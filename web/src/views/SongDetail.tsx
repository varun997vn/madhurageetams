import { useEffect, useState } from 'react'
import { ScriptPicker } from '../components/ScriptPicker'
import { downloadPdf, downloadText, safeFilename, songToText } from '../lib/export'
import {
  effectiveScript,
  langTag,
  nativeRows,
  offersScripts,
  pairedRows,
  type DisplayRow,
} from '../lib/scriptRows'
import { getWorker } from '../lib/workerClient'
import { useScript } from '../state/script'
import { useSession } from '../state/session'
import { useSetlist } from '../state/setlist'
import {
  SCRIPT_LABELS,
  type FacetName,
  type NativeDoc,
  type ScriptChoice,
  type SongDetail as Song,
} from '../lib/types'

interface Props {
  songId: number
  onFacet: (facet: FacetName, label: string) => void
  onOccasion: (id: string) => void
  onBack: () => void
}

export function SongDetailView({ songId, onFacet, onOccasion, onBack }: Props) {
  const { meta, stats } = useSession()
  const setlist = useSetlist()
  const script = useScript()
  const hasScripts = offersScripts(stats)
  const [song, setSong] = useState<Song | null>(null)
  const [native, setNative] = useState<NativeDoc | null>(null)
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

  /**
   * Native-script rows, fetched only when they will actually be shown.
   *
   * This is the one call that pulls a native shard, so the guard below is what keeps a
   * Roman-only reader from ever downloading several megabytes they do not want.
   */
  const wantsNative =
    hasScripts && script.choice !== 'roman' && song?.nativeScript === script.choice
  useEffect(() => {
    if (!wantsNative) {
      setNative(null)
      return
    }
    let cancelled = false
    void getWorker()
      .call('getNative', { ids: [songId] })
      .then((rows) => !cancelled && setNative(rows[0] ?? null))
      .catch(() => !cancelled && setNative(null))
    return () => {
      cancelled = true
    }
  }, [songId, wantsNative])

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
            onClick={() =>
              downloadText(
                `${filename}.txt`,
                songToText(song, {
                  choice: script.choice,
                  bilingual: script.bilingual,
                  docs: native ? new Map([[song.id, native]]) : undefined,
                }),
              )
            }
          >
            Download .txt
          </button>
          <button
            className="btn"
            disabled={exporting}
            title={
              native ? 'PDF export is Roman only — use the setlist session sheet for native script' : undefined
            }
            onClick={async () => {
              setExporting(true)
              try {
                await downloadPdf([song], song.title, `${filename}.pdf`)
              } finally {
                setExporting(false)
              }
            }}
          >
            {exporting ? 'Preparing…' : native ? 'Download .pdf (Roman)' : 'Download .pdf'}
          </button>
        </div>

        {hasScripts ? (
          <ScriptPicker
            value={script.choice}
            available={song.nativeScript ? [song.nativeScript] : []}
            bilingual={script.bilingual}
            onChange={script.setChoice}
            onBilingual={script.setBilingual}
          />
        ) : null}

        <LyricsPanel
          song={song}
          native={native}
          choice={hasScripts ? script.choice : 'roman'}
          bilingual={script.bilingual}
          explain={hasScripts}
        />

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

/**
 * Chooses a rendering, and explains itself when it cannot give the reader what they asked
 * for — which is the common case, since a preference is a wish and each song carries only
 * one Indic script.
 */
function LyricsPanel({
  song,
  native,
  choice,
  bilingual,
  explain,
}: {
  song: Song
  native: NativeDoc | null
  choice: ScriptChoice
  bilingual: boolean
  /** False when this build ships no native data. Every note below would then be a claim
   *  about the corpus that is really a fact about the deployment, so none are shown. */
  explain: boolean
}) {
  const effective = effectiveScript(choice, song.nativeScript)

  return (
    <>
      {effective === 'roman' ? (
        <RomanLyrics text={song.lyrics} />
      ) : native ? (
        <div className="lyrics" data-script={effective} lang={langTag(effective, song.language)}>
          <NativeLines
            rows={bilingual ? pairedRows(native) : nativeRows(native)}
            bilingual={bilingual}
          />
        </div>
      ) : (
        <div className="lyrics dim">
          <span className="spinner" aria-hidden="true" /> Loading {SCRIPT_LABELS[effective]}…
        </div>
      )}

      {explain ? <ScriptNote song={song} choice={choice} effective={effective} /> : null}
    </>
  )
}

/**
 * Why the reader is looking at what they are looking at.
 *
 * The Devanagari line is the one worth spelling out: 993 Telugu and 773 Kannada songs are
 * printed in Devanagari in this document, so a reader who sees "Language: Telugu" beside a
 * Devanagari column needs to be told that is the source's doing rather than a mistake.
 */
function ScriptNote({
  song,
  choice,
  effective,
}: {
  song: Song
  choice: ScriptChoice
  effective: ScriptChoice
}) {
  const notes: string[] = []
  const DEVANAGARI_NATIVE = ['Sanskrit', 'Hindi', 'Marathi']

  if (song.nativeScript === null) {
    notes.push('The master copy prints this song in Roman transliteration only.')
  } else if (choice !== 'roman' && effective === 'roman') {
    notes.push(
      `The master copy prints this song in ${SCRIPT_LABELS[song.nativeScript]}, ` +
        `not ${SCRIPT_LABELS[choice]}.`,
    )
  } else if (effective === 'devanagari' && !DEVANAGARI_NATIVE.includes(song.language)) {
    notes.push(`This is a ${song.language} song, printed in Devanagari in the master copy.`)
  }

  return (
    <>
      {notes.map((note) => (
        <p key={note} className="script-note">
          {note}
        </p>
      ))}
      {effective !== 'roman' && !song.scriptVerified ? (
        <p className="script-warn" role="note">
          A few glyph runs in this song could not be machine-verified against the source
          font. The Roman transliteration is the authoritative reading.
        </p>
      ) : null}
    </>
  )
}

/** Native lines, with the Roman column's structural headings carried across. */
function NativeLines({ rows, bilingual }: { rows: DisplayRow[]; bilingual: boolean }) {
  if (rows.length === 0) return <span className="dim">No lyrics recorded for this entry.</span>

  return (
    <div className={bilingual ? 'lyrics-pairs' : undefined}>
      {rows.map((row, index) => {
        if (row.heading) {
          return (
            <div key={index} className="lyric-head">
              {row.native ?? row.roman}
            </div>
          )
        }
        if (!bilingual) return <div key={index}>{row.native ?? ' '}</div>
        return (
          <div key={index} className="pair">
            <div className="pair-native">{row.native ?? ''}</div>
            <div className="pair-roman">{row.roman ?? ''}</div>
          </div>
        )
      })}
    </div>
  )
}

/** Renders stanza numbers in a lighter weight so the verse text carries the page. */
function RomanLyrics({ text }: { text: string }) {
  if (!text.trim()) {
    return <div className="lyrics dim">No lyrics recorded for this entry.</div>
  }
  return (
    <div className="lyrics" data-script="roman">
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
