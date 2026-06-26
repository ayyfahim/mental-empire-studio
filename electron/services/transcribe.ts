import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AppSettings } from '../../shared/types'
import { resolveBinDir } from './ytdlp'
import { L } from './logger'

// Word-level transcription via Groq's free Whisper API (OpenAI-compatible). We
// upload the mp3 and ask for word timestamps. Offline seam: ME_WHISPER_FIXTURE
// returns recorded word JSON so the transcript pipeline is testable without network.

export interface RawWord {
  word: string
  start: number
  end: number
}

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
const MAX_DIRECT_BYTES = 20 * 1024 * 1024
const CHUNK_SECONDS = 600
const CHUNK_RETRIES = 2

export interface TranscribeAudioOptions {
  onProgress?: (message: string) => void
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(2)} MB`
}

function sanitizeError(e: unknown): string {
  return (e as Error).message.replace(/Bearer\s+[A-Za-z0-9_.-]+/g, 'Bearer [redacted]').slice(0, 500)
}

function ffmpegPath(): string {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const vendored = join(resolveBinDir(), exe)
  return existsSync(vendored) ? vendored : exe
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const bin = ffmpegPath()
    L.info(`transcribe: spawning ffmpeg for audio chunking (${bin})`)
    const child = spawn(bin, args, { windowsHide: true })
    let err = ''
    child.stderr.on('data', (d: Buffer) => (err += d))
    child.on('error', (e) => {
      L.error(`transcribe: ffmpeg spawn failed: ${sanitizeError(e)}`)
      reject(e)
    })
    child.on('close', (code) => {
      if (code === 0) {
        L.info('transcribe: ffmpeg chunking completed')
        resolve()
      } else {
        const msg = `ffmpeg chunking failed (${code}): ${err.slice(-500)}`
        L.error(`transcribe: ${sanitizeError(new Error(msg))}`)
        reject(new Error(msg))
      }
    })
  })
}

async function chunkAudio(mp3Path: string, onProgress?: (message: string) => void): Promise<string[]> {
  const dir = join(tmpdir(), `mental-empire-transcribe-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const outPattern = join(dir, 'chunk-%03d.mp3')
  L.info(`transcribe: chunk temp dir ${dir}`)
  onProgress?.('Splitting large audio into Groq-safe chunks')
  await runFfmpeg([
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', mp3Path,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'libmp3lame',
    '-b:a', '96k',
    '-f', 'segment',
    '-segment_time', String(CHUNK_SECONDS),
    '-reset_timestamps', '1',
    outPattern
  ])
  const chunks = readdirSync(dir)
    .filter((f) => /^chunk-\d+\.mp3$/.test(f))
    .sort()
    .map((f) => join(dir, f))
  if (chunks.length === 0) throw new Error('Audio chunking produced no files.')
  L.info(`transcribe: produced ${chunks.length} chunk(s): ${chunks.map((c) => mb(statSync(c).size)).join(', ')}`)
  onProgress?.(`Prepared ${chunks.length} audio chunk${chunks.length === 1 ? '' : 's'}`)
  return chunks
}

async function transcribeOne(mp3Path: string, apiKey: string, model: string): Promise<RawWord[]> {
  const buf = readFileSync(mp3Path)
  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'audio.mp3')
  form.append('model', model || 'whisper-large-v3-turbo')
  form.append('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'word')

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Groq transcription failed ${res.status}: ${t.slice(0, 300)}`)
  }
  const json = (await res.json()) as { words?: RawWord[] }
  return json.words ?? []
}

async function transcribeOneWithRetry(mp3Path: string, apiKey: string, model: string, label: string, onProgress?: (message: string) => void): Promise<RawWord[]> {
  let lastErr: Error | null = null
  for (let attempt = 1; attempt <= CHUNK_RETRIES + 1; attempt++) {
    try {
      onProgress?.(`Sending ${label} to Groq${attempt > 1 ? ` (retry ${attempt - 1})` : ''}`)
      L.info(`transcribe: ${label} upload attempt ${attempt} (${mb(statSync(mp3Path).size)})`)
      const words = await transcribeOne(mp3Path, apiKey, model)
      L.info(`transcribe: ${label} succeeded with ${words.length} word(s)`)
      return words
    } catch (e) {
      lastErr = e as Error
      L.warn(`transcribe: ${label} attempt ${attempt} failed: ${sanitizeError(e)}`)
      if (attempt <= CHUNK_RETRIES) await sleep(1000 * attempt)
    }
  }
  throw new Error(`${label} failed after ${CHUNK_RETRIES + 1} attempts: ${sanitizeError(lastErr)}`)
}

export async function transcribeAudio(mp3Path: string, settings: AppSettings, opts: TranscribeAudioOptions = {}): Promise<RawWord[]> {
  const fixture = process.env['ME_WHISPER_FIXTURE']
  if (fixture) {
    const data = JSON.parse(readFileSync(fixture, 'utf8')) as { words?: RawWord[] }
    return data.words ?? []
  }

  const apiKey = settings.transcription.apiKey || process.env['GROQ_API_KEY'] || ''
  const { model } = settings.transcription
  if (!apiKey) throw new Error('No Groq API key set (Settings → Transcription).')
  if (!existsSync(mp3Path)) throw new Error(`Audio file not found: ${mp3Path}`)

  const size = statSync(mp3Path).size
  L.info(`transcribe: starting Groq transcription for ${mp3Path} (${mb(size)})`)
  if (size <= MAX_DIRECT_BYTES) {
    opts.onProgress?.('Sending audio to Groq')
    return transcribeOneWithRetry(mp3Path, apiKey, model, 'audio', opts.onProgress)
  }

  L.info(`transcribe: audio is ${mb(size)}; chunking for Groq upload limit`)
  const chunks = await chunkAudio(mp3Path, opts.onProgress)
  try {
    const out: RawWord[] = []
    for (let i = 0; i < chunks.length; i++) {
      const offset = i * CHUNK_SECONDS
      const label = `chunk ${i + 1}/${chunks.length}`
      const words = await transcribeOneWithRetry(chunks[i], apiKey, model, label, opts.onProgress)
      out.push(...words.map((w) => ({ ...w, start: w.start + offset, end: w.end + offset })))
      opts.onProgress?.(`Merged ${i + 1}/${chunks.length} chunk${chunks.length === 1 ? '' : 's'}`)
    }
    L.info(`transcribe: merged ${out.length} word(s) from ${chunks.length} chunk(s)`)
    return out
  } catch (e) {
    L.error(`transcribe: failed; no partial transcript will be saved: ${sanitizeError(e)}`)
    throw e
  } finally {
    const dir = chunks[0] ? dirname(chunks[0]) : ''
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      L.info(`transcribe: cleaned chunk temp dir ${dir}`)
    }
  }
}
