import { useEffect, useMemo, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react'
import { useStore } from '../store/useStore'
import { useData } from '../store/useData'
import { ScreenPad } from '../components/primitives'
import { Banner, Btn, EmptyState, Panel, Section, SectionLabel, ToggleRow } from '../components/ui/kit'
import { AUTOMATION_GOALS, buildAutomationWorkflow, formatGoal } from '@shared/automation'
import type {
  AutomationGoal,
  AutomationJob,
  AutomationJobDetail,
  AutomationJobDraft,
  AutomationPreflight,
  LibraryAsset,
  ScrapeOrder,
  ScrapedVideo,
  VideoStyle
} from '@shared/types'

type SourceKind = AutomationJobDraft['config']['sourceKind']
type AspectRatio = AutomationJobDraft['config']['aspectRatios'][number]

const SETUP_STEPS = ['Choose goal', 'Source & content', 'Assets & style', 'Automation rules', 'Review & run']
const STYLES: VideoStyle[] = ['Clean', 'Cinematic', 'Intense', 'Heartfelt', 'None']
const input: CSSProperties = {
  width: '100%', border: '1px solid var(--border-2)', borderRadius: 9, background: 'var(--bg-inset)',
  color: 'var(--text-bright)', padding: '9px 11px', fontSize: 12, outline: 'none'
}

function fileName(path: string): string { return path.split(/[\\/]/).pop() || path }

function validYoutubeUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' && ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname.toLowerCase())
  } catch { return false }
}

function jobEta(job?: AutomationJob): string {
  if (!job?.startedAt || job.progress < 2) return 'Estimating…'
  const elapsed = Math.max(1, (Date.now() - Date.parse(job.startedAt)) / 1000)
  const remaining = elapsed * (100 - job.progress) / job.progress
  const hours = Math.floor(remaining / 3600)
  const minutes = Math.max(1, Math.round((remaining % 3600) / 60))
  return `~${hours ? `${hours}h ` : ''}${minutes}m`
}

function statusPresentation(status: AutomationJob['status']): { label: string; color: string; bg: string } {
  return {
    queued: { label: 'WAITING', color: '#b8c0cc', bg: '#252a34' },
    running: { label: 'PROCESSING', color: 'var(--accent)', bg: 'var(--accent-soft)' },
    pausing: { label: 'PAUSING', color: 'var(--warn)', bg: 'rgba(245,179,35,.1)' },
    paused: { label: 'PAUSED', color: 'var(--warn)', bg: 'rgba(245,179,35,.1)' },
    attention: { label: 'ACTION NEEDED', color: 'var(--err-2)', bg: 'rgba(255,90,110,.1)' },
    completed: { label: 'COMPLETED', color: 'var(--ok-2)', bg: 'rgba(54,201,142,.1)' },
    completed_with_warnings: { label: 'DONE · WARNINGS', color: 'var(--warn)', bg: 'rgba(245,179,35,.1)' },
    failed: { label: 'FAILED', color: 'var(--err-2)', bg: 'rgba(255,90,110,.1)' },
    cancelled: { label: 'CANCELLED', color: 'var(--text-dim)', bg: '#252a34' }
  }[status]
}

function JobStatus({ status }: { status: AutomationJob['status'] }): JSX.Element {
  const value = statusPresentation(status)
  return <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, fontWeight: 800, letterSpacing: '.5px', color: value.color, background: value.bg, borderRadius: 999, padding: '4px 8px' }}>{value.label}</span>
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }): JSX.Element {
  return <label><span style={{ display: 'block', color: 'var(--text-dim)', fontSize: 10.5, marginBottom: 6 }}>{label}</span>{children}{hint && <span style={{ display: 'block', color: 'var(--text-faint)', fontSize: 9.5, marginTop: 5, lineHeight: 1.4 }}>{hint}</span>}</label>
}

function SourceRuleFields({ count, setCount, order, setOrder }: {
  count: number
  setCount: Dispatch<SetStateAction<number>>
  order: ScrapeOrder
  setOrder: Dispatch<SetStateAction<ScrapeOrder>>
}): JSX.Element {
  return <>
    <Field label="Videos to process"><input type="number" min={1} max={50} value={count} onChange={(event) => setCount(Math.max(1, Math.min(50, Number(event.target.value) || 1)))} style={input} /></Field>
    <Field label="Selection order"><select value={order} onChange={(event) => setOrder(event.target.value as ScrapeOrder)} style={input}><option>Latest</option><option>Popular</option><option>Oldest</option></select></Field>
  </>
}

function WorkflowPreview({ draft }: { draft: AutomationJobDraft }): JSX.Element {
  const steps = buildAutomationWorkflow('preview', draft.config)
  return <div className="automation-workflow-preview">
    {steps.map((step, index) => <div key={step.key} style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
      <div title={step.description} style={{ border: '1px solid var(--border-2)', background: 'var(--bg-inset)', color: 'var(--text-muted)', borderRadius: 8, padding: '7px 10px', fontSize: 10.5, whiteSpace: 'nowrap' }}>
        <span style={{ color: step.runsOn === 'online-service' ? '#7ca6ff' : 'var(--ok-2)', marginRight: 5 }}>●</span>{step.label}
      </div>
      {index < steps.length - 1 && <span aria-hidden="true" style={{ color: 'var(--text-fainter)' }}>→</span>}
    </div>)}
  </div>
}

function JobDetails({ detail }: { detail: AutomationJobDetail }): JSX.Element {
  return <div style={{ borderTop: '1px solid var(--border)', padding: 15, background: 'var(--bg-inset)' }}>
    <SectionLabel>Workflow checkpoints</SectionLabel>
    <div className="automation-checkpoint-grid">
      {detail.steps.map((step) => <div key={step.id} style={{ border: '1px solid var(--border)', borderRadius: 9, padding: 9, background: 'var(--bg-card)' }}>
        <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
          <span aria-hidden="true" style={{ color: step.status === 'completed' ? 'var(--ok-2)' : step.status === 'failed' ? 'var(--err-2)' : step.status === 'running' ? 'var(--accent)' : 'var(--text-fainter)' }}>{step.status === 'completed' ? '✓' : step.status === 'failed' ? '!' : step.status === 'running' ? '●' : '○'}</span>
          <span style={{ fontSize: 10.5, color: 'var(--text-bright)', fontWeight: 600 }}>{step.label}</span>
        </div>
        <div role="progressbar" aria-label={`${step.label} progress`} aria-valuenow={step.progress} aria-valuemin={0} aria-valuemax={100} style={{ marginTop: 6, height: 3, borderRadius: 3, background: 'var(--border-2)' }}><div style={{ height: '100%', width: `${step.progress}%`, background: step.status === 'failed' ? 'var(--err)' : step.status === 'completed' ? 'var(--ok)' : 'var(--accent)', borderRadius: 3 }} /></div>
        {step.error && <div style={{ color: 'var(--err-2)', fontSize: 9.5, marginTop: 6 }}>{step.error}</div>}
      </div>)}
    </div>
    {detail.items.length > 0 && <>
      <SectionLabel style={{ marginTop: 16 }}>Items</SectionLabel>
      <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 5 }}>
        {detail.items.map((item) => <div key={item.id} className="automation-item-row" style={{ fontSize: 10.5, padding: '7px 9px', borderRadius: 7, background: 'var(--bg-card)', color: 'var(--text-muted)' }}>
          <span className="me-ellipsis">{item.title}</span><span>{item.currentStep}</span><span style={{ color: item.status === 'failed' ? 'var(--err-2)' : item.status === 'completed' ? 'var(--ok-2)' : 'var(--accent)', textAlign: 'right' }}>{item.status}</span>
          {(item.error || item.warning) && <span style={{ gridColumn: '1 / -1', color: item.error ? 'var(--err-2)' : 'var(--warn)' }}>{item.error || item.warning}</span>}
        </div>)}
      </div>
    </>}
    <SectionLabel style={{ marginTop: 16 }}>Understandable log</SectionLabel>
    <div aria-live="polite" style={{ marginTop: 7, maxHeight: 170, overflowY: 'auto', fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--text-dim)', lineHeight: 1.65 }}>
      {detail.logs.length === 0 ? 'No log entries yet.' : detail.logs.slice(-30).map((row) => <div key={row.id} style={{ color: row.level === 'error' ? 'var(--err-2)' : row.level === 'warning' ? 'var(--warn)' : 'var(--text-dim)' }}>{new Date(row.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {row.message}</div>)}
    </div>
  </div>
}

export function Profiles(): JSX.Element {
  const sourceChannels = useData((state) => state.sourceChannels)
  const automationJobs = useData((state) => state.automationJobs)
  const loadSources = useData((state) => state.loadSources)
  const loadAutomationJobs = useData((state) => state.loadAutomationJobs)
  const preflightAutomation = useData((state) => state.preflightAutomation)
  const createAutomationJob = useData((state) => state.createAutomationJob)
  const pauseJob = useData((state) => state.pauseAutomationJob)
  const resumeJob = useData((state) => state.resumeAutomationJob)
  const cancelJob = useData((state) => state.cancelAutomationJob)
  const retryJob = useData((state) => state.retryAutomationJob)
  const setActive = useStore((state) => state.setActive)
  const settings = useStore((state) => state.settings)

  const [view, setView] = useState<'setup' | 'jobs'>('setup')
  const [stage, setStage] = useState(0)
  const [goal, setGoal] = useState<AutomationGoal>('source-to-export')
  const [sourceKind, setSourceKind] = useState<SourceKind>('saved-source')
  const [sourceId, setSourceId] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [localMediaPaths, setLocalMediaPaths] = useState<string[]>([])
  const [sourceCount, setSourceCount] = useState(3)
  const [sourceOrder, setSourceOrder] = useState<ScrapeOrder>('Latest')
  const [availableVideos, setAvailableVideos] = useState<ScrapedVideo[]>([])
  const [selectedVideoIds, setSelectedVideoIds] = useState<string[]>([])
  const [assets, setAssets] = useState<string[]>([])
  const [libraryAssets, setLibraryAssets] = useState<LibraryAsset[]>([])
  const [style, setStyle] = useState<VideoStyle>('Clean')
  const [captionPreset, setCaptionPreset] = useState('Hormozi')
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('16:9')
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
  const [setupError, setSetupError] = useState('')

  useEffect(() => {
    void Promise.all([loadSources(), loadAutomationJobs(), window.api.assets.list().then(setLibraryAssets)])
      .catch((error) => setSetupError(error instanceof Error ? error.message : String(error)))
  }, [loadSources, loadAutomationJobs])
  useEffect(() => { if (!sourceId && sourceChannels[0]) setSourceId(sourceChannels[0].id) }, [sourceChannels, sourceId])
  useEffect(() => {
    if (sourceKind !== 'saved-source' || !sourceId) { setAvailableVideos([]); return }
    void window.api.sources.videos(sourceId).then(setAvailableVideos).catch(() => setAvailableVideos([]))
  }, [sourceId, sourceKind])
  useEffect(() => {
    if (!expanded?.id) return
    void window.api.automation.job(expanded.id).then((next) => { if (next) setExpanded(next) })
  }, [automationJobs, expanded?.id])

  const source = sourceChannels.find((candidate) => candidate.id === sourceId)
  const sourceReady = sourceKind === 'saved-source' ? !!source : sourceKind === 'youtube-url' ? validYoutubeUrl(sourceUrl) : localMediaPaths.length > 0
  const sourceLabel = sourceKind === 'saved-source'
    ? source?.name || source?.handle || 'Saved source'
    : sourceKind === 'youtube-url' ? sourceUrl.trim() || 'YouTube URL'
      : localMediaPaths.length === 1 ? fileName(localMediaPaths[0]) : `${localMediaPaths.length} local files`

  const draft = useMemo<AutomationJobDraft>(() => ({
    name: `${sourceLabel} · ${formatGoal(goal)}`,
    goal,
    config: {
      sourceKind,
      sourceId: sourceKind === 'saved-source' ? source?.id ?? '' : '',
      sourceUrl: sourceKind === 'saved-source' ? source?.url ?? '' : sourceKind === 'youtube-url' ? sourceUrl.trim() : '',
      sourceName: sourceLabel,
      sourceOrder,
      sourceCount: sourceKind === 'local-files' ? Math.max(1, localMediaPaths.length) : sourceCount,
      selectedVideoIds: sourceKind === 'saved-source' ? selectedVideoIds : [],
      localMediaPaths,
      assetPaths: assets,
      style,
      captionPreset,
      aspectRatios: [aspectRatio],
      execution: 'local',
      rules: {
        minDurationSec: minDuration, skipDownloaded, continueOnError, maxRetries: retries,
        minimumFreeSpaceGb: reserveGb, captions, autoBroll, removeSilence: false, reduceFillerWords: false, keepAwake: true
      },
      notify: { desktop: desktopNotify, webhook: webhookNotify, sound: desktopNotify, email: false }
    }
  }), [sourceLabel, goal, sourceKind, source, sourceUrl, sourceOrder, sourceCount, localMediaPaths, selectedVideoIds, assets, style, captionPreset, aspectRatio, minDuration, skipDownloaded, continueOnError, retries, reserveGb, captions, autoBroll, desktopNotify, webhookNotify])

  const chooseGoal = (next: AutomationGoal): void => {
    const definition = AUTOMATION_GOALS.find((candidate) => candidate.id === next)
    if (!definition?.available) return
    setGoal(next)
    if (next === 'transcribe-subtitle') setCaptions(true)
    if (next === 'batch-source') setSourceCount((current) => Math.max(5, current))
    setSetupError('')
  }
  const chooseFiles = (files: FileList | null, setter: Dispatch<SetStateAction<string[]>>): void => {
    if (!files) return
    const paths = Array.from(files).map((file) => window.api.pathForFile(file)).filter(Boolean)
    setter((current) => [...new Set([...current, ...paths])])
  }
  const goReview = async (): Promise<void> => {
    setSetupError(''); setPreflight(null); setStage(4)
    try { setPreflight(await preflightAutomation(draft)) }
    catch (error) { setSetupError(error instanceof Error ? error.message : String(error)) }
  }
  const start = async (): Promise<void> => {
    setStarting(true); setSetupError('')
    try {
      const checked = await preflightAutomation(draft)
      setPreflight(checked)
      if (!checked?.ok) return
      const job = await createAutomationJob(draft)
      if (job) { setExpanded(job); setView('jobs') }
    } catch (error) { setSetupError(error instanceof Error ? error.message : String(error)) }
    finally { setStarting(false) }
  }
  const showDetails = async (job: AutomationJob): Promise<void> => {
    if (expanded?.id === job.id) { setExpanded(null); return }
    try { setExpanded(await window.api.automation.job(job.id)) }
    catch (error) { setSetupError(error instanceof Error ? error.message : String(error)) }
  }
  const duplicate = (job: AutomationJob): void => {
    setGoal(job.goal); setSourceKind(job.config.sourceKind); setSourceId(job.config.sourceId); setSourceUrl(job.config.sourceUrl)
    setLocalMediaPaths(job.config.localMediaPaths); setSourceCount(job.config.sourceCount); setSourceOrder(job.config.sourceOrder)
    setSelectedVideoIds(job.config.selectedVideoIds); setAssets(job.config.assetPaths); setStyle(job.config.style)
    setCaptionPreset(job.config.captionPreset); setAspectRatio(job.config.aspectRatios[0] ?? '16:9'); setCaptions(job.config.rules.captions)
    setAutoBroll(job.config.rules.autoBroll); setContinueOnError(job.config.rules.continueOnError); setSkipDownloaded(job.config.rules.skipDownloaded)
    setRetries(job.config.rules.maxRetries); setReserveGb(job.config.rules.minimumFreeSpaceGb); setStage(0); setPreflight(null); setSetupError(''); setView('setup')
  }

  const activeJob = automationJobs.find((job) => job.status === 'running' || job.status === 'pausing')

  return <ScreenPad>
    <div className="automation-header">
      <div style={{ flex: 1 }}><div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '1px', color: 'var(--accent)', marginBottom: 6 }}>AUTOMATION STUDIO</div><h1 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 27, fontWeight: 600, color: 'var(--text-bright)' }}>Choose an outcome. Come back to finished work.</h1><div style={{ color: 'var(--text-dim)', fontSize: 12.5, marginTop: 7, maxWidth: 760, lineHeight: 1.5 }}>Configure one production goal. A persistent local supervisor advances the workflow, saves checkpoints, retries safe failures, and pauses only when your input is needed.</div></div>
      <div role="tablist" aria-label="Automation views" className="automation-view-tabs"><button type="button" role="tab" aria-selected={view === 'setup'} onClick={() => setView('setup')} className={view === 'setup' ? 'active' : ''}>New automation</button><button type="button" role="tab" aria-selected={view === 'jobs'} onClick={() => setView('jobs')} className={view === 'jobs' ? 'active' : ''}>Jobs {automationJobs.length ? `(${automationJobs.length})` : ''}</button></div>
    </div>
    <Banner kind="info" style={{ marginBottom: 16, whiteSpace: 'normal' }}><b style={{ color: 'var(--text-bright)' }}>Local background execution:</b> you can leave this tab, and with tray mode enabled you can close the window. The app process and computer must remain running. Sleep pauses work; shutdown stops it until the next app start.</Banner>

    {view === 'setup' ? <>
      <nav aria-label="Automation setup progress" className="automation-setup-steps">{SETUP_STEPS.map((label, index) => <button type="button" key={label} aria-current={index === stage ? 'step' : undefined} onClick={() => { if (index <= stage) { setStage(index); setSetupError('') } }} disabled={index > stage}><div className={index < stage ? 'done' : index === stage ? 'current' : ''} /><span>{index + 1}. {label}</span></button>)}</nav>

      {stage === 0 && <Panel><SectionLabel>What do you want to finish?</SectionLabel><div className="automation-goal-grid">{AUTOMATION_GOALS.map((definition) => { const selected = goal === definition.id; return <button type="button" key={definition.id} onClick={() => chooseGoal(definition.id)} disabled={!definition.available} aria-pressed={selected} className="automation-goal-card" style={{ borderColor: selected ? 'var(--accent)' : undefined, background: selected ? 'var(--accent-soft)' : undefined }}><div><strong style={{ color: selected ? 'var(--accent)' : 'var(--text-bright)' }}>{definition.title}</strong><span>{definition.available ? 'READY' : 'LATER'}</span></div><p>{definition.description}</p>{definition.availabilityNote && <small>{definition.availabilityNote}</small>}</button> })}</div></Panel>}

      {stage === 1 && <>
        <Panel><SectionLabel>Choose source and content</SectionLabel>
          <div role="radiogroup" aria-label="Content source type" className="automation-source-types">{([['saved-source','Saved source'],['youtube-url','YouTube URL'],['local-files','Local files']] as const).map(([kind, label]) => <button type="button" role="radio" aria-checked={sourceKind === kind} key={kind} onClick={() => { setSourceKind(kind); setSelectedVideoIds([]); setSetupError('') }} className={sourceKind === kind ? 'active' : ''}>{label}</button>)}</div>
          {sourceKind === 'saved-source' && (sourceChannels.length === 0
            ? <EmptyState title="No saved sources yet" body="Add a source in Sources, paste a YouTube link here, or choose local media. You are not blocked on a separate setup screen." action={<Btn variant="soft" onClick={() => setActive('sources')}>Open Sources</Btn>} />
            : <div className="automation-source-grid"><Field label="Saved source"><select value={sourceId} onChange={(event) => { const next = sourceChannels.find((candidate) => candidate.id === event.target.value); setSourceId(event.target.value); setSelectedVideoIds([]); setAutoBroll(!!next?.betaOpts?.broll.enabled) }} style={input}>{sourceChannels.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name || candidate.handle}</option>)}</select></Field><SourceRuleFields count={sourceCount} setCount={setSourceCount} order={sourceOrder} setOrder={setSourceOrder} /></div>)}
          {sourceKind === 'youtube-url' && <div className="automation-source-grid"><Field label="Channel, playlist, or video URL" hint="HTTPS YouTube links only. The worker reads the source when the job starts."><input type="url" aria-invalid={sourceUrl.trim() ? !validYoutubeUrl(sourceUrl) : undefined} value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=…" style={{ ...input, borderColor: sourceUrl.trim() && !validYoutubeUrl(sourceUrl) ? 'var(--err)' : undefined }} />{sourceUrl.trim() && !validYoutubeUrl(sourceUrl) && <span role="alert" style={{ display: 'block', color: 'var(--err-2)', fontSize: 9.5, marginTop: 5 }}>Enter a valid HTTPS youtube.com or youtu.be link.</span>}</Field><SourceRuleFields count={sourceCount} setCount={setSourceCount} order={sourceOrder} setOrder={setSourceOrder} /></div>}
          {sourceKind === 'local-files' && <div style={{ marginTop: 13 }}><label className="automation-file-picker"><input type="file" accept="audio/*,video/*,.mkv,.webm" multiple onChange={(event) => chooseFiles(event.target.files, setLocalMediaPaths)} />＋ Choose local audio or video files</label><div aria-live="polite" style={{ marginTop: 9, color: localMediaPaths.length ? 'var(--ok-2)' : 'var(--text-faint)', fontSize: 10.5 }}>{localMediaPaths.length ? `${localMediaPaths.length} local file${localMediaPaths.length === 1 ? '' : 's'} selected` : 'MP3, WAV, M4A, MP4, MOV, MKV, and WebM are supported'}</div>{localMediaPaths.map((path) => <div key={path} className="me-ellipsis" title={path} style={{ color: 'var(--text-dim)', fontSize: 10, marginTop: 5 }}>{path}</div>)}</div>}
          <div className="automation-rule-summary">{sourceKind === 'local-files' ? `The worker imports ${localMediaPaths.length || 'your selected'} file${localMediaPaths.length === 1 ? '' : 's'} and preserves the originals.` : `Process ${sourceCount} ${sourceOrder.toLowerCase()} video${sourceCount === 1 ? '' : 's'}${minDuration ? ` longer than ${Math.round(minDuration / 60)} minutes` : ''}; reuse valid downloads.`}</div>
        </Panel>
        {sourceKind === 'saved-source' && availableVideos.length > 0 && <Panel style={{ marginTop: 10 }}><div style={{ display: 'flex', alignItems: 'center' }}><SectionLabel style={{ flex: 1 }}>Pick individual videos (optional)</SectionLabel>{selectedVideoIds.length > 0 && <button type="button" onClick={() => setSelectedVideoIds([])} className="automation-link-button">Use automatic rules</button>}</div><div style={{ color: 'var(--text-dim)', fontSize: 10.5, marginTop: 6 }}>Select exact cached videos, or leave all unchecked to use count, order, and duration rules.</div><div className="automation-video-grid">{availableVideos.slice(0, 20).map((video) => <label key={video.id} className={selectedVideoIds.includes(video.id) ? 'selected' : ''}><input type="checkbox" checked={selectedVideoIds.includes(video.id)} onChange={(event) => setSelectedVideoIds((current) => event.target.checked ? [...current, video.id] : current.filter((id) => id !== video.id))} /><span className="me-ellipsis">{video.title}</span><small>{Math.max(1, Math.round(video.durationSec / 60))}m</small></label>)}</div></Panel>}
      </>}

      {stage === 2 && <div className="automation-two-column">
        <Panel><SectionLabel>Visual assets</SectionLabel><div className="automation-help">Add new images or reuse assets from completed projects. The worker copies them into each generated project.</div><label className="automation-file-picker"><input type="file" accept="image/*" multiple onChange={(event) => chooseFiles(event.target.files, setAssets)} />＋ Add images, logos, or visual assets</label><div aria-live="polite" style={{ marginTop: 9, color: assets.length ? 'var(--ok-2)' : 'var(--text-faint)', fontSize: 10.5 }}>{assets.length ? `${assets.length} asset${assets.length === 1 ? '' : 's'} selected` : 'No assets selected'}</div>{libraryAssets.length > 0 && <Section label={`Previously used assets (${libraryAssets.length})`} defaultOpen={false}><div className="automation-library-assets">{libraryAssets.slice(0, 40).map((asset) => <label key={asset.path} title={asset.path} className={assets.includes(asset.path) ? 'selected' : ''}><input type="checkbox" checked={assets.includes(asset.path)} onChange={(event) => setAssets((current) => event.target.checked ? [...new Set([...current, asset.path])] : current.filter((path) => path !== asset.path))} /><span className="me-ellipsis">{fileName(asset.path)}</span></label>)}</div></Section>}<ToggleRow label="Use automatic B-roll" hint="Requires a configured stock provider or a warmed local pool." on={autoBroll} onToggle={() => setAutoBroll((value) => !value)} /></Panel>
        <Panel><SectionLabel>Editing and export</SectionLabel><div className="automation-style-grid">{STYLES.map((candidate) => <button type="button" key={candidate} onClick={() => setStyle(candidate)} className={style === candidate ? 'active' : ''}>{candidate}</button>)}</div><div className="automation-config-grid"><Field label="Subtitle preset"><select value={captionPreset} onChange={(event) => setCaptionPreset(event.target.value)} style={input}><option>Hormozi</option><option>Submagic</option><option>Clean</option><option>Minimal</option></select></Field><Field label="Export aspect ratio"><select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as AspectRatio)} style={input}><option value="16:9">16:9 · Landscape</option><option value="9:16">9:16 · Vertical</option><option value="1:1">1:1 · Square</option></select></Field></div><ToggleRow label="Transcribe and add captions" hint={settings.transcription.apiKey.trim() ? 'Uses the configured online transcription service; timed words are stored locally.' : 'Needs a Groq key in Settings. Turn this off to continue without captions.'} on={captions} onToggle={() => setCaptions((value) => !value)} /></Panel>
      </div>}

      {stage === 3 && <Panel><SectionLabel>How should the supervisor behave?</SectionLabel><div className="automation-two-column rules"><div><ToggleRow label="Continue when one item fails" hint="Isolate failed items while the rest of the batch keeps moving." on={continueOnError} onToggle={() => setContinueOnError((value) => !value)} /><ToggleRow label="Reuse completed downloads" hint="Validate and reuse an existing local download instead of repeating it." on={skipDownloaded} onToggle={() => setSkipDownloaded((value) => !value)} /><ToggleRow label="Desktop completion notification" hint="Receive completion or action-needed messages while the window is hidden." on={desktopNotify} onToggle={() => setDesktopNotify((value) => !value)} /><ToggleRow label="Send configured webhook" hint={settings.background.webhook ? 'Send a structured completion summary to the configured endpoint.' : 'No webhook is configured in Settings.'} on={webhookNotify} onToggle={() => setWebhookNotify((value) => !value)} disabled={!settings.background.webhook} /></div><div><Field label="Automatic retry limit"><input type="number" min={0} max={8} value={retries} onChange={(event) => setRetries(Math.max(0, Math.min(8, Number(event.target.value) || 0)))} style={input} /></Field>{sourceKind !== 'local-files' && <Field label="Minimum duration (minutes)"><input type="number" min={0} max={600} value={Math.round(minDuration / 60)} onChange={(event) => setMinDuration(Math.max(0, Number(event.target.value) * 60 || 0))} style={input} /></Field>}<Field label="Keep free-space reserve (GB)"><input type="number" min={1} max={100} value={reserveGb} onChange={(event) => setReserveGb(Math.max(1, Number(event.target.value) || 1))} style={input} /></Field></div></div><Section label="Advanced automation" defaultOpen={false}><div className="automation-help">This worker processes one orchestration at a time, keeps the computer awake, checkpoints every major stage, and pauses at a safe item boundary. Silence removal, filler-word reduction, scheduling, multi-output variants, and post-job sleep/shutdown remain disabled because the current media engine does not expose them safely.</div></Section></Panel>}

      {stage === 4 && <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}><Panel><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><SectionLabel style={{ flex: 1 }}>Generated workflow</SectionLabel><span style={{ fontSize: 9.5, color: 'var(--ok-2)', fontFamily: 'var(--font-mono)' }}>AUTO-BUILT FROM YOUR GOAL</span></div><div style={{ marginTop: 12 }}><WorkflowPreview draft={draft} /></div></Panel><div className="automation-review-grid"><Panel><SectionLabel>Ready-to-run summary</SectionLabel><div className="automation-summary"><span>Final goal</span><b>{formatGoal(goal)}</b><span>Source & items</span><b>{sourceLabel} · {sourceKind === 'local-files' ? localMediaPaths.length : selectedVideoIds.length || sourceCount} item(s)</b><span>Editing preset</span><b>{style} · {captions ? `${captionPreset} captions` : 'captions off'} · {aspectRatio} · {assets.length} assets{autoBroll ? ' + Auto B-roll' : ''}</b><span>Retry / failure</span><b>{retries} automatic retries · {continueOnError ? 'continue other items' : 'pause the batch'}</b><span>Execution</span><b>Local background worker · {settings.encoder === 'cpu' ? 'CPU' : settings.encoder.toUpperCase()} · {settings.quality}</b><span>Notifications</span><b>{[desktopNotify && 'desktop', webhookNotify && 'webhook'].filter(Boolean).join(' + ') || 'in-app only'}</b></div></Panel><Panel><SectionLabel>Preflight</SectionLabel>{!preflight ? <div aria-live="polite" style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 12 }}>Checking configuration…</div> : <><div style={{ marginTop: 11, color: preflight.ok ? 'var(--ok-2)' : 'var(--err-2)', fontWeight: 700, fontSize: 12 }}>{preflight.ok ? '✓ Ready to run unattended' : 'Action required before start'}</div><div style={{ marginTop: 10, color: 'var(--text-dim)', fontSize: 10.5, lineHeight: 1.55 }}>~{preflight.estimatedStorageGb.toFixed(1)} GB · ~{preflight.estimatedMinutes} min<br />{preflight.appMessage}<br />{preflight.powerMessage}</div>{preflight.blockers.map((message) => <div key={message} style={{ color: 'var(--err-2)', fontSize: 10.5, marginTop: 7 }}>• {message}</div>)}{preflight.warnings.map((message) => <div key={message} style={{ color: 'var(--warn)', fontSize: 10.5, marginTop: 7 }}>• {message}</div>)}</>}</Panel></div></div>}

      {setupError && <div role="alert" style={{ marginTop: 12 }}><Banner kind="error"><b>Couldn’t continue:</b> {setupError}</Banner></div>}
      <div className="automation-footer-actions"><Btn disabled={stage === 0} onClick={() => { setStage(Math.max(0, stage - 1)); setSetupError('') }}>Back</Btn><div style={{ flex: 1 }} />{stage < 3 && <Btn variant="primary" disabled={(stage === 0 && !AUTOMATION_GOALS.find((definition) => definition.id === goal)?.available) || (stage === 1 && !sourceReady)} onClick={() => { setStage(stage + 1); setSetupError('') }}>Continue</Btn>}{stage === 3 && <Btn variant="primary" disabled={!sourceReady || (!assets.length && !autoBroll)} onClick={() => void goReview()}>Review workflow</Btn>}{stage === 4 && <Btn variant="primary" disabled={!preflight?.ok || starting} onClick={() => void start()} style={{ padding: '11px 20px' }}>{starting ? 'Starting…' : '▶ Start automation and run until complete'}</Btn>}</div>
    </> : <>
      <div className="automation-jobs-heading"><div><h2>Automation jobs</h2><p>Durable production goals loaded from SQLite—not browser memory.</p></div><Btn variant="soft" onClick={() => { setStage(0); setSetupError(''); setView('setup') }}>＋ New automation</Btn></div>
      {activeJob && <div className="automation-live-strip" aria-live="polite"><span><b>LIVE</b> · {activeJob.currentStep}</span><span>ETA {jobEta(activeJob)}</span><span>Started {activeJob.startedAt ? new Date(activeJob.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'now'}</span><span>{settings.encoder === 'cpu' ? 'CPU' : settings.encoder.toUpperCase()} · {settings.quality}</span></div>}
      {automationJobs.length === 0 ? <EmptyState title="No automation jobs yet" body="Choose a goal to build your first unattended workflow. It will appear here before processing starts." action={<Btn variant="primary" onClick={() => setView('setup')}>Create automation</Btn>} /> : <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>{automationJobs.map((job) => {
        const active = job.status === 'running' || job.status === 'queued' || job.status === 'pausing'
        const needsAttention = job.status === 'attention' || job.status === 'failed'
        return <article key={job.id} className="automation-job-card" style={{ borderColor: needsAttention ? '#4a2530' : job.status === 'completed' ? '#1f382f' : undefined }}><div className="automation-job-body"><div className="automation-job-title"><div aria-hidden="true" className={`automation-job-icon ${active ? 'active' : ''}`}>{active ? '▶' : job.status === 'completed' ? '✓' : needsAttention ? '!' : '■'}</div><div style={{ flex: 1, minWidth: 0 }}><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><strong className="me-ellipsis">{job.name}</strong><JobStatus status={job.status} /></div><div style={{ color: 'var(--text-dim)', fontSize: 10.5, marginTop: 4 }}>{formatGoal(job.goal)} · {job.config.sourceName} · {job.totalItems || job.config.sourceCount} items</div></div><div style={{ textAlign: 'right' }}><b style={{ fontFamily: 'var(--font-mono)', color: job.status === 'completed' ? 'var(--ok-2)' : 'var(--accent)', fontSize: 15 }}>{job.progress}%</b><small>overall</small></div></div><div role="progressbar" aria-label={`${job.name} progress`} aria-valuenow={job.progress} aria-valuemin={0} aria-valuemax={100} className="automation-job-progress"><div style={{ width: `${job.progress}%`, background: needsAttention ? 'var(--err)' : job.status === 'completed' ? 'var(--ok)' : undefined }} /></div><div className="automation-job-metrics"><div><span>CURRENT STEP</span><b>{job.currentStep || 'Waiting'}</b></div><div><span>ITEMS</span><b>{job.completedCount} done · {job.failedCount} failed</b></div><div><span>CHECKPOINT</span><b>{job.lastCheckpointAt ? new Date(job.lastCheckpointAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'not started'}</b></div><div><span>OUTPUT</span><b className="me-ellipsis">{job.result?.outputPaths[0] || settings.libraryFolder || settings.outputFolder || 'Mental Empire Studio library'}</b></div></div>{job.error && <div role="alert" className="automation-job-error"><b>What happened:</b> {job.error}<br /><span>Other items may continue when safe. Completed checkpoints remain available for resume or retry.</span></div>}<div className="automation-job-actions">{(job.status === 'running' || job.status === 'queued') && <Btn size="sm" onClick={() => void pauseJob(job.id)}>Pause</Btn>}{(job.status === 'paused' || job.status === 'attention' || job.status === 'failed') && <Btn size="sm" variant="soft" onClick={() => void resumeJob(job.id)}>Resume</Btn>}{job.failedCount > 0 && ['failed','completed_with_warnings','attention'].includes(job.status) && <Btn size="sm" variant="soft" onClick={() => void retryJob(job.id)}>Retry failed items</Btn>}{(active || job.status === 'paused' || job.status === 'attention' || job.status === 'failed') && <Btn size="sm" variant="danger" onClick={() => void cancelJob(job.id)}>Cancel</Btn>}<Btn size="sm" onClick={() => void showDetails(job)}>{expanded?.id === job.id ? 'Hide details' : 'View details'}</Btn>{job.result?.outputPaths[0] && <Btn size="sm" onClick={() => void window.api.publish.reveal(job.result!.outputPaths[0])}>Open output</Btn>}<Btn size="sm" onClick={() => duplicate(job)}>Duplicate workflow</Btn><Btn size="sm" onClick={() => window.api.openLogs()}>Technical logs</Btn></div></div>{expanded?.id === job.id && <JobDetails detail={expanded} />}</article>
      })}</div>}
      {setupError && <div role="alert" style={{ marginTop: 12 }}><Banner kind="error">{setupError}</Banner></div>}
    </>}
  </ScreenPad>
}
