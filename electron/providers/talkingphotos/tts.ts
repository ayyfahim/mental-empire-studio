import WS from 'ws'
import { randomUUID } from 'node:crypto'
import { getRepos } from '../../db'
import { createTtsAudio, ensureLibraryCategory, listLibraryMedia } from './client'
import {
  TALKINGPHOTOS_CONNECTION_ID,
  TALKINGPHOTOS_PROVIDER,
  TALKINGPHOTOS_WS_URL,
  parseTtsSocketFrame,
  type ProviderJob,
  type TalkingPhotosProjectStyle,
  type TalkingPhotosRemoteMedia,
  type TalkingPhotosTtsSettings,
  type TalkingPhotosTtsState
} from '../../../shared/talkingphotos'
import { L } from '../../services/logger'

// Main-process-only TTS service. The socket, and everything it carries, never
// crosses into the renderer — the renderer only ever sees the resulting ProviderJob
// (plan §4 / §19). One WebSocket connection is opened per TTS UUID and closed as soon
// as that operation settles, so two concurrent TTS jobs can never cross-associate a
// result: correlation is structural (which socket received the frame), not by
// inspecting a UUID field the confirmed completion frame does not carry.

// Longest observed TTS generation in the capture was ~131s for ~6k characters;
// generous margin above that before treating the wait as failed.
const SOCKET_TIMEOUT_MS = 4 * 60_000

export type TtsSocketOutcome =
  | { kind: 'resolved'; mediaId: string; outPath: string; durationSec: number }
  | { kind: 'timeout' }
  | { kind: 'malformed'; raw: string }
  | { kind: 'closed_unresolved' }

/** Opens exactly one socket, sends the confirmed subscribe frame, and resolves on the
 *  first frame that satisfies parseTtsSocketFrame's strict validation. Any other
 *  outcome is reported distinctly and never triggers an automatic resubmission — that
 *  decision belongs entirely to the caller. */
export function waitForTtsResolution(uuid: string): Promise<TtsSocketOutcome> {
  return new Promise((resolve) => {
    let settled = false
    let socket: WS
    try {
      socket = new WS(TALKINGPHOTOS_WS_URL)
    } catch {
      resolve({ kind: 'closed_unresolved' })
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const finish = (outcome: TtsSocketOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* already closing/closed */ }
      resolve(outcome)
    }
    timer = setTimeout(() => finish({ kind: 'timeout' }), SOCKET_TIMEOUT_MS)
    socket.on('open', () => {
      try {
        socket.send(JSON.stringify({ recipient_uuid: uuid, message: 'connected' }))
      } catch {
        finish({ kind: 'closed_unresolved' })
      }
    })
    socket.on('message', (data) => {
      const text = data.toString()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        finish({ kind: 'malformed', raw: text.slice(0, 200) })
        return
      }
      const resolution = parseTtsSocketFrame(parsed)
      // A well-formed but non-matching frame (progress ping, unrelated shape) is
      // ignored, not treated as failure — only a fully valid completion frame settles.
      if (resolution) finish({ kind: 'resolved', mediaId: resolution.mediaId, outPath: resolution.outPath, durationSec: resolution.durationSec })
    })
    socket.on('error', (e) => {
      L.warn(`talkingphotos tts socket error: ${(e as Error).message}`)
      finish({ kind: 'closed_unresolved' })
    })
    socket.on('close', () => finish({ kind: 'closed_unresolved' }))
  })
}

function ttsState(job: ProviderJob): TalkingPhotosTtsState {
  let parsed: Partial<TalkingPhotosTtsState>
  try {
    parsed = JSON.parse(job.requestJson || '') as Partial<TalkingPhotosTtsState>
  } catch {
    throw new Error('TalkingPhotos TTS checkpoint is missing or invalid.')
  }
  if (parsed.version !== 1 || !parsed.uuid) throw new Error('TalkingPhotos TTS checkpoint is missing or invalid.')
  return parsed as TalkingPhotosTtsState
}

function saveTtsState(jobId: string, state: TalkingPhotosTtsState, patch: Partial<ProviderJob> = {}): ProviderJob {
  const repos = getRepos()
  repos.updateProviderJob(jobId, { ...patch, requestJson: JSON.stringify(state) })
  const job = repos.providerJob(jobId)
  if (!job) throw new Error('TalkingPhotos TTS provider job disappeared while checkpointing.')
  return job
}

export interface SubmitTtsInput {
  text: string
  settings: TalkingPhotosTtsSettings
  projectStyle: TalkingPhotosProjectStyle
  automationJobId?: string
  automationItemId?: string
  projectId?: string
}

/** Submit TTS and persist the returned UUID immediately, BEFORE opening the socket —
 *  a crash between submission and resolution must never lose which UUID is owed a
 *  result. Marked internalSegment so it stays out of the main provider-job list; it is
 *  an intermediate artifact feeding a Human project, not a user-facing output. */
export async function submitTts(input: SubmitTtsInput): Promise<ProviderJob> {
  const created = await createTtsAudio({ text: input.text, settings: input.settings, projectStyle: input.projectStyle })
  const repos = getRepos()
  const now = new Date().toISOString()
  const state: TalkingPhotosTtsState = {
    version: 1, uuid: created.uuid, text: input.text, settings: input.settings, projectStyle: input.projectStyle,
    status: 'submitted', submittedAt: now
  }
  const job: ProviderJob = {
    id: `tpj-tts-${randomUUID()}`, provider: TALKINGPHOTOS_PROVIDER, connectionId: TALKINGPHOTOS_CONNECTION_ID,
    operation: 'tts', automationJobId: input.automationJobId, automationItemId: input.automationItemId, projectId: input.projectId,
    status: 'running', progress: 10, internalSegment: true, createdAt: now, updatedAt: now,
    requestJson: JSON.stringify(state)
  }
  repos.upsertProviderJob(job)
  L.info(`talkingphotos tts submitted job=${job.id} uuid=${created.uuid}`)
  return job
}

/** Wait for the WebSocket resolution of an already-submitted TTS job. Never
 *  re-submits — a job not in 'submitted'/'awaiting_resolution' is refused outright. */
export async function resolveTtsJob(jobId: string): Promise<ProviderJob> {
  const repos = getRepos()
  const job = repos.providerJob(jobId)
  if (!job) throw new Error(`Unknown TTS job: ${jobId}`)
  const state = ttsState(job)
  if (state.status === 'resolved') return job
  if (state.status !== 'submitted' && state.status !== 'awaiting_resolution') {
    throw new Error(`TalkingPhotos TTS job ${jobId} is in a non-resolvable state (${state.status}); manual recovery required.`)
  }
  saveTtsState(job.id, { ...state, status: 'awaiting_resolution' }, { status: 'running', progress: 20 })
  const outcome = await waitForTtsResolution(state.uuid)
  if (outcome.kind === 'resolved') {
    const resolved: TalkingPhotosTtsState = {
      ...state, status: 'resolved', mediaId: outcome.mediaId, outPath: outcome.outPath, durationSec: outcome.durationSec, resolvedAt: new Date().toISOString()
    }
    return saveTtsState(job.id, resolved, { status: 'completed', progress: 100, remoteMediaId: outcome.mediaId, errorCode: '', errorMessage: '' })
  }
  const failedStatus = outcome.kind === 'timeout' ? 'timeout' : outcome.kind === 'malformed' ? 'malformed' : 'closed_unresolved'
  const message = outcome.kind === 'timeout'
    ? 'TalkingPhotos TTS did not resolve before timing out.'
    : outcome.kind === 'malformed'
      ? 'TalkingPhotos TTS WebSocket sent a malformed frame.'
      : 'TalkingPhotos TTS WebSocket closed before a result arrived.'
  L.warn(`talkingphotos tts unresolved job=${job.id} uuid=${state.uuid}: ${message}`)
  return saveTtsState(job.id, { ...state, status: failedStatus }, { status: 'attention', errorCode: 'tts_unresolved', errorMessage: message })
}

/** Startup recovery: a TTS job left mid-flight when the app last closed cannot be
 *  safely resumed — the WebSocket wait was tied to that process's lifetime, not
 *  proven recoverable across a restart (plan §7). It is marked `attention`, the UUID
 *  is preserved, and it is never silently resubmitted. */
export function reconcileUnresolvedTtsJobsOnStartup(): number {
  const repos = getRepos()
  const stuck = repos.providerJobs(TALKINGPHOTOS_CONNECTION_ID).filter((job) => job.operation === 'tts' && (job.status === 'running' || job.status === 'queued'))
  let marked = 0
  for (const job of stuck) {
    let state: TalkingPhotosTtsState
    try {
      state = ttsState(job)
    } catch {
      continue
    }
    if (state.status === 'resolved') continue
    saveTtsState(job.id, { ...state, status: 'closed_unresolved' }, {
      status: 'attention', errorCode: 'tts_unresolved',
      errorMessage: 'TalkingPhotos TTS resolution was interrupted by an app restart; the UUID is preserved but was not regenerated.'
    })
    marked++
  }
  if (marked > 0) L.warn(`talkingphotos: marked ${marked} unresolved TTS job(s) attention after restart`)
  return marked
}

/** Display/manual-recovery only (plan §4): lists the Text-To-Speech library so a user
 *  can visually pick which item matches an unresolved job, e.g. by comparing the
 *  submission time and expected duration. Never called automatically. */
export async function listTtsLibraryForRecovery(opts: { page?: number; limit?: number } = {}): Promise<TalkingPhotosRemoteMedia[]> {
  const category = await ensureLibraryCategory('Text To Speech')
  return listLibraryMedia(category.id, opts)
}

/** Persist an explicit, user-confirmed recovery choice for a TTS job stuck in
 *  attention. This is the ONLY path by which a library item is ever associated with a
 *  job after the fact — never automatic, never "pick the newest item". */
export function confirmRecoveredTts(jobId: string, mediaId: string, durationSec: number): ProviderJob {
  const job = getRepos().providerJob(jobId)
  if (!job || job.operation !== 'tts') throw new Error(`Unknown TTS job: ${jobId}`)
  const state = ttsState(job)
  const resolved: TalkingPhotosTtsState = { ...state, status: 'resolved', mediaId, durationSec, resolvedAt: new Date().toISOString() }
  return saveTtsState(job.id, resolved, { status: 'completed', progress: 100, remoteMediaId: mediaId, errorCode: '', errorMessage: '' })
}
