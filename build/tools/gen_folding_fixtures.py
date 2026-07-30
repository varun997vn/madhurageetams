#!/usr/bin/env python3
"""Regenerate fixtures/folding_cases.json.

Run after any change to mg/fold.py, then review the diff — a surprising change in the
`cases` output is the signal that a folding rule had a wider effect than intended.

    python tools/gen_folding_fixtures.py

The `equivalences` list is the real contract: each pair is a corpus spelling and a
spelling a user would plausibly type, and they must fold to the same value. Vowel-elision
differences (krsna, tulsidas) are deliberately NOT here — folding cannot fix a missing
vowel without becoming uselessly lossy. Those live in rules/aliases.yaml instead.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mg.fold import fold  # noqa: E402
from mg.util import FIXTURES_DIR  # noqa: E402

# (corpus spelling, plausible user spelling) — must fold identically.
EQUIVALENCES: list[tuple[str, str]] = [
    # Deities and names
    ("kriShNA", "krishna"), ("rAdhE", "radhe"), ("rAdhA", "radha"),
    ("gOvinda", "govinda"), ("jAnakI", "janaki"), ("anjanEya", "anjaneya"),
    ("nArasimha", "narasimha"), ("srInivAsa", "sreenivasa"), ("lakShmI", "lakshmi"),
    ("sarasvathI", "saraswathi"), ("gaNEsha", "ganesha"), ("mAdhava", "madava"),
    ("kEshava", "kesava"), ("achyutha", "acyuta"), ("pANDuranga", "panduranga"),
    ("vitthala", "vittala"), ("viThala", "vittala"), ("ranganAtha", "ranganata"),
    ("vEnkatEsha", "venkatesa"), ("nandagOpa", "nandagopa"), ("yashOdA", "yasoda"),
    ("ANDAL", "andal"), ("gOdA", "goda"), ("hanumAn", "hanuman"),
    # Composers
    ("thyAgarAja", "tyagaraja"), ("purandara dAsar", "Purandara Dasar"),
    ("bhadrAchala rAmadAsar", "bhadrachala ramadasar"),
    ("nArAyaNa thIrtthar", "narayana theerthar"),
    ("sadAshiva brahmEndral", "sadasiva brahmendral"), ("mIrAbhai", "meerabhai"),
    ("muraLIdhara", "muralidhara"), ("swAmiji", "svamiji"),
    ("ammAlu ammAL", "ammalu ammal"), ("tukkArAm", "tukkaram"),
    ("nAmdEv", "namdev"), ("EknAth", "eknath"), ("gnAnEshwar", "jnaneshwar"),
    ("kabIrdAs", "kabirdas"), ("nammAzhwAr", "nammalvar"), ("AzhwAr", "alwar"),
    # Ragams
    ("kambhOji", "kambhoji"), ("shankarAbharaNam", "sankarabharanam"),
    ("madhyamAvathi", "madhyamavati"), ("Anandabhairavi", "anandabhairavi"),
    ("mOhanam", "mohanam"), ("kalyANi", "kalyani"), ("bhairavi", "bairavi"),
    ("nAdanAmakriyA", "nadanamakriya"), ("kharaharapriyA", "kharaharapriya"),
    ("kEdAragauLa", "kedaragaula"), ("punnAgavarALi", "punnagavarali"),
    ("sindhubhairavi", "sindubhairavi"), ("yadukulakAmbhOji", "yadukulakamboji"),
    ("dhanyAsi", "dhanyasi"), ("sAvEri", "saveri"), ("asAvEri", "asaveri"),
    ("bhUpALam", "bhupalam"), ("nIlAmbari", "nilambari"), ("sAhAnA", "sahana"),
    ("hindOLam", "hindolam"), ("brindAvana sAranga", "brindavana saranga"),
    # Thalams / musical terms
    ("thALam", "thalam"), ("kIrtthana", "kirtana"), ("shlOkam", "slokam"),
    ("nAmAvaLi", "namavali"), ("aShTapadi", "ashtapadi"), ("aShTakam", "ashtakam"),
    ("tharangam", "tarangam"), ("divyanAmam", "divyanamam"), ("abhang", "abang"),
    ("pAsuram", "pasuram"), ("gIthAvaLi", "geethavali"),
    ("kIrtthanAvaLi", "keerthanavali"),
    # Categories / occasions
    ("kShEtram", "kshetram"), ("mangaLam", "mangalam"),
    ("thODaya mangaLam", "thodaya mangalam"), ("pavvaLimpu", "pavvalimpu"),
    ("dOlOtsavam", "dolotsavam"), ("kalyANa utsavam", "kalyana utsavam"),
    ("nithyOtsava", "nithyothsava"), ("vasantha kELikA", "vasanta kelika"),
    ("dashAvathAram", "dasavataram"), ("navarAthri", "navaratri"),
    ("shivarAthri", "sivaratri"), ("ekAdashi", "ekadasi"),
    ("guru pUrNimA", "guru purnima"), ("rAma navami", "rama navami"),
    ("janmAShTami", "janmashtami"), ("gOkulAShTami", "gokulashtami"),
    ("rAdhAShTami", "radhashtami"), ("sathsanga", "satsanga"),
    ("nAma mahimA", "nama mahima"), ("upadEsha", "upadesa"),
    ("prArtthana", "prartana"), ("dhyAnam", "dyanam"), ("bhakthi", "bakti"),
    ("rukmiNi pariNaya", "rukmini parinaya"), ("prahlAda", "prahlada"),
    ("bhagavatham", "bagavatam"), ("vaiShNava", "vaishnava"),
    ("thirupathi", "tirupati"), ("brindAvanam", "brindavanam"),
    # Anusvara variants
    ("sankIrtthana", "samkIrtthana"), ("samyutha", "sanyutha"),
    # Misc
    ("shrI", "sri"), ("uyyAla", "uyyala"), ("gnAna", "jnana"),
    ("namaH", "namah"), ("pazham", "palam"), ("sanjchAra", "sanchara"),
    ("prEma", "prema"), ("Ananda", "ananda"), ("dEvaki", "devaki"),
]

# Inputs whose exact folded output we pin, including adversarial ones.
EDGE_CASES: list[str] = [
    "", " ", "   ", "\n\t", "01.", "|| 05 ||", "puNya: cha", "namaH shivAya",
    "kSha", "kShu", "ksh", "zh", "zhazha",
    "aa", "aaa", "ee", "eee", "oo", "uu", "ii", "a",
    "h", "hh", "ah", "ahh", "w", "ww", "www",
    "Vol 17 - HHMuralidharaSwamiji - Ashwin Ji", "01 - Thodaya Mangalam",
    "Slokam| Others", "Tenth Canto Kirtans - ByAltSongTitle",
    "sam-yutha", "sam yutha", "ChChandra", "cchandra",
    "123", "abc123", "ABC123",
    "kṛṣṇa", "rādhā", "śiva", "shiva", "siva",
    "kAla", "kaLa", "kalA", "kala",
    "hare rama hare rama rama rama hare hare",
    "-", "--", "  leading and trailing  ", "a|b", "x", "X",
]


def main() -> int:
    broken = [(a, b, fold(a), fold(b)) for a, b in EQUIVALENCES if fold(a) != fold(b)]
    if broken:
        print("FAIL: equivalences that do not hold under the current fold():")
        for a, b, fa, fb in broken:
            print(f"  {a!r} -> {fa!r}   !=   {b!r} -> {fb!r}")
        print("\nFix mg/fold.py, or move the pair to rules/aliases.yaml if folding "
              "genuinely cannot bridge it (e.g. an elided vowel).")
        return 1

    seen: dict[str, None] = {}
    for a, b in EQUIVALENCES:
        seen[a] = None
        seen[b] = None
    for t in EDGE_CASES:
        seen[t] = None

    payload = {
        "_comment": (
            "Shared contract for build/mg/fold.py (pytest) and web/src/lib/fold.ts (vitest). "
            "'cases' pins fold() output exactly. 'equivalences' asserts that a corpus spelling "
            "and a plausible user spelling fold to the same value. "
            "Regenerate with build/tools/gen_folding_fixtures.py."
        ),
        "cases": [{"in": t, "out": fold(t)} for t in seen],
        "equivalences": [
            {"corpus": a, "user": b, "folded": fold(a)} for a, b in EQUIVALENCES
        ],
    }

    out = FIXTURES_DIR / "folding_cases.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {out}: {len(payload['cases'])} cases, "
          f"{len(payload['equivalences'])} equivalences (all holding)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
