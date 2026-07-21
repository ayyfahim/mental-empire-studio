import { useEffect, useState, useCallback } from 'react'
import { ScreenPad, Toggle } from '../components/primitives'
import { useData } from '../store/useData'
import { useStore } from '../store/useStore'
import { useTalkingPhotos } from '../store/useTalkingPhotos'
import { describeTalkingPhotosCapabilities } from '@shared/talkingphotos'
import type { AccentName, AppSettings, RenderCapabilities } from '@shared/types'

const ACCENTS: AccentName[] = ['Amber', 'Violet', 'Emerald', 'Crimson']
const ACCENT_SWATCH: Record<AccentName, string> = { Amber: '#f5b323', Violet: '#8b7cff', Emerald: '#36c98e', Crimson: '#ff5a6e' }

const RENDER_ENGINES: Array<{ value: NonNullable<AppSettings['renderEngine']>; label: string; note: string }> = [
  { value: 'ffmpeg', label: 'ffmpeg', note: 'CPU filtergraph — the stable default. Works everywhere.' },
  { value: 'gpu', label: 'GPU', note: 'WebGL compositor + WebCodecs hardware H.264. With a GPU encoder selected, failures stop visibly instead of falling back to CPU filters.' },
  { value: 'auto', label: 'Auto', note: 'Use the GPU engine when hardware H.264 encode is available, otherwise ffmpeg.' },
]

type Section = 'looks' | 'output' | 'scraping' | 'integrations' | 'beta' | 'advanced' | 'danger'
const NAV: Array<{ id: Section; label: string }> = [
  { id: 'looks', label: 'Looks' },
  { id: 'output', label: 'Output & Quality' },
  { id: 'scraping', label: 'Scraping' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'beta', label: 'Video effects' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'danger', label: 'Danger zone' },
]

function Card({ label, children }: { label?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ border: '1px solid #1d2129', borderRadius: 14, padding: 18, background: '#12151b', marginBottom: 16 }}>
      {label && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.6px', color: '#5b616f', marginBottom: 13 }}>{label}</div>}
      {children}
    </div>
  )
}

const CONNECTION_STATUS_LABEL: Record<string, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  waiting_for_login: 'Waiting for login…',
  verifying: 'Verifying session…',
  reauth_required: 'Reconnect required',
  attention: 'Needs attention',
  disconnected: 'Not connected'
}

const CONNECTION_STATUS_DOT: Record<string, string> = {
  connected: '#4fd6a0',
  connecting: '#f5b323',
  waiting_for_login: '#f5b323',
  verifying: '#f5b323',
  reauth_required: '#ff8a96',
  attention: '#ff8a96',
  disconnected: '#5b616f'
}

function TalkingPhotosCard({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }): JSX.Element {
  const { connection, connecting, capabilities, connect, reconnect, disconnect, init } = useTalkingPhotos()
  useEffect(() => { if (enabled) void init() }, [enabled, init])
  const status = connection?.status ?? 'disconnected'
  const canRetryHeadlessly = status === 'reauth_required'
  const capabilitySummary = describeTalkingPhotosCapabilities(status, capabilities ?? null)

  return (
    <Card label="TALKINGPHOTOS.AI">
      <Row on={enabled} label="Enable TalkingPhotos integration" hint="Cloud Human-video provider with uploaded-audio creation, durable progress sync, and output download." onClick={onToggle} />
      {enabled && (
        <div style={{ marginTop: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid #1d2129', borderRadius: 9, padding: '9px 13px', background: '#0e1116', marginBottom: 8 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: CONNECTION_STATUS_DOT[status] ?? '#5b616f', flex: 'none' }} />
            <span style={{ fontSize: 12, color: '#cdd2da', flex: 1 }}>
              {CONNECTION_STATUS_LABEL[status] ?? 'Not connected'}
              {connection?.lastVerifiedAt && status === 'connected' ? ` · verified ${new Date(connection.lastVerifiedAt).toLocaleTimeString()}` : ''}
            </span>
            {status === 'connected' ? (
              <div className="me-btn" onClick={() => void disconnect()} style={{ border: '1px solid #262b34', borderRadius: 7, padding: '6px 12px', fontSize: 11, color: '#c4cad3', cursor: 'pointer' }}>Disconnect</div>
            ) : (
              <div
                className="me-btn"
                onClick={connecting ? undefined : () => void (canRetryHeadlessly ? reconnect() : connect())}
                style={{ border: '1px solid var(--accent)', color: 'var(--accent)', borderRadius: 7, padding: '6px 12px', fontSize: 11, cursor: connecting ? 'not-allowed' : 'pointer', opacity: connecting ? 0.6 : 1 }}
              >
                {connecting ? (CONNECTION_STATUS_LABEL[status] ?? 'Connecting…') : status === 'reauth_required' ? 'Reconnect' : status === 'attention' ? 'Retry' : 'Connect'}
              </div>
            )}
          </div>
          {connection?.lastError && status !== 'connected' && (
            <div style={{ fontSize: 10.5, color: '#ff8a96', marginBottom: 8 }}>{connection.lastError}</div>
          )}
          {status === 'connected' && capabilities && (
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 10.5, color: '#6a7180' }}>
              <span>Max duration <b style={{ color: '#aab0bb' }}>{capabilities.limits.maxDurationSeconds}s</b></span>
              <span>Max TTS chars <b style={{ color: '#aab0bb' }}>{capabilities.limits.maxCharactersTts}</b></span>
              <span>Concurrent <b style={{ color: '#aab0bb' }}>{capabilities.usage.concurrentCount}/{capabilities.usage.concurrentLimit}</b></span>
              <span>Daily <b style={{ color: '#aab0bb' }}>{capabilities.usage.dailyUsage}/{capabilities.usage.dailyLimit}</b></span>
            </div>
          )}
          <div style={{ fontSize: 10.5, color: '#5b616f', marginTop: 8 }}>{capabilitySummary.statusText}</div>
        </div>
      )}
    </Card>
  )
}

function Row({ on, label, onClick, hint }: { on: boolean; label: string; onClick?: () => void; hint?: string }): JSX.Element {
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', border: '1px solid #1d2129', borderRadius: 9, padding: '11px 13px', background: '#0e1116', cursor: onClick ? 'pointer' : undefined, gap: 10, marginBottom: 8 }}>
      <div style={{ flex: 1 }}>
        <div style={{ color: on ? '#cdd2da' : '#6a7180', fontSize: 12.5 }}>{label}</div>
        {hint && <div style={{ fontSize: 10.5, color: '#5b616f', marginTop: 2 }}>{hint}</div>}
      </div>
      <Toggle on={on} />
    </div>
  )
}

export function Settings(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const resetAll = useStore((s) => s.resetAll)
  const { accent, setAccent, ambientGlow, toggleAmbientGlow, showActivityRail, toggleActivityRail } = useStore()
  const renderJobs = useData((s) => s.renderJobs)
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  const jobsThisWeek = renderJobs.filter((r) => r.job.status === 'done' && Date.parse(r.job.createdAt || '') >= weekAgo).length
  const { quality, autoScrape, background } = settings
  const [caps, setCaps] = useState<RenderCapabilities | null>(null)
  const [checkingCaps, setCheckingCaps] = useState(true)
  const [section, setSection] = useState<Section>('looks')
  const [savedAt, setSavedAt] = useState(0)

  const saved = useCallback((patch: Parameters<typeof updateSettings>[0]) => {
    updateSettings(patch)
    setSavedAt(Date.now())
  }, [updateSettings])

  useEffect(() => { void refreshCaps() }, [])

  const refreshCaps = async (force = false): Promise<void> => {
    setCheckingCaps(true)
    try { setCaps(await window.api?.caps?.get?.(force) ?? null) } catch { setCaps(null) } finally { setCheckingCaps(false) }
  }

  const onReset = (): void => {
    if (window.confirm('Reset everything to default settings?\n\nDeletes all channels, profiles, projects, downloads, thumbnail templates and the render queue. Cannot be undone.')) void resetAll()
  }
  const onSoftReset = async (): Promise<void> => {
    if (!window.confirm('Reset data and keep API keys?\n\nDeletes channels, profiles, projects, downloads and render queue, but keeps API keys, appearance and templates. Cannot be undone.')) return
    await window.api?.settings?.softReset?.()
    window.location.reload()
  }

  const qualities: AppSettings['quality'][] = ['720p', '1080p', '1440p']
  const nvidiaName = caps?.nvidiaGpuName?.trim()
  const nvencProbeHint = caps?.nvencProbeError ? ` Probe: ${caps.nvencProbeError.slice(0, 180)}` : ''
  const encoders = [
    { value: 'cpu' as const, label: 'CPU', warning: false, note: 'libx264 — always available.' },
    {
      value: 'nvenc' as const,
      label: 'NVENC',
      warning: !!caps && !caps.hasNvenc,
      note: caps?.hasNvenc
        ? `NVIDIA NVENC ready${nvidiaName ? ` (${nvidiaName})` : ''}${caps.ffmpegHasCuda ? ' + CUDA filters for B-roll' : ''}`
        : caps?.hasNvencListed
          ? `NVIDIA NVENC is listed${nvidiaName ? ` for ${nvidiaName}` : ''}, but the live probe failed. Renders will try NVENC and fail visibly; CPU fallback is disabled.${nvencProbeHint}`
          : nvidiaName
            ? `NVIDIA GPU detected (${nvidiaName}), but this ffmpeg build does not list h264_nvenc. Recheck after updating ffmpeg/driver; CPU fallback stays disabled.`
            : 'NVENC is not verified by ffmpeg yet. Your choice will still be saved; renders will try NVENC and fail visibly if the driver/ffmpeg cannot use it.'
    },
    { value: 'qsv' as const, label: 'QSV', warning: !!caps && !caps.hasQsv, note: caps?.hasQsv ? 'Intel QSV ready' : caps?.hasQsvListed ? 'Intel QSV is listed by ffmpeg, but the live probe failed. Choice is saved; CPU fallback is disabled.' : 'Intel QSV is not verified by ffmpeg. Choice is saved; renders will fail visibly if unavailable.' },
    { value: 'amf' as const, label: 'AMF', warning: !!caps && !caps.hasAmf, note: caps?.hasAmf ? 'AMD AMF ready' : nvidiaName ? `AMF is for AMD GPUs. This machine reports ${nvidiaName}; choose NVENC for NVIDIA unless you also have AMD hardware.` : caps?.hasAmfListed ? 'AMD AMF is listed by ffmpeg, but the live probe failed. Choice is saved; CPU fallback is disabled.' : 'AMD AMF is not verified by ffmpeg. Choice is saved; renders will fail visibly if unavailable.' },
  ]
  const selectedEncoder = encoders.find((e) => e.value === (settings.encoder ?? 'cpu')) ?? encoders[0]
  const confirmFloor = settings.detection.confirmBand[0] ?? 0.6
  const confirmCeil = settings.detection.confirmBand[1] ?? 0.82
  const chooseEncoder = (enc: typeof encoders[number]): void => {
    saved({ encoder: enc.value, renderEngine: enc.value === 'cpu' ? 'ffmpeg' : 'gpu' })
    if (enc.value !== 'cpu' && (!caps || enc.warning)) void refreshCaps(true)
  }

  const CONTENT: Record<Section, JSX.Element> = {
    looks: (
      <div>
        <Card label="ACCENT COLOUR">
          <div style={{ display: 'flex', gap: 9, marginBottom: 6 }}>
            {ACCENTS.map((a) => (
              <div key={a} onClick={() => { setAccent(a); setSavedAt(Date.now()) }} className="me-btn" style={{ display: 'flex', alignItems: 'center', gap: 7, border: a === accent ? '1px solid var(--accent)' : '1px solid #23272f', background: a === accent ? 'var(--accent-soft)' : '#0e1116', borderRadius: 9, padding: '7px 12px', cursor: 'pointer' }}>
                <span style={{ width: 14, height: 14, borderRadius: '50%', background: ACCENT_SWATCH[a] }} />
                <span style={{ fontSize: 11.5, color: a === accent ? '#f2f4f7' : '#8a909c', fontWeight: a === accent ? 600 : 400 }}>{a}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card label="DISPLAY">
          <Row on={ambientGlow} label="Ambient accent glow" onClick={toggleAmbientGlow} />
          <Row on={showActivityRail} label="Show activity rail on Home" onClick={toggleActivityRail} />
        </Card>
      </div>
    ),
    output: (
      <div>
        <Card label="FILE NAMING">
          <div style={{ fontSize: 12, color: '#8a909c', marginBottom: 8 }}>Template</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 9 }}>
            <span style={{ border: '1px solid var(--accent)', background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 8, padding: '7px 12px', fontSize: 11.5, fontFamily: 'var(--font-mono)' }}>{'{channel} - {title}'}</span>
            <span style={{ border: '1px solid #23272f', color: '#8a909c', borderRadius: 8, padding: '7px 12px', fontSize: 11.5, fontFamily: 'var(--font-mono)' }}>{'{date}_{title}'}</span>
          </div>
          <div style={{ fontSize: 11, color: '#6a7180' }}>e.g. <span style={{ fontFamily: 'var(--font-mono)', color: '#aab0bb' }}>Mental Empire - Gaslighting Explained.mp4</span></div>
        </Card>
        <Card label="RENDER">
          <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 12, color: '#8a909c', marginBottom: 7 }}>Parallel renders</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input type="number" min={1} max={8} value={settings.concurrency} onChange={(e) => saved({ concurrency: Math.max(1, Number(e.target.value)) })} style={{ width: 56, border: '1px solid #23272f', borderRadius: 8, padding: '8px 12px', fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 15, color: '#eef0f3', background: '#0e1116', outline: 'none' }} />
                <span style={{ fontSize: 11, color: '#6a7180' }}>at a time</span>
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: '#8a909c', marginBottom: 7 }}>Quality</div>
              <div style={{ display: 'flex', border: '1px solid #23272f', borderRadius: 8, overflow: 'hidden', fontSize: 11.5 }}>
                {qualities.map((q) => { const on = q === quality; return <div key={q} onClick={() => saved({ quality: q })} style={{ padding: '8px 12px', cursor: 'pointer', background: on ? 'var(--accent)' : undefined, color: on ? 'var(--accent-ink)' : '#8a909c', fontWeight: on ? 600 : undefined }}>{q}</div> })}
              </div>
            </div>
            <div style={{ minWidth: 280 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
                <div style={{ fontSize: 12, color: '#8a909c' }}>Encoder</div>
                <button type="button" onClick={() => void refreshCaps(true)} className="me-btn" style={{ border: '1px solid #262b34', background: '#15181f', borderRadius: 7, padding: '3px 7px', fontSize: 10, color: '#8a909c', cursor: 'pointer' }}>{checkingCaps ? 'Checking…' : 'Recheck'}</button>
              </div>
              <div style={{ display: 'flex', border: '1px solid #23272f', borderRadius: 8, overflow: 'hidden', fontSize: 11.5 }}>
                {encoders.map((enc) => { const on = (settings.encoder ?? 'cpu') === enc.value; return <div key={enc.value} title={enc.note} onClick={() => chooseEncoder(enc)} style={{ padding: '8px 12px', cursor: 'pointer', background: on ? 'var(--accent)' : undefined, color: on ? 'var(--accent-ink)' : enc.warning ? '#f5b323' : '#8a909c', fontWeight: on ? 600 : undefined }}>{enc.label}</div> })}
              </div>
              <div className="me-clamp-2" style={{ fontSize: 10, color: selectedEncoder.warning ? '#f5b323' : '#6a7180', marginTop: 5 }}>{checkingCaps ? 'Checking ffmpeg GPU capabilities…' : caps ? selectedEncoder.note : 'Could not check capabilities — encoder choice is saved.'}</div>
            </div>
            <div style={{ minWidth: 260 }}>
              <div style={{ fontSize: 12, color: '#8a909c', marginBottom: 7 }}>Render engine</div>
              <div style={{ display: 'flex', border: '1px solid #23272f', borderRadius: 8, overflow: 'hidden', fontSize: 11.5 }}>
                {RENDER_ENGINES.map((re) => { const on = (settings.renderEngine ?? 'ffmpeg') === re.value; return <div key={re.value} title={re.note} onClick={() => saved({ renderEngine: re.value })} style={{ padding: '8px 12px', cursor: 'pointer', background: on ? 'var(--accent)' : undefined, color: on ? 'var(--accent-ink)' : '#8a909c', fontWeight: on ? 600 : undefined }}>{re.label}</div> })}
              </div>
              <div className="me-clamp-2" style={{ fontSize: 10, color: '#6a7180', marginTop: 5 }}>{(RENDER_ENGINES.find((re) => re.value === (settings.renderEngine ?? 'ffmpeg')) ?? RENDER_ENGINES[0]).note}</div>
            </div>
          </div>
        </Card>
      </div>
    ),
    scraping: (
      <div>
        <Card label="AUTO-SCRAPE · NO API">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 13 }}>
            <div onClick={() => saved({ autoScrape: { enabled: !autoScrape.enabled } })} style={{ display: 'flex', alignItems: 'center', gap: 9, flex: 1, cursor: 'pointer' }}>
              <Toggle on={autoScrape.enabled} />
              <span style={{ fontSize: 12.5, color: autoScrape.enabled ? '#cdd2da' : '#6a7180' }}>Auto-scrape enabled</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 11, flexWrap: 'wrap', marginBottom: 13 }}>
            <div>
              <div style={{ fontSize: 11, color: '#8a909c', marginBottom: 6 }}>Frequency</div>
              <select value={autoScrape.frequency} onChange={(e) => saved({ autoScrape: { frequency: e.target.value } })} style={{ border: '1px solid #23272f', borderRadius: 8, padding: '8px 11px', fontSize: 11.5, color: '#dde0e5', background: '#0e1116', outline: 'none' }}>
                {['Every 15 minutes', 'Every 30 minutes', 'Every hour', 'Every 6 hours', 'Every 12 hours', 'Daily'].map((f) => <option key={f}>{f}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#8a909c', marginBottom: 6 }}>Request delay (s)</div>
              <input type="number" step={0.5} min={0} value={autoScrape.delaySec} onChange={(e) => saved({ autoScrape: { delaySec: Math.max(0, Number(e.target.value)) } })} style={{ width: 70, border: '1px solid #23272f', borderRadius: 8, padding: '8px 11px', fontSize: 11.5, color: '#dde0e5', background: '#0e1116', fontFamily: 'var(--font-mono)', outline: 'none' }} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#8a909c', marginBottom: 6 }}>Retries on fail</div>
              <input type="number" min={0} max={9} value={autoScrape.retries} onChange={(e) => saved({ autoScrape: { retries: Math.max(0, Number(e.target.value)) } })} style={{ width: 64, border: '1px solid #23272f', borderRadius: 8, padding: '8px 11px', fontSize: 11.5, color: '#dde0e5', background: '#0e1116', fontFamily: 'var(--font-mono)', outline: 'none' }} />
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid #1d2129', borderRadius: 9, padding: '9px 13px', background: '#0e1116' }}>
              <span style={{ color: '#cdd2da', flex: 'none' }}>Cookies file</span>
              <input value={autoScrape.cookiesPath} onChange={(e) => saved({ autoScrape: { cookiesPath: e.target.value } })} placeholder="/path/to/cookies.txt" style={{ flex: 1, border: '1px solid #23272f', borderRadius: 7, padding: '6px 10px', fontSize: 11, color: '#aab0bb', fontFamily: 'var(--font-mono)', background: '#0c0d11', outline: 'none' }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid #1d2129', borderRadius: 9, padding: '9px 13px', background: '#0e1116' }}>
              <span style={{ color: '#cdd2da', flex: 'none' }}>Proxy</span>
              <input value={autoScrape.proxy} onChange={(e) => saved({ autoScrape: { proxy: e.target.value } })} placeholder="http://user:pass@host:port" style={{ flex: 1, border: '1px solid #23272f', borderRadius: 7, padding: '6px 10px', fontSize: 11, color: '#aab0bb', fontFamily: 'var(--font-mono)', background: '#0c0d11', outline: 'none' }} />
            </div>
          </div>
        </Card>
        <Card label="BACKGROUND">
          <Row on={background.tray} label="Run in background (system tray)" onClick={() => saved({ background: { tray: !background.tray } })} />
          <Row on={background.startOnSignIn} label="Start on Windows sign-in" onClick={() => saved({ background: { startOnSignIn: !background.startOnSignIn } })} />
          <Row on={background.notifications} label="Desktop notifications" hint="Goal reminders and auto-watch events" onClick={() => saved({ background: { notifications: !background.notifications } })} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid #1d2129', borderRadius: 9, padding: '9px 13px', background: '#0e1116' }}>
            <span style={{ color: '#cdd2da', flex: 'none' }}>Webhook</span>
            <input value={background.webhook} onChange={(e) => saved({ background: { webhook: e.target.value } })} placeholder="https://… (Pushover / Zapier)" style={{ flex: 1, border: '1px solid #23272f', borderRadius: 7, padding: '6px 10px', fontSize: 11, color: '#aab0bb', fontFamily: 'var(--font-mono)', background: '#0c0d11', outline: 'none' }} />
          </div>
        </Card>
      </div>
    ),
    integrations: (
      <div>
        <Card label="TRANSCRIPTION · GROQ WHISPER">
          <div style={{ fontSize: 12, color: '#8a909c', marginBottom: 8 }}>Groq API key (free) — powers word-level captions</div>
          <input type="password" value={settings.transcription.apiKey} onChange={(e) => saved({ transcription: { apiKey: e.target.value } })} placeholder="gsk_…" style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #23272f', borderRadius: 8, padding: '9px 13px', fontSize: 12, color: '#dde0e5', background: '#0e1116', fontFamily: 'var(--font-mono)', outline: 'none', marginBottom: 8 }} />
          <div style={{ fontSize: 11, color: '#6a7180' }}>Model <span style={{ fontFamily: 'var(--font-mono)', color: '#aab0bb' }}>{settings.transcription.model}</span> · get a free key at console.groq.com</div>
        </Card>
        <Card label="STOCK FOOTAGE · B-ROLL API KEYS">
          <div style={{ fontSize: 10.5, color: '#6a7180', marginBottom: 11 }}>Optional — required for auto B-roll. Used in priority order.</div>
          {([['pexelsKey', 'Pexels'], ['pixabayKey', 'Pixabay'], ['coverrKey', 'Coverr']] as const).map(([k, label]) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid #1d2129', borderRadius: 9, padding: '9px 13px', background: '#0e1116', marginBottom: 8 }}>
              <span style={{ color: '#cdd2da', flex: 'none', width: 66 }}>{label}</span>
              <input type="password" value={settings.beta[k]} onChange={(e) => saved({ beta: { [k]: e.target.value } })} placeholder={`${label} API key`} style={{ flex: 1, border: '1px solid #23272f', borderRadius: 7, padding: '6px 10px', fontSize: 11, color: '#aab0bb', fontFamily: 'var(--font-mono)', background: '#0c0d11', outline: 'none' }} />
            </div>
          ))}
        </Card>
        <TalkingPhotosCard enabled={settings.integrations.talkingPhotos.enabled} onToggle={() => saved({ integrations: { talkingPhotos: { enabled: !settings.integrations.talkingPhotos.enabled } } })} />
        <Card label="TELEMETRY · SENTRY">
          <Row
            on={settings.telemetryEnabled}
            label="Send crash & performance reports"
            hint="Sends errors, IPC/DB call traces, and CPU/RAM/GPU usage samples to Sentry for debugging. Takes effect immediately, no restart. Turn off any time to fully disable."
            onClick={() => saved({ telemetryEnabled: !settings.telemetryEnabled })}
          />
        </Card>
      </div>
    ),
    beta: (
      <Card label="VIDEO EFFECTS">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', marginTop: 5, flex: 'none' }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12.5, color: '#cdd2da' }}>Compose controls are always available per project.</div>
            <div style={{ fontSize: 10.5, color: '#6a7180', marginTop: 2, lineHeight: 1.45 }}>Hook, auto-highlight, gradient overlay, auto-zoom, B-roll, and style transitions are saved on each project/profile. Defaults render with no extra effects.</div>
          </div>
        </div>
        <div style={{ fontSize: 11.5, color: '#5b616f', borderTop: '1px solid #1d2129', paddingTop: 11 }}>Auto B-roll still needs stock footage API keys in Integrations.</div>
      </Card>
    ),
    advanced: (
      <div>
        <Card label="UPLOAD DETECTION">
          <Row
            on={settings.detection.auto}
            label="Auto-detect uploaded matches"
            hint="Runs after downloads, renders and channel scrapes."
            onClick={() => saved({ detection: { auto: !settings.detection.auto } })}
          />
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
            <div>
              <div style={{ fontSize: 11, color: '#8a909c', marginBottom: 6 }}>Confirm from</div>
              <input type="number" min={0} max={1} step={0.01} value={confirmFloor} onChange={(e) => saved({ detection: { confirmBand: [Math.max(0, Math.min(1, Number(e.target.value))), confirmCeil] } })} style={{ width: 78, border: '1px solid #23272f', borderRadius: 8, padding: '8px 10px', fontSize: 11.5, color: '#dde0e5', background: '#0e1116', fontFamily: 'var(--font-mono)', outline: 'none' }} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#8a909c', marginBottom: 6 }}>High from</div>
              <input type="number" min={0} max={1} step={0.01} value={confirmCeil} onChange={(e) => saved({ detection: { confirmBand: [confirmFloor, Math.max(0, Math.min(1, Number(e.target.value)))] } })} style={{ width: 78, border: '1px solid #23272f', borderRadius: 8, padding: '8px 10px', fontSize: 11.5, color: '#dde0e5', background: '#0e1116', fontFamily: 'var(--font-mono)', outline: 'none' }} />
            </div>
          </div>
        </Card>
        <Card label="DEDUPLICATION">
          <Row
            on={settings.dedup.allowReupload}
            label="Allow re-downloading uploaded videos"
            hint="When off, uploaded source videos are locked unless Alt-click confirms an override."
            onClick={() => saved({ dedup: { allowReupload: !settings.dedup.allowReupload } })}
          />
        </Card>
        <Card label="REDESIGN FLAGS">
          <Row on={settings.features.workflowP1} label="Workflow P1 source state" onClick={() => saved({ features: { workflowP1: !settings.features.workflowP1 } })} />
        </Card>
      </div>
    ),
    danger: (
      <Card label="DANGER ZONE">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12.5, color: '#cdd2da', marginBottom: 3 }}>Reset data (keep API keys)</div>
              <div style={{ fontSize: 11, color: '#6a7180', lineHeight: 1.4 }}>Clears channels, profiles, projects, downloads and render queue. Keeps API keys, appearance and templates.</div>
            </div>
            <div className="me-btn" onClick={onSoftReset} style={{ flex: 'none', border: '1px solid #f5b323', color: '#f5b323', background: 'rgba(245,179,35,.08)', borderRadius: 9, padding: '9px 15px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Reset data</div>
          </div>
          <div style={{ borderTop: '1px solid #1d2129', paddingTop: 14, display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12.5, color: '#cdd2da', marginBottom: 3 }}>Reset to default settings</div>
              <div style={{ fontSize: 11, color: '#6a7180', lineHeight: 1.4 }}>Wipes all data and all settings including API keys. Cannot be undone.</div>
            </div>
            <div className="me-btn" onClick={onReset} style={{ flex: 'none', border: '1px solid #ff5a6e', color: '#ff8a96', background: 'rgba(255,90,110,.10)', borderRadius: 9, padding: '9px 15px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Reset everything</div>
          </div>
          <div style={{ borderTop: '1px solid #1d2129', paddingTop: 14 }}>
            <div onClick={() => void window.api?.openLogs?.()} className="me-btn" style={{ border: '1px solid #262b34', borderRadius: 8, padding: '9px 14px', textAlign: 'center', fontSize: 12, color: '#c4cad3', background: '#0e1116', cursor: 'pointer' }}>📄 Open logs folder</div>
            <div style={{ marginTop: 10, display: 'flex', gap: 14, fontSize: 11, color: '#6a7180' }}>
              <span>Jobs this week: <b style={{ color: '#cdd2da' }}>{jobsThisWeek}</b></span>
              <span>Version: <b style={{ color: '#cdd2da', fontFamily: 'var(--font-mono)' }}>{window.api?.appVersion || '0.1.0'}</b></span>
            </div>
          </div>
        </div>
      </Card>
    )
  }

  return (
    <ScreenPad style={{ paddingTop: 0 }}>
      {/* Page header */}
      <div style={{ padding: '18px 0 16px', borderBottom: '1px solid #1d2129', marginBottom: 22, display: 'flex', alignItems: 'center', gap: 14 }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '1px', color: 'var(--accent)', marginBottom: 5 }}>CONFIGURE</div>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 22, letterSpacing: '-.5px', color: '#f4f6f9' }}>Settings</div>
        </div>
        <div style={{ flex: 1 }} />
        {/* Auto-saved chip */}
        {Date.now() - savedAt < 2500 && (
          <div style={{ fontSize: 11.5, color: '#4fd6a0', border: '1px solid #1e3a2a', background: 'rgba(54,201,142,.1)', borderRadius: 9, padding: '5px 12px', fontFamily: 'var(--font-mono)' }}>Saved ✓</div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 22, alignItems: 'flex-start' }}>
        {/* Section nav */}
        <div style={{ width: 164, flex: 'none', display: 'flex', flexDirection: 'column', gap: 2, position: 'sticky', top: 0 }}>
          {NAV.map((n) => (
            <div
              key={n.id}
              onClick={() => setSection(n.id)}
              className="me-btn"
              style={{ padding: '9px 12px', borderRadius: 9, cursor: 'pointer', fontSize: 13, fontWeight: section === n.id ? 600 : 400, background: section === n.id ? 'var(--accent-soft)' : 'transparent', color: section === n.id ? '#f2f4f7' : n.id === 'danger' ? '#ff8a96' : '#8a909c', border: section === n.id ? '1px solid var(--accent)' : '1px solid transparent' }}
            >{n.label}</div>
          ))}
          <div style={{ borderTop: '1px solid #1d2129', marginTop: 12, paddingTop: 12 }}>
            <div style={{ fontSize: 10.5, color: '#5b616f', fontFamily: 'var(--font-mono)' }}>v{window.api?.appVersion || '0.1.0'}</div>
          </div>
        </div>

        {/* Content area */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {CONTENT[section]}
        </div>
      </div>
    </ScreenPad>
  )
}
