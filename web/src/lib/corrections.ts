/**
 * Reader-suggested, admin-approved lyric corrections, applied over the shipped corpus.
 *
 * The corpus itself only changes through the offline pipeline, which needs the PDF and
 * the password. An accepted correction therefore lands in `data/corrections.json` and
 * is applied here at read time, so publishing a fix is one small commit rather than a
 * rebuild.
 *
 * A correction changes, removes or adds lines in ONE script of one song.
 *
 * Addressing. Every line has an address `(i, n)`: `i` is the index of a line in the
 * data as shipped (row index, or line index of the Roman lyrics), and `n` counts the
 * reader-added lines that follow it — `n = 0` is the shipped line itself, `n = 1` the
 * first line added after it. `i = -1` is "before the first line", so `(-1, 1)` is the
 * first line added at the very top. Addresses are per script: lines added in Telugu do
 * not renumber anything in Tamil.
 *
 * Entries apply in order, each against the result of the ones before it. Each carries
 * the text it expects to find (`old`) and is skipped when the line no longer reads that
 * way. That makes an entry self-retiring: once a later rebuild carries the fix, the
 * entry stops applying instead of overwriting text it was never written against.
 */

import { REMOVED, ROW_COLUMN, SCRIPT_CHOICES, type MultiRow, type ScriptChoice } from './types'

export interface Correction {
  /** Script the correction was made in. Only this script's text changes. */
  s: ScriptChoice
  i: number
  /** 0 or absent: the shipped line. k: the k-th line added after it. */
  n?: number
  /** Text expected at the address. `null` expects a removed line, or the top anchor. */
  old: string | null
  /** Replace the line with this. */
  new?: string
  /** Remove the line. */
  del?: true
  /** Add these lines directly after the address. */
  add?: string[]
  /** ISO date the correction was accepted. Informational. */
  at?: string
}

export interface CorrectionsDoc {
  version: number
  songs: Record<string, Correction[]>
}

/** One line after corrections, with the address a further correction would use. */
export interface LineItem {
  i: number
  n: number
  /** `null` when the line has been removed. */
  text: string | null
}

function wellFormed(e: Correction | null | undefined): e is Correction {
  if (!e || !SCRIPT_CHOICES.includes(e.s)) return false
  if (!Number.isInteger(e.i) || e.i < -1) return false
  if (e.n !== undefined && (!Number.isInteger(e.n) || e.n < 0)) return false
  if (Array.isArray(e.add)) {
    return (e.old === null || typeof e.old === 'string') &&
      e.add.length > 0 && e.add.every((line) => typeof line === 'string' && line !== '')
  }
  // Only an insert may address the top anchor; there is no line there to change.
  if (e.i === -1 && !e.n) return false
  if (typeof e.old !== 'string') return false
  return e.del === true || typeof e.new === 'string'
}

/** Keep only well-formed entries, keyed by numeric song id. Never throws. */
export function indexCorrections(doc: unknown): Map<number, Correction[]> {
  const out = new Map<number, Correction[]>()
  const songs = (doc as CorrectionsDoc | null)?.songs
  if (!songs || typeof songs !== 'object') return out
  for (const [key, entries] of Object.entries(songs)) {
    const id = Number(key)
    if (!Number.isInteger(id) || !Array.isArray(entries)) continue
    const valid = entries.filter(wellFormed)
    if (valid.length > 0) out.set(id, valid)
  }
  return out
}

interface Slot {
  text: string | null
}

/**
 * Apply one script's entries to its lines.
 *
 * Returns one group per shipped line, offset by one: `groups[0]` is the top anchor and
 * `groups[i + 1]` belongs to shipped line `i`. Within a group, slot 0 is the shipped
 * line and the rest are added lines, so a slot's position is exactly its `n`.
 */
function resolve(base: string[], entries: Correction[]): Slot[][] {
  const groups: Slot[][] = [[{ text: null }]]
  for (const text of base) groups.push([{ text }])

  for (const entry of entries) {
    const n = entry.n ?? 0
    const group = groups[entry.i + 1]
    const slot = group?.[n]
    if (!group || !slot || slot.text !== entry.old) continue
    if (entry.add) {
      group.splice(n + 1, 0, ...entry.add.map((text) => ({ text })))
    } else if (entry.del) {
      // Kept as an empty slot rather than spliced out, so the addresses of the lines
      // after it do not move.
      slot.text = null
    } else if (typeof entry.new === 'string') {
      slot.text = entry.new
    }
  }
  return groups
}

/** Every line of one script after corrections, removed ones included, with addresses. */
export function resolveLines(
  base: string[],
  entries: Correction[] | undefined,
  script: ScriptChoice,
): LineItem[] {
  const groups = resolve(base, (entries ?? []).filter((e) => e.s === script))
  const out: LineItem[] = []
  groups.forEach((group, g) => {
    group.forEach((slot, n) => {
      if (g === 0 && n === 0) return
      out.push({ i: g - 1, n, text: slot.text })
    })
  })
  return out
}

/** Roman lyrics text with the Roman corrections applied. */
export function applyToRoman(lyrics: string, entries: Correction[] | undefined): string {
  if (!entries?.some((e) => e.s === 'roman')) return lyrics
  return resolveLines(lyrics.split('\n'), entries, 'roman')
    .filter((line) => line.text !== null)
    .map((line) => line.text)
    .join('\n')
}

/** A row that exists in one script only: every other column reads as "no line here". */
function addedRow(column: number, text: string): MultiRow {
  const row: MultiRow = [0, REMOVED, REMOVED, REMOVED, REMOVED, REMOVED, REMOVED]
  row[column] = text
  return row
}

const NATIVE_SCRIPTS = SCRIPT_CHOICES.filter((s) => s !== 'roman')

/**
 * Multiscript rows with corrections applied. Returns the input array untouched when
 * there is nothing to apply; otherwise a new array, so the cached shard is never mutated.
 *
 * A removed line becomes `REMOVED` in its column, and an added line becomes a row with
 * `REMOVED` in every other column; lib/scriptRows.ts turns both into "skip this line".
 *
 * Roman corrections are addressed by line in the Roman lyrics text, which is a different
 * extraction from these rows, so they are carried across by text instead: a row whose
 * Roman column reads the same as `old` gets the new reading, and an added line goes
 * after the row that reads like its anchor. That keeps the side-by-side view in step
 * with the Roman view.
 */
export function applyToRows(rows: MultiRow[], entries: Correction[] | undefined): MultiRow[] {
  if (!entries || entries.length === 0) return rows

  const scripts = NATIVE_SCRIPTS.filter((s) => entries.some((e) => e.s === s))
  const resolved = scripts.map((script) => ({
    column: ROW_COLUMN[script],
    groups: resolve(rows.map((row) => row[ROW_COLUMN[script]] as string), entries.filter((e) => e.s === script)),
  }))

  const out: MultiRow[] = []
  for (let g = 0; g <= rows.length; g++) {
    if (g > 0) {
      const original = rows[g - 1]!
      let row = original
      for (const { column, groups } of resolved) {
        const text = groups[g]![0]!.text ?? REMOVED
        if (text === original[column]) continue
        if (row === original) row = original.slice() as MultiRow
        row[column] = text
      }
      out.push(row)
    }
    for (const { column, groups } of resolved) {
      for (const slot of groups[g]!.slice(1)) {
        if (slot.text !== null) out.push(addedRow(column, slot.text))
      }
    }
  }

  const romanColumn = ROW_COLUMN.roman
  const reads = (row: MultiRow, wanted: string) => (row[romanColumn] as string).trim() === wanted
  for (const entry of entries) {
    if (entry.s !== 'roman') continue
    if (entry.add) {
      const added = entry.add.map((text) => addedRow(romanColumn, text.trim()))
      if (entry.old === null) {
        if (entry.i === -1 && !entry.n) out.unshift(...added)
        continue
      }
      const wanted = entry.old.trim()
      const anchor = wanted ? out.findIndex((row) => reads(row, wanted)) : -1
      if (anchor >= 0) out.splice(anchor + 1, 0, ...added)
      continue
    }
    const wanted = (entry.old ?? '').trim()
    if (!wanted) continue
    for (let index = 0; index < out.length; index++) {
      if (!reads(out[index]!, wanted)) continue
      const copy = out[index]!.slice() as MultiRow
      copy[romanColumn] = entry.del ? REMOVED : (entry.new ?? '').trim()
      out[index] = copy
    }
  }
  return out
}
