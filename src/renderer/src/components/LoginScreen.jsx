import { useEffect, useRef, useState } from 'react'
import { useOSStore } from '../store'
import raxxLogo from '../assets/raxx-logo.png'
import LoginCinematic from './LoginCinematic'

// Transition timeline (all times from onArrived):
//   0ms  — horses freeze, colored glows bloom, canvas starts opacity fade
//   400ms — logo begins fading in + scaling up
//   1600ms — login() fires → App.jsx starts Desktop cross-fade
export default function LoginScreen() {
  const login = useOSStore(s => s.login)
  const [phase, setPhase]           = useState(0)
  const [logoVisible, setLogoVisible] = useState(false)
  const timers = useRef([])

  const handleArrived = () => {
    setPhase(1)
    const t1 = setTimeout(() => setLogoVisible(true), 400)
    const t2 = setTimeout(() => setPhase(2), 1200)
    const t3 = setTimeout(() => login('User'), 1600)
    timers.current = [t1, t2, t3]
  }

  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', overflow: 'hidden' }}>
      <LoginCinematic onArrived={handleArrived} phase={phase} />

      {/* Logo fades in with a gentle scale-up, sits above the fading canvas */}
      <div style={{
        position: 'absolute', inset: 0, zIndex: 10,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        pointerEvents: 'none',
        opacity:    logoVisible ? 1 : 0,
        transform:  logoVisible ? 'scale(1)' : 'scale(0.88)',
        transition: 'opacity 1.0s cubic-bezier(0.16, 1, 0.3, 1), transform 1.0s cubic-bezier(0.16, 1, 0.3, 1)',
        willChange: 'opacity, transform',
      }}>
        <img
          src={raxxLogo}
          alt="Revelations OS"
          style={{
            width: '420px', maxWidth: '70vw',
            userSelect: 'none', pointerEvents: 'none',
            filter: 'drop-shadow(0 0 48px rgba(255,255,255,0.25)) drop-shadow(0 0 96px rgba(200,100,255,0.18))',
          }}
        />
      </div>
    </div>
  )
}
