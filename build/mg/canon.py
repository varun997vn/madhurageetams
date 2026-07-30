"""Facet-value canonicalisation.

Two mechanisms, in this order:

1. **Folded grouping.** Values whose folded key matches are the same value, so
   "Kambhoji"/"kAmbhOji", "Mohanam"/"mOhanam" and 55 other ragam spelling pairs merge
   with no configuration at all. The most frequent spelling in a group becomes the
   display label, so the site shows the form a reader will recognise.
2. **Explicit aliases** from rules/aliases.yaml, for the cases folding cannot bridge --
   chiefly thalam, where the source has 58 spellings of about 19 actual thalams.

Multi-valued fields (a ragamalika, a thalam written as "Adi / chApu") are split on both
"," and "/", parentheticals are dropped, and each part is canonicalised independently.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Iterable

from mg.fold import fold_key

# Strip a trailing parenthetical note, and also an unclosed one -- the source contains
# "Adi (kaNNan varuginDra" with no closing bracket.
_PAREN = re.compile(r"\([^)]*\)?")
_SPLIT = re.compile(r"\s*[,/]\s*")


def split_multi(value: str) -> list[str]:
    """Split a possibly multi-valued facet string into cleaned parts."""
    if not value:
        return []
    parts: list[str] = []
    for raw in _SPLIT.split(value):
        cleaned = _PAREN.sub(" ", raw)
        cleaned = re.sub(r"\s+", " ", cleaned).strip(" -–—")
        if cleaned:
            parts.append(cleaned)
    return parts


@dataclass
class Canonicaliser:
    """Maps raw facet values to canonical display labels."""

    label_by_key: dict[str, str]

    @classmethod
    def build(
        cls,
        raw_values: Iterable[str],
        alias_map: dict[str, list[str]] | None = None,
    ) -> "Canonicaliser":
        """`alias_map` is {canonical label: [folded keys that mean it]}."""
        freq: Counter[str] = Counter()
        spellings: dict[str, Counter[str]] = defaultdict(Counter)
        for value in raw_values:
            for part in split_multi(value):
                key = fold_key(part)
                if not key:
                    continue
                freq[key] += 1
                spellings[key][part] += 1

        # Most frequent spelling wins; ties broken alphabetically for determinism.
        label_by_key = {
            key: sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
            for key, counter in spellings.items()
        }

        for canonical, keys in (alias_map or {}).items():
            for key in keys:
                label_by_key[fold_key(key)] = canonical

        return cls(label_by_key=label_by_key)

    def canon_one(self, part: str) -> str:
        key = fold_key(part)
        return self.label_by_key.get(key, part.strip()) if key else ""

    def canon_multi(self, value: str) -> list[str]:
        """Canonicalise a multi-valued string, preserving order and de-duplicating."""
        out: list[str] = []
        for part in split_multi(value):
            label = self.canon_one(part)
            if label and label not in out:
                out.append(label)
        return out


# --- Tag normalisation ----------------------------------------------------------------
# The document's tag list carries index bookkeeping that is meaningless as a filter:
#   "Krishna Namavali - ByAltSongTitle"  -> an alternate-title index, same songs
#   "Bhagavatham| All"                   -> an "all" rollup of the same tag
#   "01 - Thodaya Mangalam"              -> a session ordinal (kept separately as `seq`)
_BY_ALT = re.compile(r"\s*-\s*ByAltSongTitle\s*", re.I)
_ALL_SUFFIX = re.compile(r"\|\s*All\s*$", re.I)
_SEQ_PREFIX = re.compile(r"^(\d{1,2})\s*-\s*(.*)$")
# Volume tags appear in several shapes, including truncated ones where the source's
# Tags line wrapped mid-tag: "Vol 17 - HHMuralidharaSwamiji - Ashwin Ji",
# "Vol 12 - SlokamBySwamiji", "Vol 24 -", and a bare "Vol 24". All are album tags and
# none belong in the category facet, so this is parsed by splitting rather than by one
# regex that has to anticipate every truncation.
_VOLUME_HEAD = re.compile(r"^Vol\s+(\d+)\s*(.*)$", re.I)


def normalise_tag(tag: str) -> tuple[str, int | None]:
    """Return (clean tag, session ordinal or None)."""
    t = _BY_ALT.sub(" ", tag)
    t = _ALL_SUFFIX.sub("", t)
    t = re.sub(r"\s+", " ", t).strip(" |-")
    seq: int | None = None
    hit = _SEQ_PREFIX.match(t)
    if hit:
        seq = int(hit.group(1))
        t = hit.group(2).strip()
    return t, seq


def parse_volume(tag: str) -> tuple[str, str] | None:
    """Parse a volume tag into (album label, singer). Singer may be ''."""
    hit = _VOLUME_HEAD.match(tag.strip())
    if not hit:
        return None
    number = int(hit.group(1))
    parts = [p.strip() for p in hit.group(2).split("-")]
    parts = [p for p in parts if p]
    collection = parts[0] if parts else ""
    singer = " - ".join(parts[1:]) if len(parts) > 1 else ""
    label = f"Vol {number:02d} — {collection}" if collection else f"Vol {number:02d}"
    return label, singer
