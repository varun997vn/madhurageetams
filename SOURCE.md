# Source document

This repository indexes a document that is **deliberately not stored here**.

| | |
|---|---|
| File | `MasterCopy_SourceLanguage_English_18Sep2025.pdf` |
| Size | 80,312,780 bytes (76.6 MiB) |
| SHA-256 | `3f2b537f5831fb68c9912776e2e90f4de372ab52f990a510d319139db86ea752` |
| Pages | 9,526 |
| Title | GOD MasterCopy All Kirtans |
| Author | Global Organization For Divinity |
| Generated | 18-Sep-2025 |

## Why it is not committed

The site's password gate protects the corpus by encrypting it. That protection is
worthless if the unencrypted 77 MB master copy is fetchable from this repository — and
deleting a file in a later commit does **not** remove it from history. So the PDF is
gitignored, and `.github/workflows/deploy.yml` fails the build if any PDF is ever found
anywhere in this repo's history.

## Keep a copy

The PDF is the input of record. Everything in `web/public/data/` is derived from it by a
deterministic pipeline, so the data can always be regenerated — but only from this exact
file. Store it somewhere private and verify it against the hash above before rebuilding:

```bash
shasum -a 256 MasterCopy_SourceLanguage_English_18Sep2025.pdf
```

Then place it at the repository root (or set `MG_PDF=/path/to/it`) and follow the
rebuild steps in README.md.
