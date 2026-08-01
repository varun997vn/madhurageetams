# Madhurageetam — searchable index

A password-protected static site over the Madhurageetam master copy: **7,898 kirtans**,
filterable by occasion, deity, ragam, thalam, composer, language, category and album,
searchable inside the lyrics, with per-song and setlist downloads.

Live at **https://varun997vn.github.io/madhurageetams/**

The source is a 9,526-page PDF. This repo turns it into structured data, encrypts most of
it, and ships a client that decrypts it in the browser. The native-script lyrics are the
one deliberate exception — see [Security](#security).

---

## What's in the corpus

| | |
|---|---|
| Songs | 7,898 (unique stable ids) |
| Deity | 7,792 songs · 94 values |
| Ragam | 4,915 songs · 294 values |
| Thalam | 3,608 songs · 19 values |
| Composer | 6,577 songs · 100 values |
| Language | Sanskrit 4,119 · Tamil 1,482 · Telugu 993 · Kannada 773 · Marathi 352 · Hindi 172 · English 6 · Malayalam 1 |
| Category | 543 values |
| Occasions | 32 (derived — see below) |
| Albums | 46 volume tags |
| Scripts | Roman 7,892 · Devanagari 6,370 · Tamil 1,522 |

Lyrics are readable in **Roman transliteration, Devanagari or Tamil**, with an optional
side-by-side view. See [Scripts](#scripts) for what the source actually contains and why
there is no Telugu or Kannada option.

---

## Repository layout

```
build/          Python pipeline — runs offline, never in CI
  00_extract_text.py    PDF -> cache/pages.jsonl   (~12 min, run once)
  10_parse_songs.py     -> interim/songs.json + parse_report.json
  20_enrich.py          + rules/*.yaml -> interim/songs_enriched.json
  30_build_bundles.py   -> interim/bundles/{core,index,lyrics-NN}.json
  35_build_script_shards.py  native scripts from $MG_SOURCE -> web/public/data (plaintext)
  40_pack.py            gzip + AES-256-GCM -> web/public/data/*.enc
  run_all.py            orchestrator with stage skipping
  rules/                occasions.yaml, aliases.yaml, roles.yaml  <- edit these
  mg/                   fold, canon, crypto, schema, util
  tests/                pytest
fixtures/       Shared by pytest AND vitest, so the two sides cannot drift
web/            Vite + React + TypeScript app
  public/data/  Committed artifacts: 34 encrypted shards + manifest,
                and the plaintext native-script index and shards
  src/worker/   Owns the key, the corpus, the facet bitmaps and search
  e2e/smoke.mjs Playwright pass over a production build
```

---

## Scripts

The master copy prints every song's Roman transliteration beside **exactly one** Indic
script — Tamil for Tamil-language songs, Devanagari for everything else. So the reader
picks Roman, Devanagari or Tamil, and the option a given song does not carry is shown
disabled rather than hidden.

**There is no Telugu, Kannada or Malayalam option, and there cannot be one.** A Telugu song
is *printed in Devanagari* in this document. 993 songs are Telugu-language and 773 are
Kannada, so this is the most likely thing to be mistaken for a bug — the song page says so
in as many words next to the language chip. Nothing is machine-transliterated; every
character shown comes from the PDF.

This pipeline's own stage 10 cannot read that text: the PDF's embedded fonts ship a broken
`ToUnicode` CMap, so ordinary extraction returns the Indic columns in glyph-visual order
with vowel signs and reph before their consonant. The native text therefore comes from a
second, independent extraction — the private `madhurageetams-source` repository — which
reads raw glyph ids from the content streams and recovers text by shaping candidate Unicode
with HarfBuzz against the same embedded font, accepting a reading only when the shaped
glyph sequence matches the stored glyphs exactly. Measured round trip: **99.9958%**. The
61 songs with an unresolved glyph run are flagged in the UI rather than presented as fact.

Both extractions read a byte-identical PDF and are joined **by song id**, carried explicitly
in the shipped data rather than inferred from a shared ordering. `tests/test_script_shards.py`
re-checks the two ids that `test_parse.py` pins, every `spot_check` id in
`rules/occasions.yaml`, and — when `interim/bundles/core.json` is present — that the two
extractions cover the same 7,898 songs.

Three consequences worth knowing before changing any of this:

- **Structural headings exist only in the Roman column.** All 11,604 of them; the native
  arrays contain none. A native-only reading view gets its pallavi and charaNam markers by
  following a row's pairing back to its Roman counterpart.
- **The two columns wrap differently**, so 17.8% of rows have no counterpart. Side-by-side
  renders the missing side as an empty cell — no dash, no placeholder.
- **PDF export stays Roman.** pdf-lib positions glyphs from advance widths alone and
  discards GPOS mark attachment, so it renders Devanagari and Tamil *wrong* while looking
  plausible. Native script goes to paper through the setlist's **session sheet**, which is
  ordinary DOM plus `@media print` — the browser's own shaper does it correctly, and it
  costs no embedded font.

### How the native data ships

Unlike the rest of the corpus, the native-script lyrics are **not encrypted** — a deliberate
decision by the copyright holder, so that the feature needs no password-bearing build step.
See [Security](#security) for what that does and does not change.

| | |
|---|---|
| `web/public/data/native-index.json` | ~59 KB, plaintext, fetched eagerly. Song ids, shard ranges, per-song script, checksums. |
| `web/public/data/native-NN.json.gz` | 32 shards, 7.0 MB total, fetched only when a reader selects a native script. |

Gzipped on disk because the raw JSON is 26 MB, which would take the built artifact past the
20 MB ceiling `deploy.yml` asserts. Pages gzips JSON over the wire regardless, so this costs
nothing in transfer.

Everything here is keyed by **song id**, not by the slot numbering the encrypted bundles
use. Those are slot-indexed because they come from a single sorted pass over the parsed PDF;
these come from a different extraction, so a shared ordering would be an assumption to
verify rather than a fact. Carrying the ids makes the join explicit — and removes any
dependency on `core.json`, and therefore on the 12-minute PDF extraction that produces it.

Because they are absent from `manifest.json`, `prefetchLyrics()` cannot reach them: a reader
who never picks a native script cannot download 7 MB of Indic text even by accident.

If a build ships without this data, `stats.nativeScripts` goes false and the script picker
is **not rendered at all**, so the site looks like the Roman-only one it is. That matters:
an earlier deploy shipped the code without the data, and every song then showed a disabled
Devanagari button whose tooltip said the master copy does not print that song in
Devanagari — a claim about the corpus standing in for a fact about the deployment.
`deploy.yml` now fails rather than shipping that state; set the repository variable
`ROMAN_ONLY=1` to deploy without native scripts on purpose.

## Rebuilding

Requires the source PDF, which is **deliberately not in this repo** (see Security).
Put it at the repo root, or point `MG_PDF` at it.

```bash
cd build
pip install -e .                       # pypdf, PyYAML, cryptography

python 00_extract_text.py              # ~12 min, ONCE — caches the page text
MG_PASSWORD='…' MG_SOURCE=/path/to/madhurageetams-source/data \
  python run_all.py                    # stages 10-40, ~40 s
```

`MG_SOURCE` points at the private source dataset that supplies the native scripts. Without
it, stage 35 prints a skip and the rest of the pipeline produces the Roman-only site
exactly as before — so a contributor who only has this repository can still rebuild.

**Regenerating only the native scripts** needs neither the PDF nor the password, because
they are unencrypted and joined by song id:

```bash
cd build
MG_SOURCE=/path/to/madhurageetams-source/data python 35_build_script_shards.py
git add web/public/data && git commit
```

`00` is the only slow step. Everything downstream reads `build/cache/pages.jsonl`, so
after the first extraction a full rebuild is seconds.

### Refining the occasion taxonomy

The PDF has no occasion or festival field. `build/rules/occasions.yaml` is where that
judgement lives — deliberately in YAML rather than in code so it can be corrected
without touching the pipeline. Each rule matches on deity, tags, index links or folded
title keywords:

```yaml
- id: holi-dolotsavam
  label: Holi / Dolotsavam
  group: festival
  blurb: The swing festival — Dolotsavam songs and spring colour.
  spot_check: [341, 342, 343]     # these songs MUST match; asserted by the tests
  any:
    - tags_any: ["Dolotsavam", "Dolotsavam - M", "Dolotsavam - T"]
    - indexed_any: [Dolotsavam, DolotsavamByAnna, DolotsavamBySwamiji]
  boost_tags: ["Dolotsavam"]      # these rank first inside the occasion
```

Edit, then:

```bash
MG_PASSWORD='…' python run_all.py --from 20     # ~15 s, never re-reads the PDF
```

The stage prints a per-occasion count table and fails if any rule matches nothing or
more than 2,500 songs. `spot_check` ids are asserted by `pytest`, so narrowing a rule
until the obvious songs fall out is a test failure rather than a quietly empty card.

97.3% of songs land in at least one occasion.

### Running the tests

```bash
cd build && python -m pytest -q      # 486 tests: folding, parsing, enrichment, crypto, scripts
cd web   && npm test                 # folding parity, crypto interop, bitsets, script rows
cd web   && npm run build && npx vite preview --port 4173
MG_PASSWORD='…' node e2e/smoke.mjs   # 31 checks in a real browser
MG_PASSWORD='…' node e2e/mobile.mjs  # 124 checks across four viewports
MG_PASSWORD='…' node e2e/script.mjs  # 41 checks: scripts, set builder, print sheet
```

`e2e/script.mjs` asserts the two things a screenshot cannot show: that no native shard is
fetched before a reader picks a script, and that the Indic font stacks actually resolve.
Set `MG_CHROMIUM=/path/to/chrome` if the local Chromium is not the build Playwright pins.

The parse tests pin measured coverage numbers. A parser change that silently drops or
merges songs produces a site that looks completely fine and is quietly wrong, so any
drift fails the build. If a change is intentional, update the constant *and* say why.

---

## Security

**What the password actually protects.** GitHub Pages has no server-side auth, and a
Pages site is publicly reachable even from a private repo. So the gate is not a
JavaScript password check — it can't be, since anyone can read the page source. Instead
the *data itself* is encrypted with AES-256-GCM and the shipped HTML/JS is useless
without the key.

**Except the native-script lyrics, which are published in the clear.** `native-index.json`
and `native-NN.json.gz` are committed unencrypted at the copyright holder's direction, so
the Devanagari and Tamil columns — and the Roman column that travels beside them for the
side-by-side view — are readable by anyone with the repository URL, no password involved.
This is a deliberate trade for not needing a password-bearing build step, and it is
irreversible in the usual git sense: removing the files in a later commit does not remove
them from history, exactly as `SOURCE.md` says of the PDF. The encrypted shards still gate
the search index, the facets and the Roman lyrics of the 7,892 songs reachable through
them, so the password is not pointless — but it no longer gates the whole corpus, and this
paragraph exists so nobody assumes it does.

**The honest threat model.** Every ciphertext is publicly downloadable, so an attacker
brute-forces offline at whatever rate their hardware allows, unconstrained by anything
the site does. The 600,000 PBKDF2 iterations only multiply their per-guess cost by a
constant. **All real security comes from the entropy of the password.** That is why it
is generated by `secrets.token_urlsafe`-grade randomness, why `40_pack.py` refuses
anything under 16 characters, and why it must never be a memorable phrase — the same
scheme with `MadhuraGeetam2025!` would fall to a dictionary attack in hours.

The residual risk is *sharing*: anyone with the password can pass it on, or export the
decrypted lyrics. There is no revocation short of a rebuild, which is cheap and should
be treated as routine rather than an emergency:

```bash
MG_PASSWORD='<new password>' python 40_pack.py --rotate-salt
git add web/public/data && git commit && git push
```

Rotating the salt invalidates every cached session key, forcing everyone to re-enter the
new password.

**Why the PDF is gitignored.** Deleting a file in a later commit does not remove it from
history. If the unencrypted 77 MB master copy were reachable anywhere in this repo's
history, the gate would be theatre. `.github/workflows/deploy.yml` therefore fails the
build outright if any PDF is ever found in history. Keep the source PDF somewhere
private; `SOURCE.md` records its hash so a copy can be verified.

**Key handling in the client.** The derived key is cached in `sessionStorage`, so a
refresh does not re-run the KDF but closing the tab locks the site again — a shared or
family device should not stay unlocked indefinitely. "Keep this device unlocked" opts
into `localStorage`. "Lock" clears both and terminates the worker that holds the
plaintext.

---

## How search works

The corpus romanises with capitals for long vowels and retroflex consonants —
`kriShNA`, `thALam`, `rAdhE`, `gOvinda`. Nobody types that. Both the index and the query
pass through one folding function that collapses case, diacritics, aspirates (`th`→`t`,
`dh`→`d`, `sh`→`s`), long-vowel digraphs, and doubled consonants, so `krishna` finds
`kriShNA` and `vittala` finds `viThala`.

That function exists twice — `build/mg/fold.py` builds the index, `web/src/lib/fold.ts`
runs the queries — and both execute `fixtures/folding_cases.json` in CI. If they ever
disagree, indexed tokens become permanently unreachable and results vanish with no
error, so the parity test is not optional.

Folding is deliberately lossy: `kAla`, `kaLa` and `kalA` all fold together, as do `shiva`
and `siva`. Recall matters more than precision here, and a quoted `"hare rama"` re-checks
the exact phrase against the raw lyrics.

Payload: **220 KB** gzipped to first interactive (metadata + facets), **1.9 MB** more on
the first lyrics search (inverted index), and 2.6 MB of lyric shards warmed in the
background — skipped entirely on metered or slow connections. The native-script shards sit
outside all of that and are fetched only on demand; see [Scripts](#scripts).

---

## Deploying

Pushing to `claude/madhurageetam-search-site-5am8ec` or `main` triggers
`.github/workflows/deploy.yml`.

**One manual step:** in the repository, go to **Settings → Pages** and set **Source** to
**GitHub Actions**. This cannot be scripted from here.

CI never sees the password or the PDF; it only bundles the app around the committed
encrypted shards, then smoke-tests the deployed URL.

---

## Attribution

Content is from *GOD MasterCopy All Kirtans* (Global Organization For Divinity,
18-Sep-2025). This repository is an index over that document for the copyright holder's
own use; it is not a redistribution, which is precisely why the corpus is encrypted and
the source PDF is kept out of the repository.
