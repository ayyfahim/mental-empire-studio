import { useEffect, useMemo, useState } from 'react'
import { ScreenPad, PrimaryButton } from '../components/primitives'
import { useStore } from '../store/useStore'
import { useTalkingPhotos } from '../store/useTalkingPhotos'
import { useData } from '../store/useData'
import { describeTalkingPhotosCapabilities } from '@shared/talkingphotos'
import type { ProviderConnectionStatus, ProviderJob, TalkingPhotosAspectRatio, TalkingPhotosProjectStyle, TalkingPhotosSubtitleMode } from '@shared/talkingphotos'

const STATUS_LABEL: Record<ProviderConnectionStatus, string> = {
  disconnected: 'Not connected',
  connecting: 'Connecting…',
  waiting_for_login: 'Waiting for login…',
  verifying: 'Verifying session…',
  connected: 'Connected',
  reauth_required: 'Reconnect required',
  attention: 'Needs attention'
}
const STATUS_COLOR: Record<ProviderConnectionStatus, string> = {
  disconnected: '#6a7180',
  connecting: '#f5b323',
  waiting_for_login: '#f5b323',
  verifying: '#f5b323',
  connected: '#4fd6a0',
  reauth_required: '#ff8a96',
  attention: '#ff8a96'
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

function Card({ label, children }: { label?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ border: '1px solid #1d2129', borderRadius: 14, padding: 18, background: '#12151b', marginBottom: 16 }}>
      {label && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.6px', color: '#5b616f', marginBottom: 13 }}>{label}</div>}
      {children}
    </div>
  )
}

function JobRow({ job }: { job: ProviderJob }): JSX.Element {
  const downloadOutput = useTalkingPhotos((s) => s.downloadOutput)
  const createProviderSubtitles = useTalkingPhotos((s) => s.createProviderSubtitles)
  const applyLocalCaptions = useTalkingPhotos((s) => s.applyLocalCaptions)
  const title = job.remoteProjectId ? `Project ${job.remoteProjectId}` : job.id
  const stepLabel = job.remoteStepsTotal ? `step ${job.remoteStep ?? 0} of ${job.remoteStepsTotal}` : undefined
  const canOfferSubtitles = job.status === 'completed' && !!job.localOutputPath && job.operation !== 'subtitles'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, border: '1px solid #1d2129', borderRadius: 9, padding: '11px 13px', background: '#0e1116', marginBottom: 8 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: '#cdd2da', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
        <div style={{ fontSize: 10.5, color: '#6a7180', marginTop: 2 }}>{job.operation} · {stepLabel ?? 'processing'}{job.errorMessage ? ` · ${job.errorMessage}` : ''}</div>
      </div>
      <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', border: '1px solid #262b34', borderRadius: 6, padding: '3px 8px', color: job.status === 'completed' ? '#4fd6a0' : job.status === 'failed' || job.status === 'attention' ? '#ff8a96' : '#8a909c' }}>
        {JOB_STATUS_LABEL[job.status]}
      </span>
      {canOfferSubtitles && !job.localCaptionedOutputPath && (
        <>
          <div className="me-btn" title="Submit provider subtitles for this video" onClick={() => void createProviderSubtitles(job.id)} style={{ border: '1px solid #262b34', borderRadius: 7, padding: '6px 10px', fontSize: 11, color: '#c4cad3', cursor: 'pointer' }}>Subtitles</div>
          <div className="me-btn" title="Burn local captions onto a copy of this video" onClick={() => void applyLocalCaptions(job.id)} style={{ border: '1px solid #262b34', borderRadius: 7, padding: '6px 10px', fontSize: 11, color: '#c4cad3', cursor: 'pointer' }}>Local captions</div>
        </>
      )}
      {job.localCaptionedOutputPath && (
        <div className="me-btn" onClick={() => void window.api?.publish?.reveal?.(job.localCaptionedOutputPath!)} style={{ border: '1px solid #1e3a2a', color: '#4fd6a0', borderRadius: 7, padding: '6px 10px', fontSize: 11, cursor: 'pointer' }}>Captioned copy</div>
      )}
      {job.status === 'completed' && job.localOutputPath && (
        <div className="me-btn" onClick={() => void window.api?.publish?.reveal?.(job.localOutputPath!)} style={{ border: '1px solid #262b34', borderRadius: 7, padding: '6px 10px', fontSize: 11, color: '#c4cad3', cursor: 'pointer' }}>Open folder</div>
      )}
      {(job.status === 'downloading' || (job.status === 'completed' && !job.localOutputPath)) && (
        <div className="me-btn" onClick={() => void downloadOutput(job.id)} style={{ border: '1px solid var(--accent)', color: 'var(--accent)', borderRadius: 7, padding: '6px 10px', fontSize: 11, cursor: 'pointer' }}>
          {job.errorMessage ? 'Retry download' : 'Download'}
        </div>
      )}
    </div>
  )
}

export function TalkingVideo(): JSX.Element {
  const enabled = useStore((s) => s.settings.integrations.talkingPhotos.enabled)
  const { connection, connecting, capabilities, jobs, syncing, creating, error, init, connect, reconnect, sync, createUploadedAudio, createScript } = useTalkingPhotos()
  const downloads = useData((s) => s.downloads)
  const loadDownloads = useData((s) => s.loadDownloads)
  const [title, setTitle] = useState('')
  const [audioPath, setAudioPath] = useState('')
  const [characterImagePath, setCharacterImagePath] = useState('')
  const [characterPrompt, setCharacterPrompt] = useState('')
  const [style, setStyle] = useState<TalkingPhotosProjectStyle>('high_quality')
  const [aspectRatio, setAspectRatio] = useState<TalkingPhotosAspectRatio>('16:9')
  const [motionId, setMotionId] = useState(0)
  const downloadedAudio = useMemo(() => downloads.filter((item) => !!item.filePath && /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(item.filePath)), [downloads])

  // Custom-script (TTS) creation — a separate card, shares the character image and
  // project-style/motion controls above where practical, but is otherwise standalone.
  const [scriptTitle, setScriptTitle] = useState('')
  const [script, setScript] = useState('')
  const [scriptImagePath, setScriptImagePath] = useState('')
  const [scriptCharacterPrompt, setScriptCharacterPrompt] = useState('')
  const [language, setLanguage] = useState('en-US')
  const [voice, setVoice] = useState('en-US-AndrewMultilingualNeural')
  const [subtitleMode, setSubtitleMode] = useState<TalkingPhotosSubtitleMode>('none')

  useEffect(() => { void init(); void loadDownloads() }, [init, loadDownloads])

  const status = connection?.status ?? 'disconnected'
  const capabilitySummary = describeTalkingPhotosCapabilities(status, capabilities ?? null)
  const selectLocalFile = (files: FileList | null, setPath: (p: string) => void): void => {
    const file = files?.[0]
    if (!file) return
    setPath(window.api?.pathForFile?.(file) ?? '')
  }
  const submit = async (): Promise<void> => {
    const job = await createUploadedAudio({
      title,
      audioPath,
      characterImagePath,
      characterPrompt,
      style,
      aspectRatio,
      motionId: style === 'high_quality' ? 0 : motionId
    })
    if (job) {
      setTitle('')
      await sync()
    }
  }
  const submitScript = async (): Promise<void> => {
    if (!capabilitySummary.ttsAvailable) return
    const job = await createScript({
      title: scriptTitle,
      script,
      characterImagePath: scriptImagePath,
      characterPrompt: scriptCharacterPrompt,
      style,
      aspectRatio,
      motionId: style === 'high_quality' ? 0 : motionId,
      language,
      voice,
      voiceStyle: 'general',
      speed: 1,
      pitch: 0,
      subtitleMode
    })
    if (job) {
      setScriptTitle('')
      setScript('')
      await sync()
    }
  }
  const inputStyle = { width: '100%', boxSizing: 'border-box' as const, background: '#0e1116', border: '1px solid #262b34', borderRadius: 7, color: '#d7dbe2', padding: '8px 10px', fontSize: 11.5 }

  return (
    <ScreenPad style={{ paddingTop: 0 }}>
      <div style={{ padding: '18px 0 16px', borderBottom: '1px solid #1d2129', marginBottom: 22, display: 'flex', alignItems: 'center', gap: 14 }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '1px', color: 'var(--accent)', marginBottom: 5 }}>CREATE</div>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 22, letterSpacing: '-.5px', color: '#f4f6f9' }}>Talking Video</div>
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: STATUS_COLOR[status] ?? '#6a7180' }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_COLOR[status] ?? '#6a7180' }} />
          {STATUS_LABEL[status] ?? 'Not connected'}
        </span>
      </div>

      {!enabled && (
        <Card>
          <div style={{ fontSize: 12.5, color: '#cdd2da', marginBottom: 4 }}>TalkingPhotos is turned off</div>
          <div style={{ fontSize: 11, color: '#6a7180' }}>Enable it in Settings → Integrations to connect an account and sync your projects.</div>
        </Card>
      )}

      {enabled && status !== 'connected' && (
        <Card label="CONNECT">
          <div style={{ fontSize: 12, color: '#8a909c', marginBottom: 12 }}>
            {status === 'reauth_required'
              ? 'Your TalkingPhotos session expired. Reconnect to keep syncing existing projects.'
              : status === 'attention'
              ? 'The last connect attempt closed before finishing. Try again.'
              : status === 'waiting_for_login'
              ? 'Finish logging in in the window that opened — this will update automatically.'
              : status === 'verifying'
              ? 'Confirming your session with TalkingPhotos…'
              : 'Connect your TalkingPhotos.ai account to sync and download your existing projects.'}
          </div>
          <PrimaryButton disabled={connecting} onClick={() => void (status === 'reauth_required' ? reconnect() : connect())}>
            {/* Each in-flight sub-state gets its own label so login/verify/generic
                connecting never look like the same stuck button. */}
            {connecting ? STATUS_LABEL[status] : status === 'reauth_required' ? 'Reconnect TalkingPhotos' : status === 'attention' ? 'Retry TalkingPhotos' : 'Connect TalkingPhotos'}
          </PrimaryButton>
        </Card>
      )}

      {error && (
        <div style={{ fontSize: 11.5, color: '#ff8a96', marginBottom: 14 }}>{error}</div>
      )}

      {enabled && status === 'connected' && (
        <>
          <Card label="CREATE WITH UPLOADED AUDIO">
            <div style={{ fontSize: 11, color: '#6a7180', lineHeight: 1.5, marginBottom: 14 }}>Use a manual audio file or audio already downloaded by Mental Empire. Audio beyond the provider limit is split, rendered in order, and merged automatically.</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <label style={{ fontSize: 10.5, color: '#8a909c' }}>Title<input value={title} onChange={(event) => setTitle(event.target.value)} style={{ ...inputStyle, display: 'block', marginTop: 5 }} /></label>
              <label style={{ fontSize: 10.5, color: '#8a909c' }}>Downloaded Mental Empire audio
                <select value={downloadedAudio.some((item) => item.filePath === audioPath) ? audioPath : ''} onChange={(event) => setAudioPath(event.target.value)} style={{ ...inputStyle, display: 'block', marginTop: 5 }}>
                  <option value="">Choose downloaded audio…</option>
                  {downloadedAudio.map((item) => <option key={item.id} value={item.filePath}>{item.title}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 10.5, color: '#8a909c' }}>Character prompt<input value={characterPrompt} onChange={(event) => setCharacterPrompt(event.target.value)} placeholder="Describe the person to animate" style={{ ...inputStyle, display: 'block', marginTop: 5 }} /></label>
              <label style={{ fontSize: 10.5, color: '#8a909c' }}>Style
                <select value={style} onChange={(event) => { const next = event.target.value as TalkingPhotosProjectStyle; setStyle(next); if (next === 'high_quality') setMotionId(0) }} style={{ ...inputStyle, display: 'block', marginTop: 5 }}><option value="high_quality">High Quality (60s segments)</option><option value="normal">Normal (300s segments)</option></select>
              </label>
              <label style={{ fontSize: 10.5, color: '#8a909c' }}>Aspect ratio
                <select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as TalkingPhotosAspectRatio)} style={{ ...inputStyle, display: 'block', marginTop: 5 }}><option value="16:9">16:9</option><option value="1:1">1:1</option><option value="9:16">9:16</option></select>
              </label>
              <label style={{ fontSize: 10.5, color: '#8a909c' }}>Motion ID<input type="number" min={style === 'normal' ? 1 : 0} disabled={style === 'high_quality'} value={style === 'high_quality' ? 0 : motionId} onChange={(event) => setMotionId(Number(event.target.value))} style={{ ...inputStyle, display: 'block', marginTop: 5, opacity: style === 'high_quality' ? .55 : 1 }} /></label>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 13 }}>
              <label className="me-btn" style={{ border: '1px solid #262b34', borderRadius: 7, padding: '7px 11px', fontSize: 11, color: '#c4cad3', cursor: 'pointer' }}><input type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg" hidden onChange={(event) => selectLocalFile(event.target.files, setAudioPath)} />Choose audio file</label>
              <label className="me-btn" style={{ border: '1px solid #262b34', borderRadius: 7, padding: '7px 11px', fontSize: 11, color: '#c4cad3', cursor: 'pointer' }}><input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => selectLocalFile(event.target.files, setCharacterImagePath)} />Choose character image</label>
              <div style={{ flex: 1, minWidth: 0, color: '#5b616f', fontSize: 10 }} className="me-ellipsis" title={`${audioPath}\n${characterImagePath}`}>{audioPath ? `Audio: ${audioPath.split(/[\\/]/).pop()}` : 'No audio selected'} · {characterImagePath ? `Image: ${characterImagePath.split(/[\\/]/).pop()}` : 'No image selected'}</div>
              <PrimaryButton disabled={creating} onClick={() => void submit()}>{creating ? 'Submitting…' : 'Create video'}</PrimaryButton>
            </div>
          </Card>

          <Card label="CREATE WITH A SCRIPT (TTS)">
            <div style={{ fontSize: 11, color: '#6a7180', lineHeight: 1.5, marginBottom: 14 }}>
              {capabilitySummary.ttsAvailable
                ? 'Type a script; TalkingPhotos generates speech and resolves the result over its WebSocket before the video is created. Long scripts are split at sentence boundaries and merged automatically.'
                : 'Script (TTS) creation is unavailable for this account — the fields below are disabled.'}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, opacity: capabilitySummary.ttsAvailable ? 1 : 0.55 }}>
              <label style={{ fontSize: 10.5, color: '#8a909c' }}>Title<input disabled={!capabilitySummary.ttsAvailable} value={scriptTitle} onChange={(event) => setScriptTitle(event.target.value)} style={{ ...inputStyle, display: 'block', marginTop: 5 }} /></label>
              <label style={{ fontSize: 10.5, color: '#8a909c' }}>Character prompt<input disabled={!capabilitySummary.ttsAvailable} value={scriptCharacterPrompt} onChange={(event) => setScriptCharacterPrompt(event.target.value)} placeholder="Describe the person to animate" style={{ ...inputStyle, display: 'block', marginTop: 5 }} /></label>
              <label style={{ fontSize: 10.5, color: '#8a909c', gridColumn: '1 / -1' }}>Script<textarea disabled={!capabilitySummary.ttsAvailable} value={script} onChange={(event) => setScript(event.target.value)} rows={4} placeholder="What should the character say?" style={{ ...inputStyle, display: 'block', marginTop: 5, resize: 'vertical', fontFamily: 'inherit' }} /></label>
              <label style={{ fontSize: 10.5, color: '#8a909c' }}>Language<input disabled={!capabilitySummary.ttsAvailable} value={language} onChange={(event) => setLanguage(event.target.value)} style={{ ...inputStyle, display: 'block', marginTop: 5 }} /></label>
              <label style={{ fontSize: 10.5, color: '#8a909c' }}>Voice<input disabled={!capabilitySummary.ttsAvailable} value={voice} onChange={(event) => setVoice(event.target.value)} style={{ ...inputStyle, display: 'block', marginTop: 5 }} /></label>
              <label style={{ fontSize: 10.5, color: '#8a909c' }}>Subtitles
                <select disabled={!capabilitySummary.ttsAvailable} value={subtitleMode} onChange={(event) => setSubtitleMode(event.target.value as TalkingPhotosSubtitleMode)} style={{ ...inputStyle, display: 'block', marginTop: 5 }}>
                  <option value="none">None</option>
                  <option value="provider">TalkingPhotos subtitles</option>
                  <option value="local">Mental Empire local captions</option>
                </select>
              </label>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 13 }}>
              <label className="me-btn" style={{ border: '1px solid #262b34', borderRadius: 7, padding: '7px 11px', fontSize: 11, color: '#c4cad3', cursor: capabilitySummary.ttsAvailable ? 'pointer' : 'not-allowed', opacity: capabilitySummary.ttsAvailable ? 1 : 0.55 }}><input type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={!capabilitySummary.ttsAvailable} onChange={(event) => selectLocalFile(event.target.files, setScriptImagePath)} />Choose character image</label>
              <div style={{ flex: 1, minWidth: 0, color: '#5b616f', fontSize: 10 }} className="me-ellipsis">{scriptImagePath ? `Image: ${scriptImagePath.split(/[\\/]/).pop()}` : 'No image selected'}</div>
              <PrimaryButton disabled={creating || !capabilitySummary.ttsAvailable} onClick={() => void submitScript()}>{creating ? 'Submitting…' : 'Create video'}</PrimaryButton>
            </div>
          </Card>

          {capabilities && (
            <Card label="ACCOUNT LIMITS">
              <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', fontSize: 11.5, color: '#8a909c' }}>
                <div>Max duration <b style={{ color: '#cdd2da' }}>{capabilities.limits.maxDurationSeconds}s</b></div>
                <div>Max TTS characters <b style={{ color: '#cdd2da' }}>{capabilities.limits.maxCharactersTts}</b></div>
                <div>Concurrent <b style={{ color: '#cdd2da' }}>{capabilities.usage.concurrentCount}/{capabilities.usage.concurrentLimit}</b></div>
                <div>Daily videos <b style={{ color: '#cdd2da' }}>{capabilities.usage.dailyUsage}/{capabilities.usage.dailyLimit}</b></div>
              </div>
            </Card>
          )}

          <Card label="REMOTE PROJECTS">
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: '#6a7180', flex: 1 }}>Synced from your TalkingPhotos account.</div>
              <div className="me-btn" onClick={() => void sync()} style={{ border: '1px solid #262b34', borderRadius: 7, padding: '6px 12px', fontSize: 11, color: '#c4cad3', cursor: 'pointer' }}>{syncing ? 'Syncing…' : 'Sync'}</div>
            </div>
            {jobs.length === 0 && <div style={{ fontSize: 11.5, color: '#5b616f' }}>No projects yet. Sync to check for existing TalkingPhotos projects, or create one from talkingphotos.ai.</div>}
            {jobs.filter((job) => !job.internalSegment).map((job) => <JobRow key={job.id} job={job} />)}
          </Card>
        </>
      )}
    </ScreenPad>
  )
}
