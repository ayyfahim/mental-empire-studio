import { useEffect, useState } from 'react'
import type { GpuEngineStatus } from '@shared/gpuStatus'
import { gpuStatusLabel, type GpuStatusTone } from '@shared/gpuStatus'
import { StatusPill } from '../../../components/ui/kit'

/* Compose is GPU-only: surfaces the real WebCodecs hardware-encode probe so a broken
   driver reads as a clear error here instead of a mid-render failure. */

const TONE: Record<GpuStatusTone, 'ok' | 'warn' | 'error'> = { ok: 'ok', warn: 'warn', error: 'error' }

export function GpuChip(): JSX.Element {
  const [status, setStatus] = useState<GpuEngineStatus | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    let alive = true
    setChecking(true)
    window.api.gpu.status()
      .then((s) => { if (alive) setStatus(s) })
      .catch(() => { if (alive) setStatus(null) })
      .finally(() => { if (alive) setChecking(false) })
    return () => { alive = false }
  }, [])

  const { text, tone, detail } = gpuStatusLabel(status, checking)
  return <StatusPill tone={TONE[tone]} title={detail}>{text}</StatusPill>
}
