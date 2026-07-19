import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { AppSettings, BrollDensity, TranscriptWord, VideoStyle, Niche, NichePoolHealth } from '../../shared/types'
import { videoCodecArgs } from './render'
import { ffmpegPath, ffprobePath } from './bin'
import type { RenderCapabilities } from '../../shared/types'
import { FALLBACK_CAPS } from './engine/encoder'
import { createProgressSmoother, parseFfmpegProgressBlock, type FfmpegProgress } from './engine/progress'
import { ffmpegErrorTail } from './engine/ffmpeg-error'
import { logger } from './logger'
import { cacheDir } from './storage'
import { poolKeyForNiche, nicheSearchThemes, dimsForOrientation, planPoolPrune } from './niche'
import { seededBrollOrder } from '../../shared/automationBroll'

// Auto B-roll: themed stock-footage pool driven by the transcript. We pick the
// video's dominant themes, fetch a small pool of clips (Pexels → Pixabay → Coverr),
// download them (with per-clip fallback), plan full-duration coverage (trim long
// clips, chain short ones — never a blank), and assemble a single bed.mp4 that the
// renderer treats as one video input. Network is isolated here; the pure planning
// (themes / ranking / coverage) runs offline and is unit-asserted.

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'is', 'are', 'was', 'it', 'you', 'your', 'i', 'we', 'they', 'he', 'she', 'for', 'with', 'as', 'at', 'by', 'be', 'this', 'that', 'have', 'has', 'will', 'would', 'can', 'just', 'not', 'so', 'do', 'if', 'how', 'what', 'when', 'all', 'one', 'about', 'from', 'they', 'their', 'them'])
const DEFAULT_MAX_SEGMENTS = 40
const BROLL_LOG = logger.scope('broll')
type ProviderName = BrollCandidate['provider']

function appendJobLog(logPath: string | undefined, line: string): void {
  if (!logPath) return
  try {
    appendFileSync(logPath, `[broll] ${line}\n`)
  } catch (e) {
    BROLL_LOG.warn(`job log append failed path=${logPath}: ${(e as Error).message}`)
  }
}

function brollInfo(logPath: string | undefined, line: string): void {
  BROLL_LOG.info(line)
  appendJobLog(logPath, line)
}

function brollWarn(logPath: string | undefined, line: string): void {
  BROLL_LOG.warn(line)
  appendJobLog(logPath, `WARN ${line}`)
}

class BrollRateLimitError extends Error {
  constructor(
    readonly provider: ProviderName,
    readonly status: number,
    url: string
  ) {
    super(`${provider} stock provider rate-limited or quota-blocked (HTTP ${status}): ${redactUrl(url)}`)
    this.name = 'BrollRateLimitError'
  }
}

export interface BrollCandidate {
  provider: 'pexels' | 'pixabay' | 'coverr'
  id: string
  url: string
  width: number
  height: number
  durationSec: number
  tags: string[]
}
export interface BrollClip extends BrollCandidate {
  path: string
}
export interface BrollSegment {
  path: string
  start: number
  end: number
  srcStart: number
}
export interface BrollManifestSegment extends BrollSegment {
  normalizedPath: string
  style?: VideoStyle
}

export interface BrollPlanResult {
  clips: BrollClip[]
  segments: BrollSegment[]
}
export interface BrollManifestResult {
  clips: BrollClip[]
  segments: BrollManifestSegment[]
  manifestPath: string
  jsonPath: string
}

interface BrollLibraryClip {
  provider: ProviderName
  id: string
  path: string
  durationSec: number
  width: number
  height: number
  tags: string[]
  /** when this clip was first cached into a pool (P4 pruning) */
  addedAt?: string
  /** when this clip was last used in a render (P4 usage tracking + prune) */
  lastUsedAt?: string
}

export interface BrollLibraryIndex {
  version: 1
  sourceKey: string
  createdAt: string
  updatedAt: string
  /** last time the pool was warmed/topped-up (drives periodic refresh, P4) */
  lastWarmedAt?: string
  keywords: Array<{
    keyword: string
    clips: BrollLibraryClip[]
  }>
}

export interface BrollLibraryWarmResult {
  indexPath: string
  sourceKey: string
  keywords: string[]
  clips: number
}

// ---------- pure core (offline, unit-tested) ----------

/** Top recurring content words across the transcript — the video's themes. */
export function extractThemes(words: TranscriptWord[], n = 4): string[] {
  const freq = new Map<string, number>()
  for (const w of words) {
    const norm = w.word.toLowerCase().replace(/[^a-z]/g, '')
    if (norm.length < 4 || STOPWORDS.has(norm)) continue
    freq.set(norm, (freq.get(norm) ?? 0) + 1 + (w.emphasis ? 2 : 0))
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map((e) => e[0])
}

/** Source-channel titles → stock-footage search themes. Used for background library warming. */
export function keywordThemesFromTitles(titles: string[], n = 12): string[] {
  const freq = new Map<string, number>()
  const add = (theme: string, weight: number): void => {
    const key = theme.toLowerCase().trim()
    if (!key) return
    freq.set(key, (freq.get(key) ?? 0) + weight)
  }
  for (const title of titles) {
    const lower = title.toLowerCase()
    if (/narciss|gaslight|toxic|abuse|manipulat/.test(lower)) {
      add('toxic relationship', 8)
      add('emotional abuse', 6)
      add('therapy session', 4)
    }
    if (/no contact|break.?up|relationship|ex\b|avoidant|attachment/.test(lower)) {
      add('lonely person', 7)
      add('relationship conflict', 6)
      add('person thinking', 5)
    }
    if (/discipline|motivat|success|mindset|focus|productive|habit/.test(lower)) {
      add('focused work', 7)
      add('success mindset', 6)
      add('city ambition', 4)
    }
    if (/anxiety|depress|trauma|healing|mental|stress|overthink/.test(lower)) {
      add('mental health', 7)
      add('calm nature', 4)
      add('person thinking', 4)
    }
    if (/money|business|wealth|rich|finance|entrepreneur/.test(lower)) {
      add('business success', 7)
      add('office work', 5)
    }
    if (/sleep|peace|meditat|calm|relax/.test(lower)) {
      add('peaceful nature', 7)
      add('night city', 3)
    }

    for (const raw of lower.split(/[^a-z]+/)) {
      const word = raw.replace(/[^a-z]/g, '')
      if (word.length < 4 || STOPWORDS.has(word)) continue
      add(word, 1)
    }
  }
  const ranked = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([theme]) => theme)
  return ranked.slice(0, Math.max(1, n))
}

/** Rank candidates for a keyword + target frame: tag match, orientation, resolution, duration. */
export function rankCandidates(cands: BrollCandidate[], keyword: string, target: { w: number; h: number }): BrollCandidate[] {
  const landscape = target.w >= target.h
  const score = (c: BrollCandidate): number => {
    let s = 0
    if (c.tags.some((t) => t.includes(keyword) || keyword.includes(t))) s += 5
    if ((c.width >= c.height) === landscape) s += 3
    if (c.width >= target.w && c.height >= target.h) s += 2
    if (c.durationSec >= 4) s += 1
    if (c.provider === 'pexels') s += 0.3
    else if (c.provider === 'pixabay') s += 0.2
    return s
  }
  return [...cands].sort((a, b) => score(b) - score(a))
}

/** Density → target slot length (seconds). Fewer/longer slots = calmer edit. */
function slotLenFor(density: BrollDensity): number {
  return density === 'full' ? 5 : density === 'sparse' ? 9 : 12
}

/**
 * Plan B-roll segments covering [0, durationSec] with no gaps: trim clips longer
 * than a slot, chain shorter clips, and loop/rotate the pool. Pure + deterministic.
 */
export function planCoverage(
  durationSec: number,
  clips: Array<{ path: string; durationSec: number }>,
  opts: { density: BrollDensity; maxSegments?: number; tailReserve?: number }
): BrollSegment[] {
  if (clips.length === 0 || durationSec <= 0) return []
  const maxSeg = Math.max(1, opts.maxSegments ?? DEFAULT_MAX_SEGMENTS)
  const slot = Math.max(durationSec / maxSeg, slotLenFor(opts.density))
  // When the bed will crossfade, reserve a little tail of each clip so there is
  // overlap material for the xfade (else the cut has nothing to fade into).
  const reserve = opts.tailReserve ?? 0
  const segments: BrollSegment[] = []
  let t = 0
  let i = 0
  while (t < durationSec - 0.05) {
    const clip = clips[i % clips.length]
    const remaining = durationSec - t
    const want = Math.min(slot, remaining)
    // Keep the segment count bounded even when stock clips are short. Render inputs
    // loop clips under -t, so a 9s clip can safely fill a calmer 25s slot.
    const usable = Math.max(0.5, clip.durationSec - reserve)
    const segLen = Math.max(0.5, want)
    // Rotate the in-point so re-used clips don't always show the same opening frames.
    const srcStart = usable > 0.5 ? (i * 1.7) % usable : 0
    segments.push({ path: clip.path, start: t, end: t + segLen, srcStart })
    t += segLen
    i++
  }
  return segments
}

// ---------- provider clients (network) ----------

async function getJson(provider: ProviderName, query: string, url: string, headers: Record<string, string> = {}, logPath?: string): Promise<unknown> {
  const started = Date.now()
  const safeUrl = redactUrl(url)
  brollInfo(logPath, `provider request provider=${provider} query=${JSON.stringify(query)} url=${safeUrl}`)
  let res: Response
  try {
    res = await fetch(url, { headers })
  } catch (e) {
    brollWarn(logPath, `provider request failed provider=${provider} query=${JSON.stringify(query)} ms=${Date.now() - started} error=${(e as Error).message}`)
    throw e
  }
  const ms = Date.now() - started
  brollInfo(logPath, `provider response provider=${provider} query=${JSON.stringify(query)} status=${res.status} ms=${ms} url=${safeUrl}`)
  if (!res.ok) {
    if (isRateLimitStatus(res.status)) throw new BrollRateLimitError(provider, res.status, url)
    throw new Error(`${safeUrl} -> HTTP ${res.status}`)
  }
  return res.json()
}

function redactUrl(url: string): string {
  return url
    .replace(/([?&]key=)[^&]+/gi, '$1[redacted]')
    .replace(/([?&]api_key=)[^&]+/gi, '$1[redacted]')
    .replace(/([?&]token=)[^&]+/gi, '$1[redacted]')
}

function isRateLimitStatus(status: number): boolean {
  return status === 402 || status === 403 || status === 429
}

function isRateLimitError(e: unknown): e is BrollRateLimitError {
  return e instanceof BrollRateLimitError || /rate.?limit|quota|HTTP (402|403|429)/i.test((e as Error).message ?? '')
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

async function searchPexels(key: string, q: string, target: { w: number; h: number }, logPath?: string): Promise<BrollCandidate[]> {
  const orientation = target.w >= target.h ? 'landscape' : 'portrait'
  const data = (await getJson(
    'pexels',
    q,
    `https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&orientation=${orientation}&size=medium&per_page=10`,
    { Authorization: key },
    logPath
  )) as { videos?: Array<{ id: number; duration: number; video_files: Array<{ link: string; width: number; height: number; quality: string }> }> }
  const out = (data.videos ?? []).map((v) => {
    const best = [...v.video_files].sort((a, b) => b.width - a.width).find((f) => f.width <= target.w * 1.5) ?? v.video_files[0]
    return { provider: 'pexels' as const, id: String(v.id), url: best?.link ?? '', width: best?.width ?? 0, height: best?.height ?? 0, durationSec: v.duration ?? 0, tags: q.split(/\s+/) }
  }).filter((c) => c.url)
  brollInfo(logPath, `provider result provider=pexels query=${JSON.stringify(q)} count=${out.length}`)
  return out
}

async function searchPixabay(key: string, q: string, logPath?: string): Promise<BrollCandidate[]> {
  const data = (await getJson(
    'pixabay',
    q,
    `https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(q)}&video_type=film&per_page=10`,
    {},
    logPath
  )) as { hits?: Array<{ id: number; duration: number; tags: string; videos: Record<string, { url: string; width: number; height: number }> }> }
  const out = (data.hits ?? []).map((h) => {
    const v = h.videos.large ?? h.videos.medium ?? h.videos.small ?? h.videos.tiny
    return { provider: 'pixabay' as const, id: String(h.id), url: v?.url ?? '', width: v?.width ?? 0, height: v?.height ?? 0, durationSec: h.duration ?? 0, tags: (h.tags ?? '').split(',').map((t) => t.trim().toLowerCase()) }
  }).filter((c) => c.url)
  brollInfo(logPath, `provider result provider=pixabay query=${JSON.stringify(q)} count=${out.length}`)
  return out
}

async function searchCoverr(key: string, q: string, logPath?: string): Promise<BrollCandidate[]> {
  const data = (await getJson(
    'coverr',
    q,
    `https://api.coverr.co/videos?query=${encodeURIComponent(q)}&urls=true&page_size=10`,
    { Authorization: key },
    logPath
  )) as { hits?: Array<{ id: string; duration?: number; tags?: string[]; urls?: { mp4_download?: string; mp4?: string } }> }
  const out = (data.hits ?? []).map((h) => ({
    provider: 'coverr' as const, id: h.id, url: h.urls?.mp4_download ?? h.urls?.mp4 ?? '', width: 1920, height: 1080, durationSec: h.duration ?? 0, tags: h.tags ?? []
  })).filter((c) => c.url)
  brollInfo(logPath, `provider result provider=coverr query=${JSON.stringify(q)} count=${out.length}`)
  return out
}

/** Probe a clip's duration (seconds) via ffprobe; 0 on failure. */
function probeDurationSec(path: string): number {
  try {
    const r = spawnSync(ffprobePath(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { encoding: 'utf8' })
    return parseFloat((r.stdout || '').trim()) || 0
  } catch {
    return 0
  }
}

/** Offline seam: build candidates from REAL local .mp4 clips in ME_BROLL_LOCAL. Unlike
 *  ME_BROLL_FIXTURE (which stubs the bed), these flow through the genuine assembleBed
 *  ffmpeg path, so a true b-roll render can be produced without any network. */
function localCandidates(themes: string[], target: { w: number; h: number }): BrollCandidate[] {
  const dir = process.env['ME_BROLL_LOCAL'] as string
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp4'))
  return files.map((f) => {
    const path = join(dir, f)
    return {
      provider: 'pexels' as const,
      id: f.replace(/\.mp4$/i, ''),
      url: path, // carry the real path; downloadPool resolves it directly
      width: target.w,
      height: target.h,
      durationSec: probeDurationSec(path),
      tags: themes.length ? themes : ['cinematic']
    }
  })
}

/** Fetch a ranked candidate pool across the local library + providers in priority order until poolSize. */
export async function fetchPool(
  settings: AppSettings,
  themes: string[],
  target: { w: number; h: number },
  poolSize: number,
  logPath?: string,
  opts: { skipLibrary?: boolean; poolKey?: string; allowLive?: boolean; seed?: number; shuffle?: boolean } = {}
): Promise<BrollCandidate[]> {
  brollInfo(logPath, `themes selected=${themes.join(',') || 'cinematic background'} target=${target.w}x${target.h} requested=${poolSize}`)
  // Local real-clip seam (genuine assembly, offline).
  if (process.env['ME_BROLL_LOCAL']) {
    const localPool = localCandidates(themes, target).slice(0, poolSize)
    brollInfo(logPath, `provider local pool count=${localPool.length} requested=${poolSize} dir=${process.env['ME_BROLL_LOCAL']}`)
    return seededBrollOrder(localPool, opts.seed ?? 1, !!opts.shuffle)
  }
  // Fixture seam: recorded candidates so the pipeline is testable offline.
  const fixture = process.env['ME_BROLL_FIXTURE']
  if (fixture) {
    const recorded = JSON.parse(readFileSync(join(fixture, 'candidates.json'), 'utf8')) as BrollCandidate[]
    const fixturePool = recorded.slice(0, poolSize)
    brollInfo(logPath, `provider fixture pool count=${fixturePool.length} requested=${poolSize} dir=${fixture}`)
    return seededBrollOrder(fixturePool, opts.seed ?? 1, !!opts.shuffle)
  }
  const cached = opts.skipLibrary ? [] : libraryCandidates(themes, target, poolSize, logPath, opts.poolKey, opts.seed, opts.shuffle)
  const out: BrollCandidate[] = [...cached]
  const seen = new Set<string>(out.map((c) => `${c.provider}:${c.id}`))
  if (out.length >= poolSize) return out.slice(0, poolSize)
  if (opts.allowLive === false) return out.slice(0, poolSize)
  const providers: Array<{ name: ProviderName; search: (q: string) => Promise<BrollCandidate[]> }> = []
  if (settings.beta.pexelsKey) providers.push({ name: 'pexels', search: (q) => searchPexels(settings.beta.pexelsKey, q, target, logPath) })
  if (settings.beta.pixabayKey) providers.push({ name: 'pixabay', search: (q) => searchPixabay(settings.beta.pixabayKey, q, logPath) })
  if (settings.beta.coverrKey) providers.push({ name: 'coverr', search: (q) => searchCoverr(settings.beta.coverrKey, q, logPath) })
  if (providers.length === 0) {
    brollWarn(logPath, out.length ? `provider pool skipped: no stock provider keys configured; using ${out.length} cached clips` : 'provider pool skipped: no stock provider keys configured')
    return out.slice(0, poolSize)
  }
  const queries = themes.length ? themes : ['cinematic background']
  const rateLimited = new Set<ProviderName>()
  for (const q of queries) {
    for (const provider of providers) {
      if (out.length >= poolSize) break
      if (rateLimited.has(provider.name)) continue
      try {
        const ranked = rankCandidates(await provider.search(q), q, target)
        brollInfo(logPath, `provider ranked provider=${provider.name} query=${JSON.stringify(q)} count=${ranked.length}`)
        for (const c of ranked) {
          if (out.length >= poolSize) break
          if (seen.has(`${c.provider}:${c.id}`)) continue
          seen.add(`${c.provider}:${c.id}`)
          out.push(c)
        }
      } catch (e) {
        if (isRateLimitError(e)) {
          rateLimited.add(provider.name)
          brollWarn(logPath, `provider rate-limited provider=${provider.name} query=${JSON.stringify(q)}: ${(e as Error).message}`)
        } else {
          brollWarn(logPath, `provider search failed provider=${provider.name} query=${JSON.stringify(q)}: ${(e as Error).message}`)
        }
      }
    }
  }
  brollInfo(logPath, `provider pool complete count=${out.length} requested=${poolSize} rateLimited=${[...rateLimited].join(',') || 'none'}`)
  if (out.length === 0 && rateLimited.size === providers.length) {
    throw new Error('Stock B-roll unavailable: all configured providers are rate-limited or quota-blocked')
  }
  return seededBrollOrder(out, opts.seed ?? 1, !!opts.shuffle)
}

function brollDir(): string {
  const d = cacheDir('broll')
  mkdirSync(d, { recursive: true })
  return d
}

function safeId(id: string): string {
  return (id.replace(/[^a-z0-9_.-]/gi, '_').trim() || 'broll').slice(0, 120)
}

/** Clip identity/order recorded by the latest deterministic manifest for a render job. */
export function readBrollManifestClipIds(jobId: string): string[] {
  const path = join(brollDir(), safeId(jobId), 'manifest.json')
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { clips?: Array<{ provider?: string; id?: string }> }
    return (parsed.clips || []).map((clip) => `${clip.provider || 'unknown'}:${clip.id || 'unknown'}`)
  } catch { return [] }
}

function brollLibraryDir(): string {
  const d = join(app.getPath('userData'), 'broll-library')
  mkdirSync(d, { recursive: true })
  return d
}

function libraryIndexPath(sourceKey: string): string {
  return join(brollLibraryDir(), `${safeId(sourceKey)}.json`)
}

function emptyLibraryIndex(sourceKey: string): BrollLibraryIndex {
  const now = new Date().toISOString()
  return { version: 1, sourceKey, createdAt: now, updatedAt: now, keywords: [] }
}

function readLibraryIndex(sourceKey: string): BrollLibraryIndex {
  const path = libraryIndexPath(sourceKey)
  if (!existsSync(path)) return emptyLibraryIndex(sourceKey)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as BrollLibraryIndex
    return { ...emptyLibraryIndex(sourceKey), ...parsed, keywords: parsed.keywords ?? [] }
  } catch (e) {
    BROLL_LOG.warn(`library index unreadable path=${path}: ${(e as Error).message}`)
    return emptyLibraryIndex(sourceKey)
  }
}

function writeLibraryIndex(index: BrollLibraryIndex): string {
  const path = libraryIndexPath(index.sourceKey)
  index.updatedAt = new Date().toISOString()
  writeFileSync(path, JSON.stringify(index, null, 2))
  return path
}

function readLibraryIndexes(): BrollLibraryIndex[] {
  const dir = brollLibraryDir()
  const out: BrollLibraryIndex[] = []
  for (const file of readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'))) {
    try {
      const index = JSON.parse(readFileSync(join(dir, file), 'utf8')) as BrollLibraryIndex
      if (index?.version === 1 && Array.isArray(index.keywords)) out.push(index)
    } catch (e) {
      BROLL_LOG.warn(`library index unreadable file=${file}: ${(e as Error).message}`)
    }
  }
  return out
}

/** Number of usable cached clips, optionally scoped to one niche/source pool. */
export function cachedBrollClipCount(poolKey?: string): number {
  const indexes = poolKey ? [readLibraryIndex(poolKey)] : readLibraryIndexes()
  return indexes.reduce((total, index) => total + index.keywords.reduce(
    (sum, group) => sum + group.clips.filter((clip) => !!clip.path && clip.durationSec > 0 && existsSync(clip.path)).length,
    0
  ), 0)
}

/** Whether a render can search/download new stock clips right now. */
export function hasConfiguredBrollSource(settings: AppSettings): boolean {
  return !!(
    settings.beta.pexelsKey || settings.beta.pixabayKey || settings.beta.coverrKey ||
    process.env['ME_BROLL_LOCAL'] || process.env['ME_BROLL_FIXTURE']
  )
}

/** Health summary for a niche's cached b-roll pool (clip count + freshness). */
export function readNichePoolHealth(nicheId: string): NichePoolHealth {
  const index = readLibraryIndex(poolKeyForNiche(nicheId))
  const clips = index.keywords.reduce((sum, k) => sum + k.clips.filter((c) => existsSync(c.path)).length, 0)
  return { nicheId, clips, keywords: index.keywords.map((k) => k.keyword), updatedAt: clips > 0 ? index.updatedAt : undefined }
}

/** When a niche pool was last warmed (drives periodic refresh). */
export function readNichePoolLastWarmed(nicheId: string): string | undefined {
  return readLibraryIndex(poolKeyForNiche(nicheId)).lastWarmedAt
}

/** Stamp clips (by file path) as used now, across all pools — so selection can avoid
 *  recently-used footage and pruning keeps what's actually in rotation (P4). */
export function recordClipUsage(paths: string[]): void {
  const want = new Set(paths.filter(Boolean))
  if (!want.size) return
  const now = new Date().toISOString()
  for (const idx of readLibraryIndexes()) {
    let changed = false
    for (const g of idx.keywords) {
      for (const c of g.clips) {
        if (want.has(c.path)) { c.lastUsedAt = now; changed = true }
      }
    }
    if (changed) writeLibraryIndex(idx)
  }
}

/** Remove clips from a niche pool that haven't been used in maxAgeDays (deletes the
 *  files too). Returns the number removed. Copies are per-pool, so this never affects
 *  another niche's footage. */
export function pruneNichePool(nicheId: string, maxAgeDays: number): number {
  const index = readLibraryIndex(poolKeyForNiche(nicheId))
  const stale = new Set(planPoolPrune(index.keywords.flatMap((g) => g.clips), { nowMs: Date.now(), maxAgeDays }).map((c) => c.path))
  if (!stale.size) return 0
  for (const g of index.keywords) {
    g.clips = g.clips.filter((c) => {
      if (!stale.has(c.path)) return true
      try { rmSync(c.path, { force: true }) } catch { /* ignore */ }
      return false
    })
  }
  writeLibraryIndex(index)
  return stale.size
}

function themeTokens(themes: string[]): string[] {
  return themes
    .flatMap((t) => t.toLowerCase().split(/[^a-z]+/))
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
}

function libraryCandidates(themes: string[], target: { w: number; h: number }, poolSize: number, logPath?: string, poolKey?: string, seed?: number, shuffle = false): BrollCandidate[] {
  const tokens = themeTokens(themes)
  const wanted = new Set(tokens)
  const landscape = target.w >= target.h
  const scored: Array<{ score: number; candidate: BrollCandidate }> = []
  const fallback: Array<{ score: number; candidate: BrollCandidate }> = []
  // Scope to a single niche pool when a poolKey is given (prevents cross-niche bleed);
  // otherwise consider every cached library index (legacy behavior).
  const indexes = poolKey ? [readLibraryIndex(poolKey)] : readLibraryIndexes()
  for (const index of indexes) {
    for (const group of index.keywords) {
      const groupTokens = themeTokens([group.keyword])
      for (const clip of group.clips) {
        if (!clip.path || !existsSync(clip.path)) continue
        const clipTokens = themeTokens([...clip.tags, group.keyword])
        const matchScore = [...new Set([...groupTokens, ...clipTokens])].reduce((sum, token) => {
          if (wanted.has(token)) return sum + 6
          if (tokens.some((t) => token.includes(t) || t.includes(token))) return sum + 3
          return sum
        }, 0)
        let score = matchScore
        if ((clip.width >= clip.height) === landscape) score += 3
        if (clip.width >= target.w && clip.height >= target.h) score += 2
        if (clip.durationSec >= 4) score += 1
        const item = {
          score,
          candidate: {
            provider: clip.provider,
            id: `${index.sourceKey}-${clip.id}`,
            url: clip.path,
            width: clip.width,
            height: clip.height,
            durationSec: clip.durationSec,
            tags: [...new Set([...clip.tags, group.keyword])]
          }
        }
        if (tokens.length && matchScore <= 0) fallback.push({ ...item, score: Math.min(score, 2) })
        else scored.push(item)
      }
    }
  }
  const ranked = scored.length ? scored : fallback
  const stable = ranked.sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id)).slice(0, poolSize).map((s) => s.candidate)
  const out = seededBrollOrder(stable, seed ?? 1, shuffle)
  if (out.length) brollInfo(logPath, `library pool hit count=${out.length} requested=${poolSize} themes=${themes.join(',')}`)
  return out
}

/** Cached-only B-roll plan for editor preview/timeline.
 *  This never calls stock providers and never normalizes clips; the live preview only needs
 *  representative poster frames, so raw cached library clips are enough and stay instant. */
export function buildCachedBrollPreviewSegments(opts: {
  words: TranscriptWord[]
  durationSec: number
  density: BrollDensity
  poolSize: number
  dims: { w: number; h: number }
  maxSegments?: number
  poolKey?: string
  seed?: number
  shuffle?: boolean
  logPath?: string
}): BrollManifestSegment[] {
  const themes = extractThemes(opts.words)
  const candidates = libraryCandidates(themes, opts.dims, Math.max(1, opts.poolSize), opts.logPath, opts.poolKey, opts.seed, opts.shuffle)
  const clips = candidates.map((c) => ({
    path: c.url,
    durationSec: c.durationSec || probeDurationSec(c.url)
  })).filter((c) => c.path && existsSync(c.path) && c.durationSec > 0)
  const segments = planCoverage(opts.durationSec, clips, {
    density: opts.density,
    maxSegments: opts.maxSegments
  })
  return segments.map((segment) => ({
    ...segment,
    normalizedPath: segment.path
  }))
}

function concatPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/'/g, "\\'")
}

async function downloadOne(c: BrollCandidate, dir: string, logPath?: string): Promise<string> {
  const path = join(dir, `${c.provider}-${c.id}.mp4`)
  if (existsSync(path)) {
    brollInfo(logPath, `clip cache hit provider=${c.provider} id=${c.id} bytes=${fileBytes(path)} path=${path}`)
    return path
  }
  const started = Date.now()
  brollInfo(logPath, `clip download start provider=${c.provider} id=${c.id} url=${redactUrl(c.url)}`)
  const res = await fetch(c.url)
  brollInfo(logPath, `clip download response provider=${c.provider} id=${c.id} status=${res.status} ms=${Date.now() - started} url=${redactUrl(c.url)}`)
  if (!res.ok || !res.body) throw new Error(`download ${redactUrl(c.url)} -> ${res.status}`)
  let bytes = 0
  await new Promise<void>((resolve, reject) => {
    const file = createWriteStream(path)
    file.on('error', reject)
    // @ts-expect-error - web stream → node stream is supported at runtime
    const reader = res.body.getReader()
    const pump = (): void => {
      reader.read().then(({ done, value }: { done: boolean; value?: Uint8Array }) => {
        if (done) { file.end(() => resolve()); return }
        const chunk = Buffer.from(value!)
        bytes += chunk.length
        if (!file.write(chunk)) file.once('drain', pump)
        else pump()
      }).catch(reject)
    }
    pump()
  })
  brollInfo(logPath, `clip download done provider=${c.provider} id=${c.id} bytes=${bytes || fileBytes(path)} ms=${Date.now() - started} path=${path}`)
  return path
}

/** Download up to poolSize clips, skipping ones that fail (try the next candidate). */
export async function downloadPool(cands: BrollCandidate[], poolSize: number, onProgress?: (done: number, total: number) => void, logPath?: string): Promise<BrollClip[]> {
  const dir = brollDir()
  const fixture = process.env['ME_BROLL_FIXTURE']
  const local = process.env['ME_BROLL_LOCAL']
  const out: BrollClip[] = []
  const total = Math.min(poolSize, cands.length)
  for (const c of cands) {
    if (out.length >= poolSize) break
    try {
      let path: string
      if (local || existsSync(c.url)) {
        path = c.url // local/library candidates already carry the real on-disk path
        brollInfo(logPath, `clip local provider=${c.provider} id=${c.id} bytes=${fileBytes(path)} path=${path}`)
      } else if (fixture) {
        path = join(dir, `${c.provider}-${c.id}.mp4`)
        copyFileSync(join(fixture, 'sample.mp4'), path)
        brollInfo(logPath, `clip fixture provider=${c.provider} id=${c.id} bytes=${fileBytes(path)} path=${path}`)
      } else {
        path = await downloadOne(c, dir, logPath)
      }
      out.push({ ...c, path })
      brollInfo(logPath, `clip ready provider=${c.provider} id=${c.id} index=${out.length}/${total} duration=${c.durationSec || 'unknown'} path=${path}`)
      onProgress?.(out.length, total)
    } catch (e) {
      brollWarn(logPath, `clip download failed ${c.provider}:${c.id}: ${(e as Error).message}`)
    }
  }
  return out
}

function keywordGroup(index: BrollLibraryIndex, keyword: string): BrollLibraryIndex['keywords'][number] {
  let group = index.keywords.find((k) => k.keyword === keyword)
  if (!group) {
    group = { keyword, clips: [] }
    index.keywords.push(group)
  }
  return group
}

/** Find an already-cached local file for a provider clip in ANY pool (multi-niche dedupe).
 *  Lets a clip shared across niches be copied locally instead of re-downloaded. */
function findCachedClipFile(provider: string, id: string): string | undefined {
  for (const idx of readLibraryIndexes()) {
    for (const g of idx.keywords) {
      for (const c of g.clips) {
        if (c.provider === provider && c.id === id && existsSync(c.path)) return c.path
      }
    }
  }
  return undefined
}

async function cacheCandidateForLibrary(c: BrollCandidate, sourceKey: string, keyword: string, logPath?: string): Promise<BrollLibraryClip> {
  const dir = join(brollLibraryDir(), safeId(sourceKey), safeId(keyword))
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, `${c.provider}-${safeId(c.id)}.mp4`)
  let path: string
  if (existsSync(dest)) {
    path = dest
  } else if (existsSync(c.url)) {
    path = dest
    copyFileSync(c.url, path)
    brollInfo(logPath, `library clip copied provider=${c.provider} id=${c.id} keyword=${keyword} bytes=${fileBytes(path)} path=${path}`)
  } else {
    // Multi-niche dedupe: reuse a copy already downloaded in another pool when available.
    const cached = findCachedClipFile(c.provider, c.id)
    if (cached) {
      path = dest
      copyFileSync(cached, path)
      brollInfo(logPath, `library clip reused from pool provider=${c.provider} id=${c.id} keyword=${keyword} src=${cached}`)
    } else {
      path = await downloadOne(c, dir, logPath)
      brollInfo(logPath, `library clip downloaded provider=${c.provider} id=${c.id} keyword=${keyword} bytes=${fileBytes(path)} path=${path}`)
    }
  }
  return {
    provider: c.provider,
    id: c.id,
    path,
    durationSec: c.durationSec || probeDurationSec(path),
    width: c.width,
    height: c.height,
    tags: [...new Set([...c.tags, keyword])],
    addedAt: new Date().toISOString()
  }
}

/**
 * Background prefetch from scraped titles: derive themes, save reusable stock clips by
 * keyword, then future renders choose local files before external providers.
 */
export async function warmBrollLibraryFromTitles(
  settings: AppSettings,
  titles: string[],
  opts: {
    sourceKey?: string
    targetClips?: number
    dims?: { w: number; h: number }
    logPath?: string
    onProgress?: (done: number, total: number) => void
  } = {}
): Promise<BrollLibraryWarmResult | null> {
  const themes = keywordThemesFromTitles(titles, 12)
  if (!themes.length) return null
  const sourceKey = opts.sourceKey ?? themes.slice(0, 4).join('-')
  return warmLibraryForThemes(settings, sourceKey, themes, opts)
}

/** Warm (top up) a niche's b-roll pool from its curated keywords. Stored under the
 *  `niche-<id>` library key so render selection can scope to it. */
export async function warmBrollLibraryFromNiche(
  settings: AppSettings,
  niche: Niche,
  opts: { logPath?: string; onProgress?: (done: number, total: number) => void } = {}
): Promise<BrollLibraryWarmResult | null> {
  const themes = nicheSearchThemes(niche)
  if (!themes.length) return null
  return warmLibraryForThemes(settings, poolKeyForNiche(niche.id), themes, {
    targetClips: niche.targetClips,
    dims: dimsForOrientation(niche.orientation),
    logPath: opts.logPath,
    onProgress: opts.onProgress
  })
}

/** Core library-warming loop shared by the title-based + niche-based warmers. */
export async function warmLibraryForThemes(
  settings: AppSettings,
  sourceKey: string,
  themes: string[],
  opts: {
    targetClips?: number
    dims?: { w: number; h: number }
    logPath?: string
    onProgress?: (done: number, total: number) => void
  } = {}
): Promise<BrollLibraryWarmResult | null> {
  if (!themes.length) return null
  const hasProvider = hasConfiguredBrollSource(settings)
  const targetClips = Math.max(1, Math.min(200, opts.targetClips ?? 60))
  const dims = opts.dims ?? { w: 1920, h: 1080 }
  if (!hasProvider) {
    brollWarn(opts.logPath, `library warm skipped source=${sourceKey}: no stock provider keys configured`)
    return null
  }

  const index = readLibraryIndex(sourceKey)
  const perTheme = Math.max(4, Math.ceil(targetClips / themes.length))
  let clipCount = index.keywords.reduce((sum, k) => sum + k.clips.filter((c) => existsSync(c.path)).length, 0)
  brollInfo(opts.logPath, `library warm start source=${sourceKey} target=${targetClips} existing=${clipCount} themes=${themes.join(',')}`)
  opts.onProgress?.(Math.min(clipCount, targetClips), targetClips)

  for (const keyword of themes) {
    if (clipCount >= targetClips) break
    const group = keywordGroup(index, keyword)
    group.clips = group.clips.filter((c) => existsSync(c.path))
    const needed = Math.max(0, Math.min(perTheme - group.clips.length, targetClips - clipCount))
    if (needed <= 0) continue

    try {
      const cands = await fetchPool(settings, [keyword], dims, Math.max(needed * 2, needed), opts.logPath, { skipLibrary: true })
      const seen = new Set(group.clips.map((c) => `${c.provider}:${c.id}`))
      for (const cand of cands) {
        if (group.clips.length >= perTheme || clipCount >= targetClips) break
        if (seen.has(`${cand.provider}:${cand.id}`)) continue
        try {
          const clip = await cacheCandidateForLibrary(cand, sourceKey, keyword, opts.logPath)
          if (clip.durationSec <= 0) {
            brollWarn(opts.logPath, `library clip skipped provider=${clip.provider} id=${clip.id} reason=duration-missing`)
            continue
          }
          group.clips.push(clip)
          seen.add(`${clip.provider}:${clip.id}`)
          clipCount++
          writeLibraryIndex(index)
          opts.onProgress?.(Math.min(clipCount, targetClips), targetClips)
        } catch (e) {
          brollWarn(opts.logPath, `library clip cache failed keyword=${keyword} id=${cand.provider}:${cand.id}: ${(e as Error).message}`)
        }
      }
    } catch (e) {
      brollWarn(opts.logPath, `library keyword warm failed source=${sourceKey} keyword=${keyword}: ${(e as Error).message}`)
    }
  }

  const indexPath = writeLibraryIndex(index)
  const finalClips = index.keywords.reduce((sum, k) => sum + k.clips.filter((c) => existsSync(c.path)).length, 0)
  index.lastWarmedAt = new Date().toISOString()
  writeLibraryIndex(index)
  brollInfo(opts.logPath, `library warm done source=${sourceKey} clips=${finalClips} index=${indexPath}`)
  return { indexPath, sourceKey, keywords: themes, clips: finalClips }
}

const BED_CF = 0.3 // bed crossfade duration (also the planCoverage tail reserve)

function brollStyleBoundaryFilters(style: VideoStyle | undefined, durationSec: number, index: number, total: number): string[] {
  if (!style || style === 'None' || style === 'Clean' || total <= 1) return []
  const fadeSec = style === 'Cinematic' ? 0.42 : style === 'Heartfelt' ? 0.36 : 0.14
  const d = Math.max(0.05, Math.min(fadeSec, durationSec / 3))
  const color = style === 'Heartfelt' ? 'white' : 'black'
  const filters: string[] = []
  if (index > 0) filters.push(`fade=t=in:st=0:d=${d.toFixed(2)}:color=${color}`)
  if (index < total - 1) {
    const start = Math.max(0, durationSec - d)
    filters.push(`fade=t=out:st=${start.toFixed(2)}:d=${d.toFixed(2)}:color=${color}`)
  }
  return filters
}

export function buildBrollNormalizeArgs(
  segment: BrollSegment,
  outPath: string,
  dims: { w: number; h: number },
  fps: number,
  settings: AppSettings,
  caps: RenderCapabilities,
  styleOpts: { style?: VideoStyle; index?: number; total?: number } = {}
): string[] {
  const { w, h } = dims
  const dur = Math.max(0.5, segment.end - segment.start)
  const crf = settings.quality === '1440p' ? '20' : settings.quality === '720p' ? '23' : '21'
  const useCuda = settings.encoder === 'nvenc' && caps.ffmpegHasCuda
  const inputArgs = useCuda
    ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']
    : []
  const styleFilters = brollStyleBoundaryFilters(styleOpts.style, dur, styleOpts.index ?? 0, styleOpts.total ?? 1)
  const filter = [
    useCuda
      ? `scale_cuda=w=${w}:h=${h}:force_original_aspect_ratio=increase,hwdownload,format=nv12,crop=${w}:${h},setsar=1,fps=${fps},format=yuv420p`
      : `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps},format=yuv420p`,
    ...styleFilters
  ].join(',')
  return [
    '-y',
    '-progress', 'pipe:1',
    '-nostats',
    ...inputArgs,
    '-stream_loop', '-1',
    '-ss', segment.srcStart.toFixed(2),
    '-t', dur.toFixed(2),
    '-i', segment.path,
    '-an',
    '-vf', filter,
    ...videoCodecArgs(settings, crf, caps),
    '-r', String(fps),
    '-movflags', '+faststart',
    outPath
  ]
}

function spawnNormalize(
  args: string[],
  durationSec: number,
  opts: { shouldCancel?: () => boolean; onProgress?: (p: FfmpegProgress) => void }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { windowsHide: true })
    const smooth = createProgressSmoother(durationSec)
    let err = ''
    let settled = false
    let cancelTimer: ReturnType<typeof setInterval> | undefined
    const done = (e?: Error): void => {
      if (settled) return
      settled = true
      if (cancelTimer) clearInterval(cancelTimer)
      if (e) reject(e)
      else resolve()
    }
    cancelTimer = setInterval(() => {
      if (!opts.shouldCancel?.()) return
      child.kill('SIGKILL')
      done(new Error('render cancelled'))
    }, 250)

    child.stdout.on('data', (d: Buffer) => {
      const p = parseFfmpegProgressBlock(d.toString(), durationSec)
      if (p) opts.onProgress?.(smooth(p))
    })
    child.stderr.on('data', (d: Buffer) => (err += d))
    child.on('error', (e) => done(e))
    child.on('close', (code) => {
      if (settled) return
      if (code === 0) done()
      else done(new Error(`broll normalize ffmpeg ${code}: ${ffmpegErrorTail(err, 240)}`))
    })
  })
}

async function normalizeSegment(
  segment: BrollSegment,
  index: number,
  dir: string,
  opts: {
    dims: { w: number; h: number }
    fps: number
    settings: AppSettings
    caps: RenderCapabilities
    style?: VideoStyle
    total: number
    shouldCancel?: () => boolean
    onProgress?: (p: FfmpegProgress) => void
    logPath?: string
  }
): Promise<BrollManifestSegment> {
  const styleKey = opts.style && opts.style !== 'None' ? `-${safeId(opts.style)}` : ''
  const outPath = join(dir, `seg-${String(index).padStart(3, '0')}${styleKey}.mp4`)
  const durationSec = Math.max(0.5, segment.end - segment.start)
  if (existsSync(outPath) && probeDurationSec(outPath) >= durationSec - 0.25) {
    brollInfo(opts.logPath, `normalize cache hit segment=${index} duration=${durationSec.toFixed(2)} bytes=${fileBytes(outPath)} path=${outPath}`)
    opts.onProgress?.({ outTimeSec: durationSec, pct: 100, speed: 1, etaSec: 0, etaState: 'stable' })
    return { ...segment, normalizedPath: outPath, style: opts.style }
  }

  try {
    const args = buildBrollNormalizeArgs(segment, outPath, opts.dims, opts.fps, opts.settings, opts.caps, { style: opts.style, index, total: opts.total })
    brollInfo(opts.logPath, `normalize start segment=${index} encoder=${opts.settings.encoder ?? 'cpu'} style=${opts.style ?? 'None'} duration=${durationSec.toFixed(2)} src=${segment.path} out=${outPath} cmd=${ffmpegPath()} ${args.join(' ')}`)
    await spawnNormalize(args, durationSec, opts)
    brollInfo(opts.logPath, `normalize done segment=${index} bytes=${fileBytes(outPath)} path=${outPath}`)
  } catch (e) {
    if (opts.shouldCancel?.() || (opts.settings.encoder ?? 'cpu') === 'cpu') throw e
    const msg = (e as Error).message
    brollWarn(opts.logPath, `normalize hardware encode failed; CPU fallback disabled for segment ${index}: ${msg}`)
    throw new Error(`B-roll GPU normalize failed for ${opts.settings.encoder.toUpperCase()}; CPU fallback is disabled. ${msg}`)
  }
  return { ...segment, normalizedPath: outPath, style: opts.style }
}

export async function buildBrollManifest(opts: {
  settings: AppSettings
  caps?: RenderCapabilities
  words: TranscriptWord[]
  durationSec: number
  density: BrollDensity
  poolSize: number
  dims: { w: number; h: number }
  fps: number
  style?: VideoStyle
  jobId?: string
  maxSegments?: number
  /** scope library selection to a single niche pool (niche-<id>) */
  poolKey?: string
  allowLive?: boolean
  seed?: number
  shuffle?: boolean
  shouldCancel?: () => boolean
  logPath?: string
  onProgress?: (phase: 'fetch' | 'download' | 'normalize' | 'manifest', done: number, total: number, ffmpeg?: FfmpegProgress) => void
}): Promise<BrollManifestResult | null> {
  brollInfo(opts.logPath, `manifest build start job=${opts.jobId ?? 'none'} duration=${opts.durationSec.toFixed(2)} density=${opts.density} poolSize=${opts.poolSize} dims=${opts.dims.w}x${opts.dims.h} fps=${opts.fps} style=${opts.style ?? 'None'} pool=${opts.poolKey || 'all'} seed=${opts.seed ?? 'ranked'} shuffle=${!!opts.shuffle}`)
  const planned = await buildBrollSegments({
    settings: opts.settings,
    words: opts.words,
    durationSec: opts.durationSec,
    density: opts.density,
    poolSize: opts.poolSize,
    dims: opts.dims,
    maxSegments: opts.maxSegments,
    poolKey: opts.poolKey,
    allowLive: opts.allowLive,
    seed: opts.seed,
    shuffle: opts.shuffle,
    logPath: opts.logPath,
    onProgress: (phase, done, total) => opts.onProgress?.(phase, done, total)
  })
  if (!planned || planned.segments.length === 0) {
    brollWarn(opts.logPath, `manifest build skipped job=${opts.jobId ?? 'none'} reason=no-segments`)
    return null
  }

  const dir = join(brollDir(), safeId(opts.jobId ?? `manifest-${Math.round(opts.durationSec)}-${opts.density}`))
  mkdirSync(dir, { recursive: true })
  const total = planned.segments.length
  const normalized: BrollManifestSegment[] = []
  for (let i = 0; i < planned.segments.length; i++) {
    if (opts.shouldCancel?.()) throw new Error('render cancelled')
    const seg = await normalizeSegment(planned.segments[i], i, dir, {
      dims: opts.dims,
      fps: opts.fps,
      settings: opts.settings,
      caps: opts.caps ?? FALLBACK_CAPS,
      style: opts.style,
      total,
      shouldCancel: opts.shouldCancel,
      logPath: opts.logPath,
      onProgress: (p) => opts.onProgress?.('normalize', i + (p.pct / 100), total, p)
    })
    normalized.push(seg)
    opts.onProgress?.('normalize', i + 1, total)
  }

  const manifestPath = join(dir, 'concat.txt')
  const jsonPath = join(dir, 'manifest.json')
  const concat = normalized.map((s) => {
    const durationSec = Math.max(0.5, s.end - s.start)
    return `file '${concatPath(s.normalizedPath)}'\nduration ${durationSec.toFixed(3)}`
  }).join('\n') + '\n'
  writeFileSync(manifestPath, concat)
  writeFileSync(jsonPath, JSON.stringify({
    version: 2,
    createdAt: new Date().toISOString(),
    durationSec: opts.durationSec,
    density: opts.density,
    style: opts.style ?? 'None',
    fps: opts.fps,
    dims: opts.dims,
    clips: planned.clips.map((c) => ({ provider: c.provider, id: c.id, path: c.path, durationSec: c.durationSec })),
    segments: normalized
  }, null, 2))
  brollInfo(opts.logPath, `manifest build done job=${opts.jobId ?? 'none'} clips=${planned.clips.length} order=${planned.clips.map((clip) => `${clip.provider}:${clip.id}`).join(',')} segments=${normalized.length} manifest=${manifestPath} json=${jsonPath}`)
  opts.onProgress?.('manifest', total, total)
  return { clips: planned.clips, segments: normalized, manifestPath, jsonPath }
}

/** Assemble the planned segments into one bed.mp4 (scaled to WxH). With a transition,
 *  consecutive clips crossfade; otherwise they hard-cut (concat). Dry-run seam
 *  (ME_RENDER_FIXTURE / fixture mode) writes a stub so callers work offline. */
export async function assembleBed(
  segments: BrollSegment[],
  dims: { w: number; h: number },
  fps: number,
  transition?: string,
  opts: { settings?: AppSettings; caps?: RenderCapabilities; onProgress?: (p: FfmpegProgress) => void } = {}
): Promise<string> {
  const dir = brollDir()
  const bed = join(dir, `bed-${Date.now()}.mp4`)
  if (process.env['ME_RENDER_FIXTURE'] || process.env['ME_BROLL_FIXTURE'] || segments.length === 0) {
    writeFileSync(bed, Buffer.from('\x00\x00\x00\x18ftypmp42stub-broll-bed'))
    return bed
  }
  const { w, h } = dims
  const total = segments[segments.length - 1].end
  const settings = opts.settings ?? { encoder: 'cpu', quality: '1080p' } as AppSettings
  const caps = opts.caps ?? FALLBACK_CAPS
  const inputs: string[] = []
  const parts: string[] = []
  let mapLabel: string

  if (transition && segments.length > 1) {
    // Crossfade consecutive clips. Each input carries BED_CF of extra tail (reserved by
    // planCoverage's tailReserve) so the xfade has overlap material; offsets accumulate
    // by visible segment length so the total still equals the audio duration.
    segments.forEach((s, i) => {
      inputs.push('-stream_loop', '-1', '-ss', s.srcStart.toFixed(2), '-t', (s.end - s.start + BED_CF).toFixed(2), '-i', s.path)
      parts.push(`[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps}[v${i}]`)
    })
    let last = 'v0'
    let offset = segments[0].end - segments[0].start
    for (let i = 1; i < segments.length; i++) {
      const out = `x${i}`
      parts.push(`[${last}][v${i}]xfade=transition=${transition}:duration=${BED_CF}:offset=${offset.toFixed(2)}[${out}]`)
      offset += segments[i].end - segments[i].start
      last = out
    }
    mapLabel = `[${last}]`
  } else {
    segments.forEach((s, i) => {
      inputs.push('-stream_loop', '-1', '-ss', s.srcStart.toFixed(2), '-t', (s.end - s.start).toFixed(2), '-i', s.path)
      parts.push(`[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps}[v${i}]`)
    })
    const concatIn = segments.map((_, i) => `[v${i}]`).join('')
    parts.push(`${concatIn}concat=n=${segments.length}:v=1:a=0[v]`)
    mapLabel = '[v]'
  }
  const crf = settings.quality === '1440p' ? '20' : settings.quality === '720p' ? '23' : '21'
  const args = ['-y', '-progress', 'pipe:1', '-nostats', ...inputs, '-filter_complex', parts.join(';'), '-map', mapLabel, '-t', total.toFixed(2), ...videoCodecArgs(settings, crf, caps), '-r', String(fps), bed]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { windowsHide: true })
    const smooth = createProgressSmoother(total)
    let err = ''
    child.stdout.on('data', (d: Buffer) => {
      const p = parseFfmpegProgressBlock(d.toString(), total)
      if (p) opts.onProgress?.(smooth(p))
    })
    child.stderr.on('data', (d: Buffer) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`broll ffmpeg ${code}: ${ffmpegErrorTail(err, 200)}`))))
  })
  return bed
}

/** End-to-end: themes → pool → download → coverage → bed.mp4. Returns the bed path,
 *  or null when no footage could be secured (caller falls back to stills). */
export async function buildBrollBed(opts: {
  settings: AppSettings
  words: TranscriptWord[]
  durationSec: number
  density: BrollDensity
  poolSize: number
  dims: { w: number; h: number }
  fps: number
  maxSegments?: number
  /** crossfade clips with this transition (e.g. the style's); undefined = hard cuts */
  transition?: string
  /** scope library selection to a single niche pool (niche-<id>) */
  poolKey?: string
  allowLive?: boolean
  seed?: number
  shuffle?: boolean
  caps?: RenderCapabilities
  onProgress?: (phase: 'fetch' | 'download' | 'assemble', done: number, total: number, ffmpeg?: FfmpegProgress) => void
}): Promise<string | null> {
  const planned = await buildBrollSegments(opts)
  if (!planned || planned.segments.length === 0) return null
  opts.onProgress?.('assemble', 0, Math.max(1, planned.segments.length))
  return assembleBed(planned.segments, opts.dims, opts.fps, opts.transition, {
    settings: opts.settings,
    caps: opts.caps,
    onProgress: (p) => opts.onProgress?.('assemble', p.pct, 100, p)
  })
}

/** End-to-end planning without pre-encoding: themes → pool → download → coverage. */
export async function buildBrollSegments(opts: {
  settings: AppSettings
  words: TranscriptWord[]
  durationSec: number
  density: BrollDensity
  poolSize: number
  dims: { w: number; h: number }
  /** reserve overlap tail only when the final graph will xfade */
  transition?: string
  /** hard cap for long videos; clips loop when a slot is longer than source media */
  maxSegments?: number
  /** optional per-job render log where b-roll events are mirrored */
  logPath?: string
  /** scope library selection to a single niche pool (niche-<id>) */
  poolKey?: string
  allowLive?: boolean
  seed?: number
  shuffle?: boolean
  onProgress?: (phase: 'fetch' | 'download', done: number, total: number) => void
}): Promise<BrollPlanResult | null> {
  const themes = extractThemes(opts.words)
  opts.onProgress?.('fetch', 0, opts.poolSize)
  const cands = await fetchPool(opts.settings, themes, opts.dims, opts.poolSize, opts.logPath, { poolKey: opts.poolKey, allowLive: opts.allowLive, seed: opts.seed, shuffle: opts.shuffle })
  opts.onProgress?.('fetch', cands.length, opts.poolSize)
  const clips = await downloadPool(cands, opts.poolSize, (done, total) => opts.onProgress?.('download', done, total), opts.logPath)
  if (clips.length === 0) return null
  const segments = planCoverage(opts.durationSec, clips, { density: opts.density, maxSegments: opts.maxSegments, tailReserve: opts.transition ? BED_CF : 0 })
  brollInfo(opts.logPath, `coverage planned duration=${opts.durationSec.toFixed(2)} clips=${clips.length} segments=${segments.length} maxSegments=${opts.maxSegments ?? DEFAULT_MAX_SEGMENTS}`)
  return { clips, segments }
}
