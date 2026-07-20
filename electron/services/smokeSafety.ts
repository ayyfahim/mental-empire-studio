import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Several ME_SMOKE/ME_SHOOT harnesses call repos.resetAll() + seedDemoForSmoke(), which
// wipes and reseeds whatever DB they're pointed at — fine on a disposable CI runner, but
// destructive against a real local install. This module is the single, independently
// testable choke point for that safety: one function validates and marks an isolated
// userData override dir as disposable at startup, and a second function re-verifies
// that marker immediately before any destructive smoke setup, so a future refactor of
// the startup guard can't silently reopen the hole.

export const SMOKE_PROFILE_SENTINEL = '.mental-empire-smoke-profile'

/** Default failure action: log and hard-exit. Callers (tests) can inject a non-exiting
 *  `fail` to observe both branches without killing the test process. */
function defaultFail(message: string): void {
  console.error(message)
  process.exit(1)
}

export function markDisposableSmokeProfile(dir: string): void {
  writeFileSync(
    join(dir, SMOKE_PROFILE_SENTINEL),
    JSON.stringify({ disposable: true, createdAt: new Date().toISOString(), pid: process.pid }),
    'utf8'
  )
}

export function isDisposableSmokeProfile(dir: string): boolean {
  return existsSync(join(dir, SMOKE_PROFILE_SENTINEL))
}

/** Resolves a path to a form safe to compare for "is this the same real directory":
 *  follows symlinks/junctions via realpath when the path already exists (falling back
 *  to a plain resolve() for a path that doesn't exist yet — there's nothing to alias),
 *  then lowercases on win32, where NTFS paths are case-insensitive but `path.resolve()`
 *  does NOT canonicalize case (`C:\Foo` and `c:\foo` resolve to two different strings
 *  even though they name the same directory). Without this, a differently-cased or
 *  symlinked ME_SMOKE_USERDATA_DIR could alias the real userData directory and slip
 *  straight past the equality check below. */
function canonicalForComparison(dir: string): string {
  let real: string
  try {
    real = realpathSync.native(dir)
  } catch {
    real = resolve(dir)
  }
  return process.platform === 'win32' ? real.toLowerCase() : real
}

/** Validates an isolated userData override dir for a smoke/screenshot run: must be
 *  provided and must resolve to somewhere other than the real default userData path
 *  — compared case-insensitively and symlink/junction-aware on Windows, not just as
 *  raw resolved strings. On success, creates the dir, writes the disposable-profile
 *  sentinel into it, and returns the resolved path. On failure, calls `fail` (hard
 *  process.exit(1) by default) and returns null.
 *
 *  The override directory is created (mkdirSync, recursive — a no-op if it already
 *  exists, never touching existing content) BEFORE the canonical comparison, so that
 *  if it turns out to already exist as a symlink/junction aliasing the real userData
 *  path, realpath resolution actually has something on disk to follow. Creating an
 *  empty directory (or no-opping against an existing one) is itself harmless even in
 *  the case that turns out to be a match — only markDisposableSmokeProfile() below,
 *  which writes into it, is gated on the comparison passing. */
export function prepareSmokeUserDataDir(
  overrideDir: string | undefined,
  defaultUserDataDir: string,
  fail: (message: string) => void = defaultFail
): string | null {
  const resolvedDefault = resolve(defaultUserDataDir)
  if (!overrideDir) {
    fail(
      'FATAL: ME_SMOKE/ME_SHOOT requires ME_SMOKE_USERDATA_DIR to point at an isolated ' +
        'temp directory distinct from the real userData path. Refusing to start against: ' +
        resolvedDefault
    )
    return null
  }
  const resolvedOverride = resolve(overrideDir)
  mkdirSync(resolvedOverride, { recursive: true })
  if (canonicalForComparison(resolvedOverride) === canonicalForComparison(resolvedDefault)) {
    fail(
      'FATAL: ME_SMOKE_USERDATA_DIR resolves to the same real directory as the userData ' +
        'path (case-insensitive/symlink-aware match on Windows) — refusing to start against: ' +
        resolvedDefault
    )
    return null
  }
  markDisposableSmokeProfile(resolvedOverride)
  return resolvedOverride
}

/** Must be called immediately before any destructive smoke setup (resetAll(),
 *  seedDemoForSmoke()). Refuses (hard exit by default) unless the current userData
 *  directory carries the disposable-profile sentinel written by
 *  prepareSmokeUserDataDir(). This is deliberately independent of whatever
 *  ME_SMOKE_USERDATA_DIR validation already ran at startup — it re-checks the
 *  filesystem, not an env var or a variable carried in memory. */
export function assertDisposableSmokeProfile(userDataDir: string, fail: (message: string) => void = defaultFail): void {
  if (!isDisposableSmokeProfile(userDataDir)) {
    fail(
      `FATAL: refusing destructive smoke setup (resetAll/seedDemoForSmoke) — no ` +
        `${SMOKE_PROFILE_SENTINEL} sentinel found in userData (${userDataDir}). This ` +
        `directory is not marked disposable.`
    )
  }
}
