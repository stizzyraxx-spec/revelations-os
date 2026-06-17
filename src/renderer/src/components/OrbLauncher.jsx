import { useState, useMemo, useEffect, useRef } from 'react'
import { useOSStore } from '../store'
import { APP_REGISTRY } from '../constants'
import horsemenLogo from '../assets/raxx-logo.png'
import {
  Globe, Folder, Settings2, TerminalSquare, FileText, Shield, Store,
  FileStack, Calculator, ShoppingBag, Music2, Scale, AlertTriangle, Heart,
  Microscope, Wine, Target, BookOpen, Lightbulb, Send, TrendingUp, Search,
  LayoutDashboard, Mic, PawPrint, Scissors, Star, BarChart2, Headphones,
  Briefcase, Building, GraduationCap, Hammer, Trophy, Command, Car,
  Building2, ShoppingCart, Waves, BookHeart,
  Flame, Users, Radio, Compass, Gamepad2, BookMarked, HandHeart,
  MessageSquare, UserCircle, ScrollText, DollarSign, X,
  Clock, Calendar, HelpCircle, Mail, Video, StickyNote, Bell, CalendarDays,
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

const CATEGORIES = ['All', 'faith', 'system', 'finance', 'commerce', 'media', 'legal', 'health', 'marketing', 'dev', 'productivity', 'music', 'pets', 'wellness', 'beauty', 'sports', 'enterprise', 'community', 'education', 'trades', 'admin', 'business', 'automotive', 'pos', 'gov']

const TAB_EDGE_THRESHOLD = 4
const TAB_REVEAL_DELAY   = 2000

export default function OrbLauncher() {
  const { orbLauncherOpen, toggleOrbLauncher, openWindow, openSubscription, windows } = useOSStore()
  const [query, setQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState('All')
  const tabTimerRef = useRef(null)

  const hasOpenWindows = windows.filter(w => !w.minimized).length > 0

  // Tab is visible when: no windows open, drawer is open, or cursor held at right edge
  const [edgeVisible, setEdgeVisible] = useState(false)

  useEffect(() => {
    const onMove = (e) => {
      const atEdge = e.clientX >= window.innerWidth - TAB_EDGE_THRESHOLD
      if (atEdge) {
        if (!tabTimerRef.current) {
          tabTimerRef.current = setTimeout(() => setEdgeVisible(true), TAB_REVEAL_DELAY)
        }
      } else {
        clearTimeout(tabTimerRef.current)
        tabTimerRef.current = null
        if (!orbLauncherOpen && e.clientX < window.innerWidth - 22) setEdgeVisible(false)
      }
    }
    window.addEventListener('mousemove', onMove)
    return () => { window.removeEventListener('mousemove', onMove); clearTimeout(tabTimerRef.current) }
  }, [orbLauncherOpen])

  const tabVisible = !hasOpenWindows || orbLauncherOpen || edgeVisible

  // Close on Escape
  useEffect(() => {
    if (!orbLauncherOpen) return
    const handler = (e) => { if (e.key === 'Escape') toggleOrbLauncher() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [orbLauncherOpen])

  const filtered = useMemo(() => {
    let apps = APP_REGISTRY
    if (activeCategory !== 'All') apps = apps.filter(a => a.category === activeCategory)
    if (query.trim()) {
      const q = query.toLowerCase()
      apps = apps.filter(a => a.name.toLowerCase().includes(q) || a.desc.toLowerCase().includes(q))
    }
    return apps
  }, [query, activeCategory])

  const handleAppClick = (app) => {
    if (app.free) {
      openWindow({ appId: app.id, title: app.name, props: app.liveUrl ? { liveUrl: app.liveUrl, appId: app.id, appName: app.name } : {} })
    } else {
      openSubscription(app)
    }
    toggleOrbLauncher()
    setQuery('')
    setActiveCategory('All')
  }

  return (
    <>
      {/* Tab — thin black strip, 90% screen height, "REVELATIONS" vertical text */}
      <button
        onClick={toggleOrbLauncher}
        title="Applications"
        style={{
          position: 'fixed',
          right: 0,
          top: '5vh',
          width: 22,
          height: '90vh',
          background: '#080808',
          border: 'none',
          borderRadius: '6px 0 0 6px',
          cursor: 'pointer',
          boxShadow: '-2px 0 12px rgba(0,0,0,0.7)',
          zIndex: 995,
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'transform 0.28s cubic-bezier(0.4,0,0.2,1), background 0.2s',
          transform: orbLauncherOpen ? 'translateX(22px)' : tabVisible ? 'translateX(0)' : 'translateX(22px)',
          pointerEvents: tabVisible || orbLauncherOpen ? 'all' : 'none',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = '#111' }}
        onMouseLeave={e => { e.currentTarget.style.background = '#080808' }}
      >
        <span style={{
          color: '#ffffff',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          fontFamily: '"Times New Roman", Times, serif',
          writingMode: 'vertical-rl',
          textOrientation: 'mixed',
          transform: 'rotate(180deg)',
          userSelect: 'none',
          whiteSpace: 'nowrap',
        }}>
          Revelations
        </span>
      </button>

      {/* Backdrop */}
      {orbLauncherOpen && (
        <div
          onClick={toggleOrbLauncher}
          style={{
            position: 'fixed', inset: 0, zIndex: 988,
            background: 'rgba(0,0,0,0.45)',
          }}
        />
      )}

      {/* Slide-out drawer from right */}
      <div style={{
        position: 'fixed',
        right: 0,
        top: 40,
        width: 400,
        height: 'calc(100vh - 40px)',
        background: 'rgba(4,4,14,0.98)',
        borderLeft: '1px solid rgba(255,255,255,0.08)',
        zIndex: 990,
        transform: orbLauncherOpen ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.3s cubic-bezier(0.4,0,0.2,1)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Drawer header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px 10px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <img src={horsemenLogo} alt="Revelations" style={{ width: 36, height: 36, objectFit: 'contain' }} />
              <div>
                <div style={{
                  fontFamily: '"Times New Roman", Times, serif',
                  fontSize: '1.3rem',
                  fontWeight: 700,
                  color: '#ffffff',
                  letterSpacing: '0.04em',
                  lineHeight: 1.1,
                }}>
                  Revelations
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                  OS
                </div>
              </div>
            </div>
          </div>
          <button
            onClick={toggleOrbLauncher}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 6, borderRadius: 8, display: 'flex', alignItems: 'center' }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Search */}
        <div style={{ position: 'relative', margin: '0 16px 12px' }}>
          <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            autoFocus={orbLauncherOpen}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search apps..."
            style={{
              width: '100%', height: 40, paddingLeft: 36, paddingRight: 12,
              borderRadius: 20, fontSize: '0.88rem',
              background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border)',
              color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Category filters */}
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '0 16px 10px', scrollbarWidth: 'none' }}>
          {CATEGORIES.filter(c => c === 'All' || APP_REGISTRY.some(a => a.category === c)).map(cat => (
            <button key={cat} onClick={() => setActiveCategory(cat)} style={{
              flexShrink: 0, padding: '4px 11px', borderRadius: 20, fontSize: '0.7rem', fontWeight: 500, cursor: 'pointer',
              background: activeCategory === cat ? 'var(--accent)' : 'rgba(255,255,255,0.05)',
              color: activeCategory === cat ? '#fff' : 'var(--text-secondary)',
              border: `1px solid ${activeCategory === cat ? 'var(--accent)' : 'var(--border)'}`,
              transition: 'var(--transition)', textTransform: 'capitalize',
            }}>
              {cat === 'All' ? '⬡ All' : cat}
            </button>
          ))}
        </div>

        {/* App grid */}
        <div style={{
          flex: 1, overflowY: 'auto', padding: '4px 12px 24px',
          display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, alignContent: 'start',
        }}>
          {filtered.map(app => {
            const IconComp = ICON_MAP[app.icon] || Globe
            return (
              <button
                key={app.id}
                onClick={() => handleAppClick(app)}
                title={app.desc}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
                  padding: '14px 6px 10px',
                  background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)',
                  borderRadius: 16, cursor: 'pointer', transition: 'var(--transition)', color: 'var(--text-primary)',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(109,40,217,0.18)'; e.currentTarget.style.borderColor = 'var(--border-accent)'; e.currentTarget.style.transform = 'scale(1.05)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.transform = 'scale(1)' }}
              >
                <div style={{ width: 44, height: 44, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `linear-gradient(135deg, ${app.color}44, ${app.color}99)`, border: `1px solid ${app.color}44` }}>
                  <IconComp size={22} color={app.color} />
                </div>
                <span style={{ fontSize: '0.68rem', fontWeight: 500, textAlign: 'center', lineHeight: 1.3, width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                  {app.name}
                </span>
                {!app.free && (
                  <span style={{ fontSize: '0.6rem', color: 'var(--accent-gold)', background: 'rgba(245,158,11,0.12)', padding: '1px 5px', borderRadius: 6, border: '1px solid rgba(245,158,11,0.2)' }}>
                    {app.price}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}
