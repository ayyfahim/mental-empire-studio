import { describe, expect, it } from 'vitest'
import { CAPTION_PRESETS, QUICK_CAPTION_PRESETS, captionPresetPatch } from '../../src/features/compose/gallery/captionPresets'
import { CAPTION_PRESET_SPECS, captionPresetSpec, keywordColor, resolveCaptionStyle } from '../../shared/captionStyle'

describe('captionPresetPatch', () => {
  it('adopts the preset font and clears stale colour overrides', () => {
    const patch = captionPresetPatch({ captionFont: 'Montserrat' }, 'Hormozi')
    expect(patch).toMatchObject({ captionPreset: 'Hormozi', captionFont: 'Anton' })
    // null (not undefined) so the DB patch actually clears the old overrides
    expect(patch.captionHighlightColor).toBeNull()
    expect(patch.captionBoxColor).toBeNull()
  })

  it('applies boxed-preset defaults (word pace, one line, two-word pages)', () => {
    expect(captionPresetPatch(null, 'Boxed')).toMatchObject({
      captionPreset: 'Boxed',
      captionFont: 'Archivo Black',
      captionPace: 'word',
      captionLines: 1,
      captionWordsPerPage: 2
    })
  })

  it('exports the full and quick preset sets used by the galleries', () => {
    expect(CAPTION_PRESETS).toEqual(CAPTION_PRESET_SPECS.map((p) => p.id))
    expect(QUICK_CAPTION_PRESETS).toEqual(['Hormozi', 'Beast', 'Boxed', 'Minimal'])
  })
})

describe('captionPresetSpec', () => {
  it('maps legacy ids stored in old projects onto modern specs', () => {
    expect(captionPresetSpec('Submagic').id).toBe('Boxed')
    expect(captionPresetSpec('Pop').id).toBe('Karaoke')
    expect(captionPresetSpec('Bold').id).toBe('Beast')
    expect(captionPresetSpec('nonsense').id).toBe('Hormozi')
  })

  it('gives every preset a genuinely distinct look (font or colours differ)', () => {
    const signatures = CAPTION_PRESET_SPECS.map((p) =>
      [p.fontFamily, p.active.kind, p.active.color, p.keywordColors.join(','), p.uppercase, p.sizeFactor].join('|')
    )
    expect(new Set(signatures).size).toBe(CAPTION_PRESET_SPECS.length)
  })

  it('keyword emphasis is distinct from the active-word treatment on Hormozi', () => {
    const style = resolveCaptionStyle({ captionPreset: 'Hormozi' })
    const kw = [0, 1, 2].map((i) => keywordColor(style, i))
    expect(new Set(kw).size).toBe(3) // green / yellow / red rotation
    expect(kw[0]).not.toBe(style.activeColor)
  })

  it('project overrides beat preset defaults but bad hex is ignored', () => {
    const styled = resolveCaptionStyle({ captionPreset: 'Hormozi', captionHighlightColor: '#00ff00' })
    expect(styled.activeColor).toBe('#00ff00')
    expect(resolveCaptionStyle({ captionPreset: 'Hormozi', captionHighlightColor: 'nope' }).activeColor).toBe('#FFD93D')
  })

  it('anchors: coarse position defaults and the fine offset override', () => {
    expect(resolveCaptionStyle({ captionPosition: 'bottom', captionAspect: '16:9' }).anchorPct).toBe(74)
    expect(resolveCaptionStyle({ captionPosition: 'top', captionAspect: '9:16' }).anchorPct).toBe(16)
    expect(resolveCaptionStyle({ captionPosition: 'bottom', captionOffsetY: 90 }).anchorPct).toBe(90)
    expect(resolveCaptionStyle({ captionOffsetY: 200 }).anchorPct).toBe(96) // clamped
  })
})
