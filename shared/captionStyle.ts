// Caption preset system — the single source of truth consumed by BOTH caption
// renderers (the ffmpeg/libass ASS builder in electron/services/captions.ts and the
// canvas CaptionLayer in src/render-worker/captions.ts) and by the Compose UI's
// preset cards. Presets are modelled on the industry-standard short-form styles
// (CapCut / Submagic / Opus templates): each one has its own font, base colour,
// active-word treatment and a keyword palette that is deliberately DIFFERENT from
// the active-word treatment, so emphasis reads as meaning instead of noise.
// Pure + dependency-free so Node (main) and the renderer share one module.

export type CaptionActiveKind = 'color' | 'box' | 'karaoke' | 'glow'

export interface CaptionPresetSpec {
  id: string
  label: string
  /** one-line description shown on the preset card */
  blurb: string
  /** font family name — must match a bundled TTF in resources/fonts + @font-face */
  fontFamily: string
  /** canvas font-weight hint (the bundled TTFs are single-weight files) */
  fontWeight: 400 | 600 | 700 | 800
  uppercase: boolean
  /** fill colour of non-active, non-keyword words (#rrggbb) */
  baseColor: string
  /** karaoke presets dim not-yet-spoken words to this alpha (0–1) */
  futureAlpha?: number
  active: {
    kind: CaptionActiveKind
    /** active-word fill (inside the box for kind 'box') — overridable per project */
    color: string
    /** active-word scale-up (1 = none) */
    scale: number
    /** box behind the active word (kind 'box') — overridable per project */
    boxColor?: string
    /** box corner radius as a fraction of the font size */
    boxRadiusEm?: number
    /** glow colour around the active word (kind 'glow') */
    glowColor?: string
  }
  /** rotation palette for emphasized/keyword words; [] = reuse active colour */
  keywordColors: string[]
  /** stroke width as a fraction of the font size (0 = no stroke) */
  outlinePct: number
  outlineColor: string
  /** soft drop-shadow strength as a fraction of the font size (0 = none) */
  shadowPct: number
  /** translucent band behind the whole line (podcast-style lower third) */
  band?: { color: string; alpha: number }
  /** glow blur radius as a fraction of the font size (glow presets) */
  glowPct?: number
  /** multiplier on the aspect-derived base font size */
  sizeFactor: number
}

// Palette notes: #FFD93D is the classic "CapCut yellow"; the Hormozi keyword
// rotation (green/yellow/red) mirrors the Submagic "Hormozi 1" template.
export const CAPTION_PRESET_SPECS: CaptionPresetSpec[] = [
  {
    id: 'Hormozi',
    label: 'Hormozi',
    blurb: 'Bold caps, keyword colours rotate green/yellow/red',
    fontFamily: 'Anton',
    fontWeight: 400,
    uppercase: true,
    baseColor: '#FFFFFF',
    active: { kind: 'color', color: '#FFD93D', scale: 1.12 },
    keywordColors: ['#3BFF6F', '#FFD93D', '#FF4D4D'],
    outlinePct: 0.11,
    outlineColor: '#000000',
    shadowPct: 0.05,
    sizeFactor: 1
  },
  {
    id: 'Beast',
    label: 'Beast',
    blurb: 'Chunky comic caps with a heavy outline',
    fontFamily: 'Luckiest Guy',
    fontWeight: 400,
    uppercase: true,
    baseColor: '#FFFFFF',
    active: { kind: 'color', color: '#FFE259', scale: 1.16 },
    keywordColors: ['#7CFC00', '#FF5757'],
    outlinePct: 0.13,
    outlineColor: '#000000',
    shadowPct: 0.06,
    sizeFactor: 1.02
  },
  {
    id: 'Karaoke',
    label: 'Karaoke',
    blurb: 'Spoken words light up as they are said',
    fontFamily: 'Montserrat ExtraBold',
    fontWeight: 800,
    uppercase: true,
    baseColor: '#FFFFFF',
    futureAlpha: 0.72,
    active: { kind: 'karaoke', color: '#FFD93D', scale: 1.05 },
    keywordColors: [],
    outlinePct: 0.08,
    outlineColor: '#000000',
    shadowPct: 0.04,
    sizeFactor: 0.94
  },
  {
    id: 'Boxed',
    label: 'Boxed',
    blurb: 'Colour box slides across the active word',
    fontFamily: 'Archivo Black',
    fontWeight: 400,
    uppercase: true,
    baseColor: '#FFFFFF',
    active: { kind: 'box', color: '#111111', scale: 1.04, boxColor: '#FFD93D', boxRadiusEm: 0.18 },
    keywordColors: [],
    outlinePct: 0.07,
    outlineColor: '#000000',
    shadowPct: 0,
    sizeFactor: 0.96
  },
  {
    id: 'Word',
    label: 'Word',
    blurb: 'One huge word at a time',
    fontFamily: 'Anton',
    fontWeight: 400,
    uppercase: true,
    baseColor: '#FFFFFF',
    active: { kind: 'color', color: '#FFFFFF', scale: 1.08 },
    keywordColors: ['#FFD93D'],
    outlinePct: 0.1,
    outlineColor: '#000000',
    shadowPct: 0.06,
    sizeFactor: 1.22
  },
  {
    id: 'Neon',
    label: 'Neon',
    blurb: 'Condensed caps with an electric glow',
    fontFamily: 'Bebas Neue',
    fontWeight: 400,
    uppercase: true,
    baseColor: '#FFFFFF',
    active: { kind: 'glow', color: '#9BF0FF', scale: 1.06, glowColor: '#22D3EE' },
    keywordColors: ['#FF7BF5'],
    outlinePct: 0.03,
    outlineColor: '#0E7490',
    shadowPct: 0,
    glowPct: 0.28,
    sizeFactor: 1.04
  },
  {
    id: 'Minimal',
    label: 'Minimal',
    blurb: 'Quiet sentence-case, soft shadow, no stroke',
    fontFamily: 'Montserrat SemiBold',
    fontWeight: 600,
    uppercase: false,
    baseColor: '#FFFFFF',
    active: { kind: 'color', color: '#FFD93D', scale: 1 },
    keywordColors: [],
    outlinePct: 0,
    outlineColor: '#000000',
    shadowPct: 0.09,
    sizeFactor: 0.8
  },
  {
    id: 'Podcast',
    label: 'Podcast',
    blurb: 'Lower-third band, calm and readable',
    fontFamily: 'Oswald SemiBold',
    fontWeight: 600,
    uppercase: true,
    baseColor: '#FFFFFF',
    active: { kind: 'color', color: '#FFD93D', scale: 1 },
    keywordColors: [],
    outlinePct: 0,
    outlineColor: '#000000',
    shadowPct: 0,
    band: { color: '#000000', alpha: 0.55 },
    sizeFactor: 0.82
  }
]

export const CAPTION_PRESET_IDS = CAPTION_PRESET_SPECS.map((p) => p.id)

/** Legacy preset ids stored in existing projects/profiles → their modern spec. */
const PRESET_ALIASES: Record<string, string> = {
  Submagic: 'Boxed',
  Pop: 'Karaoke',
  Bold: 'Beast'
}

export function captionPresetSpec(id: string | undefined): CaptionPresetSpec {
  const wanted = PRESET_ALIASES[id ?? ''] ?? id
  return CAPTION_PRESET_SPECS.find((p) => p.id === wanted) ?? CAPTION_PRESET_SPECS[0]
}

/** Serializable, per-project resolved caption style — the exact object both caption
 *  renderers draw from. Project-level colour/font overrides are already applied. */
export interface ResolvedCaptionStyle {
  presetId: string
  fontFamily: string
  fontWeight: number
  uppercase: boolean
  baseColor: string
  futureAlpha?: number
  activeKind: CaptionActiveKind
  activeColor: string
  activeScale: number
  boxColor?: string
  boxRadiusEm?: number
  glowColor?: string
  keywordColors: string[]
  outlinePct: number
  outlineColor: string
  shadowPct: number
  band?: { color: string; alpha: number }
  glowPct?: number
  sizeFactor: number
  /** vertical anchor of the caption block centre, % of frame height from the top */
  anchorPct: number
}

export interface CaptionStyleInputs {
  captionPreset?: string
  captionFont?: string
  captionHighlightColor?: string
  captionBoxColor?: string
  captionPosition?: 'top' | 'middle' | 'bottom'
  /** fine vertical placement (% from top); overrides the coarse position when set */
  captionOffsetY?: number | null
  captionAspect?: '16:9' | '1:1' | '9:16'
}

const HEX_RE = /^#?[0-9a-f]{6}$/i

function cleanHex(v: string | undefined | null): string | undefined {
  if (!v || !HEX_RE.test(v.trim())) return undefined
  const s = v.trim()
  return s.startsWith('#') ? s : `#${s}`
}

/** Default anchor (% from top) for the coarse position, matching the legacy margins. */
export function captionAnchorPct(
  position: 'top' | 'middle' | 'bottom' | undefined,
  offsetY: number | null | undefined,
  aspect: '16:9' | '1:1' | '9:16' | undefined
): number {
  if (offsetY != null && Number.isFinite(offsetY)) return Math.max(4, Math.min(96, offsetY))
  const tall = aspect === '9:16'
  if (position === 'top') return tall ? 16 : 13
  if (position === 'middle') return 50
  return tall ? 72 : 74
}

/** Bundled caption fonts (family → TTF in resources/fonts). The families listed here
 *  are the only ones guaranteed to exist for BOTH libass (ffmpeg burn) and the canvas. */
export const CAPTION_FONTS: Array<{ family: string; file: string }> = [
  { family: 'Anton', file: 'Anton-Regular.ttf' },
  { family: 'Archivo Black', file: 'ArchivoBlack-Regular.ttf' },
  { family: 'Bebas Neue', file: 'BebasNeue-Regular.ttf' },
  { family: 'Luckiest Guy', file: 'LuckiestGuy-Regular.ttf' },
  { family: 'Montserrat ExtraBold', file: 'Montserrat-ExtraBold.ttf' },
  { family: 'Montserrat SemiBold', file: 'Montserrat-SemiBold.ttf' },
  { family: 'Oswald SemiBold', file: 'Oswald-SemiBold.ttf' }
]

/** Map legacy font names (previously offered in the UI but never bundled) onto the
 *  closest bundled family so old projects render deterministically everywhere. */
const FONT_ALIASES: Record<string, string> = {
  Montserrat: 'Montserrat ExtraBold',
  Oswald: 'Oswald SemiBold',
  Impact: 'Anton',
  Arial: 'Montserrat SemiBold',
  Roboto: 'Montserrat SemiBold',
  'Bebas Neue': 'Bebas Neue'
}

export function resolveCaptionFont(font: string | undefined, fallback: string): string {
  const cleaned = (font ?? '').replace(/[,\r\n]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return fallback
  if (CAPTION_FONTS.some((f) => f.family === cleaned)) return cleaned
  return FONT_ALIASES[cleaned] ?? cleaned
}

export function resolveCaptionStyle(p: CaptionStyleInputs): ResolvedCaptionStyle {
  const spec = captionPresetSpec(p.captionPreset)
  const highlight = cleanHex(p.captionHighlightColor)
  const box = cleanHex(p.captionBoxColor)
  return {
    presetId: spec.id,
    fontFamily: resolveCaptionFont(p.captionFont, spec.fontFamily),
    fontWeight: spec.fontWeight,
    uppercase: spec.uppercase,
    baseColor: spec.baseColor,
    futureAlpha: spec.futureAlpha,
    activeKind: spec.active.kind,
    activeColor: highlight ?? spec.active.color,
    activeScale: spec.active.scale,
    boxColor: spec.active.kind === 'box' ? (box ?? spec.active.boxColor) : undefined,
    boxRadiusEm: spec.active.boxRadiusEm,
    glowColor: spec.active.glowColor,
    keywordColors: spec.keywordColors,
    outlinePct: spec.outlinePct,
    outlineColor: spec.outlineColor,
    shadowPct: spec.shadowPct,
    band: spec.band,
    glowPct: spec.glowPct,
    sizeFactor: spec.sizeFactor,
    anchorPct: captionAnchorPct(p.captionPosition, p.captionOffsetY, p.captionAspect)
  }
}

/** Colour for the Nth emphasized/keyword word — rotates the preset's palette so
 *  consecutive keywords differ (never the same treatment as the active word unless
 *  the preset opts out with an empty palette). */
export function keywordColor(style: Pick<ResolvedCaptionStyle, 'keywordColors' | 'activeColor'>, kwOrd: number): string {
  if (!style.keywordColors.length) return style.activeColor
  return style.keywordColors[((kwOrd % style.keywordColors.length) + style.keywordColors.length) % style.keywordColors.length]
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'is', 'are', 'was', 'it', 'you', 'your',
  'i', 'we', 'they', 'he', 'she', 'for', 'with', 'as', 'at', 'by', 'be', 'this', 'that', 'have', 'has',
  'from', 'were', 'been', 'will', 'when', 'then', 'than', 'what', 'just', 'like', 'into', 'their', 'there',
  'about', 'which', 'would', 'could', 'should'
])

/** Is this word a keyword worth emphasizing? Explicit flags always win; with
 *  auto-keywords on, long non-stopwords qualify. Shared so the ASS builder and the
 *  GPU caption model mark the SAME words. */
export function isCaptionKeyword(word: string, emphasis: boolean, autoKeywords: boolean): boolean {
  if (emphasis) return true
  if (!autoKeywords) return false
  const norm = word.toLowerCase().replace(/[^a-z]/g, '')
  return norm.length >= 6 && !STOPWORDS.has(norm)
}

/**
 * Rate-limit punch-zoom hit times so back-to-back emphasized words cannot strobe the
 * viewer: enforce a minimum gap and a hard cap. Pure — used by the ffmpeg expression
 * builder, the GPU spec builder, and the preview so all three pulse identically.
 */
export function limitPunchHits(hits: number[], opts?: { minGapSec?: number; maxTotal?: number }): number[] {
  const minGap = opts?.minGapSec ?? 2.4
  const maxTotal = opts?.maxTotal ?? 48
  const sorted = [...new Set(hits.filter((h) => Number.isFinite(h) && h >= 0))].sort((a, b) => a - b)
  const out: number[] = []
  for (const h of sorted) {
    if (out.length >= maxTotal) break
    if (!out.length || h - out[out.length - 1] >= minGap) out.push(h)
  }
  return out
}
