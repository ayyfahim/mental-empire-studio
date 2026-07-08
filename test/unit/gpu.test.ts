import { describe, it, expect } from 'vitest'
import { gradeParams } from '../../electron/services/engine/grade'
import { buildGpuRenderSpec, buildCaptionModel, buildImageSpecs, effectiveMotionPreset, gpuCaptionMode, gpuDimensions, imageMotionFor } from '../../electron/services/engine/gpu/spec'
import { activeCaptionGroup, activeWordInGroup, activeImageIndex, totalFrames, overlayAlphaAt } from '../../shared/renderSpec'
import { DEFAULT_SETTINGS, DEFAULT_BETA_OPTS, type AppSettings, type Project, type ProjectImage, type TranscriptWord } from '../../shared/types'

const settings = (over: Partial<AppSettings> = {}): AppSettings => ({ ...DEFAULT_SETTINGS, ...over })

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', downloadId: 'p1', title: 'T', channel: 'C', mp3Path: '/x/a.mp3', durationSec: 12,
  imageMode: 'sequence', poolSize: 4, kenBurns: true, seed: 1, crossfade: 0.5,
  captionPreset: 'Hormozi', captionFont: 'Anton', captionAnim: 'Pop-in', captionAspect: '16:9',
  emphasis: true, keywords: true, punchZoom: true, stage: 'queued', createdAt: '', ...over
})

const words: TranscriptWord[] = [
  { id: 'w0', projectId: 'p1', ord: 0, word: 'You', start: 0, end: 0.4, emphasis: false },
  { id: 'w1', projectId: 'p1', ord: 1, word: 'are', start: 0.4, end: 0.8, emphasis: false },
  { id: 'w2', projectId: 'p1', ord: 2, word: 'NOT', start: 0.8, end: 1.4, emphasis: true },
  { id: 'w3', projectId: 'p1', ord: 3, word: 'crazy', start: 1.4, end: 2.0, emphasis: false }
]

const images: ProjectImage[] = [
  { id: 'i0', projectId: 'p1', ord: 0, path: '/x/a.png', thumb: '', rangeStart: 0, rangeEnd: 6, manual: false },
  { id: 'i1', projectId: 'p1', ord: 1, path: '/x/b.png', thumb: '', rangeStart: 6, rangeEnd: 12, manual: false }
]

describe('gradeParams', () => {
  it('returns neutral params + no grain for None/Clean', () => {
    for (const s of ['None', 'Clean'] as const) {
      const { grade, grain } = gradeParams(s)
      expect(grade.saturation).toBe(1)
      expect(grade.contrast).toBe(1)
      expect(grade.vignette).toBe(0)
      expect(grain.strength).toBe(0)
    }
  })
  it('mirrors the cinematic look (warm balance, vignette, temporal grain)', () => {
    const { grade, grain } = gradeParams('Cinematic')
    expect(grade.saturation).toBeCloseTo(1.12)
    expect(grade.brightness).toBeLessThan(0)
    expect(grade.colorBalance.r).toBeGreaterThan(0)
    expect(grade.colorBalance.b).toBeLessThan(0)
    expect(grade.vignette).toBeGreaterThan(0)
    expect(grain.temporal).toBe(true)
    expect(grain.strength).toBeGreaterThan(0)
  })
  it('intense adds sharpen + strong saturation, no grain', () => {
    const { grade, grain } = gradeParams('Intense')
    expect(grade.saturation).toBeCloseTo(1.18)
    expect(grade.sharpen).toBeGreaterThan(0)
    expect(grain.strength).toBe(0)
  })
  it('heartfelt is warm and gentle without temporal grain', () => {
    const { grade, grain } = gradeParams('Heartfelt')
    expect(grade.saturation).toBeCloseTo(1.06)
    expect(grade.brightness).toBeGreaterThan(0)
    expect(grade.colorBalance.r).toBeGreaterThan(0)
    expect(grade.colorBalance.b).toBeLessThan(0)
    expect(grade.vignette).toBeGreaterThan(0)
    expect(grain.temporal).toBe(false)
  })
})

describe('gpuDimensions', () => {
  it('scales by quality and aspect, always even', () => {
    expect(gpuDimensions('1080p', '16:9')).toEqual({ w: 1920, h: 1080 })
    expect(gpuDimensions('720p', '16:9')).toEqual({ w: 1280, h: 720 })
    const tall = gpuDimensions('1080p', '9:16')
    expect(tall).toEqual({ w: 1080, h: 1920 })
    const r = gpuDimensions('1440p', '16:9')
    expect(r.w % 2).toBe(0)
    expect(r.h % 2).toBe(0)
  })
})

describe('gpuCaptionMode', () => {
  it('honors explicit pace', () => {
    expect(gpuCaptionMode({ durationSec: 30, captionPace: 'word' }, 10)).toBe('word')
    expect(gpuCaptionMode({ durationSec: 30, captionPace: 'phrase' }, 10)).toBe('phrase')
  })
  it('auto switches to phrase on long-form or high word count', () => {
    expect(gpuCaptionMode({ durationSec: 30, captionPace: 'auto' }, 10)).toBe('word')
    expect(gpuCaptionMode({ durationSec: 900, captionPace: 'auto' }, 10)).toBe('phrase')
    expect(gpuCaptionMode({ durationSec: 30, captionPace: 'auto' }, 2000)).toBe('phrase')
  })
})

describe('buildImageSpecs', () => {
  it('maps ranges and clamps minimum window', () => {
    const specs = buildImageSpecs(images, 12)
    expect(specs).toHaveLength(2)
    expect(specs[0]).toEqual({ path: '/x/a.png', startSec: 0, endSec: 6 })
    expect(specs[1].endSec).toBe(12)
  })
  it('returns empty list when there are no images', () => {
    expect(buildImageSpecs([], 12)).toEqual([])
  })
  it('adds deterministic smart motion when a motion preset is provided', () => {
    const subtle = buildImageSpecs(images, 12, { preset: 'subtle', seed: 42 })
    const subtleAgain = buildImageSpecs(images, 12, { preset: 'subtle', seed: 42 })
    expect(subtle[0].motion).toEqual(subtleAgain[0].motion)
    expect(subtle[0].motion?.ease).toBe('easeInOutCubic')
    expect(subtle[0].motion?.zoomTo).toBeGreaterThan(subtle[0].motion?.zoomFrom ?? 0)
    expect(subtle[1].motion?.zoomFrom).toBeGreaterThan(subtle[1].motion?.zoomTo ?? 0)
    expect(buildImageSpecs(images, 12, { preset: 'off', seed: 42 })[0].motion).toBeUndefined()
  })
  it('lets individual images override the project motion preset', () => {
    const specs = buildImageSpecs([
      { ...images[0], motionPreset: 'off' },
      { ...images[1], motionPreset: 'cinematic' }
    ], 12, { preset: 'subtle', seed: 42 })
    expect(specs[0].motion).toBeUndefined()
    expect(specs[1].motion).toBeDefined()
    expect((specs[1].motion?.zoomFrom ?? 0) - (specs[1].motion?.zoomTo ?? 0)).toBeCloseTo(0.18)

    const globalOff = buildImageSpecs([{ ...images[0], motionPreset: 'cinematic' }], 12, { preset: 'off', seed: 42 })
    expect(globalOff[0].motion).toBeDefined()
  })
  it('supports per-image motion direction and amount', () => {
    const left = buildImageSpecs([
      { ...images[0], motionPreset: 'subtle', motionDirection: 'left', motionAmount: 100 }
    ], 12, { preset: 'subtle', seed: 42 })[0].motion
    expect(left?.panX).toBeLessThan(0)
    expect(left?.panY).toBeCloseTo(0)
    expect(left?.zoomTo).toBeCloseTo(1.08)

    const pull = imageMotionFor(0, 42, 'cinematic', { direction: 'pull', amount: 25 })
    expect(pull?.zoomFrom).toBeGreaterThan(pull?.zoomTo ?? 0)
    expect((pull?.zoomFrom ?? 0) - (pull?.zoomTo ?? 0)).toBeCloseTo(0.09)
  })
})

describe('smart motion helpers', () => {
  it('maps legacy kenBurns to subtle unless explicitly overridden', () => {
    expect(effectiveMotionPreset({ kenBurns: true, motionPreset: undefined })).toBe('subtle')
    expect(effectiveMotionPreset({ kenBurns: true, motionPreset: 'off' })).toBe('off')
    expect(effectiveMotionPreset({ kenBurns: false, motionPreset: undefined })).toBe('off')
  })
  it('uses stronger motion for cinematic', () => {
    const subtle = imageMotionFor(0, 7, 'subtle')!
    const cinematic = imageMotionFor(0, 7, 'cinematic')!
    expect(cinematic.zoomTo - cinematic.zoomFrom).toBeGreaterThan(subtle.zoomTo - subtle.zoomFrom)
  })
})

describe('buildCaptionModel', () => {
  it('groups words and carries emphasis + style', () => {
    const m = buildCaptionModel(words, project(), {})
    expect(m.groups.length).toBeGreaterThan(0)
    const flat = m.groups.flatMap((g) => g.words)
    expect(flat).toHaveLength(4)
    expect(flat[2].emphasis).toBe(true)
    expect(flat[2].kwOrd).toBeDefined() // emphasized word joins the keyword rotation
    expect(m.style.presetId).toBe('Hormozi')
    expect(m.highlightColor).toBe('#FFD93D')
    expect(m.mode).toBe('word')
  })
  it('forces one-word groups for the Word preset', () => {
    const m = buildCaptionModel(words, project({ captionPreset: 'Word', captionLines: 1 }), {})
    expect(m.groups.every((g) => g.words.length === 1)).toBe(true)
  })
  it('includes a hook when provided', () => {
    const m = buildCaptionModel(words, project(), { hook: { text: 'wait', untilSec: 2 } })
    expect(m.hook?.text).toBe('wait')
  })
  it('builds Submagic rounded-box caption pages', () => {
    const m = buildCaptionModel(
      words,
      project({ captionPreset: 'Submagic', captionPace: 'phrase', captionLines: 3, captionWordsPerPage: 2 }),
      {}
    )
    expect(m.mode).toBe('word')
    expect(m.lines).toBe(1)
    expect(m.wordsPerPage).toBe(2)
    expect(m.style.presetId).toBe('Boxed') // legacy Submagic id resolves to the Boxed spec
    expect(m.highlightBox?.boxColor).toBe('#FFD93D')
    expect(m.groups[0].words).toHaveLength(2)
  })
})

describe('overlayAlphaAt', () => {
  const bottom = { top: false, right: false, bottom: true, left: false, intensity: 50 }
  it('is 0 when disabled or no edge is enabled', () => {
    expect(overlayAlphaAt(0.5, 0.99, { ...bottom, intensity: 0 })).toBe(0)
    expect(overlayAlphaAt(0.5, 0.99, { top: false, right: false, bottom: false, left: false, intensity: 100 })).toBe(0)
  })
  it('is 0 in the interior and ramps up toward the enabled edge', () => {
    expect(overlayAlphaAt(0.5, 0.2, bottom)).toBe(0) // top half — outside bottom extent
    const mid = overlayAlphaAt(0.5, 0.85, bottom)
    const edge = overlayAlphaAt(0.5, 1.0, bottom)
    expect(mid).toBeGreaterThan(0)
    expect(edge).toBeGreaterThan(mid) // monotonic toward the edge
  })
  it('matches the analytic ramp at the very edge (maxAlpha = intensity/100*200/255)', () => {
    // extentRatio(50)=0.36, ramp at yN=1 is 1 → alpha = maxAlpha * 1^1.7 = maxAlpha
    expect(overlayAlphaAt(0.5, 1.0, bottom)).toBeCloseTo((50 / 100) * 200 / 255, 6)
    expect(overlayAlphaAt(0.5, 1.0, { ...bottom, intensity: 100 })).toBeCloseTo(200 / 255, 6)
  })
  it('takes the max across multiple enabled edges', () => {
    const all = { top: true, right: true, bottom: true, left: true, intensity: 60 }
    // A bottom-left corner pixel is inside both the bottom and left ramps.
    const corner = overlayAlphaAt(0.02, 0.98, all)
    const bottomOnly = overlayAlphaAt(0.02, 0.98, { ...all, left: false })
    expect(corner).toBeGreaterThanOrEqual(bottomOnly)
  })
})

describe('buildGpuRenderSpec', () => {
  it('builds a complete spec mirroring the ffmpeg decisions', () => {
    const spec = buildGpuRenderSpec({
      project: project(), images, words, settings: settings({ beta: { ...DEFAULT_SETTINGS.beta, enabled: true } }),
      zoomHits: [0.8], voicePath: '/x/a.mp3', sfxPath: '/x/sfx.wav', hookText: 'hi',
      out: { h264Path: '/x/o.gpu.mp4', finalPath: '/x/o.mp4' }
    })
    expect(spec.width).toBe(1920)
    expect(spec.height).toBe(1080)
    expect(spec.fps).toBe(24)
    expect(spec.images).toHaveLength(2)
    expect(spec.encoder.codec).toBe('avc')
    expect(spec.encoder.bitrateMbps).toBeGreaterThan(0)
    expect(spec.audio.voicePath).toBe('/x/a.mp3')
    expect(spec.audio.sfxPath).toBe('/x/sfx.wav')
    expect(spec.captions.hook?.text).toBe('hi')
    expect(spec.motion.punchAtSec).toContain(0.8) // punchZoom on + not long-form
  })
  it('derives the edge overlay from beta.overlay', () => {
    const spec = buildGpuRenderSpec({
      project: project({ betaOpts: { ...DEFAULT_BETA_OPTS, overlay: { bottom: true, top: false, left: false, right: true, intensity: 70 } } }),
      images, words, settings: settings(), zoomHits: [], voicePath: '/x/a.mp3',
      out: { h264Path: '/x/o.gpu.mp4', finalPath: '/x/o.mp4' }
    })
    expect(spec.overlay).toEqual({ top: false, right: true, bottom: true, left: false, intensity: 70 })
  })
  it('omits the overlay when no edge is enabled', () => {
    const spec = buildGpuRenderSpec({
      project: project({ betaOpts: { ...DEFAULT_BETA_OPTS, overlay: { bottom: false, top: false, left: false, right: false, intensity: 80 } } }),
      images, words, settings: settings(), zoomHits: [], voicePath: '/x/a.mp3',
      out: { h264Path: '/x/o.gpu.mp4', finalPath: '/x/o.mp4' }
    })
    expect(spec.overlay).toBeUndefined()
  })
  it('disables motion on long-form jobs', () => {
    const spec = buildGpuRenderSpec({
      project: project({ durationSec: 900 }), images, words, settings: settings(),
      zoomHits: [0.8], voicePath: '/x/a.mp3', out: { h264Path: '/x/o.gpu.mp4', finalPath: '/x/o.mp4' }
    })
    expect(spec.motion.kenBurns).toBe(false)
    expect(spec.motion.punchAtSec).toEqual([])
  })
  it('keeps Motion Off static even when legacy flags are enabled', () => {
    const spec = buildGpuRenderSpec({
      project: project({ motionPreset: 'off', kenBurns: true, punchZoom: true }),
      images,
      words,
      settings: settings(),
      zoomHits: [0.8],
      voicePath: '/x/a.mp3',
      out: { h264Path: '/x/static.gpu.mp4', finalPath: '/x/static.mp4' }
    })
    expect(spec.motion.kenBurns).toBe(false)
    expect(spec.motion.punchAtSec).toEqual([])
    expect(spec.images.some((im) => im.motion)).toBe(false)
  })
  it('derives punch hits from emphasized transcript words', () => {
    const spec = buildGpuRenderSpec({
      project: project({ motionPreset: 'subtle', punchZoom: true }),
      images,
      words,
      settings: settings(),
      zoomHits: [],
      voicePath: '/x/a.mp3',
      out: { h264Path: '/x/punch.gpu.mp4', finalPath: '/x/punch.mp4' }
    })
    expect(spec.motion.punchAtSec).toContain(0.8)
  })
  it('carries every editing style into the GPU grade model', () => {
    const styles = ['None', 'Clean', 'Cinematic', 'Intense', 'Heartfelt'] as const
    for (const style of styles) {
      const spec = buildGpuRenderSpec({
        project: project({ betaOpts: { ...DEFAULT_BETA_OPTS, style } }),
        images,
        words,
        settings: settings({ beta: { ...DEFAULT_SETTINGS.beta, enabled: false } }),
        zoomHits: [],
        voicePath: '/x/a.mp3',
        out: { h264Path: `/x/${style}.gpu.mp4`, finalPath: `/x/${style}.mp4` }
      })
      expect(spec.grade.style).toBe(style)
      if (style === 'Intense') expect(spec.grade.sharpen).toBeGreaterThan(0)
      if (style === 'Cinematic') expect(spec.grain.temporal).toBe(true)
      if (style === 'Clean' || style === 'None') expect(spec.grade.vignette).toBe(0)
    }
  })
  it('honors project auto-zoom without the legacy global beta toggle', () => {
    const spec = buildGpuRenderSpec({
      project: project({
        punchZoom: false,
        betaOpts: {
          ...DEFAULT_BETA_OPTS,
          autoZoom: { atStart: true, atKeyPhrases: true }
        }
      }),
      images,
      words,
      settings: settings({ beta: { ...DEFAULT_SETTINGS.beta, enabled: false } }),
      zoomHits: [],
      voicePath: '/x/auto.mp3',
      out: { h264Path: '/x/auto.gpu.mp4', finalPath: '/x/auto.mp4' }
    })
    expect(spec.motion.kenBurns).toBe(true)
    expect(spec.motion.punchAtSec).toContain(0.8)
  })
  it('carries the saved project look into the GPU grade model', () => {
    const spec = buildGpuRenderSpec({
      project: project({ lookLut: 'gold', lookStrength: 0.42, lookAdjust: { saturation: 1.35, grain: 0.05 } }),
      images,
      words,
      settings: settings(),
      zoomHits: [],
      voicePath: '/x/a.mp3',
      out: { h264Path: '/x/look.gpu.mp4', finalPath: '/x/look.mp4' }
    })
    expect(spec.grade.lut).toBe('gold')
    expect(spec.grade.lutStrength).toBeCloseTo(0.42)
    expect(spec.grade.saturation).toBeCloseTo(1.35)
    expect(spec.grain.strength).toBeCloseTo(0.05)
  })
})

describe('caption/image timing helpers', () => {
  const model = buildCaptionModel(words, project({ captionPreset: 'Word', captionLines: 1 }), { highlightColor: '#fff' })
  it('activeCaptionGroup finds the window containing t', () => {
    expect(activeCaptionGroup(model, -1)).toBe(-1)
    expect(activeCaptionGroup(model, 0)).toBe(0)
    expect(activeCaptionGroup(model, 1.0)).toBe(2)
    expect(activeCaptionGroup(model, 1.4)).toBe(3)
  })
  it('activeWordInGroup clamps to the last word until the group ends', () => {
    const g = { startSec: 0, endSec: 2, words: [
      { text: 'a', startSec: 0, endSec: 0.5, emphasis: false },
      { text: 'b', startSec: 0.5, endSec: 1, emphasis: false }
    ] }
    expect(activeWordInGroup(g, 0.2)).toBe(0)
    expect(activeWordInGroup(g, 0.7)).toBe(1)
    expect(activeWordInGroup(g, 1.8)).toBe(1)
    expect(activeWordInGroup({ startSec: 0, endSec: 1, words: [] }, 0.5)).toBe(-1)
  })
  it('activeImageIndex falls back to the last image past the end', () => {
    const imgs = buildImageSpecs(images, 12)
    expect(activeImageIndex(imgs, 3)).toBe(0)
    expect(activeImageIndex(imgs, 8)).toBe(1)
    expect(activeImageIndex(imgs, 99)).toBe(1)
  })
  it('totalFrames rounds duration*fps', () => {
    expect(totalFrames({ durationSec: 12, fps: 24 })).toBe(288)
    expect(totalFrames({ durationSec: 0, fps: 24 })).toBe(1)
  })
})
