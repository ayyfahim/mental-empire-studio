import { describe, expect, it } from 'vitest'
import { automationBrollSeed, effectiveBrollPool, seededBrollOrder } from '../../shared/automationBroll'

const clips = [{ id: 'discipline' }, { id: 'city' }, { id: 'training' }, { id: 'focus' }, { id: 'success' }]

describe('Automation B-roll resolution and ordering', () => {
  it('prefers project, then automation, then source niche', () => {
    expect(effectiveBrollPool({ projectBroll: { poolKey: 'project' }, sourceNichePoolKey: 'niche' }).poolKey).toBe('project')
    expect(effectiveBrollPool({ automationConfig: { styleConfig: { brollPoolKey: 'automation' } as never }, sourceNichePoolKey: 'niche' }).poolKey).toBe('automation')
    expect(effectiveBrollPool({ sourceNichePoolKey: 'niche' }).poolKey).toBe('niche')
  })

  it('selected-only disables live fallback and all-sources drops scope', () => {
    expect(effectiveBrollPool({ projectBroll: { poolKey: 'x', fallbackPolicy: 'selected-only' } })).toMatchObject({ poolKey: 'x', allowLive: false })
    const all = effectiveBrollPool({ projectBroll: { poolKey: 'x', fallbackPolicy: 'all-sources' } })
    expect(all.allPools).toBe(true)
    expect(all.poolKey).toBeUndefined()
  })

  it('is stable for the same video and different across a batch', () => {
    const a = automationBrollSeed('job', 'video-a')
    const b = automationBrollSeed('job', 'video-b')
    expect(a).not.toBe(b)
    expect(seededBrollOrder(clips, a, true)).toEqual(seededBrollOrder(clips, a, true))
    expect(seededBrollOrder(clips, a, true)).not.toEqual(seededBrollOrder(clips, b, true))
    expect(seededBrollOrder(clips, a, false)).toEqual(clips)
  })
})
