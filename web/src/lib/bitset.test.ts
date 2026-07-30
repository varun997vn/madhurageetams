import { describe, expect, it } from 'vitest'
import * as bs from './bitset'

describe('bitset', () => {
  it('sets and reads bits across word boundaries', () => {
    const b = bs.create(100)
    for (const i of [0, 31, 32, 63, 64, 99]) bs.set(b, i)
    for (const i of [0, 31, 32, 63, 64, 99]) expect(bs.get(b, i), `bit ${i}`).toBe(true)
    for (const i of [1, 30, 33, 62, 65, 98]) expect(bs.get(b, i), `bit ${i}`).toBe(false)
  })

  it('createFull sets exactly `size` bits, not the padding', () => {
    for (const size of [1, 31, 32, 33, 100, 7898]) {
      expect(bs.popcount(bs.createFull(size)), `size ${size}`).toBe(size)
    }
  })

  it('counts intersections without materialising them', () => {
    const a = bs.create(200)
    const b = bs.create(200)
    for (const i of [1, 5, 100, 150]) bs.set(a, i)
    for (const i of [5, 100, 199]) bs.set(b, i)
    expect(bs.popcountAnd(a, b)).toBe(2)
    expect(bs.popcount(bs.and(a, b))).toBe(2)
  })

  it('andInto and orInto mutate in place', () => {
    const a = bs.create(64)
    const b = bs.create(64)
    bs.set(a, 1)
    bs.set(a, 2)
    bs.set(b, 2)
    bs.set(b, 40)
    const or = a.slice()
    bs.orInto(or, b)
    expect(bs.toArray(or)).toEqual([1, 2, 40])
    bs.andInto(a, b)
    expect(bs.toArray(a)).toEqual([2])
  })

  it('toArray returns ascending slots and honours the limit', () => {
    const b = bs.create(300)
    const slots = [0, 3, 64, 65, 200, 299]
    for (const i of slots) bs.set(b, i)
    expect(bs.toArray(b)).toEqual(slots)
    expect(bs.toArray(b, 3)).toEqual([0, 3, 64])
  })

  it('forEach visits every set slot once, ascending', () => {
    const b = bs.create(300)
    const slots = [0, 31, 32, 100, 299]
    for (const i of slots) bs.set(b, i)
    const seen: number[] = []
    bs.forEach(b, (s) => seen.push(s))
    expect(seen).toEqual(slots)
  })

  it('isEmpty', () => {
    const b = bs.create(64)
    expect(bs.isEmpty(b)).toBe(true)
    bs.set(b, 63)
    expect(bs.isEmpty(b)).toBe(false)
  })

  it('handles the real corpus size', () => {
    const full = bs.createFull(7898)
    expect(bs.popcount(full)).toBe(7898)
    expect(full.length).toBe(247)
  })
})
