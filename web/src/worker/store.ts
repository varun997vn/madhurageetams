/**
 * The decrypted corpus, plus the facet bitmaps every query is answered from.
 *
 * Lives entirely inside the worker, so the main thread never holds the key, never holds
 * the plaintext, and never blocks on a query.
 */

import * as bs from '../lib/bitset'
import { foldKey, foldTokens } from '../lib/fold'
import {
  ALL_FACETS,
  MULTI_FACETS,
  SINGLE_FACETS,
  type CoreBundle,
  type FacetName,
  type Filters,
  type MultiFacet,
  type SingleFacet,
} from '../lib/types'

export class Store {
  readonly core: CoreBundle
  readonly count: number

  /** One bitmap per (facet, dictionary index). */
  readonly facetBits: Record<FacetName, bs.Bitset[]>
  /** Songs with no value at all for a facet — an explicit, selectable bucket. */
  readonly unsetBits: Record<FacetName, bs.Bitset>
  /** Folded title tokens, for instant metadata search with no extra download. */
  readonly titleFolded: string[]
  readonly metaFolded: string[]
  readonly everything: bs.Bitset
  readonly slotById: Map<number, number>
  readonly occasionIndex: Map<string, number>

  constructor(core: CoreBundle) {
    this.core = core
    this.count = core.count
    this.everything = bs.createFull(core.count)
    this.slotById = new Map(core.ids.map((id, slot) => [id, slot]))

    this.facetBits = {} as Record<FacetName, bs.Bitset[]>
    this.unsetBits = {} as Record<FacetName, bs.Bitset>

    for (const facet of SINGLE_FACETS) {
      const column = core.single[facet]
      const bits = core.dicts[facet].map(() => bs.create(core.count))
      const unset = bs.create(core.count)
      for (let slot = 0; slot < core.count; slot++) {
        const value = column[slot]!
        if (value < 0) bs.set(unset, slot)
        else bs.set(bits[value]!, slot)
      }
      this.facetBits[facet] = bits
      this.unsetBits[facet] = unset
    }

    for (const facet of MULTI_FACETS) {
      const column = core.multi[facet]
      const bits = core.dicts[facet].map(() => bs.create(core.count))
      const unset = bs.create(core.count)
      for (let slot = 0; slot < core.count; slot++) {
        const values = column[slot]!
        if (values.length === 0) bs.set(unset, slot)
        for (const value of values) bs.set(bits[value]!, slot)
      }
      this.facetBits[facet] = bits
      this.unsetBits[facet] = unset
    }

    // Folding 7,898 titles takes a few tens of milliseconds and saves shipping a second
    // copy of every title in the bundle.
    this.titleFolded = core.titles.map((t) => foldTokens(t).join(' '))
    this.metaFolded = new Array(core.count)
    for (let slot = 0; slot < core.count; slot++) {
      const parts: string[] = []
      for (const facet of SINGLE_FACETS) {
        const idx = core.single[facet][slot]!
        if (idx >= 0) parts.push(core.dicts[facet][idx]!)
      }
      for (const facet of MULTI_FACETS) {
        for (const idx of core.multi[facet][slot]!) parts.push(core.dicts[facet][idx]!)
      }
      this.metaFolded[slot] = foldTokens(parts.join(' ')).join(' ')
    }

    this.occasionIndex = new Map(
      core.dicts.occasions.map((id, i) => [id, i] as const),
    )
  }

  value(facet: FacetName, slot: number): string[] {
    if ((SINGLE_FACETS as readonly string[]).includes(facet)) {
      const idx = this.core.single[facet as SingleFacet][slot]!
      return idx >= 0 ? [this.core.dicts[facet][idx]!] : []
    }
    return this.core.multi[facet as MultiFacet][slot]!.map((i) => this.core.dicts[facet][i]!)
  }

  /** Bitmap of songs passing every facet filter, optionally ignoring one facet.
   *
   * `exclude` is what makes facet counts behave the way people expect: the count shown
   * next to "Kambhoji" is computed with the ragam facet itself removed, so selecting a
   * second ragam widens rather than zeroes the list.
   */
  candidates(filters: Filters, exclude?: FacetName): bs.Bitset {
    let result: bs.Bitset | null = null

    for (const facet of ALL_FACETS) {
      if (facet === exclude) continue
      const selected = filters.values[facet] ?? []
      const wantUnset = filters.unset[facet] ?? false
      if (selected.length === 0 && !wantUnset) continue

      const mode = filters.modes[facet] ?? 'or'
      let facetBits: bs.Bitset

      if (mode === 'and' && selected.length > 0) {
        facetBits = this.facetBits[facet][selected[0]!]!.slice()
        for (let i = 1; i < selected.length; i++) {
          bs.andInto(facetBits, this.facetBits[facet][selected[i]!]!)
        }
        if (wantUnset) bs.orInto(facetBits, this.unsetBits[facet])
      } else {
        facetBits = bs.create(this.count)
        for (const index of selected) bs.orInto(facetBits, this.facetBits[facet][index]!)
        if (wantUnset) bs.orInto(facetBits, this.unsetBits[facet])
      }

      if (result === null) result = facetBits
      else bs.andInto(result, facetBits)
    }

    return result ?? this.everything.slice()
  }

  /** Slots that are a curated core example of an occasion, used to rank its view. */
  isBoosted(slot: number, occasionIndex: number): boolean {
    return this.core.boost[slot]!.includes(occasionIndex)
  }

  findFacetValue(facet: FacetName, label: string): number {
    const target = foldKey(label)
    const dict = this.core.dicts[facet]
    for (let i = 0; i < dict.length; i++) if (foldKey(dict[i]!) === target) return i
    return -1
  }
}
