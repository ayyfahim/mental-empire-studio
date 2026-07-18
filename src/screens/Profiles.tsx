import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useStore } from '../store/useStore'
import { useData } from '../store/useData'
import { ScreenPad } from '../components/primitives'
import { Btn, Panel, Section, SectionLabel } from '../components/ui/kit'
import { AUTOMATION_GOALS, buildAutomationWorkflow, formatGoal } from '@shared/automation'
import { type AutomationGoal, type AutomationJob, type AutomationJobDetail, type AutomationJobDraft, type AutomationPreflight, type ScrapedVideo, type VideoStyle } from '@shared/types'

const SETUP_STEPS = ['Choose goal', 'Source & content', 'Assets & style', 'Automation rules', 'Review & run']
const STYLES: VideoStyle[] = ['Clean', 'Cinematic', 'Intense', 'Heartfelt', 'None']
const input: CSSProperties = { width: '100%', border: '1px solid #2a2f39', borderRadius: 9, background: '#0d1015', color: '#dce0e6', padding: '9px 11px', fontSize: 12, outline: 'none' }

function jobEta(job?: AutomationJob): string {
  if (!job || !job.startedAt || job.progress < 2) return 'estimating'
  const elapsed = Math.max(1, (Date.now() - Date.parse(job.startedAt)) / 1000)
  const remaining = elapsed * (100 - job.progress) / job.progress
  const hours = Math.floor(remaining / 3600)
  const minutes = Math.max(1, Math.round((remaining % 3600) / 60))
  return `~${hours ? `${hours}h ` : ''}${minutes}m`
}

function ToggleRow({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', padding: '8px 0' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 2, accentColor: 'var(--accent)' }} />
      <span><span style={{ display: 'block', color: '#d6dae1', fontSize: 12, fontWeight: 600 }}>{label}</span><span style={{ color: '#737b89', fontSize: 10.5, lineHeight: 1.4 }}>{detail}</span></span>
    </label>
  )
}

function StatusPill({ status }: { status: AutomationJob['status'] }): JSX.Element {
  const map: Record<AutomationJob['status'], { label: string; color: string; bg: string }> = {
    queued: { label: 'WAITING', color: '#b8c0cc', bg: '#252a34' },
    running: { label: 'PROCESSING', color: 'var(--accent)', bg: 'var(--accent-soft)' },
    pausing: { label: 'PAUSING', color: '#f5b323', bg: 'rgba(245,179,35,.1)' },
    paused: { label: 'PAUSED', color: '#f5b323', bg: 'rgba(245,179,35,.1)' },
    attention: { label: 'ACTION NEEDED', color: '#ff8a96', bg: 'rgba(255,90,110,.1)' },
    completed: { label: 'COMPLETED', color: '#4fd6a0', bg: 'rgba(54,201,142,.1)' },
    completed_with_warnings: { label: 'DONE · WARNINGS', color: '#f5b323', bg: 'rgba(245,179,35,.1)' },
    failed: { label: 'FAILED', color: '#ff8a96', bg: 'rgba(255,90,110,.1)' },
    cancelled: { label: 'CANCELLED', color: '#8a909c', bg: '#252a34' }
  }
  const s = map[status]
  return <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, fontWeight: 800, letterSpacing: '.5px', color: s.color, background: s.bg, borderRadius: 999, padding: '4px 8px' }}>{s.label}</span>
}

function StepPreview({ draft }: { draft: AutomationJobDraft }): JSX.Element {
  const steps = buildAutomationWorkflow('preview', draft.config)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflowX: 'auto', paddingBottom: 4 }}>
      {steps.map((step, i) => (
        <div key={step.key} style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
          <div title={step.description} style={{ border: '1px solid #282d36', background: '#101319', color: '#aeb5c0', borderRadius: 8, padding: '7px 10px', fontSize: 10.5, whiteSpace: 'nowrap' }}>
            <span style={{ color: step.runsOn === 'online-service' ? '#7ca6ff' : '#4fd6a0', marginRight: 5 }}>●</span>{step.label}
          </div>
          {i < steps.length - 1 && <span style={{ color: '#454b57' }}>→</span>}
        </div>
      ))}
    </div>
  )
}

function JobDetails({ detail }: { detail: AutomationJobDetail }): JSX.Element {
  return (
    <div style={{ borderTop: '1px solid #232832', padding: 15, background: '#0e1116' }}>
      <SectionLabel>Workflow checkpoints</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 7, marginTop: 9 }}>
        {detail.steps.map((step) => (
          <div key={step.id} style={{ border: '1px solid #232832', borderRadius: 9, padding: 9, background: '#11151b' }}>
            <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}><span style={{ color: step.status === 'completed' ? '#4fd6a0' : step.status === 'failed' ? '#ff8a96' : step.status === 'running' ? 'var(--accent)' : '#565e6c' }}>{step.status === 'completed' ? '✓' : step.status === 'failed' ? '!' : step.status === 'running' ? '●' : '○'}</span><span style={{ fontSize: 10.5, color: '#c5cad2', fontWeight: 600 }}>{step.label}</span></div>
            <div style={{ marginTop: 6, height: 3, borderRadius: 3, background: '#252a34' }}><div style={{ height: '100%', width: `${step.progress}%`, background: step.status === 'failed' ? '#ff5a6e' : step.status === 'completed' ? '#36c98e' : 'var(--accent)', borderRadius: 3 }} /></div>
          </div>
        ))}
      </div>
      {detail.items.length > 0 && <>
        <SectionLabel style={{ marginTop: 16 }}>Videos</SectionLabel>
        <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {detail.items.map((item) => <div key={item.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(180px,1fr) 110px 55px', gap: 10, fontSize: 10.5, padding: '7px 9px', borderRadius: 7, background: '#12161c', color: '#aeb5c0' }}><span className="me-ellipsis">{item.title}</span><span>{item.currentStep}</span><span style={{ color: item.status === 'failed' ? '#ff8a96' : item.status === 'completed' ? '#4fd6a0' : 'var(--accent)', textAlign: 'right' }}>{item.status}</span>{(item.error || item.warning) && <span style={{ gridColumn: '1 / -1', color: item.error ? '#ff8a96' : '#f5b323' }}>{item.error || item.warning}</span>}</div>)}
        </div>
      </>}
      <SectionLabel style={{ marginTop: 16 }}>Understandable log</SectionLabel>
      <div style={{ marginTop: 7, maxHeight: 150, overflowY: 'auto', fontFamily: 'var(--font-mono)', fontSize: 9.5, color: '#7e8694', lineHeight: 1.65 }}>
        {detail.logs.slice(-12).map((row) => <div key={row.id} style={{ color: row.level === 'error' ? '#ff8a96' : row.level === 'warning' ? '#f5b323' : '#7e8694' }}>{new Date(row.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {row.message}</div>)}
      </div>
    </div>
  )
}

export function Profiles(): JSX.Element {
  const sourceChannels = useData((s) => s.sourceChannels)
  const automationJobs = useData((s) => s.automationJobs)
  const loadSources = useData((s) => s.loadSources)
  const loadAutomationJobs = useData((s) => s.loadAutomationJobs)
  const preflightAutomation = useData((s) => s.preflightAutomation)
  const createAutomationJob = useData((s) => s.createAutomationJob)
  const pauseJob = useData((s) => s.pauseAutomationJob)
  const resumeJob = useData((s) => s.resumeAutomationJob)
  const cancelJob = useData((s) => s.cancelAutomationJob)
  const retryJob = useData((s) => s.retryAutomationJob)
  const setActive = useStore((s) => s.setActive)
  const settings = useStore((s) => s.settings)
  const [view, setView] = useState<'setup' | 'jobs'>('setup')
  const [stage, setStage] = useState(0)
  const [goal, setGoal] = useState<AutomationGoal>('source-to-export')
  const [sourceId, setSourceId] = useState('')
  const [sourceCount, setSourceCount] = useState(3)
  const [availableVideos, setAvailableVideos] = useState<ScrapedVideo[]>([])
  const [selectedVideoIds, setSelectedVideoIds] = useState<string[]>([])
  const [sourceOrder, setSourceOrder] = useState<'Latest' | 'Popular' | 'Oldest'>('Latest')
  const [assets, setAssets] = useState<string[]>([])
  const [style, setStyle] = useState<VideoStyle>('Clean')
  const [captionPreset, setCaptionPreset] = useState('Hormozi')
  const [captions, setCaptions] = useState(!!settings.transcription.apiKey.trim())
  const [autoBroll, setAutoBroll] = useState(false)
  const [continueOnError, setContinueOnError] = useState(true)
  const [skipDownloaded, setSkipDownloaded] = useState(true)
  const [minDuration, setMinDuration] = useState(0)
  const [retries, setRetries] = useState(Math.max(1, settings.autoScrape.retries || 2))
  const [reserveGb, setReserveGb] = useState(2)
  const [desktopNotify, setDesktopNotify] = useState(settings.background.notifications)
  const [webhookNotify, setWebhookNotify] = useState(!!settings.background.webhook)
  const [preflight, setPreflight] = useState<AutomationPreflight | null>(null)
  const [starting, setStarting] = useState(false)
  const [expanded, setExpanded] = useState<AutomationJobDetail | null>(null)

  useEffect(() => { void Promise.all([loadSources(), loadAutomationJobs()]) }, [loadSources, loadAutomationJobs])
  useEffect(() => { if (!sourceId && sourceChannels[0]) setSourceId(sourceChannels[0].id) }, [sourceChannels, sourceId])
  useEffect(() => {
    if (!sourceId) { setAvailableVideos([]); return }
    void window.api.sources.videos(sourceId).then(setAvailableVideos).catch(() => setAvailableVideos([]))
  }, [sourceId])
  useEffect(() => {
    if (!expanded?.id) return
    void window.api.automation.job(expanded.id).then((next) => { if (next) setExpanded(next) })
  }, [automationJobs, expanded?.id])

  const source = sourceChannels.find((s) => s.id === sourceId)
  const draft = useMemo<AutomationJobDraft>(() => ({
    name: `${source?.name || source?.handle || 'Source'} · ${formatGoal(goal)}`,
    goal,
    config: {
      sourceId: source?.id ?? '', sourceUrl: source?.url ?? '', sourceName: source?.name || source?.handle || '', sourceOrder, sourceCount, selectedVideoIds,
      assetPaths: assets, style, captionPreset, aspectRatios: [source?.captionAspect ?? '16:9'], execution: 'local',
      rules: { minDurationSec: minDuration, skipDownloaded, continueOnError, maxRetries: retries, minimumFreeSpaceGb: reserveGb, captions, autoBroll, removeSilence: false, reduceFillerWords: false, keepAwake: true },
      notify: { desktop: desktopNotify, webhook: webhookNotify, sound: desktopNotify, email: false }
    }
  }), [source, sourceOrder, sourceCount, selectedVideoIds, assets, style, captionPreset, goal, minDuration, skipDownloaded, continueOnError, retries, reserveGb, captions, autoBroll, desktopNotify, webhookNotify])

  const goReview = async (): Promise<void> => { setStage(4); setPreflight(await preflightAutomation(draft)) }
  const start = async (): Promise<void> => {
    setStarting(true)
    try {
      const checked = await preflightAutomation(draft)
      setPreflight(checked)
      if (!checked?.ok) return
      const job = await createAutomationJob(draft)
      if (job) { setExpanded(job); setView('jobs') }
    } finally { setStarting(false) }
  }
  const pickAssets = (files: FileList | null): void => {
    if (!files) return
    const paths = Array.from(files).map((file) => window.api?.pathForFile(file) || '').filter(Boolean)
    setAssets((current) => [...new Set([...current, ...paths])])
  }
  const showDetails = async (job: AutomationJob): Promise<void> => {
    if (expanded?.id === job.id) { setExpanded(null); return }
    setExpanded(await window.api.automation.job(job.id))
  }
  const duplicate = (job: AutomationJob): void => {
    setGoal(job.goal); setSourceId(job.config.sourceId); setSourceCount(job.config.sourceCount); setSourceOrder(job.config.sourceOrder); setSelectedVideoIds(job.config.selectedVideoIds)
    setAssets(job.config.assetPaths); setStyle(job.config.style); setCaptionPreset(job.config.captionPreset); setCaptions(job.config.rules.captions)
    setAutoBroll(job.config.rules.autoBroll); setContinueOnError(job.config.rules.continueOnError); setSkipDownloaded(job.config.rules.skipDownloaded)
    setRetries(job.config.rules.maxRetries); setReserveGb(job.config.rules.minimumFreeSpaceGb); setStage(0); setPreflight(null); setView('setup')
  }
  const activeJob = automationJobs.find((job) => job.status === 'running' || job.status === 'pausing')

  return (
    <ScreenPad>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 18, marginBottom: 18 }}>
        <div style={{ flex: 1 }}><div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '1px', color: 'var(--accent)', marginBottom: 6 }}>AUTOMATION STUDIO</div><div style={{ fontFamily: 'var(--font-display)', fontSize: 27, fontWeight: 600, color: '#f4f6f9' }}>Choose an outcome. Come back to finished work.</div><div style={{ color: '#7f8795', fontSize: 12.5, marginTop: 7, maxWidth: 760 }}>Configure a production goal once. A persistent local worker advances each step, saves checkpoints, retries safe failures, and only pauses when your decision is genuinely needed.</div></div>
        <div style={{ display: 'flex', border: '1px solid #272c35', borderRadius: 10, padding: 3, background: '#0c0f14' }}><button onClick={() => setView('setup')} style={{ border: 0, borderRadius: 7, padding: '7px 13px', color: view === 'setup' ? '#f1f3f6' : '#737b89', background: view === 'setup' ? '#242933' : 'transparent', cursor: 'pointer', fontSize: 11.5 }}>New automation</button><button onClick={() => setView('jobs')} style={{ border: 0, borderRadius: 7, padding: '7px 13px', color: view === 'jobs' ? '#f1f3f6' : '#737b89', background: view === 'jobs' ? '#242933' : 'transparent', cursor: 'pointer', fontSize: 11.5 }}>Jobs {automationJobs.length ? `(${automationJobs.length})` : ''}</button></div>
      </div>

      <div style={{ border: '1px solid rgba(124,166,255,.24)', background: 'rgba(75,105,180,.08)', borderRadius: 12, padding: '10px 13px', display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}><span style={{ color: '#7ca6ff' }}>◉</span><div style={{ flex: 1, fontSize: 11.5, color: '#9eabc0' }}><b style={{ color: '#cfd7e4' }}>Runs locally in the desktop background.</b> {settings.background.tray ? 'You may close this window; the tray process continues.' : 'Keep the app open, or enable tray background mode in Settings.'} Sleep pauses work. A powered-off computer cannot process; start-on-sign-in can resume from the last checkpoint after boot.</div><span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: '#7ca6ff', whiteSpace: 'nowrap' }}>LOCAL · PRIVATE</span></div>

      {view === 'setup' ? <>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${SETUP_STEPS.length},1fr)`, gap: 5, marginBottom: 18 }}>{SETUP_STEPS.map((label, i) => <button key={label} onClick={() => { if (i <= stage) setStage(i) }} style={{ border: 0, textAlign: 'left', background: 'transparent', padding: 0, cursor: i <= stage ? 'pointer' : 'default' }}><div style={{ height: 4, borderRadius: 4, background: i < stage ? '#36c98e' : i === stage ? 'var(--accent)' : '#242933', marginBottom: 6 }} /><span style={{ fontSize: 9.5, color: i === stage ? '#dce0e6' : '#626a78', fontFamily: 'var(--font-mono)' }}>{i + 1}. {label}</span></button>)}</div>

        {stage === 0 && <Panel><SectionLabel>What do you want to finish?</SectionLabel><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(225px,1fr))', gap: 10, marginTop: 12 }}>{AUTOMATION_GOALS.map((g) => { const on = goal === g.id; return <button key={g.id} onClick={() => g.available && setGoal(g.id)} disabled={!g.available} style={{ textAlign: 'left', border: `1px solid ${on ? 'var(--accent)' : '#272c35'}`, borderRadius: 12, background: on ? 'var(--accent-soft)' : '#101319', padding: 14, opacity: g.available ? 1 : .48, cursor: g.available ? 'pointer' : 'not-allowed' }}><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span style={{ color: on ? 'var(--accent)' : '#cdd2da', fontSize: 12.5, fontWeight: 700, flex: 1 }}>{g.title}</span><span style={{ fontSize: 8, fontFamily: 'var(--font-mono)', color: g.available ? '#4fd6a0' : '#8a909c' }}>{g.available ? 'READY' : 'LATER'}</span></div><div style={{ color: '#7c8492', fontSize: 10.5, lineHeight: 1.45, marginTop: 7 }}>{g.description}</div>{g.availabilityNote && <div style={{ color: '#9a8390', fontSize: 9.5, marginTop: 7 }}>{g.availabilityNote}</div>}</button> })}</div></Panel>}

        {stage === 1 && <Panel><SectionLabel>Choose source and content</SectionLabel>{sourceChannels.length === 0 ? <div style={{ textAlign: 'center', padding: 30, color: '#737b89', fontSize: 12 }}>Add a YouTube source first.<div style={{ marginTop: 12 }}><Btn variant="soft" onClick={() => setActive('sources')}>Open Sources</Btn></div></div> : <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px,1.4fr) minmax(150px,.6fr) minmax(150px,.6fr)', gap: 12, marginTop: 13 }}><label><span style={{ display: 'block', color: '#838b98', fontSize: 10.5, marginBottom: 6 }}>Saved source</span><select value={sourceId} onChange={(e) => { const next = sourceChannels.find((s) => s.id === e.target.value); setSourceId(e.target.value); setSelectedVideoIds([]); setAssets([]); setAutoBroll(!!next?.betaOpts?.broll.enabled) }} style={input}>{sourceChannels.map((s) => <option key={s.id} value={s.id}>{s.name || s.handle}</option>)}</select></label><label><span style={{ display: 'block', color: '#838b98', fontSize: 10.5, marginBottom: 6 }}>Videos to process</span><input type="number" min={1} max={50} value={sourceCount} onChange={(e) => setSourceCount(Math.max(1, Math.min(50, Number(e.target.value))))} style={input} /></label><label><span style={{ display: 'block', color: '#838b98', fontSize: 10.5, marginBottom: 6 }}>Selection order</span><select value={sourceOrder} onChange={(e) => setSourceOrder(e.target.value as typeof sourceOrder)} style={input}><option>Latest</option><option>Popular</option><option>Oldest</option></select></label></div>}<div style={{ marginTop: 14, border: '1px solid #232832', borderRadius: 10, padding: 11, background: '#0e1116', color: '#7f8795', fontSize: 10.5 }}>Automatic rule: process {sourceCount} {sourceOrder.toLowerCase()} video{sourceCount === 1 ? '' : 's'}{minDuration ? ` longer than ${Math.round(minDuration / 60)} minutes` : ''}. Already downloaded audio will be reused.</div></Panel>}
        {stage === 1 && availableVideos.length > 0 && <Panel style={{ marginTop: 10 }}><div style={{ display: 'flex', alignItems: 'center' }}><SectionLabel style={{ flex: 1 }}>Pick individual videos (optional)</SectionLabel>{selectedVideoIds.length > 0 && <button type="button" onClick={() => setSelectedVideoIds([])} style={{ border: 0, background: 'transparent', color: 'var(--accent)', fontSize: 10, cursor: 'pointer' }}>Use automatic rules instead</button>}</div><div style={{ color: '#6f7784', fontSize: 10.5, marginTop: 6 }}>Select exact cached videos, or leave all unchecked to use the count, order, and duration rules above.</div><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 10 }}>{availableVideos.slice(0, 12).map((video) => <label key={video.id} style={{ display: 'flex', gap: 8, alignItems: 'center', border: `1px solid ${selectedVideoIds.includes(video.id) ? 'var(--accent)' : '#252a33'}`, background: selectedVideoIds.includes(video.id) ? 'var(--accent-soft)' : '#101319', borderRadius: 8, padding: '7px 9px', cursor: 'pointer' }}><input type="checkbox" checked={selectedVideoIds.includes(video.id)} onChange={(e) => setSelectedVideoIds((current) => e.target.checked ? [...current, video.id] : current.filter((id) => id !== video.id))} style={{ accentColor: 'var(--accent)' }} /><span className="me-ellipsis" style={{ color: '#aeb5c0', fontSize: 10.5, flex: 1 }}>{video.title}</span><span style={{ color: '#59616e', fontSize: 9, fontFamily: 'var(--font-mono)' }}>{Math.max(1, Math.round(video.durationSec / 60))}m</span></label>)}</div></Panel>}

        {stage === 2 && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}><Panel><SectionLabel>Visual assets</SectionLabel><div style={{ color: '#7f8795', fontSize: 10.5, lineHeight: 1.5, margin: '8px 0 12px' }}>Select reusable images before the job begins. They are copied into each project so the original files stay untouched.</div><label style={{ display: 'block', border: '1.5px dashed #303641', borderRadius: 11, padding: 20, textAlign: 'center', cursor: 'pointer', color: '#a6adba', fontSize: 11.5 }}><input type="file" accept="image/*" multiple onChange={(e) => pickAssets(e.target.files)} style={{ display: 'none' }} />＋ Add images, logos, or visual assets</label><div style={{ marginTop: 9, color: assets.length ? '#4fd6a0' : '#6b7380', fontSize: 10.5 }}>{assets.length ? `${assets.length} reusable asset${assets.length === 1 ? '' : 's'} selected` : 'No assets selected'}</div><ToggleRow label="Use automatic B-roll" detail="Find themed stock clips when local images are not enough. Requires a configured B-roll provider or a warmed pool." checked={autoBroll} onChange={setAutoBroll} /></Panel><Panel><SectionLabel>Editing style</SectionLabel><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7, marginTop: 11 }}>{STYLES.map((s) => <button key={s} onClick={() => setStyle(s)} style={{ border: `1px solid ${style === s ? 'var(--accent)' : '#282d36'}`, background: style === s ? 'var(--accent-soft)' : '#101319', color: style === s ? 'var(--accent)' : '#a8afba', borderRadius: 9, padding: '9px 10px', textAlign: 'left', fontSize: 11, cursor: 'pointer' }}>{s}</button>)}</div><label style={{ display: 'block', marginTop: 13 }}><span style={{ display: 'block', color: '#838b98', fontSize: 10.5, marginBottom: 6 }}>Subtitle preset</span><select value={captionPreset} onChange={(e) => setCaptionPreset(e.target.value)} style={input}><option>Hormozi</option><option>Submagic</option><option>Clean</option><option>Minimal</option></select></label><ToggleRow label="Transcribe and add captions" detail={settings.transcription.apiKey.trim() ? 'Uses the configured online transcription service, then stores timed words locally.' : 'Needs a Groq key in Settings. Turn this off to continue without captions.'} checked={captions} onChange={setCaptions} /></Panel></div>}

        {stage === 3 && <Panel><SectionLabel>How should the supervisor behave?</SectionLabel><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 28, marginTop: 8 }}><div><ToggleRow label="Continue when one video fails" detail="Failed items are isolated while the rest of the batch keeps moving." checked={continueOnError} onChange={setContinueOnError} /><ToggleRow label="Reuse completed downloads" detail="Never download the same source audio again when a valid local file exists." checked={skipDownloaded} onChange={setSkipDownloaded} /><ToggleRow label="Desktop completion notification" detail="Receive completion and action-needed messages even when the window is hidden." checked={desktopNotify} onChange={setDesktopNotify} /><ToggleRow label="Send configured webhook" detail={settings.background.webhook ? 'Send a structured completion summary to your configured endpoint.' : 'No webhook is configured in Settings.'} checked={webhookNotify} onChange={setWebhookNotify} /></div><div><label style={{ display: 'block', marginBottom: 12 }}><span style={{ display: 'block', color: '#838b98', fontSize: 10.5, marginBottom: 6 }}>Automatic retry limit</span><input type="number" min={0} max={8} value={retries} onChange={(e) => setRetries(Math.max(0, Math.min(8, Number(e.target.value))))} style={input} /></label><label style={{ display: 'block', marginBottom: 12 }}><span style={{ display: 'block', color: '#838b98', fontSize: 10.5, marginBottom: 6 }}>Minimum duration (minutes)</span><input type="number" min={0} max={600} value={Math.round(minDuration / 60)} onChange={(e) => setMinDuration(Math.max(0, Number(e.target.value) * 60))} style={input} /></label><label style={{ display: 'block' }}><span style={{ display: 'block', color: '#838b98', fontSize: 10.5, marginBottom: 6 }}>Keep free-space reserve (GB)</span><input type="number" min={1} max={100} value={reserveGb} onChange={(e) => setReserveGb(Math.max(1, Number(e.target.value)))} style={input} /></label></div></div><Section label="Advanced automation (progressive disclosure)" defaultOpen={false}><div style={{ color: '#707887', fontSize: 10.5, lineHeight: 1.6 }}>This first persistent version uses the existing local CPU/GPU profile, processes one orchestration at a time, checkpoints every major step, and waits for the current safe media unit before pausing. Silence removal, filler-word reduction, schedules, multi-ratio exports, and post-job sleep/shutdown are staged additions because the current media engine does not yet expose those operations safely.</div></Section></Panel>}

        {stage === 4 && <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}><Panel><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><SectionLabel style={{ flex: 1 }}>Generated workflow</SectionLabel><span style={{ fontSize: 9.5, color: '#4fd6a0', fontFamily: 'var(--font-mono)' }}>AUTO-BUILT FROM YOUR GOAL</span></div><div style={{ marginTop: 12 }}><StepPreview draft={draft} /></div></Panel><div style={{ display: 'grid', gridTemplateColumns: '1.25fr .75fr', gap: 13 }}><Panel><SectionLabel>Ready-to-run summary</SectionLabel><div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: '9px 14px', marginTop: 13, fontSize: 11 }}><span style={{ color: '#707887' }}>Final goal</span><span style={{ color: '#d8dce3' }}>{formatGoal(goal)}</span><span style={{ color: '#707887' }}>Source & items</span><span style={{ color: '#d8dce3' }}>{source?.name || source?.handle} · up to {sourceCount} videos</span><span style={{ color: '#707887' }}>Editing preset</span><span style={{ color: '#d8dce3' }}>{style} · {captions ? `${captionPreset} captions` : 'captions off'} · {assets.length} assets{autoBroll ? ' + Auto B-roll' : ''}</span><span style={{ color: '#707887' }}>Retry / failure</span><span style={{ color: '#d8dce3' }}>{retries} automatic retries · {continueOnError ? 'continue other videos' : 'pause the batch'}</span><span style={{ color: '#707887' }}>Execution</span><span style={{ color: '#d8dce3' }}>Local background worker · {settings.encoder === 'cpu' ? 'CPU' : settings.encoder.toUpperCase()} · {settings.quality}</span><span style={{ color: '#707887' }}>Notifications</span><span style={{ color: '#d8dce3' }}>{[desktopNotify && 'desktop', webhookNotify && 'webhook'].filter(Boolean).join(' + ') || 'in-app only'}</span></div></Panel><Panel><SectionLabel>Preflight</SectionLabel>{!preflight ? <div style={{ color: '#747c89', fontSize: 11, marginTop: 12 }}>Checking configuration…</div> : <><div style={{ marginTop: 11, color: preflight.ok ? '#4fd6a0' : '#ff8a96', fontWeight: 700, fontSize: 12 }}>{preflight.ok ? '✓ Ready to run unattended' : 'Action required before start'}</div><div style={{ marginTop: 10, color: '#858d9a', fontSize: 10.5, lineHeight: 1.55 }}>~{preflight.estimatedStorageGb.toFixed(1)} GB · ~{preflight.estimatedMinutes} min<br />{preflight.appMessage}<br />{preflight.powerMessage}</div>{preflight.blockers.map((b) => <div key={b} style={{ color: '#ff8a96', fontSize: 10.5, marginTop: 7 }}>• {b}</div>)}{preflight.warnings.map((w) => <div key={w} style={{ color: '#f5b323', fontSize: 10.5, marginTop: 7 }}>• {w}</div>)}</>}</Panel></div></div>}

        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 16 }}><Btn disabled={stage === 0} onClick={() => setStage(Math.max(0, stage - 1))}>Back</Btn><div style={{ flex: 1 }} />{stage < 3 && <Btn variant="primary" disabled={(stage === 0 && !AUTOMATION_GOALS.find((g) => g.id === goal)?.available) || (stage === 1 && !source)} onClick={() => setStage(stage + 1)}>Continue</Btn>}{stage === 3 && <Btn variant="primary" disabled={!source || (!assets.length && !autoBroll)} onClick={() => void goReview()}>Review workflow</Btn>}{stage === 4 && <Btn variant="primary" disabled={!preflight?.ok || starting} onClick={() => void start()} style={{ padding: '11px 20px' }}>{starting ? 'Starting…' : '▶ Start automation and run until complete'}</Btn>}</div>
      </> : <>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}><div><div style={{ color: '#e5e8ed', fontSize: 16, fontWeight: 700 }}>Automation jobs</div><div style={{ color: '#707887', fontSize: 10.5, marginTop: 3 }}>Current and previous production goals. Status is loaded from SQLite, not browser memory.</div></div><div style={{ flex: 1 }} /><Btn variant="soft" onClick={() => { setStage(0); setView('setup') }}>＋ New automation</Btn></div>
        {activeJob && <div style={{ display: 'flex', gap: 18, alignItems: 'center', border: '1px solid #252b35', borderRadius: 10, background: '#0f1217', padding: '8px 11px', marginBottom: 10, fontSize: 9.5, fontFamily: 'var(--font-mono)', color: '#818a98' }}><span><b style={{ color: 'var(--accent)' }}>LIVE</b> · {activeJob.currentStep}</span><span>ETA {jobEta(activeJob)}</span><span>Started {activeJob.startedAt ? new Date(activeJob.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'now'}</span><span>{settings.encoder === 'cpu' ? 'CPU' : settings.encoder.toUpperCase()} · {settings.quality} · {settings.concurrency} configured worker{settings.concurrency === 1 ? '' : 's'}</span><span style={{ marginLeft: 'auto' }}>Speed appears during render in item progress</span></div>}
        {automationJobs.length === 0 ? <div style={{ border: '1.5px dashed #282d36', borderRadius: 14, padding: 42, textAlign: 'center', color: '#707887', fontSize: 12 }}>No automation jobs yet. Choose a goal to build your first unattended workflow.</div> : <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>{automationJobs.map((job) => { const active = job.status === 'running' || job.status === 'queued' || job.status === 'pausing'; return <div key={job.id} style={{ border: `1px solid ${job.status === 'attention' || job.status === 'failed' ? '#4a2530' : job.status === 'completed' ? '#1f382f' : '#20252e'}`, borderRadius: 14, background: '#11141a', overflow: 'hidden' }}><div style={{ padding: 15 }}><div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}><div style={{ width: 38, height: 38, borderRadius: 10, background: active ? 'var(--accent-soft)' : '#20252d', display: 'grid', placeItems: 'center', color: active ? 'var(--accent)' : '#7d8592', fontSize: 16 }}>{active ? '▶' : job.status === 'completed' ? '✓' : job.status === 'attention' || job.status === 'failed' ? '!' : '■'}</div><div style={{ flex: 1, minWidth: 0 }}><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span className="me-ellipsis" style={{ fontSize: 13.5, color: '#e1e4e9', fontWeight: 700 }}>{job.name}</span><StatusPill status={job.status} /></div><div style={{ color: '#747c89', fontSize: 10.5, marginTop: 4 }}>{formatGoal(job.goal)} · {job.config.sourceName} · {job.totalItems || job.config.sourceCount} videos</div></div><div style={{ textAlign: 'right' }}><div style={{ fontFamily: 'var(--font-mono)', color: job.status === 'completed' ? '#4fd6a0' : 'var(--accent)', fontSize: 15, fontWeight: 700 }}>{job.progress}%</div><div style={{ color: '#626a78', fontSize: 9.5, marginTop: 3 }}>{job.status === 'completed' ? 'finished' : 'overall'}</div></div></div><div style={{ marginTop: 12, height: 6, borderRadius: 4, background: '#222731', overflow: 'hidden' }}><div style={{ width: `${job.progress}%`, height: '100%', borderRadius: 4, background: job.status === 'failed' || job.status === 'attention' ? '#ff5a6e' : job.status === 'completed' ? '#36c98e' : 'linear-gradient(90deg,var(--accent),var(--accent-deep))', transition: 'width .35s' }} /></div><div style={{ display: 'grid', gridTemplateColumns: '1.1fr .8fr .8fr 1.2fr', gap: 12, marginTop: 11, fontSize: 10 }}><div><span style={{ display: 'block', color: '#59616e' }}>CURRENT STEP</span><span style={{ color: '#afb6c1' }}>{job.currentStep || 'Waiting'}</span></div><div><span style={{ display: 'block', color: '#59616e' }}>ITEMS</span><span style={{ color: '#afb6c1' }}>{job.completedCount} done · {job.failedCount} failed</span></div><div><span style={{ display: 'block', color: '#59616e' }}>CHECKPOINT</span><span style={{ color: '#afb6c1' }}>{job.lastCheckpointAt ? new Date(job.lastCheckpointAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'not started'}</span></div><div><span style={{ display: 'block', color: '#59616e' }}>OUTPUT</span><span className="me-ellipsis" style={{ display: 'block', color: '#afb6c1' }}>{job.result?.outputPaths[0] || settings.libraryFolder || settings.outputFolder || 'MentalEmpireStudio library'}</span></div></div>{job.error && <div style={{ marginTop: 10, border: '1px solid #4a2530', background: 'rgba(255,90,110,.07)', color: '#ff9aa5', borderRadius: 8, padding: '8px 10px', fontSize: 10.5 }}><b>What happened:</b> {job.error}<br /><span style={{ color: '#bd7e88' }}>Completed checkpoints are safe. Fix the issue, then Resume or Retry failed work.</span></div>}<div style={{ display: 'flex', gap: 7, marginTop: 12, flexWrap: 'wrap' }}>{(job.status === 'running' || job.status === 'queued') && <Btn size="sm" onClick={() => void pauseJob(job.id)}>Pause</Btn>}{(job.status === 'paused' || job.status === 'attention') && <Btn size="sm" variant="soft" onClick={() => void resumeJob(job.id)}>Resume</Btn>}{job.failedCount > 0 && (job.status === 'failed' || job.status === 'completed_with_warnings') && <Btn size="sm" variant="soft" onClick={() => void retryJob(job.id)}>Retry failed items</Btn>}{active || job.status === 'paused' || job.status === 'attention' ? <Btn size="sm" variant="danger" onClick={() => void cancelJob(job.id)}>Cancel</Btn> : null}<Btn size="sm" onClick={() => void showDetails(job)}>{expanded?.id === job.id ? 'Hide details' : 'View details'}</Btn>{job.result?.outputPaths[0] && <Btn size="sm" onClick={() => void window.api.publish.reveal(job.result!.outputPaths[0])}>Open output</Btn>}<Btn size="sm" onClick={() => duplicate(job)}>Duplicate workflow</Btn><Btn size="sm" onClick={() => { void window.api.appMeta.set(`automation-template-${job.id}`, JSON.stringify({ name: job.name, goal: job.goal, config: job.config })); window.alert('Workflow template saved locally.') }}>Save as template</Btn><Btn size="sm" onClick={() => window.api.openLogs()}>Technical logs</Btn></div></div>{expanded?.id === job.id && <JobDetails detail={expanded} />}</div> })}</div>}
      </>}
    </ScreenPad>
  )
}
