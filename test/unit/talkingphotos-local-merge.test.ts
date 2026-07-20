import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderJob } from '../../shared/talkingphotos'

// electron/providers/talkingphotos/localMerge.ts is the ffmpeg-based fallback used once
// TalkingPhotos' remote /project/merge_videos has already failed once (see
// attemptLocalMergeFallback in creation.ts). No real ffmpeg binary is available in the
// sandbox (per CLAUDE.md's testing model), so — following the same "stub at the
// external-process boundary, exercise the real node:fs flow" convention as
// talkingphotos-downloader.test.ts (which fakes electron's net.request with an
// EventEmitter around a real .part -> validate -> atomic-rename lifecycle) — this stubs
// 'node:child_process' spawn with a fake ffmpeg process. On a simulated success the fake
// process writes a small placeholder file to the command's declared output path, so
// localMerge.ts's real writeFileSync/renameSync/existsSync calls still run against a
// real temp directory.

let ffmpegShouldSucceed: (args: string[]) => boolean = () => true
let ffmpegCalls: string[][] = []
// Contents of the ffconcat list file at the moment each concat-demuxer invocation ran
// (captured before localMerge.ts's own `finally` block deletes it), so tests can assert
// input ordering without needing to export/inspect localMerge.ts's internals.
let capturedConcatLists: string[] = []

vi.mock('node:child_process', () => ({
  spawn: vi.fn((_cmd: string, args: string[]) => {
    ffmpegCalls.push(args)
    const concatFlagIndex = args.indexOf('-f')
    if (concatFlagIndex !== -1 && args[concatFlagIndex + 1] === 'concat') {
      const listPath = args[args.indexOf('-i') + 1]
      try { capturedConcatLists.push(readFileSync(listPath, 'utf8')) } catch { /* list file already gone */ }
    }
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
    child.stderr = new EventEmitter()
    const ok = ffmpegShouldSucceed(args)
    queueMicrotask(() => {
      if (ok) {
        // ffmpeg's declared output is always the last CLI argument for both the
        // concat-demuxer and transcode invocations built in localMerge.ts.
        const outPath = args[args.length - 1]
        try { writeFileSync(outPath, 'fake-merged-media-bytes') } catch { /* ignore */ }
        child.emit('close', 0)
      } else {
        child.stderr.emit('data', Buffer.from('mock ffmpeg failure'))
        child.emit('close', 1)
      }
    })
    return child
  })
}))

vi.mock('../../electron/services/bin', () => ({ ffmpegPath: () => 'fake-ffmpeg-binary' }))
vi.mock('../../electron/services/logger', () => ({ L: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

// Queue of durations probeDuration should report on successive calls; once drained it
// falls back to a constant "healthy" duration so tests that don't care about the exact
// call count still pass.
let nextDurations: number[] = []
const probeDuration = vi.fn(async () => (nextDurations.length ? (nextDurations.shift() as number) : 42))
vi.mock('../../electron/services/audio', () => ({ probeDuration }))

// ---------------------------------------------------------------------------------
// Mocks below this line are only exercised by the second describe block, which drives
// electron/providers/talkingphotos/creation.ts's attemptLocalMergeFallback indirectly
// through the exported advanceProviderOrchestrations (attemptLocalMergeFallback itself
// is not exported, matching the existing convention in talkingphotos-creation.test.ts of
// only calling public entry points). localMerge.ts itself is intentionally left
// unmocked here too, so these tests exercise the real merge machinery (via the same
// 'node:child_process' stub above) end-to-end, rather than just asserting a mock was
// called with the right arguments.
// ---------------------------------------------------------------------------------

const jobStore = new Map<string, ProviderJob>()

const client = vi.hoisted(() => ({
  ensureLibraryCategory: vi.fn(async (title: string) => ({ id: title })),
  uploadLibraryMedia: vi.fn(async () => ({ id: 'media', title: 'media', type: 'audio', extension: 'wav' })),
  getDurationLimit: vi.fn(async () => 60),
  getProjectLimits: vi.fn(async () => ({ maxDurationSec: 60, maxCharactersTts: 6000 })),
  trimLibraryMedia: vi.fn(async () => ({ id: 'trim', title: 'trim', type: 'audio', extension: 'wav' })),
  createCharacterImage: vi.fn(async () => 'character-result'),
  createHumanProject: vi.fn(async (payload: { title: string }) => ({ id: 'project', title: payload.title, type: 'human', status: 'pending', createdDate: new Date().toISOString(), updatedDate: new Date().toISOString() })),
  mergeProjects: vi.fn(async (input: { projectIds: string[]; title: string }) => ({ id: 'merged-remote-project', title: input.title, type: 'video_merge', status: 'pending', createdDate: new Date().toISOString(), updatedDate: new Date().toISOString() })),
  listProjects: vi.fn(async () => []),
  getCapabilities: vi.fn(async () => ({
    limits: { maxDurationSeconds: 300, maxCharactersTts: 6000, maxDurationPremiumSeconds: 300, maxCharactersTtsPremium: 6000 },
    usage: { concurrentCount: 0, concurrentLimit: 5, dailyUsage: 0, dailyLimit: 100 },
    fetchedAt: new Date().toISOString()
  })),
  ProviderRequestError: class ProviderRequestError extends Error {
    normalized: { kind: string; message: string }
    constructor(normalized: { kind: string; message: string }) { super(normalized.message); this.normalized = normalized }
  }
}))
vi.mock('../../electron/providers/talkingphotos/client', () => client)

vi.mock('../../electron/providers/talkingphotos/tts', () => ({
  submitTts: vi.fn(),
  resolveTtsJob: vi.fn()
}))

const downloadProviderJobOutput = vi.fn()
let outputDirPath = ''
vi.mock('../../electron/providers/talkingphotos/downloader', () => ({
  downloadProviderJobOutput: (...args: unknown[]) => downloadProviderJobOutput(...args),
  outputDir: () => outputDirPath
}))

vi.mock('../../electron/db', () => ({
  getRepos: () => ({
    providerConnection: () => ({ id: 'default', provider: 'talkingphotos', partition: 'persist:talkingphotos:default', status: 'connected', createdAt: '', updatedAt: '' }),
    upsertProviderConnection: vi.fn(),
    providerJob: (id: string) => jobStore.get(id),
    providerJobs: () => [...jobStore.values()],
    upsertProviderJob: (job: ProviderJob) => jobStore.set(job.id, { ...job }),
    findOrCreateProviderJob: (job: ProviderJob) => {
      const existing = [...jobStore.values()].find((c) => c.requestFingerprint === job.requestFingerprint)
      if (existing) return { job: existing, created: false }
      jobStore.set(job.id, { ...job })
      return { job, created: true }
    },
    automationJob: () => undefined,
    updateProviderJob: (id: string, patch: Partial<ProviderJob>) => {
      const current = jobStore.get(id)
      if (current) jobStore.set(id, { ...current, ...patch, updatedAt: new Date().toISOString() })
    },
    providerAssetByHash: () => undefined,
    upsertProviderAsset: vi.fn()
  })
}))

const { mergeVideoFilesLocally, LocalMergeFailure } = await import('../../electron/providers/talkingphotos/localMerge')
const { advanceProviderOrchestrations } = await import('../../electron/providers/talkingphotos/creation')

describe('TalkingPhotos local ffmpeg merge fallback (localMerge.ts)', () => {
  let dir = ''
  let inputA = ''
  let inputB = ''
  let outputPath = ''

  beforeEach(() => {
    ffmpegCalls = []
    ffmpegShouldSucceed = () => true
    nextDurations = []
    probeDuration.mockClear()
    dir = mkdtempSync(join(tmpdir(), 'me-tp-localmerge-'))
    inputA = join(dir, 'seg-0.mp4')
    inputB = join(dir, 'seg-1.mp4')
    writeFileSync(inputA, 'segment-a-bytes')
    writeFileSync(inputB, 'segment-b-bytes')
    outputPath = join(dir, 'merged.mp4')
  })

  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('merges via the lossless concat demuxer, writing a .part file then renaming it atomically once duration is validated', async () => {
    await mergeVideoFilesLocally([inputA, inputB], outputPath)

    expect(existsSync(outputPath)).toBe(true)
    expect(existsSync(`${outputPath}.part`)).toBe(false)
    expect(ffmpegCalls).toHaveLength(1)
    expect(ffmpegCalls[0]).toEqual(expect.arrayContaining(['-f', 'concat', '-c', 'copy']))
    expect(ffmpegCalls[0]).not.toContain('libx264')
    // Duration is validated (>0) via probeDuration before the atomic rename; the
    // concat-branch's own "is this actually good" check and the final pre-rename
    // validation both hit the same tmp file.
    expect(probeDuration).toHaveBeenCalledTimes(2)
    expect(probeDuration.mock.calls.every(([path]) => path === `${outputPath}.part`)).toBe(true)
  })

  it('falls back to transcodeConcat when the concat demuxer ffmpeg invocation itself fails, and validates that output the same way', async () => {
    ffmpegShouldSucceed = (args) => args.includes('libx264') // only the transcode call succeeds
    await mergeVideoFilesLocally([inputA, inputB], outputPath)

    expect(existsSync(outputPath)).toBe(true)
    expect(ffmpegCalls).toHaveLength(2)
    expect(ffmpegCalls[0]).toEqual(expect.arrayContaining(['-f', 'concat']))
    expect(ffmpegCalls[1]).toEqual(expect.arrayContaining(['-filter_complex', '-c:v', 'libx264', '-c:a', 'aac']))
    // The failed concat attempt short-circuits before ever probing duration (ok=false);
    // only the successful transcode output gets validated before rename.
    expect(probeDuration).toHaveBeenCalledTimes(1)
  })

  it('falls back to transcodeConcat when the concat demuxer "succeeds" but produces a 0-duration (unreadable) file', async () => {
    nextDurations = [0] // concat demuxer's own output fails the >0 duration check
    await mergeVideoFilesLocally([inputA, inputB], outputPath)

    expect(existsSync(outputPath)).toBe(true)
    expect(ffmpegCalls).toHaveLength(2)
    expect(ffmpegCalls[1]).toEqual(expect.arrayContaining(['libx264']))
    expect(probeDuration).toHaveBeenCalledTimes(2) // 0 (concat) then a healthy duration (transcode)
  })

  it('throws LocalMergeFailure before invoking ffmpeg at all when an input path does not exist', async () => {
    rmSync(inputB)
    await expect(mergeVideoFilesLocally([inputA, inputB], outputPath)).rejects.toThrow(LocalMergeFailure)
    expect(ffmpegCalls).toHaveLength(0)
    expect(existsSync(outputPath)).toBe(false)
  })

  it('throws LocalMergeFailure and leaves no .part or final file behind when both the concat demuxer and the transcode fallback fail', async () => {
    ffmpegShouldSucceed = () => false
    await expect(mergeVideoFilesLocally([inputA, inputB], outputPath)).rejects.toThrow(LocalMergeFailure)
    expect(ffmpegCalls).toHaveLength(2) // both the concat demuxer and the transcode fallback were attempted
    expect(existsSync(outputPath)).toBe(false)
    expect(existsSync(`${outputPath}.part`)).toBe(false)
  })

  it('throws LocalMergeFailure (never renaming into the destination) when ffmpeg reports success but the merged output is unreadable', async () => {
    // Concat demuxer "succeeds" with a 0-duration file, transcodeConcat also
    // "succeeds" but its output is likewise unreadable — the final pre-rename
    // validation must still catch this and never leave a broken file at outputPath.
    nextDurations = [0, 0]
    await expect(mergeVideoFilesLocally([inputA, inputB], outputPath)).rejects.toThrow(LocalMergeFailure)
    expect(ffmpegCalls).toHaveLength(2)
    expect(existsSync(outputPath)).toBe(false)
    expect(existsSync(`${outputPath}.part`)).toBe(false)
  })

  it('rejects a single input — a local merge is meaningless with fewer than two segments', async () => {
    await expect(mergeVideoFilesLocally([inputA], outputPath)).rejects.toThrow(LocalMergeFailure)
    expect(ffmpegCalls).toHaveLength(0)
  })
})

describe('TalkingPhotos local merge fallback orchestration (attemptLocalMergeFallback via creation.ts)', () => {
  let dir = ''
  let outDir = ''

  function makeRoot(opts: { segmentCount: number; status: ProviderJob['status']; errorCode?: string; title?: string }): ProviderJob {
    const { segmentCount, status, errorCode = '', title = 'Two-part video' } = opts
    const segments = Array.from({ length: segmentCount }, (_, i) => ({
      ordinal: i, startSec: i * 100, endSec: (i + 1) * 100, durationSec: 100
    }))
    const at = '2026-01-01T00:00:00.000Z'
    return {
      id: 'tpj-root', provider: 'talkingphotos', connectionId: 'default', operation: 'merge',
      status, errorCode, progress: 88, internalSegment: false, createdAt: at, updatedAt: at,
      requestJson: JSON.stringify({
        version: 1,
        input: { title, audioPath: 'a.wav', characterImagePath: 'c.png', characterPrompt: 'p', style: 'high_quality', aspectRatio: '16:9', motionId: 0 },
        sourceDurationSec: segmentCount * 100, maxSegmentSec: 100,
        sourceAudioMediaId: 'audio-media', characterDrivingMediaId: 'char-media', characterResultUuid: 'char-result',
        segments, stage: 'segments_submitted', startedAt: at
      })
    }
  }

  function makeChild(rootId: string, ordinal: number, localOutputPath?: string): ProviderJob {
    const at = '2026-01-01T00:00:00.000Z'
    return {
      id: `${rootId}-segment-${String(ordinal + 1).padStart(3, '0')}`, provider: 'talkingphotos', connectionId: 'default',
      operation: 'video', parentProviderJobId: rootId, segmentOrdinal: ordinal, internalSegment: true,
      status: 'completed', progress: 100, remoteProjectId: `project-${ordinal}`,
      localOutputPath, createdAt: at, updatedAt: at
    }
  }

  beforeEach(() => {
    ffmpegCalls = []
    capturedConcatLists = []
    ffmpegShouldSucceed = () => true
    nextDurations = []
    probeDuration.mockClear()
    jobStore.clear()
    downloadProviderJobOutput.mockReset()
    client.mergeProjects.mockClear()
    dir = mkdtempSync(join(tmpdir(), 'me-tp-fallback-'))
    outDir = join(dir, 'output')
    mkdirSync(outDir, { recursive: true })
    outputDirPath = outDir
  })

  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('triggers the local ffmpeg fallback only once remote merge has already failed (status attention + errorCode submitting_merge), never for a merge that has not been attempted yet', async () => {
    const root = makeRoot({ segmentCount: 2, status: 'attention', errorCode: 'submitting_merge' })
    const childA = makeChild(root.id, 0, join(dir, 'child-0.mp4'))
    const childB = makeChild(root.id, 1, join(dir, 'child-1.mp4'))
    writeFileSync(childA.localOutputPath!, 'child-0-bytes')
    writeFileSync(childB.localOutputPath!, 'child-1-bytes')
    jobStore.set(root.id, root)
    jobStore.set(childA.id, childA)
    jobStore.set(childB.id, childB)

    await advanceProviderOrchestrations()

    expect(ffmpegCalls.length).toBeGreaterThan(0) // the real local-merge path actually ran ffmpeg
    expect(client.mergeProjects).not.toHaveBeenCalled() // remote merge was NOT re-attempted
    const updated = jobStore.get(root.id)!
    expect(updated.status).toBe('completed')
    expect(updated.errorCode).toBe('local_merge_fallback')
  })

  it('does NOT run the local fallback for a root that has not yet attempted a remote merge — it submits mergeProjects instead', async () => {
    const root = makeRoot({ segmentCount: 2, status: 'running', errorCode: '' })
    const childA = makeChild(root.id, 0, join(dir, 'child-0.mp4'))
    const childB = makeChild(root.id, 1, join(dir, 'child-1.mp4'))
    writeFileSync(childA.localOutputPath!, 'child-0-bytes')
    writeFileSync(childB.localOutputPath!, 'child-1-bytes')
    jobStore.set(root.id, root)
    jobStore.set(childA.id, childA)
    jobStore.set(childB.id, childB)

    await advanceProviderOrchestrations()

    expect(ffmpegCalls).toHaveLength(0) // no local merge attempted
    expect(downloadProviderJobOutput).not.toHaveBeenCalled()
    expect(client.mergeProjects).toHaveBeenCalledTimes(1)
    expect(client.mergeProjects).toHaveBeenCalledWith({ projectIds: ['project-0', 'project-1'], title: 'Two-part video' })
    const updated = jobStore.get(root.id)!
    expect(updated.remoteProjectId).toBe('merged-remote-project')
    expect(updated.status).toBe('queued') // remote submission accepted, not a local-fallback completion
  })

  it('downloads a child output only when it is missing locally, never re-downloading one that already exists on disk', async () => {
    const root = makeRoot({ segmentCount: 2, status: 'attention', errorCode: 'submitting_merge' })
    const existingPath = join(dir, 'child-0-existing.mp4')
    writeFileSync(existingPath, 'child-0-existing-bytes')
    const childA = makeChild(root.id, 0, existingPath) // already on disk
    const childB = makeChild(root.id, 1, undefined) // never downloaded
    const downloadedPath = join(dir, 'child-1-downloaded.mp4')
    downloadProviderJobOutput.mockImplementation(async (id: string) => {
      writeFileSync(downloadedPath, 'child-1-downloaded-bytes')
      return { ...jobStore.get(id), localOutputPath: downloadedPath }
    })
    jobStore.set(root.id, root)
    jobStore.set(childA.id, childA)
    jobStore.set(childB.id, childB)

    await advanceProviderOrchestrations()

    expect(downloadProviderJobOutput).toHaveBeenCalledTimes(1)
    expect(downloadProviderJobOutput).toHaveBeenCalledWith(childB.id)
    expect(downloadProviderJobOutput).not.toHaveBeenCalledWith(childA.id)
    const updated = jobStore.get(root.id)!
    expect(updated.status).toBe('completed')
  })

  it('merges children in segmentOrdinal order regardless of DB fetch order, and never aliases the root output to a single child path (audit trail preserved, not erased)', async () => {
    const root = makeRoot({ segmentCount: 3, status: 'attention', errorCode: 'submitting_merge', title: 'Three-part video' })
    const paths = [0, 1, 2].map((i) => join(dir, `child-${i}.mp4`))
    paths.forEach((p, i) => writeFileSync(p, `child-${i}-bytes`))
    const children = [0, 1, 2].map((i) => makeChild(root.id, i, paths[i]))

    jobStore.set(root.id, root)
    // Insert children out of ordinal order to prove the merge input list is sorted
    // independent of provider_jobs fetch/insertion order.
    jobStore.set(children[2].id, children[2])
    jobStore.set(children[0].id, children[0])
    jobStore.set(children[1].id, children[1])

    await advanceProviderOrchestrations()

    expect(capturedConcatLists.length).toBeGreaterThan(0)
    const lastList = capturedConcatLists[capturedConcatLists.length - 1]
    const orderedPaths = [...lastList.matchAll(/file '([^']*)'/g)].map((m) => m[1])
    expect(orderedPaths).toEqual(paths.map((p) => p.replace(/'/g, "'\\''")))

    const updated = jobStore.get(root.id)!
    expect(updated.status).toBe('completed')
    expect(updated.localOutputPath).toBeTruthy()
    // The final output is a real, freshly-merged file at a distinct path — never one
    // of the child segments' own files.
    expect(paths).not.toContain(updated.localOutputPath)
    expect(existsSync(updated.localOutputPath!)).toBe(true)
    expect(readFileSync(updated.localOutputPath!, 'utf8')).toBe('fake-merged-media-bytes')
    // The fact remote merge failed first stays visible for audit — errorCode/message
    // are re-labeled to reflect the fallback, never blanked out to '' as if nothing
    // had gone wrong upstream.
    expect(updated.errorCode).toBe('local_merge_fallback')
    expect(updated.errorMessage).toMatch(/remote merge/i)
    expect(updated.errorMessage).toContain('Three-part video')
    expect(updated.errorMessage).toContain('3')
  })
})
