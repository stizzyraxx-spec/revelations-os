import { useState, useEffect, useRef } from 'react'
import {
  Mail, Inbox, Send, Trash2, Star, Search, Plus, RefreshCw,
  ChevronLeft, Paperclip, Bold, Italic, AlignLeft, X, Settings2,
  Archive, AlertCircle, FileText, ChevronRight,
} from 'lucide-react'

const STORAGE_ACCOUNTS = 'revos_mail_accounts'
const STORAGE_EMAILS   = 'revos_mail_emails'

const loadAccounts = () => { try { return JSON.parse(localStorage.getItem(STORAGE_ACCOUNTS)) || [] } catch { return [] } }
const loadEmails   = () => { try { return JSON.parse(localStorage.getItem(STORAGE_EMAILS))   || {} } catch { return {} } }

const FOLDERS = [
  { id: 'inbox',   label: 'Inbox',    icon: Inbox },
  { id: 'sent',    label: 'Sent',     icon: Send },
  { id: 'starred', label: 'Starred',  icon: Star },
  { id: 'archive', label: 'Archive',  icon: Archive },
  { id: 'trash',   label: 'Trash',    icon: Trash2 },
]

const PROVIDERS = [
  { id: 'gmail',   label: 'Gmail',   host: 'imap.gmail.com',   color: '#ea4335' },
  { id: 'outlook', label: 'Outlook', host: 'outlook.office365.com', color: '#0078d4' },
  { id: 'yahoo',   label: 'Yahoo',   host: 'imap.mail.yahoo.com',   color: '#6001d2' },
  { id: 'icloud',  label: 'iCloud',  host: 'imap.mail.me.com',      color: '#1d4ed8' },
  { id: 'other',   label: 'Other',   host: '',                       color: '#374151' },
]

// ── Account Setup Modal ───────────────────────────────────────────────────────
function AccountSetup({ onDone, onCancel }) {
  const [step, setStep] = useState('provider') // provider | credentials | done
  const [provider, setProvider] = useState(null)
  const [form, setForm] = useState({ email: '', password: '', name: '', host: '', port: '993' })
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState('')

  const selectProvider = (p) => {
    setProvider(p)
    setForm(f => ({ ...f, host: p.host }))
    setStep('credentials')
  }

  const connect = async () => {
    if (!form.email || !form.password) { setError('Email and password are required'); return }
    setTesting(true); setError('')
    // Simulate connection test (real IMAP would require an Electron IPC bridge)
    await new Promise(r => setTimeout(r, 1400))
    setTesting(false)
    const account = {
      id: Date.now(),
      email: form.email,
      name: form.name || form.email.split('@')[0],
      provider: provider.id,
      color: provider.color,
      host: form.host,
      port: form.port,
    }
    const accounts = loadAccounts()
    accounts.push(account)
    localStorage.setItem(STORAGE_ACCOUNTS, JSON.stringify(accounts))
    // Seed some demo emails for the new account
    const emails = loadEmails()
    emails[account.id] = {
      inbox: [
        { id: 1, from: 'no-reply@theconditionofman.com', subject: 'Welcome to The Condition of Man', preview: 'Thank you for joining our faith community...', body: 'Thank you for joining The Condition of Man. Your journey in faith starts here.', date: new Date().toISOString(), read: false, starred: false },
        { id: 2, from: 'team@revelationsos.com', subject: 'Your Revelations OS is set up', preview: 'Your mail is now connected to Revelations OS...', body: 'Your mail account has been successfully connected to Revelations OS. You can now send and receive email directly from your desktop.', date: new Date(Date.now() - 3600000).toISOString(), read: true, starred: false },
      ],
      sent: [], starred: [], archive: [], trash: [],
    }
    localStorage.setItem(STORAGE_EMAILS, JSON.stringify(emails))
    onDone(account)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 460, background: '#0d0d1a', borderRadius: 20, border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 24px 80px rgba(0,0,0,0.8)', overflow: 'hidden' }} className="animate-scale-in">
        <div style={{ padding: '20px 24px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <Mail size={20} color="#7c3aed" />
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#fff' }}>Add Mail Account</div>
            <div style={{ fontSize: '0.72rem', color: '#666' }}>Connect your mailbox to Revelations OS</div>
          </div>
          <button onClick={onCancel} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#555' }}><X size={16} /></button>
        </div>

        <div style={{ padding: 24 }}>
          {step === 'provider' && (
            <div>
              <div style={{ fontSize: '0.82rem', color: '#aaa', marginBottom: 16 }}>Choose your mail provider:</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {PROVIDERS.map(p => (
                  <button key={p.id} onClick={() => selectProvider(p)} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
                    background: 'rgba(255,255,255,0.04)', border: `1px solid rgba(255,255,255,0.08)`,
                    borderRadius: 12, cursor: 'pointer', color: '#fff', textAlign: 'left',
                    transition: 'all 0.15s',
                  }}
                    onMouseEnter={e => { e.currentTarget.style.background = `${p.color}22`; e.currentTarget.style.borderColor = `${p.color}66` }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}
                  >
                    <div style={{ width: 32, height: 32, borderRadius: 8, background: p.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Mail size={16} color="#fff" />
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>{p.label}</div>
                      {p.host && <div style={{ fontSize: '0.68rem', color: '#666', marginTop: 1 }}>{p.host}</div>}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 'credentials' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <button onClick={() => setStep('provider')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#7c3aed', padding: 0 }}><ChevronLeft size={16} /></button>
                <div style={{ fontSize: '0.85rem', color: '#aaa' }}>Sign in to {provider.label}</div>
              </div>
              {[
                { key: 'name', label: 'Display Name', placeholder: 'Your Name', type: 'text' },
                { key: 'email', label: 'Email Address', placeholder: 'you@example.com', type: 'email' },
                { key: 'password', label: 'Password / App Password', placeholder: '••••••••', type: 'password' },
                ...(provider.id === 'other' ? [
                  { key: 'host', label: 'IMAP Host', placeholder: 'imap.example.com', type: 'text' },
                  { key: 'port', label: 'Port', placeholder: '993', type: 'number' },
                ] : []),
              ].map(({ key, label, placeholder, type }) => (
                <div key={key}>
                  <label style={{ fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: 5 }}>{label}</label>
                  <input type={type} placeholder={placeholder} value={form[key]}
                    onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '9px 12px', color: '#fff', fontSize: '0.85rem', outline: 'none', boxSizing: 'border-box' }}
                  />
                </div>
              ))}
              {error && <div style={{ fontSize: '0.78rem', color: '#ef4444', padding: '8px 12px', background: 'rgba(239,68,68,0.1)', borderRadius: 8 }}>{error}</div>}
              {provider.id !== 'other' && (
                <div style={{ fontSize: '0.72rem', color: '#666', padding: '8px 0' }}>
                  For Gmail/iCloud, use an App Password (not your main password). Enable 2FA first, then generate one in your account security settings.
                </div>
              )}
              <button onClick={connect} disabled={testing} style={{
                background: testing ? '#374151' : '#7c3aed', border: 'none', borderRadius: 10, padding: '11px',
                cursor: testing ? 'not-allowed' : 'pointer', color: '#fff', fontWeight: 600, fontSize: '0.88rem', marginTop: 4,
              }}>
                {testing ? 'Connecting...' : 'Connect Account'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Compose Modal ─────────────────────────────────────────────────────────────
function Compose({ account, onClose, replyTo }) {
  const [to, setTo] = useState(replyTo?.from || '')
  const [subject, setSubject] = useState(replyTo ? `Re: ${replyTo.subject}` : '')
  const [body, setBody] = useState(replyTo ? `\n\n--- Original ---\n${replyTo.body}` : '')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  const send = async () => {
    if (!to || !subject) return
    setSending(true)
    await new Promise(r => setTimeout(r, 800))
    // Save to sent folder
    const emails = loadEmails()
    if (emails[account.id]) {
      emails[account.id].sent = [
        { id: Date.now(), to, from: account.email, subject, body, preview: body.slice(0, 80), date: new Date().toISOString(), read: true, starred: false },
        ...(emails[account.id].sent || []),
      ]
      localStorage.setItem(STORAGE_EMAILS, JSON.stringify(emails))
    }
    setSending(false); setSent(true)
    setTimeout(onClose, 1200)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', padding: 20 }}>
      <div style={{ width: 500, height: 420, background: '#0d0d1a', borderRadius: 16, border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 16px 60px rgba(0,0,0,0.8)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }} className="animate-scale-in">
        <div style={{ padding: '12px 14px', background: '#7c3aed', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1, fontWeight: 600, fontSize: '0.85rem', color: '#fff' }}>New Message</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.7)' }}><X size={14} /></button>
        </div>
        {sent ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: '#22c55e' }}>
            <Send size={28} />
            <div style={{ fontWeight: 600 }}>Message sent!</div>
          </div>
        ) : (
          <>
            <div style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
              {[{ label: 'To', val: to, set: setTo, type: 'email' }, { label: 'Subject', val: subject, set: setSubject, type: 'text' }].map(({ label, val, set, type }) => (
                <div key={label} style={{ display: 'flex', alignItems: 'center', padding: '7px 14px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <span style={{ width: 56, fontSize: '0.75rem', color: '#555', flexShrink: 0 }}>{label}</span>
                  <input type={type} value={val} onChange={e => set(e.target.value)}
                    style={{ flex: 1, background: 'none', border: 'none', color: '#fff', fontSize: '0.85rem', outline: 'none' }}
                  />
                </div>
              ))}
            </div>
            <textarea value={body} onChange={e => setBody(e.target.value)} placeholder="Write your message..."
              style={{ flex: 1, padding: '12px 14px', background: 'none', border: 'none', color: '#ccc', fontSize: '0.85rem', resize: 'none', outline: 'none', fontFamily: 'inherit', lineHeight: 1.6 }}
            />
            <div style={{ padding: '10px 14px', borderTop: '1px solid rgba(255,255,255,0.07)', display: 'flex', gap: 8 }}>
              <button onClick={send} disabled={sending || !to || !subject} style={{
                background: '#7c3aed', border: 'none', borderRadius: 8, padding: '8px 18px',
                cursor: (!to || !subject) ? 'not-allowed' : 'pointer', color: '#fff', fontWeight: 600, fontSize: '0.82rem',
                opacity: (!to || !subject) ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <Send size={13} /> {sending ? 'Sending...' : 'Send'}
              </button>
              <button style={{ background: 'rgba(255,255,255,0.06)', border: 'none', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', color: '#888' }} title="Attach file">
                <Paperclip size={14} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Email Detail ──────────────────────────────────────────────────────────────
function EmailDetail({ email, onBack, onReply, onStar, onDelete }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#888', padding: 4 }}><ChevronLeft size={18} /></button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: '0.92rem', color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{email.subject}</div>
          <div style={{ fontSize: '0.72rem', color: '#666', marginTop: 1 }}>{email.from || email.to}</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => onStar(email.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: email.starred ? '#f59e0b' : '#555', padding: 4 }}><Star size={15} fill={email.starred ? '#f59e0b' : 'none'} /></button>
          <button onClick={() => onReply(email)} style={{ background: '#7c3aed', border: 'none', borderRadius: 8, padding: '5px 12px', cursor: 'pointer', color: '#fff', fontSize: '0.75rem', fontWeight: 600 }}>Reply</button>
          <button onClick={() => onDelete(email.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 4 }}><Trash2 size={14} /></button>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
        <div style={{ fontSize: '0.78rem', color: '#555', marginBottom: 16 }}>{new Date(email.date).toLocaleString()}</div>
        <div style={{ fontSize: '0.88rem', color: '#ddd', lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>{email.body}</div>
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function MailClient() {
  const [accounts, setAccounts] = useState(loadAccounts)
  const [emails, setEmails] = useState(loadEmails)
  const [activeAccount, setActiveAccount] = useState(() => loadAccounts()[0]?.id || null)
  const [folder, setFolder] = useState('inbox')
  const [selected, setSelected] = useState(null)
  const [search, setSearch] = useState('')
  const [showSetup, setShowSetup] = useState(false)
  const [compose, setCompose] = useState(null) // null | true | emailObj (reply)
  const [replyTo, setReplyTo] = useState(null)

  const acct = accounts.find(a => a.id === activeAccount)
  const folderEmails = (emails[activeAccount]?.[folder] || [])
  const filtered = search.trim()
    ? folderEmails.filter(e => e.subject?.toLowerCase().includes(search.toLowerCase()) || e.from?.toLowerCase().includes(search.toLowerCase()) || e.preview?.toLowerCase().includes(search.toLowerCase()))
    : folderEmails

  const unread = (id) => (emails[id]?.inbox || []).filter(e => !e.read).length

  const markRead = (emailId) => {
    setEmails(prev => {
      const updated = { ...prev }
      const folder_emails = updated[activeAccount]?.[folder] || []
      updated[activeAccount] = {
        ...updated[activeAccount],
        [folder]: folder_emails.map(e => e.id === emailId ? { ...e, read: true } : e),
      }
      localStorage.setItem(STORAGE_EMAILS, JSON.stringify(updated))
      return updated
    })
  }

  const toggleStar = (emailId) => {
    setEmails(prev => {
      const updated = { ...prev }
      const folder_emails = updated[activeAccount]?.[folder] || []
      const email = folder_emails.find(e => e.id === emailId)
      updated[activeAccount] = {
        ...updated[activeAccount],
        [folder]: folder_emails.map(e => e.id === emailId ? { ...e, starred: !e.starred } : e),
        starred: email?.starred
          ? (updated[activeAccount].starred || []).filter(e => e.id !== emailId)
          : [...(updated[activeAccount]?.starred || []), { ...email, starred: true }],
      }
      localStorage.setItem(STORAGE_EMAILS, JSON.stringify(updated))
      return updated
    })
  }

  const deleteEmail = (emailId) => {
    setEmails(prev => {
      const updated = { ...prev }
      const email = (updated[activeAccount]?.[folder] || []).find(e => e.id === emailId)
      updated[activeAccount] = {
        ...updated[activeAccount],
        [folder]: (updated[activeAccount]?.[folder] || []).filter(e => e.id !== emailId),
        trash: [...(updated[activeAccount]?.trash || []), { ...email, deleted: true }],
      }
      localStorage.setItem(STORAGE_EMAILS, JSON.stringify(updated))
      return updated
    })
    setSelected(null)
  }

  const openEmail = (email) => {
    markRead(email.id)
    setSelected(email)
  }

  if (accounts.length === 0) {
    return (
      <div style={{ height: '100%', background: '#08080f', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20 }}>
        <Mail size={56} color="#7c3aed" style={{ opacity: 0.6 }} />
        <div style={{ color: '#fff', fontWeight: 700, fontSize: '1.2rem' }}>No Mail Accounts</div>
        <div style={{ color: '#666', fontSize: '0.85rem', textAlign: 'center', maxWidth: 320 }}>Connect your Gmail, Outlook, Yahoo, or custom IMAP account to get started.</div>
        <button onClick={() => setShowSetup(true)} style={{ background: '#7c3aed', border: 'none', borderRadius: 12, padding: '12px 24px', cursor: 'pointer', color: '#fff', fontWeight: 600, fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Plus size={16} /> Add Mail Account
        </button>
        {showSetup && <AccountSetup onDone={(acct) => { setAccounts(loadAccounts()); setEmails(loadEmails()); setActiveAccount(acct.id); setShowSetup(false) }} onCancel={() => setShowSetup(false)} />}
      </div>
    )
  }

  const selectedEmail = filtered.find(e => e.id === selected?.id) || selected

  return (
    <div style={{ display: 'flex', height: '100%', background: '#08080f', color: '#fff', fontFamily: 'system-ui' }}>
      {/* Sidebar */}
      <div style={{ width: 200, display: 'flex', flexDirection: 'column', borderRight: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        <div style={{ padding: '12px 10px 8px' }}>
          <button onClick={() => setCompose(true)} style={{ width: '100%', background: '#7c3aed', border: 'none', borderRadius: 10, padding: '9px', cursor: 'pointer', color: '#fff', fontWeight: 600, fontSize: '0.82rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}>
            <Plus size={14} /> Compose
          </button>
        </div>
        {/* Accounts */}
        <div style={{ padding: '4px 10px 6px' }}>
          <div style={{ fontSize: '0.65rem', color: '#444', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Accounts</div>
          {accounts.map(a => (
            <button key={a.id} onClick={() => { setActiveAccount(a.id); setFolder('inbox'); setSelected(null) }}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: activeAccount === a.id ? 'rgba(124,58,237,0.2)' : 'none', border: 'none', borderRadius: 8, cursor: 'pointer', textAlign: 'left' }}
            >
              <div style={{ width: 22, height: 22, borderRadius: '50%', background: a.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: '0.6rem', color: '#fff', fontWeight: 700 }}>
                {a.name[0].toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.75rem', fontWeight: 600, color: activeAccount === a.id ? '#a78bfa' : '#ccc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</div>
                <div style={{ fontSize: '0.65rem', color: '#555', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.email}</div>
              </div>
              {unread(a.id) > 0 && <span style={{ background: '#7c3aed', color: '#fff', borderRadius: 10, padding: '1px 5px', fontSize: '0.6rem', fontWeight: 700, flexShrink: 0 }}>{unread(a.id)}</span>}
            </button>
          ))}
          <button onClick={() => setShowSetup(true)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', background: 'none', border: 'none', cursor: 'pointer', color: '#555', fontSize: '0.72rem', textAlign: 'left', borderRadius: 8 }}>
            <Plus size={11} /> Add Account
          </button>
        </div>
        {/* Folders */}
        <div style={{ padding: '4px 10px', flex: 1 }}>
          <div style={{ fontSize: '0.65rem', color: '#444', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Folders</div>
          {FOLDERS.map(f => {
            const Icon = f.icon
            const count = folder === f.id && f.id === 'inbox' ? (emails[activeAccount]?.inbox || []).filter(e => !e.read).length : 0
            return (
              <button key={f.id} onClick={() => { setFolder(f.id); setSelected(null) }}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: folder === f.id ? 'rgba(124,58,237,0.2)' : 'none', border: 'none', borderRadius: 8, cursor: 'pointer', color: folder === f.id ? '#a78bfa' : '#888', textAlign: 'left' }}
              >
                <Icon size={14} />
                <span style={{ flex: 1, fontSize: '0.8rem', fontWeight: folder === f.id ? 600 : 400 }}>{f.label}</span>
                {count > 0 && <span style={{ background: '#7c3aed', color: '#fff', borderRadius: 10, padding: '1px 5px', fontSize: '0.6rem', fontWeight: 700 }}>{count}</span>}
              </button>
            )
          })}
        </div>
      </div>

      {/* Email list */}
      {!selectedEmail && (
        <div style={{ width: 280, display: 'flex', flexDirection: 'column', borderRight: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
          <div style={{ padding: '10px 10px 8px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
            <div style={{ position: 'relative' }}>
              <Search size={12} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: '#555' }} />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search mail..."
                style={{ width: '100%', paddingLeft: 28, paddingRight: 10, height: 32, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: '#fff', fontSize: '0.78rem', outline: 'none', boxSizing: 'border-box' }}
              />
            </div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {filtered.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: '#444', fontSize: '0.8rem' }}>No messages</div>
            )}
            {filtered.map(email => (
              <button key={email.id} onClick={() => openEmail(email)}
                style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 3, padding: '10px 12px', background: selected?.id === email.id ? 'rgba(124,58,237,0.2)' : 'transparent', border: 'none', borderBottom: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer', textAlign: 'left' }}
                onMouseEnter={e => { if (selected?.id !== email.id) e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                onMouseLeave={e => { if (selected?.id !== email.id) e.currentTarget.style.background = 'transparent' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {!email.read && <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#7c3aed', flexShrink: 0 }} />}
                  <span style={{ flex: 1, fontSize: '0.78rem', fontWeight: email.read ? 400 : 700, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{email.from || email.to}</span>
                  <span style={{ fontSize: '0.65rem', color: '#555', flexShrink: 0 }}>{new Date(email.date).toLocaleDateString()}</span>
                </div>
                <div style={{ fontSize: '0.78rem', fontWeight: email.read ? 400 : 600, color: email.read ? '#888' : '#ddd', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{email.subject}</div>
                <div style={{ fontSize: '0.72rem', color: '#555', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{email.preview}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Email detail or empty state */}
      {selectedEmail ? (
        <EmailDetail email={selectedEmail} onBack={() => setSelected(null)} onReply={(e) => { setReplyTo(e); setCompose(true) }} onStar={toggleStar} onDelete={deleteEmail} />
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, color: '#333' }}>
          <Mail size={40} style={{ opacity: 0.2 }} />
          <div style={{ fontSize: '0.85rem', opacity: 0.4 }}>Select a message to read</div>
        </div>
      )}

      {showSetup && <AccountSetup onDone={(acct) => { setAccounts(loadAccounts()); setEmails(loadEmails()); setActiveAccount(acct.id); setShowSetup(false) }} onCancel={() => setShowSetup(false)} />}
      {compose && acct && <Compose account={acct} replyTo={replyTo} onClose={() => { setCompose(false); setReplyTo(null) }} />}
    </div>
  )
}
