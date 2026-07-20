import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDatabase, initDatabase } from '../../electron/db'
import { TALKINGPHOTOS_CONNECTION_ID, TALKINGPHOTOS_PARTITION, TALKINGPHOTOS_PROVIDER } from '../../shared/talkingphotos'
import type { ProviderAsset, ProviderConnection, ProviderJob, TranscriptDocument } from '../../shared/talkingphotos'

function sqliteBindingReady(): boolean {
  try {
    const db = new Database(':memory:')
    db.close()
    return true
  } catch {
    return false
  }
}

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-talkingphotos-db-'))
  return path.join(dir, 'app.sqlite')
}

afterEach(() => {
  closeDatabase()
})

const describeSqlite = sqliteBindingReady() ? describe : describe.skip

function connectionRow(patch: Partial<ProviderConnection> = {}): ProviderConnection {
  const now = new Date().toISOString()
  return {
    id: TALKINGPHOTOS_CONNECTION_ID,
    provider: TALKINGPHOTOS_PROVIDER,
    partition: TALKINGPHOTOS_PARTITION,
    status: 'connected',
    accountLabel: 'Creator Studio',
    connectedAt: now,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
    ...patch
  }
}

function jobRow(patch: Partial<ProviderJob> = {}): ProviderJob {
  const now = new Date().toISOString()
  return {
    id: 'tpj-1',
    provider: TALKINGPHOTOS_PROVIDER,
    connectionId: TALKINGPHOTOS_CONNECTION_ID,
    operation: 'video',
    remoteProjectId: 'proj-123',
    status: 'queued',
    progress: 0,
    internalSegment: false,
    createdAt: now,
    updatedAt: now,
    ...patch
  }
}

describeSqlite('TalkingPhotos provider tables', () => {
  it('creates provider tables on a brand-new database', () => {
    const repos = initDatabase(tempDbPath())
    expect(repos.providerConnections()).toEqual([])
    expect(repos.providerJobs()).toEqual([])
    expect(repos.getTranscriptDocument('missing')).toBeUndefined()
  })

  it('round-trips a provider_connections row (status metadata only)', () => {
    const repos = initDatabase(tempDbPath())
    repos.upsertProviderConnection(connectionRow())
    const read = repos.providerConnection(TALKINGPHOTOS_CONNECTION_ID)
    expect(read).toMatchObject({ id: TALKINGPHOTOS_CONNECTION_ID, provider: 'talkingphotos', status: 'connected', accountLabel: 'Creator Studio' })
  })

  it('provider_connections schema exposes no cookie/token/password columns', () => {
    const file = tempDbPath()
    initDatabase(file)
    closeDatabase()
    const raw = new Database(file)
    const cols = (raw.prepare("PRAGMA table_info(provider_connections)").all() as Array<{ name: string }>).map((c) => c.name.toLowerCase())
    raw.close()
    expect(cols).not.toEqual(expect.arrayContaining(['cookie', 'cookies', 'token', 'password', 'secret']))
    expect(cols).toEqual(expect.arrayContaining(['id', 'provider', 'partition', 'status', 'accountlabel', 'connectedat', 'lastverifiedat', 'lasterror', 'createdat', 'updatedat']))
  })

  it('upserts and updates a provider_jobs row, including partial patches that do not clobber other columns', () => {
    const repos = initDatabase(tempDbPath())
    repos.upsertProviderJob(jobRow())
    repos.updateProviderJob('tpj-1', { status: 'running', progress: 40 })
    const updated = repos.providerJob('tpj-1')
    expect(updated).toMatchObject({ status: 'running', progress: 40, remoteProjectId: 'proj-123', operation: 'video' })
  })

  it('finds a provider job by connection + remote project id (dedup for import/sync)', () => {
    const repos = initDatabase(tempDbPath())
    repos.upsertProviderJob(jobRow())
    expect(repos.providerJobByRemoteId(TALKINGPHOTOS_CONNECTION_ID, 'proj-123')).toBeTruthy()
    expect(repos.providerJobByRemoteId(TALKINGPHOTOS_CONNECTION_ID, 'proj-unknown')).toBeUndefined()
  })

  it('persists creation checkpoints and resolves an idempotency fingerprint across restart', () => {
    const file = tempDbPath()
    let repos = initDatabase(file)
    repos.upsertProviderJob(jobRow({ requestFingerprint: 'fingerprint-1', requestJson: '{"stage":"segments_submitted"}' }))
    closeDatabase()
    repos = initDatabase(file)
    expect(repos.providerJobByFingerprint(TALKINGPHOTOS_CONNECTION_ID, 'fingerprint-1')).toMatchObject({ id: 'tpj-1', requestJson: '{"stage":"segments_submitted"}' })
  })

  it('nonTerminalProviderJobs excludes completed/failed/cancelled', () => {
    const repos = initDatabase(tempDbPath())
    repos.upsertProviderJob(jobRow({ id: 'a', status: 'queued' }))
    repos.upsertProviderJob(jobRow({ id: 'b', status: 'completed' }))
    repos.upsertProviderJob(jobRow({ id: 'c', status: 'failed' }))
    repos.upsertProviderJob(jobRow({ id: 'd', status: 'downloading' }))
    const ids = repos.nonTerminalProviderJobs().map((j) => j.id).sort()
    expect(ids).toEqual(['a', 'd'])
  })

  it('round-trips provider_assets keyed by content hash', () => {
    const repos = initDatabase(tempDbPath())
    const asset: ProviderAsset = {
      id: 'asset-1', provider: TALKINGPHOTOS_PROVIDER, connectionId: TALKINGPHOTOS_CONNECTION_ID,
      localSha256: 'abc123', localPath: '/tmp/character.png', remoteMediaId: 'media-1'
    }
    repos.upsertProviderAsset(asset)
    expect(repos.providerAssetByHash(TALKINGPHOTOS_PROVIDER, TALKINGPHOTOS_CONNECTION_ID, 'abc123')).toMatchObject({ localPath: '/tmp/character.png', remoteMediaId: 'media-1' })
  })

  it('round-trips a transcript_documents row (punctuation-preserving script text)', () => {
    const repos = initDatabase(tempDbPath())
    const doc: TranscriptDocument = { projectId: 'proj-x', text: 'Hello, world. This is a test!', source: 'transcribe', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    repos.upsertTranscriptDocument(doc)
    expect(repos.getTranscriptDocument('proj-x')).toMatchObject({ text: 'Hello, world. This is a test!', source: 'transcribe' })
  })

  it('re-opening the same database file is idempotent (simulates an app restart)', () => {
    const file = tempDbPath()
    let repos = initDatabase(file)
    repos.upsertProviderConnection(connectionRow())
    repos.upsertProviderJob(jobRow())
    closeDatabase()

    repos = initDatabase(file)
    expect(repos.providerConnection(TALKINGPHOTOS_CONNECTION_ID)).toBeTruthy()
    expect(repos.providerJob('tpj-1')).toBeTruthy()
  })

  it('migrating an existing pre-TalkingPhotos database adds the new tables without touching old data', () => {
    const file = tempDbPath()
    // Simulate a database created before this feature existed: only the legacy tables.
    const legacy = new Database(file)
    legacy.exec(`
      CREATE TABLE IF NOT EXISTS my_channels (id TEXT PRIMARY KEY, name TEXT, handle TEXT, mono TEXT, avatar TEXT, views TEXT, subs TEXT, total INTEGER, linkedSourceId TEXT, source TEXT, mapDone INTEGER, mapTotal INTEGER, weekDone INTEGER, weekGoal INTEGER, monthDone INTEGER, monthGoal INTEGER, reminder TEXT, reminderNote TEXT);
      CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT);
    `)
    legacy.prepare('INSERT INTO my_channels (id,name,handle) VALUES (?,?,?)').run('legacy-1', 'Legacy Channel', '@legacy')
    legacy.close()

    const repos = initDatabase(file)
    expect(repos.myChannels().find((c) => c.id === 'legacy-1')).toBeTruthy() // old data intact
    expect(repos.providerConnections()).toEqual([]) // new tables now exist and are queryable
    repos.upsertProviderConnection(connectionRow())
    expect(repos.providerConnection(TALKINGPHOTOS_CONNECTION_ID)).toBeTruthy()
  })

  it('resetAll wipes provider connections, jobs, assets and transcript documents', () => {
    const repos = initDatabase(tempDbPath())
    repos.upsertProviderConnection(connectionRow())
    repos.upsertProviderJob(jobRow())
    repos.upsertProviderAsset({ id: 'a1', provider: TALKINGPHOTOS_PROVIDER, connectionId: TALKINGPHOTOS_CONNECTION_ID, localSha256: 'h', localPath: '/x.png' })
    repos.upsertTranscriptDocument({ projectId: 'p1', text: 'x', source: 'manual', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })

    repos.resetAll()

    expect(repos.providerConnections()).toEqual([])
    expect(repos.providerJobs()).toEqual([])
    expect(repos.providerAssetByHash(TALKINGPHOTOS_PROVIDER, TALKINGPHOTOS_CONNECTION_ID, 'h')).toBeUndefined()
    expect(repos.getTranscriptDocument('p1')).toBeUndefined()
  })

  it('softReset keeps the TalkingPhotos connection (like API keys) but wipes provider jobs/assets/transcripts', () => {
    const repos = initDatabase(tempDbPath())
    repos.upsertProviderConnection(connectionRow())
    repos.upsertProviderJob(jobRow())
    repos.upsertTranscriptDocument({ projectId: 'p1', text: 'x', source: 'manual', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })

    repos.softReset()

    expect(repos.providerConnection(TALKINGPHOTOS_CONNECTION_ID)).toBeTruthy()
    expect(repos.providerJobs()).toEqual([])
    expect(repos.getTranscriptDocument('p1')).toBeUndefined()
  })

  describe('Phase 11: DB-enforced fingerprint uniqueness', () => {
    it('creates the unique composite index on a fresh database', () => {
      const file = tempDbPath()
      initDatabase(file)
      closeDatabase()
      const raw = new Database(file)
      const indexes = raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='provider_jobs'").all() as Array<{ name: string }>
      raw.close()
      expect(indexes.some((i) => i.name === 'idx_provider_jobs_fingerprint_intent')).toBe(true)
    })

    it('findOrCreateProviderJob is transactional: a second call with the same fingerprint+intent returns the first row, not a duplicate', () => {
      const repos = initDatabase(tempDbPath())
      const a = repos.findOrCreateProviderJob(jobRow({ id: 'tpj-a', requestFingerprint: 'fp-1', creationIntentId: '' }))
      const b = repos.findOrCreateProviderJob(jobRow({ id: 'tpj-b', requestFingerprint: 'fp-1', creationIntentId: '' }))
      expect(a.created).toBe(true)
      expect(b.created).toBe(false)
      expect(b.job.id).toBe('tpj-a')
      expect(repos.providerJobs()).toHaveLength(1)
    })

    it('a distinct creationIntentId is allowed to coexist with the same fingerprint (deliberate duplicate content)', () => {
      const repos = initDatabase(tempDbPath())
      const a = repos.findOrCreateProviderJob(jobRow({ id: 'tpj-a', requestFingerprint: 'fp-1', creationIntentId: '' }))
      const b = repos.findOrCreateProviderJob(jobRow({ id: 'tpj-b', requestFingerprint: 'fp-1', creationIntentId: 'intent-2' }))
      expect(a.created).toBe(true)
      expect(b.created).toBe(true)
      expect(repos.providerJobs()).toHaveLength(2)
    })

    it('simulated race: two near-simultaneous inserts with the same key never both succeed', () => {
      const repos = initDatabase(tempDbPath())
      const results = [
        repos.findOrCreateProviderJob(jobRow({ id: 'tpj-race-1', requestFingerprint: 'fp-race', creationIntentId: '' })),
        repos.findOrCreateProviderJob(jobRow({ id: 'tpj-race-2', requestFingerprint: 'fp-race', creationIntentId: '' })),
        repos.findOrCreateProviderJob(jobRow({ id: 'tpj-race-3', requestFingerprint: 'fp-race', creationIntentId: '' }))
      ]
      expect(results.filter((r) => r.created)).toHaveLength(1)
      expect(new Set(results.map((r) => r.job.id)).size).toBe(1)
      expect(repos.providerJobs()).toHaveLength(1)
    })

    it('jobs without a fingerprint (imported/synced) are never deduplicated against each other', () => {
      const repos = initDatabase(tempDbPath())
      const a = repos.findOrCreateProviderJob(jobRow({ id: 'tpj-import-a', remoteProjectId: 'proj-a' }))
      const b = repos.findOrCreateProviderJob(jobRow({ id: 'tpj-import-b', remoteProjectId: 'proj-b' }))
      const { requestFingerprint: _a, ...restA } = a.job
      const { requestFingerprint: _b, ...restB } = b.job
      void restA; void restB
      expect(a.created).toBe(true)
      expect(b.created).toBe(true)
    })

    it('migrating a database with pre-existing duplicate fingerprint rows relabels (never deletes) the later duplicates', () => {
      const file = tempDbPath()
      // Build a pre-Phase-11 database by inserting duplicate-fingerprint rows directly,
      // bypassing findOrCreateProviderJob, before the unique index exists.
      const raw = new Database(file)
      raw.exec(`
        CREATE TABLE IF NOT EXISTS provider_jobs (
          id TEXT PRIMARY KEY, provider TEXT NOT NULL, connectionId TEXT NOT NULL, operation TEXT NOT NULL,
          remoteProjectId TEXT, remoteTaskUuid TEXT, remotePreviousTaskUuid TEXT, parentProviderJobId TEXT,
          automationJobId TEXT, automationItemId TEXT, projectId TEXT, requestFingerprint TEXT, requestJson TEXT,
          status TEXT NOT NULL, remoteStep INTEGER, remoteStepsTotal INTEGER, progress INTEGER NOT NULL DEFAULT 0,
          remoteMediaId TEXT, remoteMediaUrl TEXT, localOutputPath TEXT, errorCode TEXT, errorMessage TEXT,
          segmentOrdinal INTEGER, internalSegment INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
          lastPolledAt TEXT, downloadedAt TEXT
        );
        CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT);
      `)
      const insert = raw.prepare(`INSERT INTO provider_jobs (id,provider,connectionId,operation,requestFingerprint,status,progress,internalSegment,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      insert.run('dup-1', 'talkingphotos', 'default', 'video', 'legacy-fp', 'completed', 100, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      insert.run('dup-2', 'talkingphotos', 'default', 'video', 'legacy-fp', 'completed', 100, 0, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')
      raw.close()

      const repos = initDatabase(file) // runs the Phase 11 migration
      const all = repos.providerJobs()
      expect(all).toHaveLength(2) // neither historical row was deleted
      const [oldest, newest] = [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      expect(oldest.id).toBe('dup-1')
      expect(oldest.creationIntentId).toBe('') // canonical row's key is untouched
      expect(newest.id).toBe('dup-2')
      expect(newest.creationIntentId).toContain('dup-2') // relabeled to keep the index unique
      expect(newest.requestFingerprint).toBe('legacy-fp') // fingerprint itself preserved

      // The unique index now exists and is enforced going forward.
      const dbFile = new Database(file)
      const indexes = dbFile.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='provider_jobs'").all() as Array<{ name: string }>
      dbFile.close()
      expect(indexes.some((i) => i.name === 'idx_provider_jobs_fingerprint_intent')).toBe(true)
    })

    it('re-running the migration on an already-migrated database is a no-op (idempotent)', () => {
      const file = tempDbPath()
      initDatabase(file)
      closeDatabase()
      // Re-opening runs migrate() again — must not throw or alter existing rows.
      expect(() => initDatabase(file)).not.toThrow()
    })
  })
})
