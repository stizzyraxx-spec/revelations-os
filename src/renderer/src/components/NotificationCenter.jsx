import { useOSStore } from '../store'
import { Bell, X, CheckCircle, AlertTriangle, XCircle, Info, Shield, Check } from 'lucide-react'

const ICONS = { success: CheckCircle, warning: AlertTriangle, error: XCircle, security: Shield, info: Info }
const COLORS = { success: '#22c55e', warning: '#f59e0b', error: '#ef4444', security: '#6d28d9', info: '#3b82f6' }

function relTime(ts) {
  const diff = (Date.now() - new Date(ts).getTime()) / 1000
  if (diff < 60) return 'Just now'
  if (diff < 3600) return Math.floor(diff/60) + 'm ago'
  if (diff < 86400) return Math.floor(diff/3600) + 'h ago'
  return new Date(ts).toLocaleDateString()
}

export default function NotificationCenter() {
  const { notificationPanelOpen, notifications, markRead, markAllRead, clearAll } = useOSStore()

  return (
    <div style={{
      position:'fixed', top:40, right:0, width:360, height:'calc(100vh - 40px)', zIndex:800,
      background:'var(--bg-glass-strong)', backdropFilter:'var(--blur-heavy)', WebkitBackdropFilter:'var(--blur-heavy)',
      borderLeft:'1px solid var(--border)',
      transform: notificationPanelOpen ? 'translateX(0)' : 'translateX(100%)',
      transition:'transform 0.35s cubic-bezier(0.4,0,0.2,1)',
      display:'flex', flexDirection:'column',
    }}>
      {/* Header */}
      <div style={{ padding:'16px 16px 12px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <Bell size={16} style={{ color:'var(--accent)' }}/>
          <span style={{ fontWeight:700, fontSize:'0.9rem' }}>Notifications</span>
          {notifications.filter(n=>!n.read).length > 0 && (
            <span style={{ background:'var(--accent)', color:'#fff', borderRadius:10, padding:'1px 7px', fontSize:'0.68rem', fontWeight:700 }}>{notifications.filter(n=>!n.read).length}</span>
          )}
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <button onClick={markAllRead} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--accent)', fontSize:'0.72rem' }}>
            <Check size={12}/> All read
          </button>
          <button onClick={clearAll} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-muted)', fontSize:'0.72rem' }}>
            Clear
          </button>
        </div>
      </div>

      {/* List */}
      <div style={{ flex:1, overflowY:'auto', padding:8 }}>
        {notifications.length === 0 ? (
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', gap:12, color:'var(--text-muted)' }}>
            <Bell size={32} style={{ opacity:0.3 }}/>
            <div style={{ fontSize:'0.85rem' }}>All clear</div>
          </div>
        ) : (
          [...notifications].reverse().map(n => {
            const Icon = ICONS[n.type] || Info
            const color = COLORS[n.type] || COLORS.info
            return (
              <div
                key={n.id}
                onClick={()=>markRead(n.id)}
                style={{
                  display:'flex', gap:10, padding:'10px 12px', borderRadius:10, marginBottom:4, cursor:'pointer',
                  background: n.read ? 'transparent' : 'rgba(109,40,217,0.08)',
                  borderLeft: n.read ? 'none' : `3px solid ${color}`,
                  transition:'var(--transition)',
                }}
                onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.04)'}
                onMouseLeave={e=>e.currentTarget.style.background=n.read?'transparent':'rgba(109,40,217,0.08)'}
              >
                <Icon size={16} style={{ color, flexShrink:0, marginTop:2 }}/>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:'0.82rem', fontWeight:600, color:'var(--text-primary)' }}>{n.title}</div>
                  <div style={{ fontSize:'0.75rem', color:'var(--text-secondary)', marginTop:2, lineHeight:1.4 }}>{n.body}</div>
                  <div style={{ fontSize:'0.68rem', color:'var(--text-muted)', marginTop:4 }}>{relTime(n.timestamp)}</div>
                </div>
                <button onClick={e=>{e.stopPropagation();useOSStore.getState().markRead(n.id)}} style={{ background:'none',border:'none',cursor:'pointer',color:'var(--text-muted)',padding:2,flexShrink:0 }}>
                  <X size={12}/>
                </button>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
