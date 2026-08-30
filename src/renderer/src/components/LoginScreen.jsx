import { useEffect, useRef, useState } from 'react'
import { useOSStore } from '../store'
import raxxLogo from '../assets/raxx-logo.png'
import LoginCinematic from './LoginCinematic'
import { hasPassword, setPassword, verifyPassword } from '../auth/localAuth'
import { Lock, Eye, EyeOff, ArrowRight } from 'lucide-react'

// Transition timeline (all times from onArrived):
//   0ms   — horses freeze, colored glows bloom, canvas starts opacity fade
//   400ms — logo begins fading in + scaling up
//   1000ms — password panel fades in (login no longer auto-fires)
export default function LoginScreen() {
  const login = useOSStore((s) => s.login)
  const [phase, setPhase] = useState(0)
  const [logoVisible, setLogoVisible] = useState(false)
  const [authVisible, setAuthVisible] = useState(false)
  const timers = useRef([])

  // Auth form state
  const isSetup = !hasPassword()
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)

  const handleArrived = () => {
    setPhase(1)
    const t1 = setTimeout(() => setLogoVisible(true), 400)
    const t2 = setTimeout(() => setPhase(2), 1000)
    const t3 = setTimeout(() => {
      setAuthVisible(true)
      inputRef.current?.focus()
    }, 1000)
    timers.current = [t1, t2, t3]
  }

  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const submit = async () => {
    if (busy) return
    setError('')
    if (isSetup) {
      if (pw.length < 4) { setError('Password must be at least 4 characters'); return }
      if (pw !== confirm) { setError('Passwords do not match'); return }
      setBusy(true)
      await setPassword(pw)
      setBusy(false)
      login('User')
      return
    }
    setBusy(true)
    const ok = await verifyPassword(pw)
    setBusy(false)
    if (ok) {
      login('User')
    } else {
      setError('Incorrect password')
      setPw('')
      inputRef.current?.focus()
    }
  }

  const onKeyDown = (e) => { if (e.key === 'Enter') submit() }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', overflow: 'hidden' }}>
      <LoginCinematic onArrived={handleArrived} phase={phase} />

      {/* Logo fades in with a gentle scale-up, sits above the fading canvas */}
      <div style={{
        position: 'absolute', top: '22%', left: 0, right: 0, zIndex: 10,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        pointerEvents: 'none',
        opacity: logoVisible ? 1 : 0,
        transform: logoVisible ? 'scale(1)' : 'scale(0.88)',
        transition: 'opacity 1.0s cubic-bezier(0.16, 1, 0.3, 1), transform 1.0s cubic-bezier(0.16, 1, 0.3, 1)',
        willChange: 'opacity, transform',
      }}>
        <img
          src={raxxLogo}
          alt="Revelations OS"
          style={{
            width: '320px', maxWidth: '60vw',
            userSelect: 'none', pointerEvents: 'none',
            filter: 'drop-shadow(0 0 48px rgba(255,255,255,0.25)) drop-shadow(0 0 96px rgba(200,100,255,0.18))',
          }}
        />
      </div>

      {/* Password panel */}
      <div style={{
        position: 'absolute', top: '54%', left: '50%', zIndex: 11,
        transform: `translate(-50%, 0) ${authVisible ? 'translateY(0)' : 'translateY(16px)'}`,
        opacity: authVisible ? 1 : 0,
        transition: 'opacity 0.8s cubic-bezier(0.16, 1, 0.3, 1), transform 0.8s cubic-bezier(0.16, 1, 0.3, 1)',
        pointerEvents: authVisible ? 'all' : 'none',
        width: 360, maxWidth: '86vw',
      }}>
        <div style={{
          background: 'rgba(10,10,20,0.72)', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)',
          border: '1px solid rgba(255,255,255,0.12)', borderRadius: 18,
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)', padding: '26px 24px',
          display: 'flex', flexDirection: 'column', gap: 14,
        }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{
              fontFamily: '"Times New Roman", Times, serif', fontSize: '1.5rem', fontWeight: 700,
              color: '#fff', letterSpacing: '0.04em', lineHeight: 1.1,
            }}>Revelations</div>
            <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: '0.72rem', letterSpacing: '0.14em', textTransform: 'uppercase', marginTop: 3 }}>
              {isSetup ? 'Create your password' : 'Enter password to unlock'}
            </div>
          </div>

          {/* Password field */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,0.06)', border: `1px solid ${error ? 'rgba(239,68,68,0.55)' : 'rgba(255,255,255,0.14)'}`, borderRadius: 10, padding: '10px 12px' }}>
            <Lock size={15} style={{ color: 'rgba(255,255,255,0.4)', flexShrink: 0 }} />
            <input
              ref={inputRef}
              type={show ? 'text' : 'password'}
              value={pw}
              onChange={(e) => { setPw(e.target.value); setError('') }}
              onKeyDown={onKeyDown}
              placeholder={isSetup ? 'New password' : 'Password'}
              autoFocus
              style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#fff', fontSize: 14, minWidth: 0 }}
            />
            <button onClick={() => setShow((v) => !v)} tabIndex={-1} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.4)', display: 'flex', padding: 0 }}>
              {show ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>

          {/* Confirm field (setup only) */}
          {isSetup && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 10, padding: '10px 12px' }}>
              <Lock size={15} style={{ color: 'rgba(255,255,255,0.4)', flexShrink: 0 }} />
              <input
                type={show ? 'text' : 'password'}
                value={confirm}
                onChange={(e) => { setConfirm(e.target.value); setError('') }}
                onKeyDown={onKeyDown}
                placeholder="Confirm password"
                style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#fff', fontSize: 14, minWidth: 0 }}
              />
            </div>
          )}

          {error && (
            <div style={{ color: '#f87171', fontSize: '0.76rem', textAlign: 'center' }}>{error}</div>
          )}

          <button
            onClick={submit}
            disabled={busy}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              padding: '11px 0', borderRadius: 10, border: 'none', cursor: busy ? 'default' : 'pointer',
              background: 'linear-gradient(135deg, #7c3aed, #6d28d9)', color: '#fff',
              fontSize: 14, fontWeight: 600, opacity: busy ? 0.7 : 1, transition: 'opacity 0.15s',
            }}
          >
            {busy ? 'Please wait…' : isSetup ? 'Set Password & Enter' : 'Unlock'}
            {!busy && <ArrowRight size={16} />}
          </button>

          {isSetup && (
            <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.66rem', textAlign: 'center', lineHeight: 1.4 }}>
              This password unlocks Revelations OS on this device. Keep it safe — it can't be recovered.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
