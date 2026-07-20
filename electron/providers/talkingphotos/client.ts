import { net } from 'electron'
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
  normalizeVoice,
  redactProviderText,
  type ProviderCapabilities,
  type ProviderErrorNormalized,
  type ProviderLanguage,
  type ProviderMotion,
  type ProviderMotionQuery,
  type ProviderProjectSummary,
  type ProviderVoice
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
function rawRequest(path: string, opts: { method?: string; body?: string } = {}): Promise<RawResponse> {
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
    if (opts.body) req.setHeader('content-type', 'application/json')
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
