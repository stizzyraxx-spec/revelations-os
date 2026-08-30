import { useEffect, useRef, useState } from 'react'
import { useOSStore } from '../store'
import raxxLogo from '../assets/raxx-logo.png'
import LoginCinematic from './LoginCinematic'
import { hasAccounts, createAccount, verifyLogin } from '../auth/localAuth'
import { User, Lock, Mail, Phone, Eye, EyeOff, ArrowRight, UserCircle } from 'lucide-react'

export default function LoginScreen() {
  const login = useOSStore((s) => s.login)
  const [phase, setPhase] = useState(0)
  const [logoVisible, setLogoVisible] = useState(false)
  const [authVisible, setAuthVisible] = useState(false)
  const timers = useRef([])

  const [mode, setMode] = useState(() => (hasAccounts() ? 'signin' : 'create'))
  const [f, setF] = useState({ username: '', name: '', email: '', phone: '', password: '', confirm: '' })
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const firstInput = useRef(null)

  const set = (k) => (e) => { setF((prev) => ({ ...prev, [k]: e.target.value })); setError('') }

  const handleArrived = () => {
    setPhase(1)
    const t1 = setTimeout(() => setLogoVisible(true), 400)
    const t2 = setTimeout(() => setPhase(2), 1000)
    const t3 = setTimeout(() => { setAuthVisible(true); firstInput.current?.focus() }, 1000)
    timers.current = [t1, t2, t3]
  }
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const submit = async () => {
    if (busy) return
    setError('')
    if (mode === 'signin') {
      if (!f.username || !f.password) { setError('Enter your username and password'); return }
      setBusy(true)
      const acct = await verifyLogin(f.username, f.password)
      setBusy(false)
      if (acct) login(acct.name || acct.username)
      else { setError('Incorrect username or password'); setF((p) => ({ ...p, password: '' })) }
      return
    }
    // create
    if (f.password !== f.confirm) { setError('Passwords do not match'); return }
    setBusy(true)
    const res = await createAccount(f)
    setBusy(false)
    if (res.ok) login(res.account.name || res.account.username)
    else setError(res.error || 'Could not create account')
  }

  const onKeyDown = (e) => { if (e.key === 'Enter') submit() }
  const isCreate = mode === 'create'

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', overflow: 'hidden' }}>
      <LoginCinematic onArrived={handleArrived} phase={phase} />

      {/* Logo */}
      <div style={{
        position: 'absolute', inset: 0, zIndex: 10,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 22, padding: '28px 16px', overflowY: 'auto',
        pointerEvents: authVisible ? 'all' : 'none',
      }}>
        <img src={raxxLogo} alt="Revelations OS" style={{
          width: 190, maxWidth: '46vw', flexShrink: 0,
          opacity: logoVisible ? 1 : 0,
          transform: logoVisible ? 'scale(1)' : 'scale(0.88)',
          transition: 'opacity 1.0s cubic-bezier(0.16,1,0.3,1), transform 1.0s cubic-bezier(0.16,1,0.3,1)',
          filter: 'drop-shadow(0 0 48px rgba(255,255,255,0.25)) drop-shadow(0 0 96px rgba(200,100,255,0.18))',
        }} />

        {/* Auth card */}
        <div style={{
          zIndex: 11, width: 380, maxWidth: '90vw', flexShrink: 0,
          opacity: authVisible ? 1 : 0,
          transform: authVisible ? 'translateY(0)' : 'translateY(16px)',
          transition: 'opacity 0.8s cubic-bezier(0.16,1,0.3,1), transform 0.8s cubic-bezier(0.16,1,0.3,1)',
        }}>
        <div style={{
          background: 'rgba(10,10,20,0.74)', backdropFilter: 'blur(28px)', WebkitBackdropFilter: 'blur(28px)',
          border: '1px solid rgba(255,255,255,0.12)', borderRadius: 20,
          boxShadow: '0 28px 72px rgba(0,0,0,0.6)', padding: '26px 26px 22px',
          display: 'flex', flexDirection: 'column', gap: 12,
        }}>
          <div style={{ textAlign: 'center', marginBottom: 2 }}>
            <div style={{ fontFamily: '"Times New Roman", Times, serif', fontSize: '1.6rem', fontWeight: 700, color: '#fff', letterSpacing: '0.04em' }}>Revelations</div>
            <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: '0.72rem', letterSpacing: '0.14em', textTransform: 'uppercase', marginTop: 3 }}>
              {isCreate ? 'Create your account' : 'Sign in to continue'}
            </div>
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
            background: isCreate ? '#ffffff' : 'linear-gradient(135deg, #7c3aed, #6d28d9)',
            color: isCreate ? '#000000' : '#fff', fontSize: 14, fontWeight: 600,
            opacity: busy ? 0.7 : 1,
          }}>
            {busy ? 'Please wait…' : isCreate ? 'Create Account' : 'Sign In'}
            {!busy && <ArrowRight size={16} />}
          </button>

          <div style={{ textAlign: 'center', fontSize: '0.76rem', color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>
            {isCreate ? (
              hasAccounts() && <>Already have an account?{' '}
                <button onClick={() => { setMode('signin'); setError('') }} style={linkBtn}>Sign in</button></>
            ) : (
              <>New here?{' '}
                <button onClick={() => { setMode('create'); setError('') }} style={linkBtn}>Create an account</button></>
            )}
          </div>
        </div>
        </div>
      </div>
    </div>
  )
}

function Field({ icon: Icon, placeholder, value, onChange, onKeyDown, type = 'text', trailing, inputRef, error }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,0.06)', border: `1px solid ${error ? 'rgba(239,68,68,0.5)' : 'rgba(255,255,255,0.14)'}`, borderRadius: 10, padding: '10px 12px' }}>
      <Icon size={15} style={{ color: 'rgba(255,255,255,0.4)', flexShrink: 0 }} />
      <input
        ref={inputRef}
        type={type}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#fff', fontSize: 14, minWidth: 0 }}
      />
      {trailing}
    </div>
  )
}

const iconBtn = { background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.4)', display: 'flex', padding: 0 }
const linkBtn = { background: 'none', border: 'none', cursor: 'pointer', color: '#a78bfa', fontSize: '0.76rem', fontWeight: 600, padding: 0, textDecoration: 'underline' }
