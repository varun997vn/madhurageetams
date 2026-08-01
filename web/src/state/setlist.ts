import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ScriptChoice } from '../lib/types'

interface SetlistState {
  name: string
  ids: number[]
  /** Per-song script, overriding the reader's default. A set often mixes languages, and a
   *  group may want the Tamil songs in Tamil and the rest in Roman. Absent = use default. */
  scripts: Record<number, ScriptChoice>
  setName: (name: string) => void
  toggle: (id: number) => void
  addMany: (ids: number[]) => void
  remove: (id: number) => void
  reorder: (from: number, to: number) => void
  replace: (ids: number[]) => void
  setScript: (id: number, script: ScriptChoice | null) => void
  clear: () => void
  has: (id: number) => boolean
}

/** Drop overrides for songs no longer in the set, so the map cannot grow without bound. */
function pruneScripts(
  scripts: Record<number, ScriptChoice>,
  ids: number[],
): Record<number, ScriptChoice> {
  const keep = new Set(ids)
  const next: Record<number, ScriptChoice> = {}
  for (const [key, value] of Object.entries(scripts)) {
    if (keep.has(Number(key))) next[Number(key)] = value
  }
  return next
}

export const useSetlist = create<SetlistState>()(
  persist(
    (set, get) => ({
      name: '',
      ids: [],
      scripts: {},
      setName: (name) => set({ name }),
      toggle: (id) =>
        set((s) => {
          const ids = s.ids.includes(id) ? s.ids.filter((x) => x !== id) : [...s.ids, id]
          return { ids, scripts: pruneScripts(s.scripts, ids) }
        }),
      addMany: (ids) =>
        set((s) => {
          const seen = new Set(s.ids)
          return { ids: [...s.ids, ...ids.filter((id) => !seen.has(id))] }
        }),
      remove: (id) =>
        set((s) => {
          const ids = s.ids.filter((x) => x !== id)
          return { ids, scripts: pruneScripts(s.scripts, ids) }
        }),
      reorder: (from, to) =>
        set((s) => {
          const next = [...s.ids]
          const [moved] = next.splice(from, 1)
          if (moved !== undefined) next.splice(to, 0, moved)
          return { ids: next }
        }),
      replace: (ids) => set((s) => ({ ids, scripts: pruneScripts(s.scripts, ids) })),
      setScript: (id, script) =>
        set((s) => {
          const scripts = { ...s.scripts }
          // null means "follow my default" — stored as absence rather than as a value, so
          // changing the default later moves the song with it.
          if (script === null) delete scripts[id]
          else scripts[id] = script
          return { scripts }
        }),
      clear: () => set({ ids: [], name: '', scripts: {} }),
      has: (id) => get().ids.includes(id),
    }),
    {
      // The setlist is the user's own work, not corpus content, so it survives a lock.
      name: 'mg.setlist.v1',
      // The key is deliberately unchanged. Bumping it to v2 would orphan every setlist
      // already in someone's browser; migrating in place adds the new field and keeps them.
      version: 1,
      migrate: (state, from) => (from === 0 ? { ...(state as object), scripts: {} } : state),
      partialize: (s) => ({ name: s.name, ids: s.ids, scripts: s.scripts }),
    },
  ),
)
