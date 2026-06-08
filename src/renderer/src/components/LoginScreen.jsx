import { useEffect, useState } from 'react'
import { useOSStore } from '../store'
import raxxLogo from '../assets/raxx-logo.png'

export default function LoginScreen() {
  const login = useOSStore(s => s.login)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // Frame 1: trigger fade-in
    const show = requestAnimationFrame(() => setVisible(true))
    // 2.4s: start fade-out
    const fadeOut = setTimeout(() => setVisible(false), 2400)
    // 3.2s: load into OS
    const done = setTimeout(() => login('User'), 3200)
    return () => { cancelAnimationFrame(show); clearTimeout(fadeOut); clearTimeout(done) }
  }, [])

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: '#000',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      opacity: visible ? 1 : 0,
      transition: 'opacity 0.8s ease',
    }}>
      <img
        src={raxxLogo}
        alt="RAXX Beats Studios"
        style={{
          width: '420px',
          maxWidth: '70vw',
          userSelect: 'none',
          pointerEvents: 'none',
          draggable: false,
        }}
      />
    </div>
  )
}
