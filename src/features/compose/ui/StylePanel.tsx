import type { BetaVideoOpts, LookAdjust, MotionPreset, VideoStyle } from '@shared/types'
import { asBetaOpts } from '@shared/types'
import { useData } from '../../../store/useData'
import { Chip, FieldLabel, Section, Seg, SliderRow, ToggleRow, Btn } from '../../../components/ui/kit'

/* Style panel — the project's visual identity: video look (grade + transitions +
   caption feel), visual source (stills vs auto b-roll), hook card, overlays, zoom. */

const STYLES: Array<{ id: VideoStyle; tip: string; bg: string }> = [
  { id: 'None', tip: 'No grade, transitions, or text effects', bg: 'var(--bg-inset)' },
  { id: 'Cinematic', tip: 'Warm slow-zoom grade, fade transitions, elegant type', bg: 'linear-gradient(135deg,#26333a,#1d1714)' },
  { id: 'Intense', tip: 'Punchy high-contrast grade, fast cuts, bold caps', bg: 'linear-gradient(135deg,#3a1d25,#141820)' },
  { id: 'Heartfelt', tip: 'Soft warm grade, gentle dissolves and motion', bg: 'linear-gradient(135deg,#3a2b24,#15171d)' },
  { id: 'Clean', tip: 'Neutral grade, smooth minimal slides', bg: 'linear-gradient(135deg,#26313a,#15171d)' }
]

function percent(n: number): string {
  return `${Math.round(n * 100)}%`
}

export function StylePanel(): JSX.Element {
  const project = useData((s) => s.activeProject)
  const setCaptions = useData((s) => s.setCaptions)
  const setLook = useData((s) => s.setLook)
  const setMedia = useData((s) => s.setMedia)
  const setMotionPreset = useData((s) => s.setMotion)
  const o = asBetaOpts(project?.betaOpts)
  const patch = (p: Partial<BetaVideoOpts>): void => {
    void setCaptions({ betaOpts: { ...o, ...p } })
  }
  const adjust = project?.lookAdjust ?? {}
  const color = adjust.colorBalance ?? {}
  const setAdjust = (p: LookAdjust): void => {
    void setLook({ adjust: { ...adjust, ...p, colorBalance: p.colorBalance ?? adjust.colorBalance } })
  }
  const setColor = (p: NonNullable<LookAdjust['colorBalance']>): void => {
    void setLook({ adjust: { ...adjust, colorBalance: { ...color, ...p } } })
  }

  const motionPreset: MotionPreset = project?.motionPreset ?? (project?.kenBurns ? 'subtle' : 'off')
  // Zoom effects only apply when motion isn't 'off' — enabling one auto-arms motion.
  const armMotion = (): void => { if (motionPreset === 'off') void setMotionPreset('subtle') }
  const zoomOnEmphasis = o.autoZoom.atKeyPhrases || !!project?.punchZoom
  const setZoomOnEmphasis = (on: boolean): void => {
    patch({ autoZoom: { ...o.autoZoom, atKeyPhrases: on } })
    if (!on && project?.punchZoom) void setMedia({ punchZoom: false })
    if (on) armMotion()
  }
  const setZoomAtStart = (on: boolean): void => {
    patch({ autoZoom: { ...o.autoZoom, atStart: on } })
    if (on) armMotion()
  }
  const broll = o.broll.enabled

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <FieldLabel>Video look — grade, transitions & caption feel</FieldLabel>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 }}>
          {STYLES.map((s) => {
            const on = o.style === s.id
            return (
              <button
                key={s.id}
                type="button"
                title={s.tip}
                onClick={() => patch({ style: s.id })}
                className="me-btn ed-focus"
                style={{
                  textAlign: 'left',
                  border: on ? '1px solid var(--accent)' : '1px solid var(--border-2)',
                  background: s.bg,
                  borderRadius: 10,
                  padding: 9,
                  cursor: 'pointer',
                  minHeight: 52,
                  boxShadow: on ? '0 0 0 2px var(--accent-soft)' : 'none'
                }}
              >
                <div style={{ fontSize: 11.5, fontWeight: 700, color: on ? 'var(--text-strong)' : '#aab0bb' }}>{s.id}</div>
                <div style={{ fontSize: 9.5, color: on ? '#cdd2da' : 'var(--text-dim)', lineHeight: 1.3, marginTop: 3 }}>{s.tip}</div>
              </button>
            )
          })}
        </div>
      </div>

      <div>
        <FieldLabel>Visual source</FieldLabel>
        <Seg
          grow
          value={broll ? 'broll' : 'images'}
          onChange={(v) => patch({ broll: { ...o.broll, enabled: v === 'broll' } })}
          options={[
            { value: 'images', label: 'Images', title: 'Use the still images on the timeline' },
            { value: 'broll', label: 'Auto B-roll', title: 'Themed stock footage picked from the transcript' }
          ]}
        />
        {broll && (
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            {([
              { d: 'full', tip: 'B-roll covers the entire video' },
              { d: 'sparse', tip: 'A clip every ~30 seconds' },
              { d: 'keywords', tip: 'Cut in on detected topic keywords' }
            ] as const).map(({ d, tip }) => (
              <Chip key={d} title={tip} on={o.broll.density === d} onClick={() => patch({ broll: { ...o.broll, density: d } })}>
                {d[0].toUpperCase() + d.slice(1)}
              </Chip>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        <ToggleRow
          label="Hook (intro card)"
          hint="Big text line over the first ~2.5 seconds"
          on={o.hook.enabled}
          onToggle={() => patch({ hook: { ...o.hook, enabled: !o.hook.enabled } })}
        />
        {o.hook.enabled && (
          <input
            className="ed-input ed-fade"
            value={o.hook.text}
            onChange={(e) => patch({ hook: { ...o.hook, text: e.target.value } })}
            placeholder="Auto from transcript — or type a hook"
          />
        )}
        <ToggleRow
          label="Auto-highlight keywords"
          hint="Emphasize key words in captions automatically"
          on={o.autoHighlight}
          onToggle={() => patch({ autoHighlight: !o.autoHighlight })}
        />
        <ToggleRow
          label="Zoom in at the start"
          hint="Slow push-in on each new visual"
          on={o.autoZoom.atStart}
          onToggle={() => setZoomAtStart(!o.autoZoom.atStart)}
        />
        <ToggleRow
          label="Zoom on emphasized words"
          hint="Quick punch-in on highlighted transcript words"
          on={zoomOnEmphasis}
          onToggle={() => setZoomOnEmphasis(!zoomOnEmphasis)}
        />
      </div>

      <div>
        <FieldLabel>Edge gradient overlay</FieldLabel>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {(['bottom', 'top', 'left', 'right'] as const).map((e) => (
            <Chip key={e} on={o.overlay[e]} onClick={() => patch({ overlay: { ...o.overlay, [e]: !o.overlay[e] } })}>
              {e[0].toUpperCase() + e.slice(1)}
            </Chip>
          ))}
        </div>
        <SliderRow
          label="Intensity"
          value={o.overlay.intensity ?? 50}
          min={0}
          max={100}
          format={(v) => `${v}%`}
          onChange={(v) => patch({ overlay: { ...o.overlay, intensity: v } })}
          debounceMs={150}
        />
      </div>

      <Section label="Fine-tune colour" defaultOpen={false}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          <SliderRow label="Brightness" value={adjust.brightness ?? 0} min={-0.2} max={0.2} step={0.01} format={(v) => v.toFixed(2)} onChange={(v) => setAdjust({ brightness: v })} debounceMs={150} />
          <SliderRow label="Contrast" value={adjust.contrast ?? 1} min={0.7} max={1.5} step={0.01} format={(v) => v.toFixed(2)} onChange={(v) => setAdjust({ contrast: v })} debounceMs={150} />
          <SliderRow label="Saturation" value={adjust.saturation ?? 1} min={0} max={2} step={0.01} format={(v) => v.toFixed(2)} onChange={(v) => setAdjust({ saturation: v })} debounceMs={150} />
          <SliderRow label="Red" value={color.r ?? 0} min={-0.2} max={0.2} step={0.01} format={(v) => v.toFixed(2)} onChange={(v) => setColor({ r: v })} debounceMs={150} />
          <SliderRow label="Green" value={color.g ?? 0} min={-0.2} max={0.2} step={0.01} format={(v) => v.toFixed(2)} onChange={(v) => setColor({ g: v })} debounceMs={150} />
          <SliderRow label="Blue" value={color.b ?? 0} min={-0.2} max={0.2} step={0.01} format={(v) => v.toFixed(2)} onChange={(v) => setColor({ b: v })} debounceMs={150} />
          <SliderRow label="Vignette" value={adjust.vignette ?? 0} min={0} max={1} step={0.01} format={percent} onChange={(v) => setAdjust({ vignette: v })} debounceMs={150} />
          <SliderRow label="Sharpen" value={adjust.sharpen ?? 0} min={0} max={1} step={0.01} format={percent} onChange={(v) => setAdjust({ sharpen: v })} debounceMs={150} />
          <SliderRow label="Grain" value={adjust.grain ?? 0} min={0} max={0.12} step={0.005} format={percent} onChange={(v) => setAdjust({ grain: v })} debounceMs={150} />
          <Btn size="sm" style={{ alignSelf: 'flex-start' }} onClick={() => void setLook({ adjust: {} })}>Reset adjustments</Btn>
        </div>
      </Section>
    </div>
  )
}
