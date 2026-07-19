# Automation redesign and unattended-production plan

> Implementation status: the smallest functional unattended workflow described here is now implemented. Direct YouTube URLs and local media files were added during the recovery pass in addition to saved sources. See [AUTOMATION-FUNCTIONAL-RECOVERY-REPORT-2026-07-19.md](./AUTOMATION-FUNCTIONAL-RECOVERY-REPORT-2026-07-19.md) for the verified behavior, test evidence, and remaining phased work.

## Architecture findings

- **Current UI:** `src/screens/Profiles.tsx` is a source-card overview. It exposes a one-click run and a five-chip progress strip, but it does not begin with a goal, explain configuration, provide preflight, or show durable jobs/history.
- **Frontend and design system:** React 18 + TypeScript + Zustand inside Electron. The app uses shared primitives and tokenized dark-theme CSS (`src/components/ui/kit.tsx`, `src/components/primitives.tsx`, `src/theme/*`). The redesign should reuse these tokens and controls.
- **Desktop/backend:** Electron main process with typed IPC/preload. Native media work runs outside the renderer, so closing the Automation tab is already safe; closing the window is safe only when close-to-tray is enabled.
- **Persistence:** synchronous SQLite (`better-sqlite3`, WAL mode) holds sources, downloads, projects, transcripts, render jobs, and activity. `electron-store` holds settings and secrets.
- **Media pipeline:** yt-dlp downloads, Groq transcription, FFmpeg/WebCodecs rendering, caption/effect planning, B-roll pools, image import, thumbnails, and per-video library folders already exist and are reusable.
- **Existing background behavior:** the Electron main process can remain resident in the system tray, start at sign-in, run an auto-watch scheduler, recover stale `rendering` rows on startup, and send desktop/webhook notifications.
- **Durability gap:** source automation is one in-memory async call. Its progress is not a database entity, it has no durable item/step checkpoints, and a full app quit can lose orchestration state even though downstream render jobs persist.
- **Current UI dependency:** the media services do not require the tab to remain open. The Zustand progress model and current source-run event summary do require a renderer to be present to be visible, and are not sufficient for history/recovery.
- **Unattended limitation:** local work cannot continue while the computer is shut down. Sleep pauses local work. Start-on-sign-in can recover after boot, but continuous off-device processing requires a future cloud worker.

## 1. Current problems

The tab describes tools and sources rather than user outcomes. Configuration is scattered across Sources, Compose, Settings, B-roll Pools, and Render Queue. Runs lack a durable identity, checkpoints, clear failure behavior, preflight, history, item-level state, and a reliable answer to “can I leave now?”. The render queue is persistent, but the larger production goal is not.

## 2. Goal-based user journey

`Choose Goal → Choose Source → Select Content → Add Assets → Choose Style → Define Rules → Review Workflow → Run → Monitor → Review Results → Export`

The first release uses one guided workspace with progressive disclosure. Essential choices stay visible; resource limits, retry rules, B-roll, caption detail, scheduling, and shutdown behavior live under Advanced settings.

Exact unattended journey:

1. Select a final goal card.
2. Select a saved YouTube source and selection policy; choose assets/style/rules once.
3. Review the generated steps, preflight findings, storage/time estimate, execution location, retry behavior, and notifications.
4. Select **Start automation and run until complete**. The main process writes the job and steps to SQLite before starting.
5. Leave the tab or close the window to the tray. A persistent main-process worker advances ready steps and checkpoints each major output.
6. Return to the Jobs view to see completed outputs or a plain-language, item-scoped action request.
7. Resume a paused/interrupted job from its last successful checkpoint; completed downloads/projects/transcripts/renders are reused.

## 3. Supported goals

Core v1 goal: **Produce finished videos automatically from a saved YouTube source, a pasted YouTube video/playlist/channel URL, or selected local media files to export**. Available goal recipes express full production, download/edit, transcription/subtitles, and saved-style batch processing. Goals only enable steps supported by the current media engine; image-only generation, long-to-short reframing, existing-project review/export, and multi-platform transforms remain visibly unavailable rather than simulated.

## 4. Workflow generation

A goal definition supplies ordered step keys, defaults, required capabilities, and optional branches. Configuration modifies the graph: transcription adds `transcribe`; assets/B-roll determine `visuals`; captions/style determine `edit`; output selection adds one or more `render` branches; quality validation adds `quality-check`. Each persisted step is idempotent and checks its output before doing work. Later adaptive branches can be inserted after analysis or quality checks without changing the job contract.

## 5. Frontend screens and components

- Setup header with **New automation / Jobs** views and an always-visible local-execution truth banner.
- Goal gallery with beginner descriptions and availability labels.
- Guided source/content/assets/style/rules configuration panels.
- Generated workflow rail showing purpose, local/cloud location, required/optional status, and what happens next.
- Preflight/review card with item count, time/storage estimates, output ratios, style, retries, failure policy, power/app requirements, and notifications.
- Jobs dashboard with status filters, current step, progress, item counts, ETA, checkpoint, output, warning/error summary, and pause/resume/cancel/retry/open actions.
- Job detail expands workflow steps, item state, logs, recovery explanation, and result files.

## 6. Queue and background-worker architecture

Recommended first version: **persistent local background worker in the Electron main process**, kept alive by the tray and optionally started at sign-in.

Advantages: directly reuses the current SQLite/media services and local GPU/files without uploading source media; low migration cost; private and cost-free processing; works offline after assets are present. Limitations: the app process must be running, sleep pauses work, shutdown stops work, and a single machine limits throughput.

Future hybrid: keep file-heavy editing local by default and route explicitly approved transcription/render tasks to a cloud queue when the user needs shutdown-safe execution or extra capacity. Cloud requires authentication, encrypted transfer/storage, cost estimates/limits, remote cancellation, retention controls, and conflict-safe result synchronization.

## 7. Persistent state and database

Add `automation_jobs`, `automation_job_steps`, `automation_job_items`, and `automation_job_logs`. Store normalized status/progress/timestamps plus JSON configuration/result/checkpoint payloads for evolvable settings. SQLite transactions update a step and its checkpoint atomically. Index status/priority/schedule/job IDs. Migrations are additive; existing profiles/source automations remain readable.

## 8. Local versus cloud responsibilities

V1 is explicit local execution. Source discovery, downloads, asset import, editing, rendering, disk checks, and export stay local. Groq transcription remains a third-party API call already used by the app and is marked “online service”. Future cloud workers are opt-in per workflow and never silently receive local media.

## 9. Checkpoint and resume

Checkpoint after preflight, source selection, every successful item download, project creation, asset application, transcription, render enqueue, render completion, and final summary. On startup, `running` jobs become `queued/recovering`; the worker validates checkpoints and output files, skips valid completed steps, and restarts only the first incomplete step. Per-item state prevents one failed video from replaying the batch.

## 10. Retry and failure handling

Classify errors as temporary/retryable, user-action required, unsupported input, missing asset, authentication, download, transcription, editing, export, storage, connectivity, interruption, or resource limitation. Retry temporary errors with bounded exponential backoff. Persist attempts and the next retry time. Continue-on-error is default for batches; strict mode pauses the whole job. Each failure records what happened, item, other-work status, attempted recovery, required action, and resumability.

## 11. File and asset management

Reuse per-video library folders and image import. Automation configs reference source assets; job checkpoints record copied item-scoped paths. Deduplicate downloads and assets, sanitize filenames, support versioned export names, preserve user inputs, and only clean generated temporary files after a verified output/checkpoint.

## 12. Notifications

V1 reuses in-app activity, desktop notifications, and webhook delivery. Completion and attention-needed events include job name, result counts, and the next action. Email and sound are later adapters behind the same notification preference model.

## 13. Resource and disk management

Preflight estimates audio/download/output storage and checks the configured minimum free-space reserve. Respect existing CPU/GPU concurrency; hardware rendering remains single-flight. Persist resource profile and concurrency. Later add bandwidth caps, overnight quiet mode, thermal/load-aware throttling, proxy generation, queue priorities, and post-completion sleep/shutdown.

## 14. Security

Validate all IPC IDs/config enums, keep context isolation and Node integration disabled, never expose API keys to logs/job JSON, restrict file operations to selected/imported paths and app-managed output roots, redact webhook credentials, sanitize filenames, and require explicit opt-in before cloud upload or OS shutdown. Webhooks should be HTTPS in production and protected against local-network abuse.

## 15. Backend and API requirements

Add typed IPC methods to create/list/get/control/retry automation jobs and subscribe to job events. A main-process supervisor owns the pump, one active orchestration at a time initially, and delegates renders to the existing render queue. Repository methods provide transactional CRUD and recovery queries. Renderer state always rehydrates from SQLite; events are an optimization, not the source of truth.

## 16. Implementation order

1. Add shared job/config/result types and additive SQLite schema/repositories.
2. Add the local supervisor, preflight, workflow generator, checkpoints, recovery, retry, and final notification.
3. Expose typed IPC/preload methods and hydrate Zustand from persisted jobs.
4. Replace the source-card tab with setup, review, and dashboard views.
5. Connect source download → project/assets/style → transcription → render → output aggregation.
6. Add pause/resume/cancel/retry controls and understandable logs.
7. Add templates/scheduling/advanced rules incrementally after the core recovery path is verified.

## 17. Migration

Add tables/columns idempotently with no destructive migration. Existing source automation settings seed guided-form defaults; existing render jobs remain separate and visible in Render Queue. The legacy `runSource` API stays for auto-watch compatibility until the scheduler is moved onto durable jobs.

## 18. Testing criteria

- Unit-test goal graph generation, config validation, progress calculation, error classification, retry decisions, and checkpoint skip logic.
- Repository tests cover CRUD, atomic checkpoints, item isolation, controls, and recovery queries.
- Worker tests use existing yt-dlp/Whisper/render fixtures to verify end-to-end progression and continue-on-error.
- Restart tests terminate between each major step, reopen the DB, recover, and assert completed work is not repeated.
- UI tests cover beginner setup, review summary, job controls, empty/error/completed states, and app-close messaging.
- Build/typecheck plus a real short FFmpeg smoke validates output existence and final summary.

## 19. Acceptance criteria for unattended execution

- Starting a job first persists its full configuration, workflow, and items.
- Navigation and renderer reload do not stop or lose the job.
- Closing the window to tray does not stop local processing.
- Restarting the app resumes queued/interrupted work from a validated checkpoint.
- A failed item can be retried or skipped without discarding successful items.
- Completed jobs show exported paths; attention jobs show an actionable, categorized explanation.
- The UI clearly says the app process and computer power requirements before start.
- Full shutdown never claims to continue locally; start-on-sign-in recovery is explicit.

## 20. Future expansion

Move the existing auto-watch scheduler onto durable goal jobs, add playlist/URL/local-folder adapters, real short-form segment/reframe branches, saved workflow templates, scheduling, priority/deadline ordering, cloud execution adapters, remote status, cost-aware routing, and learning from accepted edits.

## Innovation opportunities

### Quick improvements on the current architecture

| Opportunity | Problem and value | Fit and phase | Requirements | Risks and user control |
|---|---|---|---|---|
| Preflight + dry run | Prevents late failures and shows time/storage/actions before commitment. | Directly reads current settings, files, source cache, and capabilities. **V1.** | Capability probes, disk check, estimates, credential validation. | Estimates can be wrong; label confidence and let the user override warnings. |
| Decision inbox | Avoids making users inspect logs while batches continue. | Derived from persisted `action_required` item/step errors. **V1.** | Error taxonomy and grouped actions. | Over-grouping may hide nuance; expandable per-item details and explicit apply-to-all. |
| Channel profiles | Removes repeated brand/style/output decisions. | Extends source-owned automation fields and current image pools/templates. **V1.5.** | Versioned preset JSON and copy-on-start snapshot. | Preset changes could surprise; job review shows the exact frozen version. |
| Production supervisor safe fixes | Automatically resumes downloads, retries network calls, and requeues interrupted renders. | Wraps current services with policy-driven retry. **V1.5.** | Error classifier, backoff, retry budget, watchdog heartbeat. | Retry loops/resource waste; strict caps, audit log, and per-rule toggles. |
| Goal completion quality check | Detects missing audio/captions/visuals/output and validates that export matches the chosen goal. | Uses current project/render metadata and ffprobe. **V1.5.** | Quality rubric and output probe. | False failures; warnings vs blockers and user-set thresholds. |

### High-impact, moderate architectural change

| Opportunity | Problem and value | Fit and phase | Requirements | Risks and user control |
|---|---|---|---|---|
| Adaptive workflows | Later steps can react to transcript length, speakers, or quality instead of following a rigid list. | Adds conditional edges to the persisted workflow graph. **Phase 2.** | Versioned graph engine, deterministic rule evaluation, decision checkpoints. | Harder debugging; show every decision and allow branch overrides before execution. |
| Smart resource scheduler | Prevents CPU/GPU/disk/network contention and improves overnight throughput. | Coordinates existing render concurrency, downloader, B-roll, and transcription calls. **Phase 2.** | Resource sampling, priorities, deadlines, pause/preemption policy. | Starvation or inaccurate estimates; manual priority and maximum-use controls. |
| Self-correcting QC | Retries captions/audio/export using safe adjusted settings when quality checks fail. | Sits after render and calls existing pipeline steps with a new attempt. **Phase 2.** | Quality metrics, bounded alternative strategies, versioned outputs. | Can change creative intent/cost; preview policy, confidence threshold, and keep all versions. |
| Style memory | Learns from accepted corrections so repeated edits disappear. | Stores structured deltas between generated and accepted project settings by channel/style. **Phase 2.** | Consent, feature extraction, explainable recommendations, reset/export. | Bad personalization/privacy; opt-in, inspectable memory, undo and delete. |
| Remote status page | Lets users check overnight jobs without remote-controlling the desktop. | Read-only relay of sanitized job state. **Phase 2.** | Authenticated relay, device identity, push updates, no media by default. | Security/exposure; short-lived links, revocation, MFA, metadata minimization. |

### Long-term, major infrastructure or AI

| Opportunity | Problem and value | Fit and phase | Requirements | Risks and user control |
|---|---|---|---|---|
| Hybrid cloud queue | Allows work to continue after local shutdown and adds burst capacity. | New execution target behind the same durable job contract. **Phase 3.** | Accounts, upload/chunking, cloud workers, encrypted storage, billing, sync. | Cost, privacy, transfer time; explicit routing, estimate/cap, retention and local-only mode. |
| Plain-language AI workflow builder | Converts a creator outcome into a validated graph while keeping advanced power. | Produces the same versioned config/graph as the guided form. **Phase 3.** | Tool schema, constraint solver, model service, simulation, safety validation. | Ambiguous intent; always show generated plan and require approval before start. |
| Semantic asset intelligence | Improves B-roll/image matching and tracks reuse/licensing across projects. | Extends current transcript, asset library, and B-roll pools. **Phase 3.** | Embeddings/index, rights metadata, scene analysis, usage ledger. | Model mismatch/licensing mistakes; confidence thresholds, source attribution, manual pin/ban. |
| Viral clip and multi-format agent | Finds highlights, reframes speakers, and produces platform variants. | New analysis/cut/reframe steps over current projects. **Phase 3.** | Scene/speaker/face models, scoring, timeline cutting, multi-output rendering. | Subjective scoring and poor crops; preview candidates, protected regions, user feedback loop. |

### Features not worth adding now

- A general-purpose visual node editor: it adds cognitive load before the durable goal flow is proven. Advanced users can use generated-step details and JSON import/export later.
- Arbitrary third-party integrations inside the core worker: webhooks cover the immediate need; individual integrations multiply authentication and failure modes.
- Automatic publishing to every platform in v1: platform policy/auth changes and irreversible public actions are higher risk than producing review-ready exports.
- Always-on AI decisions for every edit: expensive, slow, and less predictable than deterministic presets plus targeted AI analysis.
- Fine-grained per-effect scheduling before core checkpoints: it increases configuration without improving unattended reliability.

### Three priorities after the core workflow

1. **Preflight + decision inbox + safe production supervisor** as one reliability layer: the largest reduction in failed overnight runs.
2. **Goal-based quality scoring with bounded self-correction:** the largest improvement in returning to usable results rather than merely completed tasks.
3. **Channel profiles and inspectable style memory:** the largest reduction in repetitive creative decisions while preserving control.
