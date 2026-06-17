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
      {/* ── Deep space base gradient ── */}
      <div className="desktop-bg" style={{
        position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
        background: WALLPAPERS[wallpaper] || WALLPAPERS.nebula,
        backgroundSize: '400% 400%',
        animation: 'bgShift 24s ease infinite',
      }} />

      {/* ── Nebula cloud layers ── */}
      <div style={{
        position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none', overflow: 'hidden',
      }}>
        {/* Large violet nebula mass — upper left */}
        <div style={{
          position: 'absolute', width: '75vw', height: '65vh',
          top: '-15vh', left: '-20vw',
          background: 'radial-gradient(ellipse at 40% 40%, rgba(109,28,200,0.28) 0%, rgba(60,10,120,0.14) 45%, transparent 75%)',
          animation: 'nebula 18s ease-in-out infinite',
          filter: 'blur(32px)',
        }} />
        {/* Blue nebula mass — right side */}
        <div style={{
          position: 'absolute', width: '60vw', height: '70vh',
          top: '5vh', right: '-15vw',
          background: 'radial-gradient(ellipse at 55% 45%, rgba(20,60,200,0.22) 0%, rgba(10,30,100,0.12) 50%, transparent 75%)',
          animation: 'nebula 22s ease-in-out infinite reverse',
          filter: 'blur(40px)',
        }} />
        {/* Cyan accent — lower center */}
        <div style={{
          position: 'absolute', width: '45vw', height: '45vh',
          bottom: '-10vh', left: '28vw',
          background: 'radial-gradient(ellipse at 50% 50%, rgba(0,180,220,0.12) 0%, rgba(0,80,140,0.06) 55%, transparent 80%)',
          animation: 'nebula 28s ease-in-out infinite',
          filter: 'blur(48px)',
        }} />
        {/* Subtle red dwarf — upper right */}
        <div style={{
          position: 'absolute', width: '35vw', height: '35vh',
          top: '0', right: '8vw',
          background: 'radial-gradient(ellipse at 50% 50%, rgba(180,20,60,0.10) 0%, transparent 65%)',
          animation: 'nebula 32s ease-in-out infinite reverse',
          filter: 'blur(36px)',
        }} />
      </div>

      {/* ── Star field ── */}
      <div style={{
        position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none',
        backgroundImage: `
          radial-gradient(1px 1px at 12% 18%, rgba(255,255,255,0.85) 0%, transparent 100%),
          radial-gradient(1px 1px at 28% 7%,  rgba(255,255,255,0.70) 0%, transparent 100%),
          radial-gradient(1px 1px at 43% 24%, rgba(255,255,255,0.60) 0%, transparent 100%),
          radial-gradient(1px 1px at 57% 11%, rgba(255,255,255,0.80) 0%, transparent 100%),
          radial-gradient(1px 1px at 71% 32%, rgba(255,255,255,0.55) 0%, transparent 100%),
          radial-gradient(1px 1px at 84% 8%,  rgba(255,255,255,0.75) 0%, transparent 100%),
          radial-gradient(1px 1px at 93% 21%, rgba(255,255,255,0.65) 0%, transparent 100%),
          radial-gradient(1px 1px at  6% 45%, rgba(255,255,255,0.50) 0%, transparent 100%),
          radial-gradient(1px 1px at 19% 62%, rgba(255,255,255,0.70) 0%, transparent 100%),
          radial-gradient(1px 1px at 35% 78%, rgba(255,255,255,0.45) 0%, transparent 100%),
          radial-gradient(1px 1px at 50% 55%, rgba(255,255,255,0.60) 0%, transparent 100%),
          radial-gradient(1px 1px at 65% 68%, rgba(255,255,255,0.80) 0%, transparent 100%),
          radial-gradient(1px 1px at 78% 48%, rgba(255,255,255,0.55) 0%, transparent 100%),
          radial-gradient(1px 1px at 90% 72%, rgba(255,255,255,0.65) 0%, transparent 100%),
          radial-gradient(1.5px 1.5px at 22% 88%, rgba(200,220,255,0.70) 0%, transparent 100%),
          radial-gradient(1.5px 1.5px at 48% 92%, rgba(220,200,255,0.65) 0%, transparent 100%),
          radial-gradient(1.5px 1.5px at 76% 85%, rgba(200,230,255,0.60) 0%, transparent 100%),
          radial-gradient(2px 2px at  8% 35%, rgba(255,240,200,0.50) 0%, transparent 100%),
          radial-gradient(2px 2px at 62% 14%, rgba(200,220,255,0.55) 0%, transparent 100%),
          radial-gradient(2px 2px at 88% 58%, rgba(255,220,200,0.45) 0%, transparent 100%)
        `,
      }} />

      {/* ── Dot grid overlay (subtle depth texture) ── */}
      <div style={{
        position: 'absolute', inset: 0, zIndex: 3, pointerEvents: 'none',
        backgroundImage: 'radial-gradient(rgba(255,255,255,0.025) 1px, transparent 1px)',
        backgroundSize: '40px 40px',
      }} />

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
