import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SMOKE_PROFILE_SENTINEL,
  assertDisposableSmokeProfile,
  isDisposableSmokeProfile,
  markDisposableSmokeProfile,
  prepareSmokeUserDataDir
} from '../../electron/services/smokeSafety'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'me-smoke-safety-'))
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('markDisposableSmokeProfile / isDisposableSmokeProfile', () => {
  it('a fresh directory is not disposable until marked', () => {
    const dir = path.join(tmpRoot, 'fresh')
    fs.mkdirSync(dir)
    expect(isDisposableSmokeProfile(dir)).toBe(false)
  })

  it('marking writes the sentinel and makes the directory disposable', () => {
    const dir = path.join(tmpRoot, 'marked')
    fs.mkdirSync(dir)
    markDisposableSmokeProfile(dir)
    expect(isDisposableSmokeProfile(dir)).toBe(true)
    const sentinelPath = path.join(dir, SMOKE_PROFILE_SENTINEL)
    expect(fs.existsSync(sentinelPath)).toBe(true)
    const contents = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'))
    expect(contents.disposable).toBe(true)
    expect(typeof contents.createdAt).toBe('string')
  })
})

describe('prepareSmokeUserDataDir', () => {
  it('refuses (via fail) when no override dir is given', () => {
    const defaultDir = path.join(tmpRoot, 'real-userdata')
    let failMessage = ''
    const result = prepareSmokeUserDataDir(undefined, defaultDir, (msg) => { failMessage = msg })
    expect(result).toBeNull()
    expect(failMessage).toContain('FATAL')
    expect(failMessage).toContain('ME_SMOKE_USERDATA_DIR')
  })

  it('refuses (via fail) when the override resolves to the same path as the real default', () => {
    const defaultDir = path.join(tmpRoot, 'real-userdata')
    let failed = false
    const result = prepareSmokeUserDataDir(defaultDir, defaultDir, () => { failed = true })
    expect(result).toBeNull()
    expect(failed).toBe(true)
    // Creating an empty directory that happens to be the real path is harmless (mkdirSync
    // recursive is a no-op if it exists, and doesn't write anything into it) — what must
    // never happen is the disposable-profile sentinel landing in the real directory.
    expect(isDisposableSmokeProfile(defaultDir)).toBe(false)
  })

  it('refuses when the override resolves to the same path via different formatting (e.g. trailing slash)', () => {
    const defaultDir = path.join(tmpRoot, 'real-userdata')
    let failed = false
    const result = prepareSmokeUserDataDir(defaultDir + path.sep, defaultDir, () => { failed = true })
    expect(result).toBeNull()
    expect(failed).toBe(true)
    expect(isDisposableSmokeProfile(defaultDir)).toBe(false)
  })

  it('refuses when the override is the same real directory but with different casing (Windows NTFS case-insensitivity)', () => {
    const defaultDir = path.join(tmpRoot, 'Real-UserData')
    fs.mkdirSync(defaultDir, { recursive: true })
    const differentlyCasedOverride = path.join(tmpRoot, 'real-userdata')
    let failMessage = ''
    const result = prepareSmokeUserDataDir(differentlyCasedOverride, defaultDir, (msg) => { failMessage = msg })
    if (process.platform === 'win32') {
      expect(result).toBeNull()
      expect(failMessage).toContain('FATAL')
      expect(isDisposableSmokeProfile(defaultDir)).toBe(false)
    } else {
      // On a case-sensitive filesystem these genuinely are two different directories —
      // just confirm it doesn't crash and behaves like any other distinct-dir case.
      expect(result).not.toBeNull()
    }
  })

  it('refuses when the override is a symlink/junction pointing at the real default directory', () => {
    const defaultDir = path.join(tmpRoot, 'real-userdata-symlink-target')
    fs.mkdirSync(defaultDir, { recursive: true })
    const linkPath = path.join(tmpRoot, 'me-smoke-alias')
    try {
      fs.symlinkSync(defaultDir, linkPath, 'junction')
    } catch {
      // Symlink/junction creation can be restricted in some sandboxes — skip rather than
      // fail the suite on an environment limitation unrelated to the guard's own logic.
      return
    }
    let failMessage = ''
    const result = prepareSmokeUserDataDir(linkPath, defaultDir, (msg) => { failMessage = msg })
    expect(result).toBeNull()
    expect(failMessage).toContain('FATAL')
    expect(isDisposableSmokeProfile(defaultDir)).toBe(false)
  })

  it('accepts a genuinely different override dir: creates it and marks it disposable', () => {
    const defaultDir = path.join(tmpRoot, 'real-userdata')
    const overrideDir = path.join(tmpRoot, 'me-smoke-tmp')
    let failed = false
    const result = prepareSmokeUserDataDir(overrideDir, defaultDir, () => { failed = true })
    expect(failed).toBe(false)
    expect(result).toBe(path.resolve(overrideDir))
    expect(fs.existsSync(overrideDir)).toBe(true)
    expect(isDisposableSmokeProfile(overrideDir)).toBe(true)
    // The real default path must never have been touched.
    expect(fs.existsSync(defaultDir)).toBe(false)
  })
})

describe('assertDisposableSmokeProfile', () => {
  it('refuses (via fail) a directory with no sentinel — e.g. the real userData path', () => {
    const dir = path.join(tmpRoot, 'unmarked-real-looking-dir')
    fs.mkdirSync(dir)
    let failMessage = ''
    assertDisposableSmokeProfile(dir, (msg) => { failMessage = msg })
    expect(failMessage).toContain('FATAL')
    expect(failMessage).toContain(SMOKE_PROFILE_SENTINEL)
    expect(failMessage).toContain('not marked disposable')
  })

  it('refuses a directory that does not exist at all', () => {
    const dir = path.join(tmpRoot, 'does-not-exist')
    let failed = false
    assertDisposableSmokeProfile(dir, () => { failed = true })
    expect(failed).toBe(true)
  })

  it('passes silently once the directory has been marked disposable', () => {
    const dir = path.join(tmpRoot, 'disposable')
    fs.mkdirSync(dir)
    markDisposableSmokeProfile(dir)
    let failed = false
    assertDisposableSmokeProfile(dir, () => { failed = true })
    expect(failed).toBe(false)
  })

  it('end-to-end: prepareSmokeUserDataDir\'s output always satisfies assertDisposableSmokeProfile', () => {
    const defaultDir = path.join(tmpRoot, 'real-userdata')
    const overrideDir = path.join(tmpRoot, 'me-smoke-tmp-e2e')
    const prepared = prepareSmokeUserDataDir(overrideDir, defaultDir)
    expect(prepared).toBe(path.resolve(overrideDir))
    let failed = false
    assertDisposableSmokeProfile(prepared as string, () => { failed = true })
    expect(failed).toBe(false)
  })

  it('a sibling directory that merely looks similar (no sentinel copied over) is still refused', () => {
    const defaultDir = path.join(tmpRoot, 'real-userdata')
    const overrideDir = path.join(tmpRoot, 'me-smoke-tmp-sibling')
    prepareSmokeUserDataDir(overrideDir, defaultDir)
    const lookalike = path.join(tmpRoot, 'me-smoke-tmp-sibling-2')
    fs.mkdirSync(lookalike)
    let failed = false
    assertDisposableSmokeProfile(lookalike, () => { failed = true })
    expect(failed).toBe(true)
  })
})
