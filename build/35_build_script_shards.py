#!/usr/bin/env python3
"""Stage 35 — native-script lyric shards, joined to the corpus by song id.

    python 35_build_script_shards.py                      # MG_SOURCE or the default path
    MG_SOURCE=/path/to/madhurageetams-source/data python 35_build_script_shards.py

Reads the *second* extraction of the same master PDF (the private madhurageetams-source
repo) and emits interim/bundles/native-NN.json. 40_pack.py globs that directory, so the
shards are gzipped, encrypted and added to the manifest with no change to the packer.

Why a separate extraction at all
--------------------------------
This pipeline's own stage 10 reads the PDF's text layer, which returns the Indic columns
in glyph-visual order — vowel signs and reph land before their consonant. That text is
unusable, which is why the site has shipped the Roman transliteration alone. The source
repo recovers the Indic text a different way: it reads raw glyph ids from the content
streams and shapes candidate Unicode with HarfBuzz against the embedded font, accepting a
reading only when the shaped glyph sequence matches the stored glyphs exactly. Both
extractions read a byte-identical PDF (see SOURCE.md), so their song ids agree and the
join is exact rather than fuzzy.

Shard shape, per song
---------------------
    {"s": "deva"|"taml"|null,        # the one Indic script this song carries
     "rom": [[kind, text], ...],     # Roman column, kind 1 = structural heading
     "nat": [text, ...],             # native column, lines only
     "pair": [[romIdx, natIdx], ...] # row pairing, -1 where a side has no counterpart
     "v": 0|1}                       # extraction.roundTripVerified

Three properties of the source justify that shape, each verified by --verify:

1. `lyrics.roman` is the only authoritative source of `kind`. The native arrays contain no
   heading rows at all, and `aligned` retags a heading as a line whenever it pairs with an
   Indic row, so neither can stand in for it.
2. `aligned`'s Indic column reproduces `lyrics.<native>` exactly, in order. That makes the
   native index a running counter rather than a search.
3. `aligned`'s Roman column holds the same texts as `lyrics.roman` but occasionally
   displaces a row, so Roman indices are resolved by consuming per-text queues rather than
   by position.

Headings therefore reach the native view through the pairing: a native row paired with a
Roman heading is a heading too, which is how a native-only reading view keeps its pallavi
and charaNam markers.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from collections import defaultdict, deque
from pathlib import Path

from mg.util import (
    INTERIM_DIR,
    canonical_json,
    deterministic_gzip,
    ensure_dirs,
    human_bytes,
    write_atomic,
)

# Defined per stage, exactly as 30_build_bundles.py and 40_pack.py do.
BUNDLE_DIR = INTERIM_DIR / "bundles"

# Mirrors LYRIC_SHARDS in 30_build_bundles.py. Slot -> shard stays a range lookup, and the
# native shard for a song lands at the same index as its Roman one.
NATIVE_SHARDS = 32

EXPECTED_SONGS = 7898

# SHA-256 of the sorted id list, as canonical JSON. Both extractions must agree on the
# exact id set or every slot below is silently off by some amount, which would attach each
# song's lyrics to a neighbour — a corruption that looks completely fine on screen.
# Re-pin with --pin only after re-verifying against a freshly built core.json.
EXPECTED_ID_SHA256 = "bd1282d173991feb7f5ee577848706b13d126a532ab9494f71c64f694e5670c7"

DEFAULT_SOURCE = Path("/workspace/madhurageetams-source/data")

SCRIPT_KEYS = {"devanagari": "deva", "tamil": "taml"}


def find_source(explicit: Path | None) -> Path:
    """Locate the source dataset. Like the PDF, it lives outside this repo on purpose."""
    candidates = [explicit] if explicit else []
    env = os.environ.get("MG_SOURCE")
    if env:
        candidates.append(Path(env))
    candidates += [DEFAULT_SOURCE, Path.home() / "madhurageetams-source" / "data"]
    for c in candidates:
        if c and (c / "songs-index.json").is_file():
            return c
    raise FileNotFoundError(
        "Could not find the madhurageetams-source dataset (songs-index.json).\n"
        "It is a separate private repository — clone it and set "
        "MG_SOURCE=/path/to/madhurageetams-source/data"
    )


def load_records(source: Path) -> dict[int, dict]:
    """Every full song record, keyed by id."""
    records: dict[int, dict] = {}
    shards = sorted((source / "songs").glob("shard-*.json"))
    if not shards:
        raise FileNotFoundError(f"no songs/shard-*.json under {source}")
    for path in shards:
        for record in json.loads(path.read_text(encoding="utf-8")):
            if record["id"] in records:
                raise ValueError(f"duplicate id {record['id']} in {path.name}")
            records[record["id"]] = record
    return records


def id_digest(ids: list[int]) -> str:
    return hashlib.sha256(canonical_json(sorted(ids))).hexdigest()


def verify_against_core(ids: list[int]) -> str:
    """Strongest available check: compare slot-for-slot with this pipeline's own core bundle.

    `ids` here is derived independently, from the *other* extraction. core.json is what the
    shipped corpus actually uses (30_build_bundles.py:192 sorts songs by id, so its `ids`
    array IS the slot table). If the two ever disagree, every native shard would attach to
    the wrong song, so this is worth a hard failure rather than a warning.
    """
    core = BUNDLE_DIR / "core.json"
    if not core.exists():
        return ""
    data = json.loads(core.read_text(encoding="utf-8"))
    if data["ids"] == ids:
        return f"slot order verified against {core}"
    for slot, (mine, theirs) in enumerate(zip(ids, data["ids"])):
        if mine != theirs:
            raise ValueError(
                f"slot order diverges from core.json at slot {slot}: "
                f"source has id {mine}, corpus has {theirs}"
            )
    raise ValueError(
        f"slot count differs: source {len(ids)}, core.json {len(data['ids'])}"
    )


def build_song(record: dict, script: str | None) -> dict:
    """One song's native payload, or the null-script form when it has no Indic column.

    `script` comes from songs-index.json rather than from the presence of a `lyrics` key.
    The six English songs are why: they carry no Indic column, but the extractor read their
    single printed column into *both* sides of `aligned`, so sniffing `aligned` would
    present Roman text as though it were a native script.
    """
    lyrics = record.get("lyrics") or {}
    roman_rows = lyrics.get("roman") or []
    rom = [[1 if row["kind"] == "heading" else 0, row["text"]] for row in roman_rows]
    verified = 1 if (record.get("extraction") or {}).get("roundTripVerified") else 0

    if script is None:
        return {"s": None, "rom": rom, "nat": [], "pair": [], "v": verified}

    native_key = next(key for key, tag in SCRIPT_KEYS.items() if tag == script)
    nat = [row["text"] for row in (lyrics.get(native_key) or [])]
    aligned = record.get("aligned") or []

    # The two Tamil-only ritual "Preparation" entries have native lines but no Roman column
    # and no alignment at all. Emit them as native-only rows rather than losing the song.
    if not aligned:
        return {
            "s": script,
            "rom": rom,
            "nat": nat,
            "pair": [[-1, i] for i in range(len(nat))],
            "v": verified,
        }

    # Roman indices are resolved by consuming a queue per distinct text: `aligned` holds the
    # same Roman texts as `lyrics.roman` but sometimes displaces a row, and kirtans repeat
    # lines constantly, so matching by position or by first occurrence both misattribute.
    queues: dict[str, deque[int]] = defaultdict(deque)
    for index, (_, text) in enumerate(rom):
        queues[text].append(index)

    pair: list[list[int]] = []
    native_cursor = 0
    for row in aligned:
        roman_text, indic_text = row.get("roman"), row.get("indic")

        roman_index = -1
        if roman_text is not None and queues[roman_text]:
            roman_index = queues[roman_text].popleft()

        native_index = -1
        if indic_text is not None:
            if native_cursor >= len(nat) or nat[native_cursor] != indic_text:
                raise ValueError(
                    f"song {record['id']}: aligned Indic column diverges from "
                    f"lyrics.{native_key} at row {native_cursor}"
                )
            native_index = native_cursor
            native_cursor += 1

        if roman_index != -1 or native_index != -1:
            pair.append([roman_index, native_index])

    if native_cursor != len(nat):
        raise ValueError(
            f"song {record['id']}: aligned covered {native_cursor} of {len(nat)} native rows"
        )

    return {"s": script, "rom": rom, "nat": nat, "pair": pair, "v": verified}


def build_shards(
    ids: list[int], records: dict[int, dict], script_by_id: dict[int, str | None]
) -> list[dict]:
    """Contiguous slot ranges, split exactly as 30_build_bundles.build_lyric_shards does."""
    per = math.ceil(len(ids) / NATIVE_SHARDS)
    shards = []
    for n in range(NATIVE_SHARDS):
        lo, hi = n * per, min((n + 1) * per, len(ids))
        if lo >= hi:
            break
        shards.append(
            {
                "version": 1,
                "name": f"native-{n:02d}",
                "firstSlot": lo,
                "lastSlot": hi - 1,
                "ids": ids[lo:hi],
                "songs": [build_song(records[i], script_by_id[i]) for i in ids[lo:hi]],
            }
        )
    return shards


def build_map(ids: list[int], shards: list[dict]) -> dict:
    """Slot-indexed availability, ~1 KB, loaded eagerly.

    The script picker has to know which script a song carries *before* deciding whether to
    fetch a native shard at all. Without this the UI would either fetch several MB to
    render a toggle, or guess from `language` — and language does not predict script here
    (a Telugu song is printed in Devanagari).
    """
    codes = {None: 0, "deva": 1, "taml": 2}
    script: list[int] = []
    unverified: list[int] = []
    roman_empty: list[int] = []
    slot = 0
    for shard in shards:
        for song in shard["songs"]:
            script.append(codes[song["s"]])
            if not song["v"]:
                unverified.append(slot)
            if not song["rom"]:
                roman_empty.append(slot)
            slot += 1
    return {
        "version": 1,
        "count": len(ids),
        "script": script,
        "unverified": unverified,
        "romanEmpty": roman_empty,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", type=Path, default=None,
                    help="madhurageetams-source data dir (or set MG_SOURCE)")
    ap.add_argument("--out", type=Path, default=BUNDLE_DIR)
    ap.add_argument("--pin", action="store_true",
                    help="print the id digest to paste into EXPECTED_ID_SHA256")
    ap.add_argument("--max-script-mb", dest="max_mb", type=float, default=8.0,
                    help="fail if the gzipped native shards exceed this")
    ap.add_argument("--strict", action="store_true",
                    help="require core.json so slot order is checked against the real corpus")
    ap.add_argument("--skip-missing", action="store_true",
                    help="exit 0 rather than failing when the source repo is absent")
    args = ap.parse_args()

    try:
        source = find_source(args.source)
    except FileNotFoundError as error:
        if args.skip_missing:
            print(f"stage 35 skipped: {error}")
            return 0
        print(error, file=sys.stderr)
        return 2

    ensure_dirs()
    print(f"source: {source}")

    index = json.loads((source / "songs-index.json").read_text(encoding="utf-8"))
    ids = sorted(entry["id"] for entry in index)

    if len(ids) != len(set(ids)):
        print("source index contains duplicate ids", file=sys.stderr)
        return 1
    if len(ids) != EXPECTED_SONGS:
        print(f"expected {EXPECTED_SONGS} songs, source has {len(ids)}", file=sys.stderr)
        return 1

    verified_against_core = verify_against_core(ids)
    if verified_against_core:
        print(verified_against_core)
    elif args.strict:
        print(
            f"--strict requires {BUNDLE_DIR / 'core.json'}, which is missing.\n"
            "Run stages 10-30 first so slot order can be checked against the real corpus.",
            file=sys.stderr,
        )
        return 2
    else:
        print(f"note: {BUNDLE_DIR / 'core.json'} absent — slot order rests on the id digest")

    digest = id_digest(ids)
    if args.pin:
        print(f"\nid digest: {digest}\n  paste into EXPECTED_ID_SHA256")
    elif EXPECTED_ID_SHA256 and digest != EXPECTED_ID_SHA256:
        print(
            f"id set has changed.\n  expected {EXPECTED_ID_SHA256}\n  got      {digest}\n"
            "Slot order is derived from this list, so a change here silently reattaches\n"
            "every song's lyrics. Re-verify against interim/songs.json before repinning.",
            file=sys.stderr,
        )
        return 1

    records = load_records(source)
    missing = [i for i in ids if i not in records]
    if missing:
        print(f"{len(missing)} ids in the index have no record: {missing[:5]}", file=sys.stderr)
        return 1

    script_by_id = {
        entry["id"]: next(
            (tag for key, tag in SCRIPT_KEYS.items() if key in (entry.get("scripts") or [])),
            None,
        )
        for entry in index
    }

    args.out.mkdir(parents=True, exist_ok=True)
    print("\nbundles:")
    total_gz = 0
    counts: dict[str | None, int] = {"deva": 0, "taml": 0, None: 0}
    unverified = 0

    shards = build_shards(ids, records, script_by_id)
    for shard in shards:
        for song in shard["songs"]:
            counts[song["s"]] = counts.get(song["s"], 0) + 1
            unverified += 0 if song["v"] else 1
        raw = canonical_json(shard)
        gz = deterministic_gzip(raw)
        write_atomic(args.out / f"{shard['name']}.json", raw)
        total_gz += len(gz)
        print(f"  {shard['name']:<12} {human_bytes(len(raw)):>10} raw  {human_bytes(len(gz)):>10} gz")

    # Name deliberately has no dash: data.worker.ts selects native shards with
    # startsWith('native-'), and this map must not be swept up by that filter.
    availability = build_map(ids, shards)
    raw = canonical_json(availability)
    write_atomic(args.out / "nativemap.json", raw)
    map_gz = len(deterministic_gzip(raw))
    print(f"  {'nativemap':<12} {human_bytes(len(raw)):>10} raw  {human_bytes(map_gz):>10} gz")

    budget = int(args.max_mb * 1024 * 1024)
    print(f"\nsongs           : {len(ids):,}")
    print(f"  devanagari    : {counts.get('deva', 0):,}")
    print(f"  tamil         : {counts.get('taml', 0):,}")
    print(f"  no native col : {counts.get(None, 0):,}")
    print(f"unverified      : {unverified:,} songs flagged roundTripVerified=false")
    print(f"native (gz)     : {human_bytes(total_gz)}  <- lazy, only on a native script")
    print(f"map (gz)        : {human_bytes(map_gz)}   <- eager, drives the picker")
    print(f"id digest       : {digest}")

    if total_gz > budget:
        print(
            f"\nnative shards are {human_bytes(total_gz)} gzipped, over the "
            f"{args.max_mb} MB budget. The CI artifact ceiling is 20 MB for the whole "
            "dist; raise --max-script-mb deliberately or shrink the payload.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
