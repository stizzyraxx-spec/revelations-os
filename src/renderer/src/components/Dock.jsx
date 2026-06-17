import { useState, useEffect, useRef } from 'react'
import { useOSStore } from '../store'
import { APP_REGISTRY } from '../constants'
import {
  Globe, Folder, Settings2, TerminalSquare, FileText, Shield, Store,
  FileStack, Calculator, ShoppingBag, Music2, Scale, AlertTriangle, Heart,
  Microscope, Wine, Target, BookOpen, Lightbulb, Send, TrendingUp, Search,
  LayoutDashboard, Mic, PawPrint, Scissors, Star, BarChart2, Headphones,
  Briefcase, Building, GraduationCap, Hammer, Trophy, Command, Car,
  Building2, ShoppingCart, Waves, BookHeart,
  Flame, Users, Radio, Compass, Gamepad2, BookMarked, HandHeart,
  MessageSquare, UserCircle, ScrollText, DollarSign,
} from 'lucide-react'

const ICON_MAP = {
  Globe, Folder, Settings2, TerminalSquare, FileText, Shield, Store,
  FileStack, Calculator, ShoppingBag, Music2, Scale, AlertTriangle, Heart,
  Microscope, Wine, Target, BookOpen, Lightbulb, Send, TrendingUp, Search,
  LayoutDashboard, Mic, PawPrint, Scissors, Star, BarChart2, Headphones,
  Briefcase, Building, GraduationCap, Hammer, Trophy, Command, Car,
  Building2, ShoppingCart, Waves, BookHeart,
  Flame, Users, Radio, Compass, Gamepad2, BookMarked, HandHeart,
  MessageSquare, UserCircle, ScrollText, DollarSign,
}

const STORAGE_KEY = 'revos_dock_pinned'

function loadPinned() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') } catch { return [] }
}

function savePinned(ids) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
}

const EDGE_THRESHOLD = 4   // px from left edge to start timer
const REVEAL_DELAY   = 2000 // ms held at edge before showing

export default function Dock() {
  const { windows, focusWindow, closeWindow, restoreWindow, minimizeWindow } = useOSStore()
  const [pinned, setPinned] = useState(loadPinned)
  const [menu, setMenu] = useState(null)
  const [visible, setVisible] = useState(false)
  const menuRef = useRef(null)
  const timerRef = useRef(null)
  const dockRef = useRef(null)

  // Show dock when cursor is held at left edge for 2s
  useEffect(() => {
    const onMove = (e) => {
      if (e.clientX <= EDGE_THRESHOLD) {
        if (!timerRef.current) {
          timerRef.current = setTimeout(() => setVisible(true), REVEAL_DELAY)
        }
      } else {
        clearTimeout(timerRef.current)
        timerRef.current = null
        // Hide if mouse leaves the dock area
        if (e.clientX > 60) setVisible(false)
      }
    }
    window.addEventListener('mousemove', onMove)
    return () => { window.removeEventListener('mousemove', onMove); clearTimeout(timerRef.current) }
  }, [])

  // Dismiss context menu on outside click
  useEffect(() => {
    if (!menu) return
    const dismiss = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenu(null)
    }
    window.addEventListener('mousedown', dismiss)
    return () => window.removeEventListener('mousedown', dismiss)
  }, [menu])

  const handlePin = (appId) => {
    const next = pinned.includes(appId) ? pinned.filter(id => id !== appId) : [...pinned, appId]
    setPinned(next)
    savePinned(next)
    setMenu(null)
  }

  const handleClose = (winId, appId) => {
    closeWindow(winId)
    if (!pinned.includes(appId)) {
      // Nothing extra needed — item disappears because window is gone and not pinned
    }
    setMenu(null)
  }

  // Build dock items: open windows + pinned apps with no open window
  const openByAppId = {}
  windows.forEach(w => { openByAppId[w.appId] = w })

  const dockItems = []
  const seen = new Set()

  // Add all open windows first
  windows.forEach(w => {
    seen.add(w.appId)
    dockItems.push({ winId: w.id, appId: w.appId, window: w, pinned: pinned.includes(w.appId) })
  })

  // Add pinned apps that have no open window
  pinned.forEach(appId => {
    if (!seen.has(appId)) {
      dockItems.push({ winId: null, appId, window: null, pinned: true })
    }
  })

  if (dockItems.length === 0) return null

  return (
    <>
      {/* Left dock strip */}
      <div ref={dockRef} style={{
        position: 'fixed',
        left: 0,
        top: 40,
        width: 60,
        height: 'calc(100vh - 40px)',
        background: 'rgba(6,6,10,0.96)',
        borderRight: '1px solid rgba(255,255,255,0.06)',
        backdropFilter: 'blur(16px)',
        zIndex: 500,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: 12,
        paddingBottom: 12,
        gap: 6,
        overflowY: 'auto',
        scrollbarWidth: 'none',
        transform: visible ? 'translateX(0)' : 'translateX(-100%)',
        transition: 'transform 0.28s cubic-bezier(0.4,0,0.2,1)',
        pointerEvents: visible ? 'all' : 'none',
      }}>
        {dockItems.map((item) => {
          const reg = APP_REGISTRY.find(a => a.id === item.appId)
          const IconComp = ICON_MAP[reg?.icon] || Globe
          const color = reg?.color || '#6d28d9'
          const label = reg?.name || item.appId
          const isActive = item.window && item.window.focused
          const isMinimized = item.window?.minimized

          const handleClick = () => {
            if (!item.window) {
              // Pinned with no window — open it
              const { openWindow } = useOSStore.getState()
              if (reg?.free && reg?.liveUrl) {
                openWindow({ appId: item.appId, title: label, props: { liveUrl: reg.liveUrl, appId: item.appId, appName: label } })
              } else if (reg?.free) {
                openWindow({ appId: item.appId, title: label })
              }
              return
            }
            if (isMinimized) {
              restoreWindow(item.winId)
            } else if (isActive) {
              minimizeWindow(item.winId)
            } else {
              focusWindow(item.winId)
            }
          }

          const handleContextMenu = (e) => {
            e.preventDefault()
            e.stopPropagation()
            setMenu({ winId: item.winId, appId: item.appId, x: e.clientX, y: e.clientY })
          }

          return (
            <div
              key={`${item.appId}-${item.winId}`}
              title={label}
              onClick={handleClick}
              onContextMenu={handleContextMenu}
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: isActive
                  ? `linear-gradient(135deg, ${color}55, ${color}99)`
                  : isMinimized
                  ? 'rgba(255,255,255,0.05)'
                  : 'rgba(255,255,255,0.04)',
                border: isActive
                  ? `1px solid ${color}88`
                  : `1px solid rgba(255,255,255,0.08)`,
                cursor: 'pointer',
                position: 'relative',
                transition: 'background 0.15s, transform 0.15s, border-color 0.15s',
                opacity: item.window === null ? 0.55 : 1,
                flexShrink: 0,
              }}
              onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.12)'; e.currentTarget.style.background = `linear-gradient(135deg, ${color}44, ${color}77)` }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.background = isActive ? `linear-gradient(135deg, ${color}55, ${color}99)` : isMinimized ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.04)' }}
            >
              <IconComp size={22} color={isActive ? '#fff' : color} />

              {/* Minimized indicator dot */}
              {isMinimized && (
                <div style={{
                  position: 'absolute', bottom: 3, right: 3,
                  width: 5, height: 5, borderRadius: '50%',
                  background: color, opacity: 0.8,
                }} />
              )}

              {/* Pin indicator */}
              {item.pinned && (
                <div style={{
                  position: 'absolute', top: 2, right: 2,
                  width: 4, height: 4, borderRadius: '50%',
                  background: 'rgba(255,255,255,0.5)',
                }} />
              )}
            </div>
          )
        })}
      </div>

      {/* Context menu */}
      {menu && (
        <div
          ref={menuRef}
          style={{
            position: 'fixed',
            left: menu.x + 4,
            top: menu.y,
            zIndex: 9999,
            background: 'rgba(10,10,20,0.97)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 10,
            padding: '4px 0',
            minWidth: 160,
            boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            backdropFilter: 'blur(20px)',
          }}
          onClick={e => e.stopPropagation()}
        >
          <button
            onClick={() => handlePin(menu.appId)}
            style={menuItemStyle}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(109,40,217,0.25)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            {pinned.includes(menu.appId) ? '📌 Unpin' : '📌 Pin to Dock'}
          </button>
          {menu.winId !== null && (
            <button
              onClick={() => handleClose(menu.winId, menu.appId)}
              style={menuItemStyle}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(220,38,38,0.2)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              ✕ Close
            </button>
          )}
        </div>
      )}
    </>
  )
}

const menuItemStyle = {
  display: 'block',
  width: '100%',
  padding: '8px 16px',
  background: 'transparent',
  border: 'none',
  color: 'rgba(255,255,255,0.88)',
  fontSize: '0.82rem',
  textAlign: 'left',
  cursor: 'pointer',
  transition: 'background 0.12s',
}
