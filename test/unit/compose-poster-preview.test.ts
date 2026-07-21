import { describe, expect, it } from 'vitest'
import type { GpuRenderSpec, RenderImageSpec } from '../../shared/renderSpec'
import { asPosterPreviewSpec } from '../../src/features/compose/preview/posterSpec'

describe('B-roll poster preview spec', () => {
  it('switches the compositor from video textures to extracted poster images', () => {
    const source = {
      images: [],
      broll: [{ path: 'clip.mp4', startSec: 0, endSec: 6 }]
    } as unknown as GpuRenderSpec
    const posters: RenderImageSpec[] = [{ path: 'poster.png', startSec: 0, endSec: 6 }]

    const preview = asPosterPreviewSpec(source, posters)

    expect(preview.broll).toBeUndefined()
    expect(preview.images).toEqual(posters)
  })
})
