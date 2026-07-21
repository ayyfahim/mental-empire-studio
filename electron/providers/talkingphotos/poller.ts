import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { getRepos } from '../../db'
import { getProject, listProjects, ProviderRequestError } from './client'
import { downloadProviderJobOutput } from './downloader'
import { advanceProviderOrchestrations } from './creation'
import { emit } from '../../ipc/events'
import {
  TALKINGPHOTOS_CONNECTION_ID,
  TALKINGPHOTOS_PROVIDER,
  isTerminalProviderJobStatus,
  mapRemoteProjectStatus,
  nextPollDelayMs,
  type ProviderJob,
  type ProviderJobOperation
} from '../../../shared/talkingphotos'
import { L } from '../../services/logger'

// Single main-process polling coordinator (plan §12). Polls known jobs by remote
// project id (never the paginated project list — the HAR's own capture showed that
// polling pattern taking 180 requests over 16 minutes). Backoff/jitter and terminal
// detection are the pure functions in shared/talkingphotos.ts; this module only
// orchestrates DB + the session-bound client around them.

const TICK_MS = 5_000

interface PollState {
  streak: number
  nextPollAt: number
}

const pollState = new Map<string, PollState>()
const downloadsInFlight = new Set<string>()
let timer: ReturnType<typeof setInterval> | null = null
/** Set on an authentication failure so the tick stops hammering an expired session
 *  until reconnect explicitly clears it (reconcileNonTerminalProviderJobs). */
let pausedUntilReconnect = false

function hasVerifiedLocalFile(job: ProviderJob): boolean {
  return !!(job.downloadedAt && job.localOutputPath && existsSync(job.localOutputPath))
}

async function pollJobOnce(job: ProviderJob, state: PollState): Promise<void> {
  const repos = getRepos()
  if (!job.remoteProjectId) {
    pollState.set(job.id, { streak: state.streak, nextPollAt: Date.now() + nextPollDelayMs({ sameStateStreak: state.streak }) })
    return
  }
  try {
    const remote = await getProject(job.remoteProjectId)
    if (!remote) throw new Error('TalkingPhotos returned a malformed project response.')

    // Segment projects are provider-side merge inputs, not user-facing outputs.
    // Treat a completed remote segment as locally complete without downloading it.
    const mappedStatus = mapRemoteProjectStatus(remote.status, job.internalSegment || hasVerifiedLocalFile(job))
    const progress = remote.taskStepsTotal ? Math.round(((remote.taskStepNumber ?? 0) / remote.taskStepsTotal) * 100) : job.progress
    repos.updateProviderJob(job.id, {
      status: mappedStatus,
      remoteStep: remote.taskStepNumber,
      remoteStepsTotal: remote.taskStepsTotal,
      progress,
      remoteMediaUrl: remote.mediaUrl ?? job.remoteMediaUrl,
      remoteTaskUuid: remote.taskUuid,
      remotePreviousTaskUuid: remote.taskPrevUuid,
      lastPolledAt: new Date().toISOString()
    })
    const updated = repos.providerJob(job.id)
    if (updated) emit('talkingphotos:job', updated)

    if (!job.internalSegment && mappedStatus === 'downloading' && !downloadsInFlight.has(job.id)) {
      downloadsInFlight.add(job.id)
      void downloadProviderJobOutput(job.id)
        .catch((e: Error) => L.warn(`talkingphotos auto-download failed job=${job.id}: ${e.message}`))
        .finally(() => {
          downloadsInFlight.delete(job.id)
          const after = repos.providerJob(job.id)
          if (after) emit('talkingphotos:job', after)
        })
    }

    if (isTerminalProviderJobStatus(mappedStatus)) {
      pollState.delete(job.id)
      return
    }
    const streak = mappedStatus === job.status ? state.streak + 1 : 0
    pollState.set(job.id, { streak, nextPollAt: Date.now() + nextPollDelayMs({ sameStateStreak: streak }) })
  } catch (e) {
    if (e instanceof ProviderRequestError && e.normalized.kind === 'authentication') {
      pausedUntilReconnect = true
      const conn = repos.providerConnection(TALKINGPHOTOS_CONNECTION_ID)
      if (conn) repos.upsertProviderConnection({ ...conn, status: 'reauth_required', lastError: e.normalized.message })
      repos.updateProviderJob(job.id, { status: 'attention', errorMessage: e.normalized.message })
      const updated = repos.providerJob(job.id)
      if (updated) emit('talkingphotos:job', updated)
      return
    }
    L.warn(`talkingphotos poll failed job=${job.id}: ${(e as Error).message}`)
    pollState.set(job.id, { streak: state.streak, nextPollAt: Date.now() + nextPollDelayMs({ sameStateStreak: state.streak + 1 }) })
  }
}

async function tick(): Promise<void> {
  if (pausedUntilReconnect) return
  await advanceProviderOrchestrations()
  const jobs = getRepos().nonTerminalProviderJobs()
  const now = Date.now()
  for (const job of jobs) {
    const state = pollState.get(job.id) ?? { streak: 0, nextPollAt: 0 }
    if (now < state.nextPollAt) continue
    await pollJobOnce(job, state)
  }
  await advanceProviderOrchestrations()
}

export function startTalkingPhotosPoller(): void {
  if (timer) return
  timer = setInterval(() => { void tick() }, TICK_MS)
}

export function stopTalkingPhotosPoller(): void {
  if (timer) clearInterval(timer)
  timer = null
  pollState.clear()
}

/** Immediately poll every non-terminal job, in-process (no waiting for the next
 *  tick) — used at app startup and right after a successful reconnect. */
export async function reconcileNonTerminalProviderJobs(): Promise<void> {
  pausedUntilReconnect = false
  await advanceProviderOrchestrations()
  const jobs = getRepos().nonTerminalProviderJobs()
  for (const job of jobs) {
    await pollJobOnce(job, pollState.get(job.id) ?? { streak: 0, nextPollAt: 0 })
  }
  await advanceProviderOrchestrations()
}

function inferOperation(remoteType: string): ProviderJobOperation {
  if (remoteType === 'video_merge') return 'merge'
  if (remoteType === 'subtitles') return 'subtitles'
  return 'video'
}

/** Pull the remote project listing and create a local provider_jobs row for any
 *  project not yet tracked (e.g. one created directly on the TalkingPhotos website).
 *  provider_jobs remains authoritative for remote state — this only seeds it. */
export async function importRemoteProjects(): Promise<number> {
  const repos = getRepos()
  const remoteList = await listProjects({ limit: 50 })
  let imported = 0
  for (const summary of remoteList) {
    if (repos.providerJobByRemoteId(TALKINGPHOTOS_CONNECTION_ID, summary.id)) continue
    const now = new Date().toISOString()
    const job: ProviderJob = {
      id: `tpj-${randomUUID()}`,
      provider: TALKINGPHOTOS_PROVIDER,
      connectionId: TALKINGPHOTOS_CONNECTION_ID,
      operation: inferOperation(summary.type),
      remoteProjectId: summary.id,
      remoteTaskUuid: summary.taskUuid,
      remotePreviousTaskUuid: summary.taskPrevUuid,
      status: mapRemoteProjectStatus(summary.status, false),
      remoteStep: summary.taskStepNumber,
      remoteStepsTotal: summary.taskStepsTotal,
      progress: summary.taskStepsTotal ? Math.round(((summary.taskStepNumber ?? 0) / summary.taskStepsTotal) * 100) : 0,
      remoteMediaUrl: summary.mediaUrl,
      internalSegment: false,
      createdAt: summary.createdDate || now,
      updatedAt: summary.updatedDate || now
    }
    repos.upsertProviderJob(job)
    imported++
  }
  if (imported > 0) L.info(`talkingphotos: imported ${imported} remote project(s) not yet tracked locally`)
  return imported
}

/** Manual "Sync" action: import any untracked remote projects, reconcile every
 *  non-terminal job now, and return the full, fresh local job list. */
export async function syncAllProviderJobsNow(): Promise<ProviderJob[]> {
  await importRemoteProjects()
  await reconcileNonTerminalProviderJobs()
  return getRepos().providerJobs()
}
