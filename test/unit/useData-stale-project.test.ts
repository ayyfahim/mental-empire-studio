import { beforeEach, describe, expect, it } from 'vitest'
import { useData } from '../../src/store/useData'
import type { Project, ProjectImage, TranscriptWord } from '../../shared/types'

function project(id: string, downloadId: string): Project {
  return {
    id,
    downloadId,
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
    createdAt: ''
  }
}

function image(id: string, projectId: string): ProjectImage {
  return { id, projectId, ord: 0, path: 'image.jpg', thumb: 'image-small.jpg', rangeStart: 0, rangeEnd: 60, manual: false }
}

function word(id: string, projectId: string): TranscriptWord {
  return { id, projectId, ord: 0, word: 'Hello', start: 0, end: 0.4, emphasis: false }
}

const projectA = project('proj-a', 'dl-a')
const projectB = project('proj-b', 'dl-b')

/** Simulates the user switching to a different project while an IPC call from the
 *  previous project is still in flight — the response must not land on the wrong project. */
describe('project-switch stale-response protection', () => {
  beforeEach(() => {
    useData.setState({ activeProject: projectA, projectImages: [], transcript: [], previewError: '' })
  })

  it('setMedia ignores a late response after the project changed', async () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        compose: {
          setMedia: async (id: string, patch: Partial<Project>) => {
            // The user switches projects before this IPC call resolves.
            useData.setState({ activeProject: projectB })
            return { ...project(id, 'dl-a'), ...patch }
          }
        }
      }
    }

    await useData.getState().setMedia({ seed: 42 })

    expect(useData.getState().activeProject).toEqual(projectB)
  })

  it('setCaptions ignores a late response after the project changed', async () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        compose: {
          updateCaptions: async (id: string, patch: Partial<Project>) => {
            useData.setState({ activeProject: projectB })
            return { ...project(id, 'dl-a'), ...patch }
          }
        }
      }
    }

    await useData.getState().setCaptions({ captionFont: 'Montserrat' })

    expect(useData.getState().activeProject).toEqual(projectB)
  })

  it('setLook ignores a late response after the project changed', async () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        compose: {
          updateLook: async (id: string, patch: { lut?: string; strength?: number }) => {
            useData.setState({ activeProject: projectB })
            return { ...project(id, 'dl-a'), lookLut: patch.lut, lookStrength: patch.strength }
          }
        }
      }
    }

    await useData.getState().setLook({ lut: 'cinematic', strength: 0.7 })

    expect(useData.getState().activeProject).toEqual(projectB)
  })

  it('setMotion ignores a late response after the project changed', async () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        compose: {
          updateMotion: async (id: string, patch: { preset: string }) => {
            useData.setState({ activeProject: projectB })
            return { ...project(id, 'dl-a'), motionPreset: patch.preset }
          }
        }
      }
    }

    await useData.getState().setMotion('cinematic')

    expect(useData.getState().activeProject).toEqual(projectB)
  })

  it('setProjectImages ignores a late response after the project changed', async () => {
    const staleImages = [image('img-stale', 'proj-a')]
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        compose: {
          setImages: async () => {
            useData.setState({ activeProject: projectB })
            return staleImages
          }
        }
      }
    }

    await useData.getState().setProjectImages(['image.jpg'])

    expect(useData.getState().projectImages).toEqual([])
  })

  it('reorderProjectImages ignores a late response after the project changed', async () => {
    const staleImages = [image('img-stale', 'proj-a')]
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        compose: {
          reorderImages: async () => {
            useData.setState({ activeProject: projectB })
            return staleImages
          }
        }
      }
    }

    await useData.getState().reorderProjectImages(['img-1'])

    expect(useData.getState().projectImages).toEqual([])
  })

  it('setImageRanges ignores a late response after the project changed', async () => {
    const staleImages = [image('img-stale', 'proj-a')]
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        compose: {
          setRanges: async () => {
            useData.setState({ activeProject: projectB })
            return staleImages
          }
        }
      }
    }

    await useData.getState().setImageRanges([{ id: 'img-1', rangeStart: 0, rangeEnd: 10 }])

    expect(useData.getState().projectImages).toEqual([])
  })

  it('setImageMotion ignores a late response after the project changed', async () => {
    const staleImages = [image('img-stale', 'proj-a')]
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        compose: {
          setImageMotion: async () => {
            useData.setState({ activeProject: projectB })
            return staleImages
          }
        }
      }
    }

    await useData.getState().setImageMotion([{ id: 'img-1', motionAmount: 70 }])

    expect(useData.getState().projectImages).toEqual([])
  })
})

describe('caption emphasis optimistic-update rollback', () => {
  beforeEach(() => {
    useData.setState({
      activeProject: projectA,
      transcript: [word('w-1', 'proj-a'), word('w-2', 'proj-a')],
      transcribeError: ''
    })
  })

  it('toggleWordEmphasis rolls back the optimistic flip and surfaces an error on IPC failure', async () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        transcribe: {
          toggleEmphasis: async () => { throw new Error('write failed') }
        }
      }
    }

    await useData.getState().toggleWordEmphasis('w-1')

    expect(useData.getState().transcript.find((w) => w.id === 'w-1')?.emphasis).toBe(false)
    expect(useData.getState().transcribeError).toBe('write failed')
  })

  it('toggleWordEmphasis keeps the optimistic flip when the IPC call succeeds', async () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        transcribe: {
          toggleEmphasis: async () => undefined
        }
      }
    }

    await useData.getState().toggleWordEmphasis('w-1')

    expect(useData.getState().transcript.find((w) => w.id === 'w-1')?.emphasis).toBe(true)
    expect(useData.getState().transcribeError).toBe('')
  })

  it('setWordsEmphasis restores the exact prior transcript on IPC failure', async () => {
    const before = useData.getState().transcript
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        transcribe: {
          setEmphasis: async () => { throw new Error('bulk write failed') }
        }
      }
    }

    await useData.getState().setWordsEmphasis(['w-1', 'w-2'], true)

    expect(useData.getState().transcript).toEqual(before)
    expect(useData.getState().transcribeError).toBe('bulk write failed')
  })
})
