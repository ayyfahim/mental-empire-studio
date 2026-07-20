import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
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

/** Validates an isolated userData override dir for a smoke/screenshot run: must be
 *  provided and must resolve to somewhere other than the real default userData path.
 *  On success, creates the dir, writes the disposable-profile sentinel into it, and
 *  returns the resolved path. On failure, calls `fail` (hard process.exit(1) by
 *  default) and returns null. */
export function prepareSmokeUserDataDir(
  overrideDir: string | undefined,
  defaultUserDataDir: string,
  fail: (message: string) => void = defaultFail
): string | null {
  const resolvedDefault = resolve(defaultUserDataDir)
  const resolvedOverride = overrideDir ? resolve(overrideDir) : ''
  if (!overrideDir || resolvedOverride === resolvedDefault) {
    fail(
      'FATAL: ME_SMOKE/ME_SHOOT requires ME_SMOKE_USERDATA_DIR to point at an isolated ' +
        'temp directory distinct from the real userData path. Refusing to start against: ' +
        resolvedDefault
    )
    return null
  }
  mkdirSync(resolvedOverride, { recursive: true })
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
