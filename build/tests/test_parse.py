"""Parse coverage regressions.

These are the highest-value tests in the project. A parser change that silently drops
songs, merges two records, or bleeds native script into the Roman lyrics produces a site
that looks completely fine and is quietly wrong. Every number below was verified against
the source PDF by hand, so any drift is a real regression until proven otherwise.

If a change here is intentional, update the constant AND say why in the commit message.
"""

from __future__ import annotations

import json
import re

import pytest

from mg.util import INTERIM_DIR

SONGS_PATH = INTERIM_DIR / "songs.json"
REPORT_PATH = INTERIM_DIR / "parse_report.json"

pytestmark = pytest.mark.skipif(
    not SONGS_PATH.exists(),
    reason="run 10_parse_songs.py first (needs build/cache/pages.jsonl)",
)


@pytest.fixture(scope="module")
def songs():
    return json.loads(SONGS_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def report():
    return json.loads(REPORT_PATH.read_text(encoding="utf-8"))


# --- Structural invariants ------------------------------------------------------------

EXPECTED_SONGS = 7898


def test_song_count(report):
    assert report["songs"] == EXPECTED_SONGS


def test_ids_unique(report):
    assert report["unique_ids"] == EXPECTED_SONGS
    assert report["duplicate_ids"] == []


def test_every_song_has_title_and_id(songs):
    for s in songs:
        assert s["id"] > 0, s
        assert s["title"].strip(), s


def test_records_span_the_song_pages(report):
    first, last = report["page_range"]
    assert first == 1856, "song records start on page 1856; earlier pages are the TOC"
    assert last >= 9500, "records should run to the end of the document"


# --- Field coverage -------------------------------------------------------------------
# Measured against the source. Tolerances are tight on purpose.

EXPECTED_COVERAGE = {
    "composer": 6577,
    "deity": 7792,
    "language": 7898,
    "ragam": 4915,
    "thalam": 3608,
    "tags": 7830,
    "indexed": 7898,
    "lyrics_roman": 7897,
}


@pytest.mark.parametrize("field,expected", sorted(EXPECTED_COVERAGE.items()))
def test_field_coverage(report, field, expected):
    actual = report["coverage"][field]
    assert actual == expected, (
        f"{field} coverage moved {expected} -> {actual}. "
        "If deliberate, update EXPECTED_COVERAGE and explain in the commit."
    )


EXPECTED_DISTINCT = {
    "deity": 94,
    "ragam": 465,
    "thalam": 80,
    "composer": 100,
    "language": 8,
}


@pytest.mark.parametrize("field,expected", sorted(EXPECTED_DISTINCT.items()))
def test_distinct_values(report, field, expected):
    assert report[field]["distinct"] == expected


EXPECTED_LANGUAGES = {
    "Sanskrit": 4119,
    "Tamil": 1482,
    "Telugu": 993,
    "Kannada": 773,
    "Marathi": 352,
    "Hindi": 172,
    "English": 6,
    "Malayalam": 1,
}


def test_language_distribution(report):
    assert report["language"]["values"] == EXPECTED_LANGUAGES


def test_top_deities(report):
    values = report["deity"]["values"]
    assert values["Krishna"] == 2337
    assert values["Rama"] == 1194
    assert values["Vittala"] == 364
    assert values["Radhe"] == 339


def test_top_composers(report):
    values = report["composer"]["values"]
    assert values["Sri Sri Anna"] == 2461
    assert values["H H Sri Sri Muralidhara Swamiji"] == 833
    assert values["Sri Thyagaraja Swamigal"] == 692


# --- Script separation ----------------------------------------------------------------

INDIC = re.compile(r"[ऀ-ॣ०-෿᳐-᳿꣠-ꣿ]")


def test_roman_lyrics_are_not_polluted_by_native_script(report):
    ratio = report["lyrics_roman_non_ascii_ratio"]
    assert ratio < 0.005, f"native-script bleed into Roman lyrics: {ratio:.4%}"


def test_no_indic_characters_in_roman_lyrics(songs):
    """The danda is allowed (it is verse punctuation); actual letters are not."""
    offenders = [s["id"] for s in songs if INDIC.search(s["lyrics_roman"])]
    assert not offenders, f"{len(offenders)} songs carry Indic letters in Roman lyrics: {offenders[:10]}"


def test_almost_every_song_has_lyrics(report):
    """Only the 'Preparation' placeholders and one one-line namavali are legitimately short."""
    short = report["short_lyrics"]
    assert len(short) <= 3, short
    assert {s["id"] for s in short} == {2363, 4816, 4832}


# --- Cross-checks against the document's own declared counts --------------------------


def test_toc_declared_total_is_close(report):
    """The TOC says 7835 'AllKirtans'; we parse 7898 records.

    The delta is real: the TOC's AllKirtans index excludes a handful of collections that
    still print full records (notably the composite-id Kolahala Brindavana Bhajanai
    series). Parsing more than the index declares is expected; parsing fewer is not.
    """
    declared = report["toc_declared_counts"]["AllKirtans"]
    assert declared == 7835
    assert report["songs"] >= declared


def test_known_song_parses_correctly(songs):
    """A hand-verified record: page 5011 of the source."""
    by_id = {s["id"]: s for s in songs}
    s = by_id[7344]
    assert s["title"] == "kaNDe kaNDe kaNDenayya kangaLa daNiyuva thanaka"
    assert s["composer"] == "Sri Purandara Dasar"
    assert s["deity"] == "Krishna"
    assert s["language"] == "Kannada"
    assert s["ragam"] == "Nadanamakriya"
    assert s["thalam"] == "Ekam"          # only present in the lyric body, not a field
    assert "Krishna Namavali" in s["tags"]
    assert "Kannada" in s["indexed"]


def test_wrapped_title_is_reassembled(songs):
    """Titles wrap across lines; the id can land on the continuation line."""
    by_id = {s["id"]: s for s in songs}
    s = by_id[397904393]
    assert s["title"].endswith("yashOdaiyammaikkum")
    assert s["composer"] == "Sri Sri Anna"


def test_fields_not_contaminated_by_collapsed_labels(songs):
    """The PDF sometimes emits two metadata fields on one physical line.

    A trailing colon inside a name ("Bhakti Patha:") is genuine source text; an embedded
    field label is corruption and means the collapsed-line splitter regressed.
    """
    labels = ("Title:", "Composer:", "Deity:", "IndexedLinks:", "Language:", "Ragam:", "Tags:")
    bad = [
        (s["id"], field, s[field])
        for s in songs
        for field in ("composer", "deity", "language", "ragam")
        if any(lbl in s[field] for lbl in labels)
    ]
    assert not bad, bad[:10]


def test_collapsed_line_songs_kept_their_tags(songs):
    """Song 2185's Composer and Tags share one physical line in the source."""
    by_id = {s["id"]: s for s in songs}
    s = by_id[2185]
    assert s["composer"] == "Thirumangai Azhwar"
    assert "Pasuram" in s["tags"]


def test_language_values_are_known(songs):
    allowed = set(EXPECTED_LANGUAGES)
    bad = [(s["id"], s["language"]) for s in songs if s["language"] not in allowed]
    assert not bad, bad[:10]


def test_tags_contain_no_bare_numbers(songs):
    """Trailing numerics in the Tags line are ordinals and ids, not tags."""
    bad = [(s["id"], t) for s in songs for t in s["tags"] if t.isdigit()]
    assert not bad, bad[:10]
