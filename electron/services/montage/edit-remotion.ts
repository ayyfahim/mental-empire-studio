import type { ProjectImage, TranscriptWord, VideoStyle } from '../../../shared/types'
import type { ResolvedCaptionStyle } from '../../../shared/captionStyle'

// Remotion edit_decisions builder for the OpenMontage bridge.
//
// OpenMontage's VideoCompose (operation:"render", render_runtime:"remotion") renders the
// `remotion-composer` "Explainer" family. The `edit_decisions` object is passed to the Remotion
// CLI as inputProps, so its shape must match remotion-composer/src/Explainer.tsx:
//   { renderer_family, cuts[], overlays[], captions[], audio{}, subtitles{}, themeConfig{}, metadata{} }
// Cut/caption/asset helpers live here (the "base" runtime); edit-hyperframes.ts reuses them since
// HyperFramesCompose consumes the identical edit_decisions shape (only render_runtime differs).
//
// The shape is validated against the real OM source under OpenMontage/remotion-composer +
// OpenMontage/tools/video/video_compose.py — see docs/OPENMONTAGE_BRIDGE.md §2.

/** Everything a runtime builder needs, normalized from the MES project by montage-compose.ts. */
export interface MontageComposeContext {
  projectId: string
  title: string
  channel: string
  /** ordered, range-aligned still images (may be empty) */
  images: ProjectImage[]
  /** transcript word timings (may be empty) */
  words: TranscriptWord[]
  /** total (or sample-bounded) composition duration in seconds */
  durationSec: number
  aspect: '16:9' | '1:1' | '9:16'
  dims: { w: number; h: number }
  fps: number
  caption: ResolvedCaptionStyle
  captionsEnabled: boolean
  style: VideoStyle
  /** project Ken Burns preference — drives the still-image camera move */
  kenBurns: boolean
  /** absolute path to the narration mp3 */
  audioPath: string
  /** true → a short bounded sample render (Compose preview) */
  sample: boolean
}

/** One OpenMontage `cut` (Explainer `Cut` shape + slideshow-risk enrichment fields). */
export interface MontageCut {
  id: string
  /** asset id (resolved to a path via asset_manifest) or empty for synthetic scenes */
  source?: string
  type?: string
  in_seconds: number
  out_seconds: number
  animation?: string
  text?: string
  stat?: string
  subtitle?: string
  heroSubtitle?: string
  accentColor?: string
  // --- enrichment consumed by lib/slideshow_risk.py + lib/delivery_promise.py ---
  reason?: string
  shot_intent?: string
  information_role?: string
  narrative_role?: string
  hero_moment?: boolean
  shot_language?: { shot_size?: string; camera_movement?: string; lighting_key?: string }
}

const SHOT_SIZES = ['wide', 'medium', 'close']
const CAMERA_MOVES = ['push-in', 'pull-out', 'pan-right', 'pan-left']

/** Map the MES caption aspect to the closest OpenMontage media-profile name (controls the
 *  Remotion/HyperFrames output dimensions). See OpenMontage/lib/media_profiles.py. */
export function mapAspectToProfile(aspect: MontageComposeContext['aspect']): string {
  if (aspect === '9:16') return 'youtube_shorts'
  if (aspect === '1:1') return 'instagram_feed'
  return 'youtube_landscape'
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** A short, unique human description of what plays during [inSec, outSec], pulled from the
 *  transcript. Unique per-cut descriptions keep OpenMontage's slideshow-risk repetition score low. */
function describeWindow(words: TranscriptWord[], inSec: number, outSec: number, fallback: string): string {
  const hit = words.filter((w) => w.start >= inSec - 0.001 && w.start < outSec)
  const text = hit.map((w) => w.word).join(' ').trim()
  const snippet = text.slice(0, 90)
  return snippet || fallback
}

/** Resolve per-image [in,out] windows. Trusts the project's stored ranges when they are
 *  strictly increasing + non-degenerate; otherwise distributes images evenly. The final cut
 *  always ends exactly at durationSec so the composition length matches the narration. */
function resolveImageTimings(images: ProjectImage[], durationSec: number): Array<{ in: number; out: number }> {
  const n = images.length
  if (n === 0) return []
  const usable =
    durationSec > 0 &&
    images.every((im, i) => im.rangeEnd > im.rangeStart && (i === 0 || im.rangeStart >= images[i - 1].rangeStart))
  if (usable) {
    return images.map((im, i) => ({
      in: i === 0 ? 0 : round3(Math.max(0, Math.min(im.rangeStart, durationSec))),
      out: i === n - 1 ? round3(durationSec) : round3(Math.max(im.rangeStart + 0.2, Math.min(im.rangeEnd, durationSec)))
    }))
  }
  const seg = durationSec / n
  return images.map((_, i) => ({ in: round3(i * seg), out: round3(i === n - 1 ? durationSec : (i + 1) * seg) }))
}

/** asset_manifest.assets[] — one entry per still image; cut.source references these by id.
 *  VideoCompose._render requires a non-empty asset_manifest object. */
export function buildAssetManifest(ctx: MontageComposeContext): Record<string, unknown> {
  const assets = ctx.images.map((im, i) => ({
    id: `img-${i}`,
    path: im.path,
    type: 'image',
    role: 'broll'
  }))
  return { version: 1, project_id: ctx.projectId, assets }
}

/** Still-image cuts with Ken Burns motion + purpose metadata (the common case for MES). */
export function buildImageCuts(ctx: MontageComposeContext): MontageCut[] {
  const timings = resolveImageTimings(ctx.images, ctx.durationSec)
  const move = ctx.kenBurns ? 'ken-burns' : 'zoom-in'
  const n = ctx.images.length
  return ctx.images.map((_im, i) => {
    const t = timings[i]
    return {
      id: `img-cut-${i}`,
      source: `img-${i}`,
      in_seconds: t.in,
      out_seconds: t.out,
      animation: move,
      reason: describeWindow(ctx.words, t.in, t.out, `illustrative still ${i + 1} of ${n}`),
      shot_intent: i === 0 ? 'establish the topic' : 'advance the narration beat',
      information_role: 'illustrate',
      narrative_role: i === 0 ? 'open' : i === n - 1 ? 'resolve' : 'develop',
      hero_moment: i === 0,
      shot_language: {
        shot_size: SHOT_SIZES[i % SHOT_SIZES.length],
        camera_movement: CAMERA_MOVES[i % CAMERA_MOVES.length]
      }
    }
  })
}

/** Fallback scene cuts when a project has no still images: fill the timeline with alternating
 *  typography scenes derived from the transcript so the composition still covers the narration. */
export function buildScriptCuts(ctx: MontageComposeContext): MontageCut[] {
  const dur = ctx.durationSec
  if (dur <= 0) return []
  const perScene = 5
  const count = Math.max(1, Math.min(24, Math.ceil(dur / perScene)))
  const seg = dur / count
  const cycle: Array<'hero_title' | 'text_card' | 'callout'> = ['hero_title', 'text_card', 'callout']
  return Array.from({ length: count }, (_v, i) => {
    const inSec = round3(i * seg)
    const outSec = round3(i === count - 1 ? dur : (i + 1) * seg)
    const type = i === 0 ? 'hero_title' : cycle[i % cycle.length]
    const text = describeWindow(ctx.words, inSec, outSec, ctx.title || 'Mental Empire')
    const cut: MontageCut = {
      id: `script-cut-${i}`,
      type,
      in_seconds: inSec,
      out_seconds: outSec,
      text: type === 'hero_title' && i === 0 ? ctx.title || text : text,
      animation: 'fade',
      reason: text,
      shot_intent: 'carry the narration where no footage exists',
      information_role: 'explain',
      narrative_role: i === 0 ? 'open' : i === count - 1 ? 'resolve' : 'develop',
      hero_moment: i === 0,
      shot_language: { shot_size: SHOT_SIZES[i % SHOT_SIZES.length] }
    }
    if (type === 'hero_title' && i === 0 && ctx.channel) cut.heroSubtitle = ctx.channel
    return cut
  })
}

/** Word-level captions for the Remotion CaptionOverlay (`WordCaption { word, startMs, endMs }`). */
export function buildCaptionWords(ctx: MontageComposeContext): Array<{ word: string; startMs: number; endMs: number }> {
  if (!ctx.captionsEnabled) return []
  return ctx.words
    .filter((w) => w.word.trim() && w.end > w.start && w.start < ctx.durationSec)
    .map((w) => ({
      word: w.word,
      startMs: Math.round(w.start * 1000),
      endMs: Math.round(Math.min(w.end, ctx.durationSec) * 1000)
    }))
}

/** Narration (+ optional room for music later) as the Explainer `audio` layer. */
export function buildAudioConfig(ctx: MontageComposeContext): Record<string, unknown> {
  return { narration: { src: ctx.audioPath, volume: 1 } }
}

/** Intro title as an overlay (does not consume timeline / desync narration). */
export function buildOverlays(ctx: MontageComposeContext): Record<string, unknown>[] {
  const overlays: Record<string, unknown>[] = []
  if (ctx.title && ctx.durationSec > 3) {
    overlays.push({
      type: 'hero_title',
      text: ctx.title,
      subtitle: ctx.channel || undefined,
      in_seconds: 0,
      out_seconds: round3(Math.min(2.6, ctx.durationSec * 0.25)),
      accentColor: ctx.caption.activeColor
    })
  }
  return overlays
}

/** Map the resolved MES caption style onto the Remotion themeConfig (partial — merged over
 *  DEFAULT_THEME by resolveTheme in remotion-composer/src/Root.tsx). Carries the active-word
 *  highlight colour + box background so OpenMontage captions match the MES preset (§4C). */
export function buildThemeConfig(ctx: MontageComposeContext): Record<string, unknown> {
  const theme: Record<string, unknown> = { captionHighlightColor: ctx.caption.activeColor }
  if (ctx.caption.activeKind === 'box' && ctx.caption.boxColor) theme.captionBackgroundColor = ctx.caption.boxColor
  return theme
}

/** Serializable caption-style summary carried in metadata for the ffmpeg/HyperFrames paths
 *  and for debugging (never used to pick a runtime). */
export function captionStyleMeta(ctx: MontageComposeContext): Record<string, unknown> {
  return {
    preset: ctx.caption.presetId,
    font_family: ctx.caption.fontFamily,
    active_kind: ctx.caption.activeKind,
    active_color: ctx.caption.activeColor,
    base_color: ctx.caption.baseColor,
    uppercase: ctx.caption.uppercase,
    anchor_pct: ctx.caption.anchorPct
  }
}

/** Shared edit_decisions core (everything except render_runtime/renderer_family), reused by both
 *  the Remotion and HyperFrames builders. */
export function buildEditDecisionsCore(ctx: MontageComposeContext): Record<string, unknown> {
  const cuts = ctx.images.length ? buildImageCuts(ctx) : buildScriptCuts(ctx)
  const captions = buildCaptionWords(ctx)
  return {
    cuts,
    overlays: buildOverlays(ctx),
    captions,
    audio: buildAudioConfig(ctx),
    subtitles: { enabled: ctx.captionsEnabled },
    themeConfig: buildThemeConfig(ctx),
    metadata: {
      source: 'mental-empire-studio',
      project_id: ctx.projectId,
      title: ctx.title,
      duration_seconds: round3(ctx.durationSec),
      sample: ctx.sample,
      caption_style: captionStyleMeta(ctx),
      compose_target: { width: ctx.dims.w, height: ctx.dims.h, fit: 'cover' }
    }
  }
}

/** Pick the Remotion renderer_family (→ composition id) from the MES video style.
 *  Cinematic/Heartfelt → CinematicRenderer family; everything else → Explainer family.
 *  See VideoCompose.RENDERER_FAMILY_MAP. */
export function remotionRendererFamily(style: VideoStyle): string {
  if (style === 'Cinematic' || style === 'Heartfelt') return 'cinematic-trailer'
  return 'explainer-data'
}

/** Build the full Remotion edit_decisions (render_runtime:'remotion'). */
export function buildRemotionEditDecisions(ctx: MontageComposeContext): Record<string, unknown> {
  return {
    render_runtime: 'remotion',
    renderer_family: remotionRendererFamily(ctx.style),
    ...buildEditDecisionsCore(ctx)
  }
}
