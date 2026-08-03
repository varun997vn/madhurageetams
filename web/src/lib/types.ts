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
 * Every song ships in six scripts: the Roman transliteration and the Indic script the
 * master copy prints are the source's own text; the other four columns are machine
 * transliterations generated (and validated line-by-line against the printed column)
 * by the madhurageetams-source engine. `printed` records which Indic script the master
 * copy actually prints — ~200 songs print both (a Tamil pasuram prelude before a
 * Devanagari kirtan), and six English songs print neither.
 */

export type NativeScript = 'tamil' | 'devanagari' | 'malayalam' | 'kannada' | 'telugu'
export type ScriptChoice = 'roman' | NativeScript

/** What the master copy itself prints for a song. */
export type PrintedScript = 'devanagari' | 'tamil' | 'mixed' | null

export const SCRIPT_LABELS: Record<ScriptChoice, string> = {
  roman: 'Roman',
  tamil: 'Tamil',
  devanagari: 'Devanagari',
  malayalam: 'Malayalam',
  kannada: 'Kannada',
  telugu: 'Telugu',
}

/** Dropdown order: Roman first, then the Indic scripts. */
export const SCRIPT_CHOICES: ScriptChoice[] = [
  'roman', 'tamil', 'devanagari', 'malayalam', 'kannada', 'telugu',
]

/** `[isHeading, roman, devanagari, tamil, malayalam, kannada, telugu]` — one line of the
 *  song in every script. Rows arrive pre-aligned from the source, so there is no pairing
 *  arithmetic left on the client. */
export type MultiRow = [0 | 1, string, string, string, string, string, string]

/** Column of each script inside a MultiRow. */
export const ROW_COLUMN: Record<ScriptChoice, number> = {
  roman: 1,
  devanagari: 2,
  tamil: 3,
  malayalam: 4,
  kannada: 5,
  telugu: 6,
}

export interface NativeSong {
  /** Which Indic script the master copy prints for this song. */
  printed: PrintedScript
  rows: MultiRow[]
  /** false for the songs with a glyph run that could not be machine-verified. */
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
    /** printed script: 0 none, 1 devanagari, 2 tamil, 3 both */
    p: 0 | 1 | 2 | 3
    rows: MultiRow[]
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
  /** Row-column order of the six scripts, informational. */
  scripts: string[]
  /** Printed script per position: 0 = none, 1 = devanagari, 2 = tamil, 3 = both. */
  printed: number[]
  unverified: number[]
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
  /** Which Indic script the master copy prints this song in ('mixed' when it prints
   *  both), or null if none. Comes from the eager native index, so it costs nothing and
   *  is available before any shard fetch. */
  nativeScript: PrintedScript
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
