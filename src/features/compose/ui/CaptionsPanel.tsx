import { memo } from 'react'
import type { Project, TranscriptWord } from '@shared/types'
import { useData } from '../../../store/useData'
import { CAPTION_PRESETS, captionPresetPatch } from '../gallery/captionPresets'
import { Banner, Btn, Chip, FieldLabel, SectionLabel, Seg } from '../../../components/ui/kit'

/* Captions panel — preset, typography, layout, pacing, and the word-level
   transcript with karaoke emphasis. */

const PRESET_SAMPLE: Record<string, { text: string; boxed: boolean; glow?: boolean }> = {
  Hormozi: { text: 'NOT', boxed: false },
  Submagic: { text: 'WORD', boxed: true },
  Pop: { text: 'POP', boxed: false },
  Bold: { text: 'BOLD', boxed: false },
  Word: { text: 'ONE', boxed: false },
  Neon: { text: 'GLOW', boxed: false, glow: true },
  Minimal: { text: 'clean', boxed: false }
}

function PresetCard({ preset, active, onPick }: { preset: string; active: boolean; onPick: () => void }): JSX.Element {
  const sample = PRESET_SAMPLE[preset] ?? { text: preset.slice(0, 4).toUpperCase(), boxed: false }
  return (
    <button
      type="button"
      onClick={onPick}
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
      <div style={{ height: 40, borderRadius: 7, background: 'linear-gradient(135deg,#1d2330,#101216)', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
        <span
          style={{
            borderRadius: sample.boxed ? 5 : 0,
            padding: sample.boxed ? '1px 7px' : 0,
            background: sample.boxed ? '#ffd93d' : 'transparent',
            color: sample.boxed ? '#111111' : '#ffffff',
            fontFamily: 'var(--font-poster)',
            fontSize: 14,
            letterSpacing: '.5px',
            textTransform: sample.text === 'clean' ? 'none' : 'uppercase',
            textShadow: sample.glow ? '0 0 10px #19c3d6, 0 0 18px #19c3d6' : sample.boxed ? 'none' : '0 2px 0 #000'
          }}
        >
          {sample.text}
        </span>
      </div>
      <div style={{ marginTop: 5, fontSize: 10.5, fontWeight: 700, color: active ? 'var(--accent)' : 'var(--text-muted)' }}>{preset}</div>
    </button>
  )
}

const FONTS = ['Montserrat', 'Anton', 'Space Grotesk', 'Hanken Grotesk', 'JetBrains Mono', 'Arial', 'Impact', 'Oswald', 'Bebas Neue', 'Roboto']

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
        <Btn size="sm" disabled={transcribing || transcript.length === 0} onClick={autoDetect} title="Mark meaningful words for karaoke emphasis">
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
  const preset = project?.captionPreset ?? 'Hormozi'
  const isSubmagic = preset === 'Submagic'
  const captionHighlightColor = project?.captionHighlightColor ?? (isSubmagic ? '#111111' : '#ffd93d')
  const captionBoxColor = project?.captionBoxColor ?? '#ffd93d'
  const pace = project?.captionPace ?? 'auto'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <FieldLabel>Preset</FieldLabel>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 7 }}>
          {CAPTION_PRESETS.map((p) => (
            <PresetCard key={p} preset={p} active={preset === p} onPick={() => void setCaptions(captionPresetPatch(project, p))} />
          ))}
        </div>
      </div>

      <div>
        <FieldLabel>Font</FieldLabel>
        <select className="ed-input" value={project?.captionFont ?? 'Montserrat'} onChange={(e) => void setCaptions({ captionFont: e.target.value })}>
          {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
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

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <FieldLabel>Position</FieldLabel>
          <Seg
            grow
            value={project?.captionPosition ?? 'bottom'}
            onChange={(p) => void setCaptions({ captionPosition: p })}
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
      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: -8, lineHeight: 1.4 }}>{PACES.find((p) => p.value === pace)?.help}</div>

      {isSubmagic && (
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
              <input type="color" className="ed-color" value={captionBoxColor} onChange={(e) => void setCaptions({ captionBoxColor: e.target.value })} />
            </label>
            <label style={{ fontSize: 10.5, color: 'var(--text-dim)', display: 'flex', flexDirection: 'column', gap: 5 }}>
              Text colour
              <input type="color" className="ed-color" value={captionHighlightColor} onChange={(e) => void setCaptions({ captionHighlightColor: e.target.value })} />
            </label>
          </div>
        </div>
      )}

      {!isSubmagic && (
        <div>
          <FieldLabel>Active-word highlight colour</FieldLabel>
          <input type="color" className="ed-color" style={{ width: 72 }} value={captionHighlightColor} onChange={(e) => void setCaptions({ captionHighlightColor: e.target.value })} />
        </div>
      )}

      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
        <Chip on={!!project?.keywords} onClick={() => void setCaptions({ keywords: !project?.keywords })} title="Auto-highlight detected keywords in captions">
          Keywords {project?.keywords ? 'ON' : 'OFF'}
        </Chip>
      </div>

      <TranscriptEditor />
    </div>
  )
}
