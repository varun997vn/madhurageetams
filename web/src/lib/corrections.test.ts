import { describe, expect, it } from 'vitest'
import {
  applyToRoman,
  applyToRows,
  indexCorrections,
  resolveLines,
  type Correction,
} from './corrections'
import { nativeRows, pairedRows, romanRows } from './scriptRows'
import { REMOVED, type MultiRow, type NativeSong } from './types'

const rows: MultiRow[] = [
  [1, 'pallavi', 'पल्लवि', 'பல்லவி', 'പല്ലവി', 'ಪಲ್ಲವಿ', 'పల్లవి'],
  [0, 'rAma rAma', 'राम राम', 'ராம ராம', 'രാമ രാമ', 'ರಾಮ ರಾಮ', 'రామ రామ'],
  [0, 'hari hari', 'हरि हरि', 'ஹரி ஹரி', 'ഹരി ഹരി', 'ಹರಿ ಹರಿ', 'హరి హరి'],
]

const song = (r: MultiRow[]): NativeSong => ({ printed: 'devanagari', rows: r, verified: true })
const texts = (r: MultiRow[], script: 'telugu' | 'tamil') =>
  nativeRows(song(r), script).map((row) => row.native)

describe('applyToRows: changing a line', () => {
  it('changes only the corrected script at the addressed row', () => {
    const fix: Correction = { s: 'telugu', i: 1, old: 'రామ రామ', new: 'రామా రామ' }
    const out = applyToRows(rows, [fix])
    expect(out[1]![6]).toBe('రామా రామ')
    expect(out[1]!.slice(0, 6)).toEqual(rows[1]!.slice(0, 6))
    expect(out[0]).toBe(rows[0])
    expect(out[2]).toBe(rows[2])
  })

  it('never mutates the cached rows', () => {
    const before = JSON.stringify(rows)
    applyToRows(rows, [
      { s: 'tamil', i: 2, old: 'ஹரி ஹரி', new: 'x' },
      { s: 'tamil', i: 1, old: 'ராம ராம', del: true },
      { s: 'tamil', i: 0, old: 'பல்லவி', add: ['y'] },
      { s: 'roman', i: 9, old: 'hari hari', del: true },
    ])
    expect(JSON.stringify(rows)).toBe(before)
  })

  it('skips an entry whose old text no longer matches, or whose row is out of range', () => {
    expect(applyToRows(rows, [{ s: 'telugu', i: 1, old: 'something else', new: 'x' }])).toEqual(rows)
    expect(applyToRows(rows, [{ s: 'telugu', i: 99, old: '', new: 'x' }])).toEqual(rows)
  })

  it('applies a later correction on top of an earlier one', () => {
    const out = applyToRows(rows, [
      { s: 'kannada', i: 2, old: 'ಹರಿ ಹರಿ', new: 'a' },
      { s: 'kannada', i: 2, old: 'a', new: 'b' },
    ])
    expect(out[2]![5]).toBe('b')
  })
})

describe('applyToRows: removing and adding lines', () => {
  it('removes a line from one script only', () => {
    const out = applyToRows(rows, [{ s: 'telugu', i: 1, old: 'రామ రామ', del: true }])
    expect(texts(out, 'telugu')).toEqual(['పల్లవి', 'హరి హరి'])
    expect(texts(out, 'tamil')).toEqual(['பல்லவி', 'ராம ராம', 'ஹரி ஹரி'])
    // Side by side, the Roman line survives with nothing beside it.
    expect(pairedRows(song(out), 'telugu')[1]).toEqual({ heading: false, native: undefined, roman: 'rAma rAma' })
  })

  it('adds lines after a line, in one script only', () => {
    const out = applyToRows(rows, [{ s: 'telugu', i: 1, old: 'రామ రామ', add: ['ఒకటి', 'రెండు'] }])
    expect(texts(out, 'telugu')).toEqual(['పల్లవి', 'రామ రామ', 'ఒకటి', 'రెండు', 'హరి హరి'])
    expect(texts(out, 'tamil')).toEqual(['பல்லவி', 'ராம ராம', 'ஹரி ஹரி'])
    expect(pairedRows(song(out), 'tamil')).toHaveLength(3)
    expect(romanRows(song(out))).toHaveLength(3)
  })

  it('adds a line at the very top', () => {
    const out = applyToRows(rows, [{ s: 'telugu', i: -1, old: null, add: ['మొదలు'] }])
    expect(texts(out, 'telugu')[0]).toBe('మొదలు')
  })

  it('lets a later correction change or remove an added line by its address', () => {
    const add: Correction = { s: 'telugu', i: 1, old: 'రామ రామ', add: ['a', 'b'] }
    const changed = applyToRows(rows, [add, { s: 'telugu', i: 1, n: 2, old: 'b', new: 'B' }])
    expect(texts(changed, 'telugu')).toEqual(['పల్లవి', 'రామ రామ', 'a', 'B', 'హరి హరి'])
    const removed = applyToRows(rows, [add, { s: 'telugu', i: 1, n: 1, old: 'a', del: true }])
    expect(texts(removed, 'telugu')).toEqual(['పల్లవి', 'రామ రామ', 'b', 'హరి హరి'])
  })

  it('keeps addresses stable after a removal', () => {
    const out = applyToRows(rows, [
      { s: 'telugu', i: 1, old: 'రామ రామ', add: ['a', 'b'] },
      { s: 'telugu', i: 1, n: 1, old: 'a', del: true },
      { s: 'telugu', i: 1, n: 2, old: 'b', new: 'B' },
      // Anchored on the removed line: `old: null` expects exactly that.
      { s: 'telugu', i: 1, n: 1, old: null, add: ['c'] },
    ])
    expect(texts(out, 'telugu')).toEqual(['పల్లవి', 'రామ రామ', 'c', 'B', 'హరి హరి'])
  })

  it('keeps two scripts independent on the same row', () => {
    const out = applyToRows(rows, [
      { s: 'telugu', i: 1, old: 'రామ రామ', add: ['t'] },
      { s: 'tamil', i: 1, old: 'ராம ராம', del: true },
    ])
    expect(texts(out, 'telugu')).toEqual(['పల్లవి', 'రామ రామ', 't', 'హరి హరి'])
    expect(texts(out, 'tamil')).toEqual(['பல்லவி', 'ஹரி ஹரி'])
  })
})

describe('applyToRows: Roman corrections carried by text', () => {
  it('changes the Roman column where the text matches', () => {
    const out = applyToRows(rows, [{ s: 'roman', i: 40, old: '  hari hari', new: 'harE hari' }])
    expect(out[2]![1]).toBe('harE hari')
    expect(out[2]![2]).toBe('हरि हरि')
  })

  it('removes and adds Roman lines without leaving blank native lines', () => {
    const out = applyToRows(rows, [
      { s: 'roman', i: 7, old: 'rAma rAma', add: ['sItA rAma'] },
      { s: 'roman', i: 9, old: 'hari hari', del: true },
    ])
    expect(romanRows(song(out)).map((r) => r.roman)).toEqual(['pallavi', 'rAma rAma', 'sItA rAma'])
    expect(texts(out, 'telugu')).toEqual(['పల్లవి', 'రామ రామ', 'హరి హరి'])
    expect(pairedRows(song(out), 'telugu').map((r) => r.roman)).toEqual([
      'pallavi', 'rAma rAma', 'sItA rAma', undefined,
    ])
  })
})

describe('applyToRoman', () => {
  const lyrics = 'pallavi\nrAma rAma\n\nhari hari'

  it('replaces the addressed line only when it still matches', () => {
    expect(applyToRoman(lyrics, [{ s: 'roman', i: 3, old: 'hari hari', new: 'harE hari' }])).toBe(
      'pallavi\nrAma rAma\n\nharE hari',
    )
    expect(applyToRoman(lyrics, [{ s: 'roman', i: 1, old: 'hari hari', new: 'x' }])).toBe(lyrics)
  })

  it('removes and adds lines', () => {
    expect(
      applyToRoman(lyrics, [
        { s: 'roman', i: 1, old: 'rAma rAma', del: true },
        { s: 'roman', i: 3, old: 'hari hari', add: ['one', 'two'] },
        { s: 'roman', i: -1, old: null, add: ['top'] },
      ]),
    ).toBe('top\npallavi\n\nhari hari\none\ntwo')
  })

  it('ignores corrections made in other scripts', () => {
    expect(applyToRoman(lyrics, [{ s: 'tamil', i: 1, old: 'rAma rAma', new: 'x' }])).toBe(lyrics)
  })
})

describe('resolveLines', () => {
  it('reports the address a further correction would use', () => {
    const lines = resolveLines(['a', 'b'], [
      { s: 'roman', i: -1, old: null, add: ['top'] },
      { s: 'roman', i: 0, old: 'a', add: ['a1'] },
      { s: 'roman', i: 1, old: 'b', del: true },
    ], 'roman')
    expect(lines).toEqual([
      { i: -1, n: 1, text: 'top' },
      { i: 0, n: 0, text: 'a' },
      { i: 0, n: 1, text: 'a1' },
      { i: 1, n: 0, text: null },
    ])
  })
})

describe('indexCorrections', () => {
  it('drops malformed entries instead of throwing', () => {
    const index = indexCorrections({
      version: 1,
      songs: {
        '12': [
          { s: 'telugu', i: 1, old: 'a', new: 'b' },
          { s: 'telugu', i: 1, old: 'a', del: true },
          { s: 'telugu', i: -1, old: null, add: ['x'] },
          { s: 'klingon', i: 1, old: 'a', new: 'b' },
          { s: 'tamil', i: -2, old: 'a', new: 'b' },
          { s: 'tamil', i: -1, old: 'a', new: 'b' },
          { s: 'tamil', i: 1, old: 'a' },
          { s: 'tamil', i: 1, old: null, new: 'b' },
          { s: 'tamil', i: 1, old: 'a', add: [] },
          { s: 'tamil', i: 1, n: -1, old: 'a', new: 'b' },
          null,
        ],
        nope: [{ s: 'tamil', i: 1, old: 'a', new: 'b' }],
        '13': 'not a list',
      },
    })
    expect([...index.keys()]).toEqual([12])
    expect(index.get(12)).toHaveLength(3)
  })

  it('tolerates a missing or broken document', () => {
    expect(indexCorrections(null).size).toBe(0)
    expect(indexCorrections({ songs: 3 }).size).toBe(0)
  })
})

describe('REMOVED never reaches a reader', () => {
  it('is absent from every rendered row', () => {
    const out = applyToRows(rows, [
      { s: 'telugu', i: 1, old: 'రామ రామ', del: true },
      { s: 'tamil', i: 0, old: 'பல்லவி', add: ['x'] },
      { s: 'roman', i: 0, old: 'hari hari', del: true },
    ])
    const rendered = JSON.stringify([
      nativeRows(song(out), 'telugu'), nativeRows(song(out), 'tamil'),
      pairedRows(song(out), 'telugu'), pairedRows(song(out), 'tamil'), romanRows(song(out)),
    ])
    expect(rendered.includes(REMOVED)).toBe(false)
    expect(rendered.includes('\\u0000')).toBe(false)
  })
})
