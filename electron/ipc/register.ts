import { ipcMain } from 'electron'
import type { AppSettings, DeepPartial, GoalsPatch, Profile, ThumbnailTemplate } from '../../shared/types'
import { getSettings, setSettings, resetSettings } from '../store/settings'
import { getRepos } from '../db'
import { registerScrapeIpc } from './scrape'
import { registerDownloadIpc } from './download'
import { registerComposeIpc } from './compose'
import { registerThumbnailsIpc } from './thumbnails'
import { registerRenderIpc } from './render'
import { registerPublishIpc } from './publish'
import { registerAssetsIpc } from './assets'
import { registerLibraryIpc } from './library'
import { registerNicheIpc } from './niche'
import { registerAutomationIpc, upsertProfileAndWarm } from './automation'
import { tick, start as schedulerStart } from '../services/scheduler'
import { applyLoginItem } from '../services/background'
import { probeRenderCapabilities } from '../services/engine/caps'
import { probeGpuEngine } from '../services/engine/gpu/host'
import { runUploadDetection } from '../services/uploads-detect'
import { setSentryEnabled, telemetryForcedOff } from '../services/sentry'
import { registerTalkingPhotosIpc } from './talkingphotos'
import { clearProviderSessionStorage } from '../providers/talkingphotos/partition'

// All native capability the renderer can reach is registered here as invoke
// handlers and exposed through the typed preload bridge (window.api.*).

/** Defense-in-depth: assert a renderer-supplied id is a non-empty string before it
 *  reaches the DB/filesystem. The renderer is first-party, so this just hardens the
 *  boundary against a future renderer compromise / malformed call. */
function reqId(v: unknown, name = 'id'): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`Invalid ${name}`)
  return v
}

export function registerIpc(): void {
  // ---- settings (electron-store) ----
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: DeepPartial<AppSettings>) => {
    const next = setSettings(patch)
    // React to background/auto-scrape changes: re-register login item + scheduler.
    if (patch.background?.startOnSignIn !== undefined) applyLoginItem(next)
    if (patch.autoScrape !== undefined) schedulerStart()
    if (patch.telemetryEnabled !== undefined) setSentryEnabled(!telemetryForcedOff() && next.telemetryEnabled)
    return next
  })
  ipcMain.handle('caps:get', (_e, force?: boolean) => probeRenderCapabilities(!!force))
  // Compose's GPU status chip: combine the ffmpeg/nvidia-smi vendor probe (fast, cached)
  // with the actual WebCodecs hardware-encode probe the Compose render path depends on.
  ipcMain.handle('gpu:status', async () => {
    const caps = probeRenderCapabilities()
    const ready = await probeGpuEngine()
    return {
      hardware: ready.hardware,
      supported: ready.supported,
      detail: ready.detail,
      vendor: caps.gpuVendor,
      gpuName: caps.nvidiaGpuName || undefined
    }
  })
  ipcMain.handle('appMeta:get', (_e, key: string) => getRepos().appMeta(reqId(key, 'key')) ?? '')
  ipcMain.handle('appMeta:set', (_e, key: string, value: string) => {
    getRepos().setAppMeta(reqId(key, 'key'), String(value))
  })
  // Factory reset: settings back to defaults + wipe all projects/profiles/channels/jobs.
  // Also logs out of TalkingPhotos (its connection row is wiped along with everything
  // else, so the Chromium partition should not silently stay authenticated underneath it).
  ipcMain.handle('app:reset', async () => {
    const next = resetSettings()
    getRepos().resetAll()
    await clearProviderSessionStorage().catch(() => {})
    applyLoginItem(next)
    schedulerStart()
    return next
  })
  // Soft reset: wipe data (channels/downloads/projects/jobs) but keep settings + API keys.
  ipcMain.handle('app:softReset', () => {
    getRepos().softReset()
  })

  // ---- domain data (sqlite) ----
  ipcMain.handle('db:myChannels', () => getRepos().myChannels())
  ipcMain.handle('db:sourceChannels', () => getRepos().sourceChannels())
  ipcMain.handle('db:downloads', () => getRepos().downloads())
  ipcMain.handle('db:profiles', () => getRepos().profiles())
  ipcMain.handle('db:templates', () => getRepos().templates())
  ipcMain.handle('db:activity', () => getRepos().activity())
  ipcMain.handle('db:upsertProfile', (_e, p: Profile) => upsertProfileAndWarm(p))
  ipcMain.handle('db:saveTemplate', (_e, t: ThumbnailTemplate) => getRepos().saveTemplate(t))
  ipcMain.handle('db:recentUploads', (_e, limit?: number) => getRepos().recentUploads(limit ?? 8))
  ipcMain.handle('db:updateChannelGoals', (_e, id: string, patch: GoalsPatch) => {
    getRepos().updateChannelGoals(reqId(id), patch)
    return getRepos().myChannels()
  })
  ipcMain.handle('db:setChannelSource', (_e, id: string, linkedSourceId: string | null) => {
    getRepos().setChannelSource(reqId(id), linkedSourceId ? reqId(linkedSourceId) : null)
    return getRepos().myChannels()
  })
  ipcMain.handle('db:deleteMyChannel', (_e, id: string) => {
    getRepos().deleteMyChannel(reqId(id))
    return getRepos().myChannels()
  })

  // ---- P1: per-video work items + fuzzy upload detection ----
  ipcMain.handle('db:workItems', () => getRepos().workItems())
  ipcMain.handle('workItems:detect', () => runUploadDetection({ force: true }))
  ipcMain.handle('workItems:setUploaded', (_e, videoId: string, uploaded: boolean) => {
    getRepos().setWorkItemUploaded(reqId(videoId, 'videoId'), !!uploaded)
  })
  ipcMain.handle('workItems:setArchived', (_e, videoId: string, archived: boolean) => {
    getRepos().setWorkItemArchived(reqId(videoId, 'videoId'), !!archived)
  })

  // ---- scraping + reminders (M3) ----
  registerScrapeIpc()

  // ---- download + compose + transcribe (M4) ----
  registerDownloadIpc()
  registerComposeIpc()

  // ---- thumbnail engine (M5) ----
  registerThumbnailsIpc()

  // ---- render pipeline (M6) ----
  registerRenderIpc()

  // ---- publish hub: uploaded/not-uploaded + drag-out (P2 H) ----
  registerPublishIpc()

  // ---- image library: reuse images across projects, grouped by channel (P2 I) ----
  registerAssetsIpc()

  // ---- master library: reorganize-existing migration (P0) ----
  registerLibraryIpc()
  // ---- niche b-roll pools (P3) ----
  registerNicheIpc()

  // ---- automation: profiles + scheduler (M7) ----
  registerAutomationIpc()
  ipcMain.handle('automation:tick', () => tick())

  // ---- TalkingPhotos cloud provider: session, sync, and uploaded-audio Human creation ----
  registerTalkingPhotosIpc()

  // ---- beta: effect-plan generation via Groq (reuses the transcription key) ----
  ipcMain.handle('effects:generate', async (_e, projectId: string, style: import('../../shared/types').VideoStyle) => {
    const project = getRepos().getProject(reqId(projectId, 'projectId'))
    if (!project) throw new Error('project missing')
    const words = getRepos().getTranscript(projectId)
    const { generatePlanViaGroq } = await import('../services/effects')
    const { json } = await generatePlanViaGroq(getSettings().transcription.apiKey, words, style, project.durationSec)
    return json
  })
}
