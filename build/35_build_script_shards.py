#!/usr/bin/env python3
"""Stage 35 — all-scripts lyric shards, joined to the corpus by song id.

    python 35_build_script_shards.py                      # MG_SOURCE or the default path
    MG_SOURCE=/path/to/madhurageetams-source/data python 35_build_script_shards.py

Reads the pre-generated multiscript dataset from the private madhurageetams-source
repository (data/lyrics-multiscript/) and writes plaintext artifacts straight into
web/public/data/.

Every song ships in SIX scripts — Roman, Devanagari, Tamil, Malayalam, Kannada and
Telugu. The script the master copy actually prints is carried per song ("p"), because
the reader deserves to know which column is the source and which is machine-generated:
the other five columns come from madhurageetams-source's transliteration engine
(tools/translit/), validated there line-by-line against the printed text
(see its data/lyrics-multiscript/validation-report.json).

Deliberately **not** into interim/bundles/: 40_pack.py globs that directory and would
encrypt whatever it finds. These files are unencrypted by decision of the copyright
holder, so they bypass the packer entirely and 40_pack.py is untouched by this stage.

Gzipped on disk because the raw JSON is ~100 MB. GitHub Pages gzips JSON over the wire
regardless, so this costs nothing in transfer and keeps the raw bytes out of git
history permanently.

Everything is addressed by **song id**, not by slot — the encrypted corpus is
slot-indexed, these come from a different extraction, and carrying the ids makes the
join explicit.

Shard shape, per song
---------------------
    {"p": 1|2|3|0,                # printed script: deva/taml/both("mixed")/none
     "rows": [[kind, roman, devanagari, tamil, malayalam, kannada, telugu], ...],
     "v": 0|1}                    # extraction.roundTripVerified from the source repo

Rows arrive already aligned across all six columns (the source generates them from one
pass over the PDF's aligned rows), so the old rom/nat/pair reconciliation is gone: one
row is one line in every script, kind 1 marks a structural heading.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from pathlib import Path

from mg.util import (
    WEB_DATA_DIR,
    canonical_json,
    deterministic_gzip,
    ensure_dirs,
    human_bytes,
    sha256_hex,
    write_atomic,
)

NATIVE_SHARDS = 32

EXPECTED_SONGS = 7898

INDEX_NAME = "native-index.json"

DEFAULT_SOURCE = Path("/workspace/madhurageetams-source/data")

# order of the text columns in every row, after the kind flag
SCRIPTS = ["roman", "devanagari", "tamil", "malayalam", "kannada", "telugu"]

PRINTED_CODES = {None: 0, "devanagari": 1, "tamil": 2, "mixed": 3}


def find_source(explicit: Path | None) -> Path:
    """Locate the source dataset. Like the PDF, it lives outside this repo on purpose."""
    candidates = [explicit] if explicit else []
    env = os.environ.get("MG_SOURCE")
    if env:
        candidates.append(Path(env))
    candidates += [DEFAULT_SOURCE, Path.home() / "madhurageetams-source" / "data"]
    for c in candidates:
        if c and (c / "lyrics-multiscript" / "index.json").is_file():
            return c
    raise FileNotFoundError(
        "Could not find the madhurageetams-source multiscript dataset "
        "(lyrics-multiscript/index.json).\nIt is a separate private repository — "
        "clone it and set MG_SOURCE=/path/to/madhurageetams-source/data"
    )


def load_multiscript(source: Path) -> dict[int, dict]:
    """Every song's multiscript record, keyed by id."""
    records: dict[int, dict] = {}
    shards = sorted((source / "lyrics-multiscript").glob("shard-*.json"))
    if not shards:
        raise FileNotFoundError(f"no lyrics-multiscript/shard-*.json under {source}")
    for path in shards:
        for record in json.loads(path.read_text(encoding="utf-8"))["songs"]:
            if record["id"] in records:
                raise ValueError(f"duplicate id {record['id']} in {path.name}")
            records[record["id"]] = record
    return records


def load_verified(source: Path) -> dict[int, int]:
    """extraction.roundTripVerified per song, from the primary song records."""
    verified: dict[int, int] = {}
    for path in sorted((source / "songs").glob("shard-*.json")):
        for record in json.loads(path.read_text(encoding="utf-8")):
            flag = (record.get("extraction") or {}).get("roundTripVerified")
            verified[record["id"]] = 1 if flag else 0
    return verified


def id_digest(ids: list[int]) -> str:
    return hashlib.sha256(canonical_json(sorted(ids))).hexdigest()


def build_song(record: dict, verified: int) -> dict:
    rows = record.get("rows") or []
    for row in rows:
        if len(row) != 7:
            raise ValueError(f"song {record['id']}: row has {len(row)} fields, not 7")
    return {
        "p": PRINTED_CODES[record.get("native")],
        "rows": rows,
        "v": verified,
    }


def build_shards(ids: list[int], records: dict[int, dict],
                 verified: dict[int, int]) -> list[dict]:
    per = math.ceil(len(ids) / NATIVE_SHARDS)
    shards = []
    for n in range(NATIVE_SHARDS):
        lo, hi = n * per, min((n + 1) * per, len(ids))
        if lo >= hi:
            break
        shards.append(
            {
                "version": 2,
                "name": f"native-{n:02d}",
                "ids": ids[lo:hi],
                "songs": [build_song(records[i], verified.get(i, 0))
                          for i in ids[lo:hi]],
            }
        )
    return shards


def build_index(ids: list[int], shards: list[dict], written: dict[str, dict]) -> dict:
    printed: list[int] = []
    unverified: list[int] = []
    position = 0
    for shard in shards:
        for song in shard["songs"]:
            printed.append(song["p"])
            if not song["v"]:
                unverified.append(position)
            position += 1

    entries = []
    first = 0
    for shard in shards:
        meta = written[shard["name"]]
        entries.append(
            {
                "name": shard["name"],
                "url": f"data/{shard['name']}.json.gz",
                "first": first,
                "last": first + len(shard["ids"]) - 1,
                "bytes": meta["bytes"],
                "sha256": meta["sha256"],
            }
        )
        first += len(shard["ids"])

    return {
        "version": 2,
        "count": len(ids),
        "ids": ids,
        "shards": entries,
        "scripts": SCRIPTS,
        # printed script per position: 0 none, 1 devanagari, 2 tamil, 3 both
        "printed": printed,
        "unverified": unverified,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", type=Path, default=None,
                    help="madhurageetams-source data dir (or set MG_SOURCE)")
    ap.add_argument("--out", type=Path, default=WEB_DATA_DIR)
    ap.add_argument("--max-script-mb", dest="max_mb", type=float, default=30.0,
                    help="fail if the gzipped shards exceed this")
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

    ms_index = json.loads(
        (source / "lyrics-multiscript" / "index.json").read_text(encoding="utf-8"))
    ids = sorted(int(k) for k in ms_index["songs"])

    if len(ids) != len(set(ids)):
        print("source index contains duplicate ids", file=sys.stderr)
        return 1
    if len(ids) != EXPECTED_SONGS:
        print(f"expected {EXPECTED_SONGS} songs, source has {len(ids)}", file=sys.stderr)
        return 1

    records = load_multiscript(source)
    missing = [i for i in ids if i not in records]
    if missing:
        print(f"{len(missing)} ids in the index have no record: {missing[:5]}",
              file=sys.stderr)
        return 1

    verified = load_verified(source)

    args.out.mkdir(parents=True, exist_ok=True)
    print("\nshards:")
    total_gz = total_raw = 0
    printed_counts = {0: 0, 1: 0, 2: 0, 3: 0}
    unverified = 0
    written: dict[str, dict] = {}

    shards = build_shards(ids, records, verified)
    for shard in shards:
        for song in shard["songs"]:
            printed_counts[song["p"]] += 1
            unverified += 0 if song["v"] else 1
        raw = canonical_json(shard)
        gz = deterministic_gzip(raw)
        write_atomic(args.out / f"{shard['name']}.json.gz", gz)
        written[shard["name"]] = {"bytes": len(gz), "sha256": sha256_hex(gz)}
        total_raw += len(raw)
        total_gz += len(gz)
        print(f"  {shard['name']:<12} {human_bytes(len(raw)):>10} raw  "
              f"{human_bytes(len(gz)):>10} gz")

    index_doc = build_index(ids, shards, written)
    index_raw = canonical_json(index_doc)
    write_atomic(args.out / INDEX_NAME, index_raw)

    live = {f"{s['name']}.json.gz" for s in shards} | {INDEX_NAME}
    for stale in sorted(args.out.glob("native-*")):
        if stale.name not in live:
            stale.unlink()
            print(f"  removed stale {stale.name}")

    budget = int(args.max_mb * 1024 * 1024)
    print(f"\nsongs           : {len(ids):,}  (all six scripts each)")
    print(f"  printed deva  : {printed_counts[1]:,}")
    print(f"  printed taml  : {printed_counts[2]:,}")
    print(f"  printed both  : {printed_counts[3]:,}")
    print(f"  no native col : {printed_counts[0]:,}")
    print(f"unverified      : {unverified:,} songs flagged roundTripVerified=false")
    print(f"shards on disk  : {human_bytes(total_gz)} gz  ({human_bytes(total_raw)} raw)")
    print(f"{INDEX_NAME:<16}: {human_bytes(len(index_raw))}   <- eager, drives the picker")
    print(f"id digest       : {id_digest(ids)}")
    print("\nplaintext, unencrypted — these bypass 40_pack.py entirely.")

    if total_gz > budget:
        print(
            f"\nnative shards are {human_bytes(total_gz)} on disk, over the "
            f"{args.max_mb} MB budget. Raise --max-script-mb deliberately or shrink "
            "the payload (deploy.yml's artifact ceiling must cover this too).",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
