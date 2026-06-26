import { useEffect } from 'react'
import { ScreenPad } from '../components/primitives'
import { useStore } from '../store/useStore'
import { useData } from '../store/useData'
import type { RenderQueueRow, RenderStatus } from '@shared/types'

const STATUS_TEXT: Record<RenderStatus, { text: string; color: string }> = {
  queued: { text: 'queued', color: '#8a909c' },
  rendering: { text: 'rendering', color: '#f5b323' },
  done: { text: 'done', color: '#4fd6a0' },
  error: { text: 'failed', color: '#ff8a96' }
}

const THUMB_BG = 'linear-gradient(135deg,#2a2540,#46243a)'

function mediaSrc(path: string | undefined): string {
  if (!path) return ''
  if (/^(https?:|data:|file:)/.test(path)) return path
  return `file:///${path.replace(/\\/g, '/')}`
}

function check(on: boolean, count?: number): JSX.Element {
  if (count !== undefined) return <span style={{ fontSize: 12, color: '#aab0bb', fontFamily: 'var(--font-mono)' }}>{count}</span>
  return <span style={{ color: on ? '#36c98e' : '#ff5a6e' }}>{on ? '✓' : '!'}</span>
}

export function RenderQueue(): JSX.Element {
  const rows = useData((s) => s.renderJobs)
  const progress = useData((s) => s.renderProgress)
  const rendering = useData((s) => s.rendering)
  const loadRenderJobs = useData((s) => s.loadRenderJobs)
  const renderAll = useData((s) => s.renderAll)
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)

  useEffect(() => {
    void loadRenderJobs()
  }, [loadRenderJobs])

  const live = (r: RenderQueueRow): { pct: number; status: RenderStatus } => {
    const p = progress[r.job.id]
    const pct = p ? p.pct : r.job.pct
    const status: RenderStatus = p ? (p.done ? (p.error ? 'error' : 'done') : 'rendering') : r.job.status
    return { pct, status }
  }
  const processing = rows.filter((r) => live(r).status === 'rendering').length
  const outputFolder = settings.outputFolder || '<Downloads>/MentalEmpire_out'
  const canRender = rows.length > 0 && rows.every((r) => r.isReady) && !rendering

  const browse = async (): Promise<void> => {
    const dir = await window.api?.chooseFolder?.()
    if (dir) updateSettings({ outputFolder: dir })
  }

  return (
    <ScreenPad>
      <div style={{ display: 'flex', alignItems: 'flex-end', marginBottom: 22 }}>
        <div><div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '1px', color: 'var(--accent)', marginBottom: 7 }}>STEP 05 — RENDER</div><div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 25, letterSpacing: '-.5px', color: '#f4f6f9' }}>Render queue</div></div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#8a909c' }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', animation: 'mePulse 1.6s infinite' }} />{processing} of {rows.length} processing · {settings.concurrency} parallel</div>
      </div>

      <div style={{ border: '1px solid #1d2129', borderRadius: 14, overflow: 'hidden', background: '#12151b', marginBottom: 20 }}>
        <div style={{ display: 'flex', padding: '12px 18px', borderBottom: '1px solid #1d2129', fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.6px', color: '#5b616f' }}>
          <div style={{ flex: 2.2 }}>VIDEO</div><div style={{ width: 70, textAlign: 'center' }}>MP3</div><div style={{ width: 74, textAlign: 'center' }}>IMAGES</div><div style={{ width: 70, textAlign: 'center' }}>THUMB</div><div style={{ width: 80, textAlign: 'center' }}>CAPTIONS</div><div style={{ width: 170 }}>STATUS</div>
        </div>
        {rows.length === 0 && (
          <div style={{ padding: '28px 18px', textAlign: 'center', fontSize: 12.5, color: '#6a7180' }}>Nothing queued yet — compose a video and hit “Save &amp; send to render”.</div>
        )}
        {rows.map((r) => {
          const { pct, status } = live(r)
          const st = STATUS_TEXT[status]
          const barColor = status === 'done' ? '#36c98e' : status === 'error' ? '#ff5a6e' : 'var(--accent)'
          return (
            <div key={r.job.id} className="me-row" style={{ display: 'flex', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid #14171d' }}>
              <div style={{ flex: 2.2, display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                <div style={{ width: 50, height: 28, borderRadius: 6, background: THUMB_BG, flex: 'none', overflow: 'hidden' }}>{r.firstImagePath && <img src={mediaSrc(r.firstImagePath)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}</div>
                <div style={{ minWidth: 0 }}><div style={{ fontSize: 13, color: '#dde0e5', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.job.title}</div><div style={{ fontSize: 10.5, color: '#5b616f', fontFamily: 'var(--font-mono)' }}>{r.job.channel}{r.missing.length ? ` · missing ${r.missing.join(', ')}` : ''}</div></div>
              </div>
              <div style={{ width: 70, textAlign: 'center' }}>{check(r.hasMp3)}</div>
              <div style={{ width: 74, textAlign: 'center' }}>{check(true, r.images)}</div>
              <div style={{ width: 70, textAlign: 'center' }}>{check(r.hasThumb)}</div>
              <div style={{ width: 80, textAlign: 'center' }}>{check(r.hasCaptions)}</div>
              <div style={{ width: 170 }}><div style={{ display: 'flex', alignItems: 'center', gap: 9 }}><div style={{ flex: 1, height: 6, borderRadius: 4, background: '#1a1e26', overflow: 'hidden' }}><div style={{ width: `${pct}%`, height: '100%', background: barColor }} /></div><span style={{ fontSize: 10.5, color: r.isReady ? st.color : '#ff8a96', fontFamily: 'var(--font-mono)', width: 56 }}>{!r.isReady && status === 'queued' ? 'blocked' : status === 'rendering' ? `${pct}%` : st.text}</span></div></div>
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, borderTop: '1px solid #1d2129', paddingTop: 20 }}>
        <div style={{ flex: 1, maxWidth: 430 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.6px', color: '#5b616f', marginBottom: 7 }}>OUTPUT FOLDER</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1, border: '1px solid #23272f', borderRadius: 9, padding: '10px 13px', fontSize: 12, color: '#aab0bb', fontFamily: 'var(--font-mono)', background: '#0e1116', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{outputFolder}</div>
            <button type="button" onClick={browse} className="me-btn" style={{ border: '1px solid #262b34', background: '#15181f', borderRadius: 9, padding: '10px 14px', fontSize: 12, color: '#c4cad3', cursor: 'pointer' }}>Browse</button>
          </div>
        </div>
        <div><div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.6px', color: '#5b616f', marginBottom: 7 }}>FORMAT</div><div style={{ border: '1px solid #23272f', borderRadius: 9, padding: '10px 14px', fontSize: 12, color: '#dde0e5', background: '#0e1116' }}>mp4 · {settings.quality} ▾</div></div>
        <div style={{ flex: 1 }} />
        <button type="button" disabled={!canRender} onClick={() => void renderAll()} className="me-btn" title={!rows.length ? 'No render jobs queued' : rows.some((r) => !r.isReady) ? 'Fix missing MP3, images, thumbnail, and captions before rendering' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 9, border: 0, background: 'linear-gradient(180deg,var(--accent),var(--accent-deep))', color: 'var(--accent-ink)', fontWeight: 600, fontSize: 13.5, padding: '13px 26px', borderRadius: 11, cursor: canRender ? 'pointer' : 'not-allowed', boxShadow: '0 6px 20px -5px var(--accent-glow)', opacity: canRender ? 1 : 0.5 }}><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M5 4l14 8-14 8z" /></svg>{rendering ? 'Rendering…' : `Render all (${rows.length})`}</button>
      </div>
      {rows.some((r) => !r.isReady) && <div style={{ marginTop: 10, fontSize: 12, color: '#ff8a96', textAlign: 'right' }}>Fix blocked rows in Compose/Thumbnails before rendering.</div>}
    </ScreenPad>
  )
}
