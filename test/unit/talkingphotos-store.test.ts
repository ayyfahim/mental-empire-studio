import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConnection } from '../../shared/talkingphotos'
import { TALKINGPHOTOS_CONNECTION_ID, TALKINGPHOTOS_PARTITION, TALKINGPHOTOS_PROVIDER } from '../../shared/talkingphotos'
import { useTalkingPhotos } from '../../src/store/useTalkingPhotos'

function connection(status: ProviderConnection['status']): ProviderConnection {
  const now = new Date().toISOString()
  return {
    id: TALKINGPHOTOS_CONNECTION_ID,
    provider: TALKINGPHOTOS_PROVIDER,
    partition: TALKINGPHOTOS_PARTITION,
    status,
    createdAt: now,
    updatedAt: now
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  delete (globalThis as typeof globalThis & { window?: Window }).window
})

describe('TalkingPhotos renderer connection promotion', () => {
  it('updates Settings state immediately and refreshes capabilities after a connected event', async () => {
    let onConnectionStatusChanged: ((value: ProviderConnection) => void) | undefined
    const capabilities = vi.fn(async () => ({
      limits: { maxDurationSeconds: 60, maxCharactersTts: 5000, maxDurationPremiumSeconds: 60, maxCharactersTtsPremium: 5000 },
      usage: { concurrentCount: 0, concurrentLimit: 2, dailyUsage: 1, dailyLimit: 10 },
      fetchedAt: new Date().toISOString()
    }))
    const api = {
      talkingPhotos: {
        connectionStatus: vi.fn(async () => connection('waiting_for_login')),
        capabilities,
        jobs: vi.fn(async () => []),
        sync: vi.fn(async () => [])
      },
      onProviderJob: vi.fn(),
      onConnectionStatusChanged: vi.fn((callback: (value: ProviderConnection) => void) => {
        onConnectionStatusChanged = callback
        return () => {}
      })
    }
    Object.defineProperty(globalThis, 'window', { value: { api }, configurable: true })
    useTalkingPhotos.setState({ connection: null, connecting: false, capabilities: null, jobs: [], error: '', subscribed: false })

    await useTalkingPhotos.getState().init()
    expect(onConnectionStatusChanged).toBeTypeOf('function')
    onConnectionStatusChanged?.({ ...connection('connected'), lastVerifiedAt: new Date().toISOString() })

    await vi.waitFor(() => expect(capabilities).toHaveBeenCalledTimes(1))
    expect(useTalkingPhotos.getState().connection?.status).toBe('connected')
    expect(useTalkingPhotos.getState().connecting).toBe(false)
    expect(useTalkingPhotos.getState().capabilities?.usage.dailyLimit).toBe(10)
  })
})
