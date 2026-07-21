import type { CaptionFrameModel, CaptionGroupModel } from '@shared/renderSpec'
import { activeCaptionGroup, activeWordInGroup } from '@shared/renderSpec'
import { keywordColor, type ResolvedCaptionStyle } from '@shared/captionStyle'

// GPU caption layer — replaces libass. Draws the active caption group onto a 2D canvas
// (word-by-word highlight + pop animation) which is then uploaded as a texture and
// composited in the WebGL pass. All visual decisions come from the shared preset table
// (shared/captionStyle.ts) via model.style, so this renderer and the ffmpeg/ASS burn
// stay in lockstep. Everything is driven by frame-time (seconds), never wall-clock.

const FONT_FALLBACK = 'Anton, Impact, sans-serif'

function withFont(family: string): string {
  // Caption fonts are bundled TTFs registered via @font-face on the host document.
  return `"${family}", ${FONT_FALLBACK}`
}

/** Font size in px derived from height + preset (mirrors the ffmpeg/ASS sizing). Pure so
 *  preview (smaller canvas) and final (larger canvas) provably share one sizing formula —
 *  the only difference between them is the height it's evaluated at. */
export function captionFontSizePx(width: number, height: number, style: Pick<ResolvedCaptionStyle, 'sizeFactor'>): number {
  const aspectTall = height > width
  const base = aspectTall ? height * 0.11 : height * 0.085
  const px = Math.round(Math.max(64, Math.min(aspectTall ? 150 : 108, base)))
  return Math.round(px * style.sizeFactor)
}

/** Kick off loading of every bundled caption font on the given document so canvas
 *  drawing never silently falls back mid-render. Resolves when all are settled. */
export function warmCaptionFonts(doc: Document, families: string[]): Promise<unknown> {
  const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts
  if (!fonts) return Promise.resolve()
  return Promise.allSettled(families.map((f) => fonts.load(`700 64px "${f}"`)))
}

/** Active-word pop progress (0→1 over the first 160ms of the word). */
function popPhase(timeSec: number, wordStartSec: number): number {
  return Math.max(0, Math.min(1, (timeSec - wordStartSec) / 0.16))
}

/** Ease-out-back — small overshoot for a lively CapCut-style pop. */
function easePop(p: number): number {
  const c1 = 1.70158
  const c3 = c1 + 1
  const t = p - 1
  return 1 + c3 * t * t * t + c1 * t * t
}

export class CaptionLayer {
  readonly canvas: OffscreenCanvas
  private ctx: OffscreenCanvasRenderingContext2D
  private lastKey = ''

  constructor(private model: CaptionFrameModel, private width: number, private height: number) {
    this.canvas = new OffscreenCanvas(width, height)
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('2D context unavailable for caption layer')
    this.ctx = ctx
  }

  /** Swap in a new caption model without reallocating the canvas — used when only
   *  captions/text-effects change so the compositor doesn't need a full rebuild. */
  setModel(model: CaptionFrameModel): void {
    this.model = model
    this.lastKey = ' ' // force the next draw() to repaint even if timeSec is unchanged
  }

  private style(): ResolvedCaptionStyle {
    return this.model.style
  }

  /** Vertical centre of the caption block (shared anchor formula with the ASS path). */
  private anchorY(): number {
    return Math.round((this.height * this.style().anchorPct) / 100)
  }

  /** Greedily wrap words into lines so no line exceeds maxWidth. Word order is
   *  preserved so the flat active-word index still maps to group.words. */
  private wrapByWidth(words: string[], maxWidth: number, spaceW: number): string[][] {
    const lines: string[][] = []
    let cur: string[] = []
    let curW = 0
    for (const word of words) {
      const w = this.ctx.measureText(word).width
      const add = cur.length ? spaceW + w : w
      if (cur.length && curW + add > maxWidth) {
        lines.push(cur)
        cur = [word]
        curW = w
      } else {
        cur.push(word)
        curW += add
      }
    }
    if (cur.length) lines.push(cur)
    return lines.length ? lines : [words]
  }

  /**
   * Draw the caption state for time `t`. Returns true if the canvas changed (so the
   * compositor can skip re-uploading the texture when nothing moved). The key includes
   * a quantized pop phase so the active word animates for its first ~160ms.
   */
  draw(timeSec: number): boolean {
    const hook = this.model.hook
    // Hook card takes precedence during its window.
    if (hook && timeSec < hook.untilSec) {
      const key = `hook:${hook.text}`
      if (key === this.lastKey) return false
      this.lastKey = key
      this.clear()
      this.drawHook(hook.text.toUpperCase())
      return true
    }

    const gi = activeCaptionGroup(this.model, timeSec)
    if (gi < 0) {
      if (this.lastKey === '') return false
      this.lastKey = ''
      this.clear()
      return true
    }
    const group = this.model.groups[gi]
    const wi = this.model.mode === 'word' ? activeWordInGroup(group, timeSec) : -1
    const phase = this.model.animation === 'Fade'
      ? popPhase(timeSec, group.startSec)
      : wi >= 0 && this.model.animation !== 'None' ? popPhase(timeSec, Math.max(group.words[wi].startSec, group.startSec)) : 1
    const phaseQ = phase >= 1 ? 4 : Math.floor(phase * 4)
    const key = `${gi}:${wi}:${phaseQ}`
    if (key === this.lastKey) return false
    this.lastKey = key

    this.clear()
    this.drawGroup(group, wi, timeSec)
    return true
  }

  private clear(): void {
    this.ctx.clearRect(0, 0, this.width, this.height)
  }

  private drawHook(text: string): void {
    const ctx = this.ctx
    const size = Math.round(this.height * 0.12)
    ctx.save()
    ctx.font = `700 ${size}px ${withFont('Anton')}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    ctx.lineWidth = size * 0.14
    ctx.strokeStyle = 'rgba(0,0,0,0.85)'
    ctx.fillStyle = '#ffffff'
    const cx = this.width / 2
    const cy = this.height / 2
    ctx.strokeText(text, cx, cy)
    ctx.fillText(text, cx, cy)
    ctx.restore()
  }

  private roundedRect(x: number, y: number, w: number, h: number, radius: number): void {
    const ctx = this.ctx
    const r = Math.max(0, Math.min(radius, w / 2, h / 2))
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + w - r, y)
    ctx.quadraticCurveTo(x + w, y, x + w, y + r)
    ctx.lineTo(x + w, y + h - r)
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
    ctx.lineTo(x + r, y + h)
    ctx.quadraticCurveTo(x, y + h, x, y + h - r)
    ctx.lineTo(x, y + r)
    ctx.quadraticCurveTo(x, y, x + r, y)
    ctx.closePath()
  }

  /** Fill colour of a word given its state, per the resolved preset style. */
  private wordFill(
    style: ResolvedCaptionStyle,
    word: CaptionGroupModel['words'][number],
    state: 'past' | 'active' | 'future'
  ): { color: string; alpha: number } {
    if (style.activeKind === 'box') return { color: style.activeColor, alpha: 1 }
    if (state === 'active') return { color: style.activeColor, alpha: 1 }
    if (word.kwOrd != null) return { color: keywordColor(style, word.kwOrd), alpha: 1 }
    if (style.activeKind === 'karaoke') {
      if (state === 'past') return { color: style.activeColor, alpha: 1 }
      return { color: style.baseColor, alpha: style.futureAlpha ?? 1 }
    }
    return { color: style.baseColor, alpha: 1 }
  }

  private drawGroup(group: CaptionGroupModel, activeWordIdx: number, timeSec: number): void {
    const ctx = this.ctx
    const style = this.style()
    const boxKind = style.activeKind === 'box'
    // Layout reserves the scaled width of the active word so the enlarged word never
    // overlaps its neighbours.
    const popP = activeWordIdx >= 0 && this.model.animation !== 'None' && this.model.animation !== 'Fade'
      ? easePop(popPhase(timeSec, Math.max(group.words[activeWordIdx]?.startSec ?? 0, group.startSec)))
      : 1
    const ACTIVE_SCALE = 1 + (style.activeScale - 1) * Math.max(0, popP)
    const fadeAlpha = this.model.animation === 'Fade' ? popPhase(timeSec, group.startSec) : 1
    let size = captionFontSizePx(this.width, this.height, style)
    const fontOf = (px: number): string => `${style.fontWeight} ${px}px ${withFont(style.fontFamily)}`
    ctx.save()
    ctx.globalAlpha = fadeAlpha
    ctx.font = fontOf(size)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    ctx.miterLimit = 2

    const words = group.words.map((w) => (style.uppercase ? w.text.toUpperCase() : w.text))
    // Keep captions inside a title-safe width. If a single word is still too wide,
    // shrink the font so it fits rather than clip.
    const safeMaxW = this.width * 0.9
    const widestWord = words.reduce((m, w) => Math.max(m, ctx.measureText(w).width), 0)
    if (widestWord > safeMaxW && widestWord > 0) {
      size = Math.max(28, Math.floor((size * safeMaxW) / (widestWord * style.activeScale)))
      ctx.font = fontOf(size)
    }
    const lineH = size * 1.18
    const spaceW = ctx.measureText(' ').width
    const lines = this.wrapByWidth(words, safeMaxW, spaceW)
    const totalH = lines.length * lineH
    const startY = this.anchorY() - totalH / 2 + lineH / 2
    const cx = this.width / 2

    // Flatten word index across lines so the active-word highlight maps correctly.
    let flat = 0
    lines.forEach((line, li) => {
      const y = startY + li * lineH
      const widths = line.map((w) => ctx.measureText(w).width)
      // Reserve the *scaled* width for the active word so nothing overlaps it.
      const effWidths = line.map((w, wi) => widths[wi] * (flat + wi === activeWordIdx ? style.activeScale : 1))
      const lineW = effWidths.reduce((a, b) => a + b, 0) + spaceW * (line.length - 1)

      // Full-line backgrounds first: the boxed page or the podcast band.
      if (boxKind || style.band) {
        const padX = size * 0.34
        const padY = size * (boxKind ? 0.18 : 0.22)
        const bh = lineH + padY
        this.roundedRect(cx - lineW / 2 - padX, y - bh / 2, lineW + padX * 2, bh, boxKind ? size * (style.boxRadiusEm ?? 0.18) : size * 0.16)
        if (boxKind) {
          ctx.fillStyle = style.boxColor ?? '#FFD93D'
          ctx.globalAlpha = fadeAlpha
        } else {
          ctx.fillStyle = style.band!.color
          ctx.globalAlpha = style.band!.alpha * fadeAlpha
        }
        ctx.fill()
        ctx.globalAlpha = fadeAlpha
      }

      let x = cx - lineW / 2
      line.forEach((word, wi) => {
        const globalIdx = flat + wi
        const isActive = globalIdx === activeWordIdx
        const wordModel = group.words[globalIdx]
        const state: 'past' | 'active' | 'future' = isActive ? 'active' : globalIdx < activeWordIdx ? 'past' : 'future'
        const wx = x + effWidths[wi] / 2
        const scale = isActive ? ACTIVE_SCALE : 1
        ctx.save()
        ctx.translate(wx, y)
        ctx.scale(scale, scale)

        const fill = this.wordFill(style, wordModel ?? { text: word, startSec: 0, endSec: 0, emphasis: false }, state)

        if (style.activeKind === 'glow') {
          // Neon: coloured glow behind every word, hotter on the active one.
          ctx.shadowColor = style.glowColor ?? '#22D3EE'
          ctx.shadowBlur = size * (style.glowPct ?? 0.25) * (isActive ? 1.5 : 1)
        } else if (!boxKind && style.shadowPct > 0) {
          ctx.shadowColor = 'rgba(0,0,0,0.55)'
          ctx.shadowBlur = size * Math.min(0.2, style.shadowPct * 2)
          ctx.shadowOffsetY = Math.round(size * Math.min(0.08, style.shadowPct))
        }

        if (style.outlinePct > 0 && !boxKind) {
          ctx.lineWidth = size * style.outlinePct * 2 // canvas strokes are centred; ×2 ≈ ASS outline
          ctx.strokeStyle = style.activeKind === 'glow' ? (style.glowColor ?? style.outlineColor) : style.outlineColor
          ctx.globalAlpha = fill.alpha * fadeAlpha
          ctx.strokeText(word, 0, 0)
        }

        // Turn the shadow off for the fill so glyph interiors stay crisp (glow keeps it).
        if (style.activeKind !== 'glow') {
          ctx.shadowColor = 'transparent'
          ctx.shadowBlur = 0
          ctx.shadowOffsetY = 0
        }
        ctx.globalAlpha = fill.alpha * fadeAlpha
        ctx.fillStyle = fill.color
        ctx.fillText(word, 0, 0)
        ctx.restore()
        x += effWidths[wi] + spaceW
      })
      flat += line.length
    })
    ctx.restore()
  }
}
