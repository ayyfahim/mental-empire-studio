import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Output downloader: .part-file lifecycle, media validation, and "always refresh
// before retry" (signed CDN URLs are not durable — plan §17). Network (net.request),
// the DB repo, the remote project lookup, and ffprobe duration are all faked so the
// test exercises the real node:fs .part -> validate -> atomic-rename flow on disk.

const userDataDir = mkdtempSync(join(tmpdir(), 'me-tp-dl-userdata-'))

let nextStreamBehavior: 'ok' | 'network-error' | 'http-error' = 'ok'
let streamBody = Buffer.from('fake-mp4-bytes')
let lastRequestedUrl = ''
let requestedUrls: string[] = []
/** Fails only the request whose URL matches this predicate — lets a test make the
 *  preferred route fail while the CDN fallback still succeeds. */
let failWhenUrlMatches: ((url: string) => boolean) | null = null

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  net: {
    request: (opts: { url: string }) => {
      lastRequestedUrl = opts.url
      requestedUrls.push(opts.url)
      const behavior = failWhenUrlMatches?.(opts.url) ? 'http-error' : nextStreamBehavior
      const req = new EventEmitter() as EventEmitter & { setHeader: () => void; write: () => void; end: () => void }
      req.setHeader = () => {}
      req.write = () => {}
      req.end = () => {
        queueMicrotask(() => {
          if (behavior === 'network-error') { req.emit('error', new Error('ECONNRESET')); return }
          const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string> }
          res.statusCode = behavior === 'http-error' ? 403 : 200
          res.headers = { 'content-disposition': 'attachment; filename="server-suggested ../evil.mp4"' }
          req.emit('response', res)
          if (behavior === 'ok') {
            queueMicrotask(() => {
              res.emit('data', streamBody)
              res.emit('end')
            })
          }
        })
      }
      return req
    }
  },
  session: { fromPartition: () => ({ __sentinel: 'session' }) }
}))

let remoteProject: { id: string; mediaUrl?: string; mediaDurationSec?: number } | null = null
vi.mock('../../electron/providers/talkingphotos/client', () => ({
  getProject: vi.fn(async () => remoteProject)
}))

let nextProbedDuration = 275.5
vi.mock('../../electron/services/audio', () => ({
  probeDuration: vi.fn(async () => nextProbedDuration)
}))

interface FakeJob {
  id: string
  remoteProjectId?: string
  status: string
  localOutputPath?: string
  downloadedAt?: string
  errorMessage?: string
  remoteMediaUrl?: string
}
const jobStore = new Map<string, FakeJob>()
vi.mock('../../electron/db', () => ({
  getRepos: () => ({
    providerJob: (id: string) => jobStore.get(id),
    updateProviderJob: (id: string, patch: Partial<FakeJob>) => {
      const current = jobStore.get(id)
      if (current) jobStore.set(id, { ...current, ...patch })
    }
  })
}))

const { downloadProviderJobOutput, ProviderDownloadFailure } = await import('../../electron/providers/talkingphotos/downloader')
const { getProject } = await import('../../electron/providers/talkingphotos/client')

function outputDir(): string {
  return join(userDataDir, 'talkingphotos-output')
}

beforeEach(() => {
  jobStore.clear()
  jobStore.set('job-1', { id: 'job-1', remoteProjectId: 'proj-1', status: 'downloading' })
  remoteProject = { id: 'proj-1', mediaUrl: 'https://cdn.talkingphotos.ai/v1/out.mp4', mediaDurationSec: 275.5 }
  nextStreamBehavior = 'ok'
  nextProbedDuration = 275.5
  lastRequestedUrl = ''
  requestedUrls = []
  failWhenUrlMatches = null
  vi.mocked(getProject).mockClear()
})

describe('TalkingPhotos output downloader', () => {
  it('downloads, validates, and atomically completes — the .part file is gone and only the final file remains', async () => {
    const job = await downloadProviderJobOutput('job-1')
    expect(job.status).toBe('completed')
    expect(job.localOutputPath).toBeTruthy()
    expect(existsSync(job.localOutputPath!)).toBe(true)
    expect(existsSync(`${job.localOutputPath}.part`)).toBe(false)
    // Only trustworthy, non-cookie fields ever leave this module.
    expect(Object.keys(job).sort()).toEqual(['downloadedAt', 'errorCode', 'errorMessage', 'id', 'localOutputPath', 'remoteMediaUrl', 'remoteProjectId', 'status'].sort())
  })

  it('always refreshes the project detail before (re)downloading — never reuses a stale stored URL', async () => {
    await downloadProviderJobOutput('job-1')
    remoteProject = { id: 'proj-1', mediaUrl: 'https://cdn.talkingphotos.ai/v2/refreshed.mp4', mediaDurationSec: 275.5 }
    await downloadProviderJobOutput('job-1')
    expect(getProject).toHaveBeenCalledTimes(2)
    expect(lastRequestedUrl).toBe('https://cdn.talkingphotos.ai/v2/refreshed.mp4')
  })

  it('cleans up the .part file and keeps the job retryable (not "failed") on a network error', async () => {
    nextStreamBehavior = 'network-error'
    await expect(downloadProviderJobOutput('job-1')).rejects.toThrow()
    const job = jobStore.get('job-1')!
    expect(job.status).toBe('downloading') // preserved for retry, not flipped to 'failed'
    expect(job.errorMessage).toBeTruthy()
    const leftoverParts = readdirSync(outputDir()).filter((f) => f.endsWith('.part'))
    expect(leftoverParts).toEqual([])
  })

  it('cleans up the .part file on an HTTP error from the CDN', async () => {
    nextStreamBehavior = 'http-error'
    await expect(downloadProviderJobOutput('job-1')).rejects.toThrow(/403/)
    const leftoverParts = readdirSync(outputDir()).filter((f) => f.endsWith('.part'))
    expect(leftoverParts).toEqual([])
  })

  it('rejects a downloaded file that is not a readable media container (ffprobe duration 0) and does not mark the job completed', async () => {
    nextProbedDuration = 0
    await expect(downloadProviderJobOutput('job-1')).rejects.toThrow(ProviderDownloadFailure)
    const job = jobStore.get('job-1')!
    expect(job.status).not.toBe('completed')
    expect(job.localOutputPath).toBeUndefined()
  })

  it('refuses to stream from a host other than the TalkingPhotos CDN', async () => {
    remoteProject = { id: 'proj-1', mediaUrl: 'https://attacker.example.com/out.mp4' }
    await expect(downloadProviderJobOutput('job-1')).rejects.toThrow(ProviderDownloadFailure)
  })

  it('throws (rather than silently no-oping) when the project has no output yet', async () => {
    remoteProject = { id: 'proj-1' }
    await expect(downloadProviderJobOutput('job-1')).rejects.toThrow()
  })

  describe('Phase 9: preferred /project/download/{id} route', () => {
    beforeEach(() => {
      jobStore.set('job-numeric', { id: 'job-numeric', remoteProjectId: '98765', status: 'downloading' })
      remoteProject = { id: '98765', mediaUrl: 'https://cdn.talkingphotos.ai/v1/out.mp4', mediaDurationSec: 275.5 }
    })

    it('tries the app-origin preferred route before the CDN for a numeric project id', async () => {
      await downloadProviderJobOutput('job-numeric')
      expect(requestedUrls[0]).toBe('https://app.talkingphotos.ai/project/download/98765')
    })

    it('falls back to the refreshed CDN url when the preferred route fails', async () => {
      failWhenUrlMatches = (url) => url.includes('/project/download/')
      const job = await downloadProviderJobOutput('job-numeric')
      expect(requestedUrls).toEqual(['https://app.talkingphotos.ai/project/download/98765', 'https://cdn.talkingphotos.ai/v1/out.mp4'])
      expect(job.status).toBe('completed')
    })

    it('never requests the preferred route for a non-numeric project id, going straight to the CDN', async () => {
      await downloadProviderJobOutput('job-1') // remoteProjectId 'proj-1' is not numeric
      expect(requestedUrls).toEqual(['https://cdn.talkingphotos.ai/v1/out.mp4'])
    })

    it('rejects a manipulated preferred-route URL outside the strict allowlist even if constructed', async () => {
      // Sanity check on the underlying validator the downloader relies on — a URL
      // that isn't exactly https://app.talkingphotos.ai/project/download/<id> must
      // never be attempted as the "preferred" route.
      const { isAllowedProjectDownloadUrl } = await import('../../shared/talkingphotos')
      expect(isAllowedProjectDownloadUrl('https://app.talkingphotos.ai/admin/download/98765')).toBe(false)
      expect(isAllowedProjectDownloadUrl('https://app.talkingphotos.ai/project/download/98765/../../etc/passwd')).toBe(false)
    })
  })
})
