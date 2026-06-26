import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings } from '../../shared/types'

// Start-on-sign-in + asset resolution for the tray. Login items are an OS-session
// feature (no-op / unsupported on some Linux setups) so the call is guarded.

/** Register/unregister the app to launch on OS sign-in, hidden into the tray. */
export function applyLoginItem(settings: AppSettings): void {
  try {
    if (!app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: false })
      return
    }
    app.setLoginItemSettings({ openAtLogin: settings.background.startOnSignIn, openAsHidden: true })
  } catch {
    /* login items unsupported on this platform — non-fatal */
  }
}

/** Locate the tray icon (packaged under resources/, else repo resources/ in dev). */
export function trayIconPath(): string {
  const packaged = process.resourcesPath ? join(process.resourcesPath, 'icons', 'tray.png') : ''
  if (packaged && existsSync(packaged)) return packaged
  return join(process.cwd(), 'resources', 'icons', 'tray.png')
}
