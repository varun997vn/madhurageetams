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
import type { NativeSong } from './types'

/**
 * Synthetic songs, deliberately. The corpus is password-gated and this file is committed
 * to a public repository, so the fixtures use placeholder text and exercise structure
 * rather than content. Every shape here is one the real data actually produces — the
 * counts in the comments are measured over all 7,898 songs.
 */

/** A heading row (945 corpus-wide inside `aligned`) never carries native text. */
const HEADING: [0 | 1, string] = [1, 'pallavi']

function song(overrides: Partial<NativeSong> = {}): NativeSong {
  return {
    script: 'devanagari',
    roman: [HEADING, [0, 'roman one'], [0, 'roman two'], [0, 'roman orphan']],
    native: ['deva zero', 'deva one', 'deva two', 'deva orphan'],
    pairs: [
      [0, 0], // heading, which does have a native counterpart
      [1, 1], // both sides       (175,922 corpus-wide)
      [3, -1], // roman only      (26,547 corpus-wide)
      [-1, 3], // native only     (11,562 corpus-wide)
    ],
    verified: true,
    ...overrides,
  }
}

describe('offersScripts', () => {
  /**
   * This is the regression guard for a real incident: the app was deployed with the native
   * shards missing, and every song then showed a disabled Devanagari button whose tooltip
   * said the master copy does not print that song in Devanagari. That is a claim about the
   * corpus standing in for a fact about the deployment.
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
  it('honours a preference the song can satisfy', () => {
    expect(effectiveScript('devanagari', 'devanagari')).toBe('devanagari')
    expect(effectiveScript('tamil', 'tamil')).toBe('tamil')
  })

  it('falls back to Roman when the song is printed in the other script', () => {
    // The single most common disappointment: each song carries exactly one Indic script.
    expect(effectiveScript('tamil', 'devanagari')).toBe('roman')
    expect(effectiveScript('devanagari', 'tamil')).toBe('roman')
  })

  it('falls back to Roman for the songs with no Indic column', () => {
    expect(effectiveScript('devanagari', null)).toBe('roman')
    expect(effectiveScript('tamil', null)).toBe('roman')
  })

  it('lets a per-song override win over the reader default', () => {
    expect(effectiveScript('roman', 'devanagari', 'devanagari')).toBe('devanagari')
    expect(effectiveScript('devanagari', 'devanagari', 'roman')).toBe('roman')
  })

  it('treats a null override as "follow the default"', () => {
    expect(effectiveScript('devanagari', 'devanagari', null)).toBe('devanagari')
  })

  it('does not let an override conjure a script the song lacks', () => {
    expect(effectiveScript('roman', 'devanagari', 'tamil')).toBe('roman')
  })
})

describe('nativeRows', () => {
  it('keeps native lines in order', () => {
    expect(nativeRows(song()).map((r) => r.native)).toEqual([
      'deva zero',
      'deva one',
      'deva orphan',
    ])
  })

  it('marks a row as a heading when its Roman counterpart is one', () => {
    // The native column records no headings at all, so this carry-across is the only way a
    // single-script reading view keeps its pallavi and charaNam markers.
    expect(nativeRows(song())[0]).toEqual({ heading: true, native: 'deva zero' })
  })

  it('drops Roman-only rows, which are the other column wrapping', () => {
    expect(nativeRows(song()).some((r) => r.native === undefined && !r.heading)).toBe(false)
  })

  it('keeps a Roman heading that has no native counterpart', () => {
    const withOrphanHeading = song({ pairs: [[0, -1], [1, 1]] })
    expect(nativeRows(withOrphanHeading)[0]).toEqual({ heading: true, roman: 'pallavi' })
  })

  it('returns nothing for a song with no Indic column', () => {
    expect(nativeRows(song({ script: null, native: [], pairs: [] }))).toEqual([])
  })
})

describe('pairedRows', () => {
  it('emits both sides where both exist', () => {
    expect(pairedRows(song())[1]).toEqual({
      heading: false,
      roman: 'roman one',
      native: 'deva one',
    })
  })

  it('leaves the missing side undefined rather than inventing a placeholder', () => {
    const rows = pairedRows(song())
    expect(rows[2]).toEqual({ heading: false, roman: 'roman orphan', native: undefined })
    expect(rows[3]).toEqual({ heading: false, roman: undefined, native: 'deva orphan' })
  })

  it('keeps both texts on a heading that was printed in the native script too', () => {
    expect(pairedRows(song())[0]).toEqual({
      heading: true,
      roman: 'pallavi',
      native: 'deva zero',
    })
  })

  it('skips a pair with nothing on either side', () => {
    expect(pairedRows(song({ pairs: [[-1, -1], [1, 1]] }))).toHaveLength(1)
  })
})

describe('romanRows', () => {
  it('preserves every Roman row including headings', () => {
    const rows = romanRows(song())
    expect(rows).toHaveLength(4)
    expect(rows[0]).toEqual({ heading: true, roman: 'pallavi' })
  })
})

describe('rowsFor', () => {
  it('returns null for Roman so callers use the shipped lyrics', () => {
    expect(rowsFor(song(), 'roman', false)).toBeNull()
  })

  it('returns null when the song does not carry the requested script', () => {
    expect(rowsFor(song(), 'tamil', false)).toBeNull()
  })

  it('switches between single and paired', () => {
    expect(rowsFor(song(), 'devanagari', false)).toEqual(nativeRows(song()))
    expect(rowsFor(song(), 'devanagari', true)).toEqual(pairedRows(song()))
  })
})

describe('rowsToText', () => {
  it('writes one line per row in single-script mode', () => {
    // The heading resolves to its native rendering, keeping the sheet single-script.
    expect(rowsToText(nativeRows(song()), false)).toBe('deva zero\ndeva one\ndeva orphan')
  })

  it('falls back to the Roman label for a heading with no native counterpart', () => {
    const rows = nativeRows(song({ pairs: [[0, -1], [1, 1]] }))
    expect(rowsToText(rows, false)).toBe('pallavi\ndeva one')
  })

  it('indents the Roman beneath its native line when bilingual', () => {
    expect(rowsToText(pairedRows(song()), true)).toBe(
      'deva zero\ndeva one\n    roman one\n    roman orphan\ndeva orphan',
    )
  })

  it('survives a round trip through non-ASCII text', () => {
    // The PDF exporter strips non-Latin-1; that must never leak into the text path.
    const text = rowsToText([{ heading: false, native: 'नमः' }], false)
    expect(text).toBe('नमः')
  })
})

describe('langTag', () => {
  it('tags Tamil plainly', () => {
    expect(langTag('tamil', 'Tamil')).toBe('ta')
  })

  it('names the script explicitly for languages printed in Devanagari', () => {
    // 993 Telugu and 773 Kannada songs are printed in Devanagari in this document.
    expect(langTag('devanagari', 'Telugu')).toBe('te-Deva')
    expect(langTag('devanagari', 'Kannada')).toBe('kn-Deva')
    expect(langTag('devanagari', 'Sanskrit')).toBe('sa-Deva')
  })

  it('falls back to an undetermined language rather than guessing', () => {
    expect(langTag('devanagari', 'Konkani')).toBe('und-Deva')
  })
})

describe('decodeSong', () => {
  it('widens the shard tags to full script names', () => {
    const base = { rom: [], nat: [], pair: [], v: 1 as const }
    expect(decodeSong({ ...base, s: 'deva' }).script).toBe('devanagari')
    expect(decodeSong({ ...base, s: 'taml' }).script).toBe('tamil')
    expect(decodeSong({ ...base, s: null }).script).toBeNull()
  })

  it('carries the verification flag through', () => {
    const base = { s: 'deva' as const, rom: [], nat: [], pair: [] }
    expect(decodeSong({ ...base, v: 0 }).verified).toBe(false)
    expect(decodeSong({ ...base, v: 1 }).verified).toBe(true)
  })
})
