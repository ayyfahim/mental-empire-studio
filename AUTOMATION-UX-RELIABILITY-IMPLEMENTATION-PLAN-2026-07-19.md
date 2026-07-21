# Automation UX and reliability implementation plan

## Objective

Make the Automation setup understandable, resettable, visually inspectable, and reliable enough to complete the requested number of eligible videos without repeatedly using the same assets or silently stopping on a transient download failure.

## User-requested scope

1. Replace the saved-source dropdown with a source picker modal containing channel cards, logos, names, handles, and useful metadata.
2. Expose the existing editor capabilities that Automation currently hides: caption font, animation, line count, position, pace, highlight/box colours, visual gradient edges/intensity, image ordering, crossfade, B-roll density/mode/pool size, and saved B-roll pool selection.
3. Before downloading, check the linked owned channel’s upload history. Skip high-confidence already-uploaded matches and continue scanning until the requested number of eligible videos has been found.
4. Treat every new automation as a clean draft. Clear prior local files, exact video selections, visual assets, preflight state, and modal draft state. Preserve old selections only when the user explicitly duplicates a workflow.
5. Replace the filename-only previous-assets list with a modal grouped by channel. Show thumbnails, selection state, per-channel counts, clear/remove controls, and an explicit Apply action.
6. Allow an Automation job to choose a saved niche B-roll pool. Persist the choice in the durable job config and pass it to rendering without changing the source’s global default.
7. Shuffle B-roll with a per-project seed. A rerender of the same project remains deterministic, while separate videos get different clip orders.
8. Pace sequential YouTube requests and retry transient HTTP 403/429/network failures with bounded backoff. Authentication/cookie/login failures remain non-retryable and actionable.

## AI validation findings and additions

The implementation review found several connected issues that need to be handled with the requested changes:

- **The current 403 classification is too broad.** All 403 text is treated as authentication before the download step can classify it as retryable. The classifier must distinguish transient forbidden responses from explicit login/cookie/credential failures.
- **Discovery currently requests exactly the desired count.** Uploaded filtering therefore cannot replace skipped entries. Discovery must fetch a bounded overscan window and only then stop after collecting the requested eligible count.
- **Upload detection needs a confidence boundary.** Only exact YouTube-ID matches and high-confidence title matches should auto-skip. Pending/ambiguous matches should remain eligible and be logged rather than silently removed.
- **Explicit selections need predictable behavior.** Exact user-selected videos are never replaced with unrelated videos. Already-uploaded selected items are visibly skipped when the rule is enabled, and the job explains if fewer items remain.
- **Asset selection requires transactional modal state.** Clicking thumbnails inside the library should not change the automation until Apply is pressed; Cancel must discard modal changes.
- **B-roll shuffle must be stable for recovery.** Randomness must be seeded and stored per project, otherwise checkpoint recovery or rerendering can produce a different edit.
- **Pacing must not slow local files or cache hits.** The safe delay applies only immediately before a real YouTube request, not before reused downloads or imported local media.
- **Legacy jobs need defaults.** New config fields must normalize safely when older durable jobs are loaded.
- **Preflight needs clearer warnings.** Warn when uploaded checks have no linked owned channel/upload cache, when a selected B-roll pool is empty, and when Auto B-roll has neither a warmed pool nor provider credentials.
- **Observability is part of the fix.** Logs should state how many candidates were inspected, why items were skipped, which pool was used, and each retry’s delay/attempt count.

## Implementation sequence

### Phase 1 — durable configuration and selection rules

- Extend Automation rules/config with uploaded skipping, request delay, complete caption/visual settings, B-roll pool and shuffle settings.
- Normalize all new fields and provide backward-compatible defaults.
- Add a pure eligible-video selector using exact upload IDs and high-confidence title matching.

### Phase 2 — worker reliability

- Overscan discovery candidates and fill the requested count after filtering.
- Add paced download requests, retry-aware 403 classification, and longer bounded backoff for download/network failures.
- Apply complete caption/gradient/image settings to generated projects.
- Persist explicit B-roll pool key and per-project shuffle seed into project video options.

### Phase 3 — render selection

- Prefer a project-level B-roll pool over the source-level niche fallback.
- Seed candidate tie-breaking and clip rotation so separate videos differ while rerenders remain stable.
- Log pool key and seed in the render log.

### Phase 4 — Automation UI

- Add source-card modal.
- Add grouped thumbnail asset-library modal and current-selection strip with remove/clear actions.
- Add a true New automation reset function; keep Duplicate workflow as the only path that restores prior choices.
- Add complete supported style controls and B-roll pool controls.
- Improve review summary and preflight explanations.

### Phase 5 — validation

- Typecheck and build.
- Unit-test eligible-video selection, 403 classification, legacy normalization, seeded B-roll ordering, and draft reset behavior where practical.
- Run the Automation smoke test and verify retry logs, checkpoint recovery, uploaded skipping, and a multi-item batch.

## Acceptance criteria

- Choosing Saved source opens a modal of recognizable channel cards.
- Starting a fresh automation always shows zero selected assets and no stale exact-video/local-file selection.
- Previously used assets are browsable as channel folders with visible thumbnails.
- Requesting three videos yields three non-uploaded eligible items when enough candidates exist; logs identify skipped uploads.
- The complete supported caption and gradient controls affect generated projects.
- A saved B-roll pool can be selected; two different videos do not reuse the same initial B-roll order, while rerendering one project keeps its order.
- A transient 403/429/network failure retries after a visible delay; explicit login/cookie failures stop with an actionable message.
- Existing jobs created before these fields were added still load and run with safe defaults.
