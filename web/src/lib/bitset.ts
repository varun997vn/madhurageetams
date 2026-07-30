/**
 * Fixed-width bitsets over song slots.
 *
 * Facet counting is the hot path: after every keystroke or checkbox the UI needs a live
 * count for ~1,100 facet values against the current candidate set. Storing one bitmap
 * per facet value (7,898 bits = 988 bytes) turns that into ~1,100 popcounts over 247
 * words each, which is a few hundred thousand word operations — comfortably under a
 * frame. Doing the same with arrays of ids would be orders of magnitude slower.
 */

export type Bitset = Uint32Array

export function wordCount(size: number): number {
  return (size + 31) >>> 5
}

export function create(size: number): Bitset {
  return new Uint32Array(wordCount(size))
}

export function createFull(size: number): Bitset {
  const bits = create(size)
  bits.fill(0xffffffff)
  const extra = size & 31
  if (extra !== 0) bits[bits.length - 1] = (1 << extra) - 1
  return bits
}

export function set(bits: Bitset, index: number): void {
  bits[index >>> 5]! |= 1 << (index & 31)
}

export function get(bits: Bitset, index: number): boolean {
  return (bits[index >>> 5]! & (1 << (index & 31))) !== 0
}

export function and(a: Bitset, b: Bitset): Bitset {
  const out = new Uint32Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i]! & b[i]!
  return out
}

export function andInto(target: Bitset, other: Bitset): void {
  for (let i = 0; i < target.length; i++) target[i]! &= other[i]!
}

export function orInto(target: Bitset, other: Bitset): void {
  for (let i = 0; i < target.length; i++) target[i]! |= other[i]!
}

/** Hamming weight, via the standard SWAR popcount. */
export function popcount(bits: Bitset): number {
  let total = 0
  for (let i = 0; i < bits.length; i++) {
    let v = bits[i]!
    v = v - ((v >>> 1) & 0x55555555)
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
    v = (v + (v >>> 4)) & 0x0f0f0f0f
    total += (v * 0x01010101) >>> 24
  }
  return total
}

/** Popcount of `a AND b` without materialising the intersection. */
export function popcountAnd(a: Bitset, b: Bitset): number {
  let total = 0
  for (let i = 0; i < a.length; i++) {
    let v = a[i]! & b[i]!
    v = v - ((v >>> 1) & 0x55555555)
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
    v = (v + (v >>> 4)) & 0x0f0f0f0f
    total += (v * 0x01010101) >>> 24
  }
  return total
}

export function isEmpty(bits: Bitset): boolean {
  for (let i = 0; i < bits.length; i++) if (bits[i] !== 0) return false
  return true
}

/** Materialise the set bits, in ascending slot order. */
export function toArray(bits: Bitset, limit = Infinity): number[] {
  const out: number[] = []
  for (let w = 0; w < bits.length; w++) {
    let word = bits[w]!
    while (word !== 0) {
      const lsb = word & -word
      out.push((w << 5) + (31 - Math.clz32(lsb)))
      if (out.length >= limit) return out
      word ^= lsb
    }
  }
  return out
}

export function forEach(bits: Bitset, fn: (slot: number) => void): void {
  for (let w = 0; w < bits.length; w++) {
    let word = bits[w]!
    while (word !== 0) {
      const lsb = word & -word
      fn((w << 5) + (31 - Math.clz32(lsb)))
      word ^= lsb
    }
  }
}
