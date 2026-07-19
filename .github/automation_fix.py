from __future__ import annotations

from pathlib import Path
import re
import textwrap

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one exact match, found {count}: {old[:120]!r}")
    write(path, text.replace(old, new, 1))


def regex_once(path: str, pattern: str, replacement: str) -> None:
    text = read(path)
    next_text, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{path}: expected one regex match, found {count}: {pattern[:120]!r}")
    write(path, next_text)


replace_once(
    "shared/types.ts",
    "export interface AutomationRules {\n  minDurationSec: number\n  skipDownloaded: boolean\n  continueOnError: boolean",
    "export interface AutomationRules {\n  minDurationSec: number\n  skipDownloaded: boolean\n  skipUploaded?: boolean\n  downloadDelaySec?: number\n  continueOnError: boolean",
)
replace_once(
    "shared/types.ts",
    "  style: VideoStyle\n  captionPreset: string\n  aspectRatios: Array<'16:9' | '1:1' | '9:16'>",
    "  style: VideoStyle\n  captionPreset: string\n  captionFont?: string\n  captionAnim?: string\n  captionLines?: 1 | 2 | 3\n  captionPosition?: 'top' | 'middle' | 'bottom'\n  captionPace?: 'auto' | 'word' | 'phrase'\n  captionHighlightColor?: string\n  captionBoxColor?: string\n  captionWordsPerPage?: 1 | 2 | 3\n  imageMode?: ImageMode\n  crossfadeSec?: number\n  overlay?: BetaVideoOpts['overlay']\n  brollPoolKey?: string\n  brollDensity?: BrollDensity\n  brollPoolSize?: number\n  brollMode?: 'full' | 'overlay'\n  brollShuffle?: boolean\n  aspectRatios: Array<'16:9' | '1:1' | '9:16'>",
)
replace_once(
    "shared/types.ts",
    "  // ---- phase 2: themed b-roll pool ----\n  broll: { enabled: boolean; density: BrollDensity; poolSize: number; mode: 'full' | 'overlay' }\n  // ---- phase 3: style + transition/text-effect plan ----",
    "  // ---- phase 2: themed b-roll pool ----\n  broll: {\n    enabled: boolean\n    density: BrollDensity\n    poolSize: number\n    mode: 'full' | 'overlay'\n    /** explicit cached pool selected by Automation; source-linked niche remains fallback */\n    poolKey?: string\n    /** stable per-project shuffle: different videos differ, rerenders stay deterministic */\n    shuffle?: boolean\n    shuffleSeed?: number\n  }\n  // ---- phase 3: style + transition/text-effect plan ----",
)
replace_once(
    "shared/types.ts",
    "  broll: { enabled: false, density: 'sparse', poolSize: 18, mode: 'full' },",
    "  broll: { enabled: false, density: 'sparse', poolSize: 18, mode: 'full', poolKey: undefined, shuffle: true, shuffleSeed: undefined },",
)
replace_once(
    "shared/types.ts",
    "      poolSize: Math.round(clampNumber(broll.poolSize, DEFAULT_BETA_OPTS.broll.poolSize, 1, 200)),\n      mode\n    },",
    "      poolSize: Math.round(clampNumber(broll.poolSize, DEFAULT_BETA_OPTS.broll.poolSize, 1, 200)),\n      mode,\n      poolKey: typeof broll.poolKey === 'string' && broll.poolKey.trim() ? broll.poolKey.trim().slice(0, 160) : undefined,\n      shuffle: boolValue(broll.shuffle, DEFAULT_BETA_OPTS.broll.shuffle ?? true),\n      shuffleSeed: Number.isFinite(Number(broll.shuffleSeed)) ? Math.max(0, Math.floor(Number(broll.shuffleSeed))) : undefined\n    },",
)

replace_once(
    "electron/services/downloader.ts",
    "      '--socket-timeout', '30',\n      '--retries', '3',\n      '-o', dest.replace(/\\.mp3$/, '.%(ext)s')",
    "      '--socket-timeout', '30',\n      '--retries', '5',\n      '--fragment-retries', '5',\n      // YouTube/CDN 403 and 429 responses are often temporary. Pace requests and let\n      // yt-dlp retry before the Automation supervisor performs its own bounded retry.\n      '--retry-sleep', 'http:5',\n      '--retry-sleep', 'fragment:3',\n      '--sleep-requests', '1',\n      '-o', dest.replace(/\\.mp3$/, '.%(ext)s')",
)

replace_once(
    "electron/services/broll.ts",
    "// ---------- pure core (offline, unit-tested) ----------\n\n/** Top recurring content words across the transcript — the video's themes. */",
    "// ---------- pure core (offline, unit-tested) ----------\n\nfunction seededUnit(seed: number, key: string): number {\n  let h = (seed >>> 0) || 0x9e3779b9\n  for (let i = 0; i < key.length; i++) {\n    h ^= key.charCodeAt(i)\n    h = Math.imul(h, 16777619)\n  }\n  h ^= h >>> 16\n  h = Math.imul(h, 0x7feb352d)\n  h ^= h >>> 15\n  return (h >>> 0) / 0x100000000\n}\n\n/** Keep a relevant shortlist, then shuffle it deterministically for one project. */\nexport function seededBrollOrder<T extends { id: string }>(items: T[], seed?: number): T[] {\n  if (seed == null) return items\n  return [...items]\n    .map((item, index) => ({ item, index, key: seededUnit(seed, `${item.id}:${index}`) }))\n    .sort((a, b) => a.key - b.key || a.index - b.index)\n    .map((entry) => entry.item)\n}\n\n/** Top recurring content words across the transcript — the video's themes. */",
)
replace_once(
    "electron/services/broll.ts",
    "function libraryCandidates(themes: string[], target: { w: number; h: number }, poolSize: number, logPath?: string, poolKey?: string): BrollCandidate[] {",
    "function libraryCandidates(themes: string[], target: { w: number; h: number }, poolSize: number, logPath?: string, poolKey?: string, shuffleSeed?: number): BrollCandidate[] {",
)
replace_once(
    "electron/services/broll.ts",
    "        score += Math.random() * 0.5",
    "        score += shuffleSeed == null ? Math.random() * 0.5 : seededUnit(shuffleSeed, `${index.sourceKey}:${clip.id}`) * 0.5",
)
replace_once(
    "electron/services/broll.ts",
    "  const ranked = scored.length ? scored : fallback\n  const out = ranked.sort((a, b) => b.score - a.score).slice(0, poolSize).map((s) => s.candidate)\n  if (out.length) brollInfo(logPath, `library pool hit count=${out.length} requested=${poolSize} themes=${themes.join(',')}`)",
    "  const ranked = scored.length ? scored : fallback\n  // Preserve relevance by limiting to the best 3× pool, then vary the actual clip order.\n  const shortlist = ranked.sort((a, b) => b.score - a.score)\n    .slice(0, Math.max(poolSize, Math.min(ranked.length, poolSize * 3))).map((s) => s.candidate)\n  const out = seededBrollOrder(shortlist, shuffleSeed).slice(0, poolSize)\n  if (out.length) brollInfo(logPath, `library pool hit count=${out.length} requested=${poolSize} themes=${themes.join(',')}`)",
)
replace_once(
    "electron/services/broll.ts",
    "  maxSegments?: number\n  poolKey?: string\n  logPath?: string\n}): BrollManifestSegment[] {\n  const themes = extractThemes(opts.words)\n  const candidates = libraryCandidates(themes, opts.dims, Math.max(1, opts.poolSize), opts.logPath, opts.poolKey)",
    "  maxSegments?: number\n  poolKey?: string\n  shuffleSeed?: number\n  logPath?: string\n}): BrollManifestSegment[] {\n  const themes = extractThemes(opts.words)\n  const candidates = libraryCandidates(themes, opts.dims, Math.max(1, opts.poolSize), opts.logPath, opts.poolKey, opts.shuffleSeed)",
)
replace_once(
    "electron/services/broll.ts",
    "  opts: { skipLibrary?: boolean; poolKey?: string } = {}\n): Promise<BrollCandidate[]> {",
    "  opts: { skipLibrary?: boolean; poolKey?: string; shuffleSeed?: number } = {}\n): Promise<BrollCandidate[]> {",
)
replace_once(
    "electron/services/broll.ts",
    "  const cached = opts.skipLibrary ? [] : libraryCandidates(themes, target, poolSize, logPath, opts.poolKey)",
    "  const cached = opts.skipLibrary ? [] : libraryCandidates(themes, target, poolSize, logPath, opts.poolKey, opts.shuffleSeed)",
)
replace_once(
    "electron/services/broll.ts",
    "  /** scope library selection to a single niche pool (niche-<id>) */\n  poolKey?: string\n  shouldCancel?: () => boolean",
    "  /** scope library selection to a single niche pool (niche-<id>) */\n  poolKey?: string\n  shuffleSeed?: number\n  shouldCancel?: () => boolean",
)
replace_once(
    "electron/services/broll.ts",
    "    maxSegments: opts.maxSegments,\n    poolKey: opts.poolKey,\n    logPath: opts.logPath,",
    "    maxSegments: opts.maxSegments,\n    poolKey: opts.poolKey,\n    shuffleSeed: opts.shuffleSeed,\n    logPath: opts.logPath,",
)
replace_once(
    "electron/services/broll.ts",
    "  /** scope library selection to a single niche pool (niche-<id>) */\n  poolKey?: string\n  onProgress?: (phase: 'fetch' | 'download', done: number, total: number) => void\n}): Promise<BrollPlanResult | null> {",
    "  /** scope library selection to a single niche pool (niche-<id>) */\n  poolKey?: string\n  shuffleSeed?: number\n  onProgress?: (phase: 'fetch' | 'download', done: number, total: number) => void\n}): Promise<BrollPlanResult | null> {",
)
replace_once(
    "electron/services/broll.ts",
    "  const cands = await fetchPool(opts.settings, themes, opts.dims, opts.poolSize, opts.logPath, { poolKey: opts.poolKey })",
    "  const cands = await fetchPool(opts.settings, themes, opts.dims, opts.poolSize, opts.logPath, { poolKey: opts.poolKey, shuffleSeed: opts.shuffleSeed })",
)

replace_once(
    "electron/services/queue.ts",
    "    const poolKey = repos.nicheKeyForDownload(project.downloadId)",
    "    const poolKey = beta.broll.poolKey || repos.nicheKeyForDownload(project.downloadId)",
)
replace_once(
    "electron/services/queue.ts",
    "        maxSegments,\n        poolKey,\n        shouldCancel: () => hasCancelIntent(job.id),",
    "        maxSegments,\n        poolKey,\n        shuffleSeed: beta.broll.shuffle === false ? undefined : (beta.broll.shuffleSeed ?? renderProject.seed),\n        shouldCancel: () => hasCancelIntent(job.id),",
)
replace_once(
    "electron/services/queue.ts",
    "        if (renderLogPath) appendFileSync(renderLogPath, `[broll]\\nmanifest=${planned.manifestPath}\\njson=${planned.jsonPath}\\nsegments=${planned.segments.length}\\n`)",
    "        if (renderLogPath) appendFileSync(renderLogPath, `[broll]\\npool=${poolKey || 'all'}\\nshuffleSeed=${beta.broll.shuffle === false ? 'off' : (beta.broll.shuffleSeed ?? renderProject.seed)}\\nmanifest=${planned.manifestPath}\\njson=${planned.jsonPath}\\nsegments=${planned.segments.length}\\n`)",
)

replace_once(
    "electron/services/automation-supervisor.ts",
    "import { asBetaOpts } from '../../shared/types'\nimport { buildAutomationWorkflow, isAutomationGoalAvailable, workflowProgress } from '../../shared/automation'",
    "import { asBetaOpts } from '../../shared/types'\nimport { DEFAULT_UPLOAD_MATCH_THRESHOLD, titleMatchScore } from '../../shared/match'\nimport { buildAutomationWorkflow, isAutomationGoalAvailable, workflowProgress } from '../../shared/automation'",
)
replace_once(
    "electron/services/automation-supervisor.ts",
    "import { hasConfiguredBrollSource } from './broll'",
    "import { cachedBrollClipCount, hasConfiguredBrollSource } from './broll'",
)
replace_once(
    "electron/services/automation-supervisor.ts",
    "function classifyError(error: unknown, step = ''): { kind: AutomationErrorKind; retryable: boolean; message: string } {\n  const message = error instanceof Error ? error.message : String(error)\n  const s = message.toLowerCase()\n  if (/enospc|disk|space/.test(s)) return { kind: 'storage', retryable: false, message }\n  if (/api key|401|403|auth|credential/.test(s)) return { kind: 'authentication', retryable: false, message }\n  if (/unsupported|not available yet/.test(s)) return { kind: 'unsupported_input', retryable: false, message }\n  if (/missing|not found|enoent|visual media|asset/.test(s)) return { kind: 'missing_asset', retryable: false, message }\n  if (/429|rate|timeout|timed out|temporar|econn|network|internet|fetch failed/.test(s)) return { kind: /econn|network|internet|fetch/.test(s) ? 'connection' : 'temporary', retryable: true, message }\n  if (step === 'download') return { kind: 'download', retryable: true, message }\n  if (step === 'transcribe') return { kind: 'transcription', retryable: true, message }\n  if (step === 'render' || step === 'quality-check') return { kind: 'export', retryable: true, message }\n  if (step === 'prepare' || step === 'edit') return { kind: 'editing', retryable: false, message }\n  return { kind: 'user_action', retryable: false, message }\n}\n",
    "export function classifyAutomationError(error: unknown, step = ''): { kind: AutomationErrorKind; retryable: boolean; message: string } {\n  const message = error instanceof Error ? error.message : String(error)\n  const s = message.toLowerCase()\n  if (/enospc|disk|space/.test(s)) return { kind: 'storage', retryable: false, message }\n  if (/api key|401|auth|credential|sign.?in|login required|cookies? required|confirm you.?re not a bot/.test(s)) return { kind: 'authentication', retryable: false, message }\n  if (/unsupported|not available yet/.test(s)) return { kind: 'unsupported_input', retryable: false, message }\n  if (/missing|not found|enoent|visual media|asset/.test(s)) return { kind: 'missing_asset', retryable: false, message }\n  if (step === 'download' && /403|forbidden|429|rate|timeout|timed out|temporar|econn|network|internet|fetch failed/.test(s)) {\n    return { kind: /econn|network|internet|fetch/.test(s) ? 'connection' : 'download', retryable: true, message }\n  }\n  if (/429|rate|timeout|timed out|temporar|econn|network|internet|fetch failed/.test(s)) return { kind: /econn|network|internet|fetch/.test(s) ? 'connection' : 'temporary', retryable: true, message }\n  if (step === 'download') return { kind: 'download', retryable: true, message }\n  if (step === 'transcribe') return { kind: 'transcription', retryable: true, message }\n  if (step === 'render' || step === 'quality-check') return { kind: 'export', retryable: true, message }\n  if (step === 'prepare' || step === 'edit') return { kind: 'editing', retryable: false, message }\n  return { kind: 'user_action', retryable: false, message }\n}\n\nfunction uploadedMatch(video: ScrapedVideo, uploads: Array<{ youtubeVideoId?: string; title: string }>, threshold: number): { matched: boolean; reason?: string } {\n  const exact = uploads.find((upload) => upload.youtubeVideoId === video.id)\n  if (exact) return { matched: true, reason: `exact upload id (${exact.title})` }\n  let bestTitle = ''\n  let best = 0\n  for (const upload of uploads) {\n    const score = titleMatchScore(video.title, upload.title)\n    if (score > best) { best = score; bestTitle = upload.title }\n  }\n  return best >= threshold ? { matched: true, reason: `${Math.round(best * 100)}% title match (${bestTitle})` } : { matched: false }\n}\n",
)
replace_once(
    "electron/services/automation-supervisor.ts",
    "    style: styles.has(draft.config?.style) ? draft.config.style : 'Clean',\n    captionPreset: typeof draft.config?.captionPreset === 'string' ? draft.config.captionPreset.slice(0, 80) : 'Hormozi',\n    aspectRatios: ratios.length ? ratios : ['16:9'],",
    "    style: styles.has(draft.config?.style) ? draft.config.style : 'Clean',\n    captionPreset: typeof draft.config?.captionPreset === 'string' ? draft.config.captionPreset.slice(0, 80) : 'Hormozi',\n    captionFont: typeof draft.config?.captionFont === 'string' ? draft.config.captionFont.slice(0, 80) : source?.captionFont ?? 'Montserrat',\n    captionAnim: typeof draft.config?.captionAnim === 'string' ? draft.config.captionAnim.slice(0, 80) : source?.captionAnim ?? 'Pop-in',\n    captionLines: draft.config?.captionLines === 2 || draft.config?.captionLines === 3 ? draft.config.captionLines : 1,\n    captionPosition: draft.config?.captionPosition === 'top' || draft.config?.captionPosition === 'middle' ? draft.config.captionPosition : 'bottom',\n    captionPace: draft.config?.captionPace === 'word' || draft.config?.captionPace === 'phrase' ? draft.config.captionPace : 'auto',\n    captionHighlightColor: typeof draft.config?.captionHighlightColor === 'string' ? draft.config.captionHighlightColor.slice(0, 32) : source?.captionHighlightColor,\n    captionBoxColor: typeof draft.config?.captionBoxColor === 'string' ? draft.config.captionBoxColor.slice(0, 32) : source?.captionBoxColor,\n    captionWordsPerPage: draft.config?.captionWordsPerPage === 1 || draft.config?.captionWordsPerPage === 3 ? draft.config.captionWordsPerPage : 2,\n    imageMode: draft.config?.imageMode === 'sequence' ? 'sequence' : 'pool',\n    crossfadeSec: Math.max(0, Math.min(3, Number(draft.config?.crossfadeSec) || 0.8)),\n    overlay: {\n      bottom: !!draft.config?.overlay?.bottom, top: !!draft.config?.overlay?.top,\n      left: !!draft.config?.overlay?.left, right: !!draft.config?.overlay?.right,\n      intensity: Math.max(0, Math.min(100, Number(draft.config?.overlay?.intensity) || 50))\n    },\n    brollPoolKey: typeof draft.config?.brollPoolKey === 'string' ? draft.config.brollPoolKey.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 160) : '',\n    brollDensity: draft.config?.brollDensity === 'full' || draft.config?.brollDensity === 'keywords' ? draft.config.brollDensity : 'sparse',\n    brollPoolSize: Math.max(1, Math.min(200, Number(draft.config?.brollPoolSize) || 18)),\n    brollMode: draft.config?.brollMode === 'overlay' ? 'overlay' : 'full',\n    brollShuffle: draft.config?.brollShuffle !== false,\n    aspectRatios: ratios.length ? ratios : ['16:9'],",
)
replace_once(
    "electron/services/automation-supervisor.ts",
    "      minDurationSec: Math.max(0, Math.min(36_000, Number(rawRules?.minDurationSec) || 0)),\n      skipDownloaded: rawRules?.skipDownloaded !== false,\n      continueOnError: rawRules?.continueOnError !== false,",
    "      minDurationSec: Math.max(0, Math.min(36_000, Number(rawRules?.minDurationSec) || 0)),\n      skipDownloaded: rawRules?.skipDownloaded !== false,\n      skipUploaded: rawRules?.skipUploaded !== false,\n      downloadDelaySec: Math.max(0, Math.min(30, Number(rawRules?.downloadDelaySec) || 3)),\n      continueOnError: rawRules?.continueOnError !== false,",
)
replace_once(
    "electron/services/automation-supervisor.ts",
    "  if (draft.config.rules.autoBroll && !hasConfiguredBrollSource(getSettings())) warnings.push('No stock B-roll provider is configured. A warmed local B-roll pool is required or rendering will pause for attention.')",
    "  if (draft.config.rules.skipUploaded && draft.config.sourceKind === 'saved-source' && !source?.linkedMyChannelId) {\n    warnings.push('Uploaded-video skipping needs this source linked to one of My Channels. The job will continue without that check.')\n  }\n  const cachedPool = draft.config.brollPoolKey ? cachedBrollClipCount(draft.config.brollPoolKey) : 0\n  if (draft.config.rules.autoBroll && draft.config.brollPoolKey && cachedPool === 0) warnings.push('The selected B-roll pool is empty; warm it first or keep a stock provider configured.')\n  if (draft.config.rules.autoBroll && !hasConfiguredBrollSource(getSettings()) && cachedPool === 0) warnings.push('No stock B-roll provider or warmed selected pool is available. Rendering may pause for attention.')",
)
replace_once(
    "electron/services/automation-supervisor.ts",
    "        const failure = classifyError(error, step.key)\n        const attempts = current.attempts + 1\n        if (failure.retryable && attempts < step.maxAttempts) {\n          const delay = Math.min(5_000, 500 * (2 ** (attempts - 1)))",
    "        const failure = classifyAutomationError(error, step.key)\n        const attempts = current.attempts + 1\n        if (failure.retryable && attempts < step.maxAttempts) {\n          const delay = step.key === 'download'\n            ? Math.min(60_000, 10_000 * (2 ** (attempts - 1)))\n            : Math.min(5_000, 500 * (2 ** (attempts - 1)))",
)
replace_once(
    "electron/services/automation-supervisor.ts",
    "    const videos = await sourceVideos(config.sourceUrl, config.sourceOrder, config.selectedVideoIds.length ? 50 : config.sourceCount)\n    const explicit = new Set(config.selectedVideoIds)\n    const selected = videos\n      .filter((v) => explicit.size ? explicit.has(v.id) : v.durationSec >= config.rules.minDurationSec)\n      .slice(0, explicit.size || config.sourceCount)\n    if (!selected.length) throw new Error('No source videos matched the selection rules.')",
    "    const explicit = new Set(config.selectedVideoIds)\n    const requestCount = explicit.size ? 50 : Math.min(50, Math.max(config.sourceCount * 5, config.sourceCount + 10))\n    const videos = await sourceVideos(config.sourceUrl, config.sourceOrder, requestCount)\n    const source = repos.sourceChannel(config.sourceId)\n    const uploads = config.rules.skipUploaded && source?.linkedMyChannelId ? repos.getUploads(source.linkedMyChannelId) : []\n    const threshold = getSettings().detection?.confirmBand?.[1] ?? DEFAULT_UPLOAD_MATCH_THRESHOLD\n    const selected: ScrapedVideo[] = []\n    const skipped: Array<{ video: ScrapedVideo; reason: string }> = []\n    for (const video of videos) {\n      if (explicit.size && !explicit.has(video.id)) continue\n      if (!explicit.size && video.durationSec < config.rules.minDurationSec) continue\n      const match = uploads.length ? uploadedMatch(video, uploads, threshold) : { matched: false }\n      if (match.matched) {\n        skipped.push({ video, reason: match.reason || 'uploaded match' })\n        continue\n      }\n      selected.push(video)\n      if (selected.length >= (explicit.size || config.sourceCount)) break\n    }\n    if (!selected.length) throw new Error('No source videos matched the selection rules.')\n    skipped.forEach(({ video, reason }) => log(job.id, `Skipped already-uploaded candidate \"${video.title}\" — ${reason}.`, 'warning'))",
)
replace_once(
    "electron/services/automation-supervisor.ts",
    "    log(job.id, `Selected ${selected.length} video${selected.length === 1 ? '' : 's'} from ${config.sourceName}.`)\n    return { selected: selected.map((v) => v.id), count: selected.length }",
    "    log(job.id, `Inspected ${videos.length} candidate${videos.length === 1 ? '' : 's'}; selected ${selected.length} eligible video${selected.length === 1 ? '' : 's'} from ${config.sourceName}${skipped.length ? ` and skipped ${skipped.length} uploaded match${skipped.length === 1 ? '' : 'es'}` : ''}.`)\n    return { selected: selected.map((v) => v.id), count: selected.length, inspected: videos.length, skippedUploaded: skipped.length }",
)
replace_once(
    "electron/services/automation-supervisor.ts",
    "      const video = byId.get(item.sourceVideoId)\n      if (!video) throw new Error('The selected source video is no longer available.')\n      const [download] = await startDownloads([video], { bitrate: 192, sourceUrl: config.sourceUrl })",
    "      const video = byId.get(item.sourceVideoId)\n      if (!video) throw new Error('The selected source video is no longer available.')\n      const delayMs = Math.round((config.rules.downloadDelaySec ?? 3) * 1000)\n      if (delayMs > 0) {\n        const jitter = Math.floor(Math.random() * 1000)\n        const totalDelay = delayMs + jitter\n        log(job.id, `Pacing YouTube request for ${Math.max(1, Math.round(totalDelay / 1000))} seconds before downloading ${item.title}.`, 'info', item)\n        await new Promise((resolveDelay) => setTimeout(resolveDelay, totalDelay))\n      }\n      const [download] = await startDownloads([video], { bitrate: 192, sourceUrl: config.sourceUrl })",
)
replace_once(
    "electron/services/automation-supervisor.ts",
    "      repos.updateProject(project.id, {\n        captionPreset: config.captionPreset,\n        captionAspect: config.aspectRatios[0] ?? '16:9',\n        betaOpts: {\n          ...beta,\n          style: config.style,\n          autoHighlight: config.style !== 'None',\n          autoZoom: { atStart: config.style !== 'None', atKeyPhrases: config.style === 'Intense' },\n          broll: { ...beta.broll, enabled: config.rules.autoBroll }\n        }\n      })",
    "      repos.updateProject(project.id, {\n        captionPreset: config.captionPreset,\n        captionFont: config.captionFont ?? 'Montserrat',\n        captionAnim: config.captionAnim ?? 'Pop-in',\n        captionAspect: config.aspectRatios[0] ?? '16:9',\n        captionLines: config.captionLines ?? 1,\n        captionPosition: config.captionPosition ?? 'bottom',\n        captionPace: config.captionPace ?? 'auto',\n        captionHighlightColor: config.captionHighlightColor,\n        captionBoxColor: config.captionBoxColor,\n        captionWordsPerPage: config.captionWordsPerPage ?? 2,\n        imageMode: config.imageMode ?? 'pool',\n        crossfade: config.crossfadeSec ?? 0.8,\n        betaOpts: {\n          ...beta,\n          style: config.style,\n          autoHighlight: config.style !== 'None',\n          overlay: config.overlay ?? beta.overlay,\n          autoZoom: { atStart: config.style !== 'None', atKeyPhrases: config.style === 'Intense' },\n          broll: {\n            ...beta.broll,\n            enabled: config.rules.autoBroll,\n            density: config.brollDensity ?? beta.broll.density,\n            poolSize: config.brollPoolSize ?? beta.broll.poolSize,\n            mode: config.brollMode ?? beta.broll.mode,\n            poolKey: config.brollPoolKey || undefined,\n            shuffle: config.brollShuffle !== false,\n            shuffleSeed: project.seed\n          }\n        }\n      })",
)

write("src/screens/AutomationPickers.tsx", textwrap.dedent(r'''
import { useMemo, useState } from 'react'
import type { LibraryAsset, SourceChannel } from '@shared/types'
import { isCssImageValue, mediaSrc } from '../lib/media'
import { Btn, SectionLabel } from '../components/ui/kit'

const card: React.CSSProperties = {
  border: '1px solid var(--border-2)', borderRadius: 12, background: 'var(--bg-card)',
  color: 'var(--text)', padding: 11, textAlign: 'left', cursor: 'pointer'
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }): JSX.Element {
  return <div role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(5,7,10,.78)', display: 'grid', placeItems: 'center', padding: 22 }}>
    <section role="dialog" aria-modal="true" aria-label={title} style={{ width: 'min(920px,96vw)', maxHeight: '86vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', border: '1px solid var(--border-2)', borderRadius: 16, background: 'var(--bg-panel)', boxShadow: '0 24px 80px rgba(0,0,0,.45)' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}><SectionLabel style={{ flex: 1 }}>{title}</SectionLabel><Btn size="sm" onClick={onClose}>Close</Btn></header>
      <div style={{ padding: 16, overflowY: 'auto' }}>{children}</div>
    </section>
  </div>
}

function SourceLogo({ source }: { source: SourceChannel }): JSX.Element {
  const avatar = source.avatar || ''
  const src = mediaSrc(avatar)
  const background = isCssImageValue(avatar) ? avatar : 'linear-gradient(135deg,var(--accent),var(--accent-deep))'
  return <div style={{ width: 54, height: 54, borderRadius: 13, flex: 'none', overflow: 'hidden', display: 'grid', placeItems: 'center', background, color: 'var(--accent-ink)', fontWeight: 900, fontSize: 17 }}>
    {src ? <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : (source.name || source.handle || 'S').replace(/^@/, '').slice(0, 2).toUpperCase()}
  </div>
}

export function SourcePickerModal({ sources, selectedId, onSelect, onClose }: {
  sources: SourceChannel[]
  selectedId: string
  onSelect: (source: SourceChannel) => void
  onClose: () => void
}): JSX.Element {
  return <Modal title="Choose a saved source" onClose={onClose}>
    <div style={{ color: 'var(--text-dim)', fontSize: 11, marginBottom: 12 }}>Choose the channel this automation should inspect. The selection card shows the source identity before any videos are queued.</div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(250px,1fr))', gap: 10 }}>
      {sources.map((source) => {
        const selected = source.id === selectedId
        return <button key={source.id} type="button" onClick={() => onSelect(source)} style={{ ...card, borderColor: selected ? 'var(--accent)' : undefined, background: selected ? 'var(--accent-soft)' : card.background }}>
          <div style={{ display: 'flex', gap: 11, alignItems: 'center' }}><SourceLogo source={source} /><div style={{ minWidth: 0, flex: 1 }}><strong className="me-ellipsis" style={{ display: 'block', color: 'var(--text-bright)', fontSize: 12.5 }}>{source.name || source.handle || 'Untitled source'}</strong><span className="me-ellipsis" style={{ display: 'block', color: 'var(--text-dim)', fontSize: 10.5, marginTop: 3 }}>{source.handle || source.url}</span><span style={{ display: 'block', color: 'var(--text-faint)', fontSize: 9.5, marginTop: 6 }}>{source.videoCount ?? 0} cached videos{source.linkedMyChannelId ? ' · upload check linked' : ''}</span></div>{selected && <span style={{ color: 'var(--accent)', fontWeight: 900 }}>✓</span>}</div>
        </button>
      })}
    </div>
  </Modal>
}

function AssetThumb({ path }: { path: string }): JSX.Element {
  const src = mediaSrc(path)
  return <div style={{ width: '100%', aspectRatio: '16/10', background: '#141820', overflow: 'hidden' }}>{src && <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}</div>
}

export function SelectedAssetStrip({ paths, onRemove, onClear }: { paths: string[]; onRemove: (path: string) => void; onClear: () => void }): JSX.Element {
  if (!paths.length) return <div style={{ color: 'var(--text-faint)', fontSize: 10.5, marginTop: 9 }}>No assets selected</div>
  return <div style={{ marginTop: 10 }}><div style={{ display: 'flex', alignItems: 'center', marginBottom: 7 }}><span style={{ color: 'var(--ok-2)', fontSize: 10.5, flex: 1 }}>{paths.length} selected</span><button type="button" className="automation-link-button" onClick={onClear}>Clear all</button></div><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(82px,1fr))', gap: 7 }}>{paths.map((path) => <div key={path} title={path} style={{ position: 'relative', border: '1px solid var(--border)', borderRadius: 9, overflow: 'hidden' }}><AssetThumb path={path} /><button type="button" aria-label={`Remove ${path.split(/[\\/]/).pop()}`} onClick={() => onRemove(path)} style={{ position: 'absolute', top: 4, right: 4, width: 21, height: 21, borderRadius: 999, border: 0, background: 'rgba(0,0,0,.75)', color: 'white', cursor: 'pointer' }}>×</button></div>)}</div></div>
}

export function AssetLibraryModal({ assets, current, onApply, onClose }: {
  assets: LibraryAsset[]
  current: string[]
  onApply: (paths: string[]) => void
  onClose: () => void
}): JSX.Element {
  const [selected, setSelected] = useState(() => new Set(current))
  const grouped = useMemo(() => {
    const map = new Map<string, LibraryAsset[]>()
    for (const asset of assets) map.set(asset.channel || 'Unsorted', [...(map.get(asset.channel || 'Unsorted') ?? []), asset])
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [assets])
  const toggle = (path: string): void => setSelected((before) => { const next = new Set(before); if (next.has(path)) next.delete(path); else next.add(path); return next })
  return <Modal title="Previously used assets" onClose={onClose}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}><div style={{ color: 'var(--text-dim)', fontSize: 11, flex: 1 }}>Browse channel folders, inspect thumbnails, then apply the selection. Closing the modal discards changes.</div><Btn size="sm" onClick={() => setSelected(new Set())}>Clear</Btn><Btn size="sm" variant="primary" onClick={() => { onApply([...selected]); onClose() }}>Apply {selected.size}</Btn></div>
    {grouped.length === 0 ? <div style={{ color: 'var(--text-faint)', padding: 20, textAlign: 'center' }}>No remembered assets yet.</div> : grouped.map(([channel, channelAssets]) => <section key={channel} style={{ marginBottom: 18 }}><div style={{ color: 'var(--text-bright)', fontWeight: 700, fontSize: 11.5, marginBottom: 8 }}>{channel} <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>· {channelAssets.length}</span></div><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))', gap: 8 }}>{channelAssets.map((asset) => { const on = selected.has(asset.path); return <button key={asset.path} type="button" onClick={() => toggle(asset.path)} title={asset.path} style={{ ...card, padding: 0, overflow: 'hidden', position: 'relative', borderColor: on ? 'var(--accent)' : undefined }}><AssetThumb path={asset.path} /><div className="me-ellipsis" style={{ padding: '7px 8px', fontSize: 9.5 }}>{asset.path.split(/[\\/]/).pop()}</div>{on && <span style={{ position: 'absolute', top: 5, right: 5, width: 20, height: 20, display: 'grid', placeItems: 'center', borderRadius: 999, background: 'var(--accent)', color: 'var(--accent-ink)', fontWeight: 900 }}>✓</span>}</button> })}</div></section>)}
  </Modal>
}
''').lstrip())

replace_once(
    "src/screens/Profiles.tsx",
    "import { Banner, Btn, EmptyState, Panel, Section, SectionLabel, ToggleRow } from '../components/ui/kit'\nimport { AUTOMATION_GOALS, buildAutomationWorkflow, formatGoal } from '@shared/automation'",
    "import { Banner, Btn, EmptyState, Panel, Section, SectionLabel, ToggleRow } from '../components/ui/kit'\nimport { AssetLibraryModal, SelectedAssetStrip, SourcePickerModal } from './AutomationPickers'\nimport { AUTOMATION_GOALS, buildAutomationWorkflow, formatGoal } from '@shared/automation'",
)
replace_once(
    "src/screens/Profiles.tsx",
    "  LibraryAsset,\n  ScrapeOrder,",
    "  LibraryAsset,\n  Niche,\n  ScrapeOrder,",
)
replace_once(
    "src/screens/Profiles.tsx",
    "  const [assets, setAssets] = useState<string[]>([])\n  const [libraryAssets, setLibraryAssets] = useState<LibraryAsset[]>([])\n  const [style, setStyle] = useState<VideoStyle>('Clean')\n  const [captionPreset, setCaptionPreset] = useState('Hormozi')\n  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('16:9')\n  const [captions, setCaptions] = useState(!!settings.transcription.apiKey.trim())\n  const [autoBroll, setAutoBroll] = useState(false)\n  const [continueOnError, setContinueOnError] = useState(true)\n  const [skipDownloaded, setSkipDownloaded] = useState(true)",
    "  const [assets, setAssets] = useState<string[]>([])\n  const [libraryAssets, setLibraryAssets] = useState<LibraryAsset[]>([])\n  const [niches, setNiches] = useState<Niche[]>([])\n  const [sourcePickerOpen, setSourcePickerOpen] = useState(false)\n  const [assetPickerOpen, setAssetPickerOpen] = useState(false)\n  const [style, setStyle] = useState<VideoStyle>('Clean')\n  const [captionPreset, setCaptionPreset] = useState('Hormozi')\n  const [captionFont, setCaptionFont] = useState('Montserrat')\n  const [captionAnim, setCaptionAnim] = useState('Pop-in')\n  const [captionLines, setCaptionLines] = useState<1 | 2 | 3>(1)\n  const [captionPosition, setCaptionPosition] = useState<'top' | 'middle' | 'bottom'>('bottom')\n  const [captionPace, setCaptionPace] = useState<'auto' | 'word' | 'phrase'>('auto')\n  const [captionHighlightColor, setCaptionHighlightColor] = useState('#f5b323')\n  const [captionBoxColor, setCaptionBoxColor] = useState('#111111')\n  const [captionWordsPerPage, setCaptionWordsPerPage] = useState<1 | 2 | 3>(2)\n  const [imageMode, setImageMode] = useState<'sequence' | 'pool'>('pool')\n  const [crossfadeSec, setCrossfadeSec] = useState(0.8)\n  const [gradientEdge, setGradientEdge] = useState<'none' | 'bottom' | 'top' | 'left' | 'right'>('bottom')\n  const [gradientIntensity, setGradientIntensity] = useState(50)\n  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('16:9')\n  const [captions, setCaptions] = useState(!!settings.transcription.apiKey.trim())\n  const [autoBroll, setAutoBroll] = useState(false)\n  const [brollPoolKey, setBrollPoolKey] = useState('')\n  const [brollDensity, setBrollDensity] = useState<'full' | 'sparse' | 'keywords'>('sparse')\n  const [brollPoolSize, setBrollPoolSize] = useState(18)\n  const [brollMode, setBrollMode] = useState<'full' | 'overlay'>('full')\n  const [brollShuffle, setBrollShuffle] = useState(true)\n  const [continueOnError, setContinueOnError] = useState(true)\n  const [skipDownloaded, setSkipDownloaded] = useState(true)\n  const [skipUploaded, setSkipUploaded] = useState(true)\n  const [downloadDelaySec, setDownloadDelaySec] = useState(3)",
)
replace_once(
    "src/screens/Profiles.tsx",
    "    void Promise.all([loadSources(), loadAutomationJobs(), window.api.assets.list().then(setLibraryAssets)])",
    "    void Promise.all([loadSources(), loadAutomationJobs(), window.api.assets.list().then(setLibraryAssets), window.api.niche.list().then(setNiches)])",
)
replace_once(
    "src/screens/Profiles.tsx",
    "      style,\n      captionPreset,\n      aspectRatios: [aspectRatio],\n      execution: 'local',\n      rules: {\n        minDurationSec: minDuration, skipDownloaded, continueOnError, maxRetries: retries,",
    "      style,\n      captionPreset,\n      captionFont, captionAnim, captionLines, captionPosition, captionPace,\n      captionHighlightColor, captionBoxColor, captionWordsPerPage,\n      imageMode, crossfadeSec,\n      overlay: {\n        bottom: gradientEdge === 'bottom', top: gradientEdge === 'top',\n        left: gradientEdge === 'left', right: gradientEdge === 'right', intensity: gradientIntensity\n      },\n      brollPoolKey, brollDensity, brollPoolSize, brollMode, brollShuffle,\n      aspectRatios: [aspectRatio],\n      execution: 'local',\n      rules: {\n        minDurationSec: minDuration, skipDownloaded, skipUploaded, downloadDelaySec, continueOnError, maxRetries: retries,",
)
replace_once(
    "src/screens/Profiles.tsx",
    "  }), [sourceLabel, goal, sourceKind, source, sourceUrl, sourceOrder, sourceCount, localMediaPaths, selectedVideoIds, assets, style, captionPreset, aspectRatio, minDuration, skipDownloaded, continueOnError, retries, reserveGb, captions, autoBroll, desktopNotify, webhookNotify])",
    "  }), [sourceLabel, goal, sourceKind, source, sourceUrl, sourceOrder, sourceCount, localMediaPaths, selectedVideoIds, assets, style, captionPreset, captionFont, captionAnim, captionLines, captionPosition, captionPace, captionHighlightColor, captionBoxColor, captionWordsPerPage, imageMode, crossfadeSec, gradientEdge, gradientIntensity, brollPoolKey, brollDensity, brollPoolSize, brollMode, brollShuffle, aspectRatio, minDuration, skipDownloaded, skipUploaded, downloadDelaySec, continueOnError, retries, reserveGb, captions, autoBroll, desktopNotify, webhookNotify])",
)
replace_once(
    "src/screens/Profiles.tsx",
    "  const goReview = async (): Promise<void> => {",
    "  const resetSetup = (): void => {\n    setStage(0); setGoal('source-to-export'); setSourceKind('saved-source'); setSourceUrl('')\n    setLocalMediaPaths([]); setSelectedVideoIds([]); setAssets([]); setPreflight(null); setSetupError('')\n    setStyle('Clean'); setCaptionPreset('Hormozi'); setCaptionFont('Montserrat'); setCaptionAnim('Pop-in')\n    setCaptionLines(1); setCaptionPosition('bottom'); setCaptionPace('auto'); setImageMode('pool'); setCrossfadeSec(0.8)\n    setGradientEdge('bottom'); setGradientIntensity(50); setAutoBroll(false); setBrollPoolKey('')\n    setBrollDensity('sparse'); setBrollPoolSize(18); setBrollMode('full'); setBrollShuffle(true)\n    setSkipUploaded(true); setDownloadDelaySec(3); setSourceCount(3); setSourceOrder('Latest')\n    setSourcePickerOpen(false); setAssetPickerOpen(false); setView('setup')\n  }\n  const goReview = async (): Promise<void> => {",
)
replace_once(
    "src/screens/Profiles.tsx",
    "    setCaptionPreset(job.config.captionPreset); setAspectRatio(job.config.aspectRatios[0] ?? '16:9'); setCaptions(job.config.rules.captions)\n    setAutoBroll(job.config.rules.autoBroll); setContinueOnError(job.config.rules.continueOnError); setSkipDownloaded(job.config.rules.skipDownloaded)",
    "    setCaptionPreset(job.config.captionPreset); setAspectRatio(job.config.aspectRatios[0] ?? '16:9'); setCaptions(job.config.rules.captions)\n    setCaptionFont(job.config.captionFont ?? 'Montserrat'); setCaptionAnim(job.config.captionAnim ?? 'Pop-in')\n    setCaptionLines(job.config.captionLines ?? 1); setCaptionPosition(job.config.captionPosition ?? 'bottom'); setCaptionPace(job.config.captionPace ?? 'auto')\n    setCaptionHighlightColor(job.config.captionHighlightColor ?? '#f5b323'); setCaptionBoxColor(job.config.captionBoxColor ?? '#111111'); setCaptionWordsPerPage(job.config.captionWordsPerPage ?? 2)\n    setImageMode(job.config.imageMode ?? 'pool'); setCrossfadeSec(job.config.crossfadeSec ?? 0.8)\n    const overlay = job.config.overlay\n    setGradientEdge(overlay?.bottom ? 'bottom' : overlay?.top ? 'top' : overlay?.left ? 'left' : overlay?.right ? 'right' : 'none')\n    setGradientIntensity(overlay?.intensity ?? 50)\n    setBrollPoolKey(job.config.brollPoolKey ?? ''); setBrollDensity(job.config.brollDensity ?? 'sparse'); setBrollPoolSize(job.config.brollPoolSize ?? 18); setBrollMode(job.config.brollMode ?? 'full'); setBrollShuffle(job.config.brollShuffle !== false)\n    setAutoBroll(job.config.rules.autoBroll); setContinueOnError(job.config.rules.continueOnError); setSkipDownloaded(job.config.rules.skipDownloaded)\n    setSkipUploaded(job.config.rules.skipUploaded !== false); setDownloadDelaySec(job.config.rules.downloadDelaySec ?? 3)",
)
replace_once(
    "src/screens/Profiles.tsx",
    "<button type=\"button\" role=\"tab\" aria-selected={view === 'setup'} onClick={() => setView('setup')} className={view === 'setup' ? 'active' : ''}>New automation</button>",
    "<button type=\"button\" role=\"tab\" aria-selected={view === 'setup'} onClick={resetSetup} className={view === 'setup' ? 'active' : ''}>New automation</button>",
)
regex_once(
    "src/screens/Profiles.tsx",
    r'<Field label="Saved source"><select value=\{sourceId\}.*?</select></Field>',
    "<Field label=\"Saved source\"><button type=\"button\" onClick={() => setSourcePickerOpen(true)} style={{ ...input, textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ flex: 1 }}>{source?.name || source?.handle || 'Choose a source'}</span><span style={{ color: 'var(--accent)' }}>Browse cards…</span></button></Field>",
)
replace_once(
    "src/screens/Profiles.tsx",
    "<input type=\"file\" accept=\"audio/*,video/*,.mkv,.webm\" multiple onChange={(event) => chooseFiles(event.target.files, setLocalMediaPaths)} />",
    "<input type=\"file\" accept=\"audio/*,video/*,.mkv,.webm\" multiple onChange={(event) => { chooseFiles(event.target.files, setLocalMediaPaths); event.currentTarget.value = '' }} />",
)
regex_once(
    "src/screens/Profiles.tsx",
    r'<Panel><SectionLabel>Visual assets</SectionLabel>.*?</Panel>\n        <Panel><SectionLabel>Editing and export</SectionLabel>.*?</Panel>',
    "<Panel><SectionLabel>Visual assets</SectionLabel><div className=\"automation-help\">A new automation starts empty. Add new images or open the channel-grouped thumbnail library.</div><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><label className=\"automation-file-picker\"><input type=\"file\" accept=\"image/*\" multiple onChange={(event) => { chooseFiles(event.target.files, setAssets); event.currentTarget.value = '' }} />＋ Add new assets</label><Btn variant=\"soft\" onClick={() => setAssetPickerOpen(true)} disabled={!libraryAssets.length}>Browse previous assets</Btn></div><SelectedAssetStrip paths={assets} onRemove={(path) => setAssets((current) => current.filter((candidate) => candidate !== path))} onClear={() => setAssets([])} /><ToggleRow label=\"Use automatic B-roll\" hint=\"Choose a warmed saved pool below or allow configured stock providers.\" on={autoBroll} onToggle={() => setAutoBroll((value) => !value)} />{autoBroll && <div className=\"automation-config-grid\"><Field label=\"Saved B-roll pool\"><select value={brollPoolKey} onChange={(event) => setBrollPoolKey(event.target.value)} style={input}><option value=\"\">All pools / live stock</option>{niches.map((niche) => <option key={niche.id} value={`niche-${niche.id}`}>{niche.name}</option>)}</select></Field><Field label=\"Clip order\"><select value={brollShuffle ? 'shuffle' : 'ranked'} onChange={(event) => setBrollShuffle(event.target.value === 'shuffle')} style={input}><option value=\"shuffle\">Shuffle per video</option><option value=\"ranked\">Same relevance order</option></select></Field><Field label=\"Density\"><select value={brollDensity} onChange={(event) => setBrollDensity(event.target.value as typeof brollDensity)} style={input}><option value=\"full\">Full</option><option value=\"sparse\">Sparse</option><option value=\"keywords\">Keywords</option></select></Field><Field label=\"Pool size\"><input type=\"number\" min={1} max={200} value={brollPoolSize} onChange={(event) => setBrollPoolSize(Math.max(1, Math.min(200, Number(event.target.value) || 18)))} style={input} /></Field><Field label=\"B-roll mode\"><select value={brollMode} onChange={(event) => setBrollMode(event.target.value as typeof brollMode)} style={input}><option value=\"full\">Replace visual track</option><option value=\"overlay\">Overlay mode</option></select></Field></div>}</Panel>\n        <Panel><SectionLabel>Editing and export</SectionLabel><div className=\"automation-style-grid\">{STYLES.map((candidate) => <button type=\"button\" key={candidate} onClick={() => setStyle(candidate)} className={style === candidate ? 'active' : ''}>{candidate}</button>)}</div><div className=\"automation-config-grid\"><Field label=\"Subtitle preset\"><select value={captionPreset} onChange={(event) => setCaptionPreset(event.target.value)} style={input}><option>Hormozi</option><option>Submagic</option><option>Clean</option><option>Minimal</option></select></Field><Field label=\"Caption font\"><select value={captionFont} onChange={(event) => setCaptionFont(event.target.value)} style={input}><option>Montserrat</option><option>Anton</option><option>Hanken Grotesk</option><option>Space Grotesk</option></select></Field><Field label=\"Caption animation\"><select value={captionAnim} onChange={(event) => setCaptionAnim(event.target.value)} style={input}><option>Pop-in</option><option>Fade</option><option>None</option></select></Field><Field label=\"Caption position\"><select value={captionPosition} onChange={(event) => setCaptionPosition(event.target.value as typeof captionPosition)} style={input}><option value=\"top\">Top</option><option value=\"middle\">Middle</option><option value=\"bottom\">Bottom</option></select></Field><Field label=\"Caption lines\"><select value={captionLines} onChange={(event) => setCaptionLines(Number(event.target.value) as 1 | 2 | 3)} style={input}><option value={1}>1 line</option><option value={2}>2 lines</option><option value={3}>3 lines</option></select></Field><Field label=\"Caption pace\"><select value={captionPace} onChange={(event) => setCaptionPace(event.target.value as typeof captionPace)} style={input}><option value=\"auto\">Automatic</option><option value=\"word\">Word</option><option value=\"phrase\">Phrase</option></select></Field><Field label=\"Highlight colour\"><input type=\"color\" value={captionHighlightColor} onChange={(event) => setCaptionHighlightColor(event.target.value)} style={{ ...input, height: 39, padding: 4 }} /></Field><Field label=\"Box colour\"><input type=\"color\" value={captionBoxColor} onChange={(event) => setCaptionBoxColor(event.target.value)} style={{ ...input, height: 39, padding: 4 }} /></Field><Field label=\"Words per caption\"><select value={captionWordsPerPage} onChange={(event) => setCaptionWordsPerPage(Number(event.target.value) as 1 | 2 | 3)} style={input}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></Field><Field label=\"Image order\"><select value={imageMode} onChange={(event) => setImageMode(event.target.value as typeof imageMode)} style={input}><option value=\"pool\">Shuffle</option><option value=\"sequence\">In order</option></select></Field><Field label=\"Crossfade seconds\"><input type=\"number\" min={0} max={3} step={0.1} value={crossfadeSec} onChange={(event) => setCrossfadeSec(Math.max(0, Math.min(3, Number(event.target.value) || 0)))} style={input} /></Field><Field label=\"Legibility gradient\"><select value={gradientEdge} onChange={(event) => setGradientEdge(event.target.value as typeof gradientEdge)} style={input}><option value=\"none\">Off</option><option value=\"bottom\">Bottom</option><option value=\"top\">Top</option><option value=\"left\">Left</option><option value=\"right\">Right</option></select></Field>{gradientEdge !== 'none' && <Field label={`Gradient intensity · ${gradientIntensity}%`}><input type=\"range\" min={0} max={100} value={gradientIntensity} onChange={(event) => setGradientIntensity(Number(event.target.value))} style={{ width: '100%' }} /></Field>}<Field label=\"Export aspect ratio\"><select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as AspectRatio)} style={input}><option value=\"16:9\">16:9 · Landscape</option><option value=\"9:16\">9:16 · Vertical</option><option value=\"1:1\">1:1 · Square</option></select></Field></div><ToggleRow label=\"Transcribe and add captions\" hint={settings.transcription.apiKey.trim() ? 'Uses the configured online transcription service; timed words are stored locally.' : 'Needs a Groq key in Settings. Turn this off to continue without captions.'} on={captions} onToggle={() => setCaptions((value) => !value)} /></Panel>",
)
regex_once(
    "src/screens/Profiles.tsx",
    r'\{stage === 3 && <Panel><SectionLabel>How should the supervisor behave\?</SectionLabel>.*?</Panel>\}',
    "{stage === 3 && <Panel><SectionLabel>How should the supervisor behave?</SectionLabel><div className=\"automation-two-column rules\"><div><ToggleRow label=\"Continue when one item fails\" hint=\"Isolate failed items while the rest of the batch keeps moving.\" on={continueOnError} onToggle={() => setContinueOnError((value) => !value)} /><ToggleRow label=\"Reuse completed downloads\" hint=\"Validate and reuse an existing local download instead of repeating it.\" on={skipDownloaded} onToggle={() => setSkipDownloaded((value) => !value)} />{sourceKind === 'saved-source' && <ToggleRow label=\"Skip videos already uploaded\" hint=\"Uses exact IDs and high-confidence title matches from the linked My Channel, then keeps scanning until the requested count is filled.\" on={skipUploaded} onToggle={() => setSkipUploaded((value) => !value)} />}<ToggleRow label=\"Desktop completion notification\" hint=\"Receive completion or action-needed messages while the window is hidden.\" on={desktopNotify} onToggle={() => setDesktopNotify((value) => !value)} /><ToggleRow label=\"Send configured webhook\" hint={settings.background.webhook ? 'Send a structured completion summary to the configured endpoint.' : 'No webhook is configured in Settings.'} on={webhookNotify} onToggle={() => setWebhookNotify((value) => !value)} disabled={!settings.background.webhook} /></div><div><Field label=\"Automatic retry limit\"><input type=\"number\" min={0} max={8} value={retries} onChange={(event) => setRetries(Math.max(0, Math.min(8, Number(event.target.value) || 0)))} style={input} /></Field>{sourceKind !== 'local-files' && <Field label=\"Safe delay before each download (seconds)\"><input type=\"number\" min={0} max={30} value={downloadDelaySec} onChange={(event) => setDownloadDelaySec(Math.max(0, Math.min(30, Number(event.target.value) || 0)))} style={input} /></Field>}{sourceKind !== 'local-files' && <Field label=\"Minimum duration (minutes)\"><input type=\"number\" min={0} max={600} value={Math.round(minDuration / 60)} onChange={(event) => setMinDuration(Math.max(0, Number(event.target.value) * 60 || 0))} style={input} /></Field>}<Field label=\"Keep free-space reserve (GB)\"><input type=\"number\" min={1} max={100} value={reserveGb} onChange={(event) => setReserveGb(Math.max(1, Number(event.target.value) || 1))} style={input} /></Field></div></div><Section label=\"Advanced automation\" defaultOpen={false}><div className=\"automation-help\">Download 403/429/network failures use bounded retries with increasing delays. Explicit login, cookie, and credential failures stop immediately with an actionable message. Silence removal, filler-word reduction, scheduling, multi-output variants, and post-job sleep/shutdown remain disabled because the current media engine does not expose them safely.</div></Section></Panel>}",
)
replace_once(
    "src/screens/Profiles.tsx",
    "<Btn variant=\"soft\" onClick={() => { setStage(0); setSetupError(''); setView('setup') }}>＋ New automation</Btn>",
    "<Btn variant=\"soft\" onClick={resetSetup}>＋ New automation</Btn>",
)
replace_once(
    "src/screens/Profiles.tsx",
    "    </>}\n  </ScreenPad>",
    "    </>}\n    {sourcePickerOpen && <SourcePickerModal sources={sourceChannels} selectedId={sourceId} onClose={() => setSourcePickerOpen(false)} onSelect={(next) => { setSourceId(next.id); setSelectedVideoIds([]); setAutoBroll(!!next.betaOpts?.broll.enabled); setBrollPoolKey(next.nicheId ? `niche-${next.nicheId}` : ''); setCaptionPreset(next.captionPreset ?? 'Hormozi'); setCaptionFont(next.captionFont ?? 'Montserrat'); setCaptionAnim(next.captionAnim ?? 'Pop-in'); setCaptionLines(next.captionLines ?? 1); setCaptionPosition(next.captionPosition ?? 'bottom'); setCaptionPace(next.captionPace ?? 'auto'); setSourcePickerOpen(false) }} />}\n    {assetPickerOpen && <AssetLibraryModal assets={libraryAssets} current={assets} onApply={setAssets} onClose={() => setAssetPickerOpen(false)} />}\n  </ScreenPad>",
)

write("test/unit/automation-reliability.test.ts", textwrap.dedent("""
import { describe, expect, it } from 'vitest'
import { classifyAutomationError } from '../../electron/services/automation-supervisor'
import { seededBrollOrder } from '../../electron/services/broll'

describe('automation reliability helpers', () => {
  it('retries a download 403 but not an explicit login/cookie failure', () => {
    expect(classifyAutomationError(new Error('HTTP Error 403: Forbidden'), 'download')).toMatchObject({ kind: 'download', retryable: true })
    expect(classifyAutomationError(new Error('Sign in to confirm you are not a bot; cookies required'), 'download')).toMatchObject({ kind: 'authentication', retryable: false })
  })

  it('keeps b-roll shuffles stable per seed and different across projects', () => {
    const clips = Array.from({ length: 12 }, (_, index) => ({ id: `clip-${index}` }))
    const first = seededBrollOrder(clips, 101).map((clip) => clip.id)
    const rerender = seededBrollOrder(clips, 101).map((clip) => clip.id)
    const nextVideo = seededBrollOrder(clips, 202).map((clip) => clip.id)
    expect(rerender).toEqual(first)
    expect(nextVideo).not.toEqual(first)
  })
})
""").lstrip())

print("Automation fixes applied successfully.")
