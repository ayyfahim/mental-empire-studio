import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ScreenPad } from '../components/primitives'
import { Banner, Btn, EmptyState, Seg, Section, StatusPill, fmtTime } from '../components/ui/kit'
import { useStore } from '../store/useStore'
import { useTalkingPhotos } from '../store/useTalkingPhotos'
import { useData } from '../store/useData'
import type {
  ProviderConnectionStatus,
  ProviderJob,
  ProviderMotion,
  TalkingPhotosAspectRatio,
  TalkingPhotosProjectStyle,
  TalkingPhotosSubtitleMode
} from '@shared/talkingphotos'

// ---- status copy -----------------------------------------------------------

const STATUS_TONE: Record<ProviderConnectionStatus, 'ok' | 'warn' | 'error' | 'neutral'> = {
  disconnected: 'neutral',
  connecting: 'warn',
  waiting_for_login: 'warn',
  verifying: 'warn',
  connected: 'ok',
  reauth_required: 'error',
  attention: 'error'
}
const STATUS_LABEL: Record<ProviderConnectionStatus, string> = {
  disconnected: 'Not connected',
  connecting: 'Connecting…',
  waiting_for_login: 'Waiting for login…',
  verifying: 'Verifying session…',
  connected: 'Connected',
  reauth_required: 'Reconnect required',
  attention: 'Needs attention'
}

const JOB_STATUS_TONE: Record<ProviderJob['status'], 'ok' | 'warn' | 'error' | 'neutral'> = {
  queued: 'neutral',
  running: 'warn',
  downloading: 'warn',
  completed: 'ok',
  failed: 'error',
  attention: 'error',
  cancelled: 'neutral'
}
const JOB_STATUS_LABEL: Record<ProviderJob['status'], string> = {
  queued: 'Queued',
  running: 'Processing',
  downloading: 'Downloading',
  completed: 'Completed',
  failed: 'Failed',
  attention: 'Needs attention',
  cancelled: 'Cancelled'
}

// ---- small icons (SVG, not emoji) ------------------------------------------

function IconAudio(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2" y="7" width="2" height="4" rx="1" fill="currentColor" />
      <rect x="6" y="4" width="2" height="10" rx="1" fill="currentColor" />
      <rect x="10" y="1" width="2" height="16" rx="1" fill="currentColor" />
      <rect x="14" y="5" width="2" height="8" rx="1" fill="currentColor" />
    </svg>
  )
}
function IconImage(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="1.5" y="2.5" width="15" height="13" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6" cy="7" r="1.4" fill="currentColor" />
      <path d="M2.5 13.5l4-4 2.5 2.5 3-4 4.5 5.5" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" fill="none" />
    </svg>
  )
}
function IconClose(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
function IconAlert(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ flex: 'none' }}>
      <circle cx="6" cy="6" r="5.25" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6 3.4v3.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="6" cy="8.3" r="0.65" fill="currentColor" />
    </svg>
  )
}
function AspectIcon({ ratio, active }: { ratio: TalkingPhotosAspectRatio; active: boolean }): JSX.Element {
  const dims: Record<TalkingPhotosAspectRatio, [number, number]> = { '16:9': [20, 11.3], '1:1': [15, 15], '9:16': [11.3, 20] }
  const [w, h] = dims[ratio]
  return (
    <svg width="22" height="22" viewBox="0 0 22 22">
      <rect x={(22 - w) / 2} y={(22 - h) / 2} width={w} height={h} rx={2} fill="none" stroke="currentColor" strokeWidth="1.5" opacity={active ? 1 : 0.6} />
    </svg>
  )
}

// ---- accessible searchable combobox ----------------------------------------

interface ComboOption { value: string; label: string; sublabel?: string }

function Combobox({
  id, value, onChange, options, placeholder, loading, emptyHint
}: {
  id: string
  value: string
  onChange: (v: string) => void
  options: ComboOption[]
  placeholder: string
  loading?: boolean
  emptyHint?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = options.find((o) => o.value === value)

  useEffect(() => {
    function onDocPointerDown(e: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', onDocPointerDown)
    return () => document.removeEventListener('mousedown', onDocPointerDown)
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => o.label.toLowerCase().includes(q) || o.sublabel?.toLowerCase().includes(q))
  }, [options, query])

  const commit = (opt: ComboOption): void => {
    onChange(opt.value)
    setOpen(false)
    setQuery('')
    setActiveIndex(-1)
  }

  return (
    <div className="tp-combobox" ref={rootRef}>
      <input
        id={id}
        className="ed-input"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-listbox`}
        aria-autocomplete="list"
        aria-activedescendant={open && activeIndex >= 0 && filtered[activeIndex] ? `${id}-opt-${activeIndex}` : undefined}
        autoComplete="off"
        placeholder={loading ? 'Loading…' : placeholder}
        disabled={loading && options.length === 0}
        value={open ? query : selected?.label ?? value}
        onFocus={() => { setOpen(true); setQuery('') }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActiveIndex(0) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActiveIndex((i) => Math.min(filtered.length - 1, i + 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => Math.max(0, i - 1)) }
          else if (e.key === 'Enter') { if (open && activeIndex >= 0 && filtered[activeIndex]) { e.preventDefault(); commit(filtered[activeIndex]) } }
          else if (e.key === 'Escape') { setOpen(false); setQuery('') }
        }}
      />
      {open && (
        <div className="tp-combobox-listbox" role="listbox" id={`${id}-listbox`}>
          {filtered.length === 0 && <div className="tp-combobox-empty">{emptyHint ?? 'No matches'}</div>}
          {filtered.map((o, i) => (
            <div
              key={o.value}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={o.value === value}
              className={`tp-combobox-option${i === activeIndex ? ' active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); commit(o) }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              <span>{o.label}</span>
              {o.sublabel && <span>{o.sublabel}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---- drag-and-drop file field (audio or image), with preview + clear ------

function FileDropField({
  id, label, accept, path, onPick, onClear, kind
}: {
  id: string
  label: string
  accept: string
  path: string
  onPick: (file: File) => void
  onClear: () => void
  kind: 'audio' | 'image'
}): JSX.Element {
  const [dragOver, setDragOver] = useState(false)
  const [previewUrl, setPreviewUrl] = useState('')

  useEffect(() => {
    if (!path) setPreviewUrl('')
  }, [path])
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }, [previewUrl])

  const handleFile = (file: File | undefined): void => {
    if (!file) return
    if (kind === 'image') setPreviewUrl(URL.createObjectURL(file))
    onPick(file)
  }

  const filename = path ? path.split(/[\\/]/).pop() : ''

  return (
    <div
      className={`tp-dropzone${dragOver ? ' dragover' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files?.[0]) }}
    >
      <input id={id} type="file" accept={accept} aria-label={label} onChange={(e) => handleFile(e.target.files?.[0])} />
      {kind === 'image' && previewUrl
        ? <img className="tp-dropzone-thumb" src={previewUrl} alt="" />
        : <span className="tp-dropzone-icon">{kind === 'audio' ? <IconAudio /> : <IconImage />}</span>}
      <div className="tp-dropzone-body">
        <strong>{filename || label}</strong>
        <span>{filename ? 'Drop a new file to replace it' : `Drag & drop, or click to browse for ${kind === 'audio' ? 'an audio file' : 'an image'}`}</span>
      </div>
      {path && (
        <div
          className="tp-dropzone-clear"
          role="button"
          tabIndex={0}
          aria-label={`Clear ${label}`}
          onClick={(e) => { e.stopPropagation(); onClear() }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClear() } }}
        >
          <IconClose />
        </div>
      )}
    </div>
  )
}

// ---- field wrapper (label + optional inline error) -------------------------

function Field({
  label, required, error, htmlFor, children, hint
}: {
  label: string
  required?: boolean
  error?: string
  htmlFor?: string
  children: ReactNode
  hint?: string
}): JSX.Element {
  return (
    <label className={`tp-field${required ? ' required' : ''}${error ? ' invalid' : ''}`} htmlFor={htmlFor}>
      <span>{label}</span>
      {children}
      {hint && !error && <span className="tp-hint">{hint}</span>}
      {error && <span className="tp-error-text" role="alert"><IconAlert />{error}</span>}
    </label>
  )
}

// ---- usage meter ------------------------------------------------------------

function Meter({ label, used, limit }: { label: string; used: number; limit: number }): JSX.Element {
  const ratio = limit > 0 ? used / limit : 0
  const tone = ratio >= 0.9 ? 'danger' : ratio >= 0.7 ? 'warn' : ''
  return (
    <div className="tp-meter">
      <div className="tp-meter-head"><span>{label}</span><b>{used}/{limit}</b></div>
      <div className="tp-meter-track"><div className={`tp-meter-fill ${tone}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} /></div>
    </div>
  )
}

// ---- job row (My videos) ----------------------------------------------------

function JobRow({ job, highlighted }: { job: ProviderJob; highlighted?: boolean }): JSX.Element {
  const downloadOutput = useTalkingPhotos((s) => s.downloadOutput)
  const createProviderSubtitles = useTalkingPhotos((s) => s.createProviderSubtitles)
  const applyLocalCaptions = useTalkingPhotos((s) => s.applyLocalCaptions)
  const title = job.remoteProjectId ? `Project ${job.remoteProjectId}` : job.id
  const stepLabel = job.remoteStepsTotal ? `step ${job.remoteStep ?? 0} of ${job.remoteStepsTotal}` : undefined
  const canOfferSubtitles = job.status === 'completed' && !!job.localOutputPath && job.operation !== 'subtitles'
  return (
    <div className="tp-job-row" style={highlighted ? { borderColor: 'var(--accent)', boxShadow: 'inset 0 0 0 1px var(--accent)' } : undefined}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="me-ellipsis" style={{ fontSize: 12.5, color: '#cdd2da' }}>{title}</div>
        <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 2 }}>{job.operation} · {stepLabel ?? 'processing'}{job.errorMessage ? ` · ${job.errorMessage}` : ''}</div>
      </div>
      <StatusPill tone={JOB_STATUS_TONE[job.status]}>{JOB_STATUS_LABEL[job.status]}</StatusPill>
      {canOfferSubtitles && !job.localCaptionedOutputPath && (
        <>
          <button type="button" title="Submit provider subtitles for this video" onClick={() => void createProviderSubtitles(job.id)}>Subtitles</button>
          <button type="button" title="Burn local captions onto a copy of this video" onClick={() => void applyLocalCaptions(job.id)}>Local captions</button>
        </>
      )}
      {job.localCaptionedOutputPath && (
        <button type="button" style={{ borderColor: '#1e3a2a', color: 'var(--ok-2)' }} onClick={() => void window.api?.publish?.reveal?.(job.localCaptionedOutputPath!)}>Captioned copy</button>
      )}
      {job.status === 'completed' && job.localOutputPath && (
        <button type="button" onClick={() => void window.api?.publish?.reveal?.(job.localOutputPath!)}>Open folder</button>
      )}
      {(job.status === 'downloading' || (job.status === 'completed' && !job.localOutputPath)) && (
        <button type="button" style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }} onClick={() => void downloadOutput(job.id)}>
          {job.errorMessage ? 'Retry download' : 'Download'}
        </button>
      )}
    </div>
  )
}

// ---- error -> human copy -----------------------------------------------------

function humanizeError(message: string): { text: string; reauth: boolean } {
  const reauth = /session expired|reconnect required/i.test(message)
  return { text: message, reauth }
}

type SourceMode = 'audio' | 'script'
type Tab = 'create' | 'videos'

interface FieldErrors {
  title?: string
  characterImagePath?: string
  characterPrompt?: string
  audio?: string
  script?: string
  motion?: string
}

const FIELD_IDS: Record<keyof FieldErrors, string> = {
  title: 'tp-title',
  characterImagePath: 'tp-character-image',
  characterPrompt: 'tp-character-prompt',
  audio: 'tp-audio-file',
  script: 'tp-script',
  motion: 'tp-motion-combobox'
}
const FIELD_ORDER: Array<keyof FieldErrors> = ['title', 'characterImagePath', 'characterPrompt', 'audio', 'script', 'motion']

export function TalkingVideo(): JSX.Element {
  const enabled = useStore((s) => s.settings.integrations.talkingPhotos.enabled)
  const {
    connection, connecting, capabilities, jobs, syncing, creating, error, init, connect, reconnect, sync,
    createUploadedAudio, createScript, languages, languagesLoading, voicesByLanguage, voicesLoading,
    motionsByQuery, motionsLoading, loadLanguages, loadVoices, loadMotions
  } = useTalkingPhotos()
  const downloads = useData((s) => s.downloads)
  const loadDownloads = useData((s) => s.loadDownloads)
  const status = connection?.status ?? 'disconnected'

  const [tab, setTab] = useState<Tab>('create')
  const [sourceMode, setSourceMode] = useState<SourceMode>('audio')
  const [title, setTitle] = useState('')
  const [audioPath, setAudioPath] = useState('')
  const [script, setScript] = useState('')
  const [language, setLanguage] = useState('en-US')
  const [voice, setVoice] = useState('en-US-AndrewMultilingualNeural')
  const [characterImagePath, setCharacterImagePath] = useState('')
  const [characterPrompt, setCharacterPrompt] = useState('')
  const [characterGender, setCharacterGender] = useState<'male' | 'female'>('male')
  const [characterAge, setCharacterAge] = useState('adult')
  const [characterStyle, setCharacterStyle] = useState('realistic')
  const [characterBeard, setCharacterBeard] = useState('shaven')
  const [style, setStyle] = useState<TalkingPhotosProjectStyle>('high_quality')
  const [aspectRatio, setAspectRatio] = useState<TalkingPhotosAspectRatio>('16:9')
  const [motionId, setMotionId] = useState(0)
  const [subtitleMode, setSubtitleMode] = useState<TalkingPhotosSubtitleMode>('none')
  const [attemptedSubmit, setAttemptedSubmit] = useState(false)
  const [touched, setTouched] = useState<Partial<Record<keyof FieldErrors, boolean>>>({})
  const [highlightJobId, setHighlightJobId] = useState('')
  const [successMessage, setSuccessMessage] = useState('')

  useEffect(() => { void init(); void loadDownloads() }, [init, loadDownloads])
  useEffect(() => { if (status === 'connected') void loadLanguages() }, [status, loadLanguages])
  useEffect(() => { if (status === 'connected' && sourceMode === 'script' && language) void loadVoices(language) }, [status, sourceMode, language, loadVoices])
  useEffect(() => {
    if (status === 'connected' && style === 'normal') void loadMotions({ projectType: 'human', gender: characterGender, aspectRatio })
  }, [status, style, characterGender, aspectRatio, loadMotions])
  useEffect(() => {
    if (!highlightJobId) return
    const t = setTimeout(() => setHighlightJobId(''), 5000)
    return () => clearTimeout(t)
  }, [highlightJobId])

  const downloadedAudio = useMemo(() => downloads.filter((item) => !!item.filePath && /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(item.filePath)), [downloads])
  const maxChars = capabilities ? (style === 'high_quality' ? capabilities.limits.maxCharactersTtsPremium : capabilities.limits.maxCharactersTts) : 0
  const motionKey = `human|${characterGender}|${aspectRatio}|`
  const motionOptions: ComboOption[] = (motionsByQuery[motionKey] ?? []).map((m: ProviderMotion) => ({
    value: String(m.id), label: m.title || `Motion ${m.id}`, sublabel: `${fmtTime(m.durationSeconds)}${m.isPremium ? ' · Premium' : ''}`
  }))
  const languageOptions: ComboOption[] = languages.map((l) => ({ value: l.code, label: l.name || l.code, sublabel: l.code }))
  const voiceOptions: ComboOption[] = (voicesByLanguage[language] ?? []).map((v) => ({ value: v.name, label: v.fullName || v.name, sublabel: [v.gender, v.category].filter(Boolean).join(' · ') }))

  const errors = useMemo<FieldErrors>(() => {
    const e: FieldErrors = {}
    if (!title.trim()) e.title = 'Add a title to continue.'
    if (!characterImagePath) e.characterImagePath = 'Add a character image to continue.'
    if (!characterPrompt.trim()) e.characterPrompt = 'Describe the character to continue.'
    if (sourceMode === 'audio') {
      if (!audioPath) e.audio = 'Choose an audio file to continue.'
    } else {
      if (!script.trim()) e.script = 'Write a script to continue.'
      else if (maxChars > 0 && script.length > maxChars) e.script = `Script is ${script.length - maxChars} characters over the ${maxChars}-character limit.`
    }
    if (style === 'normal' && !motionId) e.motion = 'Choose a motion to continue.'
    return e
  }, [title, characterImagePath, characterPrompt, sourceMode, audioPath, script, maxChars, style, motionId])

  const showError = (key: keyof FieldErrors): string | undefined => ((touched[key] || attemptedSubmit) ? errors[key] : undefined)
  const markTouched = (key: keyof FieldErrors): void => setTouched((t) => (t[key] ? t : { ...t, [key]: true }))

  const selectLocalFile = (file: File, setPath: (p: string) => void): void => setPath(window.api?.pathForFile?.(file) ?? '')

  const submit = async (): Promise<void> => {
    setAttemptedSubmit(true)
    const firstInvalid = FIELD_ORDER.find((key) => errors[key])
    if (firstInvalid) {
      document.getElementById(FIELD_IDS[firstInvalid])?.focus()
      return
    }
    const resolvedMotionId = style === 'high_quality' ? 0 : motionId
    const job = sourceMode === 'audio'
      ? await createUploadedAudio({ title, audioPath, characterImagePath, characterPrompt, characterGender, characterAge, characterStyle, characterBeard, style, aspectRatio, motionId: resolvedMotionId })
      : await createScript({ title, script, characterImagePath, characterPrompt, characterGender, characterAge, characterStyle, characterBeard, style, aspectRatio, motionId: resolvedMotionId, language, voice, voiceStyle: 'general', speed: 1, pitch: 0, subtitleMode })
    if (job) {
      setTitle('')
      setAudioPath('')
      setScript('')
      setCharacterImagePath('')
      setCharacterPrompt('')
      setAttemptedSubmit(false)
      setTouched({})
      setSuccessMessage('Video queued — tracking progress below.')
      setHighlightJobId(job.id)
      setTab('videos')
      await sync()
    }
  }

  const visibleJobs = jobs.filter((job) => !job.internalSegment)
  const errorInfo = error ? humanizeError(error) : null

  return (
    <ScreenPad style={{ paddingTop: 0 }}>
      <div className="tp-shell">
        <div className="tp-header">
          <div>
            <div className="tp-eyebrow" style={{ color: 'var(--accent)', fontSize: 11, marginBottom: 5 }}>CREATE</div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 22, letterSpacing: '-.5px', color: 'var(--text-strong)' }}>Talking Video</div>
          </div>
          <div style={{ flex: 1 }} />
          <StatusPill tone={STATUS_TONE[status]}>{STATUS_LABEL[status] ?? 'Not connected'}</StatusPill>
          {enabled && status === 'connected' && <Btn variant="ghost" size="sm" onClick={() => void sync()} disabled={syncing}>{syncing ? 'Syncing…' : 'Sync'}</Btn>}
        </div>

        {!enabled && (
          <EmptyState
            title="TalkingPhotos is turned off"
            body="Enable it in Settings → Integrations to connect an account and create talking videos."
          />
        )}

        {enabled && status !== 'connected' && (
          <div className="tp-section" style={{ maxWidth: 460 }}>
            <div className="tp-eyebrow" style={{ marginBottom: 10 }}>CONNECT</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.5 }}>
              {status === 'reauth_required'
                ? 'Your TalkingPhotos session expired. Reconnect to keep creating and syncing videos.'
                : status === 'attention'
                  ? (connection?.lastError || 'The last connection attempt needs your attention.')
                  : 'Connect your TalkingPhotos.ai account to create and sync talking videos.'}
            </div>
            <Btn variant="primary" onClick={() => void (status === 'reauth_required' || status === 'attention' ? reconnect() : connect())} disabled={connecting}>
              {connecting ? 'Connecting…' : status === 'reauth_required' ? 'Reconnect TalkingPhotos' : 'Connect TalkingPhotos'}
            </Btn>
          </div>
        )}

        {errorInfo && (
          <Banner kind="error" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ flex: 1 }}>{errorInfo.text}</span>
            {errorInfo.reauth && <Btn variant="danger" size="sm" onClick={() => void reconnect()}>Reconnect</Btn>}
          </Banner>
        )}

        {enabled && status === 'connected' && (
          <>
            <div className="tp-tabs" role="tablist" aria-label="Talking Video views">
              <button type="button" role="tab" aria-selected={tab === 'create'} aria-controls="tp-panel-create" id="tp-tab-create" onClick={() => setTab('create')}>Create</button>
              <button type="button" role="tab" aria-selected={tab === 'videos'} aria-controls="tp-panel-videos" id="tp-tab-videos" onClick={() => setTab('videos')}>My videos{visibleJobs.length > 0 ? ` (${visibleJobs.length})` : ''}</button>
            </div>

            {tab === 'create' && (
              <div id="tp-panel-create" role="tabpanel" aria-labelledby="tp-tab-create">
                <div className="tp-layout">
                  <div className="tp-main">
                    <section className="tp-section">
                      <div className="tp-eyebrow" style={{ marginBottom: 4 }}>Source</div>
                      <div className="tp-section-help">Choose how the character speaks. Long audio and scripts are automatically split, rendered in order, and merged.</div>
                      <Seg
                        grow
                        value={sourceMode}
                        onChange={setSourceMode}
                        options={[
                          { value: 'audio', label: 'Upload / pick audio' },
                          { value: 'script', label: 'Write a script (TTS)' }
                        ]}
                      />
                      <div className="tp-field-grid tp-single" style={{ marginTop: 14 }}>
                        <Field label="Title" required htmlFor="tp-title" error={showError('title')}>
                          <input id="tp-title" className="ed-input" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => markTouched('title')} placeholder="e.g. Weekly product update" />
                        </Field>
                      </div>

                      {sourceMode === 'audio' ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 14 }}>
                          <Field label="Downloaded Mental Empire audio" htmlFor="tp-downloaded-audio">
                            <Combobox
                              id="tp-downloaded-audio"
                              value={downloadedAudio.some((item) => item.filePath === audioPath) ? audioPath : ''}
                              onChange={(v) => setAudioPath(v)}
                              options={downloadedAudio.map((item) => ({ value: item.filePath!, label: item.title, sublabel: item.durationSec ? fmtTime(item.durationSec) : undefined }))}
                              placeholder="Search downloaded audio…"
                              emptyHint="No downloaded audio yet — download from Sources."
                            />
                          </Field>
                          <Field label="Or drop a local audio file" required htmlFor="tp-audio-file" error={showError('audio')}>
                            <FileDropField id="tp-audio-file" label="Audio file" accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg" path={audioPath} kind="audio"
                              onPick={(f) => { selectLocalFile(f, setAudioPath); markTouched('audio') }} onClear={() => setAudioPath('')} />
                          </Field>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 14 }}>
                          <Field label="Script" required htmlFor="tp-script" error={showError('script')}>
                            <textarea id="tp-script" className="ed-input" rows={5} value={script} onChange={(e) => setScript(e.target.value)} onBlur={() => markTouched('script')} placeholder="What should the character say?" />
                            <span className={`tp-char-counter${maxChars > 0 && script.length > maxChars ? ' danger' : maxChars > 0 && script.length > maxChars * 0.85 ? ' warn' : ''}`}>
                              {script.length}{maxChars > 0 ? ` / ${maxChars}` : ''}
                            </span>
                          </Field>
                          <div className="tp-field-grid">
                            <Field label="Language" htmlFor="tp-language">
                              <Combobox id="tp-language" value={language} onChange={(v) => { setLanguage(v); setVoice('') }} options={languageOptions} placeholder="Search language…" loading={languagesLoading} />
                            </Field>
                            <Field label="Voice" htmlFor="tp-voice">
                              <Combobox id="tp-voice" value={voice} onChange={setVoice} options={voiceOptions} placeholder="Search voice…" loading={voicesLoading} emptyHint="Choose a language first" />
                            </Field>
                          </div>
                        </div>
                      )}
                    </section>

                    <section className="tp-section">
                      <div className="tp-eyebrow" style={{ marginBottom: 4 }}>Character</div>
                      <div className="tp-section-help">The image and prompt describing who (or what) delivers the video.</div>
                      <Field label="Character image" required htmlFor="tp-character-image" error={showError('characterImagePath')}>
                        <FileDropField id="tp-character-image" label="Character image" accept="image/png,image/jpeg,image/webp" path={characterImagePath} kind="image"
                          onPick={(f) => { selectLocalFile(f, setCharacterImagePath); markTouched('characterImagePath') }} onClear={() => setCharacterImagePath('')} />
                      </Field>
                      <Field label="Character prompt" required htmlFor="tp-character-prompt" error={showError('characterPrompt')} hint="Describe the person or character to animate.">
                        <textarea id="tp-character-prompt" className="ed-input" rows={2} value={characterPrompt} onChange={(e) => setCharacterPrompt(e.target.value)} onBlur={() => markTouched('characterPrompt')} placeholder="e.g. Friendly young woman, business casual, studio background" />
                      </Field>
                      <Section label="Advanced appearance" defaultOpen={false}>
                        <div className="tp-field-grid">
                          <Field label="Gender" htmlFor="tp-gender">
                            <select id="tp-gender" className="ed-input" value={characterGender} onChange={(e) => setCharacterGender(e.target.value as 'male' | 'female')}>
                              <option value="male">Male</option>
                              <option value="female">Female</option>
                            </select>
                          </Field>
                          <Field label="Age" htmlFor="tp-age">
                            <select id="tp-age" className="ed-input" value={characterAge} onChange={(e) => setCharacterAge(e.target.value)}>
                              <option value="young">Young</option>
                              <option value="adult">Adult</option>
                              <option value="senior">Senior</option>
                            </select>
                          </Field>
                          <Field label="Style" htmlFor="tp-char-style">
                            <select id="tp-char-style" className="ed-input" value={characterStyle} onChange={(e) => setCharacterStyle(e.target.value)}>
                              <option value="realistic">Realistic</option>
                              <option value="anime">Anime</option>
                              <option value="cartoon">Cartoon</option>
                            </select>
                          </Field>
                          <Field label="Beard" htmlFor="tp-beard">
                            <select id="tp-beard" className="ed-input" value={characterBeard} onChange={(e) => setCharacterBeard(e.target.value)}>
                              <option value="shaven">Shaven</option>
                              <option value="stubble">Stubble</option>
                              <option value="full">Full beard</option>
                            </select>
                          </Field>
                        </div>
                      </Section>
                    </section>

                    <section className="tp-section">
                      <div className="tp-eyebrow" style={{ marginBottom: 4 }}>Output</div>
                      <div className="tp-section-help">Rendering style, frame shape, motion, and subtitles.</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                        <Field label="Style" htmlFor="tp-style">
                          <Seg
                            grow
                            value={style}
                            onChange={(v) => { setStyle(v); if (v === 'high_quality') setMotionId(0) }}
                            options={[
                              { value: 'high_quality', label: 'High Quality', title: '60-second segments' },
                              { value: 'normal', label: 'Normal', title: '300-second segments' }
                            ]}
                          />
                        </Field>
                        <Field label="Aspect ratio" htmlFor="tp-aspect">
                          <Seg
                            value={aspectRatio}
                            onChange={setAspectRatio}
                            options={(['16:9', '1:1', '9:16'] as TalkingPhotosAspectRatio[]).map((r) => ({
                              value: r,
                              label: <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}><AspectIcon ratio={r} active={aspectRatio === r} /><span>{r}</span></span>
                            }))}
                          />
                        </Field>
                        {style === 'normal' && (
                          <Field label="Motion" required htmlFor="tp-motion-combobox" error={showError('motion')}>
                            <Combobox id="tp-motion-combobox" value={String(motionId || '')} onChange={(v) => { setMotionId(Number(v)); markTouched('motion') }} options={motionOptions} placeholder="Search motions…" loading={motionsLoading} />
                          </Field>
                        )}
                        {sourceMode === 'script' ? (
                          <Field label="Subtitles" htmlFor="tp-subtitles" hint={subtitleMode === 'provider' ? 'TalkingPhotos burns subtitles into the video.' : subtitleMode === 'local' ? 'Mental Empire generates and burns local captions after download.' : 'No subtitles are added at creation time.'}>
                            <Seg
                              grow
                              value={subtitleMode}
                              onChange={setSubtitleMode}
                              options={[
                                { value: 'none', label: 'None' },
                                { value: 'provider', label: 'Provider' },
                                { value: 'local', label: 'Local captions' }
                              ]}
                            />
                          </Field>
                        ) : (
                          <div className="tp-hint">Subtitles for uploaded-audio videos can be added afterward from My videos, once the render completes.</div>
                        )}
                      </div>
                    </section>
                  </div>

                  <aside className="tp-aside">
                    <section className="tp-section">
                      <div className="tp-eyebrow" style={{ marginBottom: 10 }}>Summary</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11.5, color: 'var(--text-muted)' }}>
                        <div>Source <b style={{ color: 'var(--text-bright)' }}>{sourceMode === 'audio' ? 'Uploaded audio' : 'Script (TTS)'}</b></div>
                        <div>Style <b style={{ color: 'var(--text-bright)' }}>{style === 'high_quality' ? 'High Quality' : 'Normal'}</b> · <b style={{ color: 'var(--text-bright)' }}>{aspectRatio}</b></div>
                        <div>Character image <b style={{ color: characterImagePath ? 'var(--ok-2)' : 'var(--text-dim)' }}>{characterImagePath ? 'Added' : 'Not added'}</b></div>
                      </div>
                    </section>

                    {capabilities && (
                      <section className="tp-section">
                        <div className="tp-eyebrow" style={{ marginBottom: 10 }}>Account limits</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                          <Meter label="Concurrent jobs" used={capabilities.usage.concurrentCount} limit={capabilities.usage.concurrentLimit} />
                          <Meter label="Videos today" used={capabilities.usage.dailyUsage} limit={capabilities.usage.dailyLimit} />
                          <div style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>Max duration <b style={{ color: 'var(--text-bright)' }}>{capabilities.limits.maxDurationSeconds}s</b></div>
                        </div>
                      </section>
                    )}

                    <div className="tp-cta-wrap">
                      <Btn variant="primary" style={{ width: '100%', justifyContent: 'center' }} onClick={() => void submit()} disabled={creating}>
                        {creating ? 'Submitting…' : 'Create video'}
                      </Btn>
                      {attemptedSubmit && Object.keys(errors).length > 0 && (
                        <div className="tp-cta-reason">{errors[FIELD_ORDER.find((k) => errors[k])!]}</div>
                      )}
                    </div>
                  </aside>
                </div>
              </div>
            )}

            {tab === 'videos' && (
              <div id="tp-panel-videos" role="tabpanel" aria-labelledby="tp-tab-videos">
                {successMessage && <Banner kind="success" style={{ marginBottom: 14 }}>{successMessage}</Banner>}
                <div className="tp-section">
                  {visibleJobs.length === 0 ? (
                    <EmptyState
                      title="No videos yet"
                      body="Create your first talking video, or sync to check for existing TalkingPhotos projects."
                      action={<Btn variant="soft" onClick={() => setTab('create')}>Create your first video</Btn>}
                    />
                  ) : (
                    visibleJobs.map((job) => <JobRow key={job.id} job={job} highlighted={job.id === highlightJobId} />)
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </ScreenPad>
  )
}
