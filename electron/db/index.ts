import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { traceObject } from '../services/sentry'
import type {
  DownloadedVideo,
  MyChannel,
  Profile,
  SourceChannel,
  ThumbnailTemplate,
  ActivityRow,
  Upload,
  ScrapedVideo,
  Project,
  ProjectImage,
  ProjectImageMotionPatch,
  TranscriptWord,
  RecentUpload,
  RenderJob,
  RenderStatus,
  ScrapeOrder,
  ImageMode,
  MotionPreset,
  MotionDirection,
  WorkItem,
  Niche,
  SourceAutomationPatch,
  LibraryAsset,
  AutomationJob,
  AutomationJobItem,
  AutomationJobLog,
  AutomationWorkflowStep
} from '../../shared/types'
import { asBetaOpts, DEFAULT_BETA_OPTS } from '../../shared/types'
import { normalizeAutomationConfig } from '../../shared/automationConfig'
import type { ProviderAsset, ProviderConnection, ProviderJob, TranscriptDocument } from '../../shared/talkingphotos'
import { seedIfEmpty, seedDemoData, seedDefaultThumbnailTemplates } from './seed'
import { planProfileSourceMigration, type SourceMigrationCandidate } from './profile-source-migration'

// Embedded, synchronous SQLite (better-sqlite3) holds all domain data: channels,
// source links, download history, uploads, profiles, thumbnail templates, render
// jobs, activity log. Settings/secrets live in electron-store, not here.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS my_channels (
  id TEXT PRIMARY KEY, name TEXT, handle TEXT, mono TEXT, avatar TEXT,
  views TEXT, subs TEXT, total INTEGER,
  linkedSourceId TEXT, source TEXT,
  mapDone INTEGER, mapTotal INTEGER,
  weekDone INTEGER, weekGoal INTEGER, monthDone INTEGER, monthGoal INTEGER,
  reminder TEXT, reminderNote TEXT
);
CREATE TABLE IF NOT EXISTS source_channels (
  id TEXT PRIMARY KEY, url TEXT, handle TEXT, name TEXT
);
CREATE TABLE IF NOT EXISTS source_videos (
  id TEXT PRIMARY KEY, sourceId TEXT, title TEXT, durationSec INTEGER,
  views INTEGER, uploadDate TEXT, thumb TEXT, scrapedAt TEXT
);
CREATE TABLE IF NOT EXISTS downloaded_videos (
  id TEXT PRIMARY KEY, sourceId TEXT, title TEXT, channel TEXT,
  size TEXT, "when" TEXT, stage TEXT, pct TEXT, action TEXT, thumb TEXT
);
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY, myChannelId TEXT, title TEXT,
  youtubeVideoId TEXT, publishedAt TEXT, views TEXT, thumb TEXT, matchedDownloadId TEXT
);
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY, name TEXT, mono TEXT, avatar TEXT,
  rule TEXT, images TEXT, thumb TEXT, cap TEXT, out TEXT, autoWatch INTEGER
);
CREATE TABLE IF NOT EXISTS thumbnail_templates (
  id TEXT PRIMARY KEY, name TEXT, layers TEXT
);
CREATE TABLE IF NOT EXISTS render_jobs (
  id TEXT PRIMARY KEY, title TEXT, channel TEXT, status TEXT,
  pct INTEGER, createdAt TEXT, projectId TEXT
);
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t TEXT, icon TEXT, color TEXT, text TEXT
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, downloadId TEXT, title TEXT, channel TEXT,
  mp3Path TEXT, durationSec INTEGER,
  imageMode TEXT, poolSize INTEGER, kenBurns INTEGER, seed INTEGER, crossfade INTEGER,
  captionPreset TEXT, captionFont TEXT, captionAnim TEXT, captionAspect TEXT, captionLines INTEGER, captionPosition TEXT, captionPace TEXT,
  captionHighlightColor TEXT, captionBoxColor TEXT, captionWordsPerPage INTEGER,
  emphasis INTEGER, keywords INTEGER, punchZoom INTEGER,
  stage TEXT, thumbPath TEXT, thumbnailTemplateId TEXT,
  lookLut TEXT, lookStrength REAL, lookAdjust TEXT,
  motionPreset TEXT, betaOpts TEXT, createdAt TEXT
);
CREATE TABLE IF NOT EXISTS project_images (
  id TEXT PRIMARY KEY, projectId TEXT, ord INTEGER, path TEXT, thumb TEXT,
  rangeStart REAL, rangeEnd REAL, manual INTEGER,
  motionPreset TEXT, motionDirection TEXT, motionAmount REAL
);
CREATE TABLE IF NOT EXISTS transcript_words (
  id TEXT PRIMARY KEY, projectId TEXT, ord INTEGER, word TEXT,
  start REAL, end REAL, emphasis INTEGER
);
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY, value TEXT
);
CREATE TABLE IF NOT EXISTS assets (
  path TEXT PRIMARY KEY, channel TEXT, addedAt TEXT
);
CREATE TABLE IF NOT EXISTS work_item_state (
  videoId TEXT PRIMARY KEY,
  uploadedTo TEXT,
  uploadMatchScore REAL,
  manualUploaded INTEGER,
  archived INTEGER DEFAULT 0,
  updatedAt TEXT
);
CREATE TABLE IF NOT EXISTS niches (
  id TEXT PRIMARY KEY,
  name TEXT,
  keywords TEXT,
  orientation TEXT,
  targetClips INTEGER,
  createdAt TEXT,
  updatedAt TEXT
);
CREATE TABLE IF NOT EXISTS automation_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  currentStep TEXT NOT NULL DEFAULT '',
  configJson TEXT NOT NULL,
  resultJson TEXT,
  errorKind TEXT,
  error TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  startedAt TEXT,
  completedAt TEXT,
  lastCheckpointAt TEXT,
  nextRetryAt TEXT,
  pauseRequested INTEGER NOT NULL DEFAULT 0,
  cancelRequested INTEGER NOT NULL DEFAULT 0,
  warningCount INTEGER NOT NULL DEFAULT 0,
  failedCount INTEGER NOT NULL DEFAULT 0,
  completedCount INTEGER NOT NULL DEFAULT 0,
  totalItems INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS automation_job_steps (
  id TEXT PRIMARY KEY,
  jobId TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL,
  ord INTEGER NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  maxAttempts INTEGER NOT NULL DEFAULT 1,
  runsOn TEXT NOT NULL,
  optional INTEGER NOT NULL DEFAULT 0,
  startedAt TEXT,
  completedAt TEXT,
  error TEXT,
  checkpointJson TEXT
);
CREATE TABLE IF NOT EXISTS automation_job_items (
  id TEXT PRIMARY KEY,
  jobId TEXT NOT NULL,
  sourceVideoId TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  currentStep TEXT NOT NULL DEFAULT '',
  progress INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  projectId TEXT,
  renderJobId TEXT,
  outputPath TEXT,
  warning TEXT,
  error TEXT,
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS automation_job_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jobId TEXT NOT NULL,
  itemId TEXT,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_automation_jobs_status ON automation_jobs(status, createdAt);
CREATE INDEX IF NOT EXISTS idx_automation_steps_job ON automation_job_steps(jobId, ord);
CREATE INDEX IF NOT EXISTS idx_automation_items_job ON automation_job_items(jobId, updatedAt);
CREATE INDEX IF NOT EXISTS idx_automation_logs_job ON automation_job_logs(jobId, id);
CREATE TABLE IF NOT EXISTS provider_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  partition TEXT NOT NULL,
  status TEXT NOT NULL,
  accountLabel TEXT,
  connectedAt TEXT,
  lastVerifiedAt TEXT,
  lastError TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_jobs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  connectionId TEXT NOT NULL,
  operation TEXT NOT NULL,
  remoteProjectId TEXT,
  remoteTaskUuid TEXT,
  remotePreviousTaskUuid TEXT,
  parentProviderJobId TEXT,
  automationJobId TEXT,
  automationItemId TEXT,
  projectId TEXT,
  requestFingerprint TEXT,
  requestJson TEXT,
  /** '' (not NULL) when the caller supplied none, so the unique index below degenerates
   *  cleanly to fingerprint-only dedup for every existing/automation caller that never
   *  sets this — only an explicit, distinct value creates a deliberate duplicate. */
  creationIntentId TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  remoteStep INTEGER,
  remoteStepsTotal INTEGER,
  progress INTEGER NOT NULL DEFAULT 0,
  remoteMediaId TEXT,
  remoteMediaUrl TEXT,
  localOutputPath TEXT,
  /** A local-caption derivative render, kept separate from the verified provider
   *  output (localOutputPath) so the original is never overwritten. */
  localCaptionedOutputPath TEXT,
  errorCode TEXT,
  errorMessage TEXT,
  segmentOrdinal INTEGER,
  internalSegment INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  lastPolledAt TEXT,
  downloadedAt TEXT
);
CREATE TABLE IF NOT EXISTS provider_assets (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  connectionId TEXT NOT NULL,
  localSha256 TEXT NOT NULL,
  localPath TEXT NOT NULL,
  mimeType TEXT,
  sizeBytes INTEGER,
  durationSec REAL,
  remoteCategoryId TEXT,
  remoteMediaId TEXT,
  remoteResultUuid TEXT,
  uploadedAt TEXT,
  lastVerifiedAt TEXT
);
CREATE TABLE IF NOT EXISTS transcript_documents (
  projectId TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  segmentsJson TEXT,
  source TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_jobs_connection ON provider_jobs(connectionId, status);
CREATE INDEX IF NOT EXISTS idx_provider_jobs_remote ON provider_jobs(remoteProjectId);
CREATE INDEX IF NOT EXISTS idx_provider_jobs_fingerprint ON provider_jobs(requestFingerprint);
CREATE INDEX IF NOT EXISTS idx_provider_jobs_parent ON provider_jobs(parentProviderJobId);
CREATE INDEX IF NOT EXISTS idx_provider_assets_hash ON provider_assets(provider, connectionId, localSha256);
`

// Every table that holds user/domain data — wiped by resetAll(). app_meta is
// intentionally excluded so the "don't re-seed" flag survives the reset.
const DATA_TABLES = [
  'my_channels', 'source_channels', 'source_videos', 'downloaded_videos', 'uploads',
  'profiles', 'thumbnail_templates', 'render_jobs', 'activity_log',
  'projects', 'project_images', 'transcript_words', 'work_item_state', 'niches',
  'automation_jobs', 'automation_job_steps', 'automation_job_items', 'automation_job_logs',
  'provider_connections', 'provider_jobs', 'provider_assets', 'transcript_documents'
]

/** Add a column only if it isn't already present — idempotent forward migration. */
function ensureColumn(d: Database.Database, table: string, col: string, type: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
}

/** Parse a stored JSON string[] (niche keywords), tolerating null/garbage. */
function parseKeywords(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function migrate(d: Database.Database): void {
  ensureColumn(d, 'my_channels', 'lastScrapedAt', 'TEXT')
  ensureColumn(d, 'source_channels', 'lastScrapedAt', 'TEXT')
  ensureColumn(d, 'source_channels', 'nicheId', 'TEXT')
  ensureColumn(d, 'source_channels', 'avatar', 'TEXT')
  ensureColumn(d, 'source_channels', 'lastVisitedAt', 'TEXT')
  ensureColumn(d, 'source_channels', 'lastSeenVideoId', 'TEXT')
  ensureColumn(d, 'source_channels', 'linkedMyChannelId', 'TEXT')
  ensureColumn(d, 'source_channels', 'videoCount', 'INTEGER')
  // Workflow P5: source-owned automation defaults. Profiles stay readable for one release.
  ensureColumn(d, 'source_channels', 'autoWatch', 'INTEGER')
  ensureColumn(d, 'source_channels', 'autoQueueRender', 'INTEGER')
  ensureColumn(d, 'source_channels', 'sourceOrder', 'TEXT')
  ensureColumn(d, 'source_channels', 'sourceCount', 'INTEGER')
  ensureColumn(d, 'source_channels', 'imageMode', 'TEXT')
  ensureColumn(d, 'source_channels', 'poolSize', 'INTEGER')
  ensureColumn(d, 'source_channels', 'kenBurns', 'INTEGER')
  ensureColumn(d, 'source_channels', 'captionPreset', 'TEXT')
  ensureColumn(d, 'source_channels', 'captionFont', 'TEXT')
  ensureColumn(d, 'source_channels', 'captionAnim', 'TEXT')
  ensureColumn(d, 'source_channels', 'captionAspect', 'TEXT')
  ensureColumn(d, 'source_channels', 'captionLines', 'INTEGER')
  ensureColumn(d, 'source_channels', 'captionPosition', 'TEXT')
  ensureColumn(d, 'source_channels', 'captionPace', 'TEXT')
  ensureColumn(d, 'source_channels', 'captionHighlightColor', 'TEXT')
  ensureColumn(d, 'source_channels', 'captionBoxColor', 'TEXT')
  ensureColumn(d, 'source_channels', 'captionWordsPerPage', 'INTEGER')
  ensureColumn(d, 'source_channels', 'outputFolder', 'TEXT')
  ensureColumn(d, 'source_channels', 'thumbnailTemplateId', 'TEXT')
  ensureColumn(d, 'source_channels', 'lastRunAt', 'TEXT')
  ensureColumn(d, 'source_channels', 'betaOpts', 'TEXT')
  ensureColumn(d, 'source_videos', 'ord', 'INTEGER')
  ensureColumn(d, 'downloaded_videos', 'matchedUploadId', 'TEXT')
  // M4: real download bookkeeping
  ensureColumn(d, 'downloaded_videos', 'filePath', 'TEXT')
  ensureColumn(d, 'downloaded_videos', 'durationSec', 'INTEGER')
  ensureColumn(d, 'render_jobs', 'projectId', 'TEXT')
  // M5: template locked to a profile
  ensureColumn(d, 'profiles', 'thumbnailTemplateId', 'TEXT')
  // P8: optionally auto-queue produced videos for render on an interactive run
  ensureColumn(d, 'profiles', 'autoQueueRender', 'INTEGER')
  // M6: render output bookkeeping
  ensureColumn(d, 'render_jobs', 'outputPath', 'TEXT')
  ensureColumn(d, 'render_jobs', 'error', 'TEXT')
  ensureColumn(d, 'render_jobs', 'updatedAt', 'TEXT')
  // M7: profile run config + auto-watch cursor
  ensureColumn(d, 'profiles', 'linkedSourceId', 'TEXT')
  ensureColumn(d, 'profiles', 'sourceUrl', 'TEXT')
  ensureColumn(d, 'profiles', 'sourceOrder', 'TEXT')
  ensureColumn(d, 'profiles', 'sourceCount', 'INTEGER')
  ensureColumn(d, 'profiles', 'imageMode', 'TEXT')
  ensureColumn(d, 'profiles', 'poolSize', 'INTEGER')
  ensureColumn(d, 'profiles', 'kenBurns', 'INTEGER')
  ensureColumn(d, 'profiles', 'captionPreset', 'TEXT')
  ensureColumn(d, 'profiles', 'captionFont', 'TEXT')
  ensureColumn(d, 'profiles', 'captionAnim', 'TEXT')
  ensureColumn(d, 'profiles', 'captionAspect', 'TEXT')
  ensureColumn(d, 'profiles', 'captionLines', 'INTEGER')
  ensureColumn(d, 'profiles', 'captionPosition', 'TEXT')
  ensureColumn(d, 'profiles', 'captionPace', 'TEXT')
  ensureColumn(d, 'profiles', 'captionHighlightColor', 'TEXT')
  ensureColumn(d, 'profiles', 'captionBoxColor', 'TEXT')
  ensureColumn(d, 'profiles', 'captionWordsPerPage', 'INTEGER')
  ensureColumn(d, 'profiles', 'outputFolder', 'TEXT')
  ensureColumn(d, 'profiles', 'lastSeenVideoId', 'TEXT')
  ensureColumn(d, 'profiles', 'lastRunAt', 'TEXT')
  // Beta features — one JSON column each, so future fields need no migration.
  ensureColumn(d, 'projects', 'betaOpts', 'TEXT')
  ensureColumn(d, 'profiles', 'betaOpts', 'TEXT')
  ensureColumn(d, 'uploads', 'thumb', 'TEXT')
  // M8: per-project saved thumbnail path
  ensureColumn(d, 'projects', 'thumbPath', 'TEXT')
  ensureColumn(d, 'projects', 'thumbnailTemplateId', 'TEXT')
  ensureColumn(d, 'projects', 'lookLut', 'TEXT')
  ensureColumn(d, 'projects', 'lookStrength', 'REAL')
  ensureColumn(d, 'projects', 'lookAdjust', 'TEXT')
  ensureColumn(d, 'projects', 'motionPreset', 'TEXT')
  ensureColumn(d, 'project_images', 'motionPreset', 'TEXT')
  ensureColumn(d, 'project_images', 'motionDirection', 'TEXT')
  ensureColumn(d, 'project_images', 'motionAmount', 'REAL')
  ensureColumn(d, 'projects', 'captionLines', 'INTEGER')
  ensureColumn(d, 'projects', 'captionPosition', 'TEXT')
  ensureColumn(d, 'projects', 'captionPace', 'TEXT')
  ensureColumn(d, 'projects', 'captionHighlightColor', 'TEXT')
  ensureColumn(d, 'projects', 'captionBoxColor', 'TEXT')
  ensureColumn(d, 'projects', 'captionWordsPerPage', 'INTEGER')
  ensureColumn(d, 'projects', 'captionOffsetY', 'REAL')
  ensureColumn(d, 'downloaded_videos', 'error', 'TEXT')
  ensureColumn(d, 'work_item_state', 'uploadConfidence', 'TEXT')
  // Durable Automation item checkpoints + asset-library metadata. All guarded for old DBs.
  ensureColumn(d, 'automation_job_items', 'stateJson', 'TEXT')
  ensureColumn(d, 'assets', 'id', 'TEXT')
  ensureColumn(d, 'assets', 'canonicalPath', 'TEXT')
  ensureColumn(d, 'assets', 'originalPath', 'TEXT')
  ensureColumn(d, 'assets', 'sourceId', 'TEXT')
  ensureColumn(d, 'assets', 'channelHandle', 'TEXT')
  ensureColumn(d, 'assets', 'channelAvatar', 'TEXT')
  ensureColumn(d, 'assets', 'thumbnailPath', 'TEXT')
  ensureColumn(d, 'assets', 'mimeType', 'TEXT')
  ensureColumn(d, 'assets', 'width', 'INTEGER')
  ensureColumn(d, 'assets', 'height', 'INTEGER')
  ensureColumn(d, 'assets', 'fileSize', 'INTEGER')
  ensureColumn(d, 'assets', 'firstAddedAt', 'TEXT')
  ensureColumn(d, 'assets', 'lastUsedAt', 'TEXT')
  ensureColumn(d, 'assets', 'usageCount', 'INTEGER')
  ensureColumn(d, 'assets', 'missing', 'INTEGER')
  ensureColumn(d, 'assets', 'projectId', 'TEXT')
  ensureColumn(d, 'provider_jobs', 'requestJson', 'TEXT')
  ensureColumn(d, 'provider_jobs', 'creationIntentId', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(d, 'provider_jobs', 'localCaptionedOutputPath', 'TEXT')
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_content_id ON assets(id) WHERE id IS NOT NULL')

  purgeLegacyDemoSeed(d)
  migrateProfilesToSources(d)
  installDefaultThumbnailTemplates(d)
  enforceProviderJobFingerprintUniqueness(d)
}

/**
 * Phase 11 idempotency hardening. The dedup check before this migration was a plain
 * SELECT (application-level, not DB-enforced) — this closes that gap with a real
 * UNIQUE index on (provider, connectionId, operation, requestFingerprint,
 * creationIntentId), so concurrent/racing creation attempts can no longer both insert.
 *
 * Historical rows may already violate that uniqueness (they were never constrained).
 * Deleting them is not an option ("never delete valid historical jobs silently"), so
 * every row after the first in each duplicate group gets a disambiguating suffix
 * appended to its OWN creationIntentId — its identity and history are preserved, it
 * simply stops being treated as the canonical dedup target for that fingerprint.
 * Idempotent: rows already suffixed, or already unique, are left untouched, and
 * CREATE UNIQUE INDEX IF NOT EXISTS is a no-op after the first successful run.
 */
function enforceProviderJobFingerprintUniqueness(d: Database.Database): void {
  const tx = d.transaction(() => {
    const dupGroups = d.prepare(
      `SELECT provider, connectionId, operation, requestFingerprint, creationIntentId, COUNT(*) c
       FROM provider_jobs
       WHERE requestFingerprint IS NOT NULL AND requestFingerprint != ''
       GROUP BY provider, connectionId, operation, requestFingerprint, creationIntentId
       HAVING c > 1`
    ).all() as Array<{ provider: string; connectionId: string; operation: string; requestFingerprint: string; creationIntentId: string }>
    const relabel = d.prepare('UPDATE provider_jobs SET creationIntentId=@intentId WHERE id=@id')
    for (const group of dupGroups) {
      const rows = d.prepare(
        'SELECT id, creationIntentId FROM provider_jobs WHERE provider=? AND connectionId=? AND operation=? AND requestFingerprint=? AND creationIntentId=? ORDER BY createdAt ASC, id ASC'
      ).all(group.provider, group.connectionId, group.operation, group.requestFingerprint, group.creationIntentId) as Array<{ id: string; creationIntentId: string }>
      // Keep the oldest row's key as-is (it remains the canonical dedup target);
      // every later duplicate gets its own id appended to its creationIntentId.
      for (const row of rows.slice(1)) {
        relabel.run({ id: row.id, intentId: `${row.creationIntentId}#dup-${row.id}` })
      }
    }
    d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_jobs_fingerprint_intent ON provider_jobs(provider, connectionId, operation, requestFingerprint, creationIntentId)')
  })
  tx()
}

/**
 * One-time cleanup for installs (≤ v0.1.4) that were seeded with fabricated demo
 * data — fake channels (ids me/sh/sd), fake downloads (d1–d4 with no real video),
 * demo profiles, and canned activity. That data made the dashboard look invented
 * and produced "Incomplete YouTube ID" download errors. We remove the exact known
 * demo rows (only ones with no real file path / real youtube id) once, guarded by a
 * meta marker so a user's real data is never touched.
 */
function purgeLegacyDemoSeed(d: Database.Database): void {
  const done = d.prepare("SELECT value FROM app_meta WHERE key='demo_purged_v2'").get()
  if (done) return
  const tx = d.transaction(() => {
    // Fake downloads had hardcoded ids d1–d4 and never a real filePath.
    d.prepare("DELETE FROM downloaded_videos WHERE id IN ('d1','d2','d3','d4') AND (filePath IS NULL OR filePath='')").run()
    // Demo channels/profiles used the fixed ids me/sh/sd with the seeded handles.
    d.prepare("DELETE FROM my_channels WHERE id IN ('me','sh','sd') AND handle IN ('@powerwithin','@stoichour','@sleepdeep')").run()
    d.prepare("DELETE FROM profiles WHERE id IN ('me','sh','sd') AND name IN ('Mental Empire','Stoic Hour','Sleep Deep')").run()
    d.prepare("DELETE FROM source_channels WHERE id IN ('src-pw','src-ds','src-rs')").run()
    // Canned activity feed from the seed (no real run ever produced these exact rows).
    d.prepare("DELETE FROM activity_log WHERE text IN ('Skipped 1 video — members only','Auto-watch found 5 new uploads','Downloaded 5 mp3 from @stoichour','Captions burned (Hormozi)','Rendered Gaslighting Explained → ME_out')").run()
    d.prepare("INSERT OR REPLACE INTO app_meta (key,value) VALUES ('demo_purged_v2','1')").run()
  })
  tx()
}

function installDefaultThumbnailTemplates(d: Database.Database): void {
  const done = d.prepare("SELECT value FROM app_meta WHERE key='default_thumb_templates_v2'").get()
  if (done) return
  const tx = d.transaction(() => {
    seedDefaultThumbnailTemplates(d)
    d.prepare("INSERT OR REPLACE INTO app_meta (key,value) VALUES ('default_thumb_templates_v2','1')").run()
  })
  tx()
}

/** One-time guarded fold from legacy profile-owned automation into source rows.
 *  The profiles table stays intact so old IPC/UI paths remain reversible shims. */
function migrateProfilesToSources(d: Database.Database): void {
  const done = d.prepare("SELECT value FROM app_meta WHERE key='profiles_folded_v1'").get()
  if (done) return
  const rows = d.prepare('SELECT * FROM profiles').all() as Array<Record<string, unknown>>
  const tx = d.transaction(() => {
    const sourceCandidates = d.prepare('SELECT id,url FROM source_channels').all() as SourceMigrationCandidate[]
    const insertSource = d.prepare(
      `INSERT OR IGNORE INTO source_channels (id,url,handle,name)
       VALUES (@id,@url,@handle,@name)`
    )
    const updateAutomation = d.prepare(
      `UPDATE source_channels SET
         autoWatch=CASE WHEN @autoWatch=1 THEN 1 ELSE COALESCE(autoWatch,@autoWatch) END,
         autoQueueRender=COALESCE(autoQueueRender,@autoQueueRender),
         sourceOrder=COALESCE(sourceOrder,@sourceOrder),
         sourceCount=COALESCE(sourceCount,@sourceCount),
         imageMode=COALESCE(imageMode,@imageMode),
         poolSize=COALESCE(poolSize,@poolSize),
         kenBurns=COALESCE(kenBurns,@kenBurns),
         captionPreset=COALESCE(captionPreset,@captionPreset),
         captionFont=COALESCE(captionFont,@captionFont),
         captionAnim=COALESCE(captionAnim,@captionAnim),
         captionAspect=COALESCE(captionAspect,@captionAspect),
         captionLines=COALESCE(captionLines,@captionLines),
         captionPosition=COALESCE(captionPosition,@captionPosition),
         captionPace=COALESCE(captionPace,@captionPace),
         captionHighlightColor=COALESCE(captionHighlightColor,@captionHighlightColor),
         captionBoxColor=COALESCE(captionBoxColor,@captionBoxColor),
         captionWordsPerPage=COALESCE(captionWordsPerPage,@captionWordsPerPage),
         outputFolder=COALESCE(outputFolder,@outputFolder),
         thumbnailTemplateId=COALESCE(thumbnailTemplateId,@thumbnailTemplateId),
         lastSeenVideoId=COALESCE(lastSeenVideoId,@lastSeenVideoId),
         lastRunAt=COALESCE(lastRunAt,@lastRunAt),
         betaOpts=COALESCE(betaOpts,@betaOpts)
       WHERE id=@id`
    )
    for (const row of rows) {
      const profile = rowToProfile(row)
      const plan = planProfileSourceMigration(profile, sourceCandidates)
      if (!plan) continue
      insertSource.run(plan.insertSource)
      updateAutomation.run({ id: plan.id, ...plan.automationRow })
      if (!sourceCandidates.some((s) => s.id === plan.id)) sourceCandidates.push({ id: plan.id, url: plan.insertSource.url })
    }
    d.prepare("INSERT OR REPLACE INTO app_meta (key,value) VALUES ('profiles_folded_v1','1')").run()
  })
  tx()
}

/** Parse the betaOpts JSON column (null/garbage → defaults), deriving from legacy
 *  project flags when the column was never written. */
function parseBetaOpts(r: Record<string, unknown>): import('../../shared/types').BetaVideoOpts {
  if (r.betaOpts != null) {
    try {
      return asBetaOpts(JSON.parse(r.betaOpts as string))
    } catch {
      /* fall through to defaults */
    }
  }
  return asBetaOpts({
    autoHighlight: !!r.keywords,
    autoZoom: { atStart: !!r.kenBurns, atKeyPhrases: !!r.punchZoom }
  })
}

function parseLookAdjust(raw: unknown): Project['lookAdjust'] {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  try {
    const v = JSON.parse(raw) as Project['lookAdjust']
    return v && typeof v === 'object' ? v : undefined
  } catch {
    return undefined
  }
}

export interface ChannelStatsPatch {
  views: string
  subs: string
  total: number
  lastScrapedAt: string
}

export interface GoalsPatch {
  weekGoal?: number
  monthGoal?: number
  reminder?: string
  reminderNote?: string
}

export interface Repositories {
  myChannels(): MyChannel[]
  myChannel(id: string): MyChannel | undefined
  upsertMyChannel(c: MyChannel): void
  sourceChannels(): SourceChannel[]
  sourceChannel(id: string): SourceChannel | undefined
  sourceChannelByUrl(url: string): SourceChannel | undefined
  upsertSourceChannel(s: SourceChannel): void
  setSourceCursor(id: string, patch: { lastSeenVideoId?: string | null; lastVisitedAt?: string; lastRunAt?: string }): void
  updateSourceAutomation(id: string, patch: SourceAutomationPatch): SourceChannel[]
  deleteSourceChannel(id: string): void
  newVideoCountForSource(id: string): number
  setSourceLinkedMyChannel(id: string, myChannelId: string | null): void
  downloads(): DownloadedVideo[]
  getDownloadsBySource(sourceId: string): DownloadedVideo[]
  profiles(): Profile[]
  templates(): ThumbnailTemplate[]
  activity(): ActivityRow[]
  addActivity(row: ActivityRow): void
  upsertProfile(p: Profile): Profile[]
  deleteProfile(id: string): Profile[]
  getProfile(id: string): Profile | undefined
  setProfileCursor(id: string, patch: { lastSeenVideoId?: string; lastRunAt?: string }): void
  saveTemplate(t: ThumbnailTemplate): ThumbnailTemplate[]
  deleteTemplate(id: string): ThumbnailTemplate[]
  getTemplate(id: string): ThumbnailTemplate | undefined
  assignTemplateToProfile(profileId: string, templateId: string): Profile[]
  // ---- M3 scraping writes ----
  replaceUploads(channelId: string, rows: Upload[]): void
  getUploads(channelId: string): Upload[]
  recentUploads(limit: number): RecentUpload[]
  replaceSourceVideos(sourceId: string, rows: ScrapedVideo[]): void
  getSourceVideos(sourceId: string): ScrapedVideo[]
  setChannelStats(id: string, patch: ChannelStatsPatch): void
  setChannelMapping(id: string, mapDone: number, mapTotal: number): void
  setChannelGoalProgress(id: string, weekDone: number, monthDone: number): void
  markDownloadMatches(matches: Array<{ downloadId: string; uploadId: string }>): void
  updateChannelGoals(id: string, patch: GoalsPatch): void
  /** Link/unlink a source channel to an owned channel (null clears the link). */
  setChannelSource(id: string, linkedSourceId: string | null): void
  /** Remove an owned channel and its scraped uploads. */
  deleteMyChannel(id: string): void
  // ---- M4 download + compose writes ----
  download(id: string): DownloadedVideo | undefined
  upsertDownload(d: DownloadedVideo): void
  setDownloadProgress(id: string, patch: { pct?: string; stage?: string; filePath?: string; durationSec?: number; action?: 'Resume' | 'Open'; error?: string }): void
  createProject(p: Project): void
  getProject(id: string): Project | undefined
  listProjects(): Project[]
  updateProject(id: string, patch: Partial<Project>): Project | undefined
  replaceProjectImages(projectId: string, rows: ProjectImage[]): void
  getProjectImages(projectId: string): ProjectImage[]
  /** Record images as reusable library assets (dedup by path) so a later project can pick
   *  the same set again instead of re-selecting from disk. */
  recordAssets(rows: LibraryAsset[]): void
  replaceAssetPath(oldPath: string, row: LibraryAsset): void
  listAssets(): LibraryAsset[]
  setImageRanges(projectId: string, ranges: Array<{ id: string; rangeStart: number; rangeEnd: number }>): void
  setImageMotion(projectId: string, updates: ProjectImageMotionPatch[]): void
  replaceTranscript(projectId: string, rows: TranscriptWord[]): void
  getTranscript(projectId: string): TranscriptWord[]
  updateWord(wordId: string, text: string): void
  toggleEmphasis(wordId: string): void
  setEmphasis(wordIds: string[], emphasis: boolean): void
  createRenderJob(job: { id: string; title: string; channel: string; projectId: string }): void
  renderJobs(): RenderJob[]
  renderJob(id: string): RenderJob | undefined
  queuedJobs(): RenderJob[]
  setRenderStatus(id: string, patch: { status?: RenderStatus; pct?: number; outputPath?: string; error?: string }): void
  // ---- Durable goal-based automation ----
  createAutomationJob(job: AutomationJob, steps: AutomationWorkflowStep[]): void
  automationJobs(): AutomationJob[]
  automationJob(id: string): AutomationJob | undefined
  automationSteps(jobId: string): AutomationWorkflowStep[]
  automationItems(jobId: string): AutomationJobItem[]
  automationLogs(jobId: string, limit?: number): AutomationJobLog[]
  updateAutomationJob(id: string, patch: Partial<AutomationJob>): void
  updateAutomationStep(id: string, patch: Partial<AutomationWorkflowStep>): void
  upsertAutomationItem(item: AutomationJobItem): void
  addAutomationLog(jobId: string, level: AutomationJobLog['level'], message: string, itemId?: string): void
  // ---- TalkingPhotos provider (cloud provider, separate from local render_jobs) ----
  providerConnection(id: string): ProviderConnection | undefined
  providerConnections(): ProviderConnection[]
  upsertProviderConnection(row: ProviderConnection): void
  providerJob(id: string): ProviderJob | undefined
  providerJobByRemoteId(connectionId: string, remoteProjectId: string): ProviderJob | undefined
  providerJobByFingerprint(connectionId: string, requestFingerprint: string): ProviderJob | undefined
  /** Atomic lookup-or-insert enforced by the DB unique index on (provider,
   *  connectionId, operation, requestFingerprint, creationIntentId) — not just an
   *  application-level SELECT-then-INSERT. Returns the existing row (created: false)
   *  on any collision, including one lost to a concurrent/racing caller. */
  findOrCreateProviderJob(job: ProviderJob): { job: ProviderJob; created: boolean }
  providerJobs(connectionId?: string): ProviderJob[]
  /** Every provider job not yet in a terminal state — the startup-reconciliation set. */
  nonTerminalProviderJobs(): ProviderJob[]
  upsertProviderJob(job: ProviderJob): void
  updateProviderJob(id: string, patch: Partial<ProviderJob>): void
  providerAssetByHash(provider: string, connectionId: string, localSha256: string): ProviderAsset | undefined
  upsertProviderAsset(asset: ProviderAsset): void
  getTranscriptDocument(projectId: string): TranscriptDocument | undefined
  upsertTranscriptDocument(doc: TranscriptDocument): void
  /** Remove a single download row from history. */
  deleteDownload(id: string): void
  /** Remove a single render job from the queue. */
  deleteRenderJob(id: string): void
  /** Rewrite asset path columns (used by the library reorganize migration). Only a fixed
   *  allowlist of table/column pairs is permitted; unknown pairs are ignored. Transactional. */
  rewriteAssetPaths(updates: Array<{ table: string; column: string; id: string; value: string }>): void
  // ---- P1: per-video work items (computed read model + persisted upload/archive state) ----
  /** Compute the per-video pipeline status for every downloaded video. */
  workItems(): WorkItem[]
  /** All my-channel upload titles, for fuzzy upload detection. */
  allUploadsForMatch(): Array<{ channelId: string; title: string }>
  /** Manual override of a video's uploaded flag (true/false). */
  setWorkItemUploaded(videoId: string, uploaded: boolean): void
  /** Hide/show a video from "to do" without deleting it. */
  setWorkItemArchived(videoId: string, archived: boolean): void
  /** Persist fuzzy upload-detection results (matched channel ids + best score). */
  setDetectedUploads(rows: Array<{ videoId: string; uploadedTo: string[]; score: number; confidence?: 'high' | 'pending' | null }>): void
  uploadStates(videoIds: string[]): Map<string, { manualUploaded: boolean | null }>
  // ---- P3: niche b-roll pools ----
  /** All user-curated niches. */
  niches(): Niche[]
  /** Create/update a niche. */
  saveNiche(n: Niche): void
  /** Delete a niche + unassign any channels pointing at it. */
  deleteNiche(id: string): void
  /** Assign (or clear) a source channel's niche. */
  setSourceChannelNiche(channelId: string, nicheId: string | null): void
  /** The pool key (`niche-<id>`) for the niche assigned to a download's source channel,
   *  or undefined when the channel has no niche. Used to scope render b-roll selection. */
  nicheKeyForDownload(downloadId: string): string | undefined
  /** The niche assigned to a download's source channel, if any. */
  nicheForDownload(downloadId: string): Niche | undefined
  /** Read a small app-level marker from app_meta. */
  appMeta(key: string): string | undefined
  /** Persist a small app-level marker in app_meta. */
  setAppMeta(key: string, value: string): void
  /** Wipe every domain table (channels, profiles, projects, jobs, …) back to empty,
   *  and mark the DB seeded so demo content is not re-inserted on next launch. */
  resetAll(): void
  /** Wipe data tables (channels, downloads, projects, jobs, transcripts) but leave
   *  settings (electron-store) untouched — keeps API keys and app preferences. */
  softReset(): void
}

let db: Database.Database | null = null
let repos: Repositories | null = null

export function initDatabase(filePath: string): Repositories {
  db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  migrate(db)
  seedIfEmpty(db)
  repos = traceObject(buildRepositories(db), 'db')
  return repos
}

export function getRepos(): Repositories {
  if (!repos) throw new Error('Database not initialised — call initDatabase() first')
  return repos
}

/** Insert the deterministic demo dataset — used ONLY by the headless smoke/e2e harnesses. */
export function seedDemoForSmoke(): void {
  if (!db) throw new Error('Database not initialised — call initDatabase() first')
  seedDemoData(db)
}

/** Idempotent: safe to call from multiple lifecycle paths (window-all-closed + before-quit). */
export function closeDatabase(): void {
  try {
    db?.close()
  } catch {
    /* already closed */
  }
  db = null
  repos = null
}

const SOURCE_BASE_COLS = [
  'id', 'url', 'handle', 'name', 'nicheId', 'avatar', 'lastScrapedAt', 'lastVisitedAt',
  'lastSeenVideoId', 'linkedMyChannelId', 'videoCount'
]

const SOURCE_AUTOMATION_COLS = [
  'autoWatch', 'autoQueueRender', 'sourceOrder', 'sourceCount', 'imageMode', 'poolSize', 'kenBurns',
  'captionPreset', 'captionFont', 'captionAnim', 'captionAspect', 'captionLines', 'captionPosition',
  'captionPace', 'captionHighlightColor', 'captionBoxColor', 'captionWordsPerPage', 'outputFolder',
  'thumbnailTemplateId', 'lastRunAt', 'betaOpts'
] as const

const SOURCE_SELECT_COLS = [...SOURCE_BASE_COLS, ...SOURCE_AUTOMATION_COLS].join(',')

function parseSourceBetaOpts(raw: unknown): import('../../shared/types').BetaVideoOpts | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  try {
    return asBetaOpts(JSON.parse(raw))
  } catch {
    return undefined
  }
}

function rowToSourceChannel(r: Record<string, unknown>): SourceChannel {
  const rawLines = Number(r.captionLines ?? 1)
  const captionLines = rawLines === 2 || rawLines === 3 ? rawLines as 1 | 2 | 3 : 1
  const rawPace = r.captionPace as SourceChannel['captionPace']
  const captionPace = rawPace === 'word' || rawPace === 'phrase' ? rawPace : 'auto'
  const rawWordsPerPage = Number(r.captionWordsPerPage ?? 0)
  const captionWordsPerPage = rawWordsPerPage === 1 || rawWordsPerPage === 2 || rawWordsPerPage === 3 ? rawWordsPerPage as 1 | 2 | 3 : undefined
  const rawOrder = r.sourceOrder as ScrapeOrder
  const sourceOrder = rawOrder === 'Popular' || rawOrder === 'Oldest' ? rawOrder : 'Latest'
  const rawMode = r.imageMode as ImageMode
  const imageMode = rawMode === 'sequence' || rawMode === 'pool' ? rawMode : 'pool'
  return {
    ...(r as unknown as SourceChannel),
    autoWatch: !!r.autoWatch,
    autoQueueRender: !!r.autoQueueRender,
    sourceOrder,
    sourceCount: coerceNum(r.sourceCount, 5),
    imageMode,
    poolSize: coerceNum(r.poolSize, 10),
    kenBurns: r.kenBurns == null ? true : !!r.kenBurns,
    captionPreset: (r.captionPreset as string) ?? 'Hormozi',
    captionFont: (r.captionFont as string) ?? 'Montserrat',
    captionAnim: (r.captionAnim as string) ?? 'Pop-in',
    captionAspect: (r.captionAspect as SourceChannel['captionAspect']) ?? '16:9',
    captionLines,
    captionPosition: (r.captionPosition as SourceChannel['captionPosition']) ?? 'bottom',
    captionPace,
    captionHighlightColor: typeof r.captionHighlightColor === 'string' && r.captionHighlightColor ? r.captionHighlightColor : undefined,
    captionBoxColor: typeof r.captionBoxColor === 'string' && r.captionBoxColor ? r.captionBoxColor : undefined,
    captionWordsPerPage,
    betaOpts: parseSourceBetaOpts(r.betaOpts)
  }
}

function sourceAutomationToRow(patch: SourceAutomationPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  const put = (key: typeof SOURCE_AUTOMATION_COLS[number], value: unknown): void => {
    if (value !== undefined) row[key] = value
  }
  put('autoWatch', patch.autoWatch == null ? undefined : patch.autoWatch ? 1 : 0)
  put('autoQueueRender', patch.autoQueueRender == null ? undefined : patch.autoQueueRender ? 1 : 0)
  put('sourceOrder', patch.sourceOrder)
  put('sourceCount', patch.sourceCount)
  put('imageMode', patch.imageMode)
  put('poolSize', patch.poolSize)
  put('kenBurns', patch.kenBurns == null ? undefined : patch.kenBurns ? 1 : 0)
  put('captionPreset', patch.captionPreset)
  put('captionFont', patch.captionFont)
  put('captionAnim', patch.captionAnim)
  put('captionAspect', patch.captionAspect)
  put('captionLines', patch.captionLines)
  put('captionPosition', patch.captionPosition)
  put('captionPace', patch.captionPace)
  put('captionHighlightColor', patch.captionHighlightColor)
  put('captionBoxColor', patch.captionBoxColor)
  put('captionWordsPerPage', patch.captionWordsPerPage)
  put('outputFolder', patch.outputFolder)
  put('thumbnailTemplateId', patch.thumbnailTemplateId)
  put('betaOpts', patch.betaOpts ? JSON.stringify(asBetaOpts(patch.betaOpts)) : undefined)
  return row
}

function jsonObject<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw.trim()) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}

function rowToAutomationJob(r: Record<string, unknown>): AutomationJob {
  const config = normalizeAutomationConfig(jsonObject(r.configJson, {} as AutomationJob['config']))
  return {
    ...(r as unknown as AutomationJob),
    progress: coerceNum(r.progress, 0),
    config,
    result: jsonObject<AutomationJob['result'] | undefined>(r.resultJson, undefined),
    pauseRequested: !!r.pauseRequested,
    cancelRequested: !!r.cancelRequested,
    warningCount: coerceNum(r.warningCount, 0),
    failedCount: coerceNum(r.failedCount, 0),
    completedCount: coerceNum(r.completedCount, 0),
    totalItems: coerceNum(r.totalItems, 0)
  }
}

function rowToAutomationStep(r: Record<string, unknown>): AutomationWorkflowStep {
  return {
    ...(r as unknown as AutomationWorkflowStep),
    ord: coerceNum(r.ord, 0),
    progress: coerceNum(r.progress, 0),
    attempts: coerceNum(r.attempts, 0),
    maxAttempts: coerceNum(r.maxAttempts, 1),
    optional: !!r.optional,
    checkpoint: jsonObject<Record<string, unknown> | undefined>(r.checkpointJson, undefined)
  }
}

function rowToAutomationItem(r: Record<string, unknown>): AutomationJobItem {
  const state = jsonObject<Partial<AutomationJobItem>>(r.stateJson, {})
  return {
    ...(r as unknown as AutomationJobItem),
    ...state,
    progress: coerceNum(r.progress, 0),
    attempts: coerceNum(r.attempts, 0)
  }
}

// ---- TalkingPhotos provider rows ----
function rowToProviderConnection(r: Record<string, unknown>): ProviderConnection {
  return { ...(r as unknown as ProviderConnection) }
}

function rowToProviderJob(r: Record<string, unknown>): ProviderJob {
  return {
    ...(r as unknown as ProviderJob),
    progress: coerceNum(r.progress, 0),
    remoteStep: r.remoteStep == null ? undefined : coerceNum(r.remoteStep, 0),
    remoteStepsTotal: r.remoteStepsTotal == null ? undefined : coerceNum(r.remoteStepsTotal, 0),
    segmentOrdinal: r.segmentOrdinal == null ? undefined : coerceNum(r.segmentOrdinal, 0),
    internalSegment: !!r.internalSegment
  }
}

function providerJobToRow(job: ProviderJob): Record<string, unknown> {
  return {
    ...job,
    remoteStep: job.remoteStep ?? null,
    remoteStepsTotal: job.remoteStepsTotal ?? null,
    segmentOrdinal: job.segmentOrdinal ?? null,
    internalSegment: job.internalSegment ? 1 : 0,
    remoteProjectId: job.remoteProjectId ?? null,
    remoteTaskUuid: job.remoteTaskUuid ?? null,
    remotePreviousTaskUuid: job.remotePreviousTaskUuid ?? null,
    parentProviderJobId: job.parentProviderJobId ?? null,
    automationJobId: job.automationJobId ?? null,
    automationItemId: job.automationItemId ?? null,
    projectId: job.projectId ?? null,
    requestFingerprint: job.requestFingerprint ?? null,
    creationIntentId: job.creationIntentId ?? '',
    requestJson: job.requestJson ?? null,
    remoteMediaId: job.remoteMediaId ?? null,
    remoteMediaUrl: job.remoteMediaUrl ?? null,
    localOutputPath: job.localOutputPath ?? null,
    localCaptionedOutputPath: job.localCaptionedOutputPath ?? null,
    errorCode: job.errorCode ?? null,
    errorMessage: job.errorMessage ?? null,
    lastPolledAt: job.lastPolledAt ?? null,
    downloadedAt: job.downloadedAt ?? null
  }
}

function rowToProviderAsset(r: Record<string, unknown>): ProviderAsset {
  return {
    ...(r as unknown as ProviderAsset),
    sizeBytes: r.sizeBytes == null ? undefined : coerceNum(r.sizeBytes, 0),
    durationSec: r.durationSec == null ? undefined : coerceNum(r.durationSec, 0)
  }
}

function rowToTranscriptDocument(r: Record<string, unknown>): TranscriptDocument {
  return { ...(r as unknown as TranscriptDocument) }
}

function buildRepositories(d: Database.Database): Repositories {
  const allTemplates = (): ThumbnailTemplate[] =>
    (d.prepare('SELECT * FROM thumbnail_templates').all() as Array<{ id: string; name: string; layers: string }>).map(
      (r) => ({ id: r.id, name: r.name, layers: JSON.parse(r.layers) })
    )
  const allProfiles = (): Profile[] =>
    (d.prepare('SELECT * FROM profiles').all() as Array<Record<string, unknown>>).map(rowToProfile)
  const allSources = (): SourceChannel[] =>
    (d.prepare(`SELECT ${SOURCE_SELECT_COLS} FROM source_channels ORDER BY COALESCE(lastVisitedAt,lastScrapedAt,name) DESC`).all() as Array<Record<string, unknown>>).map(rowToSourceChannel)

  return {
    myChannels: () => d.prepare('SELECT * FROM my_channels').all() as MyChannel[],
    myChannel: (id) => d.prepare('SELECT * FROM my_channels WHERE id=?').get(id) as MyChannel | undefined,
    upsertMyChannel: (c) => {
      d.prepare(
        `INSERT INTO my_channels (id,name,handle,mono,avatar,views,subs,total,linkedSourceId,source,mapDone,mapTotal,weekDone,weekGoal,monthDone,monthGoal,reminder,reminderNote,lastScrapedAt)
         VALUES (@id,@name,@handle,@mono,@avatar,@views,@subs,@total,@linkedSourceId,@source,@mapDone,@mapTotal,@weekDone,@weekGoal,@monthDone,@monthGoal,@reminder,@reminderNote,@lastScrapedAt)
         ON CONFLICT(id) DO UPDATE SET
           name=@name, handle=@handle, mono=@mono, avatar=@avatar, views=@views, subs=@subs, total=@total,
           linkedSourceId=@linkedSourceId, source=@source, mapDone=@mapDone, mapTotal=@mapTotal,
           weekDone=@weekDone, weekGoal=@weekGoal, monthDone=@monthDone, monthGoal=@monthGoal,
           reminder=@reminder, reminderNote=@reminderNote, lastScrapedAt=@lastScrapedAt`
      ).run({ linkedSourceId: null, lastScrapedAt: null, ...c })
    },

    sourceChannels: allSources,
    sourceChannel: (id) => {
      const row = d.prepare(`SELECT ${SOURCE_SELECT_COLS} FROM source_channels WHERE id=?`).get(id) as Record<string, unknown> | undefined
      return row ? rowToSourceChannel(row) : undefined
    },
    sourceChannelByUrl: (url) => {
      const row = d.prepare(`SELECT ${SOURCE_SELECT_COLS} FROM source_channels WHERE url=?`).get(url) as Record<string, unknown> | undefined
      return row ? rowToSourceChannel(row) : undefined
    },
    upsertSourceChannel: (s) => {
      d.prepare(
        `INSERT INTO source_channels (id,url,handle,name,nicheId,avatar,lastScrapedAt,lastVisitedAt,lastSeenVideoId,linkedMyChannelId,videoCount)
         VALUES (@id,@url,@handle,@name,@nicheId,@avatar,@lastScrapedAt,@lastVisitedAt,@lastSeenVideoId,@linkedMyChannelId,@videoCount)
         ON CONFLICT(id) DO UPDATE SET
           url=@url,
           handle=@handle,
           name=@name,
           nicheId=COALESCE(@nicheId,nicheId),
           avatar=COALESCE(@avatar,avatar),
           lastScrapedAt=COALESCE(@lastScrapedAt,lastScrapedAt),
           lastVisitedAt=COALESCE(@lastVisitedAt,lastVisitedAt),
           lastSeenVideoId=COALESCE(@lastSeenVideoId,lastSeenVideoId),
           linkedMyChannelId=COALESCE(@linkedMyChannelId,linkedMyChannelId),
           videoCount=COALESCE(@videoCount,videoCount)`
      ).run({
        nicheId: null,
        avatar: null,
        lastScrapedAt: null,
        lastVisitedAt: null,
        lastSeenVideoId: null,
        linkedMyChannelId: null,
        videoCount: null,
        ...s
      })
    },
    setSourceCursor: (id, patch) => {
      d.prepare(
        `UPDATE source_channels
         SET lastVisitedAt=COALESCE(@lastVisitedAt,lastVisitedAt),
             lastSeenVideoId=COALESCE(@lastSeenVideoId,lastSeenVideoId),
             lastRunAt=COALESCE(@lastRunAt,lastRunAt)
         WHERE id=@id`
      ).run({ id, lastVisitedAt: patch.lastVisitedAt ?? null, lastSeenVideoId: patch.lastSeenVideoId ?? null, lastRunAt: patch.lastRunAt ?? null })
    },
    updateSourceAutomation: (id, patch) => {
      if (!d.prepare('SELECT id FROM source_channels WHERE id=?').get(id)) throw new Error(`Unknown source: ${id}`)
      const row = sourceAutomationToRow(patch)
      const cols = Object.keys(row)
      if (cols.length > 0) {
        d.prepare(`UPDATE source_channels SET ${cols.map((c) => `${c}=@${c}`).join(', ')} WHERE id=@id`).run({ id, ...row })
      }
      return allSources()
    },
    deleteSourceChannel: (id) => {
      const tx = d.transaction(() => {
        d.prepare('DELETE FROM source_videos WHERE sourceId=?').run(id)
        d.prepare("UPDATE my_channels SET linkedSourceId=NULL, source='' WHERE linkedSourceId=?").run(id)
        d.prepare('DELETE FROM source_channels WHERE id=?').run(id)
      })
      tx()
    },
    newVideoCountForSource: (id) => {
      const row = d.prepare('SELECT lastSeenVideoId FROM source_channels WHERE id=?').get(id) as { lastSeenVideoId?: string } | undefined
      const videos = d.prepare('SELECT id FROM source_videos WHERE sourceId=? ORDER BY COALESCE(ord,999999), scrapedAt DESC').all(id) as Array<{ id: string }>
      if (!videos.length) return 0
      const cursor = row?.lastSeenVideoId
      if (!cursor) return videos.length
      const idx = videos.findIndex((v) => v.id === cursor)
      return idx < 0 ? videos.length : idx
    },
    setSourceLinkedMyChannel: (id, myChannelId) =>
      d.prepare('UPDATE source_channels SET linkedMyChannelId=? WHERE id=?').run(myChannelId, id),

    downloads: () => d.prepare('SELECT * FROM downloaded_videos').all() as DownloadedVideo[],
    getDownloadsBySource: (sourceId) =>
      d.prepare('SELECT * FROM downloaded_videos WHERE sourceId=?').all(sourceId) as DownloadedVideo[],

    profiles: allProfiles,
    templates: allTemplates,

    activity: () => d.prepare('SELECT t, icon, color, text FROM activity_log ORDER BY id DESC').all() as ActivityRow[],
    addActivity: (row) =>
      void d.prepare('INSERT INTO activity_log (t,icon,color,text) VALUES (@t,@icon,@color,@text)').run(row),

    upsertProfile: (p) => {
      const cols = PROFILE_COLS.join(',')
      const vals = PROFILE_COLS.map((c) => `@${c}`).join(',')
      const sets = PROFILE_COLS.filter((c) => c !== 'id').map((c) => `${c}=@${c}`).join(', ')
      d.prepare(`INSERT INTO profiles (${cols}) VALUES (${vals}) ON CONFLICT(id) DO UPDATE SET ${sets}`).run(profileToRow(p))
      return allProfiles()
    },
    deleteProfile: (id) => {
      d.prepare('DELETE FROM profiles WHERE id=?').run(id)
      return allProfiles()
    },
    getProfile: (id) => {
      const r = d.prepare('SELECT * FROM profiles WHERE id=?').get(id) as Record<string, unknown> | undefined
      return r ? rowToProfile(r) : undefined
    },
    setProfileCursor: (id, patch) => {
      d.prepare('UPDATE profiles SET lastSeenVideoId=@lastSeenVideoId, lastRunAt=@lastRunAt WHERE id=@id').run({
        id,
        lastSeenVideoId: patch.lastSeenVideoId ?? null,
        lastRunAt: patch.lastRunAt ?? null
      })
    },

    saveTemplate: (t) => {
      d.prepare(
        `INSERT INTO thumbnail_templates (id,name,layers) VALUES (@id,@name,@layers)
         ON CONFLICT(id) DO UPDATE SET name=@name, layers=@layers`
      ).run({ id: t.id, name: t.name, layers: JSON.stringify(t.layers) })
      return allTemplates()
    },
    deleteTemplate: (id) => {
      d.prepare('DELETE FROM thumbnail_templates WHERE id=?').run(id)
      return allTemplates()
    },
    getTemplate: (id) => {
      const r = d.prepare('SELECT * FROM thumbnail_templates WHERE id=?').get(id) as
        | { id: string; name: string; layers: string }
        | undefined
      return r ? { id: r.id, name: r.name, layers: JSON.parse(r.layers) } : undefined
    },
    assignTemplateToProfile: (profileId, templateId) => {
      d.prepare('UPDATE profiles SET thumbnailTemplateId=? WHERE id=?').run(templateId, profileId)
      return allProfiles()
    },

    // ---- M3 scraping writes ----
    replaceUploads: (channelId, rows) => {
      const tx = d.transaction(() => {
        d.prepare('DELETE FROM uploads WHERE myChannelId=?').run(channelId)
        const ins = d.prepare(
          `INSERT INTO uploads (id,myChannelId,title,youtubeVideoId,publishedAt,views,thumb,matchedDownloadId)
           VALUES (@id,@myChannelId,@title,@youtubeVideoId,@publishedAt,@views,@thumb,@matchedDownloadId)`
        )
        rows.forEach((r) => ins.run({ thumb: null, matchedDownloadId: null, ...r }))
      })
      tx()
    },
    getUploads: (channelId) =>
      d.prepare('SELECT * FROM uploads WHERE myChannelId=?').all(channelId) as Upload[],
    recentUploads: (limit) =>
      d.prepare(
        `SELECT u.title AS title, u.views AS views, u.publishedAt AS publishedAt, u.thumb AS thumb, c.name AS channel
         FROM uploads u JOIN my_channels c ON c.id = u.myChannelId
         ORDER BY u.publishedAt DESC LIMIT ?`
      ).all(limit) as RecentUpload[],

    replaceSourceVideos: (sourceId, rows) => {
      const tx = d.transaction(() => {
        d.prepare('DELETE FROM source_videos WHERE sourceId=?').run(sourceId)
        const now = new Date().toISOString()
        // INSERT OR REPLACE: the same video id can surface under more than one source
        // (the id is a global PK) — replace rather than collide.
        const ins = d.prepare(
          `INSERT OR REPLACE INTO source_videos (id,sourceId,title,durationSec,views,uploadDate,thumb,scrapedAt,ord)
           VALUES (@id,@sourceId,@title,@durationSec,@views,@uploadDate,@thumb,@scrapedAt,@ord)`
        )
        rows.forEach((r, ord) => ins.run({ ...r, sourceId, scrapedAt: now, ord }))
        d.prepare('UPDATE source_channels SET lastScrapedAt=?, videoCount=? WHERE id=?').run(now, rows.length, sourceId)
      })
      tx()
    },
    getSourceVideos: (sourceId) =>
      d.prepare('SELECT id,title,durationSec,views,uploadDate,thumb FROM source_videos WHERE sourceId=? ORDER BY COALESCE(ord,999999), scrapedAt DESC').all(sourceId) as ScrapedVideo[],

    setChannelStats: (id, patch) => {
      d.prepare('UPDATE my_channels SET views=@views, subs=@subs, total=@total, lastScrapedAt=@lastScrapedAt WHERE id=@id').run({ id, ...patch })
    },
    setChannelMapping: (id, mapDone, mapTotal) => {
      d.prepare('UPDATE my_channels SET mapDone=?, mapTotal=? WHERE id=?').run(mapDone, mapTotal, id)
    },
    setChannelGoalProgress: (id, weekDone, monthDone) => {
      d.prepare('UPDATE my_channels SET weekDone=?, monthDone=? WHERE id=?').run(weekDone, monthDone, id)
    },
    markDownloadMatches: (matches) => {
      const tx = d.transaction(() => {
        d.prepare('UPDATE downloaded_videos SET matchedUploadId=NULL').run()
        const dv = d.prepare('UPDATE downloaded_videos SET matchedUploadId=? WHERE id=?')
        const up = d.prepare('UPDATE uploads SET matchedDownloadId=? WHERE id=?')
        matches.forEach((m) => {
          dv.run(m.uploadId, m.downloadId)
          up.run(m.downloadId, m.uploadId)
        })
      })
      tx()
    },
    updateChannelGoals: (id, patch) => {
      const sets: string[] = []
      const params: Record<string, unknown> = { id }
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined) {
          sets.push(`${k}=@${k}`)
          params[k] = v
        }
      }
      if (sets.length) d.prepare(`UPDATE my_channels SET ${sets.join(', ')} WHERE id=@id`).run(params)
    },
    setChannelSource: (id, linkedSourceId) => {
      // Store both the FK and the source handle (shown on the card). Clearing resets the
      // mapping counters; a subsequent scrape/refresh recomputes matches for the new link.
      const src = linkedSourceId ? (d.prepare('SELECT handle FROM source_channels WHERE id=?').get(linkedSourceId) as { handle?: string } | undefined) : undefined
      d.prepare('UPDATE my_channels SET linkedSourceId=?, source=?, mapDone=0, mapTotal=0 WHERE id=?')
        .run(linkedSourceId ?? null, src?.handle ?? '', id)
    },
    deleteMyChannel: (id) => {
      const tx = d.transaction(() => {
        d.prepare('DELETE FROM uploads WHERE myChannelId=?').run(id)
        d.prepare('DELETE FROM my_channels WHERE id=?').run(id)
      })
      tx()
    },

    // ---- M4 download + compose writes ----
    download: (id) => d.prepare('SELECT * FROM downloaded_videos WHERE id=?').get(id) as DownloadedVideo | undefined,
    upsertDownload: (dl) => {
      d.prepare(
        `INSERT INTO downloaded_videos (id,sourceId,title,channel,size,"when",stage,pct,action,thumb,matchedUploadId,filePath,durationSec,error)
         VALUES (@id,@sourceId,@title,@channel,@size,@when,@stage,@pct,@action,@thumb,@matchedUploadId,@filePath,@durationSec,@error)
         ON CONFLICT(id) DO UPDATE SET sourceId=@sourceId, title=@title, channel=@channel, size=@size,
            "when"=@when, stage=@stage, pct=@pct, action=@action, thumb=@thumb, filePath=@filePath, durationSec=@durationSec, error=@error`
      ).run({ matchedUploadId: null, filePath: null, durationSec: null, error: null, ...dl })
    },
    setDownloadProgress: (id, patch) => {
      const sets: string[] = []
      const params: Record<string, unknown> = { id }
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined) {
          sets.push(`${k}=@${k}`)
          params[k] = v
        }
      }
      if (sets.length) d.prepare(`UPDATE downloaded_videos SET ${sets.join(', ')} WHERE id=@id`).run(params)
    },

    createProject: (p) => {
      d.prepare(
        `INSERT INTO projects (id,downloadId,title,channel,mp3Path,durationSec,imageMode,poolSize,kenBurns,seed,crossfade,captionPreset,captionFont,captionAnim,captionAspect,captionLines,captionPosition,captionPace,captionHighlightColor,captionBoxColor,captionWordsPerPage,emphasis,keywords,punchZoom,motionPreset,stage,createdAt,betaOpts)
         VALUES (@id,@downloadId,@title,@channel,@mp3Path,@durationSec,@imageMode,@poolSize,@kenBurns,@seed,@crossfade,@captionPreset,@captionFont,@captionAnim,@captionAspect,@captionLines,@captionPosition,@captionPace,@captionHighlightColor,@captionBoxColor,@captionWordsPerPage,@emphasis,@keywords,@punchZoom,@motionPreset,@stage,@createdAt,@betaOpts)`
      ).run(projectToRow(p))
    },
    getProject: (id) => {
      const r = d.prepare('SELECT * FROM projects WHERE id=?').get(id) as Record<string, unknown> | undefined
      return r ? rowToProject(r) : undefined
    },
    listProjects: () =>
      (d.prepare('SELECT * FROM projects ORDER BY createdAt DESC').all() as Array<Record<string, unknown>>).map(rowToProject),
    updateProject: (id, patch) => {
      const row = projectPatchToRow(patch)
      const keys = Object.keys(row)
      if (keys.length) d.prepare(`UPDATE projects SET ${keys.map((k) => `${k}=@${k}`).join(', ')} WHERE id=@id`).run({ id, ...row })
      const r = d.prepare('SELECT * FROM projects WHERE id=?').get(id) as Record<string, unknown> | undefined
      return r ? rowToProject(r) : undefined
    },

    replaceProjectImages: (projectId, rows) => {
      const tx = d.transaction(() => {
        d.prepare('DELETE FROM project_images WHERE projectId=?').run(projectId)
        const ins = d.prepare(
          'INSERT INTO project_images (id,projectId,ord,path,thumb,rangeStart,rangeEnd,manual,motionPreset,motionDirection,motionAmount) VALUES (@id,@projectId,@ord,@path,@thumb,@rangeStart,@rangeEnd,@manual,@motionPreset,@motionDirection,@motionAmount)'
        )
        rows.forEach((r) => ins.run({ ...r, manual: r.manual ? 1 : 0, motionPreset: r.motionPreset ?? null, motionDirection: r.motionDirection ?? null, motionAmount: r.motionAmount ?? null }))
      })
      tx()
    },
    getProjectImages: (projectId) =>
      (d.prepare('SELECT * FROM project_images WHERE projectId=? ORDER BY ord').all(projectId) as Array<Record<string, unknown>>).map(rowToImage),
    recordAssets: (rows) => {
      const tx = d.transaction(() => {
        const ins = d.prepare(`INSERT INTO assets
          (path,channel,addedAt,id,canonicalPath,originalPath,sourceId,channelHandle,channelAvatar,thumbnailPath,mimeType,width,height,fileSize,firstAddedAt,lastUsedAt,usageCount,missing,projectId)
          VALUES (@path,@channel,@addedAt,@id,@canonicalPath,@originalPath,@sourceId,@channelHandle,@channelAvatar,@thumbnailPath,@mimeType,@width,@height,@fileSize,@firstAddedAt,@lastUsedAt,@usageCount,@missing,@projectId)
          ON CONFLICT(path) DO UPDATE SET channel=excluded.channel,addedAt=excluded.addedAt,id=excluded.id,canonicalPath=excluded.canonicalPath,
          originalPath=COALESCE(assets.originalPath,excluded.originalPath),sourceId=COALESCE(excluded.sourceId,assets.sourceId),channelHandle=COALESCE(excluded.channelHandle,assets.channelHandle),
          channelAvatar=COALESCE(excluded.channelAvatar,assets.channelAvatar),thumbnailPath=excluded.thumbnailPath,mimeType=excluded.mimeType,width=excluded.width,height=excluded.height,
          fileSize=excluded.fileSize,firstAddedAt=COALESCE(assets.firstAddedAt,excluded.firstAddedAt),lastUsedAt=excluded.lastUsedAt,usageCount=MAX(COALESCE(assets.usageCount,0),excluded.usageCount),missing=excluded.missing,projectId=COALESCE(excluded.projectId,assets.projectId)`)
        for (const row of rows) ins.run({
          ...row,
          originalPath: row.originalPath ?? null, sourceId: row.sourceId ?? null, channelHandle: row.channelHandle ?? null,
          channelAvatar: row.channelAvatar ?? null, thumbnailPath: row.thumbnailPath ?? null, mimeType: row.mimeType ?? null,
          width: row.width ?? null, height: row.height ?? null, fileSize: row.fileSize ?? null, projectId: row.projectId ?? null,
          missing: row.missing ? 1 : 0
        })
      })
      tx()
    },
    replaceAssetPath: (oldPath, row) => {
      const tx = d.transaction(() => {
        d.prepare('DELETE FROM assets WHERE path=?').run(oldPath)
        const now = row.lastUsedAt || new Date().toISOString()
        d.prepare(`INSERT OR REPLACE INTO assets
          (path,channel,addedAt,id,canonicalPath,originalPath,sourceId,channelHandle,channelAvatar,thumbnailPath,mimeType,width,height,fileSize,firstAddedAt,lastUsedAt,usageCount,missing,projectId)
          VALUES (@path,@channel,@addedAt,@id,@canonicalPath,@originalPath,@sourceId,@channelHandle,@channelAvatar,@thumbnailPath,@mimeType,@width,@height,@fileSize,@firstAddedAt,@lastUsedAt,@usageCount,@missing,@projectId)`)
          .run({ ...row, originalPath: row.originalPath ?? oldPath, sourceId: row.sourceId ?? null, channelHandle: row.channelHandle ?? null, channelAvatar: row.channelAvatar ?? null, thumbnailPath: row.thumbnailPath ?? null, mimeType: row.mimeType ?? null, width: row.width ?? null, height: row.height ?? null, fileSize: row.fileSize ?? null, projectId: row.projectId ?? null, missing: row.missing ? 1 : 0, lastUsedAt: now })
      })
      tx()
    },
    listAssets: () => (d.prepare('SELECT * FROM assets ORDER BY COALESCE(lastUsedAt,addedAt) DESC').all() as Array<Record<string, unknown>>).map((r) => {
      const path = String(r.canonicalPath || r.path || '')
      const addedAt = String(r.firstAddedAt || r.addedAt || new Date(0).toISOString())
      return {
        id: String(r.id || createHash('sha256').update(path).digest('hex')),
        path,
        canonicalPath: path,
        originalPath: r.originalPath ? String(r.originalPath) : undefined,
        sourceId: r.sourceId ? String(r.sourceId) : undefined,
        channel: String(r.channel || 'Unsorted'),
        channelHandle: r.channelHandle ? String(r.channelHandle) : undefined,
        channelAvatar: r.channelAvatar ? String(r.channelAvatar) : undefined,
        thumbnailPath: r.thumbnailPath ? String(r.thumbnailPath) : undefined,
        mimeType: r.mimeType ? String(r.mimeType) : undefined,
        width: r.width == null ? undefined : coerceNum(r.width, 0),
        height: r.height == null ? undefined : coerceNum(r.height, 0),
        fileSize: r.fileSize == null ? undefined : coerceNum(r.fileSize, 0),
        addedAt: String(r.addedAt || addedAt), firstAddedAt: addedAt,
        lastUsedAt: String(r.lastUsedAt || r.addedAt || addedAt), usageCount: coerceNum(r.usageCount, 1),
        missing: !!r.missing, projectId: r.projectId ? String(r.projectId) : undefined
      }
    }),
    setImageRanges: (projectId, ranges) => {
      const tx = d.transaction(() => {
        const up = d.prepare('UPDATE project_images SET rangeStart=@rangeStart, rangeEnd=@rangeEnd, manual=1 WHERE id=@id AND projectId=@projectId')
        ranges.forEach((r) => up.run({ ...r, projectId }))
      })
      tx()
    },
    setImageMotion: (projectId, updates) => {
      if (!updates.length) return
      const tx = d.transaction(() => {
        for (const r of updates) {
          const row: Record<string, unknown> = {}
          if ('motionPreset' in r) row.motionPreset = r.motionPreset ?? null
          if ('motionDirection' in r) row.motionDirection = r.motionDirection ?? null
          if ('motionAmount' in r) row.motionAmount = r.motionAmount ?? null
          const keys = Object.keys(row)
          if (!keys.length) continue
          d.prepare(`UPDATE project_images SET ${keys.map((k) => `${k}=@${k}`).join(', ')} WHERE id=@id AND projectId=@projectId`).run({ id: r.id, projectId, ...row })
        }
      })
      tx()
    },

    replaceTranscript: (projectId, rows) => {
      const tx = d.transaction(() => {
        d.prepare('DELETE FROM transcript_words WHERE projectId=?').run(projectId)
        const ins = d.prepare(
          'INSERT INTO transcript_words (id,projectId,ord,word,start,end,emphasis) VALUES (@id,@projectId,@ord,@word,@start,@end,@emphasis)'
        )
        rows.forEach((r) => ins.run({ ...r, emphasis: r.emphasis ? 1 : 0 }))
      })
      tx()
    },
    getTranscript: (projectId) =>
      (d.prepare('SELECT * FROM transcript_words WHERE projectId=? ORDER BY ord').all(projectId) as Array<Record<string, unknown>>).map(rowToWord),
    updateWord: (wordId, text) => void d.prepare('UPDATE transcript_words SET word=? WHERE id=?').run(text, wordId),
    toggleEmphasis: (wordId) =>
      void d.prepare('UPDATE transcript_words SET emphasis = CASE emphasis WHEN 1 THEN 0 ELSE 1 END WHERE id=?').run(wordId),
    setEmphasis: (wordIds, emphasis) => {
      if (!wordIds.length) return
      const tx = d.transaction(() => {
        const st = d.prepare('UPDATE transcript_words SET emphasis=? WHERE id=?')
        wordIds.forEach((id) => st.run(emphasis ? 1 : 0, id))
      })
      tx()
    },

    createRenderJob: (job) => {
      d.prepare(
        `INSERT INTO render_jobs (id,title,channel,status,pct,createdAt,projectId)
         VALUES (@id,@title,@channel,'queued',0,@createdAt,@projectId)
         ON CONFLICT(id) DO UPDATE SET title=@title, channel=@channel, projectId=@projectId, status='queued', pct=0, error=NULL`
      ).run({ ...job, createdAt: new Date().toISOString() })
    },
    renderJobs: () =>
      d.prepare('SELECT id,title,channel,status,pct,projectId,outputPath,error,createdAt FROM render_jobs ORDER BY createdAt').all() as RenderJob[],
    renderJob: (id) =>
      d.prepare('SELECT id,title,channel,status,pct,projectId,outputPath,error,createdAt FROM render_jobs WHERE id=?').get(id) as RenderJob | undefined,
    queuedJobs: () =>
      d.prepare("SELECT id,title,channel,status,pct,projectId,outputPath,error,createdAt FROM render_jobs WHERE status='queued' ORDER BY createdAt").all() as RenderJob[],
    setRenderStatus: (id, patch) => {
      const sets: string[] = ['updatedAt=@updatedAt']
      const params: Record<string, unknown> = { id, updatedAt: new Date().toISOString() }
      for (const k of ['status', 'pct', 'outputPath', 'error'] as const) {
        if (patch[k] !== undefined) {
          sets.push(`${k}=@${k}`)
          params[k] = patch[k]
        }
      }
      d.prepare(`UPDATE render_jobs SET ${sets.join(', ')} WHERE id=@id`).run(params)
    },

    createAutomationJob: (job, steps) => {
      const tx = d.transaction(() => {
        d.prepare(
          `INSERT INTO automation_jobs
           (id,name,goal,status,progress,currentStep,configJson,resultJson,errorKind,error,createdAt,updatedAt,startedAt,completedAt,lastCheckpointAt,nextRetryAt,pauseRequested,cancelRequested,warningCount,failedCount,completedCount,totalItems)
           VALUES (@id,@name,@goal,@status,@progress,@currentStep,@configJson,@resultJson,@errorKind,@error,@createdAt,@updatedAt,@startedAt,@completedAt,@lastCheckpointAt,@nextRetryAt,@pauseRequested,@cancelRequested,@warningCount,@failedCount,@completedCount,@totalItems)`
        ).run({
          ...job,
          configJson: JSON.stringify(job.config),
          resultJson: job.result ? JSON.stringify(job.result) : null,
          errorKind: job.errorKind ?? null,
          error: job.error ?? null,
          startedAt: job.startedAt ?? null,
          completedAt: job.completedAt ?? null,
          lastCheckpointAt: job.lastCheckpointAt ?? null,
          nextRetryAt: job.nextRetryAt ?? null,
          pauseRequested: job.pauseRequested ? 1 : 0,
          cancelRequested: job.cancelRequested ? 1 : 0
        })
        const ins = d.prepare(
          `INSERT INTO automation_job_steps
           (id,jobId,key,label,description,ord,status,progress,attempts,maxAttempts,runsOn,optional,startedAt,completedAt,error,checkpointJson)
           VALUES (@id,@jobId,@key,@label,@description,@ord,@status,@progress,@attempts,@maxAttempts,@runsOn,@optional,@startedAt,@completedAt,@error,@checkpointJson)`
        )
        for (const step of steps) ins.run({
          ...step,
          optional: step.optional ? 1 : 0,
          startedAt: step.startedAt ?? null,
          completedAt: step.completedAt ?? null,
          error: step.error ?? null,
          checkpointJson: step.checkpoint ? JSON.stringify(step.checkpoint) : null
        })
      })
      tx()
    },
    automationJobs: () =>
      (d.prepare('SELECT * FROM automation_jobs ORDER BY createdAt DESC').all() as Array<Record<string, unknown>>).map(rowToAutomationJob),
    automationJob: (id) => {
      const row = d.prepare('SELECT * FROM automation_jobs WHERE id=?').get(id) as Record<string, unknown> | undefined
      return row ? rowToAutomationJob(row) : undefined
    },
    automationSteps: (jobId) =>
      (d.prepare('SELECT * FROM automation_job_steps WHERE jobId=? ORDER BY ord').all(jobId) as Array<Record<string, unknown>>).map(rowToAutomationStep),
    automationItems: (jobId) =>
      (d.prepare('SELECT * FROM automation_job_items WHERE jobId=? ORDER BY updatedAt,id').all(jobId) as Array<Record<string, unknown>>).map(rowToAutomationItem),
    automationLogs: (jobId, limit = 200) =>
      (d.prepare('SELECT * FROM automation_job_logs WHERE jobId=? ORDER BY id DESC LIMIT ?').all(jobId, Math.max(1, Math.min(1000, limit))) as AutomationJobLog[]).reverse(),
    updateAutomationJob: (id, patch) => {
      const allow = new Set(['name','goal','status','progress','currentStep','createdAt','updatedAt','startedAt','completedAt','lastCheckpointAt','nextRetryAt','pauseRequested','cancelRequested','warningCount','failedCount','completedCount','totalItems','errorKind','error'])
      const sets: string[] = []
      const params: Record<string, unknown> = { id }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue
        if (key === 'config') { sets.push('configJson=@configJson'); params.configJson = JSON.stringify(value); continue }
        if (key === 'result') { sets.push('resultJson=@resultJson'); params.resultJson = JSON.stringify(value); continue }
        if (!allow.has(key)) continue
        sets.push(`${key}=@${key}`)
        params[key] = key === 'pauseRequested' || key === 'cancelRequested' ? (value ? 1 : 0) : value
      }
      if (!sets.length) return
      if (!sets.some((s) => s.startsWith('updatedAt='))) { sets.push('updatedAt=@autoUpdatedAt'); params.autoUpdatedAt = new Date().toISOString() }
      d.prepare(`UPDATE automation_jobs SET ${sets.join(', ')} WHERE id=@id`).run(params)
    },
    updateAutomationStep: (id, patch) => {
      const allow = new Set(['status','progress','attempts','maxAttempts','startedAt','completedAt','error'])
      const sets: string[] = []
      const params: Record<string, unknown> = { id }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue
        if (key === 'checkpoint') { sets.push('checkpointJson=@checkpointJson'); params.checkpointJson = JSON.stringify(value); continue }
        if (!allow.has(key)) continue
        sets.push(`${key}=@${key}`)
        params[key] = value
      }
      if (sets.length) d.prepare(`UPDATE automation_job_steps SET ${sets.join(', ')} WHERE id=@id`).run(params)
    },
    upsertAutomationItem: (item) => {
      d.prepare(
        `INSERT INTO automation_job_items (id,jobId,sourceVideoId,title,status,currentStep,progress,attempts,projectId,renderJobId,outputPath,warning,error,updatedAt,stateJson)
         VALUES (@id,@jobId,@sourceVideoId,@title,@status,@currentStep,@progress,@attempts,@projectId,@renderJobId,@outputPath,@warning,@error,@updatedAt,@stateJson)
         ON CONFLICT(id) DO UPDATE SET title=@title,status=@status,currentStep=@currentStep,progress=@progress,attempts=@attempts,projectId=@projectId,renderJobId=@renderJobId,outputPath=@outputPath,warning=@warning,error=@error,updatedAt=@updatedAt,stateJson=@stateJson`
      ).run({ ...item, projectId: item.projectId ?? null, renderJobId: item.renderJobId ?? null, outputPath: item.outputPath ?? null, warning: item.warning ?? null, error: item.error ?? null,
        stateJson: JSON.stringify({ stepStates: item.stepStates, selectionDecision: item.selectionDecision, brollSeed: item.brollSeed, brollClipIds: item.brollClipIds, retryAt: item.retryAt }) })
    },
    addAutomationLog: (jobId, level, message, itemId) => {
      d.prepare('INSERT INTO automation_job_logs (jobId,itemId,level,message,createdAt) VALUES (?,?,?,?,?)')
        .run(jobId, itemId ?? null, level, message, new Date().toISOString())
    },

    // ---- TalkingPhotos provider ----
    providerConnection: (id) => {
      const r = d.prepare('SELECT * FROM provider_connections WHERE id=?').get(id) as Record<string, unknown> | undefined
      return r ? rowToProviderConnection(r) : undefined
    },
    providerConnections: () =>
      (d.prepare('SELECT * FROM provider_connections').all() as Array<Record<string, unknown>>).map(rowToProviderConnection),
    upsertProviderConnection: (row) => {
      d.prepare(
        `INSERT INTO provider_connections (id,provider,partition,status,accountLabel,connectedAt,lastVerifiedAt,lastError,createdAt,updatedAt)
         VALUES (@id,@provider,@partition,@status,@accountLabel,@connectedAt,@lastVerifiedAt,@lastError,@createdAt,@updatedAt)
         ON CONFLICT(id) DO UPDATE SET provider=@provider, partition=@partition, status=@status, accountLabel=@accountLabel,
           connectedAt=@connectedAt, lastVerifiedAt=@lastVerifiedAt, lastError=@lastError, updatedAt=@updatedAt`
      ).run({ accountLabel: null, connectedAt: null, lastVerifiedAt: null, lastError: null, ...row })
    },
    providerJob: (id) => {
      const r = d.prepare('SELECT * FROM provider_jobs WHERE id=?').get(id) as Record<string, unknown> | undefined
      return r ? rowToProviderJob(r) : undefined
    },
    providerJobByRemoteId: (connectionId, remoteProjectId) => {
      const r = d.prepare('SELECT * FROM provider_jobs WHERE connectionId=? AND remoteProjectId=?').get(connectionId, remoteProjectId) as Record<string, unknown> | undefined
      return r ? rowToProviderJob(r) : undefined
    },
    providerJobByFingerprint: (connectionId, requestFingerprint) => {
      const r = d.prepare('SELECT * FROM provider_jobs WHERE connectionId=? AND requestFingerprint=? ORDER BY createdAt DESC LIMIT 1').get(connectionId, requestFingerprint) as Record<string, unknown> | undefined
      return r ? rowToProviderJob(r) : undefined
    },
    findOrCreateProviderJob: (job) => {
      const key = { provider: job.provider, connectionId: job.connectionId, operation: job.operation, requestFingerprint: job.requestFingerprint ?? '', creationIntentId: job.creationIntentId ?? '' }
      const findExisting = (): Record<string, unknown> | undefined =>
        d.prepare(
          'SELECT * FROM provider_jobs WHERE provider=@provider AND connectionId=@connectionId AND operation=@operation AND requestFingerprint=@requestFingerprint AND creationIntentId=@creationIntentId'
        ).get(key) as Record<string, unknown> | undefined
      try {
        const tx = d.transaction(() => {
          if (job.requestFingerprint) {
            const existing = findExisting()
            if (existing) return { job: rowToProviderJob(existing), created: false }
          }
          const row = providerJobToRow(job)
          const cols = Object.keys(row)
          d.prepare(`INSERT INTO provider_jobs (${cols.join(',')}) VALUES (${cols.map((c) => `@${c}`).join(',')})`).run(row)
          return { job, created: true }
        })
        return tx()
      } catch (e) {
        // Lost a race on the unique index — another call already inserted first.
        if (job.requestFingerprint && /UNIQUE constraint failed/i.test((e as Error).message)) {
          const existing = findExisting()
          if (existing) return { job: rowToProviderJob(existing), created: false }
        }
        throw e
      }
    },
    providerJobs: (connectionId) => {
      const rows = connectionId
        ? (d.prepare('SELECT * FROM provider_jobs WHERE connectionId=? ORDER BY createdAt DESC').all(connectionId) as Array<Record<string, unknown>>)
        : (d.prepare('SELECT * FROM provider_jobs ORDER BY createdAt DESC').all() as Array<Record<string, unknown>>)
      return rows.map(rowToProviderJob)
    },
    nonTerminalProviderJobs: () =>
      (d.prepare("SELECT * FROM provider_jobs WHERE status NOT IN ('completed','failed','cancelled') ORDER BY createdAt").all() as Array<Record<string, unknown>>).map(rowToProviderJob),
    upsertProviderJob: (job) => {
      const row = providerJobToRow(job)
      const cols = Object.keys(row)
      d.prepare(
        `INSERT INTO provider_jobs (${cols.join(',')}) VALUES (${cols.map((c) => `@${c}`).join(',')})
         ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${c}=@${c}`).join(', ')}`
      ).run(row)
    },
    updateProviderJob: (id, patch) => {
      const allow = new Set([
        'operation', 'remoteProjectId', 'remoteTaskUuid', 'remotePreviousTaskUuid', 'parentProviderJobId',
        'automationJobId', 'automationItemId', 'projectId', 'requestFingerprint', 'requestJson', 'status', 'remoteStep',
        'remoteStepsTotal', 'progress', 'remoteMediaId', 'remoteMediaUrl', 'localOutputPath', 'localCaptionedOutputPath', 'errorCode',
        'errorMessage', 'segmentOrdinal', 'internalSegment', 'lastPolledAt', 'downloadedAt'
      ])
      const sets: string[] = []
      const params: Record<string, unknown> = { id }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || !allow.has(key)) continue
        sets.push(`${key}=@${key}`)
        params[key] = key === 'internalSegment' ? (value ? 1 : 0) : value
      }
      if (!sets.length) return
      if (!sets.some((s) => s.startsWith('updatedAt='))) { sets.push('updatedAt=@updatedAt'); params.updatedAt = new Date().toISOString() }
      d.prepare(`UPDATE provider_jobs SET ${sets.join(', ')} WHERE id=@id`).run(params)
    },
    providerAssetByHash: (provider, connectionId, localSha256) => {
      const r = d.prepare('SELECT * FROM provider_assets WHERE provider=? AND connectionId=? AND localSha256=?').get(provider, connectionId, localSha256) as Record<string, unknown> | undefined
      return r ? rowToProviderAsset(r) : undefined
    },
    upsertProviderAsset: (asset) => {
      d.prepare(
        `INSERT INTO provider_assets (id,provider,connectionId,localSha256,localPath,mimeType,sizeBytes,durationSec,remoteCategoryId,remoteMediaId,remoteResultUuid,uploadedAt,lastVerifiedAt)
         VALUES (@id,@provider,@connectionId,@localSha256,@localPath,@mimeType,@sizeBytes,@durationSec,@remoteCategoryId,@remoteMediaId,@remoteResultUuid,@uploadedAt,@lastVerifiedAt)
         ON CONFLICT(id) DO UPDATE SET localPath=@localPath, mimeType=@mimeType, sizeBytes=@sizeBytes, durationSec=@durationSec,
           remoteCategoryId=@remoteCategoryId, remoteMediaId=@remoteMediaId, remoteResultUuid=@remoteResultUuid, uploadedAt=@uploadedAt, lastVerifiedAt=@lastVerifiedAt`
      ).run({
        mimeType: null, sizeBytes: null, durationSec: null, remoteCategoryId: null, remoteMediaId: null, remoteResultUuid: null, uploadedAt: null, lastVerifiedAt: null,
        ...asset
      })
    },
    getTranscriptDocument: (projectId) => {
      const r = d.prepare('SELECT * FROM transcript_documents WHERE projectId=?').get(projectId) as Record<string, unknown> | undefined
      return r ? rowToTranscriptDocument(r) : undefined
    },
    upsertTranscriptDocument: (doc) => {
      d.prepare(
        `INSERT INTO transcript_documents (projectId,text,segmentsJson,source,createdAt,updatedAt)
         VALUES (@projectId,@text,@segmentsJson,@source,@createdAt,@updatedAt)
         ON CONFLICT(projectId) DO UPDATE SET text=@text, segmentsJson=@segmentsJson, source=@source, updatedAt=@updatedAt`
      ).run({ segmentsJson: null, ...doc })
    },

    resetAll: () => {
      const tx = d.transaction(() => {
        for (const t of DATA_TABLES) d.prepare(`DELETE FROM ${t}`).run()
        // Keep the DB empty: record that seeding has already happened so the next
        // launch's seedIfEmpty() does not re-insert the demo channels/profiles.
        d.prepare("INSERT OR REPLACE INTO app_meta (key,value) VALUES ('seeded','1')").run()
      })
      tx()
    },

    deleteDownload: (id) => d.prepare('DELETE FROM downloaded_videos WHERE id=?').run(id),
    deleteRenderJob: (id) => d.prepare('DELETE FROM render_jobs WHERE id=?').run(id),

    rewriteAssetPaths: (updates) => {
      // Allowlist: table → set of columns the reorg migration may rewrite. Guards the
      // dynamic SQL below against any unexpected table/column reaching it.
      const ALLOW: Record<string, Set<string>> = {
        downloaded_videos: new Set(['filePath']),
        projects: new Set(['mp3Path', 'thumbPath']),
        project_images: new Set(['path', 'thumb']),
        render_jobs: new Set(['outputPath'])
      }
      const valid = updates.filter((u) => ALLOW[u.table]?.has(u.column))
      if (!valid.length) return
      const tx = d.transaction(() => {
        for (const u of valid) {
          d.prepare(`UPDATE ${u.table} SET ${u.column}=@value WHERE id=@id`).run({ value: u.value, id: u.id })
        }
      })
      tx()
    },
    workItems: () => {
      const downloads = d.prepare('SELECT * FROM downloaded_videos').all() as DownloadedVideo[]
      const projects = d.prepare('SELECT * FROM projects').all() as Array<Record<string, unknown>>
      const projByDownload = new Map<string, { id: string; thumbPath?: string }>()
      for (const p of projects) projByDownload.set(String(p.downloadId), { id: String(p.id), thumbPath: (p.thumbPath as string) || undefined })
      const imgCounts = new Map<string, number>()
      for (const r of d.prepare('SELECT projectId, COUNT(*) c FROM project_images GROUP BY projectId').all() as Array<{ projectId: string; c: number }>) imgCounts.set(r.projectId, r.c)
      const wordCounts = new Map<string, number>()
      for (const r of d.prepare('SELECT projectId, COUNT(*) c FROM transcript_words GROUP BY projectId').all() as Array<{ projectId: string; c: number }>) wordCounts.set(r.projectId, r.c)
      const jobByProject = new Map<string, RenderJob>()
      for (const j of d.prepare('SELECT id,title,channel,status,pct,projectId,outputPath,error,createdAt FROM render_jobs ORDER BY createdAt').all() as RenderJob[]) {
        if (j.projectId) jobByProject.set(j.projectId, j) // last (most recent) wins
      }
      const state = new Map<string, { uploadedTo?: string; uploadMatchScore?: number; uploadConfidence?: string | null; manualUploaded?: number | null; archived?: number }>()
      for (const s of d.prepare('SELECT * FROM work_item_state').all() as Array<Record<string, unknown>>) {
        state.set(String(s.videoId), { uploadedTo: s.uploadedTo as string, uploadMatchScore: s.uploadMatchScore as number, uploadConfidence: s.uploadConfidence as string | null, manualUploaded: s.manualUploaded as number | null, archived: s.archived as number })
      }
      return downloads.map((dl): WorkItem => {
        const videoId = dl.id.replace(/^dl-/, '')
        const proj = projByDownload.get(dl.id)
        const job = proj ? jobByProject.get(proj.id) : undefined
        const st = state.get(videoId)
        let uploadedTo: string[] = []
        if (st?.uploadedTo) { try { uploadedTo = JSON.parse(st.uploadedTo) as string[] } catch { uploadedTo = [] } }
        const manualUploaded = st?.manualUploaded == null ? null : !!st.manualUploaded
        const detectedConfidence = st?.uploadConfidence === 'pending'
          ? 'pending'
          : uploadedTo.length > 0 ? 'high' : undefined
        const uploaded = manualUploaded == null
          ? uploadedTo.length > 0 && detectedConfidence !== 'pending'
          : manualUploaded
        return {
          videoId,
          channel: dl.channel,
          title: dl.title,
          thumb: dl.thumb || undefined,
          downloadId: dl.id,
          projectId: proj?.id,
          renderJobId: job?.id,
          downloaded: !!dl.filePath,
          hasImages: !!proj && (imgCounts.get(proj.id) ?? 0) > 0,
          captioned: !!proj && (wordCounts.get(proj.id) ?? 0) > 0,
          hasThumbnail: !!proj?.thumbPath,
          rendered: job?.status === 'done' && !!job.outputPath,
          uploaded,
          renderStatus: job?.status,
          outputPath: job?.outputPath,
          error: dl.error || job?.error || undefined,
          uploadedTo,
          uploadMatchScore: st?.uploadMatchScore ?? undefined,
          uploadConfidence: detectedConfidence,
          uploadedManual: manualUploaded,
          archived: !!st?.archived
        }
      })
    },
    allUploadsForMatch: () =>
      d.prepare('SELECT myChannelId AS channelId, title FROM uploads').all() as Array<{ channelId: string; title: string }>,
    setWorkItemUploaded: (videoId, uploaded) => {
      d.prepare(
        `INSERT INTO work_item_state (videoId, manualUploaded, updatedAt) VALUES (@videoId, @v, @now)
         ON CONFLICT(videoId) DO UPDATE SET manualUploaded=@v, updatedAt=@now`
      ).run({ videoId, v: uploaded ? 1 : 0, now: new Date().toISOString() })
    },
    setWorkItemArchived: (videoId, archived) => {
      d.prepare(
        `INSERT INTO work_item_state (videoId, archived, updatedAt) VALUES (@videoId, @v, @now)
         ON CONFLICT(videoId) DO UPDATE SET archived=@v, updatedAt=@now`
      ).run({ videoId, v: archived ? 1 : 0, now: new Date().toISOString() })
    },
    setDetectedUploads: (rows) => {
      const now = new Date().toISOString()
      const up = d.prepare(
        `INSERT INTO work_item_state (videoId, uploadedTo, uploadMatchScore, uploadConfidence, updatedAt) VALUES (@videoId, @uploadedTo, @score, @confidence, @now)
         ON CONFLICT(videoId) DO UPDATE SET uploadedTo=@uploadedTo, uploadMatchScore=@score, uploadConfidence=@confidence, updatedAt=@now`
      )
      const tx = d.transaction(() => {
        for (const r of rows) up.run({ videoId: r.videoId, uploadedTo: JSON.stringify(r.uploadedTo), score: r.score, confidence: r.confidence ?? null, now })
      })
      tx()
    },
    uploadStates: (videoIds) => {
      const result = new Map<string, { manualUploaded: boolean | null }>()
      if (!videoIds.length) return result
      const read = d.prepare('SELECT manualUploaded FROM work_item_state WHERE videoId=?')
      for (const videoId of videoIds) {
        const row = read.get(videoId) as { manualUploaded?: number | null } | undefined
        result.set(videoId, { manualUploaded: row?.manualUploaded == null ? null : !!row.manualUploaded })
      }
      return result
    },
    niches: () =>
      (d.prepare('SELECT * FROM niches ORDER BY name').all() as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        name: String(r.name ?? ''),
        keywords: parseKeywords(r.keywords),
        orientation: (r.orientation as Niche['orientation']) || 'landscape',
        targetClips: Number(r.targetClips ?? 60),
        createdAt: String(r.createdAt ?? ''),
        updatedAt: String(r.updatedAt ?? '')
      })),
    saveNiche: (n) => {
      d.prepare(
        `INSERT INTO niches (id,name,keywords,orientation,targetClips,createdAt,updatedAt)
         VALUES (@id,@name,@keywords,@orientation,@targetClips,@createdAt,@updatedAt)
         ON CONFLICT(id) DO UPDATE SET name=@name, keywords=@keywords, orientation=@orientation, targetClips=@targetClips, updatedAt=@updatedAt`
      ).run({
        id: n.id, name: n.name, keywords: JSON.stringify(n.keywords ?? []),
        orientation: n.orientation, targetClips: n.targetClips,
        createdAt: n.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString()
      })
    },
    deleteNiche: (id) => {
      const tx = d.transaction(() => {
        d.prepare('DELETE FROM niches WHERE id=?').run(id)
        d.prepare('UPDATE source_channels SET nicheId=NULL WHERE nicheId=?').run(id)
      })
      tx()
    },
    setSourceChannelNiche: (channelId, nicheId) =>
      d.prepare('UPDATE source_channels SET nicheId=? WHERE id=?').run(nicheId, channelId),
    nicheKeyForDownload: (downloadId) => {
      const row = d.prepare(
        `SELECT sc.nicheId AS nicheId FROM downloaded_videos dv
         JOIN source_channels sc ON sc.id = dv.sourceId WHERE dv.id=?`
      ).get(downloadId) as { nicheId?: string } | undefined
      return row?.nicheId ? `niche-${row.nicheId}` : undefined
    },
    nicheForDownload: (downloadId) => {
      const row = d.prepare(
        `SELECT n.* FROM downloaded_videos dv
         JOIN source_channels sc ON sc.id = dv.sourceId
         JOIN niches n ON n.id = sc.nicheId WHERE dv.id=?`
      ).get(downloadId) as Record<string, unknown> | undefined
      if (!row) return undefined
      return {
        id: String(row.id), name: String(row.name ?? ''), keywords: parseKeywords(row.keywords),
        orientation: (row.orientation as Niche['orientation']) || 'landscape',
        targetClips: Number(row.targetClips ?? 60), createdAt: String(row.createdAt ?? ''), updatedAt: String(row.updatedAt ?? '')
      }
    },
    appMeta: (key) => {
      const row = d.prepare('SELECT value FROM app_meta WHERE key=?').get(key) as { value: string } | undefined
      return row?.value
    },
    setAppMeta: (key, value) => {
      d.prepare('INSERT OR REPLACE INTO app_meta (key,value) VALUES (?,?)').run(key, value)
    },

    softReset: () => {
      // Wipe domain data but leave thumbnail_templates (user art) intact. provider_connections
      // is also kept — like API keys, a TalkingPhotos login is a credential, not disposable
      // project data, and the actual session cookies live in the Chromium partition regardless.
      const softTables = [
        'my_channels', 'source_channels', 'source_videos', 'downloaded_videos', 'uploads',
        'profiles', 'render_jobs', 'activity_log',
        'projects', 'project_images', 'transcript_words',
        'automation_jobs', 'automation_job_steps', 'automation_job_items', 'automation_job_logs',
        'provider_jobs', 'provider_assets', 'transcript_documents'
      ]
      const tx = d.transaction(() => {
        for (const t of softTables) d.prepare(`DELETE FROM ${t}`).run()
        d.prepare('DELETE FROM work_item_state').run()
        d.prepare("INSERT OR REPLACE INTO app_meta (key,value) VALUES ('seeded','1')").run()
      })
      tx()
    }
  }
}

const PROJECT_BOOL_KEYS = new Set(['kenBurns', 'emphasis', 'keywords', 'punchZoom'])
function parseMotionPreset(raw: unknown): Project['motionPreset'] {
  return raw === 'off' || raw === 'subtle' || raw === 'cinematic' ? raw : undefined
}
function parseMotionDirection(raw: unknown): MotionDirection | undefined {
  return raw === 'auto' || raw === 'push' || raw === 'pull' || raw === 'left' || raw === 'right' || raw === 'up' || raw === 'down' ? raw : undefined
}

function projectToRow(p: Project): Record<string, unknown> {
  return { ...p, captionLines: p.captionLines ?? 1, captionPosition: p.captionPosition ?? 'bottom', captionOffsetY: p.captionOffsetY ?? null, captionPace: p.captionPace ?? 'auto', captionHighlightColor: p.captionHighlightColor ?? null, captionBoxColor: p.captionBoxColor ?? null, captionWordsPerPage: p.captionWordsPerPage ?? null, kenBurns: p.kenBurns ? 1 : 0, crossfade: p.crossfade ?? 0.8, emphasis: p.emphasis ? 1 : 0, keywords: p.keywords ? 1 : 0, punchZoom: p.punchZoom ? 1 : 0, motionPreset: p.motionPreset ?? null, betaOpts: JSON.stringify(p.betaOpts ?? DEFAULT_BETA_OPTS), lookAdjust: p.lookAdjust ? JSON.stringify(p.lookAdjust) : null }
}
function projectPatchToRow(patch: Partial<Project>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || k === 'id') continue
    if (k === 'betaOpts' || k === 'lookAdjust') out[k] = v == null ? null : JSON.stringify(v)
    else out[k] = PROJECT_BOOL_KEYS.has(k) ? (v ? 1 : 0) : v
  }
  return out
}
// --- DB row → typed domain object boundary -------------------------------------------
// SQLite is loosely typed (INTEGER 0/1 for booleans, TEXT for enums). These rowTo*
// mappers are the SINGLE place untyped rows become typed domain objects, so all coercion
// lives here instead of being trusted from the raw `{...row}` spread. New numeric/boolean
// columns should be coerced explicitly below rather than relying on the spread.
function coerceNum(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function rowToProject(r: Record<string, unknown>): Project {
  const rawLines = Number(r.captionLines ?? 1)
  const captionLines = rawLines === 2 || rawLines === 3 ? rawLines : 1
  const rawPace = r.captionPace as Project['captionPace']
  const captionPace = rawPace === 'word' || rawPace === 'phrase' ? rawPace : 'auto'
  const rawWordsPerPage = Number(r.captionWordsPerPage ?? 0)
  const captionWordsPerPage = rawWordsPerPage === 1 || rawWordsPerPage === 2 || rawWordsPerPage === 3 ? rawWordsPerPage as 1 | 2 | 3 : undefined
  const captionHighlightColor = typeof r.captionHighlightColor === 'string' && r.captionHighlightColor ? r.captionHighlightColor : undefined
  const captionBoxColor = typeof r.captionBoxColor === 'string' && r.captionBoxColor ? r.captionBoxColor : undefined
  const captionOffsetY = r.captionOffsetY == null ? undefined : Math.max(4, Math.min(96, coerceNum(r.captionOffsetY, 74)))
  return { ...(r as unknown as Project), captionLines, captionPosition: (r.captionPosition as Project['captionPosition']) ?? 'bottom', captionOffsetY, captionPace, captionHighlightColor, captionBoxColor, captionWordsPerPage, durationSec: coerceNum(r.durationSec, 0), poolSize: coerceNum(r.poolSize, 10), kenBurns: !!r.kenBurns, crossfade: coerceNum(r.crossfade, 0.8), emphasis: !!r.emphasis, keywords: !!r.keywords, punchZoom: !!r.punchZoom, lookStrength: r.lookStrength == null ? undefined : coerceNum(r.lookStrength, 0), lookAdjust: parseLookAdjust(r.lookAdjust), motionPreset: parseMotionPreset(r.motionPreset), betaOpts: parseBetaOpts(r) }
}
function rowToImage(r: Record<string, unknown>): ProjectImage {
  return {
    ...(r as unknown as ProjectImage),
    manual: !!r.manual,
    motionPreset: parseMotionPreset(r.motionPreset),
    motionDirection: parseMotionDirection(r.motionDirection),
    motionAmount: r.motionAmount == null ? undefined : Math.max(0, Math.min(100, coerceNum(r.motionAmount, 50)))
  }
}
function rowToWord(r: Record<string, unknown>): TranscriptWord {
  return { ...(r as unknown as TranscriptWord), emphasis: !!r.emphasis }
}

const PROFILE_COLS = [
  'id', 'name', 'mono', 'avatar', 'rule', 'images', 'thumb', 'cap', 'out', 'autoWatch', 'autoQueueRender', 'thumbnailTemplateId',
  'linkedSourceId', 'sourceUrl', 'sourceOrder', 'sourceCount', 'imageMode', 'poolSize', 'kenBurns',
  'captionPreset', 'captionFont', 'captionAnim', 'captionAspect', 'captionLines', 'captionPosition', 'captionPace',
  'captionHighlightColor', 'captionBoxColor', 'captionWordsPerPage',
  'outputFolder', 'lastSeenVideoId', 'lastRunAt', 'betaOpts'
]

function profileToRow(p: Profile): Record<string, unknown> {
  return {
    ...p,
    autoWatch: p.autoWatch ? 1 : 0,
    autoQueueRender: p.autoQueueRender ? 1 : 0,
    kenBurns: p.kenBurns ? 1 : 0,
    captionFont: p.captionFont ?? 'Montserrat',
    captionAnim: p.captionAnim ?? 'Pop-in',
    captionLines: p.captionLines ?? 1,
    captionPosition: p.captionPosition ?? 'bottom',
    captionPace: p.captionPace ?? 'auto',
    captionHighlightColor: p.captionHighlightColor ?? null,
    captionBoxColor: p.captionBoxColor ?? null,
    captionWordsPerPage: p.captionWordsPerPage ?? null,
    thumbnailTemplateId: p.thumbnailTemplateId ?? null,
    linkedSourceId: p.linkedSourceId ?? null,
    outputFolder: p.outputFolder ?? null,
    lastSeenVideoId: p.lastSeenVideoId ?? null,
    lastRunAt: p.lastRunAt ?? null,
    betaOpts: JSON.stringify(p.betaOpts ?? DEFAULT_BETA_OPTS)
  }
}

/** Map a profiles row → Profile, coercing bools and defaulting run config for legacy rows. */
function rowToProfile(r: Record<string, unknown>): Profile {
  const rawLines = Number(r.captionLines ?? 1)
  const captionLines = rawLines === 2 || rawLines === 3 ? rawLines : 1
  const rawPace = r.captionPace as Profile['captionPace']
  const captionPace = rawPace === 'word' || rawPace === 'phrase' ? rawPace : 'auto'
  const rawWordsPerPage = Number(r.captionWordsPerPage ?? 0)
  const captionWordsPerPage = rawWordsPerPage === 1 || rawWordsPerPage === 2 || rawWordsPerPage === 3 ? rawWordsPerPage as 1 | 2 | 3 : undefined
  return {
    ...(r as unknown as Profile),
    autoWatch: !!r.autoWatch,
    autoQueueRender: !!r.autoQueueRender,
    kenBurns: r.kenBurns == null ? true : !!r.kenBurns,
    sourceUrl: (r.sourceUrl as string) ?? '',
    sourceOrder: (r.sourceOrder as ScrapeOrder) ?? 'Latest',
    sourceCount: coerceNum(r.sourceCount, 5),
    imageMode: (r.imageMode as ImageMode) ?? 'sequence',
    poolSize: coerceNum(r.poolSize, 10),
    captionPreset: (r.captionPreset as string) ?? 'Hormozi',
    captionFont: (r.captionFont as string) ?? 'Montserrat',
    captionAnim: (r.captionAnim as string) ?? 'Pop-in',
    captionAspect: (r.captionAspect as Profile['captionAspect']) ?? '16:9',
    captionLines,
    captionPosition: (r.captionPosition as Profile['captionPosition']) ?? 'bottom',
    captionPace,
    captionHighlightColor: typeof r.captionHighlightColor === 'string' && r.captionHighlightColor ? r.captionHighlightColor : undefined,
    captionBoxColor: typeof r.captionBoxColor === 'string' && r.captionBoxColor ? r.captionBoxColor : undefined,
    captionWordsPerPage,
    betaOpts: parseBetaOpts(r)
  }
}
