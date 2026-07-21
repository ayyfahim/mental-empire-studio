import { describe, expect, it } from 'vitest'
import { decideAutomationUpload, selectEligibleCandidates } from '../../shared/automationSelection'
import type { ScrapedVideo, Upload } from '../../shared/types'

const video = (id: string, title = `Video ${id}`, durationSec = 600): ScrapedVideo => ({ id, title, durationSec, views: 0, uploadDate: '', thumb: '' })
const upload = (id: string, title: string, youtubeVideoId?: string): Upload => ({ id, myChannelId: 'mine', title, youtubeVideoId, publishedAt: '', views: '', thumb: '' })

describe('upload-aware Automation selection', () => {
  it('skips exact YouTube IDs', () => expect(decideAutomationUpload(video('abc'), [upload('up', 'Different title', 'abc')], null).matchType).toBe('exact-id'))
  it('skips high-confidence normalized titles', () => expect(decideAutomationUpload(video('a', 'POWER of daily discipline!'), [upload('up', 'Power of Daily Discipline')], null)).toMatchObject({ matchType: 'high-title', action: 'skipped-uploaded' }))
  it('keeps ambiguous matches eligible', () => expect(decideAutomationUpload(video('a', 'Build Discipline Every Single Day'), [upload('up', 'Build Discipline Today')], null, [0.4, 0.9])).toMatchObject({ matchType: 'ambiguous-title', action: 'eligible-ambiguous' }))
  it('fills three requested items after earlier uploaded candidates', () => {
    const candidates = [video('1'), video('2'), video('3'), video('4'), video('5')]
    const result = selectEligibleCandidates(candidates, { requested: 3, minDurationSec: 0, uploads: [upload('u1', 'x', '1'), upload('u2', 'x', '2')] })
    expect(result.selected.map((row) => row.id)).toEqual(['3', '4', '5'])
  })
  it('reports source exhaustion and scans beyond fifty skipped candidates', () => {
    const candidates = Array.from({ length: 61 }, (_, index) => video(String(index)))
    const uploads = candidates.slice(0, 58).map((row) => upload(`u-${row.id}`, row.title, row.id))
    const result = selectEligibleCandidates(candidates, { requested: 4, minDurationSec: 0, uploads })
    expect(result.selected).toHaveLength(3)
    expect(result.decisions).toHaveLength(61)
    expect(result.exhausted).toBe(true)
  })
  it('manual uploaded state wins', () => expect(decideAutomationUpload(video('a'), [], true).matchType).toBe('manual'))
})
