import { describe, expect, it } from 'vitest'
import { contentAssetId } from '../../electron/services/asset-hash'

describe('asset hashing', () => {
  it('deduplicates identical bytes independent of source path', () => {
    const bytes = new TextEncoder().encode('same motivational image')
    expect(contentAssetId(bytes)).toBe(contentAssetId(bytes.slice()))
    expect(contentAssetId(bytes)).not.toBe(contentAssetId(new TextEncoder().encode('different image')))
  })
})
