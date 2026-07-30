"""Song record schema and the field vocabulary of the source PDF."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

# Metadata field labels used by the source document, in the order they appear.
FIELD_LABELS: tuple[str, ...] = (
    "Title",
    "Composer",
    "Deity",
    "IndexedLinks",
    "Language",
    "Ragam",
    "Tags",
)

# Only these fields wrap onto continuation lines in the PDF. Allowing continuation on
# the others is what glues "Ragam:" onto Composer and tag text onto Language.
WRAPPING_FIELDS: frozenset[str] = frozenset({"Title", "IndexedLinks", "Tags"})

# First page carrying song records; everything before is the MasterIndex / TOC.
FIRST_SONG_PAGE = 1856

# Languages the corpus actually uses. Anything else signals a parse error, not a new
# language, so the parser repairs rather than accepting it.
KNOWN_LANGUAGES: frozenset[str] = frozenset(
    {"Sanskrit", "Tamil", "Telugu", "Kannada", "Marathi", "Hindi", "English", "Malayalam"}
)


@dataclass
class Song:
    """One kirtan as parsed from the master PDF."""

    id: int
    title: str                       # display title, id and index prefixes removed
    title_raw: str                   # exactly as printed, for provenance
    composer: str = ""
    deity: str = ""
    language: str = ""
    ragam: str = ""
    thalam: str = ""
    indexed: list[str] = field(default_factory=list)   # IndexedLinks category names
    tags: list[str] = field(default_factory=list)      # raw tag strings, pre-normalisation
    lyrics_roman: str = ""
    lyrics_native: str = ""          # kept for provenance; corrupted by PDF glyph order
    page: int = 0                    # source PDF page where the record starts

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ParseIssue:
    kind: str
    song_id: int | None
    page: int
    detail: str

    def to_json(self) -> dict[str, Any]:
        return asdict(self)
