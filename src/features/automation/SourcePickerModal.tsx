import { useEffect, useMemo, useRef, useState } from 'react'
import type { SourceChannel } from '@shared/types'
import { Btn, EmptyState } from '../../components/ui/kit'
import { mediaSrc } from '../../lib/media'

type Sort = 'used' | 'scraped' | 'name'

function cacheStatus(source: SourceChannel): string {
  if (!source.videoCount) return 'No cached videos'
  const age = source.lastScrapedAt ? Date.now() - Date.parse(source.lastScrapedAt) : Number.POSITIVE_INFINITY
  return age > 24 * 60 * 60_000 ? 'Cache stale' : `${source.videoCount} cached`
}

export function SourcePickerModal({ sources, selectedId, loading, error, opener, onSelect, onClose, onRefresh }: {
  sources: SourceChannel[]
  selectedId: string
  loading?: boolean
  error?: string
  opener?: HTMLElement | null
  onSelect(source: SourceChannel): void
  onClose(): void
  onRefresh(source: SourceChannel): Promise<void>
}): JSX.Element {
  const dialog = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('used')
  const [refreshing, setRefreshing] = useState('')
  const [refreshError, setRefreshError] = useState('')
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = sources.filter((source) => !q || `${source.name} ${source.handle} ${source.url}`.toLowerCase().includes(q))
    return rows.sort((a, b) => sort === 'name' ? (a.name || a.handle).localeCompare(b.name || b.handle)
      : sort === 'scraped' ? String(b.lastScrapedAt || '').localeCompare(String(a.lastScrapedAt || ''))
        : String(b.lastVisitedAt || b.lastScrapedAt || '').localeCompare(String(a.lastVisitedAt || a.lastScrapedAt || '')))
  }, [sources, query, sort])

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

  const move = (index: number, delta: number): void => {
    if (!filtered.length) return
    cardRefs.current[(index + delta + filtered.length) % filtered.length]?.focus()
  }

  return <div className="automation-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="source-picker-title" aria-describedby="source-picker-description" className="automation-modal">
      <div className="automation-modal-heading"><div><h2 id="source-picker-title">Choose a saved source</h2><p id="source-picker-description">Use the channel identity and upload-check status to avoid similarly named sources.</p></div><Btn onClick={onClose}>Close</Btn></div>
      <div className="automation-modal-toolbar"><input aria-label="Search saved sources" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, handle, or URL" /><select aria-label="Sort saved sources" value={sort} onChange={(event) => setSort(event.target.value as Sort)}><option value="used">Recently used</option><option value="scraped">Recently scraped</option><option value="name">Name</option></select></div>
      {loading ? <div className="automation-modal-state" aria-live="polite">Loading saved sources…</div>
        : error ? <div className="automation-modal-state error" role="alert">Couldn’t load sources: {error}</div>
          : !filtered.length ? <EmptyState title={sources.length ? 'No sources match' : 'No saved sources'} body={sources.length ? 'Try a different name, handle, or URL.' : 'Add a source in Sources, then return here.'} />
            : <div role="listbox" aria-label="Saved sources" className="automation-source-card-grid">{filtered.map((source, index) => <div key={source.id} className={`automation-source-picker-card ${source.id === selectedId ? 'selected' : ''}`}>
              <button ref={(node) => { cardRefs.current[index] = node }} type="button" role="option" aria-selected={source.id === selectedId} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); move(index, 1) } if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); move(index, -1) } }} onClick={() => onSelect(source)}>
                {source.avatar ? <img src={mediaSrc(source.avatar)} alt="" /> : <i aria-hidden="true">{(source.name || source.handle).slice(0, 2).toUpperCase()}</i>}<span><strong>{source.name || source.handle}</strong><small>{source.handle}</small></span>
              </button>
              <div className="automation-source-chips"><span>{source.linkedMyChannelId ? 'Upload check linked' : 'Upload check unavailable'}</span><span>{cacheStatus(source)}</span></div>
              <button type="button" className="automation-link-button" disabled={refreshing === source.id} onClick={() => { setRefreshing(source.id); setRefreshError(''); void onRefresh(source).catch((reason) => setRefreshError(reason instanceof Error ? reason.message : String(reason))).finally(() => setRefreshing('')) }}>{refreshing === source.id ? 'Refreshing…' : 'Refresh'}</button>
            </div>)}</div>}
      {refreshError && <div className="automation-modal-state error" role="alert">Refresh failed: {refreshError}</div>}
    </div>
  </div>
}
