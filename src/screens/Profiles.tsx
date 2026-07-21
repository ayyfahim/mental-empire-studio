import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react'
import { useStore } from '../store/useStore'
import { useData } from '../store/useData'
import { useTalkingPhotos } from '../store/useTalkingPhotos'
import { ScreenPad } from '../components/primitives'
import { Banner, Btn, EmptyState, Panel, Section, SectionLabel, ToggleRow } from '../components/ui/kit'
import { AUTOMATION_GOALS, buildAutomationWorkflow, formatGoal } from '@shared/automation'
import { DEFAULT_AUTOMATION_RULES, DEFAULT_AUTOMATION_STYLE, DEFAULT_TALKINGPHOTOS_AUTOMATION } from '@shared/automationConfig'
import { automationDraftReducer, createDefaultDraft } from '@shared/automationDraft'
import { SourcePickerModal } from '../features/automation/SourcePickerModal'
import { AssetLibraryModal } from '../features/automation/AssetLibraryModal'
import { mediaSrc } from '../lib/media'
import type {
  AutomationGoal,
  AutomationJob,
  AutomationJobDetail,
  AutomationJobDraft,
  AutomationPreflight,
  LibraryAsset,
  Niche,
  NichePoolHealth,
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
  const steps = buildAutomationWorkflow('preview', draft.config, draft.goal)
  return <div className="automation-workflow-preview">
    {steps.map((step, index) => <div key={step.key} style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
      <div title={step.description} style={{ border: '1px solid var(--border-2)', background: 'var(--bg-inset)', color: 'var(--text-muted)', borderRadius: 8, padding: '7px 10px', fontSize: 10.5, whiteSpace: 'nowrap' }}>
        <span style={{ color: step.runsOn === 'online-service' ? '#7ca6ff' : 'var(--ok-2)', marginRight: 5 }}>●</span>{step.label}
      </div>
      {index < steps.length - 1 && <span aria-hidden="true" style={{ color: 'var(--text-fainter)' }}>→</span>}
    </div>)}
  </div>
}

function JobDetails({ detail, onOpenProject }: { detail: AutomationJobDetail; onOpenProject: (projectId: string) => void }): JSX.Element {
  const style = detail.config.styleConfig
  return <div style={{ borderTop: '1px solid var(--border)', padding: 15, background: 'var(--bg-inset)' }}>
    <SectionLabel>Effective configuration</SectionLabel>
    <div className="automation-job-metrics" style={{ marginBottom: 14 }}>
      <div><span>CAPTIONS</span><b>{detail.config.rules.captions ? `${style.captionPreset} · ${style.captionFont} · ${style.captionPosition}${style.captionOffsetY != null ? ` @ ${style.captionOffsetY}%` : ''} · ${style.captionLines} line${style.captionLines === 1 ? '' : 's'} · ${style.captionPace}` : 'Disabled'}</b></div>
      <div><span>VISUALS</span><b>{detail.config.assetPaths.length} assets · {style.imageMode} · {style.motionPreset} · {style.crossfadeSec}s · gradient {style.gradientEdge} {style.gradientIntensity}%</b></div>
      <div><span>B-ROLL</span><b>{detail.config.rules.autoBroll ? `${style.brollPoolKey || 'automatic pool'} · ${style.brollFallbackPolicy} · ${style.brollShufflePolicy}` : 'Disabled'}</b></div>
      <div><span>EXPORT</span><b>{style.videoStyle} · {style.aspectRatio}</b></div>
    </div>
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
          <span className="me-ellipsis">{item.title}</span><span>{item.retryAt ? `Waiting for retry · attempt ${item.attempts + 1}/${detail.config.rules.maxRetries + 1} · ${new Date(item.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : item.currentStep}</span><span style={{ color: item.status === 'failed' ? 'var(--err-2)' : item.status === 'completed' ? 'var(--ok-2)' : item.status === 'skipped' ? 'var(--warn)' : 'var(--accent)', textAlign: 'right' }}>{item.status}</span>
          {item.selectionDecision && <span style={{ gridColumn: '1 / -1', color: item.selectionDecision.matchType === 'ambiguous-title' ? 'var(--warn)' : 'var(--text-faint)' }}>Upload decision: {item.selectionDecision.matchType} · confidence {item.selectionDecision.score.toFixed(2)} · {item.selectionDecision.action}</span>}
          {(item.brollSeed !== undefined || item.brollClipIds?.length) && <span style={{ gridColumn: '1 / -1', color: 'var(--text-faint)' }}>B-roll seed {item.brollSeed ?? '—'} · {item.brollClipIds?.length ?? 0} recorded clips</span>}
          {item.outputPath && <span className="me-ellipsis" title={item.outputPath} style={{ gridColumn: '1 / -1', color: 'var(--ok-2)' }}>Output: {item.outputPath}</span>}
          {item.projectId && <span style={{ gridColumn: '1 / -1' }}><Btn size="sm" onClick={() => onOpenProject(item.projectId!)}>Open resulting project</Btn></span>}
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
  const workItems = useData((state) => state.workItems)
  const loadSources = useData((state) => state.loadSources)
  const loadAutomationJobs = useData((state) => state.loadAutomationJobs)
  const preflightAutomation = useData((state) => state.preflightAutomation)
  const createAutomationJob = useData((state) => state.createAutomationJob)
  const pauseJob = useData((state) => state.pauseAutomationJob)
  const resumeJob = useData((state) => state.resumeAutomationJob)
  const cancelJob = useData((state) => state.cancelAutomationJob)
  const retryJob = useData((state) => state.retryAutomationJob)
  const openProjectById = useData((state) => state.openProjectById)
  const setActive = useStore((state) => state.setActive)
  const settings = useStore((state) => state.settings)
  const talkingPhotosEnabled = settings.integrations.talkingPhotos.enabled
  const talkingPhotosStatus = useTalkingPhotos((state) => state.connection?.status ?? 'disconnected')
  // The shared goal catalog can't know about live provider state — patch the one
  // goal that depends on it instead of hardcoding a second copy of AUTOMATION_GOALS.
  const automationGoals = useMemo(() => AUTOMATION_GOALS.map((definition) => {
    if (definition.id !== 'talkingphotos-video' || !definition.available) return definition
    if (!talkingPhotosEnabled) return { ...definition, available: false, availabilityNote: 'Enable TalkingPhotos in Settings → Integrations first.' }
    if (talkingPhotosStatus !== 'connected') return { ...definition, available: false, availabilityNote: 'Connect your TalkingPhotos account in Settings or Talking Video first.' }
    return definition
  }), [talkingPhotosEnabled, talkingPhotosStatus])

  const [view, setView] = useState<'setup' | 'jobs'>('setup')
  const [stage, setStage] = useState(0)
  const [draftState, dispatchDraft] = useReducer(automationDraftReducer, settings, () => createDefaultDraft(settings))
  const [availableVideos, setAvailableVideos] = useState<ScrapedVideo[]>([])
  const [libraryAssets, setLibraryAssets] = useState<LibraryAsset[]>([])
  const [niches, setNiches] = useState<Niche[]>([])
  const [poolHealth, setPoolHealth] = useState<NichePoolHealth[]>([])
  const [preflight, setPreflight] = useState<AutomationPreflight | null>(null)
  const [starting, setStarting] = useState(false)
  const [expanded, setExpanded] = useState<AutomationJobDetail | null>(null)
  const [setupError, setSetupError] = useState('')
  const [sourceModalOpen, setSourceModalOpen] = useState(false)
  const [assetModalOpen, setAssetModalOpen] = useState(false)
  const [sourceLoadError, setSourceLoadError] = useState('')
  const [jobActionPending, setJobActionPending] = useState<Record<string, boolean>>({})
  const sourceBrowseRef = useRef<HTMLButtonElement>(null)
  const assetBrowseRef = useRef<HTMLButtonElement>(null)
  const activeDraftId = useRef(draftState.id)
  activeDraftId.current = draftState.id

  const config = draftState.draft.config
  const talkingPhotos = config.talkingPhotos ?? DEFAULT_TALKINGPHOTOS_AUTOMATION
  const goal = draftState.draft.goal
  const sourceKind = config.sourceKind
  const sourceId = config.sourceId
  const sourceUrl = config.sourceUrl
  const localMediaPaths = config.localMediaPaths
  const sourceCount = config.sourceCount
  const sourceOrder = config.sourceOrder
  const selectedVideoIds = config.selectedVideoIds
  const assets = config.assetPaths
  const style = config.styleConfig.videoStyle
  const captionPreset = config.styleConfig.captionPreset
  const aspectRatio = config.styleConfig.aspectRatio
  const captions = config.rules.captions
  const autoBroll = config.rules.autoBroll
  const continueOnError = config.rules.continueOnError
  const skipDownloaded = config.rules.skipDownloaded
  const minDuration = config.rules.minDurationSec
  const retries = config.rules.maxRetries
  const reserveGb = config.rules.minimumFreeSpaceGb
  const desktopNotify = config.notify.desktop
  const webhookNotify = config.notify.webhook

  const updateConfig = <K extends keyof typeof config>(key: K, value: SetStateAction<(typeof config)[K]>): void => {
    const next = typeof value === 'function' ? (value as (previous: (typeof config)[K]) => (typeof config)[K])(config[key]) : value
    dispatchDraft({ type: 'patch-config', patch: { [key]: next } })
  }
  const updateRule = <K extends keyof typeof config.rules>(key: K, value: SetStateAction<(typeof config.rules)[K]>): void => {
    const next = typeof value === 'function' ? (value as (previous: (typeof config.rules)[K]) => (typeof config.rules)[K])(config.rules[key]) : value
    dispatchDraft({ type: 'patch-rules', patch: { [key]: next } })
  }
  const updateStyle = <K extends keyof typeof config.styleConfig>(key: K, value: (typeof config.styleConfig)[K]): void => dispatchDraft({ type: 'patch-style', patch: { [key]: value } })
  const updateTalkingPhotos = <K extends keyof typeof talkingPhotos>(key: K, value: (typeof talkingPhotos)[K]): void => updateConfig('talkingPhotos', { ...talkingPhotos, [key]: value })
  const setGoal = (value: AutomationGoal): void => dispatchDraft({ type: 'goal', goal: value })
  const setSourceKind = (value: SetStateAction<SourceKind>): void => updateConfig('sourceKind', value)
  const setSourceUrl = (value: SetStateAction<string>): void => updateConfig('sourceUrl', value)
  const setLocalMediaPaths: Dispatch<SetStateAction<string[]>> = (value) => updateConfig('localMediaPaths', value)
  const setSourceCount: Dispatch<SetStateAction<number>> = (value) => updateConfig('sourceCount', value)
  const setSourceOrder: Dispatch<SetStateAction<ScrapeOrder>> = (value) => updateConfig('sourceOrder', value)
  const setSelectedVideoIds: Dispatch<SetStateAction<string[]>> = (value) => updateConfig('selectedVideoIds', value)
  const setAssets: Dispatch<SetStateAction<string[]>> = (value) => updateConfig('assetPaths', value)
  const setStyle = (value: VideoStyle): void => updateStyle('videoStyle', value)
  const setCaptionPreset = (value: string): void => updateStyle('captionPreset', value)
  const setAspectRatio = (value: AspectRatio): void => updateStyle('aspectRatio', value)
  const setCaptions = (value: SetStateAction<boolean>): void => updateRule('captions', value)
  const setAutoBroll = (value: SetStateAction<boolean>): void => {
    const next = typeof value === 'function' ? value(autoBroll) : value
    updateRule('autoBroll', next)
    updateStyle('brollMode', next && config.styleConfig.brollMode === 'off' ? 'full' : next ? config.styleConfig.brollMode : 'off')
  }
  const setContinueOnError = (value: SetStateAction<boolean>): void => updateRule('continueOnError', value)
  const setSkipDownloaded = (value: SetStateAction<boolean>): void => updateRule('skipDownloaded', value)
  const setMinDuration = (value: number): void => updateRule('minDurationSec', value)
  const setRetries = (value: number): void => updateRule('maxRetries', value)
  const setReserveGb = (value: number): void => updateRule('minimumFreeSpaceGb', value)
  const setDesktopNotify = (value: SetStateAction<boolean>): void => {
    const next = typeof value === 'function' ? value(desktopNotify) : value
    dispatchDraft({ type: 'patch-config', patch: { notify: { ...config.notify, desktop: next, sound: next } } })
  }
  const setWebhookNotify = (value: SetStateAction<boolean>): void => {
    const next = typeof value === 'function' ? value(webhookNotify) : value
    dispatchDraft({ type: 'patch-config', patch: { notify: { ...config.notify, webhook: next } } })
  }

  useEffect(() => {
    const requestId = draftState.id
    void Promise.all([loadSources(), loadAutomationJobs(), window.api.assets.list(), window.api.niche.list(), window.api.niche.poolHealth()])
      .then(([, , assetRows, nicheRows, healthRows]) => { if (activeDraftId.current === requestId) { setLibraryAssets(assetRows); setNiches(nicheRows); setPoolHealth(healthRows) } })
      .catch((error) => setSetupError(error instanceof Error ? error.message : String(error)))
  }, [loadSources, loadAutomationJobs, draftState.id])
  useEffect(() => {
    if (sourceKind !== 'saved-source' || !sourceId) { setAvailableVideos([]); return }
    const requestId = draftState.id
    void window.api.sources.videos(sourceId).then((rows) => { if (activeDraftId.current === requestId) setAvailableVideos(rows) }).catch((error) => { if (activeDraftId.current === requestId) { setAvailableVideos([]); setSourceLoadError(error instanceof Error ? error.message : String(error)) } })
  }, [sourceId, sourceKind, draftState.id])
  useEffect(() => {
    if (!expanded?.id) return
    void window.api.automation.job(expanded.id).then((next) => { if (next) setExpanded(next) })
  }, [automationJobs, expanded?.id])
  useEffect(() => {
    document.querySelectorAll<HTMLInputElement>('.automation-file-picker input[type="file"]').forEach((node) => { node.value = '' })
  }, [draftState.id])

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
      ...config,
      sourceId: sourceKind === 'saved-source' ? source?.id ?? '' : '',
      sourceUrl: sourceKind === 'saved-source' ? source?.url ?? '' : sourceKind === 'youtube-url' ? sourceUrl.trim() : '',
      sourceName: sourceLabel,
      sourceCount: sourceKind === 'local-files' ? Math.max(1, localMediaPaths.length) : sourceCount,
      selectedVideoIds: sourceKind === 'saved-source' ? selectedVideoIds : []
    }
  }), [config, sourceLabel, goal, sourceKind, source, sourceUrl, sourceCount, localMediaPaths, selectedVideoIds])

  const chooseGoal = (next: AutomationGoal): void => {
    const definition = automationGoals.find((candidate) => candidate.id === next)
    if (!definition?.available) return
    setGoal(next)
    if (next === 'transcribe-subtitle') setCaptions(true)
    if (next === 'talkingphotos-video') { setCaptions(false); setAutoBroll(false) }
    if (next === 'batch-source') setSourceCount((current) => Math.max(5, current))
    setSetupError('')
  }
  const chooseFiles = (files: FileList | null, setter: Dispatch<SetStateAction<string[]>>): void => {
    if (!files) return
    const paths = Array.from(files).map((file) => window.api.pathForFile(file)).filter(Boolean)
    setter((current) => [...new Set([...current, ...paths])])
  }
  const chooseAssetFiles = async (files: FileList | null): Promise<void> => {
    if (!files) return
    const paths = Array.from(files).map((file) => window.api.pathForFile(file)).filter(Boolean)
    if (!paths.length) return
    const requestId = draftState.id
    try {
      const imported = await window.api.assets.import(paths, { sourceId: source?.id, channel: source?.name || sourceLabel || 'Unsorted', channelHandle: source?.handle, channelAvatar: source?.avatar })
      if (activeDraftId.current !== requestId) return
      setAssets((current) => [...new Set([...current, ...imported.filter((asset) => !asset.missing).map((asset) => asset.canonicalPath)])])
      setLibraryAssets(await window.api.assets.list())
    } catch (error) { if (activeDraftId.current === requestId) setSetupError(error instanceof Error ? error.message : String(error)) }
  }
  const goReview = async (): Promise<void> => {
    setSetupError(''); setPreflight(null); setStage(4)
    const requestId = draftState.id
    try { const result = await preflightAutomation(draft); if (activeDraftId.current === requestId) setPreflight(result) }
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
    dispatchDraft({ type: 'duplicate', job })
    setAvailableVideos([]); setSourceModalOpen(false); setAssetModalOpen(false); setStage(0); setPreflight(null); setSetupError(''); setView('setup')
  }
  // Shared pause/resume/retry/cancel guard: prevents a double-click from firing
  // the same job action twice before the refreshed job list re-renders the row.
  const runJobAction = async (jobId: string, action: (id: string) => Promise<void>): Promise<void> => {
    if (jobActionPending[jobId]) return
    setJobActionPending((prev) => ({ ...prev, [jobId]: true }))
    setSetupError('')
    try {
      await action(jobId)
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : String(error))
    } finally {
      setJobActionPending((prev) => { const next = { ...prev }; delete next[jobId]; return next })
    }
  }
  const openAutomationProject = async (projectId: string): Promise<void> => {
    try {
      await openProjectById(projectId)
      setActive('compose')
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : String(error))
    }
  }
  const newAutomation = (): void => {
    dispatchDraft({ type: 'new', settings })
    setAvailableVideos([]); setPreflight(null); setExpanded(null); setStarting(false); setSourceModalOpen(false); setAssetModalOpen(false); setSourceLoadError(''); setSetupError(''); setStage(0); setView('setup')
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

      {stage === 0 && <Panel><SectionLabel>What do you want to finish?</SectionLabel><div className="automation-goal-grid">{automationGoals.map((definition) => { const selected = goal === definition.id; return <button type="button" key={definition.id} onClick={() => chooseGoal(definition.id)} disabled={!definition.available} aria-pressed={selected} className="automation-goal-card" style={{ borderColor: selected ? 'var(--accent)' : undefined, background: selected ? 'var(--accent-soft)' : undefined }}><div><strong style={{ color: selected ? 'var(--accent)' : 'var(--text-bright)' }}>{definition.title}</strong><span>{definition.available ? 'READY' : 'LATER'}</span></div><p>{definition.description}</p>{definition.availabilityNote && <small>{definition.availabilityNote}</small>}</button> })}</div></Panel>}

      {stage === 1 && <>
        <Panel><SectionLabel>Choose source and content</SectionLabel>
          <div role="radiogroup" aria-label="Content source type" className="automation-source-types">{([['saved-source','Saved source'],['youtube-url','YouTube URL'],['local-files','Local files']] as const).map(([kind, label]) => <button type="button" role="radio" aria-checked={sourceKind === kind} key={kind} onClick={() => { dispatchDraft({ type: 'patch-config', patch: { sourceKind: kind, sourceId: kind === 'saved-source' ? sourceId : '', sourceUrl: '', selectedVideoIds: [], localMediaPaths: [] } }); setPreflight(null); setSetupError('') }} className={sourceKind === kind ? 'active' : ''}>{label}</button>)}</div>
          {sourceKind === 'saved-source' && (sourceChannels.length === 0
            ? <EmptyState title="No saved sources yet" body="Add a source in Sources, paste a YouTube link here, or choose local media. You are not blocked on a separate setup screen." action={<Btn variant="soft" onClick={() => setActive('sources')}>Open Sources</Btn>} />
            : <div className="automation-source-grid"><div><span style={{ display: 'block', color: 'var(--text-dim)', fontSize: 10.5, marginBottom: 6 }}>Saved source</span>{source ? <div className="automation-selected-source">{source.avatar ? <img src={mediaSrc(source.avatar)} alt="" /> : <i aria-hidden="true">{(source.name || source.handle).slice(0, 2).toUpperCase()}</i>}<div><strong>{source.name || source.handle}</strong><span>{source.handle}</span><small>{source.videoCount || 0} cached videos · {source.linkedMyChannelId ? 'upload check linked' : 'upload check unavailable'}</small></div><button ref={sourceBrowseRef} type="button" onClick={() => setSourceModalOpen(true)}>Change source</button></div> : <button ref={sourceBrowseRef} type="button" className="automation-browse-source" onClick={() => setSourceModalOpen(true)}>Browse saved sources</button>}</div><SourceRuleFields count={sourceCount} setCount={setSourceCount} order={sourceOrder} setOrder={setSourceOrder} /></div>)}
          {sourceKind === 'youtube-url' && <div className="automation-source-grid"><Field label="Channel, playlist, or video URL" hint="HTTPS YouTube links only. The worker reads the source when the job starts."><input type="url" aria-invalid={sourceUrl.trim() ? !validYoutubeUrl(sourceUrl) : undefined} value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=…" style={{ ...input, borderColor: sourceUrl.trim() && !validYoutubeUrl(sourceUrl) ? 'var(--err)' : undefined }} />{sourceUrl.trim() && !validYoutubeUrl(sourceUrl) && <span role="alert" style={{ display: 'block', color: 'var(--err-2)', fontSize: 9.5, marginTop: 5 }}>Enter a valid HTTPS youtube.com or youtu.be link.</span>}</Field><SourceRuleFields count={sourceCount} setCount={setSourceCount} order={sourceOrder} setOrder={setSourceOrder} /></div>}
          {sourceKind === 'local-files' && <div style={{ marginTop: 13 }}><label className="automation-file-picker"><input type="file" accept="audio/*,video/*,.mkv,.webm" multiple onChange={(event) => chooseFiles(event.target.files, setLocalMediaPaths)} />＋ Choose local audio or video files</label><div aria-live="polite" style={{ marginTop: 9, color: localMediaPaths.length ? 'var(--ok-2)' : 'var(--text-faint)', fontSize: 10.5 }}>{localMediaPaths.length ? `${localMediaPaths.length} local file${localMediaPaths.length === 1 ? '' : 's'} selected` : 'MP3, WAV, M4A, MP4, MOV, MKV, and WebM are supported'}</div>{localMediaPaths.map((path) => <div key={path} className="me-ellipsis" title={path} style={{ color: 'var(--text-dim)', fontSize: 10, marginTop: 5 }}>{path}</div>)}</div>}
          <div className="automation-rule-summary">{sourceKind === 'local-files' ? `The worker imports ${localMediaPaths.length || 'your selected'} file${localMediaPaths.length === 1 ? '' : 's'} and preserves the originals.` : `Process ${sourceCount} ${sourceOrder.toLowerCase()} video${sourceCount === 1 ? '' : 's'}${minDuration ? ` longer than ${Math.round(minDuration / 60)} minutes` : ''}; reuse valid downloads.`}</div>
        </Panel>
        {sourceKind === 'saved-source' && availableVideos.length > 0 && <Panel style={{ marginTop: 10 }}><div style={{ display: 'flex', alignItems: 'center' }}><SectionLabel style={{ flex: 1 }}>Pick individual videos (optional)</SectionLabel>{selectedVideoIds.length > 0 && <button type="button" onClick={() => setSelectedVideoIds([])} className="automation-link-button">Use automatic rules</button>}</div><div style={{ color: 'var(--text-dim)', fontSize: 10.5, marginTop: 6 }}>Select exact cached videos, or leave all unchecked to use count, order, and duration rules. Known uploaded selections are kept explicit and shown as skipped; automatic replacement remains opt-in.</div><div className="automation-video-grid">{availableVideos.slice(0, 20).map((video) => { const uploaded = config.rules.skipUploaded && workItems.some((item) => item.videoId === video.id && item.uploaded); return <label key={video.id} className={`${selectedVideoIds.includes(video.id) ? 'selected' : ''} ${uploaded ? 'uploaded' : ''}`}><input type="checkbox" checked={selectedVideoIds.includes(video.id)} onChange={(event) => setSelectedVideoIds((current) => event.target.checked ? [...current, video.id] : current.filter((id) => id !== video.id))} /><span className="me-ellipsis">{video.title}</span><small>{uploaded ? 'Uploaded · will skip' : `${Math.max(1, Math.round(video.durationSec / 60))}m`}</small></label> })}</div>{selectedVideoIds.length > 0 && <div className="automation-help">Selected {selectedVideoIds.length}; known eligible {selectedVideoIds.filter((id) => !(config.rules.skipUploaded && workItems.some((item) => item.videoId === id && item.uploaded))).length}. The final upload refresh may identify additional skips.</div>}</Panel>}
      </>}

      {stage === 2 && <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {goal === 'talkingphotos-video' && <Panel><SectionLabel>TalkingPhotos Human character</SectionLabel><div className="automation-help">The first selected visual asset is uploaded as the character reference. Each source item's downloaded audio is uploaded, split to the confirmed style limit, rendered, merged in order, and downloaded.</div><div className="automation-config-grid" style={{ marginTop: 12 }}><Field label="Character prompt"><input value={talkingPhotos.characterPrompt} onChange={(event) => updateTalkingPhotos('characterPrompt', event.target.value)} placeholder="Describe the Human character" style={input} /></Field><Field label="Negative prompt"><input value={talkingPhotos.characterNegativePrompt} onChange={(event) => updateTalkingPhotos('characterNegativePrompt', event.target.value)} placeholder="Optional" style={input} /></Field><Field label="TalkingPhotos style"><select value={talkingPhotos.style} onChange={(event) => { const value = event.target.value as typeof talkingPhotos.style; updateConfig('talkingPhotos', { ...talkingPhotos, style: value, motionId: value === 'high_quality' ? 0 : Math.max(1, talkingPhotos.motionId) }) }} style={input}><option value="high_quality">High Quality · 60s segments</option><option value="normal">Normal · 300s segments</option></select></Field><Field label="Aspect ratio"><select value={talkingPhotos.aspectRatio} onChange={(event) => updateTalkingPhotos('aspectRatio', event.target.value as typeof talkingPhotos.aspectRatio)} style={input}><option value="16:9">16:9</option><option value="9:16">9:16</option><option value="1:1">1:1</option></select></Field><Field label="Motion ID" hint={talkingPhotos.style === 'high_quality' ? 'High Quality uses confirmed motion ID 0.' : 'Choose a Human motion ID from Talking Video.'}><input type="number" min={talkingPhotos.style === 'normal' ? 1 : 0} disabled={talkingPhotos.style === 'high_quality'} value={talkingPhotos.style === 'high_quality' ? 0 : talkingPhotos.motionId} onChange={(event) => updateTalkingPhotos('motionId', Number(event.target.value))} style={input} /></Field></div></Panel>}
        <div className="automation-two-column"><Panel><SectionLabel>Visual assets</SectionLabel><div className="automation-help">New images are content-hashed into the shared library before they are copied into a project.</div><label className="automation-file-picker"><input key={`asset-input-${draftState.id}`} type="file" accept="image/*" multiple onChange={(event) => void chooseAssetFiles(event.target.files)} />＋ Add images, logos, or visual assets</label><div className="automation-asset-actions"><span>{assets.length ? `${assets.length} asset${assets.length === 1 ? '' : 's'} selected` : 'No assets selected'}</span><button ref={assetBrowseRef} type="button" onClick={() => setAssetModalOpen(true)}>Browse previous assets</button>{assets.length > 0 && <button type="button" onClick={() => dispatchDraft({ type: 'clear-assets' })}>Clear</button>}</div></Panel>
        <Panel><SectionLabel>Video style and export</SectionLabel><div className="automation-style-grid">{STYLES.map((candidate) => <button type="button" key={candidate} onClick={() => setStyle(candidate)} className={style === candidate ? 'active' : ''}>{candidate}</button>)}</div><div className="automation-config-grid"><Field label="Aspect ratio"><select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as AspectRatio)} style={input}><option value="16:9">16:9 · Landscape</option><option value="9:16">9:16 · Vertical</option><option value="1:1">1:1 · Square</option></select></Field><Field label="Image order"><select value={config.styleConfig.imageMode} onChange={(event) => updateStyle('imageMode', event.target.value as 'sequence' | 'pool')} style={input}><option value="sequence">Sequence</option><option value="pool">Seeded pool</option></select></Field><Field label="Crossfade seconds"><input type="number" min={0} max={5} step={0.1} value={config.styleConfig.crossfadeSec} onChange={(event) => updateStyle('crossfadeSec', Number(event.target.value))} style={input} /></Field><Field label="Motion"><select value={config.styleConfig.motionPreset} onChange={(event) => updateStyle('motionPreset', event.target.value as 'off' | 'subtle' | 'cinematic')} style={input}><option value="off">Off</option><option value="subtle">Subtle</option><option value="cinematic">Cinematic</option></select></Field><Field label="Gradient edge"><select value={config.styleConfig.gradientEdge} onChange={(event) => updateStyle('gradientEdge', event.target.value as typeof config.styleConfig.gradientEdge)} style={input}><option value="none">None</option><option value="bottom">Bottom</option><option value="top">Top</option><option value="left">Left</option><option value="right">Right</option></select></Field><Field label="Gradient intensity"><input type="number" min={0} max={100} value={config.styleConfig.gradientIntensity} onChange={(event) => updateStyle('gradientIntensity', Number(event.target.value))} style={input} /></Field></div></Panel></div>
        <div className="automation-two-column"><Panel><SectionLabel>Captions</SectionLabel><ToggleRow label="Transcribe and add captions" hint={settings.transcription.apiKey.trim() ? 'Timed words are stored locally.' : 'Needs a Groq key in Settings. Turn this off to continue without captions.'} on={captions} onToggle={() => setCaptions((value) => !value)} /><div className="automation-config-grid"><Field label="Preset"><select value={captionPreset} onChange={(event) => setCaptionPreset(event.target.value)} style={input}><option>Hormozi</option><option>Submagic</option><option>Clean</option><option>Minimal</option></select></Field><Field label="Font"><select value={config.styleConfig.captionFont} onChange={(event) => updateStyle('captionFont', event.target.value)} style={input}><option>Montserrat</option><option>Anton</option><option>Oswald</option><option>Bebas Neue</option><option>Archivo Black</option></select></Field><Field label="Animation"><select value={config.styleConfig.captionAnimation} onChange={(event) => updateStyle('captionAnimation', event.target.value)} style={input}><option>Pop-in</option><option>Fade</option><option>None</option></select></Field><Field label="Position"><select value={config.styleConfig.captionPosition} onChange={(event) => updateStyle('captionPosition', event.target.value as 'top' | 'middle' | 'bottom')} style={input}><option value="top">Top</option><option value="middle">Middle</option><option value="bottom">Bottom</option></select></Field><Field label="Vertical offset %" hint="Optional fine placement; blank uses the selected position."><input type="number" min={4} max={96} value={config.styleConfig.captionOffsetY ?? ''} onChange={(event) => updateStyle('captionOffsetY', event.target.value === '' ? undefined : Number(event.target.value))} style={input} /></Field><Field label="Lines"><select value={config.styleConfig.captionLines} onChange={(event) => updateStyle('captionLines', Number(event.target.value) as 1 | 2 | 3)} style={input}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></Field><Field label="Pace"><select value={config.styleConfig.captionPace} onChange={(event) => updateStyle('captionPace', event.target.value as 'auto' | 'word' | 'phrase')} style={input}><option value="auto">Auto</option><option value="word">Word</option><option value="phrase">Phrase</option></select></Field><Field label="Words per caption"><select value={config.styleConfig.wordsPerCaption} onChange={(event) => updateStyle('wordsPerCaption', Number(event.target.value) as 1 | 2 | 3)} style={input}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></Field><Field label="Highlight colour"><input type="color" value={config.styleConfig.highlightColor} onChange={(event) => updateStyle('highlightColor', event.target.value)} style={input} /></Field><Field label="Box colour"><input type="color" value={config.styleConfig.boxColor} onChange={(event) => updateStyle('boxColor', event.target.value)} style={input} /></Field></div></Panel>
        <Panel><SectionLabel>Saved B-roll pool</SectionLabel><ToggleRow label="Use automatic B-roll" hint="Selected pools are resolved consistently in preflight, preview, validation, and render." on={autoBroll} onToggle={() => setAutoBroll((value) => !value)} /><div className="automation-config-grid"><Field label="Mode"><select disabled={!autoBroll} value={config.styleConfig.brollMode} onChange={(event) => updateStyle('brollMode', event.target.value as 'off' | 'full' | 'overlay')} style={input}><option value="full">Full background</option><option value="overlay">Overlay</option><option value="off">Off</option></select></Field><Field label="Density"><select disabled={!autoBroll} value={config.styleConfig.brollDensity} onChange={(event) => updateStyle('brollDensity', event.target.value as 'full' | 'sparse' | 'keywords')} style={input}><option value="full">Full</option><option value="sparse">Sparse</option><option value="keywords">Keywords</option></select></Field><Field label="Pool size"><input disabled={!autoBroll} type="number" min={1} max={200} value={config.styleConfig.brollPoolSize} onChange={(event) => updateStyle('brollPoolSize', Number(event.target.value))} style={input} /></Field><Field label="Saved pool"><select disabled={!autoBroll} value={config.styleConfig.brollPoolKey || ''} onChange={(event) => updateStyle('brollPoolKey', event.target.value || undefined)} style={input}><option value="">Source-linked / global</option>{niches.map((niche) => { const health = poolHealth.find((row) => row.nicheId === niche.id); return <option key={niche.id} value={`niche-${niche.id}`} disabled={!health?.clips}>{niche.name} · {health?.clips || 0} clips · {niche.orientation}</option> })}</select></Field><Field label="Fallback"><select disabled={!autoBroll} value={config.styleConfig.brollFallbackPolicy} onChange={(event) => updateStyle('brollFallbackPolicy', event.target.value as typeof config.styleConfig.brollFallbackPolicy)} style={input}><option value="selected-only">Selected pool only</option><option value="prefer-selected">Prefer selected, then live stock</option><option value="all-sources">All saved pools and live stock</option></select></Field><Field label="Ordering"><select disabled={!autoBroll} value={config.styleConfig.brollShufflePolicy} onChange={(event) => updateStyle('brollShufflePolicy', event.target.value as typeof config.styleConfig.brollShufflePolicy)} style={input}><option value="per-video">Shuffle per video</option><option value="ranked">Ranked order</option></select></Field></div>{config.styleConfig.brollPoolKey && (() => { const id = config.styleConfig.brollPoolKey.replace(/^niche-/, ''); const niche = niches.find((row) => row.id === id); const health = poolHealth.find((row) => row.nicheId === id); return <div className={`automation-pool-status ${health?.clips ? 'ready' : 'empty'}`}>{niche?.name || 'Selected pool'} · {health?.clips || 0} clips · {health?.updatedAt ? `warmed ${new Date(health.updatedAt).toLocaleDateString()}` : 'never warmed'} · {health?.clips ? 'ready' : 'empty'}</div> })()}</Panel></div>
      </div>}

      {stage === 3 && <Panel><SectionLabel>How should the supervisor behave?</SectionLabel><div className="automation-two-column rules"><div><ToggleRow label="Continue when one item fails" hint="Mark it failed and continue the remaining batch." on={continueOnError} onToggle={() => setContinueOnError((value) => !value)} /><ToggleRow label="Reuse completed downloads" hint="Only validated finished files bypass a network request." on={skipDownloaded} onToggle={() => setSkipDownloaded((value) => !value)} /><ToggleRow label="Skip already-uploaded videos" hint="Exact IDs and high-confidence title matches are skipped; ambiguous matches stay eligible." on={config.rules.skipUploaded} onToggle={() => updateRule('skipUploaded', !config.rules.skipUploaded)} /><ToggleRow label="Fill skipped manual selections" hint="Off by default; when enabled, unrelated eligible candidates may fill explicitly selected uploaded videos." on={config.rules.fillSkippedSelections} onToggle={() => updateRule('fillSkippedSelections', !config.rules.fillSkippedSelections)} /><ToggleRow label="Allow stale upload cache" hint="Continue with a warning if refreshing the linked upload list fails." on={config.rules.allowStaleUploadCache} onToggle={() => updateRule('allowStaleUploadCache', !config.rules.allowStaleUploadCache)} /><ToggleRow label="Desktop completion notification" hint="Receive completion or action-needed messages while the window is hidden." on={desktopNotify} onToggle={() => setDesktopNotify((value) => !value)} /><ToggleRow label="Send configured webhook" hint={settings.background.webhook ? 'Send a structured completion summary to the configured endpoint.' : 'No webhook is configured in Settings.'} on={webhookNotify} onToggle={() => setWebhookNotify((value) => !value)} disabled={!settings.background.webhook} /></div><div className="automation-rule-fields"><Field label="Additional retry attempts"><input type="number" min={0} max={8} value={retries} onChange={(event) => setRetries(Number(event.target.value))} style={input} /></Field>{sourceKind !== 'local-files' && <Field label="Minimum duration (minutes)"><input type="number" min={0} max={600} value={minDuration / 60} onChange={(event) => setMinDuration(Number(event.target.value) * 60)} style={input} /></Field>}<Field label="Download delay (seconds)"><input type="number" min={0} max={600} step={0.5} value={config.rules.downloadDelaySec} onChange={(event) => updateRule('downloadDelaySec', Number(event.target.value))} style={input} /></Field><Field label="Retry base delay (seconds)"><input type="number" min={1} max={120} value={config.rules.retryBaseDelaySec} onChange={(event) => updateRule('retryBaseDelaySec', Number(event.target.value))} style={input} /></Field><Field label="Retry maximum delay (seconds)"><input type="number" min={1} max={300} value={config.rules.retryMaxDelaySec} onChange={(event) => updateRule('retryMaxDelaySec', Number(event.target.value))} style={input} /></Field><Field label="Upload cache freshness (minutes)"><input type="number" min={5} max={43200} value={config.rules.uploadFreshnessMinutes} onChange={(event) => updateRule('uploadFreshnessMinutes', Number(event.target.value))} style={input} /></Field><Field label="Keep free-space reserve (GB)"><input type="number" min={1} max={100} value={reserveGb} onChange={(event) => setReserveGb(Number(event.target.value))} style={input} /></Field></div></div><Section label="Advanced automation" defaultOpen={false}><div className="automation-help">Item retries cover download, transcription, and render work. Step retries cover source discovery and service-wide failures. Completed item checkpoints are not rerun.</div></Section></Panel>}

      {stage === 4 && <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}><Panel><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><SectionLabel style={{ flex: 1 }}>Generated workflow</SectionLabel><span style={{ fontSize: 9.5, color: 'var(--ok-2)', fontFamily: 'var(--font-mono)' }}>EFFECTIVE CONTRACT</span></div><div style={{ marginTop: 12 }}><WorkflowPreview draft={draft} /></div></Panel><div className="automation-review-grid"><Panel><SectionLabel>Ready-to-run summary</SectionLabel><div className="automation-summary"><span>Final goal</span><b>{formatGoal(goal)}</b><span>Source & items</span><b>{sourceLabel} · {sourceKind === 'local-files' ? localMediaPaths.length : selectedVideoIds.length || sourceCount} item(s)</b><span>Caption</span><b>{captions ? `${config.styleConfig.captionPreset} · ${config.styleConfig.captionFont} · ${config.styleConfig.captionAnimation} · ${config.styleConfig.captionPosition}${config.styleConfig.captionOffsetY == null ? '' : ` @ ${config.styleConfig.captionOffsetY}%`} · ${config.styleConfig.captionLines} line(s) · ${config.styleConfig.captionPace} · ${config.styleConfig.wordsPerCaption} words · ${config.styleConfig.highlightColor}/${config.styleConfig.boxColor}` : 'Disabled'}</b><span>Gradient</span><b>{config.styleConfig.gradientEdge} · {config.styleConfig.gradientIntensity}%</b><span>Images</span><b>{config.styleConfig.imageMode} · {config.styleConfig.crossfadeSec}s crossfade · {config.styleConfig.motionPreset} motion · {assets.length} assets</b><span>B-roll</span><b>{autoBroll ? `${config.styleConfig.brollMode} · ${config.styleConfig.brollDensity} · ${config.styleConfig.brollPoolSize} clips · ${config.styleConfig.brollPoolKey || 'resolved source/global pool'} · ${config.styleConfig.brollFallbackPolicy} · ${config.styleConfig.brollShufflePolicy}` : 'Disabled'}</b><span>Aspect / style</span><b>{config.styleConfig.aspectRatio} · {config.styleConfig.videoStyle}</b><span>Retry / pacing</span><b>{retries} additional attempts · {config.rules.downloadDelaySec}s download delay · {continueOnError ? 'continue other items' : 'pause the batch'}</b><span>Upload data</span><b>{preflight?.uploadDataState || 'checking'} · {config.rules.skipUploaded ? 'skip exact/high matches' : 'skip disabled'}</b><span>Execution</span><b>Local · {settings.encoder === 'cpu' ? 'CPU' : settings.encoder.toUpperCase()} · {settings.quality}</b><span>Notifications</span><b>{[desktopNotify && 'desktop', webhookNotify && 'webhook'].filter(Boolean).join(' + ') || 'in-app only'}</b></div></Panel><Panel><SectionLabel>Preflight</SectionLabel>{!preflight ? <div aria-live="polite" style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 12 }}>Checking configuration…</div> : <><div style={{ marginTop: 11, color: preflight.ok ? 'var(--ok-2)' : 'var(--err-2)', fontWeight: 700, fontSize: 12 }}>{preflight.ok ? '✓ Ready to run unattended' : 'Action required before start'}</div><div style={{ marginTop: 10, color: 'var(--text-dim)', fontSize: 10.5, lineHeight: 1.55 }}>~{preflight.estimatedStorageGb.toFixed(1)} GB · ~{preflight.estimatedMinutes} min<br />Upload data: {preflight.uploadDataState || 'not linked'}<br />{preflight.appMessage}<br />{preflight.powerMessage}</div>{preflight.blockers.map((message) => <div key={message} style={{ color: 'var(--err-2)', fontSize: 10.5, marginTop: 7 }}>• {message}</div>)}{preflight.warnings.map((message) => <div key={message} style={{ color: 'var(--warn)', fontSize: 10.5, marginTop: 7 }}>• {message}</div>)}</>}</Panel></div></div>}

      {setupError && <div role="alert" style={{ marginTop: 12 }}><Banner kind="error"><b>Couldn’t continue:</b> {setupError}</Banner></div>}
      <div className="automation-footer-actions"><Btn disabled={stage === 0} onClick={() => { setStage(Math.max(0, stage - 1)); setSetupError('') }}>Back</Btn><div style={{ flex: 1 }} />{stage < 3 && <Btn variant="primary" disabled={(stage === 0 && !automationGoals.find((definition) => definition.id === goal)?.available) || (stage === 1 && !sourceReady)} onClick={() => { setStage(stage + 1); setSetupError('') }}>Continue</Btn>}{stage === 3 && <Btn variant="primary" disabled={!sourceReady || (!assets.length && !autoBroll)} onClick={() => void goReview()}>Review workflow</Btn>}{stage === 4 && <Btn variant="primary" disabled={!preflight?.ok || starting} onClick={() => void start()} style={{ padding: '11px 20px' }}>{starting ? 'Starting…' : '▶ Start automation and run until complete'}</Btn>}</div>
    </> : <>
      <div className="automation-jobs-heading"><div><h2>Automation jobs</h2><p>Durable production goals loaded from SQLite—not browser memory.</p></div><Btn variant="soft" onClick={newAutomation}>＋ New automation</Btn></div>
      {activeJob && <div className="automation-live-strip" aria-live="polite"><span><b>LIVE</b> · {activeJob.currentStep}</span><span>ETA {jobEta(activeJob)}</span><span>Started {activeJob.startedAt ? new Date(activeJob.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'now'}</span><span>{settings.encoder === 'cpu' ? 'CPU' : settings.encoder.toUpperCase()} · {settings.quality}</span></div>}
      {automationJobs.length === 0 ? <EmptyState title="No automation jobs yet" body="Choose a goal to build your first unattended workflow. It will appear here before processing starts." action={<Btn variant="primary" onClick={newAutomation}>Create automation</Btn>} /> : <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>{automationJobs.map((job) => {
        const active = job.status === 'running' || job.status === 'queued' || job.status === 'pausing'
        const needsAttention = job.status === 'attention' || job.status === 'failed'
        return <article key={job.id} className="automation-job-card" style={{ borderColor: needsAttention ? '#4a2530' : job.status === 'completed' ? '#1f382f' : undefined }}><div className="automation-job-body"><div className="automation-job-title"><div aria-hidden="true" className={`automation-job-icon ${active ? 'active' : ''}`}>{active ? '▶' : job.status === 'completed' ? '✓' : needsAttention ? '!' : '■'}</div><div style={{ flex: 1, minWidth: 0 }}><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><strong className="me-ellipsis">{job.name}</strong><JobStatus status={job.status} /></div><div style={{ color: 'var(--text-dim)', fontSize: 10.5, marginTop: 4 }}>{formatGoal(job.goal)} · {job.config.sourceName} · {job.totalItems || job.config.sourceCount} items</div></div><div style={{ textAlign: 'right' }}><b style={{ fontFamily: 'var(--font-mono)', color: job.status === 'completed' ? 'var(--ok-2)' : 'var(--accent)', fontSize: 15 }}>{job.progress}%</b><small>overall</small></div></div><div role="progressbar" aria-label={`${job.name} progress`} aria-valuenow={job.progress} aria-valuemin={0} aria-valuemax={100} className="automation-job-progress"><div style={{ width: `${job.progress}%`, background: needsAttention ? 'var(--err)' : job.status === 'completed' ? 'var(--ok)' : undefined }} /></div><div className="automation-job-metrics"><div><span>CURRENT STEP</span><b>{job.currentStep || 'Waiting'}</b></div><div><span>ITEMS</span><b>{job.completedCount} done · {job.failedCount} failed</b></div><div><span>CHECKPOINT</span><b>{job.lastCheckpointAt ? new Date(job.lastCheckpointAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'not started'}</b></div><div><span>OUTPUT</span><b className="me-ellipsis">{job.result?.outputPaths[0] || settings.libraryFolder || settings.outputFolder || 'Mental Empire Studio library'}</b></div></div>{job.error && <div role="alert" className="automation-job-error"><b>What happened:</b> {job.error}<br /><span>Other items may continue when safe. Completed checkpoints remain available for resume or retry.</span></div>}<div className="automation-job-actions">{(job.status === 'running' || job.status === 'queued') && <Btn size="sm" disabled={!!jobActionPending[job.id]} onClick={() => void runJobAction(job.id, pauseJob)}>Pause</Btn>}{(job.status === 'paused' || job.status === 'attention' || job.status === 'failed') && <Btn size="sm" variant="soft" disabled={!!jobActionPending[job.id]} onClick={() => void runJobAction(job.id, resumeJob)}>Resume</Btn>}{job.failedCount > 0 && ['failed','completed_with_warnings','attention'].includes(job.status) && <Btn size="sm" variant="soft" disabled={!!jobActionPending[job.id]} onClick={() => void runJobAction(job.id, retryJob)}>Retry failed items</Btn>}{(active || job.status === 'paused' || job.status === 'attention' || job.status === 'failed') && <Btn size="sm" variant="danger" disabled={!!jobActionPending[job.id]} onClick={() => void runJobAction(job.id, cancelJob)}>Cancel</Btn>}<Btn size="sm" onClick={() => void showDetails(job)}>{expanded?.id === job.id ? 'Hide details' : 'View details'}</Btn>{job.result?.outputPaths[0] && <Btn size="sm" onClick={() => void window.api.publish.reveal(job.result!.outputPaths[0])}>Open output</Btn>}<Btn size="sm" onClick={() => duplicate(job)}>Duplicate workflow</Btn><Btn size="sm" onClick={() => window.api.openLogs()}>Technical logs</Btn></div></div>{expanded?.id === job.id && <JobDetails detail={expanded} onOpenProject={(projectId) => void openAutomationProject(projectId)} />}</article>
      })}</div>}
      {setupError && <div role="alert" style={{ marginTop: 12 }}><Banner kind="error">{setupError}</Banner></div>}
    </>}
    {sourceModalOpen && <SourcePickerModal sources={sourceChannels} selectedId={sourceId} error={sourceLoadError} opener={sourceBrowseRef.current} onClose={() => setSourceModalOpen(false)} onRefresh={async (candidate) => { setSourceLoadError(''); await window.api.sources.refresh(candidate.id); await loadSources(); if (candidate.id === sourceId) setAvailableVideos(await window.api.sources.videos(candidate.id)) }} onSelect={(candidate) => {
      if (candidate.id !== sourceId && selectedVideoIds.length > 0 && !window.confirm(`Changing sources will clear ${selectedVideoIds.length} exact video selection${selectedVideoIds.length === 1 ? '' : 's'}. Continue?`)) return
      dispatchDraft({ type: 'change-source', source: candidate }); setAvailableVideos([]); setPreflight(null); setSourceModalOpen(false); setSetupError('')
    }} />}
    {assetModalOpen && <AssetLibraryModal key={`assets-${draftState.id}`} assets={libraryAssets} selectedPaths={assets} opener={assetBrowseRef.current} onClose={() => setAssetModalOpen(false)} onApply={(paths) => { setAssets(paths); setAssetModalOpen(false); setPreflight(null) }} />}
  </ScreenPad>
}
