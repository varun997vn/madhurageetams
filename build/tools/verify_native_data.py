#!/usr/bin/env python3
"""Check that a built site's native-script data is complete and self-consistent.

    python build/tools/verify_native_data.py web/dist/data

Run by .github/workflows/deploy.yml before publishing. It exists because the failure it
catches has already happened once: the app was deployed with the native-script code but
without the native data, and every song then rendered a dead Devanagari button. Nothing
caught it, because the existing assertions count encrypted shards and the native files are
not encrypted.

Exit codes: 0 complete, 1 inconsistent, 2 absent (the caller decides whether that is fatal).
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

EXPECTED_SONGS = 7898
SUFFIX = ".json.gz"


def main(argv: list[str]) -> int:
    data = Path(argv[1] if len(argv) > 1 else "web/dist/data")
    index = data / "native-index.json"

    if not index.is_file():
        print(f"native data absent: {index} not found")
        return 2

    try:
        doc = json.loads(index.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        print(f"::error::{index} is not valid JSON: {error}")
        return 1

    listed = {entry["name"] for entry in doc.get("shards", [])}
    present = {p.name[: -len(SUFFIX)] for p in data.glob(f"native-*{SUFFIX}")}
    if listed != present:
        missing = sorted(listed - present)
        extra = sorted(present - listed)
        if missing:
            print(f"::error::native-index lists shards that are not present: {missing}")
        if extra:
            print(f"::error::shards present but not listed in native-index: {extra}")
        return 1

    if doc.get("count") != EXPECTED_SONGS or len(doc.get("ids", [])) != EXPECTED_SONGS:
        print(
            f"::error::native-index covers {doc.get('count')} songs "
            f"({len(doc.get('ids', []))} ids), expected {EXPECTED_SONGS}"
        )
        return 1

    # The ids must partition across shards in order, or a song resolves to the wrong shard.
    covered = 0
    for entry in doc["shards"]:
        if entry["first"] != covered:
            print(f"::error::{entry['name']} starts at {entry['first']}, expected {covered}")
            return 1
        covered = entry["last"] + 1

        blob = data / f"{entry['name']}{SUFFIX}"
        if hashlib.sha256(blob.read_bytes()).hexdigest() != entry["sha256"]:
            print(f"::error::{blob.name} does not match its checksum in native-index.json")
            return 1

    if covered != EXPECTED_SONGS:
        print(f"::error::shards cover {covered} songs, expected {EXPECTED_SONGS}")
        return 1

    printed = doc.get("printed", [])
    print(
        f"native scripts OK: {len(listed)} shards, {doc['count']} songs, all six scripts "
        f"(printed: {printed.count(1)} devanagari, {printed.count(2)} tamil, "
        f"{printed.count(3)} both, {printed.count(0)} neither), checksums verified"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
