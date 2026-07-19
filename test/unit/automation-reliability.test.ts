import { describe, expect, it } from 'vitest'
import { classifyAutomationError } from '../../electron/services/automation-supervisor'
import { seededBrollOrder } from '../../electron/services/broll'

describe('automation reliability helpers', () => {
  it('retries a download 403 but not an explicit login/cookie failure', () => {
    expect(classifyAutomationError(new Error('HTTP Error 403: Forbidden'), 'download')).toMatchObject({ kind: 'download', retryable: true })
    expect(classifyAutomationError(new Error('Sign in to confirm you are not a bot; cookies required'), 'download')).toMatchObject({ kind: 'authentication', retryable: false })
  })

  it('keeps b-roll shuffles stable per seed and different across projects', () => {
    const clips = Array.from({ length: 12 }, (_, index) => ({ id: `clip-${index}` }))
    const first = seededBrollOrder(clips, 101).map((clip) => clip.id)
    const rerender = seededBrollOrder(clips, 101).map((clip) => clip.id)
    const nextVideo = seededBrollOrder(clips, 202).map((clip) => clip.id)
    expect(rerender).toEqual(first)
    expect(nextVideo).not.toEqual(first)
  })
})
