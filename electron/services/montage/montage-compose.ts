import { join } from 'node:path'
import type {
  MontageProduceOptions,
  MontageProduceResult,
  MontageProgress,
  MontageRuntime,
  ProjectImage
} from '../../../shared/types'
import { resolveCaptionStyle } from '../../../shared/captionStyle'
import { getRepos } from '../../db'
import { emit } from '../../ipc/events'
import { getSettings } from '../../store/settings'
import { itemDirForProject, itemOutputDir } from '../storage'
import { dimensions } from '../render'
import { logger } from '../logger'
import { sentryLog } from '../sentry'
import { produceFromBrief, type BridgeEvent } from './bridge'
import { getMontageCapabilities } from './capabilities'
import {
  buildAssetManifest,
  buildRemotionEditDecisions,
  buildEditDecisionsCore,
  mapAspectToProfile,
  remotionRendererFamily,
  type MontageComposeContext
} from './edit-remotion'
import { buildHyperframesEditDecisions } from './edit-hyperframes'

// Bridge a MES project into an OpenMontage `produce` brief and run it. `buildBriefForProject` maps
// the project's images / transcript / caption style / VideoStyle into footage-free composition
// decisions; edit-remotion.ts and edit-hyperframes.ts build the runtime-specific edit_decisions.
// The plumbing (progress streaming, cancellation) lives here and in bridge.ts.

const LOG = logger.scope('montage-compose')

/** Bounded duration (seconds) for a sample/preview render. */
const SAMPLE_SEC = 12

/** Resolve which OpenMontage composition runtime to use for this brief:
 *  opts.runtime → project betaOpts.montageRuntime (unless 'native') → default 'remotion'. */
function resolveRuntime(betaRuntime: string | undefined, opts?: MontageProduceOptions): MontageRuntime {
  if (opts?.runtime) return opts.runtime
  if (betaRuntime === 'remotion' || betaRuntime === 'hyperframes') return betaRuntime
  return 'remotion'
}

/** Pick + range the still images used for a sample so a preview stays bounded. */
function sampleImages(images: ProjectImage[]): ProjectImage[] {
  if (images.length <= 4) return images
  return images.slice(0, 4)
}

/**
 * Build the OpenMontage `produce` brief from a MES project.
 *
 * Reads the project, its still images, transcript word timings and caption style, and turns them
 * into a `{ project_id, output_dir, compose:{ render_runtime, edit_decisions, asset_manifest,
 * profile, output_path } }` brief that resources/montage/mes_bridge.py `produce` can render via
 * OpenMontage VideoCompose / HyperFramesCompose. Footage is intentionally omitted — MES projects
 * already own their still images; the footage/stock path is a separate unit (W1).
 */
export function buildBriefForProject(projectId: string, opts?: MontageProduceOptions): Record<string, unknown> {
  const repos = getRepos()
  const project = repos.getProject(projectId)
  if (!project) throw new Error(`project not found: ${projectId}`)

  const betaRuntime = (project.betaOpts as { montageRuntime?: string } | undefined)?.montageRuntime
  const runtime = resolveRuntime(betaRuntime, opts)
  const sample = !!opts?.sample

  const settings = getSettings()
  const aspect = project.captionAspect ?? '16:9'
  const dims = dimensions(settings.quality, aspect)

  const allImages = repos.getProjectImages(projectId)
  const words = repos.getTranscript(projectId)

  // Effective duration: prefer the stored duration; fall back to a nominal length so timings are
  // never degenerate for a not-yet-probed project. Bound to SAMPLE_SEC for sample renders.
  const baseDuration = project.durationSec > 0 ? project.durationSec : Math.max(30, allImages.length * 4)
  const durationSec = sample ? Math.min(baseDuration, SAMPLE_SEC) : baseDuration

  const images = sample ? sampleImages(allImages) : allImages

  const caption = resolveCaptionStyle({
    captionPreset: project.captionPreset,
    captionFont: project.captionFont,
    captionHighlightColor: project.captionHighlightColor,
    captionBoxColor: project.captionBoxColor,
    captionPosition: project.captionPosition,
    captionOffsetY: project.captionOffsetY,
    captionAspect: aspect
  })

  if (!project.mp3Path) throw new Error('project has no narration audio (mp3Path)')

  const ctx: MontageComposeContext = {
    projectId: project.id,
    title: project.title ?? '',
    channel: project.channel ?? '',
    images,
    words,
    durationSec,
    aspect,
    dims,
    fps: 30,
    caption,
    captionsEnabled: words.length > 0,
    style: (project.betaOpts as { style?: MontageComposeContext['style'] } | undefined)?.style ?? 'None',
    kenBurns: project.kenBurns !== false,
    audioPath: project.mp3Path,
    sample
  }

  const editDecisions =
    runtime === 'hyperframes'
      ? buildHyperframesEditDecisions(ctx)
      : runtime === 'ffmpeg'
        ? { render_runtime: 'ffmpeg', renderer_family: remotionRendererFamily(ctx.style), ...buildEditDecisionsCore(ctx) }
        : buildRemotionEditDecisions(ctx)

  const assetManifest = buildAssetManifest(ctx)

  const outputDir = itemOutputDir(itemDirForProject(project))
  const outputPath = join(outputDir, 'renders', sample ? 'sample.mp4' : 'final.mp4')

  LOG.info(
    `built brief project=${project.id} runtime=${runtime} images=${images.length} words=${words.length} sample=${sample}`
  )

  return {
    project_id: project.id,
    output_dir: outputDir,
    compose: {
      render_runtime: runtime,
      edit_decisions: editDecisions,
      asset_manifest: assetManifest,
      profile: mapAspectToProfile(aspect),
      output_path: outputPath
    }
  }
}

/** Normalize a raw bridge stage/log event into the renderer-facing MontageProgress shape. */
function toMontageProgress(projectId: string, ev: BridgeEvent): MontageProgress {
  return {
    id: projectId,
    stage: String(ev.stage ?? ev.event ?? ''),
    status: (ev.status as MontageProgress['status']) ?? 'log',
    message: (ev.msg as string) ?? (ev.message as string) ?? undefined,
    data: ev as Record<string, unknown>
  }
}

/**
 * Build the brief + run the OpenMontage produce orchestration for a project, streaming stage
 * events. Emits `montage:progress` for the montage UI and forwards each raw bridge event to the
 * optional `onEvent` callback so callers (e.g. the render queue) can map stages to their own
 * progress channel.
 */
export async function composeViaMontageWithEvents(
  projectId: string,
  opts?: MontageProduceOptions,
  onEvent?: (ev: BridgeEvent) => void
): Promise<MontageProduceResult> {
  let brief: Record<string, unknown>
  try {
    brief = buildBriefForProject(projectId, opts)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }

  return produceFromBrief(projectId, brief, (ev) => {
    emit('montage:progress', toMontageProgress(projectId, ev))
    onEvent?.(ev)
  })
}

/** IPC-facing produce: build brief → run → stream montage:progress. */
export async function composeViaMontage(projectId: string, opts?: MontageProduceOptions): Promise<MontageProduceResult> {
  return composeViaMontageWithEvents(projectId, opts)
}

/**
 * Capability gate for the render-queue OpenMontage branch. Returns a human-readable blocker string
 * when the chosen runtime is unavailable per getMontageCapabilities(), or null when it is safe to
 * proceed. Callers MUST NOT fall back to another runtime — surface the blocker instead (governance:
 * no silent runtime swap; docs/OPENMONTAGE_BRIDGE.md §2).
 */
export async function montageRuntimeBlocker(runtime: MontageRuntime): Promise<string | null> {
  const caps = await getMontageCapabilities()
  if (!caps.available) {
    return `OpenMontage is unavailable${caps.error ? `: ${caps.error}` : ''}. Configure it in Settings → OpenMontage, or switch this project's composition runtime back to Native.`
  }
  const engineOk =
    runtime === 'hyperframes'
      ? caps.renderEngines.hyperframes
      : runtime === 'ffmpeg'
        ? caps.renderEngines.ffmpeg
        : caps.renderEngines.remotion
  if (!engineOk) {
    sentryLog.warn('montage runtime blocked', { runtime, remotion: caps.renderEngines.remotion, hyperframes: caps.renderEngines.hyperframes })
    return `OpenMontage "${runtime}" runtime is not available on this machine (capability probe). MES will not silently switch runtimes — install/enable ${runtime} in the OpenMontage app, or choose a different composition runtime for this project.`
  }
  return null
}
