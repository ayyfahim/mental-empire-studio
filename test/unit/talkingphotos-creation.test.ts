import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ProviderAsset, ProviderJob } from '../../shared/talkingphotos'

const state = vi.hoisted(() => ({
  duration: 125,
  jobs: new Map<string, ProviderJob>(),
  assets: new Map<string, ProviderAsset>(),
  projectCounter: 0,
  trimCounter: 0
}))

const client = vi.hoisted(() => ({
  ensureLibraryCategory: vi.fn(async (title: string) => ({ id: title === 'audios' ? 'audio-category' : 'image-category' })),
  uploadLibraryMedia: vi.fn(async (_path: string, type: 'audio' | 'image') => ({ id: type === 'audio' ? 'source-audio' : 'source-image', title: type, type, extension: type === 'audio' ? 'wav' : 'png' })),
  getDurationLimit: vi.fn(async () => 60),
  trimLibraryMedia: vi.fn(async (input: { startSec: number; endSec: number }) => ({ id: `trim-${++state.trimCounter}`, title: 'trim', type: 'audio', extension: 'wav', durationSec: input.endSec - input.startSec })),
  createCharacterImage: vi.fn(async () => 'character-result'),
  createHumanProject: vi.fn(async (payload: { title: string }) => {
    const id = `project-${++state.projectCounter}`
    return { id, title: payload.title, type: 'human', status: 'pending', createdDate: new Date().toISOString(), updatedDate: new Date().toISOString() }
  }),
  mergeProjects: vi.fn(async (input: { projectIds: string[]; title: string }) => ({ id: 'merged-project', title: input.title, type: 'video_merge', status: 'pending', createdDate: new Date().toISOString(), updatedDate: new Date().toISOString() })),
  listProjects: vi.fn(async () => [])
}))

vi.mock('../../electron/services/audio', () => ({ probeDuration: vi.fn(async () => state.duration) }))
vi.mock('../../electron/services/logger', () => ({ L: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../../electron/providers/talkingphotos/client', () => client)
vi.mock('../../electron/db', () => ({
  getRepos: () => ({
    providerConnection: () => ({ id: 'default', provider: 'talkingphotos', partition: 'persist:talkingphotos:default', status: 'connected', createdAt: '', updatedAt: '' }),
    upsertProviderConnection: vi.fn(),
    providerJob: (id: string) => state.jobs.get(id),
    providerJobs: () => [...state.jobs.values()],
    providerJobByFingerprint: (_connectionId: string, fingerprint: string) => [...state.jobs.values()].find((job) => job.requestFingerprint === fingerprint),
    upsertProviderJob: (job: ProviderJob) => state.jobs.set(job.id, { ...job }),
    updateProviderJob: (id: string, patch: Partial<ProviderJob>) => {
      const current = state.jobs.get(id)
      if (current) state.jobs.set(id, { ...current, ...patch, updatedAt: new Date().toISOString() })
    },
    providerAssetByHash: (_provider: string, _connectionId: string, hash: string) => state.assets.get(hash),
    upsertProviderAsset: (asset: ProviderAsset) => state.assets.set(asset.localSha256, { ...asset })
  })
}))

const { advanceProviderOrchestrations, createUploadedAudioVideo } = await import('../../electron/providers/talkingphotos/creation')

describe('TalkingPhotos uploaded-audio orchestration', () => {
  let dir = ''
  let audioPath = ''
  let imagePath = ''

  beforeEach(() => {
    state.duration = 125
    state.jobs.clear()
    state.assets.clear()
    state.projectCounter = 0
    state.trimCounter = 0
    Object.values(client).forEach((mock) => mock.mockClear())
    dir = mkdtempSync(join(tmpdir(), 'me-tp-create-'))
    audioPath = join(dir, 'recording.wav')
    imagePath = join(dir, 'character.png')
    writeFileSync(audioPath, Buffer.from('audio-content'))
    writeFileSync(imagePath, Buffer.from('image-content'))
  })

  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('validates duration, submits ordered segments, merges in ordinal order, and reuses the idempotent root', async () => {
    const input = { title: 'Long recording', audioPath, characterImagePath: imagePath, characterPrompt: 'A presenter', style: 'high_quality' as const, aspectRatio: '16:9' as const, motionId: 0 }
    const root = await createUploadedAudioVideo(input)
    expect(root.operation).toBe('merge')
    expect(client.trimLibraryMedia).toHaveBeenCalledTimes(3)
    expect(client.createHumanProject).toHaveBeenCalledTimes(3)

    const children = [...state.jobs.values()].filter((job) => job.parentProviderJobId === root.id)
    expect(children.map((job) => job.segmentOrdinal)).toEqual([0, 1, 2])
    for (const child of [...children].reverse()) state.jobs.set(child.id, { ...child, status: 'completed' })

    await advanceProviderOrchestrations()
    expect(client.mergeProjects).toHaveBeenCalledWith({ projectIds: ['project-1', 'project-2', 'project-3'], title: 'Long recording' })
    expect(state.jobs.get(root.id)).toMatchObject({ remoteProjectId: 'merged-project', status: 'queued' })

    const same = await createUploadedAudioVideo(input)
    expect(same.id).toBe(root.id)
    expect(client.uploadLibraryMedia).toHaveBeenCalledTimes(2)
    expect(client.createHumanProject).toHaveBeenCalledTimes(3)
  })

  it('submits a short recording directly without trim or merge', async () => {
    state.duration = 45
    const root = await createUploadedAudioVideo({ title: 'Short', audioPath, characterImagePath: imagePath, characterPrompt: 'A presenter', style: 'high_quality', aspectRatio: '9:16', motionId: 0 })
    expect(root.operation).toBe('video')
    expect(root.remoteProjectId).toBe('project-1')
    expect(client.trimLibraryMedia).not.toHaveBeenCalled()
    expect(client.mergeProjects).not.toHaveBeenCalled()
  })

  it('single-flights concurrent duplicate submissions', async () => {
    state.duration = 45
    const input = { title: 'Concurrent', audioPath, characterImagePath: imagePath, characterPrompt: 'A presenter', style: 'high_quality' as const, aspectRatio: '16:9' as const, motionId: 0 }
    const [first, second] = await Promise.all([createUploadedAudioVideo(input), createUploadedAudioVideo(input)])
    expect(first.id).toBe(second.id)
    expect([...state.jobs.values()].filter((job) => !job.parentProviderJobId)).toHaveLength(1)
    expect(client.createHumanProject).toHaveBeenCalledTimes(1)
  })
})
