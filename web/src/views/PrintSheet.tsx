import { useEffect, useState } from 'react'
import { effectiveScript, langTag, nativeRows, pairedRows } from '../lib/scriptRows'
import { describeRole } from '../lib/setlist'
import { getWorker } from '../lib/workerClient'
import { useScript } from '../state/script'
import { useSession } from '../state/session'
import { useSetlist } from '../state/setlist'
import { SCRIPT_LABELS, type NativeDoc, type SongDetail } from '../lib/types'

/**
 * The printable session sheet — and the only way to get native script onto paper.
 *
 * pdf-lib cannot shape Devanagari or Tamil (see the note in lib/export.ts), so rather than
 * embedding a font and producing subtly broken output, the running order is rendered as
 * ordinary DOM and handed to the browser's own print pipeline. The platform shaper is
 * correct, "Save as PDF" is one step away, and it costs nothing to ship.
 */
export function PrintSheet({ onBack }: { onBack: () => void }) {
  const { meta, phase } = useSession()
  const setlist = useSetlist()
  const script = useScript()
  const [songs, setSongs] = useState<SongDetail[]>([])
  const [docs, setDocs] = useState<Map<number, NativeDoc>>(new Map())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const worker = getWorker()

    void worker
      .call('getSongs', { ids: setlist.ids })
      .then(async (result) => {
        if (cancelled) return
        const byId = new Map(result.map((s) => [s.id, s] as const))
        const ordered = setlist.ids
          .map((id) => byId.get(id))
          .filter((s): s is SongDetail => !!s)

        // Only songs that will actually render in a native script are worth fetching, so a
        // Roman-only sheet never pulls a native shard.
        const wanted = ordered.filter(
          (song) =>
            effectiveScript(script.choice, song.nativeScript, setlist.scripts[song.id] ?? null) !==
            'roman',
        )
        const fetched = wanted.length
          ? await worker.call('getNative', { ids: wanted.map((s) => s.id) })
          : []
        if (cancelled) return

        setSongs(ordered)
        setDocs(new Map(fetched.map((d) => [d.id, d] as const)))
        setLoading(false)
      })
      .catch(() => !cancelled && setLoading(false))

    return () => {
      cancelled = true
    }
  }, [setlist.ids, setlist.scripts, script.choice])

  // The sheet is rendered from decrypted lyrics, so it must not survive a lock.
  if (phase !== 'ready') return null

  const title = setlist.name || 'Madhurageetam setlist'
  const roles = meta?.roles ?? []

  return (
    <div className="wrap print-sheet">
      <div className="print-controls">
        <button className="btn" onClick={onBack}>← Back to setlist</button>
        <button className="btn btn-primary" disabled={loading} onClick={() => window.print()}>
          Print / Save as PDF
        </button>
        <p className="dim" style={{ fontSize: 12, margin: 0 }}>
          Each song starts on a new page. Choose “Save as PDF” in the print dialog for a
          file you can share.
        </p>
      </div>

      {loading ? (
        <div className="empty">
          <span className="spinner" aria-hidden="true" /> Preparing {setlist.ids.length} songs…
        </div>
      ) : (
        <>
          <header className="print-head">
            <h1>{title}</h1>
            <p>
              {songs.length} song{songs.length === 1 ? '' : 's'}
            </p>
            <ol className="print-contents">
              {songs.map((song) => (
                <li key={song.id}>{song.title}</li>
              ))}
            </ol>
          </header>

          {songs.map((song) => (
            <PrintSong
              key={song.id}
              song={song}
              doc={docs.get(song.id) ?? null}
              role={describeRole(song, roles)}
              choice={effectiveScript(
                script.choice,
                song.nativeScript,
                setlist.scripts[song.id] ?? null,
              )}
              bilingual={script.bilingual}
            />
          ))}

          <p className="print-foot">
            From the Madhurageetam master copy (Global Organization For Divinity,
            18-Sep-2025). Shared with permission of the copyright holder; not for
            redistribution.
          </p>
        </>
      )}
    </div>
  )
}

function PrintSong({
  song,
  doc,
  role,
  choice,
  bilingual,
}: {
  song: SongDetail
  doc: NativeDoc | null
  role: string
  choice: ReturnType<typeof effectiveScript>
  bilingual: boolean
}) {
  const native = choice !== 'roman' && doc ? doc : null
  const rows = native
    ? bilingual
      ? pairedRows(native, choice)
      : nativeRows(native, choice)
    : null

  return (
    <section className="print-song">
      {role ? <p className="print-role">{role}</p> : null}
      <h2>{song.title}</h2>
      <p className="print-meta">
        {[song.composer, song.deity, song.language, song.ragam[0], song.thalam[0]]
          .filter(Boolean)
          .join(' · ')}
        {choice !== 'roman' ? ` · ${SCRIPT_LABELS[choice]}` : ''}
      </p>

      {rows ? (
        <div
          className="lyrics"
          data-script={choice}
          lang={langTag(choice, song.language)}
        >
          <div className={bilingual ? 'lyrics-pairs' : undefined}>
            {rows.map((row, index) =>
              row.heading ? (
                <div key={index} className="lyric-head">{row.native ?? row.roman}</div>
              ) : bilingual ? (
                <div key={index} className="pair">
                  <div className="pair-native">{row.native ?? ''}</div>
                  <div className="pair-roman">{row.roman ?? ''}</div>
                </div>
              ) : (
                <div key={index}>{row.native ?? ' '}</div>
              ),
            )}
          </div>
        </div>
      ) : (
        <div className="lyrics" data-script="roman">{song.lyrics}</div>
      )}
    </section>
  )
}
