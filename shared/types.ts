// Domain + IPC types shared between the Electron main process and the React renderer.
// The native backend (yt-dlp, ffmpeg, scraper, scheduler) is wired in later milestones;
// these types define the contract the UI is built against now.

import type { GpuRenderSpec } from './renderSpec'
import type { GpuEngineStatus } from './gpuStatus'
import type {
  ProviderCapabilities,
  ProviderConnection,
  ProviderJob,
  ProviderLanguage,
  ProviderMotion,
  ProviderMotionQuery,
  ProviderProjectSummary,
  ProviderVoice,
  TalkingPhotosAspectRatio,
  TalkingPhotosCreateInput,
  TalkingPhotosRemoteMedia,
  TalkingPhotosScriptCreateInput
} from './talkingphotos'

export type AccentName = 'Amber' | 'Violet' | 'Emerald' | 'Crimson'

export type ScreenKey =
  | 'home'
  | 'library'
  | 'workspace'
  | 'channels'
  | 'sources'
  | 'download'
  | 'compose'
  | 'thumb'
  | 'render'
  | 'publish'
  | 'niches'
  | 'profiles'
  | 'settings'
  | 'talking-video'

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
  avatar?: string
  lastScrapedAt?: string
  lastVisitedAt?: string
  lastSeenVideoId?: string
  linkedMyChannelId?: string
  videoCount?: number
  cachedVideoCount?: number
  newVideoCount?: number
  /** assigned b-roll niche pool (id of a Niche); videos from this channel use its pool */
  nicheId?: string
  /** source-owned automation config (Workflow P5); legacy profiles remain as shims. */
  autoWatch?: boolean
  autoQueueRender?: boolean
  sourceOrder?: ScrapeOrder
  sourceCount?: number
  imageMode?: ImageMode
  poolSize?: number
  kenBurns?: boolean
  captionPreset?: string
  captionFont?: string
  captionAnim?: string
  captionAspect?: '16:9' | '1:1' | '9:16'
  captionLines?: 1 | 2 | 3
  captionPosition?: 'top' | 'middle' | 'bottom'
  captionPace?: 'auto' | 'word' | 'phrase'
  captionHighlightColor?: string
  captionBoxColor?: string
  captionWordsPerPage?: 1 | 2 | 3
  outputFolder?: string
  thumbnailTemplateId?: string
  lastRunAt?: string
  betaOpts?: BetaVideoOpts
}

export type SourceAutomationPatch = Partial<Pick<SourceChannel,
  'autoWatch' | 'autoQueueRender' | 'sourceOrder' | 'sourceCount' | 'imageMode' | 'poolSize' | 'kenBurns'
  | 'captionPreset' | 'captionFont' | 'captionAnim' | 'captionAspect' | 'captionLines' | 'captionPosition'
  | 'captionPace' | 'captionHighlightColor' | 'captionBoxColor' | 'captionWordsPerPage' | 'outputFolder'
  | 'thumbnailTemplateId' | 'betaOpts'
>>

/** A global, user-curated b-roll niche/theme pool (workflow plan §4). Channels are
 *  assigned to a niche; renders pull clips from the niche's pool first. */
export interface Niche {
  id: string
  name: string
  /** search phrases used to fill the pool (e.g. "toxic relationship", "city at night") */
  keywords: string[]
  orientation: 'landscape' | 'portrait' | 'any'
  /** how many clips to keep cached in the pool */
  targetClips: number
  createdAt: string
  updatedAt: string
}

/** Health summary for a niche's b-roll pool (clip count + freshness). */
export interface NichePoolHealth {
  nicheId: string
  clips: number
  keywords: string[]
  updatedAt?: string
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
  /** last download failure, shown inline in Download */
  error?: string
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
  /** channel avatar/thumbnail URL from yt-dlp (may be absent for some channels) */
  avatar?: string
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

/** A row for recent uploads (upload joined with its channel). */
export interface RecentUpload {
  title: string
  channel: string
  views: string
  publishedAt: string
  thumb?: string
}

/** An image previously used in some project, kept around so a later project targeting the
 *  same channel can reuse the same set instead of re-picking from disk. */
export interface LibraryAsset {
  /** Stable content-addressed id. Legacy rows derive this during migration. */
  id: string
  /** Canonical shared-library file. `path` is retained as a compatibility alias. */
  path: string
  canonicalPath: string
  originalPath?: string
  sourceId?: string
  channel: string
  channelHandle?: string
  channelAvatar?: string
  thumbnailPath?: string
  mimeType?: string
  width?: number
  height?: number
  fileSize?: number
  addedAt: string
  firstAddedAt: string
  lastUsedAt: string
  usageCount: number
  missing: boolean
  projectId?: string
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
  /** auto-queue every produced video for render at the end of an (interactive) run,
   *  so a profile can go fully hands-free: scrape → download → caption → render. */
  autoQueueRender?: boolean
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
  captionFont?: string
  captionAnim?: string
  captionAspect: '16:9' | '1:1' | '9:16'
  captionLines?: 1 | 2 | 3
  captionPosition?: 'top' | 'middle' | 'bottom'
  captionPace?: 'auto' | 'word' | 'phrase'
  /** active/highlighted caption text colour (#rrggbb); Submagic uses this inside the box */
  captionHighlightColor?: string
  /** active-word caption box colour (#rrggbb), used by Submagic-style captions */
  captionBoxColor?: string
  /** Submagic phrase window size: 1-3 words per page */
  captionWordsPerPage?: 1 | 2 | 3
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
  phase: 'start' | 'scraping' | 'downloading' | 'composing' | 'transcribing' | 'queued' | 'done' | 'error'
  message: string
  /** 0-100 profile/source pipeline progress for the Profiles card. */
  progress?: number
  /** Current item count for batch stages such as downloads/transcription. */
  step?: { current: number; total: number; label?: string }
  /** project ids created this run (for the interactive quick-edit) */
  projectIds?: string[]
}

// ---- Durable goal-based automation (persistent local worker) ----
export type AutomationGoal =
  | 'source-to-export'
  | 'talkingphotos-video'
  | 'download-edit'
  | 'long-to-shorts'
  | 'images-to-video'
  | 'transcribe-subtitle'
  | 'multi-platform'
  | 'batch-source'
  | 'apply-style'
  | 'review-export'

export type AutomationJobStatus =
  | 'queued'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'attention'
  | 'completed'
  | 'completed_with_warnings'
  | 'failed'
  | 'cancelled'

export type AutomationStepStatus = 'pending' | 'running' | 'completed' | 'warning' | 'skipped' | 'failed' | 'paused'
export type AutomationItemStatus = 'waiting' | 'processing' | 'completed' | 'warning' | 'skipped' | 'failed' | 'cancelled'
export type AutomationErrorKind =
  | 'temporary'
  | 'user_action'
  | 'unsupported_input'
  | 'missing_asset'
  | 'authentication'
  | 'download'
  | 'transcription'
  | 'editing'
  | 'export'
  | 'storage'
  | 'connection'
  | 'interruption'
  | 'resource'

export interface AutomationRules {
  minDurationSec: number
  skipDownloaded: boolean
  continueOnError: boolean
  maxRetries: number
  minimumFreeSpaceGb: number
  captions: boolean
  autoBroll: boolean
  removeSilence: boolean
  reduceFillerWords: boolean
  keepAwake: boolean
  /** Skip videos already published to the linked owned channel. */
  skipUploaded: boolean
  /** Explicit selections are never substituted unless this opt-in is true. */
  fillSkippedSelections: boolean
  allowStaleUploadCache: boolean
  uploadFreshnessMinutes: number
  /** Delay immediately before a real YouTube request; cache/local paths bypass it. */
  downloadDelaySec: number
  retryBaseDelaySec: number
  retryMaxDelaySec: number
}

export type AutomationBrollFallbackPolicy = 'selected-only' | 'prefer-selected' | 'all-sources'
export type AutomationBrollShufflePolicy = 'per-video' | 'ranked'
export type AutomationGradientEdge = 'none' | 'top' | 'bottom' | 'left' | 'right'

/** One shared style contract from setup through project, preview, and final render. */
export interface AutomationStyleConfig {
  videoStyle: VideoStyle
  captionPreset: string
  captionFont: string
  captionAnimation: string
  captionPosition: 'top' | 'middle' | 'bottom'
  captionOffsetY?: number
  captionLines: 1 | 2 | 3
  captionPace: 'auto' | 'word' | 'phrase'
  wordsPerCaption: 1 | 2 | 3
  highlightColor: string
  boxColor: string
  imageMode: ImageMode
  crossfadeSec: number
  motionPreset: MotionPreset
  gradientEdge: AutomationGradientEdge
  gradientIntensity: number
  aspectRatio: '16:9' | '1:1' | '9:16'
  brollMode: 'off' | 'full' | 'overlay'
  brollDensity: BrollDensity
  brollPoolSize: number
  brollPoolKey?: string
  brollFallbackPolicy: AutomationBrollFallbackPolicy
  brollShufflePolicy: AutomationBrollShufflePolicy
}

export type AutomationUploadMatchType = 'exact-id' | 'high-title' | 'ambiguous-title' | 'manual' | 'none'
export interface AutomationSelectionDecision {
  videoId: string
  title: string
  matchType: AutomationUploadMatchType
  score: number
  action: 'selected' | 'skipped-uploaded' | 'eligible-ambiguous' | 'excluded-duration'
  matchedUploadId?: string
  matchedTitle?: string
}

export interface AutomationItemStepState {
  attempts: number
  status: 'pending' | 'completed' | 'warning' | 'failed'
  checkpoint?: Record<string, unknown>
  error?: string
}

export interface AutomationJobConfig {
  /** Where the production media comes from. Legacy jobs default to saved-source. */
  sourceKind: 'saved-source' | 'youtube-url' | 'local-files'
  sourceId: string
  sourceUrl: string
  sourceName: string
  sourceOrder: ScrapeOrder
  sourceCount: number
  /** Optional explicit source video ids; empty means apply the automatic selection rules. */
  selectedVideoIds: string[]
  /** Local audio/video files selected by the user. Empty for YouTube-backed jobs. */
  localMediaPaths: string[]
  assetPaths: string[]
  style: VideoStyle
  captionPreset: string
  aspectRatios: Array<'16:9' | '1:1' | '9:16'>
  /** Canonical style contract. Legacy mirrors above remain readable. */
  styleConfig: AutomationStyleConfig
  rules: AutomationRules
  /** TalkingPhotos-specific settings. The first assetPath is the character
   * reference image; source downloads/local files provide the uploaded audio. */
  talkingPhotos?: {
    characterPrompt: string
    characterNegativePrompt: string
    style: 'normal' | 'high_quality'
    aspectRatio: '16:9' | '1:1' | '9:16'
    motionId: number
    /** 'uploaded-audio' (default) preserves the original behavior exactly — real
     *  downloaded/local audio submitted as-is. 'custom-script' feeds `script` through
     *  TTS. 'transcript-tts' reconstructs a script from the item's own transcript and
     *  feeds that through TTS instead of the original audio. */
    mode: 'uploaded-audio' | 'custom-script' | 'transcript-tts'
    script: string
    language: string
    voice: string
    voiceStyle: string
    speed: number
    pitch: number
    subtitleMode: 'none' | 'provider' | 'local'
  }
  notify: { desktop: boolean; webhook: boolean; sound: boolean; email: boolean }
  execution: 'local'
  scheduledFor?: string
}

export interface AutomationJobDraft {
  name: string
  goal: AutomationGoal
  config: AutomationJobConfig
}

export interface AutomationWorkflowStep {
  id: string
  jobId: string
  key: string
  label: string
  description: string
  ord: number
  status: AutomationStepStatus
  progress: number
  attempts: number
  maxAttempts: number
  runsOn: 'local' | 'online-service' | 'cloud'
  optional: boolean
  startedAt?: string
  completedAt?: string
  error?: string
  checkpoint?: Record<string, unknown>
}

export interface AutomationJobItem {
  id: string
  jobId: string
  sourceVideoId: string
  title: string
  status: AutomationItemStatus
  currentStep: string
  progress: number
  attempts: number
  stepStates?: Record<string, AutomationItemStepState>
  selectionDecision?: AutomationSelectionDecision
  brollSeed?: number
  brollClipIds?: string[]
  retryAt?: string
  projectId?: string
  renderJobId?: string
  outputPath?: string
  warning?: string
  error?: string
  updatedAt: string
}

export interface AutomationJobLog {
  id: number
  jobId: string
  itemId?: string
  level: 'info' | 'warning' | 'error'
  message: string
  createdAt: string
}

export interface AutomationJob {
  id: string
  name: string
  goal: AutomationGoal
  status: AutomationJobStatus
  progress: number
  currentStep: string
  config: AutomationJobConfig
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  lastCheckpointAt?: string
  nextRetryAt?: string
  pauseRequested: boolean
  cancelRequested: boolean
  warningCount: number
  failedCount: number
  completedCount: number
  totalItems: number
  errorKind?: AutomationErrorKind
  error?: string
  result?: { outputPaths: string[]; summary: string }
}

export interface AutomationJobDetail extends AutomationJob {
  steps: AutomationWorkflowStep[]
  items: AutomationJobItem[]
  logs: AutomationJobLog[]
}

export interface AutomationPreflight {
  ok: boolean
  blockers: string[]
  warnings: string[]
  estimatedStorageGb: number
  estimatedMinutes: number
  sourceItems: number
  powerMessage: string
  appMessage: string
  uploadDataState?: 'fresh' | 'stale' | 'unavailable' | 'not-linked'
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
  /** @deprecated Use highlightWords instead. Kept for legacy template compat. */
  highlightWord?: string
  /** Words to highlight (multiple selection). Falls back to highlightWord for legacy. */
  highlightWords?: string[]
  /** V2 highlight-box controls; legacy highlightColor/highlightSquare stay for compat. */
  highlight?: TextHighlight
  highlightColor: string
  highlightSquare: boolean
  color: string
  fontFamily: string
  align: 'left' | 'center' | 'right'
  /** Custom gap between uniform line boxes in px. undefined = auto-calculated. */
  lineGap?: number
  /** Legacy uniform line-height multiplier (× the largest line's size). */
  lineHeight?: number
  effects: { shadow: FxShadow; stroke: FxOutline; glow: FxGlow; caps: boolean }
}

export interface TextHighlight {
  enabled: boolean
  boxColor: string
  textColor: string
  radius: number
  padding: number
  opacity: number
}

export const DEFAULT_TEXT_HIGHLIGHT: TextHighlight = {
  enabled: false,
  boxColor: '#ffffff',
  textColor: '#111111',
  radius: 0,
  padding: 6,
  opacity: 1
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
  /** optional darkening gradient scrim painted above the background for text legibility.
   *  size = extent as a fraction of the stage (0–1), opacity = max alpha (0–1). */
  scrim?: { enabled: boolean; direction: 'bottom' | 'top' | 'left' | 'right'; size: number; opacity: number }
}

export const DEFAULT_SCRIM: NonNullable<BackgroundLayer['scrim']> = { enabled: false, direction: 'bottom', size: 0.5, opacity: 0.5 }

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
  /** optional per-image override; null/undefined inherits the project motion preset */
  motionPreset?: MotionPreset | null
  /** optional per-image motion path; null/undefined keeps the deterministic seeded direction */
  motionDirection?: MotionDirection | null
  /** optional per-image motion strength, 0-100; 50 equals the preset default */
  motionAmount?: number | null
}

export interface ProjectImageMotionPatch {
  id: string
  motionPreset?: MotionPreset | null
  motionDirection?: MotionDirection | null
  motionAmount?: number | null
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

// ---- Video effects options (project/profile scoped; defaults are no-op) ----
// Stored as one JSON column (betaOpts) on projects + profiles, so adding fields
// across phases needs no DB migration. Phase 1 = hook/highlight/overlay/zoom;
// phase 2 = b-roll pool; phase 3 = style + effect plan.
export type VideoStyle = 'None' | 'Cinematic' | 'Intense' | 'Heartfelt' | 'Clean'
export type BrollDensity = 'full' | 'sparse' | 'keywords'
export type MotionPreset = 'off' | 'subtle' | 'cinematic'
export type MotionDirection = 'auto' | 'push' | 'pull' | 'left' | 'right' | 'up' | 'down'
const VIDEO_STYLES: VideoStyle[] = ['None', 'Cinematic', 'Intense', 'Heartfelt', 'Clean']
const BROLL_DENSITIES: BrollDensity[] = ['full', 'sparse', 'keywords']

export interface BetaVideoOpts {
  /** intro text card shown for the first few seconds ('' text → auto from transcript) */
  hook: { enabled: boolean; text: string }
  /** auto-emphasize detected keywords in captions (maps to project.keywords) */
  autoHighlight: boolean
  /** simple darkening gradient on the chosen edges, for caption/subject legibility */
  overlay: { bottom: boolean; top: boolean; left: boolean; right: boolean; intensity: number }
  /** automatic zoom — at the start, and/or punch-zoom on emphasized words */
  autoZoom: { atStart: boolean; atKeyPhrases: boolean }
  // ---- phase 2: themed b-roll pool ----
  broll: {
    enabled: boolean
    density: BrollDensity
    poolSize: number
    mode: 'full' | 'overlay'
    poolKey?: string
    fallbackPolicy?: AutomationBrollFallbackPolicy
    shufflePolicy?: AutomationBrollShufflePolicy
    seed?: number
  }
  // ---- phase 3: style + transition/text-effect plan ----
  style: VideoStyle
  /** optional manual/LLM-generated effect plan JSON (overrides the style's rule engine) */
  effectPlanJson: string
}

export interface LookAdjust {
  brightness?: number
  contrast?: number
  saturation?: number
  colorBalance?: { r?: number; g?: number; b?: number }
  vignette?: number
  sharpen?: number
  grain?: number
}

export const DEFAULT_BETA_OPTS: BetaVideoOpts = {
  hook: { enabled: false, text: '' },
  autoHighlight: false,
  overlay: { bottom: false, top: false, left: false, right: false, intensity: 50 },
  autoZoom: { atStart: false, atKeyPhrases: false },
  broll: { enabled: false, density: 'sparse', poolSize: 18, mode: 'full', fallbackPolicy: 'prefer-selected', shufflePolicy: 'per-video' },
  style: 'None',
  effectPlanJson: ''
}

function finiteNumber(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : fallback
}

function boolValue(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function stringValue(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function clampNumber(v: unknown, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, finiteNumber(v, fallback)))
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
}

/** Merge a possibly-partial/legacy betaOpts onto the defaults (deep, for nested groups). */
export function asBetaOpts(v: unknown): BetaVideoOpts {
  const o = asRecord(v)
  const hook = asRecord(o.hook)
  const overlay = asRecord(o.overlay)
  const autoZoom = asRecord(o.autoZoom)
  const broll = asRecord(o.broll)
  const style = VIDEO_STYLES.includes(o.style as VideoStyle) ? o.style as VideoStyle : DEFAULT_BETA_OPTS.style
  const density = BROLL_DENSITIES.includes(broll.density as BrollDensity) ? broll.density as BrollDensity : DEFAULT_BETA_OPTS.broll.density
  const mode = broll.mode === 'overlay' || broll.mode === 'full' ? broll.mode : DEFAULT_BETA_OPTS.broll.mode
  return {
    ...DEFAULT_BETA_OPTS,
    hook: {
      enabled: boolValue(hook.enabled, DEFAULT_BETA_OPTS.hook.enabled),
      text: stringValue(hook.text, DEFAULT_BETA_OPTS.hook.text)
    },
    autoHighlight: boolValue(o.autoHighlight, DEFAULT_BETA_OPTS.autoHighlight),
    overlay: {
      bottom: boolValue(overlay.bottom, DEFAULT_BETA_OPTS.overlay.bottom),
      top: boolValue(overlay.top, DEFAULT_BETA_OPTS.overlay.top),
      left: boolValue(overlay.left, DEFAULT_BETA_OPTS.overlay.left),
      right: boolValue(overlay.right, DEFAULT_BETA_OPTS.overlay.right),
      intensity: clampNumber(overlay.intensity, DEFAULT_BETA_OPTS.overlay.intensity, 0, 100)
    },
    autoZoom: {
      atStart: boolValue(autoZoom.atStart, DEFAULT_BETA_OPTS.autoZoom.atStart),
      atKeyPhrases: boolValue(autoZoom.atKeyPhrases, DEFAULT_BETA_OPTS.autoZoom.atKeyPhrases)
    },
    broll: {
      enabled: boolValue(broll.enabled, DEFAULT_BETA_OPTS.broll.enabled),
      density,
      poolSize: Math.round(clampNumber(broll.poolSize, DEFAULT_BETA_OPTS.broll.poolSize, 1, 200)),
      mode,
      poolKey: typeof broll.poolKey === 'string' && broll.poolKey.trim() ? broll.poolKey.trim() : undefined,
      fallbackPolicy: broll.fallbackPolicy === 'selected-only' || broll.fallbackPolicy === 'all-sources' ? broll.fallbackPolicy : 'prefer-selected',
      shufflePolicy: broll.shufflePolicy === 'ranked' ? 'ranked' : 'per-video',
      seed: broll.seed == null ? undefined : Math.round(clampNumber(broll.seed, 0, 0, 2_147_483_647))
    },
    style,
    effectPlanJson: stringValue(o.effectPlanJson, DEFAULT_BETA_OPTS.effectPlanJson)
  }
}

/** Canonical render/preview entrypoint for project-scoped video effects. */
export function projectVideoOpts(project: { betaOpts?: unknown } | null | undefined): BetaVideoOpts {
  return asBetaOpts(project?.betaOpts)
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
  crossfade: number
  captionPreset: string
  captionFont: string
  captionAnim: string
  captionAspect: '16:9' | '1:1' | '9:16'
  captionLines?: 1 | 2 | 3
  captionPosition?: 'top' | 'middle' | 'bottom'
  /** fine vertical caption placement, % of frame height from the top (4–96);
   *  overrides the coarse captionPosition when set */
  captionOffsetY?: number
  captionPace?: 'auto' | 'word' | 'phrase'
  /** active/highlighted caption text colour (#rrggbb); Submagic uses this inside the box */
  captionHighlightColor?: string
  /** active-word caption box colour (#rrggbb), used by Submagic-style captions */
  captionBoxColor?: string
  /** Submagic phrase window size: 1-3 words per page */
  captionWordsPerPage?: 1 | 2 | 3
  emphasis: boolean
  keywords: boolean
  punchZoom: boolean
  stage: string
  /** saved thumbnail path (written by thumbnails:saveProjectThumb) */
  thumbPath?: string
  /** thumbnail template attached by an automation profile; applied when Thumbnail studio opens */
  thumbnailTemplateId?: string
  /** selected LUT look id from shared/looks; "off" disables LUT blending */
  lookLut?: string
  /** selected LUT blend in [0,1] */
  lookStrength?: number
  /** parametric grade overrides layered on top of the selected look */
  lookAdjust?: LookAdjust
  /** smart still motion preset; undefined keeps legacy kenBurns behavior */
  motionPreset?: MotionPreset
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
  /** Automation-only pacing before a real network request. */
  delaySec?: number
  /** Let the visible Automation supervisor own retry semantics. */
  supervised?: boolean
}

// ---- Render pipeline (M6) ----
export type RenderStatus = 'queued' | 'rendering' | 'done' | 'error'
export type RenderStage =
  | 'queued'
  | 'rendering'
  | 'preparing'
  | 'transcribing'
  | 'fetching-broll'
  | 'assembling'
  | 'grading'
  | 'captioning'
  | 'encoding'
  | 'finalizing'
  | 'done'
  | 'error'
  | 'cancelled'

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
  stage: RenderStage
  done: boolean
  stageDetail?: string
  etaSec?: number
  etaState?: 'estimating' | 'stable'
  speed?: number
  fps?: number
  bitrate?: string
  device?: 'cpu' | 'gpu'
  filterDevice?: 'cpu' | 'gpu'
  filterDetail?: string
  encoder?: string
  warning?: string
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
  /** True when the project renders from an auto-B-roll clip pool instead of still images.
   *  The queue checklist uses this so 0 still-images isn't flagged as an error. */
  broll?: boolean
}

/** A finished render surfaced on the Library/Publish screen — the "did I already upload
 *  this" view. Removes the manual folder-hunting: lists every rendered video with a fuzzy-
 *  matched upload status against whichever "My Channel" its source is linked to. */
export interface PublishItem {
  jobId: string
  projectId: string
  title: string
  /** source channel handle the video was scraped from (display only) */
  channel: string
  videoPath: string
  thumbPath: string | null
  durationSec: number
  renderedAt: string
  uploadStatus: 'uploaded' | 'not-uploaded' | 'unlinked'
  /** the actual uploaded title it fuzzy-matched, when uploadStatus is 'uploaded' */
  matchedTitle?: string
}


// ---- Settings (persisted via electron-store) ----
export interface AppSettings {
  accent: AccentName
  ambientGlow: boolean
  showActivityRail: boolean
  defaultScreen: ScreenKey
  /** last channel viewed in the Home pipeline board, so reopening lands where you left */
  lastWorkspaceChannel?: string
  namingTemplate: string
  /** master library root: where all per-video folders (audio/images/captions/broll/
   *  thumb/output) live. Empty = <Documents>/MentalEmpireStudio. Supersedes outputFolder
   *  as the single storage root; outputFolder is kept as a back-compat fallback. */
  libraryFolder?: string
  /** where downloads + renders are written; empty = <Downloads>/MentalEmpire_out */
  outputFolder: string
  concurrency: number
  quality: '720p' | '1080p' | '1440p'
  /** video encoder: cpu works everywhere; hardware modes fail visibly instead of silently falling back to CPU. */
  encoder: 'cpu' | 'nvenc' | 'qsv' | 'amf'
  /** render engine: 'ffmpeg' is the stable CPU-filtergraph path; 'gpu' uses the WebGL
   *  compositor + WebCodecs encoder; 'auto' prefers GPU when hardware H.264 is present. */
  renderEngine?: 'auto' | 'ffmpeg' | 'gpu'
  autoScrape: { enabled: boolean; frequency: string; delaySec: number; retries: number; proxy: string; cookiesPath: string }
  background: { tray: boolean; startOnSignIn: boolean; notifications: boolean; webhook: string }
  transcription: { apiKey: string; model: string }
  /** experimental features + stock-footage API keys (gated; default off) */
  beta: { enabled: boolean; pexelsKey: string; pixabayKey: string; coverrKey: string }
  /** additive redesign flags, so each shipped slice remains rollback-friendly */
  features: { workflowP1: boolean; videoEditorV2: boolean; thumbEditorV2: boolean }
  /** upload detection automation + pending/high confidence band */
  detection: { auto: boolean; confirmBand: [number, number] }
  /** duplicate-download behavior for source videos already uploaded to owned channels */
  dedup: { allowReupload: boolean }
  /** third-party cloud provider connections, gated off by default until each is ready */
  integrations: { talkingPhotos: { enabled: boolean } }
  /** global Sentry kill switch — crash reports, perf traces, and resource sampling.
   *  Flipping this off fully disables telemetry app-wide, live, no restart needed. */
  telemetryEnabled: boolean
}

export interface RenderCapabilities {
  hasNvenc: boolean
  hasQsv: boolean
  hasAmf: boolean
  gpuVendor: 'nvidia' | 'intel' | 'amd' | 'unknown'
  ffmpegHasLibass: boolean
  ffmpegHasCuda: boolean
  ffmpegPath?: string
  hasNvencListed?: boolean
  hasQsvListed?: boolean
  hasAmfListed?: boolean
  nvencProbeError?: string
  qsvProbeError?: string
  amfProbeError?: string
  nvidiaGpuName?: string
}

/** Canonical defaults — shared by the main-process store and the renderer's initial state. */
export const DEFAULT_SETTINGS: AppSettings = {
  accent: 'Amber',
  ambientGlow: true,
  showActivityRail: true,
  defaultScreen: 'home',
  namingTemplate: '{channel} - {title}',
  libraryFolder: '',
  outputFolder: '',
  concurrency: 2,
  quality: '1080p',
  encoder: 'cpu',
  renderEngine: 'ffmpeg',
  autoScrape: { enabled: true, frequency: 'Every 6 hours', delaySec: 1.5, retries: 3, proxy: '', cookiesPath: '' },
  background: { tray: true, startOnSignIn: false, notifications: true, webhook: '' },
  transcription: { apiKey: '', model: 'whisper-large-v3-turbo' },
  beta: { enabled: false, pexelsKey: '', pixabayKey: '', coverrKey: '' },
  features: { workflowP1: true, videoEditorV2: true, thumbEditorV2: true },
  detection: { auto: true, confirmBand: [0.6, 0.82] },
  dedup: { allowReupload: false },
  integrations: { talkingPhotos: { enabled: false } },
  telemetryEnabled: true
}

/** Recursive partial — used for settings patches that touch only nested keys. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

// ---- Native bridge surface ----
export interface LibraryReorgPreview {
  libraryRoot: string
  fileCount: number
  totalBytes: number
  missing: number
  alreadyOrganized: number
  sample: Array<{ from: string; to: string }>
}

export interface LibraryReorgResult {
  moved: number
  skippedMissing: number
  alreadyOrganized: number
  undoLogPath?: string
}

/** A video's progress through the production pipeline. Stages are COMPUTED from existing
 *  tables (download/project/images/transcript/render job); only uploaded/archived state is
 *  persisted (work_item_state). Surfaced as a per-channel checklist in the workspace. */
export type WorkItemStage = 'downloaded' | 'images' | 'captioned' | 'thumbnail' | 'rendered' | 'uploaded'

export interface WorkItem {
  /** bare source video id (stable key) */
  videoId: string
  /** source channel the video came from */
  channel: string
  title: string
  thumb?: string
  downloadId?: string
  projectId?: string
  renderJobId?: string
  // computed stage flags
  downloaded: boolean
  hasImages: boolean
  captioned: boolean
  hasThumbnail: boolean
  rendered: boolean
  uploaded: boolean
  // detail
  renderStatus?: RenderStatus
  outputPath?: string
  error?: string
  /** my-channel ids this video was fuzzy-matched as uploaded to (can be more than one) */
  uploadedTo: string[]
  /** best fuzzy match score for the upload detection (for display/confidence) */
  uploadMatchScore?: number
  /** high means asserted uploaded; pending means user should confirm before blocking */
  uploadConfidence?: 'high' | 'pending'
  /** user override forcing the uploaded state (null = use detection) */
  uploadedManual: boolean | null
  archived: boolean
}

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
    /** data-only reset: wipe channels/projects/downloads/jobs/transcripts but keep API keys and settings */
    softReset(): Promise<void>
  }
  appMeta: {
    /** read app-level onboarding/migration markers stored in app_meta */
    get(key: string): Promise<string>
    /** write app-level onboarding/migration markers stored in app_meta */
    set(key: string, value: string): Promise<void>
  }
  caps: {
    get(force?: boolean): Promise<RenderCapabilities>
  }
  gpu: {
    /** WebCodecs hardware-encode probe + vendor name, for the Compose GPU status chip. */
    status(): Promise<GpuEngineStatus>
  }
  effects: {
    /** beta: generate a validated effect-plan JSON for a project via Groq */
    generate(projectId: string, style: VideoStyle): Promise<string>
  }
  looks: {
    list(): Promise<import('./looks').LookPreset[]>
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
    /** link (or unlink, with null) a source channel to this owned channel so uploads can be
     *  matched against its downloaded videos */
    setChannelSource(id: string, linkedSourceId: string | null): Promise<MyChannel[]>
    /** remove an owned channel (and its scraped uploads) */
    deleteMyChannel(id: string): Promise<MyChannel[]>
    /** per-video pipeline read model (computed stages + persisted upload/archive state) */
    workItems(): Promise<WorkItem[]>
  }
  workItems: {
    /** run fuzzy upload detection (source titles vs your channels' uploads); returns # matched */
    detect(): Promise<number>
    /** manual override of the uploaded flag for a video */
    setUploaded(videoId: string, uploaded: boolean): Promise<void>
    /** hide/show a video from the "to do" lists without deleting it */
    setArchived(videoId: string, archived: boolean): Promise<void>
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
  sources: {
    /** saved source-channel list enriched with cache/new counts */
    list(): Promise<SourceChannel[]>
    /** scrape once, persist the source row + cached videos, and return the saved row */
    add(url: string): Promise<SourceChannel>
    /** refresh one saved source's cached video list */
    refresh(id: string): Promise<SourceChannel>
    /** read cached videos only; no network */
    videos(id: string): Promise<ScrapedVideo[]>
    /** record that the user opened this source, setting the cursor to the current newest video */
    markVisited(id: string): Promise<SourceChannel[]>
    /** remove the source and its cached videos */
    remove(id: string): Promise<SourceChannel[]>
    /** optionally link a source to one owned channel for dedup/status context */
    setLinkedMyChannel(id: string, myChannelId: string | null): Promise<SourceChannel[]>
    /** update the source-owned automation defaults/cursor settings */
    setAutomation(id: string, patch: SourceAutomationPatch): Promise<SourceChannel[]>
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
    /** stop an active download and leave it resumable */
    cancel(id: string): Promise<void>
    /** reveal a downloaded file in the OS file manager */
    openFolder(id: string): Promise<void>
    /** remove a download row from history */
    delete(id: string): Promise<void>
  }
  compose: {
    createProject(downloadId: string): Promise<Project>
    get(id: string): Promise<Project | null>
    list(): Promise<Project[]>
    images(projectId: string): Promise<ProjectImage[]>
    setImages(projectId: string, paths: string[]): Promise<ProjectImage[]>
    reorderImages(projectId: string, imageIds: string[]): Promise<ProjectImage[]>
    setRanges(projectId: string, ranges: { id: string; rangeStart: number; rangeEnd: number }[]): Promise<ProjectImage[]>
    setImageMotion(projectId: string, updates: ProjectImageMotionPatch[]): Promise<ProjectImage[]>
    setMedia(projectId: string, patch: Partial<Project>): Promise<Project>
    setCaptions(projectId: string, patch: Partial<Project>): Promise<Project>
    updateLook(projectId: string, patch: { lut?: string; strength?: number; adjust?: LookAdjust }): Promise<Project>
    updateMotion(projectId: string, patch: { preset: MotionPreset }): Promise<Project>
    updateCaptions(projectId: string, patch: Partial<Project>): Promise<Project>
    /** serializable GPU compositor spec for the live still editor preview */
    previewSpec(projectId: string, draftOverrides?: Partial<Project>): Promise<GpuRenderSpec>
    /** extract/cache the first frame of a local video segment as a PNG data URL */
    posterFrame(path: string): Promise<string>
    preview(projectId: string): Promise<string>
    sendToRender(projectId: string): Promise<void>
  }
  transcribe: {
    run(projectId: string): Promise<TranscriptWord[]>
    get(projectId: string): Promise<TranscriptWord[]>
    updateWord(wordId: string, text: string): Promise<void>
    toggleEmphasis(wordId: string): Promise<void>
    setEmphasis(wordIds: string[], emphasis: boolean): Promise<void>
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
    /** save a project-specific thumbnail: write PNG + update project.thumbPath */
    saveProjectThumb(projectId: string, name: string, dataUrl: string): Promise<string>
  }
  render: {
    /** the queue as joined rows (job + project checklist) */
    jobs(): Promise<RenderQueueRow[]>
    /** render every queued job, honoring the concurrency setting */
    all(): Promise<void>
    /** cancel a queued/rendering job */
    cancel(jobId: string): Promise<void>
    /** permanently remove a job from the queue */
    delete(jobId: string): Promise<void>
    /** reset an error/blocked job back to queued so it can be retried */
    requeue(jobId: string): Promise<void>
    /** open the finished render in the OS default player */
    openFile(jobId: string): Promise<void>
    /** reveal the finished render in the OS file manager */
    openFolder(jobId: string): Promise<void>
  }
  assets: {
    /** every image used in a past project, grouped client-side by channel */
    list(): Promise<LibraryAsset[]>
    /** Copy/dedupe images into the canonical library before project use. */
    import(paths: string[], context?: { sourceId?: string; channel?: string; channelHandle?: string; channelAvatar?: string; projectId?: string }): Promise<LibraryAsset[]>
  }
  publish: {
    /** every finished render, with a fuzzy-matched upload status */
    list(): Promise<PublishItem[]>
    /** reveal an arbitrary file (video or thumbnail) in the OS file manager */
    reveal(path: string): Promise<void>
    /** begin a native OS drag of a file out of the app window (e.g. into a browser upload
     *  dialog) — fire-and-forget, must be called synchronously from a DOM dragstart handler */
    startDrag(path: string): void
  }
  automation: {
    /** run a profile's pipeline; interactive returns new project ids for quick-edit */
    runProfile(profileId: string, headless?: boolean): Promise<string[]>
    /** run a saved source's automation pipeline; replaces profile-owned runs */
    runSource(sourceId: string, headless?: boolean): Promise<string[]>
    /** create/update a profile */
    upsertProfile(profile: Profile): Promise<Profile[]>
    /** delete a profile */
    deleteProfile(profileId: string): Promise<Profile[]>
    /** trigger one scheduler tick now */
    tick(): Promise<void>
    /** inspect a goal configuration before persisting/starting it */
    preflight(draft: AutomationJobDraft): Promise<AutomationPreflight>
    /** persist a durable job and let the local supervisor run it */
    createJob(draft: AutomationJobDraft): Promise<AutomationJobDetail>
    /** list current and historical durable jobs */
    jobs(): Promise<AutomationJob[]>
    /** get steps, items and understandable logs for one durable job */
    job(id: string): Promise<AutomationJobDetail | null>
    pauseJob(id: string): Promise<void>
    resumeJob(id: string): Promise<void>
    cancelJob(id: string): Promise<void>
    retryJob(id: string): Promise<void>
  }
  /** TalkingPhotos.ai cloud provider — session, catalogs, sync, and confirmed
   *  uploaded-library-audio Human video creation. */
  talkingPhotos: {
    connectionStatus(): Promise<ProviderConnection>
    connect(): Promise<ProviderConnection>
    reconnect(): Promise<ProviderConnection>
    disconnect(): Promise<ProviderConnection>
    capabilities(): Promise<ProviderCapabilities>
    languages(): Promise<ProviderLanguage[]>
    voices(languageCode: string): Promise<ProviderVoice[]>
    motions(query: ProviderMotionQuery): Promise<ProviderMotion[]>
    /** locally-known provider jobs joined with a fresh remote project listing */
    projects(): Promise<ProviderProjectSummary[]>
    project(remoteProjectId: string): Promise<ProviderProjectSummary | null>
    /** reconcile every non-terminal provider job against its remote project now */
    sync(): Promise<ProviderJob[]>
    jobs(): Promise<ProviderJob[]>
    /** Create a Human video from local uploaded audio; long audio is segmented and merged. */
    createUploadedAudio(input: TalkingPhotosCreateInput): Promise<ProviderJob>
    /** Create a Human video from a custom script (or automation transcript
     *  reconstruction) via TTS, gated behind the confirmed WebSocket resolution. */
    createScript(input: TalkingPhotosScriptCreateInput): Promise<ProviderJob>
    /** (re)download a completed job's output; safe to call repeatedly */
    downloadOutput(providerJobId: string): Promise<ProviderJob>
    subtitleLanguages(): Promise<ProviderLanguage[]>
    /** Submit provider subtitles for an already-completed source video. */
    createProviderSubtitles(sourceJobId: string, language?: string): Promise<ProviderJob>
    /** Burn local captions onto an already-downloaded, verified output — mutually
     *  exclusive with provider subtitles on the same video. */
    applyLocalCaptions(providerJobId: string, aspect?: TalkingPhotosAspectRatio): Promise<ProviderJob>
    /** Display-only TTS library listing for explicit, user-confirmed recovery —
     *  never used to automatically infer a result. */
    ttsRecoveryLibrary(): Promise<TalkingPhotosRemoteMedia[]>
    /** Persist a user-confirmed manual recovery choice for an unresolved TTS job. */
    confirmRecoveredTts(jobId: string, mediaId: string, durationSec: number): Promise<ProviderJob>
  }
  /** pick an output folder via the OS dialog; returns the chosen path or '' */
  chooseFolder(): Promise<string>
  /** master library: reorganize existing files into the per-video layout */
  library: {
    /** dry-run: size the move plan for a confirmation prompt */
    previewReorg(): Promise<LibraryReorgPreview>
    /** execute the reorganize migration (copy-verify-delete + DB rewrite + undo log) */
    reorganize(): Promise<LibraryReorgResult>
  }
  /** niche b-roll pools (P3) */
  niche: {
    list(): Promise<Niche[]>
    poolHealth(): Promise<NichePoolHealth[]>
    refreshAll(): Promise<NichePoolHealth[]>
    save(n: Partial<Niche>): Promise<Niche[]>
    remove(id: string): Promise<Niche[]>
    assignChannel(channelId: string, nicheId: string | null): Promise<SourceChannel[]>
    warm(id: string): Promise<NichePoolHealth>
  }
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
  /** subscribe to durable automation job changes; SQLite remains source of truth */
  onAutomationJob(cb: (job: AutomationJob) => void): () => void
  /** subscribe to TalkingPhotos provider-job changes; provider_jobs remains source of truth */
  onProviderJob(cb: (job: ProviderJob) => void): () => void
  /** subscribe to TalkingPhotos connection-status changes; this is the only source of
   *  progress/outcome once talkingPhotos.connect()'s login window is open — the
   *  connect() promise itself resolves as soon as the window opens. */
  onConnectionStatusChanged(cb: (connection: ProviderConnection) => void): () => void
}

declare global {
  interface Window {
    api: NativeApi
  }
}
