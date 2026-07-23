import type { MontageProduceOptions, MontageProduceResult, MontageProgress } from '../../../shared/types'
import { getRepos } from '../../db'
import { emit } from '../../ipc/events'
import { produceFromBrief, type BridgeEvent } from './bridge'

// Bridge a MES project into an OpenMontage `produce` brief and run it. The brief-builder is the
// seam the Remotion (unit 2) and HyperFrames (unit 3) composition units flesh out; the plumbing
// (progress streaming, cancellation) lives here and in bridge.ts.

/**
 * Build the OpenMontage `produce` brief from a MES project.
 *
 * FOUNDATION STUB — units 2 (Remotion) and 3 (HyperFrames) implement the mapping from the project's
 * images / transcript / caption style / VideoStyle into footage queries + `edit_decisions.cuts[]`.
 * Throwing here surfaces cleanly as MontageProduceResult{ok:false} rather than crashing the run.
 */
export function buildBriefForProject(projectId: string, opts?: MontageProduceOptions): Record<string, unknown> {
  const project = getRepos().getProject(projectId)
  if (!project) throw new Error(`project not found: ${projectId}`)
  const sample = !!opts?.sample
  const runtime = opts?.runtime
  void sample
  void runtime
  // TODO(unit-2/3): map project → { output_dir, footage.queries[], compose.{render_runtime,edit_decisions} }.
  throw new Error(
    'OpenMontage composition is not implemented yet (foundation stub). See docs/OPENMONTAGE_BRIDGE.md units 2 & 3.'
  )
}

export async function composeViaMontage(projectId: string, opts?: MontageProduceOptions): Promise<MontageProduceResult> {
  let brief: Record<string, unknown>
  try {
    brief = buildBriefForProject(projectId, opts)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }

  const onEvent = (ev: BridgeEvent): void => {
    const progress: MontageProgress = {
      id: projectId,
      stage: String(ev.stage ?? ev.event ?? ''),
      status: (ev.status as MontageProgress['status']) ?? 'log',
      message: (ev.msg as string) ?? (ev.message as string) ?? undefined,
      data: ev as Record<string, unknown>
    }
    emit('montage:progress', progress)
  }

  return produceFromBrief(projectId, brief, onEvent)
}
