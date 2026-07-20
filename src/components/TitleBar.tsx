import { useStore } from '../store/useStore'
import { useData } from '../store/useData'
import { clickableProps } from './primitives'
import type { ScreenKey } from '@shared/types'

const LABELS: Record<ScreenKey, string> = {
  home: 'Home',
  library: 'Home',
  workspace: 'Home',
  channels: 'My Channels',
  sources: 'Sources',
  download: 'Download',
  compose: 'Compose',
  'talking-video': 'Talking Video',
  thumb: 'Thumbnails',
  render: 'Render Queue',
  publish: 'Publish',
  niches: 'B-roll Pools',
  profiles: 'Automations',
  settings: 'Settings'
}

function winCtl(action: 'minimize' | 'maximize' | 'close') {
  return () => window.api?.[action]?.()
}

export function TitleBar(): JSX.Element {
  const active = useStore((s) => s.active)
  const setActive = useStore((s) => s.setActive)
  const rows = useData((s) => s.renderJobs)
  const rendering = useData((s) => s.rendering)
  const renderAll = useData((s) => s.renderAll)
  const queuedRows = rows.filter((r) => r.job.status === 'queued')
  const canRender = queuedRows.length > 0 && queuedRows.every((r) => r.isReady) && !rendering
  const handleRenderAll = (): void => {
    setActive('render')
    if (canRender) void renderAll()
  }

  return (
    <div
      className="drag-region"
      style={{
        height: 48, flex: 'none', background: 'linear-gradient(180deg,#14161d,#101218)',
        display: 'flex', alignItems: 'center', padding: '0 18px', gap: 14,
        borderBottom: '1px solid #1d2129', position: 'relative', zIndex: 5
      }}
    >
      <div className="no-drag" style={{ display: 'flex', gap: 8 }}>
        <span onClick={winCtl('close')} {...clickableProps(winCtl('close'), 'Close window')} style={{ width: 12, height: 12, borderRadius: '50%', background: '#ff5f57', cursor: 'pointer' }} />
        <span onClick={winCtl('minimize')} {...clickableProps(winCtl('minimize'), 'Minimize window')} style={{ width: 12, height: 12, borderRadius: '50%', background: '#febc2e', cursor: 'pointer' }} />
        <span onClick={winCtl('maximize')} {...clickableProps(winCtl('maximize'), 'Maximize window')} style={{ width: 12, height: 12, borderRadius: '50%', background: '#28c840', cursor: 'pointer' }} />
      </div>
      <div style={{ width: 1, height: 20, background: '#23272f' }} />
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '.5px', color: '#6a7180', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        studio / {LABELS[active]}
      </div>
      <div style={{ flex: 1 }} />
      <div className="no-drag me-title-search" style={{ display: 'flex', alignItems: 'center', gap: 7, background: '#15171e', border: '1px solid #23272f', borderRadius: 9, padding: '7px 12px', width: 'clamp(150px, 18vw, 230px)', minWidth: 0 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5b616f" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
        <span style={{ fontSize: 12.5, color: '#5b616f' }}>Search channels, jobs…</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10, color: '#444b57', border: '1px solid #262b34', borderRadius: 4, padding: '1px 5px' }}>⌘K</span>
      </div>
      <button type="button" onClick={handleRenderAll} disabled={rendering} className="me-btn no-drag me-title-render" title={canRender ? 'Render all queued jobs' : 'Open Render Queue'} style={{ display: 'flex', alignItems: 'center', gap: 8, border: 0, background: 'linear-gradient(180deg,var(--accent),var(--accent-deep))', color: 'var(--accent-ink)', fontWeight: 600, fontSize: 12.5, padding: '8px 15px', borderRadius: 9, cursor: rendering ? 'not-allowed' : 'pointer', boxShadow: '0 4px 16px -4px var(--accent-glow)', whiteSpace: 'nowrap', opacity: rendering ? 0.6 : 1 }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M5 4l14 8-14 8z" /></svg>{rendering ? 'Rendering…' : 'Render all'}
      </button>
      <div style={{ width: 30, height: 30, borderRadius: 9, background: 'linear-gradient(135deg,#3a3f4d,#23262f)', border: '1px solid #2c303b', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 700, color: '#aab1bf' }}>A</div>
    </div>
  )
}
