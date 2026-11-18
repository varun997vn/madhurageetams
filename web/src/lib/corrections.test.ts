import { describe, expect, it } from 'vitest'
import { applyToRoman, applyToRows, indexCorrections, type Correction } from './corrections'
import type { MultiRow } from './types'

const rows: MultiRow[] = [
  [1, 'pallavi', 'पल्लवि', 'பல்லவி', 'പല്ലവി', 'ಪಲ್ಲವಿ', 'పల్లవి'],
  [0, 'rAma rAma', 'राम राम', 'ராம ராம', 'രാമ രാമ', 'ರಾಮ ರಾಮ', 'రామ రామ'],
  [0, 'hari hari', 'हरि हरि', 'ஹரி ஹரி', 'ഹരി ഹരി', 'ಹರಿ ಹರಿ', 'హరి హరి'],
]

describe('applyToRows', () => {
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
    applyToRows(rows, [{ s: 'tamil', i: 2, old: 'ஹரி ஹரி', new: 'x' }])
    expect(JSON.stringify(rows)).toBe(before)
  })

  it('skips an entry whose old text no longer matches', () => {
    const out = applyToRows(rows, [{ s: 'telugu', i: 1, old: 'something else', new: 'x' }])
    expect(out).toBe(rows)
  })

  it('skips an out-of-range row', () => {
    expect(applyToRows(rows, [{ s: 'telugu', i: 99, old: '', new: 'x' }])).toBe(rows)
  })

  it('applies a later correction on top of an earlier one', () => {
    const out = applyToRows(rows, [
      { s: 'kannada', i: 2, old: 'ಹರಿ ಹರಿ', new: 'a' },
      { s: 'kannada', i: 2, old: 'a', new: 'b' },
    ])
    expect(out[2]![5]).toBe('b')
  })

  it('carries a Roman correction to the Roman column by text', () => {
    const out = applyToRows(rows, [{ s: 'roman', i: 40, old: '  hari hari', new: 'harE hari' }])
    expect(out[2]![1]).toBe('harE hari')
    expect(out[2]![2]).toBe('हरि हरि')
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

  it('ignores corrections made in other scripts', () => {
    expect(applyToRoman(lyrics, [{ s: 'tamil', i: 1, old: 'rAma rAma', new: 'x' }])).toBe(lyrics)
  })
})

describe('indexCorrections', () => {
  it('drops malformed entries instead of throwing', () => {
    const index = indexCorrections({
      version: 1,
      songs: {
        '12': [
          { s: 'telugu', i: 1, old: 'a', new: 'b' },
          { s: 'klingon', i: 1, old: 'a', new: 'b' },
          { s: 'tamil', i: -1, old: 'a', new: 'b' },
          { s: 'tamil', i: 1, old: 'a' },
          null,
        ],
        nope: [{ s: 'tamil', i: 1, old: 'a', new: 'b' }],
        '13': 'not a list',
      },
    })
    expect([...index.keys()]).toEqual([12])
    expect(index.get(12)).toHaveLength(1)
  })

  it('tolerates a missing or broken document', () => {
    expect(indexCorrections(null).size).toBe(0)
    expect(indexCorrections({ songs: 3 }).size).toBe(0)
  })
})
