import { useEffect, useMemo, useRef, useState } from 'react'
import type { MontageRuntime } from '@shared/types'
import { useData } from '../../../store/useData'
import { usePreviewCompositor } from '../hooks/usePreviewCompositor'
import { mediaSrc, videoSrc } from '../../../lib/media'
import { previewImagesKey } from '../preview/previewKeys'
import { IconBtn, StatusPill } from '../../../components/ui/kit'
import { fmt } from './util'

/* The live preview stage. Runs the SAME WebGL compositor + caption layer as the
   final GPU export, so what you see here is the real render. Playback drives the
   canvas imperatively (no React state per frame) and keeps the narration audio
   in sync.

   Additionally offers a "Preview final (OpenMontage)" mode: when the project is set
   to compose via OpenMontage, this renders a bounded SAMPLE through the OM bridge
   (`window.api.montage.produce(id, { sample:true })`) and plays the resulting mp4.
   The live WebGL preview stays the default/native view; the OM sample is a toggle. */

type PreviewMode = 'live' | 'montage'
type MontageStatus = 'idle' | 'rendering' | 'ready' | 'error'

/** Read the OpenMontage composition runtime a project is configured for, if any.
 *  The field lives in `betaOpts.montageRuntime` (added by the Compose StylePanel /
 *  Automations units); read it defensively so this compiles regardless of merge order. */
function montageRuntimeOf(project: { betaOpts?: unknown } | null | undefined): MontageRuntime | undefined {
  const raw = project?.betaOpts
  const rt = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).montageRuntime : undefined
  return rt === 'remotion' || rt === 'hyperframes' || rt === 'ffmpeg' ? rt : undefined
}

const Icons = {
  toStart: <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h2V5H6v14zm3.5-7L18 5v14l-8.5-7z" /></svg>,
  back: <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" /></svg>,
  play: <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>,
  pause: <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>,
  fwd: <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" /></svg>,
  toEnd: <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M16 5v14h2V5h-2zm-8.5 7L16 19V5L7.5 12z" /></svg>
}

export function PreviewStage({
  playheadSec: controlledPlayheadSec,
  onPlayheadChange,
  selectedLabel
}: {
  playheadSec: number
  onPlayheadChange: (sec: number) => void
  selectedLabel?: string
}): JSX.Element {
  const project = useData((s) => s.activeProject)
  const images = useData((s) => s.projectImages)
  const transcript = useData((s) => s.transcript)
  const spec = useData((s) => s.previewSpec)
  const previewLoading = useData((s) => s.previewLoading)
  const previewError = useData((s) => s.previewError)
  const loadPreviewSpec = useData((s) => s.loadPreviewSpec)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [localPlayheadSec, setLocalPlayheadSec] = useState(0)
  const [playing, setPlaying] = useState(false)
  const lastPlayheadEmitMs = useRef(0)

  // ---- OpenMontage final-video sample preview (additive mode) ----
  const [mode, setMode] = useState<PreviewMode>('live')
  const [montageStatus, setMontageStatus] = useState<MontageStatus>('idle')
  const [montageOutput, setMontageOutput] = useState('')
  const [montageError, setMontageError] = useState('')
  const [montageStage, setMontageStage] = useState('')
  // Bumped on every start/cancel/project-change so a resolving produce() from a
  // stale run (or after cancel) can't clobber the current UI state.
  const montageRunRef = useRef(0)
  const montageRuntime = montageRuntimeOf(project)

  // Any project field that affects the rendered frame → refetch the preview spec.
  const projectKey = useMemo(() => {
    if (!project) return ''
    return [
      project.id, project.durationSec, project.captionPreset, project.captionFont, project.captionAnim,
      project.captionAspect, project.captionLines, project.captionPosition, project.captionPace,
      project.captionHighlightColor, project.captionBoxColor, project.captionWordsPerPage,
      project.kenBurns, project.motionPreset, project.punchZoom, project.keywords,
      project.lookLut, project.lookStrength,
      JSON.stringify(project.lookAdjust ?? {}),
      JSON.stringify(project.betaOpts ?? {})
    ].join('|')
  }, [project])
  const imagesKey = useMemo(() => previewImagesKey(images), [images])
  const transcriptKey = useMemo(
    () => transcript.map((w) => `${w.id}:${w.word}:${w.start}:${w.end}:${w.emphasis ? 1 : 0}`).join('|'),
    [transcript]
  )

  const durationSec = Math.max(0.05, spec?.durationSec ?? project?.durationSec ?? 0.05)
  const externalPlayheadSec = controlledPlayheadSec ?? localPlayheadSec
  const playheadSec = playing ? localPlayheadSec : externalPlayheadSec
  const { status, error, drawAt } = usePreviewCompositor(canvasRef, spec, playheadSec)
  const activeBroll = spec?.broll?.find((seg) => playheadSec >= seg.startSec && playheadSec < seg.endSec)
  const canDraw = !!project && !!spec && status !== 'error'

  const setPreviewPlayhead = (next: number | ((current: number) => number), opts?: { throttle?: boolean }): void => {
    const value = typeof next === 'function' ? next(playheadSec) : next
    const clamped = Math.max(0, Math.min(durationSec, value))
    setLocalPlayheadSec(clamped)
    if (!opts?.throttle) {
      lastPlayheadEmitMs.current = performance.now()
      onPlayheadChange(clamped)
      return
    }
    const now = performance.now()
    if (now - lastPlayheadEmitMs.current >= 100 || clamped >= durationSec) {
      lastPlayheadEmitMs.current = now
      onPlayheadChange(clamped)
    }
  }

  useEffect(() => {
    setPlaying(false)
    setLocalPlayheadSec(0)
    // Reset the OM preview back to the native view when the project changes, and
    // invalidate any in-flight sample render so its result is ignored.
    montageRunRef.current++
    setMode('live')
    setMontageStatus('idle')
    setMontageOutput('')
    setMontageError('')
    setMontageStage('')
  }, [project?.id])

  const startMontagePreview = async (): Promise<void> => {
    if (!project) return
    const projectId = project.id
    const runId = ++montageRunRef.current
    setMontageStatus('rendering')
    setMontageError('')
    setMontageStage('')
    setMontageOutput('')
    try {
      const result = await window.api?.montage?.produce(
        projectId,
        montageRuntime ? { sample: true, runtime: montageRuntime } : { sample: true }
      )
      if (montageRunRef.current !== runId) return // superseded / cancelled / project changed
      if (result?.ok && result.output) {
        setMontageOutput(result.output)
        setMontageStatus('ready')
      } else {
        setMontageError(result?.error || 'OpenMontage composition not available yet')
        setMontageStatus('error')
      }
    } catch (e) {
      if (montageRunRef.current !== runId) return
      setMontageError((e as Error)?.message || 'OpenMontage sample render failed')
      setMontageStatus('error')
    }
  }

  const cancelMontagePreview = (): void => {
    montageRunRef.current++ // invalidate the in-flight resolve
    if (project) void window.api?.montage?.cancel(project.id)
    setMontageStatus('idle')
    setMontageStage('')
  }

  const toggleMontageMode = (): void => {
    if (mode === 'montage') {
      setMode('live')
      return
    }
    // Entering OM mode: stop native playback so the two previews don't fight.
    setPlaying(false)
    if (audioRef.current) audioRef.current.pause()
    setMode('montage')
    if (montageStatus === 'idle') void startMontagePreview()
  }

  // Live OM stage events (preflight → footage → compose → review → done) while a
  // sample render is in flight. Only surfaced in OM mode, filtered to this project.
  useEffect(() => {
    if (mode !== 'montage' || !project) return
    const off = window.api?.onMontageProgress?.((p) => {
      if (p.id !== project.id) return
      const label = p.message ? `${p.stage} — ${p.message}` : p.stage
      if (label) setMontageStage(label)
    })
    return () => { off?.() }
  }, [mode, project?.id])

  useEffect(() => {
    if (!playing && controlledPlayheadSec != null) setLocalPlayheadSec(controlledPlayheadSec)
  }, [controlledPlayheadSec, playing])

  useEffect(() => {
    if (!playing && audioRef.current) audioRef.current.currentTime = playheadSec
  }, [playheadSec, playing])

  useEffect(() => {
    if (!project) return
    void loadPreviewSpec(project.id)
  }, [project?.id, projectKey, imagesKey, transcriptKey, loadPreviewSpec])

  useEffect(() => {
    if (playheadSec > durationSec) setPreviewPlayhead(durationSec)
  }, [durationSec])

  // Playback loop: draw straight to the canvas each frame; audio clock wins when playing.
  useEffect(() => {
    if (!playing || !canDraw) return
    let raf = 0
    let last = performance.now()
    let t = playheadSec
    const audio = audioRef.current
    if (audio) {
      audio.currentTime = t
      audio.play().catch(() => {})
    }
    const tick = (now: number): void => {
      const dt = Math.min(0.25, (now - last) / 1000)
      last = now
      let next = t + dt
      if (audio && !audio.paused) next = audio.currentTime
      if (next >= durationSec) {
        t = durationSec
        drawAt(t)
        setPreviewPlayhead(t)
        setPlaying(false)
        if (audio) audio.pause()
        return
      }
      t = next
      drawAt(t)
      setPreviewPlayhead(t, { throttle: true })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      if (audio) audio.pause()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, canDraw, durationSec, drawAt])

  const loading = previewLoading || status === 'loading'
  const failed = Boolean(previewError || error)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, border: '1px solid var(--border)', borderRadius: 14, background: 'var(--bg-inset-2)', overflow: 'hidden' }}>
      <div style={{ position: 'relative', flex: 1, minHeight: 120, background: '#07080b', overflow: 'hidden' }}>
        {/* absolute frame gives the canvas a definite box so max-width/height letterbox it */}
        <div style={{ position: 'absolute', inset: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <canvas ref={canvasRef} style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 8, boxShadow: '0 12px 44px rgba(0,0,0,.5)', display: 'block' }} />
        </div>
        {/* OpenMontage final-video sample overlay — covers the canvas box when in OM mode */}
        {mode === 'montage' && (
          <div style={{ position: 'absolute', inset: 14, borderRadius: 8, background: 'rgba(7,8,11,.94)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
            {montageStatus === 'ready' && montageOutput ? (
              <video
                key={montageOutput}
                src={videoSrc(montageOutput)}
                controls
                autoPlay
                style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 6, display: 'block', background: '#000' }}
              />
            ) : montageStatus === 'error' ? (
              <div style={{ maxWidth: 440, padding: '0 20px', textAlign: 'center' }}>
                <div style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--err-2)', marginBottom: 6 }}>OpenMontage preview unavailable</div>
                <div title={montageError} className="me-clamp-3" style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  {montageError || 'OpenMontage composition not available yet'}
                </div>
              </div>
            ) : montageStatus === 'rendering' ? (
              <div style={{ maxWidth: 440, padding: '0 20px', textAlign: 'center' }}>
                <div style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--text)', marginBottom: 6 }}>Rendering sample via OpenMontage…</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', wordBreak: 'break-word' }}>{montageStage || 'starting…'}</div>
              </div>
            ) : (
              <div style={{ maxWidth: 440, padding: '0 20px', textAlign: 'center' }}>
                <div style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--text)', marginBottom: 8 }}>Preview the final video</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>Render a short sample through OpenMontage to see the composed result with real B-roll footage.</div>
              </div>
            )}
          </div>
        )}
        {/* status pills */}
        <div style={{ position: 'absolute', left: 14, top: 14, display: 'flex', gap: 6, flexWrap: 'wrap', maxWidth: 'calc(100% - 28px)' }}>
          {mode === 'live' && loading && <StatusPill tone="warn">building preview</StatusPill>}
          {mode === 'live' && !loading && !failed && spec && <StatusPill tone="ok" title="This preview runs the same compositor as the final render">live · {spec.width}×{spec.height}</StatusPill>}
          {mode === 'live' && activeBroll && <StatusPill tone="accent" title={activeBroll.path}>▶ b-roll poster</StatusPill>}
          {mode === 'montage' && <StatusPill tone="accent" title="Rendered by OpenMontage">OpenMontage{montageRuntime ? ` · ${montageRuntime}` : ''}</StatusPill>}
          {selectedLabel && <StatusPill tone="neutral" title={selectedLabel}>{selectedLabel}</StatusPill>}
        </div>
        {/* mode toggle (top-right) */}
        <div style={{ position: 'absolute', right: 14, top: 14, display: 'flex', gap: 6 }}>
          <IconBtn
            title={mode === 'montage' ? 'Back to live preview' : 'Preview final (OpenMontage)'}
            active={mode === 'montage'}
            onClick={toggleMontageMode}
            size={28}
          >
            {mode === 'montage' ? 'Live preview' : 'Final (OpenMontage)'}
          </IconBtn>
        </div>
        {mode === 'live' && failed && (
          <div title={previewError || error} style={{ position: 'absolute', left: 14, right: 14, bottom: 14, border: '1px solid #5a2530', borderRadius: 10, padding: '9px 12px', fontSize: 11.5, color: 'var(--err-2)', background: 'rgba(20,10,14,.9)' }} className="me-clamp-2">
            {previewError || error}
          </div>
        )}
      </div>
      {project?.mp3Path && <audio ref={audioRef} src={mediaSrc(project.mp3Path)} preload="auto" />}
      {mode === 'montage' ? (
        /* OpenMontage sample controls */
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderTop: '1px solid var(--border)', background: 'var(--bg-card-3)' }}>
          {montageStatus === 'rendering' ? (
            <IconBtn title="Cancel sample render" danger onClick={cancelMontagePreview} size={28}>Cancel</IconBtn>
          ) : (
            <IconBtn title="Render a sample via OpenMontage" disabled={!project} onClick={() => void startMontagePreview()} size={28}>
              {montageStatus === 'idle' ? 'Render sample' : 'Re-render'}
            </IconBtn>
          )}
          <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={montageStatus === 'rendering' ? montageStage : montageStatus === 'error' ? montageError : undefined}>
            {montageStatus === 'rendering'
              ? (montageStage || 'starting…')
              : montageStatus === 'ready'
                ? 'Sample ready · playing composed output'
                : montageStatus === 'error'
                  ? 'Sample render failed'
                  : 'Bounded OpenMontage sample of the final video'}
          </span>
        </div>
      ) : (
        /* transport */
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '10px 12px', borderTop: '1px solid var(--border)', background: 'var(--bg-card-3)' }}>
          <IconBtn title="Jump to start" disabled={!canDraw} onClick={() => setPreviewPlayhead(0)} size={28}>{Icons.toStart}</IconBtn>
          <IconBtn title="Back 1 second" disabled={!canDraw} onClick={() => setPreviewPlayhead((t) => Math.max(0, t - 1))} size={28}>{Icons.back}</IconBtn>
          <IconBtn title={playing ? 'Pause' : 'Play'} disabled={!canDraw} active={playing} onClick={() => setPlaying((p) => !p)} size={32}>
            {playing ? Icons.pause : Icons.play}
          </IconBtn>
          <IconBtn title="Forward 1 second" disabled={!canDraw} onClick={() => setPreviewPlayhead((t) => Math.min(durationSec, t + 1))} size={28}>{Icons.fwd}</IconBtn>
          <IconBtn title="Jump to end" disabled={!canDraw} onClick={() => setPreviewPlayhead(durationSec)} size={28}>{Icons.toEnd}</IconBtn>
          <input
            type="range"
            className="ed-range"
            min={0}
            max={Math.max(1, durationSec)}
            step={1 / Math.max(1, spec?.fps ?? 24)}
            value={Math.min(playheadSec, durationSec)}
            disabled={!canDraw}
            onChange={(e) => setPreviewPlayhead(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <span style={{ width: 86, textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-muted)', flex: 'none' }}>
            {fmt(playheadSec)} / {fmt(durationSec)}
          </span>
        </div>
      )}
    </div>
  )
}
