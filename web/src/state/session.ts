import { create } from 'zustand'
import { getWorker, resetWorker } from '../lib/workerClient'
import type { CorpusStats, SiteMeta } from '../lib/types'
import type { WorkerEvent } from '../worker/rpc'

export type Phase = 'checking' | 'locked' | 'unlocking' | 'ready' | 'unsupported'

type ProgressEvent = Extract<WorkerEvent, { kind: 'progress' }>

interface Progress {
  phase: ProgressEvent['phase']
  loaded: number
  total: number
}

interface SessionState {
  phase: Phase
  error: string
  stats: CorpusStats | null
  meta: SiteMeta | null
  progress: Progress | null
  lyricsReady: number
  indexReady: boolean
  init: () => Promise<void>
  unlock: (password: string, remember: boolean) => Promise<void>
  lock: () => Promise<void>
}

export const useSession = create<SessionState>((set, get) => ({
  phase: 'checking',
  error: '',
  stats: null,
  meta: null,
  progress: null,
  lyricsReady: 0,
  indexReady: false,

  async init() {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      set({ phase: 'unsupported' })
      return
    }
    const worker = getWorker()
    worker.on((event) => {
      if (event.kind === 'progress') {
        if (event.phase === 'lyrics') set({ lyricsReady: event.loaded / event.total })
        else set({ progress: event as Progress })
      } else if (event.kind === 'indexReady') {
        set({ indexReady: true })
      }
    })
    try {
      const cached = readCachedKey()
      const result = cached
        ? await worker.call('resume', { key: cached })
        : ({ ok: false, reason: 'no cached key' } as const)
      if (result.ok) {
        set({ phase: 'ready', stats: result.stats, meta: result.meta, error: '' })
        return
      }
    } catch {
      clearCachedKey()
    }
    set({ phase: 'locked' })
  },

  async unlock(password, remember) {
    set({ phase: 'unlocking', error: '' })
    try {
      const result = await getWorker().call('unlock', { password })
      if (result.ok) {
        cacheKey(result.key, remember)
        set({ phase: 'ready', stats: result.stats, meta: result.meta, error: '' })
      } else {
        set({ phase: 'locked', error: result.reason })
      }
    } catch (error) {
      const err = error as Error
      const message =
        err.name === 'WrongPasswordError'
          ? 'Incorrect password.'
          : err.message || 'Could not unlock.'
      set({ phase: 'locked', error: message, progress: null })
    }
  },

  async lock() {
    clearCachedKey()
    try {
      await getWorker().call('lock', {})
    } catch {
      /* terminating below is what actually matters */
    }
    resetWorker()
    set({ phase: 'locked', stats: null, meta: null, progress: null, indexReady: false, lyricsReady: 0 })
    void get().init()
  },
}))

// --- key caching -----------------------------------------------------------------
// This lives on the main thread because sessionStorage and localStorage are main-thread
// APIs: a worker sees neither, so caching there silently does nothing and every reload
// pays a 600k-iteration KDF again.
//
// sessionStorage by default, so closing the tab locks the site again — a shared or
// family device should not stay unlocked forever. localStorage only on explicit opt-in.
const SESSION_KEY = 'mg.k.v1'
const PERSIST_KEY = 'mg.k.persist.v1'

function cacheKey(key: string, remember: boolean): void {
  try {
    sessionStorage.setItem(SESSION_KEY, key)
    if (remember) localStorage.setItem(PERSIST_KEY, key)
    else localStorage.removeItem(PERSIST_KEY)
  } catch {
    /* private mode can refuse storage; unlocking still works for this page */
  }
}

function readCachedKey(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY) ?? localStorage.getItem(PERSIST_KEY)
  } catch {
    return null
  }
}

function clearCachedKey(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY)
    localStorage.removeItem(PERSIST_KEY)
  } catch {
    /* ignore */
  }
}
