import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ProviderAsset, ProviderJob, TalkingPhotosCreationState } from '../../shared/talkingphotos'

const state = vi.hoisted(() => ({
  duration: 125,
  jobs: new Map<string, ProviderJob>(),
  assets: new Map<string, ProviderAsset>(),
  projectCounter: 0,
  trimCounter: 0,
  ttsCounter: 0,
  nextTtsDurations: [] as number[]
}))

const client = vi.hoisted(() => ({
  ensureLibraryCategory: vi.fn(async (title: string) => ({ id: title === 'audios' ? 'audio-category' : 'image-category' })),
  uploadLibraryMedia: vi.fn(async (_path: string, type: 'audio' | 'image') => ({ id: type === 'audio' ? 'source-audio' : 'source-image', title: type, type, extension: type === 'audio' ? 'wav' : 'png' })),
  getDurationLimit: vi.fn(async () => 60),
  getProjectLimits: vi.fn(async () => ({ maxDurationSec: 60, maxCharactersTts: 6000 })),
  trimLibraryMedia: vi.fn(async (input: { startSec: number; endSec: number }) => ({ id: `trim-${++state.trimCounter}`, title: 'trim', type: 'audio', extension: 'wav', durationSec: input.endSec - input.startSec })),
  createCharacterImage: vi.fn(async () => 'character-result'),
  createHumanProject: vi.fn(async (payload: { title: string }) => {
    const id = `project-${++state.projectCounter}`
    return { id, title: payload.title, type: 'human', status: 'pending', createdDate: new Date().toISOString(), updatedDate: new Date().toISOString() }
  }),
  mergeProjects: vi.fn(async (input: { projectIds: string[]; title: string }) => ({ id: 'merged-project', title: input.title, type: 'video_merge', status: 'pending', createdDate: new Date().toISOString(), updatedDate: new Date().toISOString() })),
  listProjects: vi.fn(async () => []),
  getCapabilities: vi.fn(async () => ({
    limits: { maxDurationSeconds: 300, maxCharactersTts: 6000, maxDurationPremiumSeconds: 300, maxCharactersTtsPremium: 6000 },
    usage: { concurrentCount: 0, concurrentLimit: 5, dailyUsage: 0, dailyLimit: 100 },
    fetchedAt: new Date().toISOString()
  }))
}))

// submitTts/resolveTtsJob are simplified here to resolve synchronously with a
// controllable duration (state.nextTtsDurations), so the oversized-chunk
// re-segmentation path can be driven deterministically without a real socket.
const tts = vi.hoisted(() => ({
  submitTts: vi.fn(async (input: { text: string }) => {
    const id = `tpj-tts-${++state.ttsCounter}`
    const durationSec = state.nextTtsDurations.shift() ?? 10
    const job = { id, operation: 'tts', status: 'completed', progress: 100, internalSegment: true, remoteMediaId: `tts-media-${state.ttsCounter}`, requestJson: JSON.stringify({ version: 1, uuid: `tts-uuid-${state.ttsCounter}`, text: input.text, status: 'resolved', durationSec }) }
    state.jobs.set(id, job as never)
    return job
  }),
  resolveTtsJob: vi.fn(async (jobId: string) => state.jobs.get(jobId))
}))

vi.mock('../../electron/services/audio', () => ({ probeDuration: vi.fn(async () => state.duration) }))
vi.mock('../../electron/services/logger', () => ({ L: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../../electron/providers/talkingphotos/client', () => client)
vi.mock('../../electron/providers/talkingphotos/tts', () => tts)
vi.mock('../../electron/db', () => ({
  getRepos: () => ({
    providerConnection: () => ({ id: 'default', provider: 'talkingphotos', partition: 'persist:talkingphotos:default', status: 'connected', createdAt: '', updatedAt: '' }),
    upsertProviderConnection: vi.fn(),
    providerJob: (id: string) => state.jobs.get(id),
    providerJobs: () => [...state.jobs.values()],
    providerJobByFingerprint: (_connectionId: string, fingerprint: string) => [...state.jobs.values()].find((job) => job.requestFingerprint === fingerprint),
    upsertProviderJob: (job: ProviderJob) => state.jobs.set(job.id, { ...job }),
    findOrCreateProviderJob: (job: ProviderJob) => {
      const existing = job.requestFingerprint
        ? [...state.jobs.values()].find((candidate) => candidate.requestFingerprint === job.requestFingerprint && (candidate.creationIntentId ?? '') === (job.creationIntentId ?? ''))
        : undefined
      if (existing) return { job: existing, created: false }
      state.jobs.set(job.id, { ...job })
      return { job, created: true }
    },
    automationJob: () => undefined,
    updateProviderJob: (id: string, patch: Partial<ProviderJob>) => {
      const current = state.jobs.get(id)
      if (current) state.jobs.set(id, { ...current, ...patch, updatedAt: new Date().toISOString() })
    },
    providerAssetByHash: (_provider: string, _connectionId: string, hash: string) => state.assets.get(hash),
    upsertProviderAsset: (asset: ProviderAsset) => state.assets.set(asset.localSha256, { ...asset })
  })
}))

const { advanceProviderOrchestrations, createScriptVideo, createUploadedAudioVideo } = await import('../../electron/providers/talkingphotos/creation')

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
    state.ttsCounter = 0
    state.nextTtsDurations = []
    Object.values(client).forEach((mock) => mock.mockClear())
    Object.values(tts).forEach((mock) => mock.mockClear())
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

  it('a sequential retry with identical content reuses the same job (idempotent, not just concurrent-safe)', async () => {
    state.duration = 45
    const input = { title: 'Sequential retry', audioPath, characterImagePath: imagePath, characterPrompt: 'A presenter', style: 'high_quality' as const, aspectRatio: '16:9' as const, motionId: 0 }
    const first = await createUploadedAudioVideo(input)
    const second = await createUploadedAudioVideo(input)
    expect(second.id).toBe(first.id)
    expect(client.createHumanProject).toHaveBeenCalledTimes(1)
  })

  it('a distinct creationIntentId allows an intentional duplicate with otherwise-identical content', async () => {
    state.duration = 45
    const base = { title: 'Deliberate duplicate', audioPath, characterImagePath: imagePath, characterPrompt: 'A presenter', style: 'high_quality' as const, aspectRatio: '16:9' as const, motionId: 0 }
    const first = await createUploadedAudioVideo(base)
    const second = await createUploadedAudioVideo({ ...base, creationIntentId: 'intent-2' })
    expect(second.id).not.toBe(first.id)
    expect(client.createHumanProject).toHaveBeenCalledTimes(2)
  })

  it('rejects an invalid motion for normal mode and a nonzero motion for high_quality mode', async () => {
    await expect(createUploadedAudioVideo({ title: 'x', audioPath, characterImagePath: imagePath, characterPrompt: 'p', style: 'normal', aspectRatio: '16:9', motionId: 0 })).rejects.toThrow(/motion/i)
    await expect(createUploadedAudioVideo({ title: 'x', audioPath, characterImagePath: imagePath, characterPrompt: 'p', style: 'high_quality', aspectRatio: '16:9', motionId: 5 })).rejects.toThrow(/motion/i)
  })

  it('shares one fetched SubmissionBudget across every root processed in the same advanceProviderOrchestrations pass, so a second root cannot over-submit against a provider count that has not caught up yet', async () => {
    // Only room for exactly 1 submission this pass. The default getCapabilities mock
    // (called by fetchSubmissionBudget) is static — it does NOT reflect a submission
    // made moments ago within the same pass, which is exactly the real-provider lag
    // this fix protects against: with a per-root fetch, a second root would see this
    // same "1 slot free" snapshot again and over-submit.
    client.getCapabilities.mockResolvedValueOnce({
      limits: { maxDurationSeconds: 300, maxCharactersTts: 6000, maxDurationPremiumSeconds: 300, maxCharactersTtsPremium: 6000 },
      usage: { concurrentCount: 0, concurrentLimit: 1, dailyUsage: 0, dailyLimit: 100 },
      fetchedAt: new Date().toISOString()
    })

    const readyRoot = (id: string): ProviderJob => {
      const checkpoint: TalkingPhotosCreationState = {
        version: 1,
        input: { title: `Root ${id}`, audioPath, characterImagePath: imagePath, characterPrompt: 'A presenter', style: 'high_quality', aspectRatio: '16:9', motionId: 0 },
        sourceDurationSec: 10, maxSegmentSec: 60,
        sourceAudioMediaId: 'source-audio', characterDrivingMediaId: 'source-image', characterResultUuid: 'character-result',
        segments: [{ ordinal: 0, startSec: 0, endSec: 10, durationSec: 10, remoteAudioMediaId: 'source-audio' }],
        stage: 'assets_ready', startedAt: new Date().toISOString()
      }
      return {
        id, provider: 'talkingphotos', connectionId: 'default', operation: 'video',
        requestFingerprint: `fp-${id}`, status: 'queued', progress: 0, internalSegment: false,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        requestJson: JSON.stringify(checkpoint)
      }
    }
    const rootA = readyRoot('tpj-race-a')
    const rootB = readyRoot('tpj-race-b')
    state.jobs.set(rootA.id, rootA)
    state.jobs.set(rootB.id, rootB)

    await advanceProviderOrchestrations()

    // Exactly one fetch for the whole pass — proves the budget was hoisted and shared,
    // not re-fetched per root.
    expect(client.getCapabilities).toHaveBeenCalledTimes(1)
    expect(client.createHumanProject).toHaveBeenCalledTimes(1)

    const updatedA = state.jobs.get(rootA.id) as ProviderJob
    const updatedB = state.jobs.get(rootB.id) as ProviderJob
    const submitted = [updatedA, updatedB].filter((job) => job.remoteProjectId)
    const waiting = [updatedA, updatedB].filter((job) => !job.remoteProjectId)
    expect(submitted).toHaveLength(1)
    expect(waiting).toHaveLength(1)
    // A single-segment root IS its own segment row, so the loop's unconditional
    // trailing saveState (status: 'running') on the root overwrites the segment-level
    // 'queued' set moments earlier in the budget-exhausted branch above — 'running'
    // with awaiting_provider_slot is the existing, unchanged shape of "queued behind
    // the provider slot" for this root type.
    expect(waiting[0].status).toBe('running')
    expect(waiting[0].errorCode).toBe('awaiting_provider_slot')
  })
})

describe('TalkingPhotos script (TTS) orchestration', () => {
  let dir = ''
  let imagePath = ''

  beforeEach(() => {
    state.duration = 125
    state.jobs.clear()
    state.assets.clear()
    state.projectCounter = 0
    state.trimCounter = 0
    state.ttsCounter = 0
    state.nextTtsDurations = []
    Object.values(client).forEach((mock) => mock.mockClear())
    Object.values(tts).forEach((mock) => mock.mockClear())
    dir = mkdtempSync(join(tmpdir(), 'me-tp-script-'))
    imagePath = join(dir, 'character.png')
    writeFileSync(imagePath, Buffer.from('image-content'))
  })

  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  function scriptInput(overrides: Partial<Parameters<typeof createScriptVideo>[0]> = {}) {
    return {
      title: 'Script video', script: 'A short script.', characterImagePath: imagePath, characterPrompt: 'A presenter',
      style: 'high_quality' as const, aspectRatio: '16:9' as const, motionId: 0,
      language: 'en-US', voice: 'en-US-AndrewMultilingualNeural', voiceStyle: 'general', speed: 1, pitch: 0, subtitleMode: 'none' as const,
      ...overrides
    }
  }

  it('submits a single-chunk script through TTS with the fresh (non-empty) TTS fields', async () => {
    state.nextTtsDurations = [10]
    const root = await createScriptVideo(scriptInput())
    expect(root.operation).toBe('video')
    expect(tts.submitTts).toHaveBeenCalledTimes(1)
    expect(client.createHumanProject).toHaveBeenCalledTimes(1)
    const payload = client.createHumanProject.mock.calls[0][0]
    expect(payload.options.audioSource).toBe('tts')
    expect(payload.options.audioResultUuid).toBe('tts-uuid-1')
    expect(payload.options.ttsText).toBe('A short script.')
  })

  it('re-splits and regenerates when a TTS chunk exceeds the active duration limit, never reusing the oversized job', async () => {
    // First attempt for the single chunk comes back oversized (limit is 60s); after
    // the source text is split in two, both replacement chunks resolve under the limit.
    state.nextTtsDurations = [90, 20, 20]
    const root = await createScriptVideo(scriptInput({ script: 'First sentence here now. Second sentence here now.' }))
    expect(root.operation).toBe('merge') // ended up with 2 segments after the re-split
    expect(tts.submitTts).toHaveBeenCalledTimes(3) // 1 oversized attempt + 2 replacements
    // The oversized TTS job (tts-uuid-1) is never referenced by any submitted Human project.
    const usedUuids = client.createHumanProject.mock.calls.map((call: [{ options: { audioResultUuid: string } }]) => call[0].options.audioResultUuid)
    expect(usedUuids).not.toContain('tts-uuid-1')
    expect(usedUuids.sort()).toEqual(['tts-uuid-2', 'tts-uuid-3'])
  })

  it('merges multi-chunk script segments in ordinal order', async () => {
    // Force 2 chunks deterministically via a tiny character limit.
    client.getProjectLimits.mockResolvedValueOnce({ maxDurationSec: 60, maxCharactersTts: 6 })
    state.nextTtsDurations = [10, 10]
    const root = await createScriptVideo(scriptInput({ script: 'One. Two.' }))
    expect(root.operation).toBe('merge')
    const children = [...state.jobs.values()].filter((job) => job.parentProviderJobId === root.id)
    expect(children.map((job) => job.segmentOrdinal)).toEqual([0, 1])
    for (const child of [...children].reverse()) state.jobs.set(child.id, { ...child, status: 'completed' })
    await advanceProviderOrchestrations()
    const mergeCall = client.mergeProjects.mock.calls.at(-1)?.[0]
    expect(mergeCall.projectIds).toEqual(children.map((c) => c.remoteProjectId))
  })

  it('rejects an empty script before any TTS submission', async () => {
    await expect(createScriptVideo(scriptInput({ script: '   ' }))).rejects.toThrow()
    expect(tts.submitTts).not.toHaveBeenCalled()
  })
})
