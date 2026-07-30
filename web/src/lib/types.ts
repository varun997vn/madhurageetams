/** Shapes shared between the worker and the UI. */

export const SINGLE_FACETS = ['composer', 'deity', 'language'] as const
export const MULTI_FACETS = ['ragam', 'thalam', 'catalog', 'occasions', 'albums', 'singers'] as const
export const ALL_FACETS = [...SINGLE_FACETS, ...MULTI_FACETS] as const

export type SingleFacet = (typeof SINGLE_FACETS)[number]
export type MultiFacet = (typeof MULTI_FACETS)[number]
export type FacetName = (typeof ALL_FACETS)[number]

/** Within one facet, OR is the default; AND is only meaningful for multi-valued facets. */
export type FacetMode = 'or' | 'and'

export interface CoreBundle {
  version: number
  count: number
  ids: number[]
  titles: string[]
  dicts: Record<FacetName, string[]>
  roles: string[]
  single: Record<SingleFacet, number[]>
  multi: Record<MultiFacet, number[][]>
  boost: number[][]
  seq: number[]
  role: number[]
  roleOrder: number[]
  page: number[]
  dl: number[]
}

export interface IndexBundle {
  version: number
  count: number
  tokens: string[]
  postings: number[][]
  flags: { title: number; meta: number; lyrics: number }
}

export interface LyricShard {
  version: number
  name: string
  firstSlot: number
  lastSlot: number
  ids: number[]
  lyrics: string[]
}

export interface OccasionMeta {
  id: string
  label: string
  group: 'festival' | 'sampradaya' | 'life'
  icon: string
  blurb: string
  month_hint: string
  priority: number
}

export interface RoleMeta {
  id: string
  label: string
  note?: string
  order: number
  pin?: 'first' | 'last'
}

export interface SiteMeta {
  occasions: OccasionMeta[]
  roles: RoleMeta[]
  synonyms: Record<string, string[]>
}

export interface Filters {
  /** Selected dictionary indices, per facet. */
  values: Partial<Record<FacetName, number[]>>
  /** AND is only meaningful for multi-valued facets, but keying by FacetName keeps the
   *  URL serialiser and the store from needing a narrowing cast at every use site. */
  modes: Partial<Record<FacetName, FacetMode>>
  /** Songs with no value for this facet (e.g. the 4,290 without a recorded thalam). */
  unset: Partial<Record<FacetName, boolean>>
}

export type SortKey = 'relevance' | 'title' | 'id' | 'composer' | 'ragam' | 'occasion'

export interface QueryRequest {
  text: string
  scope: 'meta' | 'all'
  filters: Filters
  sort: SortKey
  offset: number
  limit: number
  occasion?: string
}

export interface ResultRow {
  slot: number
  id: number
  title: string
  composer: string
  deity: string
  language: string
  ragam: string[]
  thalam: string[]
  page: number
  score: number
  boosted: boolean
  snippet?: string
}

export interface FacetValueCount {
  index: number
  label: string
  count: number
  selected: boolean
}

export interface QueryResponse {
  total: number
  rows: ResultRow[]
  counts: Record<FacetName, FacetValueCount[]>
  unsetCounts: Partial<Record<FacetName, number>>
  tookMs: number
  /** Set when a lyrics-scoped search ran but the index was not loaded in time. */
  indexPending?: boolean
}

export interface SongDetail {
  slot: number
  id: number
  title: string
  composer: string
  deity: string
  language: string
  ragam: string[]
  thalam: string[]
  catalog: string[]
  occasions: string[]
  albums: string[]
  singers: string[]
  seq: number | null
  role: string | null
  roleOrder: number | null
  page: number
  lyrics: string
}

export interface CorpusStats {
  songs: number
  ragams: number
  thalams: number
  composers: number
  deities: number
  languages: number
  occasions: number
  built: string
}
