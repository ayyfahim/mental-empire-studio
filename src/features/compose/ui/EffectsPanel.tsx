import { useState } from 'react'
import type { BetaVideoOpts } from '@shared/types'
import { asBetaOpts } from '@shared/types'
import { buildMasterPrompt, validateEffectPlan } from '@shared/effectPlan'
import { useData } from '../../../store/useData'
import { Banner, Btn, FieldLabel } from '../../../components/ui/kit'

/* Effects panel — the advanced effect-plan override: hand-written or LLM-generated
   JSON that replaces the selected style's rule engine for transitions/text effects. */

export function EffectsPanel(): JSX.Element {
  const project = useData((s) => s.activeProject)
  const transcript = useData((s) => s.transcript)
  const setCaptions = useData((s) => s.setCaptions)
  const o = asBetaOpts(project?.betaOpts)
  const patch = (p: Partial<BetaVideoOpts>): void => {
    void setCaptions({ betaOpts: { ...o, ...p } })
  }
  const [status, setStatus] = useState('')
  const [statusKind, setStatusKind] = useState<'info' | 'success' | 'error'>('info')
  const [generating, setGenerating] = useState(false)

  const copyPrompt = (): void => {
    void navigator.clipboard.writeText(buildMasterPrompt(transcript, o.style))
    setStatusKind('info')
    setStatus('Master prompt copied — paste into ChatGPT/Gemini, then paste the JSON back here.')
  }
  const genGroq = async (): Promise<void> => {
    if (!project || generating) return
    setGenerating(true)
    setStatusKind('info')
    setStatus('Generating with Groq…')
    try {
      const json = await window.api.effects.generate(project.id, o.style)
      patch({ effectPlanJson: json })
      setStatusKind('success')
      setStatus('Generated ✓')
    } catch (e) {
      setStatusKind('error')
      setStatus(`Failed: ${(e as Error).message}`)
    } finally {
      setGenerating(false)
    }
  }
  const planSummary = ((): string => {
    if (!o.effectPlanJson.trim()) return ''
    const { plan, warnings } = validateEffectPlan(o.effectPlanJson, project?.durationSec ?? 60)
    return `${plan.transitions.length} transitions · ${plan.textEffects.length} text effects${warnings.length ? ` · ${warnings.length} adjusted` : ''}`
  })()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
        Override the <b style={{ color: '#cdd2da' }}>{o.style}</b> style's automatic transitions and text effects with a custom
        effect plan. Leave empty to keep the style defaults.
      </div>
      <div style={{ display: 'flex', gap: 7 }}>
        <Btn size="sm" style={{ flex: 1 }} onClick={copyPrompt}>Copy master prompt</Btn>
        <Btn size="sm" variant="soft" style={{ flex: 1 }} disabled={generating} onClick={() => void genGroq()}>{generating ? 'Generating…' : '✦ Auto-generate (Groq)'}</Btn>
      </div>
      <div>
        <FieldLabel>Effect plan JSON</FieldLabel>
        <textarea
          className="ed-input"
          value={o.effectPlanJson}
          onChange={(e) => patch({ effectPlanJson: e.target.value })}
          placeholder="Paste an effect-plan JSON, or auto-generate."
          rows={7}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5 }}
        />
      </div>
      {planSummary && <Banner kind="success">{planSummary}</Banner>}
      {status && <Banner kind={statusKind}>{status}</Banner>}
    </div>
  )
}
