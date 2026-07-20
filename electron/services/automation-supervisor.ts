import { app, powerSaveBlocker } from 'electron'
import { existsSync, statfsSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type {
  AutomationJob,
  AutomationJobConfig,
  AutomationJobDetail,
  AutomationJobDraft,
  AutomationJobItem,
  AutomationSelectionDecision,
  AutomationPreflight,
  AutomationWorkflowStep,
  ScrapedVideo,
  Upload
} from '../../shared/types'
import { normalizeAutomationConfig } from '../../shared/automationConfig'
import { classifyAutomationError, retryDelayMs } from '../../shared/automationReliability'
import { automationBrollSeed, effectiveBrollPool } from '../../shared/automationBroll'
import { decideAutomationUpload } from '../../shared/automationSelection'
import { automationStyleProjectPatch } from '../../shared/automationProject'
import { buildAutomationWorkflow, isAutomationGoalAvailable, workflowProgress } from '../../shared/automation'
import { getRepos } from '../db'
import { getSettings } from '../store/settings'
import { refreshChannel, sourceVideos } from '../ipc/scrape'
import { startDownloads } from '../ipc/download'
import { createProject, runTranscribe, sendToRender, setImages } from '../ipc/compose'
import { runJob } from './queue'
import { cancelDownload } from './downloader'
import { cancelRender, markCancelIntent } from './render'
import { emit, hhmm, pushActivity } from '../ipc/events'
import { notifyMessage } from './notify'
import { postWebhook } from './webhook'
import { logger } from './logger'
import { cachedBrollClipCount, hasConfiguredBrollSource, readBrollManifestClipIds } from './broll'
import { probeDuration } from './audio'
import { createScriptVideo, createUploadedAudioVideo } from '../providers/talkingphotos/creation'
import { reconcileNonTerminalProviderJobs } from '../providers/talkingphotos/poller'
import { createProviderSubtitles } from '../providers/talkingphotos/subtitles'
import { applyLocalCaptions } from '../providers/talkingphotos/localCaptions'
import { transcribeAudio } from './transcribe'
import { TALKINGPHOTOS_CONNECTION_ID, reconstructScriptFromWords } from '../../shared/talkingphotos'

const LOG = logger.scope('automation-supervisor')
let pumping = false
let stopped = false
let wakeTimer: ReturnType<typeof setTimeout> | null = null
const smokeFailures = new Set<string>()

function now(): string { return new Date().toISOString() }
function itemId(jobId: string, videoId: string): string { return `${jobId}-item-${videoId}` }
function localMediaId(path: string): string { return `local-${createHash('sha256').update(resolve(path)).digest('hex').slice(0, 20)}` }

const LOCAL_MEDIA_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.mp4', '.mov', '.mkv', '.webm'])
const TALKINGPHOTOS_AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'])

function validYoutubeSource(value: string): boolean {
  const trimmed = value.trim()
  if (/^@[A-Za-z0-9_.-]+$/.test(trimmed)) return true
  try {
    const url = new URL(trimmed)
    return url.protocol === 'https:' && ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

function detail(id: string): AutomationJobDetail | null {
  const repos = getRepos()
  const job = repos.automationJob(id)
  if (!job) return null
  return { ...job, steps: repos.automationSteps(id), items: repos.automationItems(id), logs: repos.automationLogs(id) }
}

function broadcast(id: string): void {
  const job = getRepos().automationJob(id)
  if (job) emit('automation:job', job)
}

function log(jobId: string, message: string, level: 'info' | 'warning' | 'error' = 'info', item?: AutomationJobItem): void {
  getRepos().addAutomationLog(jobId, level, message, item?.id)
  if (level === 'error') LOG.error(`job=${jobId} ${message}`)
  else if (level === 'warning') LOG.warn(`job=${jobId} ${message}`)
  else LOG.info(`job=${jobId} ${message}`)
}

function refreshJobProgress(jobId: string, currentStep?: string): void {
  const repos = getRepos()
  const steps = repos.automationSteps(jobId)
  const items = repos.automationItems(jobId)
  repos.updateAutomationJob(jobId, {
    progress: workflowProgress(steps),
    ...(currentStep !== undefined ? { currentStep } : {}),
    completedCount: items.filter((i) => i.status === 'completed').length,
    failedCount: items.filter((i) => i.status === 'failed').length,
    warningCount: items.filter((i) => i.status === 'warning' || !!i.warning).length,
    totalItems: items.length,
    lastCheckpointAt: now()
  })
  broadcast(jobId)
}

function saveItem(item: AutomationJobItem, patch: Partial<AutomationJobItem>): AutomationJobItem {
  const next = { ...item, ...patch, updatedAt: now() }
  getRepos().upsertAutomationItem(next)
  return next
}

function storageRoot(): string {
  const settings = getSettings()
  let candidate = resolve(settings.libraryFolder || settings.outputFolder || app.getPath('documents'))
  while (!existsSync(candidate)) {
    const parent = dirname(candidate)
    if (parent === candidate) return app.getPath('documents')
    candidate = parent
  }
  return candidate
}

function uploadDataState(config: AutomationJobConfig): AutomationPreflight['uploadDataState'] {
  if (!config.rules.skipUploaded || config.sourceKind !== 'saved-source') return 'not-linked'
  const repos = getRepos()
  const source = repos.sourceChannel(config.sourceId)
  if (!source?.linkedMyChannelId) return 'not-linked'
  const owned = repos.myChannel(source.linkedMyChannelId)
  if (!owned?.lastScrapedAt) return repos.getUploads(source.linkedMyChannelId).length ? 'stale' : 'unavailable'
  const age = Date.now() - Date.parse(owned.lastScrapedAt)
  return Number.isFinite(age) && age <= config.rules.uploadFreshnessMinutes * 60_000 ? 'fresh' : 'stale'
}

function selectionDecision(video: ScrapedVideo, uploads: Upload[], manualUploaded: boolean | null): AutomationSelectionDecision {
  return decideAutomationUpload(video, uploads, manualUploaded, getSettings().detection?.confirmBand ?? [0.6, 0.82])
}

function classifyStepError(error: unknown, step: string): ReturnType<typeof classifyAutomationError> {
  const structured = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const details = structured.details && typeof structured.details === 'object' ? structured.details as Record<string, unknown> : structured
  return classifyAutomationError({
    error,
    step,
    httpStatus: details.httpStatus as number | undefined,
    ytdlpExitCode: details.exitCode as number | undefined,
    stderr: details.stderr as string | undefined,
    stderrCategory: details.stderrCategory as string | undefined,
    retryAfterSec: details.retryAfterSec as number | undefined,
    usedCookies: !!getSettings().autoScrape.cookiesPath
  })
}

function normalizeDraft(draft: AutomationJobDraft): AutomationJobDraft {
  const normalized = normalizeAutomationConfig(draft.config || {} as AutomationJobConfig)
  const source = getRepos().sourceChannel(normalized.sourceId)
  const sourceKind = normalized.sourceKind
  const localMediaPaths = normalized.localMediaPaths
    .filter((p) => p.length < 2048)
    .map((p) => resolve(p))
  const directUrl = normalized.sourceUrl.trim().slice(0, 2048)
  const config: AutomationJobConfig = {
    ...normalized,
    sourceId: sourceKind === 'saved-source' ? source?.id ?? '' : '',
    sourceUrl: sourceKind === 'saved-source' ? source?.url ?? '' : sourceKind === 'youtube-url' ? directUrl : '',
    sourceName: sourceKind === 'saved-source'
      ? source?.name || source?.handle || ''
      : sourceKind === 'youtube-url' ? (normalized.sourceName.trim() ? normalized.sourceName.trim().slice(0, 160) : 'YouTube URL')
        : localMediaPaths.length === 1 ? basename(localMediaPaths[0]) : `${localMediaPaths.length} local files`,
    selectedVideoIds: normalized.selectedVideoIds.filter((id) => /^[A-Za-z0-9_-]{1,160}$/.test(id)),
    localMediaPaths,
    assetPaths: normalized.assetPaths.filter((p) => p.length < 2048)
  }
  return { name: typeof draft.name === 'string' ? draft.name.trim().slice(0, 160) : '', goal: draft.goal, config }
}

export function preflightAutomation(draft: AutomationJobDraft): AutomationPreflight {
  draft = normalizeDraft(draft)
  const blockers: string[] = []
  const warnings: string[] = []
  const repos = getRepos()
  const isTalkingPhotos = draft.goal === 'talkingphotos-video'
  const source = repos.sourceChannel(draft.config.sourceId)
  if (!isAutomationGoalAvailable(draft.goal)) blockers.push('This goal needs media capabilities that are not available in the current version.')
  if (draft.config.sourceKind === 'saved-source' && (!source || !draft.config.sourceUrl)) blockers.push('Choose a saved YouTube source before starting.')
  if (draft.config.sourceKind === 'youtube-url' && !validYoutubeSource(draft.config.sourceUrl)) blockers.push('Enter a valid HTTPS YouTube channel, playlist, or video URL.')
  if (draft.config.sourceKind === 'local-files' && !draft.config.localMediaPaths.length) blockers.push('Choose at least one local audio or video file.')
  const invalidLocalMedia = draft.config.localMediaPaths.filter((path) => !existsSync(path) || !LOCAL_MEDIA_EXTENSIONS.has(extname(path).toLowerCase()))
  if (invalidLocalMedia.length) blockers.push(`${invalidLocalMedia.length} local media file${invalidLocalMedia.length === 1 ? ' is' : 's are'} missing or unsupported.`)
  if (isTalkingPhotos && draft.config.sourceKind === 'local-files' && draft.config.localMediaPaths.some((path) => !TALKINGPHOTOS_AUDIO_EXTENSIONS.has(extname(path).toLowerCase()))) blockers.push('TalkingPhotos local-file automation accepts audio files only.')
  if (draft.config.sourceCount < 1) blockers.push('Choose at least one source video.')
  if (!isTalkingPhotos && draft.config.rules.captions && !getSettings().transcription.apiKey.trim()) blockers.push('Add a Groq transcription key in Settings, or turn captions off.')
  if (!draft.config.assetPaths.length && (isTalkingPhotos || !draft.config.rules.autoBroll)) blockers.push(isTalkingPhotos ? 'Add one character reference image for TalkingPhotos.' : 'Add at least one image or enable Auto B-roll so the exports have visual media.')
  const missingAssets = draft.config.assetPaths.filter((path) => !existsSync(path))
  if (missingAssets.length) blockers.push(`${missingAssets.length} selected visual asset${missingAssets.length === 1 ? ' is' : 's are'} no longer available.`)
  if (!isTalkingPhotos && draft.config.rules.autoBroll) {
    const broll = draft.config.styleConfig
    const cached = cachedBrollClipCount(broll.brollFallbackPolicy === 'all-sources' ? undefined : broll.brollPoolKey)
    if (broll.brollFallbackPolicy === 'selected-only' && (!broll.brollPoolKey || cached === 0)) blockers.push('The selected B-roll pool is empty or unavailable and fallback is set to “Selected pool only”.')
    else if (cached === 0 && !hasConfiguredBrollSource(getSettings())) warnings.push('No usable cached B-roll or live stock provider is available; rendering will require user action or visual assets.')
  }
  if (isTalkingPhotos) {
    const provider = repos.providerConnection(TALKINGPHOTOS_CONNECTION_ID)
    const options = draft.config.talkingPhotos
    if (provider?.status !== 'connected') blockers.push('Connect TalkingPhotos in Talking Video before starting this automation.')
    if (!options?.characterPrompt.trim()) blockers.push('Enter a TalkingPhotos character prompt.')
    if (options?.style === 'normal' && (!Number.isInteger(options.motionId) || options.motionId <= 0)) blockers.push('Normal TalkingPhotos mode requires a motion ID greater than zero.')
    if (options?.style === 'high_quality' && options.motionId !== 0) blockers.push('High Quality TalkingPhotos mode requires motion ID 0.')
    if (options?.mode === 'custom-script' && !options.script.trim()) blockers.push('Enter a TalkingPhotos script.')
    if ((options?.mode === 'custom-script' || options?.mode === 'transcript-tts') && (!options.language.trim() || !options.voice.trim())) blockers.push('Choose a TalkingPhotos language and voice.')
    if (options?.mode === 'transcript-tts' && !getSettings().transcription.apiKey.trim()) blockers.push('Add a Groq transcription key in Settings for transcript-based TalkingPhotos automation.')
    if (options?.subtitleMode === 'local' && !getSettings().transcription.apiKey.trim()) blockers.push('Add a Groq transcription key in Settings to use local captions.')
  }
  if (draft.config.notify.email) warnings.push('Email notifications are not connected yet; desktop and webhook notifications will still work.')
  if (draft.config.notify.sound) warnings.push('Sound alerts use the operating system notification sound in this version.')
  const uploadState = uploadDataState(draft.config)
  if (draft.config.rules.skipUploaded && uploadState === 'stale') warnings.push('Linked upload data is stale and will be refreshed before candidate selection.')
  if (draft.config.rules.skipUploaded && uploadState === 'unavailable') {
    const message = 'Linked upload data is unavailable; uploaded-video skipping cannot be verified.'
    if (draft.config.rules.allowStaleUploadCache) warnings.push(message)
    else blockers.push(message)
  }
  const expectedItems = draft.config.sourceKind === 'local-files'
    ? draft.config.localMediaPaths.length
    : draft.config.selectedVideoIds.length || draft.config.sourceCount
  const estimatedStorageGb = Math.max(0.3, expectedItems * 0.75)
  try {
    const fs = statfsSync(storageRoot())
    const freeGb = (fs.bavail * fs.bsize) / 1_000_000_000
    if (freeGb < estimatedStorageGb + draft.config.rules.minimumFreeSpaceGb) {
      blockers.push(`Not enough free storage. About ${estimatedStorageGb.toFixed(1)} GB is expected plus your ${draft.config.rules.minimumFreeSpaceGb.toFixed(1)} GB safety reserve.`)
    }
  } catch {
    warnings.push('Free storage could not be measured; the worker will check again before processing.')
  }
  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    estimatedStorageGb,
    estimatedMinutes: Math.max(5, Math.round(expectedItems * 18)),
    sourceItems: expectedItems,
    uploadDataState: uploadState,
    powerMessage: 'This job runs locally. The computer must remain powered on; sleep pauses processing and shutdown stops it.',
    appMessage: getSettings().background.tray
      ? 'You may close this window. Mental Empire Studio will continue from the system tray.'
      : 'Keep Mental Empire Studio open. Enable system-tray background mode to close the window while it works.'
  }
}

export function createAutomationJob(draft: AutomationJobDraft): AutomationJobDetail {
  draft = normalizeDraft(draft)
  const repos = getRepos()
  const checked = preflightAutomation(draft)
  if (!checked.ok) throw new Error(checked.blockers.join(' '))
  const id = `auto-${randomUUID()}`
  const createdAt = now()
  const job: AutomationJob = {
    id,
    name: draft.name.trim() || draft.config.sourceName || 'Automation job',
    goal: draft.goal,
    status: 'queued',
    progress: 0,
    currentStep: 'Waiting to start',
    config: draft.config,
    createdAt,
    updatedAt: createdAt,
    pauseRequested: false,
    cancelRequested: false,
    warningCount: checked.warnings.length,
    failedCount: 0,
    completedCount: 0,
    totalItems: 0
  }
  repos.createAutomationJob(job, buildAutomationWorkflow(id, draft.config, draft.goal))
  log(id, `Job saved. ${checked.appMessage}`)
  checked.warnings.forEach((w) => log(id, w, 'warning'))
  pushActivity({ t: hhmm(), icon: '▶', color: '#f5b323', text: `Automation queued: ${job.name}` })
  kickAutomationSupervisor()
  return detail(id) as AutomationJobDetail
}

function controlState(jobId: string): 'run' | 'pause' | 'cancel' {
  const job = getRepos().automationJob(jobId)
  if (!job || job.cancelRequested) return 'cancel'
  if (job.pauseRequested) return 'pause'
  return 'run'
}

function setStep(step: AutomationWorkflowStep, patch: Partial<AutomationWorkflowStep>): void {
  getRepos().updateAutomationStep(step.id, patch)
  refreshJobProgress(step.jobId, patch.status === 'completed' ? step.label : step.label)
}

async function eachItem(
  job: AutomationJob,
  step: AutomationWorkflowStep,
  fn: (item: AutomationJobItem) => Promise<AutomationJobItem>
): Promise<void> {
  const repos = getRepos()
  const items = repos.automationItems(job.id)
  let processed = 0
  let terminalFailure: unknown
  for (const original of items) {
    if (controlState(job.id) !== 'run') break
    const previousState = original.stepStates?.[step.key]
    if (previousState?.status === 'completed' || previousState?.status === 'warning' || original.status === 'skipped' || original.status === 'cancelled') { processed++; continue }
    if (original.status === 'failed' && previousState?.status !== 'failed') { processed++; continue }
    let current = original
    while (controlState(job.id) === 'run') {
      const stepAttempts = (current.stepStates?.[step.key]?.attempts ?? 0) + 1
      try {
        current = saveItem(current, {
          status: 'processing', currentStep: step.label, progress: 1, attempts: stepAttempts, error: undefined, retryAt: undefined,
          stepStates: { ...current.stepStates, [step.key]: { attempts: stepAttempts, status: 'pending' } }
        })
        const result = await fn(current)
        current = saveItem(result, {
          stepStates: { ...result.stepStates, [step.key]: { attempts: stepAttempts, status: 'completed', checkpoint: { completedAt: now() } } }
        })
        break
      } catch (error) {
        const control = controlState(job.id)
        if (control !== 'run') {
          saveItem(current, { status: control === 'cancel' ? 'cancelled' : 'waiting', currentStep: step.label, progress: current.progress })
          break
        }
        const failure = classifyStepError(error, step.key)
        terminalFailure = error
        if (failure.retryable && stepAttempts < step.maxAttempts) {
          const delay = retryDelayMs({ attempt: stepAttempts, baseDelaySec: job.config.rules.retryBaseDelaySec, maxDelaySec: job.config.rules.retryMaxDelaySec, retryAfterSec: failure.retryAfterSec })
          const retryAt = new Date(Date.now() + delay).toISOString()
          current = saveItem(current, { status: 'waiting', currentStep: step.label, progress: 0, attempts: stepAttempts, error: failure.message, retryAt,
            stepStates: { ...current.stepStates, [step.key]: { attempts: stepAttempts, status: 'pending', error: failure.message } } })
          repos.updateAutomationJob(job.id, { nextRetryAt: retryAt, currentStep: `Waiting for retry · ${current.title}` })
          broadcast(job.id)
          log(job.id, `${current.title}: ${step.label} waiting for retry (attempt ${stepAttempts + 1}/${step.maxAttempts}) in ${Math.max(1, Math.round(delay / 1000))} seconds. ${failure.message}`, 'warning', current)
          const deadline = Date.now() + delay
          while (Date.now() < deadline && controlState(job.id) === 'run') {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(1000, deadline - Date.now())))
          }
          repos.updateAutomationJob(job.id, { nextRetryAt: '', currentStep: step.label })
          broadcast(job.id)
          continue
        }
        if (step.optional && job.config.rules.continueOnError) {
          const warned = saveItem(current, { status: 'warning', currentStep: step.label, progress: 100, attempts: stepAttempts, warning: failure.message, error: undefined, retryAt: undefined,
            stepStates: { ...current.stepStates, [step.key]: { attempts: stepAttempts, status: 'warning', error: failure.message } } })
          log(job.id, `${current.title}: ${step.label} was skipped after ${stepAttempts} attempt${stepAttempts === 1 ? '' : 's'}, and later steps will continue. ${failure.message}`, 'warning', warned)
          break
        }
        const failed = saveItem(current, { status: 'failed', currentStep: step.label, progress: 0, attempts: stepAttempts, error: failure.message, retryAt: undefined,
          stepStates: { ...current.stepStates, [step.key]: { attempts: stepAttempts, status: 'failed', error: failure.message } } })
        log(job.id, `${current.title}: ${failure.message}`, 'error', failed)
        if (!job.config.rules.continueOnError) throw error
        repos.updateAutomationJob(job.id, { currentStep: `Continuing after item failure · ${current.title}` })
        broadcast(job.id)
        break
      }
    }
    if (controlState(job.id) !== 'run') break
    processed++
    repos.updateAutomationStep(step.id, { progress: Math.round((processed / Math.max(1, items.length)) * 100) })
    refreshJobProgress(job.id, step.label)
  }
  if (controlState(job.id) !== 'run') return
  if (items.length > 0 && repos.automationItems(job.id).every((i) => i.status === 'failed' || i.status === 'skipped' || i.status === 'cancelled')) {
    throw terminalFailure ?? new Error('No video items remain available to continue this job.')
  }
}

async function runStep(job: AutomationJob, step: AutomationWorkflowStep): Promise<Record<string, unknown>> {
  const repos = getRepos()
  const config = job.config
  const injected = process.env['ME_SMOKE'] === 'automation' ? process.env['ME_AUTOMATION_FAIL_ONCE'] : undefined
  const injectionKey = `${job.id}:${step.key}`
  if (injected === step.key && !smokeFailures.has(injectionKey)) {
    smokeFailures.add(injectionKey)
    throw new Error(`Temporary smoke failure in ${step.label}`)
  }
  if (step.key === 'preflight') {
    const checked = preflightAutomation({ name: job.name, goal: job.goal, config })
    if (!checked.ok) throw new Error(checked.blockers.join(' '))
    log(job.id, `Preflight passed: ~${checked.estimatedStorageGb.toFixed(1)} GB and ~${checked.estimatedMinutes} minutes estimated.`)
    return { checkedAt: now(), estimatedStorageGb: checked.estimatedStorageGb, estimatedMinutes: checked.estimatedMinutes }
  }
  if (step.key === 'discover') {
    if (config.sourceKind === 'local-files') {
      for (const path of config.localMediaPaths) {
        const id = localMediaId(path)
        if (repos.automationItems(job.id).some((item) => item.sourceVideoId === id)) continue
        repos.upsertAutomationItem({
          id: itemId(job.id, id), jobId: job.id, sourceVideoId: id,
          title: basename(path, extname(path)), status: 'waiting', currentStep: 'Waiting', progress: 0, attempts: 0, updatedAt: now()
        })
      }
      log(job.id, `Selected ${config.localMediaPaths.length} local media file${config.localMediaPaths.length === 1 ? '' : 's'}.`)
      return { selected: config.localMediaPaths.map(localMediaId), count: config.localMediaPaths.length, local: true }
    }
    const resolvedSource = repos.sourceChannel(config.sourceId) ?? repos.sourceChannelByUrl(config.sourceUrl)
    let uploadState = uploadDataState(config)
    if (config.rules.skipUploaded && resolvedSource?.linkedMyChannelId && uploadState !== 'fresh') {
      try {
        await refreshChannel(resolvedSource.linkedMyChannelId)
        uploadState = 'fresh'
        log(job.id, 'Linked upload cache refreshed before candidate selection.')
      } catch (error) {
        uploadState = repos.getUploads(resolvedSource.linkedMyChannelId).length ? 'stale' : 'unavailable'
        const message = `Upload refresh failed; ${uploadState === 'stale' ? 'using cached upload data' : 'upload status is unavailable'}. ${error instanceof Error ? error.message : String(error)}`
        if (!config.rules.allowStaleUploadCache) throw new Error(message)
        log(job.id, message, 'warning')
      }
    }
    const uploads = config.rules.skipUploaded && resolvedSource?.linkedMyChannelId ? repos.getUploads(resolvedSource.linkedMyChannelId) : []
    const requested = config.selectedVideoIds.length || config.sourceCount
    const explicit = new Set(config.selectedVideoIds)
    const safetyCap = 200
    const selected: Array<{ video: ScrapedVideo; decision: AutomationSelectionDecision }> = []
    const replacements: Array<{ video: ScrapedVideo; decision: AutomationSelectionDecision }> = []
    const skippedExplicit: Array<{ video: ScrapedVideo; decision: AutomationSelectionDecision }> = []
    const decisions: AutomationSelectionDecision[] = []
    const candidates = new Map<string, ScrapedVideo>()
    const priorCursor = Number(step.checkpoint?.cursorWindow || 0)
    const priorIds = new Set(Array.isArray(step.checkpoint?.inspectedVideoIds) ? step.checkpoint.inspectedVideoIds.filter((id): id is string => typeof id === 'string') : [])
    if (priorIds.size && resolvedSource) {
      for (const video of repos.getSourceVideos(resolvedSource.id)) if (priorIds.has(video.id)) candidates.set(video.id, video)
      if (candidates.size) log(job.id, `Resumed discovery from ${candidates.size} persisted candidate checkpoints.`)
    }
    let window = Math.max(priorCursor || 0, Math.min(safetyCap, Math.max(20, requested * 2)))
    let exhausted = false
    let evaluateCheckpointFirst = candidates.size > 0
    let evaluated = false
    while (!evaluated || candidates.size < safetyCap) {
      const before = candidates.size
      const fetched = !evaluateCheckpointFirst
      const page = fetched ? await sourceVideos(config.sourceUrl, config.sourceOrder, window) : [...candidates.values()]
      evaluateCheckpointFirst = false
      if (fetched) for (const video of page) if (video.id && !candidates.has(video.id)) candidates.set(video.id, video)
      repos.updateAutomationStep(step.id, { checkpoint: { cursorWindow: window, inspectedVideoIds: [...candidates.keys()], uploadDataState: uploadState } })
      const manual = repos.uploadStates([...candidates.keys()])
      selected.length = 0
      replacements.length = 0
      skippedExplicit.length = 0
      decisions.length = 0
      for (const video of candidates.values()) {
        if (explicit.size && !explicit.has(video.id) && !config.rules.fillSkippedSelections) continue
        let decision = selectionDecision(video, uploads, manual.get(video.id)?.manualUploaded ?? null)
        if ((!explicit.size || !explicit.has(video.id)) && video.durationSec < config.rules.minDurationSec) decision = { ...decision, action: 'excluded-duration' }
        decisions.push(decision)
        if (explicit.has(video.id) && decision.action === 'skipped-uploaded') { skippedExplicit.push({ video, decision }); continue }
        if (decision.action === 'excluded-duration' || decision.action === 'skipped-uploaded') continue
        const eligible = { video, decision: decision.action === 'eligible-ambiguous' ? decision : { ...decision, action: 'selected' as const } }
        if (explicit.size && !explicit.has(video.id)) replacements.push(eligible)
        else selected.push(eligible)
        if (!explicit.size && selected.length >= requested) break
      }
      evaluated = true
      const foundAllExplicit = !explicit.size || [...explicit].every((id) => candidates.has(id))
      const eligibleTotal = selected.length + (config.rules.fillSkippedSelections ? replacements.length : 0)
      const target = explicit.size && !config.rules.fillSkippedSelections ? Math.max(0, explicit.size - skippedExplicit.length) : requested
      if (eligibleTotal >= target && foundAllExplicit) break
      if (fetched && (page.length < window || candidates.size === before || window >= safetyCap)) { exhausted = true; break }
      window = Math.min(safetyCap, window * 2)
    }
    const selectedById = new Map(selected.map((row) => [row.video.id, row]))
    const exactSelected = config.selectedVideoIds.map((id) => selectedById.get(id)).filter((row): row is { video: ScrapedVideo; decision: AutomationSelectionDecision } => !!row)
    const orderedSelected = explicit.size
      ? exactSelected.concat(config.rules.fillSkippedSelections ? replacements.slice(0, Math.max(0, requested - exactSelected.length)) : [])
      : selected.slice(0, requested)
    for (const { video, decision } of skippedExplicit) {
      repos.upsertAutomationItem({ id: itemId(job.id, video.id), jobId: job.id, sourceVideoId: video.id, title: video.title,
        status: 'skipped', currentStep: 'Upload check', progress: 100, attempts: 0, selectionDecision: decision, updatedAt: now() })
      log(job.id, `${video.title}: skipped as uploaded (${decision.matchType}, confidence ${decision.score.toFixed(2)}).`, 'warning')
    }
    if (!orderedSelected.length) throw new Error('No eligible source videos matched the selection rules after upload and duration checks.')
    for (const { video, decision } of orderedSelected) {
      const existing = repos.automationItems(job.id).find((i) => i.sourceVideoId === video.id)
      if (existing) continue
      repos.upsertAutomationItem({
        id: itemId(job.id, video.id), jobId: job.id, sourceVideoId: video.id, title: video.title,
        status: 'waiting', currentStep: 'Waiting', progress: 0, attempts: 0, selectionDecision: decision, updatedAt: now()
      })
      if (decision.matchType === 'ambiguous-title') log(job.id, `${video.title}: possible uploaded match kept eligible (${decision.score.toFixed(2)} to “${decision.matchedTitle}”).`, 'warning')
    }
    const skipped = decisions.filter((decision) => decision.action === 'skipped-uploaded').length
    const durationExcluded = decisions.filter((decision) => decision.action === 'excluded-duration').length
    const ambiguous = decisions.filter((decision) => decision.matchType === 'ambiguous-title').length
    const summary = `Requested ${requested}; inspected ${candidates.size}; skipped uploaded ${skipped}; excluded by duration ${durationExcluded}; eligible ${orderedSelected.length}${exhausted ? '; source exhausted' : ''}.`
    log(job.id, summary, orderedSelected.length < requested ? 'warning' : 'info')
    if (orderedSelected.length < requested) {
      const first = repos.automationItems(job.id).find((item) => item.status !== 'skipped')
      if (first) saveItem(first, { warning: `Source exhausted before the requested count. ${summary}` })
    }
    return { selected: orderedSelected.map((row) => row.video.id), count: orderedSelected.length, requested, inspected: candidates.size, skippedUploaded: skipped, excludedDuration: durationExcluded, ambiguous, uploadDataState: uploadState, exhausted, decisions }
  }
  if (step.key === 'download') {
    if (config.sourceKind === 'local-files') {
      const pathById = new Map(config.localMediaPaths.map((path) => [localMediaId(path), path]))
      await eachItem(job, step, async (item) => {
        const path = pathById.get(item.sourceVideoId)
        if (!path || !existsSync(path)) throw new Error(`Local media is missing: ${path || item.title}`)
        const durationSec = await probeDuration(path)
        if (!durationSec || durationSec <= 0) throw new Error(`Local media has no usable audio duration: ${basename(path)}`)
        const downloadId = `dl-${item.sourceVideoId}`
        repos.upsertDownload({
          id: downloadId, sourceId: 'local', title: item.title, channel: 'Local files', size: `${(statSync(path).size / 1_000_000).toFixed(1)} MB`,
          when: 'imported', stage: 'Downloaded only', pct: '100%', action: 'Open', thumb: '', filePath: path, durationSec, error: ''
        })
        log(job.id, `Imported ${basename(path)} (${Math.round(durationSec)} seconds).`, 'info', item)
        return saveItem(item, { status: 'completed', currentStep: step.label, progress: 100 })
      })
      return { importedAt: now(), local: true }
    }
    const resolvedSource = repos.sourceChannel(config.sourceId) ?? repos.sourceChannelByUrl(config.sourceUrl)
    const cachedVideos = resolvedSource ? repos.getSourceVideos(resolvedSource.id) : []
    const byId = new Map<string, ScrapedVideo>(cachedVideos.map((v) => [v.id, v]))
    await eachItem(job, step, async (item) => {
      const existing = repos.download(`dl-${item.sourceVideoId}`)
      if (config.rules.skipDownloaded && existing?.filePath && existsSync(existing.filePath) && existing.durationSec) {
        log(job.id, `Reused completed download for ${item.title}.`, 'info', item)
        return saveItem(item, { status: 'completed', currentStep: step.label, progress: 100 })
      }
      const video = byId.get(item.sourceVideoId)
      if (!video) throw new Error('The selected source video is no longer available.')
      const [download] = await startDownloads([video], { bitrate: 192, sourceUrl: config.sourceUrl, delaySec: config.rules.downloadDelaySec, supervised: true })
      if (controlState(job.id) === 'cancel') return saveItem(item, { status: 'cancelled', currentStep: step.label, progress: 0 })
      if (!download?.filePath || download.stage === 'Failed' || !existsSync(download.filePath) || !download.durationSec || download.durationSec <= 0) {
        throw new Error(download?.error || 'Download did not produce a valid, non-empty audio stream.')
      }
      log(job.id, `Downloaded ${item.title} (${Math.round(download.durationSec)} seconds); this was a real network request.`, 'info', item)
      return saveItem(item, { status: 'completed', currentStep: step.label, progress: 100 })
    })
    return { downloadedAt: now() }
  }
  if (step.key === 'talkingphotos') {
    const options = config.talkingPhotos
    const characterImagePath = config.assetPaths[0]
    if (!options || !characterImagePath) throw new Error('TalkingPhotos character settings are missing.')
    if (options.mode === 'custom-script' && !options.script.trim()) throw new Error('Enter a TalkingPhotos script.')
    await eachItem(job, step, async (item) => {
      let providerJob = repos.providerJobs(TALKINGPHOTOS_CONNECTION_ID).find((candidate) => candidate.automationJobId === job.id && candidate.automationItemId === item.id && !candidate.parentProviderJobId)
      if (!providerJob) {
        if (options.mode === 'uploaded-audio') {
          const download = repos.download(`dl-${item.sourceVideoId}`)
          if (!download?.filePath || !existsSync(download.filePath)) throw new Error('Downloaded audio checkpoint is missing.')
          providerJob = await createUploadedAudioVideo({
            title: item.title, audioPath: download.filePath, characterImagePath,
            characterPrompt: options.characterPrompt, characterNegativePrompt: options.characterNegativePrompt,
            style: options.style, aspectRatio: options.aspectRatio, motionId: options.style === 'high_quality' ? 0 : options.motionId,
            automationJobId: job.id, automationItemId: item.id
          })
        } else {
          let script = options.script
          if (options.mode === 'transcript-tts') {
            const download = repos.download(`dl-${item.sourceVideoId}`)
            if (!download?.filePath || !existsSync(download.filePath)) throw new Error('Downloaded audio checkpoint is missing.')
            const words = await transcribeAudio(download.filePath, getSettings())
            script = reconstructScriptFromWords(words)
            if (!script.trim()) throw new Error('Transcription produced no usable words to build a script from.')
          }
          providerJob = await createScriptVideo({
            title: item.title, script, characterImagePath,
            characterPrompt: options.characterPrompt, characterNegativePrompt: options.characterNegativePrompt,
            style: options.style, aspectRatio: options.aspectRatio, motionId: options.style === 'high_quality' ? 0 : options.motionId,
            language: options.language, voice: options.voice, voiceStyle: options.voiceStyle, speed: options.speed, pitch: options.pitch,
            subtitleMode: options.subtitleMode, automationJobId: job.id, automationItemId: item.id
          })
        }
        log(job.id, `${item.title}: TalkingPhotos job ${providerJob.id} submitted.`, 'info', item)
      }
      while (controlState(job.id) === 'run') {
        await reconcileNonTerminalProviderJobs()
        providerJob = repos.providerJob(providerJob.id) ?? providerJob
        const progress = Math.max(1, providerJob.progress)
        item = saveItem(item, { status: 'processing', currentStep: step.label, progress })
        if (providerJob.status === 'completed' && providerJob.localOutputPath && existsSync(providerJob.localOutputPath)) {
          // Provider subtitles run asynchronously (their own provider job continues
          // in the background); local captions complete synchronously here so the
          // item's outputPath can point at the captioned derivative immediately.
          if (options.subtitleMode === 'provider') {
            await createProviderSubtitles(providerJob.id, { language: options.language }).catch((e: Error) => log(job.id, `${item.title}: provider subtitles request failed: ${e.message}`, 'warning', item))
          } else if (options.subtitleMode === 'local') {
            await applyLocalCaptions(providerJob.id, { aspect: options.aspectRatio }).catch((e: Error) => log(job.id, `${item.title}: local captions failed: ${e.message}`, 'warning', item))
          }
          return saveItem(item, { outputPath: providerJob.localOutputPath, status: 'completed', currentStep: step.label, progress: 100 })
        }
        if (providerJob.status === 'failed' || providerJob.status === 'attention' || providerJob.status === 'cancelled') {
          throw new Error(providerJob.errorMessage || `TalkingPhotos job ${providerJob.status}.`)
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))
      }
      throw new Error('TalkingPhotos wait interrupted by automation control state.')
    })
    return { providerCompletedAt: now() }
  }
  if (step.key === 'prepare') {
    await eachItem(job, step, async (item) => {
      const style = config.styleConfig
      const brollSeed = item.brollSeed ?? automationBrollSeed(job.id, item.sourceVideoId)
      if (item.brollSeed === undefined) item = saveItem(item, { brollSeed })
      const project = createProject(`dl-${item.sourceVideoId}`)
      repos.updateProject(project.id, {
        ...automationStyleProjectPatch(style, config.rules.autoBroll, project.betaOpts, brollSeed)
      })
      if (config.rules.autoBroll) {
        const effective = effectiveBrollPool({ automationConfig: config, sourceNichePoolKey: repos.nicheKeyForDownload(project.downloadId) })
        log(job.id, `${item.title}: B-roll pool ${effective.poolKey || 'all saved/global pools'} · fallback ${effective.fallbackPolicy} · seed ${brollSeed} · ${style.brollShufflePolicy}.`, 'info', item)
      }
      if (config.assetPaths.length && repos.getProjectImages(project.id).length === 0) setImages(project.id, config.assetPaths)
      return saveItem(item, { projectId: project.id, brollSeed, status: 'completed', currentStep: step.label, progress: 100 })
    })
    return { projectsReadyAt: now() }
  }
  if (step.key === 'transcribe') {
    await eachItem(job, step, async (item) => {
      if (!item.projectId) throw new Error('Project checkpoint is missing; resume from Build projects.')
      if (repos.getTranscript(item.projectId).length === 0) await runTranscribe(item.projectId)
      return saveItem(item, { status: 'completed', currentStep: step.label, progress: 100 })
    })
    return { transcribedAt: now() }
  }
  if (step.key === 'edit') {
    await eachItem(job, step, async (item) => saveItem(item, { status: 'completed', currentStep: step.label, progress: 100 }))
    return { style: config.style, editedAt: now() }
  }
  if (step.key === 'render') {
    await eachItem(job, step, async (item) => {
      if (!item.projectId) throw new Error('Project checkpoint is missing; resume from Build projects.')
      const renderId = `job-${item.projectId}`
      let render = repos.renderJob(renderId)
      if (render?.status === 'done' && render.outputPath && existsSync(render.outputPath)) {
        return saveItem(item, { renderJobId: renderId, outputPath: render.outputPath, brollClipIds: readBrollManifestClipIds(renderId), status: 'completed', currentStep: step.label, progress: 100 })
      }
      if (!render || render.status === 'error') {
        sendToRender(item.projectId)
        render = repos.renderJob(renderId)
      }
      if (!render) throw new Error('The render job could not be created.')
      const poll = setInterval(() => {
        const live = repos.renderJob(renderId)
        if (!live || live.status !== 'rendering') return
        saveItem(item, { renderJobId: renderId, status: 'processing', currentStep: step.label, progress: live.pct })
        const currentItems = repos.automationItems(job.id)
        const finished = currentItems.filter((candidate) => !!candidate.outputPath && existsSync(candidate.outputPath)).length
        repos.updateAutomationStep(step.id, { progress: Math.round(((finished + live.pct / 100) / Math.max(1, currentItems.length)) * 100) })
        refreshJobProgress(job.id, `${step.label} · ${item.title} · ${live.pct}%`)
      }, 800)
      poll.unref?.()
      try { await runJob(render) } finally { clearInterval(poll) }
      if (controlState(job.id) === 'cancel') return saveItem(item, { renderJobId: renderId, status: 'cancelled', currentStep: step.label, progress: 0 })
      render = repos.renderJob(renderId)
      if (render?.status !== 'done' || !render.outputPath || !existsSync(render.outputPath)) throw new Error(render?.error || 'Render did not produce an output file.')
      const brollClipIds = readBrollManifestClipIds(renderId)
      if (brollClipIds.length) log(job.id, `${item.title}: rendered with ${brollClipIds.length} B-roll clips in deterministic order.`, 'info', item)
      return saveItem(item, { renderJobId: renderId, outputPath: render.outputPath, brollClipIds, status: 'completed', currentStep: step.label, progress: 100 })
    })
    return { renderedAt: now() }
  }
  if (step.key === 'quality-check') {
    await eachItem(job, step, async (item) => {
      if (!item.outputPath || !existsSync(item.outputPath)) throw new Error('Export file is missing.')
      if (statSync(item.outputPath).size < 1024) throw new Error('Export file is empty or incomplete.')
      return saveItem(item, { status: 'completed', currentStep: step.label, progress: 100 })
    })
    return { checkedAt: now() }
  }
  if (step.key === 'complete') {
    const items = repos.automationItems(job.id)
    const outputs = items.map((i) => i.outputPath).filter((p): p is string => !!p && existsSync(p))
    if (!outputs.length) throw new Error('No verified output files were produced.')
    return { outputPaths: outputs, completedItems: outputs.length }
  }
  throw new Error(`Unsupported workflow step: ${step.key}`)
}

async function processJob(jobId: string): Promise<void> {
  const repos = getRepos()
  let job = repos.automationJob(jobId)
  if (!job) return
  repos.updateAutomationJob(jobId, { status: 'running', startedAt: job.startedAt ?? now(), error: '', errorKind: undefined, pauseRequested: false })
  log(jobId, job.startedAt ? 'Resumed from the latest checkpoint.' : 'Local background worker started the job.')
  broadcast(jobId)

  for (const snapshot of repos.automationSteps(jobId)) {
    job = repos.automationJob(jobId)
    if (!job) return
    const control = controlState(jobId)
    if (control === 'cancel') {
      repos.updateAutomationJob(jobId, { status: 'cancelled', completedAt: now(), currentStep: 'Cancelled' })
      log(jobId, 'Job cancelled. Completed checkpoints were kept.', 'warning')
      broadcast(jobId)
      return
    }
    if (control === 'pause') {
      repos.updateAutomationJob(jobId, { status: 'paused', currentStep: `Paused before ${snapshot.label}` })
      log(jobId, `Paused safely before ${snapshot.label}.`)
      broadcast(jobId)
      return
    }
    const step = repos.automationSteps(jobId).find((s) => s.id === snapshot.id) ?? snapshot
    if (step.status === 'completed' || step.status === 'skipped' || step.status === 'warning') continue
    const attempts = step.attempts + 1
    setStep(step, { status: 'running', progress: Math.max(1, step.progress), attempts, startedAt: step.startedAt ?? now(), error: '' })
    repos.updateAutomationJob(jobId, { status: 'running', currentStep: step.label, nextRetryAt: '' })
    log(jobId, `${step.label} started${attempts > 1 ? ` (attempt ${attempts}/${step.maxAttempts})` : ''}.`)
    try {
      const checkpoint = await runStep(job, step)
      const afterStepControl = controlState(jobId)
      if (afterStepControl !== 'run') {
        repos.updateAutomationStep(step.id, { status: 'pending', error: '' })
        if (afterStepControl === 'pause') {
          repos.updateAutomationJob(jobId, { status: 'paused', currentStep: `Paused during ${step.label}` })
          log(jobId, `${step.label} paused at a safe item checkpoint.`)
        } else {
          repos.updateAutomationJob(jobId, { status: 'cancelled', completedAt: now(), currentStep: 'Cancelled' })
          log(jobId, 'Job cancelled. Completed checkpoints were kept.', 'warning')
        }
        broadcast(jobId)
        return
      }
      const hasStepWarning = repos.automationItems(jobId).some((item) => item.status === 'warning' && item.currentStep === step.label)
      repos.updateAutomationStep(step.id, { status: hasStepWarning ? 'warning' : 'completed', progress: 100, completedAt: now(), checkpoint, error: '' })
      refreshJobProgress(jobId, step.label)
      log(jobId, `${step.label} completed and checkpointed.`)
    } catch (error) {
      const failure = classifyStepError(error, step.key)
      const stepLevelFailure = step.key === 'preflight' || step.key === 'discover'
      if (stepLevelFailure && failure.retryable && attempts < step.maxAttempts) {
        const delay = retryDelayMs({ attempt: attempts, baseDelaySec: job.config.rules.retryBaseDelaySec, maxDelaySec: job.config.rules.retryMaxDelaySec, retryAfterSec: failure.retryAfterSec })
        const nextRetryAt = new Date(Date.now() + delay).toISOString()
        repos.updateAutomationStep(step.id, { status: 'pending', error: failure.message })
        repos.updateAutomationJob(jobId, { status: 'queued', errorKind: failure.kind, error: `Retrying ${step.label}: ${failure.message}`, nextRetryAt })
        log(jobId, `${step.label} will retry automatically in ${Math.round(delay / 1000)} seconds: ${failure.message}`, 'warning')
        scheduleWake(delay)
      } else {
        repos.updateAutomationStep(step.id, { status: 'failed', error: failure.message })
        repos.updateAutomationJob(jobId, { status: failure.retryable ? 'failed' : 'attention', errorKind: failure.kind, error: failure.message, currentStep: step.label })
        log(jobId, `${step.label} paused the job: ${failure.message}. Resume after fixing the issue.`, 'error')
        if (job.config.notify.desktop) notifyMessage('Automation needs attention', `${job.name}: ${failure.message}`)
      }
      broadcast(jobId)
      return
    }
  }

  const finalJob = repos.automationJob(jobId)
  const items = repos.automationItems(jobId)
  const outputPaths = items.map((i) => i.outputPath).filter((p): p is string => !!p && existsSync(p))
  const failed = items.filter((i) => i.status === 'failed').length
  const warnings = items.filter((i) => !!i.warning || i.status === 'warning').length
  const status = failed || warnings ? 'completed_with_warnings' : 'completed'
  const summary = `${outputPaths.length} completed, ${warnings} warnings, ${failed} failed.`
  repos.updateAutomationJob(jobId, {
    status,
    progress: 100,
    currentStep: 'Complete',
    completedAt: now(),
    completedCount: outputPaths.length,
    failedCount: failed,
    warningCount: warnings,
    result: { outputPaths, summary },
    error: ''
  })
  log(jobId, `Job finished: ${summary}`)
  pushActivity({ t: hhmm(), icon: failed ? '!' : '✓', color: failed ? '#f5b323' : '#36c98e', text: `Automation finished: ${finalJob?.name ?? job.name} — ${summary}` })
  if (job.config.notify.desktop) notifyMessage('Automation complete', `${finalJob?.name ?? job.name}: ${summary}`)
  if (job.config.notify.webhook) await postWebhook('automation_complete', { jobId, name: finalJob?.name ?? job.name, status, outputPaths, failed, warnings })
  broadcast(jobId)
}

function scheduleWake(delay = 100): void {
  if (stopped) return
  if (wakeTimer) clearTimeout(wakeTimer)
  wakeTimer = setTimeout(() => { wakeTimer = null; void pump() }, Math.max(0, delay))
}

async function pump(): Promise<void> {
  if (pumping || stopped) return
  pumping = true
  try {
    while (!stopped) {
      const current = Date.now()
      const next = getRepos().automationJobs().find((j) => {
        if (j.status !== 'queued' || j.pauseRequested || j.cancelRequested) return false
        const runAt = j.config.scheduledFor ? Date.parse(j.config.scheduledFor) : 0
        const retryAt = j.nextRetryAt ? Date.parse(j.nextRetryAt) : 0
        return (!runAt || runAt <= current) && (!retryAt || retryAt <= current)
      })
      if (!next) {
        const future = getRepos().automationJobs()
          .filter((j) => j.status === 'queued' && !j.pauseRequested && !j.cancelRequested)
          .map((j) => Math.max(j.config.scheduledFor ? Date.parse(j.config.scheduledFor) || 0 : 0, j.nextRetryAt ? Date.parse(j.nextRetryAt) || 0 : 0))
          .filter((time) => time > current)
          .sort((a, b) => a - b)[0]
        if (future) scheduleWake(Math.min(2_147_000_000, future - current))
        break
      }
      let blockerId: number | undefined
      try {
        if (next.config.rules.keepAwake) blockerId = powerSaveBlocker.start('prevent-app-suspension')
        await processJob(next.id)
      } finally {
        if (blockerId !== undefined && powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId)
      }
    }
  } finally {
    pumping = false
  }
}

export function kickAutomationSupervisor(): void { scheduleWake(25) }

export function startAutomationSupervisor(): void {
  stopped = false
  const repos = getRepos()
  for (const job of repos.automationJobs()) {
    if (job.status === 'running' || job.status === 'pausing') {
      repos.updateAutomationJob(job.id, { status: 'queued', currentStep: 'Recovering after application interruption', errorKind: 'interruption', error: 'The app stopped during processing; completed checkpoints will be reused.' })
      log(job.id, 'Recovered an interrupted job. Completed checkpoints will be validated and reused.', 'warning')
    }
  }
  kickAutomationSupervisor()
}

export function stopAutomationSupervisor(): void {
  stopped = true
  if (wakeTimer) clearTimeout(wakeTimer)
  wakeTimer = null
}

export function listAutomationJobs(): AutomationJob[] { return getRepos().automationJobs() }
export function getAutomationJob(id: string): AutomationJobDetail | null { return detail(id) }

export function pauseAutomationJob(id: string): void {
  const repos = getRepos()
  const job = repos.automationJob(id)
  if (!job || ['completed','completed_with_warnings','cancelled'].includes(job.status)) return
  repos.updateAutomationJob(id, { pauseRequested: true, status: job.status === 'running' ? 'pausing' : 'paused', currentStep: job.status === 'running' ? `Finishing ${job.currentStep} before pausing` : 'Paused' })
  log(id, job.status === 'running' ? 'Pause requested; the current safe unit will finish first.' : 'Job paused.')
  broadcast(id)
}

export function resumeAutomationJob(id: string): void {
  const repos = getRepos()
  const job = repos.automationJob(id)
  if (!job || ['completed','completed_with_warnings','cancelled'].includes(job.status)) return
  for (const step of repos.automationSteps(id)) if (step.status === 'failed' || step.status === 'paused') repos.updateAutomationStep(step.id, { status: 'pending', error: '' })
  repos.updateAutomationJob(id, { pauseRequested: false, cancelRequested: false, status: 'queued', error: '', currentStep: 'Queued to resume', nextRetryAt: '' })
  log(id, 'Resume requested. The worker will continue from the latest completed checkpoint.')
  broadcast(id)
  kickAutomationSupervisor()
}

export function cancelAutomationJob(id: string): void {
  const repos = getRepos()
  const job = repos.automationJob(id)
  if (!job || ['completed','completed_with_warnings','cancelled'].includes(job.status)) return
  repos.updateAutomationJob(id, { cancelRequested: true, status: job.status === 'running' || job.status === 'pausing' ? job.status : 'cancelled', currentStep: 'Cancellation requested' })
  for (const item of repos.automationItems(id)) {
    cancelDownload(`dl-${item.sourceVideoId}`)
    if (item.renderJobId && !cancelRender(item.renderJobId, 'cancel')) markCancelIntent(item.renderJobId, 'cancel')
  }
  if (job.status !== 'running' && job.status !== 'pausing') repos.updateAutomationJob(id, { completedAt: now() })
  log(id, 'Cancellation requested. Completed checkpoints and output files are kept.', 'warning')
  broadcast(id)
}

export function retryAutomationJob(id: string): void {
  const repos = getRepos()
  const job = repos.automationJob(id)
  if (!job) return
  const steps = repos.automationSteps(id)
  const failedItems = repos.automationItems(id).filter((item) => item.status === 'failed')
  const restartOrd = failedItems.reduce((min, item) => {
    const step = steps.find((candidate) => candidate.label === item.currentStep)
    return step ? Math.min(min, step.ord) : min
  }, Number.POSITIVE_INFINITY)
  for (const step of steps) {
    if (step.status === 'failed' || (Number.isFinite(restartOrd) && step.ord >= restartOrd)) {
      repos.updateAutomationStep(step.id, { status: 'pending', progress: 0, error: '' })
    }
  }
  for (const item of failedItems) {
    repos.upsertAutomationItem({ ...item, status: 'waiting', progress: 0, error: undefined, updatedAt: now() })
  }
  repos.updateAutomationJob(id, { status: 'queued', pauseRequested: false, cancelRequested: false, error: '', currentStep: 'Retry queued', nextRetryAt: '' })
  log(id, 'Failed work was queued for retry; successful checkpoints will not be repeated.')
  broadcast(id)
  kickAutomationSupervisor()
}
