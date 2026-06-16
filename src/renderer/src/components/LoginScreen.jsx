import { useEffect, useRef, useState } from 'react'
import { useOSStore } from '../store'
import raxxLogo from '../assets/raxx-logo.png'
import LoginCinematic from './LoginCinematic'

// Phases:
//  0 — cinematic runs (horses sweep R→L, fireballs)
//  1 — horses reach center, pause (~0.5s), logo fades in
//  2 — logo visible briefly, then login fires and Desktop fades in
export default function LoginScreen() {
  const login = useOSStore(s => s.login)
  const [phase, setPhase] = useState(0) // 0=running, 1=arrived, 2=done
  const [logoVisible, setLogoVisible] = useState(false)

  const handleArrived = () => {
    setPhase(1)
    setTimeout(() => setLogoVisible(true), 100)
    setTimeout(() => setPhase(2), 900)
    setTimeout(() => login('User'), 1200)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', overflow: 'hidden' }}>
      {/* Cinematic canvas layer */}
      <LoginCinematic onArrived={handleArrived} phase={phase} />

      {/* RAXX logo fades in when horses arrive */}
      <div style={{
        position: 'absolute', inset: 0, zIndex: 10,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        pointerEvents: 'none',
        opacity: logoVisible ? 1 : 0,
        transition: 'opacity 0.6s ease',
      }}>
        <img
          src={raxxLogo}
          alt="RAXX Beats Studios"
          style={{ width: '420px', maxWidth: '70vw', userSelect: 'none', pointerEvents: 'none' }}
        />
      </div>
    </div>
  )
}
