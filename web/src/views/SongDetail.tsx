import { useEffect, useState } from 'react'
import { ScriptPicker } from '../components/ScriptPicker'
import { SuggestEdit, suggestionsEnabled } from '../components/SuggestEdit'
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
import { useSetlist } from '../state/setlist'
import { useSession } from '../state/session'
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

/**
 * The reading view is deliberately lyrics-only: a title, the language selector, and the
 * lyric body in the selected script. The metadata the corpus carries (composer, deity,
 * ragam, categories, source page) stays in the browse cards and facets — the person who
 * opened a song wants to read or sing it, not re-encounter its card.
 */
export function SongDetailView({ songId, onBack }: Props) {
  const { stats } = useSession()
  const setlist = useSetlist()
  const script = useScript()
  const hasScripts = offersScripts(stats)
  const [song, setSong] = useState<Song | null>(null)
  const [native, setNative] = useState<NativeDoc | null>(null)
  const [missing, setMissing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [suggesting, setSuggesting] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSong(null)
    setMissing(false)
    setSuggesting(false)
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
   * Multiscript rows, fetched only when they will actually be shown.
   *
   * This is the one call that pulls a native shard, so the guard below is what keeps a
   * Roman-only reader from ever downloading several megabytes they do not want.
   */
  const wantsNative = hasScripts && script.choice !== 'roman'
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
          {suggestionsEnabled && !suggesting ? (
            <button className="btn" onClick={() => setSuggesting(true)}>
              Suggest a correction
            </button>
          ) : null}
        </div>

        {hasScripts ? (
          <ScriptPicker
            value={script.choice}
            bilingual={script.bilingual}
            onChange={script.setChoice}
            onBilingual={script.setBilingual}
          />
        ) : null}

        {suggesting ? (
          <SuggestEdit
            // Remounting on a script change drops half-made edits addressed to the
            // other script's lines, which could not be sent meaningfully anyway.
            key={hasScripts ? script.choice : 'roman'}
            song={song}
            script={hasScripts ? script.choice : 'roman'}
            onClose={() => setSuggesting(false)}
          />
        ) : (
          <LyricsPanel
            song={song}
            native={native}
            choice={hasScripts ? script.choice : 'roman'}
            bilingual={script.bilingual}
            explain={hasScripts}
          />
        )}
      </div>
    </div>
  )
}

/** Chooses a rendering, and says which text is the source's own and which is generated. */
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
  /** False when this build ships no multiscript data. Every note below would then be a
   *  claim about the corpus that is really a fact about the deployment, so none show. */
  explain: boolean
}) {
  const effective = effectiveScript(choice)

  return (
    <>
      {effective === 'roman' ? (
        <RomanLyrics text={song.lyrics} />
      ) : native ? (
        <div className="lyrics" data-script={effective} lang={langTag(effective, song.language)}>
          <NativeLines
            rows={bilingual ? pairedRows(native, effective) : nativeRows(native, effective)}
            bilingual={bilingual}
          />
        </div>
      ) : (
        <div className="lyrics dim">
          <span className="spinner" aria-hidden="true" /> Loading {SCRIPT_LABELS[effective]}…
        </div>
      )}

      {explain ? <ScriptNote song={song} native={native} effective={effective} /> : null}
    </>
  )
}

/**
 * Why the reader is looking at what they are looking at.
 *
 * The line that matters: whether this column is the master copy's own printing or a
 * machine transliteration of it. Presenting generated text as the source's would be a
 * false claim about the document, so the provenance is spelled out per script.
 */
function ScriptNote({
  song,
  native,
  effective,
}: {
  song: Song
  native: NativeDoc | null
  effective: ScriptChoice
}) {
  if (effective === 'roman' || !native) return null

  const printedHere =
    native.printed === 'mixed' ||
    (effective === 'devanagari' && native.printed === 'devanagari') ||
    (effective === 'tamil' && native.printed === 'tamil')

  return (
    <>
      {printedHere ? null : (
        <p className="script-note">
          {`Transliterated to ${SCRIPT_LABELS[effective]} from the master copy` +
            (native.printed
              ? ` (printed in ${native.printed === 'mixed' ? 'Tamil and Devanagari' : SCRIPT_LABELS[native.printed as ScriptChoice]}).`
              : ' (printed in Roman only).')}
        </p>
      )}
      {!song.scriptVerified ? (
        <p className="script-warn" role="note">
          A few glyph runs in this song could not be machine-verified against the source
          font. The Roman transliteration is the authoritative reading.
        </p>
      ) : null}
    </>
  )
}

/** Lines in the chosen script, with structural headings styled distinctly. */
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
        return <div key={index}>{line || ' '}</div>
      })}
    </div>
  )
}
