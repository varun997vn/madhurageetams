/**
 * Minimal typed request/response protocol over postMessage.
 *
 * Deliberately hand-rolled rather than Comlink: there are eight methods, and a
 * dependency that proxies arbitrary object graphs would obscure exactly what crosses the
 * worker boundary — which matters here, because the key must never cross it.
 */

import type {
  CorpusStats,
  Filters,
  NativeDoc,
  QueryRequest,
  QueryResponse,
  SiteMeta,
  SongDetail,
} from '../lib/types'

export interface WorkerRequests {
  unlock: { password: string }
  resume: { key: string }
  query: QueryRequest
  getSong: { id: number }
  getSongs: { ids: number[] }
  /** Native-script lyrics. Deliberately a separate call: it is the only thing that pulls
   *  the multi-megabyte native shards, so nothing fetches them by accident. Search and the
   *  inverted index stay Roman-folded and are untouched by this. */
  getNative: { ids: number[] }
  /** Proof that this session unlocked the corpus, sent with a suggested correction so
   *  the public intake endpoint can refuse anyone who has no password. */
  suggestToken: Record<string, never>
  facetValues: { facet: string; prefix: string; limit: number }
  chartData: { spec: 'deity' | 'ragam' | 'composer' | 'language' | 'sunburst'; filters: Filters }
  lock: Record<string, never>
}

export interface WorkerResponses {
  /** `key` is the derived key, returned so the main thread can cache it across reloads;
   *  workers have no access to sessionStorage/localStorage. */
  unlock:
    | { ok: true; stats: CorpusStats; meta: SiteMeta; key: string }
    | { ok: false; reason: string }
  resume: { ok: true; stats: CorpusStats; meta: SiteMeta } | { ok: false; reason: string }
  query: QueryResponse
  getSong: SongDetail | null
  getSongs: SongDetail[]
  getNative: NativeDoc[]
  suggestToken: { token: string }
  facetValues: { index: number; label: string; count: number }[]
  chartData: ChartData
  lock: { ok: true }
}

export interface ChartSlice {
  label: string
  value: number
  facet?: string
  index?: number
  children?: ChartSlice[]
}

export interface ChartData {
  spec: string
  slices: ChartSlice[]
  total: number
}

export type WorkerMethod = keyof WorkerRequests

export type WorkerEvent =
  | { kind: 'progress'; phase: 'deriving' | 'core' | 'index' | 'lyrics'; loaded: number; total: number }
  | { kind: 'ready' }
  | { kind: 'indexReady' }

export interface RpcCall<M extends WorkerMethod = WorkerMethod> {
  rpc: number
  method: M
  params: WorkerRequests[M]
}

export type RpcReply =
  | { rpc: number; ok: true; result: unknown }
  | { rpc: number; ok: false; error: string; name: string }
  | { event: WorkerEvent }
