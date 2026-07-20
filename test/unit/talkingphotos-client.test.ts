import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Session-bound request selection + reauth detection, exercised end-to-end against a
// fake net.request — proves the client always binds to the TalkingPhotos partition
// session (never the global Node/undici fetch other services use) and that auth
// failures are classified before any body is trusted.

const SESSION_SENTINEL = { __sentinel: 'talkingphotos-partition-session' }
let lastRequestOpts: Record<string, unknown> | null = null
let lastHeaders: Record<string, string> = {}
let lastBody = Buffer.alloc(0)
let nextResponse: { statusCode: number; headers: Record<string, string>; body: string } = {
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: '{}'
}

vi.mock('electron', () => ({
  session: { fromPartition: () => SESSION_SENTINEL },
  net: {
    request: (opts: Record<string, unknown>) => {
      lastRequestOpts = opts
      const req = new EventEmitter() as EventEmitter & { setHeader: (key: string, value: string) => void; write: (body: string | Buffer) => void; end: () => void }
      req.setHeader = (key, value) => { lastHeaders[key] = value }
      req.write = (body) => { lastBody = Buffer.isBuffer(body) ? body : Buffer.from(body) }
      req.end = () => {
        queueMicrotask(() => {
          const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string> }
          res.statusCode = nextResponse.statusCode
          res.headers = nextResponse.headers
          req.emit('response', res)
          queueMicrotask(() => {
            res.emit('data', Buffer.from(nextResponse.body))
            res.emit('end')
          })
        })
      }
      return req
    }
  }
}))

const { createHumanProject, fetchProviderJson, getDurationLimit, uploadLibraryMedia } = await import('../../electron/providers/talkingphotos/client')

describe('TalkingPhotos session-bound client', () => {
  beforeEach(() => {
    lastRequestOpts = null
    lastHeaders = {}
    lastBody = Buffer.alloc(0)
    nextResponse = { statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{}' }
  })

  it('binds every request to the TalkingPhotos partition session, never the global fetch', async () => {
    await fetchProviderJson('/project/video_daily_usage')
    expect(lastRequestOpts?.session).toBe(SESSION_SENTINEL)
    expect(lastRequestOpts?.url).toContain('/project/video_daily_usage')
  })

  it('treats HTTP 401 as reauth-required, not a generic failure', async () => {
    nextResponse = { statusCode: 401, headers: {}, body: '' }
    await expect(fetchProviderJson('/project/video_daily_usage')).rejects.toMatchObject({ normalized: { kind: 'authentication' } })
  })

  it('treats HTTP 403 as reauth-required', async () => {
    nextResponse = { statusCode: 403, headers: {}, body: '' }
    await expect(fetchProviderJson('/project/video_daily_usage')).rejects.toMatchObject({ normalized: { kind: 'authentication' } })
  })

  it('treats an HTML body where JSON was expected as reauth-required', async () => {
    nextResponse = { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<html><body>please sign in</body></html>' }
    await expect(fetchProviderJson('/project/video_daily_usage')).rejects.toMatchObject({ normalized: { kind: 'authentication' } })
  })

  it('rejects malformed JSON as invalid_response rather than trusting a 200 status alone', async () => {
    nextResponse = { statusCode: 200, headers: { 'content-type': 'application/json' }, body: 'not-json{' }
    await expect(fetchProviderJson('/project/video_daily_usage')).rejects.toMatchObject({ normalized: { kind: 'invalid_response' } })
  })

  it('classifies a 429 as rate_limited', async () => {
    nextResponse = { statusCode: 429, headers: {}, body: '{"message":"slow down"}' }
    await expect(fetchProviderJson('/project/video_daily_usage')).rejects.toMatchObject({ normalized: { kind: 'rate_limited' } })
  })

  it('parses a valid JSON body on success', async () => {
    nextResponse = { statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"dailyUsage":3,"dailyLimit":100}' }
    await expect(fetchProviderJson('/project/video_daily_usage')).resolves.toEqual({ dailyUsage: 3, dailyLimit: 100 })
  })

  it('submits the confirmed Human project JSON through the partition-bound client', async () => {
    nextResponse.body = JSON.stringify({ id: 1041992, title: 'Video', type: 'human', style: 'high_quality', status: 'pending', createdDate: '', updatedDate: '' })
    const payload = { title: 'Video', type: 'human' as const, style: 'high_quality' as const, options: { audioSource: 'library', audioMediaId: 4140999, audioResultUuid: '', audioVocalUrl: '', ttsText: '', motionId: 0 } }
    await expect(createHumanProject(payload)).resolves.toMatchObject({ id: '1041992', type: 'human', status: 'pending' })
    expect(lastRequestOpts).toMatchObject({ method: 'POST', url: 'https://app.talkingphotos.ai/project', session: SESSION_SENTINEL })
    expect(JSON.parse(lastBody.toString())).toEqual(payload)
  })

  it('requests the style-specific Human duration limit', async () => {
    nextResponse.body = '{"maxDuration":60}'
    await expect(getDurationLimit('high_quality')).resolves.toBe(60)
    expect(JSON.parse(lastBody.toString())).toEqual({ projectType: 'human', projectStyle: 'high_quality' })
  })

  it('uploads multipart media with both file and type fields to the captured category route', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'me-tp-client-'))
    const path = join(dir, 'voice.wav')
    writeFileSync(path, Buffer.from('wave-bytes'))
    nextResponse.body = JSON.stringify({ id: 4140998, title: 'voice', type: 'audio', extension: 'wav', categoryId: 163906, data: { duration: 829.2 } })
    try {
      await expect(uploadLibraryMedia(path, 'audio', '163906')).resolves.toMatchObject({ id: '4140998', durationSec: 829.2 })
      expect(lastRequestOpts).toMatchObject({ method: 'POST', url: 'https://app.talkingphotos.ai/library/categories/upload/163906' })
      expect(lastHeaders['content-type']).toContain('multipart/form-data; boundary=')
      expect(lastBody.toString()).toContain('name="file"; filename="voice.wav"')
      expect(lastBody.toString()).toContain('name="type"\r\n\r\naudio')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
