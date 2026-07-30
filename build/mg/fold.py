"""Transliteration folding — the single tokeniser for the whole system.

The corpus is romanised with capitals marking long vowels and retroflex consonants
(``kriShNA``, ``thALam``, ``rAdhE``, ``gOvinda``). Nobody types that. Folding maps both
the corpus text and the user's query into one canonical form so ``krishna`` finds
``kriShNA``.

**Rule order is load-bearing.** Vowel digraphs must run before repeated-letter collapse
(otherwise ``ee`` degrades to ``e`` and can never reach ``i``); ``ksh`` must run before
``sh``; ``chh`` before ``ch``.

This file is mirrored byte-for-byte in behaviour by ``web/src/lib/fold.ts``. Both are
driven by ``fixtures/folding_cases.json`` so they cannot silently drift apart.

Deliberate over-folding, accepted because recall matters more than precision here:
``kAla``/``kaLa``/``kalA`` all fold to ``kala``; ``shiva``/``siva`` both to ``siva``.
Phrase queries re-verify against the raw text, which recovers the precision.
"""

from __future__ import annotations

import re
import unicodedata

# --- Step 2: consonant clusters and aspirates, applied in this exact order. -----------
# Longest / most specific first so a later rule cannot eat a prefix of an earlier one.
_CONSONANT_RULES: tuple[tuple[str, str], ...] = (
    ("ksh", "ks"),   # kShEtra -> ksetra ; user "kshetra" -> "ksetra"
    ("jn", "gn"),    # jnana / gnana -> gnana
    ("njch", "nch"), # sanjchAra -> sanchara (then ch -> c)
    ("chh", "c"),
    ("ch", "c"),
    ("kh", "k"),
    ("gh", "g"),
    ("jh", "j"),
    ("th", "t"),     # thyAgarAja -> tyagaraja
    ("dh", "d"),     # rAdhE -> rade
    ("ph", "p"),
    ("bh", "b"),     # kambhOji -> kamboji
    ("zh", "l"),     # Tamil zha: pazham -> palam
    ("sh", "s"),     # kriShNa -> krisna
)

# --- Step 3: long-vowel digraphs. MUST precede repeated-letter collapse. --------------
_VOWEL_RULES: tuple[tuple[str, str], ...] = (
    ("aa", "a"),
    ("ee", "i"),
    ("ii", "i"),
    ("oo", "u"),
    ("uu", "u"),
)

_TOKEN_SPLIT = re.compile(r"[^a-z0-9]+")
_REPEATED = re.compile(r"(.)\1+")
# An anusvara written as "m" before a consonant is the same sound as "n"
# (samyutha / sanyutha, samkirtana / sankirtana). Only before a consonant: converting
# every "m" would wrongly merge "rama" with "rana".
_M_BEFORE_CONSONANT = re.compile(r"m(?=[bcdfghjklmnpqrstvxyz])")


def _strip_marks(s: str) -> str:
    """NFKD-decompose and drop combining marks, so ṇ/ṛ/ā collapse to n/r/a."""
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def fold(text: str) -> str:
    """Fold a string to its canonical searchable form (space-separated tokens)."""
    if not text:
        return ""

    # 1. Decompose, drop diacritics, lowercase. Lowercasing alone handles the corpus's
    #    capitals-as-long-vowels convention: rAdhE -> radhe.
    s = _strip_marks(text).lower()

    # 2. Consonant clusters and aspirates.
    for src, dst in _CONSONANT_RULES:
        s = s.replace(src, dst)

    # 3. Long-vowel digraphs.
    for src, dst in _VOWEL_RULES:
        s = s.replace(src, dst)

    # 4. w -> v, and anusvara-style m -> n before a consonant.
    s = s.replace("w", "v")
    s = _M_BEFORE_CONSONANT.sub("n", s)

    # 5. Split into tokens on anything that is not a letter or digit. This also disposes
    #    of the corpus's visarga colons and the || / | stanza delimiters.
    tokens = [t for t in _TOKEN_SPLIT.split(s) if t]

    out: list[str] = []
    for tok in tokens:
        # 6. Collapse repeated-letter runs: viTTala -> vitala, kaNDe -> kande.
        tok = _REPEATED.sub(r"\1", tok)
        # 7. Drop a word-final h (visarga): namah -> nama. Never empty a token.
        #    Must follow the collapse, otherwise "ahh" -> "ah" -> "a" on a second pass
        #    and folding stops being idempotent.
        if len(tok) > 1 and tok.endswith("h"):
            tok = tok[:-1]
        if tok:
            out.append(tok)

    return " ".join(out)


def fold_tokens(text: str) -> list[str]:
    """Fold and return the token list."""
    folded = fold(text)
    return folded.split(" ") if folded else []


def fold_key(text: str) -> str:
    """Fold to a single comparison key with no spaces.

    Used for facet-value matching, where 'Sri Sri Anna' and 'srisrianna' should meet.
    """
    return fold(text).replace(" ", "")
