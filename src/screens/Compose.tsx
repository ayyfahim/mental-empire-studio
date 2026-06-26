import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { useData } from '../store/useData'
import { ScreenPad, Eyebrow, Title } from '../components/primitives'
import { capPresets } from '../data/mock'
import type { BetaVideoOpts, ProjectImage, TranscriptWord, VideoStyle } from '@shared/types'
import { asBetaOpts } from '@shared/types'
import { buildMasterPrompt, validateEffectPlan } from '@shared/effectPlan'

function Tab({ id, label, icon }: { id: 'media' | 'captions'; label: string; icon: JSX.Element }): JSX.Element {
  const composeTab = useStore((s) => s.composeTab)
  const setComposeTab = useStore((s) => s.setComposeTab)
  const on = composeTab === id
  return (
    <button type="button" onClick={() => setComposeTab(id)} className="me-btn" style={{ display: 'flex', alignItems: 'center', gap: 8, border: on ? '1px solid var(--accent)' : '1px solid #1d2129', background: on ? 'var(--accent-soft)' : 'transparent', color: on ? '#f2f4f7' : '#8a909c', borderRadius: 10, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
      {icon}{label}
    </button>
  )
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

const IMG_GRADS = ['linear-gradient(135deg,#2a2540,#46243a)', 'linear-gradient(135deg,#1a2e3a,#0f3a32)', 'linear-gradient(135deg,#23304a,#1a2438)', 'linear-gradient(135deg,#2e2440,#3a1f2e)']

function mediaSrc(path: string): string {
  if (!path) return ''
  if (/^(https?:|data:|file:)/.test(path)) return path
  return `file:///${path.replace(/\\/g, '/')}`
}

function MediaTab(): JSX.Element {
  const project = useData((s) => s.activeProject)
  const images = useData((s) => s.projectImages)
  const setMedia = useData((s) => s.setMedia)
  const setProjectImages = useData((s) => s.setProjectImages)
  const reorderProjectImages = useData((s) => s.reorderProjectImages)
  const mode = project?.imageMode ?? 'sequence'
  const dragId = useRef<string | null>(null)
  const durationMissing = !project || !project.durationSec || project.durationSec <= 0

  const pickFiles = (e: React.ChangeEvent<HTMLInputElement>): void => {
    // Electron 32 removed File.path — resolve via webUtils through the preload bridge.
    const paths = Array.from(e.target.files ?? [])
      .map((f) => window.api?.pathForFile?.(f) ?? (f as File & { path?: string }).path ?? '')
      .filter((p): p is string => !!p)
    if (paths.length) void setProjectImages(paths)
    e.target.value = '' // allow re-picking the same file
  }

  const moveImage = (targetId: string): void => {
    const fromId = dragId.current
    dragId.current = null
    if (!fromId || fromId === targetId) return
    const ids = images.map((im) => im.id)
    const from = ids.indexOf(fromId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return
    ids.splice(to, 0, ids.splice(from, 1)[0])
    void reorderProjectImages(ids)
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <div style={{ display: 'flex', background: '#0e1116', border: '1px solid #23272f', borderRadius: 10, overflow: 'hidden', fontSize: 12.5 }}>
          <button type="button" onClick={() => void setMedia({ imageMode: 'sequence' })} style={{ border: 0, padding: '9px 16px', cursor: 'pointer', background: mode === 'sequence' ? 'var(--accent)' : 'transparent', color: mode === 'sequence' ? 'var(--accent-ink)' : '#8a909c', fontWeight: 600 }}>Sequence</button>
          <button type="button" onClick={() => void setMedia({ imageMode: 'pool' })} style={{ border: 0, padding: '9px 16px', cursor: 'pointer', background: mode === 'pool' ? 'var(--accent)' : 'transparent', color: mode === 'pool' ? 'var(--accent-ink)' : '#8a909c', fontWeight: 600 }}>Random pool</button>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 20, marginBottom: 20 }}>
        <div style={{ flex: 'none', width: 520 }}>
          <div style={{ border: '1px solid #1d2129', borderRadius: 14, aspectRatio: '16/9', background: images[0] ? '#0e1116' : 'linear-gradient(135deg,#23262e,#15171d)', position: 'relative', overflow: 'hidden', display: 'grid', placeItems: 'center' }}>
            {images[0] ? (
              <img src={mediaSrc(images[0].thumb || images[0].path)} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <div style={{ position: 'absolute', left: '9%', bottom: 0, width: '36%', height: '88%', background: 'linear-gradient(180deg,#3a4150,#23262e)', borderRadius: '80px 80px 0 0' }} />
            )}
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.45))' }} />
            <div style={{ position: 'absolute', top: 14, left: 14, border: '1px dashed rgba(255,255,255,.3)', borderRadius: 7, padding: '5px 9px', fontSize: 10, color: '#cdd2da', fontFamily: 'var(--font-mono)' }}>⤢ Ken Burns</div>
            <div style={{ position: 'absolute', bottom: 12, left: 14, right: 14, height: 6, borderRadius: 4, background: 'rgba(255,255,255,.18)', overflow: 'hidden' }}><div style={{ width: '35%', height: '100%', background: 'var(--accent)' }} /></div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button type="button" onClick={() => void setMedia({ seed: Math.floor(Math.random() * 9000) + 1000 })} className="me-btn" style={{ display: 'flex', alignItems: 'center', gap: 7, border: '1px solid #262b34', background: '#15181f', borderRadius: 9, padding: '8px 13px', fontSize: 11.5, color: '#c4cad3', cursor: 'pointer' }}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 11-3-6.7M21 4v5h-5" /></svg>Re-roll</button>
            <div style={{ border: '1px solid #262b34', background: '#15181f', borderRadius: 9, padding: '8px 13px', fontSize: 11.5, color: '#8a909c' }}>Crossfade ▾</div>
            <div style={{ border: '1px solid #262b34', background: '#15181f', borderRadius: 9, padding: '8px 13px', fontSize: 11.5, color: '#8a909c', fontFamily: 'var(--font-mono)' }}>seed {project?.seed ?? '—'}</div>
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.6px', color: '#6a7180', marginBottom: 10 }}>IMAGES · EVEN AUTO-SPLIT</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {images.map((im: ProjectImage, i) => (
              <div key={im.id} draggable onDragStart={() => { dragId.current = im.id }} onDragOver={(e) => e.preventDefault()} onDrop={() => moveImage(im.id)} className="me-row" style={{ display: 'flex', alignItems: 'center', gap: 12, border: '1px solid #1d2129', borderRadius: 11, padding: 10, background: '#12151b' }}>
                <span title="Drag to reorder" style={{ color: '#6a7180', cursor: 'grab' }}>⠿</span>
                <div style={{ width: 58, height: 33, borderRadius: 6, background: IMG_GRADS[i % IMG_GRADS.length], flex: 'none', overflow: 'hidden' }}>
                  <img src={mediaSrc(im.thumb || im.path)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                </div>
                <div style={{ flex: 1, fontSize: 12.5, color: '#dde0e5', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{im.path.split(/[\\/]/).pop()}</div>
                <div style={{ fontSize: 11, color: durationMissing ? '#ff8a96' : '#6a7180', fontFamily: 'var(--font-mono)' }}>{durationMissing ? 'duration missing' : `${fmt(im.rangeStart)}–${fmt(im.rangeEnd)}`}</div>
              </div>
            ))}
            <label style={{ border: '1.5px dashed #262b34', borderRadius: 11, padding: 16, textAlign: 'center', fontSize: 12, color: '#6a7180', background: '#0e1116', cursor: 'pointer', display: 'block' }}>
              ＋ Drop images here
              <input type="file" multiple accept="image/*" onChange={pickFiles} style={{ display: 'none' }} />
            </label>
          </div>
        </div>
      </div>

      <div style={{ border: '1px solid #1d2129', borderRadius: 13, padding: '15px 17px', background: '#12151b' }}>
        {durationMissing && <div style={{ marginBottom: 12, color: '#ff8a96', fontSize: 12 }}>Audio duration is missing. Resume or re-download this clip before composing images, captions, or renders.</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: '#6a7180', width: 48 }}>AUDIO</span>
          <div style={{ flex: 1, height: 30, borderRadius: 7, background: 'repeating-linear-gradient(90deg,#2b303b,#2b303b 2px,#1a1e26 2px,#1a1e26 5px)' }} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: durationMissing ? '#ff8a96' : '#6a7180' }}>{durationMissing ? '0:00' : fmt(project?.durationSec ?? 0)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: '#6a7180', width: 48 }}>IMAGE</span>
          <div style={{ flex: 1, display: 'flex', gap: 4, height: 24 }}>
            {(images.length ? images : [null, null, null]).map((im, i) => (
              <div key={im?.id ?? i} style={{ flex: 1, borderRadius: 6, background: i === 0 ? 'var(--accent)' : '#2b303b', opacity: i === 0 ? 0.85 : 1, display: 'grid', placeItems: 'center', fontSize: 10, color: i === 0 ? 'var(--accent-ink)' : '#aab0bb', fontWeight: i === 0 ? 600 : undefined }}>img {i + 1}</div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

function chip(text: string, on: boolean, onClick?: () => void, key?: string) {
  return <span key={key} onClick={onClick} style={{ border: on ? '1px solid var(--accent)' : '1px solid #23272f', color: on ? 'var(--accent)' : '#8a909c', borderRadius: 7, padding: '5px 9px', background: on ? 'var(--accent-soft)' : 'transparent', cursor: onClick ? 'pointer' : undefined }}>{text}</span>
}

function MiniToggle({ on, onClick }: { on: boolean; onClick: () => void }): JSX.Element {
  return <div onClick={onClick} style={{ width: 32, height: 18, borderRadius: 11, background: on ? 'var(--accent)' : '#2b303b', position: 'relative', cursor: 'pointer', flex: 'none' }}><span style={{ position: 'absolute', top: 2, right: on ? 2 : 16, width: 14, height: 14, borderRadius: '50%', background: '#fff' }} /></div>
}

/** Compose "Customize (beta)" panel — greyed out unless Settings → beta is enabled. */
function BetaPanel(): JSX.Element {
  const betaOn = useStore((s) => s.settings.beta.enabled)
  const project = useData((s) => s.activeProject)
  const transcript = useData((s) => s.transcript)
  const setCaptions = useData((s) => s.setCaptions)
  const o = asBetaOpts(project?.betaOpts)
  const patch = (p: Partial<BetaVideoOpts>): void => void setCaptions({ betaOpts: { ...o, ...p } })
  const [fxStatus, setFxStatus] = useState('')

  const copyPrompt = (): void => {
    void navigator.clipboard.writeText(buildMasterPrompt(transcript, o.style))
    setFxStatus('Master prompt copied — paste into ChatGPT/Gemini, then paste the JSON back.')
  }
  const genGroq = async (): Promise<void> => {
    if (!project) return
    setFxStatus('Generating with Groq…')
    try {
      const json = await window.api.effects.generate(project.id, o.style)
      patch({ effectPlanJson: json })
      setFxStatus('Generated ✓')
    } catch (e) {
      setFxStatus(`Failed: ${(e as Error).message}`)
    }
  }
  const planSummary = ((): string => {
    if (!o.effectPlanJson.trim()) return ''
    const { plan, warnings } = validateEffectPlan(o.effectPlanJson, project?.durationSec ?? 60)
    return `${plan.transitions.length} transitions · ${plan.textEffects.length} text effects${warnings.length ? ` · ${warnings.length} adjusted` : ''}`
  })()

  const styles: VideoStyle[] = ['None', 'Cinematic', 'Intense', 'Heartfelt', 'Clean']
  const Row = ({ label, on, set, hint }: { label: string; on: boolean; set: () => void; hint?: string }): JSX.Element => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1 }}><div style={{ fontSize: 11.5, color: '#cdd2da' }}>{label}</div>{hint && <div style={{ fontSize: 9.5, color: '#6a7180' }}>{hint}</div>}</div>
      <MiniToggle on={on} onClick={set} />
    </div>
  )

  return (
    <div style={{ position: 'relative', border: '1px solid #1d2129', borderRadius: 14, padding: 15, background: '#12151b', display: 'flex', flexDirection: 'column', gap: 13, opacity: betaOn ? 1 : 0.45, pointerEvents: betaOn ? 'auto' : 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.6px', color: '#5b616f' }}>CUSTOMIZE</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700, background: 'var(--accent-soft)', color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 9, padding: '1px 6px' }}>BETA</span>
        {!betaOn && <span style={{ marginLeft: 'auto', fontSize: 9.5, color: '#6a7180' }}>Enable in Settings → Beta</span>}
      </div>

      <div>
        <Row label="Hook (intro card)" on={o.hook.enabled} set={() => patch({ hook: { ...o.hook, enabled: !o.hook.enabled } })} hint="Big line for the first ~2.5s" />
        {o.hook.enabled && <input value={o.hook.text} onChange={(e) => patch({ hook: { ...o.hook, text: e.target.value } })} placeholder="Auto from transcript — or type a hook" style={{ width: '100%', boxSizing: 'border-box', marginTop: 7, border: '1px solid #23272f', borderRadius: 7, padding: '6px 9px', fontSize: 11, color: '#dde0e5', background: '#0e1116' }} />}
      </div>
      <Row label="Auto-highlight keywords" on={o.autoHighlight} set={() => patch({ autoHighlight: !o.autoHighlight })} hint="Emphasize key words in captions" />

      <div>
        <div style={{ fontSize: 10.5, color: '#6a7180', marginBottom: 7 }}>Background overlay (gradient)</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {(['bottom', 'top', 'left', 'right'] as const).map((e) => {
            const on = o.overlay[e]
            return <span key={e} onClick={() => patch({ overlay: { ...o.overlay, [e]: !on } })} style={{ border: on ? '1px solid var(--accent)' : '1px solid #23272f', color: on ? 'var(--accent)' : '#8a909c', background: on ? 'var(--accent-soft)' : 'transparent', borderRadius: 7, padding: '4px 11px', fontSize: 11, cursor: 'pointer', textTransform: 'capitalize' }}>{e}</span>
          })}
        </div>
      </div>

      <div>
        <div style={{ fontSize: 10.5, color: '#6a7180', marginBottom: 7 }}>Automatically zoom in</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Row label="At start" on={o.autoZoom.atStart} set={() => patch({ autoZoom: { ...o.autoZoom, atStart: !o.autoZoom.atStart } })} />
          <Row label="At key phrases" on={o.autoZoom.atKeyPhrases} set={() => patch({ autoZoom: { ...o.autoZoom, atKeyPhrases: !o.autoZoom.atKeyPhrases } })} />
        </div>
      </div>

      <div style={{ borderTop: '1px solid #1d2129', paddingTop: 12 }}>
        <Row label="Auto B-roll (stock footage)" on={o.broll.enabled} set={() => patch({ broll: { ...o.broll, enabled: !o.broll.enabled } })} hint="Themed clip pool from the transcript" />
        {o.broll.enabled && (
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            {(['full', 'sparse', 'keywords'] as const).map((d) => <span key={d} onClick={() => patch({ broll: { ...o.broll, density: d } })} style={{ border: o.broll.density === d ? '1px solid var(--accent)' : '1px solid #23272f', color: o.broll.density === d ? 'var(--accent)' : '#8a909c', background: o.broll.density === d ? 'var(--accent-soft)' : 'transparent', borderRadius: 7, padding: '4px 10px', fontSize: 10.5, cursor: 'pointer', textTransform: 'capitalize' }}>{d}</span>)}
          </div>
        )}
      </div>

      <div>
        <div style={{ fontSize: 10.5, color: '#6a7180', marginBottom: 7 }}>Style (transitions &amp; text effects)</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {styles.map((s) => <span key={s} onClick={() => patch({ style: s })} style={{ border: o.style === s ? '1px solid var(--accent)' : '1px solid #23272f', color: o.style === s ? 'var(--accent)' : '#8a909c', background: o.style === s ? 'var(--accent-soft)' : 'transparent', borderRadius: 7, padding: '4px 10px', fontSize: 10.5, cursor: 'pointer' }}>{s}</span>)}
        </div>
        <div style={{ fontSize: 9.5, color: '#6a7180', marginTop: 6 }}>The style auto-applies tasteful transitions + text effects. Advanced: generate a custom plan below.</div>
      </div>

      <div style={{ borderTop: '1px solid #1d2129', paddingTop: 12 }}>
        <div style={{ fontSize: 10.5, color: '#6a7180', marginBottom: 7 }}>Effect plan (advanced override)</div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 7 }}>
          <button type="button" onClick={copyPrompt} className="me-btn" style={{ flex: 1, textAlign: 'center', border: '1px solid #262b34', borderRadius: 7, padding: '6px 8px', fontSize: 10.5, color: '#c4cad3', background: '#0e1116', cursor: 'pointer' }}>Copy master prompt</button>
          <button type="button" onClick={() => void genGroq()} className="me-btn" style={{ flex: 1, textAlign: 'center', border: '1px solid var(--accent)', borderRadius: 7, padding: '6px 8px', fontSize: 10.5, color: 'var(--accent)', background: 'var(--accent-soft)', cursor: 'pointer' }}>Auto-generate (Groq)</button>
        </div>
        <textarea value={o.effectPlanJson} onChange={(e) => patch({ effectPlanJson: e.target.value })} placeholder='Paste an effect-plan JSON, or auto-generate. Leave empty to use the Style defaults.' rows={4} style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #23272f', borderRadius: 7, padding: 8, fontSize: 10, color: '#dde0e5', background: '#0e1116', fontFamily: 'var(--font-mono)', resize: 'vertical' }} />
        {planSummary && <div style={{ fontSize: 9.5, color: '#36c98e', marginTop: 5 }}>{planSummary}</div>}
        {fxStatus && <div style={{ fontSize: 9.5, color: '#8a909c', marginTop: 4 }}>{fxStatus}</div>}
      </div>
    </div>
  )
}

function CaptionsTab(): JSX.Element {
  const project = useData((s) => s.activeProject)
  const transcript = useData((s) => s.transcript)
  const transcribing = useData((s) => s.transcribing)
  const transcribeMessage = useData((s) => s.transcribeMessage)
  const transcribeError = useData((s) => s.transcribeError)
  const runTranscribe = useData((s) => s.runTranscribe)
  const toggleWordEmphasis = useData((s) => s.toggleWordEmphasis)
  const setCaptions = useData((s) => s.setCaptions)
  const preset = project?.captionPreset ?? 'Hormozi'

  return (
    <div style={{ display: 'flex', gap: 18 }}>
      <div style={{ flex: 'none', width: 284, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ border: '1px solid #1d2129', borderRadius: 14, padding: 15, background: '#12151b' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.6px', color: '#5b616f', marginBottom: 11 }}>PRESET</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            {capPresets.map((name) => {
              const on = name === preset
              return <div key={name} onClick={() => void setCaptions({ captionPreset: name })} className="me-card" style={{ border: on ? '1px solid var(--accent)' : '1px solid #1d2129', background: on ? 'var(--accent-soft)' : '#0e1116', borderRadius: 9, padding: '11px 5px', textAlign: 'center', cursor: 'pointer' }}><div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 12, color: on ? '#f2f4f7' : '#8a909c' }}>{name}</div></div>
            })}
          </div>
        </div>
        <div style={{ border: '1px solid #1d2129', borderRadius: 14, padding: 15, background: '#12151b', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div><div style={{ fontSize: 10.5, color: '#6a7180', marginBottom: 6 }}>Font</div><div style={{ border: '1px solid #23272f', borderRadius: 8, padding: 9, fontSize: 13, color: '#dde0e5', background: '#0e1116', textAlign: 'center', fontWeight: 600 }}>{project?.captionFont ?? 'Montserrat'} ▾</div></div>
          <div><div style={{ fontSize: 10.5, color: '#6a7180', marginBottom: 7 }}>Animation</div><div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 10.5 }}>{(['Pop-in', 'Bounce', 'Slide', 'Type'] as const).map((a) => chip(a, project?.captionAnim === a, () => void setCaptions({ captionAnim: a }), a))}</div></div>
          <div style={{ display: 'flex', gap: 9 }}>
            <div onClick={() => void setCaptions({ keywords: !project?.keywords })} style={{ flex: 1, border: '1px solid #1d2129', borderRadius: 9, padding: 9, background: '#0e1116', cursor: 'pointer' }}><div style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ fontSize: 11, fontWeight: 600, color: '#dde0e5' }}>Keywords</span><span style={{ marginLeft: 'auto', fontSize: 8.5, fontWeight: 700, background: project?.keywords ? '#1f9c6b' : '#2b303b', color: '#fff', borderRadius: 9, padding: '1px 6px' }}>{project?.keywords ? 'ON' : 'OFF'}</span></div><div style={{ fontSize: 9, color: '#6a7180', marginTop: 4 }}>Auto-highlight</div></div>
            <div onClick={() => void setCaptions({ punchZoom: !project?.punchZoom })} style={{ flex: 1, border: '1px solid #1d2129', borderRadius: 9, padding: 9, background: '#0e1116', cursor: 'pointer' }}><div style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ fontSize: 11, fontWeight: 600, color: '#dde0e5' }}>Punch</span><span style={{ marginLeft: 'auto', fontSize: 8.5, fontWeight: 700, background: project?.punchZoom ? '#1f9c6b' : '#2b303b', color: '#fff', borderRadius: 9, padding: '1px 6px' }}>{project?.punchZoom ? 'ON' : 'OFF'}</span></div><div style={{ fontSize: 9, color: '#6a7180', marginTop: 4 }}>Zoom on hit</div></div>
          </div>
        </div>
        <BetaPanel />
      </div>

      <div style={{ flex: 'none', width: 210 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}><span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: '#6a7180' }}>PREVIEW</span><span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, background: 'var(--accent-soft)', color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 10, padding: '2px 8px' }}>{project?.captionAspect ?? '16:9'}</span></div>
        <div style={{ width: 210, border: '1px solid #1d2129', borderRadius: 12, aspectRatio: '16/9', background: 'linear-gradient(135deg,#23262e,#15171d)', position: 'relative', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 18, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', left: '14%', bottom: 0, width: '34%', height: '80%', background: 'linear-gradient(180deg,#3a4150,#23262e)', borderRadius: '50px 50px 0 0' }} />
          <div style={{ position: 'relative', textAlign: 'center', fontFamily: 'var(--font-poster)', fontSize: 19, lineHeight: 1.05, color: '#fff', textShadow: '2px 2px 0 #000' }}>YOU ARE <span style={{ color: '#1f9c6b' }}>NOT</span> CRAZY</div>
        </div>
        <div style={{ fontSize: 10, color: '#6a7180', textAlign: 'center', marginTop: 9, lineHeight: 1.4 }}>Keyword pops green + scale ({preset})</div>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}><span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: '#6a7180' }}>TRANSCRIPT · WORD-LEVEL</span><div style={{ flex: 1 }} />{transcribing && <span style={{ fontSize: 10.5, color: '#8a909c' }}>{transcribeMessage || 'Transcribing…'}</span>}<button type="button" disabled={transcribing} onClick={() => void runTranscribe()} className="me-btn" style={{ border: '1px solid #262b34', background: '#15181f', borderRadius: 8, padding: '6px 11px', fontSize: 11, color: '#c4cad3', cursor: transcribing ? 'not-allowed' : 'pointer', opacity: transcribing ? 0.55 : 1 }}>{transcribing ? 'Transcribing…' : 'Re-transcribe ↻'}</button></div>
        <div style={{ border: '1px solid #1d2129', borderRadius: 12, padding: 16, background: '#12151b', fontSize: 14, lineHeight: 2.1, color: '#cdd2da', height: 178, overflow: 'auto' }}>
          {transcribeError ? (
            <span style={{ color: '#ff8a96', fontSize: 12 }}>{transcribeError}</span>
          ) : transcript.length === 0 ? (
            <span style={{ color: '#4f5662', fontSize: 12 }}>— no transcript yet · click Re-transcribe to generate word-level timings —</span>
          ) : (
            transcript.map((w: TranscriptWord) => (
              <span key={w.id} onClick={() => void toggleWordEmphasis(w.id)} style={{ cursor: 'pointer', background: w.emphasis ? '#1f9c6b' : undefined, color: w.emphasis ? '#fff' : undefined, borderRadius: 4, padding: w.emphasis ? '0 5px' : undefined, fontWeight: w.emphasis ? 600 : undefined }}>{w.word} </span>
            ))
          )}
        </div>
        <div style={{ border: '1px solid #1d2129', borderRadius: 12, padding: 14, background: '#12151b', marginTop: 14 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: '#5b616f', marginBottom: 10 }}>WORD TIMELINE — click ★ to emphasize</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
            {transcript.slice(0, 16).map((w) => (
              <span key={w.id} onClick={() => void toggleWordEmphasis(w.id)} style={{ border: w.emphasis ? '1px solid #1f9c6b' : '1px solid #2c303b', borderRadius: 6, padding: '5px 9px', fontSize: 11.5, color: w.emphasis ? '#fff' : '#aab0bb', background: w.emphasis ? '#1f9c6b' : '#0e1116', fontWeight: w.emphasis ? 600 : undefined, cursor: 'pointer' }}>{w.word}{w.emphasis ? ' ★' : ''}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export function Compose(): JSX.Element {
  const composeTab = useStore((s) => s.composeTab)
  const project = useData((s) => s.activeProject)
  const downloads = useData((s) => s.downloads)
  const openProject = useData((s) => s.openProject)
  const sendActiveToRender = useData((s) => s.sendActiveToRender)
  const [error, setError] = useState('')

  // Open the most recent download as a project if none is active yet.
  useEffect(() => {
    if (!project && downloads.length > 0) {
      void openProject(downloads[0].id).catch((e) => setError((e as Error).message))
    }
  }, [project, downloads, openProject])

  const sendToRender = async (): Promise<void> => {
    setError('')
    try {
      await sendActiveToRender()
      setError('Queued for render.')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <ScreenPad>
      <div style={{ display: 'flex', alignItems: 'flex-end', marginBottom: 18 }}>
        <div><Eyebrow>STEP 02 — COMPOSE</Eyebrow><Title>Build the video</Title></div>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 12, color: '#6a7180' }}>{project ? `${project.title} · ${Math.floor((project.durationSec || 0) / 60)}:${String(Math.round((project.durationSec || 0) % 60)).padStart(2, '0')}` : 'No project — download a clip first'}</div>
      </div>
      <div style={{ display: 'flex', gap: 9, marginBottom: 22 }}>
        <Tab id="media" label="Audio + Image" icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="14" rx="2.5" /><circle cx="8.5" cy="10" r="1.7" /><path d="M4 17l5-4 4 3 2-2 5 4" /></svg>} />
        <Tab id="captions" label="Captions" icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M7 14h4" /><path d="M14 14h3" /></svg>} />
        <div style={{ flex: 1 }} />
        <button type="button" onClick={() => void sendToRender()} className="me-btn" style={{ display: 'flex', alignItems: 'center', gap: 7, border: '1px solid #262b34', background: '#15181f', borderRadius: 10, padding: '9px 16px', fontSize: 12.5, color: '#c4cad3', cursor: 'pointer' }}>Save &amp; send to render<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M5 12h14M13 6l6 6-6 6" /></svg></button>
      </div>
      {error && <div style={{ marginBottom: 16, border: `1px solid ${error === 'Queued for render.' ? '#1f9c6b' : '#5a2530'}`, background: error === 'Queued for render.' ? 'rgba(31,156,107,.12)' : 'rgba(255,90,110,.1)', color: error === 'Queued for render.' ? '#4fd6a0' : '#ff8a96', borderRadius: 10, padding: '10px 12px', fontSize: 12 }}>{error}</div>}
      {composeTab === 'media' ? <MediaTab /> : <CaptionsTab />}
    </ScreenPad>
  )
}
