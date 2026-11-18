/**
 * Reader-suggested, admin-approved lyric corrections, applied over the shipped corpus.
 *
 * The corpus itself only changes through the offline pipeline, which needs the PDF and
 * the password. An accepted correction therefore lands in `data/corrections.json` and
 * is applied here at read time, so publishing a fix is one small commit rather than a
 * rebuild.
 *
 * Every entry carries the text it replaces (`old`), and applies only while the shipped
 * line still equals it. That makes an entry self-retiring: once a later rebuild carries
 * the fix (or changes the line some other way), the entry stops applying instead of
 * overwriting text it was never written against.
 */

import { ROW_COLUMN, SCRIPT_CHOICES, type MultiRow, type ScriptChoice } from './types'

export interface Correction {
  /** Script the correction was made in. Only this script's text changes. */
  s: ScriptChoice
  /** Row index in the multiscript rows; for Roman, the line index in the lyrics text. */
  i: number
  old: string
  new: string
  /** ISO date the correction was accepted. Informational. */
  at?: string
}

export interface CorrectionsDoc {
  version: number
  songs: Record<string, Correction[]>
}

/** Keep only well-formed entries, keyed by numeric song id. Never throws. */
export function indexCorrections(doc: unknown): Map<number, Correction[]> {
  const out = new Map<number, Correction[]>()
  const songs = (doc as CorrectionsDoc | null)?.songs
  if (!songs || typeof songs !== 'object') return out
  for (const [key, entries] of Object.entries(songs)) {
    const id = Number(key)
    if (!Number.isInteger(id) || !Array.isArray(entries)) continue
    const valid = entries.filter(
      (e): e is Correction =>
        !!e &&
        SCRIPT_CHOICES.includes(e.s) &&
        Number.isInteger(e.i) &&
        e.i >= 0 &&
        typeof e.old === 'string' &&
        typeof e.new === 'string',
    )
    if (valid.length > 0) out.set(id, valid)
  }
  return out
}

/** Roman lyrics text with the Roman corrections applied, in order. */
export function applyToRoman(lyrics: string, entries: Correction[] | undefined): string {
  if (!entries || entries.length === 0) return lyrics
  const roman = entries.filter((e) => e.s === 'roman')
  if (roman.length === 0) return lyrics
  const lines = lyrics.split('\n')
  for (const entry of roman) {
    if (lines[entry.i] === entry.old) lines[entry.i] = entry.new
  }
  return lines.join('\n')
}

/**
 * Multiscript rows with corrections applied. Returns the input array untouched when
 * nothing applies; otherwise a copy, so the cached shard is never mutated.
 *
 * A Roman correction is addressed by line in the Roman lyrics text, which is a
 * different extraction from these rows. It is carried across by text instead: any row
 * whose Roman column reads the same as `old` gets the new reading, so the side-by-side
 * view agrees with the Roman view.
 */
export function applyToRows(rows: MultiRow[], entries: Correction[] | undefined): MultiRow[] {
  if (!entries || entries.length === 0) return rows
  let out = rows
  const write = (index: number, column: number, text: string) => {
    if (out === rows) out = rows.slice()
    const copy = out[index]!.slice() as MultiRow
    copy[column] = text
    out[index] = copy
  }

  for (const entry of entries) {
    if (entry.s === 'roman') {
      const wanted = entry.old.trim()
      if (!wanted) continue
      for (let index = 0; index < out.length; index++) {
        if ((out[index]![ROW_COLUMN.roman] as string).trim() === wanted) {
          write(index, ROW_COLUMN.roman, entry.new.trim())
        }
      }
      continue
    }
    const column = ROW_COLUMN[entry.s]
    const row = out[entry.i]
    if (row && row[column] === entry.old) write(entry.i, column, entry.new)
  }
  return out
}
