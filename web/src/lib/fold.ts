/**
 * Transliteration folding — the single tokeniser for the whole system.
 *
 * This is a behavioural port of `build/mg/fold.py`. Both are driven by
 * `fixtures/folding_cases.json`, and `fold.test.ts` fails if they ever disagree. That
 * parity is load-bearing: the index is built with the Python version and queried with
 * this one, so any divergence makes indexed tokens permanently unreachable and results
 * silently vanish.
 *
 * Rule order matters. Vowel digraphs must run before repeated-letter collapse (otherwise
 * "ee" degrades to "e" and can never reach "i"); "ksh" must run before "sh"; "chh"
 * before "ch"; and the word-final "h" strip must come *after* the collapse, or folding
 * stops being idempotent ("ahh" -> "ah" -> "a").
 */

// Longest / most specific first, so a later rule cannot eat a prefix of an earlier one.
const CONSONANT_RULES: ReadonlyArray<readonly [string, string]> = [
  ['ksh', 'ks'],
  ['jn', 'gn'],
  ['njch', 'nch'],
  ['chh', 'c'],
  ['ch', 'c'],
  ['kh', 'k'],
  ['gh', 'g'],
  ['jh', 'j'],
  ['th', 't'],
  ['dh', 'd'],
  ['ph', 'p'],
  ['bh', 'b'],
  ['zh', 'l'],
  ['sh', 's'],
]

const VOWEL_RULES: ReadonlyArray<readonly [string, string]> = [
  ['aa', 'a'],
  ['ee', 'i'],
  ['ii', 'i'],
  ['oo', 'u'],
  ['uu', 'u'],
]

const COMBINING = /\p{M}+/gu
const NON_ALNUM = /[^a-z0-9]+/g
const REPEATED = /(.)\1+/g
// An anusvara written as "m" before a consonant is the same sound as "n"
// (samyutha / sanyutha). Only before a consonant: converting every "m" would wrongly
// merge "rama" with "rana".
const M_BEFORE_CONSONANT = /m(?=[bcdfghjklmnpqrstvxyz])/g

function replaceAll(input: string, rules: ReadonlyArray<readonly [string, string]>): string {
  let s = input
  for (const [from, to] of rules) s = s.split(from).join(to)
  return s
}

/** Fold a string to its canonical searchable form (space-separated tokens). */
export function fold(text: string): string {
  if (!text) return ''

  // 1. Decompose, drop diacritics, lowercase. Lowercasing alone handles the corpus's
  //    capitals-as-long-vowels convention: rAdhE -> radhe.
  let s = text.normalize('NFKD').replace(COMBINING, '').toLowerCase()

  s = replaceAll(s, CONSONANT_RULES)
  s = replaceAll(s, VOWEL_RULES)

  s = s.split('w').join('v')
  s = s.replace(M_BEFORE_CONSONANT, 'n')

  const out: string[] = []
  for (const raw of s.split(NON_ALNUM)) {
    if (!raw) continue
    let tok = raw.replace(REPEATED, '$1')
    if (tok.length > 1 && tok.endsWith('h')) tok = tok.slice(0, -1)
    if (tok) out.push(tok)
  }
  return out.join(' ')
}

/** Fold and return the token list. */
export function foldTokens(text: string): string[] {
  const folded = fold(text)
  return folded ? folded.split(' ') : []
}

/**
 * Fold to a single comparison key with no spaces.
 * Used for facet-value matching, where "Sri Sri Anna" and "srisrianna" should meet.
 */
export function foldKey(text: string): string {
  return fold(text).split(' ').join('')
}
