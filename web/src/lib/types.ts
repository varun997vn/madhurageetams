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

/* --------------------------------------------------------------- native scripts ----
 * The master copy prints every song's Roman transliteration beside exactly one Indic
 * script — Tamil for Tamil-language songs, Devanagari for everything else. No song has
 * both, and no song is printed in Telugu, Kannada or Malayalam script, so a Telugu song
 * appears here as `devanagari`. Nothing is transliterated: this is what the page shows.
 */

export type NativeScript = 'devanagari' | 'tamil'
export type ScriptChoice = 'roman' | NativeScript

/** `deva`/`taml` as stored in the shard; widened to NativeScript on the way out. */
export type NativeScriptTag = 'deva' | 'taml'

export const SCRIPT_LABELS: Record<ScriptChoice, string> = {
  roman: 'Roman',
  devanagari: 'Devanagari',
  tamil: 'Tamil',
}

/** `[isHeading, text]` — headings are the structural markers (pallavi, charaNam, the
 *  ragam/thalam line), which the source records only in the Roman column. */
export type RomanRow = [0 | 1, string]

/** `[romanIndex, nativeIndex]` into a song's `roman`/`native` arrays; -1 where a row has
 *  no counterpart, which happens for 17.8% of rows because the two columns wrap
 *  differently. */
export type RowPair = [number, number]

export interface NativeSong {
  /** null for the six English songs, which have no Indic column at all. */
  script: NativeScript | null
  roman: RomanRow[]
  native: string[]
  pairs: RowPair[]
  /** false for the 61 songs with a glyph run that could not be machine-verified. */
  verified: boolean
}

export interface NativeDoc extends NativeSong {
  id: number
  slot: number
}

export interface NativeShard {
  version: number
  name: string
  /** This shard's own song ids, so lookup never depends on the encrypted corpus's slots. */
  ids: number[]
  songs: {
    s: NativeScriptTag | null
    rom: RomanRow[]
    nat: string[]
    pair: RowPair[]
    v: 0 | 1
  }[]
}

export interface NativeShardEntry {
  name: string
  url: string
  /** Inclusive range of positions in `NativeIndex.ids` that this shard covers. */
  first: number
  last: number
  bytes: number
  sha256: string
}

/**
 * ~59 KB, fetched eagerly and unencrypted.
 *
 * The picker has to know what a song offers before deciding whether a multi-megabyte shard
 * is worth fetching, and `language` does not predict script here — a Telugu song is printed
 * in Devanagari. Positions index into `ids`; nothing here is tied to corpus slot numbering.
 */
export interface NativeIndex {
  version: number
  count: number
  ids: number[]
  shards: NativeShardEntry[]
  /** 0 = none, 1 = devanagari, 2 = tamil. */
  script: number[]
  unverified: number[]
  romanEmpty: number[]
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
  /** Which Indic script the master copy prints this song in, or null if none. Comes from
   *  the ~1 KB native map, so it costs nothing and is available before any shard fetch. */
  nativeScript: NativeScript | null
  scriptVerified: boolean
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
  /** Whether this deployment actually ships native-script lyrics. When false the picker is
   *  not rendered at all, so a Roman-only build looks like one instead of showing controls
   *  that cannot do anything. */
  nativeScripts: boolean
}
