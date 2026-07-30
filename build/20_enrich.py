#!/usr/bin/env python3
"""Stage 20 — canonicalise facets and derive the occasion taxonomy.

Reads build/interim/songs.json, applies build/rules/*.yaml, writes
build/interim/songs_enriched.json.

This is the stage a human iterates on. Editing rules/occasions.yaml and re-running
`python run_all.py --from 20` takes seconds and never re-reads the PDF.

What it derives:
  * canonical ragam / thalam (58 thalam spellings collapse to ~19 real thalams)
  * clean tag vocabulary, with the document's index bookkeeping stripped
    ("- ByAltSongTitle", "| All", the "NN - " session ordinal)
  * `seq` / `role`  — the bhajan-session position, which drives setlist auto-ordering
  * `album` / `singer` from the "Vol NN - <collection> - <singer>" tags
  * `catalog` — the merged category facet
  * `occasions` — the festival/occasion taxonomy the landing page is built on
  * folded forms of every searchable field
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import yaml

from mg.canon import Canonicaliser, normalise_tag, parse_volume
from mg.fold import fold, fold_key
from mg.util import INTERIM_DIR, REPO_DIR, RULES_DIR, ensure_dirs, readable_json, write_atomic

SONGS_JSON = INTERIM_DIR / "songs.json"
OUT_JSON = INTERIM_DIR / "songs_enriched.json"
REPORT_JSON = INTERIM_DIR / "enrich_report.json"
SITE_META_JSON = REPO_DIR / "web" / "src" / "data" / "site-meta.json"

# An occasion matching nothing is a broken rule; one matching most of the corpus is a
# useless filter. Both are worth shouting about.
MIN_REASONABLE = 1
MAX_REASONABLE = 2500


def load_yaml(name: str) -> dict:
    path = RULES_DIR / name
    with path.open("r", encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


class OccasionMatcher:
    """Evaluates rules/occasions.yaml against enriched songs."""

    KEYS = ("tags_any", "deity_any", "indexed_any", "composer_any",
            "title_kw_any", "lyrics_kw_any")

    def __init__(self, spec: dict) -> None:
        self.occasions: list[dict] = spec.get("occasions", [])
        for occ in self.occasions:
            occ["_any"] = [self._prepare(c) for c in occ.get("any", [])]
            occ["_none"] = self._prepare(occ["none"]) if occ.get("none") else None
        seen: set[str] = set()
        for occ in self.occasions:
            if occ["id"] in seen:
                raise ValueError(f"duplicate occasion id {occ['id']!r}")
            seen.add(occ["id"])

    @staticmethod
    def _prepare(clause: dict) -> dict:
        out: dict = {}
        for key in OccasionMatcher.KEYS:
            values = clause.get(key)
            if not values:
                continue
            if key.endswith("_kw_any"):
                # Keyword rules are written in plain ASCII and matched as folded tokens.
                out[key] = {fold(v) for v in values if fold(v)}
            else:
                out[key] = {fold_key(v) for v in values if fold_key(v)}
        unknown = set(clause) - set(OccasionMatcher.KEYS)
        if unknown:
            raise ValueError(f"unknown occasion rule keys: {sorted(unknown)}")
        return out

    @staticmethod
    def _clause_matches(clause: dict, song: dict) -> bool:
        if not clause:
            return False
        for key, wanted in clause.items():
            if key == "tags_any":
                have = song["_tag_keys"]
            elif key == "deity_any":
                have = song["_deity_keys"]
            elif key == "indexed_any":
                have = song["_indexed_keys"]
            elif key == "composer_any":
                have = song["_composer_keys"]
            elif key == "title_kw_any":
                have = song["_title_tokens"]
            elif key == "lyrics_kw_any":
                have = song["_lyrics_tokens"]
            else:  # pragma: no cover - guarded in _prepare
                return False
            if not (wanted & have):
                return False
        return True

    def match(self, song: dict) -> list[str]:
        hits: list[str] = []
        for occ in self.occasions:
            if not any(self._clause_matches(c, song) for c in occ["_any"]):
                continue
            if occ["_none"] and self._clause_matches(occ["_none"], song):
                continue
            hits.append(occ["id"])
        return hits

    def boosted(self, occ_id: str, song: dict) -> bool:
        occ = next(o for o in self.occasions if o["id"] == occ_id)
        boost = {fold_key(t) for t in occ.get("boost_tags", [])}
        return bool(boost & song["_tag_keys"])

    def catalogue(self) -> list[dict]:
        return [
            {
                "id": o["id"],
                "label": o["label"],
                "group": o.get("group", "other"),
                "icon": o.get("icon", ""),
                "blurb": o.get("blurb", ""),
                "month_hint": o.get("month_hint", ""),
                "priority": o.get("priority", 500),
            }
            for o in self.occasions
        ]


def build_roles(spec: dict) -> tuple[dict[str, dict], list[dict]]:
    """Map a folded tag key to its bhajan-session role."""
    roles = spec.get("roles", [])
    by_tag: dict[str, dict] = {}
    for role in roles:
        for tag in role.get("match_tags", []):
            by_tag[fold_key(tag)] = role
    return by_tag, roles


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--songs", type=Path, default=SONGS_JSON)
    ap.add_argument("--out", type=Path, default=OUT_JSON)
    ap.add_argument("--strict", action="store_true",
                    help="fail on an occasion that matches nothing or nearly everything")
    args = ap.parse_args()

    ensure_dirs()
    if not args.songs.exists():
        print(f"missing {args.songs} — run 10_parse_songs.py first", file=sys.stderr)
        return 2

    songs = json.loads(args.songs.read_text(encoding="utf-8"))
    aliases = load_yaml("aliases.yaml")
    matcher = OccasionMatcher(load_yaml("occasions.yaml"))
    role_by_tag, role_list = build_roles(load_yaml("roles.yaml"))

    ragam_canon = Canonicaliser.build(
        (s["ragam"] for s in songs), aliases.get("ragam") or {}
    )
    thalam_canon = Canonicaliser.build(
        (s["thalam"] for s in songs), aliases.get("thalam") or {}
    )

    enriched: list[dict] = []
    for s in songs:
        tags: list[str] = []
        seq: int | None = None
        albums: list[str] = []
        singers: list[str] = []
        for raw_tag in s["tags"]:
            volume = parse_volume(raw_tag)
            if volume:
                album, singer = volume
                if album not in albums:
                    albums.append(album)
                if singer and singer not in singers:
                    singers.append(singer)
                continue
            clean, ordinal = normalise_tag(raw_tag)
            if ordinal is not None and seq is None:
                seq = ordinal
            if clean and clean not in tags:
                tags.append(clean)

        role = None
        for tag in tags:
            role = role_by_tag.get(fold_key(tag))
            if role:
                break

        # `catalog` is the single browsable category facet: the document's IndexedLinks
        # plus the tag vocabulary, minus the album tags already split out above.
        catalog: list[str] = []
        for value in list(s["indexed"]) + tags:
            if value and value not in catalog:
                catalog.append(value)

        record = {
            "id": s["id"],
            "title": s["title"],
            "composer": s["composer"],
            "deity": s["deity"],
            "language": s["language"],
            "ragam": ragam_canon.canon_multi(s["ragam"]),
            "thalam": thalam_canon.canon_multi(s["thalam"]),
            "tags": tags,
            "indexed": s["indexed"],
            "catalog": catalog,
            "albums": albums,
            "singers": singers,
            "seq": seq,
            "role": role["id"] if role else None,
            "role_order": role["order"] if role else None,
            "page": s["page"],
            "lyrics": s["lyrics_roman"],
        }

        # Folded views used by the matcher and, later, by the search index builder.
        record["_tag_keys"] = {fold_key(t) for t in tags} | {
            fold_key(t) for t in s["indexed"]
        }
        record["_deity_keys"] = {fold_key(s["deity"])} if s["deity"] else set()
        record["_indexed_keys"] = {fold_key(t) for t in s["indexed"]}
        record["_composer_keys"] = {fold_key(s["composer"])} if s["composer"] else set()
        record["_title_tokens"] = set(fold(s["title"]).split())
        record["_lyrics_tokens"] = set(fold(s["lyrics_roman"]).split())

        occasions = matcher.match(record)
        record["occasions"] = occasions
        record["occasion_boost"] = [o for o in occasions if matcher.boosted(o, record)]

        for key in list(record):
            if key.startswith("_"):
                del record[key]
        enriched.append(record)

    # --- report -----------------------------------------------------------------------
    occ_counts = Counter()
    for r in enriched:
        for o in r["occasions"]:
            occ_counts[o] += 1

    catalogue = matcher.catalogue()
    warnings: list[str] = []
    print(f"{'occasion':<26} {'group':<12} {'songs':>7}")
    print("-" * 48)
    for occ in sorted(catalogue, key=lambda o: (o["group"], o["priority"])):
        n = occ_counts.get(occ["id"], 0)
        flag = ""
        if n < MIN_REASONABLE:
            flag = "  <- MATCHES NOTHING"
            warnings.append(f"{occ['id']} matches no songs")
        elif n > MAX_REASONABLE:
            flag = "  <- TOO BROAD"
            warnings.append(f"{occ['id']} matches {n} songs (>{MAX_REASONABLE})")
        print(f"{occ['id']:<26} {occ['group']:<12} {n:>7}{flag}")

    uncovered = sum(1 for r in enriched if not r["occasions"])
    role_counts = Counter(r["role"] for r in enriched if r["role"])
    ragam_values = Counter(v for r in enriched for v in r["ragam"])
    thalam_values = Counter(v for r in enriched for v in r["thalam"])
    catalog_values = Counter(v for r in enriched for v in r["catalog"])
    album_values = Counter(v for r in enriched for v in r["albums"])

    print(f"\nsongs                : {len(enriched)}")
    print(f"in >=1 occasion      : {len(enriched) - uncovered} "
          f"({(len(enriched) - uncovered) / len(enriched):.1%})")
    print(f"in no occasion       : {uncovered}")
    print(f"ragam values         : {len(ragam_values)} (was 465 raw)")
    print(f"thalam values        : {len(thalam_values)} (was 81 raw)")
    print(f"catalog values       : {len(catalog_values)}")
    print(f"albums               : {len(album_values)}")
    print(f"songs with a role    : {sum(role_counts.values())}")

    report = {
        "songs": len(enriched),
        "occasions": {o["id"]: occ_counts.get(o["id"], 0) for o in catalogue},
        "occasion_catalogue": catalogue,
        "uncovered_songs": uncovered,
        "roles": dict(role_counts),
        "role_catalogue": [
            {k: v for k, v in r.items() if k != "match_tags"} for r in role_list
        ],
        "ragam_values": dict(ragam_values.most_common()),
        "thalam_values": dict(thalam_values.most_common()),
        "catalog_values": dict(catalog_values.most_common(200)),
        "album_values": dict(album_values.most_common()),
        "warnings": warnings,
    }

    write_atomic(args.out, readable_json(enriched))
    write_atomic(REPORT_JSON, readable_json(report))

    # The occasion labels, role order and query synonyms are UI chrome, not corpus
    # content: the unlock screen needs them before a key exists, and they reveal nothing
    # about the songs. They ship unencrypted, bundled into the app.
    site_meta = {
        "_comment": "Generated by build/20_enrich.py — do not edit by hand.",
        "occasions": sorted(catalogue, key=lambda o: (o["group"], o["priority"])),
        "roles": [
            {k: v for k, v in r.items() if k != "match_tags"} for r in role_list
        ],
        "synonyms": {
            fold(k): [fold(v) for v in vs]
            for k, vs in (load_yaml("aliases.yaml").get("query_synonyms") or {}).items()
        },
    }
    write_atomic(SITE_META_JSON, readable_json(site_meta))
    print(f"\nwrote {args.out}, {REPORT_JSON} and {SITE_META_JSON}")

    if warnings:
        print("\nWARNINGS:", file=sys.stderr)
        for w in warnings:
            print(f"  - {w}", file=sys.stderr)
        if args.strict:
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
