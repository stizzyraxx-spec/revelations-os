import { useState, useRef, useEffect } from 'react'
import { useOSStore } from '../store'
import { setPassword } from '../auth/localAuth'

// Shown once, on the first arrival of an account provisioned from a gateway
// sign-in. That account deliberately has no password: the operator proved who
// they were to code.raxxware.com to load the page, and inventing a password on
// their behalf would be worse than asking for one.
//
// It is skippable. The gateway is what actually guards this page, and blocking
// the desktop behind a second mandatory credential would be theatre. The prompt
// returns on the next sign-in until a password is set, because the password is
// what makes the packaged desktop build -- where there is no gateway -- usable.
export default function SetPasswordModal() {
  const { passwordSetupFor, clearPasswordSetup, addNotification } = useOSStore()
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const first = useRef(null)

  useEffect(() => { if (passwordSetupFor) first.current?.focus() }, [passwordSetupFor])
  if (!passwordSetupFor) return null

  const submit = async () => {
    if (busy) return
    setError('')
    if (pw !== confirm) { setError('Passwords do not match'); return }
    setBusy(true)
    const res = await setPassword(passwordSetupFor, pw)
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    addNotification({ title: 'Password set', body: `You can now sign in as ${passwordSetupFor}.`, type: 'info' })
    clearPasswordSetup()
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter') submit()
    if (e.key === 'Escape') clearPasswordSetup()
  }

  return (
    <div style={S.scrim} role="dialog" aria-modal="true" aria-labelledby="spm-title">
      <div style={S.card} onKeyDown={onKeyDown}>
        <div id="spm-title" style={S.title}>Set a password</div>
        <div style={S.sub}>
          Signed in as <strong style={{ color: '#e9e4dc' }}>{passwordSetupFor}</strong> from RaxxWare.
          Set a password so you can sign in directly next time.
        </div>

        <input
          ref={first} type="password" value={pw} onChange={(e) => { setPw(e.target.value); setError('') }}
          placeholder="New password" autoComplete="new-password" style={S.input}
        />
        <input
          type="password" value={confirm} onChange={(e) => { setConfirm(e.target.value); setError('') }}
          placeholder="Confirm password" autoComplete="new-password" style={S.input}
        />

        {error && <div style={S.error}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button onClick={submit} disabled={busy || !pw} style={{ ...S.primary, opacity: busy || !pw ? 0.5 : 1 }}>
            {busy ? 'Saving…' : 'Set password'}
          </button>
          <button onClick={clearPasswordSetup} style={S.ghost}>Not now</button>
        </div>

        <div style={S.note}>
          Stored on this device as a salted SHA-256 hash — never in plain text, and never sent anywhere.
        </div>
      </div>
    </div>
  )
}

const S = {
  scrim: {
    position: 'fixed', inset: 0, zIndex: 9000, display: 'flex', alignItems: 'center',
    justifyContent: 'center', background: 'rgba(4,4,8,0.72)', backdropFilter: 'blur(6px)',
  },
  card: {
    width: 'min(420px, calc(100vw - 40px))', padding: '26px 26px 20px', borderRadius: 16,
    background: 'linear-gradient(150deg, #14121a, #0d0c12)',
    border: '1px solid rgba(255,255,255,0.10)', boxShadow: '0 30px 70px rgba(0,0,0,0.6)',
  },
  title: { fontSize: 19, fontWeight: 700, color: '#f4efe6', marginBottom: 6 },
  sub: { fontSize: 13, lineHeight: 1.5, color: '#9d968c', marginBottom: 18 },
  input: {
    width: '100%', boxSizing: 'border-box', marginBottom: 9, padding: '11px 13px', borderRadius: 9,
    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.13)',
    color: '#f0ece4', fontSize: 14, outline: 'none',
  },
  error: { fontSize: 12.5, color: '#f87171', marginTop: 2 },
  primary: {
    flex: 1, padding: '11px 0', borderRadius: 9, border: 'none', cursor: 'pointer',
    background: '#6d28d9', color: '#fff', fontSize: 14, fontWeight: 600,
  },
  ghost: {
    padding: '11px 18px', borderRadius: 9, cursor: 'pointer', background: 'transparent',
    border: '1px solid rgba(255,255,255,0.14)', color: '#9d968c', fontSize: 14,
  },
  note: { marginTop: 14, fontSize: 11.5, lineHeight: 1.45, color: '#6f6a62' },
}
