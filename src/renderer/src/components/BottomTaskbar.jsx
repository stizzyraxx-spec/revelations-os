import { useState, useEffect, useRef, useMemo } from 'react'
import { useOSStore } from '../store'
import { APP_REGISTRY } from '../constants'
import { useVisibleApps } from '../useVisibleApps'
import horsemenLogo from '../assets/raxx-logo.png'
import whiteHorse from '../assets/white-horse.png'
import AppTile from './AppTile'
import {
  Globe, Folder, Settings2, TerminalSquare, FileText, Shield, Store,
  FileStack, Calculator, ShoppingBag, Music2, Scale, AlertTriangle, Heart,
  Microscope, Wine, Target, BookOpen, Lightbulb, Send, TrendingUp, Search,
  LayoutDashboard, Mic, PawPrint, Scissors, Star, BarChart2, Headphones,
  Briefcase, Building, GraduationCap, Hammer, Trophy, Command, Car,
  Building2, ShoppingCart, Waves, BookHeart,
  Flame, Users, Radio, Compass, Gamepad2, BookMarked, HandHeart,
  MessageSquare, UserCircle, ScrollText, DollarSign,
  Clock, Calendar, HelpCircle, Mail, Video, StickyNote, Bell, CalendarDays, X,
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
  Clock, Calendar, HelpCircle, Mail, Video, StickyNote, Bell, CalendarDays,
}

export const TASKBAR_HEIGHT = 48

const PINNED_KEY = 'revos_taskbar_pinned'
// The default apps that sit on the taskbar like the Windows navbar.
const DEFAULT_PINNED = ['ephesians', 'bible', 'scrolls', 'notepad', 'terminalx', 'calculator', 'music', 'settings']

function loadPinned() {
  try {
    const saved = localStorage.getItem(PINNED_KEY)
    if (saved) return JSON.parse(saved)
  } catch {}
  return DEFAULT_PINNED
}

function launchApp(app, { openWindow, openSubscription }) {
  if (app.free) {
    openWindow({
      appId: app.id,
      title: app.name,
      props: app.liveUrl ? { liveUrl: app.liveUrl, appId: app.id, appName: app.name } : {},
    })
  } else {
    openSubscription(app)
  }
}

export default function BottomTaskbar() {
  // Registry as this profile sees it; shadows the module import so every
  // listing below is profile-filtered. See useVisibleApps.js.
  const APP_REGISTRY = useVisibleApps()

  const { windows, openWindow, openSubscription, focusWindow, minimizeWindow, restoreWindow, customApps } = useOSStore()
  const [startOpen, setStartOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pinned] = useState(loadPinned)
  const startRef = useRef(null)
  const btnRef = useRef(null)

  // Built-in apps plus anything installed from the internet.
  const allApps = useMemo(() => [...APP_REGISTRY, ...customApps], [customApps])

  // Close the Start menu on outside click or Escape.
  useEffect(() => {
    if (!startOpen) return
    const onDown = (e) => {
      if (startRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return
      setStartOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setStartOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [startOpen])

  // Build task buttons: every open window, then pinned apps with no open window.
  const openByAppId = {}
  windows.forEach((w) => { openByAppId[w.appId] = w })
  const taskItems = []
  const seen = new Set()
  windows.forEach((w) => { seen.add(w.appId); taskItems.push({ appId: w.appId, window: w }) })
  pinned.forEach((id) => { if (!seen.has(id)) taskItems.push({ appId: id, window: null }) })

  const filteredApps = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return allApps
    return allApps.filter((a) => a.name.toLowerCase().includes(q) || (a.desc || '').toLowerCase().includes(q))
  }, [query, allApps])

  const handleTaskClick = (item) => {
    const reg = allApps.find((a) => a.id === item.appId)
    if (!item.window) {
      if (reg) launchApp(reg, { openWindow, openSubscription })
      return
    }
    if (item.window.minimized) restoreWindow(item.window.id)
    else if (item.window.focused) minimizeWindow(item.window.id)
    else focusWindow(item.window.id)
  }

  const handleStartLaunch = (app) => {
    launchApp(app, { openWindow, openSubscription })
    setStartOpen(false)
    setQuery('')
  }

  return (
    <>
      {/* Start menu popup */}
      {startOpen && (
        <div
          ref={startRef}
          className="animate-scale-in"
          style={{
            position: 'fixed', left: 8, bottom: TASKBAR_HEIGHT + 8, zIndex: 1001,
            width: 460, maxHeight: '70vh',
            background: 'rgba(6,6,14,0.98)', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)',
            border: '1px solid rgba(255,255,255,0.1)', borderRadius: 16,
            boxShadow: '0 24px 64px rgba(0,0,0,0.7)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}
        >
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px 10px' }}>
            <img src={horsemenLogo} alt="Revelations" style={{ width: 32, height: 32, objectFit: 'contain' }} />
            <div>
              <div style={{ fontFamily: '"Times New Roman", Times, serif', fontSize: '1.2rem', fontWeight: 700, color: '#fff', lineHeight: 1.05 }}>Revelations</div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.62rem', letterSpacing: '0.12em', textTransform: 'uppercase' }}>All Applications</div>
            </div>
          </div>

          {/* Search */}
          <div style={{ position: 'relative', margin: '0 16px 12px' }}>
            <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search all apps..."
              style={{
                width: '100%', height: 38, paddingLeft: 36, paddingRight: 12, borderRadius: 19, fontSize: '0.85rem',
                background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border)',
                color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box',
              }}
            />
          </div>

          {/* App grid */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 12px 16px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, alignContent: 'start' }}>
            {filteredApps.map((app) => (
              <AppTile
                key={app.id}
                app={app}
                size="sm"
                onClick={() => handleStartLaunch(app)}
                badge={!app.free ? (
                  <span style={{ fontSize: '0.55rem', color: 'var(--accent-gold)', background: 'rgba(245,158,11,0.12)', padding: '1px 5px', borderRadius: 6, border: '1px solid rgba(245,158,11,0.2)' }}>
                    {app.price}
                  </span>
                ) : null}
              />
            ))}
            {filteredApps.length === 0 && (
              <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: 24 }}>No apps found</div>
            )}
          </div>
        </div>
      )}

      {/* Taskbar */}
      <div style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, height: TASKBAR_HEIGHT, zIndex: 1000,
        display: 'flex', alignItems: 'center', gap: 4, padding: '0 8px',
        background: 'rgba(6,6,12,0.94)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        borderTop: '1px solid rgba(255,255,255,0.08)',
      }}>
        {/* Start button — white horse emblem, far left */}
        <button
          ref={btnRef}
          onClick={() => setStartOpen((v) => !v)}
          title="Start — All Applications"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', width: 56, height: 44,
            borderRadius: 10, cursor: 'pointer', flexShrink: 0,
            background: startOpen ? 'rgba(109,40,217,0.35)' : 'rgba(255,255,255,0.04)',
            border: `1px solid ${startOpen ? 'var(--border-accent)' : 'rgba(255,255,255,0.08)'}`,
            transition: 'background 0.15s, border-color 0.15s',
          }}
          onMouseEnter={(e) => { if (!startOpen) e.currentTarget.style.background = 'rgba(255,255,255,0.09)' }}
          onMouseLeave={(e) => { if (!startOpen) e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
        >
          <img src={whiteHorse} alt="Start" style={{ height: 40, objectFit: 'contain', filter: 'drop-shadow(0 0 6px rgba(255,255,255,0.35))' }} />
        </button>

        {/* Search bar */}
        <div
          onClick={() => setStartOpen(true)}
          title="Search apps"
          style={{
            display: 'flex', alignItems: 'center', gap: 8, height: 36, padding: '0 14px', flexShrink: 0,
            width: 220, maxWidth: '28vw', borderRadius: 18, cursor: 'text',
            background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
            transition: 'background 0.15s, border-color 0.15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)' }}
        >
          <Search size={15} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Search apps
          </span>
        </div>

        <div style={{ width: 1, height: 26, background: 'rgba(255,255,255,0.1)', margin: '0 4px', flexShrink: 0 }} />

        {/* Task buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, overflowX: 'auto', flex: 1, scrollbarWidth: 'none' }}>
          {taskItems.map((item) => {
            const reg = allApps.find((a) => a.id === item.appId)
            const IconComp = ICON_MAP[reg?.icon] || Globe
            const color = reg?.color || '#6d28d9'
            const label = reg?.name || item.appId
            const isActive = item.window && item.window.focused && !item.window.minimized
            const isOpen = !!item.window
            return (
              <button
                key={item.appId}
                onClick={() => handleTaskClick(item)}
                title={label}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 38,
                  borderRadius: 9, cursor: 'pointer', flexShrink: 0, position: 'relative',
                  background: isActive ? `linear-gradient(135deg, ${color}44, ${color}77)` : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${isActive ? color + '88' : 'rgba(255,255,255,0.07)'}`,
                  transition: 'background 0.15s, border-color 0.15s',
                }}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'rgba(255,255,255,0.09)' }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
              >
                <IconComp size={20} color={isActive ? '#fff' : color} style={{ flexShrink: 0 }} />
                {/* Running indicator */}
                {isOpen && (
                  <span style={{
                    position: 'absolute', bottom: 2, left: '50%', transform: 'translateX(-50%)',
                    width: isActive ? 16 : 6, height: 2.5, borderRadius: 2,
                    background: isActive ? '#fff' : color, opacity: 0.9, transition: 'width 0.15s',
                  }} />
                )}
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}
