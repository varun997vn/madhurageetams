import { useEffect, useState } from 'react'
import { ScriptPicker } from '../components/ScriptPicker'
import { Sheet } from '../components/Sheet'
import { downloadPdf, downloadText, safeFilename, setlistToText } from '../lib/export'
import type { ScriptSelection } from '../lib/export'
import { effectiveScript, offersScripts } from '../lib/scriptRows'
import { autoOrder, describeRole } from '../lib/setlist'
import { getWorker } from '../lib/workerClient'
import { useScript } from '../state/script'
import { useSession } from '../state/session'
import { useSetlist } from '../state/setlist'
import { SCRIPT_LABELS, type NativeDoc, type ScriptChoice, type SongDetail } from '../lib/types'

export function SetlistView({
  onOpen,
  onBrowse,
  onPrint,
}: {
  onOpen: (id: number) => void
  onBrowse: () => void
  onPrint: () => void
}) {
  const { meta, stats } = useSession()
  const setlist = useSetlist()
  const script = useScript()
  const hasScripts = offersScripts(stats)
  const [songs, setSongs] = useState<SongDetail[]>([])
  const [docs, setDocs] = useState<Map<number, NativeDoc>>(new Map())
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [dragging, setDragging] = useState<number | null>(null)
  const [pickerFor, setPickerFor] = useState<SongDetail | null>(null)

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

  /**
   * Native rows for whichever songs the current selection will actually render natively.
   *
   * A set of 40 songs could otherwise pull every native shard for a download the reader
   * wanted in Roman, so the filter is what keeps the export cheap.
   */
  useEffect(() => {
    const wanted = !hasScripts
      ? []
      : songs.filter(
          (song) =>
            effectiveScript(script.choice, song.nativeScript, setlist.scripts[song.id] ?? null) !==
            'roman',
        )
    if (wanted.length === 0) {
      setDocs(new Map())
      return
    }
    let cancelled = false
    void getWorker()
      .call('getNative', { ids: wanted.map((s) => s.id) })
      .then((rows) => !cancelled && setDocs(new Map(rows.map((d) => [d.id, d] as const))))
      .catch(() => !cancelled && setDocs(new Map()))
    return () => {
      cancelled = true
    }
  }, [songs, script.choice, setlist.scripts, hasScripts])

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

  const selection: ScriptSelection = {
    choice: script.choice,
    bilingual: script.bilingual,
    overrides: setlist.scripts,
    docs,
  }
  // The union of Indic scripts across the set, in a stable order. A set that mixes Tamil
  // and Sanskrit songs offers both; one that is all Tamil offers only Tamil, so the reader
  // is never given a choice that would silently resolve to Roman.
  const setScripts = (['devanagari', 'tamil'] as const).filter((s) =>
    songs.some((song) => song.nativeScript === s),
  )
  const anyNative = hasScripts && setScripts.length > 0
  const nativeCount = songs.filter(
    (s) => effectiveScript(script.choice, s.nativeScript, setlist.scripts[s.id] ?? null) !== 'roman',
  ).length

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
          onClick={() => downloadText(`${filename}.txt`, setlistToText(songs, title, selection))}
        >
          Download .txt
        </button>
        <button
          className="btn"
          disabled={exporting}
          title={
            nativeCount > 0
              ? 'PDF export is Roman only — use the session sheet for native script'
              : undefined
          }
          onClick={async () => {
            setExporting(true)
            try {
              await downloadPdf(songs, title, `${filename}.pdf`)
            } finally {
              setExporting(false)
            }
          }}
        >
          {exporting ? 'Preparing…' : nativeCount > 0 ? 'Download .pdf (Roman)' : 'Download .pdf'}
        </button>
        <button className="btn" onClick={onPrint}>Session sheet</button>
        <button className="btn btn-ghost" onClick={setlist.clear}>Clear</button>
      </div>

      {anyNative ? (
        <>
          <ScriptPicker
            value={script.choice}
            available={setScripts}
            bilingual={script.bilingual}
            onChange={script.setChoice}
            onBilingual={script.setBilingual}
            label="Read this set in"
          />
          <p className="dim" style={{ fontSize: 12, marginBottom: 12 }}>
            {nativeCount > 0
              ? `${nativeCount} of ${songs.length} songs will print in native script. ` +
                'Tap a song’s script chip to set it individually.'
              : 'Tap a song’s script chip to set it individually.'}{' '}
            The master copy prints each song in one Indic script only, so a song without
            the chosen script stays in Roman.
          </p>
        </>
      ) : null}

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
                  {hasScripts && song.nativeScript ? (
                    <button
                      className="chip"
                      data-pinned={setlist.scripts[song.id] ? 'true' : undefined}
                      onClick={() => setPickerFor(song)}
                      aria-label={`Script for ${song.title}`}
                    >
                      {
                        SCRIPT_LABELS[
                          effectiveScript(
                            script.choice,
                            song.nativeScript,
                            setlist.scripts[song.id] ?? null,
                          )
                        ]
                      }
                      {setlist.scripts[song.id] ? ' ·' : ''}
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="setlist-move">
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

      <Sheet
        open={pickerFor !== null}
        title="Script for this song"
        onClose={() => setPickerFor(null)}
      >
        {pickerFor ? (
          <SongScriptOptions
            song={pickerFor}
            pinned={setlist.scripts[pickerFor.id] ?? null}
            fallback={script.choice}
            onPick={(choice) => {
              setlist.setScript(pickerFor.id, choice)
              setPickerFor(null)
            }}
          />
        ) : null}
      </Sheet>
    </div>
  )
}

/**
 * Per-song script, for sets that mix languages.
 *
 * "Use my default" is stored as the absence of an override rather than as a value, so a
 * song left on the default follows the reader if they later change it.
 */
function SongScriptOptions({
  song,
  pinned,
  fallback,
  onPick,
}: {
  song: SongDetail
  pinned: ScriptChoice | null
  fallback: ScriptChoice
  onPick: (choice: ScriptChoice | null) => void
}) {
  const options: { value: ScriptChoice | null; label: string; hint?: string }[] = [
    {
      value: null,
      label: 'Use my default',
      hint: SCRIPT_LABELS[effectiveScript(fallback, song.nativeScript)],
    },
    { value: 'roman', label: SCRIPT_LABELS.roman },
  ]
  if (song.nativeScript) {
    options.push({ value: song.nativeScript, label: SCRIPT_LABELS[song.nativeScript] })
  }

  return (
    <div className="script-options">
      <p className="dim" style={{ fontSize: 13, margin: '0 0 12px' }}>{song.title}</p>
      {options.map((option) => (
        <button
          key={option.label}
          className="btn"
          aria-pressed={pinned === option.value}
          onClick={() => onPick(option.value)}
        >
          {option.label}
          {option.hint ? <span className="dim"> — {option.hint}</span> : null}
        </button>
      ))}
    </div>
  )
}
