import { existsSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderJob } from '../../shared/talkingphotos'

// Provider subtitles vs local captions: the mutual-exclusion guard (plan §8) is the
// one piece of this pair that isn't a pure function — it reads other provider_jobs
// rows / the source job's own localCaptionedOutputPath. Both guards are checked
// BEFORE any network/ffmpeg work starts.

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: vi.fn(() => true) }
})
vi.mock('../../electron/services/logger', () => {
  const scope = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { L: scope, logger: { scope: () => scope } }
})
vi.mock('../../electron/store/settings', () => ({ getSettings: () => ({ transcription: { apiKey: 'gsk_test' } }) }))

const client = vi.hoisted(() => ({
  getProjectRaw: vi.fn(async () => ({ id: 555, type: 'human', style: 'high_quality', status: 'completed', options: { aspectRatio: '16:9' } })),
  createSubtitlesProject: vi.fn(async () => ({ id: 'sub-1', status: 'pending' })),
  listProjectLanguages: vi.fn(async () => [{ code: 'en-US', name: 'English' }])
}))
vi.mock('../../electron/providers/talkingphotos/client', () => client)

const jobs = new Map<string, ProviderJob>()
vi.mock('../../electron/db', () => ({
  getRepos: () => ({
    providerJob: (id: string) => jobs.get(id),
    providerJobs: (connectionId?: string) => [...jobs.values()].filter((j) => !connectionId || j.connectionId === connectionId),
    upsertProviderJob: (job: ProviderJob) => jobs.set(job.id, { ...job }),
    updateProviderJob: (id: string, patch: Partial<ProviderJob>) => {
      const current = jobs.get(id)
      if (current) jobs.set(id, { ...current, ...patch })
    }
  })
}))

const { createProviderSubtitles } = await import('../../electron/providers/talkingphotos/subtitles')
const { LocalCaptionFailure } = await import('../../electron/providers/talkingphotos/localCaptions')

function completedJob(patch: Partial<ProviderJob> = {}): ProviderJob {
  const now = new Date().toISOString()
  return {
    id: 'tpj-source', provider: 'talkingphotos', connectionId: 'default', operation: 'video', status: 'completed',
    remoteProjectId: '555', localOutputPath: '/out/source.mp4', progress: 100, internalSegment: false, createdAt: now, updatedAt: now,
    ...patch
  }
}

beforeEach(() => {
  jobs.clear()
  vi.mocked(existsSync).mockReturnValue(true)
  Object.values(client).forEach((mock) => mock.mockClear())
})

describe('Provider subtitles', () => {
  it('requires a completed source video with a remote project id', async () => {
    jobs.set('tpj-source', completedJob({ status: 'running' }))
    await expect(createProviderSubtitles('tpj-source')).rejects.toThrow(/completed/i)
  })

  it('submits a sanitized clone and creates a non-internal subtitles job', async () => {
    jobs.set('tpj-source', completedJob())
    const job = await createProviderSubtitles('tpj-source')
    expect(job.operation).toBe('subtitles')
    expect(job.parentProviderJobId).toBe('tpj-source')
    expect(job.internalSegment).toBe(false)
    expect(client.createSubtitlesProject).toHaveBeenCalledTimes(1)
  })

  it('is idempotent: a second call for the same source returns the existing (non-failed) subtitles job', async () => {
    jobs.set('tpj-source', completedJob())
    const first = await createProviderSubtitles('tpj-source')
    const second = await createProviderSubtitles('tpj-source')
    expect(second.id).toBe(first.id)
    expect(client.createSubtitlesProject).toHaveBeenCalledTimes(1)
  })

  it('mutual exclusion: refuses to submit provider subtitles once local captions were already applied', async () => {
    jobs.set('tpj-source', completedJob({ localCaptionedOutputPath: '/out/source.captioned.mp4' }))
    await expect(createProviderSubtitles('tpj-source')).rejects.toThrow(/local captions/i)
    expect(client.createSubtitlesProject).not.toHaveBeenCalled()
  })
})

describe('Local captions — mutual exclusion guard (checked before any ffmpeg/transcription work)', () => {
  it('refuses to apply local captions once provider subtitles were already requested for the same source', async () => {
    jobs.set('tpj-source', completedJob())
    jobs.set('tpj-sub', { id: 'tpj-sub', provider: 'talkingphotos', connectionId: 'default', operation: 'subtitles', parentProviderJobId: 'tpj-source', status: 'running', progress: 0, internalSegment: false, createdAt: '', updatedAt: '' })
    const { applyLocalCaptions } = await import('../../electron/providers/talkingphotos/localCaptions')
    await expect(applyLocalCaptions('tpj-source')).rejects.toThrow(LocalCaptionFailure)
  })

  it('requires an already-downloaded, verified output', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    jobs.set('tpj-source', completedJob())
    const { applyLocalCaptions } = await import('../../electron/providers/talkingphotos/localCaptions')
    await expect(applyLocalCaptions('tpj-source')).rejects.toThrow(LocalCaptionFailure)
  })
})
