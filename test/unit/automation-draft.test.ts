import { describe, expect, it } from 'vitest'
import { automationDraftReducer, createDefaultDraft } from '../../shared/automationDraft'

describe('Automation draft lifecycle', () => {
  it('new draft clears all setup-only selection and changes identity', () => {
    const initial = createDefaultDraft()
    const dirty = automationDraftReducer(initial, { type: 'patch-config', patch: { sourceId: 's', sourceUrl: 'u', selectedVideoIds: ['v'], localMediaPaths: ['m'], assetPaths: ['a'] } })
    const clean = automationDraftReducer(dirty, { type: 'new' })
    expect(clean.id).not.toBe(dirty.id)
    expect(clean.draft.config).toMatchObject({ sourceId: '', sourceUrl: '', selectedVideoIds: [], localMediaPaths: [], assetPaths: [] })
  })

  it('changing source clears exact IDs but keeps styles, rules, and assets', () => {
    let state = createDefaultDraft()
    state = automationDraftReducer(state, { type: 'patch-config', patch: { selectedVideoIds: ['v'], assetPaths: ['a'] } })
    state = automationDraftReducer(state, { type: 'patch-style', patch: { crossfadeSec: 0 } })
    const next = automationDraftReducer(state, { type: 'change-source', source: { id: 's2', url: 'https://youtube.com/@x', handle: '@x', name: 'X' } as never })
    expect(next.draft.config.selectedVideoIds).toEqual([])
    expect(next.draft.config.assetPaths).toEqual(['a'])
    expect(next.draft.config.styleConfig.crossfadeSec).toBe(0)
  })
})
