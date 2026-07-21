import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RenderQueueRow } from '../../shared/types'
import { projectVideoOpts } from '../../shared/types'
import { getRepos } from '../db'
import { runAll, outputDir } from '../services/queue'
import { cancelRender, markCancelIntent } from '../services/render'
import { safeName } from '../../shared/sanitize'
import { itemDirForProject, itemThumbDir } from '../services/storage'
import { cachedBrollClipCount, hasConfiguredBrollSource } from '../services/broll'
import { effectiveBrollPool } from '../../shared/automationBroll'
import { getSettings } from '../store/settings'

// Render queue IPC (M6): the joined queue view, run-all, cancel, and an output
// folder picker for the Render Queue screen.

function jobsView(): RenderQueueRow[] {
  const repos = getRepos()
  const settings = getSettings()
  const thumbsDir = join(outputDir(), 'thumbnails')
  return repos.renderJobs().map((job) => {
    const project = repos.getProject(job.projectId)
    const images = repos.getProjectImages(job.projectId)
    const words = repos.getTranscript(job.projectId)
    const hasThumb = !!project && (
      (!!project.thumbPath && existsSync(project.thumbPath)) ||
      existsSync(join(itemThumbDir(itemDirForProject(project)), `${safeName(project.title)}.png`)) ||
      existsSync(join(thumbsDir, `${safeName(project.title)}.png`))
    )
    const hasMp3 = !!project?.mp3Path && existsSync(project.mp3Path)
    const broll = projectVideoOpts(project).broll.enabled
    // Only the audio actually blocks a render (the graph falls back to a solid
    // background with no images, and captions/thumbnail are optional). hasThumb /
    // hasCaptions / images are still surfaced as advisory checklist columns.
    const missing: string[] = []
    if (!hasMp3) missing.push('MP3')
    if (!project?.durationSec || project.durationSec <= 0) missing.push('duration')
    if (project && images.length === 0) {
      const effectivePool = effectiveBrollPool({ projectBroll: projectVideoOpts(project).broll, sourceNichePoolKey: repos.nicheKeyForDownload(project.downloadId) })
      const poolKey = effectivePool.poolKey
      const brollAvailable = broll && (cachedBrollClipCount(poolKey) > 0 || (effectivePool.allowLive && hasConfiguredBrollSource(settings)))
      if (!brollAvailable) missing.push('visual media')
    }
    return {
      job,
      images: images.length,
      hasMp3,
      hasThumb,
      hasCaptions: words.length > 0,
      isReady: missing.length === 0,
      missing,
      projectDurationSec: project?.durationSec ?? 0,
      firstImagePath: images[0]?.path,
      broll
    }
  })
}

function outputPathForJob(id: string): string {
  return getRepos().renderJob(id)?.outputPath ?? ''
}

export function registerRenderIpc(): void {
  ipcMain.handle('render:jobs', () => jobsView())
  ipcMain.handle('render:all', () => runAll())
  ipcMain.handle('render:cancel', (_e, id: string) => {
    // Kill the running encode if any; if it was mid-render the queue runner restores
    // it to 'queued', otherwise set it here for an already-idle job.
    const job = getRepos().renderJob(id)
    if (!cancelRender(id, 'cancel')) {
      if (job?.status === 'rendering' || id.startsWith('preview-')) markCancelIntent(id, 'cancel')
      else if (job) getRepos().setRenderStatus(id, { status: 'queued', pct: 0, error: '' })
    }
  })
  ipcMain.handle('render:delete', (_e, id: string) => {
    if (!cancelRender(id, 'delete')) markCancelIntent(id, 'delete') // stop work before the row disappears
    getRepos().deleteRenderJob(id)
  })
  ipcMain.handle('render:requeue', (_e, id: string) => getRepos().setRenderStatus(id, { status: 'queued', pct: 0, error: '' }))
  ipcMain.handle('render:openFile', async (_e, id: string) => {
    const p = outputPathForJob(id)
    if (p) await shell.openPath(p)
  })
  ipcMain.handle('render:openFolder', async (_e, id: string) => {
    const p = outputPathForJob(id)
    if (p) shell.showItemInFolder(p)
    else await shell.openPath(outputDir())
  })
  ipcMain.handle('fs:chooseFolder', async () => {
    const win = BrowserWindow.getAllWindows()[0]
    const res = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return res.canceled || res.filePaths.length === 0 ? '' : res.filePaths[0]
  })
}

// Exported for the headless M6 smoke harness.
export { jobsView }
