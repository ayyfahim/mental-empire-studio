import '@fontsource/anton'
import '@fontsource/hanken-grotesk'
import '../styles/caption-fonts.css'
import type { GpuRenderSpec } from '@shared/renderSpec'
import { totalFrames } from '@shared/renderSpec'
import { CAPTION_FONTS } from '@shared/captionStyle'
import { encodeSpec, probeHardwareEncode } from './encoder'
import { warmCaptionFonts } from './captions'
import { SegmentDecoder } from './decoder'

// Entry for the hidden render-worker page. It waits for a spec from the host, loads the
// input images/overlay/B-roll segments from disk (via the worker preload's fs bridge),
// runs the GPU compose + WebCodecs encode, and streams the muxed video-only MP4 to disk
// incrementally. Reports completion so the host can mux audio.

const worker = window.gpuWorker

async function loadBitmap(path: string): Promise<ImageBitmap> {
  const bytes = worker!.readFile(path)
  const blob = new Blob([bytes])
  return createImageBitmap(blob)
}

async function run(spec: GpuRenderSpec): Promise<void> {
  let fd: number | null = null
  const decoders: (SegmentDecoder | null)[] = []
  try {
    const isSelfTest = spec.jobId === 'selftest'
    console.log(`[worker] run start: job=${spec.jobId} isSelfTest=${isSelfTest} imageCount=${spec.images.length} brollCount=${spec.broll?.length ?? 0} durationSec=${spec.durationSec}`)
    // Block until the bundled caption fonts are usable — a canvas draw with an
    // unloaded font silently falls back and bakes the wrong glyphs into the video.
    await warmCaptionFonts(document, CAPTION_FONTS.map((f) => f.family))
    let images: ImageBitmap[] = []

    if (!isSelfTest) {
      // Load slideshow stills.
      images = await Promise.all(spec.images.map((im) => loadBitmap(im.path)))
      console.log(`[worker] loaded ${images.length} slides`)
    }

    // Initialize placeholders for B-roll decoders to be lazy-loaded in the encode loop
    if (spec.broll && spec.broll.length > 0) {
      console.log(`[worker] preparing lazy placeholders for ${spec.broll.length} B-roll clips`)
      for (let i = 0; i < spec.broll.length; i++) {
        decoders.push(null)
      }
    }

    // Open the output file for streaming writes.
    console.log(`[worker] opening output file: ${spec.out.h264Path}`)
    fd = worker!.openFile(spec.out.h264Path)
    const handle = {
      write: (data: Uint8Array, position: number): void => {
        worker!.writeChunk(fd!, data, position)
      }
    }

    console.log(`[worker] starting frame loop with encodeSpec`)
    await encodeSpec(spec, images, decoders, handle, {
      onProgress: (framesDone, frames) => {
        console.log(`[worker] encode progress: ${framesDone}/${frames} frames`)
        worker!.progress({ jobId: spec.jobId, framesDone, totalFrames: frames, fps: spec.fps })
      }
    })

    console.log(`[worker] closing output file and finalizing B-roll decoders`)
    worker!.closeFile(fd)
    fd = null
    decoders.forEach((dec) => dec?.close())
    worker!.done({ jobId: spec.jobId, h264Path: spec.out.h264Path })
    console.log(`[worker] job completed successfully`)

    images.forEach((b) => b.close())
  } catch (e) {
    console.error(`[worker] FATAL ERROR in render run:`, e)
    // Close the file handle on error so we don't leak it.
    if (fd != null) {
      try { worker!.closeFile(fd) } catch { /* ignore close-on-error */ }
    }
    decoders.forEach((dec) => {
      try { dec?.close() } catch { /* ignore close-on-error */ }
    })
    worker!.error({ jobId: spec.jobId, message: (e as Error).message })
  }
}

async function boot(): Promise<void> {
  if (!worker) return
  // Probe once at startup and report so the host can decide auto vs ffmpeg.
  const probe = await probeHardwareEncode(1920, 1080, 24)
  worker.ready({ hardware: probe.hardware, supported: probe.supported, detail: probe.detail })
  worker.onRun((spec) => {
    // Touch totalFrames so the import is always exercised (and to validate the spec).
    if (totalFrames(spec) < 1) {
      worker.error({ jobId: spec.jobId, message: 'invalid spec: zero frames' })
      return
    }
    void run(spec)
  })
}

void boot()

