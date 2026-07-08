import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { useData } from '../store/useData'
import { Banner, Btn, IconBtn, SectionLabel } from '../components/ui/kit'
import { PipelineRibbon } from '../components/PipelineRibbon'
import { ProjectGate } from '../components/ProjectGate'
import { EditorCanvas } from '../features/thumbnail-editor/EditorCanvas'
import { LayersPanel, TemplatesPanel } from '../features/thumbnail-editor/LayersPanel'
import { InspectorPanel } from '../features/thumbnail-editor/InspectorPanel'
import { SelectionToolbar } from '../features/thumbnail-editor/SelectionToolbar'
import { CompareStrip } from '../features/thumbnail-editor/CompareStrip'
import { BatchExport } from '../features/thumbnail-editor/BatchExport'
import { rasterizeLayers } from '../features/thumbnail-editor/render'

/* Thumbnail studio — a three-panel design tool: layers/templates on the left,
   the canvas (with floating selection toolbar) in the middle, and a context
   inspector on the right. Undo/redo + the full keyboard map live here. */

export function Thumbnails(): JSX.Element {
  const layers = useStore((s) => s.layers)
  const selectedLayerIds = useStore((s) => s.selectedLayerIds)
  const thumbnailPast = useStore((s) => s.thumbnailPast)
  const thumbnailFuture = useStore((s) => s.thumbnailFuture)
  const templates = useStore((s) => s.templates)
  const loadTemplates = useStore((s) => s.loadTemplates)
  const applyTemplate = useStore((s) => s.applyTemplate)
  const saveCurrentTemplate = useStore((s) => s.saveCurrentTemplate)
  const deleteTemplate = useStore((s) => s.deleteTemplate)
  const undoThumbnail = useStore((s) => s.undoThumbnail)
  const redoThumbnail = useStore((s) => s.redoThumbnail)
  const nudgeSelection = useStore((s) => s.nudgeSelection)
  const deleteLayer = useStore((s) => s.deleteLayer)
  const duplicateLayer = useStore((s) => s.duplicateLayer)
  const selectAllUnlockedLayers = useStore((s) => s.selectAllUnlockedLayers)
  const clearSelection = useStore((s) => s.clearSelection)
  const setActive = useStore((s) => s.setActive)
  const activeProject = useData((s) => s.activeProject)
  const projectImages = useData((s) => s.projectImages)
  const transcript = useData((s) => s.transcript)
  const downloads = useData((s) => s.downloads)
  const openProject = useData((s) => s.openProject)
  const refreshActiveProjectSnapshot = useData((s) => s.refreshActiveProjectSnapshot)
  const loadRenderJobs = useData((s) => s.loadRenderJobs)
  const loadWorkItems = useData((s) => s.loadWorkItems)

  const [leftTab, setLeftTab] = useState<'layers' | 'templates'>('layers')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [pickError, setPickError] = useState('')
  const [openingDownloadId, setOpeningDownloadId] = useState('')
  const [templatePreviews, setTemplatePreviews] = useState<Record<string, string>>({})
  const appliedTemplate = useRef('')
  const canUndo = thumbnailPast.length > 0
  const canRedo = thumbnailFuture.length > 0

  useEffect(() => { void loadTemplates() }, [loadTemplates])

  // Template previews — rasterized lazily whenever the library changes.
  const templateKey = useMemo(() => templates.map((t) => `${t.id}:${JSON.stringify(t.layers)}`).join('|'), [templates])
  useEffect(() => {
    let cancelled = false
    const ids = new Set(templates.map((t) => t.id))
    setTemplatePreviews((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(id))))
    if (!templates.length) return () => { cancelled = true }
    void (async () => {
      for (const t of templates) {
        try {
          const url = await rasterizeLayers(t.layers)
          if (cancelled) return
          setTemplatePreviews((prev) => ({ ...prev, [t.id]: url }))
        } catch {
          /* keep skeleton for templates with missing image assets */
        }
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateKey])

  // A profile-assigned template auto-applies when its project opens.
  useEffect(() => {
    const templateId = activeProject?.thumbnailTemplateId
    if (!activeProject || !templateId) return
    const key = `${activeProject.id}:${templateId}`
    if (appliedTemplate.current === key) return
    const template = templates.find((t) => t.id === templateId)
    if (!template) {
      void loadTemplates()
      return
    }
    applyTemplate(template)
    appliedTemplate.current = key
  }, [activeProject?.id, activeProject?.thumbnailTemplateId, templates, applyTemplate, loadTemplates])

  // Keyboard map: undo/redo, select-all, duplicate, delete, nudge, escape.
  useEffect(() => {
    if (!activeProject) return
    const isTypingTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName.toLowerCase()
      return target.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select'
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target)) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redoThumbnail()
        else undoThumbnail()
        return
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redoThumbnail()
        return
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        selectAllUnlockedLayers()
        return
      }
      if (mod && e.key.toLowerCase() === 'd') {
        if (!selectedLayerIds.length) return
        e.preventDefault()
        duplicateLayer(selectedLayerIds[0])
        return
      }
      if (e.key === 'Escape') {
        clearSelection()
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!selectedLayerIds.length) return
        e.preventDefault()
        deleteLayer(selectedLayerIds[0])
        return
      }
      const step = e.shiftKey ? 10 : 1
      const deltas: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step]
      }
      const delta = deltas[e.key]
      if (delta && selectedLayerIds.length) {
        e.preventDefault()
        nudgeSelection(delta[0], delta[1])
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeProject, clearSelection, deleteLayer, duplicateLayer, nudgeSelection, redoThumbnail, selectAllUnlockedLayers, selectedLayerIds, undoThumbnail])

  const openThumbnailProject = async (downloadId: string): Promise<void> => {
    if (openingDownloadId) return
    setOpeningDownloadId(downloadId)
    setPickError('')
    try {
      await openProject(downloadId)
      clearSelection()
    } catch (e) {
      setPickError((e as Error).message || 'Could not open this video.')
    } finally {
      setOpeningDownloadId('')
    }
  }

  const saveThumbnail = async (): Promise<void> => {
    if (!activeProject || saving) return
    setSaving(true)
    setSaveError('')
    try {
      const url = await rasterizeLayers(layers)
      await window.api?.thumbnails?.saveProjectThumb?.(activeProject.id, activeProject.title, url)
      await Promise.all([refreshActiveProjectSnapshot(activeProject.id), loadRenderJobs(), loadWorkItems()])
      setSaved(true)
      setTimeout(() => setSaved(false), 2200)
    } catch (e) {
      setSaveError((e as Error).message || 'Could not save thumbnail.')
    } finally {
      setSaving(false)
    }
  }

  const exportPng = async (): Promise<void> => {
    setSaveError('')
    try {
      const url = await rasterizeLayers(layers)
      await window.api?.thumbnails?.writePng?.(activeProject?.title || 'thumbnail', url)
      setSaved(true)
      setTimeout(() => setSaved(false), 2200)
    } catch (e) {
      setSaveError((e as Error).message || 'Could not export PNG.')
    }
  }

  return (
    <div className="me-screen" style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: '18px 22px 16px', gap: 12, minHeight: 0 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 'none' }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ color: 'var(--accent)', marginBottom: 4 }}>Step 03 — Thumbnail</SectionLabel>
          <div className="me-ellipsis" style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 21, letterSpacing: '-.4px', color: 'var(--text-strong)', lineHeight: 1 }}>
            Thumbnail studio
            {activeProject && <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-dim)', marginLeft: 10 }}>· {activeProject.title}</span>}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <IconBtn title="Undo (⌘/Ctrl+Z)" disabled={!canUndo} onClick={undoThumbnail}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 010 11H11" /></svg>
        </IconBtn>
        <IconBtn title="Redo (⌘/Ctrl+Shift+Z)" disabled={!canRedo} onClick={redoThumbnail}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 14l5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 000 11H13" /></svg>
        </IconBtn>
        <Btn onClick={() => void exportPng()} title="Write a PNG to the output folder">Export PNG</Btn>
        {activeProject && (
          <Btn variant={saved ? 'soft' : 'primary'} disabled={saving} onClick={() => void saveThumbnail()}>
            {saved ? '✓ Saved' : saving ? 'Saving…' : 'Save thumbnail'}
          </Btn>
        )}
      </div>

      {saveError && <Banner kind="error" style={{ flex: 'none' }}>{saveError}</Banner>}

      {!activeProject ? (
        <div className="ed-scroll" style={{ flex: 1, minHeight: 0, paddingTop: 10 }}>
          <ProjectGate
            headline="Pick a video for thumbnail work"
            sub="Finished downloads ready for a custom thumbnail."
            downloads={downloads}
            openingId={openingDownloadId}
            error={pickError}
            onOpen={(id) => void openThumbnailProject(id)}
            onSources={() => setActive('sources')}
          />
        </div>
      ) : (
        <>
          <div style={{ flex: 'none' }}>
            <PipelineRibbon
              title={activeProject.title}
              downloadId={activeProject.downloadId}
              projectId={activeProject.id}
              snapshot={{
                downloaded: true,
                hasImages: projectImages.length > 0,
                captioned: transcript.length > 0,
                hasThumbnail: Boolean(activeProject.thumbPath)
              }}
            />
          </div>

          {/* three-panel workspace */}
          <div className="me-thumb-workspace" style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '224px minmax(360px,1fr) clamp(280px, 24vw, 320px)', gap: 12, alignItems: 'stretch' }}>
            {/* left — layers / templates */}
            <div style={{ border: '1px solid var(--border)', borderRadius: 14, background: 'var(--bg-card)', overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flex: 'none' }}>
                {(['layers', 'templates'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setLeftTab(t)}
                    className="ed-focus"
                    style={{
                      flex: 1,
                      padding: '10px 0',
                      background: leftTab === t ? 'var(--accent-soft)' : 'transparent',
                      border: 'none',
                      borderBottom: leftTab === t ? '2px solid var(--accent)' : '2px solid transparent',
                      cursor: 'pointer',
                      fontSize: 11.5,
                      color: leftTab === t ? 'var(--accent)' : 'var(--text-dim)',
                      fontWeight: leftTab === t ? 700 : 600,
                      textTransform: 'capitalize',
                      fontFamily: 'var(--font-body)'
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                {leftTab === 'layers' ? (
                  <LayersPanel />
                ) : (
                  <TemplatesPanel
                    previews={templatePreviews}
                    onApply={(id) => { const t = templates.find((x) => x.id === id); if (t) applyTemplate(t) }}
                    onSave={() => void saveCurrentTemplate(`Template ${templates.length + 1}`)}
                    onDelete={(id) => void deleteTemplate(id)}
                  />
                )}
              </div>
            </div>

            {/* center — canvas + compare + batch */}
            <div className="ed-scroll" style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12, paddingRight: 2 }}>
              <div style={{ position: 'relative', flex: 'none' }}>
                <EditorCanvas />
                <SelectionToolbar />
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5, textAlign: 'center', flex: 'none' }}>
                Drag to move · corners to resize · double-click text to edit · dashed frame = title-safe zone · arrows nudge (⇧ = ×10)
              </div>
              <CompareStrip />
              <BatchExport />
            </div>

            {/* right — context inspector */}
            <div className="me-thumb-inspector" style={{ border: '1px solid var(--border)', borderRadius: 14, background: 'var(--bg-card)', overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div className="ed-scroll" style={{ flex: 1, minHeight: 0 }}>
                <InspectorPanel />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
