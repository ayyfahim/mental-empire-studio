import { useState } from 'react'
import type { DownloadedVideo } from '@shared/types'
import { youtubeIdFromDownloadId, youtubeThumbUrl, type YoutubeThumbQuality } from '@shared/youtube'
import { Banner, Btn, EmptyState } from './ui/kit'

/* Shared "pick a video" gate for the Compose + Thumbnail studios: shown when no
   project is open. One consistent card grid instead of two divergent pickers. */

function fmtDuration(sec?: number): string {
  if (!sec) return ''
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function VideoThumb({ download }: { download: DownloadedVideo }): JSX.Element {
  const videoId = youtubeIdFromDownloadId(download.id)
  const [quality, setQuality] = useState<YoutubeThumbQuality>('max')
  const [failed, setFailed] = useState(false)
  const src = videoId && !failed ? youtubeThumbUrl(videoId, quality) : ''
  return (
    <div style={{ aspectRatio: '16/9', borderRadius: '11px 11px 0 0', overflow: 'hidden', background: 'linear-gradient(135deg,#23304a,#15171d)', position: 'relative' }}>
      {src && (
        <img
          src={src}
          alt=""
          onError={() => { if (quality === 'max') setQuality('hq'); else if (quality === 'hq') setQuality('mq'); else setFailed(true) }}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      )}
      {fmtDuration(download.durationSec) && (
        <span style={{ position: 'absolute', right: 8, bottom: 8, background: 'rgba(8,10,14,.82)', color: '#dde0e5', borderRadius: 6, padding: '2px 7px', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
          {fmtDuration(download.durationSec)}
        </span>
      )}
    </div>
  )
}

export function ProjectGate({
  headline,
  sub,
  downloads,
  openingId,
  error,
  onOpen,
  onSources
}: {
  headline: string
  sub: string
  downloads: DownloadedVideo[]
  openingId: string
  error: string
  onOpen: (downloadId: string) => void
  onSources: () => void
}): JSX.Element {
  const ready = downloads.filter((d) => !!d.filePath && (d.durationSec ?? 0) > 0)
  return (
    <div className="ed-fade" style={{ maxWidth: 1060, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 18, color: 'var(--text-strong)' }}>{headline}</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>{sub}</div>
        </div>
        <Btn variant="soft" onClick={onSources}>Open Sources</Btn>
      </div>
      {error && <Banner kind="error" style={{ marginBottom: 14 }}>{error}</Banner>}
      {ready.length === 0 ? (
        <EmptyState
          icon={
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="3" y="5" width="18" height="14" rx="3" />
              <path d="M10 9.5l5 2.5-5 2.5z" fill="currentColor" stroke="none" />
            </svg>
          }
          title="No finished downloads yet"
          body="Download audio from a source channel first — every finished download shows up here, ready to edit."
          action={<Btn variant="primary" onClick={onSources}>Go to Sources</Btn>}
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))', gap: 14 }}>
          {ready.map((d) => {
            const busy = openingId === d.id
            return (
              <button
                key={d.id}
                type="button"
                disabled={!!openingId}
                onClick={() => onOpen(d.id)}
                className="me-card ed-focus"
                style={{
                  textAlign: 'left',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-card)',
                  borderRadius: 12,
                  padding: 0,
                  overflow: 'hidden',
                  cursor: openingId ? 'wait' : 'pointer',
                  opacity: openingId && !busy ? 0.55 : 1
                }}
              >
                <VideoThumb download={d} />
                <div style={{ padding: '10px 12px 12px' }}>
                  <div title={d.title} className="me-ellipsis" style={{ color: 'var(--text)', fontSize: 12.5, fontWeight: 700 }}>{d.title}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                    <span className="me-ellipsis" style={{ flex: 1, color: 'var(--text-dim)', fontSize: 10.5, fontFamily: 'var(--font-mono)' }}>{d.channel || 'Source'}</span>
                    <span style={{ flex: 'none', color: busy ? 'var(--warn)' : 'var(--accent)', fontSize: 11, fontWeight: 700 }}>{busy ? 'Opening…' : 'Open →'}</span>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
