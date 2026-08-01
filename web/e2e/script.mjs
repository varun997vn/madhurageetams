/**
 * Native-script end-to-end suite.
 *
 *   MG_PASSWORD='...' node e2e/script.mjs [baseURL]
 *
 * Two of these checks are the whole point of the suite and are invisible in a screenshot:
 *
 * 1. **Laziness.** The native shards are ~7 MB. If they ever leak into the speculative
 *    prefetch, every reader pays for them whether or not they read an Indic script. The
 *    only way to prove they don't is to watch the network from unlock to first render.
 * 2. **Shaping.** Devanagari and Tamil are complex scripts. Counting codepoints proves the
 *    right bytes arrived; asserting the font stack resolved proves the browser is actually
 *    shaping them rather than drawing tofu.
 */

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://localhost:4173/madhurageetams/'
const PASSWORD = process.env.MG_PASSWORD
if (!PASSWORD) {
  console.error('set MG_PASSWORD')
  process.exit(2)
}

const SHOTS = 'shots/script'
mkdirSync(SHOTS, { recursive: true })

// Songs chosen because each one pins a different branch. 7344 is Kannada-language but
// printed in Devanagari — the case a reader is most likely to misread as a bug. 4816 is one
// of the two Tamil-only ritual entries, which have no Roman column and no alignment at all.
// 2427 is one of the six English songs, which carry no Indic column.
const DEVANAGARI_SONG = 7344
const TAMIL_SONG = 4816
const ROMAN_ONLY_SONG = 2427

const DEVANAGARI = /[ऀ-ॿ]/g
const TAMIL = /[஀-௿]/g

let failures = 0
const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function unlock(page) {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.fill('input[type="password"]', PASSWORD)
  await page.click('button[type="submit"]')
  await page.waitForSelector('.topbar', { timeout: 90_000 })
}

const waitForScript = (page, script) =>
  page.waitForFunction(
    (want) => document.querySelector('.lyrics')?.getAttribute('data-script') === want,
    script,
    { timeout: 30_000 },
  )

// The three script choices live in the segmented control; the bilingual toggle is its own
// button beside it. Matching them separately keeps "Roman" from also matching "+ Roman".
const scriptButton = (page, label) =>
  page.locator('.script-toggle .scope-toggle button', { hasText: label })

const bilingualButton = (page) => page.locator('.script-toggle > button')

// A CI image or sandbox often ships a Chromium that is not the build this Playwright
// version pins. Point MG_CHROMIUM at it rather than re-downloading ~150 MB.
const browser = await chromium.launch(
  process.env.MG_CHROMIUM ? { executablePath: process.env.MG_CHROMIUM } : {},
)

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()

  const requested = []
  page.on('request', (r) => requested.push(r.url()))
  const consoleErrors = []
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))

  // Whether this build ships native data at all. Everything below branches on it, so the
  // suite is meaningful against a Roman-only deployment too — and the invariant that the
  // picker appears if and only if the data is there gets checked in both directions.
  // Not just `ok()`: a static host with an SPA fallback answers 200 with index.html for a
  // missing file, so the body has to be inspected before it can be believed.
  let nativeIndex = null
  try {
    const indexResponse = await page.request.get(new URL('data/native-index.json', BASE).href)
    if (indexResponse.ok()) {
      const doc = JSON.parse(await indexResponse.text())
      if (Array.isArray(doc?.ids) && Array.isArray(doc?.shards)) nativeIndex = doc
    }
  } catch {
    nativeIndex = null
  }
  const hasNative = nativeIndex !== null
  console.log(
    hasNative
      ? `native data present: ${nativeIndex.count} songs, ${nativeIndex.shards.length} shards`
      : 'native data absent — checking the degraded path only',
  )

  await unlock(page)
  check('unlocks with the corpus password', true)

  await page.waitForTimeout(1500)
  const nativeShardRequests = () => requested.filter((u) => /native-\d\d\.json\.gz/.test(u))
  check(
    'native index is fetched eagerly' + (hasNative ? '' : ' (n/a)'),
    hasNative ? requested.some((u) => u.includes('native-index.json')) : true,
  )
  check(
    'no native shard before a script is chosen',
    nativeShardRequests().length === 0,
    nativeShardRequests().join(', '),
  )

  if (!hasNative) {
    // The regression this suite exists for: a build without native data must not render a
    // picker whose disabled buttons imply the corpus lacks those scripts.
    await page.goto(`${BASE}#/song/${DEVANAGARI_SONG}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.lyrics')
    check('no script picker is rendered', (await page.locator('.script-toggle').count()) === 0)
    check('no script notes are rendered', (await page.locator('.script-note').count()) === 0)
    check('lyrics still render in Roman',
      (await page.getAttribute('.lyrics', 'data-script')) === 'roman')
    check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))
    await browser.close()
    console.log(`\n${results.length - failures}/${results.length} checks passed (Roman-only build)`)
    process.exit(failures ? 1 : 0)
  }

  check('the picker is offered when native data is present', true)

  // --- Devanagari -----------------------------------------------------------------
  await page.goto(`${BASE}#/song/${DEVANAGARI_SONG}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.lyrics')
  check('Roman is the default', (await page.getAttribute('.lyrics', 'data-script')) === 'roman')
  check('Devanagari is offered', await scriptButton(page, 'Devanagari').isEnabled())
  check('Tamil is disabled here', !(await scriptButton(page, 'Tamil').isEnabled()))

  await scriptButton(page, 'Devanagari').click()
  await waitForScript(page, 'devanagari')
  check('a native shard is fetched on demand', nativeShardRequests().length > 0)

  const deva = await page.evaluate((pattern) => {
    const el = document.querySelector('.lyrics')
    return {
      glyphs: (el.textContent.match(new RegExp(pattern, 'g')) || []).length,
      headings: document.querySelectorAll('.lyric-head').length,
      lang: el.getAttribute('lang'),
      font: getComputedStyle(el).fontFamily,
      lineHeight: parseFloat(getComputedStyle(el).lineHeight),
      fontSize: parseFloat(getComputedStyle(el).fontSize),
    }
  }, DEVANAGARI.source)
  check('Devanagari codepoints render', deva.glyphs > 100, `${deva.glyphs} chars`)
  check('section headings carry across from Roman', deva.headings > 0, `${deva.headings}`)
  check('lang carries a Devanagari subtag', /-Deva$/.test(deva.lang), deva.lang)
  check('Devanagari font stack resolved', /Devanagari|Nirmala|Mangal/i.test(deva.font), deva.font)
  check('leading is looser than the Latin column',
    deva.lineHeight / deva.fontSize >= 1.9, `${(deva.lineHeight / deva.fontSize).toFixed(2)}`)
  check('the language/script mismatch is explained',
    (await page.locator('.script-note').count()) > 0)
  await page.screenshot({ path: `${SHOTS}/devanagari-desktop.png` })

  // --- side by side ---------------------------------------------------------------
  await bilingualButton(page).click()
  await page.waitForSelector('.lyrics-pairs')
  const paired = await page.evaluate((pattern) => {
    const el = document.querySelector('.lyrics-pairs')
    return {
      columns: getComputedStyle(el).gridTemplateColumns.split(' ').length,
      native: (el.textContent.match(new RegExp(pattern, 'g')) || []).length,
      latin: (el.textContent.match(/[A-Za-z]/g) || []).length,
    }
  }, DEVANAGARI.source)
  check('two columns at 1280px', paired.columns === 2, `${paired.columns}`)
  check('both scripts present side by side', paired.native > 50 && paired.latin > 50,
    `${paired.native} native / ${paired.latin} latin`)
  await page.screenshot({ path: `${SHOTS}/side-by-side-desktop.png` })

  // --- the preference is the reader's, not the page's ------------------------------
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.lyrics')
  await waitForScript(page, 'devanagari')
  check('script preference survives a reload', true)

  // --- Tamil ------------------------------------------------------------------------
  await page.goto(`${BASE}#/song/${TAMIL_SONG}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.script-toggle')
  check('Tamil is offered on a Tamil song', await scriptButton(page, 'Tamil').isEnabled())
  await scriptButton(page, 'Tamil').click()
  await waitForScript(page, 'tamil')
  const tamil = await page.evaluate((pattern) => {
    const el = document.querySelector('.lyrics')
    return {
      glyphs: (el.textContent.match(new RegExp(pattern, 'g')) || []).length,
      font: getComputedStyle(el).fontFamily,
      lang: el.getAttribute('lang'),
    }
  }, TAMIL.source)
  check('Tamil codepoints render', tamil.glyphs > 50, `${tamil.glyphs} chars`)
  check('Tamil font stack resolved', /Tamil|Nirmala|Latha/i.test(tamil.font), tamil.font)
  check('lang is ta', tamil.lang === 'ta', tamil.lang)
  await page.screenshot({ path: `${SHOTS}/tamil-desktop.png` })

  // --- a song with no Indic column ---------------------------------------------------
  await page.goto(`${BASE}#/song/${ROMAN_ONLY_SONG}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.script-toggle')
  check('both native options disabled on a Roman-only song',
    !(await scriptButton(page, 'Devanagari').isEnabled()) &&
      !(await scriptButton(page, 'Tamil').isEnabled()))
  check('and it says why', (await page.locator('.script-note').count()) > 0)

  // --- the set builder ----------------------------------------------------------------
  for (const id of [DEVANAGARI_SONG, TAMIL_SONG]) {
    await page.goto(`${BASE}#/song/${id}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.song-actions')
    const add = page.locator('.song-actions button', { hasText: 'Add to setlist' })
    if (await add.count()) await add.click()
  }
  await page.goto(`${BASE}#/setlist`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.setlist-item')
  check('both songs are in the set',
    (await page.locator('.setlist-item').count()) === 2)
  check('the set offers a script picker', (await page.locator('.script-toggle').count()) > 0)

  // A set that mixes languages is exactly why per-song overrides exist: the reader default
  // is Tamil here, so the Devanagari song would otherwise fall back to Roman.
  const chips = page.locator('.setlist-item .result-meta button')
  check('each song shows its resolved script', (await chips.count()) === 2)
  await chips.first().click()
  await page.waitForSelector('.script-options')
  const options = await page.locator('.script-options .btn').allTextContents()
  check('the override sheet offers "use my default"',
    options.some((t) => /Use my default/.test(t)), options.join(' / '))
  const devaOption = page.locator('.script-options .btn', { hasText: 'Devanagari' })
  if (await devaOption.count()) {
    await devaOption.click()
    await page.waitForSelector('.script-options', { state: 'detached' })
    check('a per-song override pins that song',
      (await page.locator('.setlist-item .chip[data-pinned="true"]').count()) === 1)
  } else {
    check('a per-song override pins that song', false, 'Devanagari option not offered')
  }

  // The override must outlive a reload — it is stored with the setlist, not the page.
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.setlist-item')
  check('the override survives a reload',
    (await page.locator('.setlist-item .chip[data-pinned="true"]').count()) === 1)

  const download = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.song-actions button', { hasText: 'Download .txt' }).click(),
  ])
  const stream = await download[0].createReadStream()
  let txt = ''
  for await (const chunk of stream) txt += chunk
  check('the .txt export carries native codepoints',
    /[ऀ-ॿ]/.test(txt) || /[஀-௿]/.test(txt),
    `${txt.length} chars`)

  check('the PDF button says it is Roman only',
    (await page.locator('.song-actions button', { hasText: 'Roman' }).count()) > 0)

  // --- the session sheet ----------------------------------------------------------------
  await page.locator('.song-actions button', { hasText: 'Session sheet' }).click()
  await page.waitForSelector('.print-song', { timeout: 30_000 })
  check('the session sheet renders every song',
    (await page.locator('.print-song').count()) === 2)
  const sheetGlyphs = await page.evaluate(() => ({
    deva: (document.body.textContent.match(/[ऀ-ॿ]/g) || []).length,
    tamil: (document.body.textContent.match(/[஀-௿]/g) || []).length,
  }))
  check('the sheet honours per-song scripts',
    sheetGlyphs.deva > 50 && sheetGlyphs.tamil > 50,
    `${sheetGlyphs.deva} deva / ${sheetGlyphs.tamil} tamil`)

  await page.emulateMedia({ media: 'print' })
  const printLayout = await page.evaluate(() => {
    const topbar = document.querySelector('.topbar')
    const controls = document.querySelector('.print-controls')
    const song = document.querySelector('.print-song')
    return {
      topbarHidden: !topbar || getComputedStyle(topbar).display === 'none',
      controlsHidden: !controls || getComputedStyle(controls).display === 'none',
      breaks: getComputedStyle(song).breakAfter,
      ink: getComputedStyle(document.documentElement).getPropertyValue('--ink').trim(),
    }
  })
  check('app chrome is hidden when printing', printLayout.topbarHidden)
  check('print controls are hidden when printing', printLayout.controlsHidden)
  check('each song starts a new page', printLayout.breaks === 'page', printLayout.breaks)
  check('printing forces light ink even in dark mode',
    printLayout.ink === '#000', printLayout.ink)
  await page.screenshot({ path: `${SHOTS}/session-sheet-print.png`, fullPage: false })
  await page.emulateMedia({ media: 'screen' })

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

  // --- phone --------------------------------------------------------------------------
  const phone = await browser.newContext({
    viewport: { width: 375, height: 667 },
    isMobile: true,
    hasTouch: true,
  })
  const small = await phone.newPage()
  await unlock(small)
  await small.goto(`${BASE}#/song/${DEVANAGARI_SONG}`, { waitUntil: 'networkidle' })
  await small.waitForSelector('.script-toggle')
  await scriptButton(small, 'Devanagari').tap()
  await waitForScript(small, 'devanagari')
  await small.screenshot({ path: `${SHOTS}/devanagari-phone.png` })

  await bilingualButton(small).tap()
  await small.waitForSelector('.lyrics-pairs')
  const phoneColumns = await small.evaluate(
    () => getComputedStyle(document.querySelector('.lyrics-pairs')).gridTemplateColumns)
  check('one column at 375px', phoneColumns.split(' ').length === 1, phoneColumns)

  const overflow = await small.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  check('no horizontal overflow on a phone', overflow <= 0, `${overflow}px`)

  const targets = await small.evaluate(() =>
    [...document.querySelectorAll('.script-toggle button')]
      .map((b) => {
        const r = b.getBoundingClientRect()
        return Math.min(r.height, r.width)
      })
      .filter((v) => v > 0))
  check('picker touch targets reach 44px', Math.min(...targets) >= 44,
    `min ${Math.min(...targets).toFixed(1)}px`)

  const inputs = await small.evaluate(() =>
    [...document.querySelectorAll('.script-toggle button')]
      .map((b) => parseFloat(getComputedStyle(b).fontSize)))
  check('picker labels are legible on a phone', Math.min(...inputs) >= 13,
    `min ${Math.min(...inputs)}px`)
  await small.screenshot({ path: `${SHOTS}/side-by-side-phone.png` })
} finally {
  await browser.close()
}

console.log(`\n${results.length - failures}/${results.length} checks passed`)
process.exit(failures ? 1 : 0)
