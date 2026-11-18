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
