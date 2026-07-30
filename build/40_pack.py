#!/usr/bin/env python3
"""Stage 40 — gzip, encrypt and publish the bundles to web/public/data/.

    MG_PASSWORD='...' python 40_pack.py            # pack with an existing/new password
    python 40_pack.py --generate-password          # mint a fresh 20-char password

The password is read from the MG_PASSWORD environment variable or --password-file. It is
never accepted as a command-line argument (that would put it in shell history and the
process table) and is never written to any file this repo commits.

Two properties matter for keeping the repo sane:

* The salt is read back from an existing manifest.json rather than regenerated, because
  changing it invalidates every visitor's cached session key.
* IVs are derived deterministically from the key, the shard name and the plaintext hash,
  so rebuilding unchanged content produces byte-identical ciphertext and git sees no
  churn. A shard whose plaintext hash already matches the manifest is skipped entirely.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from mg.crypto import (
    DEFAULT_ITERATIONS,
    MIN_PASSWORD_LEN,
    b64,
    derive_key,
    generate_password,
    key_check_value,
    new_salt,
    seal,
    unb64,
)
from mg.util import (
    INTERIM_DIR,
    WEB_DATA_DIR,
    deterministic_gzip,
    ensure_dirs,
    human_bytes,
    readable_json,
    sha256_hex,
    write_atomic,
)

BUNDLE_DIR = INTERIM_DIR / "bundles"
MANIFEST = WEB_DATA_DIR / "manifest.json"


def read_password(args) -> str:
    if args.password_file:
        password = Path(args.password_file).read_text(encoding="utf-8").strip()
    else:
        password = os.environ.get("MG_PASSWORD", "").strip()
    if not password:
        raise SystemExit(
            "No password. Set MG_PASSWORD, pass --password-file, or run with "
            "--generate-password to mint one."
        )
    if len(password) < MIN_PASSWORD_LEN:
        raise SystemExit(
            f"Password is {len(password)} characters; minimum is {MIN_PASSWORD_LEN}.\n"
            "Every ciphertext here is publicly downloadable, so an attacker brute-forces "
            "offline at their own hardware's rate. The iteration count only buys a "
            "constant factor -- the entropy of this password is the actual security "
            "boundary. Use --generate-password."
        )
    return password


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bundles", type=Path, default=BUNDLE_DIR)
    ap.add_argument("--out", type=Path, default=WEB_DATA_DIR)
    ap.add_argument("--password-file", type=Path, default=None)
    ap.add_argument("--generate-password", action="store_true",
                    help="mint a new CSPRNG password, print it once, and use it")
    ap.add_argument("--iterations", type=int, default=DEFAULT_ITERATIONS)
    ap.add_argument("--rotate-salt", action="store_true",
                    help="mint a new salt (invalidates every cached session key)")
    ap.add_argument("--revision", default="", help="build revision stamp")
    args = ap.parse_args()

    ensure_dirs()
    if not args.bundles.exists():
        print(f"missing {args.bundles} — run 30_build_bundles.py first", file=sys.stderr)
        return 2

    if args.generate_password:
        password = generate_password(20)
        print("=" * 68)
        print("  NEW SITE PASSWORD (shown once; not written to any file)")
        print(f"  {password}")
        print("=" * 68)
    else:
        password = read_password(args)

    previous: dict = {}
    if MANIFEST.exists():
        previous = json.loads(MANIFEST.read_text(encoding="utf-8"))

    if args.rotate_salt or not previous.get("kdf", {}).get("salt"):
        salt = new_salt()
        if previous:
            print("note: minted a new salt — every cached session key is now invalid")
    else:
        salt = unb64(previous["kdf"]["salt"])

    iterations = args.iterations
    key = derive_key(password, salt, iterations)
    kcv = key_check_value(key, salt)

    prev_shards = {s["name"]: s for s in previous.get("shards", [])}
    key_unchanged = previous.get("kcv") == b64(kcv)

    revision = args.revision or ""
    shards: list[dict] = []
    reused = 0

    # core first, then index, then the lyric shards in order: the manifest order is the
    # order the client prefetches in.
    def sort_key(p: Path) -> tuple[int, str]:
        stem = p.stem
        return ({"core": 0, "index": 1}.get(stem, 2), stem)

    for path in sorted(args.bundles.glob("*.json"), key=sort_key):
        name = path.stem
        raw = path.read_bytes()
        plain_hash = sha256_hex(raw)
        target = args.out / f"{name}.enc"

        prev = prev_shards.get(name)
        if (
            key_unchanged
            and prev
            and prev.get("plainSha256") == plain_hash
            and target.exists()
        ):
            shards.append(prev)
            reused += 1
            continue

        payload = deterministic_gzip(raw)
        blob = seal(key, name, payload, gzipped=True)
        write_atomic(target, blob)
        shards.append(
            {
                "name": name,
                "url": f"data/{name}.enc",
                "bytes": len(blob),
                "sha256": sha256_hex(blob),
                "plainSha256": plain_hash,
            }
        )

    # Drop stale .enc files from a previous build that no longer has a bundle.
    live = {s["name"] for s in shards}
    for stale in args.out.glob("*.enc"):
        if stale.stem not in live:
            stale.unlink()
            print(f"  removed stale {stale.name}")

    core = json.loads((args.bundles / "core.json").read_text(encoding="utf-8"))
    manifest = {
        "v": 1,
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "revision": revision,
        "corpus": {"songs": core["count"]},
        "kdf": {
            "alg": "PBKDF2-SHA256",
            "iterations": iterations,
            "salt": b64(salt),
            "keyLen": 256,
        },
        "cipher": "AES-256-GCM",
        "container": "MG01",
        "kcv": b64(kcv),
        "shards": shards,
    }
    write_atomic(MANIFEST, readable_json(manifest))

    total = sum(s["bytes"] for s in shards)
    print(f"\npacked {len(shards)} shards ({reused} unchanged, reused) "
          f"= {human_bytes(total)} into {args.out}")
    print(f"manifest: {MANIFEST}")
    print(f"kdf: PBKDF2-SHA256 x{iterations:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
