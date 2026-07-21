import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTrailingCommit } from '../../src/lib/trailingCommit'

describe('createTrailingCommit (slider debounce/flush)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not commit synchronously on update — stays visually responsive without an immediate IPC call', () => {
    const commit = vi.fn()
    const trailing = createTrailingCommit(commit, 150)
    trailing.update(10)
    expect(commit).not.toHaveBeenCalled()
  })

  it('commits only the final value after rapid ticks, not one per tick', () => {
    const commit = vi.fn()
    const trailing = createTrailingCommit(commit, 150)
    for (let v = 1; v <= 20; v++) {
      trailing.update(v)
      vi.advanceTimersByTime(50) // faster than the 150ms debounce window
    }
    expect(commit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(150)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith(20)
  })

  it('flush() commits immediately with the latest value and cancels the pending timer', () => {
    const commit = vi.fn()
    const trailing = createTrailingCommit(commit, 150)
    trailing.update(5)
    trailing.flush()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith(5)
    vi.advanceTimersByTime(150)
    expect(commit).toHaveBeenCalledTimes(1) // no second, stale commit from the cancelled timer
  })

  it('flush() with nothing pending is a no-op', () => {
    const commit = vi.fn()
    const trailing = createTrailingCommit(commit, 150)
    trailing.flush()
    expect(commit).not.toHaveBeenCalled()
  })

  it('cancel() drops a pending value without ever committing it', () => {
    const commit = vi.fn()
    const trailing = createTrailingCommit(commit, 150)
    trailing.update(99)
    trailing.cancel()
    vi.advanceTimersByTime(150)
    expect(commit).not.toHaveBeenCalled()
  })

  it('a value committed by the debounce timer is the final one, even across multiple bursts', () => {
    const commit = vi.fn()
    const trailing = createTrailingCommit(commit, 150)
    trailing.update(1)
    vi.advanceTimersByTime(150)
    expect(commit).toHaveBeenLastCalledWith(1)
    trailing.update(2)
    trailing.update(3)
    vi.advanceTimersByTime(150)
    expect(commit).toHaveBeenCalledTimes(2)
    expect(commit).toHaveBeenLastCalledWith(3)
  })
})
