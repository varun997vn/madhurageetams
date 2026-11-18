"""AES-GCM container format for the encrypted data bundles.

The published site is a public URL — GitHub Pages has no server-side auth, and a Pages
site is reachable even from a private repo. So the gate cannot be a JavaScript password
comparison; the *data itself* is encrypted, and the shipped HTML/JS is useless without
the key.

Threat model, stated plainly: every ciphertext here is publicly downloadable, so an
attacker brute-forces offline at whatever rate their hardware allows, unconstrained by
the site. The KDF iteration count only multiplies their per-guess cost by a constant.
**All real security comes from password entropy** — hence `generate_password()` below,
and hence `pack()` refusing anything shorter than 16 characters.

Container layout::

    offset  0   4B   magic "MG01"
    offset  4   1B   version = 1
    offset  5   1B   flags (bit0 = payload is gzipped)
    offset  6   2B   reserved, zero
    offset  8  12B   IV
    offset 20   ..   AES-256-GCM ciphertext || 16B tag

IVs are *deterministic*: ``HMAC-SHA256(key, b"iv|" + name + b"|" + sha256(plaintext))[:12]``.
Unique per plaintext, so a given key never encrypts two different plaintexts under the
same IV (which would break GCM catastrophically), yet byte-identical across rebuilds when
the content has not changed — so git sees no churn on the committed artifacts.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import string

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b"MG01"
VERSION = 1
FLAG_GZIP = 0x01
HEADER_LEN = 20
IV_LEN = 12
SALT_LEN = 16
KEY_LEN = 32
KCV_LEN = 8

# OWASP's recommendation for PBKDF2-SHA256. Costs ~0.6s on a desktop, ~2-3s on a
# mid-range phone. Do not go below 210_000.
DEFAULT_ITERATIONS = 600_000

MIN_PASSWORD_LEN = 16

# Unambiguous alphabet: no O/0, l/1/I. The password gets typed by hand on phones.
_PASSWORD_ALPHABET = (
    "".join(c for c in string.ascii_uppercase if c not in "OI")
    + "".join(c for c in string.ascii_lowercase if c not in "l")
    + "".join(c for c in string.digits if c not in "01")
)


def generate_password(length: int = 20) -> str:
    """A CSPRNG password. 20 chars over this 58-symbol alphabet is ~117 bits.

    Never let a human choose this. The same container scheme with a memorable passphrase
    would fall to an offline dictionary attack in hours.
    """
    if length < MIN_PASSWORD_LEN:
        raise ValueError(f"length must be >= {MIN_PASSWORD_LEN}")
    return "".join(secrets.choice(_PASSWORD_ALPHABET) for _ in range(length))


def new_salt() -> bytes:
    return os.urandom(SALT_LEN)


def derive_key(password: str, salt: bytes, iterations: int = DEFAULT_ITERATIONS) -> bytes:
    """PBKDF2-SHA256. Mirrors WebCrypto's deriveBits exactly."""
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, KEY_LEN)


def key_check_value(key: bytes, salt: bytes) -> bytes:
    """Short digest so the client can reject a wrong password without any network I/O.

    This leaks nothing: the GCM tag on a publicly downloadable blob already lets an
    attacker verify guesses offline.
    """
    return hashlib.sha256(key + salt + b"mg-kcv").digest()[:KCV_LEN]


def suggest_token(key: bytes) -> str:
    """Proof-of-unlock for the suggestion endpoint. Mirrors suggestToken() in crypto.ts.

    One-way on purpose: the intake script stores this, and must not be holding anything
    that could decrypt the corpus.
    """
    return hashlib.sha256(b"mg-suggest-v1" + key).hexdigest()


def deterministic_iv(key: bytes, name: str, plaintext: bytes) -> bytes:
    digest = hashlib.sha256(plaintext).digest()
    mac = hmac.new(key, b"iv|" + name.encode("utf-8") + b"|" + digest, hashlib.sha256)
    return mac.digest()[:IV_LEN]


def seal(key: bytes, name: str, payload: bytes, gzipped: bool) -> bytes:
    """Wrap `payload` in the container format."""
    iv = deterministic_iv(key, name, payload)
    flags = FLAG_GZIP if gzipped else 0
    header = MAGIC + bytes([VERSION, flags, 0, 0]) + iv
    assert len(header) == HEADER_LEN, len(header)
    ciphertext = AESGCM(key).encrypt(iv, payload, None)
    return header + ciphertext


def open_sealed(key: bytes, blob: bytes) -> tuple[bytes, bool]:
    """Inverse of `seal`. Returns (payload, was_gzipped). Raises on a wrong key."""
    if len(blob) < HEADER_LEN + 16:
        raise ValueError("blob too short to be a container")
    if blob[:4] != MAGIC:
        raise ValueError(f"bad magic {blob[:4]!r}")
    version = blob[4]
    if version != VERSION:
        raise ValueError(f"unsupported container version {version}")
    flags = blob[5]
    iv = blob[8:20]
    payload = AESGCM(key).decrypt(iv, blob[HEADER_LEN:], None)
    return payload, bool(flags & FLAG_GZIP)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def unb64(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"))
