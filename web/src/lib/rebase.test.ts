/**
 * suggestions/Rebase.gs runs in Apps Script, where nothing can be tested. It is written
 * as plain functions with no Apps Script services, so it is loaded and exercised here.
 *
 * Each case is also checked against lib/corrections.ts, the code that finally applies
 * what gets published: a change reported clean must really take effect on the site.
 */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

import { applyToRoman, type Correction } from './corrections'

type Change = Omit<Correction, 's' | 'at'>
interface Result {
  status: 'clean' | 'applied' | 'conflict'
  change: Change
  current?: string | null
  at?: string
  samePlace?: true
}

const sandbox: {
  rebase_?: (changes: Change[], landed: Correction[], picked?: boolean[]) => Result[]
  competing_?: (mine: Result[], theirs: Result[]) => (string | null | undefined)[]
} = {}
runInNewContext(
  readFileSync(new URL('../../../suggestions/Rebase.gs', import.meta.url), 'utf8'),
  sandbox,
)
const rebase = sandbox.rebase_!
const competing = sandbox.competing_!

const base = ['one', 'two', 'three', 'four']
const roman = (c: Change, at = ''): Correction => ({ ...c, s: 'roman', ...(at ? { at } : {}) })

/** The song after `landed`, then after publishing what rebase_ says is publishable. */
function publish(changes: Change[], landed: Correction[], picked?: boolean[]) {
  const results = rebase(changes, landed, picked)
  const entries = results
    .filter((r, k) => r.status === 'clean' && (!picked || picked[k]))
    .map((r) => roman(r.change))
  return {
    results,
    statuses: results.map((r) => r.status),
    lines: applyToRoman(base.join('\n'), [...landed, ...entries]).split('\n'),
  }
}

describe('rebase_', () => {
  it('leaves a suggestion alone when nothing landed', () => {
    const changes: Change[] = [{ i: 1, old: 'two', new: 'TWO' }]
    const { results, lines } = publish(changes, [])
    expect(results).toEqual([{ status: 'clean', change: changes[0] }])
    expect(lines).toEqual(['one', 'TWO', 'three', 'four'])
  })

  it('lets corrections to different lines both through', () => {
    const { statuses, lines } = publish(
      [{ i: 1, old: 'two', new: 'TWO' }],
      [roman({ i: 2, old: 'three', new: 'THREE' })],
    )
    expect(statuses).toEqual(['clean'])
    expect(lines).toEqual(['one', 'TWO', 'THREE', 'four'])
  })

  it('drops a change someone else already made', () => {
    const { statuses, lines } = publish(
      [{ i: 1, old: 'two', new: 'TWO' }, { i: 3, old: 'four', del: true }],
      [roman({ i: 1, old: 'two', new: 'TWO' }), roman({ i: 3, old: 'four', del: true })],
    )
    expect(statuses).toEqual(['applied', 'applied'])
    expect(lines).toEqual(['one', 'TWO', 'three'])
  })

  it('reports a conflict with the present text of the line', () => {
    const { results } = publish(
      [{ i: 1, old: 'two', new: 'TWO' }, { i: 2, old: 'three', new: 'THREE' }],
      [roman({ i: 1, old: 'two', new: 'deux' }, '2026-11-20')],
    )
    expect(results[0]).toMatchObject({ status: 'conflict', current: 'deux', at: '2026-11-20' })
    expect(results[1]!.status).toBe('clean')
  })

  it('conflicts with a removal, and a removal conflicts with a change', () => {
    expect(publish([{ i: 1, old: 'two', new: 'TWO' }], [roman({ i: 1, old: 'two', del: true })])
      .results[0]).toMatchObject({ status: 'conflict', current: null })
    expect(publish([{ i: 1, old: 'two', del: true }], [roman({ i: 1, old: 'two', new: 'deux' })])
      .statuses).toEqual(['conflict'])
  })

  it('is clean again once a landed change was reverted', () => {
    const { statuses, lines } = publish(
      [{ i: 1, old: 'two', new: 'TWO' }],
      [roman({ i: 1, old: 'two', new: 'deux' }), roman({ i: 1, old: 'deux', new: 'two' })],
    )
    expect(statuses).toEqual(['clean'])
    expect(lines).toEqual(['one', 'TWO', 'three', 'four'])
  })

  it('moves an address down past lines added before it', () => {
    // The reader saw: one, x, two… and corrected x, the first line added after "one".
    const before: Correction[] = [roman({ i: 0, old: 'one', add: ['x'] })]
    const landed: Correction[] = [roman({ i: 0, old: 'one', add: ['p', 'q'] })]
    const results = rebase([{ i: 0, n: 1, old: 'x', new: 'X' }], landed)
    expect(results[0]).toMatchObject({ status: 'clean', change: { i: 0, n: 3, old: 'x', new: 'X' } })
    const lines = applyToRoman(base.join('\n'), [...before, ...landed, roman(results[0]!.change)])
    expect(lines.split('\n')).toEqual(['one', 'p', 'q', 'X', 'two', 'three', 'four'])
  })

  it('re-anchors added lines on a line that was corrected since', () => {
    const { results, lines } = publish(
      [{ i: 1, old: 'two', add: ['two-a'] }],
      [roman({ i: 1, old: 'two', new: 'TWO' })],
    )
    expect(results[0]).toMatchObject({ status: 'clean', change: { old: 'TWO' } })
    expect(lines).toEqual(['one', 'TWO', 'two-a', 'three', 'four'])
  })

  it('re-anchors added lines on a line that was removed since', () => {
    const { results, lines } = publish(
      [{ i: 1, old: 'two', add: ['two-a'] }],
      [roman({ i: 1, old: 'two', del: true })],
    )
    expect(results[0]!.change.old).toBeNull()
    expect(lines).toEqual(['one', 'two-a', 'three', 'four'])
  })

  it('flags lines added in the same place, and drops identical ones', () => {
    const landed = [roman({ i: 1, old: 'two', add: ['theirs'] })]
    const different = publish([{ i: 1, old: 'two', add: ['mine'] }], landed)
    expect(different.results[0]).toMatchObject({ status: 'clean', samePlace: true })
    expect(different.lines).toEqual(['one', 'two', 'mine', 'theirs', 'three', 'four'])
    expect(publish([{ i: 1, old: 'two', add: ['theirs'] }], landed).statuses).toEqual(['applied'])
  })

  it('ignores landed entries for other lines and groups', () => {
    const { results } = publish(
      [{ i: 2, n: 0, old: 'three', new: 'THREE' }],
      [roman({ i: 1, old: 'two', add: ['x', 'y'] }), roman({ i: 3, old: 'four', del: true })],
    )
    expect(results[0]).toEqual({ status: 'clean', change: { i: 2, old: 'three', new: 'THREE' } })
  })

  describe('one suggestion that corrects a line and adds lines after it', () => {
    const changes: Change[] = [
      { i: 1, old: 'two', new: 'TWO' },
      { i: 1, old: 'TWO', add: ['two-a'] },
    ]

    it('publishes both as written', () => {
      expect(publish(changes, []).lines).toEqual(['one', 'TWO', 'two-a', 'three', 'four'])
    })

    it('still adds the lines when the correction is left out', () => {
      const { results, lines } = publish(changes, [], [false, true])
      expect(results[1]!.change.old).toBe('two')
      expect(lines).toEqual(['one', 'two', 'two-a', 'three', 'four'])
    })

    it('still adds the lines when the correction lost to another one', () => {
      const landed = [roman({ i: 1, old: 'two', new: 'deux' })]
      const { statuses, lines } = publish(changes, landed, [false, true])
      expect(statuses).toEqual(['conflict', 'clean'])
      expect(lines).toEqual(['one', 'deux', 'two-a', 'three', 'four'])
    })

    it('still adds the lines when the correction was already made', () => {
      const landed = [roman({ i: 1, old: 'two', new: 'TWO' })]
      const { statuses, lines } = publish(changes, landed)
      expect(statuses).toEqual(['applied', 'clean'])
      expect(lines).toEqual(['one', 'TWO', 'two-a', 'three', 'four'])
    })
  })
})

describe('competing_', () => {
  it('shows the other reading where two pending suggestions change one line', () => {
    const mine = rebase([{ i: 1, old: 'two', new: 'TWO' }, { i: 2, old: 'three', new: 'THREE' }], [])
    const theirs = rebase([{ i: 1, old: 'two', new: 'deux' }, { i: 3, old: 'four', del: true }], [])
    expect(competing(mine, theirs)).toEqual(['deux', undefined])
    expect(competing(theirs, mine)).toEqual(['TWO', undefined])
  })

  it('does not count the same fix sent twice', () => {
    const mine = rebase([{ i: 1, old: 'two', new: 'TWO' }], [])
    expect(competing(mine, mine)).toEqual([undefined])
  })
})
