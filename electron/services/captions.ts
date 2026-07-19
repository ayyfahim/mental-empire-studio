import type { Project, TranscriptWord } from '../../shared/types'
import { textPresetTag, type PlanTextEffect } from '../../shared/effectPlan'
import {
  isCaptionKeyword,
  keywordColor,
  resolveCaptionStyle,
  type ResolvedCaptionStyle
} from '../../shared/captionStyle'

// Pure ASS (Advanced SubStation Alpha) generation for CapCut-style burned captions.
// All visual decisions come from the shared preset table (shared/captionStyle.ts), so
// this file only translates a ResolvedCaptionStyle + word timings into ASS events.
// The canvas renderer (src/render-worker/captions.ts) consumes the SAME resolved style,
// keeping the live preview and the ffmpeg burn visually in lockstep.

export type CaptionAspect = '16:9' | '1:1' | '9:16'

export interface CaptionOptions {
  preset: string
  /** renderer-selected font family; falls back to the preset's default */
  font?: string
  /** renderer-selected animation preset */
  animation?: string
  aspect: CaptionAspect
  /** auto-emphasize detected keywords in addition to per-word emphasis flags */
  keywords: boolean
  /** words per on-screen caption group (Word preset forces 1) */
  perGroup?: number
  /** number of stacked caption lines the user wants on screen */
  lines?: 1 | 2 | 3
  /** word mode keeps active-word highlighting; phrase mode reduces long-form CPU burn */
  mode?: 'word' | 'phrase'
  /** beta: intro "hook" text card shown centered for the first untilSec seconds */
  hook?: { text: string; untilSec: number }
  /** beta: a leading ASS override tag applied to every caption line (the style "feel") */
  styleLead?: string
  /** beta: per-word / hook text-effect presets from the validated effect plan */
  textEffects?: PlanTextEffect[]
  /** coarse vertical caption placement */
  position?: Project['captionPosition']
  /** fine vertical placement (% of frame height from the top); overrides position */
  offsetY?: number | null
  /** active/highlighted word text colour, as #rrggbb */
  highlightColor?: string
  /** boxed-preset box colour, as #rrggbb */
  boxColor?: string
  /** active-word box settings (legacy shape, still honoured as overrides) */
  highlightBox?: { enabled: boolean; boxColor: string; textColor: string; radius?: number; padding?: number }
  /** boxed-preset phrase-window size */
  wordsPerPage?: 1 | 2 | 3
}

export interface AssResult {
  ass: string
  /** times (seconds) where a MANUALLY emphasized word hits — drives punch-zoom.
   *  Auto-detected keywords deliberately do NOT zoom (they only colour), so turning
   *  on keyword highlighting can never strobe the video. */
  zoomHits: number[]
}

export function resolutionFor(aspect: CaptionAspect): { w: number; h: number } {
  if (aspect === '1:1') return { w: 1080, h: 1080 }
  if (aspect === '9:16') return { w: 1080, h: 1920 }
  return { w: 1920, h: 1080 }
}

function secToAss(t: number): string {
  const cs = Math.max(0, Math.round(t * 100))
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  const c = cs % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`
}

function escapeAss(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, ' ')
}

/** #rrggbb → ASS &HBBGGRR (colour only). */
function hexToAss(hex: string, fallback = '&H00FFFFFF'): string {
  const m = (hex ?? '').trim().match(/^#?([0-9a-f]{6})$/i)
  if (!m) return fallback
  const s = m[1].toUpperCase()
  return `&H00${s.slice(4, 6)}${s.slice(2, 4)}${s.slice(0, 2)}`
}

/** #rrggbb + opacity (0–1, 1 = opaque) → ASS &HAABBGGRR. */
function hexToAssWithAlpha(hex: string, opacity: number): string {
  const m = (hex ?? '').trim().match(/^#?([0-9a-f]{6})$/i)
  const s = (m ? m[1] : 'FFFFFF').toUpperCase()
  const a = Math.max(0, Math.min(255, Math.round((1 - opacity) * 255)))
  return `&H${a.toString(16).toUpperCase().padStart(2, '0')}${s.slice(4, 6)}${s.slice(2, 4)}${s.slice(0, 2)}`
}

function clampWordsPerPage(v: unknown): 1 | 2 | 3 {
  return v === 2 || v === 3 ? v : 1
}

function clampLines(v: unknown): 1 | 2 | 3 {
  return v === 2 || v === 3 ? v : 1
}

export interface CaptionGroup {
  words: TranscriptWord[]
  start: number
  end: number
}

/** Chunk words into contiguous on-screen groups of at most `perGroup`. */
export function groupWords(words: TranscriptWord[], perGroup: number): CaptionGroup[] {
  const groups: CaptionGroup[] = []
  for (let i = 0; i < words.length; i += perGroup) {
    const chunk = words.slice(i, i + perGroup)
    if (chunk.length === 0) continue
    groups.push({ words: chunk, start: chunk[0].start, end: chunk[chunk.length - 1].end })
  }
  return groups
}

function styleLine(style: ResolvedCaptionStyle, size: number): string {
  const boxed = style.activeKind === 'box'
  const banded = !!style.band
  const borderStyle = boxed || banded ? 3 : 1
  const back = boxed
    ? hexToAss(style.boxColor ?? '#FFD93D')
    : banded
      ? hexToAssWithAlpha(style.band!.color, style.band!.alpha)
      : '&H00000000'
  // BorderStyle 3 uses Outline as the box padding; BorderStyle 1 uses it as stroke width.
  const outlineW = boxed || banded
    ? Math.max(4, Math.round(size * 0.16))
    : Math.round(size * style.outlinePct * 10) / 10
  const shadow = boxed || banded ? 0 : Math.round(size * style.shadowPct * 10) / 10
  const outlineColor = style.activeKind === 'glow' ? hexToAss(style.glowColor ?? style.outlineColor) : hexToAss(style.outlineColor)
  const primary = hexToAss(style.baseColor)
  // Alignment 5 (middle-centre) + per-event \pos gives exact vertical placement; the
  // margins below are only libass fallbacks and never take effect.
  // Format: Name,Font,Size,Primary,Secondary,Outline,Back,Bold,Italic,Underline,StrikeOut,
  // ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
  return `Style: Default,${style.fontFamily},${size},${primary},${primary},${outlineColor},${back},0,0,0,0,100,100,0,0,${borderStyle},${outlineW},${shadow},5,60,60,0,1`
}

function animationWordTag(animation: string | undefined, active: boolean, scalePct: number): string {
  if (!active) return ''
  const s = Math.round(scalePct)
  const overshoot = Math.round(scalePct * 1.08)
  switch (animation) {
    case 'None':
    case 'Fade':
      return ''
    case 'Bounce':
      return `\\t(0,80,\\fscx${overshoot}\\fscy${overshoot})\\t(80,150,\\fscx${Math.round(scalePct * 0.94)}\\fscy${Math.round(scalePct * 0.94)})\\t(150,230,\\fscx${s}\\fscy${s})`
    case 'Slide':
      return `\\t(0,140,\\fscx${s}\\fscy${s})`
    case 'Type':
      return `\\t(0,80,\\fscx${s}\\fscy${s})`
    case 'Pop-in':
    default:
      return `\\t(0,120,\\fscx${overshoot}\\fscy${overshoot})\\t(120,190,\\fscx${s}\\fscy${s})`
  }
}

function lineLead(
  animation: string | undefined,
  pos: { x: number; y: number },
  extraTags: string,
  fadeIn = true,
  fadeOut = true
): string {
  // The fade is attached only to the first/last word-event of a group so libass
  // updates the active word in place instead of re-fading the whole line (flicker).
  const inMs = fadeIn ? (animation === 'Fade' ? 160 : animation === 'None' ? 0 : 20) : 0
  const outMs = fadeOut ? 20 : 0
  const fad = `\\fad(${inMs},${outMs})`
  if (animation === 'Slide' && fadeIn) {
    return `{${fad}\\move(${pos.x},${pos.y + 34},${pos.x},${pos.y},0,150)${extraTags}}`
  }
  return `{${fad}\\pos(${pos.x},${pos.y})${extraTags}}`
}

function wordsWithLineBreaks(words: string[], lines: 1 | 2 | 3): string {
  if (lines <= 1 || words.length <= 2) return words.join(' ')
  const perLine = Math.ceil(words.length / lines)
  const out: string[] = []
  for (let i = 0; i < words.length; i += perLine) out.push(words.slice(i, i + perLine).join(' '))
  return out.join('\\N')
}

export function buildAss(words: TranscriptWord[], opts: CaptionOptions): AssResult {
  const style = resolveCaptionStyle({
    captionPreset: opts.preset,
    captionFont: opts.font,
    captionHighlightColor: opts.highlightBox?.enabled ? (opts.highlightBox.textColor ?? opts.highlightColor) : opts.highlightColor,
    captionBoxColor: opts.boxColor ?? opts.highlightBox?.boxColor,
    captionPosition: opts.position,
    captionOffsetY: opts.offsetY,
    captionAspect: opts.aspect
  })
  const { w, h } = resolutionFor(opts.aspect)
  const basePx = Math.round(Math.max(64, Math.min(opts.aspect === '9:16' ? h * 0.11 : h * 0.085, opts.aspect === '9:16' ? 150 : 108)))
  const size = Math.round(basePx * style.sizeFactor)
  const boxed = style.activeKind === 'box'
  const karaoke = style.activeKind === 'karaoke'

  const lines = boxed ? 1 : clampLines(opts.lines)
  const wordsPerLine = opts.aspect === '16:9' ? 4 : 3
  const defaultGroup = wordsPerLine * lines
  const perGroup = boxed
    ? clampWordsPerPage(opts.wordsPerPage)
    : style.presetId === 'Word' && lines === 1
      ? 1
      : Math.max(1, opts.perGroup ?? defaultGroup)
  const pos = { x: Math.round(w / 2), y: Math.round((h * style.anchorPct) / 100) }
  const groups = groupWords(words, perGroup)
  const zoomHits: number[] = []
  const seenZoomHits = new Set<number>()

  // Per-word text-effect presets from the plan → ASS tag, keyed by normalized word.
  const wordFx = new Map<string, string>()
  for (const e of opts.textEffects ?? []) {
    if (e.word) wordFx.set(e.word.toLowerCase().replace(/[^a-z0-9]/g, ''), textPresetTag(e.preset))
  }
  const hookFx = (opts.textEffects ?? []).find((e) => e.scope === 'hook')

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    styleLine(style, size),
    // Hook style: big, centered on screen, heavy outline (alignment 5 = middle-centre).
    `Style: Hook,Anton,${Math.round(h * 0.12)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,8,0,5,80,80,80,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ].join('\n')

  // Neon-style glow: soften the coloured border on every line.
  const glowTag = style.activeKind === 'glow' ? `\\blur${Math.max(2, Math.round(size * 0.07))}` : ''

  const baseAss = hexToAss(style.baseColor)
  const activeAss = hexToAss(style.activeColor)
  const futureTag = karaoke && style.futureAlpha != null
    ? `\\1a&H${Math.max(0, Math.min(255, Math.round((1 - style.futureAlpha) * 255))).toString(16).toUpperCase().padStart(2, '0')}&`
    : ''

  // Keyword ordinal per transcript word id → stable colour rotation across the video.
  const kwOrdByStart = new Map<number, number>()
  let kwCount = 0
  for (const word of words) {
    if (isCaptionKeyword(word.word, word.emphasis, opts.keywords)) kwOrdByStart.set(word.start, kwCount++)
    if (word.emphasis && !seenZoomHits.has(word.start)) {
      seenZoomHits.add(word.start)
      zoomHits.push(word.start)
    }
  }

  const caseText = (t: string): string => (style.uppercase ? t.toUpperCase() : t)

  /** Render one word for a word-mode event. `state`: past | active | future. */
  const wordText = (word: TranscriptWord, state: 'past' | 'active' | 'future'): string => {
    const body = escapeAss(caseText(word.word))
    const fx = wordFx.get(word.word.toLowerCase().replace(/[^a-z0-9]/g, '')) ?? ''
    const kwOrd = kwOrdByStart.get(word.start)
    const isKw = kwOrd != null
    let color = baseAss
    let alphaTag = ''
    if (boxed) {
      // Everything inside the colour box uses the box text colour; the active word
      // still pops via scale so the reader can follow along.
      color = activeAss
    } else if (state === 'active') {
      color = activeAss
    } else if (isKw) {
      // Keywords keep their rotation colour even while not active — the emphasis
      // treatment is persistent colour, DISTINCT from the transient active pop.
      color = hexToAss(keywordColor(style, kwOrd))
    } else if (karaoke) {
      color = state === 'past' ? activeAss : baseAss
      if (state === 'future') alphaTag = futureTag
    }
    const scalePct = Math.round(style.activeScale * 100)
    const pop = state === 'active' && style.activeScale > 1 ? animationWordTag(opts.animation, true, scalePct) : ''
    const reset = state === 'active' && style.activeScale > 1 ? '{\\fscx100\\fscy100}' : ''
    return `${fx}{\\1c${color}${alphaTag}${pop}}${body}${reset}`
  }

  const mode = boxed ? 'word' : (opts.mode ?? 'word')
  const dialogues = mode === 'phrase'
    ? groups.map((g) => {
      const lineStart = g.start
      const lineEnd = Math.max(lineStart + 0.3, g.end)
      const text = wordsWithLineBreaks(g.words.map((word) => wordText(word, 'future')), lines)
      return `Dialogue: 0,${secToAss(lineStart)},${secToAss(lineEnd)},Default,,0,0,0,,${opts.styleLead ?? ''}${lineLead(opts.animation, pos, glowTag)}${text}`
    })
    : groups.flatMap((g) =>
      g.words.map((activeWord, activeIdx) => {
        const lineStart = activeWord.start
        const lineEnd = Math.max(lineStart + 0.05, g.words[activeIdx + 1]?.start ?? g.end)
        const visibleWords = opts.animation === 'Type' && !boxed ? g.words.slice(0, activeIdx + 1) : g.words
        const text = wordsWithLineBreaks(
          visibleWords.map((word, wi) => {
            const globalIdx = boxed ? activeIdx : wi
            const state = word.id === activeWord.id ? 'active' : globalIdx < activeIdx ? 'past' : 'future'
            return wordText(word, state)
          }),
          lines
        )
        // Fade the line in only on the first word and out only on the last word of the
        // group so mid-group word swaps update in place (no per-word flicker).
        const isFirst = activeIdx === 0
        const isLast = activeIdx === g.words.length - 1
        const lead = lineLead(opts.animation, pos, glowTag, isFirst, isLast)
        return `Dialogue: 0,${secToAss(lineStart)},${secToAss(lineEnd)},Default,,0,0,0,,${opts.styleLead ?? ''}${isFirst || isLast ? lead : `{\\pos(${pos.x},${pos.y})${glowTag}}`}${text}`
      })
    )

  // Beta hook: a centered intro card on its own style, fading in/out, on top (layer 1).
  if (opts.hook && opts.hook.text.trim() && opts.hook.untilSec > 0) {
    const body = escapeAss(opts.hook.text.trim().toUpperCase())
    const hookTag = hookFx ? textPresetTag(hookFx.preset) : ''
    dialogues.unshift(`Dialogue: 1,${secToAss(0)},${secToAss(opts.hook.untilSec)},Hook,,0,0,0,,${hookTag}{\\fad(250,250)}${body}`)
  }

  return { ass: `${header}\n${dialogues.join('\n')}\n`, zoomHits: [...new Set(zoomHits)].sort((a, b) => a - b) }
}
