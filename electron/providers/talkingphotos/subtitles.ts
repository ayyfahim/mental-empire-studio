import { randomUUID } from 'node:crypto'
import { getRepos } from '../../db'
import { createSubtitlesProject, getProjectRaw, listProjectLanguages } from './client'
import {
  TALKINGPHOTOS_CONNECTION_ID,
  TALKINGPHOTOS_PROVIDER,
  buildSubtitleCreatePayload,
  DEFAULT_SUBTITLES_OPTIONS,
  type ProviderJob,
  type ProviderLanguage
} from '../../../shared/talkingphotos'
import { L } from '../../services/logger'

// Provider-side subtitles (plan §8). The clone sent to POST /project/subtitles/create
// is built and sanitized entirely in the main process (buildSubtitleCreatePayload) —
// the raw source project is fetched, used once to extract a tiny allowlisted subset,
// and never logged or persisted whole.

export async function listSubtitleLanguages(): Promise<ProviderLanguage[]> {
  return listProjectLanguages()
}

/** Submit a provider subtitles job for an already-completed, non-internal source
 *  video. Idempotent: an existing non-terminal-failed subtitles job for the same
 *  source is returned as-is rather than resubmitted. */
export async function createProviderSubtitles(sourceJobId: string, opts: { language?: string } = {}): Promise<ProviderJob> {
  const repos = getRepos()
  const source = repos.providerJob(sourceJobId)
  if (!source) throw new Error(`Unknown provider job: ${sourceJobId}`)
  if (source.status !== 'completed' || !source.remoteProjectId) throw new Error('Subtitles can only be created for a completed TalkingPhotos video.')
  // Mutual exclusion (plan §8): never apply both subtitle systems to the same output.
  if (source.localCaptionedOutputPath) throw new Error('Local captions were already applied to this video — remove them before requesting provider subtitles.')

  const existing = repos.providerJobs(TALKINGPHOTOS_CONNECTION_ID)
    .find((job) => job.operation === 'subtitles' && job.parentProviderJobId === sourceJobId && job.status !== 'failed' && job.status !== 'cancelled')
  if (existing) return existing

  const raw = await getProjectRaw(source.remoteProjectId)
  const title = `talkingphotos-subtitles-${source.remoteProjectId}`
  const subtitlesOptions = opts.language ? { ...DEFAULT_SUBTITLES_OPTIONS, language: opts.language } : undefined
  const payload = buildSubtitleCreatePayload(raw, { title, parentId: source.remoteProjectId, subtitlesOptions })
  if (!payload) throw new Error('TalkingPhotos source project could not be sanitized for subtitle creation.')

  // Never log the raw source project — only that a sanitized clone was built and sent.
  L.info(`talkingphotos subtitles: submitting sanitized clone for source=${sourceJobId} remoteProjectId=${source.remoteProjectId}`)
  const result = await createSubtitlesProject(payload)

  const now = new Date().toISOString()
  const job: ProviderJob = {
    id: `tpj-sub-${randomUUID()}`, provider: TALKINGPHOTOS_PROVIDER, connectionId: TALKINGPHOTOS_CONNECTION_ID,
    operation: 'subtitles', parentProviderJobId: sourceJobId, projectId: source.projectId,
    automationJobId: source.automationJobId, automationItemId: source.automationItemId,
    remoteProjectId: result.id, status: result.status === 'processing' ? 'running' : 'queued', progress: 0,
    remoteMediaUrl: result.mediaUrl, internalSegment: false, createdAt: now, updatedAt: now
  }
  repos.upsertProviderJob(job)
  return job
}
