import { useEffect, useRef, useState } from 'react'
import { useOSStore } from '../store'
import raxxLogo from '../assets/raxx-logo.png'
import LoginCinematic from './LoginCinematic'
import { hasAccounts, createAccount, verifyLogin } from '../auth/localAuth'
import { User, Lock, Mail, Phone, Eye, EyeOff, ArrowRight, UserCircle } from 'lucide-react'

// Flow: a splash holds the four-horse logo full-screen on black, settles into
// the sign in / create account screen, and THEN the horsemen cinematic runs and
// resolves into the logo before the desktop is revealed.
export default function LoginScreen({ splash = false }) {
  const login = useOSStore((s) => s.login)
  const [stage, setStage] = useState('auth') // 'auth' | 'cinematic'
  const nameRef = useRef('User')

  // Auth form state
  const [mode, setMode] = useState(() => (hasAccounts() ? 'signin' : 'create'))
  const [f, setF] = useState({ username: '', name: '', email: '', phone: '', password: '', confirm: '' })
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const firstInput = useRef(null)

  // Cinematic state
  const [phase, setPhase] = useState(0)
  const [logoVisible, setLogoVisible] = useState(false)
  const timers = useRef([])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  // ── Splash state ──────────────────────────────────────────────────────────
  // The splash and the sign-in screen share one logo element. We lay the sign-in
  // screen out first, measure where the logo lands, then offset that same
  // element to screen-centre at splash size (FLIP). Dropping the offset animates
  // it back down into place, so there is no cross-fade seam between the two.
  // 'measure' holds a black screen while the logo loads and we take its sign-in
  // rect, 'hold' is the splash itself, 'exit' the logo settling into place, and
  // 'done' the sign-in screen at rest.
  const [splashPhase, setSplashPhase] = useState(splash ? 'measure' : 'done')
  const [splashTf, setSplashTf] = useState(null)
  const logoRef = useRef(null)
  const splashTimers = useRef([])
  const measured = useRef(false)
  useEffect(() => () => splashTimers.current.forEach(clearTimeout), [])

  const measureSplash = () => {
    if (measured.current || !splash) return
    const r = logoRef.current?.getBoundingClientRect()
    if (!r?.width || !r?.height) return
    measured.current = true
    const target = Math.min(440, window.innerWidth * 0.72)
    const dx = window.innerWidth / 2 - (r.left + r.width / 2)
    const dy = window.innerHeight / 2 - (r.top + r.height / 2)
    setSplashTf(`translate(${dx}px, ${dy}px) scale(${target / r.width})`)
    setSplashPhase('hold')
    splashTimers.current.push(setTimeout(() => setSplashPhase('exit'), 2100))
    splashTimers.current.push(setTimeout(() => setSplashPhase('done'), 3450))
  }

  useEffect(() => {
    if (!splash) return
    // Cached images can finish loading before React attaches onLoad.
    if (logoRef.current?.complete) measureSplash()
    // If the logo never resolves, don't strand the user on a black screen.
    splashTimers.current.push(setTimeout(() => {
      if (!measured.current) { measured.current = true; setSplashPhase('done') }
    }, 1500))
  }, [])

  // `firstInput` marks whichever field leads the current mode (full name when
  // creating, username when signing in) — focus it so the user can just type.
  // Re-runs as the splash lifts, so the form is focused the moment it appears.
  useEffect(() => { firstInput.current?.focus() }, [mode, splashPhase])

  const set = (k) => (e) => { setF((prev) => ({ ...prev, [k]: e.target.value })); setError('') }

  const enterOS = (name) => { nameRef.current = name || 'User'; setStage('cinematic') }

  const submit = async () => {
    if (busy) return
    setError('')
    if (mode === 'signin') {
      if (!f.username || !f.password) { setError('Enter your username and password'); return }
      setBusy(true)
      const acct = await verifyLogin(f.username, f.password)
      setBusy(false)
      if (acct) enterOS(acct.name || acct.username)
      else { setError('Incorrect username or password'); setF((p) => ({ ...p, password: '' })) }
      return
    }
    if (f.password !== f.confirm) { setError('Passwords do not match'); return }
    setBusy(true)
    const res = await createAccount(f)
    setBusy(false)
    if (res.ok) enterOS(res.account.name || res.account.username)
    else setError(res.error || 'Could not create account')
  }

  const onKeyDown = (e) => { if (e.key === 'Enter') submit() }
  const isCreate = mode === 'create'

  // ── Cinematic stage: horses run → logo → desktop ──────────────────────────
  const handleArrived = () => {
    setPhase(1)
    const t1 = setTimeout(() => setLogoVisible(true), 400)
    const t2 = setTimeout(() => setPhase(2), 1200)
    const t3 = setTimeout(() => login(nameRef.current), 2000)
    timers.current = [t1, t2, t3]
  }

  if (stage === 'cinematic') {
    return (
      <div style={{ position: 'fixed', inset: 0, background: '#000', overflow: 'hidden' }}>
        <LoginCinematic onArrived={handleArrived} phase={phase} />
        <div style={{
          position: 'absolute', inset: 0, zIndex: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
          opacity: logoVisible ? 1 : 0,
          transform: logoVisible ? 'scale(1)' : 'scale(0.88)',
          transition: 'opacity 1.0s cubic-bezier(0.16,1,0.3,1), transform 1.0s cubic-bezier(0.16,1,0.3,1)',
        }}>
          <img src={raxxLogo} alt="Revelations OS" style={{ width: 420, maxWidth: '70vw', filter: 'drop-shadow(0 0 48px rgba(255,255,255,0.25)) drop-shadow(0 0 96px rgba(200,100,255,0.18))' }} />
        </div>
      </div>
    )
  }

  // ── Auth stage: sign in / create on the brimstone background ───────────────
  const inSplash = splashPhase === 'measure' || splashPhase === 'hold'

  return (
    <div style={{
      position: 'fixed', inset: 0,
      // Stay clipped until the logo has finished settling — while it is still
      // scaled up it would otherwise push scrollable overflow.
      overflow: splashPhase === 'done' ? 'auto' : 'hidden',
      background: 'radial-gradient(ellipse at 50% 122%, #4a0d02 0%, #250701 30%, #120300 55%, #050100 78%, #000000 100%)',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Splash backdrop — pure black, lifts to reveal the brimstone sign-in screen */}
      <div style={{
        position: 'fixed', inset: 0, zIndex: 0, background: '#000', pointerEvents: 'none',
        opacity: inSplash ? 1 : 0,
        transition: 'opacity 1.15s cubic-bezier(0.16, 1, 0.3, 1)',
      }} />

      <div style={{
        position: 'relative', zIndex: 1, flex: 1, minHeight: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 22, padding: '32px 16px 10px',
      }}>
        <div style={{
          flexShrink: 0,
          // The jump to splash size must be instant — only the settle back down
          // to the sign-in position is animated, so `transform` is left out of
          // the transition until we're on the way out.
          transform: splashPhase === 'hold' ? splashTf : 'none',
          opacity: splashPhase === 'measure' ? 0 : 1,
          transition: inSplash
            ? 'opacity 0.8s ease'
            : 'transform 1.25s cubic-bezier(0.16, 1, 0.3, 1), filter 1.25s cubic-bezier(0.16, 1, 0.3, 1)',
          willChange: 'transform',
          filter: inSplash
            ? 'drop-shadow(0 0 48px rgba(255,255,255,0.24)) drop-shadow(0 0 110px rgba(255,90,30,0.26))'
            : 'drop-shadow(0 0 40px rgba(255,120,40,0.28)) drop-shadow(0 0 90px rgba(200,40,10,0.2))',
        }}>
          <img ref={logoRef} onLoad={measureSplash} src={raxxLogo} alt="Revelations OS"
            style={{ display: 'block', width: 190, maxWidth: '46vw' }} />
        </div>

        <div style={{
          width: 380, maxWidth: '90vw', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12,
          opacity: inSplash ? 0 : 1,
          pointerEvents: inSplash ? 'none' : 'auto',
          transition: 'opacity 0.75s ease 0.4s',
        }}>
          <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.55)', fontSize: '0.72rem', letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 2 }}>
            {isCreate ? 'Create your account' : 'Sign in to continue'}
          </div>

          {isCreate && (
            <>
              <Field icon={UserCircle} placeholder="Full name" value={f.name} onChange={set('name')} onKeyDown={onKeyDown} inputRef={firstInput} />
              <Field icon={Mail} placeholder="Email" type="email" value={f.email} onChange={set('email')} onKeyDown={onKeyDown} />
              <Field icon={Phone} placeholder="Phone (optional)" value={f.phone} onChange={set('phone')} onKeyDown={onKeyDown} />
            </>
          )}

          <Field icon={User} placeholder="Username" value={f.username} onChange={set('username')} onKeyDown={onKeyDown} inputRef={isCreate ? undefined : firstInput} error={!!error} />

          <Field
            icon={Lock} placeholder={isCreate ? 'Create password' : 'Password'} value={f.password} onChange={set('password')} onKeyDown={onKeyDown}
            type={show ? 'text' : 'password'} error={!!error}
            trailing={<button onClick={() => setShow((v) => !v)} tabIndex={-1} style={iconBtn}>{show ? <EyeOff size={15} /> : <Eye size={15} />}</button>}
          />

          {isCreate && (
            <Field icon={Lock} placeholder="Confirm password" type={show ? 'text' : 'password'} value={f.confirm} onChange={set('confirm')} onKeyDown={onKeyDown} />
          )}

          {error && <div style={{ color: '#f87171', fontSize: '0.76rem', textAlign: 'center' }}>{error}</div>}

          <button onClick={submit} disabled={busy} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 2,
            padding: '11px 0', borderRadius: 10, border: 'none', cursor: busy ? 'default' : 'pointer',
            background: '#ffffff', color: '#000000', fontSize: 14, fontWeight: 600, opacity: busy ? 0.7 : 1,
          }}>
            {busy ? 'Please wait…' : isCreate ? 'Create Account' : 'Sign In'}
            {!busy && <ArrowRight size={16} />}
          </button>
        </div>
      </div>

      {/* Switching between sign in and create account lives at the bottom of the
          screen, clear of the form it swaps. */}
      <div style={{
        position: 'relative', zIndex: 1, flexShrink: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9, padding: '0 16px 30px',
        opacity: inSplash ? 0 : 1,
        pointerEvents: inSplash ? 'none' : 'auto',
        transition: 'opacity 0.75s ease 0.5s',
      }}>
        <div style={{ fontSize: '0.74rem', color: 'rgba(255,255,255,0.45)' }}>
          {isCreate ? 'Already have an account?' : 'New here?'}
        </div>
        <button onClick={() => { setMode(isCreate ? 'signin' : 'create'); setError('') }} style={switchBtn}>
          {isCreate ? 'Log In' : 'Create Account'}
        </button>
      </div>
    </div>
  )
}

function Field({ icon: Icon, placeholder, value, onChange, onKeyDown, type = 'text', trailing, inputRef, error }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, borderRadius: 10, padding: '10px 12px',
      // Carved into the background: dark well + inner top shadow, lit only along
      // the bottom lip so the field reads as recessed rather than raised.
      background: 'rgba(0,0,0,0.34)',
      border: `1px solid ${error ? 'rgba(239,68,68,0.45)' : 'rgba(0,0,0,0.45)'}`,
      boxShadow: error
        ? 'inset 0 2px 6px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(239,68,68,0.25), 0 1px 0 rgba(255,150,90,0.10)'
        : 'inset 0 2px 6px rgba(0,0,0,0.6), inset 0 1px 1px rgba(0,0,0,0.5), 0 1px 0 rgba(255,150,90,0.10)',
    }}>
      <Icon size={15} style={{ color: 'rgba(255,255,255,0.4)', flexShrink: 0 }} />
      <input ref={inputRef} type={type} value={value} onChange={onChange} onKeyDown={onKeyDown} placeholder={placeholder}
        style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#fff', fontSize: 14, minWidth: 0 }} />
      {trailing}
    </div>
  )
}

const iconBtn = { background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.4)', display: 'flex', padding: 0 }
// Secondary to the white Sign In button above — outlined so it reads as the
// alternative path, not the action the user came here for.
const switchBtn = {
  width: 380, maxWidth: '90vw', padding: '11px 0', borderRadius: 10, cursor: 'pointer',
  border: '1px solid rgba(255,255,255,0.26)', background: 'rgba(255,255,255,0.06)',
  color: '#ffffff', fontSize: 14, fontWeight: 600,
}
