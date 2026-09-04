import { useState, useEffect } from 'react'
import { Monitor, Volume2, Bluetooth, Wifi, Keyboard, Mouse, Bell, Clock, Globe, Battery, Users, Shield, Palette, HardDrive, Info, RefreshCw, Lock } from 'lucide-react'
import { useOSStore } from '../store'
import { applyAccent } from '../theme'

const PANELS = [
  { id: 'appearance', label: 'Appearance', icon: Palette, group: 'General' },
  { id: 'display', label: 'Display', icon: Monitor, group: 'General' },
  { id: 'audio', label: 'Sound', icon: Volume2, group: 'General' },
  { id: 'notifications', label: 'Notifications', icon: Bell, group: 'General' },
  { id: 'bluetooth', label: 'Bluetooth', icon: Bluetooth, group: 'Connectivity' },
  { id: 'wifi', label: 'Wi-Fi', icon: Wifi, group: 'Connectivity' },
  { id: 'keyboard', label: 'Keyboard', icon: Keyboard, group: 'Input' },
  { id: 'mouse', label: 'Mouse & Trackpad', icon: Mouse, group: 'Input' },
  { id: 'accessibility', label: 'Accessibility', icon: Users, group: 'Accessibility' },
  { id: 'power', label: 'Battery & Power', icon: Battery, group: 'System' },
  { id: 'time', label: 'Date & Time', icon: Clock, group: 'System' },
  { id: 'language', label: 'Language & Region', icon: Globe, group: 'System' },
  { id: 'privacy', label: 'Privacy & Security', icon: Shield, group: 'Security' },
  { id: 'users', label: 'Users', icon: Users, group: 'Security' },
  { id: 'storage', label: 'Storage', icon: HardDrive, group: 'System' },
  { id: 'updates', label: 'Software Update', icon: RefreshCw, group: 'System' },
  { id: 'about', label: 'About', icon: Info, group: 'System' },
]

const GROUPS = ['General', 'Connectivity', 'Input', 'Accessibility', 'Security', 'System']

const ToggleSwitch = ({ checked, onChange }) => (
  <div onClick={() => onChange(!checked)} style={{ width: 44, height: 24, borderRadius: 99, background: checked ? 'var(--accent)' : 'rgba(255,255,255,0.15)', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
    <div style={{ position: 'absolute', top: 2, left: checked ? 22 : 2, width: 20, height: 20, borderRadius: '50%', background: 'white', transition: 'left 0.2s', boxShadow: '0 1px 4px rgba(0,0,0,0.4)' }} />
  </div>
)

const Slider = ({ value, min = 0, max = 100, onChange }) => (
  <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(+e.target.value)}
    style={{ width: '100%', accentColor: 'var(--accent)', height: 4 }} />
)

function useSettings() {
  const [s, setS] = useState(() => {
    try { return JSON.parse(localStorage.getItem('revos_settings') || 'null') || defaults() } catch { return defaults() }
  })
  const update = (key, val) => {
    setS((prev) => {
      const n = { ...prev, [key]: val }
      localStorage.setItem('revos_settings', JSON.stringify(n))
      if (key === 'accentColor') applyAccent(val)
      window.dispatchEvent(new CustomEvent('revos:settings-changed', { detail: n }))
      return n
    })
  }
  return [s, update]
}

function defaults() {
  return {
    theme: 'dark', accentColor: '#6d28d9', wallpaper: 'nebula',
    brightness: 80, nightMode: false, resolution: '1920x1080',
    volume: 70, micVolume: 60, outputDevice: 'Built-in Speakers', inputDevice: 'Built-in Microphone', soundEffects: true,
    notifications: true, notifSound: true, doNotDisturb: false,
    bluetoothEnabled: true,
    wifiEnabled: true, wifiNetwork: 'HomeNetwork',
    keyRepeatRate: 5, keyDelay: 3, shortcutHints: true,
    mouseSpeed: 5, mouseNatural: true, tapToClick: true,
    reduceMotion: false, highContrast: false, largeText: false, screenReader: false, colorBlindMode: 'none',
    sleep: 10, displaySleep: 5, lowPowerMode: false,
    timezone: 'America/New_York', hour24: false, dateFormat: 'MM/DD/YYYY',
    language: 'en-US', region: 'United States', currency: 'USD',
    firewall: true, autoLock: 5, showPasswordHints: false,
  }
}

export default function Settings() {
  const [active, setActive] = useState('appearance')
  const [settings, update] = useSettings()
  const { user } = useOSStore()

  const panel = PANELS.find((p) => p.id === active)

  return (
    <div style={{ height: '100%', display: 'flex', background: '#09090f' }}>
      {/* Sidebar */}
      <div style={{ width: 200, borderRight: '1px solid rgba(255,255,255,0.07)', overflowY: 'auto', flexShrink: 0, background: 'rgba(0,0,0,0.3)' }}>
        <div style={{ padding: '14px 12px 6px', fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>System Preferences</div>
        {GROUPS.map((group) => (
          <div key={group}>
            <div style={{ padding: '8px 14px 3px', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{group}</div>
            {PANELS.filter((p) => p.group === group).map((p) => {
              const Icon = p.icon
              return (
                <button
                  key={p.id}
                  onClick={() => setActive(p.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '7px 14px',
                    background: active === p.id ? 'rgba(109,40,217,0.25)' : 'none',
                    border: 'none', color: active === p.id ? 'var(--accent)' : 'var(--text-secondary)',
                    cursor: 'pointer', textAlign: 'left', fontSize: 13, borderRadius: 6, margin: '1px 4px',
                    borderLeft: active === p.id ? '2px solid var(--accent)' : '2px solid transparent',
                  }}
                >
                  <Icon size={14} style={{ flexShrink: 0 }} />
                  {p.label}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 28 }}>
        <h2 style={{ margin: '0 0 20px', fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 10 }}>
          {panel && <panel.icon size={18} />}
          {panel?.label}
        </h2>

        {active === 'appearance' && (
          <div style={sectionStyle}>
            <Row label="Color Theme">
              <div style={{ display: 'flex', gap: 8 }}>
                {['dark', 'darker', 'midnight'].map((t) => (
                  <button key={t} onClick={() => update('theme', t)} style={{ padding: '5px 12px', borderRadius: 6, border: `1px solid ${settings.theme === t ? 'var(--accent)' : 'rgba(255,255,255,0.12)'}`, background: settings.theme === t ? 'rgba(109,40,217,0.3)' : 'rgba(255,255,255,0.05)', color: settings.theme === t ? 'var(--accent)' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, textTransform: 'capitalize' }}>{t}</button>
                ))}
              </div>
            </Row>
            <Row label="Accent Color">
              <div style={{ display: 'flex', gap: 8 }}>
                {['#6d28d9', '#2563eb', '#059669', '#dc2626', '#d97706', '#db2777'].map((c) => (
                  <div key={c} onClick={() => update('accentColor', c)} style={{ width: 24, height: 24, borderRadius: '50%', background: c, cursor: 'pointer', border: settings.accentColor === c ? '2px solid white' : '2px solid transparent' }} />
                ))}
              </div>
            </Row>
            <Row label="Wallpaper">
              <div style={{ display: 'flex', gap: 8 }}>
                {['nebula', 'cosmos', 'aurora', 'void'].map((w) => (
                  <button key={w} onClick={() => update('wallpaper', w)} style={{ padding: '5px 12px', borderRadius: 6, border: `1px solid ${settings.wallpaper === w ? 'var(--accent)' : 'rgba(255,255,255,0.12)'}`, background: settings.wallpaper === w ? 'rgba(109,40,217,0.3)' : 'rgba(255,255,255,0.05)', color: settings.wallpaper === w ? 'var(--accent)' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, textTransform: 'capitalize' }}>{w}</button>
                ))}
              </div>
            </Row>
          </div>
        )}

        {active === 'display' && (
          <div style={sectionStyle}>
            <Row label="Brightness"><Slider value={settings.brightness} onChange={(v) => update('brightness', v)} /><span style={numLabel}>{settings.brightness}%</span></Row>
            <Row label="Night Mode"><ToggleSwitch checked={settings.nightMode} onChange={(v) => update('nightMode', v)} /></Row>
            <Row label="Resolution">
              <select value={settings.resolution} onChange={(e) => update('resolution', e.target.value)} style={selectSt}>
                {['1280x800', '1440x900', '1920x1080', '2560x1440', '3840x2160'].map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </Row>
          </div>
        )}

        {active === 'audio' && (
          <div style={sectionStyle}>
            <Row label="Output Volume"><Slider value={settings.volume} onChange={(v) => update('volume', v)} /><span style={numLabel}>{settings.volume}%</span></Row>
            <Row label="Input Volume"><Slider value={settings.micVolume} onChange={(v) => update('micVolume', v)} /><span style={numLabel}>{settings.micVolume}%</span></Row>
            <Row label="Sound Effects"><ToggleSwitch checked={settings.soundEffects} onChange={(v) => update('soundEffects', v)} /></Row>
            <Row label="Output Device">
              <select value={settings.outputDevice} onChange={(e) => update('outputDevice', e.target.value)} style={selectSt}>
                {['Built-in Speakers', 'Headphones', 'AirPods Pro', 'HDMI Audio'].map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </Row>
            <Row label="Input Device">
              <select value={settings.inputDevice} onChange={(e) => update('inputDevice', e.target.value)} style={selectSt}>
                {['Built-in Microphone', 'External Mic', 'AirPods Pro'].map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </Row>
          </div>
        )}

        {active === 'bluetooth' && (
          <div style={sectionStyle}>
            <Row label="Bluetooth"><ToggleSwitch checked={settings.bluetoothEnabled} onChange={(v) => update('bluetoothEnabled', v)} /></Row>
            {settings.bluetoothEnabled && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>NEARBY DEVICES</div>
                {['AirPods Pro (Shane)', 'Logitech MX Keys', 'Apple Magic Mouse 2', 'Sony WH-1000XM5'].map((d) => (
                  <div key={d} style={{ display: 'flex', justify: 'space-between', alignItems: 'center', padding: '8px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.04)', marginBottom: 4 }}>
                    <div style={{ color: 'var(--text-primary)', fontSize: 13 }}>{d}</div>
                    <button style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid rgba(109,40,217,0.5)', background: 'rgba(109,40,217,0.2)', color: 'var(--accent)', cursor: 'pointer', fontSize: 12 }}>Connect</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {active === 'wifi' && (
          <div style={sectionStyle}>
            <Row label="Wi-Fi"><ToggleSwitch checked={settings.wifiEnabled} onChange={(v) => update('wifiEnabled', v)} /></Row>
            {settings.wifiEnabled && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>AVAILABLE NETWORKS</div>
                {['HomeNetwork', 'HomeNetwork_5G', 'Office_Wifi', 'Guest_Network'].map((n) => (
                  <div key={n} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderRadius: 8, background: n === settings.wifiNetwork ? 'rgba(109,40,217,0.2)' : 'rgba(255,255,255,0.04)', marginBottom: 4, border: n === settings.wifiNetwork ? '1px solid rgba(109,40,217,0.4)' : '1px solid transparent' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)', fontSize: 13 }}>
                      <Wifi size={14} style={{ color: n === settings.wifiNetwork ? 'var(--accent)' : 'var(--text-muted)' }} />
                      {n} {n === settings.wifiNetwork && <span style={{ fontSize: 10, color: '#6ee7b7' }}>✓ Connected</span>}
                    </div>
                    {n !== settings.wifiNetwork && <button onClick={() => update('wifiNetwork', n)} style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.06)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12 }}>Join</button>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {active === 'keyboard' && (
          <div style={sectionStyle}>
            <Row label="Key Repeat Rate"><Slider value={settings.keyRepeatRate} min={1} max={10} onChange={(v) => update('keyRepeatRate', v)} /><span style={numLabel}>{settings.keyRepeatRate}</span></Row>
            <Row label="Delay Until Repeat"><Slider value={settings.keyDelay} min={1} max={10} onChange={(v) => update('keyDelay', v)} /><span style={numLabel}>{settings.keyDelay}</span></Row>
            <Row label="Shortcut Hints"><ToggleSwitch checked={settings.shortcutHints} onChange={(v) => update('shortcutHints', v)} /></Row>
          </div>
        )}

        {active === 'mouse' && (
          <div style={sectionStyle}>
            <Row label="Tracking Speed"><Slider value={settings.mouseSpeed} min={1} max={10} onChange={(v) => update('mouseSpeed', v)} /><span style={numLabel}>{settings.mouseSpeed}</span></Row>
            <Row label="Natural Scrolling"><ToggleSwitch checked={settings.mouseNatural} onChange={(v) => update('mouseNatural', v)} /></Row>
            <Row label="Tap to Click"><ToggleSwitch checked={settings.tapToClick} onChange={(v) => update('tapToClick', v)} /></Row>
          </div>
        )}

        {active === 'accessibility' && (
          <div style={sectionStyle}>
            <Row label="Reduce Motion"><ToggleSwitch checked={settings.reduceMotion} onChange={(v) => update('reduceMotion', v)} /></Row>
            <Row label="High Contrast"><ToggleSwitch checked={settings.highContrast} onChange={(v) => update('highContrast', v)} /></Row>
            <Row label="Large Text"><ToggleSwitch checked={settings.largeText} onChange={(v) => update('largeText', v)} /></Row>
            <Row label="Screen Reader"><ToggleSwitch checked={settings.screenReader} onChange={(v) => update('screenReader', v)} /></Row>
            <Row label="Color Blind Mode">
              <select value={settings.colorBlindMode} onChange={(e) => update('colorBlindMode', e.target.value)} style={selectSt}>
                {['none', 'deuteranopia', 'protanopia', 'tritanopia'].map((m) => <option key={m} value={m}>{m === 'none' ? 'None' : m.charAt(0).toUpperCase() + m.slice(1)}</option>)}
              </select>
            </Row>
          </div>
        )}

        {active === 'notifications' && (
          <div style={sectionStyle}>
            <Row label="Enable Notifications"><ToggleSwitch checked={settings.notifications} onChange={(v) => update('notifications', v)} /></Row>
            <Row label="Notification Sounds"><ToggleSwitch checked={settings.notifSound} onChange={(v) => update('notifSound', v)} /></Row>
            <Row label="Do Not Disturb"><ToggleSwitch checked={settings.doNotDisturb} onChange={(v) => update('doNotDisturb', v)} /></Row>
          </div>
        )}

        {active === 'power' && (
          <div style={sectionStyle}>
            <Row label="Sleep After (minutes)"><Slider value={settings.sleep} min={1} max={60} onChange={(v) => update('sleep', v)} /><span style={numLabel}>{settings.sleep}m</span></Row>
            <Row label="Display Sleep (minutes)"><Slider value={settings.displaySleep} min={1} max={30} onChange={(v) => update('displaySleep', v)} /><span style={numLabel}>{settings.displaySleep}m</span></Row>
            <Row label="Low Power Mode"><ToggleSwitch checked={settings.lowPowerMode} onChange={(v) => update('lowPowerMode', v)} /></Row>
          </div>
        )}

        {active === 'time' && (
          <div style={sectionStyle}>
            <Row label="Timezone">
              <select value={settings.timezone} onChange={(e) => update('timezone', e.target.value)} style={selectSt}>
                {['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'UTC'].map((tz) => <option key={tz} value={tz}>{tz}</option>)}
              </select>
            </Row>
            <Row label="24-Hour Format"><ToggleSwitch checked={settings.hour24} onChange={(v) => update('hour24', v)} /></Row>
            <Row label="Date Format">
              <select value={settings.dateFormat} onChange={(e) => update('dateFormat', e.target.value)} style={selectSt}>
                {['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'].map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </Row>
          </div>
        )}

        {active === 'language' && (
          <div style={sectionStyle}>
            <Row label="Language">
              <select value={settings.language} onChange={(e) => update('language', e.target.value)} style={selectSt}>
                {[['en-US', 'English (US)'], ['es-ES', 'Español'], ['fr-FR', 'Français'], ['de-DE', 'Deutsch'], ['zh-CN', '中文'], ['ja-JP', '日本語']].map(([val, label]) => <option key={val} value={val}>{label}</option>)}
              </select>
            </Row>
            <Row label="Region">
              <select value={settings.region} onChange={(e) => update('region', e.target.value)} style={selectSt}>
                {['United States', 'United Kingdom', 'Canada', 'Australia', 'France', 'Germany', 'Japan'].map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </Row>
            <Row label="Currency">
              <select value={settings.currency} onChange={(e) => update('currency', e.target.value)} style={selectSt}>
                {['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY'].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Row>
          </div>
        )}

        {active === 'privacy' && (
          <div style={sectionStyle}>
            <Row label="Firewall"><ToggleSwitch checked={settings.firewall} onChange={(v) => update('firewall', v)} /></Row>
            <Row label="Auto-Lock After (min)"><Slider value={settings.autoLock} min={1} max={30} onChange={(v) => update('autoLock', v)} /><span style={numLabel}>{settings.autoLock}m</span></Row>
            <Row label="Show Password Hints"><ToggleSwitch checked={settings.showPasswordHints} onChange={(v) => update('showPasswordHints', v)} /></Row>
            <div style={{ marginTop: 16, padding: 14, borderRadius: 10, background: 'rgba(109,40,217,0.1)', border: '1px solid rgba(109,40,217,0.25)' }}>
              <div style={{ color: 'var(--accent)', fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}><Shield size={14} /> Security Status</div>
              {['AES-256-GCM encryption active', 'IPC rate limiting: 100/sec', 'CSP headers enforced', 'Context isolation enabled', 'Audit logging active'].map((s) => (
                <div key={s} style={{ color: '#6ee7b7', fontSize: 12, display: 'flex', gap: 6, marginTop: 4 }}>✓ {s}</div>
              ))}
            </div>
          </div>
        )}

        {active === 'users' && (
          <div style={sectionStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, borderRadius: 10, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'linear-gradient(135deg, var(--accent), #1e40af)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 18, color: 'white' }}>{user.name?.[0]?.toUpperCase() || 'U'}</div>
              <div>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{user.name || 'User'}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Administrator</div>
              </div>
            </div>
          </div>
        )}

        {active === 'storage' && <StoragePanel />}
        {active === 'updates' && <UpdatesPanel />}
        {active === 'about' && <AboutPanel />}
      </div>
    </div>
  )
}

function StoragePanel() {
  const items = [
    { label: 'Applications', size: 14.2, color: '#6d28d9' },
    { label: 'Documents', size: 8.7, color: '#2563eb' },
    { label: 'Media', size: 22.4, color: '#059669' },
    { label: 'System', size: 6.1, color: '#d97706' },
    { label: 'Other', size: 3.5, color: '#64748b' },
  ]
  const total = 256, used = items.reduce((a, i) => a + i.size, 0), free = total - used
  return (
    <div style={sectionStyle}>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>{used.toFixed(1)} GB used of {total} GB</div>
      <div style={{ height: 12, borderRadius: 99, overflow: 'hidden', display: 'flex', marginBottom: 16 }}>
        {items.map((item) => (
          <div key={item.label} style={{ width: `${(item.size / total) * 100}%`, background: item.color }} />
        ))}
        <div style={{ flex: 1, background: 'rgba(255,255,255,0.08)' }} />
      </div>
      {items.map((item) => (
        <div key={item.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)', fontSize: 13 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: item.color }} />
            {item.label}
          </div>
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{item.size} GB</span>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', marginTop: 8 }}>
        <span style={{ color: '#6ee7b7', fontWeight: 600 }}>Free Space</span>
        <span style={{ color: '#6ee7b7', fontWeight: 600 }}>{free.toFixed(1)} GB</span>
      </div>
    </div>
  )
}

function UpdatesPanel() {
  const [checking, setChecking] = useState(false)
  const [status, setStatus] = useState(null)
  const check = async () => {
    setChecking(true)
    await new Promise((r) => setTimeout(r, 1500))
    setStatus('up-to-date')
    setChecking(false)
  }
  return (
    <div style={sectionStyle}>
      <div style={{ marginBottom: 16, padding: 14, borderRadius: 10, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Revelations OS</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Version 1.0.0</div>
      </div>
      {status === 'up-to-date' && <div style={{ color: '#6ee7b7', fontSize: 13, marginBottom: 10 }}>✓ Your system is up to date</div>}
      <button onClick={check} disabled={checking} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', borderRadius: 8, background: 'rgba(109,40,217,0.3)', border: '1px solid rgba(109,40,217,0.5)', color: 'var(--accent)', cursor: checking ? 'default' : 'pointer', fontSize: 13 }}>
        <RefreshCw size={14} style={{ animation: checking ? 'spin 1s linear infinite' : 'none' }} />
        {checking ? 'Checking...' : 'Check for Updates'}
      </button>
      <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-muted)' }}>Automatic updates check every Monday and prompt for confirmation before installing.</div>
    </div>
  )
}

// Windows-style About: a device header, then collapsible "specifications" cards
// each with its own Copy button, mirroring Settings > System > About.
function AboutPanel() {
  const [sys, setSys] = useState(null)
  const [version, setVersion] = useState('')
  const [copied, setCopied] = useState('')

  useEffect(() => {
    let alive = true
    Promise.all([
      window.nexus?.getSystemInfo?.() ?? null,
      window.nexus?.getVersion?.() ?? '',
    ]).then(([info, ver]) => {
      if (!alive) return
      setSys(info)
      setVersion(ver || '')
    }).catch(() => {})
    return () => { alive = false }
  }, [])

  const v = window.nexus?.versions || {}
  const platform = window.nexus?.platform || ''
  const platformName = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[platform] || platform || 'Unknown'
  const dash = '—'

  const deviceSpecs = [
    ['Device name', sys?.hostname ?? dash],
    ['Processor', sys?.cpuModel ? `${sys.cpuModel} (${sys.cpuCount} cores)` : dash],
    ['Installed RAM', sys ? `${sys.totalRam} GB (${sys.freeRam} GB free)` : dash],
    ['System type', sys ? `${sys.arch === 'x64' ? '64-bit' : sys.arch} operating system, ${sys.arch} processor` : dash],
    ['Host OS', sys ? `${platformName} ${sys.osRelease}` : platformName],
    ['Signed in as', sys?.username ?? dash],
    ['Uptime', sys ? `${sys.uptime} hour${sys.uptime === 1 ? '' : 's'}` : dash],
  ]

  const osSpecs = [
    ['Edition', 'Revelations OS'],
    ['Version', version || dash],
    ['Electron', v.electron ?? dash],
    ['Chromium', v.chrome ?? dash],
    ['Node.js', v.node ?? dash],
    ['Security', 'AES-256-GCM + contextIsolation'],
  ]

  const supportSpecs = [
    ['Developer', 'Shane Bedasee'],
    ['Company', 'RAXX Beats Studios LLC'],
    ['UEI', 'QHGHVKNDMQ33'],
    ['CAGE', '19WS9'],
  ]

  const copy = (label, rows) => {
    const text = rows.map(([k, val]) => `${k}: ${val}`).join('\n')
    navigator.clipboard?.writeText(text)
      .then(() => {
        setCopied(label)
        setTimeout(() => setCopied(c => (c === label ? '' : c)), 1600)
      })
      .catch(() => {})
  }

  const SpecCard = ({ title, rows }) => (
    <div style={{ ...sectionStyle, padding: 16, marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</span>
        <button onClick={() => copy(title, rows)}
          style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, padding: '4px 12px', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer' }}>
          {copied === title ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map(([k, val]) => (
          <div key={k} style={{ display: 'flex', gap: 12, fontSize: 13 }}>
            <span style={{ color: 'var(--text-muted)', width: 130, flexShrink: 0 }}>{k}</span>
            <span style={{ color: 'var(--text-secondary)', wordBreak: 'break-word' }}>{val}</span>
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <div>
      {/* Device header */}
      <div style={{ ...sectionStyle, padding: 20, flexDirection: 'row', gap: 20, alignItems: 'center' }}>
        <div style={{ width: 72, height: 72, borderRadius: 18, background: 'linear-gradient(135deg, #7c3aed, #1e40af)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, flexShrink: 0 }}>⚔️</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>{sys?.hostname || 'Revelations OS'}</div>
          <div style={{ color: 'var(--text-muted)', marginTop: 4, fontSize: 13 }}>
            Revelations OS{version ? ` · Version ${version}` : ''}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>© 2026 RAXX Beats Studios LLC. All rights reserved.</div>
        </div>
      </div>

      <UpdateCard currentVersion={version} />
      <SpecCard title="Device specifications" rows={deviceSpecs} />
      <SpecCard title="Revelations OS specifications" rows={osSpecs} />
      <SpecCard title="Support information" rows={supportSpecs} />
    </div>
  )
}

// Manual "check now", so the user never has to wait for the background check.
// Finding an update pushes it into the store, which raises the UpdateBanner.
function UpdateCard({ currentVersion }) {
  const setPendingUpdate = useOSStore(s => s.setPendingUpdate)
  const [state, setState] = useState('idle') // idle | checking | current | found | error
  const [info, setInfo] = useState(null)

  const check = async () => {
    setState('checking')
    try {
      const r = await window.nexus?.checkForUpdate?.()
      if (!r) { setState('error'); setInfo({ error: 'Updates are unavailable in this build' }); return }
      setInfo(r)
      if (r.error) { setState('error'); return }
      if (r.available) { setPendingUpdate(r); setState('found') }
      else setState('current')
    } catch (e) {
      setInfo({ error: e?.message || 'Check failed' })
      setState('error')
    }
  }

  const message = {
    idle: 'Check whether a newer version of Revelations OS has been released.',
    checking: 'Checking for updates…',
    current: `You're up to date${currentVersion ? ` — v${currentVersion} is the latest release` : ''}.`,
    found: `Version ${info?.version} is available. Use the banner at the top to install it.`,
    error: `Couldn't check for updates — ${info?.error || 'unknown error'}.`,
  }[state]

  return (
    <div style={{ ...sectionStyle, padding: 16, marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Revelations OS updates</div>
          <div style={{
            fontSize: 12, marginTop: 4,
            color: state === 'error' ? '#f87171' : state === 'found' ? 'var(--accent)' : 'var(--text-muted)',
          }}>{message}</div>
        </div>
        <button onClick={check} disabled={state === 'checking'}
          style={{
            background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6,
            padding: '7px 14px', color: 'var(--text-secondary)', fontSize: 12, flexShrink: 0,
            cursor: state === 'checking' ? 'default' : 'pointer', opacity: state === 'checking' ? 0.6 : 1,
          }}>
          {state === 'checking' ? 'Checking…' : 'Check for updates'}
        </button>
      </div>
    </div>
  )
}

const Row = ({ label, children }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.05)', gap: 16 }}>
    <span style={{ color: 'var(--text-secondary)', fontSize: 14, flexShrink: 0 }}>{label}</span>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, justifyContent: 'flex-end' }}>{children}</div>
  </div>
)

const sectionStyle = { display: 'flex', flexDirection: 'column', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: '4px 16px' }
const numLabel = { color: 'var(--text-muted)', fontSize: 12, width: 36, textAlign: 'right', flexShrink: 0 }
const selectSt = { background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, padding: '5px 8px', color: 'var(--text-primary)', fontSize: 13, outline: 'none' }
