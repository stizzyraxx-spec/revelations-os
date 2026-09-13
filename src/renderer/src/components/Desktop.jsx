import { useEffect, useRef, useState } from 'react'
import { useOSStore } from '../store'
import { APP_REGISTRY } from '../constants'
import { useVisibleApps } from '../useVisibleApps'
import AppIcon3D from './AppIcon3D'
import AppTile from './AppTile'
import TopBar from './TopBar'
import OrbLauncher from './OrbLauncher'
import WindowManager from './WindowManager'
import NotificationCenter from './NotificationCenter'
import Widgets from './Widgets'
import BottomTaskbar from './BottomTaskbar'
import horsemenLogo from '../assets/raxx-logo.png'
import { WALLPAPERS, getSettings } from '../theme'
import { X, Search } from 'lucide-react'

const DESKTOP_ICONS_KEY = 'revos_desktop_icons'
const DESKTOP_SEEDED_KEY = 'revos_desktop_seeded_v1'
const DESKTOP_POS_KEY = 'revos_desktop_positions'
// Profiles seeded before RaxxWare joined the defaults already carry the seeded
// flag, so the icon would never appear for them. This adds it once, on its own
// key, instead of re-running the whole seed and resurrecting icons the user
// deliberately removed.
const RAXXWARE_ICON_KEY = 'revos_desktop_raxxware_v1'

// Free-placement grid. Icons snap to it when dropped, and unplaced icons fill
// the first column down the left, clear of the widgets panel at the top.
const GRID_X = 92
const GRID_Y = 104
const ORIGIN_X = 12
const ORIGIN_Y = 300

// Placed on the desktop the first time a profile signs in. Filtered through the
// same profile gating as every other listing, so a user who cannot see RaxxWare
// does not get an icon for it.
//
// Whether seeding has happened is recorded under its own key rather than
// inferred from an empty icon list — otherwise clearing every icon would look
// identical to a first run and they would all come back on the next load.
const DEFAULT_DESKTOP_ICONS = ['raxxware', 'files', 'terminal', 'settings']

function loadDesktopIcons() {
  try { return JSON.parse(localStorage.getItem(DESKTOP_ICONS_KEY) || '[]') } catch { return [] }
}
function saveDesktopIcons(ids) {
  try { localStorage.setItem(DESKTOP_ICONS_KEY, JSON.stringify(ids)) } catch {}
}
function loadPositions() {
  try { return JSON.parse(localStorage.getItem(DESKTOP_POS_KEY) || '{}') } catch { return {} }
}
function savePositions(map) {
  try { localStorage.setItem(DESKTOP_POS_KEY, JSON.stringify(map)) } catch {}
}

// Snap a dropped icon to the nearest cell, kept inside the desktop: clear of the
// top bar, and clear of the taskbar at the bottom.
function snapToGrid(x, y) {
  const maxX = Math.max(ORIGIN_X, window.innerWidth - 96)
  const maxY = Math.max(56, window.innerHeight - 150)
  const sx = ORIGIN_X + Math.round((x - ORIGIN_X) / GRID_X) * GRID_X
  const sy = ORIGIN_Y + Math.round((y - ORIGIN_Y) / GRID_Y) * GRID_Y
  return {
    x: Math.min(Math.max(sx, 8), maxX),
    y: Math.min(Math.max(sy, 56), maxY),
  }
}

// Where an icon sits when it has never been dragged: down the left edge, then
// into the next column once it would run into the taskbar.
function autoSlot(index) {
  const perColumn = Math.max(1, Math.floor((window.innerHeight - ORIGIN_Y - 120) / GRID_Y))
  return {
    x: ORIGIN_X + Math.floor(index / perColumn) * GRID_X,
    y: ORIGIN_Y + (index % perColumn) * GRID_Y,
  }
}

const WALLPAPER_LABELS = { brimstone: 'Brimstone', nebula: 'Nebula', cosmos: 'Cosmos', aurora: 'Aurora', void: 'Void' }

export default function Desktop() {
  // Registry as this profile sees it; shadows the module import so every
  // listing below is profile-filtered. See useVisibleApps.js.
  const APP_REGISTRY = useVisibleApps()

  const { windows, addNotification, openWindow, openSubscription, toggleOrbLauncher, customApps, activeDesktop } = useOSStore()
  const [contextMenu, setContextMenu] = useState(null)
  const [iconMenu, setIconMenu] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const [wallpaper, setWallpaper] = useState(() => getSettings().wallpaper || 'brimstone')
  const [desktopIcons, setDesktopIcons] = useState(loadDesktopIcons)
  const [iconPos, setIconPos] = useState(loadPositions)
  const [dragging, setDragging] = useState(null) // { id, x, y } while a drag is live
  const [selectedIcon, setSelectedIcon] = useState(null)
  const [displayModalOpen, setDisplayModalOpen] = useState(false)
  const [displayInfo, setDisplayInfo] = useState(null)
  const [displayMsg, setDisplayMsg] = useState('')
  // Only windows on the desktop you are looking at hide the icons — switching
  // to an empty virtual desktop shows the wallpaper and shortcuts again.
  const hasWindows = windows.some(w => !w.minimized && (w.desktop ?? 1) === activeDesktop)

  // Seed the default icons once per browser profile. Runs after APP_REGISTRY is
  // resolved so gated apps are filtered out, and re-runs if the signed-in
  // profile changes from one that could not see RaxxWare to one that can.
  useEffect(() => {
    if (localStorage.getItem(DESKTOP_SEEDED_KEY)) return
    if (!APP_REGISTRY.length) return // registry not resolved yet
    const seed = DEFAULT_DESKTOP_ICONS.filter(id => APP_REGISTRY.some(a => a.id === id))
    if (!seed.length) return
    setDesktopIcons(prev => {
      const next = [...new Set([...prev, ...seed])]
      saveDesktopIcons(next)
      return next
    })
    try { localStorage.setItem(DESKTOP_SEEDED_KEY, '1') } catch {}
  }, [APP_REGISTRY])

  // RaxxWare is how this machine reaches the programs and files on the gateway,
  // so make sure the shortcut exists even on a profile that was seeded before
  // RaxxWare was a default. Runs once, and only for profiles that can see it.
  useEffect(() => {
    if (localStorage.getItem(RAXXWARE_ICON_KEY)) return
    if (!APP_REGISTRY.some(a => a.id === 'raxxware')) return
    setDesktopIcons(prev => {
      if (prev.includes('raxxware')) return prev
      const next = ['raxxware', ...prev]
      saveDesktopIcons(next)
      return next
    })
    try { localStorage.setItem(RAXXWARE_ICON_KEY, '1') } catch {}
  }, [APP_REGISTRY])

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
    setIconPos(prev => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      savePositions(next)
      return next
    })
  }

  // True between the end of a drag and the click event it produces, so dropping
  // an icon never also launches it.
  const draggedRef = useRef(false)

  // Drag an icon to a new spot. A press that never travels more than a few
  // pixels is left alone so it still registers as a click.
  const startIconDrag = (e, id, from) => {
    if (e.button !== 0) return
    e.preventDefault()
    setSelectedIcon(id)
    draggedRef.current = false
    const startX = e.clientX
    const startY = e.clientY
    let moved = false

    const onMove = (ev) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (!moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return
      moved = true
      draggedRef.current = true
      setDragging({ id, x: from.x + dx, y: from.y + dy })
    }
    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setDragging(null)
      if (!moved) return
      const dropped = snapToGrid(from.x + (ev.clientX - startX), from.y + (ev.clientY - startY))
      setIconPos(prev => {
        const next = { ...prev, [id]: dropped }
        savePositions(next)
        return next
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const handleContextMenu = (e) => {
    if (e.target === e.currentTarget || e.target.classList.contains('desktop-bg')) {
      e.preventDefault()
      setIconMenu(null)
      setContextMenu({ x: e.clientX, y: e.clientY })
    }
  }

  const handleClick = () => { setContextMenu(null); setIconMenu(null); setSelectedIcon(null) }

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

      {/* Desktop icons (saved app shortcuts) — drag to rearrange, double-click
          to open. The layer itself ignores the mouse so right-clicking bare
          desktop still reaches the wallpaper menu; each icon opts back in. */}
      <div style={{
        position: 'absolute', inset: 0, zIndex: 5, pointerEvents: 'none',
        opacity: hasWindows ? 0 : 1, transition: 'opacity 0.3s ease',
      }}>
        {desktopIcons.map((id) => {
          const app = allApps.find(a => a.id === id)
          if (!app) return null
          // Icons that have never been dragged fill the default column in
          // order, ignoring the ones the user has already placed by hand.
          const home = iconPos[id] || autoSlot(desktopIcons.filter(x => !iconPos[x]).indexOf(id))
          const live = dragging?.id === id ? dragging : home
          const isDragging = dragging?.id === id
          const selected = selectedIcon === id
          return (
            <div
              key={id}
              className="rx-icon-host"
              onMouseDown={(e) => startIconDrag(e, id, home)}
              // A single click opens the app. Dragging also ends in a click
              // event, so a drop is filtered out here rather than launching.
              onClick={(e) => {
                e.stopPropagation()
                if (draggedRef.current) { draggedRef.current = false; return }
                launchById(id)
              }}
              onDoubleClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setContextMenu(null); setSelectedIcon(id); setIconMenu({ id, x: e.clientX, y: e.clientY }) }}
              title={`${app.name} — click to open, drag to move`}
              style={{
                position: 'absolute', left: live.x, top: live.y,
                width: 84, padding: '10px 4px', borderRadius: 10,
                cursor: isDragging ? 'grabbing' : 'default',
                pointerEvents: hasWindows ? 'none' : 'auto',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                background: selected ? 'rgba(255,255,255,0.14)' : 'transparent',
                border: `1px solid ${selected ? 'rgba(255,255,255,0.22)' : 'transparent'}`,
                boxSizing: 'border-box',
                zIndex: isDragging ? 2 : 1,
                opacity: isDragging ? 0.85 : 1,
                userSelect: 'none',
                transition: isDragging ? 'none' : 'background 0.12s, left 0.12s, top 0.12s',
              }}
              onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
              onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = 'transparent' }}
            >
              <AppIcon3D app={app} size={46} />
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

      {/* Window manager. The layer must not take the mouse itself: it covers the
          whole desktop above the icons, so with the default pointer-events every
          click aimed at an icon was landing on this transparent div instead of
          the icon. Windows re-enable it individually (AppWindow). */}
      <div style={{ position: 'absolute', inset: 0, top: 40, zIndex: 10, pointerEvents: 'none' }}>
        <WindowManager />
      </div>

      {/* Bottom taskbar — Start menu + running/pinned apps (Windows-style) */}
      <BottomTaskbar />

      {/* Notification center */}
      <NotificationCenter />

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
                const already = desktopIcons.includes(app.id)
                return (
                  <AppTile
                    key={app.id}
                    app={app}
                    size="sm"
                    title={already ? 'Already on desktop' : `Add ${app.name}`}
                    onClick={() => { addIcon(app.id); addNotification({ title: 'Added to Desktop', body: app.name, type: 'success' }) }}
                    badge={already ? <span style={{ fontSize: '0.55rem', color: '#6ee7b7' }}>✓ on desktop</span> : null}
                  />
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
