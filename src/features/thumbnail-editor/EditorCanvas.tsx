import { useEffect, useRef, useState } from 'react'
import Konva from 'konva'
import { useStore } from '../../store/useStore'
import { THUMB_W, THUMB_H, type TextLayer, type ThumbnailLayer } from '@shared/types'
import { snapFrameToGuides, scaleTextLayerBy, type ThumbnailSnapGuide } from '@shared/thumbnail'
import { buildLayerNode, loadImage } from './render'

/* The on-canvas thumbnail editor.

   Architecture: two Konva layers on one stage.
   - content layer: one node per thumbnail layer, reconciled INCREMENTALLY — a node is
     rebuilt only when its own layer JSON changes. Selection changes, drags of other
     layers, and inspector edits to one layer never touch the rest of the scene, which
     is what keeps interactions smooth (the previous editor destroyed and rebuilt the
     whole scene on every store change).
   - overlay layer: transformer, snap guides, marquee, and the title-safe inset. */

interface InlineTextEdit {
  id: string
  value: string
  x: number
  y: number
  width: number
  minHeight: number
  fontSize: number
  fontFamily: string
  color: string
  align: TextLayer['align']
  rotation: number
}

interface NodeEntry {
  key: string
  node: Konva.Shape | Konva.Group
  /** src the node was built with — '' when the image hasn't decoded yet */
  builtWithSrc: string
}

function layerSrc(l: ThumbnailLayer): string {
  if (l.kind === 'subject') return l.src
  if (l.kind === 'background' && l.mode === 'image') return l.src ?? ''
  return ''
}

export function EditorCanvas(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage | null>(null)
  const contentRef = useRef<Konva.Layer | null>(null)
  const overlayRef = useRef<Konva.Layer | null>(null)
  const nodesRef = useRef<Map<string, NodeEntry>>(new Map())
  const imgCacheRef = useRef<Map<string, HTMLImageElement>>(new Map())
  const imgLoadingRef = useRef<Set<string>>(new Set())
  const guideNodesRef = useRef<Konva.Line[]>([])
  const inlineTextRef = useRef<HTMLTextAreaElement>(null)
  const skipInlineCommitRef = useRef(false)
  const [editing, setEditing] = useState<InlineTextEdit | null>(null)
  const [imgTick, setImgTick] = useState(0)

  const layers = useStore((s) => s.layers)
  const selectedLayerIds = useStore((s) => s.selectedLayerIds)
  const selectLayer = useStore((s) => s.selectLayer)
  const setSelection = useStore((s) => s.setSelection)
  const clearSelection = useStore((s) => s.clearSelection)
  const updateLayer = useStore((s) => s.updateLayer)
  const updateLayers = useStore((s) => s.updateLayers)
  const updateGeometry = useStore((s) => s.updateGeometry)
  const updateGeometries = useStore((s) => s.updateGeometries)

  // Refs so stable Konva event handlers always see the latest state without rebinding.
  const layersRef = useRef(layers)
  layersRef.current = layers
  const selectedIdsRef = useRef(selectedLayerIds)
  selectedIdsRef.current = selectedLayerIds

  // ---- guides (overlay) ----
  const clearGuides = (): void => {
    guideNodesRef.current.forEach((n) => n.destroy())
    guideNodesRef.current = []
    overlayRef.current?.batchDraw()
  }
  const drawGuides = (guides: ThumbnailSnapGuide[]): void => {
    const overlay = overlayRef.current
    if (!overlay) return
    guideNodesRef.current.forEach((n) => n.destroy())
    guideNodesRef.current = guides.map((guide) => {
      const line = new Konva.Line({
        points: guide.axis === 'x' ? [guide.value, 0, guide.value, THUMB_H] : [0, guide.value, THUMB_W, guide.value],
        stroke: guide.source === 'layer' ? '#36c98e' : '#f5b323',
        strokeWidth: guide.source === 'safe' ? 1.5 : 1,
        dash: guide.source === 'safe' ? [6, 5] : undefined,
        opacity: guide.source === 'layer' ? 0.9 : 0.8,
        listening: false
      })
      overlay.add(line)
      return line
    })
    overlay.batchDraw()
  }

  const snapNode = (id: string, node: Konva.Node): ReturnType<typeof snapFrameToGuides> => {
    const all = layersRef.current
    const layer = all.find((l) => l.id === id)
    const excludeIds = selectedIdsRef.current.includes(id) ? selectedIdsRef.current : [id]
    const result = snapFrameToGuides(
      {
        ...(layer?.frame ?? { x: node.x(), y: node.y(), width: node.width(), height: node.height(), rotation: node.rotation() }),
        x: node.x(),
        y: node.y(),
        rotation: node.rotation()
      },
      all,
      { excludeIds }
    )
    node.position({ x: result.frame.x, y: result.frame.y })
    return result
  }

  // ---- group drag (multi-selection follows the actively dragged node) ----
  const groupDragRef = useRef<{ activeId: string; starts: Map<string, { x: number; y: number }> } | null>(null)
  const beginGroupDrag = (id: string): void => {
    const selected = selectedIdsRef.current
    if (!selected.includes(id) || selected.length < 2) {
      groupDragRef.current = null
      return
    }
    const starts = new Map<string, { x: number; y: number }>()
    for (const layerId of selected) {
      const layer = layersRef.current.find((l) => l.id === layerId)
      if (layer && !layer.locked) starts.set(layerId, { x: layer.frame.x, y: layer.frame.y })
    }
    groupDragRef.current = { activeId: id, starts }
  }
  const applyGroupDrag = (id: string, node: Konva.Node, commit: boolean): boolean => {
    const drag = groupDragRef.current
    if (!drag || drag.activeId !== id) return false
    const activeStart = drag.starts.get(id)
    if (!activeStart) return false
    const result = snapNode(id, node)
    const dx = result.frame.x - activeStart.x
    const dy = result.frame.y - activeStart.y
    for (const [layerId, start] of drag.starts) {
      if (layerId === id) continue
      const other = nodesRef.current.get(layerId)?.node
      if (other) other.position({ x: start.x + dx, y: start.y + dy })
    }
    if (commit) {
      clearGuides()
      groupDragRef.current = null
      updateGeometries([...drag.starts.entries()].map(([layerId, start]) => ({
        id: layerId,
        frame: { x: start.x + dx, y: start.y + dy }
      })))
    } else {
      drawGuides(result.guides)
    }
    return true
  }

  // ---- inline text editing ----
  const openInlineEditor = (layer: TextLayer): void => {
    const stage = stageRef.current
    if (!stage) return
    skipInlineCommitRef.current = false
    const scale = stage.scaleX() || 1
    const maxSize = Math.max(24, ...layer.lines.map((ln) => ln.size))
    setEditing({
      id: layer.id,
      value: layer.lines.map((ln) => ln.text).join('\n'),
      x: layer.frame.x * scale,
      y: layer.frame.y * scale,
      width: Math.max(160, layer.frame.width * scale),
      minHeight: Math.max(52, layer.frame.height * scale),
      fontSize: Math.max(12, maxSize * scale),
      fontFamily: `${layer.fontFamily}, Anton, Impact, sans-serif`,
      color: layer.color,
      align: layer.align,
      rotation: layer.frame.rotation
    })
  }
  const commitInlineEditor = (edit = editing): void => {
    if (!edit) return
    const layer = useStore.getState().layers.find((l) => l.id === edit.id)
    if (!layer || layer.kind !== 'text') {
      setEditing(null)
      return
    }
    const rows = edit.value.split(/\r?\n/)
    const fallbackSize = layer.lines[0]?.size ?? 72
    const lines = (rows.length ? rows : ['']).map((text, i) => ({ text, size: layer.lines[i]?.size ?? fallbackSize }))
    updateLayer(edit.id, { text: rows.join(' '), lines } as Partial<TextLayer>)
    setEditing(null)
  }
  const addInlineHighlight = (): void => {
    if (!editing) return
    const textarea = inlineTextRef.current
    const layer = useStore.getState().layers.find((l) => l.id === editing.id)
    if (!textarea || !layer || layer.kind !== 'text') return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    let picked = editing.value.slice(Math.min(start, end), Math.max(start, end)).trim()
    if (!picked) {
      const before = editing.value.slice(0, start)
      const after = editing.value.slice(start)
      const left = before.match(/[A-Za-z0-9']+$/)?.[0] ?? ''
      const right = after.match(/^[A-Za-z0-9']+/)?.[0] ?? ''
      picked = `${left}${right}`.trim()
    }
    const words = picked.split(/\s+/).map((w) => w.trim().replace(/^[^\w']+|[^\w']+$/g, '')).filter(Boolean)
    if (!words.length) return
    const existing = layer.highlightWords ?? (layer.highlightWord ? [layer.highlightWord] : [])
    const seen = new Set(existing.map((w) => w.toLowerCase()))
    const nextWords = [...existing]
    for (const word of words) {
      if (!seen.has(word.toLowerCase())) {
        seen.add(word.toLowerCase())
        nextWords.push(word)
      }
    }
    const highlight = layer.highlight ?? { enabled: layer.highlightSquare, boxColor: layer.highlightColor, textColor: '#111111', radius: 0, padding: 6, opacity: 1 }
    updateLayer(layer.id, {
      highlightWords: nextWords,
      highlightWord: nextWords[0] ?? '',
      highlight: { ...highlight, enabled: true },
      highlightSquare: true
    } as Partial<TextLayer>)
    textarea.focus()
  }

  // ---- stage bootstrap (once) ----
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const stage = new Konva.Stage({ container, width: THUMB_W, height: THUMB_H })
    const content = new Konva.Layer()
    const overlay = new Konva.Layer()
    stage.add(content)
    stage.add(overlay)
    stageRef.current = stage
    contentRef.current = content
    overlayRef.current = overlay

    // title-safe dashed inset (static, overlay)
    const inset = Math.round(THUMB_W * 0.06)
    overlay.add(new Konva.Rect({
      x: inset,
      y: inset,
      width: THUMB_W - inset * 2,
      height: THUMB_H - inset * 2,
      stroke: 'rgba(255,255,255,.16)',
      dash: [10, 8],
      listening: false
    }))

    const resize = (): void => {
      const w = container.clientWidth
      if (!w) return
      const scale = w / THUMB_W
      stage.width(w)
      stage.height(THUMB_H * scale)
      stage.scale({ x: scale, y: scale })
      stage.batchDraw()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(container)

    // marquee selection on empty canvas
    let selecting = false
    let selectStart = { x: 0, y: 0 }
    let marquee: Konva.Rect | null = null
    const toStageCoords = (pos: { x: number; y: number }): { x: number; y: number } => ({
      x: pos.x / (stage.scaleX() || 1),
      y: pos.y / (stage.scaleY() || 1)
    })
    stage.on('mousedown.marquee touchstart.marquee', (e) => {
      if (e.target !== stage) return
      const pos = stage.getPointerPosition()
      if (!pos) return
      selecting = true
      selectStart = pos
      useStore.getState().clearSelection()
      const p = toStageCoords(pos)
      marquee = new Konva.Rect({
        x: p.x,
        y: p.y,
        width: 0,
        height: 0,
        fill: 'rgba(245,179,35,.08)',
        stroke: '#f5b323',
        strokeWidth: 1,
        dash: [6, 4],
        listening: false
      })
      overlay.add(marquee)
    })
    stage.on('mousemove.marquee touchmove.marquee', () => {
      if (!selecting || !marquee) return
      const pos = stage.getPointerPosition()
      if (!pos) return
      const a = toStageCoords(selectStart)
      const b = toStageCoords(pos)
      marquee.setAttrs({
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        width: Math.abs(b.x - a.x),
        height: Math.abs(b.y - a.y)
      })
      overlay.batchDraw()
    })
    stage.on('mouseup.marquee touchend.marquee', () => {
      if (!selecting) return
      selecting = false
      if (!marquee) return
      const box = marquee.getClientRect()
      marquee.destroy()
      marquee = null
      overlay.batchDraw()
      if (box.width < 3 && box.height < 3) return
      const all = layersRef.current
      const ids: string[] = []
      for (const [id, entry] of nodesRef.current) {
        const layer = all.find((l) => l.id === id)
        if (layer && !layer.locked && layer.visible && Konva.Util.haveIntersection(box, entry.node.getClientRect())) ids.push(id)
      }
      useStore.getState().setSelection(ids)
    })

    return () => {
      ro.disconnect()
      stage.destroy()
      stageRef.current = null
      contentRef.current = null
      overlayRef.current = null
      nodesRef.current = new Map()
    }
  }, [])

  // ---- incremental content reconcile ----
  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    const entries = nodesRef.current
    const cache = imgCacheRef.current
    const live = new Set<string>()
    let changed = false

    // kick off image loads we don't have yet; when one lands, bump imgTick to re-reconcile
    for (const l of layers) {
      const src = layerSrc(l)
      if (src && !cache.has(src) && !imgLoadingRef.current.has(src)) {
        imgLoadingRef.current.add(src)
        loadImage(src)
          .then((img) => { cache.set(src, img); setImgTick((t) => t + 1) })
          .catch(() => {})
          .finally(() => { imgLoadingRef.current.delete(src) })
      }
    }

    const wireNode = (layer: ThumbnailLayer, node: Konva.Shape | Konva.Group): void => {
      const id = layer.id
      node.on('mousedown tap', (e) => {
        e.cancelBubble = true
        const evt = e.evt as MouseEvent
        const additive = !!(evt.shiftKey || evt.ctrlKey || evt.metaKey)
        // Skip the no-op re-select of an already sole-selected layer so a grab-and-drag
        // in one motion never churns state mid-gesture.
        if (!additive && selectedIdsRef.current.length === 1 && selectedIdsRef.current[0] === id) return
        selectLayer(id, additive)
      })
      if (layer.kind === 'text') {
        node.on('dblclick dbltap', () => {
          selectLayer(id)
          const fresh = useStore.getState().layers.find((l) => l.id === id)
          if (fresh && fresh.kind === 'text') openInlineEditor(fresh as TextLayer)
        })
      }
      if (!layer.locked) {
        node.draggable(true)
        node.on('dragstart', () => beginGroupDrag(id))
        node.on('dragmove', () => {
          if (applyGroupDrag(id, node, false)) return
          const result = snapNode(id, node)
          drawGuides(result.guides)
        })
        node.on('dragend', () => {
          if (applyGroupDrag(id, node, true)) return
          clearGuides()
          const result = snapNode(id, node)
          updateGeometry(id, { x: result.frame.x, y: result.frame.y })
        })
      }
    }

    layers.forEach((layer) => {
      live.add(layer.id)
      const src = layerSrc(layer)
      const img = src ? cache.get(src) : undefined
      const key = JSON.stringify(layer)
      const existing = entries.get(layer.id)
      const imgReadyChanged = existing ? existing.builtWithSrc !== (img ? src : '') : false
      if (existing && existing.key === key && !imgReadyChanged) return
      // rebuild just this node
      const node = layer.visible ? buildLayerNode(layer, img) : null
      if (existing) {
        existing.node.destroy()
        entries.delete(layer.id)
      }
      if (node) {
        wireNode(layer, node)
        content.add(node)
        entries.set(layer.id, { key, node, builtWithSrc: img ? src : '' })
      }
      changed = true
    })

    // drop nodes for deleted layers
    for (const [id, entry] of [...entries]) {
      if (!live.has(id)) {
        entry.node.destroy()
        entries.delete(id)
        changed = true
      }
    }

    // z-order: layers[] is front-to-back → node z is reversed
    const visible = layers.filter((l) => entries.has(l.id))
    visible.forEach((layer, i) => {
      const node = entries.get(layer.id)!.node
      const targetZ = visible.length - 1 - i
      if (node.zIndex() !== targetZ) {
        node.zIndex(targetZ)
        changed = true
      }
    })

    // evict cached images no longer referenced
    const liveSrcs = new Set(layers.map(layerSrc).filter(Boolean))
    for (const key of [...cache.keys()]) {
      if (!liveSrcs.has(key)) cache.delete(key)
    }

    if (changed) content.batchDraw()
  }, [layers, imgTick, selectLayer, updateGeometry, updateGeometries])

  // ---- transformer follows selection (overlay only — content untouched) ----
  useEffect(() => {
    const overlay = overlayRef.current
    if (!overlay) return
    const selectable = selectedLayerIds
      .map((id) => ({ id, layer: layers.find((l) => l.id === id), entry: nodesRef.current.get(id) }))
      .filter((x) => x.layer && !x.layer.locked && x.layer.visible && x.entry)
    if (selectable.length === 0) return

    const nodes = selectable.map((x) => x.entry!.node)
    const tr = new Konva.Transformer({
      nodes,
      rotateEnabled: true,
      borderStroke: '#f5b323',
      anchorStroke: '#f5b323',
      anchorFill: '#0c0d11',
      anchorCornerRadius: 2,
      anchorSize: 9,
      rotateAnchorOffset: 26,
      enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'middle-left', 'middle-right']
    })
    overlay.add(tr)
    overlay.batchDraw()

    const transformHandlers: Array<{ node: Konva.Node; fn: () => void }> = []
    nodes.forEach((node) => {
      const fn = (): void => {
        const id = node.getAttr('layerId') as string
        const layer = layersRef.current.find((l) => l.id === id)
        if (!layer) return
        const sx = Math.abs(node.scaleX() || 1)
        const sy = Math.abs(node.scaleY() || 1)
        const result = snapFrameToGuides(
          {
            x: node.x(),
            y: node.y(),
            rotation: node.rotation(),
            width: Math.max(20, (layer.frame.width || node.width()) * sx),
            height: Math.max(20, (layer.frame.height || node.height()) * sy)
          },
          layersRef.current,
          { excludeIds: selectedIdsRef.current.includes(id) ? selectedIdsRef.current : [id] }
        )
        drawGuides(result.guides)
      }
      node.on('transform.thumbtr', fn)
      transformHandlers.push({ node, fn })
    })
    tr.on('transformend', () => {
      clearGuides()
      const updates = nodes
        .map((node) => {
          const id = node.getAttr('layerId') as string
          const layer = layersRef.current.find((l) => l.id === id)
          if (!layer) return null
          const sx = Math.abs(node.scaleX() || 1)
          const sy = Math.abs(node.scaleY() || 1)
          const frame = {
            x: node.x(),
            y: node.y(),
            rotation: node.rotation(),
            width: Math.max(20, (layer.frame.width || node.width()) * sx),
            height: Math.max(20, (layer.frame.height || node.height()) * sy)
          }
          const snapped = snapFrameToGuides(frame, layersRef.current, { excludeIds: selectedIdsRef.current.includes(id) ? selectedIdsRef.current : [id] }).frame
          node.scale({ x: 1, y: 1 })
          if (layer.kind === 'text') {
            const fontScale = Math.sqrt(sx * sy)
            return { id, patch: scaleTextLayerBy(layer as TextLayer, fontScale, snapped) as Partial<ThumbnailLayer> }
          }
          return { id, patch: { frame: snapped } as Partial<ThumbnailLayer> }
        })
        .filter((p): p is { id: string; patch: Partial<ThumbnailLayer> } => !!p)
      updateLayers(updates)
    })

    return () => {
      transformHandlers.forEach(({ node }) => node.off('transform.thumbtr'))
      tr.destroy()
      overlay.batchDraw()
    }
  }, [selectedLayerIds, layers, updateLayers])

  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', borderRadius: 14, overflow: 'hidden', border: '1px solid var(--border)', background: '#0c0d11', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.02), 0 18px 48px rgba(0,0,0,.35)' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {editing && (
        <>
          <div
            className="ed-float"
            style={{ position: 'absolute', left: editing.x, top: Math.max(6, editing.y - 38), display: 'flex', gap: 6, zIndex: 6 }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <button type="button" title="Highlight selected word(s)" onClick={addInlineHighlight} style={{ border: '1px solid var(--accent)', borderRadius: 7, padding: '5px 10px', background: 'var(--accent-soft)', color: 'var(--accent)', fontSize: 10.5, fontWeight: 800, cursor: 'pointer' }}>Highlight</button>
            <button type="button" title="Done (⌘/Ctrl+Enter)" onClick={() => commitInlineEditor()} style={{ border: '1px solid #262b34', borderRadius: 7, padding: '5px 10px', background: '#15181f', color: '#c4cad3', fontSize: 10.5, fontWeight: 800, cursor: 'pointer' }}>Done</button>
          </div>
          <textarea
            ref={inlineTextRef}
            autoFocus
            value={editing.value}
            onChange={(e) => setEditing({ ...editing, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                skipInlineCommitRef.current = true
                setEditing(null)
              } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                commitInlineEditor()
              }
            }}
            onBlur={() => {
              if (skipInlineCommitRef.current) {
                skipInlineCommitRef.current = false
                return
              }
              commitInlineEditor()
            }}
            style={{
              position: 'absolute',
              left: editing.x,
              top: editing.y,
              width: editing.width,
              minHeight: editing.minHeight,
              transform: `rotate(${editing.rotation}deg)`,
              transformOrigin: 'top left',
              boxSizing: 'border-box',
              border: '1px solid var(--accent)',
              borderRadius: 8,
              padding: 8,
              color: editing.color,
              background: 'rgba(8,10,14,.88)',
              outline: 'none',
              resize: 'both',
              fontFamily: editing.fontFamily,
              fontSize: editing.fontSize,
              lineHeight: 1.08,
              textAlign: editing.align,
              textTransform: 'uppercase',
              zIndex: 5
            }}
          />
        </>
      )}
    </div>
  )
}
