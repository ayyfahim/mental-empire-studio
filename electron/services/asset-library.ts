import { app, nativeImage } from 'electron'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { LibraryAsset } from '../../shared/types'
import { getRepos } from '../db'
import { contentAssetId } from './asset-hash'

export interface AssetImportContext {
  sourceId?: string
  channel?: string
  channelHandle?: string
  channelAvatar?: string
  projectId?: string
}

function roots(): { files: string; thumbs: string } {
  const base = join(app.getPath('userData'), 'asset-library')
  const files = join(base, 'files')
  const thumbs = join(base, 'thumbnails')
  mkdirSync(files, { recursive: true })
  mkdirSync(thumbs, { recursive: true })
  return { files, thumbs }
}

function mimeFor(path: string): string {
  return ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' } as Record<string, string>)[extname(path).toLowerCase()] || 'application/octet-stream'
}

function pathId(path: string): string { return createHash('sha256').update(path).digest('hex') }

function importOne(path: string, context: AssetImportContext, previous?: LibraryAsset): LibraryAsset {
  const now = new Date().toISOString()
  if (!existsSync(path)) {
    const id = previous?.id || pathId(path)
    return {
      id, path: previous?.canonicalPath || path, canonicalPath: previous?.canonicalPath || path, originalPath: previous?.originalPath || path,
      sourceId: context.sourceId || previous?.sourceId, channel: context.channel || previous?.channel || 'Unsorted',
      channelHandle: context.channelHandle || previous?.channelHandle, channelAvatar: context.channelAvatar || previous?.channelAvatar,
      thumbnailPath: previous?.thumbnailPath, mimeType: previous?.mimeType, width: previous?.width, height: previous?.height,
      fileSize: previous?.fileSize, addedAt: previous?.addedAt || now, firstAddedAt: previous?.firstAddedAt || previous?.addedAt || now,
      lastUsedAt: now, usageCount: previous?.usageCount || 1, missing: true, projectId: context.projectId || previous?.projectId
    }
  }
  const bytes = readFileSync(path)
  const id = contentAssetId(bytes)
  const ext = extname(path).toLowerCase() || '.img'
  const { files, thumbs } = roots()
  const existing = getRepos().listAssets().find((asset) => asset.id === id)
  const canonicalPath = existing?.canonicalPath || join(files, `${id}${ext}`)
  if (!existsSync(canonicalPath)) copyFileSync(path, canonicalPath)
  let thumbnailPath = join(thumbs, `${id}.png`)
  let width: number | undefined
  let height: number | undefined
  try {
    const image = nativeImage.createFromPath(canonicalPath)
    const size = image.getSize()
    width = size.width || undefined
    height = size.height || undefined
    if (!existsSync(thumbnailPath) && !image.isEmpty()) writeFileSync(thumbnailPath, image.resize({ width: 320, quality: 'good' }).toPNG())
  } catch {
    thumbnailPath = canonicalPath
  }
  return {
    id, path: canonicalPath, canonicalPath, originalPath: previous?.originalPath || path,
    sourceId: context.sourceId || existing?.sourceId || previous?.sourceId,
    channel: context.channel || existing?.channel || previous?.channel || 'Unsorted',
    channelHandle: context.channelHandle || existing?.channelHandle || previous?.channelHandle,
    channelAvatar: context.channelAvatar || existing?.channelAvatar || previous?.channelAvatar,
    thumbnailPath: existsSync(thumbnailPath) ? thumbnailPath : canonicalPath, mimeType: mimeFor(canonicalPath), width, height,
    fileSize: statSync(canonicalPath).size, addedAt: now, firstAddedAt: existing?.firstAddedAt || previous?.firstAddedAt || previous?.addedAt || now,
    lastUsedAt: now, usageCount: (existing?.usageCount || previous?.usageCount || 0) + 1, missing: false,
    projectId: context.projectId || existing?.projectId || previous?.projectId
  }
}

/** Import unique images into the durable content-addressed library and return canonical rows. */
export function ensureLibraryAssets(paths: string[], context: AssetImportContext = {}): LibraryAsset[] {
  const unique = [...new Set(paths.filter(Boolean))]
  const rows = unique.map((path) => importOne(path, context))
  getRepos().recordAssets(rows)
  return [...new Map(rows.map((row) => [row.id, row])).values()]
}

/** Lazily migrate old project-path rows without making DB viewing rewrite job JSON. */
export function migrateLegacyAssets(): LibraryAsset[] {
  const repos = getRepos()
  const current = repos.listAssets()
  for (const legacy of current) {
    const alreadyCanonical = legacy.canonicalPath.includes(`${join(app.getPath('userData'), 'asset-library')}`)
    if (alreadyCanonical && existsSync(legacy.canonicalPath)) continue
    const migrated = importOne(legacy.originalPath || legacy.path, {
      sourceId: legacy.sourceId, channel: legacy.channel || 'Unsorted', channelHandle: legacy.channelHandle,
      channelAvatar: legacy.channelAvatar, projectId: legacy.projectId
    }, legacy)
    repos.replaceAssetPath(legacy.path, migrated)
  }
  return repos.listAssets().map((asset) => ({ ...asset, missing: !existsSync(asset.canonicalPath) }))
}
