import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { getRepos } from '../../db'
import { probeDuration } from '../../services/audio'
import {
  TALKINGPHOTOS_CONNECTION_ID,
  TALKINGPHOTOS_PROVIDER,
  buildTalkingPhotosHumanPayload,
  buildTalkingPhotosHumanTtsPayload,
  planTalkingPhotosScriptChunks,
  planTalkingPhotosSegments,
  splitOversizedScriptChunk,
  type ProviderAsset,
  type ProviderJob,
  type ProviderProjectSummary,
  type TalkingPhotosCreateInput,
  type TalkingPhotosCreationState,
  type TalkingPhotosScriptCreateInput,
  type TalkingPhotosScriptCreationState,
  type TalkingPhotosScriptSegment,
  type TalkingPhotosTtsState
} from '../../../shared/talkingphotos'
import {
  createCharacterImage,
  createHumanProject,
  ensureLibraryCategory,
  getDurationLimit,
  getProjectLimits,
  listProjects,
  mergeProjects,
  ProviderRequestError,
  trimLibraryMedia,
  uploadLibraryMedia
} from './client'
import { resolveTtsJob, submitTts } from './tts'
import { fetchSubmissionBudget, logBudgetExhausted, type SubmissionBudget } from './quota'
import { downloadProviderJobOutput, outputDir } from './downloader'
import { mergeVideoFilesLocally } from './localMerge'
import { L } from '../../services/logger'

const inFlight = new Set<string>()
const creationByFingerprint = new Map<string, Promise<ProviderJob>>()
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

function now(): string { return new Date().toISOString() }

async function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function parseState(job: ProviderJob): TalkingPhotosCreationState {
  try {
    const parsed = JSON.parse(job.requestJson || '') as TalkingPhotosCreationState
    if (parsed.version === 1 && parsed.input && Array.isArray(parsed.segments)) return parsed
  } catch { /* handled below */ }
  throw new Error('TalkingPhotos creation checkpoint is missing or invalid.')
}

function saveState(jobId: string, state: TalkingPhotosCreationState, patch: Partial<ProviderJob> = {}): ProviderJob {
  const repos = getRepos()
  repos.updateProviderJob(jobId, { ...patch, requestJson: JSON.stringify(state) })
  const job = repos.providerJob(jobId)
  if (!job) throw new Error('TalkingPhotos provider job disappeared while checkpointing.')
  return job
}

function saveCreationFailure(jobId: string, error: unknown, fallbackCode: string): void {
  const repos = getRepos()
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof ProviderRequestError && error.normalized.kind === 'authentication') {
    const connection = repos.providerConnection(TALKINGPHOTOS_CONNECTION_ID)
    if (connection) repos.upsertProviderConnection({ ...connection, status: 'reauth_required', lastError: message })
    repos.updateProviderJob(jobId, { status: 'attention', errorCode: 'reauth_required', errorMessage: message })
    return
  }
  repos.updateProviderJob(jobId, { status: 'attention', errorCode: fallbackCode, errorMessage: message })
}

function validateInput(input: TalkingPhotosCreateInput): void {
  if (!input.title.trim()) throw new Error('Enter a title for the TalkingPhotos video.')
  if (!input.characterPrompt.trim()) throw new Error('Enter a character prompt.')
  if (!existsSync(input.audioPath) || !AUDIO_EXTENSIONS.has(extname(input.audioPath).toLowerCase())) throw new Error('Choose a supported local audio file.')
  if (!existsSync(input.characterImagePath) || !IMAGE_EXTENSIONS.has(extname(input.characterImagePath).toLowerCase())) throw new Error('Choose a PNG, JPEG, or WebP character reference image.')
  if (input.style === 'normal' && (!Number.isInteger(input.motionId) || input.motionId <= 0)) throw new Error('Normal mode requires a selected motion.')
  if (input.style === 'high_quality' && input.motionId !== 0) throw new Error('High Quality mode uses motion ID 0 in the confirmed contract.')
}

async function reusableUpload(path: string, type: 'audio' | 'image', durationSec?: number): Promise<ProviderAsset> {
  const repos = getRepos()
  const hash = await sha256(path)
  const existing = repos.providerAssetByHash(TALKINGPHOTOS_PROVIDER, TALKINGPHOTOS_CONNECTION_ID, hash)
  if (existing?.remoteMediaId) return existing
  const category = await ensureLibraryCategory(type === 'audio' ? 'audios' : 'Image')
  const media = await uploadLibraryMedia(path, type, category.id)
  const at = now()
  const asset: ProviderAsset = {
    id: existing?.id || `tpa-${type}-${hash.slice(0, 24)}`,
    provider: TALKINGPHOTOS_PROVIDER,
    connectionId: TALKINGPHOTOS_CONNECTION_ID,
    localSha256: hash,
    localPath: path,
    mimeType: type,
    sizeBytes: statSync(path).size,
    durationSec: durationSec ?? media.durationSec,
    remoteCategoryId: category.id,
    remoteMediaId: media.id,
    uploadedAt: at,
    lastVerifiedAt: at
  }
  repos.upsertProviderAsset(asset)
  return asset
}

/** Includes automationItemId so two different automation items with byte-identical
 *  audio/character/settings (a plausible batch scenario) never collide on fingerprint
 *  — each item gets its own dedup key, while retries of the SAME item still collide
 *  (automationItemId is stable across retries). */
function requestFingerprint(input: TalkingPhotosCreateInput, audioHash: string, imageHash: string): string {
  return createHash('sha256').update(JSON.stringify({
    audioHash, imageHash, title: input.title.trim(), prompt: input.characterPrompt.trim(),
    negative: input.characterNegativePrompt || '', style: input.style, aspectRatio: input.aspectRatio,
    motionId: input.motionId, gender: input.characterGender || 'male', age: input.characterAge || 'adult',
    characterStyle: input.characterStyle || 'realistic', beard: input.characterBeard || 'shaven',
    automationItemId: input.automationItemId || ''
  })).digest('hex')
}

function segmentTitle(state: TalkingPhotosCreationState, ordinal: number): string {
  return state.segments.length === 1 ? state.input.title.trim() : `${state.input.title.trim()} · part ${String(ordinal + 1).padStart(2, '0')} of ${String(state.segments.length).padStart(2, '0')}`
}

async function findUncertainSubmission(title: string, type: 'human' | 'video_merge', startedAt: string): Promise<ProviderProjectSummary | undefined> {
  const started = Date.parse(startedAt) - 60_000
  const matches = (await listProjects({ limit: 50 })).filter((project) => project.title === title && project.type === type && Date.parse(project.createdDate) >= started)
  return matches.length === 1 ? matches[0] : undefined
}

async function prepareAssets(root: ProviderJob, state: TalkingPhotosCreationState): Promise<TalkingPhotosCreationState> {
  if (state.sourceAudioMediaId && state.characterDrivingMediaId && state.characterResultUuid) return state
  const audio = await reusableUpload(state.input.audioPath, 'audio', state.sourceDurationSec)
  const image = await reusableUpload(state.input.characterImagePath, 'image')
  if (!audio.remoteMediaId || !image.remoteMediaId) throw new Error('TalkingPhotos media upload did not return reusable media IDs.')
  const resultUuid = state.characterResultUuid || await createCharacterImage({
    prompt: state.input.characterPrompt,
    negativePrompt: state.input.characterNegativePrompt,
    aspectRatio: state.input.aspectRatio,
    gender: state.input.characterGender,
    characterStyle: state.input.characterStyle,
    characterBeard: state.input.characterBeard,
    characterAge: state.input.characterAge,
    imageDrivingMediaId: image.remoteMediaId,
    projectStyle: state.input.style
  })
  const next = { ...state, sourceAudioMediaId: audio.remoteMediaId, characterDrivingMediaId: image.remoteMediaId, characterResultUuid: resultUuid, stage: 'assets_ready' as const }
  saveState(root.id, next, { status: 'running', progress: 12, errorCode: '', errorMessage: '' })
  return next
}

async function prepareSegmentAudio(root: ProviderJob, state: TalkingPhotosCreationState): Promise<TalkingPhotosCreationState> {
  if (!state.sourceAudioMediaId) throw new Error('Uploaded audio checkpoint is missing.')
  const sourceAudioMediaId = state.sourceAudioMediaId
  const segments = [...state.segments]
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].remoteAudioMediaId) continue
    if (segments.length === 1) segments[i] = { ...segments[i], remoteAudioMediaId: sourceAudioMediaId }
    else {
      const trimmed = await trimLibraryMedia({
        mediaId: sourceAudioMediaId,
        startSec: segments[i].startSec,
        endSec: segments[i].endSec,
        title: `${basename(state.input.audioPath, extname(state.input.audioPath))} (${segments[i].startSec.toFixed(2)}-${segments[i].endSec.toFixed(2)} sec)`
      })
      const drift = Math.abs((trimmed.durationSec ?? segments[i].durationSec) - segments[i].durationSec)
      if (drift > 1) throw new Error(`TalkingPhotos trimmed segment ${i + 1} to an unexpected duration.`)
      segments[i] = { ...segments[i], remoteAudioMediaId: trimmed.id }
    }
    state = { ...state, segments }
    saveState(root.id, state, { progress: 12 + Math.round(((i + 1) / segments.length) * 18) })
  }
  return state
}

/** Polling of already-submitted remote jobs must continue regardless of pause (plan
 *  §6: "already-running remote jobs continue syncing") — this only gates NEW
 *  POST /project submissions. */
function isAutomationPaused(automationJobId?: string): boolean {
  if (!automationJobId) return false
  const job = getRepos().automationJob(automationJobId)
  return !job || job.pauseRequested || job.cancelRequested
}

function segmentJobId(rootId: string, segmentIndex: number, segmentCount: number): string {
  return segmentCount === 1 ? rootId : `${rootId}-segment-${String(segmentIndex + 1).padStart(3, '0')}`
}

/** true when at least one of a root's segments has not yet been submitted (no
 *  remote project id) — the same condition both submitSegments/submitScriptSegments
 *  use to decide whether a fetch is needed at all, reused by
 *  advanceProviderOrchestrations to decide whether the shared per-pass budget is
 *  needed before any root is processed. */
function needsSubmissionBudget(repos: ReturnType<typeof getRepos>, rootId: string, segmentCount: number): boolean {
  for (let i = 0; i < segmentCount; i++) {
    if (!repos.providerJob(segmentJobId(rootId, i, segmentCount))?.remoteProjectId) return true
  }
  return false
}

async function submitSegments(root: ProviderJob, state: TalkingPhotosCreationState, sharedBudget?: SubmissionBudget): Promise<TalkingPhotosCreationState> {
  const repos = getRepos()
  if (!state.characterDrivingMediaId || !state.characterResultUuid) throw new Error('Character asset checkpoint is missing.')
  const characterDrivingMediaId = state.characterDrivingMediaId
  const characterResultUuid = state.characterResultUuid
  const segments = [...state.segments]

  // One quota/concurrency fetch per pass — never per segment (plan §6). Skipped
  // entirely when every segment already has a remote project id. A caller that
  // already fetched a budget for this pass (advanceProviderOrchestrations, sharing
  // one SubmissionBudget across every root processed in the same tick) passes it in
  // via sharedBudget instead of triggering a second, independently-fresh fetch here —
  // needsSubmissionBudget is only evaluated when there's no sharedBudget to short-
  // circuit to, so a shared pass never repeats the per-segment scan for nothing.
  const budget = sharedBudget ?? (needsSubmissionBudget(repos, root.id, segments.length) ? await fetchSubmissionBudget() : null)

  for (let i = 0; i < segments.length; i++) {
    const id = segmentJobId(root.id, i, segments.length)
    let job = repos.providerJob(id)
    if (!job) {
      const at = now()
      job = {
        id, provider: TALKINGPHOTOS_PROVIDER, connectionId: TALKINGPHOTOS_CONNECTION_ID, operation: 'video',
        parentProviderJobId: segments.length === 1 ? undefined : root.id,
        automationJobId: state.input.automationJobId, automationItemId: state.input.automationItemId, projectId: state.input.projectId,
        requestFingerprint: `${root.requestFingerprint}:segment:${i}`, status: 'queued', progress: 0,
        segmentOrdinal: i, internalSegment: segments.length > 1, createdAt: at, updatedAt: at
      }
      repos.upsertProviderJob(job)
    }
    if (!job.remoteProjectId) {
      // A submission already in flight (submitting_project) is resolved via
      // findUncertainSubmission regardless of budget/pause — an ambiguous prior
      // attempt must never be abandoned just because the slot now reads full or the
      // automation job was paused after it was sent.
      const resuming = job.errorCode === 'submitting_project'
      if (!resuming && isAutomationPaused(state.input.automationJobId)) {
        repos.updateProviderJob(job.id, { status: 'queued', errorCode: 'awaiting_provider_slot', errorMessage: 'Automation is paused; no new TalkingPhotos submissions until it resumes.' })
        segments[i] = { ...segments[i], providerJobId: job.id }
        state = { ...state, segments }
        continue
      }
      if (!resuming && budget && !budget.take()) {
        const reason = budget.remainingDaily <= 0 ? 'daily' : 'concurrent'
        logBudgetExhausted(reason, job.id)
        repos.updateProviderJob(job.id, { status: 'queued', errorCode: 'awaiting_provider_slot', errorMessage: reason === 'daily' ? 'Waiting for TalkingPhotos daily video quota to free up.' : 'Waiting for a TalkingPhotos concurrent render slot.' })
        segments[i] = { ...segments[i], providerJobId: job.id }
        state = { ...state, segments }
        continue
      }
      const title = segmentTitle(state, i)
      let project: ProviderProjectSummary | undefined
      if (resuming) project = await findUncertainSubmission(title, 'human', job.createdAt)
      if (!project) {
        repos.updateProviderJob(job.id, { status: 'running', errorCode: 'submitting_project', errorMessage: '' })
        project = await createHumanProject(buildTalkingPhotosHumanPayload(state.input, {
          title,
          audioMediaId: segments[i].remoteAudioMediaId as string,
          characterDrivingMediaId,
          characterResultUuid
        }))
      }
      repos.updateProviderJob(job.id, {
        remoteProjectId: project.id, remoteTaskUuid: project.taskUuid, remotePreviousTaskUuid: project.taskPrevUuid,
        status: project.status === 'processing' ? 'running' : 'queued', remoteStep: project.taskStepNumber,
        remoteStepsTotal: project.taskStepsTotal, errorCode: '', errorMessage: ''
      })
      segments[i] = { ...segments[i], providerJobId: job.id, remoteProjectId: project.id }
    } else segments[i] = { ...segments[i], providerJobId: job.id, remoteProjectId: job.remoteProjectId }
    state = { ...state, segments }
    saveState(root.id, state, { status: 'running', progress: 30 + Math.round(((i + 1) / segments.length) * 20) })
  }

  const stillWaiting = segments.some((s) => !s.remoteProjectId)
  if (stillWaiting) {
    // Surface the wait on the root job too — segments are internal and not shown
    // standalone in the UI, but the root always is (plan §6: "show queued-by-
    // provider-limit status in the UI").
    saveState(root.id, state, { status: 'running', errorCode: 'awaiting_provider_slot', errorMessage: 'Waiting for a TalkingPhotos concurrency/daily slot to free up before submitting the remaining segments.' })
    return state // try again next pass
  }
  state = { ...state, segments, stage: 'segments_submitted' }
  saveState(root.id, state, { status: 'running', progress: 50, errorCode: '', errorMessage: '' })
  return state
}

// ============================================================================
// Manual custom-script -> TTS video (Phase 5/6/7). A parallel orchestration to the
// uploaded-audio flow above: same durable-checkpoint / single-flight / quota-gated
// submission pattern, but the audio source is TTS chunks instead of a trimmed upload.
// ============================================================================

function parseScriptState(job: ProviderJob): TalkingPhotosScriptCreationState {
  try {
    const parsed = JSON.parse(job.requestJson || '') as TalkingPhotosScriptCreationState
    if (parsed.version === 1 && parsed.kind === 'script' && parsed.input && Array.isArray(parsed.segments)) return parsed
  } catch { /* handled below */ }
  throw new Error('TalkingPhotos script creation checkpoint is missing or invalid.')
}

/** true only for a provider_jobs row whose requestJson is a script-creation
 *  checkpoint — used to dispatch orchestration without throwing on the (much more
 *  common) uploaded-audio shape. */
function isScriptRoot(job: ProviderJob): boolean {
  try {
    return (JSON.parse(job.requestJson || '{}') as { kind?: string }).kind === 'script'
  } catch {
    return false
  }
}

function saveScriptState(jobId: string, state: TalkingPhotosScriptCreationState, patch: Partial<ProviderJob> = {}): ProviderJob {
  const repos = getRepos()
  repos.updateProviderJob(jobId, { ...patch, requestJson: JSON.stringify(state) })
  const job = repos.providerJob(jobId)
  if (!job) throw new Error('TalkingPhotos provider job disappeared while checkpointing.')
  return job
}

function validateScriptInput(input: TalkingPhotosScriptCreateInput): void {
  if (!input.title.trim()) throw new Error('Enter a title for the TalkingPhotos video.')
  if (!input.script.trim()) throw new Error('Enter a script.')
  if (!input.characterPrompt.trim()) throw new Error('Enter a character prompt.')
  if (!existsSync(input.characterImagePath) || !IMAGE_EXTENSIONS.has(extname(input.characterImagePath).toLowerCase())) throw new Error('Choose a PNG, JPEG, or WebP character reference image.')
  if (input.style === 'normal' && (!Number.isInteger(input.motionId) || input.motionId <= 0)) throw new Error('Normal mode requires a selected motion.')
  if (input.style === 'high_quality' && input.motionId !== 0) throw new Error('High Quality mode uses motion ID 0 in the confirmed contract.')
  if (!input.language.trim() || !input.voice.trim()) throw new Error('Choose a language and voice.')
}

/** Includes automationItemId (see requestFingerprint above) plus every field that
 *  changes what gets produced: script text, character, motion, style, aspect ratio,
 *  subtitle mode, and the full voice/TTS parameter set (plan §11). */
function scriptRequestFingerprint(input: TalkingPhotosScriptCreateInput, imageHash: string): string {
  return createHash('sha256').update(JSON.stringify({
    scriptHash: createHash('sha256').update(input.script.trim()).digest('hex'), imageHash,
    title: input.title.trim(), prompt: input.characterPrompt.trim(), negative: input.characterNegativePrompt || '',
    style: input.style, aspectRatio: input.aspectRatio, motionId: input.motionId,
    gender: input.characterGender || 'male', age: input.characterAge || 'adult',
    characterStyle: input.characterStyle || 'realistic', beard: input.characterBeard || 'shaven',
    language: input.language, voice: input.voice, voiceStyle: input.voiceStyle, speed: input.speed, pitch: input.pitch,
    subtitleMode: input.subtitleMode, automationItemId: input.automationItemId || ''
  })).digest('hex')
}

function scriptSegmentTitle(state: TalkingPhotosScriptCreationState, ordinal: number): string {
  return state.segments.length === 1 ? state.input.title.trim() : `${state.input.title.trim()} · part ${String(ordinal + 1).padStart(2, '0')} of ${String(state.segments.length).padStart(2, '0')}`
}

async function prepareScriptCharacter(root: ProviderJob, state: TalkingPhotosScriptCreationState): Promise<TalkingPhotosScriptCreationState> {
  if (state.characterDrivingMediaId && state.characterResultUuid) return state
  const image = await reusableUpload(state.input.characterImagePath, 'image')
  if (!image.remoteMediaId) throw new Error('TalkingPhotos character image upload did not return a reusable media ID.')
  const resultUuid = state.characterResultUuid || await createCharacterImage({
    prompt: state.input.characterPrompt, negativePrompt: state.input.characterNegativePrompt,
    aspectRatio: state.input.aspectRatio, gender: state.input.characterGender, characterStyle: state.input.characterStyle,
    characterBeard: state.input.characterBeard, characterAge: state.input.characterAge,
    imageDrivingMediaId: image.remoteMediaId, projectStyle: state.input.style
  })
  const next: TalkingPhotosScriptCreationState = { ...state, characterDrivingMediaId: image.remoteMediaId, characterResultUuid: resultUuid, stage: 'assets_ready' }
  saveScriptState(root.id, next, { status: 'running', progress: 10, errorCode: '', errorMessage: '' })
  return next
}

/** Submits (or resumes) TTS for every chunk lacking a resolved media id. A chunk whose
 *  actual duration exceeds the active project's limit is never used — its text is
 *  split (splitOversizedScriptChunk) into replacement chunks and the oversized TTS job
 *  is left exactly as-is for audit, never reused and never deleted (plan §7). */
async function submitTtsChunks(root: ProviderJob, state: TalkingPhotosScriptCreationState): Promise<TalkingPhotosScriptCreationState> {
  const repos = getRepos()
  let segments = [...state.segments]
  let i = 0
  while (i < segments.length) {
    const segment = segments[i]
    if (segment.ttsMediaId) { i++; continue }

    if (isAutomationPaused(state.input.automationJobId)) {
      saveScriptState(root.id, state, { status: 'running', errorCode: 'awaiting_provider_slot', errorMessage: 'Automation is paused; no new TalkingPhotos TTS submissions until it resumes.' })
      return state
    }

    let ttsJob: ProviderJob | undefined = segment.ttsJobId ? repos.providerJob(segment.ttsJobId) : undefined
    if (!ttsJob) {
      ttsJob = await submitTts({
        text: segment.text,
        settings: { language: state.input.language, voice: state.input.voice, voiceStyle: state.input.voiceStyle, speed: state.input.speed, pitch: state.input.pitch, autoTranslate: false },
        projectStyle: state.input.style,
        automationJobId: state.input.automationJobId, automationItemId: state.input.automationItemId, projectId: state.input.projectId
      })
      segments[i] = { ...segment, ttsJobId: ttsJob.id }
      state = { ...state, segments, stage: 'tts_submitted' }
      saveScriptState(root.id, state, { status: 'running' })
    }

    if (ttsJob.status !== 'completed') ttsJob = await resolveTtsJob(ttsJob.id)
    if (ttsJob.status === 'attention') {
      throw new Error(`TalkingPhotos TTS for segment ${segments[i].ordinal + 1} needs attention (job ${ttsJob.id}): ${ttsJob.errorMessage || 'unresolved'}. Recover it manually before retrying.`)
    }
    if (ttsJob.status !== 'completed' || !ttsJob.remoteMediaId) throw new Error(`TalkingPhotos TTS for segment ${segments[i].ordinal + 1} did not complete.`)

    const ttsData = JSON.parse(ttsJob.requestJson || '{}') as Partial<TalkingPhotosTtsState>
    const durationSec = ttsData.durationSec ?? 0

    if (durationSec > state.maxDurationSec) {
      L.warn(`talkingphotos script tts oversized ttsJob=${ttsJob.id} duration=${durationSec}s limit=${state.maxDurationSec}s — re-splitting source text`)
      const [left, right] = splitOversizedScriptChunk(segments[i].text)
      const replacement: TalkingPhotosScriptSegment[] = [left, right].filter((t) => t.trim()).map((text) => ({ ordinal: 0, text }))
      if (!replacement.length || replacement.every((r) => r.text === segments[i].text)) {
        throw new Error(`TalkingPhotos TTS for segment ${segments[i].ordinal + 1} exceeded the duration limit and could not be split further.`)
      }
      segments.splice(i, 1, ...replacement)
      segments = segments.map((s, idx) => ({ ...s, ordinal: idx }))
      state = { ...state, segments }
      // A single-chunk root created as operation='video' can grow past one segment
      // here — promote it to 'merge' so advanceProviderOrchestrations routes it into
      // the merge-handling path instead of only ever expecting a single project id.
      saveScriptState(root.id, state, { status: 'running', operation: segments.length > 1 ? 'merge' : root.operation })
      continue // re-process the newly split (smaller) segment(s) at the same index
    }

    segments[i] = { ...segments[i], ttsMediaId: ttsJob.remoteMediaId, ttsDurationSec: durationSec }
    state = { ...state, segments }
    saveScriptState(root.id, state, { status: 'running', progress: 10 + Math.round(((i + 1) / segments.length) * 30) })
    i++
  }
  state = { ...state, segments, stage: 'tts_resolved' }
  saveScriptState(root.id, state, { status: 'running', progress: 40 })
  return state
}

async function submitScriptSegments(root: ProviderJob, state: TalkingPhotosScriptCreationState, sharedBudget?: SubmissionBudget): Promise<TalkingPhotosScriptCreationState> {
  const repos = getRepos()
  if (!state.characterDrivingMediaId || !state.characterResultUuid) throw new Error('Character asset checkpoint is missing.')
  const characterDrivingMediaId = state.characterDrivingMediaId
  const characterResultUuid = state.characterResultUuid
  const segments = [...state.segments]

  // See submitSegments above for why needsSubmissionBudget is only evaluated when
  // there's no sharedBudget already supplied for this pass.
  const budget = sharedBudget ?? (needsSubmissionBudget(repos, root.id, segments.length) ? await fetchSubmissionBudget() : null)

  for (let i = 0; i < segments.length; i++) {
    const id = segmentJobId(root.id, i, segments.length)
    let job = repos.providerJob(id)
    if (!job) {
      const at = now()
      job = {
        id, provider: TALKINGPHOTOS_PROVIDER, connectionId: TALKINGPHOTOS_CONNECTION_ID, operation: 'video',
        parentProviderJobId: segments.length === 1 ? undefined : root.id,
        automationJobId: state.input.automationJobId, automationItemId: state.input.automationItemId, projectId: state.input.projectId,
        requestFingerprint: `${root.requestFingerprint}:segment:${i}`, status: 'queued', progress: 0,
        segmentOrdinal: i, internalSegment: segments.length > 1, createdAt: at, updatedAt: at
      }
      repos.upsertProviderJob(job)
    }
    if (!job.remoteProjectId) {
      const resuming = job.errorCode === 'submitting_project'
      if (!resuming && isAutomationPaused(state.input.automationJobId)) {
        repos.updateProviderJob(job.id, { status: 'queued', errorCode: 'awaiting_provider_slot', errorMessage: 'Automation is paused; no new TalkingPhotos submissions until it resumes.' })
        segments[i] = { ...segments[i], providerJobId: job.id }
        state = { ...state, segments }
        continue
      }
      if (!resuming && budget && !budget.take()) {
        const reason = budget.remainingDaily <= 0 ? 'daily' : 'concurrent'
        logBudgetExhausted(reason, job.id)
        repos.updateProviderJob(job.id, { status: 'queued', errorCode: 'awaiting_provider_slot', errorMessage: reason === 'daily' ? 'Waiting for TalkingPhotos daily video quota to free up.' : 'Waiting for a TalkingPhotos concurrent render slot.' })
        segments[i] = { ...segments[i], providerJobId: job.id }
        state = { ...state, segments }
        continue
      }
      const title = scriptSegmentTitle(state, i)
      let project: ProviderProjectSummary | undefined
      if (resuming) project = await findUncertainSubmission(title, 'human', job.createdAt)
      if (!project) {
        repos.updateProviderJob(job.id, { status: 'running', errorCode: 'submitting_project', errorMessage: '' })
        const ttsJob = repos.providerJob(segments[i].ttsJobId as string)
        if (!ttsJob) throw new Error(`TalkingPhotos TTS checkpoint for segment ${i + 1} is missing.`)
        const ttsData = JSON.parse(ttsJob.requestJson || '{}') as Partial<TalkingPhotosTtsState>
        if (!ttsData.uuid) throw new Error(`TalkingPhotos TTS checkpoint for segment ${i + 1} is missing its UUID.`)
        project = await createHumanProject(buildTalkingPhotosHumanTtsPayload(state.input, {
          audioMediaId: segments[i].ttsMediaId as string, audioResultUuid: ttsData.uuid, ttsText: segments[i].text,
          characterDrivingMediaId, characterResultUuid, title
        }))
      }
      repos.updateProviderJob(job.id, {
        remoteProjectId: project.id, remoteTaskUuid: project.taskUuid, remotePreviousTaskUuid: project.taskPrevUuid,
        status: project.status === 'processing' ? 'running' : 'queued', remoteStep: project.taskStepNumber,
        remoteStepsTotal: project.taskStepsTotal, errorCode: '', errorMessage: ''
      })
      segments[i] = { ...segments[i], providerJobId: job.id, remoteProjectId: project.id }
    } else segments[i] = { ...segments[i], providerJobId: job.id, remoteProjectId: job.remoteProjectId }
    state = { ...state, segments }
    saveScriptState(root.id, state, { status: 'running', progress: 50 + Math.round(((i + 1) / segments.length) * 20) })
  }

  if (segments.some((s) => !s.remoteProjectId)) {
    saveScriptState(root.id, state, { status: 'running', errorCode: 'awaiting_provider_slot', errorMessage: 'Waiting for a TalkingPhotos concurrency/daily slot to free up before submitting the remaining segments.' })
    return state
  }
  state = { ...state, segments, stage: 'segments_submitted' }
  saveScriptState(root.id, state, { status: 'running', progress: 70, errorCode: '', errorMessage: '' })
  return state
}

async function processScriptRoot(rootId: string, sharedBudget?: SubmissionBudget): Promise<ProviderJob> {
  if (inFlight.has(rootId)) return getRepos().providerJob(rootId) as ProviderJob
  inFlight.add(rootId)
  try {
    const repos = getRepos()
    let root = repos.providerJob(rootId)
    if (!root) throw new Error('TalkingPhotos provider job was not found.')
    let state = parseScriptState(root)
    state = await prepareScriptCharacter(root, state)
    state = await submitTtsChunks(root, state)
    root = repos.providerJob(rootId) as ProviderJob
    state = await submitScriptSegments(root, state, sharedBudget)
    return repos.providerJob(rootId) as ProviderJob
  } catch (error) {
    saveCreationFailure(rootId, error, 'creation_failed')
    throw error
  } finally {
    inFlight.delete(rootId)
  }
}

/** Manual custom-script (or automation transcript-driven) -> TTS -> Human video. */
export async function createScriptVideo(input: TalkingPhotosScriptCreateInput): Promise<ProviderJob> {
  validateScriptInput(input)
  const [limits, imageHash] = await Promise.all([getProjectLimits(input.style), sha256(input.characterImagePath)])
  const chunks = planTalkingPhotosScriptChunks(input.script, limits.maxCharactersTts)
  const fingerprint = scriptRequestFingerprint(input, imageHash)
  const dedupeKey = `${fingerprint}::${input.creationIntentId || ''}`
  const pending = creationByFingerprint.get(dedupeKey)
  if (pending) return pending
  const creation = (async (): Promise<ProviderJob> => {
    const createdAt = now()
    const segments: TalkingPhotosScriptSegment[] = chunks.map((c) => ({ ordinal: c.ordinal, text: c.text }))
    const candidate: ProviderJob = {
      id: `tpj-${randomUUID()}`, provider: TALKINGPHOTOS_PROVIDER, connectionId: TALKINGPHOTOS_CONNECTION_ID,
      operation: segments.length === 1 ? 'video' : 'merge', automationJobId: input.automationJobId,
      automationItemId: input.automationItemId, projectId: input.projectId, requestFingerprint: fingerprint,
      creationIntentId: input.creationIntentId || '',
      status: 'queued', progress: 0, internalSegment: false, createdAt, updatedAt: createdAt,
      requestJson: JSON.stringify({
        version: 1, kind: 'script',
        input: { ...input, title: input.title.trim(), script: input.script.trim(), characterPrompt: input.characterPrompt.trim() },
        maxDurationSec: limits.maxDurationSec, maxChars: limits.maxCharactersTts, segments, stage: 'queued', startedAt: createdAt
      } satisfies TalkingPhotosScriptCreationState)
    }
    const { job: root, created } = getRepos().findOrCreateProviderJob(candidate)
    if (created) L.info(`talkingphotos script creation queued job=${root.id} chunks=${segments.length}`)
    return processScriptRoot(root.id)
  })()
  creationByFingerprint.set(dedupeKey, creation)
  try { return await creation } finally { creationByFingerprint.delete(dedupeKey) }
}

async function processRoot(rootId: string, sharedBudget?: SubmissionBudget): Promise<ProviderJob> {
  if (inFlight.has(rootId)) return getRepos().providerJob(rootId) as ProviderJob
  inFlight.add(rootId)
  try {
    const repos = getRepos()
    let root = repos.providerJob(rootId)
    if (!root) throw new Error('TalkingPhotos provider job was not found.')
    let state = parseState(root)
    state = await prepareAssets(root, state)
    state = await prepareSegmentAudio(root, state)
    root = repos.providerJob(rootId) as ProviderJob
    state = await submitSegments(root, state, sharedBudget)
    return repos.providerJob(rootId) as ProviderJob
  } catch (error) {
    saveCreationFailure(rootId, error, 'creation_failed')
    throw error
  } finally {
    inFlight.delete(rootId)
  }
}

export async function createUploadedAudioVideo(input: TalkingPhotosCreateInput): Promise<ProviderJob> {
  validateInput(input)
  const [durationSec, maxSegmentSec, audioHash, imageHash] = await Promise.all([
    probeDuration(input.audioPath), getDurationLimit(input.style), sha256(input.audioPath), sha256(input.characterImagePath)
  ])
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error('The selected audio has no usable duration.')
  const fingerprint = requestFingerprint(input, audioHash, imageHash)
  // creationIntentId is part of the identity: an existing-job shortcut here must not
  // ignore it, or a caller asking for a deliberate duplicate would just get the old
  // job back. findOrCreateProviderJob below is the definitive, intent-aware check.
  const dedupeKey = `${fingerprint}::${input.creationIntentId || ''}`
  const pending = creationByFingerprint.get(dedupeKey)
  if (pending) return pending
  const creation = (async (): Promise<ProviderJob> => {
    const createdAt = now()
    const segments = planTalkingPhotosSegments(durationSec, maxSegmentSec)
    const candidate: ProviderJob = {
      id: `tpj-${randomUUID()}`, provider: TALKINGPHOTOS_PROVIDER, connectionId: TALKINGPHOTOS_CONNECTION_ID,
      operation: segments.length === 1 ? 'video' : 'merge', automationJobId: input.automationJobId,
      automationItemId: input.automationItemId, projectId: input.projectId, requestFingerprint: fingerprint,
      creationIntentId: input.creationIntentId || '',
      status: 'queued', progress: 0, internalSegment: false, createdAt, updatedAt: createdAt,
      requestJson: JSON.stringify({ version: 1, input: { ...input, title: input.title.trim(), characterPrompt: input.characterPrompt.trim() }, sourceDurationSec: durationSec, maxSegmentSec, segments, stage: 'queued', startedAt: createdAt } satisfies TalkingPhotosCreationState)
    }
    // Atomic lookup-or-insert enforced by the DB unique index — a lost race returns
    // the winner's row instead of raising a raw constraint error (plan §11).
    const { job: root, created } = getRepos().findOrCreateProviderJob(candidate)
    if (created) L.info(`talkingphotos creation queued job=${root.id} segments=${segments.length} duration=${durationSec.toFixed(2)}s limit=${maxSegmentSec}s`)
    return processRoot(root.id)
  })()
  creationByFingerprint.set(dedupeKey, creation)
  try { return await creation } finally { creationByFingerprint.delete(dedupeKey) }
}

/** Structural shape both creation-state types share — everything advanceMergeRoot
 *  needs, regardless of which flow (uploaded-audio or script) produced it. */
interface MergeableState {
  stage: string
  input: { title: string }
  segments: Array<{ ordinal: number; remoteProjectId?: string }>
}

/** Local FFmpeg fallback (plan §10): only attempted once remote merge has already
 *  failed at least once, so remote merge stays primary. Downloads every child's
 *  output first (internal segments are deliberately skipped by the normal
 *  auto-download path), merges them locally, and marks the result distinctly
 *  (`local_merge_fallback`) so the fact remote merge failed stays visible for audit —
 *  there is no separate merge-job row in this design; the root job IS that record. */
async function attemptLocalMergeFallback(snapshot: ProviderJob, children: ProviderJob[], title: string): Promise<void> {
  const repos = getRepos()
  L.info(`talkingphotos: attempting local merge fallback for job=${snapshot.id} (remote merge unavailable)`)
  try {
    const ordered = [...children].sort((a, b) => (a.segmentOrdinal ?? 0) - (b.segmentOrdinal ?? 0))
    const localPaths: string[] = []
    for (const child of ordered) {
      let localPath = child.localOutputPath
      if (!localPath || !existsSync(localPath)) {
        const downloaded = await downloadProviderJobOutput(child.id)
        localPath = downloaded.localOutputPath
      }
      if (!localPath) throw new Error(`Child segment ${child.id} has no downloadable output.`)
      localPaths.push(localPath)
    }
    const dest = join(outputDir(), `${snapshot.id}-local-merge.mp4`)
    await mergeVideoFilesLocally(localPaths, dest)
    repos.updateProviderJob(snapshot.id, {
      status: 'completed', localOutputPath: dest, downloadedAt: new Date().toISOString(),
      errorCode: 'local_merge_fallback', errorMessage: `Remote merge ("${title}") was unavailable; merged locally from ${ordered.length} downloaded segments.`
    })
    L.info(`talkingphotos: local merge fallback succeeded job=${snapshot.id} output=${dest}`)
  } catch (error) {
    L.warn(`talkingphotos: local merge fallback failed job=${snapshot.id}: ${(error as Error).message}`)
    repos.updateProviderJob(snapshot.id, { status: 'attention', errorCode: 'local_merge_failed', errorMessage: (error as Error).message })
  }
}

/** Shared by both orchestrations — they only differ in checkpoint JSON shape, never
 *  in how children are merged. Remote merge is retried once per pass until it
 *  succeeds or a prior attempt already failed, at which point the local fallback
 *  takes over (still preserving the failed attempt's errorCode until it does). */
async function advanceMergeRoot<S extends MergeableState>(snapshot: ProviderJob, state: S, save: (jobId: string, state: S, patch: Partial<ProviderJob>) => ProviderJob): Promise<void> {
  const repos = getRepos()
  if (snapshot.remoteProjectId) return
  const children = repos.providerJobs(TALKINGPHOTOS_CONNECTION_ID)
    .filter((job) => job.parentProviderJobId === snapshot.id)
    .sort((a, b) => (a.segmentOrdinal ?? 0) - (b.segmentOrdinal ?? 0))
  if (children.some((job) => job.status === 'failed' || job.status === 'attention')) {
    repos.updateProviderJob(snapshot.id, { status: 'attention', errorCode: 'segment_failed', errorMessage: 'One or more TalkingPhotos segments need attention before merging.' })
    return
  }
  if (children.length !== state.segments.length || children.some((job) => job.status !== 'completed' || !job.remoteProjectId)) return
  if (inFlight.has(snapshot.id)) return
  inFlight.add(snapshot.id)
  try {
    const remoteAlreadyFailed = snapshot.status === 'attention' && snapshot.errorCode === 'submitting_merge'
    if (remoteAlreadyFailed) {
      await attemptLocalMergeFallback(snapshot, children, state.input.title)
      return
    }
    save(snapshot.id, { ...state, stage: 'merge_submitting' }, { status: 'running', progress: 88, errorCode: 'submitting_merge', errorMessage: '' })
    let merged = snapshot.errorCode === 'submitting_merge' ? await findUncertainSubmission(state.input.title, 'video_merge', snapshot.createdAt) : undefined
    if (!merged) merged = await mergeProjects({ projectIds: children.map((job) => job.remoteProjectId as string), title: state.input.title })
    save(snapshot.id, { ...state, stage: 'merge_submitted' }, {
      remoteProjectId: merged.id, remoteTaskUuid: merged.taskUuid, remotePreviousTaskUuid: merged.taskPrevUuid,
      status: merged.status === 'processing' ? 'running' : 'queued', progress: 90, errorCode: '', errorMessage: ''
    })
  } catch (error) {
    // Keep the submission marker: after a network interruption we cannot know whether
    // the provider accepted the merge. The next pass searches the remote listing
    // before it is allowed to submit again, and the pass after that tries local
    // fallback if it still hasn't resolved.
    saveCreationFailure(snapshot.id, error, 'submitting_merge')
  } finally {
    inFlight.delete(snapshot.id)
  }
}

/** True once a root's segments have all already been submitted — the shared
 *  stage-boundary check used both by rootNeedsBudgetThisPass below (to skip roots
 *  that are past needing a submission slot) and by the dispatch loop in
 *  advanceProviderOrchestrations (to route into advanceMergeRoot instead of
 *  processRoot/processScriptRoot) so the two can never silently drift apart as
 *  stages evolve. */
function isPastSegmentSubmission(stage: string): boolean {
  return stage === 'segments_submitted' || stage === 'merge_submitting' || stage === 'merge_submitted'
}

/** Whether a given root will still need to spend a submission slot if
 *  processRoot/processScriptRoot runs for it this pass — mirrors the dispatch below
 *  (a root already past segment submission, or whose checkpoint can't be parsed,
 *  contributes nothing) without actually invoking the (state-mutating) process
 *  functions just to find out. */
function rootNeedsBudgetThisPass(repos: ReturnType<typeof getRepos>, snapshot: ProviderJob): boolean {
  if (snapshot.operation === 'video') return !snapshot.remoteProjectId
  try {
    if (isScriptRoot(snapshot)) {
      const state = parseScriptState(snapshot)
      if (isPastSegmentSubmission(state.stage)) return false
      return needsSubmissionBudget(repos, snapshot.id, state.segments.length)
    }
    const state = parseState(snapshot)
    if (isPastSegmentSubmission(state.stage)) return false
    return needsSubmissionBudget(repos, snapshot.id, state.segments.length)
  } catch {
    return false
  }
}

/** Advance durable roots after polling and at startup. Internal segment outputs are
 * never downloaded; once every segment completes, their remote ids are merged in
 * segmentOrdinal order and the root becomes the downloadable final job. */
export async function advanceProviderOrchestrations(): Promise<void> {
  const repos = getRepos()
  if (repos.providerConnection(TALKINGPHOTOS_CONNECTION_ID)?.status !== 'connected') return
  const roots = repos.providerJobs(TALKINGPHOTOS_CONNECTION_ID).filter((job) => job.requestJson && !job.parentProviderJobId && !['completed', 'failed', 'cancelled'].includes(job.status))

  // One SubmissionBudget fetched (if anything in this pass needs one) and shared
  // across every root below — closes the same-tick multi-root race where the
  // provider's own concurrentCount/dailyUsage counters may not yet reflect a
  // submission made earlier in this very pass. Still re-fetched fresh on every new
  // call to advanceProviderOrchestrations (no persistent ledger across passes).
  // A fetch failure here must not abort the whole pass the way it would if left
  // uncaught (previously, each root's own fetch failure was isolated to that root
  // via processRoot/processScriptRoot's try/catch) — on failure, fall back to
  // undefined so every root fetches its own budget independently, same as before.
  const needsBudget = roots.some((snapshot) => rootNeedsBudgetThisPass(repos, snapshot))
  let budget: SubmissionBudget | undefined
  if (needsBudget) {
    try {
      budget = await fetchSubmissionBudget()
    } catch (error) {
      L.warn(`talkingphotos: shared per-pass budget fetch failed (${(error as Error).message}); each root will fetch its own budget for this pass`)
    }
  }

  for (const snapshot of roots) {
    const script = isScriptRoot(snapshot)
    if (snapshot.operation === 'video') {
      if (!snapshot.remoteProjectId) await (script ? processScriptRoot(snapshot.id, budget) : processRoot(snapshot.id, budget)).catch(() => undefined)
      continue
    }
    if (script) {
      let state: TalkingPhotosScriptCreationState
      try { state = parseScriptState(snapshot) } catch { continue }
      if (!isPastSegmentSubmission(state.stage)) {
        await processScriptRoot(snapshot.id, budget).catch(() => undefined)
        continue
      }
      await advanceMergeRoot(snapshot, state, saveScriptState)
    } else {
      let state: TalkingPhotosCreationState
      try { state = parseState(snapshot) } catch { continue }
      if (!isPastSegmentSubmission(state.stage)) {
        await processRoot(snapshot.id, budget).catch(() => undefined)
        continue
      }
      await advanceMergeRoot(snapshot, state, saveState)
    }
  }
}
