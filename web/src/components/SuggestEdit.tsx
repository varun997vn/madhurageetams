import { useEffect, useMemo, useState } from 'react'
import suggestConfig from '../data/suggest.json'
import { langTag } from '../lib/scriptRows'
import { buildChanges, draftsFromText, textOf } from '../lib/suggestDrafts'
import { getWorker } from '../lib/workerClient'
import { SCRIPT_LABELS, type Editable, type ScriptChoice, type SongDetail } from '../lib/types'

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

export { buildChanges, toDrafts, type Change, type Draft } from '../lib/suggestDrafts'

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
  const [editable, setEditable] = useState<Editable | null>(null)
  const [text, setText] = useState('')
  const [unavailable, setUnavailable] = useState(false)
  const [name, setName] = useState('')
  const [codeChoice, setCodeChoice] = useState('')
  const [otherCode, setOtherCode] = useState('+')
  const [phone, setPhone] = useState('')
  const [country, setCountry] = useState('')
  const [note, setNote] = useState('')
  const [website, setWebsite] = useState('')
  const [status, setStatus] = useState<Status>('editing')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void getWorker()
      .call('getEditable', { id: song.id, script })
      .then((loaded) => {
        if (cancelled) return
        if (!loaded) return setUnavailable(true)
        setEditable(loaded)
        setText(textOf(loaded.lines))
      })
      .catch(() => !cancelled && setUnavailable(true))
    return () => {
      cancelled = true
    }
  }, [song.id, script])

  const { drafts, ignored } = useMemo(
    () => draftsFromText(editable?.lines ?? [], text),
    [editable, text],
  )

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

  if (!editable) {
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
          base: editable.base,
          name: name.trim(),
          countryCode,
          phone: phone.trim(),
          country: country.trim(),
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
  const original = textOf(editable.lines)
  /** The lines that differ from what the reader started with, in reading order. */
  const changed = drafts.filter((draft) => {
    const source = draft.source
    if (!source) return draft.value.trim() !== ''
    return source.kind === 'line' && (draft.removed || draft.value.trimEnd() !== source.text)
  })

  return (
    <div className="suggest">
      <p className="suggest-intro">
        Correct the <strong>{SCRIPT_LABELS[script]}</strong> lyrics below as you would in any
        text box: fix words, delete lines, or type new ones. Only your changes are sent, and
        nothing changes on the site until they are reviewed. To correct another script, pick
        it in the Language menu first.
      </p>

      <textarea
        className="suggest-text"
        data-script={script}
        lang={langTag(script, song.language)}
        aria-label={`${SCRIPT_LABELS[script]} lyrics`}
        value={text}
        rows={Math.min(Math.max(editable.lines.length + 2, 8), 60)}
        disabled={busy}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => setText(event.target.value)}
      />

      {ignored ? (
        <p className="script-note">Headings and blank lines stay as they are.</p>
      ) : null}

      {changed.length > 0 ? (
        <div className="suggest-changes">
          <div className="suggest-changes-head">
            <span>Your changes</span>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setText(original)}>
              Reset
            </button>
          </div>
          <ul data-script={script} lang={langTag(script, song.language)}>
            {changed.map((draft) => {
              const source = draft.source
              if (!source) {
                return <li key={draft.key}><b>Added</b> <ins>{draft.value.trim()}</ins></li>
              }
              if (draft.removed || draft.value.trim() === '') {
                return <li key={draft.key}><b>Removed</b> <del>{source.text}</del></li>
              }
              return (
                <li key={draft.key}>
                  <b>Changed</b> <del>{source.text}</del> <ins>{draft.value.trimEnd()}</ins>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}

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
        <label>
          <span>Country of residence (optional)</span>
          <input
            type="text"
            value={country}
            maxLength={60}
            autoComplete="country-name"
            onChange={(e) => setCountry(e.target.value)}
          />
        </label>
        <p className="script-note">
          These details go only to the reviewer, in case there is a question about your
          correction. They are never shown on the site.
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
