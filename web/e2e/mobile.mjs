/**
 * Mobile end-to-end suite.
 *
 *   MG_PASSWORD='...' node e2e/mobile.mjs [baseURL]
 *
 * Runs every check at four viewports with `isMobile` and `hasTouch` set, driving the UI
 * with `tap()` rather than `click()` so touch handlers are genuinely exercised.
 *
 * Four of these checks assert things that are invisible in a screenshot and are exactly
 * what made the site unusable on a phone before: horizontal overflow, sub-16px inputs
 * (which make iOS zoom and never zoom back), touch targets under 44px, and nested scroll
 * containers that trap momentum scrolling.
 */

import { chromium } from 'playwright'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://localhost:4173/madhurageetams/'
const PASSWORD = process.env.MG_PASSWORD
if (!PASSWORD) {
  console.error('set MG_PASSWORD')
  process.exit(2)
}

const SHOTS = 'shots/mobile'
mkdirSync(SHOTS, { recursive: true })

const DEVICES = [
  { name: 'iphone-se', width: 375, height: 667 },
  { name: 'iphone-14-pro', width: 393, height: 852 },
  { name: 'pixel-7', width: 412, height: 915 },
  { name: 'ipad-portrait', width: 820, height: 1180 },
]

const MIN_TARGET = 44
let failures = 0
const results = []

function check(device, name, ok, detail = '') {
  results.push({ device, name, ok, detail })
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

// --- shared page probes ---------------------------------------------------------------

const probeOverflow = () => ({
  scrollW: document.documentElement.scrollWidth,
  innerW: window.innerWidth,
  // Which element is actually sticking out, so a failure is actionable.
  culprits: Array.from(document.querySelectorAll('*'))
    .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
    .slice(0, 5)
    .map((el) => `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`),
})

const probeSmallInputs = () =>
  Array.from(document.querySelectorAll('input, select, textarea'))
    .filter((el) => el.offsetParent !== null)
    .map((el) => ({
      id: el.id || el.className || el.tagName,
      size: parseFloat(getComputedStyle(el).fontSize),
    }))
    .filter((el) => el.size < 16)

const probeSmallTargets = (min) => {
  const seen = {}
  for (const el of document.querySelectorAll('button, a[href], input, select, [role="listitem"]')) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    if (getComputedStyle(el).visibility === 'hidden') continue
    // A chip extends its hit area with an ::after overlay rather than growing visually.
    const overlay = getComputedStyle(el, '::after')
    let height = rect.height
    if (overlay && overlay.content !== 'none' && overlay.position === 'absolute') {
      const top = parseFloat(overlay.top) || 0
      const bottom = parseFloat(overlay.bottom) || 0
      height = rect.height - top - bottom
    }
    if (height < min - 0.5) {
      const key = (el.className || el.tagName).toString().split(' ').slice(0, 2).join('.')
      seen[key] = Math.min(seen[key] ?? 999, Math.round(height))
    }
  }
  return seen
}

const probeScrollContainers = () =>
  Array.from(document.querySelectorAll('*'))
    .filter((el) => {
      const s = getComputedStyle(el)
      const scrolls = s.overflowY === 'auto' || s.overflowY === 'scroll'
      return scrolls && el.scrollHeight > el.clientHeight + 2
    })
    .map((el) => `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`)

// --- run --------------------------------------------------------------------------------

const browser = await chromium.launch({
  executablePath: existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined,
})

for (const device of DEVICES) {
  const compact = device.width < 860
  console.log(`\n=== ${device.name}  ${device.width}x${device.height}${compact ? '  (compact)' : '  (desktop layout)'} ===`)

  const context = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })
  const page = await context.newPage()
  const consoleErrors = []
  page.on('pageerror', (e) => consoleErrors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))

  try {
    // --- unlock -----------------------------------------------------------------------
    await page.goto(BASE, { waitUntil: 'networkidle' })
    await page.waitForSelector('#password', { timeout: 30_000 })

    const gateInputs = await page.evaluate(probeSmallInputs)
    check(device.name, 'unlock gate has no sub-16px input', gateInputs.length === 0, JSON.stringify(gateInputs))

    let ovf = await page.evaluate(probeOverflow)
    check(device.name, 'unlock: no horizontal overflow', ovf.scrollW <= ovf.innerW + 1, `${ovf.scrollW} vs ${ovf.innerW} ${ovf.culprits.join(', ')}`)
    await page.screenshot({ path: join(SHOTS, `${device.name}-1-unlock.png`) })

    await page.fill('#password', PASSWORD)
    await page.tap('button[type=submit]')
    await page.waitForSelector('.topbar', { timeout: 60_000 })
    await page.waitForSelector('.occasion-card', { timeout: 30_000 })
    await page.waitForTimeout(2000)
    await page.screenshot({ path: join(SHOTS, `${device.name}-2-home.png`), fullPage: false })

    // --- navigation chrome -------------------------------------------------------------
    const nav = await page.evaluate(() => {
      const bar = document.querySelector('.tabbar')
      const visible = bar ? getComputedStyle(bar).display !== 'none' : false
      const tabs = bar
        ? Array.from(bar.querySelectorAll('button')).map((b) => ({
            label: b.textContent.trim(),
            h: Math.round(b.getBoundingClientRect().height),
          }))
        : []
      const topnav = document.querySelector('.topnav')
      return {
        tabbarVisible: visible,
        tabs,
        topnavVisible: topnav ? getComputedStyle(topnav).display !== 'none' : false,
      }
    })
    if (compact) {
      check(device.name, 'bottom tab bar is present with 4 tabs', nav.tabbarVisible && nav.tabs.length === 4, JSON.stringify(nav.tabs.map((t) => t.label)))
      check(device.name, 'every tab is >=44px tall', nav.tabs.every((t) => t.h >= MIN_TARGET), JSON.stringify(nav.tabs.map((t) => t.h)))
      check(device.name, 'top-bar nav links are hidden on phones', !nav.topnavVisible)
    } else {
      check(device.name, 'desktop keeps top-bar nav, no tab bar', nav.topnavVisible && !nav.tabbarVisible)
    }

    // --- search usability ---------------------------------------------------------------
    const search = await page.evaluate(() => {
      const el = document.querySelector('#search')
      const r = el.getBoundingClientRect()
      return { w: Math.round(r.width), vw: window.innerWidth, fs: parseFloat(getComputedStyle(el).fontSize) }
    })
    check(
      device.name,
      'search field uses >=55% of viewport width',
      search.w >= search.vw * 0.55,
      `${search.w}px of ${search.vw}px (${Math.round((search.w / search.vw) * 100)}%)`,
    )
    check(device.name, 'search font is >=16px (no iOS zoom)', search.fs >= 16 || !compact, `${search.fs}px`)

    // --- home layout ---------------------------------------------------------------------
    ovf = await page.evaluate(probeOverflow)
    check(device.name, 'home: no horizontal overflow', ovf.scrollW <= ovf.innerW + 1, `${ovf.scrollW} vs ${ovf.innerW} ${ovf.culprits.join(', ')}`)

    // --- browse ---------------------------------------------------------------------------
    await page.goto(`${BASE}#/browse`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.result-row', { timeout: 30_000 })
    await page.waitForTimeout(1200)
    await page.screenshot({ path: join(SHOTS, `${device.name}-3-browse.png`) })

    ovf = await page.evaluate(probeOverflow)
    check(device.name, 'browse: no horizontal overflow', ovf.scrollW <= ovf.innerW + 1, `${ovf.scrollW} vs ${ovf.innerW} ${ovf.culprits.join(', ')}`)

    const inputs = await page.evaluate(probeSmallInputs)
    check(device.name, 'browse: no sub-16px input', inputs.length === 0 || !compact, JSON.stringify(inputs))

    const scrollers = await page.evaluate(probeScrollContainers)
    check(
      device.name,
      'browse: the page is the only scroll container',
      scrollers.length === 0 || !compact,
      scrollers.join(', ') || 'none',
    )

    const targets = await page.evaluate(probeSmallTargets, MIN_TARGET)
    check(
      device.name,
      `browse: all touch targets >=${MIN_TARGET}px`,
      Object.keys(targets).length === 0 || !compact,
      JSON.stringify(targets),
    )

    // Search actually works from the mobile chrome.
    const before = await page.textContent('.results-count')
    await page.fill('#search', 'krishna')
    await page.waitForFunction(
      (prev) => {
        const now = document.querySelector('.results-count')?.textContent ?? ''
        return now !== prev && /[\d,]+ songs?/.test(now)
      },
      before,
      { timeout: 30_000 },
    )
    const searched = Number((await page.textContent('.results-count') ?? '').replace(/[^\d]/g, ''))
    check(device.name, 'search from the mobile bar filters results', searched > 500 && searched < 7898, `${searched} results`)
    await page.fill('#search', '')
    await page.waitForTimeout(700)

    // --- scrolling behaves ------------------------------------------------------------------
    const scrolled = await page.evaluate(async () => {
      window.scrollTo(0, 0)
      const start = window.scrollY
      window.scrollTo(0, 1200)
      await new Promise((r) => setTimeout(r, 300))
      const after = window.scrollY
      const rows = document.querySelectorAll('.result-row').length
      window.scrollTo(0, 0)
      return { start, after, rows, moved: after > start }
    })
    check(device.name, 'the document itself scrolls', scrolled.moved, `scrollY 0 -> ${scrolled.after}`)
    check(device.name, 'rows stay virtualised while scrolling', scrolled.rows > 0 && scrolled.rows < 120, `${scrolled.rows} rows in DOM`)

    // --- filter sheet (compact only) ---------------------------------------------------------
    if (compact) {
      await page.tap('button:has-text("Filters")')
      await page.waitForSelector('.sheet', { timeout: 15_000 })
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(SHOTS, `${device.name}-4-filters.png`) })

      const sheet = await page.evaluate(() => ({
        locked: document.body.dataset.scrollLocked === 'true',
        footer: document.querySelector('.sheet-foot')?.textContent ?? '',
        modal: document.querySelector('.sheet')?.getAttribute('aria-modal'),
      }))
      check(device.name, 'sheet locks body scroll', sheet.locked)
      check(device.name, 'sheet footer shows the live count', /Show [\d,]+ song/.test(sheet.footer), sheet.footer.trim().slice(0, 60))
      check(device.name, 'sheet is a modal dialog', sheet.modal === 'true')

      ovf = await page.evaluate(probeOverflow)
      check(device.name, 'sheet: no horizontal overflow', ovf.scrollW <= ovf.innerW + 1, `${ovf.scrollW} vs ${ovf.innerW}`)

      // Tick the first deity value and confirm the footer count follows.
      const deityGroup = page.locator('.facet-group', { has: page.locator('.facet-head', { hasText: 'Deity' }) }).first()
      await deityGroup.locator('.facet-option').first().tap()
      await page.waitForTimeout(900)
      const footerCount = Number(((await page.textContent('.sheet-foot')) ?? '').replace(/[^\d]/g, ''))
      await page.tap('.sheet-foot .btn-primary')
      await page.waitForTimeout(700)
      const listCount = Number((await page.textContent('.results-count') ?? '').replace(/[^\d]/g, ''))
      check(device.name, 'sheet count matches the applied result count', footerCount === listCount, `${footerCount} vs ${listCount}`)

      const unlocked = await page.evaluate(() => document.body.dataset.scrollLocked !== 'true')
      check(device.name, 'closing the sheet restores body scroll', unlocked)

      // Escape closes it too.
      await page.tap('button:has-text("Filters")')
      await page.waitForSelector('.sheet', { timeout: 10_000 })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(500)
      check(device.name, 'Escape closes the sheet', (await page.locator('.sheet').count()) === 0)
    }

    // --- song detail ---------------------------------------------------------------------------
    await page.goto(`${BASE}#/browse`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.result-title', { timeout: 30_000 })
    await page.locator('.result-title').first().tap()
    await page.waitForSelector('.lyrics', { timeout: 30_000 })
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(SHOTS, `${device.name}-5-song.png`) })
    ovf = await page.evaluate(probeOverflow)
    check(device.name, 'song: no horizontal overflow', ovf.scrollW <= ovf.innerW + 1, `${ovf.scrollW} vs ${ovf.innerW} ${ovf.culprits.join(', ')}`)
    const lyricLen = (await page.textContent('.lyrics'))?.length ?? 0
    check(device.name, 'song: lyrics render', lyricLen > 40, `${lyricLen} chars`)

    // --- insights -------------------------------------------------------------------------------
    await page.goto(`${BASE}#/insights`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.bar-row', { timeout: 30_000 })
    await page.waitForTimeout(1200)
    await page.screenshot({ path: join(SHOTS, `${device.name}-6-insights.png`) })
    ovf = await page.evaluate(probeOverflow)
    check(device.name, 'insights: no horizontal overflow', ovf.scrollW <= ovf.innerW + 1, `${ovf.scrollW} vs ${ovf.innerW} ${ovf.culprits.join(', ')}`)
    // Measure the FILL, not the track. An empty track still has full width, so asserting
    // on the track passed happily while every bar rendered blank.
    const bars = await page.evaluate(() => {
      const track = document.querySelector('.bar-track')
      const fill = document.querySelector('.bar-fill')
      return {
        track: track ? Math.round(track.getBoundingClientRect().width) : 0,
        fill: fill ? Math.round(fill.getBoundingClientRect().width) : 0,
        fillH: fill ? Math.round(fill.getBoundingClientRect().height) : 0,
      }
    })
    check(device.name, 'insights: bars get real width', bars.track >= device.width * 0.4, `${bars.track}px of ${device.width}px`)
    check(
      device.name,
      'insights: the largest bar is actually filled',
      bars.fill >= bars.track * 0.9 && bars.fillH > 4,
      `fill ${bars.fill}x${bars.fillH} in track ${bars.track}`,
    )

    // --- setlist ---------------------------------------------------------------------------------
    await page.goto(`${BASE}#/browse`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.result-row', { timeout: 30_000 })
    for (let i = 0; i < 4; i++) {
      await page.locator('.result-row').nth(i).locator('button:has-text("Set")').tap()
      await page.waitForTimeout(150)
    }
    await page.waitForTimeout(400)

    if (compact) {
      const bottom = await page.evaluate(() => {
        const tray = document.querySelector('.tray')?.getBoundingClientRect()
        const bar = document.querySelector('.tabbar')?.getBoundingClientRect()
        if (!tray || !bar) return null
        return { trayBottom: Math.round(tray.bottom), barTop: Math.round(bar.top), overlap: tray.bottom > bar.top + 1 }
      })
      check(device.name, 'setlist tray does not cover the tab bar', bottom && !bottom.overlap, JSON.stringify(bottom))
    }

    await page.goto(`${BASE}#/setlist`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.setlist-item', { timeout: 30_000 })
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(SHOTS, `${device.name}-7-setlist.png`) })
    ovf = await page.evaluate(probeOverflow)
    check(device.name, 'setlist: no horizontal overflow', ovf.scrollW <= ovf.innerW + 1, `${ovf.scrollW} vs ${ovf.innerW} ${ovf.culprits.join(', ')}`)

    // Reordering by tap. HTML5 drag never fires on touch, so the move buttons are the
    // only working affordance on a phone and must actually work.
    const firstBefore = await page.locator('.setlist-item .result-title').first().textContent()
    await page.locator('.setlist-item').nth(1).locator('button[aria-label="Move up"]').tap()
    await page.waitForTimeout(700)
    const firstAfter = await page.locator('.setlist-item .result-title').first().textContent()
    check(device.name, 'setlist reorders by tap', firstBefore !== firstAfter, `${(firstBefore ?? '').slice(0, 22)} -> ${(firstAfter ?? '').slice(0, 22)}`)

    await page.evaluate(() => localStorage.removeItem('mg.setlist.v1'))

    const realErrors = consoleErrors.filter((e) => !/favicon|Incorrect password|WrongPassword/i.test(e))
    check(device.name, 'no unexpected console errors', realErrors.length === 0, realErrors.slice(0, 2).join(' | '))
  } catch (error) {
    check(device.name, 'run completed', false, String(error).slice(0, 300))
  } finally {
    await context.close()
  }
}

await browser.close()

const total = results.length
console.log(`\n${total - failures}/${total} checks passed across ${DEVICES.length} viewports`)
if (failures) {
  console.log('\nFailures:')
  for (const r of results.filter((r) => !r.ok)) console.log(`  ${r.device}: ${r.name} — ${r.detail}`)
}
process.exit(failures === 0 ? 0 : 1)
