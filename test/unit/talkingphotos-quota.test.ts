import { describe, expect, it } from 'vitest'
import { SubmissionBudget } from '../../electron/providers/talkingphotos/quota'
import type { ProviderCapabilities } from '../../shared/talkingphotos'

// SubmissionBudget.take() is the in-process, synchronously-decremented budget spent
// across one orchestration pass (plan §6) — there is no persistent reservation to
// "release": once a job reaches a terminal state, the NEXT pass's fresh capabilities
// fetch simply reports more room, which these tests verify at the budget-computation
// level (a fresh SubmissionBudget per pass is the release mechanism).

function caps(usage: Partial<ProviderCapabilities['usage']>): ProviderCapabilities {
  return {
    limits: { maxDurationSeconds: 300, maxCharactersTts: 6000, maxDurationPremiumSeconds: 300, maxCharactersTtsPremium: 6000 },
    usage: { concurrentCount: 0, concurrentLimit: 0, dailyUsage: 0, dailyLimit: 0, ...usage },
    fetchedAt: ''
  }
}

describe('SubmissionBudget', () => {
  it('takes zero slots when the concurrent limit is already exhausted', () => {
    const budget = new SubmissionBudget(caps({ concurrentCount: 5, concurrentLimit: 5, dailyLimit: 100 }))
    expect(budget.take()).toBe(false)
  })

  it('takes exactly the partially-available number of slots, then refuses further submissions', () => {
    const budget = new SubmissionBudget(caps({ concurrentCount: 2, concurrentLimit: 5, dailyLimit: 100 }))
    expect(budget.take()).toBe(true)
    expect(budget.take()).toBe(true)
    expect(budget.take()).toBe(true)
    expect(budget.take()).toBe(false) // 3 available (5-2), the 4th attempt is refused
  })

  it('refuses a submission once the daily limit is reached, even with concurrent slots free', () => {
    const budget = new SubmissionBudget(caps({ concurrentLimit: 5, dailyUsage: 100, dailyLimit: 100 }))
    expect(budget.take()).toBe(false)
  })

  it('never spends below zero on repeated calls after exhaustion', () => {
    const budget = new SubmissionBudget(caps({ concurrentCount: 0, concurrentLimit: 1, dailyLimit: 100 }))
    expect(budget.take()).toBe(true)
    expect(budget.take()).toBe(false)
    expect(budget.take()).toBe(false)
    expect(budget.remainingConcurrent).toBe(0)
  })

  it('treats a 0 (unknown) limit as unbounded rather than blocking every submission', () => {
    const budget = new SubmissionBudget(caps({}))
    expect(budget.take()).toBe(true)
    expect(budget.take()).toBe(true)
    expect(budget.remainingConcurrent).toBe(Number.POSITIVE_INFINITY)
  })

  it('a fresh budget each pass reflects newly-available room — the "release on terminal state" mechanism', () => {
    const busy = new SubmissionBudget(caps({ concurrentCount: 5, concurrentLimit: 5, dailyLimit: 100 }))
    expect(busy.take()).toBe(false)
    // A job completed server-side; the next fetch reports concurrentCount back down.
    const freed = new SubmissionBudget(caps({ concurrentCount: 4, concurrentLimit: 5, dailyLimit: 100 }))
    expect(freed.take()).toBe(true)
  })
})
