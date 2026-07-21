import { describe, expect, it } from 'vitest'
import { composeRenderPreflight } from '../../src/features/compose/ui/util'
import type { Project, ProjectImage } from '../../shared/types'

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    downloadId: 'dl-1',
    title: 'Title',
    channel: 'Channel',
    mp3Path: 'audio.mp3',
    durationSec: 60,
    imageMode: 'sequence',
    poolSize: 1,
    kenBurns: false,
    seed: 1,
    crossfade: 0,
    captionPreset: 'Hormozi',
    captionFont: 'Anton',
    captionAnim: 'Pop-in',
    captionAspect: '16:9',
    emphasis: true,
    keywords: true,
    punchZoom: false,
    stage: 'composing',
    createdAt: '',
    ...overrides
  }
}

function image(id = 'img-1'): ProjectImage {
  return { id, projectId: 'proj-1', ord: 0, path: 'image.jpg', thumb: 'image-small.jpg', rangeStart: 0, rangeEnd: 60, manual: false }
}

describe('composeRenderPreflight (client-side mirror of validateRenderReady)', () => {
  it('is not ready with no project at all', () => {
    expect(composeRenderPreflight(null, [])).toEqual({ ready: false, missing: ['project'] })
  })

  it('is ready with audio, duration, and at least one image', () => {
    const result = composeRenderPreflight(project(), [image()])
    expect(result).toEqual({ ready: true, missing: [] })
  })

  it('flags missing audio', () => {
    const result = composeRenderPreflight(project({ mp3Path: '' }), [image()])
    expect(result.ready).toBe(false)
    expect(result.missing).toContain('audio')
  })

  it('flags a zero/invalid audio duration', () => {
    const result = composeRenderPreflight(project({ durationSec: 0 }), [image()])
    expect(result.ready).toBe(false)
    expect(result.missing).toContain('audio duration')
  })

  it('flags missing visual media when there are no images and Auto B-roll is off', () => {
    const result = composeRenderPreflight(project(), [])
    expect(result.ready).toBe(false)
    expect(result.missing).toContain('images or Auto B-roll')
  })

  it('is ready with zero images when Auto B-roll is enabled', () => {
    const withBroll = project({ betaOpts: { broll: { enabled: true } } as Project['betaOpts'] })
    const result = composeRenderPreflight(withBroll, [])
    expect(result.ready).toBe(true)
    expect(result.missing).toEqual([])
  })

  it('reports every missing requirement at once, not just the first', () => {
    const result = composeRenderPreflight(project({ mp3Path: '', durationSec: 0 }), [])
    expect(result.ready).toBe(false)
    expect(result.missing).toEqual(['audio', 'audio duration', 'images or Auto B-roll'])
  })
})
