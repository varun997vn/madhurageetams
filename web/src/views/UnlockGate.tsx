import { useState, type FormEvent } from 'react'
import { useSession } from '../state/session'

export function UnlockGate() {
  const { phase, error, progress, unlock } = useSession()
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const busy = phase === 'unlocking'

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!busy && password) void unlock(password, remember)
  }

  const stage =
    progress?.phase === 'deriving'
      ? 'Deriving key…'
      : progress?.phase === 'core'
        ? 'Decrypting index…'
        : 'Unlocking…'

  return (
    <div className="unlock">
      <div className="unlock-card">
        <div className="unlock-mark" aria-hidden="true">🪷</div>
        <h1>Madhurageetam</h1>
        <p className="unlock-sub">
          A searchable index of the Madhurageetam master copy.
        </p>

        <form className="unlock-form" onSubmit={onSubmit}>
          <label className="visually-hidden" htmlFor="password">Password</label>
          <input
            id="password"
            className="field"
            type="password"
            autoComplete="current-password"
            autoFocus
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            aria-describedby="unlock-error"
          />

          <label className="unlock-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              disabled={busy}
            />
            Keep this device unlocked
          </label>

          <button className="btn btn-primary" type="submit" disabled={busy || !password}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            {busy ? stage : 'Unlock'}
          </button>

          {busy && progress ? (
            <div className="progress" role="progressbar" aria-label={stage}>
              <div style={{ width: `${Math.round((progress.loaded / Math.max(progress.total, 1)) * 100)}%` }} />
            </div>
          ) : null}

          <p className="unlock-error" id="unlock-error" role="alert">{error}</p>
        </form>

        <p className="unlock-note">
          The songs are encrypted at rest — the password decrypts them in your browser
          and is never sent anywhere. Deriving the key takes a moment by design.
        </p>
      </div>
    </div>
  )
}

export function UnsupportedBrowser() {
  return (
    <div className="unlock">
      <div className="unlock-card">
        <div className="unlock-mark" aria-hidden="true">🔒</div>
        <h1>Secure context needed</h1>
        <p className="unlock-sub">
          This page decrypts its content with the Web Crypto API, which browsers only
          expose over HTTPS. Open the site over <code>https://</code> in a current
          browser and it will work.
        </p>
      </div>
    </div>
  )
}
