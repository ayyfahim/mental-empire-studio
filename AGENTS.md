# AGENTS.md

## Project overview

Mental Empire Studio is a local-first Electron desktop application for faceless-YouTube automation.
It uses Electron, React, TypeScript, Zustand, and SQLite (`better-sqlite3`). Read `README.md` for
product behavior and `PLAN.md` for completed milestone history.

## Working conventions

- Keep the renderer, preload bridge, IPC handlers, and `NativeApi` in `shared/types.ts` aligned.
  For a new IPC method: update `NativeApi` → add/register a handler in `electron/ipc/` → expose it
  from `electron/preload.ts`.
- Make database migrations idempotent. Add columns with `ensureColumn(...)`; do not modify existing
  `CREATE TABLE` statements. Coerce database booleans and handle legacy null values in repositories.
- Keep fonts self-hosted through `@fontsource/*` imports in `src/main.tsx`; do not add CDN fonts.
- Native dependencies are externalized and unpacked for Electron packaging. Rebuild `better-sqlite3`
  against Electron when dependencies change.
- Preserve the app's local-first design: no cloud dependencies or API keys except the optional Groq
  transcription key.
- **Render performance is a closed phase.** Read `docs/RENDER-PERFORMANCE.md` before touching render
  or grade filter chains, encoder flags, or Remotion render options. It holds the baseline, the
  measured rationale for the current settings, a list of optimizations already rejected with numbers,
  and the benchmark variance rules — this machine has a ±10% spread on full renders, so unpaired
  comparisons are not evidence. Do not open speculative perf work; act only on a measured regression.
- **Sentry logging is mandatory for pipeline work.** Read `docs/SENTRY_LOGGING.md` before adding
  services, provider jobs, or automation steps. Use `sentryLog` / `captureException` from
  `electron/services/sentry.ts`. When diagnosing production failures, **check Sentry Issues + Logs
  first** (org `buft`, region `de`), not only local log files.
- When working with TalkingPhotos AI you should always analyze "D:\talkingphotos-session" directory. 
  It has all the endpoints and feature list. So you should never guess how it works. Be 100% sure by 
  checking that directory.


## Production quality gate

The production scripts are component generators, not automatic proof that a publishable edit exists. A final daily video must show genuine editorial construction and original value; it must not merely disguise an automated template.

Reject a final that is only:

- still images (even AI-generated) plus captions, pans, zooms, or music;
- one image folder looped on a fixed interval;
- generic stock B-roll plus narration and captions;
- an uninterrupted TalkingPhotos/avatar render plus captions; or
- the same timeline recipe with assets swapped.

Before a four-channel batch, read the controlling channel strategy in the sibling Analytics Hub checkout:

- `D:\Work\youtube-analytics-hub\data\fetch-2026-09-04\VIDEO_MAKER_MASTER_PLANNER.md`
- `D:\Work\youtube-analytics-hub\data\fetch-2026-09-04\VIDEO_EDITING_HANDBOOK.md`

Then read `docs/DAILY-VIDEO-PRODUCTION-RUNBOOK.md` and the daily-production skill in this repository. If the sibling checkout lives elsewhere, locate that repository rather than silently skipping the two files.

Every publishable final needs a written `editing/edit-plan.json`, multiple purposeful media families, and a second editorial assembly pass. TalkingPhotos is A-roll, MindCipher's renderer is a B-roll base, and `render-ramani.mjs` is a retired legacy rough renderer; none is a final by itself. Use Video Express for selected motion scenes when the plan calls for generated movement, following `docs/VIDEOEXPRESS-INTEGRATION.md` and `scripts/production/run-videoexpress.mjs`.

These are internal quality controls, not claimed YouTube numeric rules. They exist to make originality and editorial contribution visible in the finished work.

## Key locations

- `electron/main.ts`: application window, tray, scheduling, and smoke entry points.
- `electron/ipc/`: IPC handler implementations; `register.ts` wires them up.
- `electron/services/`: service logic.
- `electron/db/index.ts`: SQLite migrations and repositories.
- `electron/store/settings.ts`: settings and secrets.
- `electron/preload.ts`: typed `window.api` bridge.
- `src/screens/`: React screens.
- `src/store/useStore.ts`: UI and appearance state; `src/store/useData.ts`: live IPC/database state.
- `src/features/thumbnail-editor/`: Konva thumbnail editor.
- `shared/types.ts`: domain and IPC contracts; `shared/thumbnail.ts`: pure thumbnail arrangement logic.

## Commands

```bash
npm install
npx @electron/rebuild -f -w better-sqlite3
npm run typecheck
npm run build
npm test
npm run dev
```

Use `npm run fetch:bin` to vendor yt-dlp and an available ffmpeg into `resources/bin`.
Use `npm run dist:dir` for an unpacked packaged-app check.

## Verification

Run `npm run typecheck` and `npm run build` for code changes. The integration smoke harness uses
fixtures because the sandbox cannot reach YouTube or run ffmpeg/Whisper:

```bash
ME_SMOKE=m6 ME_YTDLP_FIXTURE=test/fixtures/ytdlp ME_DOWNLOAD_FIXTURE=test/fixtures/audio/sample.mp3 \
  ME_WHISPER_FIXTURE=test/fixtures/whisper/sample-words.json \
  xvfb-run -a node_modules/electron/dist/electron --no-sandbox out/main/main.js
```

Supported smoke values are `1`, `m3`, `m4`, `m5`, `m6`, and `m7`. Use fixture seams such as
`ME_RENDER_FIXTURE` instead of live external tools. The built app needs `--no-sandbox` when run
headlessly in this environment.

## Change safety

- **Snapshot user data before you start.** `npm run userdata:backup` copies the live
  `mental-empire.db` and `mental-empire-settings.json` (channels, sources, automations, encrypted
  API keys) to a timestamped `CLAUDE-BACKUP-*` folder with checksums. Restore with
  `npm run userdata:restore` (`npm run userdata:list` to see the points). Do this before any task
  that launches the app, migrates the database, or writes settings — agents have wiped this data
  before.
- Never run `ME_SMOKE`/`ME_SHOOT` without `ME_SMOKE_USERDATA_DIR` set to a throwaway directory; the
  harness calls `resetAll()`. `electron/services/smokeSafety.ts` enforces this — do not weaken it.
- Keep changes scoped; do not overwrite unrelated work in a dirty tree.
- Avoid editing generated output (`out/`, `dist/`, and build artifacts) unless explicitly asked.
- Do not commit or push unless the user requests it.
