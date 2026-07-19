import { useMemo, useState } from 'react'
import type { LibraryAsset, SourceChannel } from '@shared/types'
import { isCssImageValue, mediaSrc } from '../lib/media'
import { Btn, SectionLabel } from '../components/ui/kit'

const card: React.CSSProperties = {
  border: '1px solid var(--border-2)', borderRadius: 12, background: 'var(--bg-card)',
  color: 'var(--text)', padding: 11, textAlign: 'left', cursor: 'pointer'
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }): JSX.Element {
  return <div role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(5,7,10,.78)', display: 'grid', placeItems: 'center', padding: 22 }}>
    <section role="dialog" aria-modal="true" aria-label={title} style={{ width: 'min(920px,96vw)', maxHeight: '86vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', border: '1px solid var(--border-2)', borderRadius: 16, background: 'var(--bg-panel)', boxShadow: '0 24px 80px rgba(0,0,0,.45)' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}><SectionLabel style={{ flex: 1 }}>{title}</SectionLabel><Btn size="sm" onClick={onClose}>Close</Btn></header>
      <div style={{ padding: 16, overflowY: 'auto' }}>{children}</div>
    </section>
  </div>
}

function SourceLogo({ source }: { source: SourceChannel }): JSX.Element {
  const avatar = source.avatar || ''
  const src = mediaSrc(avatar)
  const background = isCssImageValue(avatar) ? avatar : 'linear-gradient(135deg,var(--accent),var(--accent-deep))'
  return <div style={{ width: 54, height: 54, borderRadius: 13, flex: 'none', overflow: 'hidden', display: 'grid', placeItems: 'center', background, color: 'var(--accent-ink)', fontWeight: 900, fontSize: 17 }}>
    {src ? <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : (source.name || source.handle || 'S').replace(/^@/, '').slice(0, 2).toUpperCase()}
  </div>
}

export function SourcePickerModal({ sources, selectedId, onSelect, onClose }: {
  sources: SourceChannel[]
  selectedId: string
  onSelect: (source: SourceChannel) => void
  onClose: () => void
}): JSX.Element {
  return <Modal title="Choose a saved source" onClose={onClose}>
    <div style={{ color: 'var(--text-dim)', fontSize: 11, marginBottom: 12 }}>Choose the channel this automation should inspect. The selection card shows the source identity before any videos are queued.</div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(250px,1fr))', gap: 10 }}>
      {sources.map((source) => {
        const selected = source.id === selectedId
        return <button key={source.id} type="button" onClick={() => onSelect(source)} style={{ ...card, borderColor: selected ? 'var(--accent)' : undefined, background: selected ? 'var(--accent-soft)' : card.background }}>
          <div style={{ display: 'flex', gap: 11, alignItems: 'center' }}><SourceLogo source={source} /><div style={{ minWidth: 0, flex: 1 }}><strong className="me-ellipsis" style={{ display: 'block', color: 'var(--text-bright)', fontSize: 12.5 }}>{source.name || source.handle || 'Untitled source'}</strong><span className="me-ellipsis" style={{ display: 'block', color: 'var(--text-dim)', fontSize: 10.5, marginTop: 3 }}>{source.handle || source.url}</span><span style={{ display: 'block', color: 'var(--text-faint)', fontSize: 9.5, marginTop: 6 }}>{source.videoCount ?? 0} cached videos{source.linkedMyChannelId ? ' · upload check linked' : ''}</span></div>{selected && <span style={{ color: 'var(--accent)', fontWeight: 900 }}>✓</span>}</div>
        </button>
      })}
    </div>
  </Modal>
}

function AssetThumb({ path }: { path: string }): JSX.Element {
  const src = mediaSrc(path)
  return <div style={{ width: '100%', aspectRatio: '16/10', background: '#141820', overflow: 'hidden' }}>{src && <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}</div>
}

export function SelectedAssetStrip({ paths, onRemove, onClear }: { paths: string[]; onRemove: (path: string) => void; onClear: () => void }): JSX.Element {
  if (!paths.length) return <div style={{ color: 'var(--text-faint)', fontSize: 10.5, marginTop: 9 }}>No assets selected</div>
  return <div style={{ marginTop: 10 }}><div style={{ display: 'flex', alignItems: 'center', marginBottom: 7 }}><span style={{ color: 'var(--ok-2)', fontSize: 10.5, flex: 1 }}>{paths.length} selected</span><button type="button" className="automation-link-button" onClick={onClear}>Clear all</button></div><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(82px,1fr))', gap: 7 }}>{paths.map((path) => <div key={path} title={path} style={{ position: 'relative', border: '1px solid var(--border)', borderRadius: 9, overflow: 'hidden' }}><AssetThumb path={path} /><button type="button" aria-label={`Remove ${path.split(/[\\/]/).pop()}`} onClick={() => onRemove(path)} style={{ position: 'absolute', top: 4, right: 4, width: 21, height: 21, borderRadius: 999, border: 0, background: 'rgba(0,0,0,.75)', color: 'white', cursor: 'pointer' }}>×</button></div>)}</div></div>
}

export function AssetLibraryModal({ assets, current, onApply, onClose }: {
  assets: LibraryAsset[]
  current: string[]
  onApply: (paths: string[]) => void
  onClose: () => void
}): JSX.Element {
  const [selected, setSelected] = useState(() => new Set(current))
  const grouped = useMemo(() => {
    const map = new Map<string, LibraryAsset[]>()
    for (const asset of assets) map.set(asset.channel || 'Unsorted', [...(map.get(asset.channel || 'Unsorted') ?? []), asset])
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [assets])
  const toggle = (path: string): void => setSelected((before) => { const next = new Set(before); if (next.has(path)) next.delete(path); else next.add(path); return next })
  return <Modal title="Previously used assets" onClose={onClose}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}><div style={{ color: 'var(--text-dim)', fontSize: 11, flex: 1 }}>Browse channel folders, inspect thumbnails, then apply the selection. Closing the modal discards changes.</div><Btn size="sm" onClick={() => setSelected(new Set())}>Clear</Btn><Btn size="sm" variant="primary" onClick={() => { onApply([...selected]); onClose() }}>Apply {selected.size}</Btn></div>
    {grouped.length === 0 ? <div style={{ color: 'var(--text-faint)', padding: 20, textAlign: 'center' }}>No remembered assets yet.</div> : grouped.map(([channel, channelAssets]) => <section key={channel} style={{ marginBottom: 18 }}><div style={{ color: 'var(--text-bright)', fontWeight: 700, fontSize: 11.5, marginBottom: 8 }}>{channel} <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>· {channelAssets.length}</span></div><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))', gap: 8 }}>{channelAssets.map((asset) => { const on = selected.has(asset.path); return <button key={asset.path} type="button" onClick={() => toggle(asset.path)} title={asset.path} style={{ ...card, padding: 0, overflow: 'hidden', position: 'relative', borderColor: on ? 'var(--accent)' : undefined }}><AssetThumb path={asset.path} /><div className="me-ellipsis" style={{ padding: '7px 8px', fontSize: 9.5 }}>{asset.path.split(/[\\/]/).pop()}</div>{on && <span style={{ position: 'absolute', top: 5, right: 5, width: 20, height: 20, display: 'grid', placeItems: 'center', borderRadius: 999, background: 'var(--accent)', color: 'var(--accent-ink)', fontWeight: 900 }}>✓</span>}</button> })}</div></section>)}
  </Modal>
}
