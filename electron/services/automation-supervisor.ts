import { app, powerSaveBlocker } from 'electron'
import { existsSync, statfsSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type {
  AutomationErrorKind,
  AutomationJob,
  AutomationJobConfig,
  AutomationJobDetail,
  AutomationJobDraft,
  AutomationJobItem,
  AutomationPreflight,
  AutomationWorkflowStep,
  ScrapedVideo
} from '../../shared/types'
import { asBetaOpts } from '../../shared/types'
import { buildAutomationWorkflow, isAutomationGoalAvailable, workflowProgress } from '../../shared/automation'
import { getRepos } from '../db'
import { getSettings } from '../store/settings'
import { sourceVideos } from '../ipc/scrape'
import { startDownloads } from '../ipc/download'
import { createProject, runTranscribe, sendToRender, setImages } from '../ipc/compose'
import { runJob } from './queue'
import { cancelDownload } from './downloader'
import { cancelRender, markCancelIntent } from './render'
import { emit, hhmm, pushActivity } from '../ipc/events'
import { notifyMessage } from './notify'
import { postWebhook } from './webhook'
import { logger } from './logger'
import { hasConfiguredBrollSource } from './broll'

const LOG = logger.scope('automation-supervisor')
let pumping = false
let stopped = false
let wakeTimer: ReturnType<typeof setTimeout> | null = null

function now(): string { return new Date().toISOString() }
function itemId(jobId: string, videoId: string): string { return `${jobId}-item-${videoId}` }

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

function classifyError(error: unknown, step = ''): { kind: AutomationErrorKind; retryable: boolean; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  const s = message.toLowerCase()
  if (/enospc|disk|space/.test(s)) return { kind: 'storage', retryable: false, message }
  if (/api key|401|403|auth|credential/.test(s)) return { kind: 'authentication', retryable: false, message }
  if (/unsupported|not available yet/.test(s)) return { kind: 'unsupported_input', retryable: false, message }
  if (/missing|not found|enoent|visual media|asset/.test(s)) return { kind: 'missing_asset', retryable: false, message }
  if (/429|rate|timeout|timed out|temporar|econn|network|internet|fetch failed/.test(s)) return { kind: /econn|network|internet|fetch/.test(s) ? 'connection' : 'temporary', retryable: true, message }
  if (step === 'download') return { kind: 'download', retryable: true, message }
  if (step === 'transcribe') return { kind: 'transcription', retryable: true, message }
  if (step === 'render' || step === 'quality-check') return { kind: 'export', retryable: true, message }
  if (step === 'prepare' || step === 'edit') return { kind: 'editing', retryable: false, message }
  return { kind: 'user_action', retryable: false, message }
}

function storageRoot(): string {
  const settings = getSettings()
  return settings.libraryFolder || settings.outputFolder || app.getPath('documents')
}

function normalizeDraft(draft: AutomationJobDraft): AutomationJobDraft {
  const source = getRepos().sourceChannel(typeof draft.config?.sourceId === 'string' ? draft.config.sourceId : '')
  const styles = new Set(['None', 'Cinematic', 'Intense', 'Heartfelt', 'Clean'])
  const ratios = (Array.isArray(draft.config?.aspectRatios) ? draft.config.aspectRatios : []).filter((r): r is '16:9' | '1:1' | '9:16' => r === '16:9' || r === '1:1' || r === '9:16')
  const rawRules = draft.config?.rules
  const config: AutomationJobConfig = {
    sourceId: source?.id ?? '',
    sourceUrl: source?.url ?? '',
    sourceName: source?.name || source?.handle || '',
    sourceOrder: draft.config?.sourceOrder === 'Popular' || draft.config?.sourceOrder === 'Oldest' ? draft.config.sourceOrder : 'Latest',
    sourceCount: Math.max(1, Math.min(50, Number(draft.config?.sourceCount) || 1)),
    selectedVideoIds: Array.isArray(draft.config?.selectedVideoIds) ? [...new Set(draft.config.selectedVideoIds.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id)))].slice(0, 50) : [],
    assetPaths: Array.isArray(draft.config?.assetPaths) ? [...new Set(draft.config.assetPaths.filter((p): p is string => typeof p === 'string' && p.length < 2048))].slice(0, 200) : [],
    style: styles.has(draft.config?.style) ? draft.config.style : 'Clean',
    captionPreset: typeof draft.config?.captionPreset === 'string' ? draft.config.captionPreset.slice(0, 80) : 'Hormozi',
    aspectRatios: ratios.length ? ratios : ['16:9'],
    execution: 'local',
    scheduledFor: typeof draft.config?.scheduledFor === 'string' ? draft.config.scheduledFor : undefined,
    rules: {
      minDurationSec: Math.max(0, Math.min(36_000, Number(rawRules?.minDurationSec) || 0)),
      skipDownloaded: rawRules?.skipDownloaded !== false,
      continueOnError: rawRules?.continueOnError !== false,
      maxRetries: Math.max(0, Math.min(8, Number(rawRules?.maxRetries) || 0)),
      minimumFreeSpaceGb: Math.max(1, Math.min(100, Number(rawRules?.minimumFreeSpaceGb) || 2)),
      captions: rawRules?.captions !== false,
      autoBroll: !!rawRules?.autoBroll,
      removeSilence: false,
      reduceFillerWords: false,
      keepAwake: rawRules?.keepAwake !== false
    },
    notify: {
      desktop: !!draft.config?.notify?.desktop,
      webhook: !!draft.config?.notify?.webhook,
      sound: !!draft.config?.notify?.sound,
      email: !!draft.config?.notify?.email
    }
  }
  return { name: typeof draft.name === 'string' ? draft.name.trim().slice(0, 160) : '', goal: draft.goal, config }
}

export function preflightAutomation(draft: AutomationJobDraft): AutomationPreflight {
  draft = normalizeDraft(draft)
  const blockers: string[] = []
  const warnings: string[] = []
  const repos = getRepos()
  const source = repos.sourceChannel(draft.config.sourceId)
  if (!isAutomationGoalAvailable(draft.goal)) blockers.push('This goal needs media capabilities that are not available in the current version.')
  if (!source || !draft.config.sourceUrl) blockers.push('Choose a saved YouTube source before starting.')
  if (draft.config.sourceCount < 1) blockers.push('Choose at least one source video.')
  if (draft.config.rules.captions && !getSettings().transcription.apiKey.trim()) blockers.push('Add a Groq transcription key in Settings, or turn captions off.')
  if (!draft.config.assetPaths.length && !draft.config.rules.autoBroll) blockers.push('Add at least one image or enable Auto B-roll so the exports have visual media.')
  const missingAssets = draft.config.assetPaths.filter((path) => !existsSync(path))
  if (missingAssets.length) blockers.push(`${missingAssets.length} selected visual asset${missingAssets.length === 1 ? ' is' : 's are'} no longer available.`)
  if (draft.config.rules.autoBroll && !hasConfiguredBrollSource(getSettings())) warnings.push('No stock B-roll provider is configured. A warmed local B-roll pool is required or rendering will pause for attention.')
  if (draft.config.notify.email) warnings.push('Email notifications are not connected yet; desktop and webhook notifications will still work.')
  if (draft.config.notify.sound) warnings.push('Sound alerts use the operating system notification sound in this version.')
  const expectedItems = draft.config.selectedVideoIds.length || draft.config.sourceCount
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
  repos.createAutomationJob(job, buildAutomationWorkflow(id, draft.config))
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
  for (const original of items) {
    if (controlState(job.id) !== 'run') break
    if (original.status === 'failed' || original.status === 'skipped' || original.status === 'cancelled') { processed++; continue }
    try {
      const item = saveItem(original, { status: 'processing', currentStep: step.label, progress: 1, error: undefined })
      await fn(item)
    } catch (error) {
      const control = controlState(job.id)
      if (control !== 'run') {
        saveItem(original, { status: control === 'cancel' ? 'cancelled' : 'waiting', currentStep: step.label, progress: original.progress })
        break
      }
      const failure = classifyError(error, step.key)
      if (step.optional && job.config.rules.continueOnError) {
        const warned = saveItem(original, { status: 'warning', currentStep: step.label, progress: 100, attempts: original.attempts + 1, warning: failure.message, error: undefined })
        log(job.id, `${original.title}: ${step.label} was skipped, and later steps will continue. ${failure.message}`, 'warning', warned)
        processed++
        repos.updateAutomationStep(step.id, { progress: Math.round((processed / Math.max(1, items.length)) * 100) })
        refreshJobProgress(job.id, step.label)
        continue
      }
      const failed = saveItem(original, { status: 'failed', currentStep: step.label, progress: 0, attempts: original.attempts + 1, error: failure.message })
      log(job.id, `${original.title}: ${failure.message}`, 'error', failed)
      if (!job.config.rules.continueOnError) throw error
    }
    processed++
    repos.updateAutomationStep(step.id, { progress: Math.round((processed / Math.max(1, items.length)) * 100) })
    refreshJobProgress(job.id, step.label)
  }
  if (controlState(job.id) !== 'run') return
  if (items.length > 0 && repos.automationItems(job.id).every((i) => i.status === 'failed' || i.status === 'skipped' || i.status === 'cancelled')) {
    throw new Error('No video items remain available to continue this job.')
  }
}

async function runStep(job: AutomationJob, step: AutomationWorkflowStep): Promise<Record<string, unknown>> {
  const repos = getRepos()
  const config = job.config
  if (step.key === 'preflight') {
    const checked = preflightAutomation({ name: job.name, goal: job.goal, config })
    if (!checked.ok) throw new Error(checked.blockers.join(' '))
    log(job.id, `Preflight passed: ~${checked.estimatedStorageGb.toFixed(1)} GB and ~${checked.estimatedMinutes} minutes estimated.`)
    return { checkedAt: now(), estimatedStorageGb: checked.estimatedStorageGb, estimatedMinutes: checked.estimatedMinutes }
  }
  if (step.key === 'discover') {
    const videos = await sourceVideos(config.sourceUrl, config.sourceOrder, config.selectedVideoIds.length ? 50 : config.sourceCount)
    const explicit = new Set(config.selectedVideoIds)
    const selected = videos
      .filter((v) => explicit.size ? explicit.has(v.id) : v.durationSec >= config.rules.minDurationSec)
      .slice(0, explicit.size || config.sourceCount)
    if (!selected.length) throw new Error('No source videos matched the selection rules.')
    for (const video of selected) {
      const existing = repos.automationItems(job.id).find((i) => i.sourceVideoId === video.id)
      if (existing) continue
      repos.upsertAutomationItem({
        id: itemId(job.id, video.id), jobId: job.id, sourceVideoId: video.id, title: video.title,
        status: 'waiting', currentStep: 'Waiting', progress: 0, attempts: 0, updatedAt: now()
      })
    }
    log(job.id, `Selected ${selected.length} video${selected.length === 1 ? '' : 's'} from ${config.sourceName}.`)
    return { selected: selected.map((v) => v.id), count: selected.length }
  }
  if (step.key === 'download') {
    const cachedVideos = repos.getSourceVideos(config.sourceId)
    const byId = new Map<string, ScrapedVideo>(cachedVideos.map((v) => [v.id, v]))
    await eachItem(job, step, async (item) => {
      const existing = repos.download(`dl-${item.sourceVideoId}`)
      if (config.rules.skipDownloaded && existing?.filePath && existsSync(existing.filePath) && existing.durationSec) {
        log(job.id, `Reused completed download for ${item.title}.`, 'info', item)
        return saveItem(item, { status: 'completed', currentStep: step.label, progress: 100 })
      }
      const video = byId.get(item.sourceVideoId)
      if (!video) throw new Error('The selected source video is no longer available.')
      const [download] = await startDownloads([video], { bitrate: 192, sourceUrl: config.sourceUrl })
      if (controlState(job.id) === 'cancel') return saveItem(item, { status: 'cancelled', currentStep: step.label, progress: 0 })
      if (!download?.filePath || download.stage === 'Failed' || !existsSync(download.filePath)) throw new Error(download?.error || 'Download did not produce a usable audio file.')
      return saveItem(item, { status: 'completed', currentStep: step.label, progress: 100 })
    })
    return { downloadedAt: now() }
  }
  if (step.key === 'prepare') {
    await eachItem(job, step, async (item) => {
      const project = createProject(`dl-${item.sourceVideoId}`)
      const beta = asBetaOpts(project.betaOpts)
      repos.updateProject(project.id, {
        captionPreset: config.captionPreset,
        captionAspect: config.aspectRatios[0] ?? '16:9',
        betaOpts: {
          ...beta,
          style: config.style,
          autoHighlight: config.style !== 'None',
          autoZoom: { atStart: config.style !== 'None', atKeyPhrases: config.style === 'Intense' },
          broll: { ...beta.broll, enabled: config.rules.autoBroll }
        }
      })
      if (config.assetPaths.length && repos.getProjectImages(project.id).length === 0) setImages(project.id, config.assetPaths)
      return saveItem(item, { projectId: project.id, status: 'completed', currentStep: step.label, progress: 100 })
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
        return saveItem(item, { renderJobId: renderId, outputPath: render.outputPath, status: 'completed', currentStep: step.label, progress: 100 })
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
      return saveItem(item, { renderJobId: renderId, outputPath: render.outputPath, status: 'completed', currentStep: step.label, progress: 100 })
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
      const failure = classifyError(error, step.key)
      if (failure.retryable && attempts < step.maxAttempts) {
        const delay = Math.min(30_000, 2_000 * (2 ** (attempts - 1)))
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
