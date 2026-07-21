import { useMemo, useRef, useState } from 'react'
import { useStore } from '../../store/useStore'
import type { BackgroundLayer, FxGlow, FxOutline, FxShadow, ShapeLayer, SubjectLayer, TextHighlight, TextLayer } from '@shared/types'
import { asGlow, asOutline, asShadow, DEFAULT_SCRIM, DEFAULT_TEXT_HIGHLIGHT } from '@shared/types'
import { Btn, Chip, FieldLabel, SectionLabel, Section, Seg, SliderRow, Swatches, Switch } from '../../components/ui/kit'

/* Context inspector — shows exactly the controls for what's selected:
   nothing/background → canvas + scrim, subject → image + effects,
   shape → fill, text → content / typography / highlights / effects. */

const FX_SWATCHES = ['#ffffff', '#000000', '#f2c200', '#e8403a', '#19c3d6', '#8b7cff', '#36c98e']
const TEXT_SWATCHES = ['#ffffff', '#111111', '#f2c200', '#e8403a', '#19c3d6', '#8b7cff', '#36c98e']

function clampNum(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min))
}

function normWord(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function layerHighlightWords(layer: TextLayer): string[] {
  return layer.highlightWords?.length ? layer.highlightWords : layer.highlightWord ? [layer.highlightWord] : []
}

function wordsFromLayer(layer: TextLayer): string[] {
  const seen = new Set<string>()
  return (layer.lines ?? [])
    .flatMap((ln) => ln.text.split(/\s+/))
    .map((w) => w.trim())
    .filter((w) => {
      const key = normWord(w)
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

/** One effect (shadow / glow / outline) as a toggle card with its sliders. */
function FxCard({
  label,
  kind,
  value,
  onChange
}: {
  label: string
  kind: 'shadow' | 'glow' | 'outline'
  value: FxShadow | FxGlow | FxOutline
  onChange: (p: Partial<FxShadow & FxGlow & FxOutline>) => void
}): JSX.Element {
  const v = value as FxShadow & Partial<FxShadow>
  return (
    <div style={{ border: v.enabled ? '1px solid var(--accent)' : '1px solid var(--border)', borderRadius: 10, padding: '9px 10px', background: v.enabled ? 'var(--accent-soft)' : 'var(--bg-inset)', marginBottom: 7 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11.5, color: v.enabled ? 'var(--text-bright)' : 'var(--text-muted)', flex: 1, fontWeight: v.enabled ? 700 : 500 }}>{label}</span>
        <Switch on={v.enabled} onToggle={() => onChange({ enabled: !v.enabled })} />
      </div>
      {v.enabled && (
        <div className="ed-fade" style={{ marginTop: 9, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SliderRow label="Size" labelWidth={52} value={v.size} min={0} max={kind === 'outline' ? 40 : 80} onChange={(n) => onChange({ size: n })} />
          <SliderRow label="Opacity" labelWidth={52} value={Math.round(v.opacity * 100)} min={0} max={100} format={(n) => `${n}%`} onChange={(n) => onChange({ opacity: n / 100 })} />
          {kind === 'shadow' && <SliderRow label="Distance" labelWidth={52} value={v.distance} min={0} max={60} onChange={(n) => onChange({ distance: n })} />}
          {kind === 'shadow' && <SliderRow label="Angle" labelWidth={52} value={v.angle} min={0} max={360} format={(n) => `${n}°`} onChange={(n) => onChange({ angle: n })} />}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 52, flex: 'none' }}>Colour</span>
            <Swatches colors={FX_SWATCHES} value={v.color} onPick={(color) => onChange({ color })} size={18} allowCustom />
          </div>
        </div>
      )}
    </div>
  )
}

function CanvasInspector(): JSX.Element {
  const layers = useStore((s) => s.layers)
  const setBackground = useStore((s) => s.setBackground)
  const bgFile = useRef<HTMLInputElement>(null)
  const background = layers.find((l) => l.kind === 'background') as BackgroundLayer | undefined
  const scrim = background?.scrim ?? DEFAULT_SCRIM

  return (
    <div style={{ padding: 14 }}>
      <SectionLabel style={{ marginBottom: 10 }}>Canvas</SectionLabel>
      <div style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.55, marginBottom: 14 }}>
        Click a layer on the canvas or in the Layers panel to edit it. Double-click text to type directly on the canvas.
      </div>
      <FieldLabel>Background</FieldLabel>
      <div style={{ display: 'flex', gap: 7, marginBottom: 9, flexWrap: 'wrap' }}>
        {['linear-gradient(135deg,#2a2540,#46243a)', 'linear-gradient(135deg,#1a2e3a,#0f3a32)', '#1a1a1a', '#0f3a32', '#23304a', '#3a1d25'].map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            onClick={() => setBackground({ mode: c.startsWith('linear') ? 'gradient' : 'solid', fill: c })}
            className="ed-focus"
            style={{ width: 26, height: 26, borderRadius: 7, background: c, border: background?.fill === c ? '2px solid var(--accent)' : '1px solid var(--border-3)', cursor: 'pointer', padding: 0 }}
          />
        ))}
      </div>
      <input
        ref={bgFile}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const f = e.target.files?.[0]
          if (f) setBackground({ mode: 'image', src: await readAsDataUrl(f) } as Partial<BackgroundLayer>)
          e.target.value = ''
        }}
      />
      <Btn size="sm" style={{ width: '100%' }} onClick={() => bgFile.current?.click()}>⇪ Use image background</Btn>

      <Section label="Legibility scrim">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: scrim.enabled ? 10 : 0 }}>
          <span style={{ fontSize: 11.5, color: scrim.enabled ? 'var(--text-bright)' : 'var(--text-muted)', flex: 1 }}>Darkening gradient</span>
          <Switch on={scrim.enabled} onToggle={() => setBackground({ scrim: { ...scrim, enabled: !scrim.enabled } } as Partial<BackgroundLayer>)} />
        </div>
        {scrim.enabled && (
          <div className="ed-fade" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Seg
              grow
              value={scrim.direction}
              onChange={(d) => setBackground({ scrim: { ...scrim, direction: d } } as Partial<BackgroundLayer>)}
              options={(['bottom', 'top', 'left', 'right'] as const).map((d) => ({ value: d, label: d[0].toUpperCase() + d.slice(1) }))}
            />
            <SliderRow label="Size" labelWidth={52} value={Math.round(scrim.size * 100)} min={5} max={100} format={(n) => `${n}%`} onChange={(n) => setBackground({ scrim: { ...scrim, size: n / 100 } } as Partial<BackgroundLayer>)} />
            <SliderRow label="Opacity" labelWidth={52} value={Math.round(scrim.opacity * 100)} min={0} max={100} format={(n) => `${n}%`} onChange={(n) => setBackground({ scrim: { ...scrim, opacity: n / 100 } } as Partial<BackgroundLayer>)} />
          </div>
        )}
      </Section>
    </div>
  )
}

function SubjectInspector({ layer }: { layer: SubjectLayer }): JSX.Element {
  const updateLayer = useStore((s) => s.updateLayer)
  const deleteLayer = useStore((s) => s.deleteLayer)
  const setSubjectImage = useStore((s) => s.setSubjectImage)
  const subjectFile = useRef<HTMLInputElement>(null)

  return (
    <div style={{ padding: 14 }}>
      <SectionLabel style={{ color: 'var(--accent)', marginBottom: 10 }}>Subject</SectionLabel>
      <input
        ref={subjectFile}
        type="file"
        accept="image/png,image/*"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const f = e.target.files?.[0]
          if (f) setSubjectImage(await readAsDataUrl(f))
          e.target.value = ''
        }}
      />
      <Btn variant="soft" style={{ width: '100%' }} onClick={() => subjectFile.current?.click()}>⇪ Replace subject (PNG)</Btn>
      <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 7, lineHeight: 1.4 }}>Use a cut-out PNG with transparency — effects hug the subject's shape.</div>

      <Section label="Effects">
        <FxCard label="Border (outline)" kind="outline" value={asOutline(layer.outline)} onChange={(p) => updateLayer(layer.id, { outline: { ...asOutline(layer.outline), ...p } } as Partial<SubjectLayer>)} />
        <FxCard label="Drop shadow" kind="shadow" value={asShadow(layer.shadow)} onChange={(p) => updateLayer(layer.id, { shadow: { ...asShadow(layer.shadow), ...p } } as Partial<SubjectLayer>)} />
        <FxCard label="Glow" kind="glow" value={asGlow(layer.glow, '#19c3d6')} onChange={(p) => updateLayer(layer.id, { glow: { ...asGlow(layer.glow, '#19c3d6'), ...p } } as Partial<SubjectLayer>)} />
      </Section>

      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12 }}>
        <Btn variant="danger" size="sm" style={{ width: '100%' }} disabled={layer.locked} onClick={() => deleteLayer(layer.id)}>Delete layer</Btn>
      </div>
    </div>
  )
}

function ShapeInspector({ layer }: { layer: ShapeLayer }): JSX.Element {
  const updateLayer = useStore((s) => s.updateLayer)
  const deleteLayer = useStore((s) => s.deleteLayer)
  return (
    <div style={{ padding: 14 }}>
      <SectionLabel style={{ color: 'var(--accent)', marginBottom: 10 }}>{layer.name}</SectionLabel>
      <FieldLabel>Fill colour</FieldLabel>
      <Swatches colors={['#e8403a', '#f2c200', '#19c3d6', '#8b7cff', '#36c98e', '#ffffff', '#000000']} value={layer.color} onPick={(color) => updateLayer(layer.id, { color })} size={24} allowCustom />
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 14 }}>
        <Btn variant="danger" size="sm" style={{ width: '100%' }} onClick={() => deleteLayer(layer.id)}>Delete layer</Btn>
      </div>
    </div>
  )
}

function TextInspector({ layer }: { layer: TextLayer }): JSX.Element {
  const updateLayer = useStore((s) => s.updateLayer)
  const deleteLayer = useStore((s) => s.deleteLayer)
  const [customHighlight, setCustomHighlight] = useState('')

  const highlightWords = useMemo(() => layerHighlightWords(layer), [layer])
  const highlightKeys = useMemo(() => new Set(highlightWords.map(normWord).filter(Boolean)), [highlightWords])
  const textWords = useMemo(() => wordsFromLayer(layer), [layer])
  const highlight: TextHighlight = layer.highlight ?? { ...DEFAULT_TEXT_HIGHLIGHT, enabled: layer.highlightSquare, boxColor: layer.highlightColor }
  const maxLineSize = Math.max(1, ...layer.lines.map((ln) => ln.size))
  const lineGap = Math.round(layer.lineGap ?? Math.max(0, maxLineSize * ((layer.lineHeight && layer.lineHeight > 0 ? layer.lineHeight : 1.12) - 1)))

  const setHighlights = (words: string[]): void => {
    const clean = words.map((w) => w.trim()).filter(Boolean)
    updateLayer(layer.id, { highlightWords: clean, highlightWord: clean[0] ?? '' } as Partial<TextLayer>)
  }
  const toggleHighlight = (word: string): void => {
    const key = normWord(word)
    if (!key) return
    setHighlights(highlightKeys.has(key) ? highlightWords.filter((w) => normWord(w) !== key) : [...highlightWords, word])
  }
  const setHighlight = (patch: Partial<TextHighlight>): void => {
    const next = { ...highlight, ...patch }
    updateLayer(layer.id, { highlight: next, highlightSquare: next.enabled, highlightColor: next.boxColor } as Partial<TextLayer>)
  }
  const setBlockSize = (size: number): void => {
    const target = clampNum(size, 8, 260)
    const current = Math.max(1, ...layer.lines.map((ln) => ln.size))
    const scale = target / current
    const lines = layer.lines.map((ln) => ({ ...ln, size: clampNum(Math.round(ln.size * scale), 8, 260) }))
    updateLayer(layer.id, { lines } as Partial<TextLayer>)
  }
  const setLineSize = (index: number, size: number): void => {
    const lines = layer.lines.map((ln, i) => (i === index ? { ...ln, size: clampNum(size, 8, 260) } : ln))
    updateLayer(layer.id, { lines } as Partial<TextLayer>)
  }

  return (
    <div style={{ padding: 14 }}>
      <SectionLabel style={{ color: 'var(--accent)', marginBottom: 10 }}>{layer.name}</SectionLabel>

      <FieldLabel>Text — one line per row</FieldLabel>
      <textarea
        className="ed-input"
        value={layer.lines.map((l) => l.text).join('\n')}
        onChange={(e) => {
          const rows = e.target.value.split('\n')
          updateLayer(layer.id, { text: rows.join(' '), lines: rows.map((t, i) => ({ text: t, size: layer.lines[i]?.size ?? 72 })) })
        }}
        rows={Math.max(2, layer.lines.length)}
        style={{ fontWeight: 700, textTransform: layer.effects.caps ? 'uppercase' : 'none' }}
      />

      <Section label="Typography" headerRight={
        <Chip on={layer.effects.caps} onClick={() => updateLayer(layer.id, { effects: { ...layer.effects, caps: !layer.effects.caps } })} style={{ padding: '3px 8px', fontSize: 9.5 }}>CAPS</Chip>
      }>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SliderRow label="Size" value={maxLineSize} min={24} max={200} onChange={setBlockSize} />
          <SliderRow label="Line gap" value={lineGap} min={0} max={80} format={(n) => `${n}px`} onChange={(n) => updateLayer(layer.id, { lineGap: n, lineHeight: undefined } as Partial<TextLayer>)} />
          <div>
            <FieldLabel style={{ marginTop: 4 }}>Align lines</FieldLabel>
            <Seg
              grow
              value={layer.align ?? 'left'}
              onChange={(align) => updateLayer(layer.id, { align } as Partial<TextLayer>)}
              options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }]}
            />
          </div>
          <div>
            <FieldLabel style={{ marginTop: 4 }}>Colour</FieldLabel>
            <Swatches colors={TEXT_SWATCHES} value={layer.color} onPick={(color) => updateLayer(layer.id, { color })} size={20} allowCustom />
          </div>
        </div>
        {layer.lines.length > 1 && (
          <Section label="Per-line sizes" defaultOpen={false}>
            {layer.lines.map((ln, i) => (
              <div key={i} style={{ marginBottom: 8 }}>
                <SliderRow label={ln.text.slice(0, 8) || `Line ${i + 1}`} value={ln.size} min={24} max={200} onChange={(n) => setLineSize(i, n)} />
              </div>
            ))}
          </Section>
        )}
      </Section>

      <Section label="Highlighted words">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8 }}>
          {textWords.length === 0 && <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>Type words above to pick highlights.</span>}
          {textWords.map((word) => (
            <Chip key={word} on={highlightKeys.has(normWord(word))} onClick={() => toggleHighlight(word)} style={{ padding: '4px 9px', fontSize: 10.5 }}>{word}</Chip>
          ))}
        </div>
        <input
          className="ed-input"
          value={customHighlight}
          onChange={(e) => setCustomHighlight(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              const w = customHighlight.trim()
              if (w && !highlightKeys.has(normWord(w))) {
                setHighlights([...highlightWords, w])
                setCustomHighlight('')
              }
            }
          }}
          placeholder="Custom word + Enter"
          style={{ marginBottom: 9 }}
        />
        <div style={{ border: highlight.enabled ? '1px solid var(--accent)' : '1px solid var(--border)', borderRadius: 10, padding: '9px 10px', background: highlight.enabled ? 'var(--accent-soft)' : 'var(--bg-inset)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: highlight.enabled ? 9 : 0 }}>
            <span style={{ fontSize: 11.5, color: highlight.enabled ? 'var(--text-bright)' : 'var(--text-muted)', flex: 1, fontWeight: highlight.enabled ? 700 : 500 }}>Highlight box</span>
            <Switch on={highlight.enabled} onToggle={() => setHighlight({ enabled: !highlight.enabled })} />
          </div>
          {highlight.enabled ? (
            <div className="ed-fade" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 52, flex: 'none' }}>Box</span>
                <Swatches colors={TEXT_SWATCHES} value={highlight.boxColor} onPick={(boxColor) => setHighlight({ boxColor })} size={18} allowCustom />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 52, flex: 'none' }}>Text</span>
                <Swatches colors={TEXT_SWATCHES} value={highlight.textColor} onPick={(textColor) => setHighlight({ textColor })} size={18} allowCustom />
              </div>
              <SliderRow label="Radius" labelWidth={52} value={highlight.radius} min={0} max={48} onChange={(radius) => setHighlight({ radius })} />
              <SliderRow label="Padding" labelWidth={52} value={highlight.padding} min={0} max={40} onChange={(padding) => setHighlight({ padding })} />
              <SliderRow label="Opacity" labelWidth={52} value={Math.round(highlight.opacity * 100)} min={0} max={100} format={(n) => `${n}%`} onChange={(n) => setHighlight({ opacity: n / 100 })} />
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 52, flex: 'none' }}>Colour</span>
              <Swatches colors={TEXT_SWATCHES} value={layer.highlightColor} onPick={(highlightColor) => updateLayer(layer.id, { highlightColor })} size={18} allowCustom />
            </div>
          )}
        </div>
      </Section>

      <Section label="Text effects" headerRight={
        <Chip
          onClick={() => updateLayer(layer.id, { effects: { caps: layer.effects.caps, shadow: { enabled: false, color: '#000000', size: 16, opacity: 0.6, distance: 10, angle: 45 }, stroke: { enabled: false, color: '#000000', size: 6, opacity: 1 }, glow: { enabled: false, color: '#ffffff', size: 26, opacity: 0.85 } } })}
          style={{ padding: '3px 8px', fontSize: 9.5 }}
        >Reset</Chip>
      }>
        <FxCard label="Drop shadow" kind="shadow" value={asShadow(layer.effects.shadow)} onChange={(p) => updateLayer(layer.id, { effects: { ...layer.effects, shadow: { ...asShadow(layer.effects.shadow), ...p } } })} />
        <FxCard label="Stroke" kind="outline" value={asOutline(layer.effects.stroke, '#000000')} onChange={(p) => updateLayer(layer.id, { effects: { ...layer.effects, stroke: { ...asOutline(layer.effects.stroke, '#000000'), ...p } } })} />
        <FxCard label="Glow" kind="glow" value={asGlow(layer.effects.glow, layer.highlightColor)} onChange={(p) => updateLayer(layer.id, { effects: { ...layer.effects, glow: { ...asGlow(layer.effects.glow, layer.highlightColor), ...p } } })} />
      </Section>

      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12 }}>
        <Btn variant="danger" size="sm" style={{ width: '100%' }} disabled={layer.locked} onClick={() => deleteLayer(layer.id)}>Delete layer</Btn>
      </div>
    </div>
  )
}

export function InspectorPanel(): JSX.Element {
  const layers = useStore((s) => s.layers)
  const selectedLayerId = useStore((s) => s.selectedLayerId)
  const selected = layers.find((l) => l.id === selectedLayerId)

  if (!selected || selected.kind === 'background') return <CanvasInspector />
  if (selected.kind === 'subject') return <SubjectInspector layer={selected as SubjectLayer} />
  if (selected.kind === 'shape') return <ShapeInspector layer={selected as ShapeLayer} />
  return <TextInspector layer={selected as TextLayer} />
}
