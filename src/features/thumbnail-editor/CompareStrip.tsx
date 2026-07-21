import { useEffect, useState } from 'react'
import { useData } from '../../store/useData'
import { useStore } from '../../store/useStore'
import { youtubeIdFromDownloadId, youtubeThumbUrl, type YoutubeThumbQuality } from '@shared/youtube'
import { rasterizeLayers } from './render'
import { SectionLabel } from '../../components/ui/kit'

/* Side-by-side reference: your design (live raster) vs the original YouTube
   thumbnail for the source video. */

export function CompareStrip(): JSX.Element | null {
  const activeProject = useData((s) => s.activeProject)
  const layers = useStore((s) => s.layers)
  const videoId = activeProject ? youtubeIdFromDownloadId(activeProject.downloadId) : ''
  const [quality, setQuality] = useState<YoutubeThumbQuality>('max')
  const [previewUrl, setPreviewUrl] = useState('')

  useEffect(() => { setQuality('max') }, [videoId])
  useEffect(() => {
    let cancelled = false
    const t = setTimeout(() => {
      rasterizeLayers(layers).then((url) => { if (!cancelled) setPreviewUrl(url) }).catch(() => {})
    }, 220) // debounce: rasterizing at 1280×720 on every keystroke is wasteful
    return () => { cancelled = true; clearTimeout(t) }
  }, [layers])

  if (!videoId) return null
  const src = youtubeThumbUrl(videoId, quality)

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-card)', padding: 10 }}>
      <SectionLabel style={{ marginBottom: 8 }}>Reference — yours vs original</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <div style={{ aspectRatio: '16/9', borderRadius: 8, background: 'var(--bg-inset)', overflow: 'hidden', border: '1px solid var(--border)' }}>
            {previewUrl
              ? <img src={previewUrl} alt="Your design" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              : <div style={{ display: 'grid', placeItems: 'center', height: '100%', fontSize: 10.5, color: 'var(--text-faint)' }}>Rendering…</div>}
          </div>
          <div style={{ marginTop: 5, fontSize: 10, color: 'var(--text-muted)', textAlign: 'center' }}>Your design</div>
        </div>
        <div>
          <div style={{ aspectRatio: '16/9', borderRadius: 8, background: 'var(--bg-inset)', overflow: 'hidden', border: '1px solid var(--border)' }}>
            <img
              src={src}
              alt="Original YouTube thumbnail"
              onError={() => setQuality((q) => (q === 'max' ? 'hq' : q === 'hq' ? 'mq' : 'default'))}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          </div>
          <div style={{ marginTop: 5, fontSize: 10, color: 'var(--text-muted)', textAlign: 'center' }}>Original</div>
        </div>
      </div>
    </div>
  )
}
