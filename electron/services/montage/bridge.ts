import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppSettings, MontageCapabilities, MontageFootageClip, MontageFootageRequest, MontageProduceResult } from '../../../shared/types'
import { getSettings } from '../../store/settings'
import { logger } from '../logger'
import { sentryLog } from '../sentry'

// Bridge to the external OpenMontage app. MES ships only the Python invoker shim
// (resources/montage/mes_bridge.py); OpenMontage itself is a user-local dependency pointed to by
// settings.montage.openMontageRoot. We spawn the shim, stream its NDJSON protocol, and map events
// back to the renderer. This mirrors the yt-dlp/ffmpeg subprocess conventions in bin.ts / downloader.ts.

const LOG = logger.scope('montage')

const STALL_MS = 5 * 60_000 // kill if no stdout/stderr for 5 min
const HARD_MS = 60 * 60_000 // absolute ceiling: 1 hour

export interface BridgeEvent {
  event: string
  [k: string]: unknown
}

export interface BridgeResult {
  ok: boolean
  data: Record<string, unknown>
  error?: string
}

interface RunOpts {
  /** stable id (usually projectId) so the run can be cancelled */
  id?: string
  onEvent?: (e: BridgeEvent) => void
}

// Cancellation, mirroring downloader.ts: a killed child is reported as 'cancelled', not a failure.
const running = new Map<string, ChildProcess>()
const cancelIntents = new Set<string>()

export function cancelMontage(id: string): void {
  cancelIntents.add(id)
  const child = running.get(id)
  if (child) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

// ---- path / interpreter / env resolution (packaged-first, like bin.ts) ----

/** Absolute path of the bundled Python invoker shim. */
export function shimPath(): string {
  const override = process.env['ME_MONTAGE_SHIM']
  if (override) return override
  const rel = join('montage', 'mes_bridge.py')
  const packaged = process.resourcesPath ? join(process.resourcesPath, rel) : ''
  if (packaged && existsSync(packaged)) return packaged
  return join(process.cwd(), 'resources', rel)
}

export function resolveOmRoot(s: AppSettings): string {
  return (process.env['ME_MONTAGE_OM_ROOT'] || s.montage?.openMontageRoot || '').trim()
}

/** Python interpreter: explicit setting/env → OpenMontage venv → PATH. */
export function resolvePython(s: AppSettings, omRoot: string): string {
  const explicit = (process.env['ME_MONTAGE_PYTHON'] || s.montage?.pythonPath || '').trim()
  if (explicit) return explicit
  if (omRoot) {
    const venv = process.platform === 'win32'
      ? join(omRoot, '.venv', 'Scripts', 'python.exe')
      : join(omRoot, '.venv', 'bin', 'python')
    if (existsSync(venv)) return venv
  }
  return process.platform === 'win32' ? 'python' : 'python3'
}

/** API keys handed to the subprocess via env. OpenMontage's _load_dotenv only fills keys that are
 *  NOT already set, so env always wins — we never write a plaintext .env. pexels/pixabay reuse the
 *  existing beta.* keys. */
function providerEnv(s: AppSettings): Record<string, string> {
  const e: Record<string, string> = {}
  const put = (k: string, v?: string): void => {
    if (v && v.trim()) e[k] = v.trim()
  }
  put('PEXELS_API_KEY', s.beta?.pexelsKey)
  put('PIXABAY_API_KEY', s.beta?.pixabayKey)
  put('UNSPLASH_ACCESS_KEY', s.montage?.unsplashKey)
  put('FAL_KEY', s.montage?.falKey)
  put('FAL_AI_API_KEY', s.montage?.falKey)
  put('ELEVENLABS_API_KEY', s.montage?.elevenLabsKey)
  put('OPENAI_API_KEY', s.montage?.openaiKey)
  put('GOOGLE_API_KEY', s.montage?.googleKey)
  put('GEMINI_API_KEY', s.montage?.googleKey)
  return e
}

function writeTempJson(prefix: string, obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'me-montage-'))
  const f = join(dir, `${prefix}.json`)
  writeFileSync(f, JSON.stringify(obj), 'utf-8')
  return f
}

// ---- fixture seam (ME_MONTAGE_FIXTURE) so smokes/worktrees run without real OpenMontage ----

function replayFixture(dir: string, command: string, opts: RunOpts): BridgeResult {
  const file = join(dir, `${command}.ndjson`)
  if (!existsSync(file)) return { ok: false, data: {}, error: `montage fixture missing: ${file}` }
  let last: BridgeResult = { ok: false, data: {}, error: 'fixture had no result line' }
  for (const raw of readFileSync(file, 'utf-8').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let obj: BridgeEvent
    try {
      obj = JSON.parse(line) as BridgeEvent
    } catch {
      continue
    }
    if (obj.event === 'result') {
      last = { ok: !!obj.ok, data: (obj.data as Record<string, unknown>) || {}, error: (obj.error as string) ?? undefined }
    } else {
      opts.onEvent?.(obj)
    }
  }
  return last
}

// ---- core runner ----

function runShim(command: string, args: string[], opts: RunOpts = {}): Promise<BridgeResult> {
  const fixture = process.env['ME_MONTAGE_FIXTURE']
  if (fixture) return Promise.resolve(replayFixture(fixture, command, opts))

  const s = getSettings()
  const omRoot = resolveOmRoot(s)
  const py = resolvePython(s, omRoot)
  const shim = shimPath()
  const fullArgs = [shim, command, '--om-root', omRoot, ...args]

  return new Promise<BridgeResult>((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(py, fullArgs, {
        windowsHide: true,
        env: { ...process.env, ...providerEnv(s), PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
      })
    } catch (e) {
      resolve({ ok: false, data: {}, error: `failed to spawn python (${py}): ${(e as Error).message}` })
      return
    }

    const id = opts.id
    if (id) running.set(id, child)

    let buf = ''
    let stderr = ''
    let last: BridgeResult | null = null
    let lastActivity = Date.now()
    const startedAt = Date.now()

    const watchdog = setInterval(() => {
      const now = Date.now()
      if (now - lastActivity > STALL_MS || now - startedAt > HARD_MS) {
        LOG.warn(`montage ${command} watchdog kill (idle=${now - lastActivity}ms total=${now - startedAt}ms)`)
        try {
          child.kill('SIGKILL')
        } catch {
          /* gone */
        }
      }
    }, 15_000)

    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', (d: string) => {
      lastActivity = Date.now()
      buf += d
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        let obj: BridgeEvent
        try {
          obj = JSON.parse(line) as BridgeEvent
        } catch {
          continue // non-JSON diagnostic line; ignore
        }
        if (obj.event === 'result') {
          last = { ok: !!obj.ok, data: (obj.data as Record<string, unknown>) || {}, error: (obj.error as string) ?? undefined }
        } else {
          opts.onEvent?.(obj)
        }
      }
    })

    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (d: string) => {
      lastActivity = Date.now()
      stderr += d
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })

    child.on('error', (e) => {
      clearInterval(watchdog)
      if (id) running.delete(id)
      resolve({ ok: false, data: {}, error: `python spawn error (${py}): ${e.message}` })
    })

    child.on('close', (code) => {
      clearInterval(watchdog)
      const wasCancelled = id ? cancelIntents.has(id) : false
      if (id) {
        running.delete(id)
        cancelIntents.delete(id)
      }
      if (wasCancelled) {
        resolve({ ok: false, data: {}, error: 'cancelled' })
        return
      }
      if (last) {
        resolve(last)
        return
      }
      resolve({
        ok: false,
        data: {},
        error: `bridge exited ${code} without a result line${stderr ? `: ${stderr.slice(-500)}` : ''}`
      })
    })
  })
}

// ---- public API ----

function emptyCaps(partial: Partial<MontageCapabilities>): MontageCapabilities {
  return {
    available: false,
    renderEngines: { ffmpeg: false, remotion: false, hyperframes: false },
    capabilities: [],
    setupOffers: [],
    runtimeWarnings: [],
    ...partial
  }
}

/** Probe the external OpenMontage install: provider menu + composition runtimes. */
export async function detectCapabilities(): Promise<MontageCapabilities> {
  const s = getSettings()
  if (!s.montage?.enabled) return emptyCaps({ error: 'OpenMontage bridge is disabled in Settings' })
  const omRoot = resolveOmRoot(s)
  if (!omRoot) return emptyCaps({ error: 'OpenMontage root is not configured (Settings → OpenMontage)' })

  const res = await runShim('capabilities', [])
  if (!res.ok) {
    sentryLog.warn('montage capabilities probe failed', { om_root_set: !!omRoot, error: res.error ?? '' })
    return emptyCaps({ omRoot, pythonPath: resolvePython(s, omRoot), error: res.error })
  }
  const d = res.data as Record<string, any>
  const summary = (d.summary as Record<string, any>) || {}
  const re = (d.render_engines as Record<string, any>) || {}
  const caps: MontageCapabilities = {
    available: true,
    omRoot: (d.om_root as string) || omRoot,
    pythonPath: resolvePython(s, omRoot),
    python: d.python as string | undefined,
    renderEngines: { ffmpeg: !!re.ffmpeg, remotion: !!re.remotion, hyperframes: !!re.hyperframes },
    capabilities: ((summary.capabilities as any[]) || []).map((c) => ({
      capability: String(c.capability ?? ''),
      configured: Number(c.configured ?? 0),
      total: Number(c.total ?? 0),
      availableProviders: (c.available_providers as string[]) || [],
      unavailableProviders: (c.unavailable_providers as string[]) || []
    })),
    setupOffers: ((summary.setup_offers as any[]) || []).map((o) => ({
      capability: String(o.capability ?? ''),
      tool: String(o.tool ?? ''),
      provider: o.provider as string | undefined,
      envVars: (o.env_vars as string[]) || [],
      installInstructions: o.install_instructions as string | undefined
    })),
    runtimeWarnings: (summary.runtime_warnings as string[]) || []
  }
  sentryLog.info('montage capabilities probed', {
    python: caps.python ?? '',
    remotion: caps.renderEngines.remotion,
    hyperframes: caps.renderEngines.hyperframes,
    warnings: caps.runtimeWarnings.length
  })
  return caps
}

/** Retrieve footage/stock clips via OpenMontage DirectClipSearch. */
export async function retrieveFootage(req: MontageFootageRequest): Promise<MontageFootageClip[]> {
  const inputs: Record<string, unknown> = {
    output_dir: req.outputDir,
    queries: req.queries.map((q) => ({ query: q.query, slot_id: q.slotId, kind: q.kind || 'video' }))
  }
  if (req.sources) inputs.sources = req.sources
  if (req.clipsPerQuery) inputs.clips_per_query = req.clipsPerQuery
  if (req.filters) {
    inputs.filters = {
      min_duration: req.filters.minDuration,
      max_duration: req.filters.maxDuration,
      orientation: req.filters.orientation,
      min_width: req.filters.minWidth
    }
  }
  const file = writeTempJson('inputs', inputs)
  const res = await runShim('run-tool', ['--name', 'direct_clip_search', '--inputs-file', file])
  if (!res.ok) throw new Error(res.error || 'footage retrieval failed')
  const clips = ((res.data as Record<string, any>).clips as any[]) || []
  return clips.map((c) => ({
    clipId: String(c.clip_id ?? ''),
    source: String(c.source ?? ''),
    kind: String(c.kind ?? 'video'),
    path: String(c.path ?? ''),
    thumbnail: c.thumbnail as string | undefined,
    duration: c.duration as number | undefined,
    width: c.width as number | undefined,
    height: c.height as number | undefined,
    license: c.license as string | undefined,
    sourceUrl: c.source_url as string | undefined,
    query: c.query as string | undefined,
    slotId: c.slot_id as string | undefined
  }))
}

/** Run a produce() orchestration with a pre-built OpenMontage brief. */
export async function produceFromBrief(
  id: string,
  brief: Record<string, unknown>,
  onEvent?: (e: BridgeEvent) => void
): Promise<MontageProduceResult> {
  const file = writeTempJson('brief', brief)
  sentryLog.info('montage produce start', { project_id: id, runtime: String((brief.compose as any)?.render_runtime ?? '') })
  const res = await runShim('produce', ['--brief-file', file], { id, onEvent })
  const out = (res.data as Record<string, any>).output as string | undefined
  sentryLog.info('montage produce finish', { project_id: id, ok: res.ok, has_output: !!out, error: res.error ?? '' })
  return { ok: res.ok, output: out, data: res.data, error: res.error }
}
