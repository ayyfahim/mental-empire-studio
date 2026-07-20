import type { ReactNode } from 'react'
import { useStore } from '../store/useStore'
import { useData } from '../store/useData'
import { clickableProps } from './primitives'
import type { ScreenKey } from '@shared/types'
import { renderLiveState } from '../lib/renderProgress'

interface NavDef {
  key: ScreenKey
  label: string
  icon: ReactNode
  badge?: string
}

const icon = (children: ReactNode) => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">{children}</svg>
)

const HOME: NavDef[] = [
  { key: 'home', label: 'Home', icon: icon(<><rect x="3" y="4" width="8" height="7" rx="2" /><rect x="13" y="4" width="8" height="12" rx="2" /><rect x="3" y="13" width="8" height="7" rx="2" /><path d="M14 20h6" /></>) }
]

const CHANNELS: NavDef[] = [
  { key: 'sources', label: 'Sources', icon: icon(<><path d="M12 3v13" /><path d="M7 11l5 5 5-5" /><path d="M5 21h14" /></>) },
  { key: 'channels', label: 'My Channels', icon: icon(<><path d="M4 11a9 9 0 019-9" /><path d="M4 4a16 16 0 0116 16" /><circle cx="5" cy="19" r="1.6" /></>) },
]

const CREATE: NavDef[] = [
  { key: 'compose', label: 'Compose', icon: icon(<><path d="M12 3l8 4-8 4-8-4z" /><path d="M4 12l8 4 8-4" /><path d="M4 17l8 4 8-4" /></>) },
  { key: 'talking-video', label: 'Talking Video', icon: icon(<><circle cx="12" cy="9" r="4" /><path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7" /></>) },
  { key: 'thumb', label: 'Thumbnails', icon: icon(<><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M8 11h8" /><path d="M8 15h5" /></>) }
]

const OUTPUT: NavDef[] = [
  { key: 'render', label: 'Render Queue', icon: icon(<path d="M5 5l13 7-13 7z" />) },
  { key: 'publish', label: 'Publish', icon: icon(<><path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3" /></>) },
  { key: 'niches', label: 'B-roll Pools', icon: icon(<><rect x="3" y="4" width="14" height="10" rx="2" /><path d="M17 8l4-2v8l-4-2" /></>) },
  { key: 'profiles', label: 'Automations', icon: icon(<path d="M12 3l8 4v5c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V7z" />) },
  { key: 'settings', label: 'Settings', icon: icon(<><circle cx="12" cy="12" r="3.2" /><path d="M19.4 13.5a7.8 7.8 0 000-3l1.7-1.3-1.8-3.1-2 .8a7.6 7.6 0 00-2.6-1.5l-.3-2.1H8l-.3 2.1a7.6 7.6 0 00-2.6 1.5l-2-.8L1.3 9.2 3 10.5a7.8 7.8 0 000 3l-1.7 1.3 1.8 3.1 2-.8a7.6 7.6 0 002.6 1.5l.3 2.1h4l.3-2.1a7.6 7.6 0 002.6-1.5l2 .8 1.8-3.1z" /></>) }
]

function NavItem({ def, badge }: { def: NavDef; badge?: string }): JSX.Element {
  const active = useStore((s) => s.active)
  const setActive = useStore((s) => s.setActive)
  const on = active === def.key
  const shownBadge = badge ?? def.badge
  return (
    <div
      onClick={() => setActive(def.key)}
      {...clickableProps(() => setActive(def.key), def.label)}
      aria-current={on ? 'page' : undefined}
      className="me-nav"
      style={{
        display: 'flex', alignItems: 'center', gap: 11, padding: '9px 11px', borderRadius: 10,
        cursor: 'pointer', fontSize: 13, fontWeight: on ? 600 : 500,
        background: on ? 'var(--accent-soft)' : 'transparent',
        color: on ? '#f2f4f7' : '#8a909c', position: 'relative', marginBottom: 2
      }}
    >
      <span style={{ position: 'absolute', left: -12, top: 8, bottom: 8, width: 3, borderRadius: '0 4px 4px 0', background: on ? 'var(--accent)' : 'transparent', boxShadow: on ? '0 0 10px var(--accent-glow)' : 'none' }} />
      {def.icon}
      {def.label}
      {shownBadge && (
        <span style={{ marginLeft: 'auto', background: 'var(--accent)', color: 'var(--accent-ink)', fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)', padding: '1px 7px', borderRadius: 8 }}>{shownBadge}</span>
      )}
    </div>
  )
}

function Heading({ children }: { children: ReactNode }): JSX.Element {
  return <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 600, letterSpacing: '1.4px', color: '#454b57', padding: '8px 10px' }}>{children}</div>
}

export function Sidebar(): JSX.Element {
  const renderJobs = useData((s) => s.renderJobs)
  const renderProgress = useData((s) => s.renderProgress)
  const channels = useData((s) => s.channels)
  const sourceChannels = useData((s) => s.sourceChannels)
  const setActive = useStore((s) => s.setActive)
  const queued = renderJobs.filter((j) => {
    const state = renderLiveState(j, renderProgress[j.job.id])
    return state.status === 'queued' || state.status === 'rendering'
  }).length
  const watching = sourceChannels.filter((s) => s.autoWatch).length

  // Find the most active rendering job for the mini status strip
  const activeJob = renderJobs.find((j) => {
    return renderLiveState(j, renderProgress[j.job.id]).status === 'rendering'
  })
  const activePct = activeJob ? Math.round(renderLiveState(activeJob, renderProgress[activeJob.job.id]).pct) : 0

  return (
    <div className="me-sidebar" style={{ width: 'clamp(196px, 15vw, 236px)', flex: 'none', background: '#0a0c10', borderRight: '1px solid #1a1e26', display: 'flex', flexDirection: 'column', padding: '14px 12px', minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '6px 8px 16px' }}>
        <div style={{ width: 34, height: 34, borderRadius: 10, background: 'linear-gradient(135deg,var(--accent),var(--accent-deep))', display: 'grid', placeItems: 'center', fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--accent-ink)', fontSize: 14, boxShadow: '0 4px 14px -4px var(--accent-glow)', flex: 'none' }}>ME</div>
        <div className="me-sidebar-brand-text" style={{ lineHeight: 1.2, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 14, color: '#f2f4f7', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Mental Empire</div>
          <div style={{ fontSize: 10.5, color: '#5b616f', fontFamily: 'var(--font-mono)', letterSpacing: '.3px' }}>studio v{window.api?.appVersion || '0.1.0'}</div>
        </div>
      </div>

      <Heading>HOME</Heading>
      {HOME.map((d) => <NavItem key={d.key} def={d} />)}

      <div style={{ paddingTop: 8 }}><Heading>CHANNELS</Heading></div>
      {CHANNELS.map((d) => <NavItem key={d.key} def={d} />)}

      <div style={{ paddingTop: 8 }}><Heading>CREATE</Heading></div>
      {CREATE.map((d) => <NavItem key={d.key} def={d} />)}

      <div style={{ paddingTop: 8 }}><Heading>OUTPUT</Heading></div>
      {OUTPUT.map((d) => (
        <NavItem key={d.key} def={d} badge={d.key === 'render' && queued > 0 ? String(queued) : undefined} />
      ))}

      <div style={{ flex: 1, minHeight: 12 }} />

      {/* Mini render-status strip — only visible when a job is actively rendering */}
      {activeJob && (
        <div
          onClick={() => setActive('render')}
          className="me-btn"
          style={{ border: '1px solid #262b34', borderRadius: 10, padding: '9px 11px', background: '#0e1116', cursor: 'pointer', marginBottom: 10 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', animation: 'mePulse 1.4s infinite', flex: 'none' }} />
            <span style={{ fontSize: 10.5, color: '#cdd2da', fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeJob.job.title}</span>
            <span style={{ fontSize: 9.5, color: 'var(--accent)', fontFamily: 'var(--font-mono)', flex: 'none' }}>{activePct}%</span>
          </div>
          <div style={{ height: 4, borderRadius: 3, background: '#1a1e26', overflow: 'hidden' }}>
            <div style={{ width: `${activePct}%`, height: '100%', background: 'linear-gradient(90deg,var(--accent),var(--accent-deep))', transition: 'width .4s ease' }} />
          </div>
        </div>
      )}

      <div className="me-sidebar-status" style={{ border: '1px solid #1d2129', borderRadius: 12, padding: 12, background: 'linear-gradient(180deg,#10141a,#0c0f13)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: watching > 0 ? '#36c98e' : '#5b616f', boxShadow: watching > 0 ? '0 0 8px #36c98e' : 'none', animation: watching > 0 ? 'mePulse 2s infinite' : 'none' }} />
          <span style={{ fontSize: 11, fontWeight: 600, color: '#cdd2da' }}>{watching > 0 ? 'Auto-watch active' : 'Auto-watch off'}</span>
        </div>
        <div style={{ fontSize: 10.5, color: '#6a7180', lineHeight: 1.5 }}>
          {watching > 0
            ? `${watching} source${watching === 1 ? '' : 's'} watching · ${channels.length} channel${channels.length === 1 ? '' : 's'}`
            : 'Enable auto-watch on a source to run hands-free.'}
        </div>
      </div>
    </div>
  )
}
