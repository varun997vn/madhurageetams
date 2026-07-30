"""Shared helpers: deterministic serialisation, hashing, atomic writes, paths."""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import tempfile
from pathlib import Path
from typing import Any

BUILD_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BUILD_DIR.parent
CACHE_DIR = BUILD_DIR / "cache"
INTERIM_DIR = BUILD_DIR / "interim"
RULES_DIR = BUILD_DIR / "rules"
FIXTURES_DIR = REPO_DIR / "fixtures"
WEB_DATA_DIR = REPO_DIR / "web" / "public" / "data"

PDF_NAME = "MasterCopy_SourceLanguage_English_18Sep2025.pdf"


def ensure_dirs() -> None:
    for d in (CACHE_DIR, INTERIM_DIR, WEB_DATA_DIR, FIXTURES_DIR):
        d.mkdir(parents=True, exist_ok=True)


def canonical_json(obj: Any) -> bytes:
    """Byte-stable JSON: sorted keys, no incidental whitespace.

    Used for everything that gets encrypted, so an unchanged corpus produces
    byte-identical ciphertext and git sees no churn.
    """
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def readable_json(obj: Any) -> bytes:
    """Diffable JSON for interim artifacts a human will review in a PR."""
    return json.dumps(obj, indent=2, ensure_ascii=False).encode("utf-8")


def deterministic_gzip(data: bytes, level: int = 9) -> bytes:
    """gzip with mtime=0 so repeated builds of identical input are byte-identical."""
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=level, mtime=0) as fh:
        fh.write(data)
    return buf.getvalue()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def find_pdf() -> Path:
    """Locate the source PDF. It is gitignored, so it may sit outside the repo."""
    candidates = [
        REPO_DIR / PDF_NAME,
        BUILD_DIR / PDF_NAME,
        Path.home() / PDF_NAME,
    ]
    env = os.environ.get("MG_PDF")
    if env:
        candidates.insert(0, Path(env))
    for c in candidates:
        if c.is_file():
            return c
    raise FileNotFoundError(
        f"Could not find {PDF_NAME}. It is gitignored on purpose (see SOURCE.md).\n"
        f"Place it at {REPO_DIR / PDF_NAME} or set MG_PDF=/path/to/the.pdf"
    )


def human_bytes(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024 or unit == "GB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024.0
    return f"{n:.1f} GB"
