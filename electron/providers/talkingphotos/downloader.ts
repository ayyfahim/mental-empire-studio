import { app, net } from 'electron'
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { getRepos } from '../../db'
import { getProviderSession } from './partition'
import { getProject } from './client'
import { probeDuration } from '../../services/audio'
import { isAllowedProviderMediaUrl, type ProviderJob } from '../../../shared/talkingphotos'
import { L } from '../../services/logger'

// Generic provider-output downloader. The existing electron/services/downloader.ts is
// a yt-dlp/ffmpeg orchestrator for YouTube audio extraction — not a generic HTTPS
// streamer — so this is a separate, purpose-built path (review §B2): stream to a
// `.part` file over the TalkingPhotos session, validate, then atomically rename. A
// provider job is only ever marked `completed` locally AFTER the file is verified —
// never on HTTP success alone (plan §17).

export class ProviderDownloadFailure extends Error {}

function outputDir(): string {
  const dir = join(app.getPath('userData'), 'talkingphotos-output')
  mkdirSync(dir, { recursive: true })
  return dir
}

function destPathFor(job: ProviderJob): string {
  return join(outputDir(), `${job.remoteProjectId ?? job.id}.mp4`)
}

function streamToFile(url: string, tmpPath: string): Promise<void> {
  if (!isAllowedProviderMediaUrl(url)) return Promise.reject(new ProviderDownloadFailure(`Refusing to download from an unexpected host: ${url}`))
  return new Promise((resolve, reject) => {
    let req: ReturnType<typeof net.request>
    try {
      req = net.request({ method: 'GET', url, session: getProviderSession(), redirect: 'follow' })
    } catch (e) {
      reject(e as Error)
      return
    }
    req.on('response', (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new ProviderDownloadFailure(`Download failed: HTTP ${res.statusCode}`))
        return
      }
      // Electron's IncomingMessage type doesn't expose pause()/resume()/pipe() in this
      // Electron version's typings, so buffer manually — acceptable here since capability
      // limits cap TalkingPhotos videos at a few hundred seconds (modest file sizes).
      const out = createWriteStream(tmpPath)
      out.on('error', reject)
      out.on('finish', resolve)
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
    await streamToFile(mediaUrl, tmp)
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
