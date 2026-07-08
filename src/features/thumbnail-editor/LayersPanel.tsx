import { useRef } from 'react'
import { useStore } from '../../store/useStore'
import type { ThumbnailLayer } from '@shared/types'
import { Btn, IconBtn } from '../../components/ui/kit'

/* Layers panel — z-ordered list (top = front), drag to reorder, visibility /
   duplicate / delete per row, add-layer actions, and align/distribute tools when
   multiple layers are selected. */

function LayerIcon({ layer }: { layer: ThumbnailLayer }): JSX.Element {
  const common = { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 } as const
  if (layer.kind === 'text') return <svg {...common}><path d="M5 6h14M12 6v13" /></svg>
  if (layer.kind === 'subject') return <svg {...common}><circle cx="12" cy="8" r="3.4" /><path d="M5 20c1.2-3.8 3.6-5.6 7-5.6s5.8 1.8 7 5.6" /></svg>
  if (layer.kind === 'shape') return <svg {...common}><rect x="4.5" y="4.5" width="15" height="15" rx="2.5" /></svg>
  return <svg {...common}><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="M4 16l5-4 4 3 2.5-2 4.5 3.5" /></svg>
}

export function LayersPanel(): JSX.Element {
  const layers = useStore((s) => s.layers)
  const selectedLayerIds = useStore((s) => s.selectedLayerIds)
  const selectLayer = useStore((s) => s.selectLayer)
  const duplicateLayer = useStore((s) => s.duplicateLayer)
  const toggleLayerVisible = useStore((s) => s.toggleLayerVisible)
  const deleteLayer = useStore((s) => s.deleteLayer)
  const reorderLayer = useStore((s) => s.reorderLayer)
  const addTextLayer = useStore((s) => s.addTextLayer)
  const addShapeLayer = useStore((s) => s.addShapeLayer)
  const updateGeometries = useStore((s) => s.updateGeometries)
  const runAutoArrange = useStore((s) => s.runAutoArrange)
  const dragLayerId = useRef<string | null>(null)
  const selectedLayers = layers.filter((l) => selectedLayerIds.includes(l.id) && !l.locked)

  const align = (kind: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'): void => {
    if (selectedLayers.length < 2) return
    const minX = Math.min(...selectedLayers.map((l) => l.frame.x))
    const maxX = Math.max(...selectedLayers.map((l) => l.frame.x + l.frame.width))
    const minY = Math.min(...selectedLayers.map((l) => l.frame.y))
    const maxY = Math.max(...selectedLayers.map((l) => l.frame.y + l.frame.height))
    updateGeometries(selectedLayers.map((l) => {
      if (kind === 'left') return { id: l.id, frame: { x: minX } }
      if (kind === 'center') return { id: l.id, frame: { x: (minX + maxX - l.frame.width) / 2 } }
      if (kind === 'right') return { id: l.id, frame: { x: maxX - l.frame.width } }
      if (kind === 'top') return { id: l.id, frame: { y: minY } }
      if (kind === 'middle') return { id: l.id, frame: { y: (minY + maxY - l.frame.height) / 2 } }
      return { id: l.id, frame: { y: maxY - l.frame.height } }
    }))
  }
  const distribute = (axis: 'x' | 'y'): void => {
    if (selectedLayers.length < 3) return
    const sorted = [...selectedLayers].sort((a, b) => (axis === 'x' ? a.frame.x - b.frame.x : a.frame.y - b.frame.y))
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    const start = axis === 'x' ? first.frame.x : first.frame.y
    const end = axis === 'x' ? last.frame.x : last.frame.y
    const step = (end - start) / (sorted.length - 1)
    updateGeometries(sorted.slice(1, -1).map((l, i) => ({
      id: l.id,
      frame: axis === 'x' ? { x: start + step * (i + 1) } : { y: start + step * (i + 1) }
    })))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="ed-scroll" style={{ flex: 1, minHeight: 0, padding: '10px 10px 4px' }}>
        {selectedLayers.length > 1 && (
          <div className="ed-fade" style={{ border: '1px solid var(--border-3)', borderRadius: 10, background: 'var(--bg-inset)', padding: 8, marginBottom: 8 }}>
            <div style={{ fontSize: 10.5, color: '#cdd2da', marginBottom: 7, fontWeight: 700 }}>{selectedLayers.length} layers selected</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 4, marginBottom: 4 }}>
              {(['left', 'center', 'right', 'top', 'middle', 'bottom'] as const).map((kind) => (
                <Btn key={kind} size="sm" onClick={() => align(kind)} style={{ padding: '5px 0', fontSize: 10, textTransform: 'capitalize' }}>{kind}</Btn>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
              <Btn size="sm" disabled={selectedLayers.length < 3} onClick={() => distribute('x')} style={{ padding: '5px 0', fontSize: 10 }}>Distribute H</Btn>
              <Btn size="sm" disabled={selectedLayers.length < 3} onClick={() => distribute('y')} style={{ padding: '5px 0', fontSize: 10 }}>Distribute V</Btn>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {layers.map((l, index) => {
            const on = selectedLayerIds.includes(l.id)
            return (
              <div
                key={l.id}
                draggable={!l.locked}
                onDragStart={() => { dragLayerId.current = l.id }}
                onDragOver={(e) => { if (dragLayerId.current && dragLayerId.current !== l.id) e.preventDefault() }}
                onDrop={(e) => { e.preventDefault(); const from = dragLayerId.current; dragLayerId.current = null; if (from && from !== l.id) reorderLayer(from, index) }}
                onDragEnd={() => { dragLayerId.current = null }}
                onClick={(e) => selectLayer(l.id, e.shiftKey || e.ctrlKey || e.metaKey)}
                className="me-row"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 8px',
                  border: on ? '1px solid var(--accent)' : '1px solid transparent',
                  borderRadius: 8,
                  background: on ? 'var(--accent-soft)' : 'transparent',
                  fontSize: 11.5,
                  color: on ? 'var(--text-bright)' : '#aab0bb',
                  cursor: l.locked ? 'pointer' : 'grab',
                  opacity: l.visible ? 1 : 0.5
                }}
              >
                <span style={{ color: on ? 'var(--accent)' : 'var(--text-faint)', flex: 'none', display: 'flex' }}><LayerIcon layer={l} /></span>
                <span className="me-ellipsis" style={{ flex: 1, fontWeight: on ? 700 : 500 }}>{l.name}</span>
                {!l.locked && (
                  <span
                    title="Duplicate"
                    onClick={(e) => { e.stopPropagation(); duplicateLayer(l.id) }}
                    style={{ color: 'var(--text-faint)', cursor: 'pointer', flex: 'none', fontSize: 12 }}
                  >⧉</span>
                )}
                <span
                  title={l.visible ? 'Hide' : 'Show'}
                  onClick={(e) => { e.stopPropagation(); toggleLayerVisible(l.id) }}
                  style={{ color: 'var(--text-faint)', cursor: 'pointer', flex: 'none', display: 'flex' }}
                >
                  {l.visible
                    ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.6" /></svg>
                    : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 4l16 16M9.9 6.1A8.8 8.8 0 0112 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 01-3.3 3.9M6 8.2A16 16 0 002.5 12S6 18.5 12 18.5c1 0 2-.2 2.8-.5" /></svg>}
                </span>
                {!l.locked && (
                  <span
                    title="Delete"
                    onClick={(e) => { e.stopPropagation(); deleteLayer(l.id) }}
                    style={{ color: 'var(--text-faint)', cursor: 'pointer', flex: 'none', fontSize: 12 }}
                  >✕</span>
                )}
                {l.locked && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ color: 'var(--text-faint)', flex: 'none' }}>
                    <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" />
                  </svg>
                )}
              </div>
            )
          })}
        </div>
      </div>
      <div style={{ borderTop: '1px solid var(--border)', padding: 10, flex: 'none' }}>
        <div style={{ display: 'flex', gap: 5, marginBottom: 6 }}>
          <Btn size="sm" style={{ flex: 1 }} onClick={addTextLayer}>+ Text</Btn>
          <Btn size="sm" style={{ flex: 1 }} onClick={() => addShapeLayer('rect')}>+ Shape</Btn>
          <Btn size="sm" style={{ flex: 1 }} onClick={() => addShapeLayer('circle')}>+ Badge</Btn>
        </div>
        <Btn size="sm" variant="soft" style={{ width: '100%' }} onClick={runAutoArrange} title="Fit and stack the headline for maximum impact">
          ✦ Auto-arrange type
        </Btn>
      </div>
    </div>
  )
}

export function TemplatesPanel({
  previews,
  onApply,
  onSave,
  onDelete
}: {
  previews: Record<string, string>
  onApply: (id: string) => void
  onSave: () => void
  onDelete: (id: string) => void
}): JSX.Element {
  const templates = useStore((s) => s.templates)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="ed-scroll" style={{ flex: 1, minHeight: 0, padding: '10px 10px 4px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {templates.map((t) => {
            const preview = previews[t.id]
            return (
              <div key={t.id} onClick={() => onApply(t.id)} className="me-card" style={{ position: 'relative', border: '1px solid var(--border)', background: 'var(--bg-inset)', borderRadius: 9, padding: 5, cursor: 'pointer' }}>
                <div
                  title={`Delete "${t.name}"`}
                  onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete "${t.name}"?`)) onDelete(t.id) }}
                  style={{ position: 'absolute', top: 2, right: 2, zIndex: 2, width: 17, height: 17, borderRadius: 5, background: 'rgba(0,0,0,.6)', color: 'var(--err-2)', display: 'grid', placeItems: 'center', fontSize: 11, cursor: 'pointer' }}
                >×</div>
                <div style={{ aspectRatio: '16/9', borderRadius: 5, background: 'linear-gradient(135deg,#2a2540,#46243a)', overflow: 'hidden', display: 'grid', placeItems: 'center' }}>
                  {preview
                    ? <img src={preview} alt={`${t.name} preview`} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    : <span style={{ width: '50%', height: 4, borderRadius: 2, background: 'var(--accent)' }} />}
                </div>
                <div className="me-ellipsis" style={{ fontSize: 9.5, textAlign: 'center', marginTop: 5, color: '#cdd2da', fontWeight: 600 }}>{t.name}</div>
              </div>
            )
          })}
          {templates.length === 0 && (
            <div style={{ gridColumn: '1/-1', fontSize: 10.5, color: 'var(--text-faint)', textAlign: 'center', padding: '22px 6px', lineHeight: 1.5 }}>
              No templates yet. Design once, save it, and reuse the layout for every video.
            </div>
          )}
        </div>
      </div>
      <div style={{ borderTop: '1px solid var(--border)', padding: 10, flex: 'none' }}>
        <Btn size="sm" style={{ width: '100%', borderStyle: 'dashed' }} onClick={onSave}>＋ Save current as template</Btn>
      </div>
    </div>
  )
}
