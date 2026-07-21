import { asBetaOpts } from '@shared/types'
import type { BetaVideoOpts, Project, ProjectImage, TranscriptWord } from '@shared/types'
import type { GpuBrollSegment } from '@shared/renderSpec'
import type { EditorSelection } from '../timeline/timelineModel'

export interface ComposeRenderPreflight {
  ready: boolean
  missing: string[]
}

/** Best-effort mirror of the server-side validateRenderReady check (electron/ipc/compose.ts's
 *  sendToRender guard) so "Send to render" can be disabled with an actionable reason instead of
 *  only failing after a full IPC round trip. B-roll/library availability is DB- and
 *  settings-backed, so a project with B-roll enabled but an empty cache still passes this
 *  client-side check — the server's own error message remains authoritative for that case. */
export function composeRenderPreflight(project: Project | null | undefined, images: ProjectImage[]): ComposeRenderPreflight {
  if (!project) return { ready: false, missing: ['project'] }
  const missing: string[] = []
  if (!project.mp3Path) missing.push('audio')
  if (!project.durationSec || project.durationSec <= 0) missing.push('audio duration')
  const brollEnabled = asBetaOpts(project.betaOpts).broll.enabled
  if (images.length === 0 && !brollEnabled) missing.push('images or Auto B-roll')
  return { ready: missing.length === 0, missing }
}

export function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

export function formatDuration(sec?: number): string {
  if (!sec) return ''
  return fmt(sec)
}

/** CSS background stack for the edge-gradient overlay (mirrors the GPU overlay pass). */
export function overlayBackground(o?: BetaVideoOpts['overlay']): string {
  if (!o) return 'linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.42))'
  const intensity = Math.max(0, Math.min(100, o.intensity ?? 50))
  if (intensity === 0 || (!o.bottom && !o.top && !o.left && !o.right)) return 'transparent'
  const alpha = (0.08 + (intensity / 100) * 0.42).toFixed(3)
  const stop = `${Math.round(36 + (intensity / 100) * 28)}%`
  const edges: string[] = []
  if (o.bottom) edges.push(`linear-gradient(180deg,rgba(0,0,0,0) ${100 - parseInt(stop, 10)}%,rgba(0,0,0,${alpha}) 100%)`)
  if (o.top) edges.push(`linear-gradient(0deg,rgba(0,0,0,0) ${100 - parseInt(stop, 10)}%,rgba(0,0,0,${alpha}) 100%)`)
  if (o.left) edges.push(`linear-gradient(90deg,rgba(0,0,0,${alpha}) 0%,rgba(0,0,0,0) ${stop})`)
  if (o.right) edges.push(`linear-gradient(270deg,rgba(0,0,0,${alpha}) 0%,rgba(0,0,0,0) ${stop})`)
  return edges.join(',')
}

/** Human label for whatever is selected on the timeline (shown in the preview header). */
export function editorSelectionLabel(
  selection: EditorSelection,
  images: ProjectImage[],
  words: TranscriptWord[],
  broll: GpuBrollSegment[],
  project?: Project | null
): string {
  if (selection.kind === 'image') {
    const image = images.find((im) => im.id === selection.id)
    return image ? `Image · ${fmt(image.rangeStart)}-${fmt(image.rangeEnd)}` : 'Image segment'
  }
  if (selection.kind === 'broll') {
    const index = Number(selection.id.replace(/^broll-/, ''))
    const segment = Number.isFinite(index) ? broll[index] : undefined
    return segment ? `B-roll · ${fmt(segment.startSec)}-${fmt(segment.endSec)}` : 'B-roll segment'
  }
  if (selection.kind === 'caption') {
    const word = words.find((w) => w.id === selection.id)
    return word ? `Caption · ${word.word}` : 'Caption word'
  }
  if (selection.kind === 'look') return `Look · ${project?.lookLut ?? 'off'}`
  if (selection.kind === 'audio') return 'Audio track'
  return ''
}
