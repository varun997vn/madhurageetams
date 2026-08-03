import { describe, expect, it } from 'vitest'
import {
  decodeSong,
  effectiveScript,
  langTag,
  nativeRows,
  offersScripts,
  pairedRows,
  romanRows,
  rowsFor,
  rowsToText,
} from './scriptRows'
import type { MultiRow, NativeSong } from './types'

/**
 * Synthetic songs, deliberately. The corpus is password-gated and this file is committed
 * to a public repository, so the fixtures use placeholder text and exercise structure
 * rather than content. Every shape here is one the real data actually produces.
 */

const heading: MultiRow = [1, 'pallavi', 'पल्लवि', 'பல்லவி', 'പല്ലവി', 'ಪಲ್ಲವಿ', 'పల్లవి']
const line1: MultiRow = [0, 'roman one', 'deva one', 'tam one', 'mal one', 'kan one', 'tel one']
const line2: MultiRow = [0, 'roman two', 'deva two', 'tam two', 'kan two', 'kan two', 'tel two']
const romanOnly: MultiRow = [0, 'roman orphan', '', '', '', '', '']
const nativeOnly: MultiRow = [0, '', 'deva orphan', 'tam orphan', 'mal orphan', 'kan orphan', 'tel orphan']

function song(overrides: Partial<NativeSong> = {}): NativeSong {
  return {
    printed: 'devanagari',
    rows: [heading, line1, line2, romanOnly, nativeOnly],
    verified: true,
    ...overrides,
  }
}

describe('offersScripts', () => {
  /**
   * Regression guard for a real incident: the app was deployed with the native shards
   * missing, and every song then showed disabled controls whose tooltips made claims
   * about the corpus that were really facts about the deployment.
   */
  it('is false when the build ships no native data', () => {
    expect(offersScripts({ nativeScripts: false })).toBe(false)
  })

  it('is false before stats have loaded', () => {
    expect(offersScripts(null)).toBe(false)
    expect(offersScripts(undefined)).toBe(false)
  })

  it('is true only on an explicit true', () => {
    expect(offersScripts({ nativeScripts: true })).toBe(true)
  })
})

describe('effectiveScript', () => {
  it('honours the preference — every song has every script now', () => {
    expect(effectiveScript('telugu')).toBe('telugu')
    expect(effectiveScript('roman')).toBe('roman')
    expect(effectiveScript('malayalam')).toBe('malayalam')
  })

  it('lets a per-song override win over the preference', () => {
    expect(effectiveScript('tamil', null, 'kannada')).toBe('kannada')
    expect(effectiveScript('tamil', null, null)).toBe('tamil')
  })
})

describe('nativeRows', () => {
  it('picks the requested column and keeps headings', () => {
    const rows = nativeRows(song(), 'kannada')
    expect(rows[0]).toEqual({ heading: true, native: 'ಪಲ್ಲವಿ', roman: 'pallavi' })
    expect(rows[1]!.native).toBe('kan one')
  })

  it('keeps roman-only rows (empty native cell) so stanza shape survives', () => {
    const rows = nativeRows(song(), 'telugu')
    const orphan = rows.find((r) => r.roman === 'roman orphan')
    expect(orphan).toBeDefined()
    expect(orphan!.native).toBeUndefined()
  })

  it('keeps native-only rows', () => {
    const rows = nativeRows(song(), 'telugu')
    expect(rows.some((r) => r.native === 'tel orphan')).toBe(true)
  })
})

describe('rowsFor', () => {
  it('returns null for roman so the caller uses the shipped lyrics', () => {
    expect(rowsFor(song(), 'roman', false)).toBeNull()
  })

  it('returns rows for every Indic script', () => {
    for (const script of ['tamil', 'devanagari', 'malayalam', 'kannada', 'telugu'] as const) {
      expect(rowsFor(song(), script, false)).not.toBeNull()
    }
  })
})

describe('rowsToText', () => {
  it('renders single-script text with blank line before headings', () => {
    const text = rowsToText(nativeRows(song(), 'devanagari'), false)
    expect(text.startsWith('पल्लवि')).toBe(true)
    expect(text).toContain('deva one')
  })

  it('indents roman under native in bilingual mode', () => {
    const text = rowsToText(pairedRows(song(), 'devanagari'), true)
    expect(text).toContain('deva one\n    roman one')
  })
})

describe('romanRows', () => {
  it('reproduces the roman column with heading flags', () => {
    const rows = romanRows(song())
    expect(rows[0]).toEqual({ heading: true, roman: 'pallavi' })
    expect(rows[3]).toEqual({ heading: false, roman: 'roman orphan' })
  })
})

describe('langTag', () => {
  it('combines the song language with the rendered script', () => {
    expect(langTag('devanagari', 'Telugu')).toBe('te-Deva')
    expect(langTag('kannada', 'Sanskrit')).toBe('sa-Knda')
    expect(langTag('tamil', 'Tamil')).toBe('ta-Taml')
    expect(langTag('roman', 'Hindi')).toBe('hi-Latn')
  })

  it('falls back to und for unknown languages', () => {
    expect(langTag('telugu', 'Klingon')).toBe('und-Telu')
  })
})

describe('decodeSong', () => {
  it('decodes printed-script codes including mixed', () => {
    expect(decodeSong({ p: 0, rows: [], v: 1 }).printed).toBeNull()
    expect(decodeSong({ p: 1, rows: [], v: 1 }).printed).toBe('devanagari')
    expect(decodeSong({ p: 2, rows: [], v: 0 }).printed).toBe('tamil')
    expect(decodeSong({ p: 3, rows: [], v: 1 }).printed).toBe('mixed')
  })

  it('decodes the verified flag', () => {
    expect(decodeSong({ p: 1, rows: [], v: 0 }).verified).toBe(false)
    expect(decodeSong({ p: 1, rows: [], v: 1 }).verified).toBe(true)
  })
})
