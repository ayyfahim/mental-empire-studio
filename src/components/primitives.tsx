import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'

/** a11y props that make a clickable <div>/<span> behave like a button: focusable,
 *  activatable with Enter/Space, and announced as a button by screen readers. Spread
 *  these onto the element that already has an onClick. */
export function clickableProps(onClick: () => void, label?: string): {
  role: 'button'
  tabIndex: 0
  'aria-label'?: string
  onKeyDown: (e: KeyboardEvent) => void
} {
  return {
    role: 'button',
    tabIndex: 0,
    'aria-label': label,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onClick()
      }
    }
  }
}

export function Eyebrow({ children }: { children: ReactNode }): JSX.Element {
  return <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '1px', color: 'var(--accent)', marginBottom: 7 }}>{children}</div>
}

export function Title({ children, size = 25 }: { children: ReactNode; size?: number }): JSX.Element {
  return <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: size, letterSpacing: '-.5px', color: '#f4f6f9', lineHeight: 1 }}>{children}</div>
}

export function ScreenPad({ children, style }: { children: ReactNode; style?: CSSProperties }): JSX.Element {
  return <div className="me-screen" style={{ padding: '30px 34px 40px', ...style }}>{children}</div>
}

export function PrimaryButton({ children, style, onClick, disabled }: { children: ReactNode; style?: CSSProperties; onClick?: () => void; disabled?: boolean }): JSX.Element {
  return (
    <div
      onClick={disabled ? undefined : onClick}
      className="me-btn"
      style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'linear-gradient(180deg,var(--accent),var(--accent-deep))', color: 'var(--accent-ink)', fontWeight: 600, fontSize: 12.5, padding: '10px 16px', borderRadius: 10, cursor: disabled ? 'not-allowed' : 'pointer', boxShadow: '0 4px 16px -4px var(--accent-glow)', opacity: disabled ? 0.55 : 1, ...style }}
    >
      {children}
    </div>
  )
}

export function GhostButton({ children, style }: { children: ReactNode; style?: CSSProperties }): JSX.Element {
  return (
    <div className="me-btn" style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid #262b34', background: '#15181f', borderRadius: 10, padding: '9px 14px', fontSize: 12.5, color: '#c4cad3', cursor: 'pointer', ...style }}>
      {children}
    </div>
  )
}

export function Toggle({ on = true }: { on?: boolean }): JSX.Element {
  return (
    <div style={{ width: 34, height: 19, borderRadius: 11, background: on ? 'var(--accent)' : '#2b303b', position: 'relative', cursor: 'pointer', transition: 'background .2s' }}>
      <span style={{ position: 'absolute', top: 2, right: on ? 2 : 17, width: 15, height: 15, borderRadius: '50%', background: '#fff', transition: 'right .2s' }} />
    </div>
  )
}
