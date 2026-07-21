import { describe, it, expect } from 'vitest'
import { buildGpuRenderSpec, gpuDimensions } from '../../electron/services/engine/gpu/spec'
import { captionFontSizePx } from '../../src/render-worker/captions'
import { DEFAULT_SETTINGS, DEFAULT_BETA_OPTS, type AppSettings, type Project, type ProjectImage, type TranscriptWord } from '../../shared/types'

// Preview (compose:previewSpec) and the final render both go through buildGpuRenderSpec and
// the same WebGL compositor/caption layer — the only intentional difference is canvas size
// (previewSpec pins quality to 720p; final uses the user's setting). This locks that: every
// "look" decision (grade/grain/overlay/motion/caption content) must be identical regardless
// of resolution, and the one thing that legitimately scales with resolution (caption font
// size) must come from a single shared formula, not a preview-only or final-only copy.
//
// A true pixel/golden-frame comparison would need a real WebGL2 context (OffscreenCanvas),
// which this headless vitest environment doesn't provide — real-pixel parity is verified on
// user hardware. This test locks the spec-level contract that makes pixel parity possible.

const settings = (over: Partial<AppSettings> = {}): AppSettings => ({ ...DEFAULT_SETTINGS, ...over })

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', downloadId: 'p1', title: 'T', channel: 'C', mp3Path: '/x/a.mp3', durationSec: 12,
  imageMode: 'sequence', poolSize: 4, kenBurns: true, seed: 1, crossfade: 0.5,
  captionPreset: 'Hormozi', captionFont: 'Anton', captionAnim: 'Pop-in', captionAspect: '16:9',
  emphasis: true, keywords: true, punchZoom: true, stage: 'queued', createdAt: '',
  betaOpts: { ...DEFAULT_BETA_OPTS, overlay: { bottom: true, top: false, left: false, right: true, intensity: 65 } },
  ...over
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

function buildAt(quality: AppSettings['quality']) {
  return buildGpuRenderSpec({
    project: project(),
    images,
    words,
    settings: settings({ quality }),
    zoomHits: [0.8],
    voicePath: '/x/a.mp3',
    out: { h264Path: '/x/o.gpu.mp4', finalPath: '/x/o.mp4' }
  })
}

describe('preview/final GPU spec parity', () => {
  it('renders at different resolutions for preview (720p) vs final (1080p)', () => {
    const preview = buildAt('720p')
    const final = buildAt('1080p')
    expect(preview.height).toBe(720)
    expect(final.height).toBe(1080)
    expect(preview.width).not.toBe(final.width)
  })

  it('keeps every resolution-independent look decision identical between preview and final', () => {
    const preview = buildAt('720p')
    const final = buildAt('1080p')
    expect(preview.grade).toEqual(final.grade)
    expect(preview.grain).toEqual(final.grain)
    expect(preview.overlay).toEqual(final.overlay)
    expect(preview.motion).toEqual(final.motion)
    expect(preview.encoder.codec).toBe(final.encoder.codec)
    expect(preview.audio).toEqual(final.audio)
    const { groups, ...previewCaptionMeta } = preview.captions
    const { groups: finalGroups, ...finalCaptionMeta } = final.captions
    expect(previewCaptionMeta).toEqual(finalCaptionMeta)
    expect(groups).toEqual(finalGroups)
  })

  it('preserves the aspect ratio across quality tiers', () => {
    for (const aspect of ['16:9', '1:1', '9:16'] as const) {
      const preview = gpuDimensions('720p', aspect)
      const final = gpuDimensions('1080p', aspect)
      expect(preview.w / preview.h).toBeCloseTo(final.w / final.h, 2)
    }
  })

  it('derives caption font size from one shared formula, scaling with height', () => {
    const preview = buildAt('720p')
    const final = buildAt('1080p')
    const previewPx = captionFontSizePx(preview.width, preview.height, preview.captions.style)
    const finalPx = captionFontSizePx(final.width, final.height, final.captions.style)
    // Larger canvas never yields a smaller caption; the only knobs are height + preset,
    // shared by both preview and final — no separate preview-only sizing path exists.
    expect(finalPx).toBeGreaterThanOrEqual(previewPx)
    expect(previewPx).toBeGreaterThanOrEqual(64) // legibility floor applies at every resolution
  })
})
