import { describe, expect, it } from 'vitest'
import {
  buildProjectDownloadUrl,
  buildSubtitleCreatePayload,
  buildTalkingPhotosHumanPayload,
  buildTalkingPhotosHumanTtsPayload,
  classifyProviderError,
  computeSlotBudget,
  describeTalkingPhotosCapabilities,
  detectReauthRequired,
  isAllowedProjectDownloadUrl,
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
  normalizeSubtitleMode,
  normalizeSubtitleProject,
  normalizeVoice,
  parseTtsCreateResponse,
  parseTtsSocketFrame,
  planTalkingPhotosScriptChunks,
  planTalkingPhotosSegments,
  reconstructScriptFromWords,
  redactProviderText,
  sanitizeDownloadFilename,
  splitOversizedScriptChunk,
  type ProviderCapabilities
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

describe('Shared TalkingPhotos capability interpretation (Settings/Talking Video/Automation/Render Queue)', () => {
  const caps: ProviderCapabilities = {
    limits: { maxDurationSeconds: 300, maxCharactersTts: 6000, maxDurationPremiumSeconds: 300, maxCharactersTtsPremium: 6000 },
    usage: { concurrentCount: 0, concurrentLimit: 5, dailyUsage: 0, dailyLimit: 100 },
    fetchedAt: '2026-01-01T00:00:00.000Z'
  }
  const capsNoTts: ProviderCapabilities = { ...caps, limits: { ...caps.limits, maxCharactersTts: 0 } }

  it('reports both uploaded-audio and TTS available when connected with a nonzero TTS character limit', () => {
    const summary = describeTalkingPhotosCapabilities('connected', caps)
    expect(summary.uploadedAudioAvailable).toBe(true)
    expect(summary.ttsAvailable).toBe(true)
    expect(summary.statusText).toMatch(/script \(TTS\).*available/i)
  })

  it('reports TTS unavailable (but uploaded-audio still available) when connected with a zero TTS limit', () => {
    const summary = describeTalkingPhotosCapabilities('connected', capsNoTts)
    expect(summary.uploadedAudioAvailable).toBe(true)
    expect(summary.ttsAvailable).toBe(false)
    expect(summary.statusText).toMatch(/script \(tts\) creation is unavailable/i)
  })

  it('reports nothing available when not connected, even with cached capabilities from a prior session', () => {
    const summary = describeTalkingPhotosCapabilities('disconnected', caps)
    expect(summary.uploadedAudioAvailable).toBe(false)
    expect(summary.ttsAvailable).toBe(false)
  })

  it('reports nothing available when connected but capabilities have not loaded yet', () => {
    const summary = describeTalkingPhotosCapabilities('connected', null)
    expect(summary.uploadedAudioAvailable).toBe(false)
    expect(summary.ttsAvailable).toBe(false)
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

  it('redacts a cookie-attribute-shaped token even without a cookie:/set-cookie: prefix', () => {
    // Simulates a raw Set-Cookie value or HTML error body echoing a cookie string
    // without the literal header-style prefix (the gap this fix closes).
    const text = redactProviderText(
      'Unexpected response body: sessionid=a1b2c3d4e5f6g7h8i9j0; Path=/; Domain=app.talkingphotos.ai; HttpOnly; Secure; SameSite=Lax — please retry'
    )
    expect(text).not.toContain('a1b2c3d4e5f6g7h8i9j0')
    expect(text).not.toContain('sessionid=')
    expect(text).not.toContain('HttpOnly')
    expect(text).not.toContain('Secure')
    expect(text).not.toContain('SameSite=Lax')
    expect(text).toContain('[redacted-cookie]')
    expect(text).toContain('please retry')
  })

  it('redacts a bare cookie-attribute string with no leading label at all', () => {
    const text = redactProviderText('csrftoken=zz9yy8xx7ww6vv5uu4tt3; Domain=talkingphotos.ai; Secure')
    expect(text).not.toContain('zz9yy8xx7ww6vv5uu4tt3')
    expect(text).toContain('[redacted-cookie]')
  })

  it('does not touch ordinary key=value text that has no cookie attributes', () => {
    const input = 'TalkingPhotos request failed: retry_count=3, status=pending, attempt=1 of 5'
    expect(redactProviderText(input)).toBe(input)
  })

  it('leaves a normal error message with no cookie-like content completely unchanged', () => {
    const input = 'TalkingPhotos returned an unexpected response: invalid JSON at position 42, expected a value but got end of input.'
    expect(redactProviderText(input)).toBe(input)
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

describe('TTS create + WebSocket completion frame validation', () => {
  it('accepts the confirmed create_audio_vc shape and rejects a missing uuid', () => {
    expect(parseTtsCreateResponse({ success: true, uuid: 'tts-uuid-1', textValue: 'hello' })).toEqual({ uuid: 'tts-uuid-1', textValue: 'hello' })
    expect(parseTtsCreateResponse({ success: true, uuid: '' })).toBeNull()
    expect(parseTtsCreateResponse({ success: false, uuid: 'x' })).toBeNull()
    expect(parseTtsCreateResponse(null)).toBeNull()
  })

  it('accepts a completion frame only when every field is valid: code 200, type audio, positive integer media_id, positive finite duration', () => {
    expect(parseTtsSocketFrame({ media_id: 501, type: 'audio', out_path: '/tts/501.wav', code: 200, duration: 12.4 }))
      .toEqual({ mediaId: '501', outPath: '/tts/501.wav', durationSec: 12.4 })
  })

  it('rejects a frame with the wrong code, type, a non-positive/non-integer media_id, or a non-positive duration', () => {
    expect(parseTtsSocketFrame({ media_id: 501, type: 'audio', code: 202, duration: 12 })).toBeNull()
    expect(parseTtsSocketFrame({ media_id: 501, type: 'image', code: 200, duration: 12 })).toBeNull()
    expect(parseTtsSocketFrame({ media_id: -1, type: 'audio', code: 200, duration: 12 })).toBeNull()
    expect(parseTtsSocketFrame({ media_id: 1.5, type: 'audio', code: 200, duration: 12 })).toBeNull()
    expect(parseTtsSocketFrame({ media_id: 501, type: 'audio', code: 200, duration: 0 })).toBeNull()
    expect(parseTtsSocketFrame({ media_id: 501, type: 'audio', code: 200, duration: -5 })).toBeNull()
    expect(parseTtsSocketFrame({})).toBeNull()
    expect(parseTtsSocketFrame(null)).toBeNull()
  })

  it('a progress/ping frame that is well-formed JSON but does not satisfy every field is never mistaken for completion', () => {
    expect(parseTtsSocketFrame({ status: 'processing', progress: 40 })).toBeNull()
  })
})

describe('Fresh TTS Human project payload (never a cloned/empty-TTS shape)', () => {
  it('populates real audioResultUuid/audioMediaId/ttsText/voice fields, unlike the uploaded-audio payload', () => {
    const payload = buildTalkingPhotosHumanTtsPayload(
      { title: 'x', script: 'Hello there.', characterImagePath: '/p.png', characterPrompt: 'A presenter', style: 'high_quality', aspectRatio: '16:9', motionId: 0, language: 'en-US', voice: 'en-US-AndrewMultilingualNeural', voiceStyle: 'general', speed: 1, pitch: 0, subtitleMode: 'none' },
      { audioMediaId: '999', audioResultUuid: 'tts-uuid-1', ttsText: 'Hello there.', characterDrivingMediaId: '123', characterResultUuid: 'char-uuid', title: 'Segment 1' }
    )
    expect(payload.options).toMatchObject({ audioSource: 'tts', audioMediaId: 999, audioResultUuid: 'tts-uuid-1', ttsText: 'Hello there.', ttsVoice: 'en-US-AndrewMultilingualNeural', ttsLanguage: 'en-US' })
    expect(payload.options.audioResultUuid).not.toBe('')
    expect(payload.options.ttsText).not.toBe('')
  })
})

describe('Long-form script segmentation', () => {
  it('splits on paragraph boundaries first, staying under the safety margin', () => {
    const script = `${'A'.repeat(40)}.\n\n${'B'.repeat(40)}.`
    const chunks = planTalkingPhotosScriptChunks(script, 50)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(Math.floor(50 * 0.95))
  })

  it('falls back to sentence boundaries when a paragraph alone exceeds the limit', () => {
    const script = 'First sentence here. Second sentence here. Third sentence here. Fourth sentence here.'
    const chunks = planTalkingPhotosScriptChunks(script, 40)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(Math.floor(40 * 0.95))
    // No word content lost across the split.
    expect(chunks.map((c) => c.text).join(' ').replace(/\s+/g, ' ')).toContain('Fourth sentence here.')
  })

  it('hard-wraps on a word boundary only as a last resort, for a single sentence longer than the limit', () => {
    const longSentence = `${'word '.repeat(30)}end.`
    const chunks = planTalkingPhotosScriptChunks(longSentence, 30)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(Math.floor(30 * 0.95))
  })

  it('assigns deterministic, strictly increasing ordinals', () => {
    const chunks = planTalkingPhotosScriptChunks('One. Two. Three. Four. Five.', 10)
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i))
  })

  it('rejects an empty script rather than silently producing zero chunks', () => {
    expect(() => planTalkingPhotosScriptChunks('   ', 100)).toThrow()
  })
})

describe('Duration-driven re-segmentation', () => {
  it('splits an oversized chunk at a sentence boundary, preserving all text', () => {
    const [left, right] = splitOversizedScriptChunk('First sentence. Second sentence. Third sentence. Fourth sentence.')
    expect(left.length).toBeGreaterThan(0)
    expect(right.length).toBeGreaterThan(0)
    expect(`${left} ${right}`).toContain('Fourth sentence.')
  })

  it('falls back to a word-boundary split for a single run-on sentence, covering the full text between both halves', () => {
    const source = 'word '.repeat(40).trim()
    const [left, right] = splitOversizedScriptChunk(source)
    expect(left.length).toBeGreaterThan(0)
    expect(right.length).toBeGreaterThan(0)
    expect(left.length + right.length).toBeLessThanOrEqual(source.length)
    expect(left.split(' ').length + right.split(' ').length).toBe(40)
  })
})

describe('Transcript -> script reconstruction (pause-based heuristic)', () => {
  it('inserts a period at a pause and capitalizes the following word', () => {
    const words = [
      { word: 'hello', start: 0, end: 0.3 },
      { word: 'world', start: 0.4, end: 0.7 },
      { word: 'goodbye', start: 2.0, end: 2.4 },
      { word: 'now', start: 2.5, end: 2.8 }
    ]
    expect(reconstructScriptFromWords(words, 0.6)).toBe('Hello world. Goodbye now.')
  })

  it('returns an empty string for no words and never throws', () => {
    expect(reconstructScriptFromWords([])).toBe('')
  })
})

describe('Quota / concurrency slot budget', () => {
  function caps(usage: Partial<ProviderCapabilities['usage']>): ProviderCapabilities {
    return { limits: { maxDurationSeconds: 300, maxCharactersTts: 6000, maxDurationPremiumSeconds: 300, maxCharactersTtsPremium: 6000 }, usage: { concurrentCount: 0, concurrentLimit: 0, dailyUsage: 0, dailyLimit: 0, ...usage }, fetchedAt: '' }
  }

  it('reports zero available slots when the account is already at its concurrent limit', () => {
    expect(computeSlotBudget(caps({ concurrentCount: 5, concurrentLimit: 5, dailyLimit: 100 })).availableConcurrent).toBe(0)
  })

  it('reports the exact remaining count for a partially-used limit', () => {
    expect(computeSlotBudget(caps({ concurrentCount: 2, concurrentLimit: 5, dailyLimit: 100 })).availableConcurrent).toBe(3)
  })

  it('reports zero available daily slots when usage has reached the daily limit', () => {
    expect(computeSlotBudget(caps({ concurrentLimit: 5, dailyUsage: 100, dailyLimit: 100 })).availableDaily).toBe(0)
  })

  it('treats a 0 limit as unbounded rather than blocked (never observed as a real zero)', () => {
    const budget = computeSlotBudget(caps({}))
    expect(budget.availableConcurrent).toBe(Number.POSITIVE_INFINITY)
    expect(budget.availableDaily).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('Subtitle mode and mutual exclusion', () => {
  it('normalizes to exactly one of none/provider/local — never both', () => {
    expect(normalizeSubtitleMode('provider')).toBe('provider')
    expect(normalizeSubtitleMode('local')).toBe('local')
    expect(normalizeSubtitleMode('both')).toBe('none')
    expect(normalizeSubtitleMode(undefined)).toBe('none')
  })

  it('builds a transient sanitized clone with account/user/media/status/task fields stripped', () => {
    const rawSourceProject = {
      id: 555, type: 'human', style: 'high_quality', status: 'completed', taskUuid: 'real-task-uuid',
      user: { id: 'real-user-id', email: 'real@person.example' }, userId: 'real-user-id',
      media: { mediaPath: 'https://cdn.talkingphotos.ai/real-output.mp4' },
      options: { aspectRatio: '16:9', characterPrompt: 'a real prompt that must not leak' }
    }
    const payload = buildSubtitleCreatePayload(rawSourceProject, { title: 'subs-title', parentId: '555' })
    expect(payload).toMatchObject({ title: 'subs-title', type: 'subtitles', style: 'high_quality', parentId: '555', options: { aspectRatio: '16:9' } })
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('real-user-id')
    expect(serialized).not.toContain('real@person.example')
    expect(serialized).not.toContain('real-output.mp4')
    expect(serialized).not.toContain('a real prompt that must not leak')
    expect(serialized).not.toContain('real-task-uuid')
  })

  it('refuses to build a payload from a source that is missing type/style', () => {
    expect(buildSubtitleCreatePayload({ id: 1 }, { title: 't', parentId: '1' })).toBeNull()
  })

  it('normalizes a subtitles project response through pending/processing/completed without requiring a task uuid', () => {
    expect(normalizeSubtitleProject({ id: 9, status: 'pending' })).toMatchObject({ id: '9', status: 'pending' })
    expect(normalizeSubtitleProject({ id: 9, status: 'processing' })).toMatchObject({ id: '9', status: 'processing' })
    expect(normalizeSubtitleProject({ id: 9, status: 'completed', media: { mediaPath: 'https://cdn.talkingphotos.ai/subbed.mp4' } })).toMatchObject({ id: '9', status: 'completed', mediaUrl: 'https://cdn.talkingphotos.ai/subbed.mp4' })
  })
})

describe('Preferred download route (strict allowlist)', () => {
  it('builds the download URL only from a validated positive integer id', () => {
    expect(buildProjectDownloadUrl('12345')).toBe('https://app.talkingphotos.ai/project/download/12345')
    expect(buildProjectDownloadUrl('0')).toBeNull()
    expect(buildProjectDownloadUrl('-5')).toBeNull()
    expect(buildProjectDownloadUrl('12x45')).toBeNull()
    expect(buildProjectDownloadUrl('')).toBeNull()
  })

  it('allows only the exact origin and path shape, not any app.talkingphotos.ai URL', () => {
    expect(isAllowedProjectDownloadUrl('https://app.talkingphotos.ai/project/download/12345')).toBe(true)
    expect(isAllowedProjectDownloadUrl('http://app.talkingphotos.ai/project/download/12345')).toBe(false)
    expect(isAllowedProjectDownloadUrl('https://app.talkingphotos.ai/project/12345')).toBe(false)
    expect(isAllowedProjectDownloadUrl('https://app.talkingphotos.ai/admin')).toBe(false)
    expect(isAllowedProjectDownloadUrl('https://evil.example.com/project/download/12345')).toBe(false)
  })

  it('sanitizes a Content-Disposition filename, stripping traversal and path separators', () => {
    expect(sanitizeDownloadFilename('attachment; filename="../../etc/passwd"', 'fallback.mp4')).not.toContain('..')
    expect(sanitizeDownloadFilename('attachment; filename="my video.mp4"', 'fallback.mp4')).toBe('my_video.mp4')
    expect(sanitizeDownloadFilename(undefined, 'fallback.mp4')).toBe('fallback.mp4')
    expect(sanitizeDownloadFilename('attachment; filename="C:\\\\Windows\\\\evil.mp4"', 'fallback.mp4')).not.toContain('\\')
  })
})
