import { app } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RenderJob, RenderProgress } from '../../shared/types'
import { asBetaOpts } from '../../shared/types'
import { styleCaptionLead, styleTransition, deriveStylePlan, validateEffectPlan, EMPTY_PLAN } from '../../shared/effectPlan'
import { buildSfxTrack } from './sfx'
import { getRepos } from '../db'
import { getSettings } from '../store/settings'
import { formatOutputName } from './audio'
import { buildAss } from './captions'
import { runRender, dimensions } from './render'
import { buildBrollBed } from './broll'
import { emit, hhmm, pushActivity } from '../ipc/events'

// Concurrency-limited render runner. Pulls queued render_jobs, renders up to
// settings.concurrency at once, writes the .ass + mp4, and streams render:progress.

export function outputDir(): string {
  const s = getSettings()
  return s.outputFolder || join(app.getPath('downloads'), 'MentalEmpire_out')
}

function safeName(name: string): string {
  return (name.replace(/[^a-z0-9\-_. ]/gi, '_').trim() || 'thumbnail').slice(0, 120)
}

function emitR(p: RenderProgress): void {
  emit('render:progress', p)
}

let maxActive = 0
/** Peak parallelism observed during the last runAll — asserted by the smoke. */
export function lastMaxActive(): number {
  return maxActive
}

export async function runJob(job: RenderJob): Promise<void> {
  const repos = getRepos()
  const project = repos.getProject(job.projectId)
  if (!project) {
    repos.setRenderStatus(job.id, { status: 'error', pct: 0, error: 'project missing' })
    emitR({ jobId: job.id, pct: 0, stage: 'error', done: true, error: 'project missing' })
    return
  }
  const images = repos.getProjectImages(job.projectId)
  const words = repos.getTranscript(job.projectId)
  const settings = getSettings()
  const preflightMissing: string[] = []
  if (!project.mp3Path || !existsSync(project.mp3Path)) preflightMissing.push('MP3')
  if (!project.durationSec || project.durationSec <= 0) preflightMissing.push('duration')
  if (images.length === 0) preflightMissing.push('images')
  if (words.length === 0) preflightMissing.push('captions')
  if (!existsSync(join(outputDir(), 'thumbnails', `${safeName(project.title)}.png`))) preflightMissing.push('thumbnail')
  if (preflightMissing.length) {
    const msg = `Missing required render assets: ${preflightMissing.join(', ')}`
    repos.setRenderStatus(job.id, { status: 'error', pct: 0, error: msg })
    emitR({ jobId: job.id, pct: 0, stage: 'error', done: true, error: msg })
    pushActivity({ t: hhmm(), icon: '!', color: '#ff5a6e', text: `Render blocked: ${project.title.slice(0, 42)} — ${msg}` })
    return
  }

  repos.setRenderStatus(job.id, { status: 'rendering', pct: 0 })
  emitR({ jobId: job.id, pct: 0, stage: 'rendering', done: false })

  const dir = outputDir()
  mkdirSync(dir, { recursive: true })
  const base = formatOutputName(settings.namingTemplate, { channel: project.channel, title: project.title })
  const assPath = join(dir, `${base}.ass`)
  const outPath = join(dir, `${base}.mp4`)
  // Beta: fold hook + auto-highlight into the caption options when beta mode is on.
  const beta = settings.beta?.enabled ? asBetaOpts(project.betaOpts) : null
  const hookText = beta?.hook.enabled
    ? (beta.hook.text.trim() || words.slice(0, 8).map((w) => w.word).join(' '))
    : ''
  // Beta style → transitions + caption "feel". A pasted/LLM effect plan overrides the
  // built-in rule engine; both pass through validateEffectPlan's guardrails.
  const style = beta?.style ?? 'None'
  const styleLead = beta ? styleCaptionLead(style) : undefined
  const transition = beta && style !== 'None' ? styleTransition(style) : undefined
  // The effect plan (pasted/LLM JSON overrides the rule engine) drives per-boundary
  // transitions + the SFX track. Both go through validateEffectPlan's guardrails.
  const plan = beta
    ? (beta.effectPlanJson.trim() ? validateEffectPlan(beta.effectPlanJson, project.durationSec).plan : deriveStylePlan(words, style, project.durationSec))
    : EMPTY_PLAN
  const sfxPath = beta ? buildSfxTrack(plan.transitions, project.durationSec) ?? undefined : undefined

  const { ass } = buildAss(words, {
    preset: project.captionPreset,
    aspect: project.captionAspect,
    keywords: project.keywords || !!beta?.autoHighlight,
    hook: hookText ? { text: hookText, untilSec: 2.6 } : undefined,
    styleLead,
    textEffects: beta ? plan.textEffects : undefined
  })
  writeFileSync(assPath, ass)

  // Beta auto-B-roll: assemble a themed stock-footage bed; fall back to stills on failure.
  let videoBedPath: string | undefined
  if (beta?.broll.enabled) {
    try {
      const dims = dimensions(settings.quality, project.captionAspect)
      const bed = await buildBrollBed({ settings, words, durationSec: project.durationSec, density: beta.broll.density, poolSize: beta.broll.poolSize, dims, fps: 30, transition })
      videoBedPath = bed ?? undefined
    } catch {
      /* b-roll unavailable (no keys / network) → render with the existing image track */
    }
  }

  try {
    await runRender({ project, images, assPath, outPath, settings, videoBedPath, transition, plan, sfxPath }, (pct) => {
      repos.setRenderStatus(job.id, { status: 'rendering', pct })
      emitR({ jobId: job.id, pct, stage: 'rendering', done: false })
    })
    repos.setRenderStatus(job.id, { status: 'done', pct: 100, outputPath: outPath })
    repos.updateProject(job.projectId, { stage: 'rendered' })
    emitR({ jobId: job.id, pct: 100, stage: 'done', done: true, outputPath: outPath })
    pushActivity({ t: hhmm(), icon: '✓', color: '#36c98e', text: `Rendered ${project.title} → ${base}.mp4` })
  } catch (e) {
    const msg = (e as Error).message
    repos.setRenderStatus(job.id, { status: 'error', pct: 0, error: msg })
    emitR({ jobId: job.id, pct: 0, stage: 'error', done: true, error: msg })
    pushActivity({ t: hhmm(), icon: '!', color: '#ff5a6e', text: `Render failed: ${project.title}` })
  }
}

/** Render every queued job, at most `settings.concurrency` in flight at a time. */
export async function runAll(): Promise<void> {
  const jobs = getRepos().queuedJobs()
  const concurrency = Math.max(1, getSettings().concurrency)
  let idx = 0
  let active = 0
  maxActive = 0

  await new Promise<void>((resolve) => {
    const pump = (): void => {
      if (idx >= jobs.length && active === 0) {
        resolve()
        return
      }
      while (active < concurrency && idx < jobs.length) {
        const job = jobs[idx++]
        active++
        maxActive = Math.max(maxActive, active)
        void runJob(job).finally(() => {
          active--
          pump()
        })
      }
    }
    pump()
  })
}
