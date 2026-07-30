#!/usr/bin/env python3
"""Stage 30 — build the bundles the browser actually downloads.

Three kinds of artifact, split so the site is usable before the whole corpus arrives:

  core          every field except lyrics, dictionary-encoded into parallel arrays.
                ~380 KB gzipped, and enough to render facets, counts and result rows.
  index         inverted index over folded tokens from titles, metadata and lyrics.
                Fetched lazily on the first lyrics-scoped query. This is what lets the
                site rank a full-text search without downloading 7.5 MB of lyrics.
  lyrics-NN     32 shards over contiguous id ranges, so opening one song costs ~110 KB
                and slot -> shard is a range lookup rather than a table.

Everything is indexed by *slot* (0..7897), the position in id-sorted order, so postings
and column arrays share one address space.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

from mg.fold import fold_tokens
from mg.util import (
    INTERIM_DIR,
    canonical_json,
    deterministic_gzip,
    ensure_dirs,
    human_bytes,
    readable_json,
    write_atomic,
)

ENRICHED = INTERIM_DIR / "songs_enriched.json"
BUNDLE_DIR = INTERIM_DIR / "bundles"
REPORT = INTERIM_DIR / "bundle_report.json"

LYRIC_SHARDS = 32

# Field flags on a posting, so the ranker can weight a title hit above a lyric hit.
F_TITLE = 1
F_META = 2
F_LYRICS = 4

# Tokens this common carry no signal and cost the most postings. Deliberately tiny:
# over-pruning a devotional corpus would remove exactly the words people search for
# ("rama", "hare", "krishna" are content here, not stopwords).
STOPWORDS = frozenset({"a", "e", "i", "o", "u", "th", "cha", "va", "na"})

SINGLE_FIELDS = ("composer", "deity", "language")
MULTI_FIELDS = ("ragam", "thalam", "catalog", "occasions", "albums", "singers")


def build_dictionary(values: list[str]) -> tuple[list[str], dict[str, int]]:
    """Order dictionary entries by frequency so the common values get low indices."""
    freq = Counter(values)
    ordered = [v for v, _ in sorted(freq.items(), key=lambda kv: (-kv[1], kv[0]))]
    return ordered, {v: i for i, v in enumerate(ordered)}


def build_core(songs: list[dict]) -> dict:
    dicts: dict[str, list[str]] = {}
    lookup: dict[str, dict[str, int]] = {}

    for field in SINGLE_FIELDS:
        values = [s[field] for s in songs if s[field]]
        dicts[field], lookup[field] = build_dictionary(values)
    for field in MULTI_FIELDS:
        values = [v for s in songs for v in s[field]]
        dicts[field], lookup[field] = build_dictionary(values)

    role_values = sorted({s["role"] for s in songs if s["role"]})
    role_index = {v: i for i, v in enumerate(role_values)}

    core = {
        "version": 1,
        "count": len(songs),
        "ids": [s["id"] for s in songs],
        "titles": [s["title"] for s in songs],
        "dicts": dicts,
        "roles": role_values,
        "single": {
            field: [lookup[field].get(s[field], -1) for s in songs]
            for field in SINGLE_FIELDS
        },
        "multi": {
            field: [[lookup[field][v] for v in s[field]] for s in songs]
            for field in MULTI_FIELDS
        },
        # Occasions a song is a *core* example of, used to rank an occasion view.
        "boost": [
            [lookup["occasions"][v] for v in s["occasion_boost"]] for s in songs
        ],
        "seq": [s["seq"] if s["seq"] is not None else -1 for s in songs],
        "role": [role_index.get(s["role"], -1) for s in songs],
        "roleOrder": [s["role_order"] if s["role_order"] is not None else -1 for s in songs],
        "page": [s["page"] for s in songs],
        # Lyric token count, for BM25 length normalisation without shipping the lyrics.
        "dl": [len(fold_tokens(s["lyrics"])) for s in songs],
    }
    return core


def build_index(songs: list[dict]) -> tuple[dict, dict]:
    """Inverted index: folded token -> postings over slots, with field flags and tf."""
    postings: dict[str, dict[int, tuple[int, int]]] = defaultdict(dict)

    def add(slot: int, text: str, flag: int) -> None:
        if not text:
            return
        for token in fold_tokens(text):
            if token in STOPWORDS:
                continue
            mask, tf = postings[token].get(slot, (0, 0))
            postings[token][slot] = (mask | flag, tf + 1)

    for slot, s in enumerate(songs):
        add(slot, s["title"], F_TITLE)
        meta = " ".join(
            [s["composer"], s["deity"], s["language"]]
            + s["ragam"] + s["thalam"] + s["catalog"] + s["albums"] + s["singers"]
        )
        add(slot, meta, F_META)
        add(slot, s["lyrics"], F_LYRICS)

    tokens = sorted(postings)
    flat: list[list[int]] = []
    for token in tokens:
        entries = sorted(postings[token].items())
        row: list[int] = []
        prev = 0
        for slot, (mask, tf) in entries:
            row.append(slot - prev)               # delta-encoded slot
            row.append(mask * 16 + min(tf, 15))   # field flags + capped term frequency
            prev = slot
        flat.append(row)

    index = {
        "version": 1,
        "count": len(songs),
        "tokens": tokens,
        "postings": flat,
        "flags": {"title": F_TITLE, "meta": F_META, "lyrics": F_LYRICS},
    }
    stats = {
        "tokens": len(tokens),
        "postings": sum(len(p) for p in postings.values()),
        "singletons": sum(1 for t in tokens if len(postings[t]) == 1),
    }
    return index, stats


def build_lyric_shards(songs: list[dict]) -> list[dict]:
    """Contiguous slot ranges, so slot -> shard is a range lookup and prefetch is linear."""
    per = math.ceil(len(songs) / LYRIC_SHARDS)
    shards = []
    for n in range(LYRIC_SHARDS):
        lo, hi = n * per, min((n + 1) * per, len(songs))
        if lo >= hi:
            break
        shards.append(
            {
                "version": 1,
                "name": f"lyrics-{n:02d}",
                "firstSlot": lo,
                "lastSlot": hi - 1,
                "ids": [s["id"] for s in songs[lo:hi]],
                "lyrics": [s["lyrics"] for s in songs[lo:hi]],
            }
        )
    return shards


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--songs", type=Path, default=ENRICHED)
    ap.add_argument("--out", type=Path, default=BUNDLE_DIR)
    ap.add_argument("--max-index-mb", type=float, default=3.0,
                    help="fail if the gzipped index exceeds this")
    args = ap.parse_args()

    ensure_dirs()
    if not args.songs.exists():
        print(f"missing {args.songs} — run 20_enrich.py first", file=sys.stderr)
        return 2

    songs = json.loads(args.songs.read_text(encoding="utf-8"))
    songs.sort(key=lambda s: s["id"])          # slot order == id order
    args.out.mkdir(parents=True, exist_ok=True)

    written: list[dict] = []

    def emit(name: str, payload: dict) -> None:
        raw = canonical_json(payload)
        gz = deterministic_gzip(raw)
        write_atomic(args.out / f"{name}.json", raw)
        written.append({"name": name, "raw": len(raw), "gzip": len(gz)})
        print(f"  {name:<12} {human_bytes(len(raw)):>10} raw  {human_bytes(len(gz)):>10} gz")

    print("bundles:")
    core = build_core(songs)
    emit("core", core)

    index, index_stats = build_index(songs)
    emit("index", index)

    for shard in build_lyric_shards(songs):
        emit(shard["name"], shard)

    total_gz = sum(w["gzip"] for w in written)
    index_gz = next(w["gzip"] for w in written if w["name"] == "index")
    core_gz = next(w["gzip"] for w in written if w["name"] == "core")
    lyrics_gz = sum(w["gzip"] for w in written if w["name"].startswith("lyrics-"))

    print(f"\ntokens          : {index_stats['tokens']:,} "
          f"({index_stats['singletons']:,} appear in only one song)")
    print(f"postings        : {index_stats['postings']:,}")
    print(f"core (gz)       : {human_bytes(core_gz)}   <- cost to first interactive")
    print(f"index (gz)      : {human_bytes(index_gz)}   <- lazy, first lyrics search")
    print(f"lyrics (gz)     : {human_bytes(lyrics_gz)} over {LYRIC_SHARDS} shards")
    print(f"total (gz)      : {human_bytes(total_gz)}")

    report = {
        "bundles": written,
        "index": index_stats,
        "totals": {"core_gz": core_gz, "index_gz": index_gz,
                   "lyrics_gz": lyrics_gz, "all_gz": total_gz},
    }
    write_atomic(REPORT, readable_json(report))

    if index_gz > args.max_index_mb * 1024 * 1024:
        print(f"\nindex.enc would be {human_bytes(index_gz)}, over the "
              f"{args.max_index_mb} MB budget", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
