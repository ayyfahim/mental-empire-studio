import { memo } from 'react'
import type { Project, TranscriptWord } from '@shared/types'
import { CAPTION_FONTS, captionAnchorPct, captionPresetSpec, keywordColor, resolveCaptionStyle } from '@shared/captionStyle'
import { useData } from '../../../store/useData'
import { CAPTION_PRESETS, captionPresetPatch } from '../gallery/captionPresets'
import { Banner, Btn, Chip, ColorField, FieldLabel, SectionLabel, Seg, SliderRow } from '../../../components/ui/kit'

/* Captions panel — preset, typography, layout, pacing, and the word-level
   transcript with karaoke emphasis. Preset cards render with the preset's REAL
   font + colours (the same shared spec both render engines burn with). */

function PresetCard({ presetId, active, onPick }: { presetId: string; active: boolean; onPick: () => void }): JSX.Element {
  const spec = captionPresetSpec(presetId)
  const boxKind = spec.active.kind === 'box'
  const sampleActive = spec.uppercase ? 'WORD' : 'word'
  const sampleKw = spec.keywordColors.length ? (spec.uppercase ? 'KEY' : 'key') : null
  const strokePx = Math.max(0, Math.round(spec.outlinePct * 14))
  const stroke = strokePx > 0 ? `${Math.min(2.5, strokePx)}px ${spec.outlineColor}` : undefined
  const glow = spec.active.kind === 'glow' ? `0 0 8px ${spec.active.glowColor}, 0 0 14px ${spec.active.glowColor}` : undefined
  return (
    <button
      type="button"
      onClick={onPick}
      title={spec.blurb}
      className="me-btn ed-focus"
      style={{
        border: active ? '1px solid var(--accent)' : '1px solid var(--border-2)',
        background: active ? 'var(--accent-soft)' : 'var(--bg-inset)',
        borderRadius: 10,
        padding: 5,
        cursor: 'pointer',
        textAlign: 'center'
      }}
    >
      <div style={{ height: 44, borderRadius: 7, background: 'linear-gradient(135deg,#1d2330,#101216)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, overflow: 'hidden', padding: '0 4px' }}>
        <span
          style={{
            fontFamily: `"${spec.fontFamily}", Anton, Impact, sans-serif`,
            fontWeight: spec.fontWeight,
            fontSize: 15,
            lineHeight: 1,
            letterSpacing: '.4px',
            borderRadius: boxKind ? 5 : 0,
            padding: boxKind ? '3px 7px 2px' : 0,
            background: boxKind ? spec.active.boxColor : 'transparent',
            color: boxKind ? spec.active.color : spec.active.kind === 'karaoke' || spec.active.kind === 'color' ? spec.active.color : spec.active.color,
            WebkitTextStroke: boxKind ? undefined : stroke,
            textShadow: glow ?? (spec.shadowPct > 0 ? '0 2px 2px rgba(0,0,0,.7)' : undefined),
            whiteSpace: 'nowrap'
          }}
        >
          {sampleActive}
        </span>
        {sampleKw && (
          <span
            style={{
              fontFamily: `"${spec.fontFamily}", Anton, Impact, sans-serif`,
              fontWeight: spec.fontWeight,
              fontSize: 15,
              lineHeight: 1,
              color: spec.keywordColors[0],
              WebkitTextStroke: stroke,
              textShadow: spec.shadowPct > 0 ? '0 2px 2px rgba(0,0,0,.7)' : undefined,
              whiteSpace: 'nowrap'
            }}
          >
            {sampleKw}
          </span>
        )}
      </div>
      <div style={{ marginTop: 5, fontSize: 10.5, fontWeight: 700, color: active ? 'var(--accent)' : 'var(--text-muted)' }}>{spec.label}</div>
    </button>
  )
}

const PACES: Array<{ value: NonNullable<Project['captionPace']>; label: string; help: string }> = [
  { value: 'auto', label: 'Auto', help: 'Studio picks the best timing for this video length.' },
  { value: 'word', label: 'Word', help: 'Each spoken word highlights as it is said.' },
  { value: 'phrase', label: 'Pages', help: 'Captions change in calmer chunks for long videos.' }
]

const TranscriptWordSpan = memo(function TranscriptWordSpan({ word, onToggle }: { word: TranscriptWord; onToggle: (id: string) => void }): JSX.Element {
  return (
    <span
      onClick={() => onToggle(word.id)}
      style={{
        cursor: 'pointer',
        background: word.emphasis ? 'rgba(54,201,142,.9)' : undefined,
        color: word.emphasis ? '#06140e' : undefined,
        borderRadius: 4,
        padding: word.emphasis ? '0 4px' : undefined,
        fontWeight: word.emphasis ? 700 : undefined
      }}
    >
      {word.word}{' '}
    </span>
  )
})

function TranscriptEditor(): JSX.Element {
  const transcript = useData((s) => s.transcript)
  const transcribing = useData((s) => s.transcribing)
  const transcribeMessage = useData((s) => s.transcribeMessage)
  const transcribeError = useData((s) => s.transcribeError)
  const runTranscribe = useData((s) => s.runTranscribe)
  const toggleWordEmphasis = useData((s) => s.toggleWordEmphasis)
  const setWordsEmphasis = useData((s) => s.setWordsEmphasis)

  const autoDetect = (): void => {
    const stopWords = new Set(['that', 'this', 'with', 'from', 'they', 'have', 'were', 'been', 'will', 'your', 'when', 'then', 'than', 'what', 'also', 'just', 'like', 'more', 'some', 'into', 'their', 'there', 'about', 'which', 'would', 'could', 'should', 'these', 'those', 'being', 'after', 'over'])
    const candidates = transcript.filter((w) => w.word.length >= 4 && !stopWords.has(w.word.toLowerCase().replace(/[^a-z]/g, '')))
    // ~1 emphasized word per 10 transcript words, sampled evenly start→end.
    const target = Math.max(1, Math.round(transcript.length / 10))
    const stride = Math.max(1, Math.round(candidates.length / target))
    const toMark = candidates.filter((_, i) => i % stride === 0)
    void setWordsEmphasis(toMark.filter((w) => !w.emphasis).map((w) => w.id), true)
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
        <SectionLabel style={{ flex: 1 }}>Transcript · tap words to emphasize</SectionLabel>
        {transcribing && <span className="ed-pulse" style={{ fontSize: 10, color: 'var(--warn)', fontFamily: 'var(--font-mono)' }}>{transcribeMessage || 'working…'}</span>}
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <Btn size="sm" disabled={transcribing || transcript.length === 0} onClick={autoDetect} title="Mark meaningful words for colour emphasis (zoom pulses stay rate-limited)">
          ✦ Auto-detect emphasis
        </Btn>
        <Btn size="sm" disabled={transcribing} onClick={() => void runTranscribe()}>
          {transcribing ? 'Transcribing…' : transcript.length ? '↻ Re-transcribe' : '↻ Transcribe'}
        </Btn>
      </div>
      {transcribeError && <Banner kind="error" style={{ marginBottom: 8 }}>{transcribeError}</Banner>}
      <div className="ed-scroll" style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, background: 'var(--bg-inset)', fontSize: 13, lineHeight: 2, color: '#cdd2da', maxHeight: 190, userSelect: 'none' }}>
        {transcript.length === 0 ? (
          <span style={{ color: 'var(--text-fainter)', fontSize: 11.5 }}>No transcript yet — run Transcribe to generate word-level timings.</span>
        ) : (
          transcript.map((w) => <TranscriptWordSpan key={w.id} word={w} onToggle={toggleWordEmphasis} />)
        )}
      </div>
    </div>
  )
}

export function CaptionsPanel(): JSX.Element {
  const project = useData((s) => s.activeProject)
  const setCaptions = useData((s) => s.setCaptions)
  const style = resolveCaptionStyle(project ?? {})
  const preset = project?.captionPreset ?? 'Hormozi'
  const boxKind = style.activeKind === 'box'
  const pace = project?.captionPace ?? 'auto'
  const position = project?.captionPosition ?? 'bottom'
  const anchor = Math.round(captionAnchorPct(position, project?.captionOffsetY, project?.captionAspect))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <FieldLabel>Preset</FieldLabel>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 7 }}>
          {CAPTION_PRESETS.map((p) => (
            <PresetCard key={p} presetId={p} active={captionPresetSpec(preset).id === p} onPick={() => void setCaptions(captionPresetPatch(project, p))} />
          ))}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 6, lineHeight: 1.4 }}>{captionPresetSpec(preset).blurb}</div>
      </div>

      <div>
        <FieldLabel>Font</FieldLabel>
        <select className="ed-input" value={style.fontFamily} onChange={(e) => void setCaptions({ captionFont: e.target.value })}>
          {CAPTION_FONTS.map((f) => <option key={f.family} value={f.family} style={{ fontFamily: `"${f.family}"` }}>{f.family}</option>)}
        </select>
      </div>

      <div>
        <FieldLabel>Animation</FieldLabel>
        <Seg
          grow
          value={project?.captionAnim ?? 'Pop-in'}
          onChange={(a) => void setCaptions({ captionAnim: a })}
          options={(['Pop-in', 'Bounce', 'Slide', 'Type'] as const).map((a) => ({ value: a, label: a }))}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <FieldLabel>Aspect</FieldLabel>
          <Seg
            grow
            value={project?.captionAspect ?? '16:9'}
            onChange={(a) => void setCaptions({ captionAspect: a })}
            options={(['16:9', '1:1', '9:16'] as const).map((a) => ({ value: a, label: a }))}
          />
        </div>
        <div>
          <FieldLabel>Lines</FieldLabel>
          <Seg
            grow
            value={project?.captionLines ?? 1}
            onChange={(n) => void setCaptions({ captionLines: n })}
            options={([1, 2, 3] as const).map((n) => ({ value: n, label: String(n) }))}
          />
        </div>
      </div>

      <div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <FieldLabel>Position</FieldLabel>
            <Seg
              grow
              value={position}
              onChange={(p) => void setCaptions({ captionPosition: p, captionOffsetY: null as unknown as undefined })}
              options={(['top', 'middle', 'bottom'] as const).map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) }))}
            />
          </div>
          <div>
            <FieldLabel>Timing</FieldLabel>
            <Seg
              grow
              value={pace}
              onChange={(p) => void setCaptions({ captionPace: p })}
              options={PACES.map((p) => ({ value: p.value, label: p.label, title: p.help }))}
            />
          </div>
        </div>
        <div style={{ marginTop: 8 }}>
          <SliderRow
            label="Fine-tune height"
            value={anchor}
            min={4}
            max={96}
            format={(v) => `${v}% from top`}
            onChange={(v) => void setCaptions({ captionOffsetY: v })}
            debounceMs={150}
          />
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4, lineHeight: 1.4 }}>
          Drag to place captions exactly — e.g. lower than “Bottom” for 9:16 Shorts. {PACES.find((p) => p.value === pace)?.help}
        </div>
      </div>

      {boxKind && (
        <div className="ed-fade" style={{ border: '1px solid var(--accent)', borderRadius: 11, padding: 11, background: 'var(--accent-soft)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <FieldLabel>Words per page</FieldLabel>
            <Seg
              grow
              value={project?.captionWordsPerPage ?? 1}
              onChange={(n) => void setCaptions({ captionWordsPerPage: n })}
              options={([1, 2, 3] as const).map((n) => ({ value: n, label: String(n) }))}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label style={{ fontSize: 10.5, color: 'var(--text-dim)', display: 'flex', flexDirection: 'column', gap: 5 }}>
              Box colour
              <ColorField className="ed-color" value={style.boxColor ?? '#ffd93d'} onChange={(v) => void setCaptions({ captionBoxColor: v })} debounceMs={150} />
            </label>
            <label style={{ fontSize: 10.5, color: 'var(--text-dim)', display: 'flex', flexDirection: 'column', gap: 5 }}>
              Text colour
              <ColorField className="ed-color" value={style.activeColor} onChange={(v) => void setCaptions({ captionHighlightColor: v })} debounceMs={150} />
            </label>
          </div>
        </div>
      )}

      {!boxKind && (
        <div>
          <FieldLabel>Active-word colour</FieldLabel>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <ColorField className="ed-color" style={{ width: 72 }} value={style.activeColor} onChange={(v) => void setCaptions({ captionHighlightColor: v })} debounceMs={150} />
            {style.keywordColors.length > 0 && (
              <span style={{ fontSize: 10, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 5 }}>
                Emphasized words rotate
                {style.keywordColors.map((_, i) => (
                  <span key={i} style={{ width: 12, height: 12, borderRadius: 3, background: keywordColor(style, i), display: 'inline-block' }} />
                ))}
              </span>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
        <Chip on={!!project?.keywords} onClick={() => void setCaptions({ keywords: !project?.keywords })} title="Auto-colour important words using the preset's keyword palette (distinct from the active-word highlight)">
          Auto-colour keywords {project?.keywords ? 'ON' : 'OFF'}
        </Chip>
      </div>

      <TranscriptEditor />
    </div>
  )
}
