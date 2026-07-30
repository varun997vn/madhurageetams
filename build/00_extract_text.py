#!/usr/bin/env python3
"""Stage 00 — extract the PDF's text layer to a cached page stream.

This is the only stage that touches the 9,526-page PDF and it takes ~11-20 minutes,
so it writes build/cache/pages.jsonl and every downstream stage reads that instead.
Re-run it only if the source PDF changes.

    python 00_extract_text.py                # full extraction (slow, once)
    python 00_extract_text.py --from 1856 --to 1900   # spot check a range
    python 00_extract_text.py --force        # ignore an existing cache
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from mg.util import CACHE_DIR, ensure_dirs, find_pdf, human_bytes, sha256_hex

PAGES_JSONL = CACHE_DIR / "pages.jsonl"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--from", dest="start", type=int, default=1, help="first 1-based page")
    ap.add_argument("--to", dest="end", type=int, default=0, help="last 1-based page (0 = all)")
    ap.add_argument("--force", action="store_true", help="overwrite an existing cache")
    ap.add_argument("--out", type=Path, default=PAGES_JSONL)
    args = ap.parse_args()

    ensure_dirs()

    if args.out.exists() and not args.force and args.start == 1 and args.end == 0:
        print(f"cache already present: {args.out} ({human_bytes(args.out.stat().st_size)})")
        print("pass --force to re-extract")
        return 0

    from pypdf import PdfReader  # imported late: only this stage needs it

    pdf_path = find_pdf()
    raw = pdf_path.read_bytes()
    print(f"source: {pdf_path}")
    print(f"  size:   {human_bytes(len(raw))}")
    print(f"  sha256: {sha256_hex(raw)}")
    del raw

    reader = PdfReader(str(pdf_path))
    total = len(reader.pages)
    start = max(1, args.start)
    end = total if args.end <= 0 else min(total, args.end)
    print(f"  pages:  {total} (extracting {start}..{end})")

    t0 = time.time()
    written = 0
    empty = 0
    with args.out.open("w", encoding="utf-8") as fh:
        for pno in range(start, end + 1):
            try:
                text = reader.pages[pno - 1].extract_text() or ""
            except Exception as exc:  # a single bad page must not lose the whole run
                print(f"  !! page {pno}: {type(exc).__name__}: {exc}", file=sys.stderr)
                text = ""
            if not text.strip():
                empty += 1
            fh.write(json.dumps({"page": pno, "text": text}, ensure_ascii=False) + "\n")
            written += 1
            if written % 500 == 0:
                rate = written / max(time.time() - t0, 1e-9)
                remaining = (end - start + 1 - written) / max(rate, 1e-9)
                print(f"  {written}/{end - start + 1} pages  {rate:.1f} p/s  ~{remaining / 60:.1f} min left")

    dt = time.time() - t0
    print(f"wrote {written} pages ({empty} empty) to {args.out} "
          f"({human_bytes(args.out.stat().st_size)}) in {dt / 60:.1f} min")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
