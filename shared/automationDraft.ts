import type { AppSettings, AutomationGoal, AutomationJob, AutomationJobDraft, AutomationJobConfig, SourceChannel } from './types'
import { DEFAULT_AUTOMATION_RULES, DEFAULT_AUTOMATION_STYLE, normalizeAutomationConfig } from './automationConfig'

export interface AutomationDraftState {
  id: string
  draft: AutomationJobDraft
}

export type AutomationDraftAction =
  | { type: 'new'; settings?: Pick<AppSettings, 'background' | 'transcription' | 'autoScrape'> }
  | { type: 'duplicate'; job: AutomationJob }
  | { type: 'change-source'; source?: SourceChannel }
  | { type: 'patch-config'; patch: Partial<AutomationJobConfig> }
  | { type: 'patch-rules'; patch: Partial<AutomationJobConfig['rules']> }
  | { type: 'patch-style'; patch: Partial<AutomationJobConfig['styleConfig']> }
  | { type: 'goal'; goal: AutomationGoal }
  | { type: 'clear-assets' }
  | { type: 'reset-source-selections' }

function id(): string {
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function createDefaultDraft(settings?: Pick<AppSettings, 'background' | 'transcription' | 'autoScrape'>): AutomationDraftState {
  const styleConfig = { ...DEFAULT_AUTOMATION_STYLE }
  const config = normalizeAutomationConfig({
    sourceKind: 'saved-source', sourceId: '', sourceUrl: '', sourceName: '', sourceOrder: 'Latest', sourceCount: 3,
    selectedVideoIds: [], localMediaPaths: [], assetPaths: [], style: styleConfig.videoStyle, captionPreset: styleConfig.captionPreset,
    aspectRatios: [styleConfig.aspectRatio], styleConfig,
    rules: { ...DEFAULT_AUTOMATION_RULES, captions: !!settings?.transcription.apiKey.trim(), maxRetries: Math.max(0, settings?.autoScrape.retries ?? DEFAULT_AUTOMATION_RULES.maxRetries) },
    notify: { desktop: !!settings?.background.notifications, webhook: !!settings?.background.webhook, sound: !!settings?.background.notifications, email: false }, execution: 'local'
  })
  return { id: id(), draft: { name: '', goal: 'source-to-export', config } }
}

export function automationDraftReducer(state: AutomationDraftState, action: AutomationDraftAction): AutomationDraftState {
  if (action.type === 'new') return createDefaultDraft(action.settings)
  if (action.type === 'duplicate') return { id: id(), draft: { name: action.job.name, goal: action.job.goal, config: normalizeAutomationConfig(action.job.config) } }
  if (action.type === 'change-source') return {
    ...state,
    draft: { ...state.draft, config: { ...state.draft.config, sourceId: action.source?.id || '', sourceUrl: action.source?.url || '', sourceName: action.source?.name || action.source?.handle || '', selectedVideoIds: [] } }
  }
  if (action.type === 'patch-config') return { ...state, draft: { ...state.draft, config: normalizeAutomationConfig({ ...state.draft.config, ...action.patch }) } }
  if (action.type === 'patch-rules') return { ...state, draft: { ...state.draft, config: normalizeAutomationConfig({ ...state.draft.config, rules: { ...state.draft.config.rules, ...action.patch } }) } }
  if (action.type === 'patch-style') return { ...state, draft: { ...state.draft, config: normalizeAutomationConfig({ ...state.draft.config, styleConfig: { ...state.draft.config.styleConfig, ...action.patch } }) } }
  if (action.type === 'goal') return { ...state, draft: { ...state.draft, goal: action.goal } }
  if (action.type === 'clear-assets') return { ...state, draft: { ...state.draft, config: { ...state.draft.config, assetPaths: [] } } }
  if (action.type === 'reset-source-selections') return { ...state, draft: { ...state.draft, config: { ...state.draft.config, sourceUrl: '', selectedVideoIds: [], localMediaPaths: [] } } }
  return state
}
