import { useState } from 'react'
import { ScreenPad, Eyebrow, Title, PrimaryButton } from '../components/primitives'
import { useData } from '../store/useData'

export function MyChannels(): JSX.Element {
  const channels = useData((s) => s.channels)
  const scraping = useData((s) => s.scraping)
  const addChannel = useData((s) => s.addChannel)
  const updateGoals = useData((s) => s.updateGoals)
  const [url, setUrl] = useState('')
  const [editingId, setEditingId] = useState('')
  const [draft, setDraft] = useState({ weekGoal: 5, monthGoal: 20, reminder: 'On track', reminderNote: '' })

  const connect = (): void => {
    void addChannel(url)
    setUrl('')
  }

  const beginEdit = (c: (typeof channels)[number]): void => {
    setEditingId(c.id)
    setDraft({ weekGoal: c.weekGoal, monthGoal: c.monthGoal, reminder: c.reminder, reminderNote: c.reminderNote })
  }

  const saveEdit = async (): Promise<void> => {
    if (!editingId) return
    await updateGoals(editingId, {
      weekGoal: Math.max(1, draft.weekGoal),
      monthGoal: Math.max(1, draft.monthGoal),
      reminder: draft.reminder.trim() || 'On track',
      reminderNote: draft.reminderNote.trim()
    })
    setEditingId('')
  }

  return (
    <ScreenPad>
      <div style={{ display: 'flex', alignItems: 'flex-end', marginBottom: 8 }}>
        <div><Eyebrow>YOUR CHANNELS</Eyebrow><Title>Channels you publish to</Title></div>
        <div style={{ flex: 1 }} />
        <PrimaryButton onClick={connect}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 5v14M5 12h14" /></svg>Add channel
        </PrimaryButton>
      </div>
      <div style={{ fontSize: 12.5, color: '#8a909c', marginBottom: 22, maxWidth: 720 }}>
        Paste a channel URL and Studio scrapes its stats (views, subs, upload count) — no API. <b style={{ color: '#cdd2da' }}>Link the source channel</b> you pull videos from and Studio maps which downloaded videos you've already uploaded (the ↔ chip). Set a weekly/monthly goal per channel and a reminder date; you'll get a desktop notification when you're behind.
      </div>

      <div style={{ display: 'flex', gap: 11, marginBottom: 24 }}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, background: '#12151b', border: '1px dashed #2c303b', borderRadius: 11, padding: '12px 15px' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5b616f" strokeWidth="2"><path d="M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1" /><path d="M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1" /></svg>
          <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && connect()} placeholder="youtube.com/@your-channel" style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 13, color: '#dde0e5', fontFamily: 'var(--font-mono)' }} />
        </div>
        <div onClick={connect} className="me-btn" style={{ border: '1px solid #262b34', background: '#15181f', borderRadius: 11, padding: '0 20px', display: 'flex', alignItems: 'center', fontSize: 12.5, color: '#c4cad3', cursor: 'pointer' }}>{scraping ? 'Scraping…' : 'Connect & scrape'}</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {channels.map((c) => {
          const mapColor = c.mapDone >= c.mapTotal ? '#4fd6a0' : '#f5b323'
          const weekMet = c.weekDone >= c.weekGoal
          const reminderColor = weekMet ? '#4fd6a0' : '#f5b323'
          return (
            <div key={c.id} className="me-card" style={{ border: '1px solid #1d2129', borderRadius: 15, padding: '18px 20px', background: 'linear-gradient(165deg,#14171e,#0f1217)', display: 'flex', gap: 24, alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 13, width: 256, flex: 'none' }}>
                <div style={{ width: 46, height: 46, borderRadius: 12, background: c.avatar, display: 'grid', placeItems: 'center', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, color: '#0c0d11' }}>{c.mono}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 15, color: '#eef0f3' }}>{c.name}</div>
                  <div style={{ fontSize: 11, color: '#6a7180', fontFamily: 'var(--font-mono)' }}>{c.handle}</div>
                  <div style={{ fontSize: 10.5, color: '#5b616f', marginTop: 3 }}>{c.views} views · {c.subs} subs · {c.total} uploaded</div>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6, border: '1px solid #23272f', borderRadius: 7, padding: '3px 8px', background: '#0e1116' }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#6a7180" strokeWidth="2"><path d="M7 7h10l-3-3M17 17H7l3 3" /></svg>
                    <span style={{ fontSize: 10, color: '#8a909c', fontFamily: 'var(--font-mono)' }}>{c.source}</span>
                    <span style={{ fontSize: 10, color: mapColor, fontWeight: 600 }}>{c.mapDone} / {c.mapTotal} uploaded</span>
                  </div>
                </div>
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.5px', color: '#6a7180' }}>WEEKLY GOAL</span>
                  <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 12.5, color: '#eef0f3' }}>{c.weekDone} / {c.weekGoal}</span>
                  <svg onClick={() => beginEdit(c)} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#5b616f" strokeWidth="2" style={{ cursor: 'pointer' }}><path d="M4 20h4l10-10-4-4L4 16z" /></svg>
                </div>
                <div style={{ height: 7, borderRadius: 4, background: '#1a1e26', overflow: 'hidden' }}>
                  <div style={{ width: `${Math.round((c.weekDone / c.weekGoal) * 100)}%`, height: '100%', background: 'linear-gradient(90deg,var(--accent),var(--accent-deep))' }} />
                </div>
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.5px', color: '#6a7180' }}>MONTHLY GOAL</span>
                  <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 12.5, color: '#eef0f3' }}>{c.monthDone} / {c.monthGoal}</span>
                </div>
                <div style={{ height: 7, borderRadius: 4, background: '#1a1e26', overflow: 'hidden' }}>
                  <div style={{ width: `${Math.round((c.monthDone / c.monthGoal) * 100)}%`, height: '100%', background: '#3a4150' }} />
                </div>
              </div>

              <div style={{ width: 200, flex: 'none', borderLeft: '1px solid #1d2129', paddingLeft: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={reminderColor} strokeWidth="2"><rect x="3" y="4" width="18" height="17" rx="2.5" /><path d="M3 9h18M8 2v4M16 2v4" /></svg>
                  <span style={{ fontSize: 12, fontWeight: 600, color: reminderColor }}>{c.reminder}</span>
                </div>
                <div style={{ fontSize: 10.5, color: '#8a909c', lineHeight: 1.4 }}>{c.reminderNote}</div>
                <div onClick={() => beginEdit(c)} className="me-btn" style={{ marginTop: 9, border: '1px solid #262b34', background: '#15181f', borderRadius: 8, padding: '6px 10px', fontSize: 10.5, color: '#c4cad3', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>Edit goal &amp; reminder</div>
              </div>
            </div>
          )
        })}
      </div>
      {editingId && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'grid', placeItems: 'center', zIndex: 20 }}>
          <div style={{ width: 420, border: '1px solid #262b34', borderRadius: 14, background: '#12151b', padding: 18, boxShadow: '0 18px 50px rgba(0,0,0,.35)' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, color: '#eef0f3', marginBottom: 14 }}>Edit goal & reminder</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
              <label style={{ fontSize: 11, color: '#8a909c' }}>Weekly goal<input type="number" min={1} value={draft.weekGoal} onChange={(e) => setDraft((d) => ({ ...d, weekGoal: parseInt(e.target.value, 10) || 1 }))} style={{ marginTop: 6, width: '100%', boxSizing: 'border-box', border: '1px solid #23272f', borderRadius: 8, background: '#0e1116', color: '#dde0e5', padding: 9 }} /></label>
              <label style={{ fontSize: 11, color: '#8a909c' }}>Monthly goal<input type="number" min={1} value={draft.monthGoal} onChange={(e) => setDraft((d) => ({ ...d, monthGoal: parseInt(e.target.value, 10) || 1 }))} style={{ marginTop: 6, width: '100%', boxSizing: 'border-box', border: '1px solid #23272f', borderRadius: 8, background: '#0e1116', color: '#dde0e5', padding: 9 }} /></label>
            </div>
            <label style={{ display: 'block', fontSize: 11, color: '#8a909c', marginBottom: 10 }}>Reminder status<input value={draft.reminder} onChange={(e) => setDraft((d) => ({ ...d, reminder: e.target.value }))} style={{ marginTop: 6, width: '100%', boxSizing: 'border-box', border: '1px solid #23272f', borderRadius: 8, background: '#0e1116', color: '#dde0e5', padding: 9 }} /></label>
            <label style={{ display: 'block', fontSize: 11, color: '#8a909c' }}>Reminder note<textarea value={draft.reminderNote} onChange={(e) => setDraft((d) => ({ ...d, reminderNote: e.target.value }))} rows={3} style={{ marginTop: 6, width: '100%', boxSizing: 'border-box', border: '1px solid #23272f', borderRadius: 8, background: '#0e1116', color: '#dde0e5', padding: 9, resize: 'vertical' }} /></label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, marginTop: 16 }}>
              <div onClick={() => setEditingId('')} className="me-btn" style={{ border: '1px solid #262b34', borderRadius: 9, padding: '9px 14px', fontSize: 12, color: '#c4cad3', cursor: 'pointer' }}>Cancel</div>
              <div onClick={() => void saveEdit()} className="me-btn" style={{ background: 'var(--accent)', color: 'var(--accent-ink)', borderRadius: 9, padding: '9px 16px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Save</div>
            </div>
          </div>
        </div>
      )}
    </ScreenPad>
  )
}
