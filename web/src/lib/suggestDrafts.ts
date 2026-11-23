/**
 * From what a reader typed to the changes sent for review.
 *
 * The editor is one textarea holding the whole song. `draftsFromText` lines the typed
 * text up against the lines the reader started from, giving one `Draft` per line, and
 * `buildChanges` turns those into addressed changes for lib/corrections.ts.
 */
import type { Correction } from './corrections'
import type { EditableLine } from './types'

/** One change as sent for review: a Correction without the script and date. */
export type Change = Omit<Correction, 's' | 'at'>

/** A line that exists (`source`), as the reader left it, or one the reader is adding. */
export interface Draft {
  key: number
  source?: EditableLine
  value: string
  removed: boolean
}

export function toDrafts(lines: EditableLine[]): Draft[] {
  return lines.map((source, key) => ({ key, source, value: source.text, removed: false }))
}

/**
 * Turn the edited list into changes.
 *
 * Order matters, because each change is applied against the result of the ones before
 * it: changed and removed lines first, while every address still means what the reader
 * saw, then added lines from the bottom up, so adding lines never renumbers an address
 * that a later change in the same batch still needs.
 */
export function buildChanges(drafts: Draft[]): Change[] {
  const edits: Change[] = []
  const inserts: Change[] = []
  let anchor: { i: number; n: number; old: string | null } = { i: -1, n: 0, old: null }
  let pending: string[] = []

  const flush = () => {
    if (pending.length === 0) return
    inserts.push({ i: anchor.i, ...(anchor.n ? { n: anchor.n } : {}), old: anchor.old, add: pending })
    pending = []
  }

  for (const draft of drafts) {
    const source = draft.source
    if (!source) {
      const text = draft.value.trim()
      if (text) pending.push(text)
      continue
    }
    flush()
    const address = { i: source.i, ...(source.n ? { n: source.n } : {}) }
    const value = draft.value.trimEnd()
    if (source.kind !== 'line' || (!draft.removed && value === source.text)) {
      anchor = { i: source.i, n: source.n, old: source.text }
    } else if (draft.removed || value.trim() === '') {
      // Clearing a line means the same as removing it.
      edits.push({ ...address, old: source.text, del: true })
      anchor = { i: source.i, n: source.n, old: null }
    } else {
      edits.push({ ...address, old: source.text, new: value })
      anchor = { i: source.i, n: source.n, old: value }
    }
  }
  flush()

  inserts.sort((a, b) => b.i - a.i || (b.n ?? 0) - (a.n ?? 0))
  return [...edits, ...inserts]
}

/** The text the editor opens with: the song as the reader sees it, one line per line. */
export function textOf(lines: EditableLine[]): string {
  return lines.map((line) => line.text).join('\n')
}

/** Two lines this alike are one line corrected; less alike, one removed and one added. */
const ALIKE = 0.4

function bigrams(text: string): Map<string, number> {
  const out = new Map<string, number>()
  const s = text.trim()
  for (let k = 0; k < s.length - 1; k++) {
    const pair = s.slice(k, k + 2)
    out.set(pair, (out.get(pair) ?? 0) + 1)
  }
  return out
}

/** Dice coefficient over character pairs: 1 for the same text, 0 for nothing shared. */
function likeness(a: Map<string, number>, b: Map<string, number>, sizeA: number, sizeB: number): number {
  if (sizeA === 0 || sizeB === 0) return 0
  let shared = 0
  for (const [pair, count] of a) shared += Math.min(count, b.get(pair) ?? 0)
  return (2 * shared) / (sizeA + sizeB)
}

type Step = { from: number; to: number } | { from: number } | { to: number }

/**
 * Line up the lines of one changed stretch: which old line became which typed line.
 * Order is kept on both sides, and the pairing with the most likeness in total wins.
 */
function align(olds: string[], typed: string[], lone: boolean): Step[] {
  const a = olds.map(bigrams)
  const b = typed.map(bigrams)
  const sizeA = olds.map((t) => Math.max(0, t.trim().length - 1))
  const sizeB = typed.map((t) => Math.max(0, t.trim().length - 1))
  const alike = (x: number, y: number) => {
    // A lone line replaced by a lone line is a correction however much of it changed.
    if (lone) return 1
    const score = likeness(a[x]!, b[y]!, sizeA[x]!, sizeB[y]!)
    return score >= ALIKE ? score : 0
  }

  const rows = olds.length + 1
  const cols = typed.length + 1
  const best = new Float64Array(rows * cols)
  for (let x = olds.length - 1; x >= 0; x--) {
    for (let y = typed.length - 1; y >= 0; y--) {
      const pair = alike(x, y)
      best[x * cols + y] = Math.max(
        best[(x + 1) * cols + y]!,
        best[x * cols + y + 1]!,
        pair > 0 ? pair + best[(x + 1) * cols + y + 1]! : 0,
      )
    }
  }

  const steps: Step[] = []
  let x = 0
  let y = 0
  while (x < olds.length || y < typed.length) {
    const here = x < olds.length && y < typed.length ? best[x * cols + y]! : -1
    const pair = here >= 0 ? alike(x, y) : 0
    if (pair > 0 && here === pair + best[(x + 1) * cols + y + 1]!) {
      steps.push({ from: x++, to: y++ })
    } else if (y < typed.length && (x === olds.length || here === best[x * cols + y + 1]!)) {
      steps.push({ to: y++ })
    } else {
      steps.push({ from: x++ })
    }
  }
  return steps
}

/**
 * One `Draft` per line, from the text a reader typed over `lines`.
 *
 * Unchanged lines are found first (longest common subsequence), then each changed
 * stretch between them is lined up by likeness, so fixing a word reads as one changed
 * line and not as a line removed and another added.
 *
 * Headings and blank lines cannot be corrected: they stay as they are whatever was
 * typed over them, and `ignored` says that happened. Blank lines typed in are dropped.
 */
export function draftsFromText(lines: EditableLine[], text: string): { drafts: Draft[]; ignored: boolean } {
  const typed = text.split(/\r?\n/).map((line) => line.trimEnd())
  const olds = lines.map((line) => line.text.trimEnd())

  // Longest common subsequence, by suffix, so the walk below runs front to back.
  const cols = typed.length + 1
  const lcs = new Uint16Array((olds.length + 1) * cols)
  for (let x = olds.length - 1; x >= 0; x--) {
    for (let y = typed.length - 1; y >= 0; y--) {
      lcs[x * cols + y] =
        olds[x] === typed[y]
          ? lcs[(x + 1) * cols + y + 1]! + 1
          : Math.max(lcs[(x + 1) * cols + y]!, lcs[x * cols + y + 1]!)
    }
  }

  const drafts: Draft[] = []
  let ignored = false
  let key = 0
  const keep = (source: EditableLine) => drafts.push({ key: key++, source, value: source.text, removed: false })

  /** A stretch with no line in common: old lines [x0, x1) against typed lines [y0, y1). */
  const stretch = (x0: number, x1: number, y0: number, y1: number) => {
    const fresh: string[] = []
    for (let y = y0; y < y1; y++) if (typed[y]!.trim()) fresh.push(typed[y]!)
    // Blank lines take no part: they are neither corrected nor matched against.
    const candidates: number[] = []
    for (let x = x0; x < x1; x++) if (lines[x]!.kind !== 'blank') candidates.push(x)

    const lone =
      candidates.length === 1 && fresh.length === 1 && lines[candidates[0]!]!.kind === 'line'
    const steps = align(candidates.map((x) => olds[x]!), fresh, lone)
    let next = x0
    const upTo = (x: number) => {
      // Blank lines of this stretch, deleted by the reader: kept, in their place.
      for (; next < x; next++) {
        ignored = true
        keep(lines[next]!)
      }
    }
    for (const step of steps) {
      if (!('from' in step)) {
        drafts.push({ key: key++, value: fresh[step.to]!, removed: false })
        continue
      }
      const x = candidates[step.from]!
      const source = lines[x]!
      upTo(x)
      next = x + 1
      if (source.kind === 'heading') {
        ignored = true
        keep(source)
        // Typed over a heading: the heading stays, and the typed line is not added either.
      } else if ('to' in step) {
        drafts.push({ key: key++, source, value: fresh[step.to]!, removed: false })
      } else {
        drafts.push({ key: key++, source, value: source.text, removed: true })
      }
    }
    upTo(x1)
  }

  let x = 0
  let y = 0
  let x0 = 0
  let y0 = 0
  while (x < olds.length && y < typed.length) {
    if (olds[x] === typed[y]) {
      if (x > x0 || y > y0) stretch(x0, x, y0, y)
      keep(lines[x]!)
      x0 = ++x
      y0 = ++y
    } else if (lcs[(x + 1) * cols + y]! >= lcs[x * cols + y + 1]!) {
      x++
    } else {
      y++
    }
  }
  if (x0 < olds.length || y0 < typed.length) stretch(x0, olds.length, y0, typed.length)

  return { drafts, ignored }
}
