import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { GpuRenderSpec, RenderImageSpec } from '@shared/renderSpec'
import { Compositor } from '../../../render-worker/compositor'
import { CaptionLayer, warmCaptionFonts } from '../../../render-worker/captions'
import { CAPTION_FONTS } from '@shared/captionStyle'
import { lutTextureById } from '../../../render-worker/lut'
import { isCssImageValue, mediaSrc } from '../../../lib/media'
import { asPosterPreviewSpec } from '../preview/posterSpec'

type PreviewStatus = 'idle' | 'loading' | 'ready' | 'error'

interface PreviewRuntime {
  compositor: Compositor
  captions: CaptionLayer
  /** Poster-frame image specs currently standing in for B-roll video segments. */
  posterImages: RenderImageSpec[]
  /** Decoded stills keyed by resolved path, reused across edits so unchanged images
   *  are never re-fetched/re-decoded. */
  bitmapCache: Map<string, ImageBitmap>
}

function clampTime(t: number, durationSec: number): number {
  return Math.max(0, Math.min(Math.max(0.05, durationSec), t))
}

async function fallbackBitmap(width: number, height: number): Promise<ImageBitmap> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(2, Math.round(width))
  canvas.height = Math.max(2, Math.round(height))
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height)
    g.addColorStop(0, '#23304a')
    g.addColorStop(0.5, '#15171d')
    g.addColorStop(1, '#0e1116')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  return createImageBitmap(canvas)
}

function imageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    if (/^https?:/i.test(url)) img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = url
  })
}

async function loadBitmap(path: string, width: number, height: number): Promise<ImageBitmap> {
  if (!path || isCssImageValue(path) || path.startsWith('browser://')) return fallbackBitmap(width, height)
  // No cache-busting query param: paths are content-addressable (thumbs are hashed),
  // so re-fetching on every edit only wasted decode time.
  const url = mediaSrc(path)
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return createImageBitmap(await res.blob())
  } catch {
    try {
      return createImageBitmap(await imageElement(url))
    } catch {
      return fallbackBitmap(width, height)
    }
  }
}

async function specForPreview(spec: GpuRenderSpec): Promise<{ spec: GpuRenderSpec; images: RenderImageSpec[] }> {
  if (!spec.broll?.length) return { spec, images: spec.images }
  const images: RenderImageSpec[] = await Promise.all(spec.broll.map(async (seg, i) => {
    const poster = await window.api?.compose?.posterFrame?.(seg.path).catch(() => '')
    return {
      path: poster || `browser://broll-poster-${i}.png`,
      startSec: seg.startSec,
      endSec: seg.endSec
    }
  }))
  return { spec: asPosterPreviewSpec(spec, images), images }
}

/** Dimensions key — the ONLY thing that forces a full Compositor/CaptionLayer rebuild. */
function specDimsKey(spec: GpuRenderSpec): string {
  return `${spec.width}x${spec.height}`
}

/** Images key — changes here (new stills, new B-roll, reordering, range edits) require
 *  reconciling the bitmap cache and re-uploading the image texture set. Per-image motion
 *  metadata is NOT included: that's read live off the spec reference each frame. */
function specImagesKey(spec: GpuRenderSpec): string {
  return [
    spec.images.map((im) => `${im.path}|${im.startSec}|${im.endSec}`).join(','),
    spec.broll?.map((b) => `${b.path}|${b.startSec}|${b.endSec}`).join(',') ?? ''
  ].join('#')
}

/** Grade key — changes here only need a LUT swap (no rebuild, no re-decode). */
function specGradeKey(spec: GpuRenderSpec): string {
  const g = spec.grade
  return [
    g.lut ?? '',
    g.lutStrength ?? 1,
    g.saturation,
    g.contrast,
    g.brightness,
    g.colorBalance.r,
    g.colorBalance.g,
    g.colorBalance.b,
    g.vignette,
    g.sharpen,
    spec.grain.strength,
    spec.grain.temporal ? 1 : 0,
    spec.motion.kenBurns ? 1 : 0,
    spec.motion.punchAtSec.join(','),
  ].join('|')
}

/** Captions key — any change to caption content/styling/hook swaps the caption model
 *  in place (no texture rebuild, no image re-decode). */
function specCaptionsKey(spec: GpuRenderSpec): string {
  return JSON.stringify(spec.captions)
}

export function usePreviewCompositor(
  canvasRef: RefObject<HTMLCanvasElement>,
  spec: GpuRenderSpec | null,
  playheadSec: number
): { status: PreviewStatus; error: string; drawAt: (t: number) => void } {
  const runtimeRef = useRef<PreviewRuntime | null>(null)
  const rafRef = useRef<number | null>(null)
  const [status, setStatus] = useState<PreviewStatus>('idle')
  const [error, setError] = useState('')
  const [captionTick, setCaptionTick] = useState(0)

  const prevImagesKeyRef = useRef<string>('')
  const prevGradeKeyRef = useRef<string>('')
  const prevCaptionsKeyRef = useRef<string>('')

  // Full rebuild — only fires when the canvas dimensions change (or the spec/canvas
  // appears/disappears). Every other kind of edit is handled incrementally below.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !spec) {
      setStatus('idle')
      return
    }

    let runtime: PreviewRuntime | null = null
    try {
      canvas.width = spec.width
      canvas.height = spec.height
      const compositor = new Compositor(canvas, spec)
      const captions = new CaptionLayer(spec.captions, spec.width, spec.height)
      runtime = { compositor, captions, posterImages: [], bitmapCache: new Map() }
      runtimeRef.current = runtime
      // Force every incremental effect to re-populate the fresh runtime.
      prevImagesKeyRef.current = ''
      prevGradeKeyRef.current = ''
      prevCaptionsKeyRef.current = ''
      setStatus('loading')
      setError('')
    } catch (e) {
      runtimeRef.current = null
      setError((e as Error).message)
      setStatus('error')
    }

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      if (runtime && runtimeRef.current === runtime) {
        runtime.compositor.dispose()
        runtime.bitmapCache.forEach((bmp) => bmp.close())
        runtimeRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasRef, spec ? specDimsKey(spec) : ''])

  // Images/B-roll — reconcile the bitmap cache (load new paths, evict removed ones)
  // and re-upload only the resulting texture set. Unchanged images are never re-fetched.
  useEffect(() => {
    let cancelled = false
    const rt = runtimeRef.current
    if (!rt || !spec) return
    const key = specImagesKey(spec)
    if (key === prevImagesKeyRef.current) return
    prevImagesKeyRef.current = key
    void (async () => {
      try {
        const { spec: drawableSpec, images } = await specForPreview(spec)
        if (cancelled || runtimeRef.current !== rt) return
        const wanted = new Set(images.map((im) => im.path))
        for (const [path, bmp] of rt.bitmapCache) {
          if (!wanted.has(path)) {
            bmp.close()
            rt.bitmapCache.delete(path)
          }
        }
        for (const im of images) {
          if (!rt.bitmapCache.has(im.path)) {
            const bmp = await loadBitmap(im.path, spec.width, spec.height)
            if (cancelled || runtimeRef.current !== rt) {
              bmp.close()
              return
            }
            rt.bitmapCache.set(im.path, bmp)
          }
        }
        if (cancelled || runtimeRef.current !== rt) return
        const ordered = images
          .map((im) => rt.bitmapCache.get(im.path))
          .filter((b): b is ImageBitmap => !!b)
        rt.posterImages = spec.broll?.length ? images : []
        rt.compositor.updateSpec(drawableSpec)
        rt.compositor.setImages(ordered)
        setStatus('ready')
        setError('')
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message)
          setStatus('error')
        }
      }
    })()
    return () => { cancelled = true }
  }, [spec, canvasRef])

  // Keep the compositor's spec reference fresh (motion/grain/punch/per-image motion AND the
  // edge-gradient overlay are read directly off it every frame) and swap the LUT texture
  // when the grade changes.
  useEffect(() => {
    const rt = runtimeRef.current
    if (!rt || !spec) return
    rt.compositor.updateSpec(asPosterPreviewSpec(spec, rt.posterImages))
    const gradeKey = specGradeKey(spec)
    if (gradeKey !== prevGradeKeyRef.current) {
      prevGradeKeyRef.current = gradeKey
      rt.compositor.setLut(lutTextureById(spec.grade.lut))
    }
  }, [spec])

  // Captions — swap the model in place; no rebuild, no image re-decode. Fonts load
  // async, so nudge one extra repaint once they settle (otherwise the first paint of
  // a newly-selected preset can use the fallback font until the next scrub).
  useEffect(() => {
    const rt = runtimeRef.current
    if (!rt || !spec) return
    const key = specCaptionsKey(spec)
    if (key === prevCaptionsKeyRef.current) return
    prevCaptionsKeyRef.current = key
    rt.captions.setModel(spec.captions)
    setCaptionTick((t) => t + 1)
    void warmCaptionFonts(document, CAPTION_FONTS.map((f) => f.family)).then(() => {
      if (runtimeRef.current === rt) {
        rt.captions.setModel(spec.captions)
        setCaptionTick((t) => t + 1)
      }
    })
  }, [spec])

  // Imperative draw — lets a playback loop redraw the canvas every frame without
  // pushing React state (and re-rendering the surrounding UI) 60x/sec.
  const drawAt = useCallback((t: number) => {
    const rt = runtimeRef.current
    if (!rt || !spec) return
    const time = clampTime(t, spec.durationSec)
    if (rt.captions.draw(time)) rt.compositor.updateCaption(rt.captions.canvas)
    rt.compositor.drawFrame(time)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec])

  // Draw frame on playhead/caption/spec change (scrubbing, not playback — playback
  // uses drawAt directly).
  useEffect(() => {
    const rt = runtimeRef.current
    if (!rt || !spec) return
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const t = clampTime(playheadSec, spec.durationSec)
      if (rt.captions.draw(t)) rt.compositor.updateCaption(rt.captions.canvas)
      rt.compositor.drawFrame(t)
    })
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [playheadSec, spec, status, captionTick])

  return { status, error, drawAt }
}
