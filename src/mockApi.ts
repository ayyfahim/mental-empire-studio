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
  type ActivityRow,
  type AppSettings,
  type AutomationEvent,
  type DownloadProgress,
  type DownloadedVideo,
  type MyChannel,
  type NativeApi,
  type Profile,
  type Project,
  type ProjectImage,
  type RenderProgress,
  type RenderQueueRow,
  type ScrapeOrder,
  type ScrapedChannel,
  type ScrapedVideo,
  type SourceChannel,
  type ThumbnailTemplate,
  type TranscriptWord
} from '@shared/types'

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
    beta: { enabled: true, pexelsKey: '', pixabayKey: '', coverrKey: '' }
  } as Partial<AppSettings>)

  const sourceChannels: SourceChannel[] = [
    { id: 'src-pw', url: 'https://www.youtube.com/@powerwithinofficial-q7d', handle: '@powerwithinofficial-q7d', name: 'Power Within Official' },
    { id: 'src-nar', url: 'https://www.youtube.com/@narceo05', handle: '@narceo05', name: 'Narceo' }
  ]

  const channels: MyChannel[] = [
    { id: 'me', name: 'Mental Empire', handle: '@MentalEmpire', mono: 'ME', avatar: grad('#f5b323', '#b9780a'), views: '1.2M', subs: '455', total: 4, linkedSourceId: 'src-pw', source: '@powerwithinofficial-q7d', mapDone: 2, mapTotal: 3, weekDone: 3, weekGoal: 5, monthDone: 9, monthGoal: 20, reminder: 'Fri Jun 27', reminderNote: '' }
  ]
  const recentUploads = [
    { title: 'Why Narcissists Panic When You Go Quiet', channel: 'Mental Empire', views: '42K', publishedAt: '2d ago' },
    { title: 'The Stoic Secret to Never Being Angry', channel: 'Mental Empire', views: '18K', publishedAt: '4d ago' }
  ]
  const downloads: DownloadedVideo[] = []
  const projects: Project[] = []
  const projectImages = new Map<string, ProjectImage[]>()
  const transcripts = new Map<string, TranscriptWord[]>()
  const renderRows: RenderQueueRow[] = []
  const templates: ThumbnailTemplate[] = []
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
      crossfade: true,
      captionPreset: 'Hormozi',
      captionFont: 'Anton',
      captionAnim: 'Pop-in',
      captionAspect: '16:9',
      emphasis: true,
      keywords: true,
      punchZoom: true,
      stage: 'draft',
      createdAt: new Date().toISOString(),
      betaOpts: { ...DEFAULT_BETA_OPTS, hook: { enabled: true, text: 'Watch this before you answer' }, overlay: { bottom: true, top: false, left: false, right: false }, autoZoom: { atStart: true, atKeyPhrases: true }, broll: { ...DEFAULT_BETA_OPTS.broll, enabled: true }, style: 'Cinematic' }
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

  const api = {
    platform: 'web',
    appVersion: '0.1.5 (browser mock)',
    minimize: noop,
    maximize: noop,
    close: noop,
    openLogs: async () => '(browser mock - no logs)',
    logPath: async () => '(browser mock)',
    chooseFolder: async () => '/Browser/MentalEmpire_out',
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
        activity.splice(0)
        settings = { ...DEFAULT_SETTINGS }
        return settings
      }
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
      setMedia: async (projectId: string, patch: Partial<Project>) => patchProject(projectId, patch),
      setCaptions: async (projectId: string, patch: Partial<Project>) => patchProject(projectId, patch),
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
      writePng: async (name: string) => `/Browser/MentalEmpire_out/${slug(name)}.png`
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
      }
    }),
    effects: ns({
      generate: async () => JSON.stringify({
        transitions: [{ atSec: 3, type: 'fadeblack', durationSec: 0.5 }, { atSec: 8, type: 'zoomin', durationSec: 0.6 }],
        textEffects: [{ scope: 'hook', preset: 'cinematic-pop' }, { word: 'discipline', preset: 'intense-zoom' }]
      }, null, 2)
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
      upsertProfile: async (p: Profile) => upsertProfile(p),
      deleteProfile: async (profileId: string) => {
        const i = profiles.findIndex((p) => p.id === profileId)
        if (i >= 0) profiles.splice(i, 1)
        return profiles
      },
      tick: async () => {
        pushActivity('Manual auto-scrape tick completed')
      }
    }),
    onActivity: (cb: (row: ActivityRow) => void) => { activityCbs.push(cb); return noop },
    onScrapeProgress: () => noop,
    onDownloadProgress: (cb: (p: DownloadProgress) => void) => { dlCbs.push(cb); return noop },
    onTranscribeProgress: () => noop,
    onRenderProgress: (cb: (p: RenderProgress) => void) => { renderCbs.push(cb); return noop },
    onAutomation: (cb: (p: AutomationEvent) => void) => { automationCbs.push(cb); return noop }
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

  function ensureSource(url: string): void {
    const handle = handleFromUrl(url)
    if (!sourceChannels.some((s) => s.handle.toLowerCase() === handle.toLowerCase())) {
      sourceChannels.push({ id: `src-${slug(handle)}`, url, handle, name: nameFromHandle(handle) })
    }
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
