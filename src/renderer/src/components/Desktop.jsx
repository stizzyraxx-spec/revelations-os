import { useEffect, useState } from 'react'
import { useOSStore } from '../store'
import TopBar from './TopBar'
import OrbLauncher from './OrbLauncher'
import WindowManager from './WindowManager'
import NotificationCenter from './NotificationCenter'
import Widgets from './Widgets'
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
      {/* Animated blue gradient wallpaper */}
      <div className="desktop-bg" style={{
        position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
        background: WALLPAPERS[wallpaper] || WALLPAPERS.nebula,
        backgroundSize: '400% 400%',
        animation: 'bgShift 24s ease infinite',
      }}>
        <div style={{ position: 'absolute', inset: 0, backgroundImage: 'radial-gradient(rgba(255,255,255,0.03) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />
      </div>

      {/* Desktop center — "Revelations" + horsemen logo, hidden when windows open */}
      <div style={{
        position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none',
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
          }}
        />
      </div>

      {/* TopBar */}
      <TopBar />

      {/* Launcher tab — always visible */}
      <OrbLauncher />

      {/* Widgets — only when no windows */}
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
