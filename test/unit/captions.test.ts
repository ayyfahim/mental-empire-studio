import { describe, it, expect } from 'vitest'
import { buildAss, type CaptionOptions } from '../../electron/services/captions'
import type { TranscriptWord } from '../../shared/types'

function words(n: number): TranscriptWord[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `w${i}`, projectId: 'p', ord: i, word: `word${i}`, start: i * 0.4, end: i * 0.4 + 0.35, emphasis: false
  }))
}

const base: CaptionOptions = { preset: 'Hormozi', aspect: '16:9', keywords: false, lines: 1 }

function dialogueLines(ass: string): string[] {
  return ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
}

describe('buildAss — caption flicker fix (G1)', () => {
  it('word mode keeps one dialogue per word but fades only the first + last of a group', () => {
    const { ass } = buildAss(words(4), { ...base, mode: 'word', perGroup: 4 })
    const lines = dialogueLines(ass)
    expect(lines.length).toBe(4)
    // The flicker bug was a \fad on EVERY per-word event. Now only first-in + last-out.
    const fadCount = (ass.match(/\\fad\(/g) ?? []).length
    expect(fadCount).toBe(2)
  })

  it('does not put a fade on mid-group words', () => {
    const { ass } = buildAss(words(5), { ...base, mode: 'word', perGroup: 5 })
    const fadCount = (ass.match(/\\fad\(/g) ?? []).length
    expect(fadCount).toBeLessThan(dialogueLines(ass).length)
    expect(fadCount).toBe(2)
  })

  it('phrase mode collapses a group to a single dialogue', () => {
    const { ass } = buildAss(words(4), { ...base, mode: 'phrase', perGroup: 4 })
    expect(dialogueLines(ass).length).toBe(1)
  })

  it('Boxed (legacy Submagic) uses a colour box and stays word-by-word', () => {
    const { ass } = buildAss(words(3), {
      ...base,
      preset: 'Submagic',
      mode: 'phrase',
      wordsPerPage: 2,
      highlightBox: { enabled: true, boxColor: '#00ff00', textColor: '#111111' }
    })
    const lines = dialogueLines(ass)
    expect(lines.length).toBe(3) // one event per word even when phrase mode was asked
    expect(ass).toContain('&H0000FF00') // box colour in the style's BackColour
    expect(ass).toContain('&H00111111') // box text colour
    expect(ass).toMatch(/,0,0,3,\d+(\.\d+)?,0,5,/) // BorderStyle 3 opaque box, alignment 5
    // two-word pages: the first page shows both its words, never the next page's
    expect(lines[0]).toContain('WORD0')
    expect(lines[0]).toContain('WORD1')
    expect(lines[0]).not.toContain('WORD2')
  })
})
