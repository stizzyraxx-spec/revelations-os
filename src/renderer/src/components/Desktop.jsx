import { useEffect, useState } from 'react'
import { useOSStore } from '../store'
import TopBar from './TopBar'
import OrbLauncher from './OrbLauncher'
import WindowManager from './WindowManager'
import NotificationCenter from './NotificationCenter'
import Widgets from './Widgets'
import Dock from './Dock'
import horsemenLogo from '../assets/raxx-logo.png'
import { WALLPAPERS, getSettings } from '../theme'

export default function Desktop() {
  const { windows, addNotification } = useOSStore()
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

      {/* Left dock — open windows */}
      <Dock />

      {/* Notification center */}
      <NotificationCenter />

      {contextMenu && (
        <div className="context-menu" style={{ top: contextMenu.y, left: contextMenu.x }}>
          <div className="context-menu-item" onClick={() => { useOSStore.getState().openWindow({ appId: 'settings', title: 'Settings' }); setContextMenu(null) }}>
            🖼 Change Wallpaper
          </div>
          <div className="context-menu-item" onClick={() => { addNotification({ title: 'New Folder', body: 'Created on Desktop', type: 'success' }); setContextMenu(null) }}>
            📁 New Folder
          </div>
          <div className="context-menu-separator" />
          <div className="context-menu-item" onClick={() => { useOSStore.getState().toggleOrbLauncher(); setContextMenu(null) }}>
            🚀 Open App Launcher
          </div>
          <div className="context-menu-item" onClick={() => { useOSStore.getState().openWindow({ appId: 'settings', title: 'Settings' }); setContextMenu(null) }}>
            ⚙️ System Settings
          </div>
        </div>
      )}
    </div>
  )
}
