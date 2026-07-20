import { spawn } from 'node:child_process'
import { existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { ffmpegPath } from '../../services/bin'
import { probeDuration } from '../../services/audio'
import { L } from '../../services/logger'

// Local FFmpeg merge fallback (plan §10). Remote merge_videos stays primary; this is
// only ever invoked once every child segment's output has already been downloaded and
// verified. Tries the fast, lossless concat demuxer first (works when every input
// shares compatible codecs/dimensions/timing); falls back to a filter_complex
// re-encode when that fails, so mismatched inputs still produce a correct output.

export class LocalMergeFailure extends Error {}

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

/** ffconcat file list — single-quoted paths, single quotes inside a path escaped per
 *  ffmpeg's own concat-demuxer quoting rule. */
function writeConcatList(inputPaths: string[], listPath: string): void {
  const content = inputPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n')
  writeFileSync(listPath, content, 'utf8')
}

async function concatDemuxer(inputPaths: string[], outputPath: string): Promise<boolean> {
  const listPath = `${outputPath}.concat.txt`
  writeConcatList(inputPaths, listPath)
  try {
    const { code, stderr } = await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath])
    if (code !== 0) L.warn(`talkingphotos local merge: concat demuxer failed (code=${code}): ${stderr}`)
    return code === 0
  } finally {
    try { if (existsSync(listPath)) unlinkSync(listPath) } catch { /* best-effort cleanup */ }
  }
}

async function transcodeConcat(inputPaths: string[], outputPath: string): Promise<boolean> {
  const args: string[] = ['-y']
  for (const p of inputPaths) args.push('-i', p)
  const filterInputs = inputPaths.map((_, i) => `[${i}:v:0][${i}:a:0]`).join('')
  args.push('-filter_complex', `${filterInputs}concat=n=${inputPaths.length}:v=1:a=1[v][a]`, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-c:a', 'aac', outputPath)
  const { code, stderr } = await runFfmpeg(args)
  if (code !== 0) L.warn(`talkingphotos local merge: transcode fallback failed (code=${code}): ${stderr}`)
  return code === 0
}

/** Merge already-downloaded, already-verified segment files, in the given order
 *  (callers pass them pre-sorted by segmentOrdinal). Writes to a `.part` file first,
 *  validates the result is a playable media container, then atomically renames. */
export async function mergeVideoFilesLocally(inputPaths: string[], outputPath: string): Promise<void> {
  if (inputPaths.length < 2) throw new LocalMergeFailure('Local merge needs at least two inputs.')
  for (const p of inputPaths) {
    if (!existsSync(p)) throw new LocalMergeFailure(`Local merge input is missing: ${p}`)
  }
  const tmp = `${outputPath}.part`
  const cleanup = (): void => { try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* best-effort cleanup */ } }

  let ok = await concatDemuxer(inputPaths, tmp)
  if (!ok || (await probeDuration(tmp).catch(() => 0)) <= 0) {
    cleanup()
    ok = await transcodeConcat(inputPaths, tmp)
  }
  if (!ok) { cleanup(); throw new LocalMergeFailure('Local FFmpeg merge failed with both the concat demuxer and the transcode fallback.') }
  const durationSec = await probeDuration(tmp).catch(() => 0)
  if (durationSec <= 0) { cleanup(); throw new LocalMergeFailure('Local merge produced a file with no readable media stream.') }
  renameSync(tmp, outputPath)
}
