/// <reference lib="webworker" />
/**
 * Sole owner of the decryption key, the decrypted corpus, the facet bitmaps and the
 * search index.
 *
 * Keeping all of it here means the main thread never blocks on a query and never holds
 * plaintext, so a `Lock` genuinely drops the data rather than leaving it reachable from
 * a React state tree.
 */

import * as bs from '../lib/bitset'
import { fold } from '../lib/fold'
import {
  base64ToBytes,
  bytesToBase64,
  deriveKeyBytes,
  gunzip,
  importAesKey,
  keyCheckValue,
  openShard,
  suggestToken,
  WrongPasswordError,
  type Manifest,
} from '../lib/crypto'
import {
  applyToRoman,
  applyToRows,
  countCorrections,
  indexCorrections,
  resolveLines,
  type Correction,
} from '../lib/corrections'
import { decodeSong } from '../lib/scriptRows'
import {
  ALL_FACETS,
  ROW_COLUMN,
  type CoreBundle,
  type Editable,
  type EditableLine,
  type FacetName,
  type FacetValueCount,
  type Filters,
  type IndexBundle,
  type LyricShard,
  type NativeDoc,
  type NativeIndex,
  type NativeShard,
  type PrintedScript,
  type QueryRequest,
  type QueryResponse,
  type ResultRow,
  type ScriptChoice,
  type SiteMeta,
  type SongDetail,
} from '../lib/types'
import type { ChartData, ChartSlice, RpcCall, RpcReply, WorkerEvent } from './rpc'
import { SearchEngine } from './search'
import { Store } from './store'
import siteMeta from '../data/site-meta.json'

const MAX_ROWS = 200

const ctx = self as unknown as DedicatedWorkerGlobalScope

let manifest: Manifest | null = null
let cryptoKey: CryptoKey | null = null
let store: Store | null = null
let engine: SearchEngine | null = null
const lyricShards = new Map<string, LyricShard>()
const nativeShards = new Map<string, NativeShard>()
let nativeIndex: NativeIndex | null = null
let nativePosition: Map<number, number> | null = null
let prefetching = false
/** Accepted reader corrections by song id; see lib/corrections.ts. */
let corrections = new Map<number, Correction[]>()
/** Entries per song in corrections.json as loaded: the base a suggestion is sent with. */
let correctionCounts = new Map<number, number>()
/** Proof-of-unlock sent with a suggestion. Derived from the key, never the key itself. */
let unlockToken = ''

/** Printed-script codes as stored in the native index. */
const PRINTED_SCRIPTS: PrintedScript[] = [null, 'devanagari', 'tamil', 'mixed']

function emit(event: WorkerEvent): void {
  ctx.postMessage({ event } satisfies RpcReply)
}

function baseUrl(): string {
  // Vite substitutes BASE_URL at build time ('/madhurageetams/' in production, '/' in
  // dev), which is where public/ assets land. Deriving it from import.meta.url instead
  // would break, since the worker is emitted into assets/ but the data sits at the root.
  return new URL(import.meta.env.BASE_URL, self.location.origin).href
}

async function fetchManifest(): Promise<Manifest> {
  if (manifest) return manifest
  const response = await fetch(new URL('data/manifest.json', baseUrl()).href, {
    cache: 'no-cache',
  })
  if (!response.ok) throw new Error(`manifest unavailable (HTTP ${response.status})`)
  manifest = (await response.json()) as Manifest
  return manifest
}

async function fetchShard(name: string): Promise<unknown> {
  const m = await fetchManifest()
  const entry = m.shards.find((s) => s.name === name)
  if (!entry) throw new Error(`unknown shard "${name}"`)
  const url = new URL(`${entry.url}?v=${m.revision || m.built}`, baseUrl()).href
  const response = await fetch(url)
  if (!response.ok) throw new Error(`could not fetch ${name} (HTTP ${response.status})`)
  const blob = new Uint8Array(await response.arrayBuffer())
  return openShard(cryptoKey!, name, blob, entry.sha256)
}

function stats() {
  const core = store!.core
  return {
    songs: core.count,
    ragams: core.dicts.ragam.length,
    thalams: core.dicts.thalam.length,
    composers: core.dicts.composer.length,
    deities: core.dicts.deity.length,
    languages: core.dicts.language.length,
    occasions: core.dicts.occasions.length,
    built: manifest?.built ?? '',
    nativeScripts: nativeIndex !== null,
  }
}

async function loadCore(): Promise<void> {
  emit({ kind: 'progress', phase: 'core', loaded: 0, total: 1 })
  const core = (await fetchShard('core')) as CoreBundle
  store = new Store(core)
  engine = new SearchEngine(store)
  engine.setSynonyms((siteMeta as SiteMeta).synonyms ?? {})
  await Promise.all([ensureNativeIndex(), loadCorrections()])
  emit({ kind: 'progress', phase: 'core', loaded: 1, total: 1 })
  emit({ kind: 'ready' })
  void prefetchLyrics()
}

/**
 * Warm the lyric shards in the background.
 *
 * Sharding buys a fast first paint; this buys instant song detail and snippets
 * afterwards. Skipped on metered or slow connections, where 2.6 MB of speculative
 * download is a real cost to the user.
 */
async function prefetchLyrics(): Promise<void> {
  if (prefetching) return
  prefetching = true
  const connection = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } })
    .connection
  if (connection?.saveData) return
  if (connection?.effectiveType && !/4g/.test(connection.effectiveType)) return

  const m = await fetchManifest()
  // `lyrics-` only, deliberately. The native-script shards are several megabytes and are
  // useless to a reader who never switches script, so they are fetched on demand and must
  // never be swept into this speculative warm.
  const names = m.shards.filter((s) => s.name.startsWith('lyrics-')).map((s) => s.name)
  let done = 0
  const queue = [...names]

  const workers = Array.from({ length: 3 }, async () => {
    for (;;) {
      const name = queue.shift()
      if (!name) return
      if (!lyricShards.has(name)) {
        try {
          lyricShards.set(name, (await fetchShard(name)) as LyricShard)
        } catch {
          // A failed prefetch is not an error; the shard is fetched on demand later.
        }
      }
      done += 1
      emit({ kind: 'progress', phase: 'lyrics', loaded: done, total: names.length })
    }
  })
  await Promise.all(workers)
}

async function shardForSlot(slot: number): Promise<LyricShard | null> {
  const m = await fetchManifest()
  for (const entry of m.shards) {
    if (!entry.name.startsWith('lyrics-')) continue
    const cached = lyricShards.get(entry.name)
    if (cached) {
      if (slot >= cached.firstSlot && slot <= cached.lastSlot) return cached
      continue
    }
  }
  // Not cached yet: shards are contiguous and evenly sized, so the index is arithmetic.
  const total = m.shards.filter((s) => s.name.startsWith('lyrics-')).length
  const per = Math.ceil(store!.count / total)
  const name = `lyrics-${String(Math.floor(slot / per)).padStart(2, '0')}`
  if (!lyricShards.has(name)) {
    try {
      lyricShards.set(name, (await fetchShard(name)) as LyricShard)
    } catch {
      return null
    }
  }
  return lyricShards.get(name) ?? null
}

/** Roman lyrics exactly as shipped, before any correction. */
async function shippedLyricsFor(slot: number): Promise<string> {
  const shard = await shardForSlot(slot)
  if (!shard) return ''
  return shard.lyrics[slot - shard.firstSlot] ?? ''
}

async function lyricsFor(slot: number): Promise<string> {
  return applyToRoman(await shippedLyricsFor(slot), corrections.get(store!.core.ids[slot]!))
}

/**
 * Accepted corrections, fetched once per unlock.
 *
 * `no-cache` because this file changes without `manifest.revision` changing: an accepted
 * fix is a commit to this one file, not a rebuild. Failure is tolerated — without it the
 * site simply shows the corpus as built.
 */
async function loadCorrections(): Promise<void> {
  try {
    const response = await fetch(new URL('data/corrections.json', baseUrl()).href, {
      cache: 'no-cache',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const doc: unknown = await response.json()
    corrections = indexCorrections(doc)
    correctionCounts = countCorrections(doc)
  } catch {
    corrections = new Map()
    correctionCounts = new Map()
  }
}

/* ----------------------------------------------------------- native scripts --------
 * These are the one part of the corpus that ships unencrypted, by decision of the
 * copyright holder, so they are fetched with a plain `fetch` and need no key. Two
 * consequences worth stating:
 *
 * 1. They are absent from `manifest.json`, so `prefetchLyrics()` and `shardForSlot()`
 *    cannot see them. The promise that a Roman-only reader never downloads 7 MB of Indic
 *    text is therefore structural rather than a filter someone could accidentally relax.
 * 2. Everything is keyed by song **id**. The encrypted bundles are slot-indexed because
 *    they come from one sorted pass over the parsed PDF; these come from a different
 *    extraction, so sharing a slot ordering would be an assumption rather than a fact.
 */

/**
 * The ~59 KB index, loaded eagerly.
 *
 * Without it the picker could not tell whether a song has a native column without pulling
 * a multi-megabyte shard. Failure is tolerated and reported: a build with no native data
 * simply behaves as the site did before native scripts existed, and `stats.nativeScripts`
 * goes false so the UI hides the picker rather than showing dead controls.
 */
async function ensureNativeIndex(): Promise<void> {
  if (nativeIndex) return
  const url = new URL(`data/native-index.json?v=${manifest?.revision ?? ''}`, baseUrl()).href
  // One retry: a single transient failure should not disable the feature for the session.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const doc = (await response.json()) as NativeIndex
      nativeIndex = doc
      nativePosition = new Map(doc.ids.map((id, position) => [id, position]))
      return
    } catch {
      nativeIndex = null
      nativePosition = null
    }
  }
}

async function nativeShardAt(position: number): Promise<NativeShard | null> {
  const entry = nativeIndex?.shards.find((s) => position >= s.first && position <= s.last)
  if (!entry) return null

  const cached = nativeShards.get(entry.name)
  if (cached) return cached

  try {
    const url = new URL(`${entry.url}?v=${manifest?.revision ?? ''}`, baseUrl()).href
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const blob = new Uint8Array(await response.arrayBuffer())

    // Hosts disagree about `.gz`. GitHub Pages serves it as an opaque application/gzip
    // body, which arrives here still compressed; others set Content-Encoding: gzip and the
    // browser inflates it before we ever see it. Sniffing the gzip magic handles both, and
    // means this keeps working if the site is ever served from somewhere else.
    const compressed = blob[0] === 0x1f && blob[1] === 0x8b

    if (compressed) {
      // Checked before inflating, for the same reason openShard checks before decrypting:
      // a truncated response should fail as a clear checksum error rather than as a
      // confusing parse error partway through a song. Only meaningful on the raw bytes.
      const digest = await crypto.subtle.digest('SHA-256', blob as BufferSource)
      const actual = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
      if (actual !== entry.sha256) throw new Error(`checksum mismatch for ${entry.name}`)
    }

    const json = new TextDecoder().decode(compressed ? await gunzip(blob) : blob)
    const shard = JSON.parse(json) as NativeShard
    nativeShards.set(entry.name, shard)
    return shard
  } catch {
    return null
  }
}

/** One song's entry in its native shard, exactly as shipped. */
async function shippedNativeFor(id: number) {
  const position = nativePosition?.get(id)
  if (position === undefined) return null
  const shard = await nativeShardAt(position)
  if (!shard) return null
  return shard.songs[shard.ids.indexOf(id)] ?? null
}

/**
 * The lines of one script as a reader would correct them.
 *
 * Addresses are computed here, against the shipped data, because that is what
 * corrections.json is written against: the main thread only ever sees text that already
 * has earlier corrections applied, and could not tell a shipped line from an added one.
 */
async function editableFor(id: number, script: ScriptChoice): Promise<Editable | null> {
  const entries = corrections.get(id)
  let base: string[]
  let headings: Set<number> | null = null

  if (script === 'roman') {
    const slot = store!.slotById.get(id)
    if (slot === undefined) return null
    base = (await shippedLyricsFor(slot)).split('\n')
  } else {
    const entry = await shippedNativeFor(id)
    if (!entry) return null
    const column = ROW_COLUMN[script]
    base = entry.rows.map((row) => row[column] as string)
    headings = new Set(entry.rows.flatMap((row, index) => (row[0] === 1 ? [index] : [])))
  }

  const out: EditableLine[] = []
  for (const line of resolveLines(base, entries, script)) {
    if (line.text === null) continue
    const kind =
      line.n === 0 && headings?.has(line.i) ? 'heading' : line.text.trim() === '' ? 'blank' : 'line'
    out.push({ i: line.i, n: line.n, text: line.text, kind })
  }
  return { lines: out, base: correctionCounts.get(id) ?? 0 }
}

async function nativeFor(id: number): Promise<NativeDoc | null> {
  const entry = await shippedNativeFor(id)
  if (!entry) return null
  const slot = store!.slotById.get(id) ?? -1
  const song = decodeSong(entry)
  return { id, slot, ...song, rows: applyToRows(song.rows, corrections.get(id)) }
}

async function ensureIndex(): Promise<boolean> {
  if (engine!.hasIndex()) return true
  emit({ kind: 'progress', phase: 'index', loaded: 0, total: 1 })
  try {
    engine!.setIndex((await fetchShard('index')) as IndexBundle)
  } catch {
    return false
  }
  emit({ kind: 'progress', phase: 'index', loaded: 1, total: 1 })
  emit({ kind: 'indexReady' })
  return true
}

function detailFor(slot: number, lyrics: string): SongDetail {
  const core = store!.core
  // Both fields come from the small eager index, so a song detail never blocks on a shard.
  // Defaulting to "no native script, verified" keeps a build without native data behaving
  // exactly as it did before the feature existed.
  const position = nativePosition?.get(core.ids[slot]!)
  const scriptCode = position === undefined ? 0 : (nativeIndex?.printed[position] ?? 0)
  return {
    slot,
    id: core.ids[slot]!,
    title: core.titles[slot]!,
    composer: store!.value('composer', slot)[0] ?? '',
    deity: store!.value('deity', slot)[0] ?? '',
    language: store!.value('language', slot)[0] ?? '',
    ragam: store!.value('ragam', slot),
    thalam: store!.value('thalam', slot),
    catalog: store!.value('catalog', slot),
    occasions: store!.value('occasions', slot),
    albums: store!.value('albums', slot),
    singers: store!.value('singers', slot),
    seq: core.seq[slot]! >= 0 ? core.seq[slot]! : null,
    role: core.role[slot]! >= 0 ? core.roles[core.role[slot]!]! : null,
    roleOrder: core.roleOrder[slot]! >= 0 ? core.roleOrder[slot]! : null,
    page: core.page[slot]!,
    lyrics,
    nativeScript: PRINTED_SCRIPTS[scriptCode] ?? null,
    scriptVerified: position === undefined || !nativeIndex?.unverified.includes(position),
  }
}

function snippetFor(lyrics: string, query: string): string | undefined {
  if (!lyrics || !query) return undefined
  const tokens = fold(query).split(' ').filter(Boolean)
  if (tokens.length === 0) return undefined
  const lines = lyrics.split('\n')
  for (const line of lines) {
    const folded = fold(line)
    if (tokens.some((t) => folded.includes(t))) {
      const trimmed = line.trim()
      if (trimmed.length > 3) return trimmed.slice(0, 160)
    }
  }
  return lines.find((l) => l.trim().length > 3)?.trim().slice(0, 160)
}

function countFacets(filters: Filters, textBits: bs.Bitset | null) {
  const counts = {} as Record<FacetName, FacetValueCount[]>
  const unsetCounts: Partial<Record<FacetName, number>> = {}

  for (const facet of ALL_FACETS) {
    // Counts for a facet are computed with that facet's own selection removed, so
    // ticking a second value widens the result rather than emptying it.
    const others = store!.candidates(filters, facet)
    if (textBits) bs.andInto(others, textBits)

    const selected = new Set(filters.values[facet] ?? [])
    const dict = store!.core.dicts[facet]
    const rows: FacetValueCount[] = []
    for (let i = 0; i < dict.length; i++) {
      const count = bs.popcountAnd(others, store!.facetBits[facet][i]!)
      if (count === 0 && !selected.has(i)) continue
      rows.push({ index: i, label: dict[i]!, count, selected: selected.has(i) })
    }
    rows.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    counts[facet] = rows
    const unset = bs.popcountAnd(others, store!.unsetBits[facet])
    if (unset > 0) unsetCounts[facet] = unset
  }
  return { counts, unsetCounts }
}

async function runQuery(request: QueryRequest): Promise<QueryResponse> {
  const started = performance.now()
  const s = store!
  const e = engine!

  let textBits: bs.Bitset | null = null
  let scores: Float32Array | null = null
  let phrases: string[] = []
  let indexPending = false

  if (request.text.trim()) {
    if (request.scope === 'all') {
      const ready = await ensureIndex()
      const match = ready ? e.searchFullText(request.text) : null
      if (match) {
        textBits = match.bits
        scores = match.scores
        phrases = match.phrases ?? []
      } else {
        indexPending = true
        const fallback = e.searchMetadata(request.text)
        textBits = fallback.bits
        scores = fallback.scores
      }
    } else {
      const match = e.searchMetadata(request.text)
      textBits = match.bits
      scores = match.scores
    }
  }

  const candidates = s.candidates(request.filters)
  if (textBits) bs.andInto(candidates, textBits)

  let slots = bs.toArray(candidates)

  // Exact-phrase verification runs against the raw lyrics, but only for the top hits:
  // the folded index cannot preserve word order, so this is what makes a quoted query
  // mean what it says without re-checking all 7,898 songs.
  if (phrases.length > 0) {
    const ranked = [...slots].sort((a, b) => (scores?.[b] ?? 0) - (scores?.[a] ?? 0))
    const inspect = ranked.slice(0, 200)
    const keep = new Set<number>()
    for (const slot of inspect) {
      const folded = fold(await lyricsFor(slot))
      const title = s.titleFolded[slot]!
      if (phrases.every((p) => folded.includes(p) || title.includes(p))) keep.add(slot)
    }
    slots = slots.filter((slot) => keep.has(slot))
  }

  const occasionIndex =
    request.occasion !== undefined ? s.occasionIndex.get(request.occasion) : undefined

  const sorters: Record<string, (a: number, b: number) => number> = {
    relevance: (a, b) => (scores?.[b] ?? 0) - (scores?.[a] ?? 0) || a - b,
    title: (a, b) => s.core.titles[a]!.localeCompare(s.core.titles[b]!),
    id: (a, b) => s.core.ids[a]! - s.core.ids[b]!,
    composer: (a, b) =>
      (s.value('composer', a)[0] ?? '~').localeCompare(s.value('composer', b)[0] ?? '~') ||
      s.core.titles[a]!.localeCompare(s.core.titles[b]!),
    ragam: (a, b) =>
      (s.value('ragam', a)[0] ?? '~').localeCompare(s.value('ragam', b)[0] ?? '~') ||
      s.core.titles[a]!.localeCompare(s.core.titles[b]!),
    occasion: (a, b) => {
      if (occasionIndex !== undefined) {
        const ba = s.isBoosted(a, occasionIndex) ? 0 : 1
        const bb = s.isBoosted(b, occasionIndex) ? 0 : 1
        if (ba !== bb) return ba - bb
      }
      const ra = s.core.roleOrder[a]!
      const rb = s.core.roleOrder[b]!
      if (ra !== rb) return (ra < 0 ? 9999 : ra) - (rb < 0 ? 9999 : rb)
      return s.core.titles[a]!.localeCompare(s.core.titles[b]!)
    },
  }
  slots.sort(sorters[request.sort] ?? sorters.relevance!)

  const page = slots.slice(request.offset, request.offset + Math.min(request.limit, MAX_ROWS))
  const rows: ResultRow[] = []
  for (const slot of page) {
    const wantSnippet = request.scope === 'all' && request.text.trim().length > 0
    const snippet = wantSnippet ? snippetFor(await lyricsFor(slot), request.text) : undefined
    rows.push({
      slot,
      id: s.core.ids[slot]!,
      title: s.core.titles[slot]!,
      composer: s.value('composer', slot)[0] ?? '',
      deity: s.value('deity', slot)[0] ?? '',
      language: s.value('language', slot)[0] ?? '',
      ragam: s.value('ragam', slot),
      thalam: s.value('thalam', slot),
      page: s.core.page[slot]!,
      score: scores?.[slot] ?? 0,
      boosted: occasionIndex !== undefined ? s.isBoosted(slot, occasionIndex) : false,
      ...(snippet ? { snippet } : {}),
    })
  }

  const { counts, unsetCounts } = countFacets(request.filters, textBits)

  return {
    total: slots.length,
    rows,
    counts,
    unsetCounts,
    tookMs: Math.round(performance.now() - started),
    ...(indexPending ? { indexPending: true } : {}),
  }
}

function buildChart(spec: string, filters: Filters): ChartData {
  const s = store!
  const candidates = s.candidates(filters)
  const total = bs.popcount(candidates)

  const distribution = (facet: FacetName, limit: number): ChartSlice[] => {
    const dict = s.core.dicts[facet]
    const rows: ChartSlice[] = []
    for (let i = 0; i < dict.length; i++) {
      const count = bs.popcountAnd(candidates, s.facetBits[facet][i]!)
      if (count > 0) rows.push({ label: dict[i]!, value: count, facet, index: i })
    }
    rows.sort((a, b) => b.value - a.value)
    return rows.slice(0, limit)
  }

  if (spec === 'sunburst') {
    // Deity -> catalog, two levels deep. Deeper than that and the arcs are unreadable.
    const deities = distribution('deity', 8)
    for (const parent of deities) {
      const parentBits = bs.and(candidates, s.facetBits.deity[parent.index!]!)
      const children: ChartSlice[] = []
      for (let i = 0; i < s.core.dicts.catalog.length; i++) {
        const count = bs.popcountAnd(parentBits, s.facetBits.catalog[i]!)
        if (count > 0) {
          children.push({ label: s.core.dicts.catalog[i]!, value: count, facet: 'catalog', index: i })
        }
      }
      children.sort((a, b) => b.value - a.value)
      parent.children = children.slice(0, 6)
    }
    return { spec, slices: deities, total }
  }

  const limits: Record<string, number> = { deity: 12, ragam: 20, composer: 12, language: 8 }
  return { spec, slices: distribution(spec as FacetName, limits[spec] ?? 12), total }
}

/**
 * Derive the key and hand it back once so the main thread can cache it.
 *
 * The worker cannot cache it itself: sessionStorage and localStorage are main-thread
 * APIs and are simply absent here, so an in-worker write silently does nothing and
 * every reload re-runs a 600k-iteration KDF. Returning the key is not an escalation --
 * the main thread already read the password out of the input field to send it here.
 */
async function unlock(password: string) {
  const m = await fetchManifest()
  const salt = base64ToBytes(m.kdf.salt)
  emit({ kind: 'progress', phase: 'deriving', loaded: 0, total: 1 })
  const keyBytes = await deriveKeyBytes(password, salt, m.kdf.iterations)
  emit({ kind: 'progress', phase: 'deriving', loaded: 1, total: 1 })

  if ((await keyCheckValue(keyBytes, salt)) !== m.kcv) throw new WrongPasswordError()

  cryptoKey = await importAesKey(keyBytes)
  unlockToken = await suggestToken(keyBytes)
  await loadCore()
  return {
    ok: true as const,
    stats: stats(),
    meta: siteMeta as SiteMeta,
    key: bytesToBase64(keyBytes),
  }
}

/** Re-open with a key the main thread had cached, skipping the KDF entirely. */
async function resume(encoded: string) {
  if (!encoded) return { ok: false as const, reason: 'no cached key' }
  const m = await fetchManifest()
  const keyBytes = base64ToBytes(encoded)
  if ((await keyCheckValue(keyBytes, base64ToBytes(m.kdf.salt))) !== m.kcv) {
    // The data was repacked with a new password since this key was cached.
    return { ok: false as const, reason: 'cached key no longer valid' }
  }
  cryptoKey = await importAesKey(keyBytes)
  unlockToken = await suggestToken(keyBytes)
  await loadCore()
  return { ok: true as const, stats: stats(), meta: siteMeta as SiteMeta }
}

ctx.onmessage = async (event: MessageEvent<RpcCall>) => {
  const { rpc, method, params } = event.data
  try {
    let result: unknown
    switch (method) {
      case 'unlock': {
        result = await unlock((params as { password: string }).password)
        break
      }
      case 'resume':
        result = await resume((params as { key: string }).key)
        break
      case 'query':
        result = await runQuery(params as QueryRequest)
        break
      case 'getSong': {
        const slot = store!.slotById.get((params as { id: number }).id)
        result = slot === undefined ? null : detailFor(slot, await lyricsFor(slot))
        break
      }
      case 'getSongs': {
        const out: SongDetail[] = []
        for (const id of (params as { ids: number[] }).ids) {
          const slot = store!.slotById.get(id)
          if (slot !== undefined) out.push(detailFor(slot, await lyricsFor(slot)))
        }
        result = out
        break
      }
      case 'getNative': {
        const out: NativeDoc[] = []
        for (const id of (params as { ids: number[] }).ids) {
          const doc = await nativeFor(id)
          if (doc) out.push(doc)
        }
        result = out
        break
      }
      case 'facetValues': {
        const p = params as { facet: string; prefix: string; limit: number }
        const dict = store!.core.dicts[p.facet as FacetName] ?? []
        const needle = fold(p.prefix)
        const rows = dict
          .map((label, index) => ({ index, label, count: 0 }))
          .filter((row) => !needle || fold(row.label).includes(needle))
          .slice(0, p.limit)
        result = rows
        break
      }
      case 'chartData': {
        const p = params as { spec: string; filters: Filters }
        result = buildChart(p.spec, p.filters)
        break
      }
      case 'getEditable': {
        const p = params as { id: number; script: ScriptChoice }
        result = await editableFor(p.id, p.script)
        break
      }
      case 'suggestToken':
        result = { token: unlockToken }
        break
      case 'lock':
        cryptoKey = null
        unlockToken = ''
        corrections = new Map()
        correctionCounts = new Map()
        store = null
        engine = null
        lyricShards.clear()
        nativeShards.clear()
        nativeIndex = null
        nativePosition = null
        result = { ok: true }
        break
      default:
        throw new Error(`unknown method ${method}`)
    }
    ctx.postMessage({ rpc, ok: true, result } satisfies RpcReply)
  } catch (error) {
    const err = error as Error
    ctx.postMessage({
      rpc,
      ok: false,
      error: err.message ?? String(error),
      name: err.name ?? 'Error',
    } satisfies RpcReply)
  }
}

export {}
