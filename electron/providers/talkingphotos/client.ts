import { net } from 'electron'
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getProviderSession } from './partition'
import {
  TALKINGPHOTOS_BASE_URL,
  classifyProviderError,
  detectReauthRequired,
  isValidProjectSummaryShape,
  normalizeCapabilities,
  normalizeLanguage,
  normalizeMotion,
  normalizeProjectSummary,
  normalizeSubtitleProject,
  normalizeVoice,
  parseTtsCreateResponse,
  redactProviderText,
  type ProviderCapabilities,
  type ProviderErrorNormalized,
  type ProviderLanguage,
  type ProviderMotion,
  type ProviderMotionQuery,
  type ProviderProjectSummary,
  type ProviderVoice,
  type TalkingPhotosHumanProjectPayload,
  type TalkingPhotosProjectStyle,
  type TalkingPhotosRemoteMedia,
  type TalkingPhotosSubtitleResult,
  type TalkingPhotosTtsCreateResult,
  type TalkingPhotosTtsSettings
} from '../../../shared/talkingphotos'
import { L } from '../../services/logger'

// Session-bound HTTP client for TalkingPhotos. Every request goes through
// Electron's net.request bound to the isolated partition session (never the global
// Node/undici fetch() other services use — that path does not carry this partition's
// cookies). net.request's `session` option is documented and stable across Electron
// versions; net.fetch's session-binding surface is newer and less certain, so
// net.request is used uniformly here, including for the streaming downloader.

export class ProviderRequestError extends Error {
  readonly normalized: ProviderErrorNormalized
  constructor(normalized: ProviderErrorNormalized) {
    super(normalized.message)
    this.name = 'ProviderRequestError'
    this.normalized = normalized
  }
}

interface RawResponse {
  status: number
  contentType: string | null
  bodyText: string
}

function looksLikeHtml(body: string): boolean {
  return /^\s*<(!doctype html|html)/i.test(body.slice(0, 200))
}

/** Low-level session-bound request. Redirects are followed automatically (Electron
 *  default); reauth is instead detected from the FINAL response (401/403, or HTML
 *  where JSON was expected) — the HAR did not capture the exact login-redirect route
 *  (contract security.authentication), so we don't depend on intercepting it. */
function rawRequest(path: string, opts: { method?: string; body?: string | Buffer; contentType?: string } = {}): Promise<RawResponse> {
  const method = opts.method ?? 'GET'
  const url = path.startsWith('http') ? path : `${TALKINGPHOTOS_BASE_URL}${path}`
  return new Promise((resolve, reject) => {
    let req: ReturnType<typeof net.request>
    try {
      req = net.request({ method, url, session: getProviderSession(), redirect: 'follow' })
    } catch (e) {
      reject(e as Error)
      return
    }
    req.setHeader('accept', 'application/json')
    req.setHeader('x-requested-with', 'XMLHttpRequest')
    if (opts.body) {
      req.setHeader('content-type', opts.contentType || 'application/json')
      req.setHeader('content-length', String(Buffer.byteLength(opts.body)))
    }
    req.on('response', (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const header = res.headers['content-type']
        resolve({
          status: res.statusCode,
          contentType: Array.isArray(header) ? header[0] ?? null : (header as string | undefined) ?? null,
          bodyText: Buffer.concat(chunks).toString('utf8')
        })
      })
      res.on('error', (e: Error) => reject(e))
    })
    req.on('error', (e) => reject(e))
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

/** GET/POST a JSON endpoint, returning the parsed body. Throws ProviderRequestError
 *  (normalized, redacted) on any auth/network/shape failure — a 200 status alone is
 *  never treated as success (plan §11). */
export async function fetchProviderJson<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let raw: RawResponse
  try {
    raw = await rawRequest(path, { method: opts.method, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  } catch (e) {
    const message = redactProviderText((e as Error).message || 'network error')
    L.warn(`talkingphotos request failed (network): ${path} — ${message}`)
    throw new ProviderRequestError(classifyProviderError({ networkError: true, message }))
  }

  const reauthRequired = detectReauthRequired({
    status: raw.status,
    contentType: raw.contentType,
    bodyLooksHtml: looksLikeHtml(raw.bodyText)
  })
  if (reauthRequired) {
    L.warn(`talkingphotos reauth required: ${path} (status=${raw.status})`)
    throw new ProviderRequestError(classifyProviderError({ reauthRequired: true, httpStatus: raw.status, message: 'TalkingPhotos session expired — reconnect required.' }))
  }
  if (raw.status < 200 || raw.status >= 300) {
    const retryAfter = Number((raw.bodyText.match(/retry-after"?\s*[:=]\s*"?(\d+)/i) || [])[1]) || undefined
    const message = redactProviderText(raw.bodyText.slice(0, 300) || `HTTP ${raw.status}`)
    L.warn(`talkingphotos request failed: ${path} — status=${raw.status}`)
    throw new ProviderRequestError(classifyProviderError({ httpStatus: raw.status, retryAfterSec: retryAfter, message }))
  }
  try {
    return JSON.parse(raw.bodyText) as T
  } catch {
    L.warn(`talkingphotos invalid JSON response: ${path}`)
    throw new ProviderRequestError(classifyProviderError({ invalidShape: true, httpStatus: raw.status, message: 'TalkingPhotos returned an unexpected response.' }))
  }
}

async function fetchProviderBodyJson<T>(path: string, opts: { method: string; body: Buffer; contentType: string }): Promise<T> {
  let raw: RawResponse
  try {
    raw = await rawRequest(path, opts)
  } catch (e) {
    const message = redactProviderText((e as Error).message || 'network error')
    throw new ProviderRequestError(classifyProviderError({ networkError: true, message }))
  }
  const reauthRequired = detectReauthRequired({ status: raw.status, contentType: raw.contentType, bodyLooksHtml: looksLikeHtml(raw.bodyText) })
  if (reauthRequired) throw new ProviderRequestError(classifyProviderError({ reauthRequired: true, httpStatus: raw.status, message: 'TalkingPhotos session expired — reconnect required.' }))
  if (raw.status < 200 || raw.status >= 300) throw new ProviderRequestError(classifyProviderError({ httpStatus: raw.status, message: redactProviderText(raw.bodyText.slice(0, 300) || `HTTP ${raw.status}`) }))
  try { return JSON.parse(raw.bodyText) as T } catch {
    throw new ProviderRequestError(classifyProviderError({ invalidShape: true, httpStatus: raw.status, message: 'TalkingPhotos returned an unexpected response.' }))
  }
}

function normalizedRemoteMedia(raw: unknown): TalkingPhotosRemoteMedia {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const data = r.data && typeof r.data === 'object' ? r.data as Record<string, unknown> : {}
  if ((typeof r.id !== 'number' && typeof r.id !== 'string') || r.type !== 'audio' && r.type !== 'image') {
    throw new ProviderRequestError(classifyProviderError({ invalidShape: true, message: 'TalkingPhotos returned an invalid uploaded-media response.' }))
  }
  return {
    id: String(r.id), title: typeof r.title === 'string' ? r.title : '', type: String(r.type),
    extension: typeof r.extension === 'string' ? r.extension : '',
    categoryId: r.categoryId == null ? undefined : String(r.categoryId),
    durationSec: typeof data.duration === 'number' ? data.duration : undefined
  }
}

interface LibraryCategory { id: string; title: string }

export async function ensureLibraryCategory(title: string): Promise<LibraryCategory> {
  const raw = await fetchProviderJson<{ items?: unknown[] }>(`/library/categories?page=1&limit=100&query=${encodeURIComponent(title)}`)
  const items = Array.isArray(raw.items) ? raw.items : []
  const match = items.find((item) => item && typeof item === 'object' && String((item as Record<string, unknown>).title).toLowerCase() === title.toLowerCase()) as Record<string, unknown> | undefined
  if (match && (typeof match.id === 'number' || typeof match.id === 'string')) return { id: String(match.id), title: String(match.title) }
  const created = await fetchProviderJson<Record<string, unknown>>('/library/categories', { method: 'POST', body: { title } })
  if ((typeof created.id !== 'number' && typeof created.id !== 'string') || typeof created.title !== 'string') {
    throw new ProviderRequestError(classifyProviderError({ invalidShape: true, message: 'TalkingPhotos did not return the new library category.' }))
  }
  return { id: String(created.id), title: created.title }
}

function mimeFor(path: string, type: 'audio' | 'image'): string {
  const ext = extname(path).toLowerCase()
  const map: Record<string, string> = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
  return map[ext] || (type === 'audio' ? 'application/octet-stream' : 'image/png')
}

export async function uploadLibraryMedia(path: string, type: 'audio' | 'image', categoryId: string): Promise<TalkingPhotosRemoteMedia> {
  const boundary = `----MentalEmpire${randomUUID().replace(/-/g, '')}`
  const filename = basename(path).replace(/["\r\n]/g, '_')
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeFor(path, type)}\r\n\r\n`)
  const middle = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${type}\r\n--${boundary}--\r\n`)
  const body = Buffer.concat([prefix, readFileSync(path), middle])
  const raw = await fetchProviderBodyJson<unknown>(`/library/categories/upload/${encodeURIComponent(categoryId)}`, { method: 'POST', body, contentType: `multipart/form-data; boundary=${boundary}` })
  return normalizedRemoteMedia(raw)
}

export async function getDurationLimit(style: TalkingPhotosProjectStyle): Promise<number> {
  const raw = await fetchProviderJson<Record<string, unknown>>('/project/video_duration_limit', { method: 'POST', body: { projectType: 'human', projectStyle: style } })
  const value = Number(raw.maxDuration)
  if (!Number.isFinite(value) || value <= 0) throw new ProviderRequestError(classifyProviderError({ invalidShape: true, message: 'TalkingPhotos returned an invalid Human video duration limit.' }))
  return value
}

/** Style-specific duration AND character limits in one call — the TTS/script flow
 *  needs both (never hard-coded globally: normal vs high_quality differ). */
export async function getProjectLimits(style: TalkingPhotosProjectStyle): Promise<{ maxDurationSec: number; maxCharactersTts: number }> {
  const raw = await fetchProviderJson<Record<string, unknown>>('/project/video_duration_limit', { method: 'POST', body: { projectType: 'human', projectStyle: style } })
  const maxDurationSec = Number(raw.maxDuration)
  const maxCharactersTts = Number(raw.maxCharactersTTS)
  if (!Number.isFinite(maxDurationSec) || maxDurationSec <= 0 || !Number.isFinite(maxCharactersTts) || maxCharactersTts <= 0) {
    throw new ProviderRequestError(classifyProviderError({ invalidShape: true, message: 'TalkingPhotos returned invalid Human video limits.' }))
  }
  return { maxDurationSec, maxCharactersTts }
}

export async function trimLibraryMedia(input: { mediaId: string; startSec: number; endSec: number; title: string }): Promise<TalkingPhotosRemoteMedia> {
  const raw = await fetchProviderJson<Record<string, unknown>>('/ai_api/trim_media', { method: 'POST', body: { mediaId: Number(input.mediaId), timeStart: input.startSec, timeEnd: input.endSec, title: input.title, useFadeOut: false } })
  if (raw.success !== true) throw new ProviderRequestError(classifyProviderError({ invalidShape: true, message: 'TalkingPhotos did not confirm the trimmed audio.' }))
  return normalizedRemoteMedia(raw.media)
}

export async function createCharacterImage(input: {
  prompt: string; negativePrompt?: string; aspectRatio: string; gender?: string; characterStyle?: string;
  characterBeard?: string; characterAge?: string; imageDrivingMediaId: string; projectStyle: TalkingPhotosProjectStyle
}): Promise<string> {
  const raw = await fetchProviderJson<Record<string, unknown>>('/ai_api/create_image_from_prompt', { method: 'POST', body: {
    type: 'human', prompt: input.prompt, negativePrompt: input.negativePrompt || '', aspectRatio: input.aspectRatio,
    gender: input.gender || 'male', ethnicity: '', characterStyle: input.characterStyle || 'realistic',
    characterBeard: input.characterBeard || 'shaven', characterAge: input.characterAge || 'adult',
    imageDrivingMediaId: Number(input.imageDrivingMediaId), projectStyle: input.projectStyle
  } })
  if (raw.success !== true || typeof raw.uuid !== 'string' || !raw.uuid) throw new ProviderRequestError(classifyProviderError({ invalidShape: true, message: 'TalkingPhotos did not return a generated-character UUID.' }))
  return raw.uuid
}

export async function createHumanProject(payload: TalkingPhotosHumanProjectPayload): Promise<ProviderProjectSummary> {
  const raw = await fetchProviderJson<unknown>('/project', { method: 'POST', body: payload })
  const project = normalizeProjectSummary(raw)
  if (!project || project.type !== 'human') throw new ProviderRequestError(classifyProviderError({ invalidShape: true, message: 'TalkingPhotos did not return the created Human project.' }))
  return project
}

export async function mergeProjects(input: { projectIds: string[]; title: string }): Promise<ProviderProjectSummary> {
  const raw = await fetchProviderJson<unknown>('/project/merge_videos', { method: 'POST', body: { itemsIds: input.projectIds.map(Number), title: input.title, audioMediaId: 0 } })
  const project = normalizeProjectSummary(raw)
  if (!project || project.type !== 'video_merge') throw new ProviderRequestError(classifyProviderError({ invalidShape: true, message: 'TalkingPhotos did not return the merged project.' }))
  return project
}

/** Harmless authenticated read used both as the connect-flow probe and as the
 *  periodic health check. Reads video_daily_usage (contract-confirmed GET, no
 *  side effects). */
export async function healthCheck(): Promise<{ ok: boolean; reauthRequired: boolean; message?: string }> {
  try {
    const body = await fetchProviderJson<Record<string, unknown>>('/project/video_daily_usage')
    return { ok: typeof body.dailyLimit === 'number' || typeof body.dailyUsage === 'number', reauthRequired: false }
  } catch (e) {
    if (e instanceof ProviderRequestError) return { ok: false, reauthRequired: e.normalized.kind === 'authentication', message: e.normalized.message }
    return { ok: false, reauthRequired: false, message: (e as Error).message }
  }
}

export async function getCapabilities(): Promise<ProviderCapabilities> {
  const [durationLimit, concurrency, dailyUsage] = await Promise.all([
    fetchProviderJson<unknown>('/project/video_duration_limit', { method: 'POST', body: { projectType: 'human', projectStyle: 'normal' } }),
    fetchProviderJson<unknown>('/project/concurrent_limit/human'),
    fetchProviderJson<unknown>('/project/video_daily_usage')
  ])
  return normalizeCapabilities({ durationLimit, concurrency, dailyUsage })
}

export async function listLanguages(): Promise<ProviderLanguage[]> {
  const raw = await fetchProviderJson<unknown[]>('/text_to_speech/languages')
  return Array.isArray(raw) ? raw.map(normalizeLanguage) : []
}

export async function listVoices(languageCode: string): Promise<ProviderVoice[]> {
  const raw = await fetchProviderJson<unknown[]>(`/text_to_speech/voices/${encodeURIComponent(languageCode)}`)
  return Array.isArray(raw) ? raw.map(normalizeVoice) : []
}

export async function listMotions(query: ProviderMotionQuery): Promise<ProviderMotion[]> {
  const params = new URLSearchParams({ motion_type: 'animate-v3', ...(query.gender ? { gender: query.gender } : {}), ...(query.aspectRatio ? { aspect_ratio: query.aspectRatio } : {}), ...(query.style ? { style: query.style } : {}) })
  const raw = await fetchProviderJson<unknown[]>(`/motions/list/${query.projectType}?${params.toString()}`)
  return Array.isArray(raw) ? raw.map(normalizeMotion) : []
}

export async function listProjects(query: { page?: number; limit?: number; status?: string } = {}): Promise<ProviderProjectSummary[]> {
  const params = new URLSearchParams({ page: String(query.page ?? 1), limit: String(query.limit ?? 20), ...(query.status ? { status: query.status } : {}) })
  const raw = await fetchProviderJson<{ items?: unknown[] } | unknown[]>(`/project?${params.toString()}`)
  const items = Array.isArray(raw) ? raw : Array.isArray((raw as { items?: unknown[] }).items) ? (raw as { items: unknown[] }).items : []
  return items.map(normalizeProjectSummary).filter((p): p is ProviderProjectSummary => p != null)
}

export async function getProject(remoteProjectId: string): Promise<ProviderProjectSummary | null> {
  const raw = await fetchProviderJson<unknown>(`/project/${encodeURIComponent(remoteProjectId)}`)
  if (!isValidProjectSummaryShape(raw)) return null
  return normalizeProjectSummary(raw)
}

/** Raw project detail, unnormalized — used only to build a sanitized subtitle-clone
 *  payload (buildSubtitleCreatePayload strips everything else). Never logged whole. */
export async function getProjectRaw(remoteProjectId: string): Promise<unknown> {
  return fetchProviderJson<unknown>(`/project/${encodeURIComponent(remoteProjectId)}`)
}

/** POST /text_to_speech/create_audio_vc. Returns only the confirmed { success, uuid,
 *  textValue } shape — the response never contains a media ID (contract critical gap);
 *  the caller must resolve that separately through the WebSocket. */
export async function createTtsAudio(input: { text: string; settings: TalkingPhotosTtsSettings; projectStyle: TalkingPhotosProjectStyle }): Promise<TalkingPhotosTtsCreateResult> {
  const raw = await fetchProviderJson<unknown>('/text_to_speech/create_audio_vc', {
    method: 'POST',
    body: {
      lang: input.settings.language, voice: input.settings.voice, autoTranslate: input.settings.autoTranslate,
      text: input.text, voiceStyle: input.settings.voiceStyle, speed: input.settings.speed, pitch: input.settings.pitch,
      projectType: 'human', projectStyle: input.projectStyle
    }
  })
  const parsed = parseTtsCreateResponse(raw)
  if (!parsed) throw new ProviderRequestError(classifyProviderError({ invalidShape: true, message: 'TalkingPhotos did not return a TTS result UUID.' }))
  return parsed
}

export async function listProjectLanguages(): Promise<ProviderLanguage[]> {
  const raw = await fetchProviderJson<unknown[]>('/project/languages')
  return Array.isArray(raw) ? raw.map(normalizeLanguage) : []
}

/** POST /project/subtitles/create — payload must already be the sanitized clone from
 *  buildSubtitleCreatePayload; this function does not build or sanitize it. */
export async function createSubtitlesProject(payload: Record<string, unknown>): Promise<TalkingPhotosSubtitleResult> {
  const raw = await fetchProviderJson<unknown>('/project/subtitles/create', { method: 'POST', body: payload })
  const result = normalizeSubtitleProject(raw)
  if (!result) throw new ProviderRequestError(classifyProviderError({ invalidShape: true, message: 'TalkingPhotos did not return the created subtitles project.' }))
  return result
}

export async function getSubtitlesProject(remoteProjectId: string): Promise<TalkingPhotosSubtitleResult | null> {
  const raw = await fetchProviderJson<unknown>(`/project/${encodeURIComponent(remoteProjectId)}`)
  return normalizeSubtitleProject(raw)
}

/** GET /library/categories/media/{categoryId} — display/manual-recovery use only
 *  (plan §4: never used to automatically infer a TTS result by picking the newest
 *  item, which breaks under concurrent requests). */
export async function listLibraryMedia(categoryId: string, opts: { page?: number; limit?: number } = {}): Promise<TalkingPhotosRemoteMedia[]> {
  const params = new URLSearchParams({ page: String(opts.page ?? 1), limit: String(opts.limit ?? 20), query: '' })
  const raw = await fetchProviderJson<{ items?: unknown[] }>(`/library/categories/media/${encodeURIComponent(categoryId)}?${params.toString()}`)
  const items = Array.isArray(raw.items) ? raw.items : []
  return items
    .map((item) => { try { return normalizedRemoteMedia(item) } catch { return null } })
    .filter((m): m is TalkingPhotosRemoteMedia => m != null)
}
