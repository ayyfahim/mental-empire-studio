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
})
