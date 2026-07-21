import { create } from 'zustand'
import type { ProviderCapabilities, ProviderConnection, ProviderConnectionStatus, ProviderJob, ProviderLanguage, ProviderMotion, ProviderMotionQuery, ProviderProjectSummary, ProviderVoice, TalkingPhotosAspectRatio, TalkingPhotosCreateInput, TalkingPhotosScriptCreateInput } from '@shared/talkingphotos'

// TalkingPhotos live data — kept separate from useData.ts (the local-pipeline data
// layer) since this is a distinct cloud-provider domain with its own connection
// lifecycle, capability catalogs, and remote-job list.
//
// Connection state is NOT derived from awaiting connect()/reconnect()'s IPC promise —
// those resolve as soon as the login window opens. The single source of truth for
// every status change from that point on is the 'talkingphotos:connectionStatus' push
// event, subscribed to once in init() and reflected straight into `connection`.

const api = (): typeof window.api | undefined => (typeof window !== 'undefined' ? window.api : undefined)

/** True while a connect/reconnect attempt is actively in flight — drives the
 *  "Connecting…" family of button/status states without a separate boolean that
 *  could drift out of sync with the pushed connection status. */
function isConnectingStatus(status?: ProviderConnectionStatus): boolean {
  return status === 'connecting' || status === 'waiting_for_login' || status === 'verifying'
}

interface TalkingPhotosState {
  connection: ProviderConnection | null
  connecting: boolean
  capabilities: ProviderCapabilities | null
  jobs: ProviderJob[]
  remoteProjects: ProviderProjectSummary[]
  syncing: boolean
  creating: boolean
  error: string
  subscribed: boolean

  // Read-only catalogs backing the language/voice/motion pickers — fetched lazily
  // and cached in-memory (voices per language, motions per query) since they only
  // change on the provider's side, not per-render.
  languages: ProviderLanguage[]
  languagesLoading: boolean
  voicesByLanguage: Record<string, ProviderVoice[]>
  voicesLoading: boolean
  motionsByQuery: Record<string, ProviderMotion[]>
  motionsLoading: boolean

  init: () => Promise<void>
  refreshConnection: () => Promise<void>
  connect: () => Promise<void>
  reconnect: () => Promise<void>
  disconnect: () => Promise<void>
  loadCapabilities: () => Promise<void>
  loadJobs: () => Promise<void>
  sync: () => Promise<void>
  loadLanguages: () => Promise<void>
  loadVoices: (languageCode: string) => Promise<void>
  loadMotions: (query: ProviderMotionQuery) => Promise<void>
  createUploadedAudio: (input: TalkingPhotosCreateInput) => Promise<ProviderJob | undefined>
  createScript: (input: TalkingPhotosScriptCreateInput) => Promise<ProviderJob | undefined>
  downloadOutput: (providerJobId: string) => Promise<void>
  createProviderSubtitles: (sourceJobId: string, language?: string) => Promise<void>
  applyLocalCaptions: (providerJobId: string, aspect?: TalkingPhotosAspectRatio) => Promise<void>
}

/** Stable cache key for a motion query — order-independent field access, so callers
 *  don't need to worry about key ordering when building the query object. */
function motionQueryKey(query: ProviderMotionQuery): string {
  return `${query.projectType}|${query.gender ?? ''}|${query.aspectRatio ?? ''}|${query.style ?? ''}`
}

export const useTalkingPhotos = create<TalkingPhotosState>((set, get) => ({
  connection: null,
  connecting: false,
  capabilities: null,
  jobs: [],
  remoteProjects: [],
  syncing: false,
  creating: false,
  error: '',
  subscribed: false,

  languages: [],
  languagesLoading: false,
  voicesByLanguage: {},
  voicesLoading: false,
  motionsByQuery: {},
  motionsLoading: false,

  init: async () => {
    if (!get().subscribed) {
      set({ subscribed: true })
      api()?.onProviderJob?.((job) => {
        set((s) => ({ jobs: [job, ...s.jobs.filter((j) => j.id !== job.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }))
      })
      api()?.onConnectionStatusChanged?.((connection) => {
        // Deliberately does NOT touch the generic `error` field — this fires every
        // ~2.5s while a login flow is active (poll ticks between 'verifying' and
        // 'waiting_for_login'), and `error` is shared with unrelated actions
        // (job creation, sync, …) whose message must not be wiped by connection noise.
        // A failed/timed-out connect attempt is surfaced via connection.lastError.
        const wasConnected = get().connection?.status === 'connected'
        set({ connection, connecting: isConnectingStatus(connection.status) })
        if (connection.status === 'connected' && !wasConnected) {
          void get().loadCapabilities()
          void get().sync()
        }
      })
    }
    await Promise.all([get().refreshConnection(), get().loadJobs()])
    if (get().connection?.status === 'connected') await get().loadCapabilities()
  },

  refreshConnection: async () => {
    try {
      const connection = await api()?.talkingPhotos?.connectionStatus?.()
      if (connection) set({ connection, connecting: isConnectingStatus(connection.status), error: '' })
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  // connect()/reconnect() only await the quick "login window is opening" response —
  // the eventual success/failure/timeout outcome arrives later via the
  // onConnectionStatusChanged subscription set up in init(), not from this promise.
  connect: async () => {
    set({ error: '' })
    try {
      const connection = await api()?.talkingPhotos?.connect?.()
      if (connection) set({ connection, connecting: isConnectingStatus(connection.status) })
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  reconnect: async () => {
    set({ error: '' })
    try {
      const connection = await api()?.talkingPhotos?.reconnect?.()
      if (connection) set({ connection, connecting: isConnectingStatus(connection.status) })
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  disconnect: async () => {
    try {
      const connection = await api()?.talkingPhotos?.disconnect?.()
      if (connection) set({ connection, capabilities: null })
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  loadCapabilities: async () => {
    try {
      const capabilities = await api()?.talkingPhotos?.capabilities?.()
      if (capabilities) set({ capabilities })
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  loadJobs: async () => {
    try {
      const jobs = await api()?.talkingPhotos?.jobs?.()
      if (jobs) set({ jobs })
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  sync: async () => {
    set({ syncing: true, error: '' })
    try {
      const jobs = await api()?.talkingPhotos?.sync?.()
      if (jobs) set({ jobs })
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ syncing: false })
    }
  },

  loadLanguages: async () => {
    if (get().languages.length > 0 || get().languagesLoading) return
    set({ languagesLoading: true })
    try {
      const languages = await api()?.talkingPhotos?.languages?.()
      if (languages) set({ languages })
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ languagesLoading: false })
    }
  },

  loadVoices: async (languageCode) => {
    if (!languageCode || get().voicesByLanguage[languageCode] || get().voicesLoading) return
    set({ voicesLoading: true })
    try {
      const voices = await api()?.talkingPhotos?.voices?.(languageCode)
      if (voices) set((s) => ({ voicesByLanguage: { ...s.voicesByLanguage, [languageCode]: voices } }))
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ voicesLoading: false })
    }
  },

  loadMotions: async (query) => {
    const key = motionQueryKey(query)
    if (get().motionsByQuery[key] || get().motionsLoading) return
    set({ motionsLoading: true })
    try {
      const motions = await api()?.talkingPhotos?.motions?.(query)
      if (motions) set((s) => ({ motionsByQuery: { ...s.motionsByQuery, [key]: motions } }))
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ motionsLoading: false })
    }
  },

  createUploadedAudio: async (input) => {
    set({ creating: true, error: '' })
    try {
      const job = await api()?.talkingPhotos?.createUploadedAudio?.(input)
      if (job) set((s) => ({ jobs: [job, ...s.jobs.filter((item) => item.id !== job.id)] }))
      return job
    } catch (e) {
      set({ error: (e as Error).message })
      return undefined
    } finally {
      set({ creating: false })
    }
  },

  createScript: async (input) => {
    set({ creating: true, error: '' })
    try {
      const job = await api()?.talkingPhotos?.createScript?.(input)
      if (job) set((s) => ({ jobs: [job, ...s.jobs.filter((item) => item.id !== job.id)] }))
      return job
    } catch (e) {
      set({ error: (e as Error).message })
      return undefined
    } finally {
      set({ creating: false })
    }
  },

  downloadOutput: async (providerJobId: string) => {
    try {
      const job = await api()?.talkingPhotos?.downloadOutput?.(providerJobId)
      if (job) set((s) => ({ jobs: s.jobs.map((j) => (j.id === job.id ? job : j)) }))
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  createProviderSubtitles: async (sourceJobId, language) => {
    try {
      const job = await api()?.talkingPhotos?.createProviderSubtitles?.(sourceJobId, language)
      if (job) set((s) => ({ jobs: [job, ...s.jobs.filter((item) => item.id !== job.id)] }))
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  applyLocalCaptions: async (providerJobId, aspect) => {
    try {
      const job = await api()?.talkingPhotos?.applyLocalCaptions?.(providerJobId, aspect)
      if (job) set((s) => ({ jobs: s.jobs.map((j) => (j.id === job.id ? job : j)) }))
    } catch (e) {
      set({ error: (e as Error).message })
    }
  }
}))
