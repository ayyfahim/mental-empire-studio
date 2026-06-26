import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { ScreenPad } from '../components/primitives'
import type { BackgroundLayer, FxGlow, FxOutline, FxShadow, SubjectLayer, TextLayer, ThumbnailLayer } from '@shared/types'
import { asGlow, asOutline, asShadow } from '@shared/types'
import { ThumbCanvas } from '../features/thumbnail-editor/ThumbCanvas'
import { rasterizeLayers, withHeadline } from '../features/thumbnail-editor/render'

function layerGlyph(l: ThumbnailLayer): string {
  if (l.kind === 'text') return 'T'
  if (l.kind === 'shape') return '◯'
  if (l.kind === 'subject') return '▦'
  return '▒'
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

function Toolbar(): JSX.Element {
  const addTextLayer = useStore((s) => s.addTextLayer)
  const addShapeLayer = useStore((s) => s.addShapeLayer)
  const runAutoArrange = useStore((s) => s.runAutoArrange)
  const saveCurrentTemplate = useStore((s) => s.saveCurrentTemplate)
  const templates = useStore((s) => s.templates)
  const btn = { display: 'flex', alignItems: 'center', gap: 6, border: '1px solid #262b34', background: '#15181f', borderRadius: 9, padding: '8px 12px', fontSize: 11.5, color: '#dde0e5', cursor: 'pointer' } as const
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
      <div onClick={addTextLayer} className="me-btn" style={btn}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7V5h16v2M9 20h6M12 5v15" /></svg>Add text</div>
      <div onClick={() => addShapeLayer('rect')} className="me-btn" style={btn}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>Add shape</div>
      <div onClick={() => addShapeLayer('circle')} className="me-btn" style={btn}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="8" /></svg>Add badge</div>
      <div onClick={runAutoArrange} className="me-btn" style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--accent)', background: 'var(--accent-soft)', borderRadius: 9, padding: '8px 13px', fontSize: 11.5, color: 'var(--accent)', fontWeight: 600, cursor: 'pointer' }}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" /></svg>Auto-arrange type</div>
      <div style={{ flex: 1 }} />
      <div onClick={() => saveCurrentTemplate(`Template ${templates.length + 1}`)} className="me-btn" style={{ ...btn, color: '#c4cad3' }}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 3h11l3 3v15H5z" /><path d="M8 3v6h7" /></svg>Save as profile template</div>
    </div>
  )
}

function LayersPanel(): JSX.Element {
  const layers = useStore((s) => s.layers)
  const selectedLayerId = useStore((s) => s.selectedLayerId)
  const selectLayer = useStore((s) => s.selectLayer)
  const duplicateLayer = useStore((s) => s.duplicateLayer)
  const toggleLayerVisible = useStore((s) => s.toggleLayerVisible)
  const deleteLayer = useStore((s) => s.deleteLayer)
  const addTextLayer = useStore((s) => s.addTextLayer)
  return (
    <div style={{ padding: '14px 14px 12px', borderBottom: '1px solid #1d2129' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.6px', color: '#6a7180' }}>LAYERS</span>
        <div style={{ flex: 1 }} />
        <span onClick={addTextLayer} className="me-btn" style={{ border: '1px solid #262b34', borderRadius: 6, width: 22, height: 22, display: 'grid', placeItems: 'center', fontSize: 13, color: '#c4cad3', cursor: 'pointer', background: '#15181f' }}>+</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {layers.map((l) => {
          const on = l.id === selectedLayerId
          return (
            <div key={l.id} onClick={() => selectLayer(l.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', border: on ? '1px solid var(--accent)' : '1px solid #1d2129', borderRadius: 8, background: on ? 'var(--accent-soft)' : 'transparent', fontSize: 11.5, color: on ? '#eef0f3' : '#aab0bb', cursor: 'pointer' }}>
              <span style={{ fontWeight: l.kind === 'text' ? 700 : 400 }}>{layerGlyph(l)}</span>{l.name}
              <span style={{ flex: 1 }} />
              {!l.locked && <span onClick={(e) => { e.stopPropagation(); duplicateLayer(l.id) }} style={{ color: on ? '#8a909c' : '#5b616f', cursor: 'pointer' }}>⧉</span>}
              {!l.locked && <span onClick={(e) => { e.stopPropagation(); deleteLayer(l.id) }} style={{ color: on ? '#8a909c' : '#5b616f', cursor: 'pointer' }}>✕</span>}
              {l.locked
                ? <span style={{ cursor: 'pointer' }}>🔒</span>
                : <span onClick={(e) => { e.stopPropagation(); toggleLayerVisible(l.id) }} style={{ color: on ? '#8a909c' : '#5b616f', cursor: 'pointer', opacity: l.visible ? 1 : 0.4 }}>👁</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const FX_SWATCHES = ['#ffffff', '#000000', '#f2c200', '#e8403a', '#19c3d6', '#8b7cff', '#36c98e']

function FxSlider({ label, value, min, max, suffix, onChange }: { label: string; value: number; min: number; max: number; suffix?: string; onChange: (n: number) => void }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
      <span style={{ fontSize: 10.5, color: '#8a909c', width: 54 }}>{label}</span>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ flex: 1, accentColor: 'var(--accent)' }} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: '#8a909c', width: 34, textAlign: 'right' }}>{value}{suffix ?? ''}</span>
    </div>
  )
}

/** A toggleable effect (shadow/glow/outline) with size + opacity (+ distance/angle) sliders and a colour. */
function FxControl({ label, kind, value, onChange }: { label: string; kind: 'shadow' | 'glow' | 'outline'; value: FxShadow | FxGlow | FxOutline; onChange: (patch: Partial<FxShadow & FxGlow & FxOutline>) => void }): JSX.Element {
  const v = value as FxShadow & Partial<FxShadow>
  const enabled = v.enabled
  return (
    <div style={{ border: enabled ? '1px solid var(--accent)' : '1px solid #1d2129', borderRadius: 9, padding: '8px 10px', background: enabled ? 'var(--accent-soft)' : '#0e1116', marginBottom: 7 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11.5, color: enabled ? '#eef0f3' : '#8a909c', flex: 1, fontWeight: enabled ? 600 : 400 }}>{label}</span>
        <div onClick={() => onChange({ enabled: !enabled })} style={{ width: 34, height: 19, borderRadius: 11, background: enabled ? 'var(--accent)' : '#2b303b', position: 'relative', cursor: 'pointer', flex: 'none' }}><span style={{ position: 'absolute', top: 2, right: enabled ? 2 : 17, width: 15, height: 15, borderRadius: '50%', background: '#fff' }} /></div>
      </div>
      {enabled && (
        <div style={{ marginTop: 9, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <FxSlider label="Size" value={v.size} min={0} max={kind === 'outline' ? 40 : 80} onChange={(n) => onChange({ size: n })} />
          <FxSlider label="Opacity" value={Math.round(v.opacity * 100)} min={0} max={100} suffix="%" onChange={(n) => onChange({ opacity: n / 100 })} />
          {kind === 'shadow' && <FxSlider label="Distance" value={v.distance} min={0} max={60} onChange={(n) => onChange({ distance: n })} />}
          {kind === 'shadow' && <FxSlider label="Angle" value={v.angle} min={0} max={360} suffix="°" onChange={(n) => onChange({ angle: n })} />}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10.5, color: '#8a909c', width: 54 }}>Color</span>
            {FX_SWATCHES.map((c) => <span key={c} onClick={() => onChange({ color: c })} style={{ width: 18, height: 18, borderRadius: 5, background: c, border: c === v.color ? '2px solid var(--accent)' : '1px solid #2c303b', cursor: 'pointer' }} />)}
          </div>
        </div>
      )}
    </div>
  )
}

function TextLayerEditor({ layer }: { layer: TextLayer }): JSX.Element {
  const updateLayer = useStore((s) => s.updateLayer)
  const setSubjectImage = useStore((s) => s.setSubjectImage)
  const setBackground = useStore((s) => s.setBackground)
  const layers = useStore((s) => s.layers)
  const subject = layers.find((l) => l.kind === 'subject') as SubjectLayer | undefined
  const subjectFile = useRef<HTMLInputElement>(null)
  const bgFile = useRef<HTMLInputElement>(null)
  const swatches = ['#ffffff', '#f2c200', '#e8403a', '#19c3d6']
  const bgSwatches = ['linear-gradient(135deg,#2a2540,#46243a)', '#1a1a1a', '#0f3a32', '#23304a']

  const setLineSize = (i: number, size: number): void => {
    const lines = layer.lines.map((ln, idx) => (idx === i ? { ...ln, size } : ln))
    updateLayer(layer.id, { lines })
  }

  return (
    <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.6px', color: 'var(--accent)' }}>SELECTED · {layer.name.toUpperCase()}</div>

      <div>
        <div style={{ fontSize: 10.5, color: '#6a7180', marginBottom: 6 }}>Text (one line per row)</div>
        <textarea
          value={layer.lines.map((l) => l.text).join('\n')}
          onChange={(e) => {
            const rows = e.target.value.split('\n')
            const lines = rows.map((t, i) => ({ text: t, size: layer.lines[i]?.size ?? 72 }))
            updateLayer(layer.id, { text: rows.join(' '), lines })
          }}
          rows={Math.max(2, layer.lines.length)}
          style={{ width: '100%', border: '1px solid #23272f', borderRadius: 8, padding: 9, fontSize: 12, color: '#dde0e5', lineHeight: 1.4, background: '#0e1116', resize: 'vertical', fontFamily: 'inherit' }}
        />
      </div>

      <div>
        <div style={{ fontSize: 10.5, color: '#6a7180', marginBottom: 8 }}>Per-line size</div>
        {layer.lines.map((ln, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: i < layer.lines.length - 1 ? 8 : 0 }}>
            <span style={{ fontSize: 10.5, color: '#8a909c', width: 42 }}>Line {i + 1}</span>
            <input type="range" min={24} max={180} value={ln.size} onChange={(e) => setLineSize(i, Number(e.target.value))} style={{ flex: 1, accentColor: 'var(--accent)' }} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: '#8a909c', width: 30 }}>{ln.size}</span>
          </div>
        ))}
      </div>

      <div>
        <div style={{ fontSize: 10.5, color: '#6a7180', marginBottom: 7 }}>Highlighted word</div>
        <input
          value={layer.highlightWord ?? ''}
          onChange={(e) => updateLayer(layer.id, { highlightWord: e.target.value })}
          placeholder="e.g. FAKE"
          style={{ width: '100%', border: '1px solid #23272f', borderRadius: 8, padding: '7px 10px', fontSize: 12, color: '#dde0e5', background: '#0e1116', marginBottom: 10, boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
          <span style={{ fontSize: 10.5, color: '#8a909c', flex: 1 }}>Square background</span>
          <div onClick={() => updateLayer(layer.id, { highlightSquare: !layer.highlightSquare })} style={{ width: 34, height: 19, borderRadius: 11, background: layer.highlightSquare ? 'var(--accent)' : '#2b303b', position: 'relative', cursor: 'pointer' }}><span style={{ position: 'absolute', top: 2, right: layer.highlightSquare ? 2 : 17, width: 15, height: 15, borderRadius: '50%', background: '#fff' }} /></div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontSize: 10.5, color: '#8a909c' }}>Color</span>
          {swatches.map((c) => <span key={c} onClick={() => updateLayer(layer.id, { highlightColor: c })} style={{ width: 22, height: 22, borderRadius: 6, background: c, border: c === layer.highlightColor ? '2px solid var(--accent)' : '1px solid #2c303b', cursor: 'pointer' }} />)}
        </div>
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 10.5, color: '#6a7180', flex: 1 }}>Text effects</span>
          <span onClick={() => updateLayer(layer.id, { effects: { ...layer.effects, caps: !layer.effects.caps } })} style={{ border: layer.effects.caps ? '1px solid var(--accent)' : '1px solid #23272f', color: layer.effects.caps ? 'var(--accent)' : '#8a909c', borderRadius: 7, padding: '4px 10px', fontSize: 11, background: layer.effects.caps ? 'var(--accent-soft)' : 'transparent', cursor: 'pointer' }}>CAPS</span>
        </div>
        <FxControl label="Drop shadow" kind="shadow" value={asShadow(layer.effects.shadow)} onChange={(p) => updateLayer(layer.id, { effects: { ...layer.effects, shadow: { ...asShadow(layer.effects.shadow), ...p } } })} />
        <FxControl label="Border (stroke)" kind="outline" value={asOutline(layer.effects.stroke, '#000000')} onChange={(p) => updateLayer(layer.id, { effects: { ...layer.effects, stroke: { ...asOutline(layer.effects.stroke, '#000000'), ...p } } })} />
        <FxControl label="Glow" kind="glow" value={asGlow(layer.effects.glow, layer.highlightColor)} onChange={(p) => updateLayer(layer.id, { effects: { ...layer.effects, glow: { ...asGlow(layer.effects.glow, layer.highlightColor), ...p } } })} />
      </div>

      {subject && (
        <div style={{ borderTop: '1px solid #1d2129', paddingTop: 13 }}>
          <div style={{ fontSize: 10.5, color: '#6a7180', marginBottom: 8 }}>Subject (PNG) effects</div>
          <FxControl label="Border (outline)" kind="outline" value={asOutline(subject.outline)} onChange={(p) => updateLayer(subject.id, { outline: { ...asOutline(subject.outline), ...p } } as Partial<SubjectLayer>)} />
          <FxControl label="Drop shadow" kind="shadow" value={asShadow(subject.shadow)} onChange={(p) => updateLayer(subject.id, { shadow: { ...asShadow(subject.shadow), ...p } } as Partial<SubjectLayer>)} />
          <FxControl label="Glow" kind="glow" value={asGlow(subject.glow, '#19c3d6')} onChange={(p) => updateLayer(subject.id, { glow: { ...asGlow(subject.glow, '#19c3d6'), ...p } } as Partial<SubjectLayer>)} />
          <input ref={subjectFile} type="file" accept="image/png,image/*" style={{ display: 'none' }} onChange={async (e) => { const f = e.target.files?.[0]; if (f) setSubjectImage(await readAsDataUrl(f)) }} />
          <div onClick={() => subjectFile.current?.click()} className="me-btn" style={{ border: '1px solid #262b34', borderRadius: 8, padding: 8, textAlign: 'center', fontSize: 11, color: '#c4cad3', background: '#0e1116', cursor: 'pointer' }}>⇪ Replace subject · PNG</div>
        </div>
      )}

      <div style={{ borderTop: '1px solid #1d2129', paddingTop: 13 }}>
        <div style={{ fontSize: 10.5, color: '#6a7180', marginBottom: 8 }}>Background</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 9 }}>
          {bgSwatches.map((c) => <span key={c} onClick={() => setBackground({ mode: c.startsWith('linear') ? 'gradient' : 'solid', fill: c })} style={{ width: 22, height: 22, borderRadius: 6, background: c, border: '1px solid #2c303b', cursor: 'pointer' }} />)}
        </div>
        <input ref={bgFile} type="file" accept="image/*" style={{ display: 'none' }} onChange={async (e) => { const f = e.target.files?.[0]; if (f) setBackground({ mode: 'image', src: await readAsDataUrl(f) } as Partial<BackgroundLayer>) }} />
        <div onClick={() => bgFile.current?.click()} className="me-btn" style={{ border: '1px solid #262b34', borderRadius: 8, padding: 8, textAlign: 'center', fontSize: 11, color: '#c4cad3', background: '#0e1116', cursor: 'pointer' }}>⇪ Use image background</div>
      </div>
    </div>
  )
}

function TemplateRail(): JSX.Element {
  const templates = useStore((s) => s.templates)
  const applyTemplate = useStore((s) => s.applyTemplate)
  const saveCurrentTemplate = useStore((s) => s.saveCurrentTemplate)
  const deleteTemplate = useStore((s) => s.deleteTemplate)
  return (
    <div className="me-template-rail" style={{ flex: 'none', width: 120, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.6px', color: '#5b616f', marginBottom: 1 }}>PROFILE TEMPLATES</div>
      {templates.map((t) => (
        <div key={t.id} onClick={() => applyTemplate(t)} className="me-card" style={{ position: 'relative', border: '1px solid #1d2129', background: '#12151b', borderRadius: 9, padding: 6, cursor: 'pointer' }}>
          <div
            onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete template "${t.name}"?`)) void deleteTemplate(t.id) }}
            title="Delete template"
            style={{ position: 'absolute', top: 3, right: 3, zIndex: 2, width: 18, height: 18, borderRadius: 5, background: 'rgba(0,0,0,.55)', color: '#ff8a96', display: 'grid', placeItems: 'center', fontSize: 12, lineHeight: 1, cursor: 'pointer' }}
          >×</div>
          <div style={{ aspectRatio: '16/9', borderRadius: 5, background: 'linear-gradient(135deg,#2a2540,#46243a)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span style={{ width: '50%', height: 4, borderRadius: 2, background: 'var(--accent)' }} /></div>
          <div style={{ fontSize: 9.5, textAlign: 'center', marginTop: 5, color: '#cdd2da', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</div>
        </div>
      ))}
      <div onClick={() => saveCurrentTemplate(`Template ${templates.length + 1}`)} className="me-btn" style={{ border: '1.5px dashed #262b34', borderRadius: 9, padding: '10px 6px', textAlign: 'center', fontSize: 9.5, color: '#6a7180', background: '#0e1116', cursor: 'pointer' }}>＋ Save<br />current</div>
    </div>
  )
}

function BatchGenerate(): JSX.Element {
  const layers = useStore((s) => s.layers)
  const [titles, setTitles] = useState("YOU'RE NOT CRAZY\nIT ALL BROKE\nNEVER APOLOGIZE\nSTOP EXPLAINING")
  const [results, setResults] = useState<{ title: string; url: string }[]>([])
  const [busy, setBusy] = useState(false)

  const generate = async (): Promise<void> => {
    setBusy(true)
    const list = titles.split('\n').map((t) => t.trim()).filter(Boolean)
    const out: { title: string; url: string }[] = []
    for (const title of list) {
      const url = await rasterizeLayers(withHeadline(layers, title))
      out.push({ title, url })
      await window.api?.thumbnails?.writePng?.(title, url).catch(() => '')
    }
    setResults(out)
    setBusy(false)
  }

  return (
    <div style={{ border: '1px solid #1d2129', borderRadius: 14, padding: 18, background: '#12151b' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 15, color: '#e9ebef' }}>Batch generate</span>
        <span style={{ fontSize: 12, color: '#6a7180', marginLeft: 10 }}>same template · one line per title</span>
        <div style={{ flex: 1 }} />
        <div onClick={generate} className="me-btn" style={{ background: 'linear-gradient(180deg,var(--accent),var(--accent-deep))', color: 'var(--accent-ink)', fontWeight: 600, fontSize: 11.5, padding: '8px 16px', borderRadius: 9, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>{busy ? 'Generating…' : 'Generate all →'}</div>
      </div>
      <textarea value={titles} onChange={(e) => setTitles(e.target.value)} rows={4} style={{ width: '100%', border: '1px solid #23272f', borderRadius: 8, padding: 10, fontSize: 12, color: '#dde0e5', background: '#0e1116', resize: 'vertical', fontFamily: 'var(--font-mono)', marginBottom: 14, boxSizing: 'border-box' }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 10 }}>
        {results.length === 0
          ? <div style={{ gridColumn: '1 / -1', fontSize: 12, color: '#6a7180', textAlign: 'center', padding: 18 }}>Paste titles above and hit Generate — each becomes a PNG using the locked template.</div>
          : results.map((r, i) => (
            <div key={i} className="me-card" style={{ borderRadius: 9, overflow: 'hidden', aspectRatio: '16/9', background: '#0c0d11', border: '1px solid #1d2129' }}>
              <img src={r.url} alt={r.title} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            </div>
          ))}
      </div>
    </div>
  )
}

export function Thumbnails(): JSX.Element {
  const layers = useStore((s) => s.layers)
  const selectedLayerId = useStore((s) => s.selectedLayerId)
  const loadTemplates = useStore((s) => s.loadTemplates)
  useEffect(() => { void loadTemplates() }, [loadTemplates])

  const selected = layers.find((l) => l.id === selectedLayerId)
  const headline = (selected && selected.kind === 'text' ? selected : layers.find((l) => l.kind === 'text')) as TextLayer

  return (
    <ScreenPad style={{ minHeight: '100%', padding: 'clamp(16px, 2.2vw, 30px) clamp(16px, 2.5vw, 34px) 28px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', marginBottom: 22 }}>
        <div><div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '1px', color: 'var(--accent)', marginBottom: 7 }}>STEP 03 — THUMBNAIL</div><div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 25, letterSpacing: '-.5px', color: '#f4f6f9' }}>Thumbnail studio</div></div>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 12, color: '#6a7180' }}>Subject &amp; style save into the profile template</div>
      </div>

      <Toolbar />

      <div className="me-thumb-workspace" style={{ display: 'grid', gridTemplateColumns: 'minmax(96px, 120px) minmax(420px, 1fr) minmax(260px, 300px)', gap: 18, marginBottom: 22, alignItems: 'start' }}>
        <TemplateRail />
        {/* minWidth:0 lets the canvas column shrink; without it the Konva canvas's pixel
            width becomes the flex min-size and pushes the inspector off the right edge. */}
        <div style={{ minWidth: 0 }}>
          <ThumbCanvas />
          <div style={{ fontSize: 11.5, color: '#6a7180', marginTop: 11, lineHeight: 1.5 }}>Drag any layer on the canvas; the selected subject/shape gets resize handles. <span style={{ color: 'var(--accent)' }}>Auto-arrange type</span> lays out the headline opposite the subject. Dashed = title-safe.</div>
        </div>
        <div className="me-thumb-inspector" style={{ minWidth: 0, border: '1px solid #1d2129', borderRadius: 14, background: '#12151b', overflow: 'hidden', display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 180px)' }}>
          <LayersPanel />
          {headline && <TextLayerEditor layer={headline} />}
        </div>
      </div>

      <BatchGenerate />
    </ScreenPad>
  )
}
