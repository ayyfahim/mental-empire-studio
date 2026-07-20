import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { getRepos } from '../../db'
import { probeDuration } from '../../services/audio'
import {
  TALKINGPHOTOS_CONNECTION_ID,
  TALKINGPHOTOS_PROVIDER,
  buildTalkingPhotosHumanPayload,
  planTalkingPhotosSegments,
  type ProviderAsset,
  type ProviderJob,
  type ProviderProjectSummary,
  type TalkingPhotosCreateInput,
  type TalkingPhotosCreationState
} from '../../../shared/talkingphotos'
import {
  createCharacterImage,
  createHumanProject,
  ensureLibraryCategory,
  getDurationLimit,
  listProjects,
  mergeProjects,
  ProviderRequestError,
  trimLibraryMedia,
  uploadLibraryMedia
} from './client'
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

function requestFingerprint(input: TalkingPhotosCreateInput, audioHash: string, imageHash: string): string {
  return createHash('sha256').update(JSON.stringify({
    audioHash, imageHash, title: input.title.trim(), prompt: input.characterPrompt.trim(),
    negative: input.characterNegativePrompt || '', style: input.style, aspectRatio: input.aspectRatio,
    motionId: input.motionId, gender: input.characterGender || 'male', age: input.characterAge || 'adult',
    characterStyle: input.characterStyle || 'realistic', beard: input.characterBeard || 'shaven'
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

async function submitSegments(root: ProviderJob, state: TalkingPhotosCreationState): Promise<TalkingPhotosCreationState> {
  const repos = getRepos()
  if (!state.characterDrivingMediaId || !state.characterResultUuid) throw new Error('Character asset checkpoint is missing.')
  const characterDrivingMediaId = state.characterDrivingMediaId
  const characterResultUuid = state.characterResultUuid
  const segments = [...state.segments]
  for (let i = 0; i < segments.length; i++) {
    const id = segments.length === 1 ? root.id : `${root.id}-segment-${String(i + 1).padStart(3, '0')}`
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
      const title = segmentTitle(state, i)
      let project: ProviderProjectSummary | undefined
      if (job.errorCode === 'submitting_project') project = await findUncertainSubmission(title, 'human', job.createdAt)
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
  state = { ...state, segments, stage: 'segments_submitted' }
  saveState(root.id, state, { status: 'running', progress: 50, errorCode: '', errorMessage: '' })
  return state
}

async function processRoot(rootId: string): Promise<ProviderJob> {
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
    state = await submitSegments(root, state)
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
  const repos = getRepos()
  const existing = repos.providerJobByFingerprint(TALKINGPHOTOS_CONNECTION_ID, fingerprint)
  if (existing && existing.status !== 'failed' && existing.status !== 'cancelled') return existing
  const pending = creationByFingerprint.get(fingerprint)
  if (pending) return pending
  const creation = (async (): Promise<ProviderJob> => {
    // Recheck after entering the single-flight section in case a concurrent caller
    // persisted the root while this caller was hashing/probing the same files.
    const raced = repos.providerJobByFingerprint(TALKINGPHOTOS_CONNECTION_ID, fingerprint)
    if (raced && raced.status !== 'failed' && raced.status !== 'cancelled') return raced
    const createdAt = now()
    const segments = planTalkingPhotosSegments(durationSec, maxSegmentSec)
    const root: ProviderJob = {
      id: `tpj-${randomUUID()}`, provider: TALKINGPHOTOS_PROVIDER, connectionId: TALKINGPHOTOS_CONNECTION_ID,
      operation: segments.length === 1 ? 'video' : 'merge', automationJobId: input.automationJobId,
      automationItemId: input.automationItemId, projectId: input.projectId, requestFingerprint: fingerprint,
      status: 'queued', progress: 0, internalSegment: false, createdAt, updatedAt: createdAt,
      requestJson: JSON.stringify({ version: 1, input: { ...input, title: input.title.trim(), characterPrompt: input.characterPrompt.trim() }, sourceDurationSec: durationSec, maxSegmentSec, segments, stage: 'queued', startedAt: createdAt } satisfies TalkingPhotosCreationState)
    }
    repos.upsertProviderJob(root)
    L.info(`talkingphotos creation queued job=${root.id} segments=${segments.length} duration=${durationSec.toFixed(2)}s limit=${maxSegmentSec}s`)
    return processRoot(root.id)
  })()
  creationByFingerprint.set(fingerprint, creation)
  try { return await creation } finally { creationByFingerprint.delete(fingerprint) }
}

/** Advance durable roots after polling and at startup. Internal segment outputs are
 * never downloaded; once every segment completes, their remote ids are merged in
 * segmentOrdinal order and the root becomes the downloadable final job. */
export async function advanceProviderOrchestrations(): Promise<void> {
  const repos = getRepos()
  if (repos.providerConnection(TALKINGPHOTOS_CONNECTION_ID)?.status !== 'connected') return
  const roots = repos.providerJobs(TALKINGPHOTOS_CONNECTION_ID).filter((job) => job.requestJson && !job.parentProviderJobId && !['completed', 'failed', 'cancelled'].includes(job.status))
  for (const snapshot of roots) {
    if (snapshot.operation === 'video') {
      if (!snapshot.remoteProjectId) await processRoot(snapshot.id).catch(() => undefined)
      continue
    }
    let state: TalkingPhotosCreationState
    try { state = parseState(snapshot) } catch { continue }
    if (state.stage !== 'segments_submitted' && state.stage !== 'merge_submitting' && state.stage !== 'merge_submitted') {
      await processRoot(snapshot.id).catch(() => undefined)
      continue
    }
    if (snapshot.remoteProjectId) continue
    const children = repos.providerJobs(TALKINGPHOTOS_CONNECTION_ID)
      .filter((job) => job.parentProviderJobId === snapshot.id)
      .sort((a, b) => (a.segmentOrdinal ?? 0) - (b.segmentOrdinal ?? 0))
    if (children.some((job) => job.status === 'failed' || job.status === 'attention')) {
      repos.updateProviderJob(snapshot.id, { status: 'attention', errorCode: 'segment_failed', errorMessage: 'One or more TalkingPhotos segments need attention before merging.' })
      continue
    }
    if (children.length !== state.segments.length || children.some((job) => job.status !== 'completed' || !job.remoteProjectId)) continue
    if (inFlight.has(snapshot.id)) continue
    inFlight.add(snapshot.id)
    try {
      state = { ...state, stage: 'merge_submitting' }
      saveState(snapshot.id, state, { status: 'running', progress: 88, errorCode: 'submitting_merge', errorMessage: '' })
      let merged = snapshot.errorCode === 'submitting_merge' ? await findUncertainSubmission(state.input.title, 'video_merge', snapshot.createdAt) : undefined
      if (!merged) merged = await mergeProjects({ projectIds: children.map((job) => job.remoteProjectId as string), title: state.input.title })
      state = { ...state, stage: 'merge_submitted' }
      saveState(snapshot.id, state, {
        remoteProjectId: merged.id, remoteTaskUuid: merged.taskUuid, remotePreviousTaskUuid: merged.taskPrevUuid,
        status: merged.status === 'processing' ? 'running' : 'queued', progress: 90, errorCode: '', errorMessage: ''
      })
    } catch (error) {
      // Keep the submission marker: after a network interruption we cannot know
      // whether the provider accepted the merge. The next pass searches the remote
      // listing before it is allowed to submit again.
      saveCreationFailure(snapshot.id, error, 'submitting_merge')
    } finally {
      inFlight.delete(snapshot.id)
    }
  }
}
