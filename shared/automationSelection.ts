import type { AutomationSelectionDecision, ScrapedVideo, Upload } from './types'
import { titleMatchScore } from './match'

export function decideAutomationUpload(video: ScrapedVideo, uploads: Upload[], manualUploaded: boolean | null, bands: [number, number] = [0.6, 0.82]): AutomationSelectionDecision {
  if (manualUploaded === true) return { videoId: video.id, title: video.title, matchType: 'manual', score: 1, action: 'skipped-uploaded' }
  const exact = uploads.find((upload) => upload.youtubeVideoId === video.id || upload.id === video.id)
  if (exact) return { videoId: video.id, title: video.title, matchType: 'exact-id', score: 1, action: 'skipped-uploaded', matchedUploadId: exact.id, matchedTitle: exact.title }
  let best: { upload: Upload; score: number } | undefined
  for (const upload of uploads) {
    const score = titleMatchScore(video.title, upload.title)
    if (!best || score > best.score) best = { upload, score }
  }
  const floor = Math.min(...bands)
  const high = Math.max(...bands)
  if (best && best.score >= high) return { videoId: video.id, title: video.title, matchType: 'high-title', score: best.score, action: 'skipped-uploaded', matchedUploadId: best.upload.id, matchedTitle: best.upload.title }
  if (best && best.score >= floor) return { videoId: video.id, title: video.title, matchType: 'ambiguous-title', score: best.score, action: 'eligible-ambiguous', matchedUploadId: best.upload.id, matchedTitle: best.upload.title }
  return { videoId: video.id, title: video.title, matchType: 'none', score: best?.score ?? 0, action: 'selected' }
}

export function selectEligibleCandidates(candidates: ScrapedVideo[], opts: {
  requested: number
  minDurationSec: number
  uploads?: Upload[]
  manualUploaded?: Map<string, boolean | null>
  bands?: [number, number]
}): { selected: ScrapedVideo[]; decisions: AutomationSelectionDecision[]; exhausted: boolean } {
  const selected: ScrapedVideo[] = []
  const decisions: AutomationSelectionDecision[] = []
  for (const video of candidates) {
    let decision = decideAutomationUpload(video, opts.uploads || [], opts.manualUploaded?.get(video.id) ?? null, opts.bands)
    if (video.durationSec < opts.minDurationSec) decision = { ...decision, action: 'excluded-duration' }
    decisions.push(decision)
    if (decision.action === 'selected' || decision.action === 'eligible-ambiguous') selected.push(video)
    if (selected.length >= opts.requested) break
  }
  return { selected, decisions, exhausted: selected.length < opts.requested }
}
