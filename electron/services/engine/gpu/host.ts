import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { GpuRenderSpec } from '../../../../shared/renderSpec'
import { resolveCaptionStyle } from '../../../../shared/captionStyle'
import { GPU_CHANNELS, type GpuDoneMsg, type GpuErrorMsg, type GpuProgressMsg, type GpuReadyMsg } from '../../../../shared/gpuIpc'
import { ffmpegPath } from '../../bin'
import { masterAudioTwoPass } from '../audio-master'
import { ffmpegErrorTail } from '../ffmpeg-error'
import { logger } from '../../logger'

// Main-process host for the hidden GPU render-worker window. Owns the worker lifecycle
// (lazy create, keep warm, destroy on quit), relays the spec, streams progress, and —
// once the worker has written the video-only H.264 mp4 — muxes the mastered audio in
// with a single ffmpeg stream-copy. Failures surface to the queue; CPU/fallback policy
// is decided there from the user's encoder + engine settings.

const log = logger.scope('gpu')

let worker: BrowserWindow | null = null
let workerReady: Promise<GpuReadyMsg> | null = null
let listenersBound = false
// Serialize GPU jobs: one worker window encodes one video at a time (consumer GPUs cap
// concurrent hardware encode sessions anyway).
let chain: Promise<unknown> = Promise.resolve()

interface PendingJob {
  resolve: () => void
  reject: (e: Error) => void
  onProgress?: (p: GpuProgressMsg) => void
}
const pending = new Map<string, PendingJob>()
let readyResolver: ((m: GpuReadyMsg) => void) | null = null

function workerHtmlPath(): string {
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (dev) return `${dev}/src/render-worker/index.html`
  return join(__dirname, '../renderer/src/render-worker/index.html')
}

function bindListenersOnce(): void {
  if (listenersBound) return
  listenersBound = true
  ipcMain.on(GPU_CHANNELS.ready, (_e, msg: GpuReadyMsg) => {
    readyResolver?.(msg)
    readyResolver = null
  })
  ipcMain.on(GPU_CHANNELS.progress, (_e, msg: GpuProgressMsg) => {
    pending.get(msg.jobId)?.onProgress?.(msg)
  })
  ipcMain.on(GPU_CHANNELS.done, (_e, msg: GpuDoneMsg) => {
    const job = pending.get(msg.jobId)
    if (!job) return
    pending.delete(msg.jobId)
    job.resolve()
  })
  ipcMain.on(GPU_CHANNELS.error, (_e, msg: GpuErrorMsg) => {
    const job = pending.get(msg.jobId)
    if (!job) return
    pending.delete(msg.jobId)
    job.reject(new Error(msg.message))
  })
}

const gpuDebug = !!process.env['ME_GPU_DEBUG']
const GPU_PROGRESS_TIMEOUT_MS = Math.max(5_000, Number(process.env['ME_GPU_PROGRESS_TIMEOUT_MS'] ?? 60_000) || 60_000)

/** Lazily create (or reuse) the hidden render-worker window. */
function ensureWorker(): Promise<GpuReadyMsg> {
  bindListenersOnce()
  if (worker && !worker.isDestroyed() && workerReady) return workerReady
  worker = new BrowserWindow({
    show: gpuDebug,
    width: gpuDebug ? 800 : 16,
    height: gpuDebug ? 600 : 16,
    webPreferences: {
      preload: join(__dirname, '../preload/preload-worker.cjs'),
      // Real GPU compositing (not the CPU OSR path); keep full speed while hidden.
      offscreen: false,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  // Forward worker console output to the main log so GPU errors + stack traces
  // are always captured, even when the window is hidden (§5 instrumentation).
  worker.webContents.on('console-message', (_event, level, message, _line, _source) => {
    const tag = level <= 0 ? 'debug' : level === 1 ? 'info' : level === 2 ? 'warn' : 'error'
    log.info(`[worker:${tag}] ${message}`)
  })
  if (gpuDebug) worker.webContents.openDevTools()
  worker.on('closed', () => {
    worker = null
    workerReady = null
  })
  workerReady = new Promise<GpuReadyMsg>((resolve) => {
    readyResolver = resolve
    // Safety timeout: if the probe never reports, assume unsupported so the queue
    // falls back instead of hanging.
    setTimeout(() => {
      if (readyResolver) {
        readyResolver({ hardware: false, supported: false, detail: 'probe timeout' })
        readyResolver = null
      }
    }, 8000)
  })
  void worker.loadURL(workerHtmlPath())
  return workerReady
}

/** Probe whether the GPU engine can run (hardware H.264 via WebCodecs). */
export async function probeGpuEngine(): Promise<GpuReadyMsg> {
  try {
    return await ensureWorker()
  } catch (e) {
    return { hardware: false, supported: false, detail: (e as Error).message }
  }
}

function ffmpegMux(spec: GpuRenderSpec, logPath?: string): Promise<void> {
  const args: string[] = ['-y', '-i', spec.out.h264Path, '-i', spec.audio.voicePath]
  const filter: string[] = []
  let aMap = '1:a'
  if (spec.audio.sfxPath && existsSync(spec.audio.sfxPath)) {
    args.push('-i', spec.audio.sfxPath)
    filter.push('[1:a][2:a]amix=inputs=2:normalize=0:duration=first[aout]')
    aMap = '[aout]'
  }
  args.push('-map', '0:v')
  if (filter.length) args.push('-filter_complex', filter.join(';'), '-map', aMap)
  else args.push('-map', aMap)
  args.push(
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-t', spec.durationSec > 0 ? spec.durationSec.toFixed(2) : '1',
    spec.out.finalPath
  )
  if (logPath) appendFileSync(logPath, `\n[gpu:mux]\n${[ffmpegPath(), ...args].join(' ')}\n`)
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { windowsHide: true })
    let err = ''
    child.stderr.on('data', (d: Buffer) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg mux exited ${code}: ${ffmpegErrorTail(err)}`))))
  })
}

export interface GpuRunOptions {
  onProgress?: (p: GpuProgressMsg) => void
  logPath?: string
  skipAudioMaster?: boolean
}

/**
 * Run a full GPU render: worker composes + hardware-encodes the video, host muxes the
 * mastered audio in. Rejects on any failure so the queue can decide whether fallback is allowed.
 */
export function runGpuRender(spec: GpuRenderSpec, opts: GpuRunOptions = {}): Promise<void> {
  // Serialize so concurrent queue jobs share the single worker window safely.
  const task = chain.then(() => runGpuRenderInner(spec, opts))
  chain = task.catch(() => undefined)
  return task
}

async function runGpuRenderInner(spec: GpuRenderSpec, opts: GpuRunOptions): Promise<void> {
  const ready = await ensureWorker()
  if (!ready.supported) throw new Error(`GPU engine unsupported: ${ready.detail ?? 'no WebCodecs encoder'}`)
  if (!worker || worker.isDestroyed()) throw new Error('GPU worker window unavailable')

  const electronVer = app.getVersion()
  const chromeVer = process.versions['chrome'] ?? 'unknown'
  if (opts.logPath) appendFileSync(opts.logPath, `\n[gpu] engine=webcodecs hardware=${ready.hardware} ${spec.width}x${spec.height}@${spec.fps} frames~${Math.round(spec.durationSec * spec.fps)} electron=${electronVer} chrome=${chromeVer} muxer=streaming\n`)

  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null
    let settled = false
    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
    }
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      cleanup()
      pending.delete(spec.jobId)
      if (opts.logPath) appendFileSync(opts.logPath, `[gpu:timeout] ${message}\n`)
      // A timed-out worker may still be stuck in WebCodecs. Destroy it so the ffmpeg
      // fallback can proceed and future jobs start from a clean worker window.
      try { worker?.destroy() } catch { /* ignore */ }
      worker = null
      workerReady = null
      reject(new Error(message))
    }
    const resetTimer = (): void => {
      cleanup()
      timer = setTimeout(() => fail(`GPU worker made no progress for ${Math.round(GPU_PROGRESS_TIMEOUT_MS / 1000)}s`), GPU_PROGRESS_TIMEOUT_MS)
    }
    pending.set(spec.jobId, {
      resolve: () => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      },
      reject: (e) => {
        if (settled) return
        settled = true
        cleanup()
        reject(e)
      },
      onProgress: (p) => {
        resetTimer()
        opts.onProgress?.(p)
      }
    })
    resetTimer()
    worker!.webContents.send(GPU_CHANNELS.run, spec)
  })

  if (!existsSync(spec.out.h264Path)) throw new Error('GPU worker reported done but no H.264 output found')

  // ffmpeg's remaining role: stream-copy mux video + AAC audio, then loudness master.
  await ffmpegMux(spec, opts.logPath)
  if (!opts.skipAudioMaster) {
    try {
      await masterAudioTwoPass(spec.out.finalPath)
    } catch (e) {
      log.warn(`audio-master failed (kept GPU mp4): ${(e as Error).message}`)
      if (opts.logPath) appendFileSync(opts.logPath, `[gpu:audio-master:warn] ${(e as Error).message}\n`)
    }
  }
}

/** Tear down the worker window (called on app quit / idle). */
export function destroyGpuWorker(): void {
  if (worker && !worker.isDestroyed()) worker.destroy()
  worker = null
  workerReady = null
  for (const [, job] of pending) job.reject(new Error('GPU worker destroyed'))
  pending.clear()
}

/** Run the GPU worker self-test: encode ~100 solid frames through the streaming muxer to verify capabilities and pipeline integrity. */
export async function runGpuSelfTest(): Promise<{ ok: boolean; error?: string; timeMs?: number }> {
  try {
    const ready = await ensureWorker()
    if (!ready.supported) {
      return { ok: false, error: `GPU engine unsupported: ${ready.detail ?? 'no WebCodecs encoder'}` }
    }
    const tempDir = app.getPath('temp')
    const h264Path = join(tempDir, 'me-gpu-selftest.h264.mp4')
    const finalPath = join(tempDir, 'me-gpu-selftest.mp4')
    const spec: GpuRenderSpec = {
      jobId: 'selftest',
      width: 640,
      height: 360,
      fps: 24,
      durationSec: 4.2, // ~100 frames
      images: [],
      motion: { kenBurns: false, punchAtSec: [] },
      grade: {
        style: 'None',
        saturation: 1,
        contrast: 1,
        brightness: 0,
        colorBalance: { r: 0, g: 0, b: 0 },
        vignette: 0,
        sharpen: 0
      },
      grain: { strength: 0, temporal: false },
      captions: {
        groups: [],
        style: resolveCaptionStyle({ captionPreset: 'Minimal' }),
        preset: 'Clean',
        font: 'Anton',
        animation: 'Pop-in',
        mode: 'word',
        position: 'bottom',
        lines: 1,
        highlightColor: '#ffffff'
      },
      audio: { voicePath: '' },
      encoder: { codec: 'avc', bitrateMbps: 2, keyIntervalSec: 2 },
      out: { h264Path, finalPath }
    }

    const start = Date.now()
    await new Promise<void>((resolve, reject) => {
      pending.set(spec.jobId, { resolve, reject })
      worker!.webContents.send(GPU_CHANNELS.run, spec)
    })
    const duration = Date.now() - start
    return { ok: true, timeMs: duration }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

