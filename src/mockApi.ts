// Browser test mock for window.api.
//
// In Electron, the preload script sets window.api before the renderer runs, so this
// mock does nothing. In a plain browser (e.g. `npm run dev:browser`) there is no
// Electron backend, so we install a stateful in-memory backend that lets QA drive
// the full producer workflow in the browser. It never touches SQLite, ffmpeg, or
// the network.

import {
  DEFAULT_BETA_OPTS,
  DEFAULT_SETTINGS,
  asBetaOpts,
  type ActivityRow,
  type AppSettings,
  type AutomationEvent,
  type AutomationJob,
  type AutomationJobDetail,
  type AutomationJobDraft,
  type DownloadProgress,
  type DownloadedVideo,
  type LookAdjust,
  type MotionPreset,
  type MyChannel,
  type NativeApi,
  type Profile,
  type Project,
  type ProjectImage,
  type ProjectImageMotionPatch,
  type RenderProgress,
  type RenderQueueRow,
  type ScrapeOrder,
  type ScrapedChannel,
  type ScrapedVideo,
  type SourceAutomationPatch,
  type SourceChannel,
  type ThumbnailTemplate,
  type TranscriptWord,
  type WorkItem
} from '@shared/types'
import type { GpuRenderSpec } from '@shared/renderSpec'
import { buildAutomationWorkflow } from '@shared/automation'
import type { ImageMotionSpec } from '@shared/renderSpec'
import { resolveCaptionStyle } from '@shared/captionStyle'
import { LOOKS, lookById } from '@shared/looks'
import {
  TALKINGPHOTOS_PARTITION,
  TALKINGPHOTOS_PROVIDER,
  type ProviderCapabilities,
  type ProviderConnection,
  type ProviderJob,
  type ProviderLanguage,
  type ProviderMotion,
  type ProviderVoice,
  type TalkingPhotosCreateInput,
  type TalkingPhotosScriptCreateInput
} from '@shared/talkingphotos'

function grad(a: string, b: string): string {
  return `linear-gradient(135deg,${a},${b})`
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || `item-${Date.now()}`
}

function handleFromUrl(url: string): string {
  const m = url.match(/@([A-Za-z0-9_.-]+)/)
  return m ? `@${m[1]}` : `@${slug(url).slice(0, 24)}`
}

function nameFromHandle(handle: string): string {
  return handle.replace(/^@/, '').replace(/[-_.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (m) => m.toUpperCase())
}

function monoFromName(name: string): string {
  return name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase() || 'CH'
}

function nowTime(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function deepMerge<T extends object>(base: T, patch: Partial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k]
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object'
      ? deepMerge(cur as object, v as object)
      : v
  }
  return out as T
}

function effectiveMotionPreset(p: Project): MotionPreset {
  return p.motionPreset ?? (p.kenBurns ? 'subtle' : 'off')
}

function mockImageMotion(index: number, seed: number, preset: MotionPreset, image?: ProjectImage): ImageMotionSpec | undefined {
  if (preset === 'off') return undefined
  const multiplier = image?.motionAmount == null ? 1 : Math.max(0, Math.min(100, image.motionAmount)) / 50
  const amount = (preset === 'cinematic' ? 0.18 : 0.08) * multiplier
  const pan = (preset === 'cinematic' ? 0.06 : 0.03) * multiplier
  const direction = image?.motionDirection && image.motionDirection !== 'auto' ? image.motionDirection : undefined
  const sidePan = direction === 'left' || direction === 'right' || direction === 'up' || direction === 'down'
  const push = sidePan ? false : direction === 'push' ? true : direction === 'pull' ? false : index % 2 === 0
  return {
    zoomFrom: push || sidePan ? 1 : 1 + amount,
    zoomTo: push ? 1 + amount : sidePan ? 1 + amount * 0.5 : 1,
    panX: direction === 'left' ? -pan : direction === 'right' ? pan : direction === 'up' || direction === 'down' ? 0 : (index % 3 === 0 ? -1 : 1) * pan,
    panY: direction === 'up' ? -pan : direction === 'down' ? pan : direction === 'left' || direction === 'right' ? 0 : (index % 2 === 0 ? 1 : -1) * pan * 0.75,
    ease: 'easeInOutCubic'
  }
}

function imageMotionPreset(image: ProjectImage, project: Project): MotionPreset {
  return image.motionPreset ?? effectiveMotionPreset(project)
}

function splitImages(projectId: string, paths: string[], durationSec: number): ProjectImage[] {
  const safe = paths.length ? paths : ['browser://landscape-1.png', 'browser://landscape-2.png', 'browser://landscape-3.png']
  const step = durationSec / safe.length
  return safe.map((path, i) => ({
    id: `${projectId}-img-${i}`,
    projectId,
    ord: i,
    path,
    thumb: grad(['#23304a', '#143a32', '#3a2330', '#2a2540'][i % 4], '#15171d'),
    rangeStart: Math.round(i * step),
    rangeEnd: Math.round((i + 1) * step),
    manual: false
  }))
}

function installMock(): void {
  let settings: AppSettings = deepMerge(DEFAULT_SETTINGS, {
    accent: 'Amber',
    ambientGlow: true,
    showActivityRail: true,
    outputFolder: '/Browser/MentalEmpire_out',
    beta: { enabled: false, pexelsKey: '', pixabayKey: '', coverrKey: '' },
    integrations: { talkingPhotos: { enabled: true } }
  } as Partial<AppSettings>)
  const appMeta = new Map<string, string>()

  const sourceChannels: SourceChannel[] = [
    { id: 'src-pw', url: 'https://www.youtube.com/@powerwithinofficial-q7d', handle: '@powerwithinofficial-q7d', name: 'Power Within Official', lastScrapedAt: new Date().toISOString(), videoCount: 5, autoWatch: true, sourceOrder: 'Latest', sourceCount: 5, imageMode: 'pool', poolSize: 10, kenBurns: true, captionPreset: 'Hormozi', captionAspect: '16:9', betaOpts: { ...DEFAULT_BETA_OPTS, broll: { ...DEFAULT_BETA_OPTS.broll, enabled: true }, style: 'Cinematic' } },
    { id: 'src-nar', url: 'https://www.youtube.com/@narceo05', handle: '@narceo05', name: 'Narceo', lastScrapedAt: new Date().toISOString(), videoCount: 5 }
  ]

  const channels: MyChannel[] = [
    { id: 'me', name: 'Mental Empire', handle: '@MentalEmpire', mono: 'ME', avatar: grad('#f5b323', '#b9780a'), views: '1.2M', subs: '455', total: 4, linkedSourceId: 'src-pw', source: '@powerwithinofficial-q7d', mapDone: 2, mapTotal: 3, weekDone: 3, weekGoal: 5, monthDone: 9, monthGoal: 20, reminder: 'Fri Jun 27', reminderNote: '' }
  ]
  const recentUploads = [
    { title: 'Why Narcissists Panic When You Go Quiet', channel: 'Mental Empire', views: '42K', publishedAt: '2d ago' },
    { title: 'The Stoic Secret to Never Being Angry', channel: 'Mental Empire', views: '18K', publishedAt: '4d ago' }
  ]
  const downloads: DownloadedVideo[] = [
    { id: 'dl-demo-1', sourceId: 'src-pw', title: 'Why Discipline Beats Motivation', channel: '@powerwithinofficial-q7d', size: '1.1 MB', when: '2h ago', stage: 'Downloaded only', pct: '100%', action: 'Open', thumb: '', filePath: '/Browser/downloads/why-discipline-beats-motivation.mp3', durationSec: 184 },
    { id: 'dl-demo-2', sourceId: 'src-nar', title: 'The Quiet Rule That Builds Discipline', channel: '@narceo05', size: '0.9 MB', when: '1d ago', stage: 'Downloaded only', pct: '100%', action: 'Open', thumb: '', filePath: '/Browser/downloads/the-quiet-rule.mp3', durationSec: 141 }
  ]
  const projects: Project[] = []
  const projectImages = new Map<string, ProjectImage[]>()
  const transcripts = new Map<string, TranscriptWord[]>()
  const renderRows: RenderQueueRow[] = []
  const templates: ThumbnailTemplate[] = []
  const workItemState = new Map<string, { uploadedManual: boolean | null; archived: boolean }>()
  const profiles: Profile[] = [
    { id: 'prof-me', name: 'Mental Empire', mono: 'ME', avatar: grad('#f5b323', '#b9780a'), rule: 'Latest · 5 videos', images: 'Pool of 10 · shuffle', thumb: 'Full Bleed', cap: 'Hormozi · 16:9', out: '/Browser/ME_out', autoWatch: true, sourceUrl: 'https://www.youtube.com/@powerwithinofficial-q7d', sourceOrder: 'Latest', sourceCount: 5, imageMode: 'pool', poolSize: 10, kenBurns: true, captionPreset: 'Hormozi', captionAspect: '16:9', betaOpts: { ...DEFAULT_BETA_OPTS, broll: { ...DEFAULT_BETA_OPTS.broll, enabled: true }, style: 'Cinematic' } }
  ]
  const activity: ActivityRow[] = [
    { t: '09:31', icon: '✓', color: '#36c98e', text: 'Browser mock ready for full workflow testing' }
  ]

  const sourceCatalog: Record<string, ScrapedVideo[]> = {
    '@powerwithinofficial-q7d': [
      'How Narcissists React After Long No Contact',
      'The Narcissist Cannot Escape What They Did',
      'When They Realize You Are Never Coming Back',
      'Universe Sends These Signs Before Removing Toxic People',
      'The Final Mind Game They Try'
    ].map((title, i) => ({ id: `pw-${i + 1}`, title, durationSec: 760 + i * 81, views: 48000 + i * 9300, uploadDate: `2026-06-${20 - i}`, thumb: grad(['#23304a', '#2a2540', '#143a32', '#3a2330'][i % 4], '#15171d') })),
    '@narceo05': [
      'Discipline Is Built When Nobody Claps',
      'Stop Negotiating With Your Weakest Self',
      'The Silent Routine That Changes Everything',
      'You Are One Decision Away From Control',
      'No More Excuses After Tonight'
    ].map((title, i) => ({ id: `nar-${i + 1}`, title, durationSec: 540 + i * 64, views: 21000 + i * 7100, uploadDate: `2026-06-${15 - i}`, thumb: grad(['#1f3340', '#332a40', '#16323a', '#2e2440'][i % 4], '#0c0d11') }))
  }

  const dlCbs: Array<(p: DownloadProgress) => void> = []
  const activityCbs: Array<(p: ActivityRow) => void> = []
  const renderCbs: Array<(p: RenderProgress) => void> = []
  const automationCbs: Array<(p: AutomationEvent) => void> = []
  const automationJobCbs: Array<(p: AutomationJob) => void> = []
  const automationJobDetails: AutomationJobDetail[] = []
  const noop = (): void => {}
  const ns = <T extends object>(o: T): T => new Proxy(o, { get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : async () => []) }) as T

  const pushActivity = (text: string, icon = '✓', color = '#36c98e'): void => {
    const row = { t: nowTime(), icon, color, text }
    activity.unshift(row)
    activityCbs.forEach((cb) => cb(row))
  }

  const makeDownload = (v: ScrapedVideo, sourceUrl: string, stage = 'Downloading'): DownloadedVideo => {
    const handle = handleFromUrl(sourceUrl)
    return {
      id: `dl-${v.id}-${Date.now()}-${Math.floor(Math.random() * 999)}`,
      sourceId: slug(handle),
      title: v.title,
      channel: handle,
      size: `${Math.max(8, Math.round((v.durationSec / 60) * 1.4))} MB`,
      when: 'just now',
      stage,
      pct: stage === 'Downloaded only' ? '100' : '0%',
      action: stage === 'Downloaded only' ? 'Open' : 'Resume',
      thumb: v.thumb,
      durationSec: v.durationSec,
      filePath: `/Browser/MentalEmpire_out/${slug(v.title)}.mp3`
    }
  }

  const videoIdForDownload = (downloadId: string): string => {
    const match = downloadId.match(/^dl-(.+)-\d+-\d+$/)
    return match?.[1] ?? downloadId.replace(/^dl-/, '')
  }

  const readWorkItems = (): WorkItem[] => downloads.map((d) => {
    const videoId = videoIdForDownload(d.id)
    const state = workItemState.get(videoId) ?? { uploadedManual: null, archived: false }
    const project = projects.find((p) => p.downloadId === d.id)
    const row = project ? renderRows.find((r) => r.job.projectId === project.id) : undefined
    const uploaded = state.uploadedManual === true
    return {
      videoId,
      channel: d.channel,
      title: d.title,
      thumb: d.thumb,
      downloadId: d.id,
      projectId: project?.id,
      renderJobId: row?.job.id,
      downloaded: d.stage === 'Downloaded only' && !!d.filePath,
      hasImages: project ? (projectImages.get(project.id)?.length ?? 0) > 0 : false,
      captioned: project ? (transcripts.get(project.id)?.length ?? 0) > 0 : false,
      hasThumbnail: !!project?.thumbPath || !!row?.hasThumb,
      rendered: row?.job.status === 'done' && !!row.job.outputPath,
      uploaded,
      renderStatus: row?.job.status,
      outputPath: row?.job.outputPath,
      error: row?.job.error,
      uploadedTo: uploaded ? [channels[0]?.id ?? 'me'] : [],
      uploadMatchScore: uploaded ? 1 : undefined,
      uploadConfidence: uploaded ? 'high' : undefined,
      uploadedManual: state.uploadedManual,
      archived: state.archived
    }
  })

  const createProjectForDownload = (downloadId: string): Project => {
    const existing = projects.find((p) => p.downloadId === downloadId)
    if (existing) return existing
    const d = downloads.find((x) => x.id === downloadId)
    if (!d) throw new Error(`Download not found: ${downloadId}`)
    const project: Project = {
      id: `proj-${downloadId}`,
      downloadId,
      title: d.title,
      channel: d.channel,
      mp3Path: d.filePath ?? `/Browser/MentalEmpire_out/${slug(d.title)}.mp3`,
      durationSec: d.durationSec ?? 720,
      imageMode: 'sequence',
      poolSize: 10,
      kenBurns: true,
      seed: 4821,
      crossfade: 0.8,
      motionPreset: 'subtle',
      captionPreset: 'Hormozi',
      captionFont: 'Anton',
      captionAnim: 'Pop-in',
      captionAspect: '16:9',
      captionPosition: 'bottom',
      captionHighlightColor: '#ffd93d',
      captionBoxColor: '#ffd93d',
      captionWordsPerPage: 1,
      emphasis: true,
      keywords: true,
      punchZoom: true,
      stage: 'draft',
      createdAt: new Date().toISOString(),
      betaOpts: { ...DEFAULT_BETA_OPTS, hook: { enabled: true, text: 'Watch this before you answer' }, overlay: { ...DEFAULT_BETA_OPTS.overlay, bottom: true }, autoZoom: { atStart: true, atKeyPhrases: true }, broll: { ...DEFAULT_BETA_OPTS.broll, enabled: true }, style: 'Cinematic' }
    }
    projects.unshift(project)
    projectImages.set(project.id, splitImages(project.id, [], project.durationSec))
    transcripts.set(project.id, sampleTranscript(project.id))
    return project
  }

  const queueProject = (projectId: string): void => {
    const p = projects.find((x) => x.id === projectId)
    if (!p) return
    p.stage = 'queued'
    if (!renderRows.some((r) => r.job.projectId === projectId)) {
      const images = projectImages.get(projectId)?.length ?? 0
      const hasThumb = templates.length > 0
      const hasCaptions = (transcripts.get(projectId)?.length ?? 0) > 0
      const missing = [
        images > 0 ? '' : 'images',
        hasThumb ? '' : 'thumbnail',
        hasCaptions ? '' : 'captions'
      ].filter(Boolean)
      renderRows.unshift({
        job: { id: `job-${projectId}`, title: p.title, channel: p.channel, status: 'queued', pct: 0, projectId, createdAt: new Date().toISOString() },
        images,
        hasMp3: true,
        hasThumb,
        hasCaptions,
        isReady: missing.length === 0,
        missing,
        projectDurationSec: p.durationSec,
        firstImagePath: projectImages.get(projectId)?.[0]?.path
      })
    }
    pushActivity(`Queued "${p.title}" for render`)
  }

  const makePreviewSpec = (projectId: string, draftOverrides?: Partial<Project>): GpuRenderSpec => {
    const baseProject = projects.find((x) => x.id === projectId)
    if (!baseProject) throw new Error(`Project not found: ${projectId}`)
    const p: Project = {
      ...baseProject,
      ...(draftOverrides ?? {}),
      id: baseProject.id,
      downloadId: baseProject.downloadId,
      mp3Path: baseProject.mp3Path
    }
    const aspect = p.captionAspect ?? '16:9'
    const width = aspect === '9:16' ? 406 : aspect === '1:1' ? 720 : 1280
    const height = aspect === '9:16' ? 720 : aspect === '1:1' ? 720 : 720
    const imgs = projectImages.get(projectId) ?? []
    const words = transcripts.get(projectId) ?? []
    const groups = []
    const isSubmagic = p.captionPreset === 'Submagic'
    const wordsPerPage = p.captionWordsPerPage === 2 || p.captionWordsPerPage === 3 ? p.captionWordsPerPage : 1
    const perGroup = isSubmagic ? wordsPerPage : Math.max(1, (aspect === '16:9' ? 4 : 3) * (p.captionLines ?? 1))
    for (let i = 0; i < words.length; i += perGroup) {
      const chunk = words.slice(i, i + perGroup)
      if (chunk.length) groups.push({
        startSec: chunk[0].start,
        endSec: Math.max(chunk[0].start + 0.3, chunk[chunk.length - 1].end),
        words: chunk.map((w) => ({ text: w.word, startSec: w.start, endSec: w.end, emphasis: w.emphasis }))
      })
    }
    const style = asBetaOpts(p.betaOpts).style
    const motionPreset = effectiveMotionPreset(p)
    const look = lookById(p.lookLut)
    const lutStrength = look.id === 'off' ? 0 : Math.max(0, Math.min(1, p.lookStrength ?? look.defaultStrength))
    const adjust = p.lookAdjust
    const baseGrade = {
      saturation: style === 'Cinematic' ? 1.12 : 1,
      contrast: style === 'Cinematic' ? 1.06 : 1,
      brightness: style === 'Cinematic' ? -0.015 : 0,
      colorBalance: { r: style === 'Cinematic' ? 0.05 : 0, g: 0, b: style === 'Cinematic' ? -0.05 : 0 },
      vignette: style === 'Cinematic' ? 0.55 : 0,
      sharpen: 0
    }
    return {
      jobId: p.id,
      width,
      height,
      fps: 24,
      durationSec: p.durationSec,
      images: imgs.map((im) => {
        const row = { path: im.path, startSec: im.rangeStart, endSec: im.rangeEnd, motion: mockImageMotion(im.ord, p.seed, imageMotionPreset(im, p), im) }
        return row.motion ? row : { path: row.path, startSec: row.startSec, endSec: row.endSec }
      }),
      motion: { kenBurns: motionPreset !== 'off', punchAtSec: words.filter((w) => w.emphasis).map((w) => w.start) },
      grade: {
        style,
        lut: lutStrength > 0 ? look.id : undefined,
        lutStrength,
        saturation: adjust?.saturation ?? baseGrade.saturation,
        contrast: adjust?.contrast ?? baseGrade.contrast,
        brightness: adjust?.brightness ?? baseGrade.brightness,
        colorBalance: {
          r: adjust?.colorBalance?.r ?? baseGrade.colorBalance.r,
          g: adjust?.colorBalance?.g ?? baseGrade.colorBalance.g,
          b: adjust?.colorBalance?.b ?? baseGrade.colorBalance.b
        },
        vignette: adjust?.vignette ?? baseGrade.vignette,
        sharpen: adjust?.sharpen ?? baseGrade.sharpen
      },
      grain: { strength: adjust?.grain ?? (style === 'Cinematic' ? 0.03 : 0), temporal: style === 'Cinematic' },
      captions: {
        groups,
        style: resolveCaptionStyle(p),
        preset: p.captionPreset,
        font: p.captionFont || 'Anton',
        animation: p.captionAnim || 'Pop-in',
        mode: p.captionPace === 'phrase' ? 'phrase' : 'word',
        position: p.captionPosition ?? 'bottom',
        lines: isSubmagic ? 1 : p.captionLines ?? 1,
        highlightColor: p.captionHighlightColor ?? (isSubmagic ? '#111111' : '#ffd93d'),
        highlightBox: isSubmagic ? {
          enabled: true,
          boxColor: p.captionBoxColor ?? '#ffd93d',
          textColor: p.captionHighlightColor ?? '#111111',
          radius: 14,
          padding: 12
        } : undefined,
        wordsPerPage: isSubmagic ? wordsPerPage : undefined
      },
      audio: { voicePath: p.mp3Path },
      encoder: { codec: 'avc', bitrateMbps: 6, keyIntervalSec: 2 },
      out: { h264Path: '/Browser/preview.gpu.mp4', finalPath: '/Browser/preview.mp4' }
    }
  }

  // ---- TalkingPhotos fixtures (connected account, catalogs, and a few jobs
  // spanning every status) so the Talking Video screen can be exercised end to end. ----
  const tpConnection: ProviderConnection = {
    id: 'default',
    provider: TALKINGPHOTOS_PROVIDER,
    partition: TALKINGPHOTOS_PARTITION,
    status: 'connected',
    accountLabel: 'demo@talkingphotos.ai',
    connectedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  const tpCapabilities: ProviderCapabilities = {
    limits: { maxDurationSeconds: 60, maxCharactersTts: 400, maxDurationPremiumSeconds: 60, maxCharactersTtsPremium: 250 },
    usage: { concurrentCount: 1, concurrentLimit: 3, dailyUsage: 4, dailyLimit: 20 },
    fetchedAt: new Date().toISOString()
  }
  const tpLanguages: ProviderLanguage[] = [
    { code: 'en-US', name: 'English (US)' },
    { code: 'en-GB', name: 'English (UK)' },
    { code: 'es-ES', name: 'Spanish (Spain)' },
    { code: 'fr-FR', name: 'French' },
    { code: 'de-DE', name: 'German' }
  ]
  const tpVoicesFor = (languageCode: string): ProviderVoice[] => [
    { name: `${languageCode}-AndrewMultilingualNeural`, fullName: 'Andrew (Multilingual)', gender: 'male', langCode: languageCode, category: 'Neural', type: 'standard', styleList: ['general', 'cheerful'], supportedEngines: ['neural'] },
    { name: `${languageCode}-JennyNeural`, fullName: 'Jenny', gender: 'female', langCode: languageCode, category: 'Neural', type: 'standard', styleList: ['general'], supportedEngines: ['neural'] },
    { name: `${languageCode}-GuyNeural`, fullName: 'Guy', gender: 'male', langCode: languageCode, category: 'Neural', type: 'standard', styleList: ['general'], supportedEngines: ['neural'] }
  ]
  const tpMotions: ProviderMotion[] = [
    { id: 101, title: 'Subtle nod', tag: 'calm', thumbUrl: '', videoUrl: '', durationSeconds: 8, isPremium: false, isBonus: false },
    { id: 102, title: 'Hand gestures', tag: 'expressive', thumbUrl: '', videoUrl: '', durationSeconds: 12, isPremium: false, isBonus: false },
    { id: 103, title: 'Studio presenter', tag: 'professional', thumbUrl: '', videoUrl: '', durationSeconds: 10, isPremium: true, isBonus: false }
  ]
  let tpJobSeq = 0
  const tpJobs: ProviderJob[] = [
    { id: 'tpjob-1', provider: TALKINGPHOTOS_PROVIDER, connectionId: 'default', operation: 'video', remoteProjectId: '9001', status: 'completed', progress: 100, localOutputPath: '/Browser/talkingphotos-output/9001.mp4', internalSegment: false, createdAt: new Date(Date.now() - 3_600_000).toISOString(), updatedAt: new Date().toISOString(), downloadedAt: new Date().toISOString() },
    { id: 'tpjob-2', provider: TALKINGPHOTOS_PROVIDER, connectionId: 'default', operation: 'video', remoteProjectId: '9002', status: 'running', remoteStep: 2, remoteStepsTotal: 4, progress: 45, internalSegment: false, createdAt: new Date(Date.now() - 600_000).toISOString(), updatedAt: new Date().toISOString() },
    { id: 'tpjob-3', provider: TALKINGPHOTOS_PROVIDER, connectionId: 'default', operation: 'tts', status: 'failed', progress: 0, errorMessage: 'TalkingPhotos returned an unexpected response.', internalSegment: false, createdAt: new Date(Date.now() - 7_200_000).toISOString(), updatedAt: new Date().toISOString() }
  ]

  const api = {
    platform: 'web',
    appVersion: '0.1.5 (browser mock)',
    minimize: noop,
    maximize: noop,
    close: noop,
    openLogs: async () => '(browser mock - no logs)',
    logPath: async () => '(browser mock)',
    chooseFolder: async () => '/Browser/MentalEmpire_out',
    library: {
      previewReorg: async () => ({ libraryRoot: '/Browser/MentalEmpireStudio', fileCount: 0, totalBytes: 0, missing: 0, alreadyOrganized: 0, sample: [] }),
      reorganize: async () => ({ moved: 0, skippedMissing: 0, alreadyOrganized: 0 })
    },
    niche: ns({
      list: async () => [],
      poolHealth: async () => [],
      refreshAll: async () => [],
      save: async () => [],
      remove: async () => [],
      assignChannel: async () => [],
      warm: async () => ({ nicheId: '', clips: 0, keywords: [] })
    }),
    talkingPhotos: ns({
      connectionStatus: async () => tpConnection,
      connect: async () => tpConnection,
      reconnect: async () => tpConnection,
      disconnect: async () => ({ ...tpConnection, status: 'disconnected' as const }),
      capabilities: async () => tpCapabilities,
      languages: async () => tpLanguages,
      voices: async (languageCode: string) => tpVoicesFor(languageCode),
      motions: async () => tpMotions,
      projects: async () => [],
      project: async () => null,
      sync: async () => tpJobs,
      jobs: async () => tpJobs,
      createUploadedAudio: async (input: TalkingPhotosCreateInput) => {
        const job: ProviderJob = {
          id: `tpjob-${100 + ++tpJobSeq}`, provider: TALKINGPHOTOS_PROVIDER, connectionId: 'default', operation: 'video',
          status: 'queued', progress: 0, internalSegment: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        }
        tpJobs.unshift(job)
        pushActivity(`Queued a talking video "${input.title}"`)
        return job
      },
      createScript: async (input: TalkingPhotosScriptCreateInput) => {
        const job: ProviderJob = {
          id: `tpjob-${100 + ++tpJobSeq}`, provider: TALKINGPHOTOS_PROVIDER, connectionId: 'default', operation: 'tts',
          status: 'queued', progress: 0, internalSegment: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        }
        tpJobs.unshift(job)
        pushActivity(`Queued a talking video "${input.title}"`)
        return job
      },
      downloadOutput: async (providerJobId: string) => {
        const job = tpJobs.find((j) => j.id === providerJobId)
        if (job) job.status = 'completed'
        return job ?? tpJobs[0]
      },
      subtitleLanguages: async () => tpLanguages,
      createProviderSubtitles: async (sourceJobId: string) => {
        const job: ProviderJob = {
          id: `tpjob-${100 + ++tpJobSeq}`, provider: TALKINGPHOTOS_PROVIDER, connectionId: 'default', operation: 'subtitles',
          parentProviderJobId: sourceJobId, status: 'queued', progress: 0, internalSegment: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        }
        tpJobs.unshift(job)
        return job
      },
      applyLocalCaptions: async (providerJobId: string) => {
        const job = tpJobs.find((j) => j.id === providerJobId)
        if (job) job.localCaptionedOutputPath = job.localOutputPath ? job.localOutputPath.replace('.mp4', '-captioned.mp4') : undefined
        return job ?? tpJobs[0]
      },
      ttsRecoveryLibrary: async () => [],
      confirmRecoveredTts: async () => tpJobs[0]
    }),
    onProviderJob: () => noop,
    onConnectionStatusChanged: () => noop,
    pathForFile: (file: File) => `browser://${file.name}`,
    settings: ns({
      get: async () => settings,
      set: async (p: Partial<AppSettings>) => {
        settings = deepMerge(settings, p)
        return settings
      },
      reset: async () => {
        channels.splice(0)
        downloads.splice(0)
        projects.splice(0)
        projectImages.clear()
        transcripts.clear()
        renderRows.splice(0)
        profiles.splice(0)
        templates.splice(0)
        workItemState.clear()
        activity.splice(0)
        settings = { ...DEFAULT_SETTINGS }
        return settings
      }
    }),
    appMeta: ns({
      get: async (key: string) => appMeta.get(key) ?? '',
      set: async (key: string, value: string) => { appMeta.set(key, value) }
    }),
    db: ns({
      myChannels: async () => channels,
      recentUploads: async (limit = 8) => recentUploads.slice(0, limit),
      downloads: async () => downloads,
      sourceChannels: async () => sourceChannels,
      profiles: async () => profiles,
      templates: async () => templates,
      activity: async () => activity,
      upsertProfile: async (p: Profile) => upsertProfile(p),
      saveTemplate: async (t: ThumbnailTemplate) => saveTemplate(t),
      updateChannelGoals: async (id: string, patch: Partial<MyChannel>) => {
        const c = channels.find((x) => x.id === id)
        if (c) Object.assign(c, patch)
        return channels
      },
      workItems: async () => readWorkItems()
    }),
    workItems: ns({
      detect: async () => 0,
      setUploaded: async (videoId: string, uploaded: boolean) => {
        const prev = workItemState.get(videoId) ?? { uploadedManual: null, archived: false }
        workItemState.set(videoId, { ...prev, uploadedManual: uploaded })
      },
      setArchived: async (videoId: string, archived: boolean) => {
        const prev = workItemState.get(videoId) ?? { uploadedManual: null, archived: false }
        workItemState.set(videoId, { ...prev, archived })
      }
    }),
    scrape: ns({
      channel: async (url: string): Promise<ScrapedChannel> => {
        const handle = handleFromUrl(url)
        return { handle, name: nameFromHandle(handle), channelId: slug(handle), subs: 1200, totalViews: 98000, totalViewsExact: false, videos: catalogFor(url).slice(0, 5) }
      },
      addMyChannel: async (url: string): Promise<MyChannel> => {
        const handle = handleFromUrl(url)
        const existing = channels.find((c) => c.handle.toLowerCase() === handle.toLowerCase())
        if (existing) return existing
        const name = nameFromHandle(handle)
        const channel: MyChannel = {
          id: `ch-${slug(handle)}`,
          name,
          handle,
          mono: monoFromName(name),
          avatar: grad('#8b7cff', '#36c98e'),
          views: '98K',
          subs: '1.2K',
          total: 3,
          linkedSourceId: sourceChannels[0]?.id,
          source: sourceChannels[0]?.handle ?? '',
          mapDone: 0,
          mapTotal: downloads.length,
          weekDone: 0,
          weekGoal: 5,
          monthDone: 0,
          monthGoal: 20,
          reminder: '',
          reminderNote: '',
          lastScrapedAt: new Date().toISOString()
        }
        channels.unshift(channel)
        recentUploads.unshift({ title: `${name} first browser-test upload`, channel: name, views: '1.2K', publishedAt: 'just now' })
        pushActivity(`Added channel ${handle}`)
        return channel
      },
      refreshChannel: async (id: string) => {
        const c = channels.find((x) => x.id === id) ?? channels[0]
        c.lastScrapedAt = new Date().toISOString()
        c.mapTotal = downloads.length
        pushActivity(`Refreshed ${c.handle}`)
        return c
      },
      all: async () => {
        channels.forEach((c) => { c.lastScrapedAt = new Date().toISOString(); c.mapTotal = downloads.length })
        pushActivity(`Re-scraped ${channels.length} channels`)
        return channels
      },
      sourceVideos: async (url: string, order: ScrapeOrder, count: number) => {
        const vids = [...catalogFor(url)]
        if (order === 'Popular') vids.sort((a, b) => b.views - a.views)
        if (order === 'Oldest') vids.reverse()
        ensureSource(url)
        return vids.slice(0, count)
      }
    }),
    sources: ns({
      list: async () => sourceChannels.map(sourceSummary),
      add: async (url: string) => {
        const source = ensureSource(url)
        const videos = catalogFor(source.handle)
        source.lastScrapedAt = new Date().toISOString()
        source.videoCount = videos.length
        pushActivity(`Saved source ${source.handle}`)
        return sourceSummary(source)
      },
      refresh: async (id: string) => {
        const source = sourceChannels.find((s) => s.id === id)
        if (!source) throw new Error(`Source not found: ${id}`)
        const videos = catalogFor(source.handle || source.url)
        source.lastScrapedAt = new Date().toISOString()
        source.videoCount = videos.length
        pushActivity(`Checked ${source.handle} for new videos`)
        return sourceSummary(source)
      },
      videos: async (id: string) => {
        const source = sourceChannels.find((s) => s.id === id)
        return source ? catalogFor(source.handle || source.url) : []
      },
      markVisited: async (id: string) => {
        const source = sourceChannels.find((s) => s.id === id)
        if (source) {
          const videos = catalogFor(source.handle || source.url)
          source.lastVisitedAt = new Date().toISOString()
          source.lastSeenVideoId = videos[0]?.id
        }
        return sourceChannels.map(sourceSummary)
      },
      remove: async (id: string) => {
        const idx = sourceChannels.findIndex((s) => s.id === id)
        if (idx >= 0) sourceChannels.splice(idx, 1)
        return sourceChannels.map(sourceSummary)
      },
      setLinkedMyChannel: async (id: string, myChannelId: string | null) => {
        const source = sourceChannels.find((s) => s.id === id)
        if (source) source.linkedMyChannelId = myChannelId ?? undefined
        return sourceChannels.map(sourceSummary)
      },
      setAutomation: async (id: string, patch: SourceAutomationPatch) => {
        const source = sourceChannels.find((s) => s.id === id)
        if (!source) throw new Error(`Source not found: ${id}`)
        Object.assign(source, patch)
        pushActivity(`${source.handle || source.name} automation ${source.autoWatch ? 'enabled' : 'paused'}`)
        return sourceChannels.map(sourceSummary)
      }
    }),
    reminders: ns({ check: async () => [] }),
    download: ns({
      start: async (vids: ScrapedVideo[], opts: { sourceUrl: string }) => {
        const created = vids.map((v) => makeDownload(v, opts.sourceUrl))
        downloads.unshift(...created)
        created.forEach((d, i) => {
          let pct = 0
          const id = setInterval(() => {
            pct = Math.min(100, pct + 25)
            d.pct = `${pct}%`
            d.stage = pct >= 100 ? 'Downloaded only' : 'Downloading'
            d.action = pct >= 100 ? 'Open' : 'Resume'
            dlCbs.forEach((cb) => cb({ downloadId: d.id, title: d.title, pct, stage: d.stage, done: pct >= 100 }))
            if (pct >= 100) {
              clearInterval(id)
              createProjectForDownload(d.id)
              pushActivity(`Downloaded "${d.title}"`)
            }
          }, 180 + i * 80)
        })
        return downloads
      },
      resume: async (id: string) => {
        const d = downloads.find((x) => x.id === id)
        if (!d) throw new Error(`Download not found: ${id}`)
        d.stage = 'Downloaded only'
        d.pct = '100'
        d.action = 'Open'
        createProjectForDownload(id)
        return d
      },
      cancel: async (id: string) => {
        const d = downloads.find((x) => x.id === id)
        if (d) {
          d.stage = 'Cancelled'
          d.pct = '0%'
          d.action = 'Resume'
        }
      },
      openFolder: async () => {}
    }),
    compose: ns({
      createProject: async (downloadId: string) => createProjectForDownload(downloadId),
      get: async (id: string) => projects.find((p) => p.id === id) ?? null,
      list: async () => projects,
      images: async (projectId: string) => projectImages.get(projectId) ?? [],
      setImages: async (projectId: string, paths: string[]) => {
        const p = projects.find((x) => x.id === projectId)
        const imgs = splitImages(projectId, paths, p?.durationSec ?? 720)
        projectImages.set(projectId, imgs)
        return imgs
      },
      reorderImages: async (projectId: string, imageIds: string[]) => {
        const imgs = projectImages.get(projectId) ?? []
        const byId = new Map(imgs.map((im) => [im.id, im]))
        const ordered = imageIds.map((id) => byId.get(id)).filter((im): im is typeof imgs[number] => !!im)
        const rest = imgs.filter((im) => !imageIds.includes(im.id))
        const next = [...ordered, ...rest].map((im, ord) => ({ ...im, ord }))
        projectImages.set(projectId, next)
        return next
      },
      setRanges: async (projectId: string, ranges: Array<{ id: string; rangeStart: number; rangeEnd: number }>) => {
        const imgs = (projectImages.get(projectId) ?? []).map((im) => ({ ...im, ...(ranges.find((r) => r.id === im.id) ?? {}) }))
        projectImages.set(projectId, imgs)
        return imgs
      },
      setImageMotion: async (projectId: string, updates: ProjectImageMotionPatch[]) => {
        const byId = new Map(updates.map((u) => [u.id, u]))
        const imgs = (projectImages.get(projectId) ?? []).map((im) => {
          const patch = byId.get(im.id)
          if (!patch) return im
          return {
            ...im,
            ...('motionPreset' in patch ? { motionPreset: patch.motionPreset ?? null } : {}),
            ...('motionDirection' in patch ? { motionDirection: patch.motionDirection ?? null } : {}),
            ...('motionAmount' in patch ? { motionAmount: patch.motionAmount ?? null } : {})
          }
        })
        projectImages.set(projectId, imgs)
        return imgs
      },
      setMedia: async (projectId: string, patch: Partial<Project>) => patchProject(projectId, patch),
      setCaptions: async (projectId: string, patch: Partial<Project>) => patchProject(projectId, patch),
      updateLook: async (projectId: string, patch: { lut?: string; strength?: number; adjust?: LookAdjust }) => {
        const p = projects.find((x) => x.id === projectId)
        if (!p) throw new Error(`Project not found: ${projectId}`)
        const look = patch.lut === undefined ? lookById(p.lookLut) : lookById(patch.lut)
        p.lookLut = look.id
        p.lookStrength = look.id === 'off' ? 0 : Math.max(0, Math.min(1, patch.strength ?? p.lookStrength ?? look.defaultStrength))
        if (patch.adjust !== undefined) p.lookAdjust = Object.keys(patch.adjust).length ? patch.adjust : undefined
        return p
      },
      updateMotion: async (projectId: string, patch: { preset: MotionPreset }) => {
        const preset: MotionPreset = patch.preset === 'off' || patch.preset === 'subtle' || patch.preset === 'cinematic' ? patch.preset : 'subtle'
        return patchProject(projectId, { motionPreset: preset, kenBurns: preset !== 'off' })
      },
      updateCaptions: async (projectId: string, patch: Partial<Project>) => patchProject(projectId, patch),
      previewSpec: async (projectId: string, draftOverrides?: Partial<Project>) => makePreviewSpec(projectId, draftOverrides),
      posterFrame: async () => '',
      preview: async (projectId: string) => `/Browser/MentalEmpire_out/${slug(projectId)}-preview.mp4`,
      sendToRender: async (projectId: string) => queueProject(projectId)
    }),
    transcribe: ns({
      run: async (projectId: string) => {
        const words = sampleTranscript(projectId)
        transcripts.set(projectId, words)
        return words
      },
      get: async (projectId: string) => transcripts.get(projectId) ?? [],
      updateWord: async (wordId: string, text: string) => {
        transcripts.forEach((words) => {
          const w = words.find((x) => x.id === wordId)
          if (w) w.word = text
        })
      },
      toggleEmphasis: async (wordId: string) => {
        transcripts.forEach((words) => {
          const w = words.find((x) => x.id === wordId)
          if (w) w.emphasis = !w.emphasis
        })
      },
      setEmphasis: async (wordIds: string[], emphasis: boolean) => {
        const ids = new Set(wordIds)
        transcripts.forEach((words) => {
          words.forEach((w) => {
            if (ids.has(w.id)) w.emphasis = emphasis
          })
        })
      }
    }),
    thumbnails: ns({
      templates: async () => templates,
      saveTemplate: async (t: ThumbnailTemplate) => saveTemplate(t),
      deleteTemplate: async (id: string) => {
        const i = templates.findIndex((t) => t.id === id)
        if (i >= 0) templates.splice(i, 1)
        return templates
      },
      assignToProfile: async (profileId: string, templateId: string) => {
        const p = profiles.find((x) => x.id === profileId)
        if (p) p.thumbnailTemplateId = templateId
        return profiles
      },
      writePng: async (name: string) => `/Browser/MentalEmpire_out/${slug(name)}.png`,
      saveProjectThumb: async (projectId: string, name: string) => {
        const path = `/Browser/MentalEmpire_out/thumbnails/${slug(name)}.png`
        const project = projects.find((p) => p.id === projectId)
        if (project) project.thumbPath = path
        renderRows.forEach((row) => {
          if (row.job.projectId === projectId) {
            row.hasThumb = true
            row.missing = row.missing.filter((m) => m !== 'thumbnail')
            row.isReady = row.hasMp3 && row.missing.length === 0
          }
        })
        pushActivity(`Saved thumbnail for "${name}"`)
        return path
      }
    }),
    render: ns({
      jobs: async () => renderRows,
      all: async () => {
        for (const row of renderRows.filter((r) => r.job.status === 'queued')) {
          row.job.status = 'rendering'
          for (const pct of [20, 45, 70, 100]) {
            row.job.pct = pct
            renderCbs.forEach((cb) => cb({ jobId: row.job.id, pct, stage: pct === 100 ? 'done' : 'rendering', done: pct === 100, outputPath: row.job.outputPath }))
            await new Promise((r) => setTimeout(r, 120))
          }
          row.job.status = 'done'
          row.job.outputPath = `/Browser/MentalEmpire_out/${slug(row.job.title)}.mp4`
          pushActivity(`Rendered "${row.job.title}"`)
        }
      },
      cancel: async (jobId: string) => {
        const row = renderRows.find((r) => r.job.id === jobId)
        if (row) row.job.status = 'error'
      },
      openFile: async () => {},
      openFolder: async () => {}
    }),
    assets: ns({
      list: async () => [],
      import: async (paths: string[], context?: { sourceId?: string; channel?: string; channelHandle?: string; channelAvatar?: string }) => paths.map((path, index) => ({
        id: `mock-asset-${index}-${path}`,
        path,
        canonicalPath: path,
        originalPath: path,
        sourceId: context?.sourceId,
        channel: context?.channel || 'Unsorted',
        channelHandle: context?.channelHandle,
        channelAvatar: context?.channelAvatar,
        addedAt: new Date().toISOString(),
        firstAddedAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
        usageCount: 1,
        missing: false
      }))
    }),
    publish: ns({
      list: async () => renderRows
        .filter((r) => r.job.status === 'done')
        .map((r) => ({
          jobId: r.job.id,
          projectId: r.job.projectId,
          title: r.job.title,
          channel: r.job.channel,
          videoPath: r.job.outputPath ?? '',
          thumbPath: null,
          durationSec: r.projectDurationSec,
          renderedAt: r.job.createdAt,
          uploadStatus: 'not-uploaded' as const
        })),
      reveal: async () => {},
      startDrag: () => {}
    }),
    gpu: ns({
      // Browser mock: report a healthy software-ish probe so Compose renders its chip
      // instead of crashing (there is no real WebCodecs hardware probe in a plain tab).
      status: async () => ({ hardware: true, supported: true, vendor: 'unknown' as const, detail: 'browser mock' })
    }),
    effects: ns({
      generate: async () => JSON.stringify({
        transitions: [{ atSec: 3, type: 'fadeblack', durationSec: 0.5 }, { atSec: 8, type: 'zoomin', durationSec: 0.6 }],
        textEffects: [{ scope: 'hook', preset: 'cinematic-pop' }, { word: 'discipline', preset: 'intense-zoom' }]
      }, null, 2)
    }),
    looks: ns({
      list: async () => LOOKS
    }),
    automation: ns({
      runProfile: async (profileId: string) => {
        const p = profiles.find((x) => x.id === profileId)
        if (!p) return []
        automationCbs.forEach((cb) => cb({ profileId, profileName: p.name, phase: 'start', message: 'Starting browser profile run' }))
        const vids = catalogFor(p.sourceUrl).slice(0, p.sourceCount)
        const createdDownloads = vids.map((v) => {
          const d = makeDownload(v, p.sourceUrl, 'Downloaded only')
          downloads.unshift(d)
          return d
        })
        const ids = createdDownloads.map((d) => createProjectForDownload(d.id).id)
        ids.forEach(queueProject)
        p.lastRunAt = new Date().toISOString()
        p.lastSeenVideoId = vids[0]?.id
        automationCbs.forEach((cb) => cb({ profileId, profileName: p.name, phase: 'done', message: `Created ${ids.length} projects`, projectIds: ids }))
        pushActivity(`Profile "${p.name}" created ${ids.length} queued projects`)
        return ids
      },
      runSource: async (sourceId: string) => {
        const source = sourceChannels.find((s) => s.id === sourceId)
        if (!source) return []
        const name = source.name || source.handle || 'Source'
        automationCbs.forEach((cb) => cb({ profileId: source.id, profileName: name, phase: 'start', message: 'Starting browser source run' }))
        const vids = catalogFor(source.url).slice(0, source.sourceCount ?? 5)
        const createdDownloads = vids.map((v) => {
          const d = makeDownload(v, source.url, 'Downloaded only')
          downloads.unshift(d)
          return d
        })
        const ids = createdDownloads.map((d) => createProjectForDownload(d.id).id)
        if (source.autoQueueRender) ids.forEach(queueProject)
        source.lastRunAt = new Date().toISOString()
        source.lastSeenVideoId = vids[0]?.id
        automationCbs.forEach((cb) => cb({ profileId: source.id, profileName: name, phase: source.autoQueueRender ? 'queued' : 'done', message: `Created ${ids.length} projects`, projectIds: ids }))
        pushActivity(`Source "${name}" created ${ids.length} projects`)
        return ids
      },
      upsertProfile: async (p: Profile) => upsertProfile(p),
      deleteProfile: async (profileId: string) => {
        const i = profiles.findIndex((p) => p.id === profileId)
        if (i >= 0) profiles.splice(i, 1)
        return profiles
      },
      tick: async () => {
        pushActivity('Manual auto-scrape tick completed')
      },
      preflight: async (draft: AutomationJobDraft) => {
        const hasSource = draft.config.sourceKind === 'local-files'
          ? draft.config.localMediaPaths.length > 0
          : draft.config.sourceKind === 'youtube-url' ? /^https:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//i.test(draft.config.sourceUrl) : !!draft.config.sourceId
        const itemCount = draft.config.sourceKind === 'local-files' ? draft.config.localMediaPaths.length : draft.config.selectedVideoIds.length || draft.config.sourceCount
        return {
        ok: hasSource,
        blockers: hasSource ? [] : ['Choose a valid source.'],
        warnings: [],
        estimatedStorageGb: Math.max(0.3, itemCount * 0.75),
        estimatedMinutes: itemCount * 18,
        sourceItems: itemCount,
        powerMessage: 'This job runs locally. The computer must remain powered on.',
        appMessage: 'You may close this window; the desktop process continues in the tray.'
      }},
      createJob: async (draft: AutomationJobDraft) => {
        const id = `auto-browser-${Date.now()}`
        const at = new Date().toISOString()
        const job: AutomationJobDetail = {
          id, name: draft.name, goal: draft.goal, status: 'queued', progress: 0, currentStep: 'Waiting to start',
          config: draft.config, createdAt: at, updatedAt: at, pauseRequested: false, cancelRequested: false,
          warningCount: 0, failedCount: 0, completedCount: 0, totalItems: draft.config.sourceKind === 'local-files' ? draft.config.localMediaPaths.length : draft.config.sourceCount,
          steps: buildAutomationWorkflow(id, draft.config, draft.goal),
          items: [], logs: [{ id: 1, jobId: id, level: 'info', message: 'Browser preview job saved.', createdAt: at }]
        }
        automationJobDetails.unshift(job)
        automationJobCbs.forEach((cb) => cb(job))
        return job
      },
      jobs: async () => automationJobDetails,
      job: async (id: string) => automationJobDetails.find((j) => j.id === id) ?? null,
      pauseJob: async (id: string) => { const j = automationJobDetails.find((x) => x.id === id); if (j) { j.status = 'paused'; automationJobCbs.forEach((cb) => cb(j)) } },
      resumeJob: async (id: string) => { const j = automationJobDetails.find((x) => x.id === id); if (j) { j.status = 'queued'; automationJobCbs.forEach((cb) => cb(j)) } },
      cancelJob: async (id: string) => { const j = automationJobDetails.find((x) => x.id === id); if (j) { j.status = 'cancelled'; automationJobCbs.forEach((cb) => cb(j)) } },
      retryJob: async (id: string) => { const j = automationJobDetails.find((x) => x.id === id); if (j) { j.status = 'queued'; j.error = undefined; automationJobCbs.forEach((cb) => cb(j)) } }
    }),
    onActivity: (cb: (row: ActivityRow) => void) => { activityCbs.push(cb); return noop },
    onScrapeProgress: () => noop,
    onDownloadProgress: (cb: (p: DownloadProgress) => void) => { dlCbs.push(cb); return noop },
    onTranscribeProgress: () => noop,
    onRenderProgress: (cb: (p: RenderProgress) => void) => { renderCbs.push(cb); return noop },
    onAutomation: (cb: (p: AutomationEvent) => void) => { automationCbs.push(cb); return noop },
    onAutomationJob: (cb: (p: AutomationJob) => void) => { automationJobCbs.push(cb); return noop }
  }

  function catalogFor(url: string): ScrapedVideo[] {
    const handle = handleFromUrl(url).toLowerCase()
    if (handle.includes('narceo')) return sourceCatalog['@narceo05']
    if (handle.includes('power')) return sourceCatalog['@powerwithinofficial-q7d']
    return [
      'The Quiet Rule That Builds Discipline',
      'Do This Before You Reply',
      'When Silence Becomes Power',
      'Nobody Can Stop This Version Of You'
    ].map((title, i) => ({ id: `${slug(handle)}-${i}`, title, durationSec: 620 + i * 60, views: 10000 + i * 5000, uploadDate: `2026-06-${10 + i}`, thumb: grad('#23304a', '#15171d') }))
  }

  function sourceSummary(source: SourceChannel): SourceChannel {
    const videos = catalogFor(source.handle || source.url)
    const cursor = source.lastSeenVideoId
    const idx = cursor ? videos.findIndex((v) => v.id === cursor) : -1
    return {
      ...source,
      cachedVideoCount: videos.length,
      videoCount: source.videoCount ?? videos.length,
      newVideoCount: cursor ? (idx < 0 ? videos.length : idx) : videos.length
    }
  }

  function ensureSource(url: string): SourceChannel {
    const handle = handleFromUrl(url)
    const existing = sourceChannels.find((s) => s.handle.toLowerCase() === handle.toLowerCase())
    if (existing) return existing
    const source: SourceChannel = { id: `src-${slug(handle)}`, url, handle, name: nameFromHandle(handle), lastScrapedAt: new Date().toISOString(), videoCount: catalogFor(handle).length }
    sourceChannels.push(source)
    return source
  }

  function patchProject(projectId: string, patch: Partial<Project>): Project {
    const p = projects.find((x) => x.id === projectId)
    if (!p) throw new Error(`Project not found: ${projectId}`)
    Object.assign(p, patch)
    return p
  }

  function saveTemplate(t: ThumbnailTemplate): ThumbnailTemplate[] {
    const i = templates.findIndex((x) => x.id === t.id)
    if (i >= 0) templates[i] = t
    else templates.push(t)
    renderRows.forEach((r) => { r.hasThumb = true })
    pushActivity(`Saved thumbnail template "${t.name}"`)
    return templates
  }

  function upsertProfile(p: Profile): Profile[] {
    const i = profiles.findIndex((x) => x.id === p.id)
    if (i >= 0) profiles[i] = p
    else profiles.unshift(p)
    const source = p.linkedSourceId ? sourceChannels.find((s) => s.id === p.linkedSourceId) : sourceChannels.find((s) => s.url === p.sourceUrl)
    if (source) {
      Object.assign(source, {
        autoWatch: p.autoWatch,
        autoQueueRender: p.autoQueueRender,
        sourceOrder: p.sourceOrder,
        sourceCount: p.sourceCount,
        imageMode: p.imageMode,
        poolSize: p.poolSize,
        kenBurns: p.kenBurns,
        captionPreset: p.captionPreset,
        captionFont: p.captionFont,
        captionAnim: p.captionAnim,
        captionAspect: p.captionAspect,
        captionLines: p.captionLines,
        captionPosition: p.captionPosition,
        captionPace: p.captionPace,
        captionHighlightColor: p.captionHighlightColor,
        captionBoxColor: p.captionBoxColor,
        captionWordsPerPage: p.captionWordsPerPage,
        outputFolder: p.outputFolder,
        thumbnailTemplateId: p.thumbnailTemplateId,
        betaOpts: p.betaOpts
      } satisfies SourceAutomationPatch)
    }
    return profiles
  }

  ;(window as unknown as { api: NativeApi }).api = api as unknown as NativeApi
  // eslint-disable-next-line no-console
  console.info('[mockApi] browser workflow mock installed (no Electron backend detected)')
}

function sampleTranscript(projectId: string): TranscriptWord[] {
  const words = ['You', 'are', 'not', 'weak', 'discipline', 'starts', 'when', 'comfort', 'ends']
  return words.map((word, ord) => ({
    id: `${projectId}-w${ord}`,
    projectId,
    ord,
    word,
    start: ord * 0.42,
    end: ord * 0.42 + 0.35,
    emphasis: ['not', 'discipline'].includes(word.toLowerCase())
  }))
}

// Only install when there is no real Electron bridge.
if (typeof window !== 'undefined' && !(window as unknown as { api?: unknown }).api) {
  installMock()
}
