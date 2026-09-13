# Current Objective

Ensure all daily automation video production strictly adheres to the editorial quality gate in `AGENTS.md`, `VIDEO_EDITING_HANDBOOK.md`, and `VIDEO_MAKER_MASTER_PLANNER.md`. Legacy shortcut recipes (downloading third-party audio via yt-dlp, looping static images with `render-ramani.mjs`, and unedited component merges) have been removed, retired, and strictly forbidden.

# Retired Legacy Batch Logs Notice

> [!CAUTION]
> All prior daily batch entries from August and September 2026 (2026-08-31, 2026-09-05, 2026-09-08, 2026-09-12, and 2026-09-14) have been removed from this log.
>
> They documented legacy shortcut workflows that do NOT meet current channel standards:
> 1. Downloading competitor/reference YouTube audio via `yt-dlp` instead of writing an original script and generating original narration.
> 2. Looping static images via `render-ramani.mjs` for Psyche Noir and Discipline Doctrine.
> 3. Exporting raw TalkingPhotos avatar merges or raw MindCipher B-roll without an editorial second assembly pass.
>
> **Future agents must NEVER follow or imitate these retired shortcut recipes.** Every daily production run must adhere strictly to `VIDEO_EDITING_HANDBOOK.md` and produce an authored `editing/edit-plan.json` with multi-family media cuts.

# Standalone Jobs Completed (Video Express Integration)

- The 2026-09-05 standalone job is complete under `D:\MentalEmpire-Production\2026-09-05\BruceLee-Tao-JKD-VEX`: all 18 supplied scenes ran through the HAR-matched `generated-still` Video Express workflow as 10-second 1080x1920/24 fps clips.
- A separate two-item action/text pilot passed full decode and retained-frame inspection before the production batch.
- The 18 transcript-aligned cuts range from 3.40s to 10.00s, are snapped to 24 fps frame boundaries, and preserve the final music tail under scene 18.
- One known transient Video Express service fault exhausted scene 15 and affected scenes 16-18; all four had null video UUIDs, so only their attempt counters/errors were atomically reset before identical successful resubmission. No uncertain submission was retried.
- `BruceLee-Tao-of-JKD-9x16.mp4` is 1080x1920 H.264/AAC, exactly 154.032s, passes full `-xerror` decode, has no detected black segment, and passed one retained five-frame sheet per source clip plus all-scene midpoint inspection after assembly.
- All three supplied inputs are readable: 18 ordered PNG stills, the 156.630-second stereo MP3 master, and the timestamped transcript.
- All stills are 941x1672 portrait images and their numbered filenames follow the transcript's narrative order.
- The user approved the bounded generated-still runner design and authorized Video Express generation capacity.
- HAR-matched generated-still payload, manifest normalization, image checkpoint, preview URL, and uncertain-submit behavior are covered by 17/17 passing focused tests; runner/config syntax checks pass.
- The existing direct-upload manifest fingerprint remains compatible with its completed state and all prior direct clips/final partial remain untouched.
- The source-audio workspace contains a 31-segment final-timeline map, allowing clip cuts on exact narration beats instead of estimates from paragraph timestamps.
- Video Express read-only preflight passed on 2026-09-02: login succeeded, library `4` is available, My AI Images/My AI Videos exist, the queue is 0/5, and no generation capacity was consumed by preflight.

# 2026-09-02 clean-room run (Video Express Deliverable)

Job root: `D:\MentalEmpire-Production\2026-09-02\BruceChaCha-VEX-v2\`
Remote folder: `ME-20260902-BruceChaCha-VEX-v2`

- The user asked to restart this deliverable from scratch. The two earlier local roots were renamed unread to `_OLD-DO-NOT-USE-BruceLeeChaCha1958*`; nothing in them was opened or reused. Their remote folders were left alone.
- The new HAR (`vea_new_video_workflow.har`) confirms the generated-still contract the runner already implements: `upload/4` -> `ai/api/generate_image_consistent_character` (`type=human`, `aspect=9:16`) -> `ai/api/image2video` with `uuid=<still uuid>`, `mediaId=0`, `enhanceVideoPrompt=0`. No code changes were needed.
- A 2-item pilot (`BruceChaCha-VEX-pilot`) passed and exposed one prompt defect: naming body parts in the camera move ("zooms in on his feet and torso") drove the framing off the subject by 9s. All 19 video prompts use gentle moves instead.
- 19 clips generated from the 18 stills. Image 07 supplies two beats because the 1958 half of the narration runs 80.6s against seven images at the 10s clip ceiling.
- Five items hit a transient service error (`Error. Please try again later.`) and `s15-paid-first` exhausted three attempts, stopping the runner. None had a `generationUuid`, so only their attempt counters were reset before resuming; all five then submitted cleanly. This was service-side, not prompt moderation.
- `assemble.mjs` derives each trim from frame-snapped boundaries. Using raw plan durations drifts ~200ms late by the last cut because ffmpeg rounds `-t` up to the next frame.

# Current Problem

None open. The Video Express deliverable passed the gate.

# Relevant Files

- `D:\MentalEmpire-Production\2026-09-05\BruceLee-Tao-JKD-VEX\`
- `D:\MentalEmpire-Production\2026-09-05\BruceLee-Tao-JKD-VEX\final\BruceLee-Tao-of-JKD-9x16.mp4`
- `docs/DAILY-VIDEO-PRODUCTION-RUNBOOK.md`
- `.agents/skills/mental-empire-daily-production/SKILL.md`
- `scripts/production/`
- `scripts/production/talkingphotos-media.mjs`
- `scripts/production/talkingphotos-scheduler.mjs`
- `docs/VIDEOEXPRESS-INTEGRATION.md`
- `scripts/production/videoexpress-config.mjs`
- `scripts/production/run-videoexpress.mjs`
- `test/unit/production/videoexpress-config.test.mjs`
- `test/unit/production/mental-empire-skill-routing.test.mjs`
- `test/unit/production/talkingphotos-media.test.mjs`
- `test/unit/production/talkingphotos-scheduler.test.mjs`
- `D:\talkingphotos-session\session-3\docs\API-DELTAS.md`

# Do Not Modify

- Existing user changes in `src/features/automation/TemplateSheet.tsx` and `test/unit/automation/template-sheet.test.ts`.
- Reusable Ramani reference images and local B-roll library.
- Live app settings or user database.

# Verification

- Video Express preflight: `node scripts/production/run-videoexpress.mjs --preflight` reports login succeeded, library `4`, AI image/video folders present, active queue `0`, and maximum concurrency `5`.
- HAR contract regression: `node --test test/unit/production/talkingphotos-config.test.mjs` passes 6/6 and locks `high_quality`, `motionId: 0`, the generated character/driving image, the 60-second part cap, and rejection of legacy normal-motion state.
- Split validator regression: `node --test test/unit/production/talkingphotos-media.test.mjs test/unit/production/talkingphotos-config.test.mjs` passes 9/9, including the real sub-1-MiB 60-second MP3 boundary.
- Concurrency regression: all three production test files pass 12/12, including remote-count lag and locally full/overfull queue cases; runner and scheduler syntax checks pass.
- Video Express configuration and production routing tests pass, including the live userscript payload, path containment, upload/output collision rejection, five-job scheduling, login CSRF parsing, explicit retry boundaries, MP4 header validation, and uncertain-submission skill guidance.
- Video Express direct preflight logs in successfully without printing credentials and reports library `4`, 62 folders, both AI media folders, active queue `0`, and maximum concurrency `5`.
