import { describe, expect, it } from 'vitest'
import { reqMotionQuery } from '../../electron/ipc/talkingphotos'

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
})
