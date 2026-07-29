import type { MontageCapabilities } from '../../../shared/types'
import { detectCapabilities } from './bridge'

// Probing spawns Python + imports the OpenMontage registry (~90 modules), so cache the result
// briefly. Settings changes should call invalidateMontageCapabilities() to force a fresh probe.

let cache: { at: number; caps: MontageCapabilities } | null = null
const TTL_MS = 60_000

export async function getMontageCapabilities(force = false): Promise<MontageCapabilities> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.caps
  const caps = await detectCapabilities()
  cache = { at: Date.now(), caps }
  return caps
}

export function invalidateMontageCapabilities(): void {
  cache = null
}
