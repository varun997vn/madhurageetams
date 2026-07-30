import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface SetlistState {
  name: string
  ids: number[]
  setName: (name: string) => void
  toggle: (id: number) => void
  addMany: (ids: number[]) => void
  remove: (id: number) => void
  reorder: (from: number, to: number) => void
  replace: (ids: number[]) => void
  clear: () => void
  has: (id: number) => boolean
}

export const useSetlist = create<SetlistState>()(
  persist(
    (set, get) => ({
      name: '',
      ids: [],
      setName: (name) => set({ name }),
      toggle: (id) =>
        set((s) => ({
          ids: s.ids.includes(id) ? s.ids.filter((x) => x !== id) : [...s.ids, id],
        })),
      addMany: (ids) =>
        set((s) => {
          const seen = new Set(s.ids)
          return { ids: [...s.ids, ...ids.filter((id) => !seen.has(id))] }
        }),
      remove: (id) => set((s) => ({ ids: s.ids.filter((x) => x !== id) })),
      reorder: (from, to) =>
        set((s) => {
          const next = [...s.ids]
          const [moved] = next.splice(from, 1)
          if (moved !== undefined) next.splice(to, 0, moved)
          return { ids: next }
        }),
      replace: (ids) => set({ ids }),
      clear: () => set({ ids: [], name: '' }),
      has: (id) => get().ids.includes(id),
    }),
    {
      // The setlist is the user's own work, not corpus content, so it survives a lock.
      name: 'mg.setlist.v1',
      partialize: (s) => ({ name: s.name, ids: s.ids }),
    },
  ),
)
