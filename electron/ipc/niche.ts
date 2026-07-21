import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import type { Niche } from '../../shared/types'
import { getRepos } from '../db'
import { getSettings } from '../store/settings'
import { normalizeNiche, poolKeyForNiche } from '../services/niche'
import { cachedBrollClipCount, hasConfiguredBrollSource, readNichePoolHealth, warmBrollLibraryFromNiche } from '../services/broll'
import { refreshNichePools } from '../services/pool-refresh'
import { hhmm, pushActivity } from './events'
import { L } from '../services/logger'

// IPC for niche b-roll pools (P3): CRUD for the global niche list, channel assignment,
// pool-health reads, and an explicit "warm pool" action. Pool storage + selection reuse
// the existing b-roll library machinery (keyed by niche-<id>).

function poolHealthAll(): ReturnType<typeof readNichePoolHealth>[] {
  return getRepos().niches().map((n) => readNichePoolHealth(n.id))
}

export function registerNicheIpc(): void {
  ipcMain.handle('niche:list', () => getRepos().niches())
  ipcMain.handle('niche:poolHealth', () => poolHealthAll())

  // Top up + prune every niche pool now (manual trigger; the scheduler also does this
  // on a due-gated cadence).
  ipcMain.handle('niche:refreshAll', async () => {
    const n = await refreshNichePools({ force: true })
    L.info(`manual pool refresh: ${n} niche(s)`)
    return poolHealthAll()
  })

  ipcMain.handle('niche:save', (_e, input: Partial<Niche>) => {
    const niche = normalizeNiche({ ...input, id: input.id && input.id.trim() ? input.id : `niche-${randomUUID().slice(0, 8)}` })
    getRepos().saveNiche(niche)
    return getRepos().niches()
  })

  ipcMain.handle('niche:delete', (_e, id: string) => {
    getRepos().deleteNiche(id)
    return getRepos().niches()
  })

  ipcMain.handle('niche:assignChannel', (_e, channelId: string, nicheId: string | null) => {
    getRepos().setSourceChannelNiche(channelId, nicheId && nicheId.trim() ? nicheId : null)
    return getRepos().sourceChannels()
  })

  // Fill/top-up a niche's pool from its keywords (network; reuses the library warmer).
  ipcMain.handle('niche:warm', async (_e, id: string) => {
    const niche = getRepos().niches().find((n) => n.id === id)
    if (!niche) throw new Error('niche not found')
    try {
      if (niche.keywords.length === 0) throw new Error('Add at least one B-roll search phrase before warming this pool.')
      const settings = getSettings()
      const poolKey = poolKeyForNiche(id)
      if (!hasConfiguredBrollSource(settings) && cachedBrollClipCount(poolKey) === 0) {
        throw new Error('No stock-footage source is configured. Add a Pexels, Pixabay, or Coverr API key in Settings, then warm the pool again.')
      }
      const res = await warmBrollLibraryFromNiche(settings, niche)
      const health = readNichePoolHealth(id)
      if (!res && health.clips === 0) throw new Error('The pool did not find any usable clips. Check its search phrases and stock-provider settings.')
      pushActivity({ t: hhmm(), icon: '🎞', color: '#36c98e', text: `B-roll pool "${niche.name}" — ${health.clips} clips` })
      L.info(`niche pool warmed id=${id} clips=${health.clips} result=${res ? 'ok' : 'noop'}`)
      return health
    } catch (e) {
      L.warn(`niche pool warm failed id=${id}: ${(e as Error).message}`)
      throw e
    }
  })
}
