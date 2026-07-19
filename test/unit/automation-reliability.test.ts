import { describe, expect, it } from 'vitest'
import { classifyAutomationError, retryDelayMs } from '../../shared/automationReliability'

describe('Automation error classification', () => {
  it('retries a temporary 403 without login evidence', () => {
    expect(classifyAutomationError({ step: 'download', httpStatus: 403, stderr: 'HTTP Error 403: Forbidden' })).toMatchObject({ kind: 'temporary', retryable: true, requiresUserAction: false })
  })

  it('does not retry a cookie/login 403', () => {
    expect(classifyAutomationError({ step: 'download', httpStatus: 403, stderr: 'Sign in to confirm you are not a bot. Cookies required.' })).toMatchObject({ kind: 'authentication', retryable: false, requiresUserAction: true })
  })

  it('sanitizes keys and signed query values', () => {
    const result = classifyAutomationError({ error: 'failed https://x.test/a?token=secret gsk_abcdefghijklmnop' })
    expect(result.message).not.toContain('secret')
    expect(result.message).not.toContain('gsk_abcdefghijklmnop')
  })

  it('uses additional-attempt semantics with a bounded Retry-After', () => {
    expect(retryDelayMs({ attempt: 1, baseDelaySec: 10, maxDelaySec: 90, retryAfterSec: 25, jitter: 0 })).toBe(25_000)
    expect(retryDelayMs({ attempt: 5, baseDelaySec: 10, maxDelaySec: 60, jitter: 0 })).toBe(60_000)
  })
})
