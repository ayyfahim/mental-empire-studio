import { describe, expect, it } from 'vitest'
import { DEFAULT_AUTOMATION_STYLE, finiteNumber, normalizeAutomationConfig, normalizeAutomationStyle } from '../../shared/automationConfig'

describe('Automation numeric and legacy normalization', () => {
  it.each([
    [0, 0], ['0', 0], [5, 5], ['invalid', 0.8], [Number.NaN, 0.8], [undefined, 0.8]
  ])('keeps finite crossfade boundaries (%p)', (value, expected) => {
    expect(normalizeAutomationStyle({ crossfadeSec: value }).crossfadeSec).toBe(expected)
  })

  it('keeps zero gradient and download delay through durable normalization', () => {
    const config = normalizeAutomationConfig({
      styleConfig: { ...DEFAULT_AUTOMATION_STYLE, gradientIntensity: 0, crossfadeSec: 0 },
      rules: { downloadDelaySec: 0 } as never
    })
    expect(config.styleConfig.crossfadeSec).toBe(0)
    expect(config.styleConfig.gradientIntensity).toBe(0)
    expect(config.rules.downloadDelaySec).toBe(0)
  })

  it('clamps maxima and translates legacy style fields', () => {
    const config = normalizeAutomationConfig({ style: 'Intense', captionPreset: 'Minimal', aspectRatios: ['9:16'], styleConfig: { crossfadeSec: 99, gradientIntensity: -4 } as never })
    expect(config.styleConfig).toMatchObject({ videoStyle: 'Intense', captionPreset: 'Minimal', aspectRatio: '9:16', crossfadeSec: 5, gradientIntensity: 0 })
  })

  it('loads legacy jobs without introducing upload skips or network pacing', () => {
    const config = normalizeAutomationConfig({ rules: { autoBroll: true, removeSilence: true, reduceFillerWords: true } as never })
    expect(config.rules).toMatchObject({ skipUploaded: false, downloadDelaySec: 0, removeSilence: true, reduceFillerWords: true })
    expect(config.styleConfig.brollMode).toBe('full')
  })

  it.each([['Bounce', 'Pop-in'], ['Slide', 'Fade'], ['Type', 'Pop-in'], ['unknown', 'Pop-in']])('maps legacy caption animation %s to %s', (legacy, supported) => {
    expect(normalizeAutomationStyle({ captionAnimation: legacy }).captionAnimation).toBe(supported)
  })

  it('finiteNumber accepts zero and rejects invalid values', () => {
    expect(finiteNumber(0, 3, 0, 10)).toBe(0)
    expect(finiteNumber('', 3, 0, 10)).toBe(3)
    expect(finiteNumber(Number.NaN, 3, 0, 10)).toBe(3)
    expect(finiteNumber(20, 3, 0, 10)).toBe(10)
  })
})
