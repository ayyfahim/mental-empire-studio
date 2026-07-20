import type {
  AutomationJobConfig,
  AutomationRules,
  AutomationStyleConfig,
  BrollDensity,
  ImageMode,
  MotionPreset,
  VideoStyle
} from './types'

export const DEFAULT_AUTOMATION_STYLE: AutomationStyleConfig = {
  videoStyle: 'Clean',
  captionPreset: 'Hormozi',
  captionFont: 'Montserrat',
  captionAnimation: 'Pop-in',
  captionPosition: 'bottom',
  captionLines: 1,
  captionPace: 'auto',
  wordsPerCaption: 2,
  highlightColor: '#f5b323',
  boxColor: '#111111',
  imageMode: 'sequence',
  crossfadeSec: 0.8,
  motionPreset: 'subtle',
  gradientEdge: 'none',
  gradientIntensity: 50,
  aspectRatio: '16:9',
  brollMode: 'off',
  brollDensity: 'sparse',
  brollPoolSize: 18,
  brollFallbackPolicy: 'prefer-selected',
  brollShufflePolicy: 'per-video'
}

export const DEFAULT_AUTOMATION_RULES: AutomationRules = {
  minDurationSec: 0,
  skipDownloaded: true,
  continueOnError: true,
  maxRetries: 2,
  minimumFreeSpaceGb: 2,
  captions: true,
  autoBroll: false,
  removeSilence: false,
  reduceFillerWords: false,
  keepAwake: true,
  skipUploaded: true,
  fillSkippedSelections: false,
  allowStaleUploadCache: true,
  uploadFreshnessMinutes: 360,
  downloadDelaySec: 3,
  retryBaseDelaySec: 10,
  retryMaxDelaySec: 90
}

export const DEFAULT_TALKINGPHOTOS_AUTOMATION: NonNullable<AutomationJobConfig['talkingPhotos']> = {
  characterPrompt: '',
  characterNegativePrompt: '',
  style: 'high_quality',
  aspectRatio: '16:9',
  motionId: 0,
  mode: 'uploaded-audio',
  script: '',
  language: 'en-US',
  voice: 'en-US-AndrewMultilingualNeural',
  voiceStyle: 'general',
  speed: 1,
  pitch: 0,
  subtitleMode: 'none'
}

export function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  const safe = Number.isFinite(parsed) ? parsed : fallback
  return Math.max(min, Math.min(max, safe))
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function oneOf<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return values.includes(value as T) ? value as T : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback
}

function captionAnimation(value: unknown): string {
  if (value === 'Pop-in' || value === 'Fade' || value === 'None') return value
  if (value === 'Bounce' || value === 'Type') return 'Pop-in'
  if (value === 'Slide') return 'Fade'
  return DEFAULT_AUTOMATION_STYLE.captionAnimation
}

export function normalizeAutomationStyle(value: unknown, legacy: Partial<AutomationJobConfig> = {}): AutomationStyleConfig {
  const raw = record(value)
  const legacyStyle = oneOf<VideoStyle>(legacy.style, ['None', 'Cinematic', 'Intense', 'Heartfelt', 'Clean'], DEFAULT_AUTOMATION_STYLE.videoStyle)
  const legacyAspect = Array.isArray(legacy.aspectRatios) ? legacy.aspectRatios[0] : undefined
  const offsetRaw = raw.captionOffsetY
  const offset = offsetRaw == null || offsetRaw === '' ? undefined : finiteNumber(offsetRaw, 82, 4, 96)
  return {
    videoStyle: oneOf<VideoStyle>(raw.videoStyle, ['None', 'Cinematic', 'Intense', 'Heartfelt', 'Clean'], legacyStyle),
    captionPreset: typeof raw.captionPreset === 'string' && raw.captionPreset.trim() ? raw.captionPreset.trim().slice(0, 80) : legacy.captionPreset || DEFAULT_AUTOMATION_STYLE.captionPreset,
    captionFont: typeof raw.captionFont === 'string' && raw.captionFont.trim() ? raw.captionFont.trim().slice(0, 80) : DEFAULT_AUTOMATION_STYLE.captionFont,
    captionAnimation: captionAnimation(raw.captionAnimation),
    captionPosition: oneOf(raw.captionPosition, ['top', 'middle', 'bottom'], DEFAULT_AUTOMATION_STYLE.captionPosition),
    ...(offset === undefined ? {} : { captionOffsetY: offset }),
    captionLines: Math.round(finiteNumber(raw.captionLines, DEFAULT_AUTOMATION_STYLE.captionLines, 1, 3)) as 1 | 2 | 3,
    captionPace: oneOf(raw.captionPace, ['auto', 'word', 'phrase'], DEFAULT_AUTOMATION_STYLE.captionPace),
    wordsPerCaption: Math.round(finiteNumber(raw.wordsPerCaption, DEFAULT_AUTOMATION_STYLE.wordsPerCaption, 1, 3)) as 1 | 2 | 3,
    highlightColor: color(raw.highlightColor, DEFAULT_AUTOMATION_STYLE.highlightColor),
    boxColor: color(raw.boxColor, DEFAULT_AUTOMATION_STYLE.boxColor),
    imageMode: oneOf<ImageMode>(raw.imageMode, ['sequence', 'pool'], DEFAULT_AUTOMATION_STYLE.imageMode),
    crossfadeSec: finiteNumber(raw.crossfadeSec, DEFAULT_AUTOMATION_STYLE.crossfadeSec, 0, 5),
    motionPreset: oneOf<MotionPreset>(raw.motionPreset, ['off', 'subtle', 'cinematic'], DEFAULT_AUTOMATION_STYLE.motionPreset),
    gradientEdge: oneOf(raw.gradientEdge, ['none', 'top', 'bottom', 'left', 'right'], DEFAULT_AUTOMATION_STYLE.gradientEdge),
    gradientIntensity: finiteNumber(raw.gradientIntensity, DEFAULT_AUTOMATION_STYLE.gradientIntensity, 0, 100),
    aspectRatio: oneOf(raw.aspectRatio ?? legacyAspect, ['16:9', '1:1', '9:16'], DEFAULT_AUTOMATION_STYLE.aspectRatio),
    brollMode: oneOf(raw.brollMode, ['off', 'full', 'overlay'], legacy.rules?.autoBroll ? 'full' : DEFAULT_AUTOMATION_STYLE.brollMode),
    brollDensity: oneOf<BrollDensity>(raw.brollDensity, ['full', 'sparse', 'keywords'], DEFAULT_AUTOMATION_STYLE.brollDensity),
    brollPoolSize: Math.round(finiteNumber(raw.brollPoolSize, DEFAULT_AUTOMATION_STYLE.brollPoolSize, 1, 200)),
    ...(typeof raw.brollPoolKey === 'string' && raw.brollPoolKey.trim() ? { brollPoolKey: raw.brollPoolKey.trim().slice(0, 160) } : {}),
    brollFallbackPolicy: oneOf(raw.brollFallbackPolicy, ['selected-only', 'prefer-selected', 'all-sources'], DEFAULT_AUTOMATION_STYLE.brollFallbackPolicy),
    brollShufflePolicy: oneOf(raw.brollShufflePolicy, ['per-video', 'ranked'], DEFAULT_AUTOMATION_STYLE.brollShufflePolicy)
  }
}

export function normalizeAutomationRules(value: unknown): AutomationRules {
  const raw = record(value)
  return {
    minDurationSec: finiteNumber(raw.minDurationSec, DEFAULT_AUTOMATION_RULES.minDurationSec, 0, 36_000),
    skipDownloaded: bool(raw.skipDownloaded, DEFAULT_AUTOMATION_RULES.skipDownloaded),
    continueOnError: bool(raw.continueOnError, DEFAULT_AUTOMATION_RULES.continueOnError),
    maxRetries: Math.round(finiteNumber(raw.maxRetries, DEFAULT_AUTOMATION_RULES.maxRetries, 0, 8)),
    minimumFreeSpaceGb: finiteNumber(raw.minimumFreeSpaceGb, DEFAULT_AUTOMATION_RULES.minimumFreeSpaceGb, 1, 100),
    captions: bool(raw.captions, DEFAULT_AUTOMATION_RULES.captions),
    autoBroll: bool(raw.autoBroll, DEFAULT_AUTOMATION_RULES.autoBroll),
    removeSilence: bool(raw.removeSilence, DEFAULT_AUTOMATION_RULES.removeSilence),
    reduceFillerWords: bool(raw.reduceFillerWords, DEFAULT_AUTOMATION_RULES.reduceFillerWords),
    keepAwake: bool(raw.keepAwake, DEFAULT_AUTOMATION_RULES.keepAwake),
    // Missing fields belong to a pre-feature persisted job: preserve its old no-skip,
    // no-pacing behavior. New drafts pass the explicit defaults above.
    skipUploaded: bool(raw.skipUploaded, false),
    fillSkippedSelections: bool(raw.fillSkippedSelections, DEFAULT_AUTOMATION_RULES.fillSkippedSelections),
    allowStaleUploadCache: bool(raw.allowStaleUploadCache, DEFAULT_AUTOMATION_RULES.allowStaleUploadCache),
    uploadFreshnessMinutes: Math.round(finiteNumber(raw.uploadFreshnessMinutes, DEFAULT_AUTOMATION_RULES.uploadFreshnessMinutes, 5, 43_200)),
    downloadDelaySec: finiteNumber(raw.downloadDelaySec, 0, 0, 600),
    retryBaseDelaySec: finiteNumber(raw.retryBaseDelaySec, DEFAULT_AUTOMATION_RULES.retryBaseDelaySec, 1, 120),
    retryMaxDelaySec: finiteNumber(raw.retryMaxDelaySec, DEFAULT_AUTOMATION_RULES.retryMaxDelaySec, 1, 300)
  }
}

export function normalizeAutomationConfig(config: Partial<AutomationJobConfig>): AutomationJobConfig {
  const styleConfig = normalizeAutomationStyle(config.styleConfig, config)
  const talkingPhotos = record(config.talkingPhotos)
  const ratios = Array.isArray(config.aspectRatios) ? config.aspectRatios.filter((v): v is '16:9' | '1:1' | '9:16' => v === '16:9' || v === '1:1' || v === '9:16') : []
  return {
    sourceKind: config.sourceKind === 'youtube-url' || config.sourceKind === 'local-files' ? config.sourceKind : 'saved-source',
    sourceId: typeof config.sourceId === 'string' ? config.sourceId : '',
    sourceUrl: typeof config.sourceUrl === 'string' ? config.sourceUrl : '',
    sourceName: typeof config.sourceName === 'string' ? config.sourceName : '',
    sourceOrder: config.sourceOrder === 'Popular' || config.sourceOrder === 'Oldest' ? config.sourceOrder : 'Latest',
    sourceCount: Math.round(finiteNumber(config.sourceCount, 1, 1, 50)),
    selectedVideoIds: Array.isArray(config.selectedVideoIds) ? [...new Set(config.selectedVideoIds.filter((v): v is string => typeof v === 'string'))].slice(0, 50) : [],
    localMediaPaths: Array.isArray(config.localMediaPaths) ? [...new Set(config.localMediaPaths.filter((v): v is string => typeof v === 'string'))].slice(0, 50) : [],
    assetPaths: Array.isArray(config.assetPaths) ? [...new Set(config.assetPaths.filter((v): v is string => typeof v === 'string'))].slice(0, 200) : [],
    style: styleConfig.videoStyle,
    captionPreset: styleConfig.captionPreset,
    aspectRatios: ratios.length ? ratios : [styleConfig.aspectRatio],
    styleConfig,
    rules: normalizeAutomationRules(config.rules),
    talkingPhotos: {
      characterPrompt: typeof talkingPhotos.characterPrompt === 'string' ? talkingPhotos.characterPrompt.trim().slice(0, 2_000) : '',
      characterNegativePrompt: typeof talkingPhotos.characterNegativePrompt === 'string' ? talkingPhotos.characterNegativePrompt.trim().slice(0, 2_000) : '',
      style: oneOf(talkingPhotos.style, ['normal', 'high_quality'], DEFAULT_TALKINGPHOTOS_AUTOMATION.style),
      aspectRatio: oneOf(talkingPhotos.aspectRatio, ['16:9', '1:1', '9:16'], styleConfig.aspectRatio),
      motionId: Math.round(finiteNumber(talkingPhotos.motionId, DEFAULT_TALKINGPHOTOS_AUTOMATION.motionId, 0, 1_000_000)),
      mode: oneOf(talkingPhotos.mode, ['uploaded-audio', 'custom-script', 'transcript-tts'], DEFAULT_TALKINGPHOTOS_AUTOMATION.mode),
      script: typeof talkingPhotos.script === 'string' ? talkingPhotos.script.trim().slice(0, 20_000) : '',
      language: typeof talkingPhotos.language === 'string' && talkingPhotos.language.trim() ? talkingPhotos.language.trim().slice(0, 20) : DEFAULT_TALKINGPHOTOS_AUTOMATION.language,
      voice: typeof talkingPhotos.voice === 'string' && talkingPhotos.voice.trim() ? talkingPhotos.voice.trim().slice(0, 80) : DEFAULT_TALKINGPHOTOS_AUTOMATION.voice,
      voiceStyle: typeof talkingPhotos.voiceStyle === 'string' && talkingPhotos.voiceStyle.trim() ? talkingPhotos.voiceStyle.trim().slice(0, 40) : DEFAULT_TALKINGPHOTOS_AUTOMATION.voiceStyle,
      speed: finiteNumber(talkingPhotos.speed, DEFAULT_TALKINGPHOTOS_AUTOMATION.speed, 0.5, 2),
      pitch: finiteNumber(talkingPhotos.pitch, DEFAULT_TALKINGPHOTOS_AUTOMATION.pitch, -20, 20),
      subtitleMode: oneOf(talkingPhotos.subtitleMode, ['none', 'provider', 'local'], DEFAULT_TALKINGPHOTOS_AUTOMATION.subtitleMode)
    },
    notify: {
      desktop: bool(config.notify?.desktop, false),
      webhook: bool(config.notify?.webhook, false),
      sound: bool(config.notify?.sound, false),
      email: bool(config.notify?.email, false)
    },
    execution: 'local',
    ...(typeof config.scheduledFor === 'string' && config.scheduledFor ? { scheduledFor: config.scheduledFor } : {})
  }
}
