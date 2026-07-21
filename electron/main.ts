import { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { applyLoginItem, trayIconPath } from './services/background'
import * as scheduler from './services/scheduler'
import { initAutoUpdate, checkForUpdates } from './services/updater'
import { initSettings, setSettings, getSettings } from './store/settings'
import { initDatabase, getRepos, closeDatabase, seedDemoForSmoke } from './db'
import { registerIpc } from './ipc/register'
import { refreshChannel, sourceVideos, checkReminders } from './ipc/scrape'
import { startDownloads, resume as resumeDownload } from './ipc/download'
import { createProject, setImages, runTranscribe, sendToRender } from './ipc/compose'
import { firedNotifications } from './services/notify'
import { channelUrl, orderVideos } from './services/scraper'
import { splitRanges } from './services/audio'
import { autoArrangeText } from '../shared/thumbnail'
import { THUMB_W, THUMB_H, DEFAULT_BETA_OPTS, type AutomationJobDraft, type Project, type TextLayer, type ThumbnailTemplate, type TranscriptWord } from '../shared/types'
import { buildAss } from './services/captions'
import { resolveCaptionStyle } from '../shared/captionStyle'
import { isAllowedExternalUrl } from '../shared/url'
import { buildRenderArgs, runRender, dimensions } from './services/render'
import { ffmpegPath, ffprobePath, resolveYtdlpPath } from './services/bin'
import { extractThemes, keywordThemesFromTitles, rankCandidates, planCoverage, buildBrollBed, buildBrollManifest, buildBrollNormalizeArgs, assembleBed, fetchPool, warmBrollLibraryFromTitles, type BrollCandidate } from './services/broll'
import { createProgressSmoother } from './services/engine/progress'
import { probeRenderCapabilities } from './services/engine/caps'
import { validateEffectPlan, deriveStylePlan, styleCaptionLead, textPresetTag, type EffectPlan } from '../shared/effectPlan'
import { buildSfxTrack } from './services/sfx'
import { buildMasterLoudnormFilter, buildSecondPassLoudnormFilter } from './services/engine/audio-master'
import { readFileSync as readFileSyncSfx } from 'node:fs'
import { L, installGlobalLogging, logStartupDiagnostics, logFilePath } from './services/logger'
import { instrumentIpcMain, setSentryEnabled, telemetryForcedOff } from './services/sentry'
import { runAll, lastMaxActive } from './services/queue'
import { destroyGpuWorker } from './services/engine/gpu/host'
import { runProfile, newVideos } from './ipc/automation'
import { cancelAutomationJob, createAutomationJob, getAutomationJob, pauseAutomationJob, preflightAutomation, resumeAutomationJob, startAutomationSupervisor, stopAutomationSupervisor } from './services/automation-supervisor'
import { postWebhook } from './services/webhook'
import { reconcileNonTerminalProviderJobs, startTalkingPhotosPoller, stopTalkingPhotosPoller } from './providers/talkingphotos/poller'
import { reconcileInterruptedConnectionOnStartup } from './providers/talkingphotos/session'
import { assertDisposableSmokeProfile, prepareSmokeUserDataDir } from './services/smokeSafety'
import { createServer } from 'node:http'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Set a stable app name so userData (DB + settings) lands in a dedicated folder
// rather than the generic "Electron" dir shared with other dev apps.
app.setName('Mental Empire Studio')

// Hard safety guard: a headless smoke/screenshot run must NEVER touch the real
// production/dev userData directory (mental-empire.db, settings, logs). Several
// smoke harnesses call repos.resetAll() + seedDemoForSmoke(), which wipes and
// reseeds whatever DB they're pointed at — fine on a disposable CI runner, but
// catastrophic against a real local install. ME_SMOKE_USERDATA_DIR is required
// whenever ME_SMOKE/ME_SHOOT is set, must resolve to somewhere other than the
// real default userData path, and is applied via app.setPath BEFORE anything else
// (initSettings/getRepos/initDatabase) touches userData. This must run first,
// synchronously, with a hard process.exit — not app.exit, which only schedules an
// async quit and would let later userData-touching code run first.
//
// prepareSmokeUserDataDir() additionally writes a `.mental-empire-smoke-profile`
// sentinel into the validated dir — see electron/services/smokeSafety.ts.
// assertDisposableSmokeProfile() (imported below) re-checks that marker immediately
// before every destructive resetAll()/seedDemoForSmoke() call site in the smoke
// harnesses, so the code that actually runs the destructive work is permanently
// required to re-verify disposability, not just something checked once here at
// startup — a future refactor of this block can't silently reopen the hole.
if (process.env['ME_SMOKE'] || process.env['ME_SHOOT']) {
  const resolvedOverride = prepareSmokeUserDataDir(process.env['ME_SMOKE_USERDATA_DIR'], app.getPath('userData'))
  if (!resolvedOverride) process.exit(1) // prepareSmokeUserDataDir's default `fail` already exits; this is belt-and-suspenders.
  app.setPath('userData', resolvedOverride)
}

// Wrap ipcMain.handle app-wide BEFORE any handler registers, so every renderer→main
// call (across every electron/ipc/* module) gets Sentry tracing for free once telemetry
// is on. No-ops entirely when telemetry is off or during headless smokes.
instrumentIpcMain()

// Sentry.init() MUST run before the 'ready' event fires (it hooks the protocol
// registration Electron does at startup) — settings/telemetryEnabled just needs
// electron-store, which only needs app.getPath('userData') and works pre-ready.
setSentryEnabled(!telemetryForcedOff() && initSettings().telemetryEnabled)

// Single-instance: a second launch focuses the existing window instead of starting
// a duplicate (important once the app lives in the tray). Skipped in headless smokes.
if (!process.env['ME_SMOKE'] && !process.env['ME_SHOOT'] && !app.requestSingleInstanceLock()) {
  app.quit()
}
app.on('second-instance', () => showWindow())

// Synchronous version lookup for the preload (window.api.appVersion).
ipcMain.on('app:version', (e) => {
  e.returnValue = app.getVersion()
})

// Open the log file in the OS file manager so the user can send it back when debugging.
ipcMain.handle('app:openLogs', () => {
  const p = logFilePath()
  if (p) shell.showItemInFolder(p)
  return p
})
ipcMain.handle('app:logPath', () => logFilePath())

// Design window size from the prototype: 1352×868 content, frameless studio chrome.
const WIN_WIDTH = 1352
const WIN_HEIGHT = 868

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  else {
    mainWindow.show()
    mainWindow.focus()
  }
}

function buildTray(): void {
  if (tray) return
  const icon = nativeImage.createFromPath(trayIconPath())
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('Mental Empire Studio')
  tray.on('click', () => showWindow())
  refreshTrayMenu()
}

function refreshTrayMenu(): void {
  if (!tray) return
  const running = scheduler.isRunning()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Studio', click: () => showWindow() },
      { type: 'separator' },
      { label: running ? 'Auto-scrape: running' : 'Auto-scrape: paused', enabled: false },
      {
        label: running ? 'Pause auto-scrape' : 'Resume auto-scrape',
        click: () => {
          scheduler.setPaused(running)
          refreshTrayMenu()
        }
      },
      { type: 'separator' },
      { label: 'Check for updates…', click: () => void checkForUpdates() },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
}

function shouldStartHidden(): boolean {
  try {
    const login = app.getLoginItemSettings()
    return !!login.wasOpenedAsHidden || process.argv.includes('--hidden')
  } catch {
    return process.argv.includes('--hidden')
  }
}

function createWindow(showOnReady = true): void {
  // Production has no use for the default Electron menu — and it ships Ctrl/Cmd+R
  // (reload) + DevTools accelerators that let the user reload the SPA like a web
  // page, wiping in-memory state. Keep the menu only in dev (renderer URL present).
  if (!process.env['ELECTRON_RENDERER_URL']) Menu.setApplicationMenu(null)

  mainWindow = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    frame: false,
    backgroundColor: '#070809',
    titleBarStyle: 'hidden',
    icon: trayIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (showOnReady) mainWindow?.show()
  })

  // Close-to-tray: when the tray is enabled, closing the window hides it (the app
  // keeps running in the background for auto-watch) — real quit is via the tray menu.
  mainWindow.on('close', (e) => {
    if (!isQuitting && getSettings().background.tray) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  // Open external links in the OS browser, never in-app — and only http(s), so a
  // stray/attacker-influenced string can't launch arbitrary protocols (file:, smb:, …).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Never let the main window navigate away from the app (a stray location.href would
  // wipe in-memory state). Allow only the dev server URL / the currently-loaded page.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const dev = process.env['ELECTRON_RENDERER_URL']
    const current = mainWindow?.webContents.getURL()
    if (url !== dev && url !== current) e.preventDefault()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Window controls for the custom (frameless) title bar.
ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:maximize', () => {
  if (!mainWindow) return
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
})
ipcMain.on('window:close', () => mainWindow?.close())

/** Bring up persistence before any window or IPC: electron-store + the SQLite DB. */
function initPersistence(): void {
  installGlobalLogging()
  initSettings() // re-reconciles in case defaults changed between the pre-ready read above and now
  const dbPath = join(app.getPath('userData'), 'mental-empire.db')
  try {
    initDatabase(dbPath)
    recoverInterruptedRenderJobs()
    // TalkingPhotos: reconcile any non-terminal provider job against its remote project
    // now, so a completed-while-closed cloud render surfaces immediately (plan §12).
    void reconcileNonTerminalProviderJobs().catch((e) => L.warn(`talkingphotos startup reconciliation failed: ${(e as Error).message}`))
    // TalkingPhotos: a crash/restart mid-login can leave the connection row claiming
    // connecting/waiting_for_login/verifying with nothing actually in progress — fix
    // that up before any window reads connection status.
    reconcileInterruptedConnectionOnStartup()
  } catch (e) {
    L.error(`DB init FAILED at ${dbPath}: ${(e as Error).message}`)
    throw e
  }
  // The most valuable lines in a bug report: versions + whether the sidecars exist.
  logStartupDiagnostics({ ytdlp: resolveYtdlpPath(), ffmpeg: ffmpegPath(), ffprobe: ffprobePath(), dbPath })
}

function hasUsableOutput(p?: string): p is string {
  if (!p || !existsSync(p)) return false
  try {
    return statSync(p).size > 0
  } catch {
    return false
  }
}

/** If the app was closed while a render was running, repair the persisted queue row
 *  on the next launch. Completed outputs become done; unfinished rows return to
 *  queued so the user can resume instead of staring at a frozen percentage. */
function recoverInterruptedRenderJobs(): void {
  const repos = getRepos()
  const stale = repos.renderJobs().filter((j) => j.status === 'rendering')
  if (!stale.length) return

  let completed = 0
  let requeued = 0
  for (const job of stale) {
    if (hasUsableOutput(job.outputPath)) {
      repos.setRenderStatus(job.id, { status: 'done', pct: 100, outputPath: job.outputPath, error: '' })
      if (job.projectId) repos.updateProject(job.projectId, { stage: 'rendered' })
      completed++
    } else {
      repos.setRenderStatus(job.id, { status: 'queued', pct: 0, error: '' })
      requeued++
    }
  }

  const t = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  repos.addActivity({
    t,
    icon: '!',
    color: '#f5b323',
    text: `Recovered ${stale.length} interrupted render job${stale.length === 1 ? '' : 's'} on startup (${completed} done, ${requeued} requeued)`
  })
  L.warn(`render recovery: repaired=${stale.length} completed=${completed} requeued=${requeued}`)
}

/**
 * Headless self-check (ME_SMOKE=1): exercises the full persistence stack — seed
 * the DB, round-trip a setting to disk, read domain rows back — then exit.
 * Used by the M2 verification script; never runs in normal use.
 */
function runSmokeTest(): void {
  const repos = getRepos()
  const counts = {
    myChannels: repos.myChannels().length,
    sourceChannels: repos.sourceChannels().length,
    downloads: repos.downloads().length,
    profiles: repos.profiles().length,
    templates: repos.templates().length,
    activity: repos.activity().length
  }
  const before = getSettings().accent
  const flipped = before === 'Violet' ? 'Emerald' : 'Violet'
  setSettings({ accent: flipped })
  const after = getSettings().accent
  // re-open the store from disk to prove the write persisted
  initSettings()
  const persisted = getSettings().accent

  console.log('SMOKE_COUNTS ' + JSON.stringify(counts))
  console.log(`SMOKE_SETTINGS before=${before} set=${flipped} after=${after} persisted=${persisted}`)
  const ok =
    Object.values(counts).every((n) => n > 0) && after === flipped && persisted === flipped
  console.log(ok ? 'SMOKE_OK' : 'SMOKE_FAIL')
  setSettings({ accent: before }) // restore
  closeDatabase()
  app.exit(ok ? 0 : 1)
}

/**
 * Headless M3 self-check (ME_SMOKE=m3, with ME_YTDLP_FIXTURE pointing at recorded
 * yt-dlp JSON): drives the real scrape→DB→mapping→notify pipeline against fixtures
 * and asserts the results. Real scraping can't run in the sandbox (YouTube blocked),
 * so fixtures stand in; the code path is identical to production.
 */
async function runSmokeM3(): Promise<void> {
  const repos = getRepos()
  try {
    const staleMe = repos.myChannel('me')
    if (!staleMe) throw new Error('seed channel missing: me')
    repos.upsertMyChannel({ ...staleMe, name: 'Stale Channel', mono: 'SC', avatar: 'linear-gradient(135deg,#111,#222)', weekGoal: 7 })
    const me = await refreshChannel('me') // handle @powerwithin, linked source src-pw
    const uploads = repos.getUploads('me')
    const downloads = repos.getDownloadsBySource('src-pw')
    const matchedDownloads = downloads.filter((d) => d.matchedUploadId).length

    const url = 'https://www.youtube.com/@PowerWithinOfficial'
    const vids = await sourceVideos(url, 'Popular', 3)
    const src = repos.sourceChannelByUrl(channelUrl(url))
    const cached = src ? repos.getSourceVideos(src.id).length : 0
    const sortedDesc = vids.length === 3 && vids[0].views >= vids[1].views && vids[1].views >= vids[2].views

    const hits = checkReminders()
    const meHit = hits.some((h) => h.channelId === 'me')
    const meNotified = firedNotifications.some((h) => h.channelId === 'me')
    const identityOk = me.name === 'Mental Empire' && me.mono === 'ME' && me.avatar === 'https://yt3.example/mental-empire.jpg' && me.weekGoal === 7

    console.log(`SMOKE_M3_STATS name=${me.name} subs=${me.subs} views=${me.views} total=${me.total} uploads=${uploads.length}`)
    console.log(`SMOKE_M3_IDENTITY nameFresh=${me.name === 'Mental Empire'} mono=${me.mono} avatarFresh=${me.avatar === 'https://yt3.example/mental-empire.jpg'} goalPreserved=${me.weekGoal === 7}`)
    console.log(`SMOKE_M3_MAP mapDone=${me.mapDone} mapTotal=${me.mapTotal} matchedDownloads=${matchedDownloads}`)
    console.log(`SMOKE_M3_SOURCE fetched=${vids.length} cached=${cached} top='${vids[0]?.title}' sortedDesc=${sortedDesc}`)
    console.log(`SMOKE_M3_REMIND meHit=${meHit} meNotified=${meNotified} hits=${hits.length}`)

    const ok =
      me.subs === '455' && me.total === 4 && uploads.length === 4 &&
      identityOk &&
      me.mapTotal === 3 && me.mapDone === 2 && matchedDownloads === 2 &&
      vids.length === 3 && cached === 3 && sortedDesc &&
      meHit && meNotified
    console.log(ok ? 'SMOKE_M3_OK' : 'SMOKE_M3_FAIL')
    closeDatabase()
    app.exit(ok ? 0 : 1)
  } catch (e) {
    console.log('SMOKE_M3_FAIL ' + (e as Error).message)
    closeDatabase()
    app.exit(1)
  }
}

/**
 * Headless M4 self-check (ME_SMOKE=m4, with ME_YTDLP_FIXTURE / ME_DOWNLOAD_FIXTURE /
 * ME_WHISPER_FIXTURE): drives download → probe → compose ranges → transcribe → queue
 * against fixtures + a real sample mp3, asserting the whole producer backend.
 */
async function runSmokeM4(): Promise<void> {
  const repos = getRepos()
  try {
    // pure range math
    const r1 = splitRanges(12, 1)
    const r3 = splitRanges(12, 3)
    const rangesOk =
      r1.length === 1 && r1[0].rangeEnd === 12 &&
      r3.length === 3 && r3[0].rangeStart === 0 && r3[0].rangeEnd === 4 && r3[2].rangeEnd === 12

    setSettings({ outputFolder: join(app.getPath('temp'), 'me-m4-out') })

    // pick source videos (ME_YTDLP_FIXTURE) and download mp3s (ME_DOWNLOAD_FIXTURE)
    const srcUrl = 'https://www.youtube.com/@PowerWithinOfficial'
    const vids = await sourceVideos(srcUrl, 'Latest', 2)
    const dls = await startDownloads(vids, { bitrate: 192, sourceUrl: srcUrl })
    const dl = dls[0]
    const fileOk = !!dl.filePath && existsSync(dl.filePath) && typeof dl.durationSec === 'number' && Math.abs(dl.durationSec - 12) < 0.1 && dl.stage === 'Downloaded only'

    // resume must not re-fetch (mtime unchanged)
    const before = statSync(dl.filePath as string).mtimeMs
    const resumed = await resumeDownload(dl.id)
    const after = statSync(dl.filePath as string).mtimeMs
    const resumeOk = resumed.filePath === dl.filePath && before === after

    // compose: project + even-split image ranges
    const project = createProject(dl.id)
    const imgPaths = ['powerwithin', 'stoichour', 'sleepdeep'].map((n) =>
      join(process.cwd(), 'test', 'fixtures', 'ytdlp', `${n}.json`)
    )
    const imgs = setImages(project.id, imgPaths)
    const third = (project.durationSec || 12) / 3
    const imgOk = imgs.length === 3 &&
      Math.abs(imgs[0].rangeStart - 0) < 0.01 &&
      Math.abs(imgs[0].rangeEnd - third) < 0.1 &&
      Math.abs(imgs[2].rangeEnd - project.durationSec) < 0.1

    // transcript (ME_WHISPER_FIXTURE) + emphasis toggle
    const words = await runTranscribe(project.id)
    repos.toggleEmphasis(words[0].id)
    const t = repos.getTranscript(project.id)
    const transcriptOk = words.length === 9 && t[0].emphasis === true

    // send to render
    sendToRender(project.id)
    const queuedOk = repos.getProject(project.id)?.stage === 'queued'

    console.log(`SMOKE_M4_RANGES ok=${rangesOk}`)
    console.log(`SMOKE_M4_DOWNLOAD count=${dls.length} fileOk=${fileOk} dur=${dl.durationSec} resumeNoRefetch=${resumeOk}`)
    console.log(`SMOKE_M4_COMPOSE images=${imgs.length} rangesOk=${imgOk}`)
    console.log(`SMOKE_M4_TRANSCRIBE words=${words.length} emphasis=${t[0]?.emphasis} ok=${transcriptOk}`)
    console.log(`SMOKE_M4_RENDER queued=${queuedOk}`)
    const ok = rangesOk && dls.length === 2 && fileOk && resumeOk && imgOk && transcriptOk && queuedOk
    console.log(ok ? 'SMOKE_M4_OK' : 'SMOKE_M4_FAIL')
    closeDatabase()
    app.exit(ok ? 0 : 1)
  } catch (e) {
    console.log('SMOKE_M4_FAIL ' + (e as Error).message)
    closeDatabase()
    app.exit(1)
  }
}

/**
 * Headless M5 self-check (ME_SMOKE=m5): exercises the thumbnail data layer —
 * auto-arrange layout math, template save/load round-trip (geometry preserved),
 * per-profile template lock, and PNG writing. Konva canvas + batch raster are
 * verified separately via the renderer screenshot harness.
 */
async function runSmokeM5(): Promise<void> {
  const repos = getRepos()
  try {
    // 1) template load (geometry preserved)
    const tpl = repos.getTemplate('tpl-full-bleed')
    const headline = tpl?.layers.find((l) => l.kind === 'text') as TextLayer | undefined
    const subject = tpl?.layers.find((l) => l.kind === 'subject')
    const tplOk = !!tpl && tpl.layers.length === 3 && !!headline && headline.frame.width === 780

    // 2) auto-arrange: balanced lines, highlighted word preserved, block opposite subject.
    // Highlight is now colour/box treatment only; whole-line size bumps caused uneven
    // multi-line gaps and made users split one headline into multiple text layers.
    const aa = autoArrangeText(headline as TextLayer, { w: THUMB_W, h: THUMB_H }, subject?.frame ?? null)
    const hiLine = aa.lines.find((l) => /fake/i.test(l.text))
    const otherLine = aa.lines.find((l) => !/fake/i.test(l.text))
    const highlightWords = (headline?.highlightWords?.length ? headline.highlightWords : headline?.highlightWord ? [headline.highlightWord] : [])
      .map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ''))
    const aaOk =
      aa.lines.length === 2 &&
      !!hiLine && !!otherLine && hiLine.size === otherLine.size &&
      highlightWords.includes('fake') &&
      aa.frame.x + aa.frame.width / 2 > THUMB_W / 2 // subject is left → text parks right

    // 3) save a new template + reload (round-trip)
    const newTpl: ThumbnailTemplate = { id: 'tpl-test', name: 'Test', layers: (tpl as ThumbnailTemplate).layers }
    repos.saveTemplate(newTpl)
    const reload = repos.getTemplate('tpl-test')
    const saveOk = !!reload && reload.layers.length === 3 && reload.layers[0].frame.width === 780

    // 4) lock template to a profile
    const profiles = repos.assignTemplateToProfile('me', 'tpl-test')
    const assignOk = profiles.find((p) => p.id === 'me')?.thumbnailTemplateId === 'tpl-test'

    // 5) writePng decodes a data URL to a valid PNG file
    const onePx =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQGNN1bvAAAAAElFTkSuQmCC'
    const b64 = onePx.replace(/^data:image\/\w+;base64,/, '')
    const pngPath = join(app.getPath('temp'), 'me-m5.png')
    writeFileSync(pngPath, Buffer.from(b64, 'base64'))
    const head = readFileSync(pngPath).subarray(0, 8)
    const pngOk = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47

    console.log(`SMOKE_M5_TEMPLATE tplOk=${tplOk} saveOk=${saveOk}`)
    console.log(`SMOKE_M5_AUTOARRANGE lines=${aa.lines.length} hi=${hiLine?.size} other=${otherLine?.size} x=${aa.frame.x} ok=${aaOk}`)
    console.log(`SMOKE_M5_ASSIGN ok=${assignOk}`)
    console.log(`SMOKE_M5_PNG ok=${pngOk}`)
    const ok = tplOk && aaOk && saveOk && assignOk && pngOk
    console.log(ok ? 'SMOKE_M5_OK' : 'SMOKE_M5_FAIL')
    closeDatabase()
    app.exit(ok ? 0 : 1)
  } catch (e) {
    console.log('SMOKE_M5_FAIL ' + (e as Error).message)
    closeDatabase()
    app.exit(1)
  }
}

/**
 * Headless M6 self-check (ME_SMOKE=m6): asserts ASS caption generation + the ffmpeg
 * arg-builder (pure), then drives the queue runner under ME_RENDER_FIXTURE (stub mp4)
 * to verify status/output/concurrency without ffmpeg. Real encode runs on the user's box.
 */
async function runSmokeM6(): Promise<void> {
  const repos = getRepos()
  try {
    const words: TranscriptWord[] = [
      { id: 'w0', projectId: 'p', ord: 0, word: 'You', start: 0, end: 0.3, emphasis: false },
      { id: 'w1', projectId: 'p', ord: 1, word: 'are', start: 0.3, end: 0.5, emphasis: false },
      { id: 'w2', projectId: 'p', ord: 2, word: 'NOT', start: 0.5, end: 0.9, emphasis: true },
      { id: 'w3', projectId: 'p', ord: 3, word: 'crazy', start: 0.9, end: 1.4, emphasis: false }
    ]
    const ass169 = buildAss(words, { preset: 'Hormozi', aspect: '16:9', keywords: false })
    const ass916 = buildAss(words, { preset: 'Hormozi', aspect: '9:16', keywords: false })
    const assPop = buildAss(words, { preset: 'Pop', aspect: '16:9', keywords: false })
    const assTop = buildAss(words, { preset: 'Hormozi', aspect: '16:9', keywords: false, position: 'top' })
    const assFont = buildAss(words, { preset: 'Hormozi', font: 'Bebas Neue', aspect: '16:9', keywords: false })
    const assLegacyFont = buildAss(words, { preset: 'Hormozi', font: 'Impact', aspect: '16:9', keywords: false })
    const assOffset = buildAss(words, { preset: 'Hormozi', aspect: '16:9', keywords: false, offsetY: 85 })
    const countDialogues = (ass: string): number => ass.split(/\r?\n/).filter((line) => line.startsWith('Dialogue: 0,')).length
    const longWords: TranscriptWord[] = Array.from({ length: 1600 }, (_, i) => ({
      id: `lw${i}`,
      projectId: 'long',
      ord: i,
      word: i % 17 === 0 ? 'discipline' : i % 11 === 0 ? 'relationship' : `word${i}`,
      start: i * 0.38,
      end: (i * 0.38) + 0.28,
      emphasis: i % 97 === 0
    }))
    const assLongWord = buildAss(longWords, { preset: 'Hormozi', aspect: '16:9', keywords: true, lines: 2 })
    const assLongPhrase = buildAss(longWords, { preset: 'Hormozi', aspect: '16:9', keywords: true, lines: 2, mode: 'phrase' })
    const longWordDialogues = countDialogues(assLongWord.ass)
    const longPhraseDialogues = countDialogues(assLongPhrase.ass)
    const captionPerfOk = longWordDialogues === longWords.length && longPhraseDialogues < longWordDialogues / 4 && assLongPhrase.ass.includes('\\N')
    const assOk =
      ass169.ass.includes('PlayResX: 1920') && ass916.ass.includes('PlayResX: 1080') &&
      !ass169.ass.includes('\\kf') && ass169.ass.includes('\\fscx112') && ass169.ass.includes('&H003DD9FF') &&
      // the manually-emphasized word carries the Hormozi keyword rotation colour
      // (green #3BFF6F), which is distinct from the active-word yellow above
      ass169.ass.includes('&H006FFF3B') &&
      ass169.zoomHits.length === 1 &&
      // preset fonts genuinely differ: Hormozi=Anton, legacy Pop alias→Karaoke=Montserrat
      ass169.ass.includes('Anton') && assPop.ass.includes('Montserrat ExtraBold') &&
      // vertical placement: coarse position + the fine offsetY override both map to \pos
      assTop.ass.includes('\\pos(960,140)') && assOffset.ass.includes('\\pos(960,918)') &&
      // font override honours bundled families; never-bundled legacy names alias sanely
      assFont.ass.includes('Style: Default,Bebas Neue,') && assLegacyFont.ass.includes('Style: Default,Anton,')

    const proj = (id: string, title: string): Parameters<typeof repos.createProject>[0] => ({
      id, downloadId: id, title, channel: 'Mental Empire', mp3Path: join(process.cwd(), 'test', 'fixtures', 'audio', 'sample.mp3'),
      durationSec: 12, imageMode: 'sequence', poolSize: 10, kenBurns: true, seed: 4821, crossfade: 0.8,
      captionPreset: 'Hormozi', captionFont: 'Anton', captionAnim: 'Pop-in', captionAspect: '16:9',
      emphasis: true, keywords: true, punchZoom: true, stage: 'queued', createdAt: new Date().toISOString()
    })
    const smokeSettings = { ...getSettings(), quality: '1080p' as const, encoder: 'cpu' as const }
    const args = buildRenderArgs({
      project: proj('p-args', 'Args'),
      images: [
        { id: 'i0', projectId: 'p-args', ord: 0, path: '/x/a.png', thumb: '', rangeStart: 0, rangeEnd: 6, manual: false },
        { id: 'i1', projectId: 'p-args', ord: 1, path: '/x/b.png', thumb: '', rangeStart: 6, rangeEnd: 12, manual: false }
      ],
      assPath: '/tmp/x.ass', outPath: '/tmp/o.mp4', settings: smokeSettings
    })
    const g = args.join(' ')
    const longImageArgs = buildRenderArgs({
      project: { ...proj('p-long', 'Long image'), durationSec: 1174, kenBurns: true, punchZoom: true },
      images: [{ id: 'li0', projectId: 'p-long', ord: 0, path: '/x/a.png', thumb: '', rangeStart: 0, rangeEnd: 1174, manual: false }],
      assPath: '/tmp/x.ass',
      outPath: '/tmp/o.mp4',
      settings: smokeSettings
    }).join(' ')
    const longMultiImageArgs = buildRenderArgs({
      project: { ...proj('p-long-multi', 'Long image multi'), durationSec: 1174, kenBurns: true, punchZoom: true },
      images: [
        { id: 'lmi0', projectId: 'p-long-multi', ord: 0, path: '/x/a.png', thumb: '', rangeStart: 0, rangeEnd: 391, manual: false },
        { id: 'lmi1', projectId: 'p-long-multi', ord: 1, path: '/x/b.png', thumb: '', rangeStart: 391, rangeEnd: 782, manual: false },
        { id: 'lmi2', projectId: 'p-long-multi', ord: 2, path: '/x/c.png', thumb: '', rangeStart: 782, rangeEnd: 1174, manual: false }
      ],
      assPath: '/tmp/x.ass',
      outPath: '/tmp/o.mp4',
      settings: smokeSettings
    }).join(' ')
    const longBrollManifestArgs = buildRenderArgs({
      project: {
        ...proj('p-long-broll', 'Long Broll'),
        durationSec: 1174,
        kenBurns: true,
        punchZoom: true,
        betaOpts: { ...DEFAULT_BETA_OPTS, autoZoom: { atStart: true, atKeyPhrases: true }, broll: { ...DEFAULT_BETA_OPTS.broll, enabled: true, density: 'sparse' } }
      },
      images: [],
      brollManifestPath: '/tmp/long-broll-concat.txt',
      assPath: '/tmp/x.ass',
      outPath: '/tmp/o.mp4',
      settings: { ...smokeSettings, beta: { enabled: true, pexelsKey: '', pixabayKey: '', coverrKey: '' } }
    }).join(' ')
    const loudnorm2 = buildSecondPassLoudnormFilter({ input_i: '-20.0', input_tp: '-3.0', input_lra: '7.0', input_thresh: '-30.0', target_offset: '1.2' })
    const loudnormFallback = buildMasterLoudnormFilter({ input_i: '-inf', input_tp: '-inf', input_lra: '0.0', input_thresh: '-70.0', target_offset: 'inf' })
    const argsOk = g.includes('zoompan') && g.includes('xfade') && g.includes('subtitles=') && g.includes('libx264') && g.includes('scale=1920:1080') && loudnorm2.includes('measured_I=-20.0') && loudnorm2.includes('linear=true') && loudnormFallback === 'loudnorm=I=-14:TP=-1:LRA=11' && !g.includes('-shortest')
    const longMotionOk =
      !longImageArgs.includes('zoompan') && !longImageArgs.includes('xfade=') &&
      longImageArgs.includes('subtitles=') && longImageArgs.includes('-t 1174.00') &&
      !longMultiImageArgs.includes('zoompan') && !longMultiImageArgs.includes('xfade=') &&
      longMultiImageArgs.includes('concat=n=3:v=1:a=0') && longMultiImageArgs.includes('-t 1174.00')
    const longBrollFastArgsOk =
      longBrollManifestArgs.includes('-f concat -safe 0 -i /tmp/long-broll-concat.txt') &&
      !longBrollManifestArgs.includes('zoompan') &&
      !longBrollManifestArgs.includes('xfade=') &&
      !longBrollManifestArgs.includes('-stream_loop') &&
      longBrollManifestArgs.includes('-t 1174.00')
    const smooth = createProgressSmoother(120)
    const etaA = smooth({ outTimeSec: 1, pct: 1, speed: 0.1 })
    const etaB = smooth({ outTimeSec: 2, pct: 2, speed: 0.2 })
    const etaC = smooth({ outTimeSec: 3, pct: 3, speed: 0.3 })
    const etaOk = etaA.etaState === 'estimating' && etaB.etaState === 'estimating' && etaC.etaState === 'stable' && (etaC.etaSec ?? 9999) <= 300
    const oldestOrder = orderVideos([
      { id: 'new', title: 'new', durationSec: 0, thumb: '', views: 0, uploadDate: '20240601' },
      { id: 'old', title: 'old', durationSec: 0, thumb: '', views: 0, uploadDate: '20240101' },
      { id: 'mid', title: 'mid', durationSec: 0, thumb: '', views: 0, uploadDate: '20240301' }
    ], 'Oldest', 3).map((v) => v.id).join(',')
    const sourceOrderOk = oldestOrder === 'old,mid,new'

    // ---- Beta features (hook / overlay gradient / auto-zoom at start) ----
    const assHook = buildAss(words, { preset: 'Hormozi', aspect: '16:9', keywords: false, hook: { text: 'wait for it', untilSec: 2.5 } })
    const betaProj = {
      ...proj('p-beta', 'Beta'), kenBurns: false, punchZoom: false,
      betaOpts: { ...DEFAULT_BETA_OPTS, overlay: { ...DEFAULT_BETA_OPTS.overlay, bottom: true }, autoZoom: { atStart: true, atKeyPhrases: false } }
    }
    const betaImgs = [{ id: 'i0', projectId: 'p-beta', ord: 0, path: '/x/a.png', thumb: '', rangeStart: 0, rangeEnd: 12, manual: false }]
    const betaSettings = { ...smokeSettings, beta: { enabled: true, pexelsKey: '', pixabayKey: '', coverrKey: '' } }
    const betaArgs = buildRenderArgs({ project: betaProj, images: betaImgs, assPath: '/tmp/x.ass', outPath: '/tmp/o.mp4', settings: betaSettings }).join(' ')
    // Everything off on the PROJECT (static motion, no overlay/zoom flags) → no
    // overlay/zoompan in the graph (regression guard for the no-effects default).
    const offProj = { ...proj('p-beta-off', 'BetaOff'), kenBurns: false, punchZoom: false, motionPreset: 'off' as const, betaOpts: { ...DEFAULT_BETA_OPTS } }
    const offArgs = buildRenderArgs({ project: offProj, images: betaImgs, assPath: '/tmp/x.ass', outPath: '/tmp/o.mp4', settings: betaSettings }).join(' ')
    const betaOk =
      assHook.ass.includes('Style: Hook') && assHook.ass.includes('Dialogue: 1,') &&
      betaArgs.includes('overlay=0:0') && betaArgs.includes('.pam') && betaArgs.includes('zoompan') &&
      !offArgs.includes('overlay=0:0') && !offArgs.includes('zoompan')
    console.log(`SMOKE_M6_BETA hook=${assHook.ass.includes('Style: Hook')} overlay=${betaArgs.includes('overlay=0:0')} startZoom=${betaArgs.includes('zoompan')} offClean=${!offArgs.includes('overlay=0:0')}`)

    // ---- Beta auto-B-roll: themes / ranking / coverage (pure) + bed assembly (fixture) ----
    const themes = extractThemes(words.concat([
      { id: 'k', projectId: 'p', ord: 9, word: 'discipline', start: 2, end: 2.4, emphasis: true },
      { id: 'k2', projectId: 'p', ord: 10, word: 'discipline', start: 3, end: 3.4, emphasis: false }
    ]))
    const cands: BrollCandidate[] = [
      { provider: 'pixabay', id: 'a', url: 'u', width: 720, height: 1280, durationSec: 2, tags: ['x'] },
      { provider: 'pexels', id: 'b', url: 'u', width: 1920, height: 1080, durationSec: 8, tags: ['discipline'] }
    ]
    const ranked = rankCandidates(cands, 'discipline', { w: 1920, h: 1080 })
    // 12s covered by a 3s + an 8s clip → segments tile the whole duration, long clip trimmed.
    const cov = planCoverage(12, [{ path: 'c1', durationSec: 3 }, { path: 'c2', durationSec: 8 }], { density: 'sparse' })
    const covEnd = cov.length ? cov[cov.length - 1].end : 0
    const longTrimmed = cov.every((s) => s.end - s.start <= 9.001)
    const longCov = planCoverage(1174, [
      { path: 'short1', durationSec: 9 },
      { path: 'short2', durationSec: 12 },
      { path: 'short3', durationSec: 18 }
    ], { density: 'sparse', maxSegments: 32 })
    const longCovEnd = longCov.length ? longCov[longCov.length - 1].end : 0
    const longCapped = longCov.length <= 32 && Math.abs(longCovEnd - 1174) < 0.1
    process.env['ME_BROLL_FIXTURE'] = join(process.cwd(), 'test', 'fixtures', 'broll')
    const bed = await buildBrollBed({ settings: { ...smokeSettings, beta: { enabled: true, pexelsKey: 'k', pixabayKey: '', coverrKey: '' } }, words, durationSec: 12, density: 'sparse', poolSize: 4, dims: { w: 1920, h: 1080 }, fps: 30 })
    delete process.env['ME_BROLL_FIXTURE']
    const directBrollArgs = buildRenderArgs({
      project: proj('p-broll-direct', 'Broll direct'),
      images: [],
      brollSegments: cov.map((s) => ({ ...s, path: '/x/clip.mp4' })),
      assPath: '/tmp/x.ass',
      outPath: '/tmp/o.mp4',
      settings: smokeSettings
    }).join(' ')
    const directOk = directBrollArgs.includes('concat=n=') && directBrollArgs.includes('-stream_loop -1') && directBrollArgs.includes('/x/clip.mp4') && !directBrollArgs.includes('bed-')
    process.env['ME_BROLL_LOCAL'] = join(process.cwd(), 'test', 'fixtures', 'broll', 'local')
    const manifestJobId = `smoke-m6-${Date.now()}`
    const manifestOpts = {
      settings: smokeSettings,
      words,
      durationSec: 4,
      density: 'sparse' as const,
      poolSize: 2,
      dims: { w: 320, h: 180 },
      fps: 15,
      jobId: manifestJobId,
      maxSegments: 2
    }
    const manifest = await buildBrollManifest(manifestOpts)
    const manifestMtimesBefore = manifest?.segments.map((s) => statSync(s.normalizedPath).mtimeMs) ?? []
    const manifestAgain = await buildBrollManifest(manifestOpts)
    const manifestMtimesAfter = manifestAgain?.segments.map((s) => statSync(s.normalizedPath).mtimeMs) ?? []
    delete process.env['ME_BROLL_LOCAL']
    const titleThemes = keywordThemesFromTitles(['How Narcissists React After Long No Contact | Dr Ramani'], 6)
    const librarySourceKey = `smoke-library-${Date.now()}`
    process.env['ME_BROLL_LOCAL'] = join(process.cwd(), 'test', 'fixtures', 'broll', 'local')
    const warmed = await warmBrollLibraryFromTitles(
      { ...smokeSettings, beta: { enabled: true, pexelsKey: 'local', pixabayKey: '', coverrKey: '' } },
      ['How Narcissists React After Long No Contact | Dr Ramani'],
      { sourceKey: librarySourceKey, targetClips: 2, dims: { w: 320, h: 180 } }
    )
    delete process.env['ME_BROLL_LOCAL']
    const cachedPool = await fetchPool({ ...smokeSettings, beta: { enabled: true, pexelsKey: '', pixabayKey: '', coverrKey: '' } }, ['unmatched random topic'], { w: 320, h: 180 }, 1)
    const libraryOk =
      titleThemes.includes('toxic relationship') &&
      titleThemes.includes('lonely person') &&
      !!warmed && existsSync(warmed.indexPath) && warmed.clips > 0 &&
      cachedPool.some((c) => existsSync(c.url))
    const manifestArgs = manifest ? buildRenderArgs({
      project: proj('p-broll-manifest', 'Broll manifest'),
      images: [],
      brollManifestPath: manifest.manifestPath,
      assPath: '/tmp/x.ass',
      outPath: '/tmp/o.mp4',
      settings: smokeSettings
    }).join(' ') : ''
    const manifestOk = !!manifest && existsSync(manifest.manifestPath) && existsSync(manifest.jsonPath) && manifest.segments.every((s) => existsSync(s.normalizedPath)) && manifestArgs.includes('-f concat -safe 0 -i') && manifestArgs.includes(manifest.manifestPath)
    const manifestResumeOk = !!manifestAgain && manifestAgain.segments.length === manifestMtimesBefore.length && manifestMtimesAfter.every((m, i) => m === manifestMtimesBefore[i])
    const finalCudaArgs = manifest ? buildRenderArgs({
      project: proj('p-broll-final-cuda', 'Broll final cuda'),
      images: [],
      brollManifestPath: manifest.manifestPath,
      assPath: '/tmp/x.ass',
      outPath: '/tmp/o.mp4',
      settings: { ...smokeSettings, encoder: 'nvenc' },
      caps: { hasNvenc: true, hasQsv: false, hasAmf: false, gpuVendor: 'nvidia', ffmpegHasLibass: true, ffmpegHasCuda: true }
    }).join(' ') : ''
    const finalCudaOk = finalCudaArgs.includes('-hwaccel cuda') && finalCudaArgs.includes('scale_cuda=') && finalCudaArgs.includes('hwdownload,format=nv12') && finalCudaArgs.includes('hwupload_cuda') && finalCudaArgs.includes('h264_nvenc') && !finalCudaArgs.includes('-pix_fmt yuv420p')
    const cudaNormalizeArgs = buildBrollNormalizeArgs(
      { path: '/x/clip.mp4', start: 0, end: 4, srcStart: 0 },
      '/tmp/seg.mp4',
      { w: 1920, h: 1080 },
      30,
      { ...smokeSettings, encoder: 'nvenc' },
      { hasNvenc: true, hasQsv: false, hasAmf: false, gpuVendor: 'nvidia', ffmpegHasLibass: true, ffmpegHasCuda: true }
    ).join(' ')
    const cudaNormalizeOk = cudaNormalizeArgs.includes('-hwaccel cuda') && cudaNormalizeArgs.includes('scale_cuda=') && cudaNormalizeArgs.includes('hwdownload,format=nv12') && cudaNormalizeArgs.includes('h264_nvenc')
    const originalFetch = globalThis.fetch
    let rateFallbackOk = false
    let allLimitedOk = false
    try {
      const requestedUrls: string[] = []
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input)
        requestedUrls.push(url)
        if (url.includes('pexels.com')) return new Response('', { status: 429 })
        if (url.includes('pixabay.com')) {
          return new Response(JSON.stringify({
            hits: [{ id: 9, duration: 6, tags: 'discipline,focus', videos: { large: { url: 'https://example.test/clip.mp4', width: 1920, height: 1080 } } }]
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch
      const fallbackPool = await fetchPool({ ...smokeSettings, beta: { enabled: true, pexelsKey: 'p', pixabayKey: 'x', coverrKey: '' } }, ['discipline'], { w: 1920, h: 1080 }, 1, undefined, { skipLibrary: true })
      rateFallbackOk = requestedUrls.some((u) => u.includes('pexels.com')) && requestedUrls.some((u) => u.includes('pixabay.com')) && fallbackPool[0]?.provider === 'pixabay'

      globalThis.fetch = (async () => new Response('', { status: 429 })) as typeof fetch
      try {
        await fetchPool({ ...smokeSettings, beta: { enabled: true, pexelsKey: 'p', pixabayKey: 'x', coverrKey: '' } }, ['discipline'], { w: 1920, h: 1080 }, 1, undefined, { skipLibrary: true })
      } catch (e) {
        allLimitedOk = /all configured providers are rate-limited/i.test((e as Error).message)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
    const brollOk = sourceOrderOk && themes.includes('discipline') && ranked[0].id === 'b' && Math.abs(covEnd - 12) < 0.1 && longTrimmed && longCapped && !!bed && existsSync(bed!) && directOk && manifestOk && manifestResumeOk && libraryOk && cudaNormalizeOk && finalCudaOk && rateFallbackOk && allLimitedOk
    console.log(`SMOKE_M6_BROLL sourceOrder=${sourceOrderOk} themes=${themes.slice(0, 3).join(',')} titleThemes=${titleThemes.slice(0, 2).join(',')} topRank=${ranked[0].id} covEnd=${covEnd.toFixed(1)} trimmed=${longTrimmed} long=${longCov.length}/${longCovEnd.toFixed(1)} bed=${!!bed} direct=${directOk} manifest=${manifestOk} resume=${manifestResumeOk} library=${libraryOk} cudaNormalize=${cudaNormalizeOk} cudaFinal=${finalCudaOk} rateFallback=${rateFallbackOk} allLimited=${allLimitedOk}`)

    // ---- Beta style + effect plan: validator guardrails, rule engine, render wiring ----
    const vp = validateEffectPlan({
      transitions: [
        { atSec: 1, type: 'fadeblack', durationSec: 2 },     // duration clamped to 0.8
        { atSec: 1.5, type: 'fadeblack', durationSec: 0.5 }, // too close → dropped
        { atSec: 8, type: 'nonsense', durationSec: 0.5 },    // unknown → dropped
        { atSec: 9, type: 'zoomin', durationSec: 0.5 }
      ],
      textEffects: [{ scope: 'hook', preset: 'cinematic-pop' }, { word: 'x', preset: 'bogus' }]
    }, 60)
    // length 2 ⇒ the unknown type + the too-close transition were both dropped.
    const validatorOk =
      vp.plan.transitions.length === 2 && vp.plan.transitions[0].durationSec <= 0.8 &&
      vp.plan.textEffects.length === 1
    const rulePlan = deriveStylePlan(words, 'Cinematic', 12)
    const ruleOk = rulePlan.transitions.length >= 0 && rulePlan.textEffects.some((e) => e.scope === 'hook')
    const lead = styleCaptionLead('Cinematic')
    const assStyled = buildAss(words, { preset: 'Hormozi', aspect: '16:9', keywords: false, styleLead: lead })
    const styleArgs = buildRenderArgs({
      project: { ...proj('p-sty', 'Sty'), kenBurns: false, betaOpts: { ...DEFAULT_BETA_OPTS, style: 'Cinematic' } },
      images: [
        { id: 'i0', projectId: 'p-sty', ord: 0, path: '/x/a.png', thumb: '', rangeStart: 0, rangeEnd: 6, manual: false },
        { id: 'i1', projectId: 'p-sty', ord: 1, path: '/x/b.png', thumb: '', rangeStart: 6, rangeEnd: 12, manual: false }
      ],
      assPath: '/tmp/x.ass', outPath: '/tmp/o.mp4', settings: betaSettings, transition: 'fadeblack'
    }).join(' ')
    // Per-word + hook text-effect presets land as ASS override tags.
    const assWordFx = buildAss(words, { preset: 'Hormozi', aspect: '16:9', keywords: false, hook: { text: 'hi', untilSec: 2 }, textEffects: [{ word: 'crazy', preset: 'intense-zoom' }, { scope: 'hook', preset: 'cinematic-pop' }] })
    const wordFxOk = assWordFx.ass.includes(textPresetTag('intense-zoom')) && assWordFx.ass.includes(textPresetTag('cinematic-pop'))
    const normalizeStyleSeg = { path: '/x/clip.mp4', start: 0, end: 6, srcStart: 0 }
    const noGpuCaps = { hasNvenc: false, hasQsv: false, hasAmf: false, gpuVendor: 'unknown' as const, ffmpegHasLibass: true, ffmpegHasCuda: false }
    const cinematicBrollFx = buildBrollNormalizeArgs(normalizeStyleSeg, '/tmp/c.mp4', { w: 320, h: 180 }, 24, smokeSettings, noGpuCaps, { style: 'Cinematic', index: 0, total: 2 }).join(' ')
    const heartfeltBrollFx = buildBrollNormalizeArgs(normalizeStyleSeg, '/tmp/h.mp4', { w: 320, h: 180 }, 24, smokeSettings, noGpuCaps, { style: 'Heartfelt', index: 1, total: 2 }).join(' ')
    const intenseBrollFx = buildBrollNormalizeArgs(normalizeStyleSeg, '/tmp/i.mp4', { w: 320, h: 180 }, 24, smokeSettings, noGpuCaps, { style: 'Intense', index: 0, total: 2 }).join(' ')
    const cleanBrollFx = buildBrollNormalizeArgs(normalizeStyleSeg, '/tmp/n.mp4', { w: 320, h: 180 }, 24, smokeSettings, noGpuCaps, { style: 'Clean', index: 0, total: 2 }).join(' ')
    const brollStyleFxOk =
      cinematicBrollFx.includes('fade=t=out') && cinematicBrollFx.includes('d=0.42') && cinematicBrollFx.includes('color=black') &&
      heartfeltBrollFx.includes('fade=t=in') && heartfeltBrollFx.includes('d=0.36') && heartfeltBrollFx.includes('color=white') &&
      intenseBrollFx.includes('fade=t=out') && intenseBrollFx.includes('d=0.14') && !cleanBrollFx.includes('fade=t=')
    const styleOk = validatorOk && ruleOk && assStyled.ass.includes(lead) && lead.length > 0 && styleArgs.includes('xfade=transition=fadeblack') && styleArgs.includes('vignette=PI/5') && styleArgs.includes('noise=alls=8') && wordFxOk && brollStyleFxOk
    console.log(`SMOKE_M6_STYLE validator=${validatorOk} rule=${ruleOk} lead=${assStyled.ass.includes(lead)} transition=${styleArgs.includes('xfade=transition=fadeblack')} grade=${styleArgs.includes('vignette=PI/5')} wordFx=${wordFxOk} brollFx=${brollStyleFxOk}`)

    // ---- Beta transition SFX + per-boundary placement ----
    const fxPlan: EffectPlan = { transitions: [{ atSec: 6, type: 'circleopen', durationSec: 0.5, sfx: 'whoosh_soft' }], textEffects: [] }
    const sfxWav = buildSfxTrack(fxPlan.transitions, 12)
    const sfxHeaderOk = !!sfxWav && existsSync(sfxWav) && readFileSyncSfx(sfxWav).subarray(0, 4).toString() === 'RIFF'
    // 2-image project: boundary at offset=6 → the plan's circleopen lands on that cut.
    const perBoundaryArgs = buildRenderArgs({
      project: { ...proj('p-fx', 'Fx'), kenBurns: false },
      images: [
        { id: 'i0', projectId: 'p-fx', ord: 0, path: '/x/a.png', thumb: '', rangeStart: 0, rangeEnd: 6, manual: false },
        { id: 'i1', projectId: 'p-fx', ord: 1, path: '/x/b.png', thumb: '', rangeStart: 6, rangeEnd: 12, manual: false }
      ],
      assPath: '/tmp/x.ass', outPath: '/tmp/o.mp4', settings: betaSettings, transition: 'fade', plan: fxPlan, sfxPath: sfxWav ?? undefined
    }).join(' ')
    const sfxOk = sfxHeaderOk && perBoundaryArgs.includes('xfade=transition=circleopen') && perBoundaryArgs.includes('amix=inputs=2')
    console.log(`SMOKE_M6_SFX wav=${sfxHeaderOk} perBoundary=${perBoundaryArgs.includes('xfade=transition=circleopen')} mix=${perBoundaryArgs.includes('amix=inputs=2')}`)

    // dry-run queue with two jobs at concurrency 2 (unique ids → smoke is re-runnable)
    setSettings({ outputFolder: join(app.getPath('temp'), 'me-m6-out'), concurrency: 2 })
    process.env['ME_RENDER_FIXTURE'] = '1'
    const ns = Date.now()
    for (const k of [1, 2]) {
      const id = `proj-m6-${ns}-${k}`
      repos.createProject({
        ...proj(id, `M6 Test ${k}`),
        captionLines: k === 1 ? 3 : 2,
        captionPosition: k === 1 ? 'middle' : 'bottom',
        captionPace: k === 1 ? 'phrase' : 'auto'
      })
      repos.replaceProjectImages(id, [{ id: `${id}-i0`, projectId: id, ord: 0, path: '/x/a.png', thumb: '', rangeStart: 0, rangeEnd: 12, manual: false }])
      repos.replaceTranscript(id, words.map((w, i) => ({ ...w, id: `${id}-w${i}`, projectId: id })))
      repos.createRenderJob({ id: `job-${id}`, title: `M6 Test ${k}`, channel: 'Mental Empire', projectId: id })
    }
    await runAll()
    const j1 = repos.renderJob(`job-proj-m6-${ns}-1`)
    const queueOk = j1?.status === 'done' && !!j1.outputPath && existsSync(j1.outputPath) && j1.pct === 100 && lastMaxActive() === 2
    // .ass/.log are written as siblings of the .mp4 (now under the per-video output/ dir),
    // so derive their paths from the job's outputPath rather than a fixed flat location.
    const assFileOk = !!j1?.outputPath && existsSync(j1.outputPath.replace(/\.mp4$/, '.ass'))
    const logFile = j1?.outputPath ? j1.outputPath.replace(/\.mp4$/, '.render.log') : ''
    const logTxt = logFile && existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    const stageTimingOk = logTxt.includes('[stage:start] preparing') && logTxt.includes('[stage:end] preparing') && logTxt.includes('[render:end] status=done')
    const probeLogOk = logTxt.includes('[probe] output=') && logTxt.includes('expectedSec=12.00')
    const captionPaceLogOk = logTxt.includes('mode=phrase') && logTxt.includes('pace=phrase') && logTxt.includes('lines=3')

    console.log(`SMOKE_M6_ASS ok=${assOk} zoomHits=${ass169.zoomHits.length} top=${assTop.ass.includes('\\pos(960,140)')} offset=${assOffset.ass.includes('\\pos(960,918)')}`)
    console.log(`SMOKE_M6_ARGS ok=${argsOk} eta=${etaOk}`)
    console.log(`SMOKE_M6_LONGFORM captions=${captionPerfOk} wordEvents=${longWordDialogues} phraseEvents=${longPhraseDialogues} motion=${longMotionOk} brollFast=${longBrollFastArgsOk}`)
    console.log(`SMOKE_M6_QUEUE status=${j1?.status} pct=${j1?.pct} maxActive=${lastMaxActive()} out=${!!j1?.outputPath} ass=${assFileOk} stageTiming=${stageTimingOk} probe=${probeLogOk} captionPace=${captionPaceLogOk}`)
    const ok = assOk && argsOk && etaOk && captionPerfOk && longMotionOk && longBrollFastArgsOk && queueOk && assFileOk && stageTimingOk && probeLogOk && captionPaceLogOk && betaOk && brollOk && styleOk && sfxOk
    console.log(ok ? 'SMOKE_M6_OK' : 'SMOKE_M6_FAIL')
    closeDatabase()
    app.exit(ok ? 0 : 1)
  } catch (e) {
    console.log('SMOKE_M6_FAIL ' + (e as Error).message)
    closeDatabase()
    app.exit(1)
  }
}

/**
 * Headless M7 self-check (ME_SMOKE=m7, with ME_YTDLP_FIXTURE + ME_DOWNLOAD_FIXTURE):
 * frequency map + new-upload cursor (pure), profile config round-trip, a fixture-backed
 * headless profile run (projects + queued jobs + cursor advance), and a webhook POST to
 * a local server. Tray / login / notifications are OS-session features → tested on the box.
 */
async function runSmokeM7(): Promise<void> {
  const repos = getRepos()
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  try {
    assertDisposableSmokeProfile(app.getPath('userData'))
    repos.resetAll()
    seedDemoForSmoke()
    // pure: frequency map + cursor
    const freqOk =
      scheduler.frequencyToMs('Every 6 hours') === 6 * 3_600_000 &&
      scheduler.frequencyToMs('Every 30 minutes') === 30 * 60_000 &&
      scheduler.frequencyToMs('Daily') === 24 * 3_600_000
    const vids = (ids: string[]): { id: string }[] => ids.map((id) => ({ id }))
    const cursorOk =
      newVideos(vids(['a', 'b', 'c', 'd']) as never) .length === 4 &&
      newVideos(vids(['a', 'b', 'c', 'd']) as never, 'b').length === 1 &&
      newVideos(vids(['a', 'b', 'c', 'd']) as never, 'b')[0].id === 'a' &&
      newVideos(vids(['a', 'b']) as never, 'zzz').length === 2

    // profile config round-trip
    const me = repos.getProfile('me')
    const cfgOk = !!me && me.sourceUrl.includes('@PowerWithinOfficial') && me.sourceCount === 5 && me.kenBurns === true && me.captionPreset === 'Hormozi'

    // webhook POST to a local server
    const received: Array<Record<string, unknown>> = []
    const server = createServer((req, res) => {
      let b = ''
      req.on('data', (d) => (b += d))
      req.on('end', () => {
        try { received.push(JSON.parse(b)) } catch { /* ignore */ }
        res.end('ok')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    setSettings({ background: { webhook: `http://127.0.0.1:${port}` } })
    await postWebhook('profile_run', { profile: 'WHTest' })
    for (let i = 0; i < 30 && received.length === 0; i++) await sleep(50)
    const webhookOk = received.some((r) => r.event === 'profile_run' && r.profile === 'WHTest')
    server.close()
    setSettings({ background: { webhook: '' } })

    // login item: must not throw
    let loginOk = true
    try {
      applyLoginItem({ ...getSettings(), background: { ...getSettings().background, startOnSignIn: true } })
    } catch {
      loginOk = false
    }

    // headless profile run (fixtures): scrape → download → projects → cursor advance
    setSettings({ outputFolder: join(app.getPath('temp'), 'me-m7-out'), transcription: { apiKey: '' } })
    const projectIds = await runProfile('me', true)
    const firstProj = repos.getProject(projectIds[0])
    const cursor = repos.getProfile('me')?.lastSeenVideoId
    // NOTE: the queued-render count is deliberately NOT asserted here. The legacy
    // profile auto-run (runProfile/runAutomation) creates projects with no images and
    // B-roll disabled, then calls sendToRender(). validateRenderReady() was tightened
    // during the frontend redesign to require audio AND visual media (images or usable
    // B-roll) — image-less projects used to queue and produce a black-background MP4,
    // which the stricter check now (correctly) refuses. That refusal is right for the
    // redesigned Compose flow, where the user always adds images or enables B-roll and
    // a client-side preflight guards the button. The legacy profile auto-run path has
    // no entry point anywhere in the redesigned UI (it is superseded by Automation
    // Studio, which supplies assets/B-roll of its own); wiring a default image/B-roll
    // source into it is a feature change out of scope for the rewiring pass. This smoke
    // therefore verifies the auto-run pipeline up to project creation + cursor advance,
    // not the render-queue handoff for a visually-empty project.
    const runOk =
      projectIds.length === 5 &&
      cursor === 's5' &&
      firstProj?.captionPreset === 'Hormozi'
    // second run: nothing new
    const second = await runProfile('me', true)
    const noopOk = second.length === 0

    console.log(`SMOKE_M7_PURE freq=${freqOk} cursor=${cursorOk} config=${cfgOk}`)
    console.log(`SMOKE_M7_WEBHOOK ok=${webhookOk} login=${loginOk}`)
    console.log(`SMOKE_M7_RUN projects=${projectIds.length} queued=${repos.queuedJobs().length} cursor=${cursor} noop=${noopOk}`)
    const ok = freqOk && cursorOk && cfgOk && webhookOk && loginOk && runOk && noopOk
    console.log(ok ? 'SMOKE_M7_OK' : 'SMOKE_M7_FAIL')
    closeDatabase()
    app.exit(ok ? 0 : 1)
  } catch (e) {
    console.log('SMOKE_M7_FAIL ' + (e as Error).message)
    closeDatabase()
    app.exit(1)
  }
}

interface Probe {
  video: boolean
  audio: boolean
  width: number
  height: number
  duration: number
  vcodec: string
  acodec: string
}

function ffprobe(file: string): Probe | null {
  try {
    const out = execFileSync(ffprobePath(), [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file
    ]).toString()
    const j = JSON.parse(out) as { streams: Array<Record<string, unknown>>; format: { duration?: string } }
    const v = j.streams.find((s) => s.codec_type === 'video')
    const a = j.streams.find((s) => s.codec_type === 'audio')
    return {
      video: !!v, audio: !!a,
      width: (v?.width as number) ?? 0, height: (v?.height as number) ?? 0,
      duration: parseFloat(j.format.duration ?? '0'),
      vcodec: (v?.codec_name as string) ?? '', acodec: (a?.codec_name as string) ?? ''
    }
  } catch {
    return null
  }
}

function loudnessI(file: string): number | null {
  const r = spawnSync(ffmpegPath(), [
    '-hide_banner', '-nostats',
    '-i', file,
    '-vn',
    '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json',
    '-f', 'null',
    '-'
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 })
  const txt = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  const start = txt.lastIndexOf('{')
  const end = txt.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const j = JSON.parse(txt.slice(start, end + 1)) as { input_i?: string }
    const n = Number(j.input_i)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

interface FrameStats {
  activePixels: number
  captionPixels: number
  yellowPixels: number
  totalPixels: number
}

function fixedFrameStats(file: string, probe: Probe, atSec = 1.25): FrameStats | null {
  if (!probe.width || !probe.height) return null
  const r = spawnSync(ffmpegPath(), [
    '-v', 'error',
    '-ss', atSec.toFixed(2),
    '-i', file,
    '-frames:v', '1',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-'
  ], { encoding: 'buffer', windowsHide: true, maxBuffer: probe.width * probe.height * 4 + 1024 * 1024 })
  const buf = r.stdout as Buffer
  const totalPixels = probe.width * probe.height
  if (!buf || buf.length < totalPixels * 4) return null
  let activePixels = 0
  let captionPixels = 0
  let yellowPixels = 0
  for (let i = 0; i < totalPixels * 4; i += 4) {
    const red = buf[i] ?? 0
    const green = buf[i + 1] ?? 0
    const blue = buf[i + 2] ?? 0
    if (red + green + blue > 48) activePixels++
    const yellow = red > 200 && green > 150 && blue < 130
    const white = red > 190 && green > 190 && blue > 190
    if (yellow) yellowPixels++
    if (yellow || white) captionPixels++
  }
  return { activePixels, captionPixels, yellowPixels, totalPixels }
}

function scaledRawFrame(file: string, atSec: number, size = '160:90'): Buffer | null {
  const [sw, sh] = size.split(':').map((n) => Number(n))
  const expected = (sw || 0) * (sh || 0) * 4
  if (!expected) return null
  const r = spawnSync(ffmpegPath(), [
    '-v', 'error',
    '-ss', atSec.toFixed(2),
    '-i', file,
    '-frames:v', '1',
    '-vf', `scale=${size}`,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-'
  ], { encoding: 'buffer', windowsHide: true, maxBuffer: expected + 1024 * 1024 })
  const buf = r.stdout as Buffer
  return buf && buf.length >= expected ? buf.subarray(0, expected) : null
}

function averageFrameDelta(file: string, atA: number, atB: number): number | null {
  const a = scaledRawFrame(file, atA)
  const b = scaledRawFrame(file, atB)
  if (!a || !b) return null
  let total = 0
  let samples = 0
  for (let i = 0; i < Math.min(a.length, b.length); i += 4) {
    total += Math.abs((a[i] ?? 0) - (b[i] ?? 0))
    total += Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0))
    total += Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0))
    samples += 3
  }
  return samples ? total / samples : null
}

async function runSmokeBrollReal(): Promise<void> {
  const outDir = join(app.getPath('temp'), 'me-broll-real-out')
  const localDir = join(process.cwd(), 'test', 'fixtures', 'broll', 'local')
  const audioPath = join(process.cwd(), 'test', 'fixtures', 'audio', 'sample.mp3')
  const words: TranscriptWord[] = [
    { id: 'br-w0', projectId: 'broll-real', ord: 0, word: 'The', start: 0.1, end: 0.3, emphasis: false },
    { id: 'br-w1', projectId: 'broll-real', ord: 1, word: 'final', start: 0.3, end: 0.7, emphasis: true },
    { id: 'br-w2', projectId: 'broll-real', ord: 2, word: 'render', start: 0.7, end: 1.1, emphasis: false },
    { id: 'br-w3', projectId: 'broll-real', ord: 3, word: 'moves', start: 1.1, end: 1.5, emphasis: true }
  ]
  try {
    mkdirSync(outDir, { recursive: true })
    const caps = probeRenderCapabilities(true)
    const settings = {
      ...getSettings(),
      outputFolder: outDir,
      quality: '720p' as const,
      encoder: caps.hasNvenc ? 'nvenc' as const : 'cpu' as const,
      beta: { ...getSettings().beta, enabled: true }
    }
    const project: Project = {
      id: 'broll-real',
      downloadId: 'broll-real',
      title: 'Broll Real Smoke',
      channel: 'Mental Empire',
      mp3Path: audioPath,
      durationSec: 12,
      imageMode: 'sequence',
      poolSize: 2,
      kenBurns: false,
      seed: 1,
      crossfade: 0,
      captionPreset: 'Hormozi',
      captionFont: 'Anton',
      captionAnim: 'Pop-in',
      captionAspect: '16:9',
      captionPosition: 'bottom',
      emphasis: true,
      keywords: true,
      punchZoom: false,
      stage: 'queued',
      createdAt: new Date().toISOString(),
      betaOpts: { ...DEFAULT_BETA_OPTS, style: 'Clean', overlay: { ...DEFAULT_BETA_OPTS.overlay, bottom: true }, broll: { ...DEFAULT_BETA_OPTS.broll, enabled: true, poolSize: 2, density: 'sparse' } }
    }
    const assPath = join(outDir, 'broll-real.ass')
    writeFileSync(assPath, buildAss(words, { preset: 'Hormozi', aspect: '16:9', keywords: true }).ass)
    const outPath = join(outDir, 'broll-real.mp4')
    const logPath = join(outDir, 'broll-real.render.log')
    writeFileSync(logPath, '')

    process.env['ME_BROLL_LOCAL'] = localDir
    const manifest = await buildBrollManifest({
      settings,
      caps,
      words,
      durationSec: project.durationSec,
      density: 'sparse',
      poolSize: 2,
      dims: dimensions(settings.quality, project.captionAspect),
      fps: 30,
      jobId: `broll-real-${Date.now()}`,
      maxSegments: 4,
      logPath
    })
    delete process.env['ME_BROLL_LOCAL']
    if (!manifest) throw new Error('manifest missing')

    const progress: string[] = []
    await runRender({ project, images: [], assPath, outPath, settings, caps, brollManifestPath: manifest.manifestPath, jobId: 'broll-real', logPath }, (p) => {
      if (p.etaState === 'stable') progress.push(`pct=${p.pct} speed=${p.speed?.toFixed(2) ?? ''} eta=${p.etaSec ?? ''}`)
    })

    const probe = ffprobe(outPath)
    const stats = probe ? fixedFrameStats(outPath, probe, 0.75) : null
    const tailDelta = averageFrameDelta(outPath, 10.1, 11.1)
    const logTxt = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    const durationOk = !!probe && Math.abs(probe.duration - 12) < 0.75
    const streamOk = !!probe && probe.video && probe.audio && probe.vcodec === 'h264' && probe.acodec === 'aac'
    const frameOk = !!stats && stats.activePixels > 5_000 && stats.captionPixels > 250
    const tailMotionOk = tailDelta != null && tailDelta > 2.5
    const noCpuFallback = !logTxt.includes('[ffmpeg:fallback-cpu]')
    const gpuArgOk = !caps.hasNvenc || (logTxt.includes('-hwaccel cuda') && logTxt.includes('scale_cuda=') && logTxt.includes('h264_nvenc') && noCpuFallback)
    const overlayArgOk = logTxt.includes('overlay=0:0') && logTxt.includes('.pam') && !logTxt.includes('drawbox=') && !logTxt.includes('geq=')
    const progressOk = progress.length > 0
    const brollLogOk = logTxt.includes('[broll] manifest build start') && logTxt.includes('[broll] provider local pool') && logTxt.includes('[broll] clip local') && logTxt.includes('[broll] normalize') && logTxt.includes('[broll] manifest build done')
    const probeLogOk = logTxt.includes('[probe] output=') && logTxt.includes('durationSec=') && logTxt.includes('video=h264')
    const ok = durationOk && streamOk && frameOk && tailMotionOk && gpuArgOk && overlayArgOk && progressOk && brollLogOk && probeLogOk
    console.log(`SMOKE_BROLL_REAL encoder=${settings.encoder} cudaCaps=${caps.ffmpegHasCuda} duration=${probe?.duration?.toFixed(2) ?? 'n/a'} durationOk=${durationOk} stream=${streamOk} caption=${frameOk} tailDelta=${tailDelta?.toFixed(2) ?? 'n/a'} tailMotion=${tailMotionOk} gpuArgs=${gpuArgOk} noFallback=${noCpuFallback} overlay=${overlayArgOk} progress=${progressOk} brollLog=${brollLogOk} probeLog=${probeLogOk} out=${outPath}`)
    app.exit(ok ? 0 : 1)
  } catch (e) {
    delete process.env['ME_BROLL_LOCAL']
    console.log('SMOKE_BROLL_REAL_FAIL ' + (e as Error).message)
    app.exit(1)
  }
}

/**
 * Real GPU-worker B-roll render (ME_SMOKE=broll-gpu-real). Unlike runSmokeBrollReal
 * (which renders through the ffmpeg/CPU-filter graph), this exercises the exact path a
 * real user hits with an NVENC encoder selected: buildBrollManifest normalizes real local
 * clips with ffmpeg (as production does), then those normalized segments are handed to
 * the hidden-BrowserWindow GPU worker (runGpuRender) — the WebCodecs decode/composite/
 * encode pipeline in src/render-worker/{decoder,encoder}.ts that the NVDEC/NVENC-
 * contention stall fix targets. Requires a real NVENC-capable GPU; run on real hardware,
 * not under xvfb-run.
 */
async function runSmokeBrollGpuReal(): Promise<void> {
  const outDir = join(app.getPath('temp'), 'me-broll-gpu-real-out')
  const localDir = join(process.cwd(), 'test', 'fixtures', 'broll', 'local')
  const audioPath = join(process.cwd(), 'test', 'fixtures', 'audio', 'sample.mp3')
  const durationSec = 9
  try {
    mkdirSync(outDir, { recursive: true })
    const caps = probeRenderCapabilities(true)
    if (!caps.hasNvenc) {
      console.log('SMOKE_BROLL_GPU_REAL_SKIP no NVENC-capable GPU detected on this machine')
      app.exit(0)
      return
    }
    const settings = { ...getSettings(), outputFolder: outDir, quality: '720p' as const, encoder: 'nvenc' as const }
    const logPath = join(outDir, 'broll-gpu-real.render.log')
    writeFileSync(logPath, '')

    process.env['ME_BROLL_LOCAL'] = localDir
    const manifest = await buildBrollManifest({
      settings,
      caps,
      words: [],
      durationSec,
      density: 'full',
      poolSize: 3,
      dims: dimensions(settings.quality, '16:9'),
      fps: 24,
      jobId: `broll-gpu-real-${Date.now()}`,
      maxSegments: 3,
      logPath
    })
    delete process.env['ME_BROLL_LOCAL']
    if (!manifest?.segments.length) throw new Error('manifest missing or empty — normalize step failed before the GPU worker was ever reached')

    const { runGpuRender, destroyGpuWorker: destroyWorker } = await import('./services/engine/gpu/host')
    const h264Path = join(outDir, 'broll-gpu-real.gpu.mp4')
    const finalPath = join(outDir, 'broll-gpu-real.mp4')
    const spec = {
      jobId: 'broll-gpu-real',
      width: dimensions(settings.quality, '16:9').w,
      height: dimensions(settings.quality, '16:9').h,
      fps: 24,
      durationSec,
      images: [],
      broll: manifest.segments.map((s) => ({ path: s.normalizedPath, startSec: s.start, endSec: s.end })),
      motion: { kenBurns: false, punchAtSec: [] },
      grade: { style: 'None' as const, saturation: 1, contrast: 1, brightness: 0, colorBalance: { r: 0, g: 0, b: 0 }, vignette: 0, sharpen: 0 },
      grain: { strength: 0, temporal: false },
      captions: { groups: [], style: resolveCaptionStyle({ captionPreset: 'Minimal' }), preset: 'Clean' as const, font: 'Anton', animation: 'Pop-in', mode: 'word' as const, position: 'bottom' as const, lines: 1 as const, highlightColor: '#ffffff' },
      audio: { voicePath: audioPath },
      encoder: { codec: 'avc' as const, bitrateMbps: 6, keyIntervalSec: 2 },
      out: { h264Path, finalPath }
    }

    const progressed: number[] = []
    const startedAt = Date.now()
    await runGpuRender(spec, { logPath, onProgress: (p) => progressed.push(p.framesDone) })
    const elapsedMs = Date.now() - startedAt
    destroyWorker()

    const probe = ffprobe(finalPath)
    const durationOk = !!probe && Math.abs(probe.duration - durationSec) < 1
    const streamOk = !!probe && probe.video && probe.audio && probe.vcodec === 'h264'
    const progressOk = progressed.length > 1
    const ok = existsSync(finalPath) && durationOk && !!streamOk && progressOk
    console.log(`SMOKE_BROLL_GPU_REAL ok=${ok} elapsedMs=${elapsedMs} segments=${manifest.segments.length} duration=${probe?.duration?.toFixed(2) ?? 'n/a'} durationOk=${durationOk} stream=${streamOk} progress=${progressOk} out=${finalPath}`)
    app.exit(ok ? 0 : 1)
  } catch (e) {
    delete process.env['ME_BROLL_LOCAL']
    console.log('SMOKE_BROLL_GPU_REAL_FAIL ' + (e as Error).message)
    try {
      const { destroyGpuWorker: destroyWorker } = await import('./services/engine/gpu/host')
      destroyWorker()
    } catch { /* ignore */ }
    app.exit(1)
  }
}

/**
 * Full end-to-end journey (ME_SMOKE=e2e) on one continuous DB: fixture scrape +
 * download + transcript, REAL images, and a REAL ffmpeg render — probed with
 * ffprobe. Exercises the three render branches (multi-image+xfade, single image,
 * no-image lavfi fallback) plus J1 mapping and J4 webhook/login/scheduler.
 * Logs problems; prints E2E_OK only if all pass.
 */
async function runSmokeE2E(): Promise<void> {
  const repos = getRepos()
  const problems: string[] = []
  const check = (ok: boolean, label: string): void => {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`)
    if (!ok) problems.push(label)
  }
  const F = (p: string): string => join(process.cwd(), 'test', 'fixtures', p)
  const imgs = ['images/img1.png', 'images/img2.png', 'images/img3.png'].map(F)
  delete process.env['ME_RENDER_FIXTURE'] // real ffmpeg this run
  process.env['ME_WHISPER_FIXTURE'] = process.env['ME_WHISPER_FIXTURE'] || F('whisper/sample-words.json')

  try {
    setSettings({ outputFolder: join(app.getPath('temp'), 'me-e2e-out'), concurrency: 2, quality: '1080p', encoder: 'cpu' })

    // Deterministic state: production no longer seeds demo content, and prior smoke
    // runs share this userData DB — so wipe + seed the demo dataset for a clean journey.
    assertDisposableSmokeProfile(app.getPath('userData'))
    repos.resetAll()
    seedDemoForSmoke()

    // ---- J1: source ↔ my-channel mapping ----
    console.log('J1 — source↔channel mapping')
    const me = await refreshChannel('me')
    check(me.subs === '455' && repos.getUploads('me').length === 4, 'J1 stats + uploads parsed')
    check(me.mapTotal === 3 && me.mapDone === 2, `J1 ↔ chip mapDone/mapTotal (got ${me.mapDone}/${me.mapTotal})`)
    repos.updateChannelGoals('me', { weekGoal: 5, reminder: 'Fri Jun 27' })
    const ch = repos.myChannel('me')
    check(ch?.weekGoal === 5 && ch?.reminder === 'Fri Jun 27', 'J1 goal + reminder persist')
    check(checkReminders().some((h) => h.channelId === 'me'), 'J1 behind-pace reminder fires')

    // ---- J3/J5: pipeline → REAL render (3 branches) ----
    console.log('J3/J5 — pipeline + real render')
    const vids = await sourceVideos('https://www.youtube.com/@PowerWithinOfficial', 'Latest', 3)
    const dls = await startDownloads(vids, { bitrate: 192, sourceUrl: 'https://www.youtube.com/@PowerWithinOfficial' })
    check(dls.length === 3 && !!dls[0].filePath && existsSync(dls[0].filePath!), 'J5 downloaded 3 mp3s')

    // (a) multi-image + xfade + transcript
    const pA = createProject(dls[0].id)
    const imagesA = setImages(pA.id, imgs)
    check(imagesA.length === 3 && imagesA[2].rangeEnd === dls[0].durationSec, 'J5 even-split image ranges')
    const words = await runTranscribe(pA.id)
    check(words.length === 9, 'J5 transcript words')
    sendToRender(pA.id)
    // (b) single image
    const pB = createProject(dls[1].id)
    setImages(pB.id, [imgs[0]])
    sendToRender(pB.id)
    // (c) minimal single-image render. This case used to queue an audio-only project and
    //     exercise the render engine's solid-background (lavfi) fallback, but the redesign
    //     tightened validateRenderReady() to require visual media (images or usable B-roll)
    //     so users can't accidentally queue an all-black video — the behavior the Compose UI
    //     (and its client-side preflight) now enforces. An audio-only project therefore no
    //     longer passes the queue gate, so this branch supplies a still image. The engine's
    //     solid-background fallback code still exists but is no longer reachable via the
    //     render queue by design.
    const pC = createProject(dls[2].id)
    setImages(pC.id, [imgs[1]])
    sendToRender(pC.id)

    // (d) BETA image-mode: hook (with ASS-escaping chars) + overlay (all edges) + auto-zoom
    //     + Cinematic style + a pasted plan with a per-boundary transition & SFX. Beta ON.
    setSettings({ beta: { enabled: true } })
    const pBeta = createProject(dls[0].id)
    setImages(pBeta.id, imgs)
    repos.replaceTranscript(pBeta.id, words.map((w, i) => ({ ...w, id: `beta-w${i}`, projectId: pBeta.id })))
    repos.updateProject(pBeta.id, {
      kenBurns: false, punchZoom: false,
      betaOpts: {
        ...DEFAULT_BETA_OPTS,
        hook: { enabled: true, text: 'wait {for} it' }, // braces test ASS escaping
        overlay: { ...DEFAULT_BETA_OPTS.overlay, bottom: true, top: true, left: true, right: true },
        autoZoom: { atStart: true, atKeyPhrases: true },
        style: 'Cinematic',
        effectPlanJson: JSON.stringify({ transitions: [{ atSec: 6, type: 'circleopen', durationSec: 0.5, sfx: 'whoosh_soft' }], textEffects: [{ scope: 'hook', preset: 'intense-zoom' }] })
      }
    })
    sendToRender(pBeta.id)

    await runAll() // REAL ffmpeg, concurrency 2

    const probeJob = (id: string, label: string): void => {
      const job = repos.renderJob(`job-${id}`)
      const ok = job?.status === 'done' && !!job.outputPath && existsSync(job.outputPath)
      check(ok, `${label}: job done + mp4 on disk`)
      if (!ok) {
        console.log(`     job=${JSON.stringify({ status: job?.status, err: job?.error })}`)
        return
      }
      const p = ffprobe(job!.outputPath!)
      check(!!p && p.video && p.audio, `${label}: has video+audio stream`)
      check(!!p && p.width === 1920 && p.height === 1080, `${label}: 1920×1080 (got ${p?.width}×${p?.height})`)
      check(!!p && Math.abs(p.duration - 12) < 0.6, `${label}: matches audio ~12s (got ${p?.duration?.toFixed(1)})`)
      check(!!p && p.vcodec === 'h264' && p.acodec === 'aac', `${label}: h264/aac (got ${p?.vcodec}/${p?.acodec})`)
      check(existsSync(job!.outputPath!.replace(/\.mp4$/, '.ass')), `${label}: .ass written`)
      const logPath = job!.outputPath!.replace(/\.mp4$/, '.render.log')
      const logTxt = existsSync(logPath) ? readFileSyncSfx(logPath).toString() : ''
      check(logTxt.includes('[stage]') && logTxt.includes('[ffmpeg]') && logTxt.includes('[audio-master]') && logTxt.includes('[probe] output='), `${label}: render log has stages + ffmpeg + audio-master + probe`)
    }
    probeJob(pA.id, 'J5a multi-image+xfade')
    probeJob(pB.id, 'J5b single-image')
    probeJob(pC.id, 'J5c single-image (minimal visual)')

    // ---- J6: BETA features on REAL ffmpeg (duration drift is the key regression) ----
    console.log('J6 — beta features real render')
    probeJob(pBeta.id, 'J6a beta image (hook+overlay+zoom+transition+sfx)')
    const betaJob = repos.renderJob(`job-${pBeta.id}`)
    if (betaJob?.outputPath) {
      const bp = ffprobe(betaJob.outputPath)
      // The big bug class: beta filters/SFX must NOT push the output past the audio length.
      check(!!bp && Math.abs(bp.duration - 12) < 0.6, `J6a duration clamped to audio (got ${bp?.duration?.toFixed(2)})`)
      const assTxt = readFileSyncSfx(betaJob.outputPath.replace(/\.mp4$/, '.ass')).toString()
      check(assTxt.includes('Style: Hook'), 'J6a hook style burned')
      check(assTxt.includes('\\{FOR\\}'), 'J6a hook text ASS-escaped (no raw braces)')
      check(assTxt.includes(styleCaptionLead('Cinematic')), 'J6a Cinematic caption lead applied')
      check(assTxt.includes(textPresetTag('intense-zoom')), 'J6a per-word/hook text preset applied')
      const stats = bp ? fixedFrameStats(betaJob.outputPath, bp) : null
      check(!!stats && stats.activePixels > 5_000 && stats.captionPixels > 500, `J6a golden frame: nonblank + caption ink (active=${stats?.activePixels ?? 0}, caption=${stats?.captionPixels ?? 0}, yellow=${stats?.yellowPixels ?? 0})`)
      const lufs = loudnessI(betaJob.outputPath)
      check(lufs != null && Math.abs(lufs + 14) < 1.5, `J6a loudness near -14 LUFS (got ${lufs?.toFixed(2) ?? 'n/a'})`)
    }

    // J6b: REAL b-roll bed assembly + bed-mode render + SFX mix (amix normalize=0).
    // The synthetic clip must be LONGER than the 12s timeline so planCoverage's segments
    // (the sparse density plans a 9s first segment) are each satisfied from a single linear
    // read. A too-short clip (e.g. 6s covering a 9s segment) forces the render inputs onto
    // `-stream_loop -1`, and an infinitely-looped+seeked video input driving the full
    // single-pass filter chain (scale→xfade→grade→zoompan→overlay→libass) is what pegged the
    // 2-core CI ffmpeg for 20m. Real stock b-roll is likewise longer than a slot, so this
    // matches production, where looping rarely triggers. 13s covers 12s with margin.
    const clip = join(app.getPath('temp'), 'me-e2e-clip.mp4')
    execFileSync(ffmpegPath(), ['-y', '-f', 'lavfi', '-i', 'testsrc=d=13:s=640x360:r=30', '-pix_fmt', 'yuv420p', clip])
    // Crossfade bed: tailReserve gives the xfade overlap material; total must still be 12s.
    const segs = planCoverage(12, [{ path: clip, durationSec: 13 }], { density: 'sparse', tailReserve: 0.3 })
    const bedReal = await assembleBed(segs, { w: 1920, h: 1080 }, 30, 'fade')
    const bedProbe = ffprobe(bedReal)
    check(!!bedProbe && bedProbe.video && Math.abs(bedProbe.duration - 12) < 0.8, `J6b real crossfade bed covers 12s (got ${bedProbe?.duration?.toFixed(2)})`)
    const sfxTrack = buildSfxTrack([{ atSec: 4, type: 'fade', durationSec: 0.5, sfx: 'whoosh_soft' }, { atSec: 8, type: 'fade', durationSec: 0.5, sfx: 'impact_soft' }], 12)
    const bedOut = join(app.getPath('temp'), 'me-e2e-out', 'beta-bed.mp4')
    const bedAss = join(app.getPath('temp'), 'me-e2e-out', 'beta-bed.ass')
    writeFileSync(bedAss, buildAss(words, { preset: 'Hormozi', aspect: '16:9', keywords: false }).ass)
    // J6b's two renders exist to prove the b-roll GRAPH VARIANTS render valid a/v: the
    // bed-mode path (a pre-assembled full-length video fed as one input) and the
    // single-pass path (planned clips composed as direct xfade inputs). They are NOT here
    // to re-verify punch-zoom — J6a already does that (golden frame + LUFS).
    //
    // The catch: punchZoomFilter() applies a `zoompan` to the footage, and zoompan on a
    // real MULTI-FRAME video (the 12s bed / the xfaded segments) is pathologically slow on
    // ffmpeg's CPU path — it re-runs a high-precision zoom-scale on every one of the ~360
    // frames, single-threaded. On the 2-core CI runner that alone blows the 20m e2e budget.
    // Every render that passes (J5, J6a) only ever runs zoompan on `-loop 1` STILL images
    // (one source frame), which is why they finish in ~1s. So render the two b-roll
    // variants with motion OFF: the b-roll-specific graph (xfade/concat/bed + overlay +
    // libass + sfx amix + two-pass audio master) is still fully exercised on real ffmpeg,
    // just without the orthogonal zoompan that J6a already covers. Keep them small +
    // ultrafast too (the source is already 640x360, so no upscale).
    const j6bPreview = { previewDimensions: { w: 640, h: 360 }, cpuPreset: 'ultrafast' as const }
    const j6bProject = { ...repos.getProject(pBeta.id)!, motionPreset: 'off' as const }
    await runRender({ project: j6bProject, images: [], assPath: bedAss, outPath: bedOut, settings: getSettings(), videoBedPath: bedReal, sfxPath: sfxTrack ?? undefined, ...j6bPreview })
    const bo = ffprobe(bedOut)
    check(!!bo && bo.video && bo.audio && Math.abs(bo.duration - 12) < 0.6, `J6b bed-mode render: a/v + 12s (got ${bo?.duration?.toFixed(2)})`)
    check(!!bo && bo.vcodec === 'h264' && bo.acodec === 'aac', 'J6b bed-mode h264/aac')
    const directOut = join(app.getPath('temp'), 'me-e2e-out', 'beta-direct-broll.mp4')
    await runRender({ project: j6bProject, images: [], assPath: bedAss, outPath: directOut, settings: getSettings(), brollSegments: segs, transition: 'fade', sfxPath: sfxTrack ?? undefined, ...j6bPreview })
    const directProbe = ffprobe(directOut)
    check(!!directProbe && directProbe.video && directProbe.audio && Math.abs(directProbe.duration - 12) < 0.6, `J6b single-pass b-roll render: a/v + 12s (got ${directProbe?.duration?.toFixed(2)})`)
    check(!!directProbe && directProbe.vcodec === 'h264' && directProbe.acodec === 'aac', 'J6b single-pass b-roll h264/aac')

    // J6c: validator robustness (garbage / extremes) + ASS-escaping never throws.
    let validatorSafe = true
    try {
      validateEffectPlan('not json{{{', 12)
      validateEffectPlan({ transitions: [{ atSec: -5, type: 'x', durationSec: 99 }], textEffects: 'nope' }, 12)
      buildAss(words, { preset: 'Hormozi', aspect: '16:9', keywords: false, hook: { text: 'a {b} \\ c: "d"', untilSec: 2 } })
    } catch { validatorSafe = false }
    check(validatorSafe, 'J6c validator + ASS escaping never throw on bad input')

    // J6d: beta-OFF parity — disabling beta yields the pre-beta arg string (no overlay/amix/Hook).
    const offArgs = buildRenderArgs({ project: { ...repos.getProject(pBeta.id)!, betaOpts: undefined }, images: setImages(createProject(dls[1].id).id, imgs), assPath: bedAss, outPath: bedOut, settings: { ...getSettings(), beta: { ...getSettings().beta, enabled: false } } }).join(' ')
    check(!offArgs.includes('overlay=0:0') && !offArgs.includes('amix'), 'J6d beta-off render args clean (no overlay/sfx)')
    setSettings({ beta: { enabled: false } })

    // ---- J4: webhook + login + scheduler ----
    console.log('J4 — auto-scrape/background plumbing')
    const received: Array<Record<string, unknown>> = []
    const { createServer } = await import('node:http')
    const server = createServer((req, res) => {
      let b = ''
      req.on('data', (d) => (b += d))
      req.on('end', () => { try { received.push(JSON.parse(b)) } catch { /* */ } res.end('ok') })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    setSettings({ background: { webhook: `http://127.0.0.1:${port}` } })
    await postWebhook('e2e', { ok: true })
    for (let i = 0; i < 30 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 50))
    check(received.some((r) => r.event === 'e2e'), 'J4 webhook POST delivered')
    server.close()
    setSettings({ background: { webhook: '' } })
    let loginOk = true
    try { applyLoginItem({ ...getSettings(), background: { ...getSettings().background, startOnSignIn: true } }) } catch { loginOk = false }
    check(loginOk, 'J4 setLoginItemSettings no-throw')
    check(scheduler.frequencyToMs('Daily') === 86_400_000, 'J4 frequency map')

    console.log(problems.length ? `E2E_PROBLEMS ${JSON.stringify(problems)}` : 'E2E_OK')
    closeDatabase()
    app.exit(problems.length ? 1 : 0)
  } catch (e) {
    console.log(`E2E_FAIL ${(e as Error).message}`)
    console.log((e as Error).stack)
    closeDatabase()
    app.exit(1)
  }
}

/**
 * ME_DEMO: render one realistic faceless-YouTube video through the REAL production
 * pipeline (the same code a user's "Render all" runs) with the full beta stack on —
 * Hormozi karaoke captions + keyword emphasis, hook intro card, background overlay,
 * auto-zoom, Cinematic transitions + subtle SFX, and per-word text effects. Images +
 * mp3 come from env (generated by the caller). Prints DEMO_OUT=<mp4 path>.
 */
async function runDemoRender(): Promise<void> {
  const repos = getRepos()
  delete process.env['ME_RENDER_FIXTURE'] // real ffmpeg
  const outDir = process.env['ME_DEMO_OUT'] || join(app.getPath('temp'), 'me-demo')
  setSettings({ outputFolder: outDir, quality: '1080p', beta: { enabled: true, pexelsKey: '', pixabayKey: '', coverrKey: '' } })
  const images = (process.env['ME_DEMO_IMAGES'] || '').split(',').filter(Boolean)
  const mp3 = process.env['ME_DEMO_MP3'] || join(process.cwd(), 'test', 'fixtures', 'audio', 'sample.mp3')
  const dur = Number(process.env['ME_DEMO_DUR'] || '12')

  // A motivational line spread across the audio, with a few emphasized keywords.
  const line = 'THE NARCISSIST KNOWS YOU WILL NEVER COME BACK AND DEEP DOWN IT TERRIFIES THEM'
  const toks = line.split(' ')
  const per = dur / toks.length
  const emph = new Set(['KNOWS', 'NEVER', 'TERRIFIES'])
  const pid = `demo-${Date.now()}`
  const words = toks.map((w, i) => ({ id: `dw${i}`, projectId: pid, ord: i, word: w, start: +(i * per).toFixed(2), end: +((i + 1) * per).toFixed(2), emphasis: emph.has(w) }))

  repos.createProject({
    id: pid, downloadId: pid, title: 'Why The Narcissist Can Never Move On', channel: 'Mental Empire',
    mp3Path: mp3, durationSec: dur, imageMode: 'sequence', poolSize: 1, kenBurns: false, seed: 7, crossfade: 0.8,
    captionPreset: 'Hormozi', captionFont: 'Anton', captionAnim: 'Pop-in', captionAspect: '16:9',
    emphasis: true, keywords: true, punchZoom: false, stage: 'queued', createdAt: new Date().toISOString(),
    betaOpts: {
      hook: { enabled: true, text: 'they will never admit this' },
      autoHighlight: true,
      overlay: { ...DEFAULT_BETA_OPTS.overlay, bottom: true },
      autoZoom: { atStart: true, atKeyPhrases: true },
      broll: { enabled: !!process.env['ME_BROLL_LOCAL'], density: 'full', poolSize: 6, mode: 'full' },
      style: 'Cinematic',
      effectPlanJson: JSON.stringify({
        transitions: [
          { atSec: +(dur / 3).toFixed(1), type: 'fadeblack', durationSec: 0.5, sfx: 'whoosh_soft' },
          { atSec: +((dur * 2) / 3).toFixed(1), type: 'circleopen', durationSec: 0.5, sfx: 'impact_soft' }
        ],
        textEffects: [{ scope: 'hook', preset: 'cinematic-pop' }, { word: 'NEVER', preset: 'intense-zoom' }, { word: 'TERRIFIES', preset: 'intense-zoom' }]
      })
    }
  })
  if (images.length) setImages(pid, images)
  repos.replaceTranscript(pid, words)
  repos.createRenderJob({ id: `job-${pid}`, title: 'Demo', channel: 'Mental Empire', projectId: pid })
  console.log('DEMO_RENDER start — real ffmpeg, full beta stack…')
  await runAll()
  const job = repos.renderJob(`job-${pid}`)
  console.log(`DEMO_STATUS ${job?.status} ${job?.error ?? ''}`)
  if (job?.outputPath) console.log(`DEMO_OUT ${job.outputPath}`)
  closeDatabase()
  app.exit(job?.status === 'done' ? 0 : 1)
}

/** Automation-specific end-to-end smoke. Uses a real local audio fixture, real image
 * import, the durable supervisor, SQLite checkpoints, and a real ffmpeg encode. It
 * also simulates an interrupted persisted row to prove startup recovery preserves a
 * completed checkpoint. Run with ME_SMOKE=automation and an isolated user-data dir. */
async function runSmokeAutomation(): Promise<void> {
  const repos = getRepos()
  const problems: string[] = []
  const check = (ok: boolean, label: string): void => {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`)
    if (!ok) problems.push(label)
  }
  const fixture = (path: string): string => join(process.cwd(), 'test', 'fixtures', path)
  const output = join(app.getPath('temp'), `me-automation-smoke-${process.pid}`)
  delete process.env['ME_RENDER_FIXTURE']
  try {
    assertDisposableSmokeProfile(app.getPath('userData'))
    repos.resetAll()
    setSettings({ outputFolder: output, libraryFolder: output, quality: '720p', encoder: 'cpu', renderEngine: 'ffmpeg', beta: { enabled: false } })
    const draft: AutomationJobDraft = {
      name: 'Local fixture to finished video',
      goal: 'source-to-export',
      config: {
        sourceKind: 'local-files', sourceId: '', sourceUrl: '', sourceName: 'sample.mp3', sourceOrder: 'Latest', sourceCount: 1,
        selectedVideoIds: [], localMediaPaths: [fixture('audio/sample.mp3')], assetPaths: [fixture('images/img1.png')],
        style: 'Clean', captionPreset: 'Hormozi', aspectRatios: ['16:9'], execution: 'local',
        styleConfig: { videoStyle: 'Clean', captionPreset: 'Hormozi', captionFont: 'Montserrat', captionAnimation: 'Pop-in', captionPosition: 'bottom', captionLines: 1, captionPace: 'auto', wordsPerCaption: 2, highlightColor: '#f5b323', boxColor: '#111111', imageMode: 'sequence', crossfadeSec: 0.8, motionPreset: 'subtle', gradientEdge: 'none', gradientIntensity: 50, aspectRatio: '16:9', brollMode: 'off', brollDensity: 'sparse', brollPoolSize: 18, brollFallbackPolicy: 'prefer-selected', brollShufflePolicy: 'per-video' },
        rules: { minDurationSec: 0, skipDownloaded: true, continueOnError: true, maxRetries: 1, minimumFreeSpaceGb: 1, captions: false, autoBroll: false, removeSilence: false, reduceFillerWords: false, keepAwake: false, skipUploaded: true, fillSkippedSelections: false, allowStaleUploadCache: true, uploadFreshnessMinutes: 360, downloadDelaySec: 0, retryBaseDelaySec: 1, retryMaxDelaySec: 2 },
        notify: { desktop: false, webhook: false, sound: false, email: false }
      }
    }
    const preflight = preflightAutomation(draft)
    check(preflight.ok, `preflight passes (${preflight.blockers.join('; ') || 'no blockers'})`)
    process.env['ME_AUTOMATION_FAIL_ONCE'] = 'preflight'
    const created = createAutomationJob(draft)
    check(created.status === 'queued' && created.steps.length === 8, 'job and generated workflow persist before processing')
    startAutomationSupervisor()
    let finished = getAutomationJob(created.id)
    for (let attempt = 0; attempt < 360 && finished && !['completed','completed_with_warnings','attention','failed','cancelled'].includes(finished.status); attempt++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 500))
      finished = getAutomationJob(created.id)
    }
    check(finished?.status === 'completed', `job completes (status=${finished?.status}, error=${finished?.error || 'none'})`)
    check(finished?.steps.find((step) => step.key === 'preflight')?.attempts === 2, 'temporary failure retries automatically and then succeeds')
    check(finished?.logs.some((row) => row.level === 'warning' && row.message.includes('retry automatically')) === true, 'automatic retry is explained in the job log')
    delete process.env['ME_AUTOMATION_FAIL_ONCE']
    check(finished?.steps.every((step) => step.status === 'completed') === true, 'every workflow step has a completed checkpoint')
    const outputPath = finished?.result?.outputPaths[0]
    check(!!outputPath && existsSync(outputPath), `verified output exists (${outputPath || 'missing'})`)
    const media = outputPath ? ffprobe(outputPath) : null
    check(!!media?.video && !!media?.audio && media.duration > 11 && media.duration < 13, `output has video+audio and expected duration (${media?.duration ?? 0}s)`)
    const durableAsset = repos.listAssets()[0]
    const renderedItem = finished?.items.find((item) => !!item.projectId)
    const projectImage = renderedItem?.projectId ? repos.getProjectImages(renderedItem.projectId)[0] : undefined
    check(!!durableAsset && existsSync(durableAsset.canonicalPath) && durableAsset.canonicalPath.includes(join(app.getPath('userData'), 'asset-library')), 'asset is stored in the canonical shared library')
    check(!!projectImage && !!durableAsset && projectImage.path !== durableAsset.canonicalPath, 'project uses an independent asset copy, so project cleanup cannot remove the library original')

    const recoveryDraft: AutomationJobDraft = {
      ...draft,
      name: 'Interrupted recovery fixture',
      config: { ...draft.config, scheduledFor: new Date(Date.now() + 3_600_000).toISOString() }
    }
    const recovery = createAutomationJob(recoveryDraft)
    const firstStep = recovery.steps[0]
    repos.updateAutomationStep(firstStep.id, { status: 'completed', progress: 100, checkpoint: { verified: true }, completedAt: new Date().toISOString() })
    repos.updateAutomationJob(recovery.id, { status: 'running', currentStep: 'Interrupted fixture' })
    stopAutomationSupervisor()
    startAutomationSupervisor()
    const recovered = getAutomationJob(recovery.id)
    check(recovered?.status === 'queued' && recovered.currentStep.includes('Recovering'), 'startup converts interrupted work to recoverable queued state')
    check(recovered?.steps[0].status === 'completed' && recovered.steps[0].checkpoint?.verified === true, 'startup preserves completed step checkpoint')

    const control = createAutomationJob({ ...recoveryDraft, name: 'Control fixture', config: { ...recoveryDraft.config, scheduledFor: new Date(Date.now() + 7_200_000).toISOString() } })
    pauseAutomationJob(control.id)
    check(getAutomationJob(control.id)?.status === 'paused', 'queued job pauses persistently')
    resumeAutomationJob(control.id)
    check(getAutomationJob(control.id)?.status === 'queued', 'paused job resumes to the durable queue')
    cancelAutomationJob(control.id)
    check(getAutomationJob(control.id)?.status === 'cancelled', 'queued job cancels without deleting checkpoints')

    stopAutomationSupervisor()
    mkdirSync(output, { recursive: true })
    const disappearingMedia = join(output, 'disappearing-after-preflight.mp3')
    copyFileSync(fixture('audio/sample.mp3'), disappearingMedia)
    const batchDraft: AutomationJobDraft = {
      ...draft,
      name: 'Continue-on-error batch fixture',
      goal: 'batch-source',
      config: { ...draft.config, sourceName: 'Two local files', sourceCount: 2, localMediaPaths: [fixture('audio/sample.mp3'), disappearingMedia] }
    }
    const batch = createAutomationJob(batchDraft)
    const batchPreflight = batch.steps.find((step) => step.key === 'preflight')!
    repos.updateAutomationStep(batchPreflight.id, { status: 'completed', progress: 100, checkpoint: { verifiedBeforeInputDisappeared: true }, completedAt: new Date().toISOString() })
    unlinkSync(disappearingMedia)
    startAutomationSupervisor()
    let batchFinished = getAutomationJob(batch.id)
    for (let attempt = 0; attempt < 180 && batchFinished && !['completed','completed_with_warnings','attention','failed','cancelled'].includes(batchFinished.status); attempt++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 250))
      batchFinished = getAutomationJob(batch.id)
    }
    check(batchFinished?.status === 'completed_with_warnings', `batch continues after a permanent item failure (status=${batchFinished?.status})`)
    check(batchFinished?.failedCount === 1 && batchFinished.completedCount === 1, 'batch summary isolates one failed item and keeps one completed output')
    check(batchFinished?.items.some((item) => item.status === 'failed' && item.error?.includes('missing')) === true, 'failed item keeps an actionable missing-file explanation')
    check((batchFinished?.result?.outputPaths.length ?? 0) === 1, 'successful batch item retains its verified output')

    stopAutomationSupervisor()
    console.log(problems.length ? `AUTOMATION_SMOKE_PROBLEMS ${JSON.stringify(problems)}` : `AUTOMATION_SMOKE_OK output=${outputPath}`)
    closeDatabase()
    app.exit(problems.length ? 1 : 0)
  } catch (error) {
    stopAutomationSupervisor()
    console.log(`AUTOMATION_SMOKE_FAIL ${(error as Error).message}`)
    console.log((error as Error).stack)
    closeDatabase()
    app.exit(1)
  }
}

/** Remove transient render artifacts (e.g. per-render SFX WAVs) left in temp by a
 *  previous, possibly crashed, run so they don't accumulate. Crash-proof. */
function sweepTempArtifacts(): void {
  try {
    rmSync(join(app.getPath('temp'), 'me-sfx'), { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

app.whenReady().then(() => {
  initPersistence()
  registerIpc()
  sweepTempArtifacts()

  if (process.env['ME_GPU_SELFTEST']) {
    void (async () => {
      try {
        const { runGpuSelfTest, destroyGpuWorker } = await import('./services/engine/gpu/host')
        const result = await runGpuSelfTest()
        destroyGpuWorker()
        if (result.ok) {
          console.log(`SELFTEST_OK timeMs=${result.timeMs}`)
          app.exit(0)
        } else {
          console.error(`SELFTEST_FAIL error=${result.error}`)
          app.exit(1)
        }
      } catch (err) {
        console.error(`SELFTEST_FAIL error=${(err as Error).message}`)
        app.exit(1)
      }
    })()
    return
  }

  if (process.env['ME_DEMO']) {
    void runDemoRender()
    return
  }
  if (process.env['ME_SMOKE'] === 'e2e') {
    void runSmokeE2E()
    return
  }
  if (process.env['ME_SMOKE'] === 'automation') {
    void runSmokeAutomation()
    return
  }
  if (process.env['ME_SMOKE'] === 'broll-real') {
    void runSmokeBrollReal()
    return
  }
  if (process.env['ME_SMOKE'] === 'broll-gpu-real') {
    void runSmokeBrollGpuReal()
    return
  }
  // Demo-dependent smokes (M2–M7) assert against deterministic seeded rows. Production
  // now starts clean, so the harness seeds the demo dataset explicitly here.
  if (['1', 'm3', 'm4', 'm5', 'm6', 'm7'].includes(process.env['ME_SMOKE'] ?? '')) {
    assertDisposableSmokeProfile(app.getPath('userData'))
    seedDemoForSmoke()
  }
  if (process.env['ME_SMOKE'] === 'm7') {
    void runSmokeM7()
    return
  }
  if (process.env['ME_SMOKE'] === 'm6') {
    void runSmokeM6()
    return
  }
  if (process.env['ME_SMOKE'] === 'm5') {
    void runSmokeM5()
    return
  }
  if (process.env['ME_SMOKE'] === 'm4') {
    void runSmokeM4()
    return
  }
  if (process.env['ME_SMOKE'] === 'm3') {
    void runSmokeM3()
    return
  }
  if (process.env['ME_SMOKE']) {
    runSmokeTest()
    return
  }

  // UI screenshot seeding (ME_SHOOT + ME_SHOOT_SEED=1): one REAL fixture-backed
  // download + composed project (images + transcript) so the editor screens can be
  // captured with data. Mirrors the M4 flow but writes rows directly for determinism.
  if (process.env['ME_SHOOT'] && process.env['ME_SHOOT_SEED']) {
    try {
      const repos = getRepos()
      assertDisposableSmokeProfile(app.getPath('userData'))
      repos.resetAll()
      const fixtures = join(process.cwd(), 'test', 'fixtures')
      const dlId = 'dl-shoot-0000000001-0'
      repos.upsertDownload({
        id: dlId,
        sourceId: 'src-shoot',
        title: 'Why Discipline Beats Motivation',
        channel: '@powerwithin',
        size: '1.2 MB',
        when: 'now',
        stage: 'Downloaded only',
        pct: '100%',
        action: 'Open',
        thumb: ''
      })
      repos.setDownloadProgress(dlId, { filePath: join(fixtures, 'audio', 'sample.mp3'), durationSec: 12, pct: '100%', stage: 'Downloaded only', action: 'Open' })
      const project = createProject(dlId)
      setImages(project.id, ['img1.png', 'img2.png', 'img3.png'].map((n) => join(fixtures, 'images', n)))
      const whisper = JSON.parse(readFileSync(join(fixtures, 'whisper', 'sample-words.json'), 'utf8')) as { words: Array<{ word: string; start: number; end: number }> }
      repos.replaceTranscript(project.id, whisper.words.map((w, i) => ({ id: `shoot-w${i}`, projectId: project.id, ord: i, word: w.word, start: w.start, end: w.end, emphasis: i % 4 === 1 })))
      console.log(`SHOOT_SEED_OK project=${project.id}`)
    } catch (e) {
      console.log(`SHOOT_SEED_FAIL ${(e as Error).message}`)
    }
  }

  const startHidden = shouldStartHidden()
  if (!startHidden) createWindow()

  // Headless screenshot (ME_SHOOT=<png path>): wait for the renderer to settle,
  // capture, then exit. With ME_BATCH=1, also drive the Thumbnails "Generate all"
  // button and report how many PNGs the renderer rasterized + wrote (M5 check).
  const shootPath = process.env['ME_SHOOT']
  if (shootPath) {
    if (!mainWindow) createWindow()
    mainWindow!.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const wc = mainWindow!.webContents
        const accent = await wc.executeJavaScript('document.documentElement.getAttribute("data-accent")')
        // ME_SHOOT_NAV=<sidebar label>: click that nav item before capturing, so a
        // screenshot can target any screen (not just the one the app boots to).
        const navLabel = process.env['ME_SHOOT_NAV']
        if (navLabel) {
          await wc.executeJavaScript(
            `(() => { const items=[...document.querySelectorAll('.me-nav')]; const el=items.find(e=>e.textContent.trim().startsWith(${JSON.stringify(navLabel)})); if(el){el.click();return true;} return false; })()`
          )
          await new Promise((r) => setTimeout(r, 400))
        }
        // ME_SHOOT_CLICKS=<comma-separated texts>: after the nav click, click each in
        // order (any element whose own trimmed text starts with it, deepest-first so a
        // button's own label wins over an ancestor container), waiting briefly between.
        const clickSeq = process.env['ME_SHOOT_CLICKS']
        if (clickSeq) {
          for (const text of clickSeq.split(',')) {
            await wc.executeJavaScript(
              `(() => { const all=[...document.querySelectorAll('button,span,div')].reverse(); const el=all.find(e=>e.textContent.trim().startsWith(${JSON.stringify(text)}) && e.offsetParent); if(el){el.click();return true;} return false; })()`
            )
            await new Promise((r) => setTimeout(r, 400))
          }
        }
        if (process.env['ME_SHOOT_SCROLL']) {
          await wc.executeJavaScript(
            '(() => { const el=[...document.querySelectorAll("div")].find(e=>e.scrollHeight>e.clientHeight+40); if(el) el.scrollTop=el.scrollHeight; })()'
          )
          await new Promise((r) => setTimeout(r, 200))
        }
        const img = await wc.capturePage()
        const fs = await import('node:fs')
        fs.writeFileSync(shootPath, img.toPNG())
        console.log(`SHOOT_OK accent=${accent} -> ${shootPath}`)

        if (process.env['ME_BATCH']) {
          await wc.executeJavaScript(
            `(() => { const b=[...document.querySelectorAll('button,div')].find(e=>e.textContent.trim().startsWith('Generate all')); if(b){b.click();return true;} return false; })()`
          )
          await new Promise((r) => setTimeout(r, 3500)) // let 4 rasterizations + writes land
          // writePng lands ad-hoc PNGs in <outputFolder>/_cache/thumbnails (see ipc/thumbnails.ts)
          const dir = join(getSettings().outputFolder || app.getPath('temp'), '_cache', 'thumbnails')
          let pngs: string[] = []
          try {
            pngs = fs.readdirSync(dir).filter((f) => f.endsWith('.png'))
          } catch {
            /* no dir */
          }
          const valid = pngs.filter((f) => {
            const head = fs.readFileSync(join(dir, f)).subarray(0, 4)
            return head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
          })
          console.log(`SHOOT_BATCH pngs=${pngs.length} valid=${valid.length} dir=${dir}`)
          console.log(valid.length >= 4 ? 'SHOOT_BATCH_OK' : 'SHOOT_BATCH_FAIL')
        }

        // ME_RUNPROFILE=1: click a profile's "Run" in the real UI → window.api →
        // automation.runProfile → projects in the DB. Proves the Profiles screen wiring.
        if (process.env['ME_RUNPROFILE']) {
          const before = getRepos().listProjects().length
          const clicked = await wc.executeJavaScript(
            `(() => { const b=[...document.querySelectorAll('div')].find(e=>e.textContent.trim()==='▶ Run'); if(b){b.click();return true;} return false; })()`
          )
          await new Promise((r) => setTimeout(r, 4000)) // scrape + download (fixtures) + project create
          const after = getRepos().listProjects().length
          console.log(`SHOOT_RUNPROFILE clicked=${clicked} projectsBefore=${before} projectsAfter=${after}`)
          console.log(clicked && after > before ? 'SHOOT_RUNPROFILE_OK' : 'SHOOT_RUNPROFILE_FAIL')
        }
        app.exit(0)
      }, 1100)
    })
  }

  // Headless thumbnail render (ME_THUMB=<png path>) from REAL background + subject
  // PNGs (ME_THUMB_BG / ME_THUMB_SUBJECT) through the production Konva rasterizer.
  const thumbPath = process.env['ME_THUMB']
  if (thumbPath && mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const wc = mainWindow!.webContents
        const fs = await import('node:fs')
        const toDataUrl = (p?: string): string =>
          p && fs.existsSync(p) ? `data:image/png;base64,${fs.readFileSync(p).toString('base64')}` : ''
        const bg = toDataUrl(process.env['ME_THUMB_BG'])
        const subject = toDataUrl(process.env['ME_THUMB_SUBJECT'])
        const layers = [
          {
            id: 'headline', kind: 'text', name: 'Headline', visible: true, locked: false,
            frame: { x: 70, y: 372, width: 720, height: 300, rotation: 0 },
            text: 'THEY LIED TO YOU', lines: [{ text: 'THEY LIED', size: 118 }, { text: 'TO YOU', size: 150 }],
            highlightWord: 'LIED', highlightColor: '#ffd400', highlightSquare: true, color: '#ffffff',
            fontFamily: 'Anton', align: 'left',
            effects: { shadow: { enabled: true, color: '#000000', size: 0, opacity: 0.65, distance: 7, angle: 45 }, stroke: { enabled: true, color: '#000000', size: 7, opacity: 1 }, glow: { enabled: false, color: '#ffffff', size: 26, opacity: 0.85 }, caps: true }
          },
          {
            id: 'subject', kind: 'subject', name: 'Subject', visible: true, locked: false,
            frame: { x: 700, y: 70, width: 520, height: 650, rotation: 0 }, src: subject,
            outline: { enabled: true, color: '#ffffff', size: 7, opacity: 1 },
            shadow: { enabled: true, color: '#000000', size: 30, opacity: 0.7, distance: 12, angle: 90 },
            glow: { enabled: false, color: '#19c3d6', size: 30, opacity: 0.85 }
          },
          {
            id: 'bg', kind: 'background', name: 'Background', visible: true, locked: true,
            frame: { x: 0, y: 0, width: 1280, height: 720, rotation: 0 },
            fill: '#1a1230', mode: bg ? 'image' : 'gradient', src: bg
          }
        ]
        const dataUrl: string = await wc.executeJavaScript(
          `window.__meThumb.rasterizeLayers(${JSON.stringify(layers)})`
        )
        const out: string = await wc.executeJavaScript(
          `window.api.thumbnails.writePng('demo-thumb', ${JSON.stringify(dataUrl)})`
        )
        const valid = fs.existsSync(out) && (() => { const h = fs.readFileSync(out).subarray(0, 4); return h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47 })()
        if (valid) fs.copyFileSync(out, thumbPath)
        console.log(`THUMB_OUT ${out}`)
        console.log(valid ? 'THUMB_OK' : 'THUMB_FAIL')
        app.exit(valid ? 0 : 1)
      }, 1200)
    })
  }

  // M7 background automation: tray, start-on-sign-in, and the auto-watch scheduler.
  // Screenshot validation is read-only unless its explicit seed/run flags are set;
  // never let a UI capture unexpectedly advance the user's queued Automation jobs.
  if (!process.env['ME_SHOOT']) {
    buildTray()
    applyLoginItem(getSettings())
    scheduler.start()
    startAutomationSupervisor()
    startTalkingPhotosPoller()
  }
  // M8 auto-update (packaged production builds only).
  void initAutoUpdate()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showWindow()
  })
})

app.on('before-quit', () => {
  isQuitting = true
  scheduler.stop()
  stopAutomationSupervisor()
  stopTalkingPhotosPoller()
  // Tear down the hidden GPU render-worker window if it was created.
  destroyGpuWorker()
  // Close the DB here too: with the tray enabled, the real quit comes through here
  // (not window-all-closed), so this is the only path that checkpoints the WAL cleanly.
  closeDatabase()
})

app.on('window-all-closed', () => {
  // With the tray enabled the app stays resident for auto-watch; otherwise quit
  // (except macOS, which conventionally keeps apps alive).
  if (getSettings().background.tray) return
  if (process.platform !== 'darwin') {
    closeDatabase()
    app.quit()
  }
})
