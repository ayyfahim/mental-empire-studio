import { useMemo, useRef, useState, type MouseEvent, type ReactNode, type WheelEvent } from 'react'
import type { Project, ProjectImage, TranscriptWord } from '@shared/types'
import type { GpuBrollSegment } from '@shared/renderSpec'
import {
  buildBrollTimeline,
  buildCaptionGroupTimeline,
  buildVisualTimeline,
  clampTimelineSec,
  rangeToPct,
  type EditorSelection,
  type TimelineBlock,
  type VisualTimelineBlock
} from '../timeline/timelineModel'
import { IconBtn, SectionLabel } from '../../../components/ui/kit'
import { SelectionDetails } from './SelectionDetails'
import { fmt } from './util'

/* Multi-track timeline: visuals (stills + b-roll), caption phrases, look span, and
   the narration audio. Click to seek, click a block to inspect/edit it, ctrl+wheel
   to zoom (CapCut-style). */

const TRACK_H = 30
const TRACK_GAP = 7

function selectionKey(selection: EditorSelection): string {
  return selection.kind === 'image' || selection.kind === 'broll' || selection.kind === 'caption'
    ? `${selection.kind}:${selection.id}`
    : selection.kind
}

function TrackBox({ children, onSeek }: { children: ReactNode; onSeek: (e: MouseEvent<HTMLDivElement>) => void }): JSX.Element {
  return (
    <div onClick={onSeek} style={{ position: 'relative', height: TRACK_H, border: '1px solid var(--border)', borderRadius: 8, background: '#0b0d12', overflow: 'hidden', cursor: 'crosshair' }}>
      {children}
    </div>
  )
}

const TONES = {
  visual: { bg: 'rgba(245,179,35,.13)', border: 'rgba(245,179,35,.34)', activeBorder: 'var(--accent)', text: '#f5c95f', activeText: '#fff4cc' },
  broll: { bg: 'rgba(64,169,255,.12)', border: 'rgba(64,169,255,.34)', activeBorder: '#40a9ff', text: '#8fcaff', activeText: '#eaf6ff' },
  caption: { bg: 'rgba(54,201,142,.12)', border: 'rgba(54,201,142,.32)', activeBorder: '#36c98e', text: '#72d8aa', activeText: '#eafff5' },
  look: { bg: 'rgba(139,124,255,.13)', border: 'rgba(139,124,255,.34)', activeBorder: '#8b7cff', text: '#b8afff', activeText: '#f1eeff' }
} as const

function Block({
  block,
  active,
  tone,
  badge,
  onClick
}: {
  block: TimelineBlock
  active: boolean
  tone: keyof typeof TONES
  badge?: string
  onClick: (e: MouseEvent) => void
}): JSX.Element {
  const c = TONES[tone]
  return (
    <button
      type="button"
      title={`${block.label} · ${fmt(block.startSec)}-${fmt(block.endSec)}`}
      onClick={onClick}
      className="ed-block"
      style={{
        position: 'absolute',
        left: `${block.leftPct}%`,
        width: `${block.widthPct}%`,
        top: 4,
        bottom: 4,
        border: `1px solid ${active ? c.activeBorder : c.border}`,
        borderRadius: 6,
        background: c.bg,
        color: active ? c.activeText : c.text,
        padding: '0 7px',
        fontSize: 10.5,
        fontFamily: tone === 'caption' ? 'var(--font-display)' : 'var(--font-mono)',
        fontWeight: active ? 700 : 600,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        cursor: 'pointer',
        textAlign: 'left',
        boxShadow: active ? `0 0 0 1px ${c.activeBorder}` : 'none'
      }}
    >
      {badge && (
        <span style={{ display: 'inline-block', marginRight: 5, border: '1px solid currentColor', borderRadius: 5, padding: '0 4px', fontSize: 8, lineHeight: '12px', verticalAlign: '1px', opacity: 0.9 }}>
          {badge === 'video' ? '▶' : badge}
        </span>
      )}
      {block.label}
    </button>
  )
}

function Waveform(): JSX.Element {
  const bars = Array.from({ length: 72 }, (_, i) => {
    const h = 18 + Math.round(Math.abs(Math.sin(i * 0.55) * Math.cos(i * 0.17)) * 55)
    return <span key={i} style={{ width: 2.5, height: `${h}%`, borderRadius: 3, background: '#2b3441', display: 'block' }} />
  })
  return <div style={{ position: 'absolute', inset: '5px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>{bars}</div>
}

export function Timeline({
  project,
  images,
  broll = [],
  words,
  playheadSec,
  selection,
  onSeek,
  onSelect
}: {
  project: Project
  images: ProjectImage[]
  broll?: GpuBrollSegment[]
  words: TranscriptWord[]
  playheadSec: number
  selection: EditorSelection
  onSeek: (sec: number) => void
  onSelect: (selection: EditorSelection) => void
}): JSX.Element {
  const durationSec = Math.max(0.05, project.durationSec || 0.05)
  const [zoom, setZoom] = useState(1)
  const scrollRef = useRef<HTMLDivElement>(null)
  const visualBlocks: VisualTimelineBlock[] = useMemo(
    () =>
      [...buildVisualTimeline(images, durationSec), ...buildBrollTimeline(broll, durationSec)].sort(
        (a, b) => a.startSec - b.startSec || (a.kind === 'broll' ? -1 : 1)
      ),
    [images, broll, durationSec]
  )
  const captionBlocks = useMemo(() => buildCaptionGroupTimeline(words, durationSec), [words, durationSec])
  const playheadPct = rangeToPct(clampTimelineSec(playheadSec, durationSec), clampTimelineSec(playheadSec, durationSec) + 0.05, durationSec).leftPct
  const activeKey = selectionKey(selection)

  const seekFromClick = (e: MouseEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left))
    onSeek((x / Math.max(1, rect.width)) * durationSec)
  }
  const ZOOM_MIN = 1
  const ZOOM_MAX = 16
  const setZoomClamped = (next: number): void => setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(next * 100) / 100)))
  const onWheel = (e: WheelEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.metaKey) {
      setZoomClamped(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15))
    } else if (scrollRef.current && zoom > 1 && e.deltaY !== 0) {
      scrollRef.current.scrollLeft += e.deltaY
    }
  }

  const trackLabels = ['Visual', 'Captions', 'Look', 'Audio']

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 14, background: 'var(--bg-card)', padding: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 11 }}>
        <SectionLabel>Timeline</SectionLabel>
        <span style={{ fontSize: 9.5, color: 'var(--text-faint)' }}>click a block to edit it · ⌘/ctrl + wheel to zoom</span>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <IconBtn title="Zoom out" size={24} disabled={zoom <= ZOOM_MIN} onClick={() => setZoomClamped(zoom / 1.5)}>−</IconBtn>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', minWidth: 36, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
          <IconBtn title="Zoom in" size={24} disabled={zoom >= ZOOM_MAX} onClick={() => setZoomClamped(zoom * 1.5)}>+</IconBtn>
          <IconBtn title="Fit whole project" size={24} disabled={zoom === 1} onClick={() => setZoom(1)}>Fit</IconBtn>
        </div>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-muted)' }}>{fmt(playheadSec)} / {fmt(durationSec)}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 250px', gap: 13, alignItems: 'stretch' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '58px minmax(0,1fr)', gap: 9, alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: TRACK_GAP }}>
            {trackLabels.map((l) => (
              <div key={l} style={{ height: TRACK_H, display: 'flex', alignItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.5px' }}>{l}</div>
            ))}
          </div>
          <div ref={scrollRef} onWheel={onWheel} style={{ overflowX: zoom > 1 ? 'auto' : 'hidden', overflowY: 'hidden' }}>
            <div style={{ position: 'relative', width: `${zoom * 100}%`, minWidth: '100%', display: 'flex', flexDirection: 'column', gap: TRACK_GAP }}>
              <TrackBox onSeek={seekFromClick}>
                {visualBlocks.map((block) => {
                  const key = `${block.kind}:${block.id}`
                  return (
                    <Block
                      key={key}
                      block={block}
                      tone={block.kind === 'broll' ? 'broll' : 'visual'}
                      badge={block.badge}
                      active={activeKey === key}
                      onClick={(e) => {
                        e.stopPropagation()
                        onSelect({ kind: block.kind, id: block.id })
                        onSeek(block.startSec)
                      }}
                    />
                  )
                })}
                {visualBlocks.length === 0 && <span style={{ position: 'absolute', left: 10, top: 8, fontSize: 10.5, color: 'var(--text-faint)' }}>No images yet — add some in Media</span>}
              </TrackBox>
              <TrackBox onSeek={seekFromClick}>
                {captionBlocks.map((block) => (
                  <Block
                    key={block.id}
                    block={block}
                    tone="caption"
                    active={activeKey === `caption:${block.id}`}
                    onClick={(e) => { e.stopPropagation(); onSelect({ kind: 'caption', id: block.id }); onSeek(block.startSec) }}
                  />
                ))}
                {captionBlocks.length === 0 && <span style={{ position: 'absolute', left: 10, top: 8, fontSize: 10.5, color: 'var(--text-faint)' }}>No transcript yet — run Transcribe in Captions</span>}
              </TrackBox>
              <TrackBox onSeek={seekFromClick}>
                <Block
                  block={{
                    id: 'look',
                    label: project.lookLut && project.lookLut !== 'off' ? `${project.lookLut} · ${Math.round((project.lookStrength ?? 0) * 100)}%` : 'Look off',
                    startSec: 0,
                    endSec: durationSec,
                    ...rangeToPct(0, durationSec, durationSec)
                  }}
                  tone="look"
                  active={selection.kind === 'look'}
                  onClick={(e) => { e.stopPropagation(); onSelect({ kind: 'look' }) }}
                />
              </TrackBox>
              <TrackBox onSeek={(e) => { seekFromClick(e); onSelect({ kind: 'audio' }) }}>
                <Waveform />
              </TrackBox>
              <span style={{ position: 'absolute', left: `${playheadPct}%`, top: 0, bottom: 0, width: 1.5, background: 'var(--accent)', boxShadow: '0 0 8px var(--accent-glow)', pointerEvents: 'none', zIndex: 5 }} />
            </div>
          </div>
        </div>
        <SelectionDetails project={project} images={images} broll={broll} words={words} selection={selection} />
      </div>
    </div>
  )
}

export type { EditorSelection }
