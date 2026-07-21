import { BrowserWindow } from 'electron'
import { getRepos } from '../../db'
import { clearProviderSessionStorage, getProviderSession } from './partition'
import { healthCheck } from './client'
import { emit } from '../../ipc/events'
import {
  TALKINGPHOTOS_BASE_URL,
  TALKINGPHOTOS_APP_HOST,
  TALKINGPHOTOS_CONNECTION_ID,
  TALKINGPHOTOS_PARTITION,
  TALKINGPHOTOS_PROVIDER,
  isAllowedProviderNavigation,
  type ProviderConnection,
  type ProviderConnectionStatus
} from '../../../shared/talkingphotos'
import { L } from '../../services/logger'

// Connection lifecycle: an isolated, persistent-partition login BrowserWindow plus
// DB-backed connection state. provider_connections never stores cookies/tokens — only
// status metadata (plan §3 / §19). The actual session lives in Chromium's partition
// storage and is managed exclusively through partition.ts.
//
// Everything that happens once the login window is open is communicated exclusively
// through the 'talkingphotos:connectionStatus' push event (see setStatus below) —
// connectTalkingPhotos() itself only opens the window and returns; it never stays
// pending for the whole interactive login.

const HEALTH_POLL_MS = 2_500
// Logins can require CAPTCHA/MFA the user must complete by hand — generous, not silent.
const CONNECT_TIMEOUT_MS = 15 * 60_000
// Once the app itself is visible, API verification should either promote or return
// control to the user quickly instead of consuming the full interactive-login timer.
const AUTHENTICATED_PAGE_VERIFY_TIMEOUT_MS = 30_000
// Coalesce a burst of navigation/cookie-change signals into a single health check.
const HEALTH_DEBOUNCE_MS = 400

const CONNECTION_STATUS_EVENT = 'talkingphotos:connectionStatus'

let loginWindow: BrowserWindow | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let timeoutTimer: ReturnType<typeof setTimeout> | null = null
let verificationTimeoutTimer: ReturnType<typeof setTimeout> | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let detachCookieListener: (() => void) | null = null
let healthCheckInFlight: Promise<void> | null = null
/** True whenever no login flow is currently in progress — guards every timer/listener
 *  callback so a stale one can never fire (or double-finish) after teardown. */
let settled = true

function nowIso(): string {
  return new Date().toISOString()
}

function defaultConnectionRow(): ProviderConnection {
  const now = nowIso()
  return { id: TALKINGPHOTOS_CONNECTION_ID, provider: TALKINGPHOTOS_PROVIDER, partition: TALKINGPHOTOS_PARTITION, status: 'disconnected', createdAt: now, updatedAt: now }
}

function loadConnectionRow(): ProviderConnection {
  return getRepos().providerConnection(TALKINGPHOTOS_CONNECTION_ID) ?? defaultConnectionRow()
}

function saveConnectionRow(patch: Partial<ProviderConnection>): ProviderConnection {
  const next: ProviderConnection = { ...loadConnectionRow(), ...patch, updatedAt: nowIso() }
  getRepos().upsertProviderConnection(next)
  return next
}

/** The single place that changes connection status from here on: persists the row
 *  and pushes it to every renderer window over CONNECTION_STATUS_EVENT so the UI
 *  never has to infer progress/failure from a long-pending IPC promise. */
function setStatus(status: ProviderConnectionStatus, extra: Partial<ProviderConnection> = {}): ProviderConnection {
  const previousStatus = loadConnectionRow().status
  const conn = saveConnectionRow({ status, ...extra })
  if (previousStatus !== status) L.info(`talkingphotos auth diagnostic stateTransition=${previousStatus}->${status}`)
  emit(CONNECTION_STATUS_EVENT, conn)
  return conn
}

/** Read the persisted connection state. With `refresh`, and only when currently
 *  'connected', also runs a headless health check so a silently-expired session
 *  surfaces promptly instead of waiting for the next real request to fail. */
export async function getConnectionStatus(refresh = false): Promise<ProviderConnection> {
  const current = loadConnectionRow()
  if (!refresh || current.status !== 'connected') return current
  const health = await healthCheck()
  if (health.ok) return saveConnectionRow({ status: 'connected', lastVerifiedAt: nowIso(), lastError: undefined })
  if (health.reauthRequired) return saveConnectionRow({ status: 'reauth_required', lastError: health.message })
  return current // network/other failure: don't destroy the last known good status
}

function clearTimers(): void {
  if (pollTimer) clearInterval(pollTimer)
  if (timeoutTimer) clearTimeout(timeoutTimer)
  if (verificationTimeoutTimer) clearTimeout(verificationTimeoutTimer)
  if (debounceTimer) clearTimeout(debounceTimer)
  pollTimer = null
  timeoutTimer = null
  verificationTimeoutTimer = null
  debounceTimer = null
}

function closeLoginWindow(): void {
  const win = loginWindow
  loginWindow = null
  if (win && !win.isDestroyed()) win.close()
}

/** Cancels every timer and listener an in-progress login flow attached — the 2.5s
 *  poll, the debounce timer, the partition's cookie-change listener, and the window
 *  itself. Safe to call whether or not a flow is actually in progress (disconnect
 *  calls this unconditionally). */
function teardownLoginFlow(): void {
  clearTimers()
  if (detachCookieListener) {
    detachCookieListener()
    detachCookieListener = null
  }
  closeLoginWindow()
}

/** Coalesce a burst of navigation/cookie-change signals into one health check, fired
 *  at most once per HEALTH_DEBOUNCE_MS — never runs once the flow has settled. */
function scheduleHealthCheck(immediate = false): void {
  if (settled) return
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void runHealthCheckNow()
  }, immediate ? 0 : HEALTH_DEBOUNCE_MS)
}

async function runHealthCheckNow(): Promise<void> {
  if (settled) return
  // Navigation, cookie, debounce, and interval signals can arrive together. Reuse
  // the active probe so login never fires duplicate authenticated API requests.
  if (healthCheckInFlight) return healthCheckInFlight
  const pending = (async () => {
    setStatus('verifying')
    let health: Awaited<ReturnType<typeof healthCheck>> = {
      ok: false,
      reauthRequired: false,
      message: 'TalkingPhotos authenticated API session has not been verified yet.'
    }
    try {
      health = await healthCheck()
    } catch {
      // A controlled UI message below makes verifier failures visible. Detailed safe
      // response metadata is emitted by client.ts; never echo an arbitrary exception.
    }
    if (settled) return
    if (health.ok) {
      finishSuccess()
      return
    }
    setStatus('waiting_for_login', { lastError: health.message || 'TalkingPhotos authenticated API session has not been verified yet.' })
  })()
  healthCheckInFlight = pending
  try {
    await pending
  } finally {
    if (healthCheckInFlight === pending) healthCheckInFlight = null
  }
}

function finishSuccess(): void {
  if (settled) return
  settled = true
  setStatus('connected', { connectedAt: nowIso(), lastVerifiedAt: nowIso(), lastError: undefined })
  // Emit/persist the connected state before closing the provider window. Renderer
  // subscribers immediately refresh capabilities/quota and Settings updates live.
  teardownLoginFlow()
}

function finishFailure(message: string): void {
  if (settled) return
  settled = true
  teardownLoginFlow()
  L.warn(`talkingphotos connect: ${message}`)
  setStatus('attention', { lastError: message })
}

/** Auth-looking navigation is only an immediate verification trigger, never proof.
 * The health-check API chain remains authoritative. The public homepage and known
 * login/account-recovery routes are intentionally excluded. */
function isAuthenticatedLookingAppUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== TALKINGPHOTOS_APP_HOST) return false
    return !/^\/(?:$|login(?:\/|$)|sign-?in(?:\/|$)|register(?:\/|$)|forgot(?:\/|$)|reset(?:\/|$)|auth(?:\/|$))/i.test(url.pathname)
  } catch {
    return false
  }
}

function scheduleNavigationHealthCheck(value: string): void {
  const authenticatedLooking = isAuthenticatedLookingAppUrl(value)
  if (authenticatedLooking && !verificationTimeoutTimer) {
    verificationTimeoutTimer = setTimeout(
      () => finishFailure('TalkingPhotos appears open, but the authenticated API session could not be verified.'),
      AUTHENTICATED_PAGE_VERIFY_TIMEOUT_MS
    )
  }
  scheduleHealthCheck(authenticatedLooking)
}

/** Opens the isolated TalkingPhotos login window, wires up every detection signal,
 *  and immediately reports 'waiting_for_login' — the outcome from here on (verifying,
 *  connected, or a terminal attention state) is reported purely through setStatus.
 *  No application preload, sandboxed, contextIsolation on, nodeIntegration off — this
 *  window never talks to window.api and can only navigate within the TalkingPhotos
 *  app origin over https (unresolved HAR gap: exact login/OAuth/MFA domains — see
 *  plan §20 — so unknown hosts are blocked rather than guessed at). */
function openLoginWindow(): ProviderConnection {
  settled = false
  const win = new BrowserWindow({
    width: 480,
    height: 720,
    title: 'Connect TalkingPhotos',
    webPreferences: {
      partition: TALKINGPHOTOS_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
      // Deliberately no `preload` here.
    }
  })
  loginWindow = win

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => { if (!isAllowedProviderNavigation(url)) e.preventDefault() })
  win.webContents.on('will-redirect', (e, url) => { if (!isAllowedProviderNavigation(url)) e.preventDefault() })
  // Faster-than-the-poll detection: any of these navigation signals can mean the user
  // just finished logging in, so check sooner than the next 2.5s tick (debounced).
  win.webContents.on('did-finish-load', () => scheduleNavigationHealthCheck(win.webContents.getURL()))
  win.webContents.on('did-navigate', (_e, url) => scheduleNavigationHealthCheck(url))
  win.webContents.on('did-navigate-in-page', (_e, url) => scheduleNavigationHealthCheck(url))
  win.webContents.on('did-fail-load', (_e, errorCode) => {
    if (errorCode !== -3) finishFailure('TalkingPhotos login page failed to load.') // -3 = ERR_ABORTED, a normal cancelled navigation
  })
  win.on('closed', () => {
    loginWindow = null
    finishFailure('TalkingPhotos login window closed before authentication was confirmed.')
  })

  // Signal-only: the listener never reads/logs/persists/emits the cookie or cause
  // argument this event carries — it only schedules a debounced health check.
  const onCookieChanged = (): void => scheduleHealthCheck()
  getProviderSession().cookies.on('changed', onCookieChanged)
  detachCookieListener = () => getProviderSession().cookies.removeListener('changed', onCookieChanged)

  pollTimer = setInterval(() => { void runHealthCheckNow() }, HEALTH_POLL_MS)
  timeoutTimer = setTimeout(() => finishFailure('TalkingPhotos appears open, but the authenticated API session could not be verified.'), CONNECT_TIMEOUT_MS)

  const waiting = setStatus('waiting_for_login')
  win.loadURL(TALKINGPHOTOS_BASE_URL)
  return waiting
}

/** Opens the login window and returns as soon as it's up — it does NOT wait for the
 *  interactive login to finish (no 15-minute-long unresolved promise). A second call
 *  while a flow is already in progress focuses the existing window instead of
 *  tearing it down and reopening it. Everything after this point (waiting for the
 *  user, verifying, and the final connected/attention outcome) arrives exclusively
 *  through the 'talkingphotos:connectionStatus' push event. */
export async function connectTalkingPhotos(): Promise<ProviderConnection> {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus()
    loginWindow.show()
    return loadConnectionRow()
  }
  setStatus('connecting', { lastError: undefined })
  return openLoginWindow()
}

/** The partition may still hold a valid session, so try headlessly first — a user who
 *  is still actually logged in should never have to see the window again. Always tears
 *  down any login flow that happened to be in progress before declaring success — this
 *  path bypasses the normal poll/signal machinery, so it can't rely on finishSuccess()'s
 *  `settled` guard (which assumes it's only reached from within an active flow). */
export async function reconnectTalkingPhotos(): Promise<ProviderConnection> {
  const health = await healthCheck()
  if (health.ok) {
    settled = true
    teardownLoginFlow()
    return setStatus('connected', { connectedAt: nowIso(), lastVerifiedAt: nowIso(), lastError: undefined })
  }
  return connectTalkingPhotos()
}

export async function disconnectTalkingPhotos(): Promise<ProviderConnection> {
  settled = true
  teardownLoginFlow()
  await clearProviderSessionStorage()
  return setStatus('disconnected', { lastError: undefined })
}

const INTERRUPTIBLE_STATUSES: ProviderConnectionStatus[] = ['connecting', 'waiting_for_login', 'verifying']

/** Startup-only: a crash/restart during an in-progress login leaves in-memory state
 *  fresh (settled=true, no window, no timers), but the persisted row can still claim
 *  connecting/waiting_for_login/verifying from before the crash — nothing is actually
 *  happening, yet the UI would show that as if it were. Call once at app startup,
 *  before any window reads connection status, so the user sees an accurate "try
 *  again" state instead of one that looks like a login is silently still in progress. */
export function reconcileInterruptedConnectionOnStartup(): void {
  const current = loadConnectionRow()
  if (INTERRUPTIBLE_STATUSES.includes(current.status)) {
    setStatus('attention', { lastError: 'TalkingPhotos login was interrupted by an app restart — click Connect to try again.' })
  }
}
