import { useState } from 'react'
import { ScreenPad, Eyebrow, Title } from '../components/primitives'
import { useData } from '../store/useData'
import { useStore } from '../store/useStore'
import type { ScrapeOrder } from '@shared/types'

const GRADS = [
  'linear-gradient(135deg,#2a2540,#46243a)', 'linear-gradient(135deg,#1a2e3a,#0f3a32)',
  'linear-gradient(135deg,#3a2440,#2a1530)', 'linear-gradient(135deg,#23304a,#1a2438)',
  'linear-gradient(135deg,#16323a,#0f2630)', 'linear-gradient(135deg,#2e2440,#3a1f2e)',
  'linear-gradient(135deg,#1f3340,#102a3a)', 'linear-gradient(135deg,#332a40,#241a30)'
]

function fmtDur(sec: number): string {
  if (!sec) return '—'
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function Download(): JSX.Element {
  const sourceVideos = useData((s) => s.sourceVideos)
  const downloads = useData((s) => s.downloads)
  const dlProgress = useData((s) => s.dlProgress)
  const fetching = useData((s) => s.fetching)
  const fetchSource = useData((s) => s.fetchSource)
  const startDownload = useData((s) => s.startDownload)
  const resumeDownload = useData((s) => s.resumeDownload)
  const openProject = useData((s) => s.openProject)
  const setActive = useStore((s) => s.setActive)

  const [url, setUrl] = useState('')
  const [order, setOrder] = useState<ScrapeOrder>('Popular')
  const [qty, setQty] = useState(10)
  const [bitrate] = useState(192)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const toggle = (id: string): void =>
    setSel((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const canFetch = url.trim().length > 0 && !fetching
  const fetchVids = (): void => {
    if (!canFetch) return
    void fetchSource(url, order, qty)
  }
  const selected = sourceVideos.filter((v) => sel.has(v.id))
  const estMb = (selected.reduce((a, v) => a + v.durationSec, 0) * bitrate) / 8 / 1000

  const download = async (toQueue: boolean): Promise<void> => {
    if (selected.length === 0 || busy) return
    setBusy(true)
    setMessage(toQueue ? 'Downloading selected audio before opening Compose…' : 'Starting download…')
    try {
      const rows = await startDownload(selected, url, bitrate)
      const usable = rows.find((d) => d.filePath && (d.durationSec ?? 0) > 0)
      if (toQueue) {
        if (!usable) {
          setMessage('Download did not produce a usable MP3 yet. Check the row below and resume if needed.')
          return
        }
        await openProject(usable.id)
        setActive('compose')
      } else {
        setMessage(rows.some((d) => d.stage === 'Failed') ? 'Some downloads failed. Check Activity or logs for details.' : 'Download finished.')
      }
      setSel(new Set())
    } catch (e) {
      setMessage((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ScreenPad>
      <div style={{ marginBottom: 22 }}><Eyebrow>STEP 01 — SOURCE</Eyebrow><Title>Download audio from a channel</Title></div>

      <div style={{ display: 'flex', gap: 11, marginBottom: 18 }}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, background: '#12151b', border: '1px solid #23272f', borderRadius: 11, padding: '12px 15px' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5b616f" strokeWidth="2"><path d="M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1" /><path d="M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1" /></svg>
          <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && fetchVids()} placeholder="youtube.com/@PowerWithinOfficial" style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 13, color: '#dde0e5', fontFamily: 'var(--font-mono)' }} />
        </div>
        <button type="button" disabled={!canFetch} onClick={fetchVids} className="me-btn" style={{ display: 'flex', alignItems: 'center', gap: 8, border: 0, background: 'linear-gradient(180deg,var(--accent),var(--accent-deep))', color: 'var(--accent-ink)', fontWeight: 600, fontSize: 13, padding: '0 20px', borderRadius: 11, cursor: canFetch ? 'pointer' : 'not-allowed', boxShadow: '0 4px 16px -4px var(--accent-glow)', opacity: canFetch ? 1 : 0.5 }}>{fetching ? 'Fetching…' : 'Fetch'}</button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 13, border: '1px solid #1d2129', borderRadius: 13, padding: '13px 16px', marginBottom: 18, background: '#12151b' }}>
        <div style={{ width: 44, height: 44, borderRadius: 11, background: 'linear-gradient(135deg,#2d3340,#1a1e26)', display: 'grid', placeItems: 'center', fontFamily: 'var(--font-display)', fontWeight: 700, color: '#aab1bf' }}>▶</div>
        <div><div style={{ fontWeight: 600, fontSize: 14, color: '#eef0f3' }}>{url || 'Paste a channel and Fetch'}</div><div style={{ fontSize: 11, color: '#6a7180', fontFamily: 'var(--font-mono)' }}>{sourceVideos.length} videos found</div></div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
          <div style={{ display: 'flex', background: '#0e1116', border: '1px solid #23272f', borderRadius: 9, overflow: 'hidden', fontSize: 12 }}>
            {(['Popular', 'Latest', 'Oldest'] as ScrapeOrder[]).map((o) => (
              <button type="button" key={o} onClick={() => setOrder(o)} style={{ border: 0, padding: '8px 14px', cursor: 'pointer', background: order === o ? 'var(--accent)' : 'transparent', color: order === o ? 'var(--accent-ink)' : '#8a909c', fontWeight: order === o ? 600 : undefined }}>{o}</button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, border: '1px solid #23272f', borderRadius: 9, padding: '7px 12px', background: '#0e1116' }}><span style={{ fontSize: 11, color: '#6a7180', fontFamily: 'var(--font-mono)' }}>QTY</span><input value={qty} onChange={(e) => setQty(Math.max(1, parseInt(e.target.value) || 1))} style={{ width: 28, border: 'none', outline: 'none', background: 'transparent', fontFamily: 'var(--font-display)', fontWeight: 600, color: '#eef0f3', fontSize: 14 }} /></div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, border: '1px solid #23272f', borderRadius: 9, padding: '7px 12px', background: '#0e1116', fontSize: 11.5, color: '#8a909c' }}>mp3 · {bitrate}k ▾</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 13, marginBottom: 20 }}>
        {sourceVideos.length === 0 && (
          <div style={{ gridColumn: '1 / -1', padding: '34px 0', textAlign: 'center', fontSize: 12.5, color: '#5b616f', border: '1.5px dashed #23272f', borderRadius: 12 }}>Fetch a channel to list its videos.</div>
        )}
        {sourceVideos.map((v, i) => {
          const on = sel.has(v.id)
          return (
            <div key={v.id} onClick={() => toggle(v.id)} className="me-vid me-card" style={{ border: `1px solid ${on ? 'var(--accent)' : '#1d2129'}`, borderRadius: 12, overflow: 'hidden', background: '#12151b', cursor: 'pointer' }}>
              <div style={{ position: 'relative', height: 92, background: GRADS[i % GRADS.length], backgroundSize: 'cover', backgroundPosition: 'center', ...(v.thumb && v.thumb.startsWith('http') ? { backgroundImage: `url("${v.thumb}")` } : v.thumb && v.thumb.startsWith('linear-gradient') ? { background: v.thumb } : {}) }}>
                <div className="me-vidsel" style={{ position: 'absolute', top: 8, left: 8, width: 22, height: 22, borderRadius: 6, border: `1.5px solid ${on ? 'var(--accent)' : 'rgba(255,255,255,.5)'}`, background: on ? 'var(--accent)' : 'rgba(0,0,0,.45)', display: 'grid', placeItems: 'center', color: 'var(--accent-ink)' }}>{on ? '✓' : ''}</div>
                <div style={{ position: 'absolute', bottom: 7, right: 7, fontFamily: 'var(--font-mono)', fontSize: 10, background: 'rgba(0,0,0,.7)', color: '#dde0e5', padding: '2px 6px', borderRadius: 5 }}>{fmtDur(v.durationSec)}</div>
              </div>
              <div style={{ padding: '11px 12px' }}>
                <div style={{ fontSize: 12, color: '#dde0e5', lineHeight: 1.35, height: 33, overflow: 'hidden' }}>{v.title}</div>
                <div style={{ fontSize: 10.5, color: '#5b616f', fontFamily: 'var(--font-mono)', marginTop: 6 }}>{v.views > 0 ? `${v.views.toLocaleString()} views` : '— views'}</div>
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, borderTop: '1px solid #1d2129', paddingTop: 18 }}>
        <div style={{ fontSize: 13, color: '#8a909c' }}><b style={{ color: '#eef0f3', fontFamily: 'var(--font-display)' }}>{selected.length}</b> videos selected{selected.length > 0 ? ` · ~${estMb.toFixed(0)} MB` : ''}</div>
        <div style={{ flex: 1 }} />
        <button type="button" disabled={!selected.length || busy} onClick={() => void download(false)} className="me-btn" style={{ border: '1px solid #262b34', background: '#15181f', borderRadius: 10, padding: '11px 18px', fontSize: 12.5, color: '#c4cad3', cursor: selected.length && !busy ? 'pointer' : 'not-allowed', opacity: selected.length && !busy ? 1 : 0.45 }}>Download mp3 only</button>
        <button type="button" disabled={!selected.length || busy} onClick={() => void download(true)} className="me-btn" style={{ display: 'flex', alignItems: 'center', gap: 8, border: 0, background: 'linear-gradient(180deg,var(--accent),var(--accent-deep))', color: 'var(--accent-ink)', fontWeight: 600, fontSize: 12.5, padding: '11px 20px', borderRadius: 10, cursor: selected.length && !busy ? 'pointer' : 'not-allowed', boxShadow: '0 4px 16px -4px var(--accent-glow)', opacity: selected.length && !busy ? 1 : 0.45 }}>{busy ? 'Working…' : 'Add to queue'}<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M5 12h14M13 6l6 6-6 6" /></svg></button>
      </div>
      {message && <div style={{ marginTop: 10, fontSize: 12, color: message.includes('failed') || message.includes('usable') ? '#ff8a96' : '#8a909c' }}>{message}</div>}

      <div style={{ marginTop: 30 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 13 }}>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 15, color: '#e9ebef' }}>Already downloaded</span>
          <span style={{ fontSize: 11, color: '#6a7180' }}>— resume unfinished, don't re-fetch</span>
        </div>
        <div style={{ border: '1px solid #1d2129', borderRadius: 14, overflow: 'hidden', background: '#12151b' }}>
          <div style={{ display: 'flex', padding: '11px 16px', borderBottom: '1px solid #1d2129', fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.6px', color: '#5b616f' }}>
            <div style={{ flex: 2.4 }}>CLIP</div><div style={{ width: 120 }}>SOURCE</div><div style={{ width: 130 }}>STAGE</div><div style={{ width: 140 }}>PROGRESS</div><div style={{ width: 80, textAlign: 'right' }}>ACTION</div>
          </div>
          {downloads.length === 0 && (
            <div style={{ padding: '22px 16px', textAlign: 'center', fontSize: 12, color: '#5b616f' }}>Nothing downloaded yet.</div>
          )}
          {downloads.map((d) => {
            const live = dlProgress[d.id]
            const pct = live ? `${Math.round(live.pct)}%` : d.pct
            const done = pct === '100%'
            const barColor = done ? '#36c98e' : 'var(--accent)'
            const stageColor = done ? '#4fd6a0' : '#cdd2da'
            return (
              <div key={d.id} className="me-row" style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #14171d' }}>
                <div style={{ flex: 2.4, display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                  <div style={{ width: 48, height: 27, borderRadius: 6, background: d.thumb, flex: 'none' }} />
                  <div style={{ minWidth: 0 }}><div style={{ fontSize: 12.5, color: '#dde0e5', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.title}</div><div style={{ fontSize: 10, color: '#5b616f', fontFamily: 'var(--font-mono)' }}>{d.size} · {d.when}</div></div>
                </div>
                <div style={{ width: 120, fontSize: 11, color: '#8a909c', fontFamily: 'var(--font-mono)' }}>{d.channel}</div>
                <div style={{ width: 130, fontSize: 11.5, color: stageColor }}>{live?.stage ?? d.stage}</div>
                <div style={{ width: 140 }}><div style={{ height: 6, borderRadius: 4, background: '#1a1e26', overflow: 'hidden' }}><div style={{ width: pct, height: '100%', background: barColor }} /></div></div>
                <div style={{ width: 80, textAlign: 'right' }}><span onClick={() => void resumeDownload(d.id)} className="me-btn" style={{ display: 'inline-block', border: '1px solid #262b34', background: '#15181f', borderRadius: 7, padding: '6px 12px', fontSize: 11, color: '#dde0e5', cursor: 'pointer' }}>{d.action}</span></div>
              </div>
            )
          })}
        </div>
      </div>
    </ScreenPad>
  )
}
