import { BrowserWindow } from 'electron'
import { getRepos } from '../../db'
import { clearProviderSessionStorage } from './partition'
import { healthCheck } from './client'
import {
  TALKINGPHOTOS_BASE_URL,
  TALKINGPHOTOS_CONNECTION_ID,
  TALKINGPHOTOS_PARTITION,
  TALKINGPHOTOS_PROVIDER,
  isAllowedProviderNavigation,
  type ProviderConnection
} from '../../../shared/talkingphotos'
import { L } from '../../services/logger'

// Connection lifecycle: an isolated, persistent-partition login BrowserWindow plus
// DB-backed connection state. provider_connections never stores cookies/tokens — only
// status metadata (plan §3 / §19). The actual session lives in Chromium's partition
// storage and is managed exclusively through partition.ts.

const HEALTH_POLL_MS = 2_500
// Logins can require CAPTCHA/MFA the user must complete by hand — generous, not silent.
const CONNECT_TIMEOUT_MS = 15 * 60_000

let loginWindow: BrowserWindow | null = null

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

function closeLoginWindow(): void {
  const win = loginWindow
  loginWindow = null
  if (win && !win.isDestroyed()) win.close()
}

/** Opens the isolated TalkingPhotos login window and resolves once an authenticated
 *  health check succeeds; rejects if the user closes the window first or it times out.
 *  No application preload, sandboxed, contextIsolation on, nodeIntegration off — this
 *  window never talks to window.api and can only navigate within the TalkingPhotos
 *  app origin over https (unresolved HAR gap: exact login/OAuth/MFA domains — see
 *  plan §20 — so unknown hosts are blocked rather than guessed at). */
function openLoginWindowAndWaitForAuth(): Promise<void> {
  return new Promise((resolve, reject) => {
    closeLoginWindow()
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

    let settled = false
    let poll: ReturnType<typeof setInterval> | null = null
    let timeout: ReturnType<typeof setTimeout> | null = null

    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      if (poll) clearInterval(poll)
      if (timeout) clearTimeout(timeout)
      closeLoginWindow()
      if (ok) resolve()
      else reject(new Error('TalkingPhotos login window closed before authentication was confirmed.'))
    }

    poll = setInterval(() => { void healthCheck().then((health) => { if (health.ok) finish(true) }) }, HEALTH_POLL_MS)
    timeout = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS)

    win.webContents.on('did-fail-load', (_e, errorCode) => {
      if (errorCode !== -3) finish(false) // -3 = ERR_ABORTED, a normal cancelled navigation
    })
    win.on('closed', () => { loginWindow = null; finish(false) })
    win.loadURL(TALKINGPHOTOS_BASE_URL)
  })
}

export async function connectTalkingPhotos(): Promise<ProviderConnection> {
  saveConnectionRow({ status: 'connecting' })
  try {
    await openLoginWindowAndWaitForAuth()
    return saveConnectionRow({ status: 'connected', connectedAt: nowIso(), lastVerifiedAt: nowIso(), lastError: undefined })
  } catch (e) {
    L.warn(`talkingphotos connect: ${(e as Error).message}`)
    return saveConnectionRow({ status: 'disconnected', lastError: (e as Error).message })
  }
}

/** The partition may still hold a valid session, so try headlessly first — a user who
 *  is still actually logged in should never have to see the window again. */
export async function reconnectTalkingPhotos(): Promise<ProviderConnection> {
  const health = await healthCheck()
  if (health.ok) return saveConnectionRow({ status: 'connected', connectedAt: nowIso(), lastVerifiedAt: nowIso(), lastError: undefined })
  return connectTalkingPhotos()
}

export async function disconnectTalkingPhotos(): Promise<ProviderConnection> {
  closeLoginWindow()
  await clearProviderSessionStorage()
  return saveConnectionRow({ status: 'disconnected', lastError: undefined })
}
