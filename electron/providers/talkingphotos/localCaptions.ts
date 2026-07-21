import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getRepos } from '../../db'
import { getSettings } from '../../store/settings'
import { transcribeAudio, type RawWord } from '../../services/transcribe'
import { buildAss, resolutionFor, type CaptionAspect } from '../../services/captions'
import { assForFilter, captionFontsDir } from '../../services/render'
import { ffmpegPath } from '../../services/bin'
import { probeDuration } from '../../services/audio'
import type { ProviderJob } from '../../../shared/talkingphotos'
import type { TranscriptWord } from '../../../shared/types'
import { L } from '../../services/logger'

// Local-caption alternative to provider subtitles (plan §8). Downloads/reuses the
// verified TalkingPhotos MP4, reuses the EXISTING Groq transcription + ASS caption
// builder (the same tooling Compose renders use), and burns captions with ffmpeg into
// a SEPARATE derivative file — the verified provider output at localOutputPath is
// never touched or overwritten.

export class LocalCaptionFailure extends Error {}

function runFfmpeg(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(ffmpegPath(), args, { windowsHide: true })
    } catch (e) {
      resolve({ code: -1, stderr: (e as Error).message })
      return
    }
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('close', (code) => resolve({ code, stderr: stderr.slice(-2000) }))
    child.on('error', (e) => resolve({ code: -1, stderr: e.message }))
  })
}

function wordsToTranscriptWords(raw: RawWord[], projectId: string): TranscriptWord[] {
  return raw.map((w, ord) => ({ id: `${projectId}-w${ord}`, projectId, ord, word: w.word, start: w.start, end: w.end, emphasis: false }))
}

/** Apply local captions to an already-downloaded, already-verified TalkingPhotos
 *  output. Requires a configured Groq transcription key (the same one Compose uses).
 *  Persists the derivative separately (localCaptionedOutputPath) — never in place of
 *  the original. Safe to call again: re-running replaces only the derivative. */
export async function applyLocalCaptions(providerJobId: string, opts: { aspect?: CaptionAspect; preset?: string } = {}): Promise<ProviderJob> {
  const repos = getRepos()
  const job = repos.providerJob(providerJobId)
  if (!job) throw new Error(`Unknown provider job: ${providerJobId}`)
  if (job.status !== 'completed' || !job.localOutputPath || !existsSync(job.localOutputPath)) {
    throw new LocalCaptionFailure('Local captions require an already-downloaded, verified TalkingPhotos output.')
  }
  // Mutual exclusion (plan §8): never apply both subtitle systems to the same output.
  const hasProviderSubtitles = repos.providerJobs(job.connectionId)
    .some((candidate) => candidate.operation === 'subtitles' && candidate.parentProviderJobId === job.id && candidate.status !== 'failed' && candidate.status !== 'cancelled')
  if (hasProviderSubtitles) throw new LocalCaptionFailure('Provider subtitles were already requested for this video — remove them before applying local captions.')
  const apiKey = getSettings().transcription.apiKey.trim()
  if (!apiKey) throw new LocalCaptionFailure('Add a Groq transcription key in Settings before applying local captions.')

  const scratch = mkdtempSync(join(tmpdir(), 'me-talkingphotos-captions-'))
  const audioPath = join(scratch, 'audio.mp3')
  const assPath = join(scratch, 'captions.ass')
  const dest = `${job.localOutputPath.replace(/\.mp4$/i, '')}.captioned.mp4`
  const tmp = `${dest}.part`
  try {
    const extract = await runFfmpeg(['-y', '-i', job.localOutputPath, '-vn', '-acodec', 'libmp3lame', '-q:a', '4', audioPath])
    if (extract.code !== 0 || !existsSync(audioPath)) throw new LocalCaptionFailure(`Could not extract audio for transcription: ${extract.stderr}`)

    const rawWords = await transcribeAudio(audioPath, getSettings())
    if (!rawWords.length) throw new LocalCaptionFailure('Transcription returned no words — cannot build captions.')
    const words = wordsToTranscriptWords(rawWords, job.id)

    const aspect = opts.aspect ?? '16:9'
    const { ass } = buildAss(words, { preset: opts.preset ?? 'Hormozi', aspect, keywords: false })
    writeFileSync(assPath, ass, 'utf8')

    const { w, h } = resolutionFor(aspect)
    const fontsDir = captionFontsDir()
    const fontsArg = fontsDir ? `:fontsdir='${assForFilter(fontsDir)}'` : ''
    const burn = await runFfmpeg([
      '-y', '-i', job.localOutputPath,
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,subtitles='${assForFilter(assPath)}'${fontsArg}`,
      '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-c:a', 'copy', tmp
    ])
    if (burn.code !== 0 || !existsSync(tmp)) throw new LocalCaptionFailure(`Caption burn failed: ${burn.stderr}`)

    const originalDuration = await probeDuration(job.localOutputPath)
    const captionedDuration = await probeDuration(tmp)
    if (captionedDuration <= 0) throw new LocalCaptionFailure('Local-caption output is not a readable media container.')
    if (originalDuration > 0) {
      const drift = Math.abs(captionedDuration - originalDuration) / originalDuration
      if (drift > 0.05) L.warn(`talkingphotos local captions duration mismatch job=${job.id} original=${originalDuration}s captioned=${captionedDuration}s`)
    }

    renameSync(tmp, dest)
    repos.updateProviderJob(job.id, { localCaptionedOutputPath: dest })
    L.info(`talkingphotos local captions applied job=${job.id} output=${dest}`)
    return repos.providerJob(job.id)!
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* best-effort cleanup */ }
    throw e
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
  }
}
