import type { AutomationGoal, AutomationJobConfig, AutomationWorkflowStep } from './types'

export interface AutomationGoalDefinition {
  id: AutomationGoal
  title: string
  description: string
  outcome: string
  available: boolean
  availabilityNote?: string
}

export const AUTOMATION_GOALS: AutomationGoalDefinition[] = [
  { id: 'talkingphotos-video', title: 'Create TalkingPhotos videos', description: 'Use downloaded or local audio with one generated Human character, then segment and merge automatically.', outcome: 'Finished TalkingPhotos videos downloaded locally', available: true },
  { id: 'source-to-export', title: 'Source to finished video', description: 'Download, caption, style, render, check, and export.', outcome: 'Finished videos ready in your output folder', available: true },
  { id: 'batch-source', title: 'Batch-process a channel', description: 'Run the same production recipe across several source videos.', outcome: 'A completed batch with item-by-item results', available: true },
  { id: 'download-edit', title: 'Download and edit videos', description: 'Bring selected source videos into projects and apply your assets and style.', outcome: 'Edited and exported videos', available: true },
  { id: 'transcribe-subtitle', title: 'Transcribe and subtitle', description: 'Create styled captions and export captioned videos.', outcome: 'Captioned videos ready to review', available: true },
  { id: 'apply-style', title: 'Apply a saved editing style', description: 'Use one consistent visual and caption recipe across a batch.', outcome: 'Consistently branded exports', available: true },
  { id: 'review-export', title: 'Prepare for review and export', description: 'Finish existing projects, validate outputs, and organize result files.', outcome: 'Quality-checked exports', available: false, availabilityNote: 'Needs an existing-project source adapter' },
  { id: 'long-to-shorts', title: 'Turn long videos into shorts', description: 'Find highlights and create short vertical clips.', outcome: 'A set of short-form clips', available: false, availabilityNote: 'Needs timeline cutting and highlight scoring' },
  { id: 'multi-platform', title: 'Repurpose for every platform', description: 'Produce 16:9, 9:16, and 1:1 variants with smart reframing.', outcome: 'Platform-ready variants', available: false, availabilityNote: 'Needs multi-output reframing' },
  { id: 'images-to-video', title: 'Create a video from images', description: 'Build a complete video from selected images and audio.', outcome: 'A finished image-led video', available: false, availabilityNote: 'Audio/source upload flow is not available yet' }
]

const BASE: Array<Omit<AutomationWorkflowStep, 'id' | 'jobId' | 'ord' | 'status' | 'progress' | 'attempts' | 'maxAttempts'>> = [
  { key: 'preflight', label: 'Preflight', description: 'Check source, credentials, assets, storage, and execution requirements.', runsOn: 'local', optional: false },
  { key: 'discover', label: 'Select content', description: 'Read the source and apply your video-selection rules.', runsOn: 'local', optional: false },
  { key: 'download', label: 'Download', description: 'Download selected video audio and reuse completed downloads.', runsOn: 'local', optional: false },
  { key: 'prepare', label: 'Build projects', description: 'Create project timelines and attach reusable visual assets.', runsOn: 'local', optional: false },
  { key: 'transcribe', label: 'Transcribe', description: 'Create a timed transcript for captions and content-aware editing.', runsOn: 'online-service', optional: true },
  { key: 'edit', label: 'Apply style', description: 'Apply caption, motion, B-roll, and editing-style rules.', runsOn: 'local', optional: false },
  { key: 'render', label: 'Render videos', description: 'Produce each video and checkpoint every completed output.', runsOn: 'local', optional: false },
  { key: 'quality-check', label: 'Quality check', description: 'Verify output files and compare results with the selected goal.', runsOn: 'local', optional: false },
  { key: 'complete', label: 'Finish & notify', description: 'Save the result summary and send enabled notifications.', runsOn: 'local', optional: false }
]

// 'transcript-tts' mode transcribes the downloaded audio directly inside the
// talkingphotos step (electron/services/automation-supervisor.ts) rather than
// through BASE's generic transcribe step, which requires a local Project checkpoint
// TalkingPhotos automation never creates. The workflow shape stays the same for
// every talkingPhotos.mode.
const TALKINGPHOTOS: typeof BASE = [
  BASE[0],
  BASE[1],
  BASE[2],
  { key: 'talkingphotos', label: 'Create TalkingPhotos videos', description: 'Submit script/audio, render ordered segments, merge, and download final outputs.', runsOn: 'cloud', optional: false },
  BASE[8]
]

export function isAutomationGoalAvailable(goal: AutomationGoal): boolean {
  return AUTOMATION_GOALS.some((g) => g.id === goal && g.available)
}

export function buildAutomationWorkflow(jobId: string, config: AutomationJobConfig, goal?: AutomationGoal): AutomationWorkflowStep[] {
  return (goal === 'talkingphotos-video' ? TALKINGPHOTOS : BASE)
    .filter((s) => s.key !== 'transcribe' || config.rules.captions)
    .map((step, ord) => ({
      ...step,
      label: step.key === 'download' && config.sourceKind === 'local-files' ? 'Import media' : step.label,
      description: step.key === 'download' && config.sourceKind === 'local-files' ? 'Validate selected local media and register reusable inputs.' : step.description,
      id: `${jobId}-${step.key}`,
      jobId,
      ord,
      status: 'pending',
      progress: 0,
      attempts: 0,
      maxAttempts: Math.max(1, config.rules.maxRetries + 1)
    }))
}

export function workflowProgress(steps: AutomationWorkflowStep[]): number {
  if (!steps.length) return 0
  const done = steps.reduce((sum, step) => {
    if (step.status === 'completed' || step.status === 'skipped' || step.status === 'warning') return sum + 100
    return sum + Math.max(0, Math.min(100, step.progress))
  }, 0)
  return Math.round(done / steps.length)
}

export function formatGoal(goal: AutomationGoal): string {
  return AUTOMATION_GOALS.find((g) => g.id === goal)?.title ?? 'Automation job'
}
