import { useState, useEffect } from 'react'
import { Clock, Cpu, HardDrive, Wifi, FileText, Calendar } from 'lucide-react'
import { useOSStore } from '../store'

function ClockWidget() {
  const [time, setTime] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  const h = String(time.getHours()).padStart(2,'0')
  const m = String(time.getMinutes()).padStart(2,'0')
  const s = String(time.getSeconds()).padStart(2,'0')
  const date = time.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' })
  return (
    <div style={widgetStyle}>
      <div style={{ fontSize: 36, fontWeight: 700, letterSpacing: 2, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{h}:{m}:{s}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{date}</div>
    </div>
  )
}

function SystemHealthWidget() {
  const [health, setHealth] = useState({ cpu: 12, mem: 34, disk: 48 })
  useEffect(() => {
    const t = setInterval(() => {
      setHealth(prev => ({
        cpu: Math.max(5, Math.min(95, prev.cpu + (Math.random() - 0.5) * 10)),
        mem: Math.max(20, Math.min(90, prev.mem + (Math.random() - 0.5) * 5)),
        disk: 48,
      }))
    }, 3000)
    return () => clearInterval(t)
  }, [])

  const Bar = ({ label, val, color }) => (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, fontSize: 11 }}>
        <span style={{ color: 'var(--text-muted)' }}>{label}</span>
        <span style={{ color }}>{Math.round(val)}%</span>
      </div>
      <div style={{ height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 99 }}>
        <div style={{ height: '100%', width: `${val}%`, background: color, borderRadius: 99, transition: 'width 1s ease' }} />
      </div>
    </div>
  )

  return (
    <div style={widgetStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        <Cpu size={12} /> System Health
      </div>
      <Bar label="CPU" val={health.cpu} color="#a78bfa" />
      <Bar label="Memory" val={health.mem} color="#6ee7b7" />
      <Bar label="Disk" val={health.disk} color="#fbbf24" />
    </div>
  )
}

function QuickNotesWidget() {
  const NOTES_KEY = 'revos_quick_notes'
  const [text, setText] = useState(() => localStorage.getItem(NOTES_KEY) || '')
  const save = (v) => { setText(v); localStorage.setItem(NOTES_KEY, v) }
  return (
    <div style={{ ...widgetStyle, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        <FileText size={12} /> Quick Notes
      </div>
      <textarea
        value={text}
        onChange={(e) => save(e.target.value)}
        placeholder="Jot something down..."
        style={{ flex: 1, resize: 'none', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, padding: '6px 8px', color: 'var(--text-secondary)', fontSize: 12, outline: 'none', fontFamily: 'inherit', lineHeight: 1.5, minHeight: 80 }}
      />
    </div>
  )
}

export default function Widgets() {
  const windows = useOSStore(s => s.windows)
  const hasWindows = windows.filter(w => !w.minimized).length > 0
  if (hasWindows) return null

  return (
    <div style={{ position: 'absolute', bottom: 20, right: 20, display: 'flex', flexDirection: 'column', gap: 10, zIndex: 5, pointerEvents: 'auto', width: 220 }}>
      <ClockWidget />
      <SystemHealthWidget />
      <QuickNotesWidget />
    </div>
  )
}

const widgetStyle = {
  background: 'rgba(10,8,28,0.92)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 14,
  padding: '14px 16px',
}
