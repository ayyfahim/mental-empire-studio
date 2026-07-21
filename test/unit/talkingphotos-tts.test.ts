import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Main-process-only TTS submission + WebSocket resolution. The socket is faked as an
// EventEmitter so each test controls exactly which frame arrives on which connection —
// this is how "no cross-association between concurrent TTS operations" is proven: one
// socket instance per UUID, never a shared/multiplexed connection.

const sockets: FakeSocket[] = []

class FakeSocket extends EventEmitter {
  sent: string[] = []
  closed = false
  constructor(public url: string) {
    super()
    sockets.push(this)
    queueMicrotask(() => this.emit('open'))
  }
  send(data: string): void { this.sent.push(data) }
  close(): void { this.closed = true }
}

vi.mock('ws', () => ({ default: FakeSocket }))
vi.mock('../../electron/services/logger', () => ({ L: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

let nextUuid = 0
const ttsCreateMock = vi.fn(async (input: { text: string }) => ({ uuid: `tts-uuid-${++nextUuid}`, textValue: input.text }))
vi.mock('../../electron/providers/talkingphotos/client', () => ({
  createTtsAudio: ttsCreateMock,
  ensureLibraryCategory: vi.fn(async () => ({ id: 'tts-category', title: 'Text To Speech' })),
  listLibraryMedia: vi.fn(async () => [
    { id: 'media-old', title: 'older', type: 'audio', extension: 'wav' },
    { id: 'media-new', title: 'newer', type: 'audio', extension: 'wav' }
  ])
}))

const jobs = new Map<string, Record<string, unknown>>()
vi.mock('../../electron/db', () => ({
  getRepos: () => ({
    providerJob: (id: string) => jobs.get(id),
    providerJobs: () => [...jobs.values()],
    upsertProviderJob: (job: Record<string, unknown>) => jobs.set(job.id as string, { ...job }),
    updateProviderJob: (id: string, patch: Record<string, unknown>) => {
      const current = jobs.get(id)
      if (current) jobs.set(id, { ...current, ...patch, updatedAt: new Date().toISOString() })
    }
  })
}))

const { confirmRecoveredTts, listTtsLibraryForRecovery, reconcileUnresolvedTtsJobsOnStartup, resolveTtsJob, submitTts } = await import('../../electron/providers/talkingphotos/tts')

const SETTINGS = { language: 'en-US', voice: 'en-US-AndrewMultilingualNeural', voiceStyle: 'general', speed: 1, pitch: 0, autoTranslate: false }

beforeEach(() => {
  jobs.clear()
  sockets.length = 0
  nextUuid = 0
  ttsCreateMock.mockClear()
})

describe('TTS submission + WebSocket resolution', () => {
  it('persists the UUID immediately on submission, before any socket activity', async () => {
    const job = await submitTts({ text: 'Hello world', settings: SETTINGS, projectStyle: 'high_quality' })
    expect(job.operation).toBe('tts')
    expect(job.internalSegment).toBe(true)
    const state = JSON.parse(job.requestJson as string)
    expect(state.uuid).toBe('tts-uuid-1')
    expect(state.status).toBe('submitted')
  })

  it('resolves a valid completion frame into a completed job with the correct media id/duration', async () => {
    const job = await submitTts({ text: 'Hello world', settings: SETTINGS, projectStyle: 'high_quality' })
    const resolution = resolveTtsJob(job.id)
    await Promise.resolve() // let the socket construct + 'open' microtask run
    expect(sockets).toHaveLength(1)
    expect(JSON.parse(sockets[0].sent[0])).toEqual({ recipient_uuid: 'tts-uuid-1', message: 'connected' })
    sockets[0].emit('message', Buffer.from(JSON.stringify({ media_id: 4242, type: 'audio', out_path: '/tts/4242.wav', code: 200, duration: 8.5 })))
    const resolved = await resolution
    expect(resolved.status).toBe('completed')
    expect(resolved.remoteMediaId).toBe('4242')
    const state = JSON.parse(resolved.requestJson as string)
    expect(state.status).toBe('resolved')
    expect(state.durationSec).toBe(8.5)
    expect(sockets[0].closed).toBe(true)
  })

  it('two simultaneous TTS operations never cross-associate a result — each resolves from its OWN socket only', async () => {
    const jobA = await submitTts({ text: 'Script A', settings: SETTINGS, projectStyle: 'high_quality' })
    const jobB = await submitTts({ text: 'Script B', settings: SETTINGS, projectStyle: 'high_quality' })
    const pA = resolveTtsJob(jobA.id)
    const pB = resolveTtsJob(jobB.id)
    await Promise.resolve()
    expect(sockets).toHaveLength(2)
    // Resolve B's socket first, with A's media id in the frame content is irrelevant —
    // correlation is structural (which socket), not by inspecting frame identity.
    sockets[1].emit('message', Buffer.from(JSON.stringify({ media_id: 2000, type: 'audio', out_path: '/b.wav', code: 200, duration: 4 })))
    sockets[0].emit('message', Buffer.from(JSON.stringify({ media_id: 1000, type: 'audio', out_path: '/a.wav', code: 200, duration: 3 })))
    const [resolvedA, resolvedB] = await Promise.all([pA, pB])
    expect(resolvedA.remoteMediaId).toBe('1000')
    expect(resolvedB.remoteMediaId).toBe('2000')
  })

  it('a malformed (non-JSON) frame moves the job to attention without resubmitting', async () => {
    const job = await submitTts({ text: 'Hello', settings: SETTINGS, projectStyle: 'high_quality' })
    const resolution = resolveTtsJob(job.id)
    await Promise.resolve()
    sockets[0].emit('message', Buffer.from('not-json{'))
    const result = await resolution
    expect(result.status).toBe('attention')
    expect(result.errorCode).toBe('tts_unresolved')
    expect(JSON.parse(result.requestJson as string).status).toBe('malformed')
    expect(ttsCreateMock).toHaveBeenCalledTimes(1) // never resubmitted
  })

  it('an unexpected close before any frame moves the job to attention, preserving the UUID', async () => {
    const job = await submitTts({ text: 'Hello', settings: SETTINGS, projectStyle: 'high_quality' })
    const resolution = resolveTtsJob(job.id)
    await Promise.resolve()
    sockets[0].emit('close')
    const result = await resolution
    expect(result.status).toBe('attention')
    const state = JSON.parse(result.requestJson as string)
    expect(state.status).toBe('closed_unresolved')
    expect(state.uuid).toBe('tts-uuid-1') // preserved, not cleared
  })

  it('times out and moves to attention if no frame ever arrives', async () => {
    vi.useFakeTimers()
    try {
      const job = await submitTts({ text: 'Hello', settings: SETTINGS, projectStyle: 'high_quality' })
      const resolution = resolveTtsJob(job.id)
      await vi.advanceTimersByTimeAsync(4 * 60_000 + 1_000)
      const result = await resolution
      expect(result.status).toBe('attention')
      expect(JSON.parse(result.requestJson as string).status).toBe('timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses to re-resolve an already-resolved job (idempotent, no double socket)', async () => {
    const job = await submitTts({ text: 'Hello', settings: SETTINGS, projectStyle: 'high_quality' })
    const first = resolveTtsJob(job.id)
    await Promise.resolve()
    sockets[0].emit('message', Buffer.from(JSON.stringify({ media_id: 1, type: 'audio', out_path: '/1.wav', code: 200, duration: 1 })))
    await first
    const second = await resolveTtsJob(job.id)
    expect(second.status).toBe('completed')
    expect(sockets).toHaveLength(1) // no second socket opened
  })
})

describe('Startup recovery for unresolved TTS jobs', () => {
  it('marks a job stuck mid-flight as attention on restart, without regenerating it', () => {
    jobs.set('tpj-tts-stuck', {
      id: 'tpj-tts-stuck', provider: 'talkingphotos', connectionId: 'default', operation: 'tts', status: 'running', progress: 20, internalSegment: true,
      createdAt: '', updatedAt: '',
      requestJson: JSON.stringify({ version: 1, uuid: 'stuck-uuid', text: 'x', settings: SETTINGS, projectStyle: 'high_quality', status: 'awaiting_resolution', submittedAt: '' })
    })
    const marked = reconcileUnresolvedTtsJobsOnStartup()
    expect(marked).toBe(1)
    const job = jobs.get('tpj-tts-stuck')!
    expect(job.status).toBe('attention')
    expect(JSON.parse(job.requestJson as string).uuid).toBe('stuck-uuid')
    expect(ttsCreateMock).not.toHaveBeenCalled()
  })

  it('leaves an already-resolved job untouched', () => {
    jobs.set('tpj-tts-done', {
      id: 'tpj-tts-done', provider: 'talkingphotos', connectionId: 'default', operation: 'tts', status: 'completed', progress: 100, internalSegment: true,
      createdAt: '', updatedAt: '',
      requestJson: JSON.stringify({ version: 1, uuid: 'done-uuid', text: 'x', settings: SETTINGS, projectStyle: 'high_quality', status: 'resolved', submittedAt: '', resolvedAt: '' })
    })
    expect(reconcileUnresolvedTtsJobsOnStartup()).toBe(0)
  })
})

describe('Manual, explicit TTS recovery — never automatic newest-item matching', () => {
  it('lists the library verbatim (no sort-by-recency or auto-pick)', async () => {
    const list = await listTtsLibraryForRecovery()
    expect(list.map((m) => m.id)).toEqual(['media-old', 'media-new'])
  })

  it('confirmRecoveredTts uses exactly the caller-supplied id, not the newest list item', async () => {
    jobs.set('tpj-tts-manual', {
      id: 'tpj-tts-manual', provider: 'talkingphotos', connectionId: 'default', operation: 'tts', status: 'attention', progress: 20, internalSegment: true,
      createdAt: '', updatedAt: '',
      requestJson: JSON.stringify({ version: 1, uuid: 'manual-uuid', text: 'x', settings: SETTINGS, projectStyle: 'high_quality', status: 'closed_unresolved', submittedAt: '' })
    })
    // The "newest" library item is media-new, but the user explicitly picks the older one.
    const result = confirmRecoveredTts('tpj-tts-manual', 'media-old', 9.9)
    expect(result.status).toBe('completed')
    expect(result.remoteMediaId).toBe('media-old')
    expect(JSON.parse(result.requestJson as string)).toMatchObject({ status: 'resolved', mediaId: 'media-old', durationSec: 9.9 })
  })

  it('rejects recovery for a non-tts job', () => {
    jobs.set('tpj-video', { id: 'tpj-video', operation: 'video', status: 'attention', requestJson: '{}' })
    expect(() => confirmRecoveredTts('tpj-video', 'media-x', 5)).toThrow()
  })
})
