import { useState, useEffect } from 'react'
import { Bell, BellOff, Volume2, VolumeX, Monitor, Mail, Calendar, MessageSquare, Shield, Clock, Zap, ToggleLeft, ToggleRight, Plus, Trash2 } from 'lucide-react'

const STORAGE = 'revos_notif_settings'

const defaultSettings = {
  master: true,
  sound: true,
  banner: true,
  doNotDisturb: false,
  dndStart: '22:00',
  dndEnd: '07:00',
  apps: {
    mail:      { enabled: true,  sound: true,  banner: true,  label: 'Mail',           icon: 'Mail' },
    calendar:  { enabled: true,  sound: true,  banner: true,  label: 'Calendar',       icon: 'Calendar' },
    meetings:  { enabled: true,  sound: true,  banner: true,  label: 'Meetings',       icon: 'Video' },
    system:    { enabled: true,  sound: false, banner: true,  label: 'System Alerts',  icon: 'Monitor' },
    faith:     { enabled: true,  sound: false, banner: true,  label: 'Faith Updates',  icon: 'Shield' },
    messages:  { enabled: true,  sound: true,  banner: true,  label: 'Messages',       icon: 'MessageSquare' },
  },
  customAlerts: [],
  reminderMinutes: 15,
}

const load = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE))
    return saved ? { ...defaultSettings, ...saved, apps: { ...defaultSettings.apps, ...saved.apps } } : defaultSettings
  } catch { return defaultSettings }
}

const ICON_MAP = { Mail, Calendar, Monitor, MessageSquare, Shield, Clock, Zap, Bell, Video: Bell }

function Toggle({ on, onChange, size = 'md' }) {
  const w = size === 'sm' ? 34 : 44
  const h = size === 'sm' ? 18 : 24
  const dot = size === 'sm' ? 14 : 18
  return (
    <div onClick={() => onChange(!on)} style={{
      width: w, height: h, borderRadius: h, background: on ? '#7c3aed' : 'rgba(255,255,255,0.12)',
      position: 'relative', cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0,
    }}>
      <div style={{
        position: 'absolute', top: (h - dot) / 2, left: on ? w - dot - (h - dot) / 2 : (h - dot) / 2,
        width: dot, height: dot, borderRadius: '50%', background: '#fff',
        transition: 'left 0.2s', boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
      }} />
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: '0.72rem', color: '#555', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 10, fontWeight: 600 }}>{title}</div>
      <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 14, overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  )
}

function Row({ label, sub, left, right, last }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px',
      borderBottom: last ? 'none' : '1px solid rgba(255,255,255,0.05)',
    }}>
      {left && <div style={{ flexShrink: 0 }}>{left}</div>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.85rem', color: '#fff', fontWeight: 500 }}>{label}</div>
        {sub && <div style={{ fontSize: '0.72rem', color: '#666', marginTop: 2 }}>{sub}</div>}
      </div>
      {right}
    </div>
  )
}

export default function NotificationsManager() {
  const [s, setS] = useState(load)
  const [newAlertLabel, setNewAlertLabel] = useState('')
  const [newAlertTime, setNewAlertTime] = useState('09:00')
  const [testSent, setTestSent] = useState(false)

  const save = (updated) => { setS(updated); localStorage.setItem(STORAGE, JSON.stringify(updated)) }
  const set = (key, val) => save({ ...s, [key]: val })
  const setApp = (appId, key, val) => save({ ...s, apps: { ...s.apps, [appId]: { ...s.apps[appId], [key]: val } } })

  const sendTest = () => {
    // Dispatch a test notification via the OS notification system
    if (window.Notification?.permission === 'granted') {
      new window.Notification('Revelations OS', { body: 'Test notification — your alerts are working!', icon: '/icon.png' })
    }
    setTestSent(true)
    setTimeout(() => setTestSent(false), 2500)
  }

  const requestPermission = () => {
    window.Notification?.requestPermission()
  }

  const addCustomAlert = () => {
    if (!newAlertLabel.trim()) return
    const updated = { ...s, customAlerts: [...s.customAlerts, { id: Date.now(), label: newAlertLabel.trim(), time: newAlertTime, enabled: true }] }
    save(updated)
    setNewAlertLabel('')
  }

  const delCustomAlert = (id) => save({ ...s, customAlerts: s.customAlerts.filter(a => a.id !== id) })
  const toggleCustomAlert = (id) => save({ ...s, customAlerts: s.customAlerts.map(a => a.id === id ? { ...a, enabled: !a.enabled } : a) })

  const notifPermission = window.Notification?.permission || 'default'

  return (
    <div style={{ height: '100%', background: '#08080f', color: '#fff', fontFamily: 'system-ui', overflowY: 'auto', padding: '20px 24px' }}>
      <div style={{ maxWidth: 600, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
          <Bell size={20} color="#7c3aed" />
          <h1 style={{ margin: 0, fontWeight: 700, fontSize: '1.1rem' }}>Notification Settings</h1>
        </div>

        {/* Permission banner */}
        {notifPermission !== 'granted' && (
          <div style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 12, padding: '12px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 12 }}>
            <Bell size={16} color="#f59e0b" />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: '0.85rem', color: '#f59e0b' }}>System notifications disabled</div>
              <div style={{ fontSize: '0.75rem', color: '#999', marginTop: 2 }}>Allow Revelations OS to show system banner alerts</div>
            </div>
            <button onClick={requestPermission} style={{ background: '#f59e0b', border: 'none', borderRadius: 8, padding: '6px 14px', cursor: 'pointer', color: '#000', fontWeight: 600, fontSize: '0.78rem', flexShrink: 0 }}>
              Enable
            </button>
          </div>
        )}

        {/* Master toggle */}
        <Section title="Global">
          <Row label="Allow Notifications" sub="Master switch for all alerts"
            left={<Bell size={16} color="#7c3aed" />}
            right={<Toggle on={s.master} onChange={v => set('master', v)} />}
          />
          <Row label="Notification Sound" sub="Play a sound with each alert"
            left={<Volume2 size={16} color="#3b82f6" />}
            right={<Toggle on={s.sound} onChange={v => set('sound', v)} />}
          />
          <Row label="Banner Alerts" sub="Show pop-up banners on screen"
            left={<Monitor size={16} color="#10b981" />}
            right={<Toggle on={s.banner} onChange={v => set('banner', v)} />}
          />
          <Row label="Test Alert" sub="Send a test notification right now"
            left={<Zap size={16} color="#f59e0b" />}
            right={
              <button onClick={sendTest} style={{ background: testSent ? '#22c55e' : 'rgba(124,58,237,0.2)', border: `1px solid ${testSent ? '#22c55e' : 'rgba(124,58,237,0.4)'}`, borderRadius: 8, padding: '6px 14px', cursor: 'pointer', color: testSent ? '#fff' : '#a78bfa', fontSize: '0.78rem', fontWeight: 600, transition: 'all 0.2s' }}>
                {testSent ? '✓ Sent!' : 'Send Test'}
              </button>
            }
            last
          />
        </Section>

        {/* Do Not Disturb */}
        <Section title="Do Not Disturb">
          <Row label="Do Not Disturb" sub="Silence all notifications"
            left={<BellOff size={16} color="#ef4444" />}
            right={<Toggle on={s.doNotDisturb} onChange={v => set('doNotDisturb', v)} />}
          />
          <Row label="Scheduled DND" sub={`From ${s.dndStart} to ${s.dndEnd}`}
            left={<Clock size={16} color="#888" />}
            right={
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="time" value={s.dndStart} onChange={e => set('dndStart', e.target.value)}
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '5px 8px', color: '#fff', fontSize: '0.8rem', outline: 'none' }}
                />
                <span style={{ color: '#555', fontSize: '0.75rem' }}>to</span>
                <input type="time" value={s.dndEnd} onChange={e => set('dndEnd', e.target.value)}
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '5px 8px', color: '#fff', fontSize: '0.8rem', outline: 'none' }}
                />
              </div>
            }
            last
          />
        </Section>

        {/* Meeting reminder */}
        <Section title="Meeting Reminders">
          <Row label="Remind me before meetings"
            sub={`${s.reminderMinutes} minutes before start`}
            left={<Calendar size={16} color="#f97316" />}
            right={
              <select value={s.reminderMinutes} onChange={e => set('reminderMinutes', parseInt(e.target.value))}
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '6px 10px', color: '#fff', fontSize: '0.8rem', outline: 'none' }}>
                {[5, 10, 15, 30, 60].map(n => <option key={n} value={n}>{n} min</option>)}
              </select>
            }
            last
          />
        </Section>

        {/* Per-app */}
        <Section title="App Notifications">
          {Object.entries(s.apps).map(([id, app], i, arr) => {
            const Icon = ICON_MAP[app.icon] || Bell
            return (
              <Row key={id}
                label={app.label}
                sub={`${app.sound ? 'Sound · ' : ''}${app.banner ? 'Banner' : 'Silent'}`}
                left={<Icon size={16} color="#888" />}
                right={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ fontSize: '0.68rem', color: '#555' }}>Sound</span>
                      <Toggle on={app.sound && app.enabled} onChange={v => setApp(id, 'sound', v)} size="sm" />
                    </div>
                    <Toggle on={app.enabled} onChange={v => setApp(id, 'enabled', v)} />
                  </div>
                }
                last={i === arr.length - 1}
              />
            )
          })}
        </Section>

        {/* Custom alerts */}
        <Section title="Custom Daily Alerts">
          {s.customAlerts.map((a, i) => (
            <Row key={a.id}
              label={a.label}
              sub={`Daily at ${a.time}`}
              left={<Bell size={16} color="#a78bfa" />}
              right={
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Toggle on={a.enabled} onChange={() => toggleCustomAlert(a.id)} size="sm" />
                  <button onClick={() => delCustomAlert(a.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 4 }}><Trash2 size={13} /></button>
                </div>
              }
              last={i === s.customAlerts.length - 1}
            />
          ))}
          <div style={{ padding: '12px 16px', borderTop: s.customAlerts.length ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={newAlertLabel} onChange={e => setNewAlertLabel(e.target.value)} placeholder="Alert label..."
                style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '8px 10px', color: '#fff', fontSize: '0.82rem', outline: 'none' }}
              />
              <input type="time" value={newAlertTime} onChange={e => setNewAlertTime(e.target.value)}
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '8px 10px', color: '#fff', fontSize: '0.82rem', outline: 'none' }}
              />
              <button onClick={addCustomAlert} style={{ background: '#7c3aed', border: 'none', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', color: '#fff' }}><Plus size={15} /></button>
            </div>
          </div>
        </Section>

        <div style={{ paddingBottom: 20, fontSize: '0.72rem', color: '#444', textAlign: 'center' }}>
          Settings are saved automatically to this device
        </div>
      </div>
    </div>
  )
}
