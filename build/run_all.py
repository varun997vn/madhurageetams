#!/usr/bin/env python3
"""Orchestrator for the whole offline pipeline.

    MG_PASSWORD='...' python run_all.py               # stages 10-40 (00 is cached)
    python run_all.py --from 20                       # after editing rules/*.yaml
    python run_all.py --from 00 --force               # re-extract the PDF (~12 min)
    python run_all.py --generate-password             # mint a new site password

Stage 00 is skipped by default because it is the only slow step: it reads all 9,526
pages of the PDF. Everything downstream runs off build/cache/pages.jsonl in seconds,
which is what makes iterating on rules/occasions.yaml practical.
"""

from __future__ import annotations

import argparse
import hashlib
import subprocess
import sys
import time
from pathlib import Path

from mg.util import BUILD_DIR, CACHE_DIR, RULES_DIR, INTERIM_DIR

STAGES = [
    ("00", "00_extract_text.py", "extract PDF text  (slow, cached)"),
    ("10", "10_parse_songs.py", "parse song records"),
    ("20", "20_enrich.py", "canonicalise facets, derive occasions"),
    ("30", "30_build_bundles.py", "build core / index / lyric shards"),
    ("35", "35_build_script_shards.py", "native-script shards from $MG_SOURCE"),
    ("40", "40_pack.py", "gzip + encrypt -> web/public/data"),
]


def revision() -> str:
    """Hash of the parsed corpus plus the rule files.

    Committed artifacts must not drift from the rules that produced them; stamping this
    into the manifest lets CI detect a rules edit that was never repacked.
    """
    h = hashlib.sha256()
    songs = INTERIM_DIR / "songs.json"
    if songs.exists():
        h.update(songs.read_bytes())
    for rule in sorted(RULES_DIR.glob("*.yaml")):
        h.update(rule.read_bytes())
    return h.hexdigest()[:12]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--from", dest="start", default="10",
                    help="first stage to run (00/10/20/30/40)")
    ap.add_argument("--to", dest="end", default="40")
    ap.add_argument("--force", action="store_true", help="passed through to stage 00")
    ap.add_argument("--generate-password", action="store_true")
    ap.add_argument("--rotate-salt", action="store_true")
    args = ap.parse_args()

    if args.start == "00" and not args.force and (CACHE_DIR / "pages.jsonl").exists():
        print("stage 00: cache present, skipping (use --force to re-extract)\n")
        args.start = "10"

    selected = [s for s in STAGES if args.start <= s[0] <= args.end]
    if not selected:
        print(f"no stages between {args.start} and {args.end}", file=sys.stderr)
        return 2

    rev = revision()
    t0 = time.time()
    for code, script, description in selected:
        print(f"\n{'=' * 72}\nstage {code}  {description}\n{'=' * 72}")
        cmd = [sys.executable, str(BUILD_DIR / script)]
        if code == "00" and args.force:
            cmd.append("--force")
        if code == "20":
            cmd.append("--strict")
        if code == "35":
            # --strict pins slot order against the core bundle stage 30 just wrote.
            # --skip-missing keeps the Roman-only pipeline usable without the private
            # source repo, which not every contributor will have.
            cmd += ["--strict", "--skip-missing"]
        if code == "40":
            cmd += ["--revision", rev]
            if args.generate_password:
                cmd.append("--generate-password")
            if args.rotate_salt:
                cmd.append("--rotate-salt")
        result = subprocess.run(cmd, cwd=str(BUILD_DIR))
        if result.returncode != 0:
            print(f"\nstage {code} failed (exit {result.returncode})", file=sys.stderr)
            return result.returncode
        if code == "10":
            rev = revision()  # songs.json now exists / changed

    print(f"\n{'=' * 72}")
    print(f"pipeline complete in {time.time() - t0:.1f}s   revision {rev}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
