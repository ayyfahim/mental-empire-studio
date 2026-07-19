import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AUTOMATION_GOALS, buildAutomationWorkflow, isAutomationGoalAvailable, workflowProgress } from '../../shared/automation'
import type { AutomationJob, AutomationJobConfig, AutomationJobItem } from '../../shared/types'
import { closeDatabase, initDatabase } from '../../electron/db'
import Database from 'better-sqlite3'

function config(captions = true): AutomationJobConfig {
  return {
    sourceKind: 'saved-source', sourceId: 'src-1', sourceUrl: 'https://youtube.com/@source', sourceName: 'Source', sourceOrder: 'Latest', sourceCount: 3, selectedVideoIds: [], localMediaPaths: [],
    assetPaths: ['D:/assets/a.png'], style: 'Clean', captionPreset: 'Hormozi', aspectRatios: ['16:9'], execution: 'local',
    rules: { minDurationSec: 0, skipDownloaded: true, continueOnError: true, maxRetries: 2, minimumFreeSpaceGb: 2, captions, autoBroll: false, removeSilence: false, reduceFillerWords: false, keepAwake: true },
    notify: { desktop: true, webhook: false, sound: true, email: false }
  }
}

describe('goal workflow generation', () => {
  it('exposes supported goals honestly and keeps future media goals disabled', () => {
    expect(AUTOMATION_GOALS.find((g) => g.id === 'source-to-export')?.available).toBe(true)
    expect(isAutomationGoalAvailable('long-to-shorts')).toBe(false)
  })

  it('builds an ordered, retry-aware local workflow', () => {
    const steps = buildAutomationWorkflow('job-1', config())
    expect(steps.map((s) => s.key)).toEqual(['preflight', 'discover', 'download', 'prepare', 'transcribe', 'edit', 'render', 'quality-check', 'complete'])
    expect(steps.find((s) => s.key === 'transcribe')?.runsOn).toBe('online-service')
    expect(steps.every((s) => s.maxAttempts === 3)).toBe(true)
  })

  it('removes transcription when captions are disabled and calculates aggregate progress', () => {
    const steps = buildAutomationWorkflow('job-2', config(false))
    expect(steps.some((s) => s.key === 'transcribe')).toBe(false)
    steps[0].status = 'completed'
    steps[1].status = 'running'
    steps[1].progress = 50
    expect(workflowProgress(steps)).toBe(Math.round(150 / steps.length))
  })
})

function sqliteBindingReady(): boolean {
  try { const db = new Database(':memory:'); db.close(); return true } catch { return false }
}

const describeSqlite = sqliteBindingReady() ? describe : describe.skip

describeSqlite('automation persistence', () => {
  let dir = ''
  afterEach(() => { closeDatabase(); if (dir) rmSync(dir, { recursive: true, force: true }); dir = '' })

  it('persists jobs, step checkpoints, per-item state and readable logs across reopen', () => {
    dir = mkdtempSync(join(tmpdir(), 'me-auto-'))
    const file = join(dir, 'studio.db')
    let repos = initDatabase(file)
    const at = new Date().toISOString()
    const job: AutomationJob = {
      id: 'auto-test', name: 'Test goal', goal: 'source-to-export', status: 'queued', progress: 0, currentStep: 'Waiting', config: config(),
      createdAt: at, updatedAt: at, pauseRequested: false, cancelRequested: false, warningCount: 0, failedCount: 0, completedCount: 0, totalItems: 0
    }
    const steps = buildAutomationWorkflow(job.id, job.config)
    repos.createAutomationJob(job, steps)
    repos.updateAutomationStep(steps[0].id, { status: 'completed', progress: 100, checkpoint: { checked: true } })
    const item: AutomationJobItem = { id: 'item-1', jobId: job.id, sourceVideoId: 'vid-1', title: 'Video', status: 'waiting', currentStep: 'Download', progress: 0, attempts: 0, updatedAt: at }
    repos.upsertAutomationItem(item)
    repos.addAutomationLog(job.id, 'info', 'Checkpoint saved', item.id)
    closeDatabase()

    repos = initDatabase(file)
    expect(repos.automationJob(job.id)?.config.sourceId).toBe('src-1')
    expect(repos.automationSteps(job.id)[0]).toMatchObject({ status: 'completed', progress: 100, checkpoint: { checked: true } })
    expect(repos.automationItems(job.id)).toHaveLength(1)
    expect(repos.automationLogs(job.id)[0].message).toBe('Checkpoint saved')
  })
})
