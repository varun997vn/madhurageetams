#!/usr/bin/env python3
"""Stage 10 — turn the cached page stream into structured song records.

Reads build/cache/pages.jsonl, writes build/interim/songs.json plus a
build/interim/parse_report.json for human review.

Record shape in the source PDF:

    Title: <title> (<id>)
    Composer: <composer>            [optional]
    Deity: <deity>
    IndexedLinks: <comma list, wraps across lines>
    Language: <language>
    Ragam: <ragam>                  [optional]
    Tags: <comma list, wraps across lines, trailing numeric tokens are ordinals/ids>
    <native-script lyrics>
    <roman transliteration lyrics>  <- includes a "rAgam: X thALam: Y" header line

Two subtleties that this parser exists to handle:

1. Only Title / IndexedLinks / Tags wrap onto continuation lines. Permitting continuation
   on every field makes "Ragam:" get appended to Composer and tag text get appended to
   Language, which silently corrupts those facets for a handful of songs.
2. Thalam has no field of its own anywhere in the document. It appears only inside the
   lyric body's "rAgam: ... thALam: ..." header, so it must be lifted out of the lyrics.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

from mg.schema import (
    FIELD_LABELS,
    FIRST_SONG_PAGE,
    KNOWN_LANGUAGES,
    WRAPPING_FIELDS,
    ParseIssue,
    Song,
)
from mg.util import CACHE_DIR, INTERIM_DIR, ensure_dirs, readable_json, write_atomic

PAGES_JSONL = CACHE_DIR / "pages.jsonl"
SONGS_JSON = INTERIM_DIR / "songs.json"
REPORT_JSON = INTERIM_DIR / "parse_report.json"

FIELD_RE = re.compile(r"^(%s):\s*(.*)$" % "|".join(FIELD_LABELS))
# The PDF's text layer occasionally collapses two metadata lines into one physical line,
# e.g. "Composer: Thirumangai Azhwar Tags: Pasuram,  Pasuram| All,  2185". Without
# splitting on the embedded label the composer is corrupted AND the tags are lost
# entirely, so this recovers both.
EMBEDDED_FIELD_RE = re.compile(r"\s+(%s):\s" % "|".join(FIELD_LABELS))
# The id is the last parenthesised integer on the assembled Title line.
TITLE_ID_RE = re.compile(r"^(?P<title>.*)\((?P<id>\d+)\)\s*$")
# Lyric-body header carrying ragam and (only here) thalam. Both "rAgam: X thALam: Y" and
# the numbered variant "05. rAgam: X - Y" occur.
RAGAM_LINE_RE = re.compile(
    r"^\s*(?:\d+\.\s*)?rAgam\s*:\s*(?P<ragam>.*?)"
    r"(?:\s*(?:thALam\s*:|-)\s*(?P<thalam>.*?))?\s*$"
)
PAGE_HEADER_RE = re.compile(r"^Page\s*\|\s*\d+\s")
# TOC lines declaring corpus sizes, e.g. "AllKirtans (7835 Kirtans)".
TOC_COUNT_RE = re.compile(r"^(?P<name>[A-Za-z0-9]+)\s*\((?P<count>\d+)\s+Kirtans\)")
# Index prefixes the document prepends to some titles: "kannaDA| aNNA| 005 <title>".
TITLE_PREFIX_RE = re.compile(r"^(?:[A-Za-z]+\|\s*)+(?:\d+\s+)?")


# Indic script blocks. Testing "ord(c) > 0x08FF" instead would misclassify ordinary
# typographic punctuation -- U+2026 ellipsis, smart quotes, en/em dashes -- as native
# script and silently drop the Roman lines containing them.
_INDIC_RANGES: tuple[tuple[int, int], ...] = (
    (0x0900, 0x0DFF),  # Devanagari .. Sinhala, covering every script this corpus uses
    (0x1CD0, 0x1CFF),  # Vedic extensions
    (0xA8E0, 0xA8FF),  # Devanagari extended
)


# The danda and double danda sit in the Devanagari block but are used throughout this
# document as generic verse punctuation alongside Roman text ("|| SB 10.14.03 ||"), so
# treating them as script would discard those Roman lines.
_SCRIPT_NEUTRAL = frozenset({0x0964, 0x0965})


def is_indic(ch: str) -> bool:
    o = ord(ch)
    if o in _SCRIPT_NEUTRAL:
        return False
    return any(lo <= o <= hi for lo, hi in _INDIC_RANGES)


def native_ratio(line: str) -> float:
    """Fraction of characters belonging to an Indic script."""
    s = line.strip()
    if not s:
        return 0.0
    return sum(1 for c in s if is_indic(c)) / len(s)


def is_native(line: str) -> bool:
    return native_ratio(line) > 0.35


_LETTERS = re.compile(r"[A-Za-z]")


def roman_part(line: str) -> str:
    """Extract the Roman transliteration from a line, or '' if there isn't one.

    Most lines are purely one script. Where the PDF's two-column layout collides, a
    single extracted line holds native text followed by its Roman counterpart; keeping
    the longest Indic-free run recovers the Roman half instead of discarding the line.
    """
    s = line.rstrip()
    if not s.strip():
        return ""
    if not any(is_indic(c) for c in s):
        return s
    runs = "".join(" " if is_indic(c) else c for c in s).split("  ")
    best = max(runs, key=lambda r: len(_LETTERS.findall(r)), default="")
    return best.rstrip() if len(_LETTERS.findall(best)) >= 8 else ""


def strip_page_furniture(text: str) -> list[str]:
    """Drop the repeated 5-line header: two mahamantra lines, blank, MasterIndex, Page | N."""
    lines = text.split("\n")
    out: list[str] = []
    for i, line in enumerate(lines):
        if i < 6:
            s = line.strip()
            if not s or s == "MasterIndex" or PAGE_HEADER_RE.match(s) or is_native(line):
                continue
        out.append(line)
    return out


def collapse_blank_runs(lines: list[str]) -> list[str]:
    out: list[str] = []
    blank = 0
    for line in lines:
        if line.strip():
            blank = 0
            out.append(line.rstrip())
        else:
            blank += 1
            if blank == 1:
                out.append("")
    while out and not out[-1]:
        out.pop()
    while out and not out[0]:
        out.pop(0)
    return out


def split_list_field(value: str) -> list[str]:
    """Split a comma list, dropping the numeric ordinals/ids the document appends."""
    parts = [re.sub(r"\s+", " ", p).strip() for p in value.split(",")]
    return [p for p in parts if p and not p.isdigit()]


class Parser:
    def __init__(self) -> None:
        self.songs: list[Song] = []
        self.issues: list[ParseIssue] = []
        self.toc_counts: dict[str, int] = {}
        self._meta: dict[str, str] = {}
        self._current_field: str | None = None
        self._in_meta = False
        self._lyric_lines: list[str] = []
        self._page = 0
        self._start_page = 0
        self._pages_with_records: set[int] = set()

    # -- issue helper ------------------------------------------------------------------
    def note(self, kind: str, detail: str, song_id: int | None = None) -> None:
        self.issues.append(ParseIssue(kind=kind, song_id=song_id, page=self._page, detail=detail))

    # -- record lifecycle --------------------------------------------------------------
    def flush(self) -> None:
        if not self._meta:
            return
        meta, lyric_lines, start_page = self._meta, self._lyric_lines, self._start_page
        self._meta, self._lyric_lines = {}, []

        title_raw = re.sub(r"\s+", " ", meta.get("Title", "")).strip()
        m = TITLE_ID_RE.match(title_raw)
        if not m:
            self.note("title_without_id", f"page {start_page}: {title_raw[:120]!r}")
            return
        song_id = int(m.group("id"))
        title = m.group("title").strip()
        title = TITLE_PREFIX_RE.sub("", title).strip() or title

        # Repair fields that a wrapped list bled into.
        composer = meta.get("Composer", "").strip()
        ragam = meta.get("Ragam", "").strip()
        if "Ragam:" in composer:
            composer, _, spill = composer.partition("Ragam:")
            composer = composer.strip()
            ragam = ragam or spill.strip()
            self.note("composer_absorbed_ragam", f"repaired to {composer!r}", song_id)

        language = meta.get("Language", "").strip()
        if language and language not in KNOWN_LANGUAGES:
            head = language.split()[0] if language.split() else ""
            if head in KNOWN_LANGUAGES:
                self.note("language_absorbed_tags", f"{language[:60]!r} -> {head!r}", song_id)
                language = head
            else:
                self.note("language_unknown", f"{language[:60]!r}", song_id)
                language = ""

        # Separate the two script blocks and lift the ragam/thalam header out of the lyrics.
        roman: list[str] = []
        native: list[str] = []
        thalam = ""
        for line in lyric_lines:
            if not line.strip():
                roman.append("")
                native.append("")
                continue
            if is_native(line):
                native.append(line)
            roman_text = roman_part(line)
            if not roman_text.strip():
                continue
            line = roman_text
            hit = RAGAM_LINE_RE.match(line)
            if hit:
                found_thalam = (hit.group("thalam") or "").strip()
                # A few records print the label twice ("thALam: thALam: Adi").
                found_thalam = re.sub(r"^(?:thALam\s*:\s*)+", "", found_thalam).strip()
                found_ragam = (hit.group("ragam") or "").strip()
                if found_thalam and not thalam:
                    thalam = found_thalam
                if found_ragam and not ragam:
                    ragam = found_ragam
                continue
            roman.append(line)

        song = Song(
            id=song_id,
            title=title,
            title_raw=title_raw,
            composer=composer,
            deity=meta.get("Deity", "").strip(),
            language=language,
            ragam=ragam,
            thalam=thalam,
            indexed=split_list_field(meta.get("IndexedLinks", "")),
            tags=split_list_field(meta.get("Tags", "")),
            lyrics_roman="\n".join(collapse_blank_runs(roman)),
            lyrics_native="\n".join(collapse_blank_runs(native)),
            page=start_page,
        )
        self.songs.append(song)
        self._pages_with_records.add(start_page)

    # -- line dispatch -----------------------------------------------------------------
    def feed_page(self, page: int, text: str) -> None:
        self._page = page
        for line in strip_page_furniture(text):
            if page < FIRST_SONG_PAGE:
                hit = TOC_COUNT_RE.match(line.strip())
                if hit:
                    self.toc_counts[hit.group("name")] = int(hit.group("count"))
                continue
            self.feed_line(line)

    def _apply_field(self, label: str, value: str) -> None:
        if label == "Title":
            self.flush()
            self._meta = {"Title": value}
            self._start_page = self._page
            self._current_field = "Title"
            self._in_meta = True
        elif self._in_meta:
            self._meta[label] = value
            self._current_field = label
        # A field label encountered outside a metadata block is lyric text that happens
        # to look like one; ignore it rather than corrupting the previous record.

    def feed_line(self, line: str) -> None:
        hit = FIELD_RE.match(line)
        if hit:
            label, value = hit.group(1), hit.group(2).strip()
            # Recover a second field collapsed onto this physical line.
            split = EMBEDDED_FIELD_RE.search(value)
            if split:
                rest = value[split.start() :].strip()
                value = value[: split.start()].strip()
                self._apply_field(label, value)
                self.note(
                    "collapsed_field_line",
                    f"{label} line also carried {split.group(1)}",
                )
                self.feed_line(rest)
                return
            self._apply_field(label, value)
            return

        if not self._meta:
            return

        if self._in_meta:
            if not line.strip():
                # A blank line inside the block ends the current field but not the block;
                # the document puts blanks between the metadata and the lyrics.
                self._current_field = None
                return
            if self._current_field in WRAPPING_FIELDS and not is_native(line):
                self._meta[self._current_field] = (
                    self._meta[self._current_field] + " " + line.strip()
                )
                return
            # Anything else is the start of the lyric body.
            self._in_meta = False

        self._lyric_lines.append(line)

    def finish(self) -> None:
        self.flush()


def build_report(parser: Parser) -> dict:
    songs = parser.songs
    ids = [s.id for s in songs]
    dupes = [i for i, n in Counter(ids).items() if n > 1]

    def dist(attr: str, limit: int = 0) -> dict:
        c = Counter(getattr(s, attr) or "(none)" for s in songs)
        items = c.most_common(limit) if limit else c.most_common()
        return {"distinct": len([k for k in c if k != "(none)"]), "values": dict(items)}

    non_ascii = sum(
        1 for s in songs for ch in s.lyrics_roman if ord(ch) > 127
    )
    total_chars = sum(len(s.lyrics_roman) for s in songs)

    tag_counter: Counter[str] = Counter()
    for s in songs:
        for t in s.tags:
            tag_counter[t] += 1

    by_kind: dict[str, int] = defaultdict(int)
    for issue in parser.issues:
        by_kind[issue.kind] += 1

    song_pages = sorted(parser._pages_with_records)
    gap_pages: list[int] = []
    if song_pages:
        # Pages inside the song range that produced no record start are normal (a long
        # song spans pages); this only flags a suspiciously long run of them.
        run = 0
        prev = song_pages[0]
        for p in song_pages[1:]:
            run = p - prev
            if run > 25:
                gap_pages.append(prev)
            prev = p

    return {
        "songs": len(songs),
        "unique_ids": len(set(ids)),
        "duplicate_ids": sorted(dupes),
        "id_range": [min(ids), max(ids)] if ids else [],
        "page_range": [min(song_pages), max(song_pages)] if song_pages else [],
        "coverage": {
            "composer": sum(1 for s in songs if s.composer),
            "deity": sum(1 for s in songs if s.deity),
            "language": sum(1 for s in songs if s.language),
            "ragam": sum(1 for s in songs if s.ragam),
            "thalam": sum(1 for s in songs if s.thalam),
            "tags": sum(1 for s in songs if s.tags),
            "indexed": sum(1 for s in songs if s.indexed),
            "lyrics_roman": sum(1 for s in songs if s.lyrics_roman.strip()),
            "lyrics_native": sum(1 for s in songs if s.lyrics_native.strip()),
        },
        "lyrics_roman_non_ascii_ratio": (non_ascii / total_chars) if total_chars else 0.0,
        "language": dist("language"),
        "deity": dist("deity", 40),
        "ragam": dist("ragam", 40),
        "thalam": dist("thalam"),
        "composer": dist("composer", 40),
        "tags": {"distinct": len(tag_counter), "top": dict(tag_counter.most_common(40))},
        "short_lyrics": [
            {"id": s.id, "page": s.page, "title": s.title[:80], "len": len(s.lyrics_roman)}
            for s in songs
            if len(s.lyrics_roman) < 40
        ],
        "longest_lyrics": [
            {"id": s.id, "page": s.page, "title": s.title[:80], "len": len(s.lyrics_roman)}
            for s in sorted(songs, key=lambda s: -len(s.lyrics_roman))[:10]
        ],
        "large_page_gaps": gap_pages,
        "toc_declared_counts": dict(sorted(parser.toc_counts.items())),
        "issues_by_kind": dict(sorted(by_kind.items())),
        "issues": [i.to_json() for i in parser.issues[:200]],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pages", type=Path, default=PAGES_JSONL)
    ap.add_argument("--out", type=Path, default=SONGS_JSON)
    ap.add_argument("--report", type=Path, default=REPORT_JSON)
    ap.add_argument("--expect", type=int, default=7898, help="expected song count (0 = no gate)")
    args = ap.parse_args()

    ensure_dirs()
    if not args.pages.exists():
        print(f"missing {args.pages} — run 00_extract_text.py first", file=sys.stderr)
        return 2

    parser = Parser()
    with args.pages.open("r", encoding="utf-8") as fh:
        for raw in fh:
            rec = json.loads(raw)
            parser.feed_page(rec["page"], rec["text"])
    parser.finish()

    parser.songs.sort(key=lambda s: s.id)
    report = build_report(parser)

    write_atomic(args.out, readable_json([s.to_json() for s in parser.songs]))
    write_atomic(args.report, readable_json(report))

    cov = report["coverage"]
    print(f"songs:      {report['songs']}  (unique ids {report['unique_ids']})")
    print(f"pages:      {report['page_range']}")
    print(f"coverage:   composer {cov['composer']}  deity {cov['deity']}  "
          f"language {cov['language']}  ragam {cov['ragam']}  thalam {cov['thalam']}")
    print(f"            tags {cov['tags']}  indexed {cov['indexed']}  "
          f"lyrics {cov['lyrics_roman']}")
    print(f"distinct:   deity {report['deity']['distinct']}  ragam {report['ragam']['distinct']}  "
          f"thalam {report['thalam']['distinct']}  composer {report['composer']['distinct']}  "
          f"language {report['language']['distinct']}  tags {report['tags']['distinct']}")
    print(f"non-ascii in roman lyrics: {report['lyrics_roman_non_ascii_ratio'] * 100:.3f}%")
    if report["issues_by_kind"]:
        print(f"issues:     {report['issues_by_kind']}")
    print(f"wrote {args.out} and {args.report}")

    failures: list[str] = []
    if args.expect and report["songs"] != args.expect:
        failures.append(f"expected {args.expect} songs, parsed {report['songs']}")
    if report["duplicate_ids"]:
        failures.append(f"duplicate ids: {report['duplicate_ids'][:10]}")
    if report["lyrics_roman_non_ascii_ratio"] > 0.005:
        failures.append(
            f"native-script bleed into roman lyrics: "
            f"{report['lyrics_roman_non_ascii_ratio'] * 100:.3f}% > 0.5%"
        )
    if len(report["short_lyrics"]) > 5:
        failures.append(f"{len(report['short_lyrics'])} songs with <40 chars of lyrics")
    if failures:
        print("\nPARSE GATE FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
