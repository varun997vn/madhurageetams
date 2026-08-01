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
  importAesKey,
  keyCheckValue,
  openShard,
  WrongPasswordError,
  type Manifest,
} from '../lib/crypto'
import { decodeSong } from '../lib/scriptRows'
import {
  ALL_FACETS,
  type CoreBundle,
  type FacetName,
  type FacetValueCount,
  type Filters,
  type IndexBundle,
  type LyricShard,
  type NativeDoc,
  type NativeMap,
  type NativeScript,
  type NativeShard,
  type QueryRequest,
  type QueryResponse,
  type ResultRow,
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
let nativeMap: NativeMap | null = null
let prefetching = false

const NATIVE_SCRIPTS: (NativeScript | null)[] = [null, 'devanagari', 'tamil']

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
  }
}

async function loadCore(): Promise<void> {
  emit({ kind: 'progress', phase: 'core', loaded: 0, total: 1 })
  const core = (await fetchShard('core')) as CoreBundle
  store = new Store(core)
  engine = new SearchEngine(store)
  engine.setSynonyms((siteMeta as SiteMeta).synonyms ?? {})
  await ensureNativeMap()
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

async function lyricsFor(slot: number): Promise<string> {
  const shard = await shardForSlot(slot)
  if (!shard) return ''
  return shard.lyrics[slot - shard.firstSlot] ?? ''
}

/**
 * The ~1 KB availability map, loaded eagerly.
 *
 * Without it the script picker could not know whether a song has a native column at all
 * without pulling a multi-megabyte shard, so it would either guess or download blindly.
 * Failure is tolerated: an older data build has no map, and the site then behaves exactly
 * as it did before native scripts existed.
 */
async function ensureNativeMap(): Promise<void> {
  if (nativeMap) return
  try {
    nativeMap = (await fetchShard('nativemap')) as NativeMap
  } catch {
    nativeMap = null
  }
}

async function nativeShardForSlot(slot: number): Promise<NativeShard | null> {
  const m = await fetchManifest()
  for (const entry of m.shards) {
    if (!entry.name.startsWith('native-')) continue
    const cached = nativeShards.get(entry.name)
    if (cached && slot >= cached.firstSlot && slot <= cached.lastSlot) return cached
  }
  const total = m.shards.filter((s) => s.name.startsWith('native-')).length
  if (total === 0) return null
  // Same contiguous, evenly sized split as the lyric shards, so this stays arithmetic.
  const per = Math.ceil(store!.count / total)
  const name = `native-${String(Math.floor(slot / per)).padStart(2, '0')}`
  if (!nativeShards.has(name)) {
    try {
      nativeShards.set(name, (await fetchShard(name)) as NativeShard)
    } catch {
      return null
    }
  }
  return nativeShards.get(name) ?? null
}

async function nativeFor(slot: number): Promise<NativeDoc | null> {
  const shard = await nativeShardForSlot(slot)
  const entry = shard?.songs[slot - shard.firstSlot]
  if (!entry) return null
  return { id: store!.core.ids[slot]!, slot, ...decodeSong(entry) }
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
  // Both fields come from the tiny native map, so a song detail never blocks on a shard.
  // Defaulting to "no native script, verified" keeps a data build without the map behaving
  // exactly as it did before.
  const scriptCode = nativeMap?.script[slot] ?? 0
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
    nativeScript: NATIVE_SCRIPTS[scriptCode] ?? null,
    scriptVerified: !nativeMap?.unverified.includes(slot),
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
          const slot = store!.slotById.get(id)
          if (slot === undefined) continue
          const doc = await nativeFor(slot)
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
      case 'lock':
        cryptoKey = null
        store = null
        engine = null
        lyricShards.clear()
        nativeShards.clear()
        nativeMap = null
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
