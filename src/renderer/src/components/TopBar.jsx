import { useState, useEffect, useRef } from 'react'
import { useOSStore } from '../store'
import { APP_REGISTRY } from '../constants'
import {
  Bell, Wifi, WifiOff, Battery, BatteryCharging, Volume2, Bluetooth, Search, ChevronDown, LogOut,
  Power, Settings2, Shield, User, X, Globe
} from 'lucide-react'
import { getAppIcon } from './appIcons'

export default function TopBar() {
  const {
    user, windows, notifications, currentTime, notificationPanelOpen, toggleNotificationPanel,
    openWindow, focusWindow, restoreWindow, closeWindow, logout, openExitModal, toggleOrbLauncher,
  } = useOSStore()
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [sysInfo, setSysInfo] = useState(null)
  const [now, setNow] = useState(new Date())
  const searchRef = useRef(null)

  const [battery, setBattery] = useState(null) // { level, charging }
  const [online, setOnline] = useState(navigator.onLine)

  useEffect(() => {
    window.nexus?.getSystemInfo().then(setSysInfo).catch(() => {})
  }, [])

  useEffect(() => {
    let batt
    const sync = () => batt && setBattery({ level: Math.round(batt.level * 100), charging: batt.charging })
    navigator.getBattery?.().then((b) => {
      batt = b
      sync()
      b.addEventListener('levelchange', sync)
      b.addEventListener('chargingchange', sync)
    }).catch(() => {})
    const onUp = () => setOnline(true)
    const onDown = () => setOnline(false)
    window.addEventListener('online', onUp)
    window.addEventListener('offline', onDown)
    return () => {
      batt?.removeEventListener('levelchange', sync)
      batt?.removeEventListener('chargingchange', sync)
      window.removeEventListener('online', onUp)
      window.removeEventListener('offline', onDown)
    }
  }, [])

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const unreadCount = notifications.filter(n => !n.read).length
  const openWindows = windows.filter(w => !w.minimized)

  const fmtTime = (d) => {
    if (!d) return ''
    const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    return `${day}  ${time}`
  }

  const initials = (name) => name?.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2) || '?'

  // Search filtered apps
  const searchResults = searchQuery.trim()
    ? APP_REGISTRY.filter(a => a.name.toLowerCase().includes(searchQuery.toLowerCase()) || a.desc.toLowerCase().includes(searchQuery.toLowerCase())).slice(0,8)
    : []

  const handleSearchApp = (app) => {
    if (app.free) openWindow({ appId: app.id, title: app.name })
    else useOSStore.getState().openSubscription(app)
    setSearchOpen(false); setSearchQuery('')
  }

  return (
    <div style={{
      position:'fixed', top:0, left:0, right:0, height:40, zIndex:100,
      background:'var(--bg-glass-strong)', backdropFilter:'var(--blur-heavy)', WebkitBackdropFilter:'var(--blur-heavy)',
      borderBottom:'1px solid var(--border)',
      display:'flex', alignItems:'center', padding:'0 12px 0 68px',
      WebkitAppRegion:'drag',
    }}>

      {/* Topbar Search (no-drag) */}
      <div style={{ WebkitAppRegion:'no-drag', position:'relative', marginRight:12 }}>
        <button
          onClick={() => { setSearchOpen(v=>!v); setTimeout(()=>searchRef.current?.focus(),50) }}
          style={{ display:'flex', alignItems:'center', gap:6, padding:'4px 12px', background:'rgba(255,255,255,0.05)', border:'1px solid var(--border)', borderRadius:20, cursor:'pointer', color:'var(--text-muted)', fontSize:'0.78rem', WebkitAppRegion:'no-drag' }}
        >
          <Search size={12}/> Search apps...
        </button>
        {searchOpen && (
          <div style={{ position:'absolute', top:34, left:0, width:340, background:'var(--bg-glass-strong)', backdropFilter:'var(--blur-heavy)', border:'1px solid var(--border)', borderRadius:16, overflow:'hidden', boxShadow:'var(--shadow-lg)', zIndex:999 }} className="animate-fade-in-down">
            <div style={{ padding:'10px 12px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:8 }}>
              <Search size={14} style={{ color:'var(--text-muted)' }}/>
              <input
                ref={searchRef}
                value={searchQuery} onChange={e=>setSearchQuery(e.target.value)}
                onKeyDown={e=>e.key==='Escape'&&setSearchOpen(false)}
                placeholder="Search apps..."
                style={{ flex:1, background:'none', border:'none', color:'var(--text-primary)', fontSize:'0.9rem', outline:'none' }}
              />
              {searchQuery && <button onClick={()=>setSearchQuery('')} style={{background:'none',border:'none',cursor:'pointer',color:'var(--text-muted)'}}><X size={12}/></button>}
            </div>
            {searchResults.length > 0 ? (
              <div style={{ padding:6 }}>
                {searchResults.map(app => {
                  const AppIcon = getAppIcon(app.icon)
                  return (
                  <button key={app.id} onClick={()=>handleSearchApp(app)} style={{ width:'100%', display:'flex', alignItems:'center', gap:10, padding:'8px 10px', background:'none', border:'none', cursor:'pointer', borderRadius:10, color:'var(--text-primary)' }}
                    onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.06)'}
                    onMouseLeave={e=>e.currentTarget.style.background='none'}
                  >
                    <div style={{ width:32,height:32,borderRadius:9,background:`linear-gradient(135deg,${app.color}44,${app.color}88)`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0 }}>
                      <AppIcon size={16} color={app.color}/>
                    </div>
                    <div style={{ flex:1, textAlign:'left' }}>
                      <div style={{ fontSize:'0.82rem', fontWeight:500 }}>{app.name}</div>
                      <div style={{ fontSize:'0.7rem', color:'var(--text-muted)' }}>{app.category}</div>
                    </div>
                    {!app.free && <span style={{fontSize:'0.65rem',color:'var(--accent-gold)'}}>{app.price}</span>}
                  </button>
                  )
                })}
              </div>
            ) : searchQuery ? (
              <div style={{ padding:'16px', textAlign:'center', color:'var(--text-muted)', fontSize:'0.82rem' }}>No apps found</div>
            ) : (
              <div style={{ padding:'10px 12px' }}>
                <div style={{ color:'var(--text-muted)', fontSize:'0.72rem', marginBottom:6 }}>RECENT</div>
                {APP_REGISTRY.filter(a=>a.free).slice(0,4).map(app=>(
                  <button key={app.id} onClick={()=>handleSearchApp(app)} style={{ width:'100%', display:'flex', alignItems:'center', gap:8, padding:'6px 8px', background:'none', border:'none', cursor:'pointer', borderRadius:8, color:'var(--text-primary)', fontSize:'0.82rem' }}>
                    {app.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Open app indicators */}
      <div style={{ flex:1, display:'flex', alignItems:'center', gap:4, WebkitAppRegion:'no-drag', overflow:'hidden' }}>
        {openWindows.slice(0,8).map(w => {
          const lookupId = w.appId?.startsWith('raxx_') ? w.appId.slice(5) : w.appId
          const app = APP_REGISTRY.find(a=>a.id===lookupId)
          return (
            <button
              key={w.id}
              onClick={()=>{ w.minimized ? restoreWindow(w.id) : focusWindow(w.id) }}
              onContextMenu={e=>{ e.preventDefault(); closeWindow(w.id) }}
              title={`${w.title} (right-click to close)`}
              style={{
                display:'flex', alignItems:'center', gap:5, padding:'3px 10px 3px 6px',
                background: w.focused ? 'rgba(109,40,217,0.25)' : 'rgba(255,255,255,0.05)',
                border: `1px solid ${w.focused ? 'var(--border-accent)' : 'var(--border)'}`,
                borderRadius:20, cursor:'pointer', color:'var(--text-primary)', maxWidth:140,
                transition:'var(--transition)',
              }}
            >
              <div style={{ width:18,height:18,borderRadius:5,background:`linear-gradient(135deg,${app?.color||'#6d28d9'}44,${app?.color||'#6d28d9'}88)`,flexShrink:0 }}/>
              <span style={{ fontSize:'0.72rem', fontWeight:500, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', maxWidth:90 }}>{w.title}</span>
              <div style={{ width:5,height:5,borderRadius:'50%',background:w.focused?'var(--accent)':'var(--text-muted)',flexShrink:0 }}/>
            </button>
          )
        })}
      </div>

      {/* Right section */}
      <div style={{ display:'flex', alignItems:'center', gap:10, WebkitAppRegion:'no-drag' }}>
        <button onClick={() => openWindow({ appId: 'bluetooth', title: 'Bluetooth' })} title="Bluetooth" style={{ background:'none', border:'none', cursor:'pointer', padding:3, borderRadius:5, display:'flex', alignItems:'center' }}>
          <Bluetooth size={13} style={{ color:'var(--text-muted)' }}/>
        </button>
        <button onClick={() => openWindow({ appId: 'wifi', title: 'Wi-Fi' })} title={online ? 'Wi-Fi — Connected' : 'Wi-Fi — Offline'} style={{ background:'none', border:'none', cursor:'pointer', padding:3, borderRadius:5, display:'flex', alignItems:'center' }}>
          {online
            ? <Wifi size={13} style={{ color:'var(--text-muted)' }}/>
            : <WifiOff size={13} style={{ color:'#f59e0b' }}/>}
        </button>
        <button onClick={() => openWindow({ appId: 'volume', title: 'Volume' })} title="Volume" style={{ background:'none', border:'none', cursor:'pointer', padding:3, borderRadius:5, display:'flex', alignItems:'center' }}>
          <Volume2 size={13} style={{ color:'var(--text-muted)' }}/>
        </button>
        <button onClick={() => openWindow({ appId: 'battery', title: 'Battery' })} title={battery?.charging ? 'Battery — Charging' : 'Battery'} style={{ background:'none', border:'none', cursor:'pointer', padding:3, borderRadius:5, display:'flex', alignItems:'center', gap:3 }}>
          {battery?.charging
            ? <BatteryCharging size={13} style={{ color:'#22c55e' }}/>
            : <Battery size={13} style={{ color: battery && battery.level <= 20 ? '#ef4444' : '#22c55e' }}/>}
          <span style={{ fontSize:'0.7rem', color:'var(--text-muted)' }}>{battery ? `${battery.level}%` : '—'}</span>
        </button>

        {/* Notification bell */}
        <button onClick={toggleNotificationPanel} style={{ position:'relative', background:'none', border:'none', cursor:'pointer', color:notificationPanelOpen?'var(--accent)':'var(--text-muted)', padding:3, borderRadius:6 }}>
          <Bell size={14}/>
          {unreadCount > 0 && (
            <div style={{ position:'absolute', top:-2, right:-2, width:14, height:14, background:'#ef4444', borderRadius:'50%', fontSize:'0.6rem', display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontWeight:700, border:'1px solid var(--bg-primary)' }}>{unreadCount > 9 ? '9+' : unreadCount}</div>
          )}
        </button>

        {/* Clock */}
        <div style={{ fontFamily:'var(--font-mono)', fontSize:'0.75rem', color:'var(--text-primary)', whiteSpace:'nowrap', padding:'0 6px' }}>
          {fmtTime(now)}
        </div>

        {/* User avatar */}
        <div style={{ position:'relative' }}>
          <button onClick={()=>setUserMenuOpen(v=>!v)} style={{ width:26,height:26,borderRadius:'50%',background:'linear-gradient(135deg,var(--accent),var(--accent-2))',border:'2px solid var(--border-accent)',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'0.7rem',fontWeight:700,color:'#fff' }}>
            {initials(user.name)}
          </button>
          {userMenuOpen && (
            <div className="glass-strong animate-fade-in-down" style={{ position:'absolute', right:0, top:32, width:210, borderRadius:14, overflow:'hidden', boxShadow:'var(--shadow-lg)', zIndex:9000 }}>
              <div style={{ padding:'12px 14px 10px', borderBottom:'1px solid var(--border)' }}>
                <div style={{ fontWeight:600, fontSize:'0.85rem' }}>{user.name}</div>
                <div style={{ color:'var(--text-muted)', fontSize:'0.72rem' }}>RAXX Beats Studios</div>
              </div>
              {[
                { icon: User, label: 'My Account', action: ()=>openWindow({appId:'settings',title:'Settings'}) },
                { icon: Settings2, label: 'System Preferences', action: ()=>openWindow({appId:'settings',title:'Settings'}) },
                { icon: Shield, label: 'Privacy & Security', action: ()=>openWindow({appId:'pcscanfix',title:'PCFixScan'}) },
              ].map(({ icon: Icon, label, action }) => (
                <button key={label} onClick={()=>{action();setUserMenuOpen(false)}} className="context-menu-item" style={{ width:'100%', borderRadius:0 }}>
                  <Icon size={14}/> {label}
                </button>
              ))}
              <div className="context-menu-separator"/>
              <button onClick={()=>{logout();setUserMenuOpen(false)}} className="context-menu-item" style={{ width:'100%', borderRadius:0, color:'var(--text-secondary)' }}>
                <LogOut size={14}/> Sign Out
              </button>
              <button onClick={()=>{openExitModal();setUserMenuOpen(false)}} className="context-menu-item danger" style={{ width:'100%', borderRadius:0 }}>
                <Power size={14}/> Exit Revelations OS
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
