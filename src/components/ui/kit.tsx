import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createTrailingCommit } from '../../lib/trailingCommit'
import type { TrailingCommit } from '../../lib/trailingCommit'

/* Shared editor UI kit — the single source of look-and-feel for the Compose and
   Thumbnail studios. Everything reads the theme tokens (tokens.css) and the control
   styles in theme/editor.css, so both editors feel like one product. */

// ---- typography ----

export function SectionLabel({ children, style }: { children: ReactNode; style?: CSSProperties }): JSX.Element {
  return (
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.8px', textTransform: 'uppercase', color: 'var(--text-faint)', ...style }}>
      {children}
    </div>
  )
}

export function FieldLabel({ children, style }: { children: ReactNode; style?: CSSProperties }): JSX.Element {
  return <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6, ...style }}>{children}</div>
}

// ---- containers ----

export function Panel({ children, style, pad = 14 }: { children: ReactNode; style?: CSSProperties; pad?: number | string }): JSX.Element {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 14, background: 'var(--bg-card)', padding: pad, minWidth: 0, ...style }}>
      {children}
    </div>
  )
}

/** Collapsible inspector section with an optional header-right slot. */
export function Section({
  label,
  defaultOpen = true,
  headerRight,
  children
}: {
  label: string
  defaultOpen?: boolean
  headerRight?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <details open={defaultOpen} style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 10 }}>
      <summary
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
          userSelect: 'none',
          listStyle: 'none',
          marginBottom: 10
        }}
      >
        <SectionLabel style={{ flex: 1 }}>{label}</SectionLabel>
        {headerRight && <span onClick={(e) => e.preventDefault()}>{headerRight}</span>}
        <svg width="9" height="9" viewBox="0 0 10 6" style={{ flex: 'none', opacity: 0.6 }}>
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </summary>
      {children}
    </details>
  )
}

// ---- buttons ----

type BtnVariant = 'primary' | 'soft' | 'ghost' | 'danger'

const BTN_STYLES: Record<BtnVariant, CSSProperties> = {
  primary: {
    border: '1px solid transparent',
    background: 'linear-gradient(180deg,var(--accent),var(--accent-deep))',
    color: 'var(--accent-ink)',
    boxShadow: '0 4px 16px -6px var(--accent-glow)'
  },
  soft: {
    border: '1px solid var(--accent)',
    background: 'var(--accent-soft)',
    color: 'var(--accent)'
  },
  ghost: {
    border: '1px solid var(--border-3)',
    background: '#15181f',
    color: '#c4cad3'
  },
  danger: {
    border: '1px solid #4a2530',
    background: '#1a1216',
    color: 'var(--err-2)'
  }
}

export function Btn({
  children,
  variant = 'ghost',
  size = 'md',
  disabled,
  title,
  onClick,
  style
}: {
  children: ReactNode
  variant?: BtnVariant
  size?: 'sm' | 'md'
  disabled?: boolean
  title?: string
  onClick?: () => void
  style?: CSSProperties
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="me-btn ed-focus"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        borderRadius: size === 'sm' ? 8 : 10,
        padding: size === 'sm' ? '6px 11px' : '9px 15px',
        fontSize: size === 'sm' ? 11 : 12.5,
        fontWeight: 700,
        fontFamily: 'var(--font-body)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        whiteSpace: 'nowrap',
        ...BTN_STYLES[variant],
        ...style
      }}
    >
      {children}
    </button>
  )
}

export function IconBtn({
  children,
  title,
  active,
  danger,
  disabled,
  onClick,
  size = 30
}: {
  children: ReactNode
  title: string
  active?: boolean
  danger?: boolean
  disabled?: boolean
  onClick: () => void
  size?: number
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="me-btn ed-focus"
      style={{
        minWidth: size,
        height: size,
        padding: '0 8px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: active ? '1px solid var(--accent)' : danger ? '1px solid #4a2530' : '1px solid var(--border-3)',
        borderRadius: 8,
        background: active ? 'var(--accent-soft)' : danger ? '#1a1216' : '#15181f',
        color: disabled ? 'var(--text-fainter)' : active ? 'var(--accent)' : danger ? 'var(--err-2)' : '#c4cad3',
        fontSize: 11,
        fontWeight: 800,
        cursor: disabled ? 'not-allowed' : 'pointer'
      }}
    >
      {children}
    </button>
  )
}

// ---- selection controls ----

export function Seg<T extends string | number>({
  options,
  value,
  onChange,
  grow
}: {
  options: Array<{ value: T; label: ReactNode; title?: string }>
  value: T
  onChange: (v: T) => void
  grow?: boolean
}): JSX.Element {
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--border-2)', borderRadius: 9, background: 'var(--bg-inset)', padding: 2, gap: 2, width: grow ? '100%' : undefined }}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={String(o.value)}
            type="button"
            title={o.title}
            onClick={() => onChange(o.value)}
            className="ed-focus"
            style={{
              flex: grow ? 1 : undefined,
              border: 'none',
              borderRadius: 7,
              padding: '6px 11px',
              fontSize: 11,
              fontWeight: 700,
              fontFamily: 'var(--font-body)',
              background: on ? '#232833' : 'transparent',
              color: on ? 'var(--text-bright)' : 'var(--text-muted)',
              boxShadow: on ? 'inset 0 0 0 1px var(--border-3), 0 1px 4px rgba(0,0,0,.35)' : 'none',
              cursor: 'pointer',
              transition: 'background .15s, color .15s',
              whiteSpace: 'nowrap'
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function Chip({
  children,
  on,
  title,
  onClick,
  style
}: {
  children: ReactNode
  on?: boolean
  title?: string
  onClick?: () => void
  style?: CSSProperties
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="ed-focus"
      style={{
        border: on ? '1px solid var(--accent)' : '1px solid var(--border-2)',
        color: on ? 'var(--accent)' : 'var(--text-muted)',
        background: on ? 'var(--accent-soft)' : 'transparent',
        borderRadius: 999,
        padding: '5px 11px',
        fontSize: 11,
        fontWeight: 600,
        fontFamily: 'var(--font-body)',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'border-color .15s, color .15s, background .15s',
        whiteSpace: 'nowrap',
        ...style
      }}
    >
      {children}
    </button>
  )
}

export function Switch({ on, onToggle, disabled, label }: { on: boolean; onToggle: () => void; disabled?: boolean; label?: string }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className="ed-focus"
      style={{
        width: 34,
        height: 19,
        borderRadius: 11,
        border: 'none',
        background: on ? 'var(--accent)' : '#2b303b',
        position: 'relative',
        cursor: disabled ? 'not-allowed' : 'pointer',
        flex: 'none',
        padding: 0,
        transition: 'background .18s',
        opacity: disabled ? 0.5 : 1
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 17 : 2,
          width: 15,
          height: 15,
          borderRadius: '50%',
          background: '#fff',
          transition: 'left .18s cubic-bezier(.2,.7,.2,1)',
          boxShadow: '0 1px 3px rgba(0,0,0,.4)'
        }}
      />
    </button>
  )
}

export function ToggleRow({
  label,
  hint,
  on,
  onToggle,
  disabled
}: {
  label: string
  hint?: string
  on: boolean
  onToggle: () => void
  disabled?: boolean
}): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: on ? 'var(--text-bright)' : '#cdd2da', fontWeight: on ? 600 : 500 }}>{label}</div>
        {hint && <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2, lineHeight: 1.35 }}>{hint}</div>}
      </div>
      <Switch on={on} onToggle={onToggle} disabled={disabled} label={label} />
    </div>
  )
}

export function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  format,
  onChange,
  labelWidth = 62,
  disabled,
  debounceMs = 0
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  format?: (v: number) => string
  onChange: (v: number) => void
  labelWidth?: number
  disabled?: boolean
  /** When >0, the thumb/value stay instantly responsive locally while the
   *  onChange commit (typically a persistent IPC mutation) is debounced during
   *  a drag, then flushed immediately on release/blur so the final value is
   *  always persisted. 0 (default) preserves the previous every-tick behavior —
   *  used by callers (e.g. the Thumbnail inspector) whose onChange only updates
   *  local/in-memory state that the live canvas reads every frame. */
  debounceMs?: number
}): JSX.Element {
  const [local, setLocal] = useState(value)
  const pendingRef = useRef(false)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  // Lazily created once per mount — delayMs is static per call site (no caller
  // varies debounceMs across renders), so recreating it isn't needed.
  const trailingRef = useRef<TrailingCommit<number> | null>(null)
  if (debounceMs > 0 && !trailingRef.current) {
    trailingRef.current = createTrailingCommit((v) => {
      pendingRef.current = false
      onChangeRef.current(v)
    }, debounceMs)
  }

  useEffect(() => {
    // Only resync from the prop while nothing is pending commit locally —
    // otherwise an external refresh could yank the thumb back mid-drag.
    if (!pendingRef.current) setLocal(value)
  }, [value])

  useEffect(() => () => {
    // Unmounting (e.g. the user switched projects/selection) — drop any
    // not-yet-committed drag value instead of firing it, since onChange may
    // now resolve against a different active project/selection.
    trailingRef.current?.cancel()
  }, [])

  const flush = (): void => trailingRef.current?.flush()

  const handleChange = (v: number): void => {
    setLocal(v)
    if (debounceMs <= 0) { onChange(v); return }
    pendingRef.current = true
    trailingRef.current?.update(v)
  }

  return (
    <label style={{ display: 'grid', gridTemplateColumns: `${labelWidth}px minmax(0,1fr) 44px`, alignItems: 'center', gap: 9, fontSize: 11, color: 'var(--text-muted)' }}>
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      <input
        type="range"
        className="ed-range"
        min={min}
        max={max}
        step={step}
        value={local}
        disabled={disabled}
        onChange={(e) => handleChange(Number(e.target.value))}
        onPointerUp={debounceMs > 0 ? flush : undefined}
        onBlur={debounceMs > 0 ? flush : undefined}
      />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: '#cdd2da', textAlign: 'right' }}>{format ? format(local) : local}</span>
    </label>
  )
}

/** A raw <input type="color">, same local-first/trailing-commit pattern as SliderRow —
 *  the native color picker fires onChange continuously while a color is being dragged
 *  within it, so a nonzero debounceMs keeps a persistent IPC-backed onChange (e.g. a
 *  caption/highlight color) from round-tripping on every pick tick. 0 (default) is the
 *  previous every-tick behavior, for callers whose onChange is local-only. */
export function ColorField({
  value,
  onChange,
  className,
  style,
  debounceMs = 0
}: {
  value: string
  onChange: (v: string) => void
  className?: string
  style?: CSSProperties
  debounceMs?: number
}): JSX.Element {
  const [local, setLocal] = useState(value)
  const pendingRef = useRef(false)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const trailingRef = useRef<TrailingCommit<string> | null>(null)
  if (debounceMs > 0 && !trailingRef.current) {
    trailingRef.current = createTrailingCommit((v) => {
      pendingRef.current = false
      onChangeRef.current(v)
    }, debounceMs)
  }

  useEffect(() => {
    if (!pendingRef.current) setLocal(value)
  }, [value])

  useEffect(() => () => {
    // Switching project/selection while a pick is uncommitted — drop it rather
    // than fire it against whatever is active now.
    trailingRef.current?.cancel()
  }, [])

  const flush = (): void => trailingRef.current?.flush()

  const handleChange = (v: string): void => {
    setLocal(v)
    if (debounceMs <= 0) { onChange(v); return }
    pendingRef.current = true
    trailingRef.current?.update(v)
  }

  return (
    <input
      type="color"
      className={className}
      style={style}
      value={local}
      onChange={(e) => handleChange(e.target.value)}
      onBlur={debounceMs > 0 ? flush : undefined}
    />
  )
}

export function Swatches({
  colors,
  value,
  onPick,
  size = 20,
  allowCustom
}: {
  colors: string[]
  value?: string
  onPick: (c: string) => void
  size?: number
  allowCustom?: boolean
}): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {colors.map((c) => {
        const on = value?.toLowerCase() === c.toLowerCase()
        return (
          <button
            key={c}
            type="button"
            title={c}
            aria-label={`Colour ${c}`}
            onClick={() => onPick(c)}
            className="ed-focus"
            style={{
              width: size,
              height: size,
              borderRadius: 6,
              background: c,
              border: on ? '2px solid var(--accent)' : '1px solid rgba(255,255,255,.16)',
              boxShadow: on ? '0 0 0 2px var(--accent-soft)' : 'none',
              cursor: 'pointer',
              padding: 0,
              transition: 'transform .12s',
              transform: on ? 'scale(1.08)' : 'none'
            }}
          />
        )
      })}
      {allowCustom && (
        <label
          title="Custom colour"
          style={{
            width: size,
            height: size,
            borderRadius: 6,
            border: '1px dashed var(--border-3)',
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
            position: 'relative',
            overflow: 'hidden',
            background: 'conic-gradient(#e8403a,#f2c200,#36c98e,#19c3d6,#8b7cff,#e8403a)'
          }}
        >
          <input
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(value ?? '') ? value : '#ffffff'}
            onChange={(e) => onPick(e.target.value)}
            style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
          />
        </label>
      )}
    </div>
  )
}

// ---- feedback ----

export function Banner({ kind, children, style }: { kind: 'error' | 'success' | 'info'; children: ReactNode; style?: CSSProperties }): JSX.Element {
  const palette =
    kind === 'error'
      ? { border: '#5a2530', bg: 'rgba(255,90,110,.09)', color: 'var(--err-2)' }
      : kind === 'success'
        ? { border: '#1f9c6b', bg: 'rgba(31,156,107,.1)', color: 'var(--ok-2)' }
        : { border: 'var(--border-3)', bg: 'var(--bg-inset)', color: 'var(--text-muted)' }
  return (
    <div
      className="ed-fade me-clamp-2"
      style={{ border: `1px solid ${palette.border}`, background: palette.bg, color: palette.color, borderRadius: 10, padding: '9px 12px', fontSize: 11.5, lineHeight: 1.45, ...style }}
    >
      {children}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  body,
  action
}: {
  icon?: ReactNode
  title: string
  body?: ReactNode
  action?: ReactNode
}): JSX.Element {
  return (
    <div style={{ border: '1.5px dashed var(--border-2)', borderRadius: 14, padding: '38px 20px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
      {icon && <div style={{ color: 'var(--text-faint)' }}>{icon}</div>}
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 600, color: 'var(--text-bright)' }}>{title}</div>
      {body && <div style={{ fontSize: 12, color: 'var(--text-dim)', maxWidth: 420, lineHeight: 1.55 }}>{body}</div>}
      {action && <div style={{ marginTop: 6 }}>{action}</div>}
    </div>
  )
}

export function StatusPill({ tone, children, title }: { tone: 'ok' | 'warn' | 'error' | 'neutral' | 'accent'; children: ReactNode; title?: string }): JSX.Element {
  const color =
    tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : tone === 'error' ? 'var(--err)' : tone === 'accent' ? 'var(--accent)' : 'var(--text-muted)'
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        border: `1px solid ${tone === 'neutral' ? 'var(--border-3)' : color + '55'}`,
        background: tone === 'neutral' ? 'rgba(10,12,16,.75)' : color.startsWith('var') ? 'rgba(10,12,16,.75)' : undefined,
        color,
        borderRadius: 999,
        padding: '3px 9px',
        fontSize: 10,
        fontFamily: 'var(--font-mono)',
        letterSpacing: '.2px',
        whiteSpace: 'nowrap'
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flex: 'none' }} />
      {children}
    </span>
  )
}

// ---- helpers ----

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
