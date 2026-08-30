import { useEffect, useState } from 'react'
import { useOSStore } from '../store'
import TopBar from './TopBar'
import OrbLauncher from './OrbLauncher'
import WindowManager from './WindowManager'
import NotificationCenter from './NotificationCenter'
import Widgets from './Widgets'
import BottomTaskbar, { TASKBAR_HEIGHT } from './BottomTaskbar'
import horsemenLogo from '../assets/raxx-logo.png'
import { WALLPAPERS, getSettings } from '../theme'

export default function Desktop() {
  const { windows, addNotification, openWindow, toggleOrbLauncher } = useOSStore()
  const [contextMenu, setContextMenu] = useState(null)
  const [wallpaper, setWallpaper] = useState(() => getSettings().wallpaper || 'nebula')
  const hasWindows = windows.filter(w => !w.minimized).length > 0

  useEffect(() => {
    const t = setTimeout(() => {
      addNotification({ title: 'Welcome to Revelations OS', body: 'Your secure business desktop is ready.', type: 'success' })
    }, 1500)
    const onSettings = (e) => { if (e.detail?.wallpaper) setWallpaper(e.detail.wallpaper) }
    window.addEventListener('revos:settings-changed', onSettings)
    return () => { clearTimeout(t); window.removeEventListener('revos:settings-changed', onSettings) }
  }, [])


  const handleContextMenu = (e) => {
    if (e.target === e.currentTarget || e.target.classList.contains('desktop-bg')) {
      e.preventDefault()
      setContextMenu({ x: e.clientX, y: e.clientY })
    }
  }

  const handleClick = () => setContextMenu(null)

  return (
    <div
      style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', overflow: 'hidden' }}
      onContextMenu={handleContextMenu}
      onClick={handleClick}
    >
      {/* ── Solid black background ── */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 0, background: '#000', pointerEvents: 'none' }} />

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

      {/* Footer — privacy & support links (only visible when no windows open) */}
      <div style={{
        position: 'absolute', bottom: TASKBAR_HEIGHT + 8, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', gap: 16, zIndex: 6, pointerEvents: hasWindows ? 'none' : 'all',
        opacity: hasWindows ? 0 : 0.45, transition: 'opacity 0.4s ease',
      }}>
        {[
          { label: 'Privacy Policy', appId: 'privacy', title: 'Privacy Policy' },
          { label: 'Support', appId: 'support', title: 'Support' },
        ].map(({ label, appId, title }) => (
          <button key={appId} onClick={() => openWindow({ appId, title, width: 780, height: 560 })}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.5)', fontSize: '0.7rem', textDecoration: 'underline', textUnderlineOffset: 2, padding: 0 }}>
            {label}
          </button>
        ))}
        <span style={{ color: 'rgba(255,255,255,0.2)', fontSize: '0.7rem' }}>· RAXX BEATS STUDIOS LLC</span>
      </div>

      {contextMenu && (
        <div className="context-menu" style={{ top: contextMenu.y, left: contextMenu.x }}>
          <div className="context-menu-item" onClick={() => { openWindow({ appId: 'settings', title: 'Settings' }); setContextMenu(null) }}>
            🖼 Change Wallpaper
          </div>
          <div className="context-menu-item" onClick={() => { addNotification({ title: 'New Folder', body: 'Created on Desktop', type: 'success' }); setContextMenu(null) }}>
            📁 New Folder
          </div>
          <div className="context-menu-separator" />
          <div className="context-menu-item" onClick={() => { toggleOrbLauncher(); setContextMenu(null) }}>
            🚀 Open App Launcher
          </div>
          <div className="context-menu-separator" />
          <div className="context-menu-item" onClick={() => { openWindow({ appId: 'calculator', title: 'Calculator', width: 440, height: 520 }); setContextMenu(null) }}>
            🧮 Calculator
          </div>
          <div className="context-menu-item" onClick={() => { openWindow({ appId: 'clock', title: 'Clock', width: 480, height: 560 }); setContextMenu(null) }}>
            🕐 Clock & Alarms
          </div>
          <div className="context-menu-item" onClick={() => { openWindow({ appId: 'calendar', title: 'Calendar', width: 780, height: 560 }); setContextMenu(null) }}>
            📅 Calendar
          </div>
          <div className="context-menu-item" onClick={() => { openWindow({ appId: 'music', title: 'Music', width: 680, height: 480 }); setContextMenu(null) }}>
            🎵 Music Player
          </div>
          <div className="context-menu-separator" />
          <div className="context-menu-item" onClick={() => { openWindow({ appId: 'settings', title: 'Settings' }); setContextMenu(null) }}>
            ⚙️ System Settings
          </div>
        </div>
      )}
    </div>
  )
}
