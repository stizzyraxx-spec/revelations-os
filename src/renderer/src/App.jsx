import { useEffect } from 'react'
import { useOSStore } from './store'
import LoginScreen from './components/LoginScreen'
import Desktop from './components/Desktop'
import ExitOSModal from './components/ExitOSModal'
import SubscriptionModal from './components/SubscriptionModal'

export default function App() {
  const { user, addNotification, pendingUpdate, setPendingUpdate } = useOSStore()

  useEffect(() => {
    if (!window.nexus?.onNotification) return
    const unsub = window.nexus.onNotification((n) => addNotification(n))
    return unsub
  }, [])

  useEffect(() => {
    if (!user.loggedIn) return
    // Auto-lock after 300s inactivity
    let timer
    const reset = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        useOSStore.getState().logout()
        addNotification({ title: 'Screen Locked', body: 'Session locked due to inactivity', type: 'security' })
      }, 300000)
    }
    window.addEventListener('mousemove', reset)
    window.addEventListener('keydown', reset)
    reset()
    return () => {
      clearTimeout(timer)
      window.removeEventListener('mousemove', reset)
      window.removeEventListener('keydown', reset)
    }
  }, [user.loggedIn])

  useEffect(() => {
    if (!user.loggedIn) return
    // Check for Monday updates
    const day = new Date().getDay()
    if (day === 1 && window.nexus?.checkForUpdate) {
      window.nexus.checkForUpdate().then(r => {
        if (r?.available) setPendingUpdate(r)
      }).catch(() => {})
    }
  }, [user.loggedIn])

  return (
    <>
      {user.loggedIn ? (
        <div className="animate-fade-in" style={{ width: '100vw', height: '100vh' }}>
          <Desktop />
        </div>
      ) : (
        <div className="animate-fade-in" style={{ width: '100vw', height: '100vh' }}>
          <LoginScreen />
        </div>
      )}
      <ExitOSModal />
      <SubscriptionModal />
    </>
  )
}
