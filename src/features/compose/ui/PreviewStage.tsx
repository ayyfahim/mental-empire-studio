import { useEffect, useMemo, useRef, useState } from 'react'
import { useData } from '../../../store/useData'
import { usePreviewCompositor } from '../hooks/usePreviewCompositor'
import { mediaSrc } from '../../../lib/media'
import { previewImagesKey } from '../preview/previewKeys'
import { IconBtn, StatusPill } from '../../../components/ui/kit'
import { fmt } from './util'

/* The live preview stage. Runs the SAME WebGL compositor + caption layer as the
   final GPU export, so what you see here is the real render. Playback drives the
   canvas imperatively (no React state per frame) and keeps the narration audio
   in sync. */

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
  }, [project?.id])

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
        {/* status pills */}
        <div style={{ position: 'absolute', left: 14, top: 14, display: 'flex', gap: 6, flexWrap: 'wrap', maxWidth: 'calc(100% - 28px)' }}>
          {loading && <StatusPill tone="warn">building preview</StatusPill>}
          {!loading && !failed && spec && <StatusPill tone="ok" title="This preview runs the same compositor as the final render">live · {spec.width}×{spec.height}</StatusPill>}
          {activeBroll && <StatusPill tone="accent" title={activeBroll.path}>▶ b-roll poster</StatusPill>}
          {selectedLabel && <StatusPill tone="neutral" title={selectedLabel}>{selectedLabel}</StatusPill>}
        </div>
        {failed && (
          <div title={previewError || error} style={{ position: 'absolute', left: 14, right: 14, bottom: 14, border: '1px solid #5a2530', borderRadius: 10, padding: '9px 12px', fontSize: 11.5, color: 'var(--err-2)', background: 'rgba(20,10,14,.9)' }} className="me-clamp-2">
            {previewError || error}
          </div>
        )}
      </div>
      {project?.mp3Path && <audio ref={audioRef} src={mediaSrc(project.mp3Path)} preload="auto" />}
      {/* transport */}
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
    </div>
  )
}
