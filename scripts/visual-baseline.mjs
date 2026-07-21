// Repeatable visual-regression capture for the redesigned screens, driven against the
// browser-mode mock backend (src/mockApi.ts, loaded automatically because no window.api
// is present) at a fixed viewport and fixed onboarding/navigation sequence.
//
// This is NOT a substitute for the project's real-Electron screenshot harness
// (ME_SHOOT in electron/main.ts, documented in CLAUDE.md) — it exercises the frontend
// against seeded mock data, not real IPC/SQLite/render. Use it when the Electron binary
// isn't available; use ME_SHOOT (in CI or a machine that can run the packaged app) for a
// screenshot that proves the real backend renders the same UI.
//
// Usage:
//   npm run build:renderer                     # produces out/renderer
//   node scripts/visual-baseline.mjs baseline   # first capture -> browser-test-out/visual/baseline
//   ...make changes, npm run build:renderer again...
//   node scripts/visual-baseline.mjs current    # second capture -> browser-test-out/visual/current
//   node scripts/visual-baseline.mjs diff       # pixelmatch baseline vs current, per-screen report
//
// Output intentionally is not committed: browser-test-out/ is gitignored, matching this
// repo's existing convention for ad-hoc browser-mode verification scripts (see
// scripts/browser-verify.mjs, scripts/browser-thumb.mjs). This captures local,
// reproducible runs for a developer/agent to diff — not a versioned baseline image set.

import { chromium } from 'playwright'
import http from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RDIR = join(ROOT, 'out', 'renderer')
const VISUAL_DIR = join(ROOT, 'browser-test-out', 'visual')
const VIEWPORT = { width: 1440, height: 900 }

// The 7 redesigned screens named in the visual-regression check.
const SCREENS = [
  { key: 'home', navText: 'Home' },
  { key: 'compose', navText: 'Compose' },
  { key: 'thumbnails', navText: 'Thumbnails' },
  { key: 'talking-video', navText: 'Talking Video' },
  { key: 'automations', navText: 'Automations' },
  { key: 'render-queue', navText: 'Render Queue' },
  { key: 'settings', navText: 'Settings' }
]

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml' }

function serveRenderer() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0])
    if (p === '/') p = '/index.html'
    const f = join(RDIR, p)
    if (!existsSync(f)) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' })
    res.end(readFileSync(f))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

async function capture(runName) {
  if (!existsSync(RDIR)) throw new Error(`${RDIR} not found — run "npm run build:renderer" first.`)
  const outDir = join(VISUAL_DIR, runName)
  mkdirSync(outDir, { recursive: true })
  const server = await serveRenderer()
  const url = `http://127.0.0.1:${server.address().port}/`
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: VIEWPORT })
  const consoleErrors = []
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message))

  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
  const skip = page.locator('button:has-text("Skip")').first()
  if (await skip.count() > 0) { await skip.click(); await page.waitForTimeout(400) }

  for (const screen of SCREENS) {
    const link = page.getByText(screen.navText, { exact: false }).first()
    if (await link.count() === 0) { console.log(`SKIP ${screen.key}: nav "${screen.navText}" not found`); continue }
    await link.click()
    await page.waitForTimeout(900)
    await page.screenshot({ path: join(outDir, `${screen.key}.png`) })
    console.log(`captured ${screen.key} -> ${join(outDir, `${screen.key}.png`)}`)
  }

  await browser.close()
  server.close()
  console.log('console errors:', consoleErrors.length ? consoleErrors.join(' | ') : '(none)')
}

async function diffRuns() {
  const { default: pixelmatch } = await import('pixelmatch')
  const { PNG } = await import('pngjs')
  const baseDir = join(VISUAL_DIR, 'baseline')
  const curDir = join(VISUAL_DIR, 'current')
  if (!existsSync(baseDir) || !existsSync(curDir)) {
    throw new Error('Run "node scripts/visual-baseline.mjs baseline" and "... current" first.')
  }
  let anyDiff = false
  for (const screen of SCREENS) {
    const baseFile = join(baseDir, `${screen.key}.png`)
    const curFile = join(curDir, `${screen.key}.png`)
    if (!existsSync(baseFile) || !existsSync(curFile)) { console.log(`${screen.key}: SKIP (missing capture)`); continue }
    const img1 = PNG.sync.read(readFileSync(baseFile))
    const img2 = PNG.sync.read(readFileSync(curFile))
    if (img1.width !== img2.width || img1.height !== img2.height) {
      console.log(`${screen.key}: DIFFERENT DIMENSIONS ${img1.width}x${img1.height} vs ${img2.width}x${img2.height} — investigate`)
      anyDiff = true
      continue
    }
    const { width, height } = img1
    const outPng = new PNG({ width, height })
    const mismatched = pixelmatch(img1.data, img2.data, outPng.data, width, height, { threshold: 0.1 })
    const pct = ((mismatched / (width * height)) * 100).toFixed(3)
    console.log(`${screen.key}: ${mismatched} px differ (${pct}%)`)
    if (mismatched > 0) {
      anyDiff = true
      writeFileSync(join(VISUAL_DIR, `${screen.key}.diff.png`), PNG.sync.write(outPng))
    }
  }
  console.log(anyDiff ? 'VISUAL_DIFF_FOUND' : 'VISUAL_NO_DIFF')
}

const mode = process.argv[2]
if (mode === 'diff') {
  await diffRuns()
} else if (mode === 'baseline' || mode === 'current') {
  await capture(mode)
} else {
  console.log('Usage: node scripts/visual-baseline.mjs <baseline|current|diff>')
  process.exit(1)
}
