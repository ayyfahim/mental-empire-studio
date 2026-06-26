// Domain + IPC types shared between the Electron main process and the React renderer.
// The native backend (yt-dlp, ffmpeg, scraper, scheduler) is wired in later milestones;
// these types define the contract the UI is built against now.

export type AccentName = 'Amber' | 'Violet' | 'Emerald' | 'Crimson'

export type ScreenKey =
  | 'library'
  | 'channels'
  | 'download'
  | 'compose'
  | 'thumb'
  | 'render'
  | 'profiles'
  | 'settings'

export type UploadStatus = 'Uploaded' | 'Scheduled' | 'Draft'

export interface MyChannel {
  id: string
  name: string
  handle: string
  mono: string
  avatar: string
  views: string
  subs: string
  total: number
  /** id of the linked SourceChannel this channel republishes from */
  linkedSourceId?: string
  source: string
  mapDone: number
  mapTotal: number
  weekDone: number
  weekGoal: number
  monthDone: number
  monthGoal: number
  reminder: string
  reminderNote: string
  /** ISO timestamp of the last successful scrape (M3) */
  lastScrapedAt?: string
}

export interface SourceChannel {
  id: string
  url: string
  handle: string
  name: string
}

export interface DownloadedVideo {
  id: string
  sourceId: string
  title: string
  channel: string
  size: string
  when: string
  /** pipeline stage label, e.g. "Downloaded only" | "Needs thumbnail" | "Captioned" | "Uploaded" */
  stage: string
  pct: string
  action: 'Resume' | 'Open'
  thumb: string
  /** id of the Upload this download was fuzzy-matched to (M3 mapping) */
  matchedUploadId?: string
  /** absolute path to the downloaded mp3 (M4) */
  filePath?: string
  /** probed audio duration in seconds (M4) */
  durationSec?: number
}

/** A video published on one of my own channels (scraped from its uploads tab). */
export interface Upload {
  id: string
  myChannelId: string
  title: string
  youtubeVideoId: string
  publishedAt: string
  views: string
  thumb?: string
  /** id of the DownloadedVideo this upload was fuzzy-matched to, if any */
  matchedDownloadId?: string
}

// ---- Scraping (M3) ----
export type ScrapeOrder = 'Popular' | 'Latest' | 'Oldest'

/** One video parsed from a yt-dlp flat-playlist entry. */
export interface ScrapedVideo {
  id: string
  title: string
  durationSec: number
  views: number
  uploadDate: string
  thumb: string
}

/** Channel-level stats + video list returned by a scrape. */
export interface ScrapedChannel {
  handle: string
  name: string
  channelId: string
  subs: number
  /** lifetime views — best-effort (about page) with a labeled fallback to summed video views */
  totalViews: number
  totalViewsExact: boolean
  videos: ScrapedVideo[]
}

/** Streamed progress for a long scrape (one channel at a time). */
export interface ScrapeProgress {
  channelId: string
  channelName: string
  phase: 'start' | 'stats' | 'uploads' | 'mapping' | 'done' | 'error'
  message: string
}

/** Result of fuzzy-matching downloaded source videos against my uploads. */
export interface MappingResult {
  mapDone: number
  mapTotal: number
  matches: { downloadId: string; uploadId: string }[]
}

/** A channel flagged as behind pace by the reminder check. */
export interface ReminderHit {
  channelId: string
  channelName: string
  pending: number
  message: string
}

/** A row for the Library "Recent uploads" table (upload joined with its channel). */
export interface RecentUpload {
  title: string
  channel: string
  views: string
  publishedAt: string
  thumb?: string
}

export interface GoalsPatch {
  weekGoal?: number
  monthGoal?: number
  reminder?: string
  reminderNote?: string
}

export interface Profile {
  id: string
  name: string
  mono: string
  avatar: string
  // display labels (shown on the profile card)
  rule: string
  images: string
  thumb: string
  cap: string
  out: string
  autoWatch: boolean
  /** id of the ThumbnailTemplate locked to this profile (M5) */
  thumbnailTemplateId?: string
  // ---- structured run config (M7) ----
  linkedSourceId?: string
  sourceUrl: string
  sourceOrder: ScrapeOrder
  sourceCount: number
  imageMode: ImageMode
  poolSize: number
  kenBurns: boolean
  captionPreset: string
  captionAspect: '16:9' | '1:1' | '9:16'
  outputFolder?: string
  /** newest source video id already processed — the auto-watch cursor */
  lastSeenVideoId?: string
  lastRunAt?: string
  /** beta-feature defaults applied to videos this profile produces */
  betaOpts?: BetaVideoOpts
}

/** Live status streamed while a profile runs (interactive or hands-free). */
export interface AutomationEvent {
  profileId: string
  profileName: string
  phase: 'start' | 'scraping' | 'downloading' | 'composing' | 'queued' | 'done' | 'error'
  message: string
  /** project ids created this run (for the interactive quick-edit) */
  projectIds?: string[]
}

// ---- Thumbnail editor model (req #4) ----
export type LayerKind = 'background' | 'subject' | 'text' | 'shape'

/** Logical-pixel geometry on the 1280×720 thumbnail stage. */
export interface LayerFrame {
  x: number
  y: number
  width: number
  height: number
  rotation: number
}

/** Logical stage size — 16:9 at 1280×720. */
export const THUMB_W = 1280
export const THUMB_H = 720

export interface BaseLayer {
  id: string
  kind: LayerKind
  name: string
  visible: boolean
  locked: boolean
  frame: LayerFrame
}

// ---- Customizable layer effects (shared by subject PNG + text) ----
// Each effect is independently toggleable with size / opacity / colour, plus a
// distance + angle for drop shadows. Replaces the old on/off booleans.
export interface FxShadow { enabled: boolean; color: string; size: number; opacity: number; distance: number; angle: number }
export interface FxGlow { enabled: boolean; color: string; size: number; opacity: number }
export interface FxOutline { enabled: boolean; color: string; size: number; opacity: number }

export const DEFAULT_SHADOW: FxShadow = { enabled: false, color: '#000000', size: 16, opacity: 0.6, distance: 10, angle: 45 }
export const DEFAULT_GLOW: FxGlow = { enabled: false, color: '#ffffff', size: 26, opacity: 0.85 }
export const DEFAULT_OUTLINE: FxOutline = { enabled: false, color: '#ffffff', size: 6, opacity: 1 }

/** Coerce a legacy boolean (or partial object) into a full effect object, so old
 *  saved templates keep rendering after the on/off → params upgrade. */
export function asShadow(v: unknown, color = DEFAULT_SHADOW.color): FxShadow {
  if (v && typeof v === 'object') return { ...DEFAULT_SHADOW, color, ...(v as Partial<FxShadow>) }
  return { ...DEFAULT_SHADOW, color, enabled: !!v }
}
export function asGlow(v: unknown, color = DEFAULT_GLOW.color): FxGlow {
  if (v && typeof v === 'object') return { ...DEFAULT_GLOW, color, ...(v as Partial<FxGlow>) }
  return { ...DEFAULT_GLOW, color, enabled: !!v }
}
export function asOutline(v: unknown, color = DEFAULT_OUTLINE.color, size = DEFAULT_OUTLINE.size): FxOutline {
  if (v && typeof v === 'object') return { ...DEFAULT_OUTLINE, color, size, ...(v as Partial<FxOutline>) }
  return { ...DEFAULT_OUTLINE, color, size, enabled: !!v }
}

export interface TextLayer extends BaseLayer {
  kind: 'text'
  text: string
  lines: { text: string; size: number }[]
  highlightWord?: string
  highlightColor: string
  highlightSquare: boolean
  color: string
  fontFamily: string
  align: 'left' | 'center' | 'right'
  effects: { shadow: FxShadow; stroke: FxOutline; glow: FxGlow; caps: boolean }
}

export interface SubjectLayer extends BaseLayer {
  kind: 'subject'
  /** path or data URL of the user-supplied PNG (no cutout — transparency as authored) */
  src: string
  outline: FxOutline
  shadow: FxShadow
  glow: FxGlow
}

export interface ShapeLayer extends BaseLayer {
  kind: 'shape'
  shape: 'rect' | 'circle' | 'arrow'
  color: string
}

export interface BackgroundLayer extends BaseLayer {
  kind: 'background'
  fill: string
  mode: 'solid' | 'gradient' | 'image'
  /** path or data URL when mode === 'image' */
  src?: string
}

export type ThumbnailLayer = TextLayer | SubjectLayer | ShapeLayer | BackgroundLayer

export interface ThumbnailTemplate {
  id: string
  name: string
  layers: ThumbnailLayer[]
}

export interface ActivityRow {
  t: string
  icon: string
  color: string
  text: string
}

// ---- Compose projects (M4) ----
export type ImageMode = 'sequence' | 'pool'

export interface ProjectImage {
  id: string
  projectId: string
  ord: number
  path: string
  thumb: string
  rangeStart: number
  rangeEnd: number
  manual: boolean
}

export interface TranscriptWord {
  id: string
  projectId: string
  ord: number
  word: string
  start: number
  end: number
  emphasis: boolean
}

// ---- Beta features (gated behind settings.beta.enabled) ----
// Stored as one JSON column (betaOpts) on projects + profiles, so adding fields
// across phases needs no DB migration. Phase 1 = hook/highlight/overlay/zoom;
// phase 2 = b-roll pool; phase 3 = style + effect plan.
export type VideoStyle = 'None' | 'Cinematic' | 'Intense' | 'Heartfelt' | 'Clean'
export type BrollDensity = 'full' | 'sparse' | 'keywords'

export interface BetaVideoOpts {
  /** intro text card shown for the first few seconds ('' text → auto from transcript) */
  hook: { enabled: boolean; text: string }
  /** auto-emphasize detected keywords in captions (maps to project.keywords) */
  autoHighlight: boolean
  /** simple darkening gradient on the chosen edges, for caption/subject legibility */
  overlay: { bottom: boolean; top: boolean; left: boolean; right: boolean }
  /** automatic zoom — at the start, and/or punch-zoom on emphasized words */
  autoZoom: { atStart: boolean; atKeyPhrases: boolean }
  // ---- phase 2: themed b-roll pool ----
  broll: { enabled: boolean; density: BrollDensity; poolSize: number; mode: 'full' | 'overlay' }
  // ---- phase 3: style + transition/text-effect plan ----
  style: VideoStyle
  /** optional manual/LLM-generated effect plan JSON (overrides the style's rule engine) */
  effectPlanJson: string
}

export const DEFAULT_BETA_OPTS: BetaVideoOpts = {
  hook: { enabled: false, text: '' },
  autoHighlight: false,
  overlay: { bottom: false, top: false, left: false, right: false },
  autoZoom: { atStart: false, atKeyPhrases: false },
  broll: { enabled: false, density: 'sparse', poolSize: 18, mode: 'full' },
  style: 'None',
  effectPlanJson: ''
}

/** Merge a possibly-partial/legacy betaOpts onto the defaults (deep, for nested groups). */
export function asBetaOpts(v: unknown): BetaVideoOpts {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<BetaVideoOpts>
  return {
    ...DEFAULT_BETA_OPTS,
    ...o,
    hook: { ...DEFAULT_BETA_OPTS.hook, ...(o.hook ?? {}) },
    overlay: { ...DEFAULT_BETA_OPTS.overlay, ...(o.overlay ?? {}) },
    autoZoom: { ...DEFAULT_BETA_OPTS.autoZoom, ...(o.autoZoom ?? {}) },
    broll: { ...DEFAULT_BETA_OPTS.broll, ...(o.broll ?? {}) }
  }
}

/** One compose project = a downloaded mp3 + its image/caption recipe, headed for render. */
export interface Project {
  id: string
  downloadId: string
  title: string
  channel: string
  mp3Path: string
  durationSec: number
  imageMode: ImageMode
  poolSize: number
  kenBurns: boolean
  seed: number
  crossfade: boolean
  captionPreset: string
  captionFont: string
  captionAnim: string
  captionAspect: '16:9' | '1:1' | '9:16'
  emphasis: boolean
  keywords: boolean
  punchZoom: boolean
  stage: string
  createdAt: string
  /** beta-feature options (hook/highlight/overlay/zoom/b-roll/style). Always present
   *  from the DB; optional on the type so construction-site literals stay terse. */
  betaOpts?: BetaVideoOpts
}

export interface DownloadProgress {
  downloadId: string
  title: string
  pct: number
  stage: string
  done: boolean
  error?: string
}

export interface TranscribeProgress {
  projectId: string
  phase: 'start' | 'uploading' | 'transcribing' | 'done' | 'error'
  message: string
  error?: string
}

/** Options for a download batch (from the Download picker header). */
export interface DownloadOptions {
  bitrate: number
  sourceUrl: string
}

// ---- Render pipeline (M6) ----
export type RenderStatus = 'queued' | 'rendering' | 'done' | 'error'

export interface RenderJob {
  id: string
  title: string
  channel: string
  status: RenderStatus
  pct: number
  projectId: string
  outputPath?: string
  error?: string
  createdAt: string
}

export interface RenderProgress {
  jobId: string
  pct: number
  stage: string
  done: boolean
  error?: string
  outputPath?: string
}

/** A render_jobs row joined with its project for the Render Queue checklist. */
export interface RenderQueueRow {
  job: RenderJob
  images: number
  hasMp3: boolean
  hasThumb: boolean
  hasCaptions: boolean
  isReady: boolean
  missing: string[]
  projectDurationSec: number
  firstImagePath?: string
}


// ---- Settings (persisted via electron-store) ----
export interface AppSettings {
  accent: AccentName
  ambientGlow: boolean
  showActivityRail: boolean
  defaultScreen: ScreenKey
  namingTemplate: string
  /** where downloads + renders are written; empty = <Downloads>/MentalEmpire_out */
  outputFolder: string
  concurrency: number
  quality: '720p' | '1080p' | '1440p'
  autoScrape: { enabled: boolean; frequency: string; delaySec: number; retries: number; proxy: string; cookiesPath: string }
  background: { tray: boolean; startOnSignIn: boolean; notifications: boolean; webhook: string }
  transcription: { apiKey: string; model: string }
  /** experimental features + stock-footage API keys (gated; default off) */
  beta: { enabled: boolean; pexelsKey: string; pixabayKey: string; coverrKey: string }
}

/** Canonical defaults — shared by the main-process store and the renderer's initial state. */
export const DEFAULT_SETTINGS: AppSettings = {
  accent: 'Amber',
  ambientGlow: true,
  showActivityRail: true,
  defaultScreen: 'library',
  namingTemplate: '{channel} - {title}',
  outputFolder: '',
  concurrency: 2,
  quality: '1080p',
  autoScrape: { enabled: true, frequency: 'Every 6 hours', delaySec: 1.5, retries: 3, proxy: '', cookiesPath: '' },
  background: { tray: true, startOnSignIn: false, notifications: true, webhook: '' },
  transcription: { apiKey: '', model: 'whisper-large-v3-turbo' },
  beta: { enabled: false, pexelsKey: '', pixabayKey: '', coverrKey: '' }
}

/** Recursive partial — used for settings patches that touch only nested keys. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

// ---- Native bridge surface ----
export interface NativeApi {
  platform: NodeJS.Platform | 'web'
  /** the running app version (from package.json / app.getVersion()) */
  appVersion: string
  minimize(): void
  maximize(): void
  close(): void
  /** reveal the log file in the OS file manager (for bug reports) */
  openLogs(): Promise<string>
  /** absolute path of the current log file */
  logPath(): Promise<string>
  settings: {
    get(): Promise<AppSettings>
    set(patch: DeepPartial<AppSettings>): Promise<AppSettings>
    /** factory reset: settings → defaults and wipe all projects/profiles/channels/jobs */
    reset(): Promise<AppSettings>
  }
  effects: {
    /** beta: generate a validated effect-plan JSON for a project via Groq */
    generate(projectId: string, style: VideoStyle): Promise<string>
  }
  db: {
    myChannels(): Promise<MyChannel[]>
    sourceChannels(): Promise<SourceChannel[]>
    downloads(): Promise<DownloadedVideo[]>
    profiles(): Promise<Profile[]>
    templates(): Promise<ThumbnailTemplate[]>
    activity(): Promise<ActivityRow[]>
    upsertProfile(profile: Profile): Promise<Profile[]>
    saveTemplate(template: ThumbnailTemplate): Promise<ThumbnailTemplate[]>
    recentUploads(limit?: number): Promise<RecentUpload[]>
    updateChannelGoals(id: string, patch: GoalsPatch): Promise<MyChannel[]>
  }
  scrape: {
    /** preview a channel's stats without persisting */
    channel(url: string): Promise<ScrapedChannel>
    /** scrape + persist a new owned channel, optionally linking a source */
    addMyChannel(url: string, linkedSourceId?: string): Promise<MyChannel>
    /** re-scrape one owned channel: stats, uploads, mapping */
    refreshChannel(id: string): Promise<MyChannel>
    /** re-scrape every owned channel */
    all(): Promise<MyChannel[]>
    /** fetch a source channel's videos for the Download picker (cached to DB) */
    sourceVideos(url: string, order: ScrapeOrder, count: number): Promise<ScrapedVideo[]>
  }
  reminders: {
    /** evaluate behind-pace channels, firing desktop notifications */
    check(): Promise<ReminderHit[]>
  }
  download: {
    /** download mp3s for the given source video ids; streams progress */
    start(videos: ScrapedVideo[], opts: DownloadOptions): Promise<DownloadedVideo[]>
    /** resume an unfinished download (skips if the file already exists) */
    resume(id: string): Promise<DownloadedVideo>
    /** reveal a downloaded file in the OS file manager */
    openFolder(id: string): Promise<void>
  }
  compose: {
    createProject(downloadId: string): Promise<Project>
    get(id: string): Promise<Project | null>
    list(): Promise<Project[]>
    images(projectId: string): Promise<ProjectImage[]>
    setImages(projectId: string, paths: string[]): Promise<ProjectImage[]>
    reorderImages(projectId: string, imageIds: string[]): Promise<ProjectImage[]>
    setRanges(projectId: string, ranges: { id: string; rangeStart: number; rangeEnd: number }[]): Promise<ProjectImage[]>
    setMedia(projectId: string, patch: Partial<Project>): Promise<Project>
    setCaptions(projectId: string, patch: Partial<Project>): Promise<Project>
    sendToRender(projectId: string): Promise<void>
  }
  transcribe: {
    run(projectId: string): Promise<TranscriptWord[]>
    get(projectId: string): Promise<TranscriptWord[]>
    updateWord(wordId: string, text: string): Promise<void>
    toggleEmphasis(wordId: string): Promise<void>
  }
  thumbnails: {
    /** persist a template (insert/update) and return the full library */
    saveTemplate(template: ThumbnailTemplate): Promise<ThumbnailTemplate[]>
    /** delete a template by id, return the remaining library */
    deleteTemplate(id: string): Promise<ThumbnailTemplate[]>
    /** list saved templates */
    templates(): Promise<ThumbnailTemplate[]>
    /** lock a template to a profile (subject/background/style reused per video) */
    assignToProfile(profileId: string, templateId: string): Promise<Profile[]>
    /** write a rasterized PNG (data URL) to the output folder; returns the file path */
    writePng(name: string, dataUrl: string): Promise<string>
  }
  render: {
    /** the queue as joined rows (job + project checklist) */
    jobs(): Promise<RenderQueueRow[]>
    /** render every queued job, honoring the concurrency setting */
    all(): Promise<void>
    /** cancel a queued/rendering job */
    cancel(jobId: string): Promise<void>
  }
  automation: {
    /** run a profile's pipeline; interactive returns new project ids for quick-edit */
    runProfile(profileId: string, headless?: boolean): Promise<string[]>
    /** create/update a profile */
    upsertProfile(profile: Profile): Promise<Profile[]>
    /** delete a profile */
    deleteProfile(profileId: string): Promise<Profile[]>
    /** trigger one scheduler tick now (Library "Run now") */
    tick(): Promise<void>
  }
  /** pick an output folder via the OS dialog; returns the chosen path or '' */
  chooseFolder(): Promise<string>
  /** resolve the absolute filesystem path of a picked/dropped File (Electron webUtils) */
  pathForFile(file: File): string
  /** subscribe to live scrape progress; returns an unsubscribe fn */
  onScrapeProgress(cb: (p: ScrapeProgress) => void): () => void
  /** subscribe to new activity-log entries; returns an unsubscribe fn */
  onActivity(cb: (row: ActivityRow) => void): () => void
  /** subscribe to download progress; returns an unsubscribe fn */
  onDownloadProgress(cb: (p: DownloadProgress) => void): () => void
  /** subscribe to transcription progress; returns an unsubscribe fn */
  onTranscribeProgress(cb: (p: TranscribeProgress) => void): () => void
  /** subscribe to render progress; returns an unsubscribe fn */
  onRenderProgress(cb: (p: RenderProgress) => void): () => void
  /** subscribe to profile-run events; returns an unsubscribe fn */
  onAutomation(cb: (e: AutomationEvent) => void): () => void
}

declare global {
  interface Window {
    api: NativeApi
  }
}
