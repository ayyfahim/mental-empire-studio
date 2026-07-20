import { describe, expect, it } from 'vitest'
import {
  classifyProviderError,
  buildTalkingPhotosHumanPayload,
  detectReauthRequired,
  isAllowedProviderMediaUrl,
  isAllowedProviderNavigation,
  isTerminalProviderJobStatus,
  isValidProjectSummaryShape,
  mapRemoteProjectStatus,
  nextPollDelayMs,
  normalizeCapabilities,
  normalizeLanguage,
  normalizeMotion,
  normalizeProjectSummary,
  normalizeVoice,
  planTalkingPhotosSegments,
  redactProviderText
} from '../../shared/talkingphotos'

describe('Uploaded-audio Human request contract', () => {
  it('builds the confirmed library-audio request and leaves TTS result fields empty', () => {
    const payload = buildTalkingPhotosHumanPayload({
      title: 'Uploaded recording', audioPath: '/audio.wav', characterImagePath: '/person.png',
      characterPrompt: 'A presenter', style: 'high_quality', aspectRatio: '16:9', motionId: 0
    }, { audioMediaId: '4140999', characterDrivingMediaId: '4139604', characterResultUuid: 'character-uuid' })
    expect(payload).toMatchObject({ title: 'Uploaded recording', type: 'human', style: 'high_quality' })
    expect(payload.options).toMatchObject({
      audioSource: 'library', audioMediaId: 4140999, audioResultUuid: '', audioVocalUrl: '',
      ttsText: '', motionId: 0, characterDrivingMediaId: 4139604, characterResultUuid: 'character-uuid'
    })
  })

  it('segments at the provider limit without gaps, overlaps, or an oversized tail', () => {
    expect(planTalkingPhotosSegments(829.2, 60)).toHaveLength(14)
    const segments = planTalkingPhotosSegments(829.2, 60)
    expect(segments[0]).toMatchObject({ ordinal: 0, startSec: 0, endSec: 60, durationSec: 60 })
    expect(segments.at(-1)).toMatchObject({ ordinal: 13, startSec: 780, endSec: 829.2 })
    expect(segments.at(-1)?.durationSec).toBeCloseTo(49.2)
    for (let i = 1; i < segments.length; i++) expect(segments[i].startSec).toBe(segments[i - 1].endSec)
  })

  it('rejects unusable source duration and provider limits', () => {
    expect(() => planTalkingPhotosSegments(0, 60)).toThrow()
    expect(() => planTalkingPhotosSegments(20, 0)).toThrow()
  })
})

describe('TalkingPhotos capability normalization', () => {
  it('combines duration/character limits, concurrency and daily usage into one capability object', () => {
    const caps = normalizeCapabilities({
      durationLimit: { maxDuration: 300, maxCharactersTTS: 6000, maxDurationPremium: 300, maxCharactersTTSPremium: 6000 },
      concurrency: { concurrentCount: 1, concurrentLimit: 5 },
      dailyUsage: { dailyUsage: 3, dailyLimit: 100 }
    })
    expect(caps.limits).toEqual({ maxDurationSeconds: 300, maxCharactersTts: 6000, maxDurationPremiumSeconds: 300, maxCharactersTtsPremium: 6000 })
    expect(caps.usage).toEqual({ concurrentCount: 1, concurrentLimit: 5, dailyUsage: 3, dailyLimit: 100 })
    expect(caps.fetchedAt).toBeTruthy()
  })

  it('never hardcodes a global default — missing fields normalize to 0, not a guessed limit', () => {
    const caps = normalizeCapabilities({})
    expect(caps.limits.maxDurationSeconds).toBe(0)
    expect(caps.limits.maxCharactersTts).toBe(0)
    expect(caps.usage.dailyLimit).toBe(0)
  })

  it('normalizes a voice catalog entry defensively, dropping non-string list entries', () => {
    const voice = normalizeVoice({ name: 'ava', fullName: 'Ava', gender: 'female', langCode: 'en-US', category: 'standard', type: 'neural', styleList: ['general', 42], supportedEngines: ['v1'] })
    expect(voice).toMatchObject({ name: 'ava', gender: 'female', styleList: ['general'] })
  })

  it('normalizes a language and a motion entry', () => {
    expect(normalizeLanguage({ code: 'en-US', name: 'English (US)' })).toEqual({ code: 'en-US', name: 'English (US)' })
    expect(normalizeMotion({ id: '7', title: 'Wave', tag: 'casual', thumbUrl: 'a', videoUrl: 'b', durationSeconds: 4, isPremium: true, isBonus: false })).toMatchObject({ id: 7, isPremium: true, isBonus: false })
  })
})

describe('Project-state normalization', () => {
  it('requires an id and a non-empty status before trusting a project payload', () => {
    expect(isValidProjectSummaryShape({ id: '1', status: 'pending' })).toBe(true)
    expect(isValidProjectSummaryShape({ id: '1', status: '' })).toBe(false)
    expect(isValidProjectSummaryShape({ status: 'pending' })).toBe(false)
    expect(isValidProjectSummaryShape(null)).toBe(false)
    expect(isValidProjectSummaryShape('ok')).toBe(false)
  })

  it('rejects a malformed payload instead of guessing at fields (a 200 status alone is not enough)', () => {
    expect(normalizeProjectSummary({ message: 'no id or status here' })).toBeNull()
  })

  it('extracts media url/duration from the nested media object', () => {
    const summary = normalizeProjectSummary({
      id: 42, title: 'My video', type: 'human', status: 'completed', taskStepNumber: 2, taskStepsTotal: 2,
      createdDate: '2026-01-01T00:00:00Z', updatedDate: '2026-01-01T00:23:05Z',
      media: { mediaPath: 'https://cdn.talkingphotos.ai/out.mp4', data: { duration: 275.48 } }
    })
    expect(summary).toMatchObject({ id: '42', status: 'completed', mediaUrl: 'https://cdn.talkingphotos.ai/out.mp4', mediaDurationSec: 275.48 })
  })
})

describe('Remote status -> local ProviderJobStatus mapping', () => {
  it.each([
    ['pending', false, 'queued'],
    ['processing', false, 'running'],
    ['completed', false, 'downloading'],
    ['completed', true, 'completed'],
    ['error', false, 'failed'],
    ['some_unknown_future_status', false, 'attention']
  ] as const)('%s (verified=%s) -> %s', (remote, verified, expected) => {
    expect(mapRemoteProjectStatus(remote, verified)).toBe(expected)
  })

  it('only completed/failed/cancelled are terminal — attention and downloading keep polling', () => {
    expect(isTerminalProviderJobStatus('completed')).toBe(true)
    expect(isTerminalProviderJobStatus('failed')).toBe(true)
    expect(isTerminalProviderJobStatus('cancelled')).toBe(true)
    expect(isTerminalProviderJobStatus('attention')).toBe(false)
    expect(isTerminalProviderJobStatus('downloading')).toBe(false)
    expect(isTerminalProviderJobStatus('queued')).toBe(false)
    expect(isTerminalProviderJobStatus('running')).toBe(false)
  })
})

describe('Polling backoff', () => {
  it('climbs the 5s -> 10s -> 15s -> 30s -> 60s ladder with no jitter', () => {
    expect(nextPollDelayMs({ sameStateStreak: 0, jitter: 0 })).toBe(5_000)
    expect(nextPollDelayMs({ sameStateStreak: 1, jitter: 0 })).toBe(10_000)
    expect(nextPollDelayMs({ sameStateStreak: 2, jitter: 0 })).toBe(15_000)
    expect(nextPollDelayMs({ sameStateStreak: 3, jitter: 0 })).toBe(30_000)
    expect(nextPollDelayMs({ sameStateStreak: 4, jitter: 0 })).toBe(60_000)
  })

  it('caps at the 60s rung instead of growing unbounded', () => {
    expect(nextPollDelayMs({ sameStateStreak: 50, jitter: 0 })).toBe(60_000)
  })

  it('adds jitter so simultaneous jobs do not all poll at once', () => {
    const delay = nextPollDelayMs({ sameStateStreak: 0, jitter: 0.2 })
    expect(delay).toBeGreaterThanOrEqual(5_000)
    expect(delay).toBeLessThanOrEqual(6_000)
  })
})

describe('Reauth detection', () => {
  it('flags 401/403 as reauth required', () => {
    expect(detectReauthRequired({ status: 401 })).toBe(true)
    expect(detectReauthRequired({ status: 403 })).toBe(true)
  })

  it('flags HTML returned where JSON was expected', () => {
    expect(detectReauthRequired({ status: 200, contentType: 'text/html', bodyLooksHtml: true })).toBe(true)
  })

  it('does not flag a normal JSON 200 response', () => {
    expect(detectReauthRequired({ status: 200, contentType: 'application/json', bodyLooksHtml: false })).toBe(false)
  })

  it('does not flag a JSON error response that happens to be 200 with no html body', () => {
    expect(detectReauthRequired({ status: 200, contentType: 'application/json' })).toBe(false)
  })
})

describe('Provider error classification', () => {
  it('classifies a reauth failure as non-retryable authentication', () => {
    expect(classifyProviderError({ reauthRequired: true, httpStatus: 401, message: 'expired' })).toMatchObject({ kind: 'authentication', retryable: false })
  })

  it('classifies 429 as retryable rate_limited with Retry-After', () => {
    expect(classifyProviderError({ httpStatus: 429, retryAfterSec: 20 })).toMatchObject({ kind: 'rate_limited', retryable: true, retryAfterSec: 20 })
  })

  it('classifies 5xx as retryable server_error and network failures as retryable network', () => {
    expect(classifyProviderError({ httpStatus: 502 })).toMatchObject({ kind: 'server_error', retryable: true })
    expect(classifyProviderError({ networkError: true })).toMatchObject({ kind: 'network', retryable: true })
  })

  it('classifies a malformed response as non-retryable invalid_response', () => {
    expect(classifyProviderError({ invalidShape: true })).toMatchObject({ kind: 'invalid_response', retryable: false })
  })
})

describe('Log redaction', () => {
  it('redacts signed query params, cookie headers, and API-key-shaped tokens', () => {
    const text = redactProviderText('GET /x?token=abc123&signature=def456 failed; Set-Cookie: session=zzz; key gsk_abcdefghijklmnopqrstuvwx used')
    expect(text).not.toContain('abc123')
    expect(text).not.toContain('def456')
    expect(text).not.toContain('zzz')
    expect(text).not.toContain('gsk_abcdefghijklmnopqrstuvwx')
  })

  it('truncates overly long messages', () => {
    expect(redactProviderText('x'.repeat(2000)).length).toBeLessThanOrEqual(600)
  })
})

describe('Login-window / media navigation guard', () => {
  it('allows only https + the exact TalkingPhotos app host for navigation', () => {
    expect(isAllowedProviderNavigation('https://app.talkingphotos.ai/login')).toBe(true)
    expect(isAllowedProviderNavigation('http://app.talkingphotos.ai/login')).toBe(false)
    expect(isAllowedProviderNavigation('https://evil.example.com')).toBe(false)
    expect(isAllowedProviderNavigation('not a url')).toBe(false)
  })

  it('allows only https + the exact CDN host for media downloads', () => {
    expect(isAllowedProviderMediaUrl('https://cdn.talkingphotos.ai/out.mp4')).toBe(true)
    expect(isAllowedProviderMediaUrl('https://attacker.example.com/out.mp4')).toBe(false)
  })
})
