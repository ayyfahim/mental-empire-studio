// Serializable render spec shared by both engines (ffmpeg + GPU/WebCodecs) so they
// stay output-compatible. The GPU worker reads NUMERIC parameters (not ffmpeg filter
// strings) — gradeParams() in electron/services/engine/grade.ts is the source of truth
// for the values, mirroring gradeChain(). Kept dependency-free + DOM-free so it can be
// imported from the Electron main process (Node) and the render-worker (renderer) alike.

import type { VideoStyle } from './types'
import type { ResolvedCaptionStyle } from './captionStyle'

/** Numeric colour-grade parameters for the GPU compositor shader. Mirrors the look of
 *  the ffmpeg gradeChain() for the same style, expressed as values a shader can apply. */
export interface GradeParams {
  /** style id this was derived from (for LUT selection + logging) */
  style: VideoStyle
  /** optional baked 3D LUT (.cube) asset id; when absent the shader uses the math below */
  lut?: string
  /** blend amount for the LUT in [0,1] */
  lutStrength?: number
  /** master saturation multiplier (1 = unchanged) */
  saturation: number
  /** master contrast multiplier (1 = unchanged) */
  contrast: number
  /** additive brightness in [-1,1] (0 = unchanged) */
  brightness: number
  /** per-channel lift/gain bias approximating colorbalance, each in [-1,1] */
  colorBalance: { r: number; g: number; b: number }
  /** vignette strength in [0,1] (0 = off). Larger = darker corners. */
  vignette: number
  /** unsharp/sharpen amount in [0,1] (0 = off) */
  sharpen: number
}

/** Film-grain parameters for the GPU compositor. */
export interface GrainParams {
  /** 0 = off; ~0..1 normalized strength (ffmpeg noise alls=8 ≈ 0.03) */
  strength: number
  /** when true the grain seed advances per frame (matches ffmpeg allf=t temporal grain) */
  temporal: boolean
}

/** One slideshow still and the time window it is on screen. */
export interface ImageMotionSpec {
  zoomFrom: number
  zoomTo: number
  panX: number
  panY: number
  ease: 'linear' | 'easeInOutCubic'
}

export interface RenderImageSpec {
  path: string
  startSec: number
  endSec: number
  /** deterministic per-still smart motion, omitted when static */
  motion?: ImageMotionSpec
}

/** A single caption group (phrase or word) with its on-screen window + emphasis. */
export interface CaptionGroupModel {
  startSec: number
  endSec: number
  /** the words in this group, in order. `kwOrd` = this word's ordinal among all
   *  keyword/emphasized words (drives the preset's keyword colour rotation). */
  words: Array<{ text: string; startSec: number; endSec: number; emphasis: boolean; kwOrd?: number }>
}

export interface CaptionHighlightBoxModel {
  enabled: boolean
  boxColor: string
  textColor: string
  radius: number
  padding: number
}

/** GPU caption plan — replaces libass. Drawn to a 2D canvas, uploaded as a texture and
 *  composited in the WebGL pass. Drive by frame index, never wall-clock. */
export interface CaptionFrameModel {
  groups: CaptionGroupModel[]
  /** the fully-resolved preset style (fonts/colours/box/glow/anchor) — authoritative;
   *  the fields below it are kept for change-detection keys and legacy callers. */
  style: ResolvedCaptionStyle
  preset: string
  font: string
  animation: string
  /** word | phrase rendering mode (matches the ffmpeg caption mode) */
  mode: 'word' | 'phrase'
  position: 'top' | 'middle' | 'bottom'
  lines: 1 | 2 | 3
  /** highlight colour for the active/emphasized word, as #rrggbb */
  highlightColor: string
  /** optional active-word rounded box, used by Submagic-style captions */
  highlightBox?: CaptionHighlightBoxModel
  /** phrase-window size for one-to-three-word active caption pages */
  wordsPerPage?: 1 | 2 | 3
  /** optional intro hook card shown for the first untilSec seconds */
  hook?: { text: string; untilSec: number }
}

/** Edge-gradient darkening overlay params. Rendered directly in the compositor shader
 *  (replaces the old .pam texture that browsers could not decode). `intensity` 0–100:
 *  0 = off, 50 = default, 100 = heavy. */
export interface OverlayParams {
  top: boolean
  right: boolean
  bottom: boolean
  left: boolean
  intensity: number
}

/**
 * Normalized [0,1] darkening alpha of the edge overlay at fractional coords (xN, yN both
 * in [0,1], origin top-left). Pure — the single source of truth for the ramp shared by the
 * WebGL shader (see render-worker/compositor.ts) and any raster fallback. Mirrors the ramp
 * the old overlayGradientPath() baked into a .pam: extent 0.12–0.60 of the frame, max alpha
 * 0–200/255, eased by pow(ramp, 1.7). Returns 0 when disabled or no edge is enabled.
 */
export function overlayAlphaAt(xN: number, yN: number, o: OverlayParams): number {
  const intensity = Math.max(0, Math.min(100, o.intensity))
  if (intensity === 0 || (!o.top && !o.right && !o.bottom && !o.left)) return 0
  const extentRatio = 0.12 + (intensity / 100) * 0.48
  const maxAlpha = ((intensity / 100) * 200) / 255
  const ramps = [
    o.bottom ? (yN - (1 - extentRatio)) / extentRatio : 0,
    o.top ? (extentRatio - yN) / extentRatio : 0,
    o.left ? (extentRatio - xN) / extentRatio : 0,
    o.right ? (xN - (1 - extentRatio)) / extentRatio : 0
  ]
  let ramp = 0
  for (const r of ramps) ramp = Math.max(ramp, Math.min(1, Math.max(0, r)))
  return maxAlpha * Math.pow(ramp, 1.7)
}

/** Optional per-frame motion (Ken Burns / punch zoom). */
export interface MotionSpec {
  kenBurns: boolean
  /** times (seconds) where a punch-zoom pulse should fire — already rate-limited
   *  via limitPunchHits() so dense emphasis can never strobe the viewer */
  punchAtSec: number[]
  /** slow push-in over the first ~1.2s ("zoom in at the start") */
  introZoom?: boolean
}

/** A visual transition at a segment boundary (from the style/effect plan). */
export interface TransitionSpec {
  atSec: number
  /** xfade-style transition name (fade, fadeblack, slideleft, zoomin, dissolve, …) */
  type: string
  durationSec: number
}

/**
 * Punch-zoom envelope at time t for a pulse that fired at `atSec` (pure). Quick
 * attack (~80ms), eased decay (~370ms), peak 1. Shared by the GPU compositor and any
 * preview math so every engine pulses identically; the ffmpeg expression in
 * render.ts mirrors the same curve.
 */
export function punchEnvelope(timeSec: number, atSec: number): number {
  const d = timeSec - atSec
  if (d < 0 || d >= 0.45) return 0
  return d < 0.08 ? d / 0.08 : Math.max(0, 1 - (d - 0.08) / 0.37)
}

/** Intro push-in zoom factor at time t (pure): starts at 1.09, eases out to 1 by 1.2s. */
export function introZoomAt(timeSec: number): number {
  const p = Math.max(0, Math.min(1, timeSec / 1.2))
  const eased = 1 - Math.pow(1 - p, 3)
  return 1.09 - 0.09 * eased
}

/** One B-roll segment and its playback window. */
export interface GpuBrollSegment {
  path: string
  startSec: number
  endSec: number
}

/** The full GPU render job spec. Serializable across the IPC boundary to the worker. */
export interface GpuRenderSpec {
  jobId: string
  width: number
  height: number
  fps: number
  durationSec: number
  images: RenderImageSpec[]
  broll?: GpuBrollSegment[]
  motion: MotionSpec
  /** per-boundary transitions from the style/effect plan (nearest within tolerance wins) */
  transitions?: TransitionSpec[]
  /** fallback transition when no planned one is near a segment boundary */
  defaultTransition?: { type: string; durationSec: number }
  grade: GradeParams
  grain: GrainParams
  /** edge-gradient darkening overlay, rendered directly in the shader (preferred) */
  overlay?: OverlayParams
  captions: CaptionFrameModel
  audio: { voicePath: string; sfxPath?: string }
  encoder: { codec: 'avc'; bitrateMbps: number; keyIntervalSec: number }
  out: { h264Path: string; finalPath: string }
}

/** WebCodecs AVC config string used everywhere (High@L4). Single source of truth. */
export const GPU_AVC_CODEC = 'avc1.640028'

/**
 * Which caption group is active at a given time (pure — unit-tested). Returns the index
 * of the group whose [startSec,endSec) window contains t, or -1 if none. Groups are
 * assumed sorted by startSec and non-overlapping.
 */
export function activeCaptionGroup(model: CaptionFrameModel, timeSec: number): number {
  for (let i = 0; i < model.groups.length; i++) {
    const g = model.groups[i]
    if (timeSec >= g.startSec && timeSec < g.endSec) return i
  }
  return -1
}

/**
 * Which word inside a group is active at a given time (pure — unit-tested). Returns the
 * index of the word whose window contains t, clamped so the last word stays active until
 * the group ends. Returns -1 when the group has no words.
 */
export function activeWordInGroup(group: CaptionGroupModel, timeSec: number): number {
  if (group.words.length === 0) return -1
  for (let i = 0; i < group.words.length; i++) {
    const w = group.words[i]
    const next = group.words[i + 1]
    const end = next ? next.startSec : group.endSec
    if (timeSec >= w.startSec && timeSec < end) return i
  }
  // before the first word's start (within the group window) → first word
  return timeSec < group.words[0].startSec ? 0 : group.words.length - 1
}

/** Which slideshow image is on screen at time t (pure). Falls back to the last image. */
export function activeImageIndex(images: RenderImageSpec[], timeSec: number): number {
  for (let i = 0; i < images.length; i++) {
    if (timeSec >= images[i].startSec && timeSec < images[i].endSec) return i
  }
  return images.length - 1
}

/** Total frame count for a spec (pure). */
export function totalFrames(spec: Pick<GpuRenderSpec, 'durationSec' | 'fps'>): number {
  return Math.max(1, Math.round(spec.durationSec * spec.fps))
}
