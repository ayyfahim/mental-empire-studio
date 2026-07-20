import { ipcMain } from 'electron'
import { getRepos } from '../db'
import { connectTalkingPhotos, disconnectTalkingPhotos, getConnectionStatus, reconnectTalkingPhotos } from '../providers/talkingphotos/session'
import { getCapabilities, getProject, listLanguages, listMotions, listProjects, listVoices } from '../providers/talkingphotos/client'
import { downloadProviderJobOutput } from '../providers/talkingphotos/downloader'
import { reconcileNonTerminalProviderJobs, syncAllProviderJobsNow } from '../providers/talkingphotos/poller'
import type { ProviderMotionQuery } from '../../shared/talkingphotos'

// TalkingPhotos IPC surface — Phase 1-3 (session/connection + read-only capabilities,
// catalogs, project sync, and output download). No project/video/TTS/merge/subtitle
// CREATION is exposed here: several required request/response contracts were not
// resolved by the HAR capture (see the integration review's "unresolved" list), and
// this module is intentionally limited to what the confirmed contract supports.

/** Defense-in-depth: assert a renderer-supplied id is a non-empty string. Mirrors the
 *  reqId() guard in electron/ipc/register.ts. */
function reqId(v: unknown, name = 'id'): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`Invalid ${name}`)
  return v
}

/** Exported for direct unit testing of the IPC argument-validation boundary. */
export function reqMotionQuery(v: unknown): ProviderMotionQuery {
  const q = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  if (q.projectType !== 'human') throw new Error('Invalid motion query: only projectType "human" is supported.')
  const gender = q.gender === 'male' || q.gender === 'female' ? q.gender : undefined
  const aspectRatio = q.aspectRatio === '16:9' || q.aspectRatio === '1:1' || q.aspectRatio === '9:16' ? q.aspectRatio : undefined
  const style = typeof q.style === 'string' ? q.style : undefined
  return { projectType: 'human', gender, aspectRatio, style }
}

export function registerTalkingPhotosIpc(): void {
  ipcMain.handle('talkingphotos:connectionStatus', () => getConnectionStatus(true))
  ipcMain.handle('talkingphotos:connect', () => connectTalkingPhotos())
  ipcMain.handle('talkingphotos:reconnect', async () => {
    const conn = await reconnectTalkingPhotos()
    if (conn.status === 'connected') await reconcileNonTerminalProviderJobs()
    return conn
  })
  ipcMain.handle('talkingphotos:disconnect', () => disconnectTalkingPhotos())

  ipcMain.handle('talkingphotos:capabilities', () => getCapabilities())
  ipcMain.handle('talkingphotos:languages', () => listLanguages())
  ipcMain.handle('talkingphotos:voices', (_e, languageCode: unknown) => listVoices(reqId(languageCode, 'languageCode')))
  ipcMain.handle('talkingphotos:motions', (_e, query: unknown) => listMotions(reqMotionQuery(query)))

  ipcMain.handle('talkingphotos:projects', () => listProjects())
  ipcMain.handle('talkingphotos:project', (_e, remoteProjectId: unknown) => getProject(reqId(remoteProjectId, 'remoteProjectId')))
  ipcMain.handle('talkingphotos:sync', () => syncAllProviderJobsNow())
  ipcMain.handle('talkingphotos:jobs', () => getRepos().providerJobs())
  ipcMain.handle('talkingphotos:downloadOutput', (_e, providerJobId: unknown) => downloadProviderJobOutput(reqId(providerJobId, 'providerJobId')))
}
