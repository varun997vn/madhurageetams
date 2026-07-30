#!/usr/bin/env python3
"""Regenerate fixtures/crypto_vectors.json.

These vectors are the contract between the Python writer (mg/crypto.py) and the browser
reader (web/src/lib/crypto.ts). Both test suites run them, so an incompatible change to
either side fails in CI rather than as an undecryptable site.

The password here is a throwaway test value and has nothing to do with the site password.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mg.crypto import (  # noqa: E402
    b64,
    derive_key,
    deterministic_iv,
    key_check_value,
    seal,
)
from mg.util import FIXTURES_DIR, deterministic_gzip  # noqa: E402

TEST_PASSWORD = "correct horse battery staple 42"
TEST_SALT = bytes(range(16))
# Deliberately low so the TypeScript suite runs fast; production uses 600,000.
TEST_ITERATIONS = 1000


def main() -> int:
    key = derive_key(TEST_PASSWORD, TEST_SALT, TEST_ITERATIONS)

    samples = []
    for name, text, gzipped in [
        ("core", '{"hello":"world"}', False),
        ("index", '{"tokens":["rama","krisna"],"postings":[[0,17],[1,33]]}', True),
        ("lyrics-00", '{"ids":[5,8],"lyrics":["line one","line two"]}', True),
        ("empty", "", False),
        ("unicode", '{"t":"kriShNA rAdhE gOvinda — ॥"}', True),
    ]:
        raw = text.encode("utf-8")
        payload = deterministic_gzip(raw) if gzipped else raw
        blob = seal(key, name, payload, gzipped=gzipped)
        samples.append(
            {
                "name": name,
                "plaintext": text,
                "gzipped": gzipped,
                "iv": b64(deterministic_iv(key, name, payload)),
                "blob": b64(blob),
            }
        )

    payload = {
        "_comment": (
            "Interop contract between build/mg/crypto.py and web/src/lib/crypto.ts. "
            "The password is a throwaway test value, NOT the site password. "
            "Regenerate with build/tools/gen_crypto_vectors.py."
        ),
        "password": TEST_PASSWORD,
        "salt": b64(TEST_SALT),
        "iterations": TEST_ITERATIONS,
        "keyLen": 256,
        "derivedKey": b64(key),
        "kcv": b64(key_check_value(key, TEST_SALT)),
        "container": {
            "magic": "MG01",
            "version": 1,
            "headerLen": 20,
            "ivOffset": 8,
            "ivLen": 12,
            "flagGzip": 1,
        },
        "samples": samples,
    }

    out = FIXTURES_DIR / "crypto_vectors.json"
    out.write_text(json.dumps(payload, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {out}: {len(samples)} samples")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
