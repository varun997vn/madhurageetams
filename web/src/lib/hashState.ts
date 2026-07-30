/**
 * All navigable state lives in `location.hash`.
 *
 * Hash routing rather than history routing is a requirement, not a preference: GitHub
 * Pages returns a hard 404 for any path it has no file for, so a deep link like
 * /madhurageetams/song/7344 would break on refresh. The usual 404.html redirect trick
 * costs a visible flash and loses scroll restoration. With the hash, every view is
 * shareable and refresh-safe with no server configuration at all.
 */

import type { FacetName, Filters, SortKey } from './types'
import { ALL_FACETS } from './types'

export type View = 'home' | 'browse' | 'song' | 'setlist' | 'insights'

export interface AppRoute {
  view: View
  songId?: number
  occasion?: string
  q: string
  scope: 'meta' | 'all'
  sort: SortKey
  filters: Filters
}

export const EMPTY_FILTERS: Filters = { values: {}, modes: {}, unset: {} }

export function defaultRoute(): AppRoute {
  return { view: 'home', q: '', scope: 'meta', sort: 'relevance', filters: EMPTY_FILTERS }
}

export function serialise(route: AppRoute): string {
  const params = new URLSearchParams()
  if (route.q) params.set('q', route.q)
  if (route.scope !== 'meta') params.set('scope', route.scope)
  if (route.sort !== 'relevance') params.set('sort', route.sort)
  if (route.occasion) params.set('occasion', route.occasion)

  for (const facet of ALL_FACETS) {
    const values = route.filters.values[facet]
    if (values?.length) params.set(facet, values.join('.'))
    if (route.filters.modes[facet] === 'and') params.set(`${facet}~mode`, 'and')
    if (route.filters.unset[facet]) params.set(`${facet}~unset`, '1')
  }

  const path =
    route.view === 'home'
      ? '/'
      : route.view === 'song'
        ? `/song/${route.songId ?? ''}`
        : `/${route.view}`
  const query = params.toString()
  return `#${path}${query ? `?${query}` : ''}`
}

export function parse(hash: string): AppRoute {
  const route = defaultRoute()
  const raw = hash.replace(/^#/, '')
  if (!raw || raw === '/') return route

  const [path, queryString = ''] = raw.split('?')
  const segments = (path ?? '').split('/').filter(Boolean)

  if (segments[0] === 'browse') route.view = 'browse'
  else if (segments[0] === 'setlist') route.view = 'setlist'
  else if (segments[0] === 'insights') route.view = 'insights'
  else if (segments[0] === 'song') {
    route.view = 'song'
    const id = Number(segments[1])
    if (Number.isFinite(id)) route.songId = id
  }

  const params = new URLSearchParams(queryString)
  route.q = params.get('q') ?? ''
  route.scope = params.get('scope') === 'all' ? 'all' : 'meta'
  route.sort = (params.get('sort') as SortKey) ?? 'relevance'
  const occasion = params.get('occasion')
  if (occasion) route.occasion = occasion

  const filters: Filters = { values: {}, modes: {}, unset: {} }
  for (const facet of ALL_FACETS) {
    const raw = params.get(facet)
    if (raw) {
      const values = raw
        .split('.')
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 0)
      if (values.length) filters.values[facet] = values
    }
    if (params.get(`${facet}~mode`) === 'and') filters.modes[facet] = 'and'
    if (params.get(`${facet}~unset`) === '1') filters.unset[facet] = true
  }
  route.filters = filters
  return route
}

export function navigate(route: AppRoute, replace = false): void {
  const target = serialise(route)
  if (location.hash === target) return
  if (replace) history.replaceState(null, '', target)
  else location.hash = target
}

export function toggleFacet(filters: Filters, facet: FacetName, index: number): Filters {
  const current = filters.values[facet] ?? []
  const next = current.includes(index)
    ? current.filter((i) => i !== index)
    : [...current, index].sort((a, b) => a - b)
  const values = { ...filters.values }
  if (next.length) values[facet] = next
  else delete values[facet]
  return { ...filters, values }
}

export function clearFacet(filters: Filters, facet: FacetName): Filters {
  const values = { ...filters.values }
  delete values[facet]
  const unset = { ...filters.unset }
  delete unset[facet]
  return { ...filters, values, unset }
}

export function countActiveFilters(filters: Filters): number {
  let total = 0
  for (const facet of ALL_FACETS) {
    total += filters.values[facet]?.length ?? 0
    if (filters.unset[facet]) total += 1
  }
  return total
}
