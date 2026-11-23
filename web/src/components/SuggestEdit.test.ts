/**
 * The editor's output is applied by lib/corrections.ts, so the contract worth pinning is
 * the round trip: whatever a reader does to the list, applying the generated changes to
 * the shipped lines must reproduce exactly what they saw — including on a song that
 * already carries earlier corrections.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../lib/workerClient', () => ({ getWorker: () => ({}) }))

import { applyToRoman, resolveLines, type Correction } from '../lib/corrections'
import type { EditableLine } from '../lib/types'
import { draftsFromText } from '../lib/suggestDrafts'
import { buildChanges, contactProblem, toDrafts, type Draft } from './SuggestEdit'

const base = ['one', 'two', '', 'three', 'four']

function editable(entries: Correction[]): EditableLine[] {
  return resolveLines(base, entries, 'roman')
    .filter((line) => line.text !== null)
    .map((line) => ({
      i: line.i, n: line.n, text: line.text!, kind: line.text!.trim() ? 'line' : 'blank',
    }))
}

const fresh = (value: string): Draft => ({ key: Math.random(), value, removed: false })

/** What the reader sees in the editor once their edits are in. */
const seen = (drafts: Draft[]) =>
  drafts.filter((d) => !d.removed && (d.source?.kind === 'blank' || d.value.trim())).map((d) => d.value.trim())

function roundTrip(earlier: Correction[], edit: (drafts: Draft[]) => Draft[]) {
  const drafts = edit(toDrafts(editable(earlier)))
  const changes = buildChanges(drafts).map((c) => ({ ...c, s: 'roman' as const }))
  const result = applyToRoman(base.join('\n'), [...earlier, ...changes]).split('\n')
  expect(result).toEqual(seen(drafts))
  return changes
}

describe('contactProblem', () => {
  it('requires a name, a country code and a phone number', () => {
    expect(contactProblem('', '+91', '9876543210')).toMatch(/name/)
    expect(contactProblem('Asha', '', '9876543210')).toMatch(/country code/)
    expect(contactProblem('Asha', '91', '9876543210')).toMatch(/country code/)
    expect(contactProblem('Asha', '+0', '9876543210')).toMatch(/country code/)
    expect(contactProblem('Asha', '+91', '')).toMatch(/phone/)
    expect(contactProblem('Asha', '+91', '12345')).toMatch(/phone/)
    expect(contactProblem('Asha', '+91', 'not a number')).toMatch(/phone/)
  })

  it('accepts usual ways of writing a number', () => {
    expect(contactProblem('Asha', '+91', '98765 43210')).toBe('')
    expect(contactProblem('Asha', '+1', '(415) 555-0100')).toBe('')
    expect(contactProblem('Asha', '+971', '50.123.4567')).toBe('')
  })
})

describe('buildChanges', () => {
  it('sends nothing when nothing changed', () => {
    expect(roundTrip([], (d) => d)).toEqual([])
  })

  it('changes, removes and adds in one batch', () => {
    const changes = roundTrip([], (d) => {
      d[0]!.value = 'ONE'
      d[1]!.removed = true
      return [fresh('zero'), d[0]!, fresh('one-a'), fresh('one-b'), ...d.slice(1), fresh('five')]
    })
    expect(changes).toHaveLength(5)
  })

  it('anchors an added line on a line changed or removed in the same batch', () => {
    roundTrip([], (d) => {
      d[0]!.value = 'ONE'
      d[3]!.removed = true
      return [d[0]!, fresh('a'), ...d.slice(1, 4), fresh('b'), d[4]!]
    })
  })

  it('treats a cleared line as removed and ignores empty new lines', () => {
    const changes = roundTrip([], (d) => {
      d[1]!.value = '   '
      return [...d, fresh('  ')]
    })
    expect(changes).toEqual([{ s: 'roman', i: 1, old: 'two', del: true }])
  })

  it('edits lines that an earlier correction added', () => {
    const earlier: Correction[] = [
      { s: 'roman', i: 0, old: 'one', add: ['x', 'y', 'z'] },
      { s: 'roman', i: -1, old: null, add: ['top'] },
      { s: 'roman', i: 3, old: 'three', del: true },
    ]
    roundTrip(earlier, (d) => {
      // top, one, x, y, z, two, '', four
      d[2]!.value = 'X'
      d[3]!.removed = true
      return [fresh('first'), ...d.slice(0, 3), fresh('x2'), d[3]!, fresh('y2'), ...d.slice(4), fresh('end')]
    })
  })
})

describe('draftsFromText', () => {
  /** Type `typed` over the song and check the site would then read exactly that. */
  function typeOver(earlier: Correction[], retype: (lines: string[]) => string[]) {
    const lines = editable(earlier)
    const typed = retype(lines.map((line) => line.text))
    const { drafts, ignored } = draftsFromText(lines, typed.join('\n'))
    const changes = buildChanges(drafts).map((c) => ({ ...c, s: 'roman' as const }))
    const result = applyToRoman(base.join('\n'), [...earlier, ...changes]).split('\n')
    return { changes, result, ignored }
  }

  it('sends nothing for untouched text', () => {
    const { changes, ignored } = typeOver([], (t) => t)
    expect(changes).toEqual([])
    expect(ignored).toBe(false)
  })

  it('reads a fixed word as one changed line', () => {
    const { changes, result } = typeOver([], () => ['one', 'twoo', '', 'three', 'four'])
    expect(changes).toEqual([{ s: 'roman', i: 1, old: 'two', new: 'twoo' }])
    expect(result).toEqual(['one', 'twoo', '', 'three', 'four'])
  })

  it('reads a rewritten line as changed, not removed and added', () => {
    const { changes } = typeOver([], () => ['one', 'something else', '', 'three', 'four'])
    expect(changes).toEqual([{ s: 'roman', i: 1, old: 'two', new: 'something else' }])
  })

  it('removes a line', () => {
    const { changes, result } = typeOver([], () => ['one', 'two', '', 'four'])
    expect(changes).toEqual([{ s: 'roman', i: 3, old: 'three', del: true }])
    expect(result).toEqual(['one', 'two', '', 'four'])
  })

  it('adds lines at the top, in the middle and at the end', () => {
    const { changes, result } = typeOver([], () =>
      ['zero', 'one', 'one-a', 'one-b', 'two', '', 'three', 'four', 'five'])
    expect(result).toEqual(['zero', 'one', 'one-a', 'one-b', 'two', '', 'three', 'four', 'five'])
    expect(changes).toHaveLength(3)
  })

  it('pairs a corrected line with itself when a new line is typed before it', () => {
    const { changes, result } = typeOver([], () => ['one', 'two', '', 'brand new', 'threee', 'four'])
    expect(result).toEqual(['one', 'two', '', 'brand new', 'threee', 'four'])
    expect(changes).toContainEqual({ s: 'roman', i: 3, old: 'three', new: 'threee' })
  })

  it('handles a pasted replacement of every line', () => {
    const { result } = typeOver([], () => ['alpha', 'beta', 'gamma'])
    expect(result.filter(Boolean)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('keeps blank lines whatever is typed, and says so', () => {
    const { changes, result, ignored } = typeOver([], () => ['one', 'two', 'three', 'four'])
    expect(changes).toEqual([])
    expect(result).toEqual(base)
    expect(ignored).toBe(true)
  })

  it('ignores extra blank lines and Windows line endings', () => {
    const lines = editable([])
    const { drafts } = draftsFromText(lines, 'one\r\ntwo\r\n\r\n\r\nthree\r\nfour\r\n')
    expect(buildChanges(drafts)).toEqual([])
  })

  it('tells repeated lines apart by position', () => {
    const refrain: EditableLine[] = ['hari', 'a', 'hari', 'b', 'hari'].map((text, i) => ({
      i, n: 0, text, kind: 'line',
    }))
    const { drafts } = draftsFromText(refrain, 'hari\na\nharI\nb\nhari')
    expect(buildChanges(drafts)).toEqual([{ i: 2, old: 'hari', new: 'harI' }])
  })

  it('leaves a heading alone when it is typed over', () => {
    const lines: EditableLine[] = [
      { i: 0, n: 0, text: 'pallavi', kind: 'heading' },
      { i: 1, n: 0, text: 'line', kind: 'line' },
    ]
    const { drafts, ignored } = draftsFromText(lines, 'pallavI\nline')
    expect(buildChanges(drafts)).toEqual([])
    expect(ignored).toBe(true)
  })

  it('works on a song that already carries corrections', () => {
    const earlier: Correction[] = [
      { s: 'roman', i: 0, old: 'one', add: ['x', 'y', 'z'] },
      { s: 'roman', i: -1, old: null, add: ['top'] },
      { s: 'roman', i: 3, old: 'three', del: true },
    ]
    // top, one, x, y, z, two, '', four
    const typed = ['first', 'top', 'one', 'X', 'x2', 'z', 'two', '', 'four', 'end']
    const { result } = typeOver(earlier, () => typed)
    expect(result).toEqual(typed)
  })
})
