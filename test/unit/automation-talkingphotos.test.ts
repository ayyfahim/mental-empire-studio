import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AutomationJob, AutomationJobConfig, AutomationJobItem, AutomationJobLog, AutomationWorkflowStep } from '../../shared/types'
import type { ProviderConnection, ProviderJob, TimedWord } from '../../shared/talkingphotos'
import { TALKINGPHOTOS_CONNECTION_ID, reconstructScriptFromWords } from '../../shared/talkingphotos'

// This suite drives electron/services/automation-supervisor.ts's dedicated
// 'talkingphotos' step end-to-end through the *public* automation API
// (createAutomationJob / pauseAutomationJob / resumeAutomationJob /
// retryAutomationJob / startAutomationSupervisor), with everything below it
// faked: the DB repo layer, settings, and the TalkingPhotos provider boundary
// (createUploadedAudioVideo / createScriptVideo / reconcileNonTerminalProviderJobs).
// No live provider calls, no ffmpeg/whisper. The internal pump()/processJob()/
// runStep() functions are not exported, so the only way to exercise the real
// mode-wiring + pause/resume/retry/restart interplay is through the exported
// surface, driven with fake timers (the supervisor schedules itself via
// setTimeout, and the talkingphotos step polls on a 5s interval).

// ---- Fake in-memory "DB" shared across the mocked electron/db module ----
const state = vi.hoisted(() => ({
  jobs: new Map<string, AutomationJob>(),
  steps: new Map<string, AutomationWorkflowStep[]>(),
  items: new Map<string, Map<string, AutomationJobItem>>(),
  logs: new Map<string, AutomationJobLog[]>(),
  downloads: new Map<string, { id: string; filePath?: string; durationSec?: number }>(),
  connections: new Map<string, ProviderConnection>(),
  providerJobs: new Map<string, ProviderJob>(),
  providerJobSeq: 0
}))

function resetState(): void {
  state.jobs.clear()
  state.steps.clear()
  state.items.clear()
  state.logs.clear()
  state.downloads.clear()
  state.connections.clear()
  state.providerJobs.clear()
  state.providerJobSeq = 0
  const at = new Date().toISOString()
  state.connections.set(TALKINGPHOTOS_CONNECTION_ID, {
    id: TALKINGPHOTOS_CONNECTION_ID, provider: 'talkingphotos', partition: 'persist:talkingphotos:default',
    status: 'connected', createdAt: at, updatedAt: at
  })
}

function makeProviderJob(overrides: Partial<ProviderJob> & { automationJobId: string; automationItemId: string }): ProviderJob {
  state.providerJobSeq += 1
  const at = new Date().toISOString()
  const job: ProviderJob = {
    id: overrides.id ?? `pj-${state.providerJobSeq}`,
    provider: 'talkingphotos',
    connectionId: TALKINGPHOTOS_CONNECTION_ID,
    operation: 'video',
    status: 'queued',
    progress: 0,
    internalSegment: false,
    createdAt: at,
    updatedAt: at,
    ...overrides
  }
  state.providerJobs.set(job.id, job)
  return job
}

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn(), isStarted: vi.fn(() => false) }
}))

vi.mock('../../electron/services/logger', () => ({
  logger: { scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  L: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('../../electron/db', () => ({
  getRepos: () => ({
    createAutomationJob: (job: AutomationJob, steps: AutomationWorkflowStep[]) => {
      state.jobs.set(job.id, { ...job })
      state.steps.set(job.id, steps.map((s) => ({ ...s })))
      state.items.set(job.id, new Map())
      state.logs.set(job.id, [])
    },
    automationJob: (id: string) => state.jobs.get(id),
    automationJobs: () => [...state.jobs.values()].map((j) => ({ ...j })),
    automationSteps: (jobId: string) => (state.steps.get(jobId) ?? []).map((s) => ({ ...s })),
    automationItems: (jobId: string) => [...(state.items.get(jobId)?.values() ?? [])].map((i) => ({ ...i })),
    automationLogs: (jobId: string) => state.logs.get(jobId) ?? [],
    addAutomationLog: (jobId: string, level: 'info' | 'warning' | 'error', message: string, itemId?: string) => {
      const arr = state.logs.get(jobId) ?? []
      arr.push({ id: arr.length + 1, jobId, itemId, level, message, createdAt: new Date().toISOString() })
      state.logs.set(jobId, arr)
    },
    updateAutomationJob: (id: string, patch: Partial<AutomationJob>) => {
      const j = state.jobs.get(id)
      if (j) state.jobs.set(id, { ...j, ...patch, updatedAt: new Date().toISOString() })
    },
    updateAutomationStep: (id: string, patch: Partial<AutomationWorkflowStep>) => {
      for (const steps of state.steps.values()) {
        const idx = steps.findIndex((s) => s.id === id)
        if (idx !== -1) { steps[idx] = { ...steps[idx], ...patch }; return }
      }
    },
    upsertAutomationItem: (item: AutomationJobItem) => {
      const map = state.items.get(item.jobId) ?? new Map<string, AutomationJobItem>()
      map.set(item.id, { ...item })
      state.items.set(item.jobId, map)
    },
    download: (id: string) => state.downloads.get(id),
    upsertDownload: (d: { id: string; filePath?: string; durationSec?: number }) => state.downloads.set(d.id, { ...d }),
    providerConnection: (id: string) => state.connections.get(id),
    providerJob: (id: string) => state.providerJobs.get(id),
    providerJobs: (connectionId: string) => [...state.providerJobs.values()].filter((j) => j.connectionId === connectionId),
    sourceChannel: () => undefined,
    sourceChannelByUrl: () => undefined,
    getUploads: () => [],
    uploadStates: () => new Map(),
    getSourceVideos: () => [],
    myChannel: () => undefined,
    getTranscript: () => [],
    renderJob: () => undefined,
    getProjectImages: () => [],
    updateProject: () => {},
    nicheKeyForDownload: () => undefined
  })
}))

const settingsState = vi.hoisted(() => ({ current: { libraryFolder: '', transcriptionApiKey: 'groq-test-key' } }))

vi.mock('../../electron/store/settings', () => ({
  getSettings: () => ({
    libraryFolder: settingsState.current.libraryFolder,
    outputFolder: settingsState.current.libraryFolder,
    autoScrape: { enabled: false, frequency: 'Every 6 hours', delaySec: 0, retries: 0, proxy: '', cookiesPath: '' },
    background: { tray: true, startOnSignIn: false, notifications: false, webhook: '' },
    transcription: { apiKey: settingsState.current.transcriptionApiKey, model: 'whisper-large-v3-turbo' },
    detection: { auto: true, confirmBand: [0.6, 0.82] }
  })
}))

vi.mock('../../electron/ipc/scrape', () => ({ refreshChannel: vi.fn(), sourceVideos: vi.fn(async () => []) }))
vi.mock('../../electron/ipc/download', () => ({ startDownloads: vi.fn(async () => []), resume: vi.fn() }))
vi.mock('../../electron/ipc/compose', () => ({ createProject: vi.fn(), setImages: vi.fn(), sendToRender: vi.fn(), runTranscribe: vi.fn(async () => {}) }))
vi.mock('../../electron/services/queue', () => ({ runJob: vi.fn(async () => {}) }))
vi.mock('../../electron/services/downloader', () => ({ cancelDownload: vi.fn(() => false) }))
vi.mock('../../electron/services/render', () => ({ cancelRender: vi.fn(() => false), markCancelIntent: vi.fn() }))
vi.mock('../../electron/ipc/events', () => ({ emit: vi.fn(), hhmm: () => '00:00', pushActivity: vi.fn() }))
vi.mock('../../electron/services/notify', () => ({ notifyMessage: vi.fn() }))
vi.mock('../../electron/services/webhook', () => ({ postWebhook: vi.fn(async () => {}) }))
vi.mock('../../electron/services/broll', () => ({
  cachedBrollClipCount: vi.fn(() => 0),
  hasConfiguredBrollSource: vi.fn(() => false),
  readBrollManifestClipIds: vi.fn(() => [])
}))
vi.mock('../../electron/services/audio', () => ({ probeDuration: vi.fn(async () => 30) }))

const creation = vi.hoisted(() => ({
  createUploadedAudioVideo: vi.fn(),
  createScriptVideo: vi.fn()
}))
vi.mock('../../electron/providers/talkingphotos/creation', () => creation)

const pollerMock = vi.hoisted(() => ({ reconcileNonTerminalProviderJobs: vi.fn(async () => {}) }))
vi.mock('../../electron/providers/talkingphotos/poller', () => pollerMock)

vi.mock('../../electron/providers/talkingphotos/subtitles', () => ({ createProviderSubtitles: vi.fn(async () => ({})) }))
vi.mock('../../electron/providers/talkingphotos/localCaptions', () => ({ applyLocalCaptions: vi.fn(async () => ({})) }))

const transcribeMock = vi.hoisted(() => ({ transcribeAudio: vi.fn() }))
vi.mock('../../electron/services/transcribe', () => transcribeMock)

const {
  createAutomationJob,
  pauseAutomationJob,
  resumeAutomationJob,
  retryAutomationJob,
  startAutomationSupervisor
} = await import('../../electron/services/automation-supervisor')

describe('automation supervisor: talkingphotos step', () => {
  let dir = ''
  let outputFixture = ''

  function file(name: string, content = 'x'): string {
    const p = join(dir, name)
    writeFileSync(p, content)
    return p
  }

  /** Drives the fake-timer-scheduled supervisor loop until `predicate()` is true
   *  or the simulated clock budget is exhausted (fails loudly rather than hanging). */
  async function runUntil(predicate: () => boolean, budgetMs = 120_000, stepMs = 250): Promise<void> {
    let elapsed = 0
    while (!predicate() && elapsed < budgetMs) {
      await vi.advanceTimersByTimeAsync(stepMs)
      elapsed += stepMs
    }
    if (!predicate()) throw new Error('runUntil: predicate never became true within the simulated time budget')
  }

  beforeEach(() => {
    vi.useFakeTimers()
    resetState()
    dir = mkdtempSync(join(tmpdir(), 'me-auto-tp-'))
    settingsState.current.libraryFolder = dir
    settingsState.current.transcriptionApiKey = 'groq-test-key'
    outputFixture = file('output.mp4', 'fake-mp4-bytes')
    creation.createUploadedAudioVideo.mockReset()
    creation.createScriptVideo.mockReset()
    pollerMock.reconcileNonTerminalProviderJobs.mockReset().mockImplementation(async () => {})
    transcribeMock.transcribeAudio.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  function baseConfig(overrides: {
    localMediaPaths: string[]
    assetPaths: string[]
    talkingPhotos?: Partial<NonNullable<AutomationJobConfig['talkingPhotos']>>
  }): AutomationJobConfig {
    return {
      sourceKind: 'local-files',
      sourceId: '', sourceUrl: '', sourceName: '', sourceOrder: 'Latest', sourceCount: 1,
      selectedVideoIds: [], localMediaPaths: overrides.localMediaPaths, assetPaths: overrides.assetPaths,
      style: 'Clean', captionPreset: 'Hormozi', aspectRatios: ['16:9'],
      styleConfig: {
        videoStyle: 'Clean', captionPreset: 'Hormozi', captionFont: 'Montserrat', captionAnimation: 'Pop-in', captionPosition: 'bottom',
        captionLines: 1, captionPace: 'auto', wordsPerCaption: 2, highlightColor: '#f5b323', boxColor: '#111111', imageMode: 'sequence',
        crossfadeSec: 0.8, motionPreset: 'subtle', gradientEdge: 'none', gradientIntensity: 50, aspectRatio: '16:9', brollMode: 'off',
        brollDensity: 'sparse', brollPoolSize: 18, brollFallbackPolicy: 'prefer-selected', brollShufflePolicy: 'per-video'
      },
      rules: {
        minDurationSec: 0, skipDownloaded: true, continueOnError: true, maxRetries: 2, minimumFreeSpaceGb: 1,
        captions: false, autoBroll: false, removeSilence: false, reduceFillerWords: false, keepAwake: false,
        skipUploaded: false, fillSkippedSelections: false, allowStaleUploadCache: true, uploadFreshnessMinutes: 360,
        downloadDelaySec: 0, retryBaseDelaySec: 1, retryMaxDelaySec: 2
      },
      talkingPhotos: {
        characterPrompt: 'A friendly presenter', characterNegativePrompt: '', style: 'high_quality', aspectRatio: '16:9', motionId: 0,
        mode: 'uploaded-audio', script: '', language: 'en-US', voice: 'en-US-AndrewMultilingualNeural', voiceStyle: 'general',
        speed: 1, pitch: 0, subtitleMode: 'none',
        ...overrides.talkingPhotos
      },
      notify: { desktop: false, webhook: false, sound: false, email: false },
      execution: 'local'
    }
  }

  function createJob(name: string, config: AutomationJobConfig): AutomationJob {
    return createAutomationJob({ name, goal: 'talkingphotos-video', config })
  }

  function job(id: string): AutomationJob {
    const j = state.jobs.get(id)
    if (!j) throw new Error(`job ${id} not found`)
    return j
  }

  function itemsOf(jobId: string): AutomationJobItem[] {
    return [...(state.items.get(jobId)?.values() ?? [])]
  }

  function itemByTitle(jobId: string, title: string): AutomationJobItem {
    const found = itemsOf(jobId).find((i) => i.title === title)
    if (!found) throw new Error(`item titled "${title}" not found`)
    return found
  }

  const TERMINAL = new Set(['completed', 'completed_with_warnings', 'failed', 'attention', 'paused', 'cancelled'])

  // ---- 1. Mode wiring ------------------------------------------------------

  it('uploaded-audio mode calls createUploadedAudioVideo with the downloaded file path', async () => {
    const audioPath = file('recording.wav')
    const imagePath = file('character.png')
    creation.createUploadedAudioVideo.mockImplementation(async (input: { automationJobId: string; automationItemId: string }) =>
      makeProviderJob({ automationJobId: input.automationJobId, automationItemId: input.automationItemId, status: 'completed', localOutputPath: outputFixture, progress: 100 }))

    const created = createJob('uploaded-audio job', baseConfig({ localMediaPaths: [audioPath], assetPaths: [imagePath], talkingPhotos: { mode: 'uploaded-audio' } }))
    await runUntil(() => TERMINAL.has(job(created.id).status))

    expect(job(created.id).status).toBe('completed')
    expect(creation.createUploadedAudioVideo).toHaveBeenCalledTimes(1)
    expect(creation.createScriptVideo).not.toHaveBeenCalled()
    const call = creation.createUploadedAudioVideo.mock.calls[0][0]
    expect(call.audioPath).toBe(audioPath)
    expect(call.automationJobId).toBe(created.id)
  })

  it('custom-script mode calls createScriptVideo with options.script verbatim', async () => {
    const audioPath = file('recording2.wav')
    const imagePath = file('character2.png')
    const script = 'This is the exact custom script text.'
    creation.createScriptVideo.mockImplementation(async (input: { automationJobId: string; automationItemId: string }) =>
      makeProviderJob({ automationJobId: input.automationJobId, automationItemId: input.automationItemId, status: 'completed', localOutputPath: outputFixture, progress: 100 }))

    const created = createJob('custom-script job', baseConfig({ localMediaPaths: [audioPath], assetPaths: [imagePath], talkingPhotos: { mode: 'custom-script', script } }))
    await runUntil(() => TERMINAL.has(job(created.id).status))

    expect(job(created.id).status).toBe('completed')
    expect(creation.createScriptVideo).toHaveBeenCalledTimes(1)
    expect(creation.createUploadedAudioVideo).not.toHaveBeenCalled()
    expect(transcribeMock.transcribeAudio).not.toHaveBeenCalled()
    const call = creation.createScriptVideo.mock.calls[0][0]
    expect(call.script).toBe(script)
  })

  it('transcript-tts mode transcribes the downloaded audio and calls createScriptVideo with a script reconstructed from words (not the raw audio path)', async () => {
    const audioPath = file('recording3.wav')
    const imagePath = file('character3.png')
    const words: TimedWord[] = [
      { word: 'hello', start: 0, end: 0.3 },
      { word: 'world', start: 0.35, end: 0.7 },
      { word: 'this', start: 1.4, end: 1.6 },
      { word: 'is', start: 1.65, end: 1.8 },
      { word: 'tts', start: 1.85, end: 2.1 }
    ]
    const expectedScript = reconstructScriptFromWords(words)
    transcribeMock.transcribeAudio.mockResolvedValue(words)
    creation.createScriptVideo.mockImplementation(async (input: { automationJobId: string; automationItemId: string }) =>
      makeProviderJob({ automationJobId: input.automationJobId, automationItemId: input.automationItemId, status: 'completed', localOutputPath: outputFixture, progress: 100 }))

    const created = createJob('transcript-tts job', baseConfig({ localMediaPaths: [audioPath], assetPaths: [imagePath], talkingPhotos: { mode: 'transcript-tts' } }))
    await runUntil(() => TERMINAL.has(job(created.id).status))

    expect(job(created.id).status).toBe('completed')
    expect(transcribeMock.transcribeAudio).toHaveBeenCalledTimes(1)
    expect(transcribeMock.transcribeAudio.mock.calls[0][0]).toBe(audioPath)
    expect(creation.createScriptVideo).toHaveBeenCalledTimes(1)
    expect(creation.createUploadedAudioVideo).not.toHaveBeenCalled()
    const call = creation.createScriptVideo.mock.calls[0][0]
    expect(call.script).toBe(expectedScript)
    expect(call.script).not.toBe(audioPath)
    expect(call.script.length).toBeGreaterThan(0)
  })

  // ---- 2. Pause blocks new submissions but lets in-flight jobs sync --------

  it('pause blocks a new submission for a not-yet-started item, but an already-submitted job is still allowed to sync to completion', async () => {
    const pathA = file('item-one.wav')
    const pathB = file('item-two.wav')
    const imagePath = file('character4.png')

    // item-one's remote job is "in flight" (submitted, not yet complete) when the
    // sync call happens; that same sync call is what surfaces the pause request
    // arriving mid-poll, and the completion check right after it still runs.
    creation.createUploadedAudioVideo.mockImplementation(async (input: { automationJobId: string; automationItemId: string; title: string }) =>
      makeProviderJob({ automationJobId: input.automationJobId, automationItemId: input.automationItemId, status: 'running', progress: 40 }))
    pollerMock.reconcileNonTerminalProviderJobs.mockImplementation(async () => {
      for (const pj of state.providerJobs.values()) {
        if (pj.status !== 'completed') {
          state.providerJobs.set(pj.id, { ...pj, status: 'completed', localOutputPath: outputFixture, progress: 100 })
          const owner = pj.automationJobId
          if (owner) pauseAutomationJob(owner)
        }
      }
    })

    const created = createJob('pause job', baseConfig({ localMediaPaths: [pathA, pathB], assetPaths: [imagePath] }))
    await runUntil(() => job(created.id).status === 'paused')

    expect(creation.createUploadedAudioVideo).toHaveBeenCalledTimes(1) // never a second (new) submission for item-two
    expect(pollerMock.reconcileNonTerminalProviderJobs).toHaveBeenCalled() // the in-flight sync was allowed to happen
    const itemOne = itemByTitle(created.id, 'item-one')
    const itemTwo = itemByTitle(created.id, 'item-two')
    expect(itemOne.status).toBe('completed') // in-flight job was allowed to finish syncing
    expect(itemOne.outputPath).toBe(outputFixture)
    expect(itemOne.stepStates?.talkingphotos?.status).toBe('completed')
    // item-two's top-level `status` field is a generic per-step marker reused by
    // every step (it's still 'completed' from the earlier download step) — the
    // decisive signal that the talkingphotos step never touched it is the absence
    // of a talkingphotos stepState / a still-pre-talkingphotos currentStep.
    expect(itemTwo.stepStates?.talkingphotos).toBeUndefined()
    expect(itemTwo.currentStep).not.toBe('Create TalkingPhotos videos')
  })

  // ---- 3. Resume continues from the persisted checkpoint -------------------

  it('resume finds the existing correlated provider job and continues it instead of creating a duplicate', async () => {
    const audioPath = file('resume.wav')
    const imagePath = file('character5.png')
    let resolveNow = false

    creation.createUploadedAudioVideo.mockImplementation(async (input: { automationJobId: string; automationItemId: string }) =>
      makeProviderJob({ automationJobId: input.automationJobId, automationItemId: input.automationItemId, status: 'running', progress: 20 }))
    pollerMock.reconcileNonTerminalProviderJobs.mockImplementation(async () => {
      if (!resolveNow) return
      for (const pj of state.providerJobs.values()) {
        if (pj.status !== 'completed') state.providerJobs.set(pj.id, { ...pj, status: 'completed', localOutputPath: outputFixture, progress: 100 })
      }
    })

    const created = createJob('resume job', baseConfig({ localMediaPaths: [audioPath], assetPaths: [imagePath] }))

    // Let it run into the talkingphotos poll loop (submission happens, job stays
    // non-terminal), then pause mid-poll — simulating a pause requested while the
    // remote job was still in flight.
    await runUntil(() => creation.createUploadedAudioVideo.mock.calls.length > 0)
    pauseAutomationJob(created.id)
    await runUntil(() => job(created.id).status === 'paused')
    expect(creation.createUploadedAudioVideo).toHaveBeenCalledTimes(1)

    resumeAutomationJob(created.id)
    resolveNow = true
    await runUntil(() => TERMINAL.has(job(created.id).status))

    expect(job(created.id).status).toBe('completed')
    // Still exactly one submission across the whole pause -> resume cycle: the
    // resumed pass found the existing correlated job and continued it.
    expect(creation.createUploadedAudioVideo).toHaveBeenCalledTimes(1)
    expect(itemsOf(created.id)[0].outputPath).toBe(outputFixture)
  })

  // ---- 4. Restart does not recreate completed work --------------------------

  it('a fresh supervisor pass (simulated restart) does not resubmit an item whose TalkingPhotos job already completed', async () => {
    const pathA = file('restart-one.wav')
    const pathB = file('restart-two.wav')
    const imagePath = file('character6.png')

    // item-one's job goes through the normal in-flight sync path (like test 2)
    // and pause is requested from inside that sync call, *after* the completion
    // check has already run — so item-one genuinely finishes before item-two
    // (which never starts) is blocked.
    creation.createUploadedAudioVideo.mockImplementation(async (input: { automationJobId: string; automationItemId: string }) =>
      makeProviderJob({ automationJobId: input.automationJobId, automationItemId: input.automationItemId, status: 'running', progress: 50 }))
    pollerMock.reconcileNonTerminalProviderJobs.mockImplementation(async () => {
      for (const pj of state.providerJobs.values()) {
        if (pj.status !== 'completed') {
          state.providerJobs.set(pj.id, { ...pj, status: 'completed', localOutputPath: outputFixture, progress: 100 })
          if (pj.automationJobId) pauseAutomationJob(pj.automationJobId)
        }
      }
    })

    const created = createJob('restart job', baseConfig({ localMediaPaths: [pathA, pathB], assetPaths: [imagePath] }))
    await runUntil(() => job(created.id).status === 'paused')
    expect(creation.createUploadedAudioVideo).toHaveBeenCalledTimes(1)
    const restartOneBefore = itemByTitle(created.id, 'restart-one')
    expect(restartOneBefore.status).toBe('completed')
    expect(restartOneBefore.stepStates?.talkingphotos?.status).toBe('completed')
    expect(itemByTitle(created.id, 'restart-two').stepStates?.talkingphotos).toBeUndefined()

    // Simulate a hard crash: the persisted job status is stuck at 'running'
    // rather than the graceful 'paused' our test harness just produced.
    const stuck = job(created.id)
    state.jobs.set(created.id, { ...stuck, status: 'running', pauseRequested: false })

    // Now item-two should submit normally; item-one must never submit again.
    creation.createUploadedAudioVideo.mockImplementation(async (input: { automationJobId: string; automationItemId: string }) =>
      makeProviderJob({ automationJobId: input.automationJobId, automationItemId: input.automationItemId, status: 'completed', localOutputPath: outputFixture, progress: 100 }))

    startAutomationSupervisor()
    await runUntil(() => TERMINAL.has(job(created.id).status))

    expect(job(created.id).status).toBe('completed')
    expect(creation.createUploadedAudioVideo).toHaveBeenCalledTimes(2) // one for restart-one (before), one for restart-two (after restart)
    const restartOneCalls = creation.createUploadedAudioVideo.mock.calls.filter((c) => c[0].automationItemId === itemByTitle(created.id, 'restart-one').id)
    expect(restartOneCalls).toHaveLength(1)
  })

  // ---- 5. Retry does not duplicate paid jobs --------------------------------

  it('retrying a failed item reuses the existing correlated provider job instead of submitting a brand-new one', async () => {
    const audioPath = file('retry.wav')
    const imagePath = file('character7.png')
    let outcome: 'attention' | 'completed' = 'attention'

    creation.createUploadedAudioVideo.mockImplementation(async (input: { automationJobId: string; automationItemId: string }) =>
      makeProviderJob({ automationJobId: input.automationJobId, automationItemId: input.automationItemId, status: 'running', progress: 10 }))
    pollerMock.reconcileNonTerminalProviderJobs.mockImplementation(async () => {
      for (const pj of state.providerJobs.values()) {
        if (outcome === 'attention' && pj.status === 'running') state.providerJobs.set(pj.id, { ...pj, status: 'attention', errorMessage: 'Needs manual review.' })
        else if (outcome === 'completed' && pj.status !== 'completed') state.providerJobs.set(pj.id, { ...pj, status: 'completed', localOutputPath: outputFixture, progress: 100 })
      }
    })

    const created = createJob('retry job', baseConfig({ localMediaPaths: [audioPath], assetPaths: [imagePath] }))
    await runUntil(() => TERMINAL.has(job(created.id).status))
    expect(job(created.id).status).toBe('attention')
    expect(itemsOf(created.id)[0].status).toBe('failed')
    expect(creation.createUploadedAudioVideo).toHaveBeenCalledTimes(1)

    outcome = 'completed'
    retryAutomationJob(created.id)
    await runUntil(() => TERMINAL.has(job(created.id).status))

    expect(job(created.id).status).toBe('completed')
    // The retry must have found and reused the existing (already-paid-for) job —
    // never a second createUploadedAudioVideo call.
    expect(creation.createUploadedAudioVideo).toHaveBeenCalledTimes(1)
    expect(itemsOf(created.id)[0].outputPath).toBe(outputFixture)
  })

  // ---- 6. One item's failure doesn't corrupt other batch items -------------

  it('one item failing to submit does not prevent the other items in the same batch from completing', async () => {
    const pathA = file('batch-one.wav')
    const pathB = file('batch-two.wav')
    const imagePath = file('character8.png')

    creation.createUploadedAudioVideo.mockImplementation(async (input: { automationJobId: string; automationItemId: string; title: string }) => {
      if (input.title === 'batch-one') throw new Error('Simulated provider rejection for batch-one.')
      return makeProviderJob({ automationJobId: input.automationJobId, automationItemId: input.automationItemId, status: 'completed', localOutputPath: outputFixture, progress: 100 })
    })

    const created = createJob('batch job', baseConfig({ localMediaPaths: [pathA, pathB], assetPaths: [imagePath] }))
    await runUntil(() => TERMINAL.has(job(created.id).status))

    expect(job(created.id).status).toBe('completed_with_warnings')
    expect(creation.createUploadedAudioVideo).toHaveBeenCalledTimes(2)
    expect(itemByTitle(created.id, 'batch-one').status).toBe('failed')
    const other = itemByTitle(created.id, 'batch-two')
    expect(other.status).toBe('completed')
    expect(other.outputPath).toBe(outputFixture)
  })
})
