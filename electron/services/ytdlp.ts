import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import type { AppSettings } from '../../shared/types'
import { L } from './logger'
import { resolveBinDir, resolveYtdlpPath } from './bin'

// Low-level yt-dlp runner. yt-dlp is the no-API way to read public channel/video
// metadata: we spawn the standalone binary, ask for a single JSON dump of the
// (flat) playlist, and parse it. All scraping flows through here so proxy / cookies
// / request-delay / retries live in one place.

export interface YtdlpEntry {
  id?: string
  title?: string
  duration?: number
  view_count?: number
  upload_date?: string
  thumbnails?: Array<{ url?: string }>
}

export interface YtdlpPlaylist {
  id?: string
  title?: string
  duration?: number
  view_count?: number
  upload_date?: string
  channel?: string
  uploader?: string
  uploader_id?: string
  channel_id?: string
  channel_follower_count?: number
  /** channel avatar URL (present when yt-dlp fetches channel-level metadata) */
  thumbnail?: string
  thumbnails?: Array<{ url?: string; id?: string }>
  entries?: Array<YtdlpEntry | null>
}

export interface YtdlpOptions {
  proxy?: string
  cookiesPath?: string
  delaySec?: number
  retries?: number
  /** When false, omit --flat-playlist so per-video metadata (view_count, duration)
   *  is included. Slower — pair with `limit` to cap how many videos are extracted. */
  flat?: boolean
  /** Cap the number of playlist entries (yt-dlp --playlist-end). */
  limit?: number
}

export function ytdlpOptionsFromSettings(s: AppSettings): YtdlpOptions {
  const a = s.autoScrape
  return { proxy: a.proxy, cookiesPath: a.cookiesPath, delaySec: a.delaySec, retries: a.retries }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Extract the @handle from a channel URL, used to key offline fixtures. */
function handleFromUrl(url: string): string {
  const m = url.match(/@([A-Za-z0-9_.-]+)/)
  return m ? m[1] : url.replace(/[^A-Za-z0-9]+/g, '_')
}

/** Offline test seam: read a recorded yt-dlp JSON dump instead of hitting the network. */
function readFixture(url: string): YtdlpPlaylist {
  const dir = process.env['ME_YTDLP_FIXTURE'] as string
  const file = join(dir, `${handleFromUrl(url)}.json`)
  if (!existsSync(file)) throw new Error(`No yt-dlp fixture for ${url} (expected ${file})`)
  return JSON.parse(readFileSync(file, 'utf8')) as YtdlpPlaylist
}

/** Run yt-dlp for a URL and return the parsed playlist JSON, retrying with backoff. */
export async function runYtdlpJson(url: string, opts: YtdlpOptions = {}): Promise<YtdlpPlaylist> {
  if (process.env['ME_YTDLP_FIXTURE']) return readFixture(url)
  const retries = Math.max(0, opts.retries ?? 0)
  let lastErr: Error | null = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await spawnYtdlp(url, opts)
    } catch (e) {
      lastErr = e as Error
      if (attempt < retries) await sleep(1000 * 2 ** attempt) // exponential backoff
    }
  }
  throw lastErr ?? new Error('yt-dlp failed')
}

function spawnYtdlp(url: string, opts: YtdlpOptions): Promise<YtdlpPlaylist> {
  return new Promise((resolve, reject) => {
    const args = ['-J', '--no-warnings', '--ignore-errors', '--js-runtimes', 'node']
    // Default to a flat dump (fast, full list); callers that need real per-video
    // view counts pass flat:false (+ a limit) to get full metadata extraction.
    if (opts.flat !== false) args.push('--flat-playlist')
    if (opts.limit && opts.limit > 0) args.push('--playlist-end', String(opts.limit))
    if (opts.proxy) args.push('--proxy', opts.proxy)
    if (opts.cookiesPath) args.push('--cookies', opts.cookiesPath)
    if (opts.delaySec) args.push('--sleep-requests', String(opts.delaySec))
    args.push(url)

    const bin = resolveYtdlpPath()
    L.info(`yt-dlp scrape: ${bin} ${args.join(' ')}`)
    if (!existsSync(bin)) L.error(`yt-dlp binary missing at ${bin}`)
    const child = spawn(bin, args, { windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => { L.error(`yt-dlp spawn error: ${e.message} (bin=${bin})`); reject(e) })
    child.on('close', (code) => {
      if (code !== 0 && !out.trim()) {
        L.error(`yt-dlp scrape exited ${code}: ${err.slice(0, 600)}`)
        return reject(new Error(`yt-dlp exited ${code}: ${err.slice(0, 300)}`))
      }
      if (err.trim()) L.warn(`yt-dlp scrape stderr: ${err.slice(0, 400)}`)
      try {
        resolve(JSON.parse(out) as YtdlpPlaylist)
      } catch {
        reject(new Error(`yt-dlp JSON parse failed: ${out.slice(0, 200)}`))
      }
    })
  })
}
