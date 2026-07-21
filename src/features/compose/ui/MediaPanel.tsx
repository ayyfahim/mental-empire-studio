import { useMemo, useRef, useState } from 'react'
import type { LibraryAsset, MotionPreset, ProjectImage } from '@shared/types'
import { asBetaOpts } from '@shared/types'
import { useData } from '../../../store/useData'
import { isCssImageValue, mediaSrc } from '../../../lib/media'
import { Banner, Btn, FieldLabel, IconBtn, SectionLabel, Seg, SliderRow } from '../../../components/ui/kit'
import { fmt } from './util'

/* Media panel — the project's visual sources: still images (ordered or shuffled),
   timing, and reuse from the cross-project image library. */

function ImageThumb({ image, index }: { image: ProjectImage; index: number }): JSX.Element {
  const thumb = image.thumb || image.path
  const src = mediaSrc(thumb)
  const grads = ['linear-gradient(135deg,#2a2540,#46243a)', 'linear-gradient(135deg,#1a2e3a,#0f3a32)', 'linear-gradient(135deg,#23304a,#1a2438)', 'linear-gradient(135deg,#2e2440,#3a1f2e)']
  const bg = isCssImageValue(thumb) ? thumb : grads[index % grads.length]
  return (
    <div style={{ width: 62, height: 35, borderRadius: 7, background: bg, flex: 'none', overflow: 'hidden', border: '1px solid var(--border)' }}>
      {src && <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
    </div>
  )
}

function LibraryPicker({ onAdd, onClose }: { onAdd: (paths: string[]) => void; onClose: () => void }): JSX.Element {
  const assets = useData((s) => s.libraryAssets)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const grouped = useMemo(() => {
    const byChannel = new Map<string, LibraryAsset[]>()
    for (const a of assets) {
      const list = byChannel.get(a.channel) ?? []
      list.push(a)
      byChannel.set(a.channel, list)
    }
    return [...byChannel.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [assets])
  const toggle = (path: string): void => {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div className="ed-fade" style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-inset)', padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <SectionLabel style={{ flex: 1 }}>Image library</SectionLabel>
        <Btn size="sm" variant={selected.size ? 'primary' : 'ghost'} disabled={!selected.size} onClick={() => { onAdd([...selected]); onClose() }}>
          Add {selected.size || ''}
        </Btn>
        <Btn size="sm" onClick={onClose}>Close</Btn>
      </div>
      {grouped.length === 0 ? (
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', padding: '8px 0' }}>No past images yet — images you add to any project are remembered here.</div>
      ) : (
        <div className="ed-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 11, maxHeight: 260 }}>
          {grouped.map(([channel, imgs]) => (
            <div key={channel}>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginBottom: 6 }}>
                {channel} <span style={{ opacity: 0.6 }}>· {imgs.length}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(64px,1fr))', gap: 6 }}>
                {imgs.map((a) => {
                  const on = selected.has(a.path)
                  const src = mediaSrc(a.path)
                  return (
                    <button
                      key={a.path}
                      type="button"
                      onClick={() => toggle(a.path)}
                      title={a.path.split(/[\\/]/).pop()}
                      className="ed-focus"
                      style={{ position: 'relative', aspectRatio: '1', borderRadius: 8, overflow: 'hidden', cursor: 'pointer', border: on ? '2px solid var(--accent)' : '1px solid var(--border-2)', background: '#15181f', padding: 0 }}
                    >
                      {src && <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
                      {on && <span style={{ position: 'absolute', top: 3, right: 3, width: 15, height: 15, borderRadius: '50%', background: 'var(--accent)', color: 'var(--accent-ink)', fontSize: 9, fontWeight: 800, display: 'grid', placeItems: 'center' }}>✓</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function MediaPanel({ fileInputRef }: { fileInputRef: React.RefObject<HTMLInputElement> }): JSX.Element {
  const project = useData((s) => s.activeProject)
  const images = useData((s) => s.projectImages)
  const setMedia = useData((s) => s.setMedia)
  const setMotionPreset = useData((s) => s.setMotion)
  const setProjectImages = useData((s) => s.setProjectImages)
  const reorderProjectImages = useData((s) => s.reorderProjectImages)
  const loadLibraryAssets = useData((s) => s.loadLibraryAssets)
  const mode = project?.imageMode ?? 'sequence'
  const dragId = useRef<string | null>(null)
  const [showLibrary, setShowLibrary] = useState(false)
  const durationMissing = !project || !project.durationSec || project.durationSec <= 0
  const brollEnabled = asBetaOpts(project?.betaOpts).broll.enabled
  const motionPreset: MotionPreset = project?.motionPreset ?? (project?.kenBurns ? 'subtle' : 'off')

  const pickFiles = (e: React.ChangeEvent<HTMLInputElement>): void => {
    // Electron 32 removed File.path — resolve via webUtils through the preload bridge.
    const paths = Array.from(e.target.files ?? [])
      .map((f) => window.api?.pathForFile?.(f) ?? (f as File & { path?: string }).path ?? '')
      .filter((p): p is string => !!p)
    if (paths.length) void setProjectImages([...images.map((im) => im.path), ...paths])
    e.target.value = ''
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {durationMissing && <Banner kind="error">Audio duration is missing. Resume or re-download this clip before composing.</Banner>}
      {brollEnabled && (
        <Banner kind="info">
          Auto B-roll is on — stock clips replace these stills in the render. Switch back to Images in the Style tab.
        </Banner>
      )}

      <div>
        <FieldLabel>Image order</FieldLabel>
        <Seg
          grow
          value={mode}
          onChange={(m) => void setMedia({ imageMode: m })}
          options={[
            { value: 'sequence', label: 'In order', title: 'Play images in this exact order' },
            { value: 'pool', label: 'Shuffle', title: 'Let Studio pick a repeatable shuffled order' }
          ]}
        />
        {mode === 'pool' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <Btn size="sm" onClick={() => void setMedia({ seed: Math.floor(Math.random() * 9000) + 1000 })} title="Try a new saved shuffle for these images">
              ↻ Try another shuffle
            </Btn>
            <span style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>#{project?.seed ?? '—'}</span>
          </div>
        )}
      </div>

      <div>
        <FieldLabel>Motion on stills</FieldLabel>
        <Seg
          grow
          value={motionPreset}
          onChange={(m) => void setMotionPreset(m)}
          options={[
            { value: 'off', label: 'Static', title: 'No movement' },
            { value: 'subtle', label: 'Subtle', title: 'Gentle eased zoom + pan' },
            { value: 'cinematic', label: 'Cinematic', title: 'Stronger push and drift' }
          ]}
        />
        {motionPreset !== 'off' && (project?.durationSec ?? 0) >= 600 && (
          <div style={{ fontSize: 10, color: 'var(--warn)', marginTop: 6, lineHeight: 1.4 }}>
            Motion is skipped on videos over 10 minutes (long-form fast path) to keep render times sane.
          </div>
        )}
      </div>

      <SliderRow
        label="Blend"
        value={Math.round((project?.crossfade ?? 0.8) * 10) / 10}
        min={0}
        max={3}
        step={0.1}
        format={(v) => `${v.toFixed(1)}s`}
        onChange={(v) => void setMedia({ crossfade: v })}
        debounceMs={150}
      />

      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <SectionLabel style={{ flex: 1 }}>Images · auto-split {images.length ? `· ${images.length}` : ''}</SectionLabel>
          <Btn size="sm" variant={showLibrary ? 'soft' : 'ghost'} onClick={() => { setShowLibrary((v) => !v); void loadLibraryAssets() }} title="Reuse images from a past project">
            Library
          </Btn>
          <Btn size="sm" variant="soft" onClick={() => fileInputRef.current?.click()}>+ Add</Btn>
        </div>
        {showLibrary && (
          <LibraryPicker
            onAdd={(paths) => void setProjectImages([...images.map((im) => im.path), ...paths])}
            onClose={() => setShowLibrary(false)}
          />
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {images.map((im, i) => (
            <div
              key={im.id}
              draggable
              onDragStart={() => { dragId.current = im.id }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => moveImage(im.id)}
              className="me-row"
              style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--border)', borderRadius: 10, padding: 8, background: 'var(--bg-inset)', cursor: 'grab' }}
            >
              <span title="Drag to reorder" style={{ color: 'var(--text-faint)', fontSize: 12, flex: 'none' }}>⠿</span>
              <ImageThumb image={im} index={i} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="me-ellipsis" style={{ fontSize: 11.5, color: 'var(--text)', fontWeight: 600 }}>{im.path.split(/[\\/]/).pop()}</div>
                <div style={{ fontSize: 10, color: durationMissing ? 'var(--err-2)' : 'var(--text-dim)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                  {durationMissing ? 'duration missing' : `${fmt(im.rangeStart)} – ${fmt(im.rangeEnd)}`}
                </div>
              </div>
              <IconBtn
                title="Remove image"
                danger
                size={24}
                onClick={() => void setProjectImages(images.filter((x) => x.id !== im.id).map((x) => x.path))}
              >
                ✕
              </IconBtn>
            </div>
          ))}
          <label
            style={{ border: '1.5px dashed var(--border-3)', borderRadius: 10, padding: 14, textAlign: 'center', fontSize: 11.5, color: 'var(--text-dim)', background: 'var(--bg-inset)', cursor: 'pointer', display: 'block' }}
          >
            ＋ Add images (multi-select)
            <input ref={fileInputRef} type="file" multiple accept="image/*" onChange={pickFiles} style={{ display: 'none' }} />
          </label>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 8, lineHeight: 1.45 }}>
          Timing is split evenly across the narration — fine-tune each image's window from the timeline below.
        </div>
      </div>
    </div>
  )
}
