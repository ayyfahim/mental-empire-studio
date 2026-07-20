import { app, net } from 'electron'
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { getRepos } from '../../db'
import { getProviderSession } from './partition'
import { getProject } from './client'
import { probeDuration } from '../../services/audio'
import {
  buildProjectDownloadUrl,
  isAllowedProjectDownloadUrl,
  isAllowedProviderMediaUrl,
  sanitizeDownloadFilename,
  type ProviderJob
} from '../../../shared/talkingphotos'
import { L } from '../../services/logger'

// Generic provider-output downloader. The existing electron/services/downloader.ts is
// a yt-dlp/ffmpeg orchestrator for YouTube audio extraction — not a generic HTTPS
// streamer — so this is a separate, purpose-built path (review §B2): stream to a
// `.part` file over the TalkingPhotos session, validate, then atomically rename. A
// provider job is only ever marked `completed` locally AFTER the file is verified —
// never on HTTP success alone (plan §17).
//
// Two routes, in preference order (plan §9):
//   1. GET https://app.talkingphotos.ai/project/download/<numeric-id> — preferred,
//      built only from a validated positive-integer project id, strict origin+path
//      allowlist, session-bound.
//   2. The refreshed media.mediaPath CDN URL — kept as the fallback, exactly as
//      before, for when the preferred route is unavailable or fails.

export class ProviderDownloadFailure extends Error {}

interface StreamResult {
  resumed: boolean
}

export function outputDir(): string {
  const dir = join(app.getPath('userData'), 'talkingphotos-output')
  mkdirSync(dir, { recursive: true })
  return dir
}

function destPathFor(job: ProviderJob): string {
  // Deterministic, identity-based naming (not the server's suggested filename) so a
  // retry/resume always targets the same .part file. Any Content-Disposition
  // filename is still read and sanitized (never trusted raw) — see downloadOnce —
  // purely so a hostile/malformed header can never influence a filesystem path.
  return join(outputDir(), `${job.remoteProjectId ?? job.id}.mp4`)
}

function contentDispositionHeader(headers: Record<string, string | string[]> | undefined | null): string | undefined {
  const raw = headers?.['content-disposition']
  return Array.isArray(raw) ? raw[0] : raw
}

/** Streams one URL to `tmpPath`, honoring a Range resume when the file already has
 *  bytes from a prior attempt. If the server ignores the range and answers 200
 *  instead of 206, the file is restarted cleanly — a 200 body is NEVER appended to an
 *  existing partial file (that would silently corrupt it). */
function downloadOnce(url: string, tmpPath: string, allow: (u: string) => boolean): Promise<StreamResult> {
  if (!allow(url)) return Promise.reject(new ProviderDownloadFailure(`Refusing to download from an unexpected host/path: ${url}`))
  let existingBytes = 0
  if (existsSync(tmpPath)) {
    try { existingBytes = statSync(tmpPath).size } catch { existingBytes = 0 }
  }
  return new Promise((resolve, reject) => {
    let req: ReturnType<typeof net.request>
    try {
      req = net.request({ method: 'GET', url, session: getProviderSession(), redirect: 'follow' })
    } catch (e) {
      reject(e as Error)
      return
    }
    if (existingBytes > 0) req.setHeader('range', `bytes=${existingBytes}-`)
    req.on('response', (res) => {
      const filename = sanitizeDownloadFilename(contentDispositionHeader(res.headers as Record<string, string | string[]>), '')
      if (filename) L.info(`talkingphotos download: server suggested filename "${filename}" (not used as the local path)`)

      if (res.statusCode === 206 && existingBytes > 0) {
        const out = createWriteStream(tmpPath, { flags: 'a' })
        out.on('error', reject)
        out.on('finish', () => resolve({ resumed: true }))
        res.on('data', (chunk: Buffer) => out.write(chunk))
        res.on('end', () => out.end())
        res.on('error', (e: Error) => { out.destroy(); reject(e) })
        return
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new ProviderDownloadFailure(`Download failed: HTTP ${res.statusCode}`))
        return
      }
      // 200: either a fresh request, or the server ignored our Range header — always
      // restart clean (truncate) rather than appending a full body onto partial bytes.
      const out = createWriteStream(tmpPath, { flags: 'w' })
      out.on('error', reject)
      out.on('finish', () => resolve({ resumed: false }))
      res.on('data', (chunk: Buffer) => out.write(chunk))
      res.on('end', () => out.end())
      res.on('error', (e: Error) => { out.destroy(); reject(e) })
    })
    req.on('error', reject)
    req.end()
  })
}

/** (Re)download a provider job's completed output. Always refreshes the project
 *  detail first — signed/session CDN URLs are not durable, so a stored URL is never
 *  reused as-is on retry (plan §17). Safe to call repeatedly: a failed attempt leaves
 *  the job in `downloading` (not `failed`) so the completed remote project is preserved
 *  and the next Sync/retry can pick the download back up without resubmitting work. */
export async function downloadProviderJobOutput(providerJobId: string): Promise<ProviderJob> {
  const repos = getRepos()
  const job = repos.providerJob(providerJobId)
  if (!job) throw new Error(`Unknown provider job: ${providerJobId}`)
  if (!job.remoteProjectId) throw new Error('Provider job has no remote project id yet.')

  const remote = await getProject(job.remoteProjectId)
  const mediaUrl = remote?.mediaUrl
  if (!remote || !mediaUrl) throw new Error('TalkingPhotos project has no downloadable output yet.')

  const dest = destPathFor(job)
  const tmp = `${dest}.part`
  repos.updateProviderJob(job.id, { status: 'downloading', remoteMediaUrl: mediaUrl, errorCode: undefined, errorMessage: undefined })

  try {
    const preferredUrl = buildProjectDownloadUrl(job.remoteProjectId)
    if (preferredUrl) {
      try {
        await downloadOnce(preferredUrl, tmp, isAllowedProjectDownloadUrl)
      } catch (e) {
        L.warn(`talkingphotos download: preferred route failed for job=${job.id}, falling back to CDN: ${(e as Error).message}`)
        try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* best-effort cleanup before the fallback attempt */ }
        await downloadOnce(mediaUrl, tmp, isAllowedProviderMediaUrl)
      }
    } else {
      await downloadOnce(mediaUrl, tmp, isAllowedProviderMediaUrl)
    }

    if (!existsSync(tmp) || statSync(tmp).size <= 0) throw new ProviderDownloadFailure('Downloaded file is empty.')
    const durationSec = await probeDuration(tmp)
    if (durationSec <= 0) throw new ProviderDownloadFailure('Downloaded file is not a readable media container.')
    if (remote.mediaDurationSec && remote.mediaDurationSec > 0) {
      const drift = Math.abs(durationSec - remote.mediaDurationSec) / remote.mediaDurationSec
      if (drift > 0.05) L.warn(`talkingphotos download duration mismatch job=${job.id} expected=${remote.mediaDurationSec}s got=${durationSec}s`)
    }
    renameSync(tmp, dest)
    repos.updateProviderJob(job.id, { status: 'completed', localOutputPath: dest, downloadedAt: new Date().toISOString(), errorCode: undefined, errorMessage: undefined })
    return repos.providerJob(job.id)!
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* best-effort cleanup */ }
    const message = (e as Error).message
    L.warn(`talkingphotos download failed job=${job.id}: ${message}`)
    repos.updateProviderJob(job.id, { status: 'downloading', errorMessage: message })
    throw e
  }
}
