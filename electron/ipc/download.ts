import { ipcMain, shell } from 'electron'
import { statSync } from 'node:fs'
import type { DownloadOptions, DownloadProgress, DownloadedVideo, ScrapedVideo } from '../../shared/types'
import { getSettings } from '../store/settings'
import { getRepos } from '../db'
import { cancelDownload, downloadAudio } from '../services/downloader'
import { channelUrl } from '../services/scraper'
import { probeDuration } from '../services/audio'
import { itemAudioDir, itemDir, ensureDir } from '../services/storage'
import { youtubeThumbUrl } from '../../shared/youtube'
import { emit, hhmm, pushActivity } from './events'
import { L } from '../services/logger'
import { runUploadDetection } from '../services/uploads-detect'

// Download orchestration: yt-dlp mp3 download → DB history → duration probe, with
// streamed progress. Resume reuses finished files (no re-fetch). Audio lands in the
// per-video library folder (<lib>/<channel>/<videoId>__<slug>/audio) via the storage
// service so every asset for a video sits together.

function emitProgress(p: DownloadProgress): void {
  emit('download:progress', p)
}

function sizeLabel(filePath: string): string {
  try {
    return `${(statSync(filePath).size / 1_000_000).toFixed(1)} MB`
  } catch {
    return '—'
  }
}

async function runOne(video: ScrapedVideo, sourceId: string, channel: string, opts: DownloadOptions): Promise<DownloadedVideo> {
  const repos = getRepos()
  const settings = getSettings()
  const id = `dl-${video.id}`
  const base: DownloadedVideo = {
    id,
    sourceId,
    title: video.title,
    channel,
    size: '—',
    when: 'just now',
    stage: 'Downloading',
    pct: '0%',
    action: 'Resume',
    // Real YouTube thumbnail via the deterministic i.ytimg.com URL (no yt-dlp fetch);
    // fall back to the scraped thumb, then a gradient placeholder in the UI on error.
    thumb: video.thumb || youtubeThumbUrl(video.id, 'hq')
  }
  repos.upsertDownload(base)
  emitProgress({ downloadId: id, title: video.title, pct: 0, stage: 'Downloading', done: false })

  try {
    const audioOut = ensureDir(itemAudioDir(itemDir({ channel, videoId: video.id, title: video.title })))
    const res = await downloadAudio({
      video,
      downloadId: id,
      channel,
      outDir: audioOut,
      bitrate: opts.bitrate,
      settings,
      delaySec: opts.delaySec,
      supervised: opts.supervised,
      onProgress: (pct) => {
        repos.setDownloadProgress(id, { pct: `${Math.round(pct)}%` })
        emitProgress({ downloadId: id, title: video.title, pct, stage: 'Downloading', done: false })
      }
    })
    const durationSec = await probeDuration(res.filePath).catch(() => 0)
    repos.setDownloadProgress(id, {
      pct: '100%',
      stage: 'Downloaded only',
      action: 'Open',
      filePath: res.filePath,
      durationSec,
      error: ''
    })
    repos.upsertDownload({ ...(repos.download(id) as DownloadedVideo), size: sizeLabel(res.filePath) })
    pushActivity({ t: hhmm(), icon: '✓', color: '#36c98e', text: `Downloaded ${video.title}` })
    try { runUploadDetection() } catch { /* upload detection is advisory */ }
    emitProgress({ downloadId: id, title: video.title, pct: 100, stage: 'Downloaded only', done: true })
    return repos.download(id) as DownloadedVideo
  } catch (e) {
    const msg = (e as Error).message
    if (msg === 'download cancelled') {
      repos.setDownloadProgress(id, { pct: '0%', stage: 'Cancelled', action: 'Resume', error: '' })
      pushActivity({ t: hhmm(), icon: '⊘', color: '#8a909c', text: `Download cancelled: ${video.title.slice(0, 42)}` })
      emitProgress({ downloadId: id, title: video.title, pct: 0, stage: 'Cancelled', done: true })
      return repos.download(id) as DownloadedVideo
    }
    L.error(`download FAILED "${video.title}": ${msg}`)
    repos.setDownloadProgress(id, { stage: 'Failed', error: msg })
    // Surface the reason in the in-app activity feed (not just a silent "Failed").
    pushActivity({ t: hhmm(), icon: '✕', color: '#ff5a6e', text: `Download failed: ${video.title.slice(0, 40)} — ${msg.slice(0, 80)}` })
    emitProgress({ downloadId: id, title: video.title, pct: 0, stage: 'Failed', done: true, error: msg })
    if (opts.supervised) throw e
    return repos.download(id) as DownloadedVideo // don't reject the whole interactive batch — keep going
  }
}

async function startDownloads(videos: ScrapedVideo[], opts: DownloadOptions): Promise<DownloadedVideo[]> {
  const repos = getRepos()
  const src = repos.sourceChannelByUrl(channelUrl(opts.sourceUrl))
  const sourceId = src?.id ?? `src-${opts.sourceUrl.replace(/[^A-Za-z0-9]+/g, '_')}`
  const channel = src?.handle ?? opts.sourceUrl
  const out: DownloadedVideo[] = []
  for (const v of videos) {
    out.push(await runOne(v, sourceId, channel, opts))
  }
  return out
}

async function resume(id: string): Promise<DownloadedVideo> {
  const repos = getRepos()
  const row = repos.download(id)
  if (!row) throw new Error(`Unknown download: ${id}`)
  const videoId = id.replace(/^dl-/, '')
  // Carry forward the metadata we already have (deterministic thumb + any known
  // duration) instead of resuming with blanks; runOne re-probes the real duration
  // once the file lands.
  const video: ScrapedVideo = {
    id: videoId,
    title: row.title,
    durationSec: row.durationSec ?? 0,
    views: 0,
    uploadDate: '',
    thumb: row.thumb && !row.thumb.startsWith('linear-gradient') ? row.thumb : youtubeThumbUrl(videoId, 'hq')
  }
  return runOne(video, row.sourceId, row.channel, { bitrate: 192, sourceUrl: row.channel })
}

function openFolder(id: string): void {
  const row = getRepos().download(id)
  if (row?.filePath) shell.showItemInFolder(row.filePath)
}

export function registerDownloadIpc(): void {
  ipcMain.handle('download:start', (_e, videos: ScrapedVideo[], opts: DownloadOptions) => startDownloads(videos, opts))
  ipcMain.handle('download:resume', (_e, id: string) => resume(id))
  ipcMain.handle('download:cancel', (_e, id: string) => {
    cancelDownload(id)
    getRepos().setDownloadProgress(id, { pct: '0%', stage: 'Cancelled', action: 'Resume' })
  })
  ipcMain.handle('download:openFolder', (_e, id: string) => openFolder(id))
  ipcMain.handle('download:delete', (_e, id: string) => {
    cancelDownload(id)
    getRepos().deleteDownload(id)
  })
}

// Exported for the headless M4 smoke harness.
export { startDownloads, resume }
