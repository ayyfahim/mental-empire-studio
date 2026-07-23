import Store from 'electron-store'
import { safeStorage } from 'electron'
import { DEFAULT_SETTINGS, type AppSettings, type DeepPartial } from '../../shared/types'

// electron-store persists JSON to <userData>/mental-empire-settings.json with atomic writes.
// This is the single source of truth for AppSettings (appearance, render, auto-scrape, background).
//
// Secrets (Groq + stock-footage API keys) are encrypted AT REST via Electron safeStorage
// (OS keychain/DPAPI). Plaintext stays in memory for the renderer UI; only the on-disk
// JSON is ciphertext. Legacy plaintext values keep working and are re-encrypted on the
// next write. If the OS has no secure backend, we transparently fall back to plaintext.

type Schema = { settings: AppSettings }

let store: Store<Schema> | null = null

// Field names (anywhere in the settings tree) whose string values are secrets.
const SECRET_FIELDS = new Set([
  'apiKey', 'pexelsKey', 'pixabayKey', 'coverrKey',
  // OpenMontage bridge provider keys (settings.montage.*) — passed to the Python subprocess via env
  'falKey', 'unsplashKey', 'elevenLabsKey', 'openaiKey', 'googleKey'
])
const ENC_PREFIX = 'enc:v1:'

function canEncrypt(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function encryptValue(v: string): string {
  if (!v || v.startsWith(ENC_PREFIX) || !canEncrypt()) return v
  try {
    return ENC_PREFIX + safeStorage.encryptString(v).toString('base64')
  } catch {
    return v
  }
}

function decryptValue(v: string): string {
  if (!v.startsWith(ENC_PREFIX)) return v // plaintext (legacy / no-keychain machine)
  if (!canEncrypt()) return '' // ciphertext we can't read here — surface as unset, don't leak
  try {
    return safeStorage.decryptString(Buffer.from(v.slice(ENC_PREFIX.length), 'base64'))
  } catch {
    return ''
  }
}

/** Deep-clone settings, applying `fn` to every secret string field. */
function transformSecrets(obj: unknown, fn: (val: string) => string): unknown {
  if (Array.isArray(obj)) return obj.map((v) => transformSecrets(v, fn))
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = SECRET_FIELDS.has(k) && typeof v === 'string' ? fn(v) : transformSecrets(v, fn)
    }
    return out
  }
  return obj
}

function decodeSecrets<T>(obj: T): T {
  return transformSecrets(obj, decryptValue) as T
}

/** Encrypt secrets then persist to disk. */
function persist(settings: AppSettings): void {
  store!.set('settings', transformSecrets(settings, encryptValue) as AppSettings)
}

/** Recursively merge a (possibly partial) patch onto a base object, returning a new object. */
export function mergeDeep<T>(base: T, patch?: DeepPartial<T>): T {
  if (!patch) return base
  const out: Record<string, unknown> = Array.isArray(base) ? [...(base as unknown[])] as never : { ...(base as object) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const current = (out as Record<string, unknown>)[key]
    if (value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object') {
      out[key] = mergeDeep(current, value as DeepPartial<unknown>)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out as T
}

/** Open the store and reconcile any newly-added default keys onto the persisted object. */
export function initSettings(): AppSettings {
  store = new Store<Schema>({
    name: 'mental-empire-settings',
    defaults: { settings: DEFAULT_SETTINGS }
  })
  const decoded = decodeSecrets(store.get('settings') as DeepPartial<AppSettings>)
  const reconciled = mergeDeep(DEFAULT_SETTINGS, decoded)
  persist(reconciled) // re-encrypts (migrates any legacy plaintext keys)
  return reconciled
}

export function getSettings(): AppSettings {
  if (!store) return initSettings()
  return decodeSecrets(store.get('settings'))
}

/** Apply a deep patch, persist, and return the full merged settings. */
export function setSettings(patch: DeepPartial<AppSettings>): AppSettings {
  if (!store) initSettings()
  const next = mergeDeep(getSettings(), patch)
  persist(next)
  return next
}

/** Restore every setting to its factory default and persist. */
export function resetSettings(): AppSettings {
  if (!store) initSettings()
  persist(DEFAULT_SETTINGS)
  return DEFAULT_SETTINGS
}
