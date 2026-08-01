"""Stage 35 — native-script shards.

The source dataset is a separate private repository, so every test that needs it skips
when $MG_SOURCE is absent. That keeps `pytest` green for a contributor who only has this
repo, while still failing hard in a real build where the data is present.

What these pin is the join. Both extractions read a byte-identical PDF and derive song ids
the same way, but they were written independently — and if their id sets ever diverge,
every native shard attaches to the wrong song. That failure is invisible on screen: the
page renders beautifully, in the wrong script, for the wrong song.
"""

from __future__ import annotations

import importlib.util
import json
import math
from pathlib import Path

import pytest
import yaml

from mg.util import BUILD_DIR, INTERIM_DIR, RULES_DIR


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


# --------------------------------------------------------------------- the join ----


def test_song_count_matches_the_corpus(ids):
    assert len(ids) == stage.EXPECTED_SONGS == 7898
    assert len(set(ids)) == len(ids)


def test_id_digest_is_pinned(ids):
    """Slot order is derived from this list, so a change must be deliberate."""
    assert stage.id_digest(ids) == stage.EXPECTED_ID_SHA256


def test_hand_verified_songs_agree_with_this_pipeline(index):
    """The two constants test_parse.py pins, checked against the *other* extraction.

    If both extractors independently produce id 7344 with the same six metadata fields,
    they are numbering the same document the same way.
    """
    by_id = {entry["id"]: entry for entry in index}

    song = by_id[7344]
    assert song["title"] == "kaNDe kaNDe kaNDenayya kangaLa daNiyuva thanaka"
    assert song["composer"] == "Sri Purandara Dasar"
    assert song["deity"] == "Krishna"
    assert song["language"] == "Kannada"
    assert song["ragam"] == "Nadanamakriya"
    assert song["thalam"] == "Ekam"

    # The composite-id series that test_parse.py:183 documents survives in both.
    composite = by_id[397904393]
    assert composite["title"].endswith("yashOdaiyammaikkum")
    assert composite["composer"] == "Sri Sri Anna"


def test_every_occasion_spot_check_resolves(index):
    """rules/occasions.yaml asserts these ids exist; they must exist on both sides."""
    rules = yaml.safe_load((RULES_DIR / "occasions.yaml").read_text(encoding="utf-8"))
    if isinstance(rules, dict):
        rules = rules.get("occasions", rules.get("rules", []))
    known = {entry["id"] for entry in index}
    expected = {sid for rule in rules for sid in (rule.get("spot_check") or [])}
    assert expected, "occasions.yaml has no spot_check ids to verify against"
    assert expected <= known


@pytest.mark.skipif(
    not (INTERIM_DIR / "bundles" / "core.json").exists(),
    reason="core.json absent; run stages 10-30 for the strongest check",
)
def test_slot_order_matches_the_real_core_bundle(ids):
    """The authoritative check: the shipped corpus's own slot table, position by position."""
    assert stage.verify_against_core(ids)


# ------------------------------------------------------------------ shard shape ----


def test_shards_cover_every_slot_contiguously(ids, records, index):
    script_by_id = _script_map(index)
    shards = stage.build_shards(ids, records, script_by_id)

    per = math.ceil(len(ids) / stage.NATIVE_SHARDS)
    assert shards[0]["firstSlot"] == 0
    assert shards[-1]["lastSlot"] == len(ids) - 1
    for n, shard in enumerate(shards):
        assert shard["firstSlot"] == n * per
        assert len(shard["ids"]) == len(shard["songs"]) == shard["lastSlot"] - shard["firstSlot"] + 1
        if n:
            assert shard["firstSlot"] == shards[n - 1]["lastSlot"] + 1


def test_shard_names_cannot_be_mistaken_for_lyric_shards():
    """data.worker.ts selects shards by name prefix, so the names are a contract.

    Deliberately needs no source dataset, because this is the check that must run in CI: a
    native shard named `lyrics-…` would be swept into `startsWith('lyrics-')` and corrupt
    the arithmetic mapping a slot to its Roman shard — and `nativemap` must likewise stay
    clear of `startsWith('native-')`, which selects the native shards.
    """
    names = [f"native-{n:02d}" for n in range(stage.NATIVE_SHARDS)]
    for name in names:
        assert name.startswith("native-")
        assert not name.startswith("lyrics")
    assert not "nativemap".startswith("native-")
    assert "nativemap" not in names


def test_emitted_shard_names_follow_the_contract(ids, records, index):
    shards = stage.build_shards(ids, records, _script_map(index))
    assert len(shards) == stage.NATIVE_SHARDS
    for shard in shards:
        assert shard["name"].startswith("native-")
        assert not shard["name"].startswith("lyrics")


# ------------------------------------------------------------- content invariants ----


def test_native_column_round_trips_for_every_song(ids, records, index):
    """The invariant the whole shard shape rests on.

    `pairs` indexes into `native`; if the two ever disagree the reader sees scrambled
    lines rather than an error, so this is checked across the entire corpus.
    """
    script_by_id = _script_map(index)
    for song_id in ids:
        script = script_by_id[song_id]
        built = stage.build_song(records[song_id], script)
        if script is None:
            assert built["nat"] == []
            continue

        key = "devanagari" if script == "deva" else "tamil"
        expected = [row["text"] for row in (records[song_id]["lyrics"].get(key) or [])]
        assert built["nat"] == expected, song_id

        indices = [n for _, n in built["pair"] if n >= 0]
        assert indices == sorted(indices), song_id
        assert indices == list(range(len(expected))), song_id


def test_roman_indices_stay_in_range(ids, records, index):
    script_by_id = _script_map(index)
    for song_id in ids:
        built = stage.build_song(records[song_id], script_by_id[song_id])
        for roman_index, _ in built["pair"]:
            assert -1 <= roman_index < len(built["rom"]), song_id


def test_headings_come_only_from_the_roman_column(ids, records, index):
    """The native arrays record no `kind`, so every heading flag must trace to Roman."""
    script_by_id = _script_map(index)
    headings = 0
    for song_id in ids:
        built = stage.build_song(records[song_id], script_by_id[song_id])
        headings += sum(1 for flag, _ in built["rom"] if flag == 1)
    assert headings > 10_000, f"expected ~11.6k structural headings, found {headings}"


def test_script_availability_matches_the_source_index(ids, records, index):
    counts = {"deva": 0, "taml": 0, None: 0}
    for script in _script_map(index).values():
        counts[script] += 1
    assert counts == {"deva": 6370, "taml": 1522, None: 6}
    assert sum(counts.values()) == len(ids)


def test_english_songs_get_no_native_column(records, index):
    """The six English songs print one column, which the extractor put on *both* sides.

    Sniffing `aligned` would therefore present Roman text as though it were Devanagari, so
    the script comes from the index instead. This pins that.
    """
    script_by_id = _script_map(index)
    english = [e["id"] for e in index if e["language"] == "English"]
    assert len(english) == 6
    for song_id in english:
        assert script_by_id[song_id] is None
        built = stage.build_song(records[song_id], None)
        assert built["s"] is None
        assert built["nat"] == []
        assert built["pair"] == []


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
        built = stage.build_song(records[song_id], script_by_id[song_id])
        assert built["nat"], song_id
        assert [n for _, n in built["pair"]] == list(range(len(built["nat"])))
        assert all(r == -1 for r, _ in built["pair"])


# ------------------------------------------------------------------ availability ----


def test_map_is_slot_indexed_and_small(ids, records, index):
    shards = stage.build_shards(ids, records, _script_map(index))
    availability = stage.build_map(ids, shards)

    assert availability["count"] == len(ids)
    assert len(availability["script"]) == len(ids)
    assert set(availability["script"]) <= {0, 1, 2}
    assert availability["script"].count(1) == 6370
    assert availability["script"].count(2) == 1522
    assert availability["script"].count(0) == 6
    assert len(availability["unverified"]) == 61
    assert availability["unverified"] == sorted(availability["unverified"])
    assert all(0 <= slot < len(ids) for slot in availability["unverified"])


def _script_map(index: list[dict]) -> dict[int, str | None]:
    return {
        entry["id"]: next(
            (tag for key, tag in stage.SCRIPT_KEYS.items() if key in (entry.get("scripts") or [])),
            None,
        )
        for entry in index
    }
