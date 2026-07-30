"""Container-format and key-derivation tests.

The same fixture file is executed by web/src/lib/crypto.test.ts against WebCrypto, so
these vectors prove the Python writer and the browser reader interoperate without
needing a browser in the loop.
"""

from __future__ import annotations

import gzip
import json

import pytest

from mg.crypto import (
    HEADER_LEN,
    MAGIC,
    b64,
    derive_key,
    deterministic_iv,
    generate_password,
    key_check_value,
    new_salt,
    open_sealed,
    seal,
    unb64,
)
from mg.util import FIXTURES_DIR, deterministic_gzip

VECTORS = json.loads((FIXTURES_DIR / "crypto_vectors.json").read_text(encoding="utf-8"))
KEY = unb64(VECTORS["derivedKey"])


def test_derived_key_matches_fixture():
    key = derive_key(VECTORS["password"], unb64(VECTORS["salt"]), VECTORS["iterations"])
    assert b64(key) == VECTORS["derivedKey"]


def test_key_check_value_matches_fixture():
    assert b64(key_check_value(KEY, unb64(VECTORS["salt"]))) == VECTORS["kcv"]


@pytest.mark.parametrize("sample", VECTORS["samples"], ids=lambda s: s["name"])
def test_sample_blobs_roundtrip(sample):
    blob = unb64(sample["blob"])
    payload, gzipped = open_sealed(KEY, blob)
    assert gzipped == sample["gzipped"]
    text = gzip.decompress(payload) if gzipped else payload
    assert text.decode("utf-8") == sample["plaintext"]


@pytest.mark.parametrize("sample", VECTORS["samples"], ids=lambda s: s["name"])
def test_sample_blobs_are_reproducible(sample):
    """Rebuilding unchanged content must produce byte-identical output, or every
    rebuild churns the committed artifacts and bloats the repo."""
    raw = sample["plaintext"].encode("utf-8")
    payload = deterministic_gzip(raw) if sample["gzipped"] else raw
    assert b64(seal(KEY, sample["name"], payload, sample["gzipped"])) == sample["blob"]


def test_container_header_layout():
    blob = seal(KEY, "core", b"x", False)
    assert blob[:4] == MAGIC
    assert blob[4] == 1                      # version
    assert blob[5] == 0                      # flags: not gzipped
    assert seal(KEY, "core", b"x", True)[5] == 1
    assert len(blob) == HEADER_LEN + 1 + 16  # header + payload + GCM tag


def test_iv_is_unique_per_plaintext_and_per_name():
    """GCM catastrophically fails if a key encrypts two plaintexts under one IV."""
    assert deterministic_iv(KEY, "core", b"a") != deterministic_iv(KEY, "core", b"b")
    assert deterministic_iv(KEY, "core", b"a") != deterministic_iv(KEY, "index", b"a")
    assert deterministic_iv(KEY, "core", b"a") == deterministic_iv(KEY, "core", b"a")


def test_wrong_key_is_rejected():
    blob = seal(KEY, "core", b"secret", False)
    other = derive_key("a different password entirely", unb64(VECTORS["salt"]), 1000)
    with pytest.raises(Exception):
        open_sealed(other, blob)


def test_truncated_blob_is_rejected():
    blob = seal(KEY, "core", b"secret payload here", False)
    with pytest.raises(Exception):
        open_sealed(KEY, blob[:-1])
    with pytest.raises(ValueError):
        open_sealed(KEY, blob[:10])


def test_tampered_ciphertext_is_rejected():
    blob = bytearray(seal(KEY, "core", b"secret payload here", False))
    blob[HEADER_LEN] ^= 0xFF
    with pytest.raises(Exception):
        open_sealed(KEY, bytes(blob))


def test_bad_magic_is_rejected():
    blob = bytearray(seal(KEY, "core", b"x", False))
    blob[0] = ord("X")
    with pytest.raises(ValueError, match="bad magic"):
        open_sealed(KEY, bytes(blob))


def test_generated_passwords_have_real_entropy():
    """All the security is in this string; nothing else about the scheme constrains an
    offline attacker."""
    passwords = {generate_password(20) for _ in range(200)}
    assert len(passwords) == 200, "CSPRNG should not repeat over 200 draws"
    for p in passwords:
        assert len(p) == 20
        # Unambiguous alphabet: no O/0, l/1/I, since this gets typed on phones.
        assert not (set(p) & set("OIl01"))


def test_generate_password_refuses_weak_lengths():
    with pytest.raises(ValueError):
        generate_password(8)


def test_salts_are_random():
    assert len({new_salt() for _ in range(50)}) == 50
