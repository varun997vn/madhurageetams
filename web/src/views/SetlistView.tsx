import { useEffect, useState } from 'react'
import { downloadPdf, downloadText, safeFilename, setlistToText } from '../lib/export'
import { autoOrder, describeRole } from '../lib/setlist'
import { getWorker } from '../lib/workerClient'
import { useSession } from '../state/session'
import { useSetlist } from '../state/setlist'
import type { SongDetail } from '../lib/types'

export function SetlistView({ onOpen, onBrowse }: { onOpen: (id: number) => void; onBrowse: () => void }) {
  const { meta } = useSession()
  const setlist = useSetlist()
  const [songs, setSongs] = useState<SongDetail[]>([])
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [dragging, setDragging] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void getWorker()
      .call('getSongs', { ids: setlist.ids })
      .then((result) => {
        if (cancelled) return
        // Preserve the user's ordering; getSongs returns in request order but be explicit.
        const byId = new Map(result.map((s) => [s.id, s] as const))
        setSongs(setlist.ids.map((id) => byId.get(id)).filter((s): s is SongDetail => !!s))
        setLoading(false)
      })
      .catch(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [setlist.ids])

  if (setlist.ids.length === 0) {
    return (
      <div className="wrap">
        <div className="empty">
          <p style={{ fontSize: 15, marginBottom: 6 }}>Your setlist is empty.</p>
          <p style={{ fontSize: 13, marginBottom: 14 }}>
            Add songs from the browse view, then order them for a session and download the
            whole set at once.
          </p>
          <button className="btn btn-primary" onClick={onBrowse}>Browse songs</button>
        </div>
      </div>
    )
  }

  const title = setlist.name || 'Madhurageetam setlist'
  const filename = safeFilename(setlist.name || 'setlist')
  const roles = meta?.roles ?? []

  return (
    <div className="wrap" style={{ maxWidth: 860 }}>
      <div className="section-head" style={{ marginTop: 0 }}>
        <h2>Setlist</h2>
        <p>{setlist.ids.length} songs</p>
      </div>

      <input
        className="field"
        placeholder="Name this setlist (optional)"
        value={setlist.name}
        onChange={(e) => setlist.setName(e.target.value)}
        style={{ marginBottom: 12 }}
      />

      <div className="song-actions" style={{ marginTop: 0 }}>
        <button
          className="btn"
          onClick={() => setlist.replace(autoOrder(songs, roles).map((s) => s.id))}
          title="Order by the traditional bhajan sequence"
        >
          Auto-order for a session
        </button>
        <button
          className="btn"
          onClick={() => downloadText(`${filename}.txt`, setlistToText(songs, title))}
        >
          Download .txt
        </button>
        <button
          className="btn"
          disabled={exporting}
          onClick={async () => {
            setExporting(true)
            try {
              await downloadPdf(songs, title, `${filename}.pdf`)
            } finally {
              setExporting(false)
            }
          }}
        >
          {exporting ? 'Preparing…' : 'Download .pdf'}
        </button>
        <button className="btn btn-ghost" onClick={setlist.clear}>Clear</button>
      </div>

      <p className="dim" style={{ fontSize: 12, marginBottom: 12 }}>
        Auto-order follows the sampradaya sequence recorded in the master copy — Thodaya
        Mangalam first, Mangalam last, and the numbered sections in between.
      </p>

      {loading ? (
        <div className="empty"><span className="spinner" aria-hidden="true" /> Loading songs…</div>
      ) : (
        <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {songs.map((song, index) => (
            <li
              key={song.id}
              className="setlist-item"
              draggable
              data-dragging={dragging === index}
              onDragStart={() => setDragging(index)}
              onDragEnd={() => setDragging(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                if (dragging !== null && dragging !== index) setlist.reorder(dragging, index)
                setDragging(null)
              }}
            >
              <span className="grip" aria-hidden="true">⠿</span>
              <span className="pos tabular">{String(index + 1).padStart(2, '0')}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <button
                  className="result-title"
                  style={{ fontSize: 14.5 }}
                  onClick={() => onOpen(song.id)}
                >
                  {song.title}
                </button>
                <div className="result-meta">
                  {describeRole(song, roles) ? (
                    <span className="setlist-role">{describeRole(song, roles)}</span>
                  ) : null}
                  {song.deity ? <span className="chip chip-muted">{song.deity}</span> : null}
                  {song.ragam[0] ? <span className="chip chip-muted">{song.ragam[0]}</span> : null}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => index > 0 && setlist.reorder(index, index - 1)}
                  disabled={index === 0}
                  aria-label="Move up"
                >
                  ↑
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => index < songs.length - 1 && setlist.reorder(index, index + 1)}
                  disabled={index === songs.length - 1}
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setlist.remove(song.id)}
                  aria-label={`Remove ${song.title}`}
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
