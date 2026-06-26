import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  ActivityRow,
  AppSettings,
  DeepPartial,
  DownloadOptions,
  DownloadProgress,
  GoalsPatch,
  NativeApi,
  Profile,
  Project,
  ScrapeOrder,
  ScrapeProgress,
  ScrapedVideo,
  ThumbnailTemplate,
  TranscribeProgress,
  RenderProgress,
  AutomationEvent
} from '../shared/types'

/** Subscribe to a main→renderer event; returns an unsubscribe fn. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// All native capability is exposed here behind a typed `window.api`. The renderer
// never touches Node directly (contextIsolation on, nodeIntegration off).
const api: NativeApi = {
  platform: process.platform,
  appVersion: (ipcRenderer.sendSync('app:version') as string) ?? '',
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  openLogs: () => ipcRenderer.invoke('app:openLogs'),
  logPath: () => ipcRenderer.invoke('app:logPath'),

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch: DeepPartial<AppSettings>) => ipcRenderer.invoke('settings:set', patch),
    reset: () => ipcRenderer.invoke('app:reset')
  },

  effects: {
    generate: (projectId: string, style: string) => ipcRenderer.invoke('effects:generate', projectId, style)
  },

  db: {
    myChannels: () => ipcRenderer.invoke('db:myChannels'),
    sourceChannels: () => ipcRenderer.invoke('db:sourceChannels'),
    downloads: () => ipcRenderer.invoke('db:downloads'),
    profiles: () => ipcRenderer.invoke('db:profiles'),
    templates: () => ipcRenderer.invoke('db:templates'),
    activity: () => ipcRenderer.invoke('db:activity'),
    upsertProfile: (p: Profile) => ipcRenderer.invoke('db:upsertProfile', p),
    saveTemplate: (t: ThumbnailTemplate) => ipcRenderer.invoke('db:saveTemplate', t),
    recentUploads: (limit?: number) => ipcRenderer.invoke('db:recentUploads', limit),
    updateChannelGoals: (id: string, patch: GoalsPatch) => ipcRenderer.invoke('db:updateChannelGoals', id, patch)
  },

  scrape: {
    channel: (url: string) => ipcRenderer.invoke('scrape:channel', url),
    addMyChannel: (url: string, linkedSourceId?: string) =>
      ipcRenderer.invoke('scrape:addMyChannel', url, linkedSourceId),
    refreshChannel: (id: string) => ipcRenderer.invoke('scrape:refreshChannel', id),
    all: () => ipcRenderer.invoke('scrape:all'),
    sourceVideos: (url: string, order: ScrapeOrder, count: number) =>
      ipcRenderer.invoke('scrape:sourceVideos', url, order, count)
  },

  reminders: {
    check: () => ipcRenderer.invoke('reminders:check')
  },

  download: {
    start: (videos: ScrapedVideo[], opts: DownloadOptions) => ipcRenderer.invoke('download:start', videos, opts),
    resume: (id: string) => ipcRenderer.invoke('download:resume', id),
    openFolder: (id: string) => ipcRenderer.invoke('download:openFolder', id)
  },

  compose: {
    createProject: (downloadId: string) => ipcRenderer.invoke('compose:createProject', downloadId),
    get: (id: string) => ipcRenderer.invoke('compose:get', id),
    list: () => ipcRenderer.invoke('compose:list'),
    images: (projectId: string) => ipcRenderer.invoke('compose:images', projectId),
    setImages: (projectId: string, paths: string[]) => ipcRenderer.invoke('compose:setImages', projectId, paths),
    reorderImages: (projectId: string, imageIds: string[]) => ipcRenderer.invoke('compose:reorderImages', projectId, imageIds),
    setRanges: (projectId: string, ranges: { id: string; rangeStart: number; rangeEnd: number }[]) =>
      ipcRenderer.invoke('compose:setRanges', projectId, ranges),
    setMedia: (projectId: string, patch: Partial<Project>) => ipcRenderer.invoke('compose:setMedia', projectId, patch),
    setCaptions: (projectId: string, patch: Partial<Project>) => ipcRenderer.invoke('compose:setCaptions', projectId, patch),
    sendToRender: (projectId: string) => ipcRenderer.invoke('compose:sendToRender', projectId)
  },

  transcribe: {
    run: (projectId: string) => ipcRenderer.invoke('transcribe:run', projectId),
    get: (projectId: string) => ipcRenderer.invoke('transcribe:get', projectId),
    updateWord: (wordId: string, text: string) => ipcRenderer.invoke('transcribe:updateWord', wordId, text),
    toggleEmphasis: (wordId: string) => ipcRenderer.invoke('transcribe:toggleEmphasis', wordId)
  },

  thumbnails: {
    saveTemplate: (t: ThumbnailTemplate) => ipcRenderer.invoke('thumbnails:saveTemplate', t),
    deleteTemplate: (id: string) => ipcRenderer.invoke('thumbnails:deleteTemplate', id),
    templates: () => ipcRenderer.invoke('thumbnails:templates'),
    assignToProfile: (profileId: string, templateId: string) =>
      ipcRenderer.invoke('thumbnails:assignToProfile', profileId, templateId),
    writePng: (name: string, dataUrl: string) => ipcRenderer.invoke('thumbnails:writePng', name, dataUrl)
  },

  render: {
    jobs: () => ipcRenderer.invoke('render:jobs'),
    all: () => ipcRenderer.invoke('render:all'),
    cancel: (jobId: string) => ipcRenderer.invoke('render:cancel', jobId)
  },

  automation: {
    runProfile: (profileId: string, headless?: boolean) => ipcRenderer.invoke('automation:runProfile', profileId, headless),
    upsertProfile: (profile: Profile) => ipcRenderer.invoke('automation:upsertProfile', profile),
    deleteProfile: (profileId: string) => ipcRenderer.invoke('automation:deleteProfile', profileId),
    tick: () => ipcRenderer.invoke('automation:tick')
  },

  chooseFolder: () => ipcRenderer.invoke('fs:chooseFolder'),

  // Electron 32 removed the File.path property; webUtils.getPathForFile is the
  // supported way to get the absolute path of a dropped/picked file for the main
  // process (used to import images/audio in Compose).
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return (file as File & { path?: string }).path ?? ''
    }
  },

  onScrapeProgress: (cb: (p: ScrapeProgress) => void) => subscribe('scrape:progress', cb),
  onActivity: (cb: (row: ActivityRow) => void) => subscribe('activity:new', cb),
  onDownloadProgress: (cb: (p: DownloadProgress) => void) => subscribe('download:progress', cb),
  onTranscribeProgress: (cb: (p: TranscribeProgress) => void) => subscribe('transcribe:progress', cb),
  onRenderProgress: (cb: (p: RenderProgress) => void) => subscribe('render:progress', cb),
  onAutomation: (cb: (e: AutomationEvent) => void) => subscribe('automation:event', cb)
}

contextBridge.exposeInMainWorld('api', api)
