import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Session-bound request selection + reauth detection, exercised end-to-end against a
// fake net.request — proves the client always binds to the TalkingPhotos partition
// session (never the global Node/undici fetch other services use) and that auth
// failures are classified before any body is trusted.

const SESSION_SENTINEL = { __sentinel: 'talkingphotos-partition-session' }
let lastRequestOpts: Record<string, unknown> | null = null
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
      const req = new EventEmitter() as EventEmitter & { setHeader: () => void; write: () => void; end: () => void }
      req.setHeader = () => {}
      req.write = () => {}
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

const { fetchProviderJson } = await import('../../electron/providers/talkingphotos/client')

describe('TalkingPhotos session-bound client', () => {
  beforeEach(() => {
    lastRequestOpts = null
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
})
