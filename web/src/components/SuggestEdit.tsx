import { useMemo, useState } from 'react'
import suggestConfig from '../data/suggest.json'
import { langTag } from '../lib/scriptRows'
import { getWorker } from '../lib/workerClient'
import {
  ROW_COLUMN,
  SCRIPT_LABELS,
  type NativeDoc,
  type ScriptChoice,
  type SongDetail,
} from '../lib/types'

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

/** Mirrors the limits enforced by suggestions/Code.gs, so a reader hears about them here. */
const MAX_CHANGES = 40
const MAX_LINE = 300

interface Line {
  /** Index the correction is addressed by: row index, or line index for Roman. */
  i: number
  text: string
}

/** The lines a reader may correct, in the script they are currently reading. */
export function editableLines(
  song: SongDetail,
  native: NativeDoc | null,
  script: ScriptChoice,
): Line[] | null {
  if (script === 'roman') {
    return song.lyrics
      .split('\n')
      .map((text, i) => ({ i, text }))
      .filter((line) => line.text.trim() !== '')
  }
  if (!native) return null
  const column = ROW_COLUMN[script]
  const out: Line[] = []
  native.rows.forEach((row, i) => {
    const text = row[column] as string
    // Headings (Pallavi, Charanam…) are generated labels, not lyric text.
    if (row[0] === 0 && text) out.push({ i, text })
  })
  return out
}

type Status = 'editing' | 'sending' | 'sent' | 'error'

export function SuggestEdit({
  song,
  native,
  script,
  onClose,
}: {
  song: SongDetail
  native: NativeDoc | null
  script: ScriptChoice
  onClose: () => void
}) {
  const lines = useMemo(() => editableLines(song, native, script), [song, native, script])
  const [edits, setEdits] = useState<Record<number, string>>({})
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [website, setWebsite] = useState('')
  const [status, setStatus] = useState<Status>('editing')
  const [error, setError] = useState('')

  if (!lines) {
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

  const changes = lines
    .filter((line) => edits[line.i] !== undefined && edits[line.i]!.trimEnd() !== line.text)
    .map((line) => ({ i: line.i, old: line.text, new: edits[line.i]!.trimEnd() }))

  const problem =
    changes.length > MAX_CHANGES
      ? `Please send at most ${MAX_CHANGES} changed lines at a time.`
      : changes.some((c) => c.new.length > MAX_LINE)
        ? `A line is longer than ${MAX_LINE} characters.`
        : ''

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

  return (
    <div className="suggest">
      <p className="suggest-intro">
        Correct any line in <strong>{SCRIPT_LABELS[script]}</strong>, then send. Only the
        lines you change are sent, and nothing changes on the site until it is reviewed.
        To correct another script, pick it in the Language menu first.
      </p>

      <div className="suggest-lines" data-script={script} lang={langTag(script, song.language)}>
        {lines.map((line) => {
          const value = edits[line.i] ?? line.text
          const changed = value.trimEnd() !== line.text
          return (
            <div key={line.i} className={`suggest-line ${changed ? 'is-changed' : ''}`}>
              <input
                type="text"
                value={value}
                aria-label={`Line ${line.i + 1}`}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(event) => setEdits({ ...edits, [line.i]: event.target.value })}
              />
              {changed ? (
                <button
                  className="btn btn-ghost btn-sm"
                  title="Undo this change"
                  onClick={() => {
                    const next = { ...edits }
                    delete next[line.i]
                    setEdits(next)
                  }}
                >
                  Undo
                </button>
              ) : null}
            </div>
          )
        })}
      </div>

      <div className="suggest-meta">
        <label>
          <span>Your name (optional)</span>
          <input type="text" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
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

      {problem || error ? <p className="script-warn" role="alert">{problem || error}</p> : null}

      <div className="suggest-actions">
        <button
          className="btn btn-primary"
          disabled={changes.length === 0 || problem !== '' || status === 'sending'}
          onClick={submit}
        >
          {status === 'sending'
            ? 'Sending…'
            : changes.length === 0
              ? 'Send for review'
              : `Send ${changes.length} ${changes.length === 1 ? 'change' : 'changes'} for review`}
        </button>
        <button className="btn" disabled={status === 'sending'} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  )
}
