import type { MontageFootageClip, MontageFootageRequest } from '../../../shared/types'
import { retrieveFootage } from './bridge'
import type { MontageComposeContext } from './edit-remotion'

// OpenMontage footage/stock sourcing (W1).
//
// Two entry points share the same OpenMontage DirectClipSearch tool:
//  1. `buildFootageBlock()` — attaches a `footage` block to the compose brief so the shim's
//     `produce` orchestrator retrieves clips into the project workspace right before it composes
//     (the "agentic" retrieve→compose flow). This is how an OpenMontage-composed video gets real
//     motion footage; it needs no changes to MES's native B-roll library.
//  2. `retrieveMontageFootage()` — a standalone fetch (used by the montage:retrieveFootage IPC) for
//     callers that just want clip files on disk.
//
// NOTE (follow-up): injecting OpenMontage clips into MES's NATIVE ffmpeg/GPU B-roll pool
// (electron/services/broll.ts library index) is a separate, larger integration — the library
// pipeline (fetchPool → cacheCandidateForLibrary → writeLibraryIndex) expects to download from a
// provider URL, whereas DirectClipSearch returns already-downloaded files. That path is intentionally
// deferred; see docs/OPENMONTAGE_BRIDGE.md. Today OpenMontage footage flows through the OpenMontage
// composition path (facet 1), which is where "use their footage" actually matters.

/** Which MES footage source the user picked for a project/pool. Stored on betaOpts.montageFootageSource. */
export type MontageFootageSource = 'native' | 'archives' | 'stock' | 'all'

/** Public-domain archives — no API keys required. */
export const MONTAGE_ARCHIVE_SOURCES = ['archive_org', 'nasa', 'wikimedia', 'loc'] as const
/** Keyed stock providers (reuse beta.pexelsKey/pixabayKey + montage.unsplashKey). */
export const MONTAGE_STOCK_SOURCES = ['pexels', 'pixabay', 'unsplash'] as const

/** Map a MES footage-source selection to OpenMontage adapter names. Returns null for 'native'
 *  (no OpenMontage retrieval) so callers can cleanly skip the footage stage. */
export function montageFootageSources(source: MontageFootageSource): string[] | null {
  switch (source) {
    case 'archives':
      return [...MONTAGE_ARCHIVE_SOURCES]
    case 'stock':
      return [...MONTAGE_STOCK_SOURCES]
    case 'all':
      return [...MONTAGE_ARCHIVE_SOURCES, ...MONTAGE_STOCK_SOURCES]
    case 'native':
    default:
      return null
  }
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'that', 'this', 'with', 'have', 'they', 'them', 'from',
  'what', 'why', 'how', 'when', 'will', 'can', 'are', 'was', 'but', 'not', 'all', 'out', 'get'
])

/** Derive a small set of footage search queries from the project's title + most-frequent content
 *  words. Deterministic (no randomness) so the same project yields a stable clip plan. */
export function footageQueriesForContext(ctx: Pick<MontageComposeContext, 'title' | 'words'>, max = 6): string[] {
  const queries: string[] = []
  const title = (ctx.title ?? '').trim()
  if (title) queries.push(title.slice(0, 80))

  const freq = new Map<string, number>()
  for (const w of ctx.words ?? []) {
    const norm = (w.word ?? '').toLowerCase().replace(/[^a-z]/g, '')
    if (norm.length >= 5 && !STOPWORDS.has(norm)) freq.set(norm, (freq.get(norm) ?? 0) + 1)
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w)
  for (const w of top) {
    if (queries.length >= max) break
    if (!queries.some((q) => q.toLowerCase().includes(w))) queries.push(w)
  }
  return queries.slice(0, max)
}

/** Build the `footage` block for the OpenMontage `produce` brief, or null when the project uses
 *  native footage (so buildBriefForProject omits it). */
export function buildFootageBlock(
  ctx: MontageComposeContext,
  source: MontageFootageSource
): { queries: { query: string; kind: 'video' }[]; sources: string[]; clips_per_query: number; filters: Record<string, unknown> } | null {
  const sources = montageFootageSources(source)
  if (!sources || sources.length === 0) return null
  const phrases = footageQueriesForContext(ctx)
  if (phrases.length === 0) return null
  return {
    queries: phrases.map((query) => ({ query, kind: 'video' })),
    sources,
    clips_per_query: ctx.sample ? 1 : 3,
    filters: {
      orientation: ctx.aspect === '9:16' ? 'portrait' : ctx.aspect === '1:1' ? 'square' : 'landscape',
      min_duration: 2
    }
  }
}

/** Standalone footage/stock fetch: map the MES source selection to OpenMontage adapters and run
 *  DirectClipSearch via the bridge. Used by the montage:retrieveFootage IPC. */
export async function retrieveMontageFootage(
  req: Omit<MontageFootageRequest, 'sources'> & { source?: MontageFootageSource }
): Promise<MontageFootageClip[]> {
  const sources = req.source ? montageFootageSources(req.source) : undefined
  return retrieveFootage({
    outputDir: req.outputDir,
    queries: req.queries,
    ...(sources ? { sources } : {}),
    ...(req.clipsPerQuery ? { clipsPerQuery: req.clipsPerQuery } : {}),
    ...(req.filters ? { filters: req.filters } : {})
  })
}
