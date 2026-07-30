/**
 * Query execution: text matching, ranking, facet counts.
 *
 * Metadata search runs entirely off `core`, which is already in memory, so typing is
 * instant with no extra network cost. Lyrics search needs the inverted index, which is
 * fetched lazily the first time the user widens the scope.
 */

import * as bs from '../lib/bitset'
import { fold, foldTokens } from '../lib/fold'
import type { IndexBundle } from '../lib/types'
import type { Store } from './store'

const BM25_K1 = 1.2
const BM25_B = 0.75

// A title hit means far more than a lyric hit: the corpus repeats deity names in almost
// every song, so lyric frequency alone ranks nearly at random.
const FIELD_WEIGHT = { title: 3, meta: 2, lyrics: 1 }

export interface TextMatch {
  bits: bs.Bitset
  scores: Float32Array | null
  /** Folded quoted phrases, verified against raw lyrics for the top hits only. */
  phrases?: string[]
}

export class SearchEngine {
  private readonly store: Store
  private index: IndexBundle | null = null
  private tokenLookup: Map<string, number> | null = null
  private avgLyricLength = 1
  private synonyms: Record<string, string[]> = {}

  constructor(store: Store) {
    this.store = store
  }

  setIndex(index: IndexBundle): void {
    this.index = index
    this.tokenLookup = new Map(index.tokens.map((t, i) => [t, i] as const))
    const dl = this.store.core.dl
    let total = 0
    for (let i = 0; i < dl.length; i++) total += dl[i]!
    this.avgLyricLength = Math.max(1, total / Math.max(1, dl.length))
  }

  setSynonyms(synonyms: Record<string, string[]>): void {
    this.synonyms = synonyms
  }

  hasIndex(): boolean {
    return this.index !== null
  }

  /** Expand a folded query token with any configured synonyms. */
  private expand(token: string): string[] {
    const extra = this.synonyms[token]
    if (!extra || extra.length === 0) return [token]
    const out = [token]
    for (const alt of extra) {
      const folded = fold(alt)
      if (folded && !out.includes(folded)) out.push(folded)
    }
    return out
  }

  /**
   * Substring match over folded metadata. Used for the default scope, and as the
   * fallback when a lyrics-scoped query arrives before the index has loaded.
   */
  searchMetadata(query: string): TextMatch {
    const tokens = foldTokens(query)
    if (tokens.length === 0) return { bits: this.store.everything.slice(), scores: null }

    const bits = bs.create(this.store.count)
    const scores = new Float32Array(this.store.count)
    const titles = this.store.titleFolded
    const metas = this.store.metaFolded

    for (let slot = 0; slot < this.store.count; slot++) {
      const title = titles[slot]!
      const meta = metas[slot]!
      let score = 0
      let matchedAll = true

      for (const token of tokens) {
        let best = 0
        for (const variant of this.expand(token)) {
          if (title.startsWith(variant)) best = Math.max(best, 12)
          else if (hasWordPrefix(title, variant)) best = Math.max(best, 8)
          else if (title.includes(variant)) best = Math.max(best, 4)
          else if (hasWordPrefix(meta, variant)) best = Math.max(best, 3)
          else if (meta.includes(variant)) best = Math.max(best, 1)
        }
        if (best === 0) {
          matchedAll = false
          break
        }
        score += best
      }

      if (matchedAll) {
        bs.set(bits, slot)
        scores[slot] = score
      }
    }
    return { bits, scores }
  }

  /** Full-text search across titles, metadata and lyrics, ranked with BM25-lite. */
  searchFullText(query: string): TextMatch | null {
    const index = this.index
    const lookup = this.tokenLookup
    if (!index || !lookup) return null

    const tokens = foldTokens(query)
    if (tokens.length === 0) return { bits: this.store.everything.slice(), scores: null }

    const phrases = extractPhrases(query)
    const scores = new Float32Array(this.store.count)
    let conjunction: bs.Bitset | null = null

    for (const token of tokens) {
      const termBits = bs.create(this.store.count)
      let documentFrequency = 0

      for (const variant of this.expand(token)) {
        // Exact term, plus prefix expansion so a half-typed word still matches.
        const candidates = [variant, ...prefixMatches(index.tokens, lookup, variant)]
        for (const candidate of new Set(candidates)) {
          const at = lookup.get(candidate)
          if (at === undefined) continue
          const postings = index.postings[at]!
          documentFrequency += postings.length / 2
          this.accumulate(postings, termBits, scores, candidate === variant ? 1 : 0.5)
        }
      }

      if (documentFrequency === 0) return { bits: bs.create(this.store.count), scores }

      // IDF applied per term after accumulation, so rare words dominate the ranking.
      const idf = Math.log(1 + (this.store.count - documentFrequency + 0.5) / (documentFrequency + 0.5))
      bs.forEach(termBits, (slot) => {
        scores[slot]! *= idf
      })

      if (conjunction === null) conjunction = termBits
      else bs.andInto(conjunction, termBits)
    }

    const bits = conjunction ?? bs.create(this.store.count)
    return phrases.length ? { bits, scores, phrases } : { bits, scores }
  }

  private accumulate(
    postings: number[],
    termBits: bs.Bitset,
    scores: Float32Array,
    weight: number,
  ): void {
    const dl = this.store.core.dl
    let slot = 0
    for (let i = 0; i < postings.length; i += 2) {
      slot += postings[i]!
      const packed = postings[i + 1]!
      const mask = packed >>> 4
      const tf = packed & 15

      let fieldWeight = 0
      if (mask & 1) fieldWeight += FIELD_WEIGHT.title
      if (mask & 2) fieldWeight += FIELD_WEIGHT.meta
      if (mask & 4) fieldWeight += FIELD_WEIGHT.lyrics

      const length = Math.max(1, dl[slot] ?? 1)
      const norm = 1 - BM25_B + BM25_B * (length / this.avgLyricLength)
      const saturated = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm)

      bs.set(termBits, slot)
      scores[slot]! += saturated * fieldWeight * weight
    }
  }
}

function hasWordPrefix(haystack: string, needle: string): boolean {
  if (haystack.startsWith(needle)) return true
  return haystack.includes(' ' + needle)
}

/**
 * Tokens sharing a prefix, capped hard.
 *
 * The corpus has 205k tokens of which 152k are singletons (Sanskrit inflects heavily),
 * so an unbounded prefix scan on a short query would walk most of the vocabulary.
 */
function prefixMatches(tokens: string[], lookup: Map<string, number>, prefix: string): string[] {
  if (prefix.length < 3) return []
  if (lookup.has(prefix) && prefix.length < 4) return []

  let lo = 0
  let hi = tokens.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (tokens[mid]! < prefix) lo = mid + 1
    else hi = mid
  }

  const out: string[] = []
  for (let i = lo; i < tokens.length && out.length < 48; i++) {
    if (!tokens[i]!.startsWith(prefix)) break
    out.push(tokens[i]!)
  }
  return out
}

/** Quoted runs in the raw query, folded, for exact-phrase verification. */
export function extractPhrases(query: string): string[] {
  const out: string[] = []
  for (const match of query.matchAll(/"([^"]+)"/g)) {
    const folded = fold(match[1]!)
    if (folded.includes(' ')) out.push(folded)
  }
  return out
}
