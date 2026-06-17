import { useState } from 'react'
import { Calendar, Plus, Trash2, RefreshCw, CheckCircle, AlertCircle, Link, X, Eye, EyeOff } from 'lucide-react'

const STORAGE = 'revos_cal_connections'

const PROVIDERS = [
  { id: 'google',  label: 'Google Calendar', color: '#4285f4', emoji: '📅', authType: 'oauth',  hint: 'Sign in with Google' },
  { id: 'apple',   label: 'Apple iCal',      color: '#1d4ed8', emoji: '🗓', authType: 'ical',   hint: 'Paste your iCloud calendar URL' },
  { id: 'outlook', label: 'Outlook/Office 365', color: '#0078d4', emoji: '📆', authType: 'ical', hint: 'Paste your Outlook calendar URL' },
  { id: 'caldav',  label: 'CalDAV / Custom', color: '#7c3aed', emoji: '🔗', authType: 'caldav', hint: 'Enter CalDAV server URL' },
  { id: 'ical',    label: 'ICS Feed URL',    color: '#374151', emoji: '📋', authType: 'ical',   hint: 'Paste any .ics subscription URL' },
]

const COLORS = ['#7c3aed','#ef4444','#f59e0b','#10b981','#3b82f6','#ec4899','#14b8a6','#f97316']

const load = () => { try { return JSON.parse(localStorage.getItem(STORAGE)) || [] } catch { return [] } }
const save = (list) => localStorage.setItem(STORAGE, JSON.stringify(list))

// Simulates fetching/syncing a calendar (real implementation needs Electron IPC for CORS)
async function simulateSync(conn) {
  await new Promise(r => setTimeout(r, 1200))
  return { events: Math.floor(Math.random() * 40) + 5, lastSync: new Date().toISOString() }
}

function ConnectForm({ onDone, onCancel }) {
  const [step, setStep] = useState('provider')
  const [provider, setProvider] = useState(null)
  const [form, setForm] = useState({ label: '', url: '', username: '', password: '', color: COLORS[0] })
  const [syncing, setSyncing] = useState(false)
  const [showPass, setShowPass] = useState(false)
  const [error, setError] = useState('')

  const connect = async () => {
    if (!form.label.trim()) { setError('Calendar name is required'); return }
    if (provider.authType !== 'oauth' && !form.url.trim()) { setError('URL is required'); return }
    setSyncing(true); setError('')
    try {
      const result = await simulateSync(form)
      const conn = {
        id: Date.now(),
        label: form.label,
        provider: provider.id,
        color: form.color,
        url: form.url,
        username: form.username,
        eventCount: result.events,
        lastSync: result.lastSync,
        enabled: true,
      }
      const list = load()
      list.push(conn)
      save(list)
      onDone(conn)
    } catch {
      setError('Connection failed — check your URL/credentials')
    }
    setSyncing(false)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 460, background: '#0d0d1a', borderRadius: 20, border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 24px 80px rgba(0,0,0,0.8)', overflow: 'hidden' }} className="animate-scale-in">
        <div style={{ padding: '18px 22px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Calendar size={18} color="#7c3aed" />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#fff' }}>Connect Calendar</div>
            <div style={{ fontSize: '0.72rem', color: '#666' }}>Sync external calendars into Revelations OS</div>
          </div>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#555' }}><X size={16} /></button>
        </div>

        <div style={{ padding: 22 }}>
          {step === 'provider' && (
            <div>
              <div style={{ fontSize: '0.82rem', color: '#aaa', marginBottom: 14 }}>Choose a calendar service:</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {PROVIDERS.map(p => (
                  <button key={p.id} onClick={() => { setProvider(p); setForm(f => ({ ...f, label: p.label })); setStep('form') }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
                      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: 12, cursor: 'pointer', color: '#fff', textAlign: 'left', transition: 'all 0.15s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = `${p.color}88`; e.currentTarget.style.background = `${p.color}11` }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                  >
                    <div style={{ width: 36, height: 36, borderRadius: 10, background: `${p.color}22`, border: `1px solid ${p.color}44`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>
                      {p.emoji}
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>{p.label}</div>
                      <div style={{ fontSize: '0.72rem', color: '#666', marginTop: 1 }}>{p.hint}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 'form' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <button onClick={() => setStep('provider')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#7c3aed', padding: 0 }}>← Back</button>
                <div style={{ fontSize: '0.85rem', color: '#aaa' }}>{provider.emoji} {provider.label}</div>
              </div>

              <div>
                <label style={{ fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: 5 }}>Calendar Name</label>
                <input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="My Work Calendar"
                  style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '9px 12px', color: '#fff', fontSize: '0.85rem', outline: 'none', boxSizing: 'border-box' }}
                />
              </div>

              {provider.authType === 'oauth' ? (
                <div style={{ background: 'rgba(66,133,244,0.1)', border: '1px solid rgba(66,133,244,0.3)', borderRadius: 12, padding: '16px', textAlign: 'center' }}>
                  <div style={{ fontSize: '0.85rem', color: '#93c5fd', marginBottom: 8 }}>OAuth sign-in requires the full desktop app with Electron IPC bridge.</div>
                  <div style={{ fontSize: '0.75rem', color: '#666' }}>Export your Google Calendar as an ICS URL and use "ICS Feed URL" instead.</div>
                </div>
              ) : (
                <>
                  <div>
                    <label style={{ fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: 5 }}>
                      {provider.authType === 'caldav' ? 'CalDAV URL' : 'Calendar URL / ICS Feed'}
                    </label>
                    <input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                      placeholder={provider.authType === 'caldav' ? 'https://caldav.example.com/dav/' : 'https://calendar.google.com/calendar/ical/.../basic.ics'}
                      style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '9px 12px', color: '#fff', fontSize: '0.82rem', outline: 'none', boxSizing: 'border-box' }}
                    />
                  </div>
                  {provider.authType === 'caldav' && (
                    <>
                      <div>
                        <label style={{ fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: 5 }}>Username</label>
                        <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                          style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '9px 12px', color: '#fff', fontSize: '0.85rem', outline: 'none', boxSizing: 'border-box' }}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: 5 }}>Password / App Password</label>
                        <div style={{ position: 'relative' }}>
                          <input type={showPass ? 'text' : 'password'} value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                            style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '9px 36px 9px 12px', color: '#fff', fontSize: '0.85rem', outline: 'none', boxSizing: 'border-box' }}
                          />
                          <button onClick={() => setShowPass(s => !s)} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#555' }}>
                            {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </>
              )}

              {/* Color picker */}
              <div>
                <label style={{ fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: 8 }}>Calendar Color</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {COLORS.map(c => (
                    <div key={c} onClick={() => setForm(f => ({ ...f, color: c }))} style={{ width: 22, height: 22, borderRadius: '50%', background: c, cursor: 'pointer', border: form.color === c ? '3px solid #fff' : '2px solid transparent', boxSizing: 'border-box' }} />
                  ))}
                </div>
              </div>

              {error && <div style={{ fontSize: '0.78rem', color: '#ef4444', padding: '8px 12px', background: 'rgba(239,68,68,0.1)', borderRadius: 8 }}>{error}</div>}

              <button onClick={connect} disabled={syncing} style={{
                background: syncing ? '#374151' : '#7c3aed', border: 'none', borderRadius: 10, padding: '11px',
                cursor: syncing ? 'not-allowed' : 'pointer', color: '#fff', fontWeight: 600, fontSize: '0.88rem', marginTop: 4,
              }}>
                {syncing ? 'Connecting & syncing...' : 'Connect Calendar'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function CalendarConnector() {
  const [connections, setConnections] = useState(load)
  const [showForm, setShowForm] = useState(false)
  const [syncing, setSyncing] = useState(null)

  const reload = () => setConnections(load())

  const sync = async (conn) => {
    setSyncing(conn.id)
    const result = await simulateSync(conn)
    const updated = connections.map(c => c.id === conn.id ? { ...c, eventCount: result.events, lastSync: result.lastSync } : c)
    save(updated); setConnections(updated)
    setSyncing(null)
  }

  const toggle = (id) => {
    const updated = connections.map(c => c.id === id ? { ...c, enabled: !c.enabled } : c)
    save(updated); setConnections(updated)
  }

  const del = (id) => {
    const updated = connections.filter(c => c.id !== id)
    save(updated); setConnections(updated)
  }

  const relTime = (ts) => {
    if (!ts) return 'Never'
    const diff = (Date.now() - new Date(ts).getTime()) / 1000
    if (diff < 60) return 'Just now'
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    return `${Math.floor(diff / 3600)}h ago`
  }

  return (
    <div style={{ height: '100%', background: '#08080f', color: '#fff', fontFamily: 'system-ui', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Calendar size={18} color="#dc2626" />
        <span style={{ fontWeight: 700, fontSize: '1rem', flex: 1 }}>Calendar Connections</span>
        <button onClick={() => setShowForm(true)} style={{ background: '#7c3aed', border: 'none', borderRadius: 10, padding: '8px 14px', cursor: 'pointer', color: '#fff', fontWeight: 600, fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Plus size={14} /> Add Calendar
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px' }}>
        {connections.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 240, gap: 16, color: '#444' }}>
            <Calendar size={48} style={{ opacity: 0.15 }} />
            <div style={{ fontSize: '0.9rem', fontWeight: 600, color: '#555' }}>No calendars connected</div>
            <div style={{ fontSize: '0.8rem', color: '#444', textAlign: 'center', maxWidth: 300 }}>Connect Google Calendar, iCloud, Outlook, or any ICS feed to see events in your Calendar app.</div>
            <button onClick={() => setShowForm(true)} style={{ background: 'rgba(124,58,237,0.2)', border: '1px solid rgba(124,58,237,0.4)', borderRadius: 12, padding: '10px 20px', cursor: 'pointer', color: '#a78bfa', fontWeight: 600 }}>
              Connect First Calendar
            </button>
          </div>
        )}

        {connections.map(conn => {
          const prov = PROVIDERS.find(p => p.id === conn.provider) || PROVIDERS[4]
          return (
            <div key={conn.id} style={{
              background: conn.enabled ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.2)',
              border: `1px solid ${conn.enabled ? `${conn.color}44` : 'rgba(255,255,255,0.05)'}`,
              borderLeft: `4px solid ${conn.enabled ? conn.color : '#333'}`,
              borderRadius: 14, padding: '14px 16px', marginBottom: 12,
              opacity: conn.enabled ? 1 : 0.6,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ fontSize: 22, flexShrink: 0 }}>{prov.emoji}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: '0.9rem', color: '#fff' }}>{conn.label}</div>
                  <div style={{ fontSize: '0.72rem', color: '#666', marginTop: 2 }}>
                    {prov.label} · {conn.eventCount || 0} events · Last sync: {relTime(conn.lastSync)}
                  </div>
                  {conn.url && <div style={{ fontSize: '0.68rem', color: '#555', marginTop: 2, wordBreak: 'break-all' }}>{conn.url.slice(0, 60)}{conn.url.length > 60 ? '...' : ''}</div>}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: conn.enabled ? '#22c55e' : '#555' }} />
                    <span style={{ fontSize: '0.68rem', color: conn.enabled ? '#22c55e' : '#555' }}>{conn.enabled ? 'Active' : 'Paused'}</span>
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button onClick={() => sync(conn)} disabled={syncing === conn.id}
                  style={{ background: 'rgba(255,255,255,0.06)', border: 'none', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', color: '#aaa', fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <RefreshCw size={12} style={{ animation: syncing === conn.id ? 'spin 1s linear infinite' : 'none' }} />
                  {syncing === conn.id ? 'Syncing...' : 'Sync Now'}
                </button>
                <button onClick={() => toggle(conn.id)}
                  style={{ background: 'rgba(255,255,255,0.06)', border: 'none', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', color: '#aaa', fontSize: '0.78rem' }}>
                  {conn.enabled ? 'Pause' : 'Resume'}
                </button>
                <button onClick={() => del(conn.id)}
                  style={{ background: 'rgba(239,68,68,0.08)', border: 'none', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', color: '#ef4444', fontSize: '0.78rem', marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <Trash2 size={12} /> Remove
                </button>
              </div>
            </div>
          )
        })}

        <div style={{ margin: '16px 0', padding: '14px 16px', background: 'rgba(124,58,237,0.06)', border: '1px solid rgba(124,58,237,0.15)', borderRadius: 12 }}>
          <div style={{ fontWeight: 600, fontSize: '0.82rem', color: '#a78bfa', marginBottom: 6 }}>📋 How to get your ICS URL</div>
          <div style={{ fontSize: '0.75rem', color: '#777', lineHeight: 1.7 }}>
            <b style={{ color: '#aaa' }}>Google Calendar:</b> Settings → click a calendar → Integrate → copy the "Secret address in iCal format"<br />
            <b style={{ color: '#aaa' }}>Apple iCloud:</b> Settings → iCloud → Calendar → Sharing → copy the private link<br />
            <b style={{ color: '#aaa' }}>Outlook:</b> Calendar → Publish → copy ICS link
          </div>
        </div>
      </div>

      {showForm && <ConnectForm onDone={() => { reload(); setShowForm(false) }} onCancel={() => setShowForm(false)} />}
      <style>{`@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}
