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
let requestOptions: Record<string, unknown>[] = []
let lastHeaders: Record<string, string> = {}
let lastBody = Buffer.alloc(0)
interface FakeResponse {
  statusCode: number
  headers: Record<string, string>
  body: string
  redirectUrl?: string
}
let nextResponse: FakeResponse = {
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: '{}'
}
let responseQueue: FakeResponse[] = []
let followRedirectCalls: number[] = []

const infoMock = vi.fn()
const warnMock = vi.fn()
vi.mock('../../electron/services/logger', () => ({ L: { info: infoMock, warn: warnMock, error: vi.fn() } }))

vi.mock('electron', () => ({
  session: { fromPartition: () => SESSION_SENTINEL },
  net: {
    request: (opts: Record<string, unknown>) => {
      lastRequestOpts = opts
      requestOptions.push(opts)
      const req = new EventEmitter() as EventEmitter & { setHeader: (key: string, value: string) => void; write: (body: string | Buffer) => void; followRedirect: () => void; end: () => void }
      req.setHeader = (key, value) => { lastHeaders[key] = value }
      req.write = (body) => { lastBody = Buffer.isBuffer(body) ? body : Buffer.from(body) }
      // Mirrors real Chromium: ClientRequest.followRedirect() is only valid when the
      // request was created with `redirect: 'manual'`. Calling it under 'follow' (the
      // regression this suite guards against) throws net::ERR_INVALID_ARGUMENT the
      // instant a real 3xx occurs — reproduced here so a regression fails loudly
      // instead of passing under an unrealistically permissive fake.
      followRedirectCalls.push(0)
      req.followRedirect = () => {
        followRedirectCalls[followRedirectCalls.length - 1]++
        if (opts.redirect !== 'manual') {
          const err = new Error('net::ERR_INVALID_ARGUMENT')
          req.emit('error', err)
          throw err
        }
      }
      req.end = () => {
        queueMicrotask(() => {
          const response = responseQueue.shift() ?? nextResponse
          if (response.redirectUrl) {
            try {
              req.emit('redirect', 302, 'GET', response.redirectUrl, {})
            } catch {
              return // real net.request would not emit 'response' after a thrown followRedirect()
            }
          }
          const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string> }
          res.statusCode = response.statusCode
          res.headers = response.headers
          req.emit('response', res)
          queueMicrotask(() => {
            res.emit('data', Buffer.from(response.body))
            res.emit('end')
          })
        })
      }
      return req
    }
  }
}))

const { createHumanProject, fetchProviderJson, getDurationLimit, healthCheck, uploadLibraryMedia } = await import('../../electron/providers/talkingphotos/client')

describe('TalkingPhotos session-bound client', () => {
  beforeEach(() => {
    lastRequestOpts = null
    requestOptions = []
    lastHeaders = {}
    lastBody = Buffer.alloc(0)
    followRedirectCalls = []
    nextResponse = { statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{}' }
    responseQueue = []
    infoMock.mockClear()
    warnMock.mockClear()
  })

  it('binds every request to the TalkingPhotos partition session, never the global fetch', async () => {
    await fetchProviderJson('/project/video_daily_usage')
    expect(lastRequestOpts?.session).toBe(SESSION_SENTINEL)
    expect(lastRequestOpts?.useSessionCookies).toBe(true)
    expect(lastRequestOpts?.url).toContain('/project/video_daily_usage')
  })

  // Regression: rawRequest previously paired `redirect: 'follow'` with a manual
  // `followRedirect()` call on every 'redirect' event — a double-follow Chromium
  // rejects with net::ERR_INVALID_ARGUMENT the instant any provider request 3xx's,
  // taking down every TalkingPhotos call (capabilities, sync, create, …) at once.
  it('requests manual redirect mode so followRedirect() is valid to call', async () => {
    await fetchProviderJson('/project/video_daily_usage')
    expect(lastRequestOpts?.redirect).toBe('manual')
  })

  it('follows a same-origin redirect to its final response without net::ERR_INVALID_ARGUMENT', async () => {
    nextResponse = {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"dailyUsage":1,"dailyLimit":5}',
      redirectUrl: 'https://app.talkingphotos.ai/project/video_daily_usage'
    }
    await expect(fetchProviderJson('/project/video_daily_usage')).resolves.toEqual({ dailyUsage: 1, dailyLimit: 5 })
    expect(followRedirectCalls).toEqual([1])
  })

  it('classifies a redirect away from the API (e.g. to a login page) as reauth, not a raw network error', async () => {
    nextResponse = {
      statusCode: 200,
      headers: { 'content-type': 'text/html' },
      body: '<html>login</html>',
      redirectUrl: 'https://app.talkingphotos.ai/login'
    }
    await expect(fetchProviderJson('/project/video_daily_usage')).rejects.toMatchObject({ normalized: { kind: 'authentication' } })
    expect(followRedirectCalls).toEqual([1])
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

  it('accepts the primary endpoint expected authenticated usage shape', async () => {
    nextResponse = { statusCode: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"dailyUsage":3,"dailyLimit":100}' }

    await expect(healthCheck()).resolves.toEqual({ ok: true, reauthRequired: false })
    expect(requestOptions).toHaveLength(1)
    expect(requestOptions[0]).toMatchObject({ method: 'GET', url: 'https://app.talkingphotos.ai/project/video_daily_usage', useSessionCookies: true, redirect: 'manual' })
    expect(lastHeaders).toMatchObject({ accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' })
  })

  it('accepts a confirmed alternative usage envelope with numeric strings', async () => {
    nextResponse = { statusCode: 200, headers: { 'content-type': 'application/problem+json' }, body: '{"data":{"video_daily_usage":"3","video_daily_limit":"100"}}' }

    await expect(healthCheck()).resolves.toEqual({ ok: true, reauthRequired: false })
    expect(requestOptions).toHaveLength(1)
  })

  it('falls back to the read-only project list when the primary validator rejects', async () => {
    responseQueue = [
      { statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"unexpected":true}' },
      { statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"items":[],"total":0}' }
    ]

    await expect(healthCheck()).resolves.toEqual({ ok: true, reauthRequired: false })
    expect(requestOptions.map((opts) => opts.url)).toEqual([
      'https://app.talkingphotos.ai/project/video_daily_usage',
      'https://app.talkingphotos.ai/project?page=1&limit=1'
    ])
    expect(infoMock.mock.calls.flat().join(' ')).toContain('failure:unsupported_usage_shape')
  })

  it('rejects HTTP 200 HTML login pages on every approved endpoint', async () => {
    responseQueue = [
      { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<html><body>login</body></html>' },
      { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html><html></html>' }
    ]

    await expect(healthCheck()).resolves.toMatchObject({ ok: false, reauthRequired: true })
    expect(infoMock.mock.calls.flat().join(' ')).toContain('failure:html_response')
  })

  it('rejects redirects to the public TalkingPhotos login page and strips its query from diagnostics', async () => {
    const signedSecret = 'signed-secret-must-not-appear'
    responseQueue = [
      { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<html></html>', redirectUrl: `https://talkingphotos.ai/login?token=${signedSecret}` },
      { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<html></html>', redirectUrl: `https://talkingphotos.ai/login?token=${signedSecret}` }
    ]

    await expect(healthCheck()).resolves.toMatchObject({ ok: false, reauthRequired: true })
    const diagnostics = infoMock.mock.calls.flat().join(' ')
    expect(diagnostics).toContain('https://talkingphotos.ai/login')
    expect(diagnostics).toContain('redirected=true')
    expect(diagnostics).not.toContain(signedSecret)
  })

  it('logs only sanitized metadata and top-level key names for validator failures', async () => {
    const bodySecret = 'response-body-account-data-must-not-appear'
    const cookieSecret = 'cookie-value-must-not-appear'
    responseQueue = [
      { statusCode: 200, headers: { 'content-type': 'application/json', 'set-cookie': `session=${cookieSecret}; HttpOnly` }, body: JSON.stringify({ unexpectedKey: bodySecret }) },
      { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alsoUnexpected: bodySecret }) }
    ]

    await expect(healthCheck()).resolves.toMatchObject({ ok: false })
    const diagnostics = infoMock.mock.calls.flat().join(' ')
    expect(diagnostics).toContain('endpoint="/project/video_daily_usage"')
    expect(diagnostics).toContain('status=200')
    expect(diagnostics).toContain('contentType="application/json"')
    expect(diagnostics).toContain('keys=["unexpectedKey"]')
    expect(diagnostics).toContain('failure:unsupported_usage_shape')
    expect(diagnostics).not.toContain(bodySecret)
    expect(diagnostics).not.toContain(cookieSecret)
    expect(diagnostics).not.toContain('<html')
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
