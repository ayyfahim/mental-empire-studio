import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TALKINGPHOTOS_CONNECTION_ID } from '../../shared/talkingphotos'
import type { ProviderJob } from '../../shared/talkingphotos'

// Polling coordinator: startup reconciliation, terminal-state stop, and the
// authentication-failure -> reauth_required path. Client/downloader/DB/events are
// faked so this exercises poller.ts's orchestration logic in isolation.

vi.mock('../../electron/ipc/events', () => ({ emit: vi.fn() }))

class FakeProviderRequestError extends Error {
  normalized: { kind: string; message: string }
  constructor(kind: string, message: string) {
    super(message)
    this.normalized = { kind, message }
  }
}

let nextProjectResponses: Record<string, { status: string; taskStepNumber?: number; taskStepsTotal?: number; mediaUrl?: string } | 'AUTH_ERROR'> = {}
vi.mock('../../electron/providers/talkingphotos/client', () => ({
  getProject: vi.fn(async (remoteProjectId: string) => {
    const r = nextProjectResponses[remoteProjectId]
    if (r === 'AUTH_ERROR') throw new FakeProviderRequestError('authentication', 'session expired')
    if (!r) return null
    return { id: remoteProjectId, title: 't', type: 'human', status: r.status, taskStepNumber: r.taskStepNumber, taskStepsTotal: r.taskStepsTotal, createdDate: '', updatedDate: '', mediaUrl: r.mediaUrl }
  }),
  listProjects: vi.fn(async () => []),
  ProviderRequestError: FakeProviderRequestError
}))

const downloadMock = vi.fn(async (jobId: string) => {
  const job = jobs.get(jobId)!
  jobs.set(jobId, { ...job, status: 'completed', localOutputPath: `/out/${jobId}.mp4`, downloadedAt: new Date().toISOString() })
  return jobs.get(jobId)!
})
vi.mock('../../electron/providers/talkingphotos/downloader', () => ({ downloadProviderJobOutput: downloadMock }))

const jobs = new Map<string, ProviderJob>()
const connections = new Map<string, { id: string; status: string; lastError?: string }>()
vi.mock('../../electron/db', () => ({
  getRepos: () => ({
    nonTerminalProviderJobs: () => Array.from(jobs.values()).filter((j) => !['completed', 'failed', 'cancelled'].includes(j.status)),
    providerJobs: () => Array.from(jobs.values()),
    providerJob: (id: string) => jobs.get(id),
    updateProviderJob: (id: string, patch: Partial<ProviderJob>) => {
      const current = jobs.get(id)
      if (current) jobs.set(id, { ...current, ...patch })
    },
    providerConnection: (id: string) => connections.get(id),
    upsertProviderConnection: (row: { id: string; status: string; lastError?: string }) => connections.set(row.id, row)
  })
}))

function makeJob(patch: Partial<ProviderJob>): ProviderJob {
  const now = new Date().toISOString()
  return { id: patch.id!, provider: 'talkingphotos', connectionId: TALKINGPHOTOS_CONNECTION_ID, operation: 'video', status: 'queued', progress: 0, internalSegment: false, createdAt: now, updatedAt: now, ...patch }
}

const { reconcileNonTerminalProviderJobs } = await import('../../electron/providers/talkingphotos/poller')
const { getProject } = await import('../../electron/providers/talkingphotos/client')

beforeEach(() => {
  jobs.clear()
  connections.clear()
  connections.set(TALKINGPHOTOS_CONNECTION_ID, { id: TALKINGPHOTOS_CONNECTION_ID, status: 'connected' })
  nextProjectResponses = {}
  downloadMock.mockClear()
  vi.mocked(getProject).mockClear()
})

describe('TalkingPhotos polling coordinator', () => {
  it('polls every non-terminal job by remote project id and updates its local status', async () => {
    jobs.set('j1', makeJob({ id: 'j1', remoteProjectId: 'p1', status: 'queued' }))
    nextProjectResponses.p1 = { status: 'processing', taskStepNumber: 1, taskStepsTotal: 2 }

    await reconcileNonTerminalProviderJobs()

    expect(jobs.get('j1')?.status).toBe('running')
    expect(jobs.get('j1')?.progress).toBe(50)
  })

  it('stops polling once a job reaches a terminal state and triggers the download when completed without a local file', async () => {
    jobs.set('j1', makeJob({ id: 'j1', remoteProjectId: 'p1', status: 'running' }))
    nextProjectResponses.p1 = { status: 'completed', mediaUrl: 'https://cdn.talkingphotos.ai/out.mp4' }

    await reconcileNonTerminalProviderJobs()
    // status transitions to 'downloading' immediately, and the auto-download fires
    // (async, fire-and-forget) — wait a tick for it to resolve.
    await new Promise((r) => setTimeout(r, 10))

    expect(downloadMock).toHaveBeenCalledWith('j1')
    expect(jobs.get('j1')?.status).toBe('completed')

    // Second reconcile: the job is now terminal, so it must not be polled again.
    await reconcileNonTerminalProviderJobs()
    expect(getProject).toHaveBeenCalledTimes(1)
  })

  it('marks the connection reauth_required and the job attention on an authentication failure, without crashing the reconcile loop', async () => {
    jobs.set('j1', makeJob({ id: 'j1', remoteProjectId: 'p1', status: 'running' }))
    jobs.set('j2', makeJob({ id: 'j2', remoteProjectId: 'p2', status: 'queued' }))
    nextProjectResponses.p1 = 'AUTH_ERROR'
    nextProjectResponses.p2 = { status: 'processing' }

    await reconcileNonTerminalProviderJobs()

    expect(jobs.get('j1')?.status).toBe('attention')
    expect(connections.get(TALKINGPHOTOS_CONNECTION_ID)?.status).toBe('reauth_required')
    // The other job's poll still proceeds independently.
    expect(jobs.get('j2')?.status).toBe('running')
  })

  it('leaves a job with no remoteProjectId alone (nothing to poll yet)', async () => {
    jobs.set('j1', makeJob({ id: 'j1', status: 'queued' }))
    await reconcileNonTerminalProviderJobs()
    expect(getProject).not.toHaveBeenCalled()
    expect(jobs.get('j1')?.status).toBe('queued')
  })

  it('marks completed internal segments complete without downloading them', async () => {
    jobs.set('segment-1', makeJob({ id: 'segment-1', remoteProjectId: 'p-segment', status: 'running', internalSegment: true }))
    nextProjectResponses['p-segment'] = { status: 'completed', mediaUrl: 'https://cdn.talkingphotos.ai/segment.mp4' }
    await reconcileNonTerminalProviderJobs()
    expect(jobs.get('segment-1')?.status).toBe('completed')
    expect(downloadMock).not.toHaveBeenCalled()
  })
})
