import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { AppSettings, ScrapedVideo } from '../../shared/types'
import { resolveBinDir, resolveYtdlpPath } from './bin'
import { formatOutputName, probeDuration } from './audio'
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
  delaySec?: number
  supervised?: boolean
}

export class DownloadFailure extends Error {
  constructor(message: string, public readonly details: { httpStatus?: number; exitCode?: number | null; stderr?: string; stderrCategory?: string; retryAfterSec?: number }) {
    super(message)
    this.name = 'DownloadFailure'
  }
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

function quarantineIncomplete(dest: string): void {
  const stamp = Date.now()
  const stem = basename(dest, '.mp3')
  const candidates = existsSync(dirname(dest))
    ? readdirSync(dirname(dest)).filter((name) => name === basename(dest) || (name.startsWith(`${stem}.`) && /\.(?:part|ytdl)$/i.test(name)))
    : []
  for (const name of candidates) {
    const path = join(dirname(dest), name)
    try { renameSync(path, `${path}.partial-${stamp}`) } catch { /* keep the original for diagnostics if quarantine is unavailable */ }
  }
}

async function isVerifiedAudio(path: string): Promise<boolean> {
  if (!existsSync(path) || statSync(path).size < 1024) return false
  try { return (await probeDuration(path)) > 0 } catch { return false }
}

export async function downloadAudio(params: DownloadParams): Promise<DownloadResult> {
  const { video, downloadId, channel, outDir, bitrate, settings, onProgress } = params
  mkdirSync(outDir, { recursive: true })
  const dest = targetPath(outDir, channel, video.title)

  // Resume: a finished file is reused, never re-downloaded.
  if (await isVerifiedAudio(dest)) {
    onProgress?.(100)
    return { filePath: dest, skipped: true }
  }

  // Offline seam: copy a recorded sample mp3 to simulate a completed download.
  const fixture = process.env['ME_DOWNLOAD_FIXTURE']
  if (fixture) {
    copyFileSync(fixture, dest)
    if (!await isVerifiedAudio(dest)) throw new DownloadFailure('Download fixture did not produce valid audio.', { stderrCategory: 'invalid-media' })
    onProgress?.(100)
    return { filePath: dest, skipped: false }
  }

  // A tiny/truncated file is never a completed cache hit. Quarantine it before yt-dlp
  // resumes so a stale artifact cannot be mistaken for success on the next attempt.
  quarantineIncomplete(dest)
  if ((params.delaySec ?? 0) > 0) {
    const delayMs = Math.round((params.delaySec as number) * 1000 + Math.random() * 750)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs))
  }
  await runYtdlpDownload(video, dest, bitrate, settings, onProgress, downloadId, !!params.supervised)
  if (!await isVerifiedAudio(dest)) {
    quarantineIncomplete(dest)
    throw new DownloadFailure('Download completed without a valid, non-empty audio stream.', { stderrCategory: 'invalid-media' })
  }
  return { filePath: dest, skipped: false }
}

function runYtdlpDownload(
  video: ScrapedVideo,
  dest: string,
  bitrate: number,
  settings: AppSettings,
  onProgress?: (pct: number) => void,
  downloadId?: string,
  supervised = false
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
      '--retries', supervised ? '0' : '3',
      '-o', dest.replace(/\.mp3$/, '.%(ext)s')
    ]
    const ffmpegDir = vendoredFfmpegDir()
    if (ffmpegDir) args.push('--ffmpeg-location', ffmpegDir)
    else L.warn('downloader: no vendored ffmpeg found — mp3 extraction may fail')
    if (a.proxy) args.push('--proxy', a.proxy)
    if (a.cookiesPath) args.push('--cookies', a.cookiesPath)
    args.push(watchUrl(video.id))

    const bin = resolveYtdlpPath()
    const safeArgs = args.map((arg, index) => args[index - 1] === '--cookies' ? '[configured-cookie-file]' : args[index - 1] === '--proxy' ? '[configured-proxy]' : arg)
    L.info(`yt-dlp download: ${bin} ${safeArgs.join(' ')}`)
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
        const safeStderr = err.replace(/([?&](?:key|token|signature|sig)=)[^&\s]+/gi, '$1[redacted]').slice(0, 500)
        L.error(`yt-dlp download failed (${code}) for "${video.title}": ${safeStderr}`)
        const httpStatus = Number(safeStderr.match(/HTTP Error (\d{3})|\b(403|429)\b/i)?.slice(1).find(Boolean)) || undefined
        const stderrCategory = /login required|sign in|cookies? required|confirm you(?:'re| are) not a bot/i.test(safeStderr)
          ? 'authentication' : /private|members?-only/i.test(safeStderr) ? 'private' : /age|region|country/i.test(safeStderr) ? 'restriction'
            : httpStatus ? `http-${httpStatus}` : 'ytdlp'
        const retryAfterSec = Number(safeStderr.match(/retry-after\s*[:=]\s*(\d+)/i)?.[1]) || undefined
        quarantineIncomplete(dest)
        reject(new DownloadFailure(`yt-dlp download failed (${code ?? 'unknown'}): ${safeStderr.slice(0, 300)}`, { httpStatus, exitCode: code, stderr: safeStderr, stderrCategory, retryAfterSec }))
      }
    })
  })
}
