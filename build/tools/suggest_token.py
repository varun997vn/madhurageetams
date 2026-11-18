#!/usr/bin/env python3
"""Print the UNLOCK_TOKEN the suggestion review queue expects.

    MG_PASSWORD='…' python build/tools/suggest_token.py

Readers who suggest a lyric correction send a proof that they unlocked the site:
SHA-256("mg-suggest-v1" || key). The Apps Script in suggestions/ compares it with its
UNLOCK_TOKEN Script Property, so the public endpoint refuses anyone without the
password. This prints that value for the committed manifest.

Needs only the password and web/public/data/manifest.json — not the PDF. Rerun it, and
update the Script Property, whenever the password or salt changes
(`40_pack.py --rotate-salt`); until then suggestions are refused with a prompt to
unlock again.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mg.crypto import b64, derive_key, key_check_value, suggest_token, unb64  # noqa: E402
from mg.util import WEB_DATA_DIR  # noqa: E402


def main() -> int:
    password = os.environ.get("MG_PASSWORD")
    if not password:
        print("Set MG_PASSWORD to the site password.", file=sys.stderr)
        return 2
    manifest = json.loads((WEB_DATA_DIR / "manifest.json").read_text(encoding="utf-8"))
    salt = unb64(manifest["kdf"]["salt"])
    key = derive_key(password, salt, manifest["kdf"]["iterations"])
    if b64(key_check_value(key, salt)) != manifest["kcv"]:
        print("That password does not open the committed data.", file=sys.stderr)
        return 1
    print(suggest_token(key))
    return 0


if __name__ == "__main__":
    sys.exit(main())
