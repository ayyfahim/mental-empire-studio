import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TALKINGPHOTOS_CONNECTION_ID, TALKINGPHOTOS_PARTITION, TALKINGPHOTOS_PROVIDER } from '../../shared/talkingphotos'
import type { ProviderConnection } from '../../shared/talkingphotos'

// Connection lifecycle (session.ts): non-blocking connect(), the push-event state
// machine driven by the poll / navigation / cookie-change signals, single-flight
// window reuse, and full teardown on disconnect. BrowserWindow, the partition
// session/cookies, the DB repo, the logger, and healthCheck are all faked so this
// exercises session.ts's orchestration in isolation, under vitest's fake timers
// (no real 2.5s poll / 15-minute timeout waits).

/** Never expected to appear in any emitted event or logged message — the
 *  cookie-change listener must treat this purely as a "something changed" signal. */
const COOKIE_SENTINEL = 'super-secret-session-cookie-value-should-never-leak'

interface FakeWindowHandle {
  webContents: EventEmitter & { setWindowOpenHandler: () => void }
  focusCalls: number
  showCalls: number
  loadURLCalls: string[]
  isDestroyed(): boolean
  close(): void
  focus(): void
  show(): void
  loadURL(url: string): void
  on(event: string, cb: (...args: unknown[]) => void): unknown
  emit(event: string, ...args: unknown[]): unknown
}

// NOTE: deliberately built with plain functions/objects, not `class X extends
// EventEmitter` — a class *declaration* inside a vi.mock factory that extends an
// imported identifier trips Vitest's factory-hoisting (it moves the class statement
// above the 'node:events' import that it needs), so no ES6 `extends` of an imported
// symbol is used inside this factory body.
vi.mock('electron', () => {
  function makeEmitter(): EventEmitter {
    const target: Record<string, unknown> = {}
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    target.on = (event: string, cb: (...args: unknown[]) => void) => {
      const set = listeners.get(event) ?? new Set()
      set.add(cb)
      listeners.set(event, set)
      return target
    }
    target.removeListener = (event: string, cb: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(cb)
      return target
    }
    target.emit = (event: string, ...args: unknown[]) => {
      for (const cb of Array.from(listeners.get(event) ?? [])) cb(...args)
      return true
    }
    return target as unknown as EventEmitter
  }

  function makeWebContents(): EventEmitter & { setWindowOpenHandler: () => void } {
    const emitter = makeEmitter() as unknown as Record<string, unknown>
    emitter.setWindowOpenHandler = () => {}
    return emitter as unknown as EventEmitter & { setWindowOpenHandler: () => void }
  }

  function BrowserWindow(opts: unknown): FakeWindowHandle {
    const emitter = makeEmitter() as unknown as Record<string, unknown>
    let destroyed = false
    const win = {
      ...emitter,
      opts,
      webContents: makeWebContents(),
      focusCalls: 0,
      showCalls: 0,
      loadURLCalls: [] as string[],
      focus(): void { win.focusCalls++ },
      show(): void { win.showCalls++ },
      isDestroyed(): boolean { return destroyed },
      close(): void {
        if (destroyed) return
        destroyed = true
        queueMicrotask(() => (win.emit as (e: string) => void)('closed'))
      },
      loadURL(url: string): void { win.loadURLCalls.push(url) }
    } as unknown as FakeWindowHandle
    instances.push(win)
    return win
  }

  const instances: FakeWindowHandle[] = []
  return { BrowserWindow, __instances: instances }
})

const warnMock = vi.fn()
vi.mock('../../electron/services/logger', () => ({ L: { info: vi.fn(), warn: warnMock, error: vi.fn() } }))

const emitMock = vi.fn()
vi.mock('../../electron/ipc/events', () => ({ emit: emitMock }))

const healthCheckMock = vi.fn(async () => ({ ok: false, reauthRequired: false }) as { ok: boolean; reauthRequired: boolean; message?: string })
vi.mock('../../electron/providers/talkingphotos/client', () => ({ healthCheck: healthCheckMock }))

const fakeCookies = new EventEmitter()
const clearProviderSessionStorageMock = vi.fn(async () => {})
vi.mock('../../electron/providers/talkingphotos/partition', () => ({
  getProviderSession: () => ({ cookies: fakeCookies }),
  clearProviderSessionStorage: clearProviderSessionStorageMock
}))

const connections = new Map<string, ProviderConnection>()
vi.mock('../../electron/db', () => ({
  getRepos: () => ({
    providerConnection: (id: string) => connections.get(id),
    upsertProviderConnection: (row: ProviderConnection) => connections.set(row.id, row)
  })
}))

const { connectTalkingPhotos, disconnectTalkingPhotos, reconnectTalkingPhotos, reconcileInterruptedConnectionOnStartup } = await import('../../electron/providers/talkingphotos/session')
const electronMock = (await import('electron')) as unknown as { __instances: FakeWindowHandle[] }

function latestWindow(): FakeWindowHandle {
  const win = electronMock.__instances[electronMock.__instances.length - 1]
  if (!win) throw new Error('no BrowserWindow was created')
  return win
}

/** Every status pushed over the 'talkingphotos:connectionStatus' event, in order. */
function emittedStatuses(): string[] {
  return emitMock.mock.calls.filter((c) => c[0] === 'talkingphotos:connectionStatus').map((c) => (c[1] as ProviderConnection).status)
}

function lastEmittedConnection(): ProviderConnection {
  const calls = emitMock.mock.calls.filter((c) => c[0] === 'talkingphotos:connectionStatus')
  return calls[calls.length - 1][1] as ProviderConnection
}

/** Every argument ever passed to emit() or L.warn(), flattened to one blob any
 *  leaked cookie text would have to show up in. */
function everyLoggedOrEmittedText(): string {
  return JSON.stringify([...emitMock.mock.calls, ...warnMock.mock.calls])
}

beforeEach(() => {
  vi.useFakeTimers()
  connections.clear()
  const now = new Date().toISOString()
  connections.set(TALKINGPHOTOS_CONNECTION_ID, {
    id: TALKINGPHOTOS_CONNECTION_ID,
    provider: TALKINGPHOTOS_PROVIDER,
    partition: TALKINGPHOTOS_PARTITION,
    status: 'disconnected',
    createdAt: now,
    updatedAt: now
  })
  emitMock.mockClear()
  warnMock.mockClear()
  clearProviderSessionStorageMock.mockClear()
  healthCheckMock.mockReset()
  healthCheckMock.mockResolvedValue({ ok: false, reauthRequired: false })
  electronMock.__instances.length = 0
  fakeCookies.removeAllListeners()
})

afterEach(async () => {
  // Always drive any flow left running by a test back to a clean, settled state
  // before the next test runs — session.ts's window/timer state is module-level.
  await disconnectTalkingPhotos()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('TalkingPhotos connect() — non-blocking', () => {
  it('resolves as soon as the login window opens, without waiting for the full auth flow', async () => {
    healthCheckMock.mockImplementation(() => new Promise(() => {})) // never resolves
    const result = await connectTalkingPhotos()
    expect(result.status).toBe('waiting_for_login')
    expect(electronMock.__instances).toHaveLength(1)
    expect(healthCheckMock).not.toHaveBeenCalled()
  })
})

describe('TalkingPhotos connect() — status transitions', () => {
  it('emits connecting -> waiting_for_login -> verifying -> connected when the periodic poll succeeds', async () => {
    await connectTalkingPhotos()
    expect(emittedStatuses()).toEqual(['connecting', 'waiting_for_login'])

    healthCheckMock.mockResolvedValue({ ok: true, reauthRequired: false })
    await vi.advanceTimersByTimeAsync(2_500)

    expect(emittedStatuses()).toEqual(['connecting', 'waiting_for_login', 'verifying', 'connected'])
    expect(latestWindow().isDestroyed()).toBe(true)
  })

  it('emits verifying -> connected when a did-navigate event triggers the debounced check', async () => {
    await connectTalkingPhotos()
    const win = latestWindow()
    healthCheckMock.mockResolvedValue({ ok: true, reauthRequired: false })

    win.webContents.emit('did-navigate')
    await vi.advanceTimersByTimeAsync(400)

    expect(emittedStatuses()).toEqual(['connecting', 'waiting_for_login', 'verifying', 'connected'])
    expect(healthCheckMock).toHaveBeenCalledTimes(1)
  })

  it('emits verifying -> connected when a debounced cookie-change check succeeds, and never leaks the cookie payload', async () => {
    await connectTalkingPhotos()
    healthCheckMock.mockResolvedValue({ ok: true, reauthRequired: false })

    fakeCookies.emit('changed', {}, { name: 'session', value: COOKIE_SENTINEL, domain: 'app.talkingphotos.ai' }, 'explicit', false)
    await vi.advanceTimersByTimeAsync(400)

    expect(emittedStatuses()).toEqual(['connecting', 'waiting_for_login', 'verifying', 'connected'])
    expect(healthCheckMock).toHaveBeenCalledTimes(1)
    expect(everyLoggedOrEmittedText()).not.toContain(COOKIE_SENTINEL)
  })

  it('debounces a burst of navigation/cookie signals into a single health check', async () => {
    await connectTalkingPhotos()
    const win = latestWindow()
    healthCheckMock.mockResolvedValue({ ok: true, reauthRequired: false })

    win.webContents.emit('did-finish-load')
    await vi.advanceTimersByTimeAsync(100)
    win.webContents.emit('did-navigate')
    await vi.advanceTimersByTimeAsync(100)
    fakeCookies.emit('changed', {}, {}, 'explicit', false)
    await vi.advanceTimersByTimeAsync(400)

    expect(healthCheckMock).toHaveBeenCalledTimes(1)
    expect(lastEmittedConnection().status).toBe('connected')
  })

  it('emits a terminal attention status (not connected) when the window is closed before success', async () => {
    await connectTalkingPhotos()
    const win = latestWindow()

    win.close()
    await vi.advanceTimersByTimeAsync(0)

    expect(emittedStatuses()).toEqual(['connecting', 'waiting_for_login', 'attention'])
    expect(lastEmittedConnection().lastError).toBeTruthy()

    // No dangling poll/timeout after teardown.
    healthCheckMock.mockClear()
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(healthCheckMock).not.toHaveBeenCalled()
  })

  it('emits a terminal attention status (not connected) when the login times out', async () => {
    await connectTalkingPhotos()

    await vi.advanceTimersByTimeAsync(15 * 60_000)

    const statuses = emittedStatuses()
    expect(statuses[statuses.length - 1]).toBe('attention')
    expect(lastEmittedConnection().lastError).toBeTruthy()
    expect(latestWindow().isDestroyed()).toBe(true)

    // No dangling poll after the timeout has already settled the flow.
    healthCheckMock.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(healthCheckMock).not.toHaveBeenCalled()
  })
})

describe('TalkingPhotos connect() — single-flight', () => {
  it('focuses the existing login window instead of closing and reopening it', async () => {
    await connectTalkingPhotos()
    const win = latestWindow()

    await connectTalkingPhotos()

    expect(electronMock.__instances).toHaveLength(1)
    expect(win.focusCalls).toBe(1)
    expect(win.showCalls).toBe(1)
  })
})

describe('TalkingPhotos disconnect()', () => {
  it('cancels every timer and listener — no health check fires afterward even if time advances', async () => {
    await connectTalkingPhotos()
    const win = latestWindow()
    healthCheckMock.mockClear()

    const result = await disconnectTalkingPhotos()

    expect(result.status).toBe('disconnected')
    expect(clearProviderSessionStorageMock).toHaveBeenCalledTimes(1)
    expect(win.isDestroyed()).toBe(true)

    await vi.advanceTimersByTimeAsync(20 * 60_000) // past both the poll interval and the 15-minute timeout
    expect(healthCheckMock).not.toHaveBeenCalled()

    // The cookie-change listener was detached, not just ignored.
    expect(fakeCookies.listenerCount('changed')).toBe(0)
    fakeCookies.emit('changed', {}, {}, 'explicit', false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(healthCheckMock).not.toHaveBeenCalled()
  })
})

describe('TalkingPhotos reconnectTalkingPhotos()', () => {
  it('tries headlessly first and never opens a window when the session is still valid', async () => {
    healthCheckMock.mockResolvedValue({ ok: true, reauthRequired: false })
    const result = await reconnectTalkingPhotos()
    expect(result.status).toBe('connected')
    expect(electronMock.__instances).toHaveLength(0)
  })

  it('falls back to the full connect() flow when the headless check fails', async () => {
    healthCheckMock.mockResolvedValue({ ok: false, reauthRequired: false })
    const result = await reconnectTalkingPhotos()
    expect(result.status).toBe('waiting_for_login')
    expect(electronMock.__instances).toHaveLength(1)
  })

  it('tears down an already-open login window if the headless check succeeds while one is in progress', async () => {
    healthCheckMock.mockResolvedValue({ ok: false, reauthRequired: false })
    await connectTalkingPhotos()
    const win = latestWindow()
    expect(win.isDestroyed()).toBe(false)

    healthCheckMock.mockResolvedValue({ ok: true, reauthRequired: false })
    const result = await reconnectTalkingPhotos()

    expect(result.status).toBe('connected')
    expect(win.isDestroyed()).toBe(true)

    // No dangling poll/timeout left running from the flow that was torn down.
    healthCheckMock.mockClear()
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(healthCheckMock).not.toHaveBeenCalled()
  })
})

describe('reconcileInterruptedConnectionOnStartup()', () => {
  it.each(['connecting', 'waiting_for_login', 'verifying'] as const)(
    'converts a stale "%s" row (left over from a crash/restart) to attention',
    (staleStatus) => {
      connections.set(TALKINGPHOTOS_CONNECTION_ID, {
        ...(connections.get(TALKINGPHOTOS_CONNECTION_ID) as ProviderConnection),
        status: staleStatus
      })
      reconcileInterruptedConnectionOnStartup()
      const row = connections.get(TALKINGPHOTOS_CONNECTION_ID)
      expect(row?.status).toBe('attention')
      expect(row?.lastError).toContain('restart')
      expect(lastEmittedConnection().status).toBe('attention')
    }
  )

  it.each(['disconnected', 'connected', 'reauth_required', 'attention'] as const)(
    'leaves an already-terminal "%s" row untouched',
    (terminalStatus) => {
      connections.set(TALKINGPHOTOS_CONNECTION_ID, {
        ...(connections.get(TALKINGPHOTOS_CONNECTION_ID) as ProviderConnection),
        status: terminalStatus
      })
      emitMock.mockClear()
      reconcileInterruptedConnectionOnStartup()
      const row = connections.get(TALKINGPHOTOS_CONNECTION_ID)
      expect(row?.status).toBe(terminalStatus)
      expect(emitMock).not.toHaveBeenCalled()
    }
  )
})
