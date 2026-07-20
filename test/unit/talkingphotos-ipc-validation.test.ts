import { describe, expect, it } from 'vitest'
import { reqCreateInput, reqMotionQuery } from '../../electron/ipc/talkingphotos'

// IPC argument validation at the main-process boundary (renderer-supplied input is
// never trusted as-is — plan requirement + review item on validating ids/URLs/paths).

describe('TalkingPhotos IPC argument validation', () => {
  it('accepts a valid human motion query and normalizes optional fields', () => {
    expect(reqMotionQuery({ projectType: 'human', gender: 'female', aspectRatio: '16:9', style: 'normal' }))
      .toEqual({ projectType: 'human', gender: 'female', aspectRatio: '16:9', style: 'normal' })
  })

  it('drops an unsupported gender/aspectRatio instead of forwarding it to the provider', () => {
    expect(reqMotionQuery({ projectType: 'human', gender: 'robot', aspectRatio: '4:3' }))
      .toEqual({ projectType: 'human', gender: undefined, aspectRatio: undefined, style: undefined })
  })

  it('rejects a query with any projectType other than "human" (the only confirmed value)', () => {
    expect(() => reqMotionQuery({ projectType: 'avatar' })).toThrow()
    expect(() => reqMotionQuery({})).toThrow()
    expect(() => reqMotionQuery(null)).toThrow()
    expect(() => reqMotionQuery('human')).toThrow()
  })

  it('accepts a complete uploaded-audio Human creation request', () => {
    expect(reqCreateInput({ title: 'Video', audioPath: '/a.wav', characterImagePath: '/a.png', characterPrompt: 'Presenter', style: 'high_quality', aspectRatio: '16:9', motionId: 0 }))
      .toMatchObject({ title: 'Video', style: 'high_quality', motionId: 0 })
  })

  it('rejects unconfirmed styles, ratios, and invalid motion identifiers', () => {
    expect(() => reqCreateInput({ title: 'Video', audioPath: '/a.wav', characterImagePath: '/a.png', characterPrompt: 'Presenter', style: 'other', aspectRatio: '16:9', motionId: 0 })).toThrow()
    expect(() => reqCreateInput({ title: 'Video', audioPath: '/a.wav', characterImagePath: '/a.png', characterPrompt: 'Presenter', style: 'normal', aspectRatio: '4:3', motionId: 2 })).toThrow()
    expect(() => reqCreateInput({ title: 'Video', audioPath: '/a.wav', characterImagePath: '/a.png', characterPrompt: 'Presenter', style: 'normal', aspectRatio: '16:9', motionId: -1 })).toThrow()
  })
})
