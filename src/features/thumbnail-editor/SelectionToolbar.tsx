import { useStore } from '../../store/useStore'
import type { LayerFrame, ShapeLayer, TextLayer, ThumbnailLayer } from '@shared/types'
import { DEFAULT_TEXT_HIGHLIGHT, THUMB_H, THUMB_W } from '@shared/types'
import { IconBtn, Swatches } from '../../components/ui/kit'

/* Floating context toolbar — appears near the selection on the canvas with the
   fastest actions: text size, highlight, caps, colour, alignment, duplicate, delete. */

const QUICK_COLORS = ['#ffffff', '#000000', '#f2c200', '#e8403a', '#19c3d6', '#8b7cff', '#36c98e']

function clampNum(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min))
}

function selectedBounds(layers: ThumbnailLayer[]): LayerFrame | null {
  if (!layers.length) return null
  const minX = Math.min(...layers.map((l) => l.frame.x))
  const minY = Math.min(...layers.map((l) => l.frame.y))
  const maxX = Math.max(...layers.map((l) => l.frame.x + l.frame.width))
  const maxY = Math.max(...layers.map((l) => l.frame.y + l.frame.height))
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY, rotation: 0 }
}

function firstHighlightWords(layer: TextLayer): string[] {
  const words = layer.lines
    .flatMap((line) => line.text.split(/\s+/))
    .map((w) => w.trim().replace(/^[^\w']+|[^\w']+$/g, ''))
    .filter(Boolean)
  return words.slice(0, Math.min(2, words.length))
}

export function SelectionToolbar(): JSX.Element | null {
  const layers = useStore((s) => s.layers)
  const selectedLayerIds = useStore((s) => s.selectedLayerIds)
  const updateLayers = useStore((s) => s.updateLayers)
  const duplicateLayer = useStore((s) => s.duplicateLayer)
  const deleteLayer = useStore((s) => s.deleteLayer)
  const selected = layers.filter((l) => selectedLayerIds.includes(l.id) && !l.locked && l.visible)
  const bounds = selectedBounds(selected)
  if (!bounds || selected.length === 0) return null

  const selectedText = selected.filter((l): l is TextLayer => l.kind === 'text')
  const selectedColourLayers = selected.filter((l): l is TextLayer | ShapeLayer => l.kind === 'text' || l.kind === 'shape')
  const hasText = selectedText.length > 0
  const allCaps = hasText && selectedText.every((l) => l.effects.caps)
  const hasHighlight = hasText && selectedText.some((l) => l.highlight?.enabled ?? l.highlightSquare)
  const centerPct = clampNum(((bounds.x + bounds.width / 2) / THUMB_W) * 100, 18, 82)
  const topPct = (bounds.y / THUMB_H) * 100
  const bottomPct = ((bounds.y + bounds.height) / THUMB_H) * 100
  const top = bounds.y > 58 ? `calc(${topPct}% - 44px)` : `calc(${bottomPct}% + 10px)`

  const changeTextSize = (delta: number): void => {
    updateLayers(selectedText.map((layer) => ({
      id: layer.id,
      patch: { lines: layer.lines.map((line) => ({ ...line, size: clampNum(line.size + delta, 8, 260) })) } as Partial<TextLayer>
    })))
  }
  const applyColour = (color: string): void => {
    updateLayers(selectedColourLayers.map((layer) => ({ id: layer.id, patch: { color } as Partial<TextLayer | ShapeLayer> })))
  }
  const toggleCaps = (): void => {
    updateLayers(selectedText.map((layer) => ({ id: layer.id, patch: { effects: { ...layer.effects, caps: !allCaps } } as Partial<TextLayer> })))
  }
  const toggleHighlight = (): void => {
    const enabled = !hasHighlight
    updateLayers(selectedText.map((layer) => {
      const highlight = layer.highlight ?? { ...DEFAULT_TEXT_HIGHLIGHT, enabled: layer.highlightSquare, boxColor: layer.highlightColor }
      const existing = layer.highlightWords?.length ? layer.highlightWords : layer.highlightWord ? [layer.highlightWord] : []
      const highlightWords = existing.length ? existing : firstHighlightWords(layer)
      return {
        id: layer.id,
        patch: {
          highlight: { ...highlight, enabled },
          highlightSquare: enabled,
          highlightWords,
          highlightWord: highlightWords[0] ?? ''
        } as Partial<TextLayer>
      }
    }))
  }
  const currentAlign: TextLayer['align'] | undefined = hasText
    ? selectedText.every((l) => (l.align ?? 'left') === (selectedText[0].align ?? 'left'))
      ? selectedText[0].align ?? 'left'
      : undefined
    : undefined
  const setTextAlign = (align: TextLayer['align']): void => {
    updateLayers(selectedText.map((layer) => ({ id: layer.id, patch: { align } as Partial<TextLayer> })))
  }
  const firstSelectedId = selected[0]?.id
  const divider = <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border-3)', flex: 'none', margin: '2px 1px' }} />

  return (
    <div
      className="ed-float"
      style={{
        position: 'absolute',
        left: `${centerPct}%`,
        top,
        transform: 'translateX(-50%)',
        zIndex: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        maxWidth: 'calc(100% - 18px)',
        padding: 6,
        border: '1px solid var(--border-3)',
        borderRadius: 10,
        background: 'rgba(12,14,19,.94)',
        boxShadow: '0 14px 36px rgba(0,0,0,.4)',
        overflowX: 'auto'
      }}
    >
      {hasText && (
        <>
          <IconBtn title="Smaller text" size={26} onClick={() => changeTextSize(-6)}>A−</IconBtn>
          <IconBtn title="Larger text" size={26} onClick={() => changeTextSize(6)}>A+</IconBtn>
          <IconBtn title="Highlight box on key words" size={26} active={hasHighlight} onClick={toggleHighlight}>H</IconBtn>
          <IconBtn title="ALL CAPS" size={26} active={allCaps} onClick={toggleCaps}>AA</IconBtn>
          {divider}
        </>
      )}
      {selectedColourLayers.length > 0 && (
        <>
          <span style={{ padding: '0 2px', display: 'flex' }}>
            <Swatches colors={QUICK_COLORS} onPick={applyColour} size={17} />
          </span>
          {divider}
        </>
      )}
      {hasText && (
        <>
          <IconBtn title="Align text left" size={26} active={currentAlign === 'left'} onClick={() => setTextAlign('left')}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M4 12h10M4 18h13" /></svg>
          </IconBtn>
          <IconBtn title="Align text center" size={26} active={currentAlign === 'center'} onClick={() => setTextAlign('center')}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M7 12h10M5.5 18h13" /></svg>
          </IconBtn>
          <IconBtn title="Align text right" size={26} active={currentAlign === 'right'} onClick={() => setTextAlign('right')}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M10 12h10M7 18h13" /></svg>
          </IconBtn>
          {divider}
        </>
      )}
      {firstSelectedId && (
        <>
          <IconBtn title="Duplicate (⌘/Ctrl+D)" size={26} onClick={() => duplicateLayer(firstSelectedId)}>⧉</IconBtn>
          <IconBtn title="Delete (Del)" size={26} danger onClick={() => deleteLayer(firstSelectedId)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7h16M9 7V5h6v2M6.5 7l1 13h9l1-13" /></svg>
          </IconBtn>
        </>
      )}
    </div>
  )
}
