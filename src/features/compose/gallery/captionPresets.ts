import type { Project } from '@shared/types'
import { CAPTION_PRESET_IDS, captionPresetSpec } from '@shared/captionStyle'

// UI-facing preset list. The actual visual definitions live in shared/captionStyle.ts
// (one source of truth for the ASS burn, the GPU canvas, and these cards).

export const CAPTION_PRESETS = CAPTION_PRESET_IDS
export const QUICK_CAPTION_PRESETS = ['Hormozi', 'Beast', 'Boxed', 'Minimal'] as const

export type CaptionPresetName = (typeof CAPTION_PRESETS)[number]

/**
 * Patch applied when the user picks a preset: adopt the preset's designed font and
 * clear stale per-project colour overrides so the card's look is exactly what they
 * get (they can still re-override font/colours afterwards).
 */
export function captionPresetPatch(
  _project: Partial<Project> | null | undefined,
  captionPreset: string
): Partial<Project> {
  const spec = captionPresetSpec(captionPreset)
  // null (not undefined) so the DB patch actually clears old colour overrides.
  const patch = {
    captionPreset,
    captionFont: spec.fontFamily,
    captionHighlightColor: null,
    captionBoxColor: null
  } as unknown as Partial<Project>
  if (spec.active.kind === 'box') {
    patch.captionPace = 'word'
    patch.captionLines = 1
    patch.captionWordsPerPage = 2
  }
  return patch
}
