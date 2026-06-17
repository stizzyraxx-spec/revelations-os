import { useEffect, useRef, useState } from 'react'
import { useOSStore } from './store'
import LoginScreen from './components/LoginScreen'
import Desktop from './components/Desktop'
import ExitOSModal from './components/ExitOSModal'
import SubscriptionModal from './components/SubscriptionModal'
import UpdateBanner from './components/UpdateBanner'
import Spotlight from './components/Spotlight'

export default function App() {
  const { user, addNotification, pendingUpdate, setPendingUpdate } = useOSStore()
  const [showLogin, setShowLogin] = useState(true)
  const [loginOpacity, setLoginOpacity] = useState(1)
  const [spotlightOpen, setSpotlightOpen] = useState(false)
  const timers = useRef([])

  // Global Cmd+Space → Spotlight (available after login)
  useEffect(() => {
    if (!user.loggedIn) return
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.code === 'Space') {
        e.preventDefault()
        setSpotlightOpen(o => !o)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [user.loggedIn])

  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = [] }

  useEffect(() => {
    if (!window.nexus?.onNotification) return
    const unsub = window.nexus.onNotification((n) => addNotification(n))
    return unsub
  }, [])

  // React to login state — fade out LoginScreen, show Desktop
  useEffect(() => {
    if (!user.loggedIn) return
    clearTimers()
    // Begin fading login screen out
    const t1 = setTimeout(() => setLoginOpacity(0), 50)
    // Remove login from DOM after fade completes
    const t2 = setTimeout(() => setShowLogin(false), 1400)
    timers.current = [t1, t2]
    return clearTimers
  }, [user.loggedIn])

  // Inactivity lock — 5 minutes
  useEffect(() => {
    if (!user.loggedIn) return
    let timer
    const reset = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        useOSStore.getState().logout()
        addNotification({ title: 'Screen Locked', body: 'Session locked due to inactivity', type: 'security' })
        setShowLogin(true)
        setLoginOpacity(1)
      }, 300000)
    }
    window.addEventListener('mousemove', reset)
    window.addEventListener('keydown', reset)
    reset()
    return () => { clearTimeout(timer); window.removeEventListener('mousemove', reset); window.removeEventListener('keydown', reset) }
  }, [user.loggedIn])

  useEffect(() => {
    if (!user.loggedIn) return
    const day = new Date().getDay()
    if (day === 1 && window.nexus?.checkForUpdate) {
      window.nexus.checkForUpdate().then(r => { if (r?.available) setPendingUpdate(r) }).catch(() => {})
    }
  }, [user.loggedIn])

  return (
    <>
      {/* Desktop always in DOM, always fully visible — LoginScreen sits on top */}
      <div style={{ position: 'fixed', inset: 0 }}>
        <Desktop />
      </div>

      {/* LoginScreen overlays on top, fades out on login */}
      {showLogin && (
        <div style={{
          position: 'fixed', inset: 0,
          opacity: loginOpacity,
          transition: 'opacity 1.2s cubic-bezier(0.16, 1, 0.3, 1)',
          willChange: 'opacity',
          pointerEvents: loginOpacity > 0 ? 'all' : 'none',
        }}>
          <LoginScreen />
        </div>
      )}

      {user.loggedIn && <UpdateBanner />}
      <ExitOSModal />
      <SubscriptionModal />
      {user.loggedIn && <Spotlight open={spotlightOpen} onClose={() => setSpotlightOpen(false)} />}
    </>
  )
}
