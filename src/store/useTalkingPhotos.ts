import { create } from 'zustand'
import type { ProviderCapabilities, ProviderConnection, ProviderJob, ProviderProjectSummary, TalkingPhotosCreateInput } from '@shared/talkingphotos'

// TalkingPhotos live data — kept separate from useData.ts (the local-pipeline data
// layer) since this is a distinct cloud-provider domain with its own connection
// lifecycle, capability catalogs, and remote-job list.

const api = (): typeof window.api | undefined => (typeof window !== 'undefined' ? window.api : undefined)

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

  init: () => Promise<void>
  refreshConnection: () => Promise<void>
  connect: () => Promise<void>
  reconnect: () => Promise<void>
  disconnect: () => Promise<void>
  loadCapabilities: () => Promise<void>
  loadJobs: () => Promise<void>
  sync: () => Promise<void>
  createUploadedAudio: (input: TalkingPhotosCreateInput) => Promise<ProviderJob | undefined>
  downloadOutput: (providerJobId: string) => Promise<void>
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

  init: async () => {
    if (!get().subscribed) {
      set({ subscribed: true })
      api()?.onProviderJob?.((job) => {
        set((s) => ({ jobs: [job, ...s.jobs.filter((j) => j.id !== job.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }))
      })
    }
    await Promise.all([get().refreshConnection(), get().loadJobs()])
    if (get().connection?.status === 'connected') await get().loadCapabilities()
  },

  refreshConnection: async () => {
    try {
      const connection = await api()?.talkingPhotos?.connectionStatus?.()
      if (connection) set({ connection, error: '' })
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  connect: async () => {
    set({ connecting: true, error: '' })
    try {
      const connection = await api()?.talkingPhotos?.connect?.()
      if (connection) set({ connection })
      if (connection?.status === 'connected') { await get().loadCapabilities(); await get().sync() }
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ connecting: false })
    }
  },

  reconnect: async () => {
    set({ connecting: true, error: '' })
    try {
      const connection = await api()?.talkingPhotos?.reconnect?.()
      if (connection) set({ connection })
      if (connection?.status === 'connected') { await get().loadCapabilities(); await get().sync() }
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ connecting: false })
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

  downloadOutput: async (providerJobId: string) => {
    try {
      const job = await api()?.talkingPhotos?.downloadOutput?.(providerJobId)
      if (job) set((s) => ({ jobs: s.jobs.map((j) => (j.id === job.id ? job : j)) }))
    } catch (e) {
      set({ error: (e as Error).message })
    }
  }
}))
