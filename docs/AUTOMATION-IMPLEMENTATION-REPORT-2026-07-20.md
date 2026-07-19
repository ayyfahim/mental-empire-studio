# Automation workflow implementation report

Date: 2026-07-20
Implementation branch: `claude/compose-tab-issues-budb3w`
Validated head: `84ded4430aaefd5b7fceade399ecf1674cd01887`
Comparison base: `build/mental-empire-studio` at merge base `d622c56ab4f951901400efb109bd4254a7e0d379`

This is the durable audit and implementation report required by the Automation plan. Findings added during implementation must remain in this file.

## Mandatory pre-edit validation

The branch contains four commits beyond the comparison base and changes 91 files (7,661 insertions, 4,452 deletions). The worktree was clean before validation.

| Gate | Result | Notes |
| --- | --- | --- |
| Typecheck | Passed | `npm run typecheck` |
| Unit tests | Passed with coverage gaps | 204 passed, 4 skipped. The two database-backed source-automation tests are skipped, as is one automation repository round-trip test. |
| Renderer build | Passed with warning | `npm run build:renderer`; main renderer chunk is over 500 kB. |
| Electron build | Passed with warning | `npm run build`; GPU host is both statically and dynamically imported, and the main renderer chunk is over 1 MB. |

The plan's “Current Branch Baseline” does not match this branch head. At this head the Automation screen uses a native `<select>` for saved sources, has no previous-assets modal, exposes only video style/caption preset/aspect ratio plus an Auto B-roll toggle, has no `resetSetup()`, does not skip uploaded videos during discovery, has no download pacing setting, and has no persisted Automation B-roll pool/seed. Those features therefore cannot be treated as already implemented.

## Baseline item classification

Status values are exactly the requested gate categories.

| Plan item | Baseline status | Evidence / gap |
| --- | --- | --- |
| 4.1 Authoritative supervisor error classifier | Implemented incorrectly | A private `classifyError` exists, so the name is not undefined at this head. There is no exported `classifyAutomationError`, no structured input, and every 403 is classified as authentication. |
| 4.2 Zero-value normalization | Missing | Automation has no crossfade, gradient-intensity, or download-delay contract. Existing normalization uses falsy numeric fallbacks in several places. |
| 4.3 Unified retry semantics | Implemented incorrectly | Item and step retries use different schedules. Item attempts are one counter shared across all steps, completed items can rerun during a step retry, and retryability is derived from coarse message regexes. |
| 5.1 Reusable accessible source modal | Missing | Saved sources use a native select; no dialog, trap, restoration, card keyboard navigation, or modal states. |
| 5.2 Source search/sort/status/refresh | Missing | No picker or discovery controls exist. |
| 5.3 Selected source identity card | Missing | Only the select value and later text summary identify the source. |
| 5.4 Source-change selection rules | Partially implemented | Changing the select clears exact video IDs and reloads cached videos, but gives no warning and source-type changes do not consistently clear source URL/local state. |
| 6.1 Shared Automation style schema | Missing | Job config stores only `style`, `captionPreset`, and aspect ratios. Project rendering has a much larger separate schema. |
| 6.2 Unsupported/misleading options | Implemented incorrectly | The Automation `style` button maps indirectly to a few beta flags; there is no audited field-level final-render support or legacy translation log. |
| 6.3 Live effective style summary | Missing | Review shows only style/preset/aspect/assets/Auto B-roll. |
| 6.4 Preview/final parity tests | Missing | Existing GPU parity tests do not exercise Automation config propagation. |
| 7.1 Upload freshness before selection | Missing | Upload timestamps exist in owned-channel rows, but Automation discovery neither refreshes nor records freshness. |
| 7.2 Adaptive eligible scanning | Missing | Discovery makes one scrape call and slices once; no cursor, dedupe checkpoint, safety cap, or upload filter. |
| 7.3 Upload confidence decisions | Missing | General work-item upload detection has fuzzy confidence data, but Automation selection does not consume or persist it. |
| 7.4 Exact-selection behavior | Missing | Exact IDs are filtered from one fetched window; uploaded status and opt-in replacement do not exist. |
| 7.5 Exhausted-source result | Missing | Zero matches throw a generic error; partial results have no requested/inspected/skipped/eligible totals. |
| 8.1 Central Automation draft model | Missing | Setup uses 25+ independent `useState` values. |
| 8.2 Clean New Automation | Implemented incorrectly | The jobs-page action changes stage/view only. It retains sources, exact IDs, assets, files, preflight data, and hidden input values. The first source is also auto-selected. |
| 8.3 Duplicate as sole restoration path | Partially implemented | Duplicate copies many config fields but omits minimum duration and notification settings; legacy defaults are unsafe and runtime-independent draft identity does not exist. |
| 8.4 Stale-response protection | Missing | Source-video, asset-library, details, and preflight promises can update a replaced setup. |
| 9.1 Expanded durable asset model | Missing | Asset rows contain only path, channel text, and added timestamp. |
| 9.2 Canonical hashed asset library | Missing | Records point into project folders; list IPC hides missing rows. |
| 9.3 Channel-folder modal | Missing | Assets are an inline filename checkbox list capped at 40. |
| 9.4 Transactional asset selection | Missing | Checkbox changes immediately mutate the draft selection. |
| 10.1 Pool-selection UI metadata | Missing | Automation exposes only an Auto B-roll boolean. |
| 10.2 B-roll fallback policy | Missing | The underlying B-roll service implicitly supplements a scoped library with live providers. |
| 10.3 Effective pool resolver | Missing | Preview/readiness derive only the source-linked niche pool; Automation has no selected pool field. |
| 10.4 Deterministic per-video ordering | Implemented incorrectly | Library ranking adds `Math.random()` tie-breaking. Project image seeds are random and no Automation B-roll seed/order is persisted. |
| 10.5 Shuffle-mode validation | Missing | Neither Automation shuffle policy nor deterministic corpus coverage exists. |
| 11.1 Delay only real downloads | Missing | No Automation download-delay setting or supervisor pacing exists. Cache reuse itself is present. |
| 11.2 Adaptive cooldown | Missing | Item retry uses 0.5–5 seconds, step retry 2–30 seconds, with no jitter, Retry-After, or failure-specific caps. yt-dlp also performs three hidden retries. |
| 11.3 Non-retryable authentication | Implemented incorrectly | Generic `403` is treated as authentication; detailed yt-dlp categories and actionable restriction cases are absent. |
| 11.4 Partial-download cleanup | Missing | `--continue` is used, but non-zero existence is treated as a complete cache hit and partial artifacts are not validated/quarantined. |
| 11.5 Item-level continuation | Partially implemented | Failed items continue when configured, but attempts/checkpoints are flawed and the final warning summary lacks titles/reasons. |
| 12 Structured observability/job UX | Partially implemented | Basic steps/items/logs and aggregate counts exist; all requested discovery, upload, cache, retry countdown, B-roll, asset, and per-output details are absent. |
| 13.1 Guarded migrations | Partially implemented | `ensureColumn` infrastructure exists; none of the requested new Automation/asset fields exist. |
| 13.2 Existing-job defaults | Implemented incorrectly | Loader defaults only `sourceKind`, exact IDs, and local paths. Missing rule/style/B-roll values can remain undefined. |
| 13.3 Existing-asset migration | Missing | Missing assets are filtered out by IPC rather than migrated/marked; no canonical copy or Unsorted assignment exists. |
| 14 Unit test matrix | Missing | Only four basic workflow tests exist; the requested boundary/selection/retry/B-roll/asset cases are absent. |
| 14 Renderer tests | Missing | No Automation config-to-project-to-preview/final contract tests exist. |
| 14 Component tests | Missing | No React component test environment or Automation component tests exist. |
| 14 Integration tests | Missing | No Automation integration fixture suite exists. |
| 14 Smoke tests | Partially implemented | An Automation smoke seam exists, but it does not cover the requested upload-fill, durable asset, pool-resolution, or visual-contract scenarios. |
| 14 Final validation matrix | Partially implemented | Typecheck/tests/builds are available. There is no dedicated integration script, packaged-app Automation checklist, or automated credential-leak diff check. |

## Newly discovered defects and requirements

1. Item `attempts` is shared across download, transcribe, prepare, and render. A retry in one step consumes retry budget in later steps. Retry accounting must be persisted per item and per workflow step.
2. On a step-level retry, `eachItem()` processes already-completed items again because it skips only failed/skipped/cancelled statuses. Per-step item checkpoints are needed before step-level retry is safe.
3. `startDownloads()` converts a rejected download into a `DownloadedVideo` row with stage `Failed`; the supervisor must preserve the structured downloader failure before it can classify status, exit code, and stderr category.
4. yt-dlp has three internal retries in addition to supervisor retries, making configured attempt counts misleading. Automation must use a single visible owner for retry semantics or explicitly account for internal attempts.
5. Any non-empty target MP3 is accepted as a cache hit before duration validation. A stale/truncated result can therefore bypass downloading and fail later.
6. Source discovery is capped by the one-shot request. Popular scraping is capped upstream, so adaptive discovery requires a page/window contract rather than repeated identical requests.
7. The UI automatically selects the first source after reset. Clean drafts require no implicit saved-source selection.
8. Duplicate omits `minDurationSec`, desktop/webhook notification settings, and any future style/B-roll fields.
9. The asset table is absent from `DATA_TABLES`; this is desirable for a durable shared library but must be documented and explicitly tested because Reset All currently preserves it.
10. Asset IPC filters missing records, preventing the UI and migration from showing a missing-file badge or repairing a row.
11. B-roll library ranking uses `Math.random()`, so preview, resume, and rerender can differ even without a shuffle option.
12. Readiness checks in compose/render use only `nicheKeyForDownload()`, confirming the selected-pool contract drift described in the plan.
13. Renderer bundle-size and GPU host import warnings predate this implementation; they are retained here but are not blockers for Automation correctness.
14. Database-backed Automation tests are skipped when the native SQLite module is not loadable in the Node test ABI. The final validation must either rebuild it for Node tests or add pure-contract coverage that always runs; silently skipped migration tests are insufficient.
15. Credential safety needs structured errors: current low-level errors embed up to 300 characters of yt-dlp stderr and command logging includes a cookie file path. Logs must sanitize secrets, signed URLs, keys, and cookie paths.

## Dependency-adjusted implementation order

1. Reliability primitives: structured classifier, numeric normalization, retry/checkpoint semantics, downloader validation.
2. Shared durable contracts and guarded migrations: normalized Automation config/style, selection decisions, retry metadata, B-roll policy/seed, asset schema.
3. Upload-aware adaptive selection and observability, because the draft UI depends on its preflight/result contract.
4. Draft reducer and accessible source picker, including stale-response guards.
5. Canonical asset library and transactional channel-folder modal.
6. Effective B-roll resolver, deterministic ordering, and style preview/final parity.
7. Full focused/integration/smoke validation and an independent end-to-end pass.

## Phase validation log

Implementation-phase results and additional findings are recorded here rather than replacing the baseline audit.

### Phase 0 — reliability foundation

- Added one exported `classifyAutomationError` contract with workflow step, HTTP status, yt-dlp exit code, sanitized stderr category, credential/cookie context, retryability, and required-user-action state. Both item and outer workflow failures now use it.
- `DownloadFailure` preserves structured downloader details through IPC/supervisor boundaries. Supervised downloads disable yt-dlp's hidden retry loop so the visible Automation attempt count is authoritative.
- `maxRetries` consistently means additional attempts. Per-item, per-step attempt/checkpoint state prevents an earlier retry from consuming a later step's budget and prevents completed item steps from rerunning during a step-level retry.
- Authentication/user-action categories never auto-retry. Transient 403, 429, timeouts, resets, DNS failures, and temporary extractor failures use bounded exponential cooldown with jitter and `Retry-After` support.
- Replaced targeted falsy numeric fallbacks with finite/nullish normalization. A final independent grep found and fixed one additional project-row `crossfade || 0.8` loader after the first validation pass.
- Focused reliability/config tests passed after the phase; typecheck and the renderer/main contract diff were clean.

### Phase 1 — upload-aware selection and downloads

- Added upload-cache freshness states (`fresh`, `stale`, `unavailable`), refresh-before-discovery policy, stale-cache continuation policy, and preflight/result logging.
- Discovery now scans expanding bounded windows up to a documented safety cap, deduplicates across windows, persists inspected IDs/cursor state, and continues until the eligible count, exhaustion, or cap is reached. Popular scraping can supply the expanded window.
- Added exact-ID, manual, high-confidence, ambiguous, and low-confidence decision bands with stored score/reason. Ambiguous matches remain eligible; exact/manual/high matches skip automatically.
- Exact selections are never silently replaced. Uploaded exact selections are visible, and fill-after-skip is explicit and defaults off.
- Source exhaustion completes with warnings when allowed and reports requested, inspected, duration-excluded, upload-skipped, ambiguous, eligible, and selected totals.
- Pacing occurs immediately before real network downloads only. Cache hits/local imports/completed files are not delayed. Cache hits and completed files require non-zero size and media-duration validation; incomplete files are quarantined before retry.
- Selection/reliability tests cover three-after-skips, more than fifty ineligible candidates, exhaustion, transient/auth 403, retry semantics, and credential redaction.

### Phase 2 — draft lifecycle and source picker

- Replaced scattered setup ownership with `createDefaultAutomationDraft()` plus reducer operations for new, duplicate, source change, asset clearing, and source-selection reset.
- New Automation changes draft identity and clears source URL, source selection, exact videos, local files, assets, preflight state, modal snapshots, hidden file inputs, and setup-only async ownership. It no longer auto-selects the first source.
- Duplicate restores configuration only, including reliability/notification/style/B-roll values, and does not restore runtime state, checkpoints, attempts, results, or output paths.
- Source-video, asset, niche, and preflight responses are guarded by draft/session identity.
- Added an accessible source dialog with focus trap/restoration, Escape/backdrop close, arrow-card navigation, title/description relationships, loading/empty/error states, search, sort, status chips, and per-card refresh.
- The chosen source remains visible as an avatar/name/handle/cache/upload-status identity card. Changing it warns before clearing exact selections while retaining generic rules, styles, and assets.
- Reducer tests passed; packaged UI validation exercised the source modal against the real database.

### Phase 3 — durable asset library

- Guarded migration expands legacy asset rows with stable content IDs, canonical/original paths, source/channel identity, avatar/handle, durable thumbnail, MIME/dimensions/size, first/last use, usage count, missing state, and provenance.
- New imports use SHA-256 content addressing in a shared user-data asset library, generate durable thumbnails, deduplicate identical content, and copy from the canonical file into each project.
- Legacy rows migrate lazily without crashing: existing files are canonicalized, unresolved rows remain visible as missing, and rows lacking channel identity appear under Unsorted.
- Added a transactional channel-folder asset dialog with folder summaries/recent thumbnails, asset metadata, missing badges, search/sort, select-all, folder clear, Back, Apply, Cancel, Escape, and backdrop discard behavior.
- The asset table intentionally remains outside Reset All so deleting/resetting projects cannot remove the shared library. The Electron smoke verifies canonical and project-copy paths independently.

### Phase 4 — shared styling and B-roll contract

- Added one normalized Automation style contract covering video style; caption preset/font/animation/position/offset/lines/pace/word count/colours; image mode/crossfade/motion; gradient edge/intensity; aspect; and B-roll mode/density/pool size/pool/shuffle/fallback.
- Job creation, legacy loading, duplicate, review summary, project preparation, preview, and final rendering consume the normalized contract. Legacy values translate to supported equivalents without rewriting job JSON on view.
- Added actual Fade and None caption behavior in both ASS and GPU paths. Zero crossfade now reaches preview, GPU, queue, database reload, and final compositor unchanged.
- The review screen shows effective values rather than preset names only.
- Added saved-pool metadata/status UI and three fallback policies. One effective-pool resolver is used by preflight/readiness, project preparation, preview, final render, recovery, and summaries.
- B-roll seeds derive from stable job ID plus source video ID and persist before processing. Provider/library ranking is deterministic; per-video shuffle differs across a batch while resume/rerender reproduces the same order. Selected clip IDs/order are written to the manifest/item log.
- Style parity and B-roll resolver/order tests passed after the phase.

### Phase 5 — migrations, observability, and job UX

- Guarded database migration adds item state JSON and expanded assets without destructive rewrites. Job readers normalize legacy JSON in memory only, with safe legacy defaults for upload skip, delay, pool/fallback/shuffle, captions, gradients, and retries.
- Job details expose discovery totals/decisions, cache vs network downloads, attempt/total and cooldown time, user-action state, continuation state, source exhaustion, effective B-roll pool/fallback/seed/clip count, asset/missing counts, and item output paths.
- Cookie paths, proxies, signed query values, keys, and long stderr are sanitized. The final diff credential scan found only settings-presence checks and redaction code; no secrets or unredacted provider credentials were introduced.
- Renderer/main IPC and shared-type changes were inspected together after each phase. Existing persisted jobs were loaded through the packaged real database without being rewritten merely by viewing them.

## Independent post-implementation validation

The second pass started from the complete Automation flow rather than the edited helper functions. It traced draft creation/duplication, source discovery and upload decisions, download retry/cache behavior, project/style mapping, asset durability, B-roll resolution/order, rendering, checkpoint recovery, summaries, database migration, and packaged UI behavior.

Additional defects found and closed during this pass:

16. GPU, preview, queue, and database reload paths still contained separate crossfade behavior; all now preserve an explicit zero.
17. Caption `Fade` and `None` were exposed but silently fell back to pop-in in one or both rendering engines; both are now supported.
18. The outer classifier received a `DownloadFailure` wrapper rather than its structured details; classifier input now unwraps status, exit code, stderr category, cookie context, and `Retry-After`.
19. Partial eligible discovery could finish as an ordinary success without a source-exhausted state; the item/job now retain the warning and totals.
20. Provider aggregation could reorder a seeded result after the local library was deterministic; provider aggregation now uses the same seed/ranked-order contract.
21. The UI screenshot harness could advance real queued jobs while validating the real database; scheduler/supervisor startup is now suppressed for `ME_SHOOT` unless an explicit run fixture is requested.
22. The last diff audit found the legacy project-row `crossfade || 0.8` expression; it was changed to finite-number coercion and the full final matrix was restarted.
23. The first post-package hardware-GPU capture produced a black frame. A software-composited repeat rendered the expected real-data UI, establishing this as a screenshot timing/GPU artifact rather than an application-load failure.

## Final validation results

The final sequence was rerun after finding item 22.

| Command / check | Final result |
| --- | --- |
| `npm run typecheck` | Passed. |
| `npm test -- --reporter=verbose` | Passed: 235 tests; 4 pre-existing skips. |
| Automation-focused contract/integration command | Passed: 41 tests; 1 native-DB ABI skip. Covers normalization, selection, reliability, draft, style parity, B-roll, asset hashing, workflow, and preview contracts. |
| `npm run build:renderer` | Passed; pre-existing >500 kB chunk warning remains. |
| `npm run build` | Passed; pre-existing GPU host static/dynamic import and renderer chunk warnings remain. |
| `ME_SMOKE=automation` isolated Electron smoke | Passed with `AUTOMATION_SMOKE_OK`. Real SQLite/ffmpeg exercised retry, durable checkpoints, startup recovery, pause/resume/cancel, verified audio/video output, item continuation, and canonical asset durability. |
| `npm run dist:dir` | Passed. One transient `rcedit` commit attempt retried successfully inside electron-builder. |
| Packaged real-local-database UI test | Passed read-only with background job execution suppressed. The accessible saved-source dialog rendered recognizable channel cards, avatars/handles, cache/upload states, search/sort, refresh, and focus state. |
| `git diff --check` | Passed; only the repository's Windows LF-to-CRLF notices were printed. |
| Classifier drift grep | Passed: no `classifyError(` references remain. |
| Zero-fallback grep | Passed after item 22 was fixed. |
| Migration/IPC/credential diff review | Passed; no contract drift or secret material found. |

The Node Vitest process cannot load the Electron-rebuilt `better-sqlite3` ABI, so three existing database round-trip tests remain skipped; one manual preset-frame test is also intentionally skipped. Database migrations and repositories were nevertheless exercised in the Electron ABI by the Automation smoke and the packaged app against the existing real database. The repository does not currently carry a jsdom/React Testing Library component-test stack, so keyboard/transactional modal behavior was validated through reducer/pure contract tests, source inspection, and the packaged UI harness rather than a new DOM runner. These are retained as explicit infrastructure caveats rather than hidden omissions.

## Final outcome

All Automation acceptance behaviors are implemented: accessible channel selection and persistent identity, complete effective styling, zero preservation, clean drafts and config-only duplication, durable channel-folder assets, adaptive upload-aware filling with confidence reasons, consistent saved-pool resolution and deterministic per-video B-roll, bounded visible retries with non-retryable user-action failures, continuation after item failure, structured job details, and backward-compatible persisted data loading.
