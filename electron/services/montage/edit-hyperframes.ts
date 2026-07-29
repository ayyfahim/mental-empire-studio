import type { VideoStyle } from '../../../shared/types'
import { buildEditDecisionsCore, remotionRendererFamily, type MontageComposeContext } from './edit-remotion'

// HyperFrames edit_decisions builder for the OpenMontage bridge.
//
// OpenMontage's HyperFramesCompose (driven via VideoCompose with render_runtime:"hyperframes")
// consumes the SAME edit_decisions shape as the Remotion path — cuts[], audio{}, asset_manifest,
// metadata — and materializes an HTML/CSS/GSAP workspace instead of a React composition
// (OpenMontage/tools/video/hyperframes_compose.py). So we reuse the shared cut/caption/asset core
// from edit-remotion.ts and only swap render_runtime + renderer_family.
//
// Requires Node.js >= 22 on the target machine. Availability is enforced at render time via
// getMontageCapabilities() — an unavailable runtime surfaces a structured blocker rather than
// silently swapping to Remotion/ffmpeg (see docs/OPENMONTAGE_BRIDGE.md §2 governance).

/** Renderer family for the HyperFrames path. HyperFrames does not use the Remotion composition
 *  map, but VideoCompose's pre-compose validation still requires a non-empty renderer_family, and
 *  slideshow-risk scoring reads it for cinematic-claim checks — so we reuse the style mapping. */
export function hyperframesRendererFamily(style: VideoStyle): string {
  return remotionRendererFamily(style)
}

/** Build the full HyperFrames edit_decisions (render_runtime:'hyperframes'). */
export function buildHyperframesEditDecisions(ctx: MontageComposeContext): Record<string, unknown> {
  return {
    render_runtime: 'hyperframes',
    renderer_family: hyperframesRendererFamily(ctx.style),
    ...buildEditDecisionsCore(ctx)
  }
}
