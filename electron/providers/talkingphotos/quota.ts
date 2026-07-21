import { getRepos } from '../../db'
import { getCapabilities } from './client'
import { computeSlotBudget, TALKINGPHOTOS_CONNECTION_ID, type ProviderCapabilities } from '../../../shared/talkingphotos'
import { L } from '../../services/logger'

// Provider submission control (plan §6 — release-critical for long-form use). Only
// 'video' operation jobs (an actual POST /project call) consume a concurrency/daily
// slot: polling, downloads, and local processing never do, and merge/subtitle/TTS
// submissions are deliberately NOT counted here either — the HAR never confirmed
// whether they draw from the same quota (contract: "whether merge/subtitles consume
// the daily video quota" is unresolved), so counting them would risk under-submitting
// for no confirmed reason.
//
// There is no persistent reservation ledger to rebuild after a restart: every
// SubmissionBudget is derived fresh from the provider's own concurrentCount/
// dailyUsage, which already reflects every submission (ours and anyone else's) as of
// the fetch. The "reservation" is just an in-process, synchronously-decremented
// in-memory budget for the remainder of one orchestration pass — see
// SubmissionBudget.take() below.

export class SubmissionBudget {
  private concurrent: number
  private daily: number
  readonly capabilities: ProviderCapabilities

  constructor(capabilities: ProviderCapabilities) {
    this.capabilities = capabilities
    const budget = computeSlotBudget(capabilities)
    this.concurrent = budget.availableConcurrent
    this.daily = budget.availableDaily
  }

  /** Atomically (synchronously, single-threaded — no other code path spends this same
   *  budget) claim one 'video' submission slot. Returns false without side effects if
   *  either limit is exhausted, so callers never submit above either limit. */
  take(): boolean {
    if (this.concurrent <= 0 || this.daily <= 0) return false
    this.concurrent -= 1
    this.daily -= 1
    return true
  }

  get remainingConcurrent(): number { return this.concurrent }
  get remainingDaily(): number { return this.daily }
}

/** Refresh limits/usage fresh from the provider (plan §6: "refresh limits before paid
 *  submissions") and return a spendable budget for this orchestration pass. */
export async function fetchSubmissionBudget(): Promise<SubmissionBudget> {
  const capabilities = await getCapabilities()
  return new SubmissionBudget(capabilities)
}

/** Every 'video' operation job not yet in a terminal state — the local view of
 *  currently-occupied render slots, exposed only for display (the actual gating
 *  decision always uses a fresh provider fetch, never this count). */
export function localActiveVideoSubmissionCount(): number {
  return getRepos().providerJobs(TALKINGPHOTOS_CONNECTION_ID)
    .filter((job) => job.operation === 'video' && (job.status === 'queued' || job.status === 'running' || job.status === 'downloading')).length
}

export function logBudgetExhausted(reason: 'concurrent' | 'daily', jobId: string): void {
  L.info(`talkingphotos: job=${jobId} queued locally — provider ${reason} limit reached, will retry on the next pass`)
}
