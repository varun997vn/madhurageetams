"""Stage 35 — all-scripts lyric shards.

The source dataset is a separate private repository, so every test that needs it skips
when $MG_SOURCE is absent. That keeps `pytest` green for a contributor who only has this
repo, while still failing hard in a real build where the data is present.

These artifacts ship **unencrypted and keyed by song id**. Every song carries all six
scripts as columns of one aligned row list; `p` records which Indic script the master
copy actually prints (0 none, 1 devanagari, 2 tamil, 3 both), because that is the line
between the source's own text and machine transliteration.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import math
from pathlib import Path

import pytest
import yaml

from mg.util import BUILD_DIR, INTERIM_DIR, RULES_DIR, canonical_json, deterministic_gzip


def _load_stage():
    """Import a module whose filename starts with a digit."""
    path = BUILD_DIR / "35_build_script_shards.py"
    spec = importlib.util.spec_from_file_location("stage35", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


stage = _load_stage()


@pytest.fixture(scope="module")
def source() -> Path:
    try:
        return stage.find_source(None)
    except FileNotFoundError:
        pytest.skip("madhurageetams-source not available; set MG_SOURCE")


@pytest.fixture(scope="module")
def index(source: Path) -> list[dict]:
    return json.loads((source / "songs-index.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def records(source: Path) -> dict[int, dict]:
    return stage.load_multiscript(source)


@pytest.fixture(scope="module")
def verified(source: Path) -> dict[int, int]:
    return stage.load_verified(source)


@pytest.fixture(scope="module")
def ids(records) -> list[int]:
    return sorted(records)


@pytest.fixture(scope="module")
def built(ids, records, verified):
    """The shards and index exactly as the stage would write them."""
    shards = stage.build_shards(ids, records, verified)
    written = {}
    for shard in shards:
        gz = deterministic_gzip(canonical_json(shard))
        written[shard["name"]] = {"bytes": len(gz), "sha256": hashlib.sha256(gz).hexdigest()}
    return shards, stage.build_index(ids, shards, written)


# ------------------------------------------------------------------- naming ----
# data.worker.ts no longer selects native data out of the encrypted manifest — these files
# are not in it at all — but the Roman path still filters on `lyrics-`, so a native artifact
# must never adopt that prefix.


def test_native_names_cannot_collide_with_lyric_shards():
    """Deliberately needs no source dataset, so this one runs in CI."""
    names = [f"native-{n:02d}" for n in range(stage.NATIVE_SHARDS)]
    for name in names:
        assert not name.startswith("lyrics")
    assert stage.INDEX_NAME == "native-index.json"
    assert not stage.INDEX_NAME.startswith("lyrics")


def test_stage_writes_outside_the_bundle_directory():
    """40_pack.py globs interim/bundles/*.json and encrypts what it finds.

    These artifacts are unencrypted by decision, so landing in that directory would both
    encrypt them and add them to the manifest — silently undoing the whole approach.
    """
    assert stage.WEB_DATA_DIR != INTERIM_DIR / "bundles"
    assert stage.WEB_DATA_DIR.name == "data"
    assert stage.WEB_DATA_DIR.parent.name == "public"


def test_row_column_order_is_pinned():
    """The client indexes rows positionally; reordering SCRIPTS would scramble scripts."""
    assert stage.SCRIPTS == ["roman", "devanagari", "tamil", "malayalam", "kannada", "telugu"]


# --------------------------------------------------------------- the id join ----


def test_song_count(ids):
    assert len(ids) == stage.EXPECTED_SONGS == 7898
    assert len(set(ids)) == len(ids)


def test_hand_verified_songs_agree_with_this_pipeline(index):
    """The two constants test_parse.py pins, checked against the *other* extraction."""
    by_id = {entry["id"]: entry for entry in index}

    song = by_id[7344]
    assert song["title"] == "kaNDe kaNDe kaNDenayya kangaLa daNiyuva thanaka"
    assert song["composer"] == "Sri Purandara Dasar"
    assert song["deity"] == "Krishna"
    assert song["language"] == "Kannada"
    assert song["ragam"] == "Nadanamakriya"
    assert song["thalam"] == "Ekam"

    composite = by_id[397904393]
    assert composite["title"].endswith("yashOdaiyammaikkum")
    assert composite["composer"] == "Sri Sri Anna"


def test_every_occasion_spot_check_resolves(index):
    rules = yaml.safe_load((RULES_DIR / "occasions.yaml").read_text(encoding="utf-8"))
    if isinstance(rules, dict):
        rules = rules.get("occasions", rules.get("rules", []))
    known = {entry["id"] for entry in index}
    expected = {sid for rule in rules for sid in (rule.get("spot_check") or [])}
    assert expected, "occasions.yaml has no spot_check ids to verify against"
    assert expected <= known


def test_multiscript_ids_match_the_primary_extraction(ids, index):
    """Both datasets in the source repo must cover the same 7,898 songs."""
    assert sorted(entry["id"] for entry in index) == ids


@pytest.mark.skipif(
    not (INTERIM_DIR / "bundles" / "core.json").exists(),
    reason="core.json absent; run stages 10-30 to cross-check against the real corpus",
)
def test_id_set_matches_the_shipped_corpus(ids):
    core = json.loads((INTERIM_DIR / "bundles" / "core.json").read_text(encoding="utf-8"))
    assert core["ids"] == ids


# ------------------------------------------------------------- index integrity ----


def test_index_ids_partition_across_shards(built, ids):
    shards, doc = built
    assert doc["count"] == len(ids)
    assert doc["ids"] == ids

    seen: list[int] = []
    for shard, entry in zip(shards, doc["shards"]):
        assert entry["name"] == shard["name"]
        assert entry["url"] == f"data/{shard['name']}.json.gz"
        assert shard["ids"] == ids[entry["first"] : entry["last"] + 1]
        assert len(shard["songs"]) == len(shard["ids"])
        seen += shard["ids"]
    assert seen == ids


def test_shard_ranges_are_contiguous_and_sized_as_expected(built, ids):
    shards, doc = built
    per = math.ceil(len(ids) / stage.NATIVE_SHARDS)
    assert len(shards) == stage.NATIVE_SHARDS
    assert doc["shards"][0]["first"] == 0
    assert doc["shards"][-1]["last"] == len(ids) - 1
    for previous, entry in zip(doc["shards"], doc["shards"][1:]):
        assert entry["first"] == previous["last"] + 1
    assert doc["shards"][0]["last"] - doc["shards"][0]["first"] + 1 == per


def test_index_checksums_match_the_bytes_that_would_be_written(built):
    shards, doc = built
    by_name = {s["name"]: s for s in shards}
    for entry in doc["shards"]:
        gz = deterministic_gzip(canonical_json(by_name[entry["name"]]))
        assert hashlib.sha256(gz).hexdigest() == entry["sha256"]
        assert entry["bytes"] == len(gz)


def test_index_arrays_are_position_indexed(built, records):
    """`printed`/`unverified` index into `ids`, not into corpus slots."""
    _, doc = built
    assert len(doc["printed"]) == doc["count"]
    assert set(doc["printed"]) <= {0, 1, 2, 3}

    for position, song_id in enumerate(doc["ids"]):
        expected = stage.PRINTED_CODES[records[song_id].get("native")]
        assert doc["printed"][position] == expected

    assert doc["unverified"] == sorted(doc["unverified"])
    assert all(0 <= p < doc["count"] for p in doc["unverified"])


def test_printed_scripts_match_the_verification(built):
    """The measured composition of the master copy, pinned.

    6,208 songs print Devanagari alone, 1,484 Tamil alone, 200 print BOTH (an Azhvar
    pasuram prelude before a Devanagari kirtan), and the six English songs print
    neither. These numbers come from the per-line script census of the PDF.
    """
    _, doc = built
    assert doc["printed"].count(1) == 6208
    assert doc["printed"].count(2) == 1484
    assert doc["printed"].count(3) == 200
    assert doc["printed"].count(0) == 6
    assert len(doc["unverified"]) == 61


# ------------------------------------------------------------- content invariants ----


def test_every_row_has_seven_fields(ids, records, verified):
    for song_id in ids:
        song = stage.build_song(records[song_id], verified.get(song_id, 0))
        for row in song["rows"]:
            assert len(row) == 7, song_id
            assert row[0] in (0, 1), song_id


def test_every_song_has_text_in_every_script(ids, records, verified):
    """The point of the feature: no script column may be empty for a whole song.

    Even the two Tamil-only ritual entries carry Roman now — the source generates a
    reverse transliteration where the master copy prints none — so all seven columns
    must be non-empty for every song that has any lyric rows at all.
    """
    for song_id in ids:
        song = stage.build_song(records[song_id], verified.get(song_id, 0))
        rows = song["rows"]
        if not rows:
            continue
        for col in range(1, 7):
            assert any(row[col] for row in rows), (song_id, col)


def test_headings_exist_in_every_script(ids, records, verified):
    """Structural markers are transliterated too — a Kannada reader sees ಪಲ್ಲವಿ."""
    checked = 0
    for song_id in ids[:2000]:
        song = stage.build_song(records[song_id], verified.get(song_id, 0))
        for row in song["rows"]:
            if row[0] == 1 and row[1]:
                for col in range(2, 7):
                    assert row[col], (song_id, col)
                checked += 1
    assert checked > 100
