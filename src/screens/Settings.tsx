import { useEffect, useState, useCallback } from 'react'
import { ScreenPad } from '../components/primitives'
import { PageHeader, Btn, ToggleRow, Seg, StatusPill } from '../components/ui/kit'
import { useData } from '../store/useData'
import { useStore } from '../store/useStore'
import { useTalkingPhotos } from '../store/useTalkingPhotos'
import { describeTalkingPhotosCapabilities } from '@shared/talkingphotos'
import type { AccentName, AppSettings, DeepPartial, MontageCapabilities, RenderCapabilities } from '@shared/types'

const ACCENTS: AccentName[] = ['Amber', 'Violet', 'Emerald', 'Crimson']
const ACCENT_SWATCH: Record<AccentName, string> = { Amber: '#f5b323', Violet: '#8b7cff', Emerald: '#36c98e', Crimson: '#ff5a6e' }

const RENDER_ENGINES: Array<{ value: NonNullable<AppSettings['renderEngine']>; label: string; note: string }> = [
  { value: 'ffmpeg', label: 'ffmpeg', note: 'CPU filtergraph — the stable default. Works everywhere.' },
  { value: 'gpu', label: 'GPU', note: 'WebGL compositor + WebCodecs hardware H.264. With a GPU encoder selected, failures stop visibly instead of falling back to CPU filters.' },
  { value: 'auto', label: 'Auto', note: 'Use the GPU engine when hardware H.264 encode is available, otherwise ffmpeg.' },
]

type Section = 'looks' | 'output' | 'scraping' | 'integrations' | 'openmontage' | 'beta' | 'advanced' | 'danger'
const NAV: Array<{ id: Section; label: string }> = [
  { id: 'looks', label: 'Looks' },
  { id: 'output', label: 'Output & Quality' },
  { id: 'scraping', label: 'Scraping' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'openmontage', label: 'OpenMontage' },
  { id: 'beta', label: 'Video effects' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'danger', label: 'Danger zone' },
]

const inputStyle = { width: '100%', boxSizing: 'border-box' as const }
const keyRowStyle = { display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '9px 13px', background: 'var(--bg-inset)', marginBottom: 8 }

function Card({ label, children }: { label?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 18, background: 'var(--bg-card)', boxShadow: 'var(--shadow-card)', marginBottom: 16 }}>
      {label && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.6px', color: 'var(--text-faint)', marginBottom: 13 }}>{label}</div>}
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
const CONNECTION_TONE: Record<string, 'ok' | 'warn' | 'error' | 'neutral'> = {
  connected: 'ok', connecting: 'warn', waiting_for_login: 'warn', verifying: 'warn',
  reauth_required: 'error', attention: 'error', disconnected: 'neutral'
}

function TalkingPhotosCard({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }): JSX.Element {
  const { connection, connecting, capabilities, connect, reconnect, disconnect, init } = useTalkingPhotos()
  useEffect(() => { if (enabled) void init() }, [enabled, init])
  const status = connection?.status ?? 'disconnected'
  const canRetryHeadlessly = status === 'reauth_required'
  const capabilitySummary = describeTalkingPhotosCapabilities(status, capabilities ?? null)

  return (
    <Card label="TALKINGPHOTOS.AI">
      <ToggleRow on={enabled} label="Enable TalkingPhotos integration" hint="Cloud Human-video provider with uploaded-audio creation, durable progress sync, and output download." onToggle={onToggle} />
      {enabled && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '9px 13px', background: 'var(--bg-inset)', marginBottom: 8 }}>
            <StatusPill tone={CONNECTION_TONE[status] ?? 'neutral'}>{CONNECTION_STATUS_LABEL[status] ?? 'Not connected'}</StatusPill>
            <span style={{ fontSize: 11, color: 'var(--text-dim)', flex: 1 }}>
              {connection?.lastVerifiedAt && status === 'connected' ? `verified ${new Date(connection.lastVerifiedAt).toLocaleTimeString()}` : ''}
            </span>
            {status === 'connected' ? (
              <Btn variant="ghost" onClick={() => void disconnect()}>Disconnect</Btn>
            ) : (
              <Btn variant="soft" disabled={connecting} onClick={() => void (canRetryHeadlessly ? reconnect() : connect())}>
                {connecting ? (CONNECTION_STATUS_LABEL[status] ?? 'Connecting…') : status === 'reauth_required' ? 'Reconnect' : status === 'attention' ? 'Retry' : 'Connect'}
              </Btn>
            )}
          </div>
          {connection?.lastError && status !== 'connected' && (
            <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--err-2)', marginBottom: 8 }}>{connection.lastError}</div>
          )}
          {status === 'connected' && capabilities && (
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 'var(--fs-caption)', color: 'var(--text-dim)' }}>
              <span>Max duration <b style={{ color: 'var(--text-muted)' }}>{capabilities.limits.maxDurationSeconds}s</b></span>
              <span>Max TTS chars <b style={{ color: 'var(--text-muted)' }}>{capabilities.limits.maxCharactersTts}</b></span>
              <span>Concurrent <b style={{ color: 'var(--text-muted)' }}>{capabilities.usage.concurrentCount}/{capabilities.usage.concurrentLimit}</b></span>
              <span>Daily <b style={{ color: 'var(--text-muted)' }}>{capabilities.usage.dailyUsage}/{capabilities.usage.dailyLimit}</b></span>
            </div>
          )}
          <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-faint)', marginTop: 8 }}>{capabilitySummary.statusText}</div>
        </div>
      )}
    </Card>
  )
}

const MONTAGE_KEYS: Array<{ key: 'falKey' | 'unsplashKey' | 'elevenLabsKey' | 'openaiKey' | 'googleKey'; label: string; placeholder: string }> = [
  { key: 'falKey', label: 'fal.ai', placeholder: 'fal key (footage/gen)' },
  { key: 'unsplashKey', label: 'Unsplash', placeholder: 'Unsplash access key' },
  { key: 'elevenLabsKey', label: 'ElevenLabs', placeholder: 'ElevenLabs API key' },
  { key: 'openaiKey', label: 'OpenAI', placeholder: 'sk-…' },
  { key: 'googleKey', label: 'Google', placeholder: 'Google API key' },
]

function EngineBadge({ label, on }: { label: string; on: boolean }): JSX.Element {
  return <StatusPill tone={on ? 'ok' : 'neutral'} title={on ? `${label} available` : `${label} not available`}>{label} {on ? '✓' : '—'}</StatusPill>
}

function OpenMontageSection({ montage, saved }: { montage: AppSettings['montage']; saved: (patch: DeepPartial<AppSettings>) => void }): JSX.Element {
  const [caps, setCaps] = useState<MontageCapabilities | null>(null)
  const [probing, setProbing] = useState(false)
  const [probed, setProbed] = useState(false)

  const probe = useCallback(async (force = false): Promise<void> => {
    setProbing(true)
    try { setCaps((await window.api?.montage?.capabilities?.(force)) ?? null) }
    catch { setCaps(null) }
    finally { setProbing(false); setProbed(true) }
  }, [])

  // Auto-probe once when the section opens and the bridge is enabled (cached in main; cheap).
  useEffect(() => { if (montage.enabled && !probed) void probe(false) }, [montage.enabled, probed, probe])

  const browseRoot = async (): Promise<void> => {
    const dir = await window.api?.chooseFolder?.()
    if (dir) saved({ montage: { openMontageRoot: dir } })
  }

  const available = caps?.available === true
  const labelCol = { color: 'var(--text-bright)', flex: 'none', width: 82 } as const

  return (
    <div>
      <Card label="OPENMONTAGE BRIDGE">
        <ToggleRow
          on={montage.enabled}
          label="Enable OpenMontage bridge"
          hint="Drive an external OpenMontage install (subprocess) for open-footage/stock retrieval and Remotion/HyperFrames composition. Requires a local OpenMontage checkout."
          onToggle={() => saved({ montage: { enabled: !montage.enabled } })}
        />
      </Card>

      <Card label="INSTALL LOCATION">
        <div style={keyRowStyle}>
          <span style={labelCol}>Root folder</span>
          <input value={montage.openMontageRoot} onChange={(e) => saved({ montage: { openMontageRoot: e.target.value } })} placeholder="/path/to/OpenMontage" aria-label="OpenMontage root folder" className="ed-input" style={{ flex: 1, fontFamily: 'var(--font-mono)' }} />
          <Btn variant="ghost" onClick={() => void browseRoot()}>Browse…</Btn>
        </div>
        <div style={keyRowStyle}>
          <span style={labelCol}>Python</span>
          <input value={montage.pythonPath} onChange={(e) => saved({ montage: { pythonPath: e.target.value } })} placeholder="auto — OpenMontage venv → PATH (optional)" aria-label="Python interpreter path" className="ed-input" style={{ flex: 1, fontFamily: 'var(--font-mono)' }} />
        </div>
        <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-dim)', marginTop: 4 }}>Point at your OpenMontage checkout. Leave Python blank to auto-detect the venv, then the PATH interpreter.</div>
      </Card>

      <Card label="PROVIDER KEYS">
        <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-dim)', marginBottom: 11 }}>Optional — passed to the OpenMontage subprocess via env (encrypted at rest). Pexels &amp; Pixabay keys live under Video effects / Integrations and are reused automatically.</div>
        {MONTAGE_KEYS.map(({ key, label, placeholder }) => (
          <div key={key} style={keyRowStyle}>
            <span style={{ color: 'var(--text-bright)', flex: 'none', width: 82 }}>{label}</span>
            <input type="password" value={montage[key]} onChange={(e) => saved({ montage: { [key]: e.target.value } })} placeholder={placeholder} aria-label={`${label} API key`} className="ed-input" style={{ flex: 1, fontFamily: 'var(--font-mono)' }} />
          </div>
        ))}
      </Card>

      <Card label="CAPABILITIES">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <Btn variant="soft" disabled={probing} onClick={() => void probe(true)}>{probing ? 'Detecting…' : 'Detect / Refresh'}</Btn>
          {probed && !probing && (
            <StatusPill tone={available ? 'ok' : 'error'}>{available ? 'Detected' : 'Not available'}</StatusPill>
          )}
          {caps?.omRoot && <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{caps.omRoot}</span>}
        </div>

        {!probed && !probing && (
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Run Detect to probe the OpenMontage install for render engines and capability providers.</div>
        )}

        {probed && !probing && !available && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '11px 13px', background: 'var(--bg-inset)' }}>
            <div style={{ fontSize: 12, color: 'var(--err-2)', marginBottom: 6 }}>{caps?.error || 'OpenMontage was not detected.'}</div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.45 }}>Set the OpenMontage root folder above (a checkout with <span style={{ fontFamily: 'var(--font-mono)' }}>tools/</span>), optionally set the Python interpreter, then click Detect / Refresh.</div>
          </div>
        )}

        {caps && available && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 'var(--fs-caption)', color: 'var(--text-dim)' }}>
              {caps.python && <span>Python <b style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{caps.python}</b></span>}
              {caps.pythonPath && <span>Interpreter <b style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{caps.pythonPath}</b></span>}
            </div>

            <div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.6px', color: 'var(--text-faint)', marginBottom: 8 }}>RENDER ENGINES</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <EngineBadge label="ffmpeg" on={caps.renderEngines.ffmpeg} />
                <EngineBadge label="remotion" on={caps.renderEngines.remotion} />
                <EngineBadge label="hyperframes" on={caps.renderEngines.hyperframes} />
              </div>
            </div>

            {caps.capabilities.length > 0 && (
              <div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.6px', color: 'var(--text-faint)', marginBottom: 8 }}>CAPABILITIES</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {caps.capabilities.map((c) => (
                    <div key={c.capability} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <StatusPill tone={c.configured > 0 ? 'ok' : c.total > 0 ? 'warn' : 'neutral'}>{c.configured}/{c.total}</StatusPill>
                      <span style={{ fontSize: 12, color: 'var(--text-bright)', fontFamily: 'var(--font-mono)' }}>{c.capability}</span>
                      {c.availableProviders.length > 0 && <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{c.availableProviders.join(', ')}</span>}
                      {c.unavailableProviders.length > 0 && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>· needs: {c.unavailableProviders.join(', ')}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {caps.runtimeWarnings.length > 0 && (
              <div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.6px', color: 'var(--warn)', marginBottom: 8 }}>RUNTIME WARNINGS</div>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {caps.runtimeWarnings.map((w, i) => (
                    <li key={i} style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.45 }}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {caps.setupOffers.length > 0 && (
              <div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.6px', color: 'var(--text-faint)', marginBottom: 8 }}>SETUP OFFERS</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {caps.setupOffers.map((o, i) => (
                    <div key={`${o.capability}-${o.tool}-${i}`} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '9px 12px', background: 'var(--bg-inset)' }}>
                      <div style={{ fontSize: 12, color: 'var(--text-bright)' }}>{o.capability} · {o.tool}{o.provider ? ` · ${o.provider}` : ''}</div>
                      {o.envVars.length > 0 && <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', marginTop: 3 }}>env: {o.envVars.join(', ')}</div>}
                      {o.installInstructions && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3, lineHeight: 1.45 }}>{o.installInstructions}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Card>
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
  const [confirmReset, setConfirmReset] = useState<'soft' | 'hard' | null>(null)

  const saved = useCallback((patch: Parameters<typeof updateSettings>[0]) => {
    updateSettings(patch)
    setSavedAt(Date.now())
  }, [updateSettings])

  useEffect(() => { void refreshCaps() }, [])

  const refreshCaps = async (force = false): Promise<void> => {
    setCheckingCaps(true)
    try { setCaps(await window.api?.caps?.get?.(force) ?? null) } catch { setCaps(null) } finally { setCheckingCaps(false) }
  }

  const doHardReset = (): void => { void resetAll(); setConfirmReset(null) }
  const doSoftReset = async (): Promise<void> => {
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
  const chooseEncoder = (value: typeof encoders[number]['value']): void => {
    const enc = encoders.find((e) => e.value === value) ?? encoders[0]
    saved({ encoder: enc.value, renderEngine: enc.value === 'cpu' ? 'ffmpeg' : 'gpu' })
    if (enc.value !== 'cpu' && (!caps || enc.warning)) void refreshCaps(true)
  }
  const numField = { width: 78 }

  const CONTENT: Record<Section, JSX.Element> = {
    looks: (
      <div>
        <Card label="ACCENT COLOUR">
          <div role="radiogroup" aria-label="Accent colour" style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
            {ACCENTS.map((a) => (
              <button key={a} type="button" role="radio" aria-checked={a === accent} onClick={() => { setAccent(a); setSavedAt(Date.now()) }} className="me-btn ed-focus" style={{ display: 'flex', alignItems: 'center', gap: 7, border: a === accent ? '1px solid var(--accent)' : '1px solid var(--border-2)', background: a === accent ? 'var(--accent-soft)' : 'var(--bg-inset)', borderRadius: 'var(--radius-md)', padding: '7px 12px', cursor: 'pointer' }}>
                <span style={{ width: 14, height: 14, borderRadius: '50%', background: ACCENT_SWATCH[a] }} />
                <span style={{ fontSize: 11.5, color: a === accent ? 'var(--text-strong)' : 'var(--text-muted)', fontWeight: a === accent ? 600 : 400 }}>{a}</span>
              </button>
            ))}
          </div>
        </Card>
        <Card label="DISPLAY">
          <ToggleRow on={ambientGlow} label="Ambient accent glow" onToggle={toggleAmbientGlow} />
          <ToggleRow on={showActivityRail} label="Show activity rail on Home" onToggle={toggleActivityRail} />
        </Card>
      </div>
    ),
    output: (
      <div>
        <Card label="FILE NAMING">
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Template</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 9 }}>
            <span style={{ border: '1px solid var(--accent)', background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 'var(--radius-sm)', padding: '7px 12px', fontSize: 11.5, fontFamily: 'var(--font-mono)' }}>{'{channel} - {title}'}</span>
            <span style={{ border: '1px solid var(--border-2)', color: 'var(--text-muted)', borderRadius: 'var(--radius-sm)', padding: '7px 12px', fontSize: 11.5, fontFamily: 'var(--font-mono)' }}>{'{date}_{title}'}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>e.g. <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>Mental Empire - Gaslighting Explained.mp4</span></div>
        </Card>
        <Card label="RENDER">
          <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 7 }}>Parallel renders</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input type="number" min={1} max={8} value={settings.concurrency} onChange={(e) => saved({ concurrency: Math.max(1, Number(e.target.value)) })} aria-label="Parallel renders" className="ed-input" style={{ width: 64, fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 15 }} />
                <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>at a time</span>
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 7 }}>Quality</div>
              <Seg options={qualities.map((q) => ({ value: q, label: q }))} value={quality} onChange={(q) => saved({ quality: q })} />
            </div>
            <div style={{ minWidth: 280 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Encoder</div>
                <Btn variant="ghost" onClick={() => void refreshCaps(true)}>{checkingCaps ? 'Checking…' : 'Recheck'}</Btn>
              </div>
              <Seg options={encoders.map((e) => ({ value: e.value, label: e.label, title: e.note }))} value={settings.encoder ?? 'cpu'} onChange={chooseEncoder} />
              <div className="me-clamp-2" style={{ fontSize: 10, color: selectedEncoder.warning ? 'var(--warn)' : 'var(--text-dim)', marginTop: 5 }}>{checkingCaps ? 'Checking ffmpeg GPU capabilities…' : caps ? selectedEncoder.note : 'Could not check capabilities — encoder choice is saved.'}</div>
            </div>
            <div style={{ minWidth: 260 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 7 }}>Render engine</div>
              <Seg options={RENDER_ENGINES.map((re) => ({ value: re.value, label: re.label, title: re.note }))} value={settings.renderEngine ?? 'ffmpeg'} onChange={(v) => saved({ renderEngine: v })} />
              <div className="me-clamp-2" style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 5 }}>{(RENDER_ENGINES.find((re) => re.value === (settings.renderEngine ?? 'ffmpeg')) ?? RENDER_ENGINES[0]).note}</div>
            </div>
          </div>
        </Card>
      </div>
    ),
    scraping: (
      <div>
        <Card label="AUTO-SCRAPE · NO API">
          <ToggleRow on={autoScrape.enabled} label="Auto-scrape enabled" onToggle={() => saved({ autoScrape: { enabled: !autoScrape.enabled } })} />
          <div style={{ display: 'flex', gap: 11, flexWrap: 'wrap', margin: '13px 0' }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Frequency</div>
              <select value={autoScrape.frequency} onChange={(e) => saved({ autoScrape: { frequency: e.target.value } })} aria-label="Scrape frequency" className="ed-input" style={{ width: 'auto' }}>
                {['Every 15 minutes', 'Every 30 minutes', 'Every hour', 'Every 6 hours', 'Every 12 hours', 'Daily'].map((f) => <option key={f}>{f}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Request delay (s)</div>
              <input type="number" step={0.5} min={0} value={autoScrape.delaySec} onChange={(e) => saved({ autoScrape: { delaySec: Math.max(0, Number(e.target.value)) } })} aria-label="Request delay seconds" className="ed-input" style={{ width: 72, fontFamily: 'var(--font-mono)' }} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Retries on fail</div>
              <input type="number" min={0} max={9} value={autoScrape.retries} onChange={(e) => saved({ autoScrape: { retries: Math.max(0, Number(e.target.value)) } })} aria-label="Retries on fail" className="ed-input" style={{ width: 66, fontFamily: 'var(--font-mono)' }} />
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            <div style={keyRowStyle}>
              <span style={{ color: 'var(--text-bright)', flex: 'none' }}>Cookies file</span>
              <input value={autoScrape.cookiesPath} onChange={(e) => saved({ autoScrape: { cookiesPath: e.target.value } })} placeholder="/path/to/cookies.txt" aria-label="Cookies file path" className="ed-input" style={{ flex: 1, fontFamily: 'var(--font-mono)' }} />
            </div>
            <div style={keyRowStyle}>
              <span style={{ color: 'var(--text-bright)', flex: 'none' }}>Proxy</span>
              <input value={autoScrape.proxy} onChange={(e) => saved({ autoScrape: { proxy: e.target.value } })} placeholder="http://user:pass@host:port" aria-label="Proxy" className="ed-input" style={{ flex: 1, fontFamily: 'var(--font-mono)' }} />
            </div>
          </div>
        </Card>
        <Card label="BACKGROUND">
          <ToggleRow on={background.tray} label="Run in background (system tray)" onToggle={() => saved({ background: { tray: !background.tray } })} />
          <ToggleRow on={background.startOnSignIn} label="Start on Windows sign-in" onToggle={() => saved({ background: { startOnSignIn: !background.startOnSignIn } })} />
          <ToggleRow on={background.notifications} label="Desktop notifications" hint="Goal reminders and auto-watch events" onToggle={() => saved({ background: { notifications: !background.notifications } })} />
          <div style={keyRowStyle}>
            <span style={{ color: 'var(--text-bright)', flex: 'none' }}>Webhook</span>
            <input value={background.webhook} onChange={(e) => saved({ background: { webhook: e.target.value } })} placeholder="https://… (Pushover / Zapier)" aria-label="Webhook URL" className="ed-input" style={{ flex: 1, fontFamily: 'var(--font-mono)' }} />
          </div>
        </Card>
      </div>
    ),
    integrations: (
      <div>
        <Card label="TRANSCRIPTION · GROQ WHISPER">
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Groq API key (free) — powers word-level captions</div>
          <input type="password" value={settings.transcription.apiKey} onChange={(e) => saved({ transcription: { apiKey: e.target.value } })} placeholder="gsk_…" aria-label="Groq API key" className="ed-input" style={{ ...inputStyle, fontFamily: 'var(--font-mono)', marginBottom: 8 }} />
          <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>Model <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{settings.transcription.model}</span> · get a free key at console.groq.com</div>
        </Card>
        <Card label="STOCK FOOTAGE · B-ROLL API KEYS">
          <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-dim)', marginBottom: 11 }}>Optional — required for auto B-roll. Used in priority order.</div>
          {([['pexelsKey', 'Pexels'], ['pixabayKey', 'Pixabay'], ['coverrKey', 'Coverr']] as const).map(([k, label]) => (
            <div key={k} style={keyRowStyle}>
              <span style={{ color: 'var(--text-bright)', flex: 'none', width: 66 }}>{label}</span>
              <input type="password" value={settings.beta[k]} onChange={(e) => saved({ beta: { [k]: e.target.value } })} placeholder={`${label} API key`} aria-label={`${label} API key`} className="ed-input" style={{ flex: 1, fontFamily: 'var(--font-mono)' }} />
            </div>
          ))}
        </Card>
        <TalkingPhotosCard enabled={settings.integrations.talkingPhotos.enabled} onToggle={() => saved({ integrations: { talkingPhotos: { enabled: !settings.integrations.talkingPhotos.enabled } } })} />
        <Card label="TELEMETRY · SENTRY">
          <ToggleRow
            on={settings.telemetryEnabled}
            label="Send crash & performance reports"
            hint="Sends errors, structured logs, IPC/DB traces, and CPU/RAM/GPU samples to Sentry. Takes effect on next launch. Turn off any time to fully disable."
            onToggle={() => saved({ telemetryEnabled: !settings.telemetryEnabled })}
          />
        </Card>
      </div>
    ),
    openmontage: <OpenMontageSection montage={settings.montage} saved={saved} />,
    beta: (
      <Card label="VIDEO EFFECTS">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', marginTop: 5, flex: 'none' }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12.5, color: 'var(--text-bright)' }}>Compose controls are always available per project.</div>
            <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-dim)', marginTop: 2, lineHeight: 1.45 }}>Hook, auto-highlight, gradient overlay, auto-zoom, B-roll, and style transitions are saved on each project/profile. Defaults render with no extra effects.</div>
          </div>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', borderTop: '1px solid var(--border)', paddingTop: 11 }}>Auto B-roll still needs stock footage API keys in Integrations.</div>
      </Card>
    ),
    advanced: (
      <div>
        <Card label="UPLOAD DETECTION">
          <ToggleRow
            on={settings.detection.auto}
            label="Auto-detect uploaded matches"
            hint="Runs after downloads, renders and channel scrapes."
            onToggle={() => saved({ detection: { auto: !settings.detection.auto } })}
          />
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Confirm from</div>
              <input type="number" min={0} max={1} step={0.01} value={confirmFloor} onChange={(e) => saved({ detection: { confirmBand: [Math.max(0, Math.min(1, Number(e.target.value))), confirmCeil] } })} aria-label="Confirm-match threshold" className="ed-input" style={{ ...numField, fontFamily: 'var(--font-mono)' }} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>High from</div>
              <input type="number" min={0} max={1} step={0.01} value={confirmCeil} onChange={(e) => saved({ detection: { confirmBand: [confirmFloor, Math.max(0, Math.min(1, Number(e.target.value)))] } })} aria-label="High-confidence threshold" className="ed-input" style={{ ...numField, fontFamily: 'var(--font-mono)' }} />
            </div>
          </div>
        </Card>
        <Card label="DEDUPLICATION">
          <ToggleRow
            on={settings.dedup.allowReupload}
            label="Allow re-downloading uploaded videos"
            hint="When off, uploaded source videos are locked unless Alt-click confirms an override."
            onToggle={() => saved({ dedup: { allowReupload: !settings.dedup.allowReupload } })}
          />
        </Card>
        <Card label="REDESIGN FLAGS">
          <ToggleRow on={settings.features.workflowP1} label="Workflow P1 source state" onToggle={() => saved({ features: { workflowP1: !settings.features.workflowP1 } })} />
        </Card>
      </div>
    ),
    danger: (
      <Card label="DANGER ZONE">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12.5, color: 'var(--text-bright)', marginBottom: 3 }}>Reset data (keep API keys)</div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.4 }}>Clears channels, profiles, projects, downloads and render queue. Keeps API keys, appearance and templates.</div>
            </div>
            {confirmReset === 'soft' ? (
              <div style={{ display: 'flex', gap: 8, flex: 'none' }}>
                <Btn variant="soft" size="md" onClick={() => void doSoftReset()}>Confirm reset</Btn>
                <Btn variant="ghost" size="md" onClick={() => setConfirmReset(null)}>Cancel</Btn>
              </div>
            ) : (
              <Btn variant="soft" size="md" onClick={() => setConfirmReset('soft')}>Reset data</Btn>
            )}
          </div>
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12.5, color: 'var(--text-bright)', marginBottom: 3 }}>Reset to default settings</div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.4 }}>Wipes all data and all settings including API keys. Cannot be undone.</div>
            </div>
            {confirmReset === 'hard' ? (
              <div style={{ display: 'flex', gap: 8, flex: 'none' }}>
                <Btn variant="danger" size="md" onClick={doHardReset}>Erase everything</Btn>
                <Btn variant="ghost" size="md" onClick={() => setConfirmReset(null)}>Cancel</Btn>
              </div>
            ) : (
              <Btn variant="danger" size="md" onClick={() => setConfirmReset('hard')}>Reset everything</Btn>
            )}
          </div>
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
            <Btn variant="ghost" size="md" onClick={() => void window.api?.openLogs?.()}>Open logs folder</Btn>
            <div style={{ marginTop: 10, display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-dim)' }}>
              <span>Jobs this week: <b style={{ color: 'var(--text-bright)' }}>{jobsThisWeek}</b></span>
              <span>Version: <b style={{ color: 'var(--text-bright)', fontFamily: 'var(--font-mono)' }}>{window.api?.appVersion || '0.1.0'}</b></span>
            </div>
          </div>
        </div>
      </Card>
    )
  }

  return (
    <ScreenPad>
      <PageHeader
        eyebrow="Configure"
        title="Settings"
        actions={(Date.now() - savedAt < 2500) ? <StatusPill tone="ok">Saved</StatusPill> : undefined}
      />

      <div style={{ display: 'flex', gap: 22, alignItems: 'flex-start' }}>
        {/* Section nav (vertical tablist) */}
        <div role="tablist" aria-label="Settings sections" style={{ width: 172, flex: 'none', display: 'flex', flexDirection: 'column', gap: 2, position: 'sticky', top: 0 }}>
          {NAV.map((n) => {
            const on = section === n.id
            return (
              <button
                key={n.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setSection(n.id)}
                className="me-btn ed-focus"
                style={{ textAlign: 'left', padding: '9px 12px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: on ? 600 : 400, background: on ? 'var(--accent-soft)' : 'transparent', color: on ? 'var(--text-strong)' : n.id === 'danger' ? 'var(--err-2)' : 'var(--text-muted)', border: on ? '1px solid var(--accent)' : '1px solid transparent' }}
              >{n.label}</button>
            )
          })}
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 12, paddingTop: 12 }}>
            <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>v{window.api?.appVersion || '0.1.0'}</div>
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
