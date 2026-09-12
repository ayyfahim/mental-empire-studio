import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const [channelRoot, imageDir, outputName] = process.argv.slice(2)
if (!channelRoot || !imageDir || !outputName) {
  throw new Error('Usage: node render-ramani.mjs <channel-root> <image-dir> <output-name>')
}


if (process.env.ME_ALLOW_LEGACY_STATIC_LOOP !== '1') {
  throw new Error(
    'Retired final renderer: this script only loops still images with captions. ' +
    'Use the channel edit plan and mixed-media assembly workflow. ' +
    'Set ME_ALLOW_LEGACY_STATIC_LOOP=1 only to reproduce a labeled historical rough.'
  )
}

console.warn(
  'LEGACY ROUGH MODE: output from render-ramani.mjs is a component/reference and must not be published as a final.'
)

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe'
const fontsDir = resolve(process.env.CAPTION_FONTS_DIR || 'resources/fonts')
const audioPath = join(channelRoot, 'source', 'source.mp3')
const assPath = join(channelRoot, 'captions', 'captions.ass')
const intermediateDir = join(channelRoot, 'intermediate')
const finalDir = join(channelRoot, 'final')
const manifestPath = join(intermediateDir, 'images.ffconcat')
const outputPath = join(finalDir, outputName)
const partialPath = `${outputPath}.partial.mp4`

for (const path of [audioPath, assPath, imageDir]) {
  if (!existsSync(path)) throw new Error(`Required input is missing: ${path}`)
}
mkdirSync(intermediateDir, { recursive: true })
mkdirSync(finalDir, { recursive: true })

function probeDuration(path) {
  const result = spawnSync(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', path
  ], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`ffprobe failed: ${(result.stderr || '').slice(-300)}`)
  const value = Number.parseFloat(result.stdout.trim())
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid duration for ${path}`)
  return value
}

function validFinal(path, expectedDuration) {
  if (!existsSync(path) || statSync(path).size < 1024 * 1024) return false
  try {
    return Math.abs(probeDuration(path) - expectedDuration) < 1.5
  } catch {
    return false
  }
}

function ffconcatQuote(path) {
  const normalized = resolve(path).replaceAll('\\', '/')
  if (normalized.includes("'")) throw new Error(`Image path contains an unsupported quote: ${normalized}`)
  return `'${normalized}'`
}

function filterPath(path) {
  return resolve(path).replaceAll('\\', '/').replace(/^([A-Za-z]):/, '$1\\:').replaceAll("'", "\\'")
}

const duration = probeDuration(audioPath)
if (validFinal(outputPath, duration)) {
  console.log(`Reused verified final: ${outputPath}`)
  process.exit(0)
}

const images = readdirSync(imageDir)
  .filter((name) => /\.(?:jpe?g|png|webp|bmp)$/i.test(name))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
  .map((name) => join(imageDir, name))
if (images.length === 0) throw new Error(`No images found in ${imageDir}`)

const entries = []
let elapsed = 0
let index = 0
while (elapsed < duration - 0.001) {
  const segmentDuration = Math.min(7, duration - elapsed)
  const image = images[index % images.length]
  entries.push({ image, duration: segmentDuration })
  elapsed += segmentDuration
  index += 1
}

const manifest = [
  'ffconcat version 1.0',
  ...entries.flatMap((entry) => [`file ${ffconcatQuote(entry.image)}`, `duration ${entry.duration.toFixed(6)}`]),
  `file ${ffconcatQuote(entries.at(-1).image)}`,
  ''
].join('\n')
writeFileSync(manifestPath, manifest, 'utf8')

const videoFilter = [
  'scale=1920:1080:force_original_aspect_ratio=increase',
  'crop=1920:1080',
  'setsar=1',
  'fps=30',
  `ass=filename='${filterPath(assPath)}':fontsdir='${filterPath(fontsDir)}'`,
  'format=yuv420p'
].join(',')

// VIDEO_ENCODER=libx264 fallback: this machine's NVIDIA driver (591.86) is older
// than this ffmpeg build's NVENC 13.1 minimum (610+). NVENC remains the default.
function videoEncoderArgs(cq) {
  if (process.env.VIDEO_ENCODER === 'libx264') {
    return ['-c:v', 'libx264', '-preset', process.env.X264_PRESET || 'veryfast',
      '-crf', process.env.X264_CRF || '20', '-maxrate', '12M', '-bufsize', '24M']
  }
  return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq',
    '-rc', 'vbr', '-cq', String(cq), '-b:v', '0', '-maxrate', '12M', '-bufsize', '24M']
}

const args = [
  '-y', '-hide_banner', '-loglevel', 'warning', '-stats', '-stats_period', '15',
  '-f', 'concat', '-safe', '0', '-i', manifestPath,
  '-i', audioPath,
  '-map', '0:v:0', '-map', '1:a:0',
  '-vf', videoFilter,
  '-t', duration.toFixed(3),
  ...videoEncoderArgs(21),
  '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
  '-movflags', '+faststart',
  partialPath
]

console.log(`${basename(channelRoot)}: rendering ${entries.length} seven-second slots with ${images.length} images`)
const result = spawnSync(ffmpeg, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
if (result.status !== 0) throw new Error(`FFmpeg render failed (${result.status}): ${(result.stderr || '').slice(-1500)}`)
if (!validFinal(partialPath, duration)) throw new Error(`Rendered file failed duration validation: ${partialPath}`)
if (existsSync(outputPath)) throw new Error(`Refusing to overwrite unexpected existing final: ${outputPath}`)
renameSync(partialPath, outputPath)
console.log(`Completed: ${outputPath}`)
