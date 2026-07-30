"""Enrichment regressions: facet canonicalisation, roles, and the occasion taxonomy.

The occasion rules encode human judgement, so the guard here is different from the
parser's: rather than pinning every count, each occasion declares `spot_check` song ids
that must land in it. A rule edit that narrows an occasion until the obvious songs fall
out fails here instead of quietly shipping an empty festival card.
"""

from __future__ import annotations

import json

import pytest
import yaml

from mg.canon import Canonicaliser, normalise_tag, parse_volume
from mg.fold import fold_key
from mg.util import INTERIM_DIR, RULES_DIR

ENRICHED_PATH = INTERIM_DIR / "songs_enriched.json"
REPORT_PATH = INTERIM_DIR / "enrich_report.json"

pytestmark = pytest.mark.skipif(
    not ENRICHED_PATH.exists(), reason="run 20_enrich.py first"
)


@pytest.fixture(scope="module")
def songs():
    return json.loads(ENRICHED_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def by_id(songs):
    return {s["id"]: s for s in songs}


@pytest.fixture(scope="module")
def report():
    return json.loads(REPORT_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def occasion_spec():
    return yaml.safe_load((RULES_DIR / "occasions.yaml").read_text(encoding="utf-8"))


# --- Canonicalisation -----------------------------------------------------------------

# The source spells about 19 real thalams 81 different ways.
EXPECTED_THALAMS = {
    "Adi", "Chapu", "Rupakam", "Triputa", "Jhampa", "Ata", "Deshadi", "Ekam",
    "Misra Chapu", "Khanda Chapu", "Tisra Laghu", "Tisram", "Tisra Nadai", "Matta",
    "Mathyam", "Dhruvam", "Dhavalam", "Trividi", "Ashta",
}


def test_thalam_vocabulary_is_closed(report):
    actual = set(report["thalam_values"])
    assert actual == EXPECTED_THALAMS, (
        f"unexpected thalam values: {sorted(actual - EXPECTED_THALAMS)}; "
        f"missing: {sorted(EXPECTED_THALAMS - actual)}"
    )


def test_thalam_collapsed_meaningfully(report):
    assert report["thalam_values"]["Adi"] == 2376
    assert len(report["thalam_values"]) == 19


def test_ragam_merged_spelling_variants(report):
    """465 raw ragam spellings collapse to 294 actual ragams via folded grouping."""
    assert len(report["ragam_values"]) == 294
    assert report["ragam_values"]["Kambhoji"] == 163


def test_no_facet_value_is_a_stray_label(songs):
    for s in songs:
        for value in s["ragam"] + s["thalam"]:
            assert "thALam" not in value and "rAgam" not in value, (s["id"], value)


def test_alias_variants_actually_resolve():
    """Regression: pre-folded alias keys silently never match anything.

    fold_key removes spaces, so fold_key("thishra Adi") is "tisraadi" -- and folding
    *that* collapses the doubled vowel to "tisradi". An alias written as the
    already-folded string therefore never matches the value it was meant to fix, and the
    variant survives as its own facet value with nobody noticing. Alias entries must be
    written the way the source spells them, which this asserts by round-tripping every
    variant through the canonicaliser.
    """
    aliases = yaml.safe_load((RULES_DIR / "aliases.yaml").read_text(encoding="utf-8"))
    for group in ("thalam", "ragam"):
        alias_map = aliases.get(group) or {}
        canon = Canonicaliser.build([], alias_map)
        for canonical, variants in alias_map.items():
            for variant in variants:
                assert canon.canon_multi(variant) == [canonical], (
                    f"{group}: alias {variant!r} resolves to "
                    f"{canon.canon_multi(variant)}, expected [{canonical!r}]. "
                    "Write alias entries as source spellings, not pre-folded keys."
                )


def test_canonicaliser_splits_multivalue_and_drops_parentheticals():
    canon = Canonicaliser.build(["Adi", "chApu"], {"Adi": ["Adi"], "Chapu": ["chApu"]})
    assert canon.canon_multi("Adi / chApu") == ["Adi", "Chapu"]
    assert canon.canon_multi("Adi (2 kiLai)") == ["Adi"]
    assert canon.canon_multi("Adi (kaNNan varuginDra") == ["Adi"]
    assert canon.canon_multi("") == []


# --- Tag normalisation ----------------------------------------------------------------


def test_normalise_tag_strips_index_bookkeeping():
    assert normalise_tag("Krishna Namavali - ByAltSongTitle") == ("Krishna Namavali", None)
    assert normalise_tag("Bhagavatham| All") == ("Bhagavatham", None)
    assert normalise_tag("01 - Thodaya Mangalam") == ("Thodaya Mangalam", 1)
    assert normalise_tag("09 - Mangalam") == ("Mangalam", 9)


def test_parse_volume():
    assert parse_volume("Vol 17 - HHMuralidharaSwamiji - Ashwin Ji") == (
        "Vol 17 — HHMuralidharaSwamiji",
        "Ashwin Ji",
    )
    assert parse_volume("Krishna Namavali") is None


def test_tags_carry_no_ordinal_prefix(songs):
    bad = [(s["id"], t) for s in songs for t in s["tags"] if t[:2].isdigit() and " - " in t[:6]]
    assert not bad, bad[:10]


def test_album_tags_are_split_out_of_tags(songs):
    bad = [(s["id"], t) for s in songs for t in s["tags"] if t.lower().startswith("vol ")]
    assert not bad, bad[:10]


# --- Occasions ------------------------------------------------------------------------


def test_every_occasion_matches_some_songs(report):
    empty = [k for k, v in report["occasions"].items() if v == 0]
    assert not empty, f"occasions matching nothing: {empty}"


def test_no_occasion_is_uselessly_broad(report):
    broad = {k: v for k, v in report["occasions"].items() if v > 2500}
    assert not broad, f"occasions matching most of the corpus: {broad}"


def test_enrichment_reports_no_warnings(report):
    assert report["warnings"] == []


def test_occasion_spot_checks(occasion_spec, by_id):
    """Each occasion names songs that must land in it."""
    failures: list[str] = []
    for occ in occasion_spec["occasions"]:
        for song_id in occ.get("spot_check", []):
            song = by_id.get(song_id)
            if song is None:
                failures.append(f"{occ['id']}: song {song_id} does not exist")
            elif occ["id"] not in song["occasions"]:
                failures.append(
                    f"{occ['id']}: song {song_id} ({song['title'][:50]!r}) no longer matches"
                )
    assert not failures, failures


def test_most_songs_reach_at_least_one_occasion(report):
    covered = report["songs"] - report["uncovered_songs"]
    assert covered / report["songs"] > 0.95, (
        f"only {covered}/{report['songs']} songs land in an occasion"
    )


def test_occasion_ids_are_unique(occasion_spec):
    ids = [o["id"] for o in occasion_spec["occasions"]]
    assert len(ids) == len(set(ids))


def test_occasion_groups_are_known(occasion_spec):
    allowed = {"festival", "sampradaya", "life"}
    bad = [(o["id"], o.get("group")) for o in occasion_spec["occasions"]
           if o.get("group") not in allowed]
    assert not bad, bad


def test_boosted_songs_are_a_subset_of_matched(songs):
    for s in songs:
        assert set(s["occasion_boost"]) <= set(s["occasions"]), s["id"]


# --- Roles / setlist ordering ---------------------------------------------------------


def test_roles_cover_the_session_sequence(report):
    roles = report["roles"]
    assert roles.get("thodaya-mangalam", 0) > 0, "session opening must be findable"
    assert roles.get("mangalam", 0) > 0, "session closing must be findable"


def test_role_pins(report):
    catalogue = {r["id"]: r for r in report["role_catalogue"]}
    assert catalogue["thodaya-mangalam"]["pin"] == "first"
    assert catalogue["mangalam"]["pin"] == "last"
    assert catalogue["thodaya-mangalam"]["order"] < catalogue["mangalam"]["order"]


def test_songs_with_a_role_also_have_role_order(songs):
    bad = [s["id"] for s in songs if bool(s["role"]) != (s["role_order"] is not None)]
    assert not bad, bad[:10]
