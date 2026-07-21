// TalkingPhotos.ai provider — pure types + logic shared between the Electron main
// process and tests. No Electron import here (mirrors automationReliability.ts):
// capability/response normalization, status mapping, polling backoff, and error
// classification are all plain functions so they can be unit-tested without a
// running app. Side-effecting code (session, HTTP, polling loop) lives under
// electron/providers/talkingphotos/ and calls into these helpers.

// ---- Identity ----
export const TALKINGPHOTOS_PROVIDER = 'talkingphotos' as const
/** Stable persistent Electron session partition. Fixed for the single-account
 *  first release; a future multi-account release would suffix the connection id. */
export const TALKINGPHOTOS_PARTITION = 'persist:talkingphotos:default'
export const TALKINGPHOTOS_BASE_URL = 'https://app.talkingphotos.ai'
export const TALKINGPHOTOS_CDN_HOST = 'cdn.talkingphotos.ai'
export const TALKINGPHOTOS_APP_HOST = 'app.talkingphotos.ai'
/** Single-connection id used until multi-account ships. */
export const TALKINGPHOTOS_CONNECTION_ID = 'default'

// ---- Connection ----
/** 'connecting': the login window is being opened, before it's up.
 *  'waiting_for_login': the login window is open and the user hasn't completed
 *  auth yet — only the periodic poll/nav/cookie signals are watching.
 *  'verifying': a health check triggered by one of those signals (or the poll) is
 *  in flight right now; reverts to 'waiting_for_login' if it comes back not-ok.
 *  'attention': a connect attempt ended without success (closed early or timed
 *  out) and needs the user to look at it — never silently left as 'connecting'. */
export type ProviderConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'waiting_for_login'
  | 'verifying'
  | 'connected'
  | 'reauth_required'
  | 'attention'

export interface ProviderConnection {
  id: string
  provider: typeof TALKINGPHOTOS_PROVIDER
  partition: string
  status: ProviderConnectionStatus
  accountLabel?: string
  connectedAt?: string
  lastVerifiedAt?: string
  lastError?: string
  createdAt: string
  updatedAt: string
}

// ---- Provider jobs (remote work, durable + authoritative for remote state) ----
export type ProviderJobOperation = 'video' | 'merge' | 'subtitles' | 'character' | 'tts'
export type ProviderJobStatus = 'queued' | 'running' | 'downloading' | 'completed' | 'failed' | 'attention' | 'cancelled'

export interface ProviderJob {
  id: string
  provider: typeof TALKINGPHOTOS_PROVIDER
  connectionId: string
  operation: ProviderJobOperation
  remoteProjectId?: string
  remoteTaskUuid?: string
  remotePreviousTaskUuid?: string
  parentProviderJobId?: string
  automationJobId?: string
  automationItemId?: string
  projectId?: string
  requestFingerprint?: string
  /** Distinguishes a deliberate duplicate submission from a retry of the same intent.
   *  Defaults to '' — every existing/automation caller that never sets this keeps the
   *  old fingerprint-only dedup behavior; only an explicit fresh value allows a second
   *  job with otherwise-identical content (plan §11). */
  creationIntentId?: string
  /** Durable, non-secret orchestration checkpoint. Creation inputs, resolved remote
   * asset ids, segment ordering, and submission state live here so restart recovery
   * never depends on renderer memory. */
  requestJson?: string
  status: ProviderJobStatus
  remoteStep?: number
  remoteStepsTotal?: number
  progress: number
  remoteMediaId?: string
  remoteMediaUrl?: string
  localOutputPath?: string
  /** A local-caption derivative render, kept separate from the verified provider
   *  output above so the original is never overwritten (plan §8). */
  localCaptionedOutputPath?: string
  errorCode?: string
  errorMessage?: string
  segmentOrdinal?: number
  internalSegment: boolean
  createdAt: string
  updatedAt: string
  lastPolledAt?: string
  downloadedAt?: string
}

// ---- Reusable remote assets (dedup local file -> remote media) ----
export interface ProviderAsset {
  id: string
  provider: typeof TALKINGPHOTOS_PROVIDER
  connectionId: string
  localSha256: string
  localPath: string
  mimeType?: string
  sizeBytes?: number
  durationSec?: number
  remoteCategoryId?: string
  remoteMediaId?: string
  remoteResultUuid?: string
  uploadedAt?: string
  lastVerifiedAt?: string
}

// ---- Punctuation-preserving transcript document (Workflow 2 prerequisite) ----
export interface TranscriptDocument {
  projectId: string
  text: string
  segmentsJson?: string
  source: 'transcribe' | 'manual'
  createdAt: string
  updatedAt: string
}

// ---- Capabilities / catalogs (read-only, Phase 3) ----
export interface ProviderCapabilityLimits {
  maxDurationSeconds: number
  maxCharactersTts: number
  maxDurationPremiumSeconds: number
  maxCharactersTtsPremium: number
}

export interface ProviderUsage {
  concurrentCount: number
  concurrentLimit: number
  dailyUsage: number
  dailyLimit: number
}

export interface ProviderCapabilities {
  limits: ProviderCapabilityLimits
  usage: ProviderUsage
  fetchedAt: string
}

export interface ProviderLanguage {
  code: string
  name: string
}

export interface ProviderVoice {
  name: string
  fullName: string
  gender: string
  langCode: string
  category: string
  type: string
  styleList: string[]
  supportedEngines: string[]
}

export interface ProviderMotion {
  id: number
  title: string
  tag: string
  thumbUrl: string
  videoUrl: string
  durationSeconds: number
  isPremium: boolean
  isBonus: boolean
}

export interface ProviderMotionQuery {
  projectType: 'human'
  gender?: 'male' | 'female'
  aspectRatio?: '16:9' | '1:1' | '9:16'
  style?: string
}

// ---- Confirmed uploaded-audio Human creation contract ----
export type TalkingPhotosProjectStyle = 'normal' | 'high_quality'
export type TalkingPhotosAspectRatio = '16:9' | '1:1' | '9:16'

export interface TalkingPhotosCreateInput {
  title: string
  audioPath: string
  characterImagePath: string
  characterPrompt: string
  characterNegativePrompt?: string
  style: TalkingPhotosProjectStyle
  aspectRatio: TalkingPhotosAspectRatio
  /** Confirmed values: high_quality uses 0; normal uses a selected motion id. */
  motionId: number
  characterGender?: 'male' | 'female'
  characterAge?: string
  characterStyle?: string
  characterBeard?: string
  automationJobId?: string
  automationItemId?: string
  projectId?: string
  /** Optional: a fresh, caller-supplied value creates a deliberate duplicate even with
   *  otherwise-identical content. Omitted (the default for every existing caller)
   *  preserves today's fingerprint-only dedup behavior. */
  creationIntentId?: string
}

export interface TalkingPhotosAudioSegment {
  ordinal: number
  startSec: number
  endSec: number
  durationSec: number
  remoteAudioMediaId?: string
  providerJobId?: string
  remoteProjectId?: string
}

export interface TalkingPhotosCreationState {
  version: 1
  kind?: 'uploaded-audio'
  input: TalkingPhotosCreateInput
  sourceDurationSec: number
  maxSegmentSec: number
  sourceAudioMediaId?: string
  characterDrivingMediaId?: string
  characterResultUuid?: string
  segments: TalkingPhotosAudioSegment[]
  stage: 'queued' | 'assets_ready' | 'segments_submitted' | 'merge_submitting' | 'merge_submitted'
  startedAt: string
}

export interface TalkingPhotosRemoteMedia {
  id: string
  title: string
  type: string
  extension: string
  categoryId?: string
  durationSec?: number
}

export interface TalkingPhotosHumanProjectPayload {
  title: string
  type: 'human'
  style: TalkingPhotosProjectStyle
  options: Record<string, unknown>
}

/** Split audio without overlap or gaps. The provider limit is authoritative and
 * every end time is clamped to the probed source duration. */
export function planTalkingPhotosSegments(durationSec: number, maxSegmentSec: number): TalkingPhotosAudioSegment[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error('Audio duration must be greater than zero.')
  if (!Number.isFinite(maxSegmentSec) || maxSegmentSec <= 0) throw new Error('TalkingPhotos returned an invalid duration limit.')
  const count = Math.ceil(durationSec / maxSegmentSec)
  return Array.from({ length: count }, (_, ordinal) => {
    const startSec = ordinal * maxSegmentSec
    const endSec = Math.min(durationSec, startSec + maxSegmentSec)
    return { ordinal, startSec, endSec, durationSec: endSec - startSec }
  })
}

/** Exact field family observed in the confirmed Human + library-audio capture.
 * Empty TTS/result fields are intentional: uploaded audio is selected by
 * audioSource=library and audioMediaId. */
export function buildTalkingPhotosHumanPayload(
  input: TalkingPhotosCreateInput,
  resolved: { audioMediaId: string; characterDrivingMediaId: string; characterResultUuid: string; title?: string }
): TalkingPhotosHumanProjectPayload {
  return {
    title: resolved.title || input.title,
    type: 'human',
    style: input.style,
    options: {
      aspectRatio: input.aspectRatio,
      characterPrompt: input.characterPrompt,
      characterNegativePrompt: input.characterNegativePrompt || '',
      motionId: input.motionId,
      parentMotionId: 0,
      motionPrompt: '',
      characterResultUuid: resolved.characterResultUuid,
      characterDrivingMediaId: Number(resolved.characterDrivingMediaId),
      characterGender: input.characterGender || 'male',
      characterEthnicity: '',
      characterAge: input.characterAge || 'adult',
      characterStyle: input.characterStyle || 'realistic',
      characterBeard: input.characterBeard || 'shaven',
      backgroundResultUuid: '',
      backgroundPrompt: '',
      backgroundMediaId: 0,
      audioSource: 'library',
      audioMediaId: Number(resolved.audioMediaId),
      audioVocalUrl: '',
      characterImageMediaId: 0,
      ttsText: '',
      ttsLanguage: 'en-US',
      ttsVoice: 'en-US-AndrewMultilingualNeural',
      ttsVoiceGender: '',
      ttsEmotion: 'general',
      ttsSpeed: 50,
      ttsPitch: 50,
      voiceCloneCategory: 'cloned',
      voiceCloneLanguage: 1,
      voiceCloneVoice: null,
      songPrompt: '',
      songLyrics: '',
      songLength: 'short',
      songStylesSelectedList: [],
      songResultUuid: '',
      audioResultUuid: '',
      replicateMotionUseSource: true,
      replicateUseVoiceChanger: false,
      replicateMotionMode: 'animate',
      reverseVideoMode: true
    }
  }
}

/** The fresh Human project request for a TTS-sourced segment — audioSource="tts"
 *  with the resolved TTS UUID/media ID and the real voice/script parameters that
 *  produced them (never a cloned account object, never empty TTS fields — that
 *  emptiness is specific to the uploaded-audio payload above). */
export function buildTalkingPhotosHumanTtsPayload(
  input: TalkingPhotosScriptCreateInput,
  resolved: { audioMediaId: string; audioResultUuid: string; ttsText: string; characterDrivingMediaId: string; characterResultUuid: string; title: string }
): TalkingPhotosHumanProjectPayload {
  return {
    title: resolved.title,
    type: 'human',
    style: input.style,
    options: {
      aspectRatio: input.aspectRatio,
      characterPrompt: input.characterPrompt,
      characterNegativePrompt: input.characterNegativePrompt || '',
      motionId: input.motionId,
      parentMotionId: 0,
      motionPrompt: '',
      characterResultUuid: resolved.characterResultUuid,
      characterDrivingMediaId: Number(resolved.characterDrivingMediaId),
      characterGender: input.characterGender || 'male',
      characterEthnicity: '',
      characterAge: input.characterAge || 'adult',
      characterStyle: input.characterStyle || 'realistic',
      characterBeard: input.characterBeard || 'shaven',
      backgroundResultUuid: '',
      backgroundPrompt: '',
      backgroundMediaId: 0,
      audioSource: 'tts',
      audioMediaId: Number(resolved.audioMediaId),
      audioResultUuid: resolved.audioResultUuid,
      audioVocalUrl: '',
      characterImageMediaId: 0,
      ttsText: resolved.ttsText,
      ttsLanguage: input.language,
      ttsVoice: input.voice,
      ttsVoiceGender: '',
      ttsEmotion: input.voiceStyle,
      ttsSpeed: input.speed,
      ttsPitch: input.pitch,
      voiceCloneCategory: 'cloned',
      voiceCloneLanguage: 1,
      voiceCloneVoice: null,
      songPrompt: '',
      songLyrics: '',
      songLength: 'short',
      songStylesSelectedList: [],
      songResultUuid: '',
      replicateMotionUseSource: true,
      replicateUseVoiceChanger: false,
      replicateMotionMode: 'animate',
      reverseVideoMode: true
    }
  }
}

// ---- Remote project summaries ----
export interface ProviderProjectSummary {
  id: string
  title: string
  type: string
  style?: string
  status: string
  message?: string
  parentId?: string
  taskUuid?: string
  taskPrevUuid?: string
  taskStepNumber?: number
  taskStepsTotal?: number
  createdDate: string
  updatedDate: string
  mediaUrl?: string
  mediaDurationSec?: number
}

// ---- Normalized provider errors ----
export type ProviderErrorKind =
  | 'authentication'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  | 'network'
  | 'invalid_response'
  | 'unknown'

export interface ProviderErrorNormalized {
  kind: ProviderErrorKind
  message: string
  httpStatus?: number
  retryAfterSec?: number
  retryable: boolean
}

function finiteNumber(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : fallback
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : String(v)
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

// ---- Capability normalization ----
export function normalizeCapabilities(input: { durationLimit?: unknown; concurrency?: unknown; dailyUsage?: unknown }): ProviderCapabilities {
  const d = record(input.durationLimit)
  const c = record(input.concurrency)
  const u = record(input.dailyUsage)
  const maxDurationSeconds = finiteNumber(d.maxDuration, 0)
  const maxCharactersTts = finiteNumber(d.maxCharactersTTS, 0)
  return {
    limits: {
      maxDurationSeconds,
      maxCharactersTts,
      maxDurationPremiumSeconds: finiteNumber(d.maxDurationPremium, maxDurationSeconds),
      maxCharactersTtsPremium: finiteNumber(d.maxCharactersTTSPremium, maxCharactersTts)
    },
    usage: {
      concurrentCount: finiteNumber(c.concurrentCount, 0),
      concurrentLimit: finiteNumber(c.concurrentLimit, 0),
      dailyUsage: finiteNumber(u.dailyUsage, 0),
      dailyLimit: finiteNumber(u.dailyLimit, 0)
    },
    fetchedAt: new Date().toISOString()
  }
}

export interface TalkingPhotosCapabilitySummary {
  uploadedAudioAvailable: boolean
  ttsAvailable: boolean
  statusText: string
}

/** Single source of truth for "what can this account actually do right now" —
 *  consumed by Settings, Talking Video, Automation Studio, and Render Queue so
 *  none of them independently guesses at or hardcodes provider availability. */
export function describeTalkingPhotosCapabilities(
  status: ProviderConnectionStatus,
  capabilities: ProviderCapabilities | null
): TalkingPhotosCapabilitySummary {
  if (status !== 'connected' || !capabilities) {
    return {
      uploadedAudioAvailable: false,
      ttsAvailable: false,
      statusText: 'Connect a TalkingPhotos.ai account to see available creation modes.'
    }
  }
  const ttsAvailable = capabilities.limits.maxCharactersTts > 0
  return {
    uploadedAudioAvailable: true,
    ttsAvailable,
    statusText: ttsAvailable
      ? 'Uploaded-audio and script (TTS) Human video creation are both available in Talking Video and Automation Studio.'
      : 'Uploaded-audio Human video creation is available in Talking Video and Automation Studio. Script (TTS) creation is unavailable for this account.'
  }
}

export function normalizeLanguage(raw: unknown): ProviderLanguage {
  const r = record(raw)
  return { code: str(r.code), name: str(r.name) }
}

export function normalizeVoice(raw: unknown): ProviderVoice {
  const r = record(raw)
  return {
    name: str(r.name),
    fullName: str(r.fullName, str(r.name)),
    gender: str(r.gender),
    langCode: str(r.langCode),
    category: str(r.category),
    type: str(r.type),
    styleList: Array.isArray(r.styleList) ? r.styleList.filter((x): x is string => typeof x === 'string') : [],
    supportedEngines: Array.isArray(r.supportedEngines) ? r.supportedEngines.filter((x): x is string => typeof x === 'string') : []
  }
}

export function normalizeMotion(raw: unknown): ProviderMotion {
  const r = record(raw)
  return {
    id: Math.round(finiteNumber(r.id, 0)),
    title: str(r.title),
    tag: str(r.tag),
    thumbUrl: str(r.thumbUrl),
    videoUrl: str(r.videoUrl),
    durationSeconds: finiteNumber(r.durationSeconds, 0),
    isPremium: !!r.isPremium,
    isBonus: !!r.isBonus
  }
}

/** Minimal shape check before trusting a project payload — a successful HTTP status
 *  is not sufficient (plan §11): the body must actually look like a project. */
export function isValidProjectSummaryShape(raw: unknown): boolean {
  const r = record(raw)
  return (typeof r.id === 'string' || typeof r.id === 'number') && typeof r.status === 'string' && r.status.trim() !== ''
}

export function normalizeProjectSummary(raw: unknown): ProviderProjectSummary | null {
  if (!isValidProjectSummaryShape(raw)) return null
  const r = record(raw)
  const media = record(r.media)
  const mediaData = record(media.data)
  return {
    id: str(r.id),
    title: str(r.title),
    type: str(r.type),
    style: r.style == null ? undefined : str(r.style),
    status: str(r.status),
    message: r.message == null ? undefined : str(r.message),
    parentId: r.parentId == null ? undefined : str(r.parentId),
    taskUuid: r.taskUuid == null ? undefined : str(r.taskUuid),
    taskPrevUuid: r.taskPrevUuid == null ? undefined : str(r.taskPrevUuid),
    taskStepNumber: r.taskStepNumber == null ? undefined : finiteNumber(r.taskStepNumber),
    taskStepsTotal: r.taskStepsTotal == null ? undefined : finiteNumber(r.taskStepsTotal),
    createdDate: str(r.createdDate),
    updatedDate: str(r.updatedDate),
    mediaUrl: typeof media.mediaPath === 'string' && media.mediaPath ? media.mediaPath : undefined,
    mediaDurationSec: mediaData.duration == null ? undefined : finiteNumber(mediaData.duration)
  }
}

// ---- Status mapping (plan §12) ----
/** Map a remote TalkingPhotos project status onto our local ProviderJobStatus.
 *  `hasVerifiedLocalFile` is true only once the output has been downloaded AND
 *  passed media validation — never on HTTP success alone. */
export function mapRemoteProjectStatus(remoteStatus: string, hasVerifiedLocalFile: boolean): ProviderJobStatus {
  const s = remoteStatus.toLowerCase().trim()
  if (s === 'pending') return 'queued'
  if (s === 'processing') return 'running'
  if (s === 'completed') return hasVerifiedLocalFile ? 'completed' : 'downloading'
  if (/error|fail/.test(s)) return 'failed'
  // Unknown remote status: surface for a human rather than silently treating it as ok.
  return 'attention'
}

export function isTerminalProviderJobStatus(status: ProviderJobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

// ---- Polling backoff (plan §12: 5s -> 10s -> 15s -> 30s -> max 60s, with jitter) ----
const POLL_LADDER_MS = [5_000, 10_000, 15_000, 30_000, 60_000]

export function nextPollDelayMs(input: { sameStateStreak: number; jitter?: number }): number {
  const idx = Math.max(0, Math.min(POLL_LADDER_MS.length - 1, Math.floor(input.sameStateStreak)))
  const base = POLL_LADDER_MS[idx]
  const jitterFactor = input.jitter == null ? 0.2 : Math.max(0, Math.min(0.5, input.jitter))
  return Math.round(base + base * jitterFactor * Math.random())
}

// ---- Auth-expiration detection (plan §3 / contract security.authentication) ----
export interface ReauthSignal {
  status?: number
  contentType?: string | null
  bodyLooksHtml?: boolean
  redirectedAwayFromApi?: boolean
}

/** True for any of: HTTP 401/403, a redirect away from the requested API route,
 *  or an HTML body where JSON was expected. Never infer a token/cookie format —
 *  the HAR did not capture one (contract security.authentication). */
export function detectReauthRequired(signal: ReauthSignal): boolean {
  if (signal.status === 401 || signal.status === 403) return true
  if (signal.redirectedAwayFromApi) return true
  const ct = (signal.contentType || '').toLowerCase()
  if (signal.bodyLooksHtml && !ct.includes('application/json')) return true
  return false
}

// ---- Error classification ----
export interface ProviderErrorInput {
  httpStatus?: number
  retryAfterSec?: number
  message?: string
  reauthRequired?: boolean
  networkError?: boolean
  invalidShape?: boolean
}

export function classifyProviderError(input: ProviderErrorInput): ProviderErrorNormalized {
  const message = redactProviderText(input.message || 'TalkingPhotos request failed')
  if (input.reauthRequired) return { kind: 'authentication', message, httpStatus: input.httpStatus, retryable: false }
  if (input.networkError) return { kind: 'network', message, retryable: true }
  if (input.httpStatus === 404) return { kind: 'not_found', message, httpStatus: 404, retryable: false }
  if (input.httpStatus === 429) return { kind: 'rate_limited', message, httpStatus: 429, retryAfterSec: input.retryAfterSec, retryable: true }
  if (input.httpStatus != null && input.httpStatus >= 500) return { kind: 'server_error', message, httpStatus: input.httpStatus, retryable: true }
  if (input.invalidShape) return { kind: 'invalid_response', message, httpStatus: input.httpStatus, retryable: false }
  if (input.httpStatus != null && input.httpStatus >= 400) return { kind: 'unknown', message, httpStatus: input.httpStatus, retryable: false }
  return { kind: 'unknown', message, retryable: false }
}

// ---- Redaction (never let cookies / signed URLs / tokens reach logs) ----
/** Matches a `name=value` pair (value 8+ chars, cookie-alphabet) followed by one or
 *  more `Path=|Domain=|HttpOnly|Secure|SameSite=` cookie attributes — i.e. a
 *  cookie-attribute-shaped token even when it appears without a literal
 *  `cookie:`/`set-cookie:` line prefix (e.g. echoed into an HTML error body, or a
 *  `Set-Cookie` value logged without its header name). Requires at least one
 *  recognized attribute immediately after the value, so ordinary `key=value` text
 *  with no cookie attributes is left untouched. */
const COOKIE_ATTR_RE =
  /\b[A-Za-z0-9_-]{1,64}=[A-Za-z0-9%._~+/=-]{8,};?\s*(?:Path=[^;\s]*|Domain=[^;\s]*|HttpOnly|Secure|SameSite=[^;\s]*)(?:;\s*(?:Path=[^;\s]*|Domain=[^;\s]*|HttpOnly|Secure|SameSite=[^;\s]*))*/gi

export function redactProviderText(text: string): string {
  return text
    .replace(/([?&](?:key|token|signature|sig|auth|session|api_key)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(?:set-cookie|cookie)\s*:\s*[^\n]+/gi, 'cookie: [redacted]')
    .replace(COOKIE_ATTR_RE, '[redacted-cookie]')
    .replace(/\b(?:sk|gsk)_[A-Za-z0-9_-]{12,}\b/g, '[redacted-key]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+\b/gi, 'Bearer [redacted]')
    .slice(0, 600)
}

// ---- Navigation guard for the isolated login window (plan §3, §19) ----
/** Only the TalkingPhotos app origin, https only. Deliberately conservative: the
 *  HAR did not capture the login/OAuth/MFA domain set (contract security gaps),
 *  so unknown hosts fail visibly rather than being silently allowed through. */
export function isAllowedProviderNavigation(url: string, allowedHost = TALKINGPHOTOS_APP_HOST): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname === allowedHost
  } catch {
    return false
  }
}

/** True only for TalkingPhotos' own CDN over https — used to gate output downloads. */
export function isAllowedProviderMediaUrl(url: string, allowedHost = TALKINGPHOTOS_CDN_HOST): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname === allowedHost
  } catch {
    return false
  }
}

// ============================================================================
// Phase 4-12 additions: TTS + WebSocket resolution, quota/concurrency, long-form
// segmentation, subtitles, and the preferred download route. Kept in this file
// (rather than a new one) so every provider-domain pure function lives in one
// place, matching the existing convention.
// ============================================================================

// ---- TTS (Phase 4/5/7) ----
export const TALKINGPHOTOS_WS_URL = 'wss://ws.talkingphotos.ai/'

export interface TalkingPhotosTtsSettings {
  language: string
  voice: string
  voiceStyle: string
  speed: number
  pitch: number
  autoTranslate: boolean
}

export const DEFAULT_TTS_SETTINGS: TalkingPhotosTtsSettings = {
  language: 'en-US', voice: 'en-US-AndrewMultilingualNeural', voiceStyle: 'general', speed: 1, pitch: 0, autoTranslate: false
}

export interface TalkingPhotosTtsCreateResult {
  uuid: string
  textValue: string
}

/** POST /text_to_speech/create_audio_vc response — runtime-validated, never trusted
 *  on HTTP 200 alone (confirmed shape: { success, uuid, textValue }). */
export function parseTtsCreateResponse(raw: unknown): TalkingPhotosTtsCreateResult | null {
  const r = record(raw)
  if (r.success !== true || typeof r.uuid !== 'string' || !r.uuid.trim()) return null
  return { uuid: r.uuid, textValue: typeof r.textValue === 'string' ? r.textValue : '' }
}

export interface TalkingPhotosTtsResolution {
  mediaId: string
  outPath: string
  durationSec: number
}

/** wss://ws.talkingphotos.ai completion frame — the ONLY accepted UUID -> media-ID
 *  resolver. Never infer by picking the newest Text-To-Speech library item, which
 *  breaks under concurrent TTS requests (contract: matchingWarning). Success requires
 *  ALL of: code===200, type==="audio", a positive-integer media_id, and a positive,
 *  finite duration. Anything else — including a frame for a different operation — is
 *  rejected by the caller via the recipient_uuid it opened the socket for. */
export function parseTtsSocketFrame(raw: unknown): TalkingPhotosTtsResolution | null {
  const r = record(raw)
  if (r.code !== 200) return null
  if (r.type !== 'audio') return null
  const mediaId = r.media_id
  if (typeof mediaId !== 'number' || !Number.isInteger(mediaId) || mediaId <= 0) return null
  const duration = r.duration
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return null
  return { mediaId: String(mediaId), outPath: typeof r.out_path === 'string' ? r.out_path : '', durationSec: duration }
}

export type TalkingPhotosTtsJobStatus =
  | 'submitted'
  | 'awaiting_resolution'
  | 'resolved'
  | 'timeout'
  | 'malformed'
  | 'closed_unresolved'
  | 'ambiguous'

/** Durable TTS orchestration checkpoint (mirrors TalkingPhotosCreationState — stored
 *  as JSON on a provider_jobs.requestJson row with operation='tts'). Never regenerate
 *  automatically once `status` leaves 'submitted'/'awaiting_resolution': ambiguity must
 *  be resolved by an explicit user action, not a silent retry that could double-bill. */
export interface TalkingPhotosTtsState {
  version: 1
  uuid: string
  text: string
  settings: TalkingPhotosTtsSettings
  projectStyle: TalkingPhotosProjectStyle
  status: TalkingPhotosTtsJobStatus
  mediaId?: string
  outPath?: string
  durationSec?: number
  submittedAt: string
  resolvedAt?: string
}

// ---- Manual custom-script -> TTS creation (Phase 5) ----
export interface TalkingPhotosScriptSegment {
  ordinal: number
  text: string
  ttsJobId?: string
  ttsMediaId?: string
  ttsDurationSec?: number
  providerJobId?: string
  remoteProjectId?: string
}

export interface TalkingPhotosScriptCreationState {
  version: 1
  kind: 'script'
  input: TalkingPhotosScriptCreateInput
  maxDurationSec: number
  maxChars: number
  characterDrivingMediaId?: string
  characterResultUuid?: string
  segments: TalkingPhotosScriptSegment[]
  stage: 'queued' | 'assets_ready' | 'tts_submitted' | 'tts_resolved' | 'segments_submitted' | 'merge_submitting' | 'merge_submitted' | 'subtitles_submitting' | 'subtitles_submitted'
  startedAt: string
}

export interface TalkingPhotosScriptCreateInput {
  title: string
  script: string
  characterImagePath: string
  characterPrompt: string
  characterNegativePrompt?: string
  style: TalkingPhotosProjectStyle
  aspectRatio: TalkingPhotosAspectRatio
  motionId: number
  characterGender?: 'male' | 'female'
  characterAge?: string
  characterStyle?: string
  characterBeard?: string
  language: string
  voice: string
  voiceStyle: string
  speed: number
  pitch: number
  subtitleMode: TalkingPhotosSubtitleMode
  automationJobId?: string
  automationItemId?: string
  projectId?: string
  creationIntentId?: string
}

// ---- Subtitles / local captions (Phase 8) ----
export type TalkingPhotosSubtitleMode = 'none' | 'provider' | 'local'

/** The subtitle mode is a single enum, not two independent booleans — "both enabled"
 *  is structurally unrepresentable. This function is the one normalization boundary:
 *  anything that isn't exactly 'provider' or 'local' becomes 'none'. */
export function normalizeSubtitleMode(raw: unknown): TalkingPhotosSubtitleMode {
  return raw === 'provider' || raw === 'local' ? raw : 'none'
}

export const DEFAULT_SUBTITLES_OPTIONS: Record<string, unknown> = {
  language: 'en-US',
  subtitlesType: 'highlighted-word',
  subtitlesStyle: 'stroke',
  position: 'bottom',
  alignment: 'center',
  textFontFamily: 'Montserrat',
  textFontSize: 52,
  colorPrimary: '#ffffff',
  colorSecondary: '#f7ff19',
  colorAccent: '#ffffff',
  colorStroke: '#000000',
  backgroundOpacity: 100,
  backgroundBoxFullWidth: false
}

/** Build a sanitized subtitle-creation payload from a raw GET /project/{id} response.
 *  Only a small, explicit allowlist of fields is carried over — user/account objects,
 *  media, status, and task fields are never copied (plan §8 / review privacy note). */
export function buildSubtitleCreatePayload(
  sourceProjectRaw: unknown,
  opts: { title: string; parentId: string; subtitlesOptions?: Record<string, unknown> }
): Record<string, unknown> | null {
  const r = record(sourceProjectRaw)
  const options = record(r.options)
  if (typeof r.type !== 'string' || typeof r.style !== 'string') return null
  return {
    title: opts.title,
    type: 'subtitles',
    style: r.style,
    parentId: opts.parentId,
    options: { aspectRatio: typeof options.aspectRatio === 'string' ? options.aspectRatio : '16:9' },
    subtitlesOptions: { ...DEFAULT_SUBTITLES_OPTIONS, ...(opts.subtitlesOptions ?? {}) }
  }
}

export interface TalkingPhotosSubtitleResult {
  id: string
  status: string
  mediaUrl?: string
  srtUrl?: string
  jsonUrl?: string
}

/** GET/POST subtitles response — completed/processing/pending only; no task UUID is
 *  required for this operation (plan §8). */
export function normalizeSubtitleProject(raw: unknown): TalkingPhotosSubtitleResult | null {
  const r = record(raw)
  if ((typeof r.id !== 'string' && typeof r.id !== 'number') || typeof r.status !== 'string' || !r.status.trim()) return null
  const media = record(r.media)
  return {
    id: str(r.id),
    status: r.status,
    mediaUrl: typeof media.mediaPath === 'string' && media.mediaPath ? media.mediaPath : undefined,
    srtUrl: typeof r.srtPath === 'string' ? r.srtPath : undefined,
    jsonUrl: typeof r.jsonPath === 'string' ? r.jsonPath : undefined
  }
}

// ---- Long-form script segmentation (Phase 7) ----
export interface TalkingPhotosScriptChunk {
  ordinal: number
  text: string
}

const CHUNK_SAFETY_MARGIN = 0.95

function splitOnSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) ?? [text]).map((s) => s.trim()).filter(Boolean)
}

/** Paragraph-first, then sentence-boundary, then (only as a last resort) a word-boundary
 *  hard wrap — every chunk stays under `maxChars * 0.95` (plan §7 safety margin) and
 *  ordinals are assigned deterministically left-to-right, never reordered later. */
export function planTalkingPhotosScriptChunks(script: string, maxChars: number): TalkingPhotosScriptChunk[] {
  const limit = Math.max(1, Math.floor(maxChars * CHUNK_SAFETY_MARGIN))
  const normalized = script.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim()
  if (!normalized) throw new Error('Script is empty.')
  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  const chunks: string[] = []
  let current = ''
  const flush = (): void => { if (current.trim()) chunks.push(current.trim()); current = '' }
  const appendPiece = (piece: string, joiner: string): void => {
    const candidate = current ? `${current}${joiner}${piece}` : piece
    if (candidate.length > limit) { flush(); current = piece } else current = candidate
  }
  for (const paragraph of paragraphs) {
    if (paragraph.length <= limit) { appendPiece(paragraph, '\n\n'); continue }
    for (const sentence of splitOnSentences(paragraph)) {
      if (sentence.length <= limit) { appendPiece(sentence, ' '); continue }
      flush()
      let rest = sentence
      while (rest.length > limit) {
        let cut = rest.lastIndexOf(' ', limit)
        if (cut <= 0) cut = limit
        chunks.push(rest.slice(0, cut).trim())
        rest = rest.slice(cut).trim()
      }
      current = rest
    }
  }
  flush()
  return chunks.map((text, ordinal) => ({ ordinal, text }))
}

/** Duration-driven re-segmentation: split an oversized chunk's text roughly in half at
 *  a sentence boundary (falling back to a word boundary) so replacement TTS chunks can
 *  be generated. The oversized TTS job itself is never reused for a Human project. */
export function splitOversizedScriptChunk(text: string): [string, string] {
  const sentences = splitOnSentences(text)
  if (sentences.length >= 2) {
    const half = Math.ceil(sentences.length / 2)
    return [sentences.slice(0, half).join(' ').trim(), sentences.slice(half).join(' ').trim()]
  }
  const mid = Math.floor(text.length / 2)
  let cut = text.lastIndexOf(' ', mid)
  if (cut <= 0) cut = mid
  return [text.slice(0, cut).trim(), text.slice(cut).trim()]
}

// ---- Transcript -> script reconstruction (Phase 7) ----
export interface TimedWord {
  word: string
  start: number
  end: number
}

/** Best-effort punctuation reconstruction from word timings for the 'transcript-tts'
 *  automation mode: inserts a period at each pause of `pauseSec` or longer and
 *  capitalizes the following word. This is a pause-based heuristic, not true
 *  punctuation restoration (no NLP model is involved) — good enough to seed a TTS
 *  script without literally concatenating bare words, never claimed as more. */
export function reconstructScriptFromWords(words: TimedWord[], pauseSec = 0.6): string {
  if (!words.length) return ''
  const sentences: string[] = []
  let current: string[] = []
  const capitalize = (w: string): string => w.length ? w.charAt(0).toUpperCase() + w.slice(1) : w
  for (let i = 0; i < words.length; i++) {
    const word = words[i].word.trim()
    if (!word) continue
    current.push(current.length === 0 ? capitalize(word) : word)
    const gap = i + 1 < words.length ? words[i + 1].start - words[i].end : Number.POSITIVE_INFINITY
    if (gap >= pauseSec || i === words.length - 1) {
      const joined = current.join(' ')
      sentences.push(/[.!?]$/.test(joined) ? joined : `${joined}.`)
      current = []
    }
  }
  return sentences.join(' ')
}

// ---- Quota / concurrency (Phase 6) ----
export interface ProviderSlotBudget {
  availableConcurrent: number
  availableDaily: number
}

/** Only ever called with a FRESHLY fetched ProviderCapabilities (plan §6: "refresh
 *  limits before paid submissions"). The budget this returns is spent down in-process,
 *  synchronously, for the remainder of one orchestration pass — there is no persistent
 *  reservation ledger to rebuild after a restart because every pass re-derives
 *  availability from the server's own concurrentCount/dailyUsage, which already
 *  reflects every submission (ours and anyone else's) as of the fetch. A limit of 0
 *  is treated as "unknown/unbounded" rather than "blocked" (never captured as a real
 *  zero in the HAR). */
export function computeSlotBudget(capabilities: ProviderCapabilities): ProviderSlotBudget {
  const { concurrentLimit, concurrentCount, dailyLimit, dailyUsage } = capabilities.usage
  return {
    availableConcurrent: concurrentLimit > 0 ? Math.max(0, concurrentLimit - concurrentCount) : Number.POSITIVE_INFINITY,
    availableDaily: dailyLimit > 0 ? Math.max(0, dailyLimit - dailyUsage) : Number.POSITIVE_INFINITY
  }
}

// ---- Preferred download route (Phase 9) ----
const PROJECT_DOWNLOAD_PATH_RE = /^\/project\/download\/([1-9][0-9]*)$/

/** Construct the preferred download URL — only from a validated positive integer
 *  project id. Returns null (never a guessed/partial URL) for anything else. */
export function buildProjectDownloadUrl(remoteProjectId: string): string | null {
  if (!/^[1-9][0-9]*$/.test(remoteProjectId)) return null
  return `${TALKINGPHOTOS_BASE_URL}/project/download/${remoteProjectId}`
}

/** Strict allowlist: origin exactly https://app.talkingphotos.ai AND path exactly
 *  /project/download/<positive-integer> — never a broad "any app.talkingphotos.ai URL"
 *  allowance (plan §9). */
export function isAllowedProjectDownloadUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname === TALKINGPHOTOS_APP_HOST && PROJECT_DOWNLOAD_PATH_RE.test(u.pathname)
  } catch {
    return false
  }
}

/** Sanitize a Content-Disposition filename: strips path separators and traversal so it
 *  can never escape the destination directory when used as a local file name. */
export function sanitizeDownloadFilename(contentDisposition: string | undefined | null, fallback: string): string {
  const match = contentDisposition ? /filename\*?=(?:UTF-8''|")?([^";\n]+)"?/i.exec(contentDisposition) : null
  let candidate = fallback
  if (match?.[1]) {
    try { candidate = decodeURIComponent(match[1].replace(/^"|"$/g, '')) } catch { candidate = match[1].replace(/^"|"$/g, '') }
  }
  const base = candidate.replace(/[\\/]/g, '_').replace(/\.\.+/g, '_').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 150)
  return base || fallback
}
