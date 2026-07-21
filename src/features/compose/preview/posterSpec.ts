import type { GpuRenderSpec, RenderImageSpec } from '@shared/renderSpec'

/**
 * The editor previews B-roll with extracted poster frames rather than running a
 * VideoDecoder in the visible renderer. Switch the compositor to its still-image
 * path as well; leaving `broll` populated makes it sample the (empty) video
 * textures even though the poster textures were uploaded successfully.
 */
export function asPosterPreviewSpec(spec: GpuRenderSpec, posters: RenderImageSpec[]): GpuRenderSpec {
  if (!spec.broll?.length) return spec
  return { ...spec, broll: undefined, images: posters }
}
