# Madhurageetam — searchable index

A password-protected static site over the Madhurageetam master copy: **7,898 kirtans**,
filterable by occasion, deity, ragam, thalam, composer, language, category and album,
searchable inside the lyrics, with per-song and setlist downloads.

Live at **https://varun997vn.github.io/madhurageetams/**

The source is a 9,526-page PDF. This repo turns it into structured data, encrypts that
data, and ships a client that decrypts it in the browser.

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

Lyrics are the **Roman transliteration** only. The PDF's native-script text extracts in
glyph-visual order — vowel signs and reph land before their consonant — so shipping it
would mean shipping corrupted text. The transliteration extracts perfectly and is what
the file itself calls its source language. The native text *is* retained in
`build/interim/songs.json` for provenance, so adding a script toggle later would not
require re-extracting the PDF.

---

## Repository layout

```
build/          Python pipeline — runs offline, never in CI
  00_extract_text.py    PDF -> cache/pages.jsonl   (~12 min, run once)
  10_parse_songs.py     -> interim/songs.json + parse_report.json
  20_enrich.py          + rules/*.yaml -> interim/songs_enriched.json
  30_build_bundles.py   -> interim/bundles/{core,index,lyrics-NN}.json
  40_pack.py            gzip + AES-256-GCM -> web/public/data/*.enc
  run_all.py            orchestrator with stage skipping
  rules/                occasions.yaml, aliases.yaml, roles.yaml  <- edit these
  mg/                   fold, canon, crypto, schema, util
  tests/                pytest
fixtures/       Shared by pytest AND vitest, so the two sides cannot drift
web/            Vite + React + TypeScript app
  public/data/  Committed encrypted artifacts (34 shards + manifest)
  src/worker/   Owns the key, the corpus, the facet bitmaps and search
  e2e/smoke.mjs Playwright pass over a production build
```

---

## Rebuilding

Requires the source PDF, which is **deliberately not in this repo** (see Security).
Put it at the repo root, or point `MG_PDF` at it.

```bash
cd build
pip install -e .                       # pypdf, PyYAML, cryptography

python 00_extract_text.py              # ~12 min, ONCE — caches the page text
MG_PASSWORD='…' python run_all.py      # stages 10-40, ~25 s
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
cd build && python -m pytest -q      # 471 tests: folding, parsing, enrichment, crypto
cd web   && npm test                 # folding parity, crypto interop, bitsets
cd web   && npm run build && npx vite preview --port 4173
MG_PASSWORD='…' node e2e/smoke.mjs   # 31 checks in a real browser
```

The parse tests pin measured coverage numbers. A parser change that silently drops or
merges songs produces a site that looks completely fine and is quietly wrong, so any
drift fails the build. If a change is intentional, update the constant *and* say why.

---

## Security

**What the password actually protects.** GitHub Pages has no server-side auth, and a
Pages site is publicly reachable even from a private repo. So the gate is not a
JavaScript password check — it can't be, since anyone can read the page source. Instead
the *data itself* is encrypted with AES-256-GCM and the shipped HTML/JS is useless
without the key. Only the encrypted shards are ever published.

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
background — skipped entirely on metered or slow connections.

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
