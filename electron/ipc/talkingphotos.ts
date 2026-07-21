import { ipcMain } from 'electron'
import { getRepos } from '../db'
import { connectTalkingPhotos, disconnectTalkingPhotos, getConnectionStatus, reconnectTalkingPhotos } from '../providers/talkingphotos/session'
import { getCapabilities, getProject, listLanguages, listMotions, listProjects, listVoices } from '../providers/talkingphotos/client'
import { downloadProviderJobOutput } from '../providers/talkingphotos/downloader'
import { createScriptVideo, createUploadedAudioVideo } from '../providers/talkingphotos/creation'
import { reconcileNonTerminalProviderJobs, syncAllProviderJobsNow } from '../providers/talkingphotos/poller'
import { confirmRecoveredTts, listTtsLibraryForRecovery } from '../providers/talkingphotos/tts'
import { createProviderSubtitles, listSubtitleLanguages } from '../providers/talkingphotos/subtitles'
import { applyLocalCaptions } from '../providers/talkingphotos/localCaptions'
import type { ProviderMotionQuery, TalkingPhotosCreateInput, TalkingPhotosScriptCreateInput } from '../../shared/talkingphotos'

// TalkingPhotos IPC surface: session/catalog sync, the confirmed uploaded-audio Human
// project workflow, the TTS-based (custom-script / transcript) workflow gated behind
// the confirmed WebSocket resolution, and provider subtitles / local captions.

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

/** Validate the complete renderer boundary before any file or network work starts. */
export function reqCreateInput(v: unknown): TalkingPhotosCreateInput {
  if (!v || typeof v !== 'object') throw new Error('Invalid TalkingPhotos creation request.')
  const q = v as Record<string, unknown>
  const requiredString = (name: string): string => {
    const value = q[name]
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${name}`)
    return value
  }
  const optionalString = (name: string): string | undefined => {
    const value = q[name]
    if (value == null || value === '') return undefined
    if (typeof value !== 'string') throw new Error(`Invalid ${name}`)
    return value
  }
  if (q.style !== 'normal' && q.style !== 'high_quality') throw new Error('Invalid TalkingPhotos project style.')
  if (q.aspectRatio !== '16:9' && q.aspectRatio !== '1:1' && q.aspectRatio !== '9:16') throw new Error('Invalid TalkingPhotos aspect ratio.')
  if (!Number.isInteger(q.motionId) || (q.motionId as number) < 0) throw new Error('Invalid TalkingPhotos motion ID.')
  if (q.characterGender != null && q.characterGender !== 'male' && q.characterGender !== 'female') throw new Error('Invalid characterGender')
  return {
    title: requiredString('title'),
    audioPath: requiredString('audioPath'),
    characterImagePath: requiredString('characterImagePath'),
    characterPrompt: requiredString('characterPrompt'),
    characterNegativePrompt: optionalString('characterNegativePrompt'),
    style: q.style,
    aspectRatio: q.aspectRatio,
    motionId: q.motionId as number,
    characterGender: q.characterGender as 'male' | 'female' | undefined,
    characterAge: optionalString('characterAge'),
    characterStyle: optionalString('characterStyle'),
    characterBeard: optionalString('characterBeard'),
    automationJobId: optionalString('automationJobId'),
    automationItemId: optionalString('automationItemId'),
    projectId: optionalString('projectId')
  }
}

/** Validate the complete renderer boundary for the custom-script/TTS creation
 *  request, before any file, network, or TTS-billing work starts. */
export function reqScriptCreateInput(v: unknown): TalkingPhotosScriptCreateInput {
  if (!v || typeof v !== 'object') throw new Error('Invalid TalkingPhotos script request.')
  const q = v as Record<string, unknown>
  const requiredString = (name: string): string => {
    const value = q[name]
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${name}`)
    return value
  }
  const optionalString = (name: string): string | undefined => {
    const value = q[name]
    if (value == null || value === '') return undefined
    if (typeof value !== 'string') throw new Error(`Invalid ${name}`)
    return value
  }
  if (q.style !== 'normal' && q.style !== 'high_quality') throw new Error('Invalid TalkingPhotos project style.')
  if (q.aspectRatio !== '16:9' && q.aspectRatio !== '1:1' && q.aspectRatio !== '9:16') throw new Error('Invalid TalkingPhotos aspect ratio.')
  if (!Number.isInteger(q.motionId) || (q.motionId as number) < 0) throw new Error('Invalid TalkingPhotos motion ID.')
  if (q.characterGender != null && q.characterGender !== 'male' && q.characterGender !== 'female') throw new Error('Invalid characterGender')
  const subtitleMode = q.subtitleMode === 'provider' || q.subtitleMode === 'local' ? q.subtitleMode : 'none'
  return {
    title: requiredString('title'),
    script: requiredString('script'),
    characterImagePath: requiredString('characterImagePath'),
    characterPrompt: requiredString('characterPrompt'),
    characterNegativePrompt: optionalString('characterNegativePrompt'),
    style: q.style,
    aspectRatio: q.aspectRatio,
    motionId: q.motionId as number,
    characterGender: q.characterGender as 'male' | 'female' | undefined,
    characterAge: optionalString('characterAge'),
    characterStyle: optionalString('characterStyle'),
    characterBeard: optionalString('characterBeard'),
    language: requiredString('language'),
    voice: requiredString('voice'),
    voiceStyle: typeof q.voiceStyle === 'string' && q.voiceStyle.trim() ? q.voiceStyle : 'general',
    speed: typeof q.speed === 'number' && Number.isFinite(q.speed) ? q.speed : 1,
    pitch: typeof q.pitch === 'number' && Number.isFinite(q.pitch) ? q.pitch : 0,
    subtitleMode,
    automationJobId: optionalString('automationJobId'),
    automationItemId: optionalString('automationItemId'),
    projectId: optionalString('projectId'),
    creationIntentId: optionalString('creationIntentId')
  }
}

export function registerTalkingPhotosIpc(): void {
  ipcMain.handle('talkingphotos:connectionStatus', () => getConnectionStatus(true))
  // connectTalkingPhotos() itself only opens the login window and resolves — it never
  // stays pending for the interactive login. Everything after that (waiting for the
  // user, verifying, and the final connected/attention outcome) is pushed separately
  // over the 'talkingphotos:connectionStatus' event (see session.ts's setStatus).
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
  ipcMain.handle('talkingphotos:createUploadedAudio', (_e, input: unknown) => createUploadedAudioVideo(reqCreateInput(input)))
  ipcMain.handle('talkingphotos:createScript', (_e, input: unknown) => createScriptVideo(reqScriptCreateInput(input)))
  ipcMain.handle('talkingphotos:downloadOutput', (_e, providerJobId: unknown) => downloadProviderJobOutput(reqId(providerJobId, 'providerJobId')))

  ipcMain.handle('talkingphotos:subtitleLanguages', () => listSubtitleLanguages())
  ipcMain.handle('talkingphotos:createProviderSubtitles', (_e, sourceJobId: unknown, language: unknown) =>
    createProviderSubtitles(reqId(sourceJobId, 'sourceJobId'), { language: typeof language === 'string' && language.trim() ? language : undefined }))
  ipcMain.handle('talkingphotos:applyLocalCaptions', (_e, providerJobId: unknown, aspect: unknown) =>
    applyLocalCaptions(reqId(providerJobId, 'providerJobId'), { aspect: aspect === '16:9' || aspect === '1:1' || aspect === '9:16' ? aspect : undefined }))

  // Explicit, user-confirmed TTS recovery only — never automatic (plan §4).
  ipcMain.handle('talkingphotos:ttsRecoveryLibrary', () => listTtsLibraryForRecovery())
  ipcMain.handle('talkingphotos:confirmRecoveredTts', (_e, jobId: unknown, mediaId: unknown, durationSec: unknown) => {
    const id = reqId(jobId, 'jobId')
    const media = reqId(mediaId, 'mediaId')
    const duration = typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0
    if (duration <= 0) throw new Error('Invalid durationSec')
    return confirmRecoveredTts(id, media, duration)
  })
}
