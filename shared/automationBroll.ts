import type { AutomationJobConfig, AutomationBrollFallbackPolicy, BetaVideoOpts } from './types'

export interface EffectiveBrollPool {
  poolKey?: string
  fallbackPolicy: AutomationBrollFallbackPolicy
  allowLive: boolean
  allPools: boolean
  source: 'project' | 'automation' | 'source-niche' | 'global'
}

export function effectiveBrollPool(input: {
  projectBroll?: Partial<BetaVideoOpts['broll']>
  automationConfig?: Partial<AutomationJobConfig>
  sourceNichePoolKey?: string
}): EffectiveBrollPool {
  const project = input.projectBroll
  const automation = input.automationConfig?.styleConfig
  const poolKey = project?.poolKey || automation?.brollPoolKey || input.sourceNichePoolKey
  const fallbackPolicy = project?.fallbackPolicy || automation?.brollFallbackPolicy || 'prefer-selected'
  const source = project?.poolKey ? 'project' : automation?.brollPoolKey ? 'automation' : input.sourceNichePoolKey ? 'source-niche' : 'global'
  return {
    ...(fallbackPolicy === 'all-sources' ? {} : poolKey ? { poolKey } : {}),
    fallbackPolicy,
    allowLive: fallbackPolicy !== 'selected-only',
    allPools: fallbackPolicy === 'all-sources',
    source
  }
}

/** Stable signed-31-bit seed; same job/video is identical, different videos diverge. */
export function automationBrollSeed(jobId: string, sourceVideoId: string): number {
  let hash = 2166136261
  for (const ch of `${jobId}\u0000${sourceVideoId}`) {
    hash ^= ch.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 1
}

export function seededBrollOrder<T extends { id: string }>(items: T[], seed: number, shuffle: boolean): T[] {
  const out = [...items]
  if (!shuffle) return out
  let state = seed || 1
  const random = (): number => {
    state = Math.imul(state ^ (state >>> 15), 1 | state)
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state)
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
