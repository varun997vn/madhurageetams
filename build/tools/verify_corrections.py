#!/usr/bin/env python3
"""Check that corrections.json is well-formed before it ships.

    python build/tools/verify_corrections.py web/public/data/corrections.json

Run by .github/workflows/deploy.yml. The file is written by the Apps Script review
queue (suggestions/Code.gs) each time the admin accepts a reader's correction, so it is
the one piece of shipped data no pipeline stage produces. The client drops malformed
entries rather than crashing, which is exactly why this exists: a bad commit would
otherwise deploy cleanly and silently publish nothing.

Standard library only, so CI needs no install step for it.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

SCRIPTS = {"roman", "devanagari", "tamil", "malayalam", "kannada", "telugu"}
MAX_LINE = 300
# The review queue reads this file through GitHub's Contents API, which stops returning
# file bodies inline at 1 MB.
MAX_BYTES = 900_000


def check(doc: object) -> list[str]:
    errors: list[str] = []
    if not isinstance(doc, dict) or doc.get("version") != 1:
        return ["top level must be an object with version 1"]
    songs = doc.get("songs")
    if not isinstance(songs, dict):
        return ["'songs' must be an object keyed by song id"]

    for key, entries in songs.items():
        if not key.isdigit():
            errors.append(f"song key {key!r} is not a numeric id")
            continue
        if not isinstance(entries, list) or not entries:
            errors.append(f"song {key}: expected a non-empty list")
            continue
        for n, entry in enumerate(entries):
            where = f"song {key} entry {n}"
            if not isinstance(entry, dict):
                errors.append(f"{where}: not an object")
                continue
            if entry.get("s") not in SCRIPTS:
                errors.append(f"{where}: unknown script {entry.get('s')!r}")
            index = entry.get("i")
            if not isinstance(index, int) or isinstance(index, bool) or index < 0:
                errors.append(f"{where}: 'i' must be a non-negative integer")
            for field in ("old", "new"):
                text = entry.get(field)
                if not isinstance(text, str):
                    errors.append(f"{where}: '{field}' must be a string")
                elif len(text) > MAX_LINE or "\n" in text or "\r" in text:
                    errors.append(f"{where}: '{field}' is over {MAX_LINE} chars or spans lines")
            if entry.get("old") == entry.get("new"):
                errors.append(f"{where}: 'old' and 'new' are identical")
    return errors


def main(argv: list[str]) -> int:
    path = Path(argv[1] if len(argv) > 1 else "web/public/data/corrections.json")
    if not path.is_file():
        print(f"{path}: absent — no corrections to apply")
        return 0
    raw = path.read_bytes()
    if len(raw) > MAX_BYTES:
        print(f"::error::{path} is {len(raw)} bytes; fold accepted fixes into the source "
              "dataset and reset it")
        return 1
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        print(f"::error::{path} is not valid UTF-8 JSON: {exc}")
        return 1

    errors = check(doc)
    for message in errors:
        print(f"::error::{path.name}: {message}")
    if errors:
        return 1
    total = sum(len(v) for v in doc["songs"].values())
    print(f"OK: {total} corrections across {len(doc['songs'])} songs")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
