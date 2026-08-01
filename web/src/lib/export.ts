/**
 * Client-side downloads.
 *
 * Both formats are produced in the browser: sending anything to a server would defeat
 * the point of encrypting the corpus in the first place.
 */

import { effectiveScript, nativeRows, pairedRows, rowsToText } from './scriptRows'
import type { NativeDoc, ScriptChoice, SongDetail } from './types'

/**
 * How a set resolves each song's script: the reader's default, unless they pinned this
 * song to something else. Passed in rather than read from the store so the exporters stay
 * pure and testable.
 */
export interface ScriptSelection {
  choice: ScriptChoice
  bilingual: boolean
  overrides?: Record<number, ScriptChoice>
  docs?: Map<number, NativeDoc>
}

/** The lyric body for one song, in whichever script the selection resolves to. */
function lyricsFor(song: SongDetail, selection?: ScriptSelection): string {
  if (!selection) return song.lyrics
  const script = effectiveScript(
    selection.choice,
    song.nativeScript,
    selection.overrides?.[song.id] ?? null,
  )
  if (script === 'roman') return song.lyrics
  const doc = selection.docs?.get(song.id)
  if (!doc || doc.script !== script) return song.lyrics
  return rowsToText(selection.bilingual ? pairedRows(doc) : nativeRows(doc), selection.bilingual)
}

const ATTRIBUTION =
  'From the Madhurageetam master copy (Global Organization For Divinity, 18-Sep-2025).'

function metaLines(song: SongDetail): string[] {
  const lines: string[] = []
  const add = (label: string, value: string | string[]) => {
    const text = Array.isArray(value) ? value.join(', ') : value
    if (text) lines.push(`${label}: ${text}`)
  }
  add('Composer', song.composer)
  add('Deity', song.deity)
  add('Language', song.language)
  add('Ragam', song.ragam)
  add('Thalam', song.thalam)
  add('Category', song.catalog.slice(0, 8))
  add('Song ID', String(song.id))
  add('Source page', String(song.page))
  return lines
}

export function songToText(song: SongDetail, selection?: ScriptSelection): string {
  return [
    song.title,
    '='.repeat(Math.min(song.title.length, 72)),
    '',
    ...metaLines(song),
    '',
    lyricsFor(song, selection),
    '',
    '—',
    ATTRIBUTION,
  ].join('\n')
}

export function setlistToText(
  songs: SongDetail[],
  name: string,
  selection?: ScriptSelection,
): string {
  const parts: string[] = [
    name || 'Setlist',
    '='.repeat(Math.min((name || 'Setlist').length, 72)),
    '',
    `${songs.length} song${songs.length === 1 ? '' : 's'}`,
    '',
    'Contents',
    ...songs.map((s, i) => `  ${String(i + 1).padStart(2, '0')}. ${s.title}`),
    '',
  ]
  for (const [index, song] of songs.entries()) {
    parts.push(
      '',
      '─'.repeat(72),
      `${String(index + 1).padStart(2, '0')}. ${song.title}`,
      '─'.repeat(72),
      ...metaLines(song),
      '',
      lyricsFor(song, selection),
      '',
    )
  }
  parts.push('—', ATTRIBUTION)
  return parts.join('\n')
}

export function downloadText(filename: string, text: string): void {
  triggerDownload(filename, new Blob([text], { type: 'text/plain;charset=utf-8' }))
}

function triggerDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function safeFilename(text: string, fallback = 'madhurageetam'): string {
  const cleaned = text
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
  return cleaned || fallback
}

/**
 * PDF generation, loaded on demand. **Roman only, deliberately.**
 *
 * pdf-lib is ~180 KB, and most visits never export a PDF, so it is imported only when the
 * button is actually pressed.
 *
 * It cannot render the native scripts and should not be made to try. pdf-lib positions
 * every glyph from its advance width alone and discards GPOS mark attachment, so
 * Devanagari vowel signs and anusvara, and Tamil above/below marks, land at the baseline
 * origin instead of on their consonant. The output looks plausible and is wrong — which is
 * exactly the corruption this whole dataset exists to avoid, and it would cost a few
 * hundred KB of embedded font to achieve. Native-script export goes through the print
 * sheet instead, where the browser's own shaper does the work correctly and for free.
 */
export async function songsToPdf(songs: SongDetail[], title: string): Promise<Blob> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const body = await doc.embedFont(StandardFonts.TimesRoman)
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold)
  const italic = await doc.embedFont(StandardFonts.TimesRomanItalic)

  const PAGE = { width: 595.28, height: 841.89 }
  const MARGIN = 56
  const ink = rgb(0.12, 0.11, 0.1)
  const muted = rgb(0.42, 0.4, 0.38)

  let page = doc.addPage([PAGE.width, PAGE.height])
  let y = PAGE.height - MARGIN

  const newPage = () => {
    page = doc.addPage([PAGE.width, PAGE.height])
    y = PAGE.height - MARGIN
  }

  const write = (
    text: string,
    opts: { font?: typeof body; size?: number; color?: typeof ink; indent?: number } = {},
  ) => {
    const font = opts.font ?? body
    const size = opts.size ?? 11
    const indent = opts.indent ?? 0
    const maxWidth = PAGE.width - MARGIN * 2 - indent
    // pdf-lib has no line breaking, so wrap by measured width.
    for (const rawLine of text.split('\n')) {
      const words = rawLine.split(' ')
      let line = ''
      const flush = () => {
        if (y < MARGIN + size) newPage()
        page.drawText(line, {
          x: MARGIN + indent,
          y,
          size,
          font,
          color: opts.color ?? ink,
        })
        y -= size * 1.45
        line = ''
      }
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word
        if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) flush()
        else line = candidate
      }
      flush()
    }
  }

  const gap = (amount = 8) => {
    y -= amount
  }

  if (songs.length > 1) {
    write(title, { font: bold, size: 22 })
    gap(6)
    write(`${songs.length} songs`, { font: italic, size: 11, color: muted })
    gap(16)
    write('Contents', { font: bold, size: 13 })
    gap(4)
    songs.forEach((song, index) => {
      write(`${String(index + 1).padStart(2, '0')}.  ${song.title}`, { size: 10, color: muted })
    })
    newPage()
  }

  songs.forEach((song, index) => {
    if (index > 0) newPage()
    write(song.title, { font: bold, size: 16 })
    gap(4)
    const meta = metaLines(song).join('   ·   ')
    write(meta, { font: italic, size: 9, color: muted })
    gap(14)
    // The corpus is ASCII romanisation, so the standard PDF fonts cover it and no
    // 300 KB Unicode font embed is needed.
    write(song.lyrics.replace(/[^\x00-\xFF]/g, ''), { size: 11 })
    gap(16)
    write(ATTRIBUTION, { font: italic, size: 8, color: muted })
  })

  const bytes = await doc.save()
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' })
}

export async function downloadPdf(songs: SongDetail[], title: string, filename: string) {
  triggerDownload(filename, await songsToPdf(songs, title))
}
