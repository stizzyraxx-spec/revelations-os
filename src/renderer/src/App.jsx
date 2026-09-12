import { useEffect, useRef, useState } from 'react'
import { useOSStore } from './store'
import LoginScreen from './components/LoginScreen'
import SetPasswordModal from './components/SetPasswordModal'
import Desktop from './components/Desktop'
import ExitOSModal from './components/ExitOSModal'
import SubscriptionModal from './components/SubscriptionModal'
import UpdateBanner from './components/UpdateBanner'
import Spotlight from './components/Spotlight'

export default function App() {
  const { user, booting, hydrate, addNotification, pendingUpdate, setPendingUpdate } = useOSStore()
  const [showLogin, setShowLogin] = useState(true)
  const [loginOpacity, setLoginOpacity] = useState(1)
  const [spotlightOpen, setSpotlightOpen] = useState(false)
  const timers = useRef([])
  // The splash belongs to opening the app — once we've signed in, a later
  // inactivity lock returns straight to the sign-in screen.
  const bootSplash = useRef(true)

  // Ask once, before anything renders, whether we already know who this is --
  // from the gateway that served the page, or from a stored session. Until that
  // resolves we show nothing rather than flashing the login screen at someone
  // who is already signed in.
  useEffect(() => {
    hydrate().then(() => {
      // Dismiss the login screen outright rather than letting it mount and fade.
      // The fade belongs to an actual sign-in; a restored session should land on
      // the desktop with no intermediate screen at all.
      if (useOSStore.getState().user.loggedIn) { setShowLogin(false); setLoginOpacity(0) }
    })
  }, [])

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
    bootSplash.current = false
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

  // Update check — shortly after sign-in, then every 6 hours for long sessions.
  // The banner is the only thing that surfaces it, so a miss here means the user
  // never learns an update exists; hence on every launch rather than Mondays.
  useEffect(() => {
    if (!user.loggedIn || !window.nexus?.checkForUpdate) return
    const check = () => window.nexus.checkForUpdate()
      .then(r => { if (r?.available) setPendingUpdate(r) })
      .catch(() => {})
    const first = setTimeout(check, 8000)
    const iv = setInterval(check, 6 * 60 * 60 * 1000)
    return () => { clearTimeout(first); clearInterval(iv) }
  }, [user.loggedIn])

  // Nothing until hydrate() has answered. A black frame for one tick beats
  // showing a "create account" screen to someone who is already signed in.
  if (booting) return <div style={{ position: 'fixed', inset: 0, background: '#000' }} />

  return (
    <>
      <SetPasswordModal />
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
          <LoginScreen splash={bootSplash.current} />
        </div>
      )}

      {user.loggedIn && <UpdateBanner />}
      <ExitOSModal />
      <SubscriptionModal />
      {user.loggedIn && <Spotlight open={spotlightOpen} onClose={() => setSpotlightOpen(false)} />}
    </>
  )
}
