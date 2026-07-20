import { useEffect, lazy, Suspense, type ComponentType } from 'react'
import { useStore } from './store/useStore'
import { useData } from './store/useData'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { FirstRunOnboarding } from './components/FirstRunOnboarding'
import { Home } from './screens/Home'
import { MyChannels } from './screens/MyChannels'
import { Download } from './screens/Download'
import { Compose } from './screens/Compose'
import { TalkingVideo } from './screens/TalkingVideo'
import { RenderQueue } from './screens/RenderQueue'
import { Publish } from './screens/Publish'
import { Profiles } from './screens/Profiles'
import { Niches } from './screens/Niches'
import { Settings } from './screens/Settings'
import { ErrorBoundary } from './components/ErrorBoundary'
import type { ScreenKey } from '@shared/types'

// The Thumbnails editor pulls in Konva/react-konva (~heavy). Lazy-load it so it's a
// separate chunk fetched on first navigation, keeping the initial bundle small.
const Thumbnails = lazy(() => import('./screens/Thumbnails').then((m) => ({ default: m.Thumbnails })))

const SCREENS: Record<ScreenKey, ComponentType> = {
  home: Home,
  library: Home,
  workspace: Home,
  channels: MyChannels,
  sources: Download,
  download: Download,
  compose: Compose,
  'talking-video': TalkingVideo,
  thumb: Thumbnails,
  render: RenderQueue,
  publish: Publish,
  niches: Niches,
  profiles: Profiles,
  settings: Settings
}

export function App(): JSX.Element {
  const { active, accent, ambientGlow } = useStore()
  const hydrate = useStore((s) => s.hydrate)
  const initData = useData((s) => s.init)

  // load persisted settings (electron-store) + live data once on boot
  useEffect(() => {
    hydrate()
    initData()
  }, [hydrate, initData])

  // accent drives the CSS variable palette on :root
  useEffect(() => {
    document.documentElement.setAttribute('data-accent', accent)
  }, [accent])

  const pageBg = ambientGlow
    ? 'radial-gradient(70% 55% at 18% 0%, var(--accent-soft) 0%, rgba(0,0,0,0) 60%), radial-gradient(60% 50% at 100% 100%, rgba(80,90,120,.10) 0%, rgba(0,0,0,0) 55%), #070809'
    : '#070809'
  const mainBg = ambientGlow
    ? 'radial-gradient(90% 60% at 100% 0%, var(--accent-soft) 0%, rgba(0,0,0,0) 55%), #0d0f14'
    : '#0d0f14'

  const Screen = SCREENS[active]

  return (
    <div style={{ height: '100%', background: pageBg, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <TitleBar />
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <Sidebar />
        <div style={{ flex: 1, minWidth: 0, background: mainBg, position: 'relative', overflowY: 'auto', overflowX: 'hidden' }}>
          <ErrorBoundary resetKey={active}>
            <Suspense fallback={<div style={{ padding: 40, color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>}>
              <Screen key={active} />
            </Suspense>
          </ErrorBoundary>
        </div>
        <FirstRunOnboarding />
      </div>
    </div>
  )
}
