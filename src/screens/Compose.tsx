import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { useData } from '../store/useData'
import { Banner, Btn, SectionLabel } from '../components/ui/kit'
import { PipelineRibbon } from '../components/PipelineRibbon'
import { ProjectGate } from '../components/ProjectGate'
import { PreviewStage } from '../features/compose/ui/PreviewStage'
import { Timeline, type EditorSelection } from '../features/compose/ui/Timeline'
import { MediaPanel } from '../features/compose/ui/MediaPanel'
import { CaptionsPanel } from '../features/compose/ui/CaptionsPanel'
import { StylePanel } from '../features/compose/ui/StylePanel'
import { EffectsPanel } from '../features/compose/ui/EffectsPanel'
import { GpuChip } from '../features/compose/ui/GpuChip'
import { composeRenderPreflight, editorSelectionLabel, fmt } from '../features/compose/ui/util'

/* Compose — the video editor. Layout: header (project switcher + render CTA),
   live preview stage beside a tabbed inspector, and the multi-track timeline
   with its selection editor underneath. */

type InspectorTab = 'media' | 'captions' | 'style' | 'effects'

const TABS: Array<{ id: InspectorTab; label: string; icon: JSX.Element }> = [
  {
    id: 'media',
    label: 'Media',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="14" rx="2.5" /><circle cx="8.5" cy="10" r="1.7" /><path d="M4 17l5-4 4 3 2-2 5 4" /></svg>
  },
  {
    id: 'captions',
    label: 'Captions',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M7 14h4" /><path d="M14 14h3" /></svg>
  },
  {
    id: 'style',
    label: 'Style',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" /></svg>
  },
  {
    id: 'effects',
    label: 'Effects',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 6h16M4 12h16M4 18h7" /></svg>
  }
]

export function Compose(): JSX.Element {
  const setActive = useStore((s) => s.setActive)
  const project = useData((s) => s.activeProject)
  const images = useData((s) => s.projectImages)
  const transcript = useData((s) => s.transcript)
  const previewSpec = useData((s) => s.previewSpec)
  const downloads = useData((s) => s.downloads)
  const openProject = useData((s) => s.openProject)
  const sendActiveToRender = useData((s) => s.sendActiveToRender)

  const [tab, setTab] = useState<InspectorTab>('media')
  const [error, setError] = useState('')
  const [queued, setQueued] = useState(false)
  const [sending, setSending] = useState(false)
  const [openingDownloadId, setOpeningDownloadId] = useState('')
  const [playheadSec, setPlayheadSec] = useState(0)
  const [selection, setSelection] = useState<EditorSelection>({ kind: 'project' })
  const fileInputRef = useRef<HTMLInputElement>(null)

  const previewBroll = previewSpec?.broll ?? []
  const preflight = useMemo(() => composeRenderPreflight(project, images), [project, images])
  const selectedLabel = useMemo(
    () => editorSelectionLabel(selection, images, transcript, previewBroll, project),
    [selection, images, transcript, previewBroll, project]
  )

  // Auto-open only when there is one obvious choice; with multiple downloads the
  // context stays explicit so Compose never silently swaps projects.
  useEffect(() => {
    if (!project && downloads.length === 1) {
      void openProject(downloads[0].id).catch((e) => setError((e as Error).message))
    }
  }, [project, downloads, openProject])

  useEffect(() => {
    setPlayheadSec(0)
    setSelection({ kind: 'project' })
    setQueued(false)
    setError('')
  }, [project?.id])

  const openComposeProject = async (downloadId: string): Promise<void> => {
    if (openingDownloadId) return
    setOpeningDownloadId(downloadId)
    setError('')
    try {
      await openProject(downloadId)
    } catch (e) {
      setError((e as Error).message || 'Could not open this video.')
    } finally {
      setOpeningDownloadId('')
    }
  }

  const sendToRender = async (): Promise<void> => {
    if (sending) return
    if (!preflight.ready) {
      setError(`Project is not render-ready. Missing: ${preflight.missing.join(', ')}.`)
      return
    }
    setSending(true)
    setError('')
    try {
      await sendActiveToRender()
      setQueued(true)
      setTimeout(() => setQueued(false), 3000)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="me-screen" style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: '18px 22px 16px', gap: 12, minHeight: 0 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 'none' }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ color: 'var(--accent)', marginBottom: 4 }}>Step 02 — Compose</SectionLabel>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 21, letterSpacing: '-.4px', color: 'var(--text-strong)', lineHeight: 1 }}>
            Video studio
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <GpuChip />
        {downloads.length > 0 && (
          <select
            className="ed-input"
            value={project?.downloadId ?? ''}
            onChange={(e) => { if (e.target.value) void openComposeProject(e.target.value) }}
            style={{ width: 260, fontSize: 12 }}
            title="Switch project"
          >
            {!project && <option value="">Choose a downloaded clip…</option>}
            {downloads.filter((d) => !!d.filePath && (d.durationSec ?? 0) > 0).map((d) => (
              <option key={d.id} value={d.id}>{d.title}</option>
            ))}
          </select>
        )}
        {project && (
          <Btn
            variant={queued ? 'soft' : 'primary'}
            disabled={sending || (!queued && !preflight.ready)}
            title={!queued && !preflight.ready ? `Missing: ${preflight.missing.join(', ')}` : undefined}
            onClick={() => void sendToRender()}
          >
            {queued ? '✓ Queued for render' : sending ? 'Queueing…' : 'Send to render'}
            {!queued && !sending && (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            )}
          </Btn>
        )}
      </div>

      {error && <Banner kind="error" style={{ flex: 'none' }}>{error}</Banner>}

      {!project ? (
        <div className="ed-scroll" style={{ flex: 1, minHeight: 0, paddingTop: 10 }}>
          <ProjectGate
            headline="Pick a video to compose"
            sub="Finished downloads ready for editing — captions, look, motion, and render."
            downloads={downloads}
            openingId={openingDownloadId}
            error=""
            onOpen={(id) => void openComposeProject(id)}
            onSources={() => setActive('sources')}
          />
        </div>
      ) : (
        <>
          <div style={{ flex: 'none' }}>
            <PipelineRibbon
              title={project.title}
              downloadId={project.downloadId}
              projectId={project.id}
              snapshot={{
                downloaded: true,
                hasImages: images.length > 0,
                captioned: transcript.length > 0,
                hasThumbnail: Boolean(project.thumbPath)
              }}
              onCustomAction={(act) => {
                if (act.screen === 'compose' && act.label === 'Add images') {
                  setTab('media')
                  setTimeout(() => fileInputRef.current?.click(), 60)
                  return true
                }
                return false
              }}
            />
          </div>

          {/* workspace: preview + inspector */}
          <div style={{ flex: 1, minHeight: 260, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) clamp(300px, 26vw, 360px)', gap: 12 }}>
            <PreviewStage playheadSec={playheadSec} onPlayheadChange={setPlayheadSec} selectedLabel={selectedLabel} />
            <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', borderRadius: 14, background: 'var(--bg-card)', overflow: 'hidden', minHeight: 0 }}>
              <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flex: 'none' }}>
                {TABS.map((t) => {
                  const on = tab === t.id
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setTab(t.id)}
                      className="ed-focus"
                      style={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6,
                        padding: '10px 4px',
                        border: 'none',
                        borderBottom: on ? '2px solid var(--accent)' : '2px solid transparent',
                        background: on ? 'var(--accent-soft)' : 'transparent',
                        color: on ? 'var(--accent)' : 'var(--text-dim)',
                        fontSize: 11.5,
                        fontWeight: on ? 700 : 600,
                        fontFamily: 'var(--font-body)',
                        cursor: 'pointer',
                        transition: 'color .15s, background .15s'
                      }}
                    >
                      {t.icon}
                      {t.label}
                    </button>
                  )
                })}
              </div>
              <div className="ed-scroll" style={{ flex: 1, minHeight: 0, padding: 14 }}>
                {tab === 'media' && <MediaPanel fileInputRef={fileInputRef} />}
                {tab === 'captions' && <CaptionsPanel />}
                {tab === 'style' && <StylePanel />}
                {tab === 'effects' && <EffectsPanel />}
              </div>
              <div style={{ flex: 'none', borderTop: '1px solid var(--border)', padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="me-ellipsis" style={{ flex: 1, fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }} title={project.title}>
                  {project.title}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', flex: 'none' }}>{fmt(project.durationSec)}</span>
              </div>
            </div>
          </div>

          {/* timeline */}
          <div style={{ flex: 'none' }}>
            <Timeline
              project={project}
              images={images}
              broll={previewBroll}
              words={transcript}
              playheadSec={playheadSec}
              selection={selection}
              onSeek={setPlayheadSec}
              onSelect={setSelection}
            />
          </div>
        </>
      )}
    </div>
  )
}
