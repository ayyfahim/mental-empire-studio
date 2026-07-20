import { useEffect } from 'react'
import { ScreenPad, PrimaryButton } from '../components/primitives'
import { useStore } from '../store/useStore'
import { useTalkingPhotos } from '../store/useTalkingPhotos'
import type { ProviderConnectionStatus, ProviderJob } from '@shared/talkingphotos'

const STATUS_LABEL: Record<ProviderConnectionStatus, string> = {
  disconnected: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Connected',
  reauth_required: 'Reconnect required',
  error: 'Error'
}
const STATUS_COLOR: Record<ProviderConnectionStatus, string> = {
  disconnected: '#6a7180',
  connecting: '#f5b323',
  connected: '#4fd6a0',
  reauth_required: '#ff8a96',
  error: '#ff8a96'
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
  const title = job.remoteProjectId ? `Project ${job.remoteProjectId}` : job.id
  const stepLabel = job.remoteStepsTotal ? `step ${job.remoteStep ?? 0} of ${job.remoteStepsTotal}` : undefined
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, border: '1px solid #1d2129', borderRadius: 9, padding: '11px 13px', background: '#0e1116', marginBottom: 8 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: '#cdd2da', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
        <div style={{ fontSize: 10.5, color: '#6a7180', marginTop: 2 }}>{job.operation} · {stepLabel ?? 'processing'}{job.errorMessage ? ` · ${job.errorMessage}` : ''}</div>
      </div>
      <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', border: '1px solid #262b34', borderRadius: 6, padding: '3px 8px', color: job.status === 'completed' ? '#4fd6a0' : job.status === 'failed' || job.status === 'attention' ? '#ff8a96' : '#8a909c' }}>
        {JOB_STATUS_LABEL[job.status]}
      </span>
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
  const { connection, connecting, capabilities, jobs, syncing, error, init, connect, reconnect, sync } = useTalkingPhotos()

  useEffect(() => { void init() }, [init])

  const status = connection?.status ?? 'disconnected'

  return (
    <ScreenPad style={{ paddingTop: 0 }}>
      <div style={{ padding: '18px 0 16px', borderBottom: '1px solid #1d2129', marginBottom: 22, display: 'flex', alignItems: 'center', gap: 14 }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '1px', color: 'var(--accent)', marginBottom: 5 }}>CREATE</div>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 22, letterSpacing: '-.5px', color: '#f4f6f9' }}>Talking Video</div>
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: STATUS_COLOR[status] }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_COLOR[status] }} />
          {STATUS_LABEL[status]}
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
              : 'Connect your TalkingPhotos.ai account to sync and download your existing projects.'}
          </div>
          <PrimaryButton onClick={() => void (status === 'reauth_required' ? reconnect() : connect())}>
            {connecting ? 'Connecting…' : status === 'reauth_required' ? 'Reconnect TalkingPhotos' : 'Connect TalkingPhotos'}
          </PrimaryButton>
        </Card>
      )}

      {error && (
        <div style={{ fontSize: 11.5, color: '#ff8a96', marginBottom: 14 }}>{error}</div>
      )}

      {enabled && status === 'connected' && (
        <>
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
            {jobs.map((job) => <JobRow key={job.id} job={job} />)}
          </Card>

          <Card label="CREATING NEW VIDEOS">
            <div style={{ fontSize: 11.5, color: '#5b616f', lineHeight: 1.5 }}>
              Creating new Talking Videos from inside Mental Empire Studio isn't available yet — requires additional protocol capture (TTS audio resolution, imported-audio submission, and error responses aren't confirmed yet). This view stays read-only: sync, watch progress, and download completed output.
            </div>
          </Card>
        </>
      )}
    </ScreenPad>
  )
}
