import { useEffect, useRef, useState } from 'react'
import suggestConfig from '../data/suggest.json'
import type { Correction } from '../lib/corrections'
import { langTag } from '../lib/scriptRows'
import { getWorker } from '../lib/workerClient'
import { SCRIPT_LABELS, type EditableLine, type ScriptChoice, type SongDetail } from '../lib/types'

/**
 * Where suggestions are sent: the Apps Script web app in `suggestions/`.
 *
 * Empty means this deployment has no review queue behind it, and the entry point is
 * then not rendered at all — the same rule the script picker follows, so a build
 * without the feature looks like one rather than offering a form that goes nowhere.
 */
export const SUGGEST_URL: string =
  (import.meta.env.VITE_SUGGEST_URL as string | undefined) || suggestConfig.url || ''

export const suggestionsEnabled = SUGGEST_URL !== ''

/** Mirror the limits enforced by suggestions/Code.gs, so a reader hears about them here. */
const MAX_CHANGES = 40
const MAX_LINE = 300
const MAX_ADDED = 20

/**
 * Dialling codes offered first. Chosen for where this sampradaya's readers are; anyone
 * else picks "Other" and types theirs, so the list never has to be complete.
 */
const COUNTRY_CODES: [code: string, label: string][] = [
  ['+91', 'India'],
  ['+1', 'USA / Canada'],
  ['+44', 'United Kingdom'],
  ['+65', 'Singapore'],
  ['+60', 'Malaysia'],
  ['+971', 'UAE'],
  ['+61', 'Australia'],
  ['+64', 'New Zealand'],
  ['+94', 'Sri Lanka'],
  ['+49', 'Germany'],
  ['+33', 'France'],
  ['+31', 'Netherlands'],
  ['+41', 'Switzerland'],
  ['+974', 'Qatar'],
  ['+968', 'Oman'],
  ['+973', 'Bahrain'],
  ['+965', 'Kuwait'],
  ['+966', 'Saudi Arabia'],
  ['+27', 'South Africa'],
  ['+81', 'Japan'],
]

/** Same rules as suggestions/Code.gs, which is the one that actually enforces them. */
export function contactProblem(name: string, code: string, phone: string): string {
  if (name.trim().length < 2) return 'Please enter your name.'
  if (!/^\+[1-9]\d{0,3}$/.test(code.trim())) return 'Please choose your country code.'
  if (!/^\d{6,14}$/.test(phone.replace(/[\s().-]/g, ''))) return 'Please enter a valid phone number.'
  return ''
}

/** One change as sent for review: a Correction without the script and date. */
export type Change = Omit<Correction, 's' | 'at'>

/** A row of the editor: a line that exists (`source`), or one the reader is adding. */
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

type Status = 'editing' | 'sending' | 'sent' | 'error'

export function SuggestEdit({
  song,
  script,
  onClose,
}: {
  song: SongDetail
  script: ScriptChoice
  onClose: () => void
}) {
  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [name, setName] = useState('')
  const [codeChoice, setCodeChoice] = useState('')
  const [otherCode, setOtherCode] = useState('+')
  const [phone, setPhone] = useState('')
  const [note, setNote] = useState('')
  const [website, setWebsite] = useState('')
  const [status, setStatus] = useState<Status>('editing')
  const [error, setError] = useState('')
  const nextKey = useRef(1_000_000)
  const focusKey = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    void getWorker()
      .call('getEditable', { id: song.id, script })
      .then((lines) => {
        if (cancelled) return
        if (lines) setDrafts(toDrafts(lines))
        else setUnavailable(true)
      })
      .catch(() => !cancelled && setUnavailable(true))
    return () => {
      cancelled = true
    }
  }, [song.id, script])

  if (unavailable) {
    return (
      <div className="suggest">
        <p className="suggest-intro">
          The {SCRIPT_LABELS[script]} lyrics could not be loaded for editing. Please try again.
        </p>
        <button className="btn" onClick={onClose}>Back to the lyrics</button>
      </div>
    )
  }

  if (!drafts) {
    return (
      <div className="suggest">
        <span className="spinner" aria-hidden="true" /> Loading {SCRIPT_LABELS[script]}…
      </div>
    )
  }

  if (status === 'sent') {
    return (
      <div className="suggest" role="status">
        <p className="suggest-done">
          Thank you. Your correction was sent for review and will appear here once it is
          accepted.
        </p>
        <button className="btn" onClick={onClose}>Back to the lyrics</button>
      </div>
    )
  }

  const changes = buildChanges(drafts)
  const longest = Math.max(0, ...drafts.map((d) => d.value.trim().length))
  const problem =
    changes.length > MAX_CHANGES
      ? `Please send at most ${MAX_CHANGES} changes at a time.`
      : longest > MAX_LINE
        ? `A line is longer than ${MAX_LINE} characters.`
        : changes.some((c) => (c.add?.length ?? 0) > MAX_ADDED)
          ? `Please add at most ${MAX_ADDED} lines in one place.`
          : ''

  const countryCode = codeChoice === 'other' ? otherCode.trim() : codeChoice
  // Shown only once there is something to send, so the form does not open on an error.
  const contact = changes.length > 0 ? contactProblem(name, countryCode, phone) : ''

  const update = (key: number, patch: Partial<Draft>) =>
    setDrafts(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)))

  /** Put an empty new line directly after the given row, or first when `after` is null. */
  const addAfter = (after: number | null) => {
    const key = nextKey.current++
    focusKey.current = key
    const fresh: Draft = { key, value: '', removed: false }
    if (after === null) return setDrafts([fresh, ...drafts])
    const at = drafts.findIndex((d) => d.key === after)
    setDrafts([...drafts.slice(0, at + 1), fresh, ...drafts.slice(at + 1)])
  }

  const submit = async () => {
    setStatus('sending')
    setError('')
    try {
      const { token } = await getWorker().call('suggestToken', {})
      // A string body with no headers keeps this a CORS "simple request". Apps Script
      // web apps cannot answer a preflight, so a JSON content type would never arrive.
      const response = await fetch(SUGGEST_URL, {
        method: 'POST',
        body: JSON.stringify({
          songId: song.id,
          title: song.title,
          script,
          changes,
          name: name.trim(),
          countryCode,
          phone: phone.trim(),
          note: note.trim(),
          website,
          token,
        }),
      })
      const reply = (await response.json()) as { ok: boolean; error?: string }
      if (!reply.ok) throw new Error(reply.error || 'The suggestion was not accepted.')
      setStatus('sent')
    } catch (cause) {
      setStatus('error')
      setError(
        (cause as Error).message && !(cause instanceof TypeError || cause instanceof SyntaxError)
          ? (cause as Error).message
          : 'Could not send. Check your connection and try again — your edits are still here.',
      )
    }
  }

  const busy = status === 'sending'

  return (
    <div className="suggest">
      <p className="suggest-intro">
        Edit, add or remove lines in <strong>{SCRIPT_LABELS[script]}</strong>, then send.
        Only your changes are sent, and nothing changes on the site until they are
        reviewed. To correct another script, pick it in the Language menu first.
      </p>

      <div className="suggest-lines" data-script={script} lang={langTag(script, song.language)}>
        <button className="suggest-add" disabled={busy} onClick={() => addAfter(null)}>
          + Add a line at the top
        </button>

        {drafts.map((draft) => {
          const source = draft.source
          if (source?.kind === 'heading') {
            return <div key={draft.key} className="lyric-head">{source.text}</div>
          }
          if (source?.kind === 'blank') {
            return <div key={draft.key} className="suggest-gap" aria-hidden="true" />
          }
          const changed = !source || draft.removed || draft.value.trimEnd() !== source.text
          const state = !source ? 'is-new' : draft.removed ? 'is-removed' : changed ? 'is-changed' : ''
          return (
            <div key={draft.key} className={`suggest-line ${state}`}>
              <input
                type="text"
                value={draft.value}
                disabled={draft.removed || busy}
                placeholder={source ? undefined : 'New line'}
                aria-label={source ? 'Lyric line' : 'New lyric line'}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                ref={(element) => {
                  if (element && focusKey.current === draft.key) {
                    focusKey.current = null
                    element.focus()
                  }
                }}
                onChange={(event) => update(draft.key, { value: event.target.value })}
              />
              {source && changed ? (
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  title="Put this line back as it was"
                  onClick={() => update(draft.key, { value: source.text, removed: false })}
                >
                  Undo
                </button>
              ) : null}
              {!draft.removed ? (
                <>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    title="Add a line below this one"
                    aria-label="Add a line below this one"
                    onClick={() => addAfter(draft.key)}
                  >
                    +
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    title={source ? 'Remove this line' : 'Discard this new line'}
                    aria-label={source ? 'Remove this line' : 'Discard this new line'}
                    onClick={() =>
                      source
                        ? update(draft.key, { removed: true })
                        : setDrafts(drafts.filter((d) => d.key !== draft.key))
                    }
                  >
                    ✕
                  </button>
                </>
              ) : null}
            </div>
          )
        })}
      </div>

      <div className="suggest-meta">
        <label>
          <span>Your name</span>
          <input
            type="text"
            value={name}
            maxLength={80}
            required
            autoComplete="name"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <div className="suggest-phone">
          <label>
            <span>Country code</span>
            <select value={codeChoice} required onChange={(e) => setCodeChoice(e.target.value)}>
              <option value="">Select…</option>
              {COUNTRY_CODES.map(([code, label]) => (
                <option key={code} value={code}>{`${label} (${code})`}</option>
              ))}
              <option value="other">Other…</option>
            </select>
          </label>
          {codeChoice === 'other' ? (
            <label className="suggest-code">
              <span>Code</span>
              <input
                type="tel"
                value={otherCode}
                maxLength={5}
                required
                placeholder="+00"
                onChange={(e) => setOtherCode(e.target.value)}
              />
            </label>
          ) : null}
          <label className="suggest-number">
            <span>Phone number</span>
            <input
              type="tel"
              value={phone}
              maxLength={20}
              required
              inputMode="tel"
              autoComplete="tel-national"
              onChange={(e) => setPhone(e.target.value)}
            />
          </label>
        </div>
        <p className="script-note">
          Your name and number go only to the reviewer, in case there is a question about
          your correction. They are never shown on the site.
        </p>
        <label>
          <span>Note for the reviewer (optional)</span>
          <textarea value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} />
        </label>
        {/* Honeypot: invisible to people, irresistible to form-filling bots. */}
        <input
          className="suggest-hp"
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>

      {problem || contact || error ? (
        <p className="script-warn" role="alert">{problem || contact || error}</p>
      ) : null}

      <div className="suggest-actions">
        <button
          className="btn btn-primary"
          disabled={changes.length === 0 || problem !== '' || contact !== '' || busy}
          onClick={submit}
        >
          {busy
            ? 'Sending…'
            : changes.length === 0
              ? 'Send for review'
              : `Send ${changes.length} ${changes.length === 1 ? 'change' : 'changes'} for review`}
        </button>
        <button className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  )
}
