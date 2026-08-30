import { useEffect, useState } from 'react'
import { useOSStore } from '../store'
import { APP_REGISTRY } from '../constants'
import { getAppIcon } from './appIcons'
import TopBar from './TopBar'
import OrbLauncher from './OrbLauncher'
import WindowManager from './WindowManager'
import NotificationCenter from './NotificationCenter'
import Widgets from './Widgets'
import BottomTaskbar, { TASKBAR_HEIGHT } from './BottomTaskbar'
import horsemenLogo from '../assets/raxx-logo.png'
import { WALLPAPERS, getSettings } from '../theme'
import { X, Search } from 'lucide-react'

const DESKTOP_ICONS_KEY = 'revos_desktop_icons'
function loadDesktopIcons() {
  try { return JSON.parse(localStorage.getItem(DESKTOP_ICONS_KEY) || '[]') } catch { return [] }
}
function saveDesktopIcons(ids) {
  try { localStorage.setItem(DESKTOP_ICONS_KEY, JSON.stringify(ids)) } catch {}
}

const WALLPAPER_LABELS = { nebula: 'Nebula', cosmos: 'Cosmos', aurora: 'Aurora', void: 'Void' }

export default function Desktop() {
  const { windows, addNotification, openWindow, openSubscription, toggleOrbLauncher, customApps } = useOSStore()
  const [contextMenu, setContextMenu] = useState(null)
  const [iconMenu, setIconMenu] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const [wallpaper, setWallpaper] = useState(() => getSettings().wallpaper || 'nebula')
  const [desktopIcons, setDesktopIcons] = useState(loadDesktopIcons)
  const [displayModalOpen, setDisplayModalOpen] = useState(false)
  const [displayInfo, setDisplayInfo] = useState(null)
  const [displayMsg, setDisplayMsg] = useState('')
  const hasWindows = windows.filter(w => !w.minimized).length > 0

  const openDisplayModal = async () => {
    setContextMenu(null); setDisplayMsg(''); setDisplayModalOpen(true)
    try { setDisplayInfo(await window.nexus?.displayList?.()) } catch { setDisplayInfo(null) }
  }
  const applyDisplayMode = async (mode) => {
    try {
      const res = await window.nexus?.displaySetMode?.(mode)
      setDisplayMsg(res?.ok ? `Applied: ${mode}` : (res?.reason || 'Display control unavailable'))
      try { setDisplayInfo(await window.nexus?.displayList?.()) } catch {}
    } catch { setDisplayMsg('Display control unavailable') }
  }

  const allApps = [...APP_REGISTRY, ...customApps]

  useEffect(() => {
    const t = setTimeout(() => {
      addNotification({ title: 'Welcome to Revelations OS', body: 'Your secure business desktop is ready.', type: 'success' })
    }, 1500)
    const onSettings = (e) => { if (e.detail?.wallpaper) setWallpaper(e.detail.wallpaper) }
    window.addEventListener('revos:settings-changed', onSettings)
    return () => { clearTimeout(t); window.removeEventListener('revos:settings-changed', onSettings) }
  }, [])

  const setBackground = (key) => {
    const s = getSettings()
    s.wallpaper = key
    try { localStorage.setItem('revos_settings', JSON.stringify(s)) } catch {}
    setWallpaper(key)
    window.dispatchEvent(new CustomEvent('revos:settings-changed', { detail: { wallpaper: key } }))
  }

  const launchById = (id) => {
    const app = allApps.find(a => a.id === id)
    if (!app) return
    if (app.free === false) { openSubscription(app); return }
    openWindow({ appId: app.id, title: app.name, props: app.liveUrl ? { liveUrl: app.liveUrl, appId: app.id, appName: app.name } : {} })
  }

  const addIcon = (id) => {
    setDesktopIcons(prev => {
      const next = prev.includes(id) ? prev : [...prev, id]
      saveDesktopIcons(next)
      return next
    })
  }
  const removeIcon = (id) => {
    setDesktopIcons(prev => {
      const next = prev.filter(x => x !== id)
      saveDesktopIcons(next)
      return next
    })
  }

  const handleContextMenu = (e) => {
    if (e.target === e.currentTarget || e.target.classList.contains('desktop-bg')) {
      e.preventDefault()
      setIconMenu(null)
      setContextMenu({ x: e.clientX, y: e.clientY })
    }
  }

  const handleClick = () => { setContextMenu(null); setIconMenu(null) }

  const pickerApps = pickerQuery.trim()
    ? allApps.filter(a => a.name.toLowerCase().includes(pickerQuery.toLowerCase()))
    : allApps

  return (
    <div
      style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', overflow: 'hidden' }}
      onContextMenu={handleContextMenu}
      onClick={handleClick}
    >
      {/* ── Wallpaper background ── */}
      <div className="desktop-bg" style={{ position: 'absolute', inset: 0, zIndex: 0, background: WALLPAPERS[wallpaper] || WALLPAPERS.nebula, transition: 'background 0.5s ease' }} />

      {/* Desktop center — horsemen logo, hidden when windows open */}
      <div style={{
        position: 'absolute', inset: 0, zIndex: 4, pointerEvents: 'none',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        opacity: hasWindows ? 0 : 1,
        transition: 'opacity 0.4s ease',
      }}>
        <img
          src={horsemenLogo}
          alt="Revelations OS"
          style={{
            width: 'clamp(380px, 55vw, 820px)',
            maxHeight: '58vh',
            objectFit: 'contain',
            userSelect: 'none',
            pointerEvents: 'none',
            opacity: 0.95,
            filter: 'drop-shadow(0 0 40px rgba(109,40,217,0.35)) drop-shadow(0 0 80px rgba(60,20,120,0.25))',
          }}
        />
      </div>

      {/* Desktop icons (saved app shortcuts) */}
      <div style={{
        position: 'absolute', top: 300, left: 12, zIndex: 5,
        display: 'flex', flexDirection: 'column', flexWrap: 'wrap', maxHeight: 'calc(100vh - 380px)', gap: 4,
        pointerEvents: hasWindows ? 'none' : 'all', opacity: hasWindows ? 0 : 1, transition: 'opacity 0.3s ease',
      }}>
        {desktopIcons.map(id => {
          const app = allApps.find(a => a.id === id)
          if (!app) return null
          const Icon = getAppIcon(app.icon)
          return (
            <div
              key={id}
              onDoubleClick={() => launchById(id)}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setContextMenu(null); setIconMenu({ id, x: e.clientX, y: e.clientY }) }}
              title={`${app.name} — double-click to open`}
              style={{
                width: 84, padding: '10px 4px', borderRadius: 10, cursor: 'default',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                transition: 'background 0.12s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              <div style={{ width: 46, height: 46, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `linear-gradient(135deg, ${app.color}44, ${app.color}99)`, border: `1px solid ${app.color}55` }}>
                <Icon size={24} style={{ color: app.color }} />
              </div>
              <span style={{ fontSize: '0.68rem', color: '#fff', textAlign: 'center', width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
                {app.name}
              </span>
            </div>
          )
        })}
      </div>

      {/* TopBar */}
      <TopBar />

      {/* Launcher tab */}
      <OrbLauncher />

      {/* Widgets */}
      <div style={{
        position: 'absolute', left: 16, top: 56, zIndex: 50,
        opacity: hasWindows ? 0 : 1,
        pointerEvents: hasWindows ? 'none' : 'all',
        transition: 'opacity 0.4s ease',
      }}>
        <Widgets />
      </div>

      {/* Window manager */}
      <div style={{ position: 'absolute', inset: 0, top: 40, zIndex: 10 }}>
        <WindowManager />
      </div>

      {/* Bottom taskbar — Start menu + running/pinned apps (Windows-style) */}
      <BottomTaskbar />

      {/* Notification center */}
      <NotificationCenter />

      {/* Footer — support link (only visible when no windows open) */}
      <div style={{
        position: 'absolute', bottom: TASKBAR_HEIGHT + 8, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', gap: 16, zIndex: 6, pointerEvents: hasWindows ? 'none' : 'all',
        opacity: hasWindows ? 0 : 0.45, transition: 'opacity 0.4s ease',
      }}>
        {[
          { label: 'Support', appId: 'support', title: 'Support' },
        ].map(({ label, appId, title }) => (
          <button key={appId} onClick={() => openWindow({ appId, title, width: 780, height: 560 })}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.5)', fontSize: '0.7rem', textDecoration: 'underline', textUnderlineOffset: 2, padding: 0 }}>
            {label}
          </button>
        ))}
        <span style={{ color: 'rgba(255,255,255,0.2)', fontSize: '0.7rem' }}>· RAXX BEATS STUDIOS LLC</span>
      </div>

      {/* Desktop right-click menu */}
      {contextMenu && (
        <div className="context-menu" style={{ top: contextMenu.y, left: contextMenu.x, minWidth: 210 }}>
          <div className="context-menu-item" onClick={() => { setPickerOpen(true); setContextMenu(null) }}>
            ➕ Add App to Desktop
          </div>
          <div className="context-menu-item" onClick={openDisplayModal}>
            🖥 Display (Project to second screen)
          </div>
          <div className="context-menu-separator" />
          <div style={{ padding: '6px 12px 4px', fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Change Background</div>
          <div style={{ display: 'flex', gap: 6, padding: '2px 12px 8px' }}>
            {Object.keys(WALLPAPERS).map(key => (
              <button
                key={key}
                title={WALLPAPER_LABELS[key]}
                onClick={() => { setBackground(key); setContextMenu(null) }}
                style={{
                  width: 34, height: 24, borderRadius: 6, cursor: 'pointer',
                  background: WALLPAPERS[key],
                  border: `2px solid ${wallpaper === key ? 'var(--accent)' : 'rgba(255,255,255,0.2)'}`,
                }}
              />
            ))}
          </div>
          <div className="context-menu-separator" />
          <div className="context-menu-item" onClick={() => { toggleOrbLauncher(); setContextMenu(null) }}>
            🚀 Open App Launcher
          </div>
          <div className="context-menu-item" onClick={() => { openWindow({ appId: 'calculator', title: 'Calculator', width: 440, height: 520 }); setContextMenu(null) }}>
            🧮 Calculator
          </div>
          <div className="context-menu-item" onClick={() => { openWindow({ appId: 'clock', title: 'Clock', width: 480, height: 560 }); setContextMenu(null) }}>
            🕐 Clock & Alarms
          </div>
          <div className="context-menu-separator" />
          <div className="context-menu-item" onClick={() => { openWindow({ appId: 'settings', title: 'Settings' }); setContextMenu(null) }}>
            ⚙️ System Settings
          </div>
        </div>
      )}

      {/* Desktop-icon right-click menu */}
      {iconMenu && (
        <div className="context-menu" style={{ top: iconMenu.y, left: iconMenu.x }} onClick={e => e.stopPropagation()}>
          <div className="context-menu-item" onClick={() => { launchById(iconMenu.id); setIconMenu(null) }}>⇱ Open</div>
          <div className="context-menu-separator" />
          <div className="context-menu-item danger" onClick={() => { removeIcon(iconMenu.id); setIconMenu(null) }}>✕ Remove from Desktop</div>
        </div>
      )}

      {/* App picker for "Add App to Desktop" */}
      {pickerOpen && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={(e) => { if (e.target === e.currentTarget) { setPickerOpen(false); setPickerQuery('') } }}
        >
          <div style={{ width: 520, maxWidth: '90vw', maxHeight: '76vh', background: 'rgba(8,8,16,0.98)', backdropFilter: 'blur(24px)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 16, boxShadow: '0 24px 64px rgba(0,0,0,0.7)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px 10px' }}>
              <div style={{ fontSize: '1rem', fontWeight: 700, color: '#fff' }}>Add App to Desktop</div>
              <button onClick={() => { setPickerOpen(false); setPickerQuery('') }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
            </div>
            <div style={{ position: 'relative', margin: '0 16px 12px' }}>
              <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input autoFocus value={pickerQuery} onChange={e => setPickerQuery(e.target.value)} placeholder="Search apps..."
                style={{ width: '100%', height: 38, paddingLeft: 36, paddingRight: 12, borderRadius: 19, fontSize: '0.85rem', background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box' }} />
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '4px 12px 16px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, alignContent: 'start' }}>
              {pickerApps.map(app => {
                const Icon = getAppIcon(app.icon)
                const already = desktopIcons.includes(app.id)
                return (
                  <button key={app.id} onClick={() => { addIcon(app.id); addNotification({ title: 'Added to Desktop', body: app.name, type: 'success' }) }} title={already ? 'Already on desktop' : `Add ${app.name}`}
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '12px 4px 8px', background: already ? 'rgba(109,40,217,0.18)' : 'rgba(255,255,255,0.04)', border: `1px solid ${already ? 'var(--border-accent)' : 'var(--border)'}`, borderRadius: 14, cursor: 'pointer', color: 'var(--text-primary)' }}>
                    <div style={{ width: 40, height: 40, borderRadius: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `linear-gradient(135deg, ${app.color}44, ${app.color}99)`, border: `1px solid ${app.color}44` }}>
                      <Icon size={20} style={{ color: app.color }} />
                    </div>
                    <span style={{ fontSize: '0.62rem', textAlign: 'center', width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{app.name}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Display projection (multi-monitor) */}
      {displayModalOpen && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={(e) => { if (e.target === e.currentTarget) setDisplayModalOpen(false) }}
        >
          <div style={{ width: 420, maxWidth: '90vw', background: 'rgba(8,8,16,0.98)', backdropFilter: 'blur(24px)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 16, boxShadow: '0 24px 64px rgba(0,0,0,0.7)', padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <div style={{ fontSize: '1rem', fontWeight: 700, color: '#fff' }}>Display</div>
              <button onClick={() => setDisplayModalOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 14 }}>
              {displayInfo
                ? (displayInfo.hasExternal ? `${displayInfo.count} displays detected` : 'Only one display detected — connect a second monitor to duplicate or extend.')
                : 'Detecting displays…'}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {[
                { mode: 'internal', label: 'PC screen only', icon: '🖥' },
                { mode: 'duplicate', label: 'Duplicate', icon: '🖥🖥' },
                { mode: 'extend', label: 'Extend', icon: '🖥➕' },
                { mode: 'external', label: 'Second screen only', icon: '📺' },
              ].map(opt => {
                const disabled = opt.mode !== 'internal' && !(displayInfo?.hasExternal)
                return (
                  <button key={opt.mode} onClick={() => applyDisplayMode(opt.mode)} disabled={disabled}
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '16px 8px', borderRadius: 12, cursor: disabled ? 'not-allowed' : 'pointer', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', color: 'var(--text-primary)', opacity: disabled ? 0.45 : 1 }}>
                    <span style={{ fontSize: 22 }}>{opt.icon}</span>
                    <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{opt.label}</span>
                  </button>
                )
              })}
            </div>
            {displayMsg && <div style={{ marginTop: 14, fontSize: '0.78rem', color: displayMsg.startsWith('Applied') ? '#6ee7b7' : '#fbbf24', textAlign: 'center' }}>{displayMsg}</div>}
          </div>
        </div>
      )}
    </div>
  )
}
