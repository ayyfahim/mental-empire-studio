import { describe, it, expect } from 'vitest'
import { buildGpuRenderSpec, buildImageSpecs } from '../../electron/services/engine/gpu/spec'
import { activeImageIndex } from '../../shared/renderSpec'
import { transitionProgressFor } from '../../src/render-worker/compositor'
import type { BrollManifestSegment } from '../../electron/services/broll'
import type { AppSettings, Project } from '../../shared/types'

describe('GPU B-roll spec builder', () => {
  const project = {
    id: 'p-broll',
    title: 'Broll GPU Render',
    downloadId: 'dl-123',
    channel: 'test',
    mp3Path: 'voice.mp3',
    durationSec: 12,
    imageMode: 'sequence',
    seed: 1,
    kenBurns: true,
    punchZoom: true,
    crossfade: 0.5,
    captionPreset: 'Hormozi',
    captionFont: 'Anton',
    captionAnim: 'Pop-in',
    captionAspect: '16:9',
    captionLines: 1,
    captionPosition: 'bottom',
    captionPace: 'auto',
    keywords: false,
    betaOpts: null,
    stage: 'queued'
  } as unknown as Project

  const brollSegments: BrollManifestSegment[] = [
    { path: 'clipA.mp4', normalizedPath: 'normalizedA.mp4', start: 0, end: 6, srcStart: 0 },
    { path: 'clipB.mp4', normalizedPath: 'normalizedB.mp4', start: 6, end: 12, srcStart: 1.5 }
  ]

  it('maps B-roll segments to GpuRenderSpec broll property', () => {
    const spec = buildGpuRenderSpec({
      project,
      images: [],
      words: [],
      settings: { encoder: 'cpu', quality: '1080p' } as AppSettings,
      zoomHits: [],
      voicePath: 'voice.mp3',
      out: { h264Path: 'temp.h264.mp4', finalPath: 'out.mp4' },
      brollSegments
    })

    expect(spec.broll).toBeDefined()
    expect(spec.broll).toHaveLength(2)
    expect(spec.broll![0]).toEqual({
      path: 'normalizedA.mp4',
      startSec: 0,
      endSec: 6
    })
    expect(spec.broll![1]).toEqual({
      path: 'normalizedB.mp4',
      startSec: 6,
      endSec: 12
    })
  })

  it('activeImageIndex works generically with B-roll segments structurally', () => {
    const activeSegs = brollSegments.map((s) => ({
      path: s.normalizedPath,
      startSec: s.start,
      endSec: s.end
    }))

    expect(activeImageIndex(activeSegs, 3)).toBe(0)
    expect(activeImageIndex(activeSegs, 8)).toBe(1)
    expect(activeImageIndex(activeSegs, 15)).toBe(1) // clamps to last
  })

  it('never blends B-roll into the empty next-video texture', () => {
    expect(transitionProgressFor(true, true, 0.1, 0.4)).toBe(0)
    expect(transitionProgressFor(false, true, 0.1, 0.4)).toBeCloseTo(0.75)
  })
})
