import { ipcMain } from 'electron'
import type { AssetImportContext } from '../services/asset-library'
import { ensureLibraryAssets, migrateLegacyAssets } from '../services/asset-library'

// Image library (P2 I): images used in past projects, grouped by channel, so a later
// project targeting the same channel can reuse the same set instead of re-picking from
// disk. Recorded as a side effect of compose:setImages (see ipc/compose.ts).

export function registerAssetsIpc(): void {
  ipcMain.handle('assets:list', () => migrateLegacyAssets())
  ipcMain.handle('assets:import', (_event, paths: string[], context?: AssetImportContext) => ensureLibraryAssets(paths, context))
}
