import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

const runRoot = process.argv[2]
if (!runRoot) throw new Error('Usage: node transcribe-and-caption.mjs <run-root>')

const channels = ['MindCipher', 'NeuralVault', 'PsycheNoir', 'DisciplineDoctrine']
const groqUrl = 'https://api.groq.com/openai/v1/audio/transcriptions'
const model = 'whisper-large-v3-turbo'
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe'
const apiKey = process.env.GROQ_API_KEY || ''
if (!apiKey) throw new Error('GROQ_API_KEY is unavailable')

function atomicJson(path, value) {
  const temp = `${path}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}

function atomicText(path, value) {
  const temp = `${path}.tmp`
  writeFileSync(temp, value, 'utf8')
  renameSync(temp, path)
}

function probeDuration(path) {
  const result = spawnSync(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path
  ], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`ffprobe failed for ${path}: ${(result.stderr || '').slice(-300)}`)
  const duration = Number.parseFloat(result.stdout.trim())
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid duration for ${path}`)
  return duration
}

function ensureChunks(channelRoot) {
  const source = join(channelRoot, 'source', 'source.mp3')
  const chunkDir = join(channelRoot, 'intermediate', 'transcribe-chunks')
  mkdirSync(chunkDir, { recursive: true })
  let chunks = readdirSync(chunkDir)
    .filter((name) => /^chunk-\d+\.mp3$/.test(name))
    .sort()
    .map((name) => join(chunkDir, name))

  if (chunks.length === 0) {
    const pattern = join(chunkDir, 'chunk-%03d.mp3')
    const result = spawnSync(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', source,
      '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'libmp3lame', '-b:a', '96k',
      '-f', 'segment', '-segment_time', '600', '-reset_timestamps', '1',
      pattern
    ], { encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) throw new Error(`Audio chunking failed: ${(result.stderr || '').slice(-500)}`)
    chunks = readdirSync(chunkDir)
      .filter((name) => /^chunk-\d+\.mp3$/.test(name))
      .sort()
      .map((name) => join(chunkDir, name))
  }
  if (chunks.length === 0) throw new Error(`No transcription chunks in ${chunkDir}`)
  for (const path of chunks) probeDuration(path)
  return chunks
}

function loadWordFile(path) {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed.words) && parsed.words.length > 0 ? parsed.words : null
  } catch {
    return null
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function transcribeChunkViaCurl(path) {
  // GROQ_USE_CURL=1 fallback: some networks fingerprint Node fetch as
  // unauthorized (HTTP 401) while curl with the same key succeeds.
  const curlBin = process.env.CURL_PATH || 'curl.exe'
  const args = [
    '-sS', '-m', '300',
    '-X', 'POST', groqUrl,
    '-H', `Authorization: Bearer ${apiKey}`,
    '-F', `file=@${path};type=audio/mpeg`,
    '-F', `model=${model}`,
    '-F', 'response_format=verbose_json',
    '-F', 'timestamp_granularities[]=word'
  ]
  const result = spawnSync(curlBin, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`curl exit ${result.status}: ${(result.stderr || '').slice(-300)}`)
  let json
  try {
    json = JSON.parse(result.stdout)
  } catch {
    throw new Error(`curl non-JSON reply: ${(result.stdout || '').slice(0, 300)}`)
  }
  if (json?.error) throw new Error(`Groq: ${JSON.stringify(json.error).slice(0, 300)}`)
  if (!Array.isArray(json.words) || json.words.length === 0) throw new Error('Groq returned no word timestamps')
  return json.words
}

async function transcribeChunk(path, label) {
  const buffer = readFileSync(path)
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      if (process.env.GROQ_USE_CURL === '1') return await transcribeChunkViaCurl(path)
      const form = new FormData()
      form.append('file', new Blob([buffer], { type: 'audio/mpeg' }), 'audio.mp3')
      form.append('model', model)
      form.append('response_format', 'verbose_json')
      form.append('timestamp_granularities[]', 'word')
      const response = await fetch(groqUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form
      })
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300)
        throw new Error(`HTTP ${response.status}: ${detail}`)
      }
      const json = await response.json()
      if (!Array.isArray(json.words) || json.words.length === 0) throw new Error('Groq returned no word timestamps')
      return json.words
    } catch (error) {
      lastError = error
      if (attempt < 3) await sleep(attempt * 2000)
    }
  }
  throw new Error(`${label} failed after 3 attempts: ${lastError?.message || lastError}`)
}

function assTime(seconds) {
  const centiseconds = Math.max(0, Math.round(seconds * 100))
  const hours = Math.floor(centiseconds / 360000)
  const minutes = Math.floor((centiseconds % 360000) / 6000)
  const secs = Math.floor((centiseconds % 6000) / 100)
  const cs = centiseconds % 100
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function assEscape(value) {
  return String(value)
    .replaceAll('\\', '')
    .replaceAll('{', '(')
    .replaceAll('}', ')')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ')
    .trim()
}

function phraseGroups(words) {
  const groups = []
  let current = []
  for (const word of words) {
    const clean = assEscape(word.word)
    if (!clean) continue
    const next = { word: clean, start: Number(word.start), end: Number(word.end) }
    if (!Number.isFinite(next.start) || !Number.isFinite(next.end)) continue
    const candidateText = [...current, next].map((item) => item.word).join(' ')
    const gap = current.length ? next.start - current.at(-1).end : 0
    const span = current.length ? next.end - current[0].start : 0
    if (current.length && (current.length >= 5 || candidateText.length > 34 || gap > 0.55 || span > 2.8)) {
      groups.push(current)
      current = []
    }
    current.push(next)
  }
  if (current.length) groups.push(current)
  return groups
}

function phraseText(group, activeIndex) {
  const midpoint = group.length >= 4 ? Math.ceil(group.length / 2) : -1
  return group.map((item, index) => {
    const prefix = index === activeIndex
      ? '{\\c&H00D7FF&\\fscx112\\fscy112}'
      : '{\\c&HFFFFFF&\\fscx100\\fscy100}'
    const suffix = index === activeIndex ? '{\\c&HFFFFFF&\\fscx100\\fscy100}' : ''
    const breakBefore = index === midpoint ? '\\N' : index > 0 ? ' ' : ''
    return `${breakBefore}${prefix}${item.word}${suffix}`
  }).join('')
}

function buildAss(words) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: TikTok,Montserrat ExtraBold,78,&H00FFFFFF,&H0000D7FF,&H00101010,&H64000000,-1,0,0,0,100,100,0,0,1,7,2,2,110,110,125,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`
  const events = []
  for (const group of phraseGroups(words)) {
    const groupEnd = Math.max(group.at(-1).end, group[0].start + 0.35)
    for (let index = 0; index < group.length; index += 1) {
      const start = Math.max(group[0].start, group[index].start)
      const nextStart = group[index + 1]?.start ?? groupEnd
      const end = Math.max(start + 0.08, nextStart)
      const intro = index === 0 ? '{\\fad(45,0)\\fscx94\\fscy94\\t(0,120,\\fscx100\\fscy100)}' : ''
      events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},TikTok,,0,0,0,,${intro}${phraseText(group, index)}`)
    }
  }
  return `${header}${events.join('\n')}\n`
}

async function processChannel(channel) {
  const channelRoot = join(runRoot, channel)
  if (!existsSync(join(channelRoot, 'source', 'source.mp3'))) {
    console.log(`${channel}: skipped (source audio not present)`)
    return
  }
  const wordsPath = join(channelRoot, 'transcript', 'words.json')
  const transcriptPath = join(channelRoot, 'transcript', 'transcript.txt')
  const assPath = join(channelRoot, 'captions', 'captions.ass')
  mkdirSync(join(channelRoot, 'transcript'), { recursive: true })
  mkdirSync(join(channelRoot, 'captions'), { recursive: true })
  const existing = loadWordFile(wordsPath)
  if (existing) {
    if (!existsSync(transcriptPath)) atomicText(transcriptPath, `${existing.map((word) => word.word).join(' ').replace(/\s+/g, ' ').trim()}\n`)
    if (!existsSync(assPath)) atomicText(assPath, buildAss(existing))
    console.log(`${channel}: reused ${existing.length} words`)
    return
  }

  const chunks = ensureChunks(channelRoot)
  const merged = []
  let offset = 0
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]
    const chunkWordsPath = chunk.replace(/\.mp3$/, '.words.json')
    let words = loadWordFile(chunkWordsPath)
    if (!words) {
      console.log(`${channel}: transcribing chunk ${index + 1}/${chunks.length}`)
      words = await transcribeChunk(chunk, `${channel} chunk ${index + 1}`)
      atomicJson(chunkWordsPath, { model, words })
    } else {
      console.log(`${channel}: reused chunk ${index + 1}/${chunks.length}`)
    }
    merged.push(...words.map((word) => ({
      word: String(word.word),
      start: Number(word.start) + offset,
      end: Number(word.end) + offset
    })))
    offset += probeDuration(chunk)
  }

  if (merged.length === 0) throw new Error(`${channel}: merged transcript is empty`)
  atomicJson(wordsPath, { model, source: 'Groq', words: merged })
  atomicText(transcriptPath, `${merged.map((word) => word.word).join(' ').replace(/\s+/g, ' ').trim()}\n`)
  atomicText(assPath, buildAss(merged))
  atomicJson(join(channelRoot, 'transcript', 'manifest.json'), {
    channel,
    model,
    chunkCount: chunks.length,
    wordCount: merged.length,
    durationSeconds: offset,
    completedAt: new Date().toISOString()
  })
  console.log(`${channel}: completed ${merged.length} words across ${chunks.length} chunks`)
}

for (const channel of channels) await processChannel(channel)
