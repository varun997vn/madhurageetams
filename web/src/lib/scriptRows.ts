/**
 * Turning a song's multiscript rows into something renderable.
 *
 * Every song ships one aligned row list with all six scripts as columns, so the old
 * roman/native/pair reconciliation is gone: rendering a script is picking a column.
 * Two things still deserve care:
 *
 * 1. Which column is *source* and which is machine-transliterated — `printed` carries
 *    that, and the UI says so rather than presenting generated text as the page's own.
 * 2. Empty cells: a handful of rows exist in one column only (source wrapping); those
 *    render as blank lines rather than being dropped, so stanza shape survives.
 */

import type { NativeSong, MultiRow, ScriptChoice } from './types'
import { REMOVED, ROW_COLUMN } from './types'

/** One line ready to render, in whichever script was asked for. */
export interface DisplayRow {
  heading: boolean
  /** Absent when this row has no text in the chosen script. */
  native?: string
  roman?: string
}

/**
 * Whether to render the script picker at all.
 *
 * A deployment without the multiscript data must look like one: the picker is not
 * rendered rather than shown disabled, so a missing-data deploy reads as Roman-only
 * instead of claiming the corpus lacks those scripts.
 */
export function offersScripts(stats: { nativeScripts: boolean } | null | undefined): boolean {
  return stats?.nativeScripts === true
}

/**
 * Which script actually renders. Every song carries every script now, so a preference
 * simply wins; the override still lets a setlist pin one song to a different script.
 */
export function effectiveScript(
  preference: ScriptChoice,
  _printed?: unknown,
  override?: ScriptChoice | null,
): ScriptChoice {
  return override ?? preference
}

function cell(row: MultiRow, script: ScriptChoice): string {
  return row[ROW_COLUMN[script]] as string
}

/**
 * Lines in reading order for one script. Headings render in the same script — the
 * source generates them for every column.
 */
export function nativeRows(song: NativeSong, script: ScriptChoice): DisplayRow[] {
  return displayRows(song, script, false)
}

/**
 * The chosen script beside Roman, for the side-by-side view.
 *
 * Differs from `nativeRows` only for lines an accepted correction removed from this
 * script (or added to Roman alone): on its own the script simply has no such line, but
 * beside Roman the Roman line still has to appear, with nothing next to it.
 */
export function pairedRows(song: NativeSong, script: ScriptChoice): DisplayRow[] {
  return displayRows(song, script, true)
}

function displayRows(song: NativeSong, script: ScriptChoice, paired: boolean): DisplayRow[] {
  const out: DisplayRow[] = []
  for (const row of song.rows) {
    const rawText = cell(row, script)
    const rawRoman = cell(row, 'roman')
    const text = rawText === REMOVED ? '' : rawText
    const roman = rawRoman === REMOVED ? '' : rawRoman
    if (!text && !roman) continue
    if (rawText === REMOVED && !paired) continue
    out.push({ heading: row[0] === 1, native: text || undefined, roman: roman || undefined })
  }
  return out
}

/** The source's own Roman column, used by exports so a bilingual sheet stays consistent. */
export function romanRows(song: NativeSong): DisplayRow[] {
  return song.rows
    .filter((row) => cell(row, 'roman') !== REMOVED)
    .map((row) => ({
      heading: row[0] === 1,
      roman: cell(row, 'roman') || undefined,
    }))
}

/**
 * Plain text for the .txt export and the clipboard.
 *
 * Headings keep their own line; a paired row in bilingual mode puts the native line
 * first and indents the Roman beneath it, which is how the printed page reads.
 */
export function rowsToText(rows: DisplayRow[], bilingual: boolean): string {
  const lines: string[] = []
  for (const row of rows) {
    if (row.heading) {
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
  return bilingual ? pairedRows(song, script) : nativeRows(song, script)
}

/**
 * A BCP-47 tag for the rendered text.
 *
 * Worth setting precisely: it lets the OS pick a face that suits the language rather
 * than a generic fallback. The script subtag matters because most songs render in a
 * script that is not their language's default (a Telugu song read in Devanagari, a
 * Sanskrit song read in Kannada).
 */
export function langTag(script: ScriptChoice, language: string): string {
  const lang: Record<string, string> = {
    Sanskrit: 'sa', Hindi: 'hi', Marathi: 'mr', Telugu: 'te',
    Kannada: 'kn', Malayalam: 'ml', Tamil: 'ta', English: 'en',
  }
  const scriptTag: Record<ScriptChoice, string> = {
    roman: 'Latn', tamil: 'Taml', devanagari: 'Deva',
    malayalam: 'Mlym', kannada: 'Knda', telugu: 'Telu',
  }
  const base = lang[language] ?? 'und'
  return `${base}-${scriptTag[script]}`
}

/** Decode the shard's compact per-song form. */
export function decodeSong(entry: {
  p: 0 | 1 | 2 | 3
  rows: MultiRow[]
  v: 0 | 1
}): NativeSong {
  const printed = entry.p === 1 ? 'devanagari' : entry.p === 2 ? 'tamil'
    : entry.p === 3 ? 'mixed' : null
  return {
    printed,
    rows: entry.rows,
    verified: entry.v === 1,
  }
}
