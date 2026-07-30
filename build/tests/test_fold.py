"""Folding contract tests, driven by the shared fixture file.

The same fixture is executed by web/src/lib/fold.test.ts, so a divergence between the
Python build-time tokeniser and the TypeScript query-time tokeniser fails CI. That
parity is the whole reason search works: if the two disagree, indexed tokens become
unreachable and results silently vanish.
"""

from __future__ import annotations

import json

import pytest

from mg.fold import fold, fold_key, fold_tokens
from mg.util import FIXTURES_DIR

FIXTURE = json.loads((FIXTURES_DIR / "folding_cases.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: repr(c["in"])[:40])
def test_pinned_output(case):
    assert fold(case["in"]) == case["out"]


@pytest.mark.parametrize(
    "eq", FIXTURE["equivalences"], ids=lambda e: f'{e["corpus"]}~{e["user"]}'
)
def test_corpus_and_user_spellings_agree(eq):
    assert fold(eq["corpus"]) == fold(eq["user"]) == eq["folded"]


def test_idempotent():
    """Folding a folded string must be a no-op, or query-time re-folding would drift."""
    for case in FIXTURE["cases"]:
        once = fold(case["in"])
        assert fold(once) == once, f"not idempotent for {case['in']!r}"


def test_empty_and_punctuation_only():
    for s in ["", "   ", "|| ||", "---", "\n\n", ":", "."]:
        assert fold(s) == ""
        assert fold_tokens(s) == []


def test_tokens_never_empty_strings():
    for case in FIXTURE["cases"]:
        assert all(t for t in fold_tokens(case["in"]))


def test_fold_key_removes_spaces():
    assert fold_key("Sri Sri Anna") == "srisriana"
    assert " " not in fold_key("H H Sri Sri Muralidhara Swamiji")


def test_digits_survive():
    assert fold("Vol 17") == "vol 17"
    assert fold_tokens("01 - Thodaya Mangalam") == ["01", "todaya", "mangalam"]


def test_single_letter_h_not_emptied():
    assert fold("h") == "h"
    assert fold("ah") == "a"
