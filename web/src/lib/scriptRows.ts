/**
 * Turning a song's paired rows into something renderable.
 *
 * The source records three things that do not line up neatly, and every function here
 * exists to reconcile one of them:
 *
 * 1. Structural headings (pallavi, anupallavi, charaNam, the ragam/thalam line) are
 *    recorded only in the Roman column. The native column has none. So a native-only
 *    reading view gets its section markers by following a pair back to its Roman row.
 * 2. The two columns wrap differently, so 17.8% of pairs have no counterpart on one side.
 *    Those rows are real text, not errors, and must still be shown.
 * 3. A song carries at most one Indic script, so a preference for a script the song does
 *    not have has to fall back rather than render an empty page.
 */

import type { NativeSong, RowPair, ScriptChoice } from './types'

/** One line ready to render, in whichever script was asked for. */
export interface DisplayRow {
  heading: boolean
  /** Absent when this row exists only in the other column. */
  native?: string
  roman?: string
}

/**
 * Which script actually renders, given a preference and what the song has.
 *
 * A preference is a wish, not a guarantee: asking for Tamil on a Devanagari song has to
 * resolve to something, and Roman is the one column every song (bar two) carries.
 */
export function effectiveScript(
  preference: ScriptChoice,
  available: NativeSong['script'],
  override?: ScriptChoice | null,
): ScriptChoice {
  const wanted = override ?? preference
  if (wanted === 'roman') return 'roman'
  return wanted === available ? wanted : 'roman'
}

function romanText(song: NativeSong, index: number): string | undefined {
  const row = song.roman[index]
  return row ? row[1] : undefined
}

function isHeading(song: NativeSong, index: number): boolean {
  return song.roman[index]?.[0] === 1
}

/**
 * Native lines in reading order, with headings carried across from the Roman column.
 *
 * Rows that exist only in Roman are dropped: they are the other column's wrapping, and
 * showing them here would interleave two scripts in a view the reader asked to be
 * single-script. Roman *headings* are the deliberate exception — they are structural
 * labels rather than lyric text, and without them the song loses its shape.
 */
export function nativeRows(song: NativeSong): DisplayRow[] {
  const out: DisplayRow[] = []
  for (const [romanIndex, nativeIndex] of song.pairs) {
    const heading = romanIndex >= 0 && isHeading(song, romanIndex)
    if (nativeIndex >= 0) {
      const native = song.native[nativeIndex]
      if (native !== undefined) out.push({ heading, native })
    } else if (heading) {
      const roman = romanText(song, romanIndex)
      if (roman !== undefined) out.push({ heading: true, roman })
    }
  }
  return out
}

/** Both columns, for the side-by-side view. Either side may be absent. */
export function pairedRows(song: NativeSong): DisplayRow[] {
  const out: DisplayRow[] = []
  for (const [romanIndex, nativeIndex] of song.pairs) {
    const heading = romanIndex >= 0 && isHeading(song, romanIndex)
    const roman = romanIndex >= 0 ? romanText(song, romanIndex) : undefined
    const native = nativeIndex >= 0 ? song.native[nativeIndex] : undefined
    if (roman === undefined && native === undefined) continue
    // A heading spans both columns rather than sitting in one of them, but it keeps both
    // texts: the ragam/thalam line is printed in the native script too, so a heading often
    // does have a native counterpart even though the native column records no `kind`.
    out.push({ heading, roman, native })
  }
  return out
}

/** The source's own Roman column, used by exports so a bilingual sheet stays consistent. */
export function romanRows(song: NativeSong): DisplayRow[] {
  return song.roman.map(([flag, text]) => ({ heading: flag === 1, roman: text }))
}

/**
 * Plain text for the .txt export and the clipboard.
 *
 * Headings keep their own line; a paired row in bilingual mode puts the native line first
 * and indents the Roman beneath it, which is how the printed page reads.
 */
export function rowsToText(rows: DisplayRow[], bilingual: boolean): string {
  const lines: string[] = []
  for (const row of rows) {
    if (row.heading) {
      // Prefer the native rendering of a section marker when the source printed one, so a
      // single-script sheet stays single-script.
      lines.push('', row.native ?? row.roman ?? '')
      continue
    }
    if (bilingual) {
      if (row.native !== undefined) lines.push(row.native)
      if (row.roman !== undefined) lines.push(`    ${row.roman}`)
    } else {
      const text = row.native ?? row.roman
      if (text !== undefined) lines.push(text)
    }
  }
  return lines.join('\n').replace(/^\n+/, '')
}

/** Rows for a chosen script, or null when the caller should use the shipped Roman lyrics. */
export function rowsFor(
  song: NativeSong,
  script: ScriptChoice,
  bilingual: boolean,
): DisplayRow[] | null {
  if (script === 'roman') return null
  if (song.script !== script) return null
  return bilingual ? pairedRows(song) : nativeRows(song)
}

/**
 * A BCP-47 tag for the rendered text.
 *
 * Worth setting precisely: it is what lets the OS pick a Devanagari face that suits the
 * language rather than a generic fallback, and it is literally true of the source — a
 * Telugu song really is printed here in Devanagari.
 */
export function langTag(script: ScriptChoice, language: string): string {
  if (script === 'tamil') return 'ta'
  if (script === 'roman') return 'und-Latn'
  const byLanguage: Record<string, string> = {
    Sanskrit: 'sa-Deva',
    Hindi: 'hi-Deva',
    Marathi: 'mr-Deva',
    Telugu: 'te-Deva',
    Kannada: 'kn-Deva',
    Malayalam: 'ml-Deva',
  }
  return byLanguage[language] ?? 'und-Deva'
}

/** Decode the shard's compact per-song form. */
export function decodeSong(entry: {
  s: 'deva' | 'taml' | null
  rom: [0 | 1, string][]
  nat: string[]
  pair: RowPair[]
  v: 0 | 1
}): NativeSong {
  return {
    script: entry.s === 'deva' ? 'devanagari' : entry.s === 'taml' ? 'tamil' : null,
    roman: entry.rom,
    native: entry.nat,
    pairs: entry.pair,
    verified: entry.v === 1,
  }
}
