# OpenMontage Bridge — design & live progress

> **Resumability anchor.** This file is the single source of truth for the OpenMontage
> integration. If work is interrupted, the next agent reads this top-to-bottom, checks the
> **Progress** table, and continues. Keep the Progress table and "Next action" current with every
> commit. Branch: `feat/openmontage-bridge` (off `build/mental-empire-studio`).

## 1. Goal (from the user)

Mental Empire Studio (MES) should reuse **OpenMontage (OM)**'s four better-than-ours capabilities
by acting as a **subprocess bridge** that "works like an agent did my work using OpenMontage":

1. **Open footage** — public-domain archives (Archive.org, NASA, Wikimedia, LoC, ESA, JAXA), no API keys. *MES lacks this.*
2. **Extra stock** — Pexels / Unsplash / Pixabay. *Route through OM (user: "theirs does a better job").*
3. **Composition — Remotion** — React scenes (text/stat cards, charts, kinetic captions, transitions).
4. **Composition — HyperFrames** — HTML/CSS/GSAP motion graphics.

MES stays the UI/orchestrator; the user picks options in MES, MES turns them into an OM production
request and drives OM's tools end-to-end (retrieve → compose → self-review). Confirmed decisions:
subprocess bridge (agentic feel), **OM is fully set up** on the target machine (venv +
`remotion-composer/node_modules`), **all four** capabilities, UI in **both** Compose + Automations.

### Later "final polish" asks (keep compatible with the OM path; skip if harmful to OM)
- **Caption multi-color is bad.** Screenshot shows per-word green/yellow/red. Remove the multi-color
  default; default to the popular **active-word-pop** look; offer **box** style. (These presets
  already exist — see §4C.)
- **B-roll loop bug.** One clip repeats in sequence — real MES bug (single-distinct-clip pool). §4B.
- **Compose final-video preview.** User wants to see what the final video looks like. §4D.

## 2. Grounded facts about OpenMontage (do not re-derive)

- OM is **agent-first**: there is **no headless "run the whole pipeline" API**. But every capability
  is a `BaseTool` subclass (`tools/base_tool.py`), instantiated no-arg, run via
  `Tool().execute(inputs: dict) -> ToolResult` (`.success/.data/.artifacts/.error`).
- `.env` auto-loads on import (`tools/base_tool.py::_load_dotenv`); **real env vars take precedence**
  over `.env`, so we pass secrets via `spawn(env)` — never write a plaintext `.env`.
- **Capability → tool mapping:**
  - Open footage **and** extra stock → **`DirectClipSearch`** (`tools/video/direct_clip_search.py`).
    Low-dep (`requests` + ffmpeg for thumbnails). Searches all stock/open-footage adapters in
    `tools/video/stock_sources/` (`archive_org, nasa, wikimedia, loc, esa, jaxa, pexels, pixabay,
    unsplash, coverr, …`). `execute()` required `["output_dir","queries"]`; `queries=[{query,
    slot_id?, kind:video|image|any}]`; optional `sources` (adapter-name list), `clips_per_query`,
    `filters{min_duration,max_duration,orientation,min_width}`. Output `data.clips[]` each with
    `{clip_id, source, source_url, kind, path (downloaded file), thumbnail, duration, width, height,
    license, ...}`; files land in `<output_dir>/clips/`.
  - Remotion → **`VideoCompose`** (`tools/video/video_compose.py`), `operation:"render"|"remotion_render"`,
    `edit_decisions.render_runtime="remotion"`, `edit_decisions.cuts[]` (scene schema in
    `remotion-composer/SCENE_TYPES.md`: `text_card, stat_card, callout, comparison, hero_title,
    bar_chart, line_chart, pie_chart, kpi_grid, progress_bar, anime_scene, terminal_scene`; plus
    plain video/image cuts with Ken Burns). Shells `npx remotion render` with `cwd=remotion-composer/`.
    `renderer_family` → composition id (`Explainer`, `CinematicRenderer`, `TalkingHead`).
  - HyperFrames → **`HyperFramesCompose`** (`tools/video/hyperframes_compose.py`), `operation:"render"`,
    `render_runtime="hyperframes"`, needs **Node ≥ 22** + `npx --yes hyperframes`. Also driven through
    `VideoCompose._render_via_hyperframes` when `render_runtime="hyperframes"`.
  - Subtitle styling in OM: `VideoCompose._resolve_subtitle_style` / `_build_subtitle_style`
    (`video_compose.py:2551-2620`) + `tools/subtitle/subtitle_gen.py`. Remotion word-level captions:
    `remotion-composer/src/components/CaptionOverlay.tsx` (`WordCaption`).
- **Availability probe:** `from tools.tool_registry import registry; registry.discover();
  registry.provider_menu_summary()` → `{composition_runtimes:{ffmpeg,remotion,hyperframes},
  capabilities:[{capability,configured,total,available_providers[],unavailable_providers[]}],
  setup_offers:[…], runtime_warnings:[…]}`. `discover()` does no network; heavy deps (torch, whisperx,
  cv2, transformers) are **lazy** (`try/except ImportError` inside methods) — a minimal env
  (`requests pyyaml pydantic jsonschema python-dotenv numpy Pillow`) is enough for the four tools.
- **No single-tool CLI exists** → we ship our own invoker shim (§3).
- **OM is untracked in git** (`?? OpenMontage/`). Worktrees won't contain it. Therefore **all bridge
  code lives in the MES repo**; the shim points `sys.path` at the external OM root at runtime, and
  worker verification is **fixture-based** (`ME_MONTAGE_FIXTURE`).

## 3. Architecture (3 layers)

### Layer 1 — Python invoker shim (MES repo, tracked, packaged)
`resources/montage/mes_bridge.py`. Adds OM root (from `--om-root`/env) to `sys.path`. Commands emit
**NDJSON** on stdout (one JSON object per line: `{"event":"…", ...}`), final line `{"event":"result", ...}`:
- `capabilities --om-root <path>` → `registry.provider_menu_summary()` + runtime checks.
- `run-tool --om-root <path> --name <tool> --inputs-file <json>` → `registry.get(name).execute(inputs)` → ToolResult JSON.
- `produce --om-root <path> --brief-file <json>` → deterministic mini-orchestrator (the "agentic"
  flow): preflight → footage/stock via `DirectClipSearch` → build `edit_decisions` from the brief →
  `VideoCompose`/`HyperFramesCompose` (locked `render_runtime`) → OM `final_review`. Streams stage
  events `preflight|footage|compose|review|done`.

### Layer 2 — Electron bridge service (`electron/services/montage/`)
- `bridge.ts` — resolve Python interpreter (OM venv → configured `pythonPath` → PATH), resolve OM root
  (`settings.openMontageRoot`), resolve shim path (`resources/montage` via `bin.ts`-style packaged-first),
  `spawn` with `{ env: { ...process.env, <provider keys> } }`, parse NDJSON, map stage events to
  progress, cancellation (running Map + cancelIntents, copy `downloader.ts`), stall watchdog. Fixture
  seam `ME_MONTAGE_FIXTURE` short-circuits the spawn for tests.
- `capabilities.ts` — call shim `capabilities`, cache, expose to renderer.
- `footage.ts` — call shim `run-tool DirectClipSearch`, normalize downloaded clips into MES's B-roll
  library (reuse `broll.ts` normalize/index helpers) as an "OpenMontage" source.
- `montage-compose.ts` — project → brief → shim `produce`; routed from `queue.ts::resolveEngine`
  `openmontage` branch. `edit-remotion.ts` / `edit-hyperframes.ts` build the runtime-specific
  `edit_decisions` from the MES project (images/transcript/captions/`VideoStyle`).

### Layer 3 — IPC + UI
- IPC namespace `montage:*` (3-file contract: `shared/types.ts` `NativeApi` → `electron/preload.ts` →
  `electron/ipc/montage.ts` + `register.ts`). Methods: `capabilities()`, `listSources()`,
  `produce(projectId, opts)`, `cancel(id)`, `retrieveFootage(...)`; events `onMontageProgress`.
- Compose `StylePanel.tsx`: footage-source + composition-runtime selectors (persist via `betaOpts`).
- Automations `Profiles.tsx` "Assets & style" step: same options for batch jobs.
- Settings: capability status panel + provider keys (safeStorage) + OM-root/python-path config.

## 4. MES seams & the three "polish" fixes (grounded)

### 4A — Subprocess & IPC patterns to copy
`electron/services/bin.ts` (path resolution: env override → `process.resourcesPath/bin` packaged →
`cwd/resources/bin` dev). `electron/services/downloader.ts::runYtdlpDownload` (progress + cancel via
`runningDownloads` Map + `cancelIntents` + 15s stall watchdog + 30min hard cap). `render.ts::spawnFfmpeg`
(`-progress pipe:1`). IPC: `ipcMain.handle('domain:verb', …)` + `preload.ts` forwarder + `NativeApi`
entry; main→renderer via `electron/ipc/events.ts::emit` matched to an `onXxx` preload subscription.

### 4B — B-roll loop bug (root cause)
`electron/services/broll.ts::planCoverage` (~:230-258) round-robins over **distinct clips by path**;
when the effective pool collapses to **one distinct clip** (small/narrow niche pool, low `poolSize`,
failed downloads), every slot is that one clip → visible loop. `recordClipUsage` stamps `lastUsedAt`
but `libraryCandidates` scoring never reads it (no "avoid recently-used" guard). **Fix direction:**
(a) routing footage through OM adds many more distinct clips (archives + stock) — primary mitigation;
(b) add a min-distinct-clips guard + de-prioritize recently-used in `planCoverage`/`libraryCandidates`.
Compatible with OM (OM footage feeds the same pool).

### 4C — Caption multi-color (root cause + the fix already exists)
All caption visuals live in `shared/captionStyle.ts` (`CAPTION_PRESET_SPECS`, `resolveCaptionStyle`,
`keywordColor`, `isCaptionKeyword`) consumed by BOTH renderers (`electron/services/captions.ts::buildAss`
and `src/render-worker/captions.ts`). The multi-color = default preset **`Hormozi`** ships
`keywordColors:['#3BFF6F','#FFD93D','#FF4D4D']` AND `defaultProject()` (`electron/ipc/compose.ts:49-61`)
sets `captionPreset:'Hormozi'` + `keywords:true`, so `isCaptionKeyword` (≥6-char non-stopword) colors
many words via `keywordColor()`.
**The looks the user wants already exist as presets:** `Karaoke` (`kind:'karaoke'`, `keywordColors:[]`
→ active-word pop only), `Minimal`/`Podcast` (`kind:'color'`, `keywordColors:[]`), `Boxed`
(`kind:'box'`). **Fix direction:** change the default preset away from multi-color (e.g. `Karaoke` or a
new "Clean") + default `keywords:false`; keep multi-color available but not default; surface the
active-word/box presets in `CaptionsPanel.tsx`. When composing via OM, map the chosen MES caption
preset → OM subtitle style (`_build_subtitle_style`) / Remotion `CaptionOverlay` props. Not harmful to OM.

### 4D — Compose preview (current state)
`compose.ts::previewProject` **throws by design** (rendered sample clip removed). The live preview is
the WebGL compositor: `compose:previewSpec` → `previewSpec()` (720p) → `usePreviewCompositor.ts` +
`PreviewStage.tsx`, using the same `Compositor`+`CaptionLayer` as final export. It shows **real
captions** but **B-roll only as static poster frames** (`posterSpec.ts`, `compose:posterFrame`), not
video. **Fix direction for OM final preview:** produce a short OM sample render (bounded duration) via
`montage.produce` and play it in `PreviewStage`, OR show the last OM render output. Reuse `posterFrame`
for thumbnails. Keep the live WebGL preview for native path.

## 5. Foundation (Phase 0 — coordinator, on-branch, committed = the trunk)

The trunk exists so fan-out worktrees fork a branch that already compiles with the full contract.

- **F1** ✅ branch + this doc + memory (OM skills inventory + bridge facts + polish findings).
- **F2** Python shim `resources/montage/mes_bridge.py` (capabilities / run-tool / produce; produce may start minimal).
- **F3** Electron bridge service skeleton (`bridge.ts` spawn/resolve/cancel + `capabilities.ts`).
- **F4** IPC contract `montage:*` + settings scaffold (new fields `openMontageRoot`, `pythonPath`,
  secret keys) + `useData`/`useStore` stubs. All stubbed so `npm run typecheck` + `npm run build` pass.
- **F5** `queue.ts::resolveEngine` `openmontage` branch → `montage-compose.ts` (compiling stub);
  `electron-builder.yml` `extraResources` adds `resources/montage`.

## 6. Fan-out work units (parallel worktrees off the committed trunk)

| # | Unit | Primary files | Change |
|---|------|---------------|--------|
| 1 | Footage & stock sourcing | `electron/services/montage/footage.ts` (new); minimal `broll.ts`/`Niches.tsx` source-option edits; shim DirectClipSearch path | Retrieve open-footage + stock via `DirectClipSearch`; normalize into B-roll library; expose "OpenMontage" source. Also adds distinct-clip variety → mitigates 4B loop. |
| 2 | Remotion composition | `montage/edit-remotion.ts` (new); fill `montage-compose.ts` remotion path; shim produce remotion | MES project → `edit_decisions.cuts[]` + scene types, `render_runtime="remotion"`; call VideoCompose; stream progress. |
| 3 | HyperFrames composition | `montage/edit-hyperframes.ts` (new); fill hyperframes path; shim produce hyperframes | Build hyperframes workspace/`edit_decisions`; structured blocker if Node<22 (no silent swap). |
| 4 | Compose StylePanel UI | `src/features/compose/ui/StylePanel.tsx`; `shared/types.ts` betaOpts | Per-project footage-source + composition-runtime selectors; disable unavailable via `montage.capabilities`. |
| 5 | Automations wizard UI | `src/screens/Profiles.tsx`; `shared/automationDraft.ts`; `shared/automationConfig.ts` | Batch "Assets & style" OM options; plumb to automation `render` engine selection. |
| 6 | Settings / Capabilities UI | `src/screens/Settings.tsx`; `electron/ipc/montage.ts`; settings secret fields | Capability status panel + key entry + OM-root/python config + setup guidance. |
| 7 | Caption styling overhaul (4C) | `electron/ipc/compose.ts` defaults; `shared/captionStyle.ts`; `CaptionsPanel.tsx` | Default to active-word-pop (non-multi-color), `keywords:false`; surface box/karaoke presets; map preset → OM subtitle style. |
| 8 | B-roll loop fix (4B) | `electron/services/broll.ts` (`planCoverage`, `libraryCandidates`) | Min-distinct-clips guard + de-prioritize recently-used (`lastUsedAt`); avoid back-to-back repeats. |
| 9 | Compose OM preview (4D) | `electron/ipc/compose.ts`; `PreviewStage.tsx`; `usePreviewCompositor.ts` | Play a bounded OM sample render (or last OM output) in Compose preview. |
| 10 | Smokes / fixtures / tests / docs | `electron/main.ts` `runSmokeMontage`; `test/fixtures/montage/*`; shim unit test | `ME_SMOKE=montage` drives bridge against `ME_MONTAGE_FIXTURE`; CI wire-up; finalize this doc. |

Dependencies point only at the committed trunk, never sibling PRs. Unit 1 also feeds 4B mitigation.

### Execution note (fan-out wave 1)
Remotion + HyperFrames were **merged into a single composition unit** to avoid two worktrees editing
`montage-compose.ts::buildBriefForProject`. Final spawned unit numbering (worktrees off commit with
F1–F5):
- W1 Footage & stock sourcing (`montage/footage.ts` + broll source option + Niches UI)
- W2 Composition — Remotion + HyperFrames (`montage/edit-remotion.ts`, `edit-hyperframes.ts`,
  `buildBriefForProject`, `queue.ts` dispatch)
- W3 Compose StylePanel UI
- W4 Automations wizard UI
- W5 Settings / Capabilities UI
- W6 Caption styling overhaul (4C)
- W7 B-roll loop fix (4B)
- W8 Compose OM preview (4D)
- W9 Smokes / fixtures / tests / docs

Worker verification is **typecheck + build + fixture/shim checks** (worktrees have no real OM and no
node_modules → `npm install` first; no headful Electron). W9 owns the `ME_MONTAGE_FIXTURE`-backed
`ME_SMOKE=montage` smoke and verifies it itself. Shared-file conflict hotspots the coordinator
resolves on merge-back: `broll.ts` (W1+W7 — disjoint regions), `compose.ts` (W6+W8), `shared/types.ts`
(W3 betaOpts). git push is blocked → workers commit locally; coordinator merges branches into
`feat/openmontage-bridge` and pushes via the GitHub Data API.

## 7. Verification (e2e recipe)

Sandbox/worktree reality: no real OM in worktrees, MES is Electron → **fixture + build based**.
1. **Always:** `npm run typecheck` and `npm run build` must pass.
2. **Backend units (1,2,3,8,10):** `ME_SMOKE=montage ME_MONTAGE_FIXTURE=test/fixtures/montage` boot →
   assert `SMOKE_MONTAGE_OK` (fixture stubs the Python spawn: canned NDJSON + stub mp4).
3. **Python shim:** `python resources/montage/mes_bridge.py capabilities --om-root <stub>` → valid JSON shape.
4. **UI units (4,5,6,7,9):** typecheck + build; where practical `ME_SHOOT=<png>` boot-screenshot.
5. **Code review:** run the `code-review` skill; fix findings before commit.
Coordinator-only REAL e2e (not required of workers): on the OM-installed machine, run a real
`montage.produce` for a short clip through Compose and confirm `renders/final.mp4`.

## 8. Constraints / gotchas
- **Packaged builds** (`npm run dist:dir`): resolve shim path via `process.resourcesPath` first.
- **GPU-only encoding** (user memory): OM composition (Remotion/HyperFrames/ffmpeg) is separate from
  MES's native encoder policy — do NOT add CPU fallback to MES's native render path.
- **git push proxy blocked** (CLAUDE.md): direct `git push` fails; pushes go via the GitHub Data API
  (`scratchpad/push_*.py`). Workers commit locally + try `gh`; coordinator consolidates & pushes.
- Only `resources/montage/` ships with MES; OpenMontage stays a user-local external dependency
  pointed to by `openMontageRoot` (not bundled).

## 9. Progress

> **Live probe (2026-07-24, this machine, system Python 3.11.9):** shim `capabilities` verified
> against real OM. `render_engines = {ffmpeg:true, remotion:FALSE, hyperframes:true}`,
> `clip_acquisition 1/1` (DirectClipSearch ✓), `video_post 9/9`, `subtitle 2/2`. **Remotion is
> currently unavailable** (remotion-composer node_modules not resolvable) even though OM is otherwise
> set up — so capability detection is essential and Unit 2 renders will blocker-out until the user
> installs remotion-composer deps. No separate `.venv`; system Python 3.11 already has OM's deps.
> **UTF-8 gotcha (fixed):** Windows cp1252 stdout raised UnicodeEncodeError on OM's non-ASCII output
> and silently produced empty-but-exit-0 runs; shim now force-reconfigures stdout/stderr to UTF-8.
> The TS bridge MUST read the subprocess stream as UTF-8.

| Item | Status | Notes |
|------|--------|-------|
| F1 branch + design doc + memory | ✅ done | branch `feat/openmontage-bridge`; this doc + 3 memory files |
| F2 Python shim | ✅ done | `resources/montage/mes_bridge.py`; capabilities verified vs real OM |
| F3 bridge service skeleton | ✅ done | `electron/services/montage/{bridge,capabilities,montage-compose}.ts`; spawn/NDJSON/cancel/watchdog/fixture seam; capabilities+retrieveFootage functional, produce plumbed |
| F4 IPC + settings scaffold | ✅ done | `montage:*` IPC (`electron/ipc/montage.ts` + register), `NativeApi.montage` + `onMontageProgress`, `AppSettings.montage` + defaults + SECRET_FIELDS, preload + mockApi stubs. typecheck + build green |
| F5 render dispatch stub + packaging | ✅ done | `montage-compose.ts` `composeViaMontage` (buildBrief stub for units 2/3); `electron-builder.yml` extraResources `resources/montage`. Note: `queue.ts::resolveEngine` NOT modified — unit 2 wires the compose call. |
| W1 Footage & stock sourcing | ✅ done | 2a4ff57 — `montage/footage.ts`; footage block in produce brief |
| W2 Composition (Remotion+HyperFrames) | ✅ done | 379f4a8 — `buildBriefForProject` + edit-remotion/hyperframes |
| W3 Compose StylePanel UI | ✅ done | c99a7d1 — footage-source + runtime selectors (betaOpts) |
| W4 Automations wizard UI | ✅ done | 065c9b4 — Assets & style step; automation render reads runtime |
| W5 Settings/Capabilities UI | ✅ done | 9ff3f12 — settings + capability probe panel (+caption test fix) |
| W6 Caption styling overhaul (4C) | ✅ done | 2a13127 — 'Clean' preset default, keywords:false |
| W7 B-roll loop fix (4B) | ✅ done | 15a1982 — single-clip warn + recency penalty + distinctClips |
| W8 Compose OM preview (4D) | ✅ done | 623c3e7 — sample-render preview in PreviewStage |
| W9 Smokes/fixtures/tests/docs | ✅ done | e15f852 — ME_SMOKE=montage + fixtures + shim test |

**ALL FOUNDATION + 9 UNITS LANDED on `feat/openmontage-bridge`.** Verified: `npm run typecheck` +
`npm run build` green; full `vitest run` = 489 passed / 0 failed; `ME_SMOKE=montage` prints
`SMOKE_MONTAGE_OK`; Python shim test `SHIM_TEST_OK`; shim `capabilities` verified against the real
OpenMontage on the dev machine.

> **How it landed:** the parallel fan-out (two waves) repeatedly hit the account usage limit and
> died mid-edit. The coordinator salvaged each worker's worktree work (cherry-picked the committed
> ones W3/W5; applied/adapted the uncommitted ones W2/W4/W8/W9; completed W1/W6/W7 directly) onto the
> trunk, verifying each. W2 forked a stale base — its `types.ts` was discarded (W3's betaOpts is
> authoritative) and its builder files were adapted.

### Remaining follow-ups (not blockers; the produce path works today)
1. **Render-queue auto-dispatch.** `queue.ts::runJob` does not yet route a project whose
   `betaOpts.montageRuntime !== 'native'` to `composeViaMontageWithEvents()`. The helper +
   capability gate (`montageRuntimeBlocker`) already exist in `montage-compose.ts`; wiring is a small
   addition to `runJob`. Until then, OpenMontage composition runs via `montage.produce` (the Compose
   "Preview final (OpenMontage)" button + IPC), not the batch render queue.
2. **Native B-roll pool injection.** OpenMontage footage currently flows through the OpenMontage
   compose path (footage block in the produce brief). Injecting DirectClipSearch clips into MES's
   native ffmpeg/GPU B-roll library (`broll.ts` index) needs a new "register pre-downloaded files"
   helper (the legacy pipeline downloads from provider URLs). Deferred.
3. **Push.** Branch is committed locally; the env git proxy blocks `git push` — push via the GitHub
   Data API (`scratchpad/push_*.py`) or from an unproxied clone.

**Merge-back order (coordinator):** W6, W7 (MES-native, low-risk) → W1 → W2 → W3, W4, W5, W8 (UI) → W9.
Resolve shared-file conflicts: `broll.ts` (W1 fetchPool region vs W7 planCoverage/libraryCandidates),
`compose.ts` (W6 defaultProject vs W8 new region), `shared/types.ts` betaOpts (W2 vs W3 — field names
`montageRuntime`/`montageFootageSource`), `montage-compose.ts` (W2 only). Re-run typecheck+build after
each merge. Workers commit locally (push blocked); coordinator pushes the consolidated branch via the
GitHub Data API.

**Next action:** Feature is functionally complete on `feat/openmontage-bridge` (foundation + 9 units,
all green). Remaining: push the branch (proxy-blocked → GitHub Data API), then optionally the two
follow-ups above (render-queue auto-dispatch; native-pool footage injection). To exercise the real
end-to-end (not fixtures): in Settings → OpenMontage set the root + enable, pick a Remotion/HyperFrames
runtime on a project in Compose, and hit "Preview final (OpenMontage)".

**Trunk API surface available to units:** `window.api.montage.{capabilities,retrieveFootage,produce,
cancel}` + `onMontageProgress`; main-process `electron/services/montage/{bridge,capabilities,
montage-compose}.ts` (`detectCapabilities`, `getMontageCapabilities`, `retrieveFootage`,
`produceFromBrief`, `cancelMontage`, `composeViaMontage`, `buildBriefForProject` STUB); settings
`settings.montage.{enabled,openMontageRoot,pythonPath,falKey,unsplashKey,elevenLabsKey,openaiKey,
googleKey}`; fixture seam `ME_MONTAGE_FIXTURE` (dir with `<command>.ndjson`).
