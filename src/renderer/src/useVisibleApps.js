import { useMemo } from 'react'
import { useOSStore } from './store'
import { appsFor } from './constants'

// The app registry as the signed-in profile should see it. Lives in its own
// module rather than in constants.js so the constants stay import-free and
// cannot cycle with the store.
//
// Subscribes to user.name, so launchers re-render when the profile changes —
// switching away from Stizz drops RaxxWare from the Orb, Dock, Spotlight,
// Desktop, taskbar and App Store in the same tick.
export function useVisibleApps() {
  const userName = useOSStore((s) => s.user.name)
  return useMemo(() => appsFor(userName), [userName])
}
