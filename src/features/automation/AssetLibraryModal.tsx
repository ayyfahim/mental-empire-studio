import { useEffect, useMemo, useRef, useState } from 'react'
import type { LibraryAsset } from '@shared/types'
import { Btn, EmptyState } from '../../components/ui/kit'
import { mediaSrc } from '../../lib/media'

type AssetSort = 'recent' | 'used' | 'name'

export function AssetLibraryModal({ assets, selectedPaths, opener, onApply, onClose }: {
  assets: LibraryAsset[]
  selectedPaths: string[]
  opener?: HTMLElement | null
  onApply(paths: string[]): void
  onClose(): void
}): JSX.Element {
  const dialog = useRef<HTMLDivElement>(null)
  const [folder, setFolder] = useState<string | null>(null)
  const [temporary, setTemporary] = useState(() => new Set(selectedPaths))
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<AssetSort>('recent')
  const groups = useMemo(() => {
    const map = new Map<string, LibraryAsset[]>()
    for (const asset of assets) {
      const key = asset.sourceId || asset.channelHandle || asset.channel || 'Unsorted'
      map.set(key, [...(map.get(key) || []), asset])
    }
    return [...map.entries()].map(([key, rows]) => ({ key, rows, label: rows[0]?.channel || 'Unsorted', handle: rows[0]?.channelHandle, avatar: rows[0]?.channelAvatar }))
  }, [assets])
  const current = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = groups.find((group) => group.key === folder)?.rows || []
    return rows.filter((asset) => !q || `${asset.path} ${asset.channel} ${asset.channelHandle || ''}`.toLowerCase().includes(q)).sort((a, b) => sort === 'name' ? a.path.localeCompare(b.path) : sort === 'used' ? b.usageCount - a.usageCount : b.lastUsedAt.localeCompare(a.lastUsedAt))
  }, [groups, folder, query, sort])
  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = groups.filter((group) => !q || `${group.label} ${group.handle || ''}`.toLowerCase().includes(q))
    return rows.sort((a, b) => sort === 'name' ? a.label.localeCompare(b.label)
      : sort === 'used' ? b.rows.reduce((sum, asset) => sum + asset.usageCount, 0) - a.rows.reduce((sum, asset) => sum + asset.usageCount, 0)
        : String(b.rows[0]?.lastUsedAt || '').localeCompare(String(a.rows[0]?.lastUsedAt || '')))
  }, [groups, query, sort])

  useEffect(() => {
    const node = dialog.current
    const focusable = (): HTMLElement[] => node ? [...node.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled])')] : []
    focusable()[0]?.focus()
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key === 'Tab') {
        const list = focusable(); if (!list.length) return
        const first = list[0]; const last = list[list.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); opener?.focus() }
  }, [onClose, opener])

  const toggle = (path: string): void => setTemporary((before) => { const next = new Set(before); if (next.has(path)) next.delete(path); else next.add(path); return next })
  return <div className="automation-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="asset-picker-title" aria-describedby="asset-picker-description" className="automation-modal asset-modal">
      <div className="automation-modal-heading"><div><h2 id="asset-picker-title">Previous assets</h2><p id="asset-picker-description">Selections are temporary until you click Apply.</p></div><Btn onClick={onClose}>Cancel</Btn></div>
      {folder ? <>
        <div className="automation-modal-toolbar"><button type="button" onClick={() => { setFolder(null); setQuery('') }}>← Back to channels</button><input aria-label="Search assets" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search filename" /><select aria-label="Sort assets" value={sort} onChange={(event) => setSort(event.target.value as AssetSort)}><option value="recent">Recently used</option><option value="used">Usage count</option><option value="name">Filename</option></select></div>
        <div className="automation-selection-actions"><button type="button" onClick={() => setTemporary((before) => new Set([...before, ...current.filter((asset) => !asset.missing).map((asset) => asset.canonicalPath)]))}>Select all</button><button type="button" onClick={() => setTemporary((before) => { const next = new Set(before); current.forEach((asset) => next.delete(asset.canonicalPath)); return next })}>Clear folder selection</button></div>
        {!current.length ? <EmptyState title="No assets in this folder" body="Import images while creating a project or Automation." /> : <div className="automation-asset-grid">{current.map((asset) => <label key={asset.id} className={temporary.has(asset.canonicalPath) ? 'selected' : ''}><input type="checkbox" disabled={asset.missing} checked={temporary.has(asset.canonicalPath)} onChange={() => toggle(asset.canonicalPath)} /><div className="automation-asset-thumb">{asset.thumbnailPath && !asset.missing ? <img src={mediaSrc(asset.thumbnailPath)} alt="" /> : <span>Unavailable</span>}</div><strong title={asset.canonicalPath}>{asset.canonicalPath.split(/[\\/]/).pop()}</strong><small>{asset.width && asset.height ? `${asset.width}×${asset.height}` : 'Dimensions unknown'} · used {asset.usageCount}×</small>{asset.missing && <em>Missing</em>}</label>)}</div>}
      </> : <><div className="automation-modal-toolbar"><input aria-label="Search channel folders" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search channel or handle" /><select aria-label="Sort channel folders" value={sort} onChange={(event) => setSort(event.target.value as AssetSort)}><option value="recent">Recently used</option><option value="used">Usage count</option><option value="name">Name</option></select></div>{!groups.length ? <EmptyState title="No previous assets" body="Imported images will appear here in durable channel folders." /> : !visibleGroups.length ? <EmptyState title="No folders match" body="Try a different channel name or handle." /> : <div className="automation-folder-grid">{visibleGroups.map((group) => <button type="button" key={group.key} onClick={() => { setFolder(group.key); setQuery('') }}><div>{group.avatar ? <img src={mediaSrc(group.avatar)} alt="" /> : <span>{group.label.slice(0, 2).toUpperCase()}</span>}<strong>{group.label}</strong><small>{group.handle || 'Unsorted'} · {group.rows.length} assets</small></div><div className="automation-folder-strip">{group.rows.slice(0, 3).map((asset) => asset.thumbnailPath && !asset.missing ? <img key={asset.id} src={mediaSrc(asset.thumbnailPath)} alt="" /> : <span key={asset.id} />)}</div><small>Last used {new Date(group.rows[0].lastUsedAt).toLocaleDateString()}</small></button>)}</div>}</>}
      <div className="automation-modal-footer"><span>{temporary.size} selected</span><button type="button" className="automation-link-button" onClick={() => setTemporary(new Set())}>Clear all</button><Btn variant="primary" onClick={() => onApply([...temporary])}>Apply</Btn></div>
    </div>
  </div>
}
