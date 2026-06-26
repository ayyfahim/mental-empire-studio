import Database from 'better-sqlite3'
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
  TranscriptWord,
  RecentUpload,
  RenderJob,
  RenderStatus,
  ScrapeOrder,
  ImageMode
} from '../../shared/types'
import { asBetaOpts, DEFAULT_BETA_OPTS } from '../../shared/types'
import { seedIfEmpty, seedDemoData } from './seed'

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
  captionPreset TEXT, captionFont TEXT, captionAnim TEXT, captionAspect TEXT,
  emphasis INTEGER, keywords INTEGER, punchZoom INTEGER,
  stage TEXT, createdAt TEXT
);
CREATE TABLE IF NOT EXISTS project_images (
  id TEXT PRIMARY KEY, projectId TEXT, ord INTEGER, path TEXT, thumb TEXT,
  rangeStart REAL, rangeEnd REAL, manual INTEGER
);
CREATE TABLE IF NOT EXISTS transcript_words (
  id TEXT PRIMARY KEY, projectId TEXT, ord INTEGER, word TEXT,
  start REAL, end REAL, emphasis INTEGER
);
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY, value TEXT
);
`

// Every table that holds user/domain data — wiped by resetAll(). app_meta is
// intentionally excluded so the "don't re-seed" flag survives the reset.
const DATA_TABLES = [
  'my_channels', 'source_channels', 'source_videos', 'downloaded_videos', 'uploads',
  'profiles', 'thumbnail_templates', 'render_jobs', 'activity_log',
  'projects', 'project_images', 'transcript_words'
]

/** Add a column only if it isn't already present — idempotent forward migration. */
function ensureColumn(d: Database.Database, table: string, col: string, type: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
}

function migrate(d: Database.Database): void {
  ensureColumn(d, 'my_channels', 'lastScrapedAt', 'TEXT')
  ensureColumn(d, 'source_channels', 'lastScrapedAt', 'TEXT')
  ensureColumn(d, 'downloaded_videos', 'matchedUploadId', 'TEXT')
  // M4: real download bookkeeping
  ensureColumn(d, 'downloaded_videos', 'filePath', 'TEXT')
  ensureColumn(d, 'downloaded_videos', 'durationSec', 'INTEGER')
  ensureColumn(d, 'render_jobs', 'projectId', 'TEXT')
  // M5: template locked to a profile
  ensureColumn(d, 'profiles', 'thumbnailTemplateId', 'TEXT')
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
  ensureColumn(d, 'profiles', 'captionAspect', 'TEXT')
  ensureColumn(d, 'profiles', 'outputFolder', 'TEXT')
  ensureColumn(d, 'profiles', 'lastSeenVideoId', 'TEXT')
  ensureColumn(d, 'profiles', 'lastRunAt', 'TEXT')
  // Beta features — one JSON column each, so future fields need no migration.
  ensureColumn(d, 'projects', 'betaOpts', 'TEXT')
  ensureColumn(d, 'profiles', 'betaOpts', 'TEXT')
  ensureColumn(d, 'uploads', 'thumb', 'TEXT')

  purgeLegacyDemoSeed(d)
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
  sourceChannelByUrl(url: string): SourceChannel | undefined
  upsertSourceChannel(s: SourceChannel): void
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
  markDownloadMatches(matches: Array<{ downloadId: string; uploadId: string }>): void
  updateChannelGoals(id: string, patch: GoalsPatch): void
  // ---- M4 download + compose writes ----
  download(id: string): DownloadedVideo | undefined
  upsertDownload(d: DownloadedVideo): void
  setDownloadProgress(id: string, patch: { pct?: string; stage?: string; filePath?: string; durationSec?: number; action?: 'Resume' | 'Open' }): void
  createProject(p: Project): void
  getProject(id: string): Project | undefined
  listProjects(): Project[]
  updateProject(id: string, patch: Partial<Project>): Project | undefined
  replaceProjectImages(projectId: string, rows: ProjectImage[]): void
  getProjectImages(projectId: string): ProjectImage[]
  setImageRanges(projectId: string, ranges: Array<{ id: string; rangeStart: number; rangeEnd: number }>): void
  replaceTranscript(projectId: string, rows: TranscriptWord[]): void
  getTranscript(projectId: string): TranscriptWord[]
  updateWord(wordId: string, text: string): void
  toggleEmphasis(wordId: string): void
  createRenderJob(job: { id: string; title: string; channel: string; projectId: string }): void
  renderJobs(): RenderJob[]
  renderJob(id: string): RenderJob | undefined
  queuedJobs(): RenderJob[]
  setRenderStatus(id: string, patch: { status?: RenderStatus; pct?: number; outputPath?: string; error?: string }): void
  /** Wipe every domain table (channels, profiles, projects, jobs, …) back to empty,
   *  and mark the DB seeded so demo content is not re-inserted on next launch. */
  resetAll(): void
}

let db: Database.Database | null = null
let repos: Repositories | null = null

export function initDatabase(filePath: string): Repositories {
  db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  migrate(db)
  seedIfEmpty(db)
  repos = buildRepositories(db)
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

export function closeDatabase(): void {
  db?.close()
  db = null
  repos = null
}

function buildRepositories(d: Database.Database): Repositories {
  const allTemplates = (): ThumbnailTemplate[] =>
    (d.prepare('SELECT * FROM thumbnail_templates').all() as Array<{ id: string; name: string; layers: string }>).map(
      (r) => ({ id: r.id, name: r.name, layers: JSON.parse(r.layers) })
    )
  const allProfiles = (): Profile[] =>
    (d.prepare('SELECT * FROM profiles').all() as Array<Record<string, unknown>>).map(rowToProfile)

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

    sourceChannels: () => d.prepare('SELECT id,url,handle,name FROM source_channels').all() as SourceChannel[],
    sourceChannelByUrl: (url) =>
      d.prepare('SELECT id,url,handle,name FROM source_channels WHERE url=?').get(url) as SourceChannel | undefined,
    upsertSourceChannel: (s) => {
      d.prepare(
        `INSERT INTO source_channels (id,url,handle,name) VALUES (@id,@url,@handle,@name)
         ON CONFLICT(id) DO UPDATE SET url=@url, handle=@handle, name=@name`
      ).run(s)
    },

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
          `INSERT OR REPLACE INTO source_videos (id,sourceId,title,durationSec,views,uploadDate,thumb,scrapedAt)
           VALUES (@id,@sourceId,@title,@durationSec,@views,@uploadDate,@thumb,@scrapedAt)`
        )
        rows.forEach((r) => ins.run({ ...r, sourceId, scrapedAt: now }))
      })
      tx()
    },
    getSourceVideos: (sourceId) =>
      d.prepare('SELECT id,title,durationSec,views,uploadDate,thumb FROM source_videos WHERE sourceId=?').all(sourceId) as ScrapedVideo[],

    setChannelStats: (id, patch) => {
      d.prepare('UPDATE my_channels SET views=@views, subs=@subs, total=@total, lastScrapedAt=@lastScrapedAt WHERE id=@id').run({ id, ...patch })
    },
    setChannelMapping: (id, mapDone, mapTotal) => {
      d.prepare('UPDATE my_channels SET mapDone=?, mapTotal=? WHERE id=?').run(mapDone, mapTotal, id)
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

    // ---- M4 download + compose writes ----
    download: (id) => d.prepare('SELECT * FROM downloaded_videos WHERE id=?').get(id) as DownloadedVideo | undefined,
    upsertDownload: (dl) => {
      d.prepare(
        `INSERT INTO downloaded_videos (id,sourceId,title,channel,size,"when",stage,pct,action,thumb,matchedUploadId,filePath,durationSec)
         VALUES (@id,@sourceId,@title,@channel,@size,@when,@stage,@pct,@action,@thumb,@matchedUploadId,@filePath,@durationSec)
         ON CONFLICT(id) DO UPDATE SET sourceId=@sourceId, title=@title, channel=@channel, size=@size,
           "when"=@when, stage=@stage, pct=@pct, action=@action, thumb=@thumb, filePath=@filePath, durationSec=@durationSec`
      ).run({ matchedUploadId: null, filePath: null, durationSec: null, ...dl })
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
        `INSERT INTO projects (id,downloadId,title,channel,mp3Path,durationSec,imageMode,poolSize,kenBurns,seed,crossfade,captionPreset,captionFont,captionAnim,captionAspect,emphasis,keywords,punchZoom,stage,createdAt,betaOpts)
         VALUES (@id,@downloadId,@title,@channel,@mp3Path,@durationSec,@imageMode,@poolSize,@kenBurns,@seed,@crossfade,@captionPreset,@captionFont,@captionAnim,@captionAspect,@emphasis,@keywords,@punchZoom,@stage,@createdAt,@betaOpts)`
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
          'INSERT INTO project_images (id,projectId,ord,path,thumb,rangeStart,rangeEnd,manual) VALUES (@id,@projectId,@ord,@path,@thumb,@rangeStart,@rangeEnd,@manual)'
        )
        rows.forEach((r) => ins.run({ ...r, manual: r.manual ? 1 : 0 }))
      })
      tx()
    },
    getProjectImages: (projectId) =>
      (d.prepare('SELECT * FROM project_images WHERE projectId=? ORDER BY ord').all(projectId) as Array<Record<string, unknown>>).map(rowToImage),
    setImageRanges: (projectId, ranges) => {
      const tx = d.transaction(() => {
        const up = d.prepare('UPDATE project_images SET rangeStart=@rangeStart, rangeEnd=@rangeEnd, manual=1 WHERE id=@id AND projectId=@projectId')
        ranges.forEach((r) => up.run({ ...r, projectId }))
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

    resetAll: () => {
      const tx = d.transaction(() => {
        for (const t of DATA_TABLES) d.prepare(`DELETE FROM ${t}`).run()
        // Keep the DB empty: record that seeding has already happened so the next
        // launch's seedIfEmpty() does not re-insert the demo channels/profiles.
        d.prepare("INSERT OR REPLACE INTO app_meta (key,value) VALUES ('seeded','1')").run()
      })
      tx()
    }
  }
}

const PROJECT_BOOL_KEYS = new Set(['kenBurns', 'crossfade', 'emphasis', 'keywords', 'punchZoom'])

function projectToRow(p: Project): Record<string, unknown> {
  return { ...p, kenBurns: p.kenBurns ? 1 : 0, crossfade: p.crossfade ? 1 : 0, emphasis: p.emphasis ? 1 : 0, keywords: p.keywords ? 1 : 0, punchZoom: p.punchZoom ? 1 : 0, betaOpts: JSON.stringify(p.betaOpts ?? DEFAULT_BETA_OPTS) }
}
function projectPatchToRow(patch: Partial<Project>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || k === 'id') continue
    if (k === 'betaOpts') out[k] = JSON.stringify(v)
    else out[k] = PROJECT_BOOL_KEYS.has(k) ? (v ? 1 : 0) : v
  }
  return out
}
function rowToProject(r: Record<string, unknown>): Project {
  return { ...(r as unknown as Project), kenBurns: !!r.kenBurns, crossfade: !!r.crossfade, emphasis: !!r.emphasis, keywords: !!r.keywords, punchZoom: !!r.punchZoom, betaOpts: parseBetaOpts(r) }
}
function rowToImage(r: Record<string, unknown>): ProjectImage {
  return { ...(r as unknown as ProjectImage), manual: !!r.manual }
}
function rowToWord(r: Record<string, unknown>): TranscriptWord {
  return { ...(r as unknown as TranscriptWord), emphasis: !!r.emphasis }
}

const PROFILE_COLS = [
  'id', 'name', 'mono', 'avatar', 'rule', 'images', 'thumb', 'cap', 'out', 'autoWatch', 'thumbnailTemplateId',
  'linkedSourceId', 'sourceUrl', 'sourceOrder', 'sourceCount', 'imageMode', 'poolSize', 'kenBurns',
  'captionPreset', 'captionAspect', 'outputFolder', 'lastSeenVideoId', 'lastRunAt', 'betaOpts'
]

function profileToRow(p: Profile): Record<string, unknown> {
  return {
    ...p,
    autoWatch: p.autoWatch ? 1 : 0,
    kenBurns: p.kenBurns ? 1 : 0,
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
  return {
    ...(r as unknown as Profile),
    autoWatch: !!r.autoWatch,
    kenBurns: r.kenBurns == null ? true : !!r.kenBurns,
    sourceUrl: (r.sourceUrl as string) ?? '',
    sourceOrder: (r.sourceOrder as ScrapeOrder) ?? 'Latest',
    sourceCount: (r.sourceCount as number) ?? 5,
    imageMode: (r.imageMode as ImageMode) ?? 'sequence',
    poolSize: (r.poolSize as number) ?? 10,
    captionPreset: (r.captionPreset as string) ?? 'Hormozi',
    captionAspect: (r.captionAspect as Profile['captionAspect']) ?? '16:9',
    betaOpts: parseBetaOpts(r)
  }
}
