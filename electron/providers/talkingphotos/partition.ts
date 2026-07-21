import { session as electronSession, type Session } from 'electron'
import { TALKINGPHOTOS_PARTITION } from '../../../shared/talkingphotos'

// The ONLY place that resolves the TalkingPhotos Electron session. Cookies/storage
// for this partition live entirely inside Chromium — never copied into electron-store,
// SQLite, logs, or exposed to the renderer via IPC.

let cached: Session | null = null

export function getProviderSession(): Session {
  if (!cached) cached = electronSession.fromPartition(TALKINGPHOTOS_PARTITION, { cache: true })
  return cached
}

/** Full logout: clears cookies/cache/storage for the TalkingPhotos partition only.
 *  Never touches the main app session. */
export async function clearProviderSessionStorage(): Promise<void> {
  await getProviderSession().clearStorageData()
}
