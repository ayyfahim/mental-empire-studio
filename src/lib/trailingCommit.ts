export interface TrailingCommit<T> {
  /** Record a new value; (re)schedules the debounced commit `delayMs` out. */
  update(value: T): void
  /** Commit immediately if a value is pending, and cancel the pending timer. */
  flush(): void
  /** Drop any pending value without committing it. */
  cancel(): void
}

/** A trailing debounce with a manual flush — for controls (e.g. a drag slider) that
 *  must stay visually responsive on every tick while deferring an expensive commit
 *  (e.g. a persistent IPC mutation) until the drag pauses or is explicitly released. */
export function createTrailingCommit<T>(commit: (value: T) => void, delayMs: number): TrailingCommit<T> {
  let pending = false
  let latest: T
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    update(value) {
      latest = value
      pending = true
      clearTimer()
      timer = setTimeout(() => {
        timer = null
        pending = false
        commit(latest)
      }, delayMs)
    },
    flush() {
      clearTimer()
      if (pending) {
        pending = false
        commit(latest)
      }
    },
    cancel() {
      clearTimer()
      pending = false
    }
  }
}
