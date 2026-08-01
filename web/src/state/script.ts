import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ScriptChoice } from '../lib/types'

interface ScriptState {
  /** What to read in by default. A song without this script falls back to Roman. */
  choice: ScriptChoice
  /** Show the Roman transliteration beside the native column. */
  bilingual: boolean
  setChoice: (choice: ScriptChoice) => void
  setBilingual: (bilingual: boolean) => void
}

/**
 * How the reader wants lyrics rendered.
 *
 * Persisted rather than kept in the URL: this is a property of the person, not of the page
 * they are looking at. Somebody who reads Tamil wants Tamil on every song they open, and
 * should not have to re-pick it after following a link. It survives a lock for the same
 * reason the setlist does — it is the user's own setting, not corpus content.
 */
export const useScript = create<ScriptState>()(
  persist(
    (set) => ({
      choice: 'roman',
      bilingual: false,
      setChoice: (choice) => set({ choice }),
      setBilingual: (bilingual) => set({ bilingual }),
    }),
    {
      name: 'mg.script.v1',
      partialize: (s) => ({ choice: s.choice, bilingual: s.bilingual }),
    },
  ),
)
