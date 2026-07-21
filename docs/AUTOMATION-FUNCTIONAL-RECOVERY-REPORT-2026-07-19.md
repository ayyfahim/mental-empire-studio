# Automation functional recovery report

## Outcome

The Automation tab is now a guided goal-to-output system backed by durable SQLite job state and an Electron main-process worker. A user can choose an available goal, configure a saved source, paste a YouTube URL, or select local media, add existing or new visual assets, choose style and rules, run preflight, and start the whole workflow once. The worker progresses through the generated steps, checkpoints item state, retries temporary failures, continues a batch when configured, and produces a real exported video.

The tab is not required to remain open. Closing the window is safe when the application remains in the tray. Sleep pauses local processing and work resumes after wake; a full shutdown stops all local processing and recovery occurs the next time the application starts. Processing while the computer is powered off requires a future cloud worker and is not implied by the interface.

## What was broken and why

- The previous setup depended on preconfigured saved sources, so a new user could reach an empty state with no usable way forward.
- Pasted watch and playlist URLs were treated like channel URLs and had `/videos` appended, making discovery invalid.
- The supervisor required a database source ID and could not normalize direct URLs or local files into durable items.
- Setup promise failures were swallowed, leaving the interface apparently unresponsive.
- Retries existed at the step level but not around individual batch items, so a temporary item failure could not recover as advertised.
- Browser QA used a hard-coded workflow that could display transcription even when captions were disabled.
- Preflight checked free space against a not-yet-created output directory and could report a false warning.
- Several controls lacked accessible names, and the layout did not provide a readable beginner path or useful small-window behavior.

## Implemented vertical slice

1. **Choose a goal.** Available recipes are honest about the media engine they can execute; future recipes are shown as unavailable rather than starting fake work.
2. **Choose a source.** Saved sources, direct HTTPS YouTube video/short/playlist/channel URLs, and selected local media files are supported.
3. **Configure once.** Content rules, reusable/new visual assets, style, captions, aspect ratio, retry/failure behavior, free-space guard, resource limits, and notification preferences are captured in one guided flow.
4. **Review and preflight.** The UI shows item count, estimated time/storage, outputs, steps, execution location, retry policy, notification behavior, and the local power limitation before enabling the primary action.
5. **Start once.** Job, step, item, and log rows are written before the worker begins. The main-process supervisor owns execution instead of the React screen.
6. **Run and checkpoint.** The worker imports/downloads media, reuses existing project and render services, records each successful step/item, and skips valid completed work after recovery.
7. **Handle failures.** Bounded item retries handle temporary failures. Continue-on-error preserves successful batch items; actionable messages identify the failed item and whether the remainder continued.
8. **Return to results.** The dashboard rehydrates from SQLite and exposes progress, current step, item state, checkpoints, logs, exported files, pause/resume/cancel, retry failed items, and open-output actions.

## Architecture

The first version deliberately uses a persistent local worker in the Electron main process:

- **Advantages:** reuses the existing FFmpeg, yt-dlp, transcription, SQLite, local asset, GPU, tray, and notification systems; avoids mandatory uploads; keeps media private and has no cloud compute bill.
- **Limitations:** the Electron process and computer must remain running. Sleep suspends useful processing. A power-off computer cannot run local media work. One machine also caps parallel throughput.
- **Future hybrid:** opt-in cloud transcription/rendering can provide shutdown-safe operation and burst capacity, but requires accounts, encrypted transfer/storage, cost budgets, retention controls, remote cancellation, and result synchronization. It is intentionally not presented as available today.

The renderer is a client of durable job state. SQLite WAL tables store jobs, steps, items, logs, attempts, checkpoints, outputs, and configuration. Startup recovery changes interrupted running work back to a recoverable queued state and validates completed checkpoints instead of replaying them. Existing downstream project/render records remain the source of truth for media artifacts.

## Verification evidence

- `npm run typecheck`: passed.
- `npm run build`: passed. The existing Vite advisory about the GPU module being both statically and dynamically imported remains non-fatal.
- `npm test`: 204 passed and 4 skipped after correcting a stale still-image motion assertion. The skipped native-ABI tests are explicitly environment-gated.
- Electron automation smoke (`ME_SMOKE=automation`): passed with an isolated SQLite database and real FFmpeg/ffprobe processing.
- The smoke produced and probed a roughly 12-second MP4 containing video and audio.
- The smoke verified a temporary failure automatically retries and records the retry warning.
- The smoke simulated an interrupted running job, restarted the supervisor, and verified the completed checkpoint was preserved.
- The smoke persisted queued pause, resume, and cancel transitions.
- A two-item batch deleted one input after preflight; the remaining item still exported successfully and the final job reported `completed_with_warnings` with an actionable failed item.
- Browser QA verified the complete guided path, immediate invalid-URL feedback, disabled start/continue states, accessible switch labels, real workflow generation in the browser mock, and a narrow 760-pixel layout without horizontal overflow.

Run the real backend smoke from PowerShell:

```powershell
$env:ME_SMOKE='automation'
npm run build
npm run start
Remove-Item Env:ME_SMOKE
```

The smoke uses a temporary isolated database and temporary media/output directory; it does not mutate the normal user library.

## Remaining phased work

These are not represented as functional controls in the current interface:

- Long-video highlight extraction and automatic 9:16/1:1 reframing.
- Image-only video generation without a source audio/video item.
- Existing-project review/export as an Automation source adapter.
- Scheduled/overnight queue UI, priority/deadline reordering, and post-run sleep/shutdown actions.
- Email and remote status notifications, cloud/off-power execution, and cost-aware routing.
- Workflow template import/export and learned channel/style profiles.
- Semantic B-roll/image selection beyond the existing transcript, asset, and media-planning capabilities.
- Automatic temporary-file retention/cleanup policies and versioned multi-format fallback exports.

The highest-value next steps remain: (1) preflight plus a decision inbox for issues requiring user input, (2) a production watchdog with checkpoint validation and safe fallback settings, and (3) accepted-edit memory captured as explicit channel profiles. Their problem/fit/phase/requirements/risks/control analysis is in the plan's dedicated **Innovation opportunities** section.
