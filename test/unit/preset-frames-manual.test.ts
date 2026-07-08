// Manual visual harness: renders one PNG per caption preset through real ffmpeg +
// libass with the bundled fonts, so a human can eyeball that presets genuinely
// differ. Run: npx vitest run test/unit/preset-frames-manual.test.ts
// Skips itself when the vendored ffmpeg is absent (run `npm run setup:ffmpeg`).
import { describe, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildAss } from '../../electron/services/captions'
import { CAPTION_PRESET_SPECS } from '../../shared/captionStyle'
import type { TranscriptWord } from '../../shared/types'

const OUT = process.env.PRESET_FRAMES_OUT ?? '/tmp/preset-frames'
const FF = join(process.cwd(), 'resources', 'bin', 'ffmpeg')
const FONTS = join(process.cwd(), 'resources', 'fonts')

const words: TranscriptWord[] = [
  { id: 'w0', projectId: 'p', ord: 0, word: 'You', start: 0, end: 0.4, emphasis: false },
  { id: 'w1', projectId: 'p', ord: 1, word: 'are', start: 0.4, end: 0.8, emphasis: false },
  { id: 'w2', projectId: 'p', ord: 2, word: 'NOT', start: 0.8, end: 3.0, emphasis: true },
  { id: 'w3', projectId: 'p', ord: 3, word: 'crazy', start: 3.0, end: 3.4, emphasis: false },
  { id: 'w4', projectId: 'p', ord: 4, word: 'anymore', start: 3.4, end: 3.8, emphasis: true }
]

describe('preset frame renders', () => {
  it.skipIf(!existsSync(FF))('renders one frame per preset', () => {
    mkdirSync(OUT, { recursive: true })
    for (const spec of CAPTION_PRESET_SPECS) {
      const { ass } = buildAss(words, { preset: spec.id, aspect: '16:9', keywords: false, lines: 1 })
      const assPath = join(OUT, `${spec.id}.ass`)
      writeFileSync(assPath, ass)
      const png = join(OUT, `${spec.id}.png`)
      const filter = `subtitles='${assPath}':fontsdir='${FONTS}'`
      const r = spawnSync(FF, [
        '-y', '-f', 'lavfi', '-i', 'gradients=s=1280x720:c0=0x1a2740:c1=0x0b0e14:d=4',
        '-vf', filter, '-ss', '1.2', '-frames:v', '1', png
      ], { encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`${spec.id}: ${r.stderr.slice(-400)}`)
      console.log(`rendered ${png}`)
    }
  }, 120000)
})
