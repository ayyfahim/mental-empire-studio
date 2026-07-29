import { ipcMain } from 'electron'
import type { MontageFootageRequest, MontageProduceOptions } from '../../shared/types'
import { getMontageCapabilities } from '../services/montage/capabilities'
import { retrieveFootage, cancelMontage } from '../services/montage/bridge'
import { composeViaMontage } from '../services/montage/montage-compose'

// OpenMontage bridge IPC: capability probe, footage/stock retrieval, full produce, and cancel.
// All heavy work runs in the Python subprocess (electron/services/montage/*).

export function registerMontageIpc(): void {
  ipcMain.handle('montage:capabilities', (_e, force?: boolean) => getMontageCapabilities(!!force))

  ipcMain.handle('montage:retrieveFootage', (_e, req: MontageFootageRequest) => {
    if (!req || !Array.isArray(req.queries) || req.queries.length === 0) {
      throw new Error('montage:retrieveFootage requires at least one query')
    }
    if (typeof req.outputDir !== 'string' || req.outputDir.trim() === '') {
      throw new Error('montage:retrieveFootage requires outputDir')
    }
    return retrieveFootage(req)
  })

  ipcMain.handle('montage:produce', (_e, projectId: string, opts?: MontageProduceOptions) => {
    if (typeof projectId !== 'string' || projectId.trim() === '') throw new Error('Invalid projectId')
    return composeViaMontage(projectId, opts)
  })

  ipcMain.handle('montage:cancel', (_e, id: string) => {
    cancelMontage(String(id))
  })
}
