import { useStore } from '../store/useStore'
import { useData } from '../store/useData'
import { ScreenPad } from '../components/primitives'
import { statusStyle } from '../data/mock'

const GRADIENTS = [
  'linear-gradient(135deg,#2a2540,#46243a)', 'linear-gradient(135deg,#1a2e3a,#0f3a32)',
  'linear-gradient(135deg,#23304a,#1a2438)', 'linear-gradient(135deg,#16323a,#0f2630)',
  'linear-gradient(135deg,#3a2440,#2a1530)'
]

function mediaSrc(path: string | undefined): string {
  if (!path) return ''
  if (/^(https?:|data:|file:)/.test(path)) return path
  return `file:///${path.replace(/\\/g, '/')}`
}

/** Parse a humanized count ("12.4K" / "2.1M") back to a number for aggregation. */
function parseHuman(s: string): number {
  const m = s.trim().match(/^([\d.]+)\s*([KM])?$/i)
  if (!m) return 0
  const n = parseFloat(m[1])
  const unit = (m[2] || '').toUpperCase()
  return unit === 'M' ? n * 1e6 : unit === 'K' ? n * 1e3 : n
}
function human(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`
  return Math.round(n).toLocaleString()
}
/** Deterministic 8-bar sparkline from a string seed (no per-video data yet). */
function barsFor(seed: string): number[] {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return Array.from({ length: 8 }, (_, i) => 40 + ((h >> (i * 3)) % 60))
}

function Kpi({ label, value, sub, accentCard }: { label: string; value: string; sub: JSX.Element; accentCard?: boolean }): JSX.Element {
  return (
    <div className="me-card" style={{ border: accentCard ? '1px solid var(--accent)' : '1px solid #1d2129', borderRadius: 15, padding: 18, background: accentCard ? 'linear-gradient(165deg,var(--accent-soft),#0f1217)' : 'linear-gradient(165deg,#14171e,#0f1217)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.8px', color: accentCard ? '#cdd2da' : '#6a7180' }}>{label}</span>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="2.6" /></svg>
      </div>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 30, color: '#f4f6f9', letterSpacing: '-1px' }}>{value}</div>
      <div style={{ marginTop: 6 }}>{sub}</div>
    </div>
  )
}

const muted = (txt: string) => <div style={{ fontSize: 11.5, color: '#6a7180' }}>{txt}</div>

export function Library(): JSX.Element {
  const showRail = useStore((s) => s.showActivityRail)
  const channels = useData((s) => s.channels)
  const recentUploads = useData((s) => s.recentUploads)
  const activity = useData((s) => s.activity)
  const downloads = useData((s) => s.downloads)
  const renderJobs = useData((s) => s.renderJobs)
  const scraping = useData((s) => s.scraping)
  const rescrapeAll = useData((s) => s.rescrapeAll)
  const greet = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }).toUpperCase()
  const hr = new Date().getHours()
  const timeOfDay = hr < 12 ? 'morning' : hr < 18 ? 'afternoon' : 'evening'

  const totalViews = channels.reduce((a, c) => a + parseHuman(c.views), 0)
  const totalSubs = channels.reduce((a, c) => a + parseHuman(c.subs), 0)
  const totalUploaded = channels.reduce((a, c) => a + (c.total || 0), 0)
  const inQueue = renderJobs.filter((r) => r.job.status === 'queued' || r.job.status === 'rendering').length

  return (
    <ScreenPad>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginBottom: 26 }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '1px', color: 'var(--accent)', marginBottom: 7 }}>{greet}</div>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 27, letterSpacing: '-.5px', color: '#f4f6f9', lineHeight: 1 }}>Good {timeOfDay} — {channels.length === 0 ? 'add a channel to begin' : `${channels.length} channel${channels.length === 1 ? '' : 's'} running`}</div>
        </div>
        <div style={{ flex: 1 }} />
        <div onClick={() => void rescrapeAll()} className="me-btn" style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid #262b34', background: '#15181f', borderRadius: 10, padding: '9px 14px', fontSize: 12.5, color: '#c4cad3', cursor: 'pointer' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 11-3-6.7M21 4v5h-5" /></svg>{scraping ? 'Scraping…' : 'Re-scrape'}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 24 }}>
        <Kpi label="TOTAL VIEWS" value={human(totalViews)} sub={muted(channels.length ? 'across all channels' : 'no channels yet')} />
        <Kpi label="SUBSCRIBERS" value={human(totalSubs)} sub={muted(channels.length ? `across ${channels.length} channels` : 'add a channel to start')} />
        <Kpi label="UPLOADED" value={String(totalUploaded)} sub={<div style={{ fontSize: 11.5, color: '#6a7180' }}>across {channels.length} channels</div>} />
        <Kpi label="IN QUEUE" value={String(inQueue)} sub={<div style={{ fontSize: 11.5, color: '#cdd2da' }}>{downloads.length} downloaded</div>} accentCard />
      </div>

      <div style={{ display: 'flex', gap: 22, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 15, color: '#e9ebef' }}>Your channels</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: '#5b616f', border: '1px solid #23272f', borderRadius: 5, padding: '2px 7px' }}>scraped · no API</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 13, marginBottom: 26 }}>
            {channels.map((ch) => (
              <div key={ch.id} className="me-card" style={{ border: '1px solid #1d2129', borderRadius: 14, padding: 15, background: '#12151b' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 13 }}>
                  <div style={{ width: 38, height: 38, borderRadius: 10, background: ch.avatar, display: 'grid', placeItems: 'center', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, color: '#0c0d11' }}>{ch.mono}</div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, color: '#eef0f3', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ch.name}</div>
                    <div style={{ fontSize: 10.5, color: '#6a7180', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ch.handle}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 40, marginBottom: 12 }}>
                  {barsFor(ch.handle).map((h, i) => (
                    <div key={i} style={{ flex: 1, borderRadius: '3px 3px 0 0', background: 'linear-gradient(180deg,var(--accent),var(--accent-deep))', opacity: 0.85, height: `${h}%` }} />
                  ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #1d2129', paddingTop: 11 }}>
                  <div><div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 15, color: '#eef0f3' }}>{ch.views}</div><div style={{ fontSize: 9.5, color: '#5b616f', fontFamily: 'var(--font-mono)' }}>VIEWS</div></div>
                  <div><div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 15, color: '#eef0f3' }}>{ch.subs}</div><div style={{ fontSize: 9.5, color: '#5b616f', fontFamily: 'var(--font-mono)' }}>SUBS</div></div>
                  <div><div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 15, color: 'var(--accent)' }}>{ch.mapTotal > 0 ? `${ch.mapDone}/${ch.mapTotal}` : ch.total}</div><div style={{ fontSize: 9.5, color: '#5b616f', fontFamily: 'var(--font-mono)' }}>DONE</div></div>
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 13 }}>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 15, color: '#e9ebef' }}>Recent uploads</span>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11.5, color: 'var(--accent)', cursor: 'pointer' }}>View all →</span>
          </div>
          <div style={{ border: '1px solid #1d2129', borderRadius: 14, overflow: 'hidden', background: '#12151b' }}>
            <div style={{ display: 'flex', padding: '11px 16px', borderBottom: '1px solid #1d2129', fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.6px', color: '#5b616f' }}>
              <div style={{ flex: 2.4 }}>VIDEO</div><div style={{ width: 120 }}>CHANNEL</div><div style={{ width: 108, textAlign: 'center' }}>STATUS</div><div style={{ width: 64, textAlign: 'right' }}>VIEWS</div><div style={{ width: 62, textAlign: 'right' }}>AGE</div>
            </div>
            {recentUploads.length === 0 && (
              <div style={{ padding: '22px 16px', textAlign: 'center', fontSize: 12, color: '#5b616f' }}>No uploads yet — scrape a channel to populate.</div>
            )}
            {recentUploads.map((u, i) => {
              const s = statusStyle.Uploaded
              return (
                <div key={`${u.title}-${i}`} className="me-row" style={{ display: 'flex', alignItems: 'center', padding: '11px 16px', borderBottom: '1px solid #14171d' }}>
                  <div style={{ flex: 2.4, display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
                    <div style={{ width: 46, height: 26, borderRadius: 5, background: GRADIENTS[i % GRADIENTS.length], flex: 'none', overflow: 'hidden' }}>{u.thumb && <img src={mediaSrc(u.thumb)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}</div>
                    <span style={{ fontSize: 12.5, color: '#dde0e5', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.title}</span>
                  </div>
                  <div style={{ width: 120, fontSize: 11.5, color: '#8a909c' }}>{u.channel}</div>
                  <div style={{ width: 108, textAlign: 'center' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 600, borderRadius: 20, padding: '3px 10px', background: s.bg, color: s.color }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.dot }} />Uploaded
                    </span>
                  </div>
                  <div style={{ width: 64, textAlign: 'right', fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 12.5, color: u.views ? '#dde0e5' : '#6a7180' }}>{u.views || 'unavailable'}</div>
                  <div style={{ width: 62, textAlign: 'right', fontSize: 11, color: '#6a7180', fontFamily: 'var(--font-mono)' }}>{u.publishedAt || '—'}</div>
                </div>
              )
            })}
          </div>
        </div>

        {showRail && (
          <div style={{ width: 268, flex: 'none', display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ border: '1px solid #1d2129', borderRadius: 14, padding: 16, background: '#12151b' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#36c98e', boxShadow: '0 0 8px #36c98e' }} />
                <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 13, color: '#e9ebef' }}>Activity</span>
                <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 9.5, color: '#5b616f' }}>live</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
                {activity.length === 0 && (
                  <div style={{ fontSize: 11, color: '#5b616f', lineHeight: 1.5 }}>No activity yet. Scrape, download, or render to see events here.</div>
                )}
                {activity.map((a, i) => (
                  <div key={i} style={{ display: 'flex', gap: 10 }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: '#4f5662', flex: 'none', width: 32, paddingTop: 1 }}>{a.t}</span>
                    <span style={{ color: a.color, flex: 'none' }}>{a.icon}</span>
                    <span style={{ fontSize: 11.5, color: '#aab0bb', lineHeight: 1.4 }}>{a.text}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ border: '1px solid var(--accent)', borderRadius: 14, padding: 16, background: 'linear-gradient(165deg,var(--accent-soft),#0f1217)' }}>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 13, color: '#f2f4f7', marginBottom: 6 }}>Auto-scrape</div>
              <div style={{ fontSize: 11.5, color: '#aab0bb', lineHeight: 1.5, marginBottom: 13 }}>{channels.length ? <>Re-scrape {channels.length} channel{channels.length === 1 ? '' : 's'} for new uploads + stats.</> : <>Add a channel, then re-scrape to pull stats &amp; uploads.</>}</div>
              <div onClick={() => void rescrapeAll()} className="me-btn" style={{ textAlign: 'center', border: '1px solid #2a2f39', background: '#15181f', borderRadius: 9, padding: 8, fontSize: 12, fontWeight: 600, color: '#dde0e5', cursor: 'pointer' }}>{scraping ? 'Scraping…' : 'Run now'}</div>
            </div>
          </div>
        )}
      </div>
    </ScreenPad>
  )
}
