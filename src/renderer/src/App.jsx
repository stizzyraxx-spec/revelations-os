import { useEffect, useState } from 'react'
import { useOSStore } from './store'
import LoginScreen from './components/LoginScreen'
import Desktop from './components/Desktop'
import ExitOSModal from './components/ExitOSModal'
import SubscriptionModal from './components/SubscriptionModal'
import UpdateBanner from './components/UpdateBanner'

// Keep both screens mounted during transition so Desktop is ready to cross-fade in.
// loginVisible  — controls LoginScreen opacity (1 → 0)
// desktopVisible — controls Desktop opacity   (0 → 1)
export default function App() {
  const { user, addNotification, pendingUpdate, setPendingUpdate } = useOSStore()
  const [showLogin, setShowLogin]     = useState(!user.loggedIn)
  const [loginVisible, setLoginVisible]   = useState(true)
  const [desktopVisible, setDesktopVisible] = useState(false)

  useEffect(() => {
    if (!window.nexus?.onNotification) return
    const unsub = window.nexus.onNotification((n) => addNotification(n))
    return unsub
  }, [])

  // When login() fires in the store, orchestrate the cross-fade
  useEffect(() => {
    if (!user.loggedIn) return

    // Start fading Desktop in immediately
    setDesktopVisible(true)
    // Start fading Login out after a short beat so both are briefly visible together
    const t1 = setTimeout(() => setLoginVisible(false), 200)
    // Unmount LoginScreen after its fade-out is complete (1.2s fade + 200ms delay)
    const t2 = setTimeout(() => setShowLogin(false), 1600)

    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [user.loggedIn])

  useEffect(() => {
    if (!user.loggedIn) return
    let timer
    const reset = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        useOSStore.getState().logout()
        addNotification({ title: 'Screen Locked', body: 'Session locked due to inactivity', type: 'security' })
        setShowLogin(true); setLoginVisible(true); setDesktopVisible(false)
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

  const FADE = 'opacity 1.2s cubic-bezier(0.16, 1, 0.3, 1)'

  return (
    <>
      {/* Desktop renders underneath, fades in as login fades out */}
      {user.loggedIn && (
        <div style={{
          position: 'fixed', inset: 0,
          opacity: desktopVisible ? 1 : 0,
          transition: FADE,
          willChange: 'opacity',
        }}>
          <Desktop />
        </div>
      )}

      {/* LoginScreen sits on top, fades out */}
      {showLogin && (
        <div style={{
          position: 'fixed', inset: 0,
          opacity: loginVisible ? 1 : 0,
          transition: FADE,
          willChange: 'opacity',
          pointerEvents: loginVisible ? 'all' : 'none',
        }}>
          <LoginScreen />
        </div>
      )}

      {user.loggedIn && <UpdateBanner />}
      <ExitOSModal />
      <SubscriptionModal />
    </>
  )
}
