"""Stage 35 — native-script shards.

The source dataset is a separate private repository, so every test that needs it skips
when $MG_SOURCE is absent. That keeps `pytest` green for a contributor who only has this
repo, while still failing hard in a real build where the data is present.

These artifacts ship **unencrypted and keyed by song id**, which is what most of the
assertions below are really pinning. The encrypted bundles are slot-indexed because they
come from one sorted pass over the parsed PDF; these come from a second, independent
extraction, so an implicit shared ordering would be an assumption rather than a fact. The
id list travels with the data instead, and the tests check that it partitions cleanly and
that every derived array lines up with it.
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
    return stage.load_records(source)


@pytest.fixture(scope="module")
def ids(index: list[dict]) -> list[int]:
    return sorted(entry["id"] for entry in index)


@pytest.fixture(scope="module")
def built(ids, records, index):
    """The shards and index exactly as the stage would write them."""
    script_by_id = _script_map(index)
    shards = stage.build_shards(ids, records, script_by_id)
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


# --------------------------------------------------------------- the id join ----


def test_song_count(ids):
    assert len(ids) == stage.EXPECTED_SONGS == 7898
    assert len(set(ids)) == len(ids)


def test_hand_verified_songs_agree_with_this_pipeline(index):
    """The two constants test_parse.py pins, checked against the *other* extraction.

    Nothing downstream depends on slot order any more, but agreement here is still what
    says the two extractions are numbering the same document the same way.
    """
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


@pytest.mark.skipif(
    not (INTERIM_DIR / "bundles" / "core.json").exists(),
    reason="core.json absent; run stages 10-30 to cross-check against the real corpus",
)
def test_id_set_matches_the_shipped_corpus(ids):
    """Not required for correctness — the join is explicit — but worth knowing.

    If these ever diverged it would mean one extraction is missing songs the other has,
    which is a data problem rather than an indexing one.
    """
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


def test_index_arrays_are_position_indexed(built, index):
    """`script`/`unverified`/`romanEmpty` index into `ids`, not into corpus slots."""
    _, doc = built
    assert len(doc["script"]) == doc["count"]
    assert set(doc["script"]) <= {0, 1, 2}

    codes = {None: 0, "deva": 1, "taml": 2}
    script_by_id = _script_map(index)
    for position, song_id in enumerate(doc["ids"]):
        assert doc["script"][position] == codes[script_by_id[song_id]]

    for key in ("unverified", "romanEmpty"):
        assert doc[key] == sorted(doc[key])
        assert all(0 <= p < doc["count"] for p in doc[key])


def test_script_availability_matches_the_source(built):
    _, doc = built
    assert doc["script"].count(1) == 6370
    assert doc["script"].count(2) == 1522
    assert doc["script"].count(0) == 6
    assert len(doc["unverified"]) == 61
    assert len(doc["romanEmpty"]) == 2


# ------------------------------------------------------------- content invariants ----


def test_native_column_round_trips_for_every_song(ids, records, index):
    """The invariant the shard shape rests on.

    `pair` indexes into `nat`; if the two disagree the reader sees scrambled lines rather
    than an error, so this is checked across the whole corpus.
    """
    script_by_id = _script_map(index)
    for song_id in ids:
        script = script_by_id[song_id]
        song = stage.build_song(records[song_id], script)
        if script is None:
            assert song["nat"] == []
            continue

        key = "devanagari" if script == "deva" else "tamil"
        expected = [row["text"] for row in (records[song_id]["lyrics"].get(key) or [])]
        assert song["nat"] == expected, song_id

        positions = [n for _, n in song["pair"] if n >= 0]
        assert positions == list(range(len(expected))), song_id


def test_roman_indices_stay_in_range(ids, records, index):
    script_by_id = _script_map(index)
    for song_id in ids:
        song = stage.build_song(records[song_id], script_by_id[song_id])
        for roman_index, _ in song["pair"]:
            assert -1 <= roman_index < len(song["rom"]), song_id


def test_headings_come_only_from_the_roman_column(ids, records, index):
    """The native arrays record no `kind`, so every heading flag must trace to Roman."""
    script_by_id = _script_map(index)
    headings = sum(
        sum(1 for flag, _ in stage.build_song(records[i], script_by_id[i])["rom"] if flag == 1)
        for i in ids
    )
    assert headings > 10_000, f"expected ~11.6k structural headings, found {headings}"


def test_english_songs_get_no_native_column(records, index):
    """The six English songs print one column, which the extractor put on *both* sides.

    Sniffing `aligned` would present Roman text as though it were Devanagari, so the script
    comes from the source index instead. This pins that.
    """
    script_by_id = _script_map(index)
    english = [e["id"] for e in index if e["language"] == "English"]
    assert len(english) == 6
    for song_id in english:
        assert script_by_id[song_id] is None
        song = stage.build_song(records[song_id], None)
        assert song["s"] is None
        assert song["nat"] == []
        assert song["pair"] == []


def test_songs_without_alignment_still_keep_their_lyrics(records, index):
    """The two Tamil-only ritual entries have native lines, no Roman column, no alignment."""
    script_by_id = _script_map(index)
    orphans = [
        e["id"]
        for e in index
        if not (records[e["id"]].get("aligned") or []) and script_by_id[e["id"]]
    ]
    assert len(orphans) == 2
    for song_id in orphans:
        song = stage.build_song(records[song_id], script_by_id[song_id])
        assert song["nat"], song_id
        assert [n for _, n in song["pair"]] == list(range(len(song["nat"])))
        assert all(r == -1 for r, _ in song["pair"])


def _script_map(index: list[dict]) -> dict[int, str | None]:
    return {
        entry["id"]: next(
            (tag for key, tag in stage.SCRIPT_KEYS.items() if key in (entry.get("scripts") or [])),
            None,
        )
        for entry in index
    }
