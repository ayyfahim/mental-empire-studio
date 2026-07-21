import type { MotionDirection, MotionPreset, Project, ProjectImage, TranscriptWord } from '@shared/types'
import type { GpuBrollSegment } from '@shared/renderSpec'
import { LOOKS } from '@shared/looks'
import { useData } from '../../../store/useData'
import { QUICK_CAPTION_PRESETS, captionPresetPatch } from '../gallery/captionPresets'
import type { EditorSelection } from '../timeline/timelineModel'
import { Chip, ColorField, SectionLabel, SliderRow } from '../../../components/ui/kit'
import { fmt } from './util'

/* Timeline selection details — a compact context editor for whatever block is
   selected: image window + per-image motion, caption word emphasis, look strength,
   or project-level quick settings. */

function clampValue(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

const MOTION_DIRECTIONS: Array<{ id: MotionDirection | null; label: string; title: string }> = [
  { id: null, label: 'Auto', title: 'Seeded direction for this image' },
  { id: 'push', label: 'In', title: 'Zoom in' },
  { id: 'pull', label: 'Out', title: 'Zoom out' },
  { id: 'left', label: '←', title: 'Pan left' },
  { id: 'right', label: '→', title: 'Pan right' },
  { id: 'up', label: '↑', title: 'Pan up' },
  { id: 'down', label: '↓', title: 'Pan down' }
]

function NumField({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }): JSX.Element {
  return (
    <label style={{ display: 'grid', gridTemplateColumns: '46px minmax(0,1fr)', alignItems: 'center', gap: 8, fontSize: 10.5, color: 'var(--text-dim)' }}>
      <span>{label}</span>
      <input
        type="number"
        className="ed-input"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? Number(value.toFixed(2)) : 0}
        onChange={(e) => {
          const next = Number(e.target.value)
          if (Number.isFinite(next)) onChange(next)
        }}
        style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, padding: '5px 8px' }}
      />
    </label>
  )
}

export function SelectionDetails({
  project,
  images,
  broll,
  words,
  selection
}: {
  project: Project
  images: ProjectImage[]
  broll: GpuBrollSegment[]
  words: TranscriptWord[]
  selection: EditorSelection
}): JSX.Element {
  const setImageRanges = useData((s) => s.setImageRanges)
  const setCaptions = useData((s) => s.setCaptions)
  const setLook = useData((s) => s.setLook)
  const setImageMotion = useData((s) => s.setImageMotion)
  const setWordsEmphasis = useData((s) => s.setWordsEmphasis)

  const image = selection.kind === 'image' ? images.find((im) => im.id === selection.id) : undefined
  const brollIndex = selection.kind === 'broll' ? Number(selection.id.replace(/^broll-/, '')) : -1
  const brollSegment = brollIndex >= 0 ? broll[brollIndex] : undefined
  const word = selection.kind === 'caption' ? words.find((w) => w.id === selection.id) : undefined
  const durationSec = Math.max(0.05, project.durationSec || 0.05)
  const minSpan = Math.min(0.05, durationSec)
  const projectMotionPreset: MotionPreset = project.motionPreset ?? (project.kenBurns ? 'subtle' : 'off')
  const imageMotionPreset: MotionPreset = image?.motionPreset ?? projectMotionPreset
  const imageMotionDirection = image?.motionDirection ?? null
  const imageMotionAmount = clampValue(image?.motionAmount ?? 50, 0, 100)
  const selectedLook = LOOKS.find((look) => look.id === (project.lookLut ?? 'off')) ?? LOOKS[0]
  const lookStrength = selectedLook.id === 'off' ? 0 : clampValue(project.lookStrength ?? selectedLook.defaultStrength, 0, 1)
  const captionHighlightColor = /^#[0-9a-f]{6}$/i.test(project.captionHighlightColor ?? '') ? project.captionHighlightColor! : project.captionPreset === 'Submagic' ? '#111111' : '#ffd93d'
  const captionBoxColor = /^#[0-9a-f]{6}$/i.test(project.captionBoxColor ?? '') ? project.captionBoxColor! : '#ffd93d'

  const title = image ? 'Image segment' : brollSegment ? 'B-roll segment' : word ? 'Caption word' : selection.kind === 'look' ? 'Look' : selection.kind === 'audio' ? 'Audio' : 'Project'
  const detail = image
    ? `${fmt(image.rangeStart)}-${fmt(image.rangeEnd)} · ${image.path.split(/[\\/]/).pop() || 'image'}`
    : brollSegment
      ? `${fmt(brollSegment.startSec)}-${fmt(brollSegment.endSec)} · ${brollSegment.path.split(/[\\/]/).pop() || 'video'}`
      : word
        ? `${fmt(word.start)}-${fmt(word.end)} · ${word.emphasis ? 'emphasized' : 'normal'}`
        : selection.kind === 'look'
          ? `${selectedLook.name} · ${Math.round(lookStrength * 100)}%`
          : selection.kind === 'audio'
            ? `${fmt(project.durationSec)} narration`
            : `${project.captionAspect} · ${project.captionPreset} captions`

  const setImageRange = (rangeStart: number, rangeEnd: number): void => {
    if (!image) return
    const start = clampValue(rangeStart, 0, Math.max(0, durationSec - minSpan))
    const end = clampValue(rangeEnd, start + minSpan, durationSec)
    void setImageRanges([{ id: image.id, rangeStart: start, rangeEnd: end }])
  }

  return (
    <div className="ed-scroll" style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-inset)', padding: 12, maxHeight: 260 }}>
      <SectionLabel style={{ color: 'var(--accent)', marginBottom: 6 }}>Selection</SectionLabel>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 700, color: 'var(--text-bright)' }}>{title}</div>
      <div title={detail} className="me-ellipsis" style={{ marginTop: 4, fontSize: 10.5, color: '#aab0bb', fontFamily: 'var(--font-mono)' }}>{detail}</div>

      {image && (
        <div style={{ marginTop: 11, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <NumField label="Start" value={image.rangeStart} min={0} max={Math.max(0, image.rangeEnd - minSpan)} step={0.05} onChange={(v) => setImageRange(v, image.rangeEnd)} />
            <NumField label="End" value={image.rangeEnd} min={image.rangeStart + minSpan} max={durationSec} step={0.05} onChange={(v) => setImageRange(image.rangeStart, v)} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 5 }}>Motion</div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              <Chip on={image.motionPreset == null} title={`Inherit project motion: ${projectMotionPreset}`} onClick={() => void setImageMotion([{ id: image.id, motionPreset: null, motionDirection: null, motionAmount: null }])}>Auto</Chip>
              {([{ id: 'off', label: 'Static' }, { id: 'subtle', label: 'Subtle' }, { id: 'cinematic', label: 'Cinema' }] as Array<{ id: MotionPreset; label: string }>).map((p) => (
                <Chip key={p.id} on={image.motionPreset != null && imageMotionPreset === p.id} onClick={() => void setImageMotion([{ id: image.id, motionPreset: p.id }])}>{p.label}</Chip>
              ))}
            </div>
          </div>
          {imageMotionPreset !== 'off' && (
            <>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {MOTION_DIRECTIONS.map((d) => (
                  <Chip key={d.id ?? 'auto'} title={d.title} on={d.id === imageMotionDirection} onClick={() => void setImageMotion([{ id: image.id, motionDirection: d.id }])}>{d.label}</Chip>
                ))}
              </div>
              <SliderRow label="Amount" value={Math.round(imageMotionAmount)} min={0} max={100} labelWidth={50} onChange={(v) => void setImageMotion([{ id: image.id, motionAmount: v }])} debounceMs={150} />
            </>
          )}
        </div>
      )}

      {word && (
        <div style={{ marginTop: 11, display: 'flex', flexDirection: 'column', gap: 9 }}>
          <Chip on={!!word.emphasis} onClick={() => void setWordsEmphasis([word.id], !word.emphasis)}>
            {word.emphasis ? '★ Emphasis on' : 'Emphasis off'}
          </Chip>
          <label style={{ fontSize: 10.5, color: 'var(--text-dim)', display: 'flex', flexDirection: 'column', gap: 5 }}>
            {project.captionPreset === 'Submagic' ? 'Text colour' : 'Highlight colour'}
            <ColorField className="ed-color" value={captionHighlightColor} onChange={(v) => void setCaptions({ captionHighlightColor: v })} debounceMs={150} />
          </label>
          {project.captionPreset === 'Submagic' && (
            <label style={{ fontSize: 10.5, color: 'var(--text-dim)', display: 'flex', flexDirection: 'column', gap: 5 }}>
              Box colour
              <ColorField className="ed-color" value={captionBoxColor} onChange={(v) => void setCaptions({ captionBoxColor: v })} debounceMs={150} />
            </label>
          )}
        </div>
      )}

      {brollSegment && (
        <div style={{ marginTop: 11, border: '1px solid #20334a', borderRadius: 9, padding: 9, background: 'rgba(64,169,255,.08)', fontSize: 10.5, color: '#8fcaff', lineHeight: 1.45 }}>
          The live preview shows a cached poster frame for this clip. B-roll pool and density live in the Style tab.
        </div>
      )}

      {selection.kind === 'look' && (
        <div style={{ marginTop: 11, display: 'flex', flexDirection: 'column', gap: 9 }}>
          <SliderRow
            label="Power"
            value={Math.round(lookStrength * 100)}
            min={0}
            max={100}
            labelWidth={50}
            format={(v) => `${v}%`}
            onChange={(v) => void setLook({ lut: selectedLook.id === 'off' ? 'clean' : selectedLook.id, strength: clampValue(v, 0, 100) / 100 })}
            debounceMs={150}
          />
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {LOOKS.slice(0, 5).map((look) => (
              <Chip key={look.id} title={look.description} on={selectedLook.id === look.id} onClick={() => void setLook({ lut: look.id, strength: look.id === 'off' ? 0 : look.defaultStrength })}>
                {look.name}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {selection.kind === 'audio' && (
        <div style={{ marginTop: 9, fontSize: 10.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
          The narration length anchors this project. Trim image windows and caption timing around it from the tracks.
        </div>
      )}

      {selection.kind === 'project' && (
        <div style={{ marginTop: 11, display: 'flex', flexDirection: 'column', gap: 9 }}>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {(['16:9', '1:1', '9:16'] as Project['captionAspect'][]).map((aspect) => (
              <Chip key={aspect} on={project.captionAspect === aspect} onClick={() => void setCaptions({ captionAspect: aspect })}>{aspect}</Chip>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {QUICK_CAPTION_PRESETS.map((preset) => (
              <Chip key={preset} on={project.captionPreset === preset} onClick={() => void setCaptions(captionPresetPatch(project, preset))}>{preset}</Chip>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
