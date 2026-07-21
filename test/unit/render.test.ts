import { describe, it, expect } from 'vitest'
import { buildRenderArgs, canUseCudaFinalFilters, videoCodecArgs } from '../../electron/services/render'
import { DEFAULT_BETA_OPTS, DEFAULT_SETTINGS, type AppSettings, type Project, type ProjectImage, type RenderCapabilities } from '../../shared/types'

const caps = (over: Partial<RenderCapabilities>): RenderCapabilities => ({
  hasNvenc: false, hasQsv: false, hasAmf: false, gpuVendor: 'unknown', ffmpegHasLibass: true, ffmpegHasCuda: false, ...over
})
const settings = (encoder: AppSettings['encoder']): AppSettings => ({ encoder } as AppSettings)

// G3: GPU scaling only engages when NVENC is selected AND ffmpeg/driver actually
// support CUDA — never silently, and never on CPU.
describe('canUseCudaFinalFilters', () => {
  it('is true only for nvenc + nvenc-capable + cuda-capable ffmpeg', () => {
    expect(canUseCudaFinalFilters(settings('nvenc'), caps({ hasNvenc: true, ffmpegHasCuda: true }))).toBe(true)
  })
  it('is false when cuda is unavailable', () => {
    expect(canUseCudaFinalFilters(settings('nvenc'), caps({ hasNvenc: true, ffmpegHasCuda: false }))).toBe(false)
  })
  it('is false on CPU', () => {
    expect(canUseCudaFinalFilters(settings('cpu'), caps({ hasNvenc: true, ffmpegHasCuda: true }))).toBe(false)
  })
})

describe('videoCodecArgs', () => {
  it('uses the GPU codec when nvenc is selected', () => {
    expect(videoCodecArgs(settings('nvenc'), '20')).toContain('h264_nvenc')
  })
  it('uses libx264 on CPU', () => {
    expect(videoCodecArgs(settings('cpu'), '20')).toContain('libx264')
  })
  it('can use an ultrafast CPU preset for throwaway previews', () => {
    const args = videoCodecArgs(settings('cpu'), '28', undefined, { cpuPreset: 'ultrafast' })
    expect(args).toContain('ultrafast')
  })
})

describe('buildRenderArgs — still-image ffmpeg path', () => {
  const project = {
    id: 'p1',
    title: 'GPU image path',
    downloadId: 'dl-video123',
    channel: 'test',
    mp3Path: 'voice.mp3',
    durationSec: 12,
    imageMode: 'sequence',
    seed: 1,
    kenBurns: true,
    punchZoom: true,
    crossfade: 0,
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
  const image = { id: 'im1', projectId: 'p1', ord: 0, path: 'still.png', thumb: 'still-thumb.jpg', rangeStart: 0, rangeEnd: 12, manual: false } as ProjectImage

  it('uses CPU motion filters plus NVENC encode for ordinary still-image renders', () => {
    const args = buildRenderArgs({
      project,
      images: [image],
      assPath: 'captions.ass',
      outPath: 'out.mp4',
      settings: { encoder: 'nvenc', quality: '1080p' } as AppSettings,
      caps: caps({ hasNvenc: true, ffmpegHasCuda: true })
    })
    const joined = args.join(' ')
    expect(joined).toContain('scale=1920:1080:force_original_aspect_ratio=increase')
    expect(joined).not.toContain('scale_cuda')
    expect(joined).not.toContain('hwupload_cuda')
    expect(joined).not.toContain('hwdownload')
    expect(joined).toContain('h264_nvenc')
    // This fixture explicitly enables Ken Burns motion, so the CPU filtergraph
    // should keep the seeded zoom/pan while NVENC handles only the encode.
    expect(joined).toContain('zoompan')
  })

  it('does not use CUDA filters on CPU renders', () => {
    const args = buildRenderArgs({
      project,
      images: [image],
      assPath: 'captions.ass',
      outPath: 'out.mp4',
      settings: { encoder: 'cpu', quality: '1080p' } as AppSettings,
      caps: caps({ hasNvenc: true, ffmpegHasCuda: true })
    })
    const joined = args.join(' ')
    expect(joined).not.toContain('scale_cuda')
    expect(joined).toContain('libx264')
  })

  it('uses explicit smaller dimensions and ultrafast CPU preset for preview renders', () => {
    const args = buildRenderArgs({
      project,
      images: [image],
      assPath: 'captions.ass',
      outPath: 'preview.mp4',
      settings: { encoder: 'cpu', quality: '720p' } as AppSettings,
      caps: caps({ hasNvenc: true, ffmpegHasCuda: true }),
      previewDimensions: { w: 640, h: 360 },
      cpuPreset: 'ultrafast',
      skipAudioMaster: true
    })
    const joined = args.join(' ')
    expect(joined).toContain('scale=640:360:force_original_aspect_ratio=increase')
    expect(joined).toContain('ultrafast')
  })

  it('honors project video effects without the legacy global beta toggle', () => {
    const args = buildRenderArgs({
      project: {
        ...project,
        betaOpts: {
          ...DEFAULT_BETA_OPTS,
          style: 'Cinematic',
          overlay: { ...DEFAULT_BETA_OPTS.overlay, bottom: true, intensity: 60 }
        }
      },
      images: [image],
      assPath: 'captions.ass',
      outPath: 'out.mp4',
      settings: { ...DEFAULT_SETTINGS, beta: { ...DEFAULT_SETTINGS.beta, enabled: false }, encoder: 'nvenc', quality: '1080p' },
      caps: caps({ hasNvenc: true, ffmpegHasCuda: true })
    })
    const joined = args.join(' ')
    expect(joined).toContain('overlay=0:0:format=auto')
    expect(joined).toContain('curves=preset=medium_contrast')
    expect(joined).toContain('h264_nvenc')
  })
})
