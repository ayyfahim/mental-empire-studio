import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings, ScrapedVideo } from '../../shared/types'
import { resolveBinDir, resolveYtdlpPath } from './bin'
import { formatOutputName } from './audio'
import { L } from './logger'

/** Vendored ffmpeg dir if present, else undefined → yt-dlp falls back to PATH.
 *  yt-dlp's mp3 extraction needs BOTH ffmpeg and ffprobe in the same dir; we log a
 *  clear error if ffprobe is missing (the usual "ffprobe and ffmpeg not found" cause). */
function vendoredFfmpegDir(): string | undefined {
  const dir = resolveBinDir()
  const win = process.platform === 'win32'
  const hasFfmpeg = existsSync(join(dir, win ? 'ffmpeg.exe' : 'ffmpeg'))
  const hasFfprobe = existsSync(join(dir, win ? 'ffprobe.exe' : 'ffprobe'))
  if (hasFfmpeg && !hasFfprobe) {
    L.error(`downloader: ffmpeg found but ffprobe MISSING in ${dir} — yt-dlp mp3 extraction will fail. Run \`npm run fetch:bin\` or reinstall.`)
  }
  return hasFfmpeg ? dir : undefined
}

// Downloads a source video's audio as mp3 via yt-dlp (+ vendored ffmpeg for the
// extraction). Resume-aware: an already-complete file is never re-fetched. In the
// sandbox (no ffmpeg / YouTube blocked) ME_DOWNLOAD_FIXTURE copies a sample mp3 so
// the surrounding history/probe/range logic is exercised for real.

export interface DownloadResult {
  filePath: string
  skipped: boolean
}

export interface DownloadParams {
  video: ScrapedVideo
  downloadId?: string
  channel: string
  outDir: string
  bitrate: number
  settings: AppSettings
  onProgress?: (pct: number) => void
}

const runningDownloads = new Map<string, ChildProcess>()
const cancelIntents = new Set<string>()

// A hung yt-dlp (network stall, throttling, interactive prompt) would otherwise never
// resolve and stall the whole batch / auto-watch run. Kill it if no output arrives for
// STALL_MS, or if the whole download exceeds HARD_MS.
const STALL_MS = 120_000
const HARD_MS = 30 * 60_000

export function cancelDownload(downloadId: string): boolean {
  const child = runningDownloads.get(downloadId)
  if (!child) return false
  // Only record the intent when a child is actually running, so a stale intent can't
  // linger and cancel a later download that reuses the same id.
  cancelIntents.add(downloadId)
  child.kill('SIGKILL')
  runningDownloads.delete(downloadId)
  return true
}

function consumeCancel(downloadId?: string): boolean {
  if (!downloadId || !cancelIntents.has(downloadId)) return false
  cancelIntents.delete(downloadId)
  return true
}

export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`
}

/** Target mp3 path for a video, named via the Settings template. */
export function targetPath(outDir: string, channel: string, title: string): string {
  return join(outDir, `${formatOutputName('{channel} - {title}', { channel, title })}.mp3`)
}

export async function downloadAudio(params: DownloadParams): Promise<DownloadResult> {
  const { video, downloadId, channel, outDir, bitrate, settings, onProgress } = params
  mkdirSync(outDir, { recursive: true })
  const dest = targetPath(outDir, channel, video.title)

  // Resume: a finished file is reused, never re-downloaded.
  if (existsSync(dest) && statSync(dest).size > 0) {
    onProgress?.(100)
    return { filePath: dest, skipped: true }
  }

  // Offline seam: copy a recorded sample mp3 to simulate a completed download.
  const fixture = process.env['ME_DOWNLOAD_FIXTURE']
  if (fixture) {
    copyFileSync(fixture, dest)
    onProgress?.(100)
    return { filePath: dest, skipped: false }
  }

  await runYtdlpDownload(video, dest, bitrate, settings, onProgress, downloadId)
  return { filePath: dest, skipped: false }
}

function runYtdlpDownload(
  video: ScrapedVideo,
  dest: string,
  bitrate: number,
  settings: AppSettings,
  onProgress?: (pct: number) => void,
  downloadId?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const a = settings.autoScrape
    const args = [
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', `${bitrate}K`,
      '--newline',
      '--continue',
      '--no-warnings',
      '--js-runtimes', 'node',
      // Self-recover from transient network stalls before our watchdog has to step in.
      '--socket-timeout', '30',
      '--retries', '5',
      '--fragment-retries', '5',
      // YouTube/CDN 403 and 429 responses are often temporary. Pace requests and let
      // yt-dlp retry before the Automation supervisor performs its own bounded retry.
      '--retry-sleep', 'http:5',
      '--retry-sleep', 'fragment:3',
      '--sleep-requests', '1',
      '-o', dest.replace(/\.mp3$/, '.%(ext)s')
    ]
    const ffmpegDir = vendoredFfmpegDir()
    if (ffmpegDir) args.push('--ffmpeg-location', ffmpegDir)
    else L.warn('downloader: no vendored ffmpeg found — mp3 extraction may fail')
    if (a.proxy) args.push('--proxy', a.proxy)
    if (a.cookiesPath) args.push('--cookies', a.cookiesPath)
    args.push(watchUrl(video.id))

    const bin = resolveYtdlpPath()
    L.info(`yt-dlp download: ${bin} ${args.join(' ')}`)
    if (!existsSync(bin)) L.error(`yt-dlp binary missing at ${bin} — download will fail`)
    const child = spawn(bin, args, { windowsHide: true })
    if (downloadId) runningDownloads.set(downloadId, child)
    let err = ''
    // Stall/hard-ceiling watchdog (A2): kill a yt-dlp that stops producing output.
    let lastActivity = Date.now()
    let timedOut = false
    const startedAt = Date.now()
    const watchdog = setInterval(() => {
      const idle = Date.now() - lastActivity
      const total = Date.now() - startedAt
      if (idle > STALL_MS || total > HARD_MS) {
        timedOut = true
        L.error(`yt-dlp download timed out (idle=${Math.round(idle / 1000)}s total=${Math.round(total / 1000)}s) for "${video.title}"`)
        child.kill('SIGKILL')
      }
    }, 15_000)
    child.stdout.on('data', (d: Buffer) => {
      lastActivity = Date.now()
      const m = d.toString().match(/\[download\]\s+([\d.]+)%/)
      if (m) onProgress?.(parseFloat(m[1]))
    })
    child.stderr.on('data', (d: Buffer) => { lastActivity = Date.now(); err += d })
    child.on('error', (e) => {
      clearInterval(watchdog)
      if (downloadId) runningDownloads.delete(downloadId)
      if (consumeCancel(downloadId)) reject(new Error('download cancelled'))
      else { L.error(`yt-dlp download spawn error: ${e.message} (bin=${bin})`); reject(e) }
    })
    child.on('close', (code) => {
      clearInterval(watchdog)
      if (downloadId) runningDownloads.delete(downloadId)
      if (consumeCancel(downloadId)) {
        L.warn(`download cancelled: ${video.title}`)
        reject(new Error('download cancelled'))
        return
      }
      if (timedOut) {
        reject(new Error('download timed out — no progress; resume to retry'))
        return
      }
      if (code === 0 && existsSync(dest)) {
        L.info(`download ok: ${dest}`)
        onProgress?.(100)
        resolve()
      } else {
        L.error(`yt-dlp download failed (${code}) for "${video.title}": ${err.slice(0, 600)}`)
        reject(new Error(`yt-dlp download failed (${code}): ${err.slice(0, 300)}`))
      }
    })
  })
}
