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
            errors.extend(f"{where}: {problem}" for problem in check_entry(entry))
    return errors


def is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def is_line(value: object) -> bool:
    return (isinstance(value, str) and len(value) <= MAX_LINE
            and not any(ch in value for ch in "\n\r\x00"))


def check_entry(entry: dict) -> list[str]:
    """Mirror of wellFormed() in web/src/lib/corrections.ts, which documents the format.

    An entry changes ({"new"}), removes ({"del": true}) or adds lines after ({"add": [...]})
    the line at address (i, n) in script s.
    """
    problems: list[str] = []
    if entry.get("s") not in SCRIPTS:
        problems.append(f"unknown script {entry.get('s')!r}")
    index = entry.get("i")
    if not is_int(index) or index < -1:
        problems.append("'i' must be an integer >= -1")
    n = entry.get("n", 0)
    if not is_int(n) or n < 0:
        problems.append("'n' must be a non-negative integer")
    old = entry.get("old")

    kinds = [k for k in ("new", "del", "add") if k in entry]
    if len(kinds) != 1:
        problems.append("needs exactly one of 'new', 'del', 'add'")
        return problems

    if "add" in entry:
        if old is not None and not is_line(old):
            problems.append("'old' must be null or a single line")
        added = entry["add"]
        if not isinstance(added, list) or not added:
            problems.append("'add' must be a non-empty list")
        elif not all(is_line(text) and text.strip() for text in added):
            problems.append(f"'add' lines must be non-empty, single-line, <= {MAX_LINE} chars")
        return problems

    if index == -1 and n == 0:
        problems.append("only 'add' may address the top anchor (i=-1, n=0)")
    if not is_line(old):
        problems.append("'old' must be a single line")
    if "del" in entry:
        if entry["del"] is not True:
            problems.append("'del' must be true")
    elif not is_line(entry["new"]) or not entry["new"].strip():
        problems.append("'new' must be a non-empty single line")
    elif entry["new"] == old:
        problems.append("'old' and 'new' are identical")
    return problems


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
