import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  ActivityRow,
  AppSettings,
  DeepPartial,
  DownloadOptions,
  DownloadProgress,
  GoalsPatch,
  NativeApi,
  Niche,
  Profile,
  Project,
  ScrapeOrder,
  ScrapeProgress,
  ScrapedVideo,
  SourceAutomationPatch,
  ThumbnailTemplate,
  TranscribeProgress,
  RenderProgress,
  AutomationEvent,
  AutomationJobDraft,
  AutomationJob
} from '../shared/types'
import type { ProviderConnection, ProviderJob, ProviderMotionQuery, TalkingPhotosAspectRatio, TalkingPhotosCreateInput, TalkingPhotosScriptCreateInput } from '../shared/talkingphotos'

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
    reset: () => ipcRenderer.invoke('app:reset'),
    softReset: () => ipcRenderer.invoke('app:softReset')
  },

  appMeta: {
    get: (key: string) => ipcRenderer.invoke('appMeta:get', key),
    set: (key: string, value: string) => ipcRenderer.invoke('appMeta:set', key, value)
  },

  caps: {
    get: (force?: boolean) => ipcRenderer.invoke('caps:get', !!force)
  },

  gpu: {
    status: () => ipcRenderer.invoke('gpu:status')
  },

  effects: {
    generate: (projectId: string, style: string) => ipcRenderer.invoke('effects:generate', projectId, style)
  },

  looks: {
    list: () => ipcRenderer.invoke('looks:list')
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
    updateChannelGoals: (id: string, patch: GoalsPatch) => ipcRenderer.invoke('db:updateChannelGoals', id, patch),
    setChannelSource: (id: string, linkedSourceId: string | null) => ipcRenderer.invoke('db:setChannelSource', id, linkedSourceId),
    deleteMyChannel: (id: string) => ipcRenderer.invoke('db:deleteMyChannel', id),
    workItems: () => ipcRenderer.invoke('db:workItems')
  },

  workItems: {
    detect: () => ipcRenderer.invoke('workItems:detect'),
    setUploaded: (videoId: string, uploaded: boolean) => ipcRenderer.invoke('workItems:setUploaded', videoId, uploaded),
    setArchived: (videoId: string, archived: boolean) => ipcRenderer.invoke('workItems:setArchived', videoId, archived)
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

  sources: {
    list: () => ipcRenderer.invoke('sources:list'),
    add: (url: string) => ipcRenderer.invoke('sources:add', url),
    refresh: (id: string) => ipcRenderer.invoke('sources:refresh', id),
    videos: (id: string) => ipcRenderer.invoke('sources:videos', id),
    markVisited: (id: string) => ipcRenderer.invoke('sources:markVisited', id),
    remove: (id: string) => ipcRenderer.invoke('sources:remove', id),
    setLinkedMyChannel: (id: string, myChannelId: string | null) =>
      ipcRenderer.invoke('sources:setLinkedMyChannel', id, myChannelId),
    setAutomation: (id: string, patch: SourceAutomationPatch) =>
      ipcRenderer.invoke('sources:setAutomation', id, patch)
  } satisfies NativeApi['sources'],

  reminders: {
    check: () => ipcRenderer.invoke('reminders:check')
  },

  download: {
    start: (videos: ScrapedVideo[], opts: DownloadOptions) => ipcRenderer.invoke('download:start', videos, opts),
    resume: (id: string) => ipcRenderer.invoke('download:resume', id),
    cancel: (id: string) => ipcRenderer.invoke('download:cancel', id),
    openFolder: (id: string) => ipcRenderer.invoke('download:openFolder', id),
    delete: (id: string) => ipcRenderer.invoke('download:delete', id)
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
    setImageMotion: (projectId: string, updates: Parameters<NativeApi['compose']['setImageMotion']>[1]) =>
      ipcRenderer.invoke('compose:setImageMotion', projectId, updates),
    setMedia: (projectId: string, patch: Partial<Project>) => ipcRenderer.invoke('compose:setMedia', projectId, patch),
    setCaptions: (projectId: string, patch: Partial<Project>) => ipcRenderer.invoke('compose:setCaptions', projectId, patch),
    updateLook: (projectId: string, patch: Parameters<NativeApi['compose']['updateLook']>[1]) => ipcRenderer.invoke('compose:updateLook', projectId, patch),
    updateMotion: (projectId: string, patch: Parameters<NativeApi['compose']['updateMotion']>[1]) => ipcRenderer.invoke('compose:updateMotion', projectId, patch),
    updateCaptions: (projectId: string, patch: Partial<Project>) => ipcRenderer.invoke('compose:updateCaptions', projectId, patch),
    previewSpec: (projectId: string, draftOverrides?: Partial<Project>) => ipcRenderer.invoke('compose:previewSpec', projectId, draftOverrides),
    posterFrame: (path: string) => ipcRenderer.invoke('compose:posterFrame', path),
    preview: (projectId: string) => ipcRenderer.invoke('compose:preview', projectId),
    sendToRender: (projectId: string) => ipcRenderer.invoke('compose:sendToRender', projectId)
  },

  transcribe: {
    run: (projectId: string) => ipcRenderer.invoke('transcribe:run', projectId),
    get: (projectId: string) => ipcRenderer.invoke('transcribe:get', projectId),
    updateWord: (wordId: string, text: string) => ipcRenderer.invoke('transcribe:updateWord', wordId, text),
    toggleEmphasis: (wordId: string) => ipcRenderer.invoke('transcribe:toggleEmphasis', wordId),
    setEmphasis: (wordIds: string[], emphasis: boolean) => ipcRenderer.invoke('transcribe:setEmphasis', wordIds, emphasis)
  },

  thumbnails: {
    saveTemplate: (t: ThumbnailTemplate) => ipcRenderer.invoke('thumbnails:saveTemplate', t),
    deleteTemplate: (id: string) => ipcRenderer.invoke('thumbnails:deleteTemplate', id),
    templates: () => ipcRenderer.invoke('thumbnails:templates'),
    assignToProfile: (profileId: string, templateId: string) =>
      ipcRenderer.invoke('thumbnails:assignToProfile', profileId, templateId),
    writePng: (name: string, dataUrl: string) => ipcRenderer.invoke('thumbnails:writePng', name, dataUrl),
    saveProjectThumb: (projectId: string, name: string, dataUrl: string) => ipcRenderer.invoke('thumbnails:saveProjectThumb', projectId, name, dataUrl)
  },

  render: {
    jobs: () => ipcRenderer.invoke('render:jobs'),
    all: () => ipcRenderer.invoke('render:all'),
    cancel: (jobId: string) => ipcRenderer.invoke('render:cancel', jobId),
    delete: (jobId: string) => ipcRenderer.invoke('render:delete', jobId),
    requeue: (jobId: string) => ipcRenderer.invoke('render:requeue', jobId),
    openFile: (jobId: string) => ipcRenderer.invoke('render:openFile', jobId),
    openFolder: (jobId: string) => ipcRenderer.invoke('render:openFolder', jobId)
  },

  assets: {
    list: () => ipcRenderer.invoke('assets:list'),
    import: (paths, context) => ipcRenderer.invoke('assets:import', paths, context)
  },

  publish: {
    list: () => ipcRenderer.invoke('publish:list'),
    reveal: (path: string) => ipcRenderer.invoke('publish:reveal', path),
    startDrag: (path: string) => ipcRenderer.send('publish:startDrag', path)
  },

  automation: {
    runProfile: (profileId: string, headless?: boolean) => ipcRenderer.invoke('automation:runProfile', profileId, headless),
    runSource: (sourceId: string, headless?: boolean) => ipcRenderer.invoke('automation:runSource', sourceId, headless),
    upsertProfile: (profile: Profile) => ipcRenderer.invoke('automation:upsertProfile', profile),
    deleteProfile: (profileId: string) => ipcRenderer.invoke('automation:deleteProfile', profileId),
    tick: () => ipcRenderer.invoke('automation:tick'),
    preflight: (draft: AutomationJobDraft) => ipcRenderer.invoke('automation:preflight', draft),
    createJob: (draft: AutomationJobDraft) => ipcRenderer.invoke('automation:createJob', draft),
    jobs: () => ipcRenderer.invoke('automation:jobs'),
    job: (id: string) => ipcRenderer.invoke('automation:job', id),
    pauseJob: (id: string) => ipcRenderer.invoke('automation:pauseJob', id),
    resumeJob: (id: string) => ipcRenderer.invoke('automation:resumeJob', id),
    cancelJob: (id: string) => ipcRenderer.invoke('automation:cancelJob', id),
    retryJob: (id: string) => ipcRenderer.invoke('automation:retryJob', id)
  },

  talkingPhotos: {
    connectionStatus: () => ipcRenderer.invoke('talkingphotos:connectionStatus'),
    connect: () => ipcRenderer.invoke('talkingphotos:connect'),
    reconnect: () => ipcRenderer.invoke('talkingphotos:reconnect'),
    disconnect: () => ipcRenderer.invoke('talkingphotos:disconnect'),
    capabilities: () => ipcRenderer.invoke('talkingphotos:capabilities'),
    languages: () => ipcRenderer.invoke('talkingphotos:languages'),
    voices: (languageCode: string) => ipcRenderer.invoke('talkingphotos:voices', languageCode),
    motions: (query: ProviderMotionQuery) => ipcRenderer.invoke('talkingphotos:motions', query),
    projects: () => ipcRenderer.invoke('talkingphotos:projects'),
    project: (remoteProjectId: string) => ipcRenderer.invoke('talkingphotos:project', remoteProjectId),
    sync: () => ipcRenderer.invoke('talkingphotos:sync'),
    jobs: () => ipcRenderer.invoke('talkingphotos:jobs'),
    createUploadedAudio: (input: TalkingPhotosCreateInput) => ipcRenderer.invoke('talkingphotos:createUploadedAudio', input),
    createScript: (input: TalkingPhotosScriptCreateInput) => ipcRenderer.invoke('talkingphotos:createScript', input),
    downloadOutput: (providerJobId: string) => ipcRenderer.invoke('talkingphotos:downloadOutput', providerJobId),
    subtitleLanguages: () => ipcRenderer.invoke('talkingphotos:subtitleLanguages'),
    createProviderSubtitles: (sourceJobId: string, language?: string) => ipcRenderer.invoke('talkingphotos:createProviderSubtitles', sourceJobId, language),
    applyLocalCaptions: (providerJobId: string, aspect?: TalkingPhotosAspectRatio) => ipcRenderer.invoke('talkingphotos:applyLocalCaptions', providerJobId, aspect),
    ttsRecoveryLibrary: () => ipcRenderer.invoke('talkingphotos:ttsRecoveryLibrary'),
    confirmRecoveredTts: (jobId: string, mediaId: string, durationSec: number) => ipcRenderer.invoke('talkingphotos:confirmRecoveredTts', jobId, mediaId, durationSec)
  },

  chooseFolder: () => ipcRenderer.invoke('fs:chooseFolder'),

  // Master library: dry-run the reorganize-existing migration, then execute it.
  library: {
    previewReorg: () => ipcRenderer.invoke('library:previewReorg'),
    reorganize: () => ipcRenderer.invoke('library:reorganize')
  },

  // Niche b-roll pools (P3)
  niche: {
    list: () => ipcRenderer.invoke('niche:list'),
    poolHealth: () => ipcRenderer.invoke('niche:poolHealth'),
    refreshAll: () => ipcRenderer.invoke('niche:refreshAll'),
    save: (n: Partial<Niche>) => ipcRenderer.invoke('niche:save', n),
    remove: (id: string) => ipcRenderer.invoke('niche:delete', id),
    assignChannel: (channelId: string, nicheId: string | null) => ipcRenderer.invoke('niche:assignChannel', channelId, nicheId),
    warm: (id: string) => ipcRenderer.invoke('niche:warm', id)
  },

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
  onAutomation: (cb: (e: AutomationEvent) => void) => subscribe('automation:event', cb),
  onAutomationJob: (cb: (job: AutomationJob) => void) => subscribe('automation:job', cb),
  onProviderJob: (cb: (job: ProviderJob) => void) => subscribe('talkingphotos:job', cb),
  onConnectionStatusChanged: (cb: (connection: ProviderConnection) => void) => subscribe('talkingphotos:connectionStatus', cb)
}

contextBridge.exposeInMainWorld('api', api)
