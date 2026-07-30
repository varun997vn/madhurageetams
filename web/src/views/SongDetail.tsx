import { useEffect, useState } from 'react'
import { downloadPdf, downloadText, safeFilename, songToText } from '../lib/export'
import { getWorker } from '../lib/workerClient'
import { useSession } from '../state/session'
import { useSetlist } from '../state/setlist'
import type { FacetName, SongDetail as Song } from '../lib/types'

interface Props {
  songId: number
  onFacet: (facet: FacetName, label: string) => void
  onOccasion: (id: string) => void
  onBack: () => void
}

export function SongDetailView({ songId, onFacet, onOccasion, onBack }: Props) {
  const { meta } = useSession()
  const setlist = useSetlist()
  const [song, setSong] = useState<Song | null>(null)
  const [missing, setMissing] = useState(false)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSong(null)
    setMissing(false)
    void getWorker()
      .call('getSong', { id: songId })
      .then((result) => {
        if (cancelled) return
        if (result) setSong(result)
        else setMissing(true)
      })
      .catch(() => !cancelled && setMissing(true))
    return () => {
      cancelled = true
    }
  }, [songId])

  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [songId])

  if (missing) {
    return (
      <div className="wrap">
        <div className="empty">
          <p>No song with id {songId}.</p>
          <button className="btn" onClick={onBack}>Back to browsing</button>
        </div>
      </div>
    )
  }

  if (!song) {
    return (
      <div className="wrap">
        <div className="empty"><span className="spinner" aria-hidden="true" /> Loading…</div>
      </div>
    )
  }

  const inList = setlist.ids.includes(song.id)
  const filename = safeFilename(song.title)

  return (
    <div className="wrap">
      <div className="song">
        <button className="btn btn-ghost btn-sm" onClick={onBack} style={{ marginBottom: 12 }}>
          ← Back
        </button>

        <header className="song-head">
          <h1>{song.title}</h1>
          <div className="song-chips">
            {song.deity ? (
              <button className="chip" onClick={() => onFacet('deity', song.deity)}>
                {song.deity}
              </button>
            ) : null}
            {song.ragam.map((r) => (
              <button key={r} className="chip" onClick={() => onFacet('ragam', r)}>
                Ragam: {r}
              </button>
            ))}
            {song.thalam.map((t) => (
              <button key={t} className="chip" onClick={() => onFacet('thalam', t)}>
                Thalam: {t}
              </button>
            ))}
            {song.composer ? (
              <button className="chip" onClick={() => onFacet('composer', song.composer)}>
                {song.composer}
              </button>
            ) : null}
            {song.language ? (
              <button className="chip" onClick={() => onFacet('language', song.language)}>
                {song.language}
              </button>
            ) : null}
            {song.albums.map((a) => (
              <button key={a} className="chip chip-muted" onClick={() => onFacet('albums', a)}>
                {a}
              </button>
            ))}
          </div>

          {song.occasions.length > 0 ? (
            <div className="song-chips" style={{ marginTop: 8 }}>
              {song.occasions.map((id) => {
                const occasion = meta?.occasions.find((o) => o.id === id)
                return (
                  <button key={id} className="chip" onClick={() => onOccasion(id)}>
                    <span aria-hidden="true">{occasion?.icon}</span>
                    {occasion?.label ?? id}
                  </button>
                )
              })}
            </div>
          ) : null}
        </header>

        <div className="song-actions">
          <button
            className={`btn ${inList ? 'btn-primary' : ''}`}
            onClick={() => setlist.toggle(song.id)}
          >
            {inList ? '✓ In setlist' : '+ Add to setlist'}
          </button>
          <button
            className="btn"
            onClick={() => downloadText(`${filename}.txt`, songToText(song))}
          >
            Download .txt
          </button>
          <button
            className="btn"
            disabled={exporting}
            onClick={async () => {
              setExporting(true)
              try {
                await downloadPdf([song], song.title, `${filename}.pdf`)
              } finally {
                setExporting(false)
              }
            }}
          >
            {exporting ? 'Preparing…' : 'Download .pdf'}
          </button>
        </div>

        <Lyrics text={song.lyrics} />

        {song.catalog.length > 0 ? (
          <div className="song-chips" style={{ marginTop: 18 }}>
            {song.catalog.slice(0, 14).map((c) => (
              <button key={c} className="chip chip-muted" onClick={() => onFacet('catalog', c)}>
                {c}
              </button>
            ))}
          </div>
        ) : null}

        <p className="song-foot">
          Song #{song.id} · master copy page {song.page}
          {song.role ? ` · session role: ${song.role}` : ''}
        </p>
      </div>
    </div>
  )
}

/** Renders stanza numbers in a lighter weight so the verse text carries the page. */
function Lyrics({ text }: { text: string }) {
  if (!text.trim()) {
    return <div className="lyrics dim">No lyrics recorded for this entry.</div>
  }
  return (
    <div className="lyrics">
      {text.split('\n').map((line, index) => {
        const match = /^(\s*)(\d{1,3}\.)(\s+)(.*)$/.exec(line)
        if (match) {
          return (
            <div key={index}>
              <span className="stanza-no">{match[2]} </span>
              {match[4]}
            </div>
          )
        }
        return <div key={index}>{line || ' '}</div>
      })}
    </div>
  )
}
