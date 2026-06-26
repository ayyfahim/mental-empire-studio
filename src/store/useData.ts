import { create } from 'zustand'
import type {
  ActivityRow,
  DownloadProgress,
  DownloadedVideo,
  MyChannel,
  Project,
  ProjectImage,
  ScrapeOrder,
  ScrapedVideo,
  RecentUpload,
  TranscriptWord,
  RenderQueueRow,
  RenderProgress,
  Profile
} from '@shared/types'

// Live data layer — everything sourced from the SQLite DB / scrape / download /
// transcription services over window.api. Separate from useStore (UI state) so the
// producer screens read real data while the appearance/editor state stays put.

const api = (): typeof window.api | undefined => (typeof window !== 'undefined' ? window.api : undefined)

interface DataState {
  channels: MyChannel[]
  activity: ActivityRow[]
  recentUploads: RecentUpload[]
  downloads: DownloadedVideo[]
  sourceVideos: ScrapedVideo[]
  fetching: boolean
  scraping: boolean
  dlProgress: Record<string, DownloadProgress>
  activeProject: Project | null
  projectImages: ProjectImage[]
  transcript: TranscriptWord[]
  transcribing: boolean
  transcribeMessage: string
  transcribeError: string
  renderJobs: RenderQueueRow[]
  renderProgress: Record<string, RenderProgress>
  rendering: boolean
  profiles: Profile[]
  runningProfileId: string | null
  ready: boolean

  init: () => Promise<void>
  loadChannels: () => Promise<void>
  loadDownloads: () => Promise<void>
  loadActivity: () => Promise<void>
  addChannel: (url: string, linkedSourceId?: string) => Promise<void>
  rescrapeAll: () => Promise<void>
  updateGoals: (id: string, patch: { weekGoal?: number; monthGoal?: number; reminder?: string; reminderNote?: string }) => Promise<void>
  fetchSource: (url: string, order: ScrapeOrder, count: number) => Promise<void>
  startDownload: (videos: ScrapedVideo[], sourceUrl: string, bitrate: number) => Promise<DownloadedVideo[]>
  resumeDownload: (id: string) => Promise<void>
  openProject: (downloadId: string) => Promise<void>
  openProjectById: (projectId: string) => Promise<void>
  setProjectImages: (paths: string[]) => Promise<void>
  reorderProjectImages: (imageIds: string[]) => Promise<void>
  setMedia: (patch: Partial<Project>) => Promise<void>
  setCaptions: (patch: Partial<Project>) => Promise<void>
  runTranscribe: () => Promise<void>
  toggleWordEmphasis: (wordId: string) => Promise<void>
  sendActiveToRender: () => Promise<void>
  loadRenderJobs: () => Promise<void>
  renderAll: () => Promise<void>
  cancelJob: (id: string) => Promise<void>
  loadProfiles: () => Promise<void>
  runProfile: (id: string) => Promise<string[]>
  saveProfile: (p: Profile) => Promise<void>
  deleteProfile: (id: string) => Promise<void>
  runNow: () => Promise<void>
}

let subscribed = false

export const useData = create<DataState>((set, get) => ({
  channels: [],
  activity: [],
  recentUploads: [],
  downloads: [],
  sourceVideos: [],
  fetching: false,
  scraping: false,
  dlProgress: {},
  activeProject: null,
  projectImages: [],
  transcript: [],
  transcribing: false,
  transcribeMessage: '',
  transcribeError: '',
  renderJobs: [],
  renderProgress: {},
  rendering: false,
  profiles: [],
  runningProfileId: null,
  ready: false,

  init: async () => {
    const a = api()
    if (!a) {
      set({ ready: true })
      return
    }
    await Promise.all([get().loadChannels(), get().loadDownloads(), get().loadActivity(), get().loadProfiles(), get().loadRenderJobs()])
    set({ ready: true })
    a.reminders.check().catch(() => {})

    if (subscribed) return
    subscribed = true
    a.onActivity((row) => set((s) => ({ activity: [row, ...s.activity].slice(0, 30) })))
    a.onDownloadProgress((p) => {
      set((s) => ({ dlProgress: { ...s.dlProgress, [p.downloadId]: p } }))
      void get().loadDownloads()
    })
    a.onTranscribeProgress((p) => set({
      transcribing: p.phase !== 'done' && p.phase !== 'error',
      transcribeMessage: p.phase === 'done' ? 'Done' : p.phase === 'error' ? '' : p.message,
      transcribeError: p.phase === 'error' ? (p.error ?? p.message) : ''
    }))
    a.onRenderProgress((p) => {
      set((s) => ({ renderProgress: { ...s.renderProgress, [p.jobId]: p } }))
      void get().loadRenderJobs()
    })
  },

  loadChannels: async () => {
    const a = api()
    if (!a) return
    const [channels, recentUploads] = await Promise.all([a.db.myChannels(), a.db.recentUploads(8)])
    set({ channels, recentUploads })
  },
  loadDownloads: async () => {
    const a = api()
    if (a) set({ downloads: await a.db.downloads() })
  },
  loadActivity: async () => {
    const a = api()
    if (a) set({ activity: await a.db.activity() })
  },

  addChannel: async (url, linkedSourceId) => {
    const a = api()
    if (!a || !url.trim()) return
    set({ scraping: true })
    try {
      await a.scrape.addMyChannel(url.trim(), linkedSourceId)
      await get().loadChannels()
    } finally {
      set({ scraping: false })
    }
  },
  rescrapeAll: async () => {
    const a = api()
    if (!a) return
    set({ scraping: true })
    try {
      await a.scrape.all()
      await Promise.all([get().loadChannels(), get().loadActivity()])
    } finally {
      set({ scraping: false })
    }
  },
  updateGoals: async (id, patch) => {
    const a = api()
    if (!a) return
    const channels = await a.db.updateChannelGoals(id, patch)
    set({ channels })
  },

  fetchSource: async (url, order, count) => {
    const a = api()
    if (!a || !url.trim()) return
    set({ fetching: true })
    try {
      const sourceVideos = await a.scrape.sourceVideos(url.trim(), order, count)
      set({ sourceVideos })
    } finally {
      set({ fetching: false })
    }
  },
  startDownload: async (videos, sourceUrl, bitrate) => {
    const a = api()
    if (!a || videos.length === 0) return []
    const rows = await a.download.start(videos, { bitrate, sourceUrl })
    await get().loadDownloads()
    return rows
  },
  resumeDownload: async (id) => {
    const a = api()
    if (!a) return
    await a.download.resume(id)
    await get().loadDownloads()
  },

  openProject: async (downloadId) => {
    const a = api()
    if (!a) return
    const project = await a.compose.createProject(downloadId)
    const [projectImages, transcript] = await Promise.all([a.compose.images(project.id), a.transcribe.get(project.id)])
    set({ activeProject: project, projectImages, transcript, transcribeError: '', transcribeMessage: '' })
  },
  openProjectById: async (projectId) => {
    const a = api()
    if (!a) return
    const project = await a.compose.get(projectId)
    if (!project) return
    const [projectImages, transcript] = await Promise.all([a.compose.images(projectId), a.transcribe.get(projectId)])
    set({ activeProject: project, projectImages, transcript, transcribeError: '', transcribeMessage: '' })
  },
  setProjectImages: async (paths) => {
    const a = api()
    const p = get().activeProject
    if (!a || !p) return
    const projectImages = await a.compose.setImages(p.id, paths)
    set({ projectImages })
  },
  reorderProjectImages: async (imageIds) => {
    const a = api()
    const p = get().activeProject
    if (!a || !p) return
    const projectImages = await a.compose.reorderImages(p.id, imageIds)
    set({ projectImages })
  },
  setMedia: async (patch) => {
    const a = api()
    const p = get().activeProject
    if (!a || !p) return
    const project = await a.compose.setMedia(p.id, patch)
    if (project) set({ activeProject: project })
  },
  setCaptions: async (patch) => {
    const a = api()
    const p = get().activeProject
    if (!a || !p) return
    const project = await a.compose.setCaptions(p.id, patch)
    if (project) set({ activeProject: project })
  },
  runTranscribe: async () => {
    const a = api()
    const p = get().activeProject
    if (!a || !p || get().transcribing) return
    set({ transcribing: true, transcribeError: '', transcribeMessage: 'Starting' })
    try {
      const transcript = await a.transcribe.run(p.id)
      set({ transcript, transcribeError: '', transcribeMessage: 'Done' })
    } catch (e) {
      set({ transcribeError: (e as Error).message, transcribeMessage: '' })
    } finally {
      set({ transcribing: false })
    }
  },
  toggleWordEmphasis: async (wordId) => {
    const a = api()
    const p = get().activeProject
    if (!a || !p) return
    await a.transcribe.toggleEmphasis(wordId)
    set({ transcript: await a.transcribe.get(p.id) })
  },
  sendActiveToRender: async () => {
    const a = api()
    const p = get().activeProject
    if (!a || !p) return
    await a.compose.sendToRender(p.id)
    await Promise.all([get().loadActivity(), get().loadRenderJobs()])
  },

  loadRenderJobs: async () => {
    const a = api()
    if (a) set({ renderJobs: await a.render.jobs() })
  },
  renderAll: async () => {
    const a = api()
    if (!a) return
    set({ rendering: true })
    try {
      await a.render.all()
      await Promise.all([get().loadRenderJobs(), get().loadActivity()])
    } finally {
      set({ rendering: false })
    }
  },
  cancelJob: async (id) => {
    const a = api()
    if (!a) return
    await a.render.cancel(id)
    await get().loadRenderJobs()
  },

  loadProfiles: async () => {
    const a = api()
    if (a) set({ profiles: await a.db.profiles() })
  },
  runProfile: async (id) => {
    const a = api()
    if (!a) return []
    set({ runningProfileId: id })
    try {
      const projectIds = await a.automation.runProfile(id, false)
      // open the first new project for quick-edit, then refresh
      if (projectIds[0]) await get().openProjectById(projectIds[0])
      await Promise.all([get().loadDownloads(), get().loadProfiles(), get().loadActivity()])
      return projectIds
    } finally {
      set({ runningProfileId: null })
    }
  },
  saveProfile: async (p) => {
    const a = api()
    if (!a) return
    const profiles = await a.automation.upsertProfile(p)
    set({ profiles })
  },
  deleteProfile: async (id) => {
    const a = api()
    if (!a) return
    const profiles = await a.automation.deleteProfile(id)
    set({ profiles })
  },
  runNow: async () => {
    const a = api()
    if (!a) return
    await a.automation.tick()
    await Promise.all([get().loadActivity(), get().loadRenderJobs(), get().loadProfiles()])
  }
}))
