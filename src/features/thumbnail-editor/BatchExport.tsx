import { useState } from 'react'
import { useStore } from '../../store/useStore'
import { rasterizeLayers, withHeadline } from './render'
import { Banner, Btn, SectionLabel } from '../../components/ui/kit'

/* Batch export — reuse the current design as a template: one PNG per title line,
   written straight to the output folder. */

export function BatchExport(): JSX.Element {
  const layers = useStore((s) => s.layers)
  const [titles, setTitles] = useState("YOU'RE NOT CRAZY\nIT ALL BROKE\nNEVER APOLOGIZE\nSTOP EXPLAINING")
  const [results, setResults] = useState<{ title: string; url: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(0)
  const [error, setError] = useState('')

  const generate = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    setDone(0)
    setResults([])
    try {
      const list = titles.split('\n').map((t) => t.trim()).filter(Boolean)
      const out: { title: string; url: string }[] = []
      for (const title of list) {
        const url = await rasterizeLayers(withHeadline(layers, title))
        out.push({ title, url })
        setResults([...out])
        setDone(out.length)
        await window.api?.thumbnails?.writePng?.(title, url).catch(() => '')
      }
    } catch (e) {
      setError((e as Error).message || 'Batch generation failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-card)', padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <SectionLabel style={{ flex: 1 }}>Batch export — one PNG per title</SectionLabel>
        <Btn size="sm" variant="soft" disabled={busy} onClick={() => void generate()}>
          {busy ? `Generating ${done}…` : 'Generate all →'}
        </Btn>
      </div>
      <textarea
        className="ed-input"
        value={titles}
        onChange={(e) => setTitles(e.target.value)}
        rows={4}
        placeholder="One title per line"
        style={{ fontFamily: 'var(--font-mono)', fontSize: 11, marginBottom: 10 }}
      />
      {error && <Banner kind="error" style={{ marginBottom: 10 }}>{error}</Banner>}
      {results.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))', gap: 8 }}>
          {results.map((r, i) => (
            <div key={i} title={r.title} style={{ borderRadius: 8, overflow: 'hidden', aspectRatio: '16/9', background: 'var(--bg-inset-2)', border: '1px solid var(--border)' }}>
              <img src={r.url} alt={r.title} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 8 }}>
        Keeps the whole design and swaps only the headline. PNGs are written to your output folder.
      </div>
    </div>
  )
}
