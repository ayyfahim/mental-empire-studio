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
export type ProviderConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reauth_required' | 'error'

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
export function redactProviderText(text: string): string {
  return text
    .replace(/([?&](?:key|token|signature|sig|auth|session|api_key)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(?:set-cookie|cookie)\s*:\s*[^\n]+/gi, 'cookie: [redacted]')
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
