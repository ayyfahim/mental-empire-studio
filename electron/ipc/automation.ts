import { ipcMain } from 'electron'
import { asBetaOpts, type AutomationEvent, type AutomationJobDraft, type DownloadedVideo, type Profile, type ScrapedVideo, type SourceAutomationPatch, type SourceChannel } from '../../shared/types'
import { getRepos } from '../db'
import { sourceVideos, warmSourceBrollLibrary } from './scrape'
import { startDownloads } from './download'
import { createProject, runTranscribe, sendToRender } from './compose'
import { emit, hhmm, pushActivity } from './events'
import { getSettings } from '../store/settings'
import { postWebhook } from '../services/webhook'
import { notifyMessage } from '../services/notify'
import { L } from '../services/logger'
import {
  cancelAutomationJob,
  createAutomationJob,
  getAutomationJob,
  listAutomationJobs,
  pauseAutomationJob,
  preflightAutomation,
  resumeAutomationJob,
  retryAutomationJob
} from '../services/automation-supervisor'

// Profile run orchestrator (req #2 / #3). Reuses the scrape → download → compose →
// render functions. Interactive runs return the new project ids so the renderer can
// open the first for quick-edit; headless (auto-watch) runs queue them directly.

/** Source videos newer than the cursor. yt-dlp returns newest-first, so new uploads
 *  are the entries *before* the cursor id; an unknown/absent cursor means "all". */
export function newVideos(scraped: ScrapedVideo[], lastSeenId?: string): ScrapedVideo[] {
  if (!lastSeenId) return scraped
  const idx = scraped.findIndex((v) => v.id === lastSeenId)
  return idx === -1 ? scraped : scraped.slice(0, idx)
}

const inFlight = new Set<string>()

function emitA(e: AutomationEvent): void {
  emit('automation:event', e)
}

type CursorPatch = { lastSeenVideoId?: string; lastRunAt?: string }

function monoFor(name: string): string {
  const words = name.trim().replace(/^@/, '').split(/\s+/).filter(Boolean)
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase()
  return name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'SO'
}

function profileFromSource(source: SourceChannel): Profile {
  const name = source.name || source.handle || 'Source'
  const sourceOrder = source.sourceOrder ?? 'Latest'
  const sourceCount = source.sourceCount ?? 5
  const imageMode = source.imageMode ?? 'pool'
  const poolSize = source.poolSize ?? 10
  const captionPreset = source.captionPreset ?? 'Hormozi'
  const captionAspect = source.captionAspect ?? '16:9'
  const captionLines = source.captionLines ?? 1
  const captionPace = source.captionPace ?? 'auto'
  return {
    id: `src-auto-${source.id}`,
    name: `${name} automation`,
    mono: monoFor(name),
    avatar: 'linear-gradient(135deg,var(--accent),var(--accent-deep))',
    rule: `${sourceOrder} · ${sourceCount} videos`,
    images: imageMode === 'pool' ? `Pool of ${poolSize} · shuffle` : 'Sequence',
    thumb: source.thumbnailTemplateId ? 'Template' : 'None',
    cap: `${captionPreset} · ${captionAspect} · ${captionLines}L · ${captionPace === 'phrase' ? 'steady' : captionPace}`,
    out: source.outputFolder ?? '',
    autoWatch: !!source.autoWatch,
    autoQueueRender: !!source.autoQueueRender,
    thumbnailTemplateId: source.thumbnailTemplateId,
    linkedSourceId: source.id,
    sourceUrl: source.url,
    sourceOrder,
    sourceCount,
    imageMode,
    poolSize,
    kenBurns: source.kenBurns ?? true,
    captionPreset,
    captionFont: source.captionFont ?? 'Montserrat',
    captionAnim: source.captionAnim ?? 'Pop-in',
    captionAspect,
    captionLines,
    captionPosition: source.captionPosition ?? 'bottom',
    captionPace,
    captionHighlightColor: source.captionHighlightColor,
    captionBoxColor: source.captionBoxColor,
    captionWordsPerPage: source.captionWordsPerPage,
    outputFolder: source.outputFolder,
    lastSeenVideoId: source.lastSeenVideoId,
    lastRunAt: source.lastRunAt,
    betaOpts: asBetaOpts(source.betaOpts)
  }
}

function sourcePatchFromProfile(p: Profile): SourceAutomationPatch {
  return {
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
  }
}

async function runAutomation(eventId: string, guardId: string, profile: Profile, headless: boolean, setCursor: (patch: CursorPatch) => void): Promise<string[]> {
  const repos = getRepos()
  if (!profile.sourceUrl) throw new Error(`${profile.name} has no source URL`)
  if (inFlight.has(guardId)) return [] // re-entrancy guard
  inFlight.add(guardId)
  try {
    const settings = getSettings()
    const canAutoTranscribe = !!settings.transcription.apiKey?.trim()
    emitA({ profileId: eventId, profileName: profile.name, phase: 'start', message: 'Starting source pipeline', progress: 1 })
    emitA({ profileId: eventId, profileName: profile.name, phase: 'scraping', message: 'Checking source', progress: 4 })
    const scraped = await sourceVideos(profile.sourceUrl, profile.sourceOrder, profile.sourceCount)
    const list = headless ? newVideos(scraped, profile.lastSeenVideoId) : scraped
    if (list.length === 0) {
      emitA({ profileId: eventId, profileName: profile.name, phase: 'done', message: 'No new uploads', progress: 100, projectIds: [] })
      return []
    }

    const dls: DownloadedVideo[] = []
    for (let i = 0; i < list.length; i++) {
      const sourceVideo = list[i]
      const current = i + 1
      const label = sourceVideo.title.slice(0, 60)
      emitA({
        profileId: eventId,
        profileName: profile.name,
        phase: 'downloading',
        message: `Downloading ${current}/${list.length}: ${label}`,
        progress: Math.round(8 + (i / list.length) * 32),
        step: { current, total: list.length, label }
      })
      const [dl] = await startDownloads([sourceVideo], { bitrate: 192, sourceUrl: profile.sourceUrl })
      if (!dl) throw new Error(`Download did not start for ${sourceVideo.title}`)
      dls.push(dl)
      emitA({
        profileId: eventId,
        profileName: profile.name,
        phase: 'downloading',
        message: `Downloaded ${current}/${list.length}: ${label}`,
        progress: Math.round(8 + (current / list.length) * 32),
        step: { current, total: list.length, label }
      })
    }

    emitA({ profileId: eventId, profileName: profile.name, phase: 'composing', message: 'Building projects', progress: 44 })
    const projectIds: string[] = []
    const succeeded = new Set<string>()
    const template = profile.thumbnailTemplateId ? repos.getTemplate(profile.thumbnailTemplateId) : undefined
    for (let i = 0; i < dls.length; i++) {
      const dl = dls[i]
      const sourceVideo = list[i]
      try {
        if (!dl.filePath || !dl.durationSec || dl.stage === 'Failed') {
          throw new Error(dl.stage === 'Failed' ? 'download failed' : 'download did not produce a usable MP3')
        }
        const proj = createProject(dl.id)
        repos.updateProject(proj.id, {
          imageMode: profile.imageMode,
          poolSize: profile.poolSize,
          kenBurns: profile.kenBurns,
          captionPreset: profile.captionPreset,
          captionFont: profile.captionFont ?? 'Montserrat',
          captionAnim: profile.captionAnim ?? 'Pop-in',
          captionAspect: profile.captionAspect,
          captionLines: profile.captionLines ?? 1,
          captionPosition: profile.captionPosition ?? 'bottom',
          captionPace: profile.captionPace ?? 'auto',
          captionHighlightColor: profile.captionHighlightColor,
          captionBoxColor: profile.captionBoxColor,
          captionWordsPerPage: profile.captionWordsPerPage,
          // Inherit the profile's beta-feature defaults (hook/highlight/overlay/zoom/b-roll/style).
          ...(profile.betaOpts ? { betaOpts: profile.betaOpts } : {}),
          ...(template ? { thumbnailTemplateId: template.id } : {})
        })
        projectIds.push(proj.id)
        succeeded.add(sourceVideo.id)
        if (template) {
          emitA({ profileId: eventId, profileName: profile.name, phase: 'composing', message: `Attached thumbnail template "${template.name}"`, progress: Math.round(46 + ((i + 1) / dls.length) * 12), step: { current: i + 1, total: dls.length, label: sourceVideo.title.slice(0, 60) } })
        }
        if (canAutoTranscribe) {
          emitA({ profileId: eventId, profileName: profile.name, phase: 'transcribing', message: `Transcribing ${i + 1}/${dls.length}: ${sourceVideo.title.slice(0, 60)}`, progress: Math.round(60 + (i / dls.length) * 28), step: { current: i + 1, total: dls.length, label: sourceVideo.title.slice(0, 60) } })
          try {
            await runTranscribe(proj.id)
            emitA({ profileId: eventId, profileName: profile.name, phase: 'transcribing', message: `Captioned ${i + 1}/${dls.length}: ${sourceVideo.title.slice(0, 60)}`, progress: Math.round(60 + ((i + 1) / dls.length) * 28), step: { current: i + 1, total: dls.length, label: sourceVideo.title.slice(0, 60) } })
          } catch (e) {
            const msg = (e as Error).message
            emitA({ profileId: eventId, profileName: profile.name, phase: 'composing', message: `Transcription skipped: ${msg.slice(0, 90)}`, progress: Math.round(60 + ((i + 1) / dls.length) * 28), step: { current: i + 1, total: dls.length, label: sourceVideo.title.slice(0, 60) } })
            pushActivity({ t: hhmm(), icon: '!', color: '#f5b323', text: `${profile.name}: transcription skipped for ${sourceVideo.title.slice(0, 30)} — ${msg.slice(0, 70)}` })
          }
        } else {
          emitA({ profileId: eventId, profileName: profile.name, phase: 'composing', message: 'Project ready; add Groq key to auto-transcribe', progress: Math.round(60 + ((i + 1) / dls.length) * 18), step: { current: i + 1, total: dls.length, label: sourceVideo.title.slice(0, 60) } })
        }
        // Headless (auto-watch) always queues; interactive runs queue too when the
        // profile opts into end-to-end automation. Otherwise projects are left staged
        // for the user to quick-edit and queue manually.
        if (headless || profile.autoQueueRender) sendToRender(proj.id)
      } catch (e) {
        const msg = (e as Error).message
        emitA({ profileId: eventId, profileName: profile.name, phase: 'error', message: `${sourceVideo.title}: ${msg}` })
        pushActivity({ t: hhmm(), icon: '!', color: '#ff5a6e', text: `${profile.name}: skipped ${sourceVideo.title.slice(0, 34)} — ${msg.slice(0, 70)}` })
      }
    }
    if (projectIds.length === 0) throw new Error('No videos completed successfully')

    // Advance only on a fully successful batch. With YouTube's newest-first cursor,
    // moving past a partial failure can hide older failed uploads forever.
    const cursor = succeeded.size === list.length ? list[0]?.id : profile.lastSeenVideoId
    setCursor({ lastSeenVideoId: cursor, lastRunAt: new Date().toISOString() })
    const queued = headless || profile.autoQueueRender
    pushActivity({ t: hhmm(), icon: '▶', color: '#f5b323', text: `${profile.name}: ${dls.length} ${queued ? 'queued for render' : 'staged for edit'}` })
    await postWebhook('profile_run', { profile: profile.name, count: dls.length, headless })
    if (headless) notifyMessage('Auto-watch', `${profile.name}: ${dls.length} new video(s) queued`)

    emitA({ profileId: eventId, profileName: profile.name, phase: queued ? 'queued' : 'done', message: queued ? `${dls.length} queued for render — see Render Queue` : `${dls.length} staged — open Compose to edit, then render`, progress: 100, projectIds })
    return projectIds
  } catch (e) {
    emitA({ profileId: eventId, profileName: profile.name, phase: 'error', message: (e as Error).message })
    throw e
  } finally {
    inFlight.delete(guardId)
  }
}

export async function runProfile(profileId: string, headless = false): Promise<string[]> {
  const repos = getRepos()
  const profile = repos.getProfile(profileId)
  if (!profile) throw new Error(`Unknown profile: ${profileId}`)
  const source = profile.linkedSourceId ? repos.sourceChannel(profile.linkedSourceId) : profile.sourceUrl ? repos.sourceChannelByUrl(profile.sourceUrl) : undefined
  return runAutomation(profileId, `profile:${profileId}`, profile, headless, (patch) => {
    repos.setProfileCursor(profileId, patch)
    if (source) repos.setSourceCursor(source.id, patch)
  })
}

export async function runSource(sourceId: string, headless = false): Promise<string[]> {
  const repos = getRepos()
  const source = repos.sourceChannel(sourceId)
  if (!source) throw new Error(`Unknown source: ${sourceId}`)
  return runAutomation(sourceId, `source:${sourceId}`, profileFromSource(source), headless, (patch) => {
    repos.setSourceCursor(sourceId, patch)
  })
}

export function upsertProfileAndWarm(p: Profile): Profile[] {
  const repos = getRepos()
  const profiles = repos.upsertProfile(p)
  const source = p.linkedSourceId ? repos.sourceChannel(p.linkedSourceId) : p.sourceUrl ? repos.sourceChannelByUrl(p.sourceUrl) : undefined
  if (source) repos.updateSourceAutomation(source.id, sourcePatchFromProfile(p))
  if (p.sourceUrl?.trim() && asBetaOpts(p.betaOpts).broll.enabled) {
    void warmSourceBrollLibrary(p.sourceUrl, p.sourceOrder, {
      sourceKey: p.linkedSourceId || `profile-${p.id}`,
      displayName: p.name
    }).catch((e) => {
      L.warn(`profile B-roll warm failed profile=${p.id}: ${(e as Error).message}`)
    })
  }
  return profiles
}

export function registerAutomationIpc(): void {
  ipcMain.handle('automation:runProfile', (_e, id: string, headless?: boolean) => runProfile(id, !!headless))
  ipcMain.handle('automation:runSource', (_e, id: string, headless?: boolean) => runSource(id, !!headless))
  ipcMain.handle('automation:upsertProfile', (_e, p: Profile) => upsertProfileAndWarm(p))
  ipcMain.handle('automation:deleteProfile', (_e, id: string) => getRepos().deleteProfile(id))
  ipcMain.handle('automation:preflight', (_e, draft: AutomationJobDraft) => preflightAutomation(draft))
  ipcMain.handle('automation:createJob', (_e, draft: AutomationJobDraft) => createAutomationJob(draft))
  ipcMain.handle('automation:jobs', () => listAutomationJobs())
  ipcMain.handle('automation:job', (_e, id: string) => getAutomationJob(id))
  ipcMain.handle('automation:pauseJob', (_e, id: string) => pauseAutomationJob(id))
  ipcMain.handle('automation:resumeJob', (_e, id: string) => resumeAutomationJob(id))
  ipcMain.handle('automation:cancelJob', (_e, id: string) => cancelAutomationJob(id))
  ipcMain.handle('automation:retryJob', (_e, id: string) => retryAutomationJob(id))
}
