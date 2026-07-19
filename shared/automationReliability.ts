import type { AutomationErrorKind } from './types'

export interface AutomationErrorInput {
  error?: unknown
  step?: string
  httpStatus?: number
  ytdlpExitCode?: number | null
  stderr?: string
  stderrCategory?: string
  usedCredentials?: boolean
  usedCookies?: boolean
  retryAfterSec?: number
}

export interface AutomationErrorClassification {
  kind: AutomationErrorKind
  retryable: boolean
  message: string
  httpStatus?: number
  ytdlpExitCode?: number | null
  stderrCategory?: string
  retryAfterSec?: number
  requiresUserAction: boolean
}

function sanitize(text: string): string {
  return text
    .replace(/([?&](?:key|token|signature|sig|auth|api_key)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(--cookies(?:-from-browser)?\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\b(?:sk|gsk)_[A-Za-z0-9_-]{12,}\b/g, '[redacted-key]')
    .slice(0, 600)
}

function messageOf(input: AutomationErrorInput): string {
  const errorText = input.error instanceof Error ? input.error.message : input.error == null ? '' : String(input.error)
  return sanitize(errorText || input.stderr || 'Automation step failed')
}

export function classifyAutomationError(inputOrError: AutomationErrorInput | unknown, legacyStep = ''): AutomationErrorClassification {
  const input: AutomationErrorInput = inputOrError && typeof inputOrError === 'object' && (
    'error' in inputOrError || 'step' in inputOrError || 'httpStatus' in inputOrError || 'stderr' in inputOrError
  ) ? inputOrError as AutomationErrorInput : { error: inputOrError, step: legacyStep }
  const message = messageOf(input)
  const evidence = `${message}\n${sanitize(input.stderr || '')}\n${input.stderrCategory || ''}`.toLowerCase()
  const step = input.step || legacyStep
  const auth = /login required|sign in|cookies? required|confirm you(?:'re| are) not a bot|private video|members?-only|age[- ]restricted|not available in your country|invalid credentials|unauthorized/.test(evidence)
  const rateLimited = input.httpStatus === 429 || /\b429\b|too many requests|rate limit/.test(evidence)
  const transient403 = input.httpStatus === 403 || /\b403\b|http error 403/.test(evidence)
  const connection = /econnreset|econnrefused|enotfound|eai_again|connection reset|temporary failure in name resolution|dns|network is unreachable|fetch failed|socket/.test(evidence)
  const timeout = /timeout|timed out|no progress/.test(evidence)
  const temporaryExtraction = /temporary|fragment unavailable|unable to download webpage|remote end closed|extractor.*temporar/.test(evidence)

  if (/enospc|no space left|insufficient disk|free storage/.test(evidence)) return { kind: 'storage', retryable: false, message, requiresUserAction: true }
  if (auth) return { kind: 'authentication', retryable: false, message, httpStatus: input.httpStatus, ytdlpExitCode: input.ytdlpExitCode, stderrCategory: input.stderrCategory, requiresUserAction: true }
  if (rateLimited || transient403 || timeout || temporaryExtraction) return {
    kind: 'temporary', retryable: true, message, httpStatus: input.httpStatus, ytdlpExitCode: input.ytdlpExitCode,
    stderrCategory: input.stderrCategory, retryAfterSec: input.retryAfterSec, requiresUserAction: false
  }
  if (connection) return { kind: 'connection', retryable: true, message, ytdlpExitCode: input.ytdlpExitCode, stderrCategory: input.stderrCategory, requiresUserAction: false }
  if (/unsupported|not available yet|invalid url|unsupported url/.test(evidence)) return { kind: 'unsupported_input', retryable: false, message, requiresUserAction: true }
  if (/missing|not found|enoent|visual media|asset/.test(evidence)) return { kind: 'missing_asset', retryable: false, message, requiresUserAction: true }
  if (step === 'download') return { kind: 'download', retryable: true, message, ytdlpExitCode: input.ytdlpExitCode, stderrCategory: input.stderrCategory, requiresUserAction: false }
  if (step === 'transcribe') return { kind: 'transcription', retryable: !input.usedCredentials, message, requiresUserAction: !!input.usedCredentials }
  if (step === 'render' || step === 'quality-check') return { kind: 'export', retryable: true, message, requiresUserAction: false }
  if (step === 'prepare' || step === 'edit') return { kind: 'editing', retryable: false, message, requiresUserAction: true }
  return { kind: 'user_action', retryable: false, message, requiresUserAction: true }
}

export function retryDelayMs(opts: { attempt: number; baseDelaySec: number; maxDelaySec: number; retryAfterSec?: number; jitter?: number }): number {
  const base = Math.max(1, opts.baseDelaySec) * 1000 * (2 ** Math.max(0, opts.attempt - 1))
  const retryAfter = Math.max(0, opts.retryAfterSec || 0) * 1000
  const jitterFactor = opts.jitter == null ? 0.15 : Math.max(0, Math.min(0.5, opts.jitter))
  const jitter = base * jitterFactor * Math.random()
  return Math.round(Math.min(Math.max(base + jitter, retryAfter), Math.max(1, opts.maxDelaySec) * 1000))
}
