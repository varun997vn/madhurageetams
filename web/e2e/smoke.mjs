/**
 * End-to-end smoke test against a built site.
 *
 *   MG_PASSWORD='...' node e2e/smoke.mjs [baseURL]
 *
 * Covers the paths that only fail in a real browser: PBKDF2 timing, worker startup,
 * WebCrypto decryption, virtualised rendering, and the download handlers.
 */

import { chromium } from 'playwright'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://localhost:4173/madhurageetams/'
const PASSWORD = process.env.MG_PASSWORD
if (!PASSWORD) {
  console.error('set MG_PASSWORD')
  process.exit(2)
}

let failures = 0
const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const browser = await chromium.launch({
  executablePath: existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined,
})
const downloadDir = mkdtempSync(join(tmpdir(), 'mg-dl-'))
const context = await browser.newContext({ acceptDownloads: true })
const page = await context.newPage()

const consoleErrors = []
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
page.on('pageerror', (e) => consoleErrors.push(String(e)))

try {
  // --- wrong password -----------------------------------------------------------
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('#password', { timeout: 30_000 })
  await page.fill('#password', 'definitely-the-wrong-password')
  await page.click('button[type=submit]')
  await page.waitForFunction(
    () => document.querySelector('#unlock-error')?.textContent?.includes('Incorrect'),
    { timeout: 30_000 },
  )
  check('wrong password is rejected', true)
  check(
    'no data decrypted while locked',
    !(await page.evaluate(() => !!document.querySelector('.topbar'))),
  )

  // --- correct password ---------------------------------------------------------
  const t0 = Date.now()
  await page.fill('#password', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForSelector('.topbar', { timeout: 60_000 })
  const unlockMs = Date.now() - t0
  check('correct password unlocks', true, `${unlockMs} ms`)

  await page.waitForSelector('.occasion-card', { timeout: 30_000 })
  const cards = await page.$$eval('.occasion-card', (els) =>
    els.map((e) => ({
      label: e.querySelector('.label')?.textContent ?? '',
      count: e.querySelector('.count')?.textContent ?? '',
    })),
  )
  check('occasion cards render', cards.length >= 30, `${cards.length} cards`)
  check(
    'every occasion card has a non-empty count',
    cards.every((c) => c.count && c.count !== '—'),
    cards.filter((c) => !c.count || c.count === '—').map((c) => c.label).join(', ') || 'all populated',
  )

  const heroStats = await page.textContent('.hero-stats')
  check('corpus stats show 7,898 kirtans', heroStats?.includes('7,898') ?? false, heroStats?.trim())

  // --- occasion drill-in --------------------------------------------------------
  await page.click('.occasion-card:first-of-type')
  await page.waitForSelector('.result-row', { timeout: 30_000 })
  const occasionTotal = await page.textContent('.results-count')
  check('occasion view returns songs', /\d/.test(occasionTotal ?? ''), occasionTotal?.trim())

  // --- metadata search ----------------------------------------------------------
  // Wait for the count to actually *change*, not merely to look like a number: the
  // pre-search total is also a number, so a naive wait reads the stale value.
  const searchFor = async (term) => {
    const before = await page.textContent('.results-count')
    await page.fill('#search', term)
    await page.waitForFunction(
      (prev) => {
        const now = document.querySelector('.results-count')?.textContent ?? ''
        return now !== prev && /[\d,]+ songs?/.test(now)
      },
      before,
      { timeout: 30_000 },
    )
    await page.waitForTimeout(250)
    return Number((await page.textContent('.results-count') ?? '').replace(/[^\d]/g, ''))
  }

  await page.goto(`${BASE}#/browse`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.result-row', { timeout: 30_000 })

  const krishnaN = await searchFor('krishna')
  check(
    'folded search: "krishna" matches "kriShNA"',
    krishnaN > 500 && krishnaN < 7898,
    `${krishnaN} results`,
  )

  const tyagN = await searchFor('tyagaraja')
  check('folded search: "tyagaraja" matches "thyAgarAja"', tyagN > 100 && tyagN < 7898, `${tyagN} results`)

  const vitN = await searchFor('vittala')
  check('folded search: "vittala" matches "viThala"', vitN > 100 && vitN < 7898, `${vitN} results`)

  const nonsenseN = await searchFor('zzzqqqxyzzy')
  check('a nonsense query returns nothing', nonsenseN === 0, `${nonsenseN} results`)

  // --- lyrics scope -------------------------------------------------------------
  await page.fill('#search', 'govinda')
  await page.click('.scope-toggle button:nth-child(2)')
  await page.waitForFunction(
    () => !document.querySelector('.chip-muted')?.textContent?.includes('loading lyrics index'),
    { timeout: 90_000 },
  )
  await page.waitForTimeout(1200)
  const lyricsN = Number((await page.textContent('.results-count') ?? '').replace(/[^\d]/g, ''))
  const hasSnippet = await page.evaluate(() => !!document.querySelector('.result-snippet'))
  check('lyrics-scoped search returns results', lyricsN > 0, `${lyricsN} results`)
  check('lyrics search shows snippets', hasSnippet)

  // --- facet filtering ----------------------------------------------------------
  await page.goto(`${BASE}#/browse`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.facet-option', { timeout: 30_000 })
  const beforeAll = Number((await page.textContent('.results-count') ?? '').replace(/[^\d]/g, ''))
  check('unfiltered browse shows the whole corpus', beforeAll === 7898, `${beforeAll}`)

  // Expand the Ragam group and pick the top value.
  const ragamHeader = page.locator('.facet-head', { hasText: 'Ragam' }).first()
  await ragamHeader.click()
  await page.waitForTimeout(300)
  const ragamGroup = page.locator('.facet-group', { has: page.locator('.facet-head', { hasText: 'Ragam' }) }).first()
  await ragamGroup.locator('.facet-option').first().click()
  await page.waitForTimeout(800)
  const afterRagam = Number((await page.textContent('.results-count') ?? '').replace(/[^\d]/g, ''))
  check('ragam facet narrows results', afterRagam > 0 && afterRagam < beforeAll, `${beforeAll} -> ${afterRagam}`)
  check('active filter chip appears', await page.evaluate(() => !!document.querySelector('.active-filters .chip')))

  const urlHasFilter = page.url().includes('ragam=')
  check('filter state is in the URL (shareable)', urlHasFilter, page.url().split('#')[1] ?? '')

  // --- song detail + downloads --------------------------------------------------
  await page.click('.result-title')
  await page.waitForSelector('.lyrics', { timeout: 30_000 })
  const lyricLen = (await page.textContent('.lyrics'))?.length ?? 0
  check('song detail renders lyrics', lyricLen > 40, `${lyricLen} chars`)
  const songUrl = page.url()
  check('song URL is deep-linkable', /#\/song\/\d+/.test(songUrl), songUrl.split('#')[1] ?? '')

  const [txt] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page.click('button:has-text("Download .txt")'),
  ])
  const txtPath = join(downloadDir, 'song.txt')
  await txt.saveAs(txtPath)
  const txtBody = readFileSync(txtPath, 'utf8')
  check('TXT download has content and metadata', txtBody.length > 100 && txtBody.includes('Song ID:'), `${txtBody.length} bytes`)

  const [pdf] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.click('button:has-text("Download .pdf")'),
  ])
  const pdfPath = join(downloadDir, 'song.pdf')
  await pdf.saveAs(pdfPath)
  const pdfBody = readFileSync(pdfPath)
  check(
    'PDF download is a valid PDF',
    pdfBody.subarray(0, 5).toString() === '%PDF-' && pdfBody.length > 800,
    `${pdfBody.length} bytes`,
  )

  // --- setlist ------------------------------------------------------------------
  await page.goto(`${BASE}#/browse`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.result-row', { timeout: 30_000 })
  for (let i = 0; i < 5; i++) {
    await page.locator('.result-row').nth(i).locator('button:has-text("Set")').click()
  }
  await page.waitForTimeout(400)
  check('setlist tray appears', await page.evaluate(() => !!document.querySelector('.tray')))
  await page.click('.tray button:has-text("Open setlist")')
  await page.waitForSelector('.setlist-item', { timeout: 30_000 })
  const items = await page.$$eval('.setlist-item', (els) => els.length)
  check('setlist holds the added songs', items === 5, `${items} items`)

  await page.click('button:has-text("Auto-order for a session")')
  await page.waitForTimeout(700)
  const ordered = await page.$$eval('.setlist-item', (els) => els.length)
  check('auto-order keeps every song', ordered === 5, `${ordered} items`)

  const [setPdf] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.click('.song-actions button:has-text("Download .pdf")'),
  ])
  const setPath = join(downloadDir, 'setlist.pdf')
  await setPdf.saveAs(setPath)
  const setBody = readFileSync(setPath)
  check('combined setlist PDF generates', setBody.subarray(0, 5).toString() === '%PDF-' && setBody.length > 2000, `${setBody.length} bytes`)

  // --- insights -----------------------------------------------------------------
  await page.goto(`${BASE}#/insights`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.bar-row', { timeout: 30_000 })
  const bars = await page.$$eval('.bar-row', (els) => els.length)
  check('insight charts render', bars > 30, `${bars} bars`)
  await page.locator('.chart-card').first().locator('.bar-row').first().click()
  await page.waitForSelector('.result-row', { timeout: 30_000 })
  check('clicking a bar filters the results', page.url().includes('deity='), page.url().split('#')[1] ?? '')

  // --- session persistence ------------------------------------------------------
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const stillUnlocked = await page.evaluate(() => !!document.querySelector('.topbar'))
  check('reload stays unlocked (cached session key)', stillUnlocked)

  await page.click('button:has-text("Lock")')
  await page.waitForSelector('#password', { timeout: 30_000 })
  check('Lock re-prompts for the password', true)

  const newPage = await (await browser.newContext()).newPage()
  await newPage.goto(BASE, { waitUntil: 'networkidle' })
  await newPage.waitForSelector('#password', { timeout: 30_000 })
  check('a fresh browser context is locked', true)

  const realErrors = consoleErrors.filter(
    (e) => !/favicon|Incorrect password|WrongPasswordError/i.test(e),
  )
  check('no unexpected console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
} catch (error) {
  check('smoke run completed', false, String(error).slice(0, 400))
} finally {
  await browser.close()
}

console.log(`\n${results.length - failures}/${results.length} checks passed`)
process.exit(failures === 0 ? 0 : 1)
