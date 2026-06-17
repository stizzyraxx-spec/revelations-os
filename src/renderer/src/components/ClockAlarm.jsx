import { useState, useEffect, useRef } from 'react'
import { Bell, BellOff, Plus, Trash2, Clock, Timer, StopCircle, Play, Pause, RotateCcw } from 'lucide-react'

const TAB_STYLE = (active) => ({
  padding: '8px 18px', border: 'none', borderRadius: 20, cursor: 'pointer', fontWeight: 500, fontSize: '0.8rem',
  background: active ? '#7c3aed' : 'rgba(255,255,255,0.06)',
  color: active ? '#fff' : 'rgba(255,255,255,0.5)',
  transition: 'all 0.2s',
})

// ── World Clock ──────────────────────────────────────────────────────────────
const ZONES = [
  { label: 'Local', tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
  { label: 'New York', tz: 'America/New_York' },
  { label: 'London', tz: 'Europe/London' },
  { label: 'Tokyo', tz: 'Asia/Tokyo' },
  { label: 'Dubai', tz: 'Asia/Dubai' },
  { label: 'Los Angeles', tz: 'America/Los_Angeles' },
]

function WorldClock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const fmt = (tz) => now.toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
  const fmtDate = (tz) => now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' })

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Analog clock */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
        <AnalogClock date={now} size={160} />
      </div>
      {ZONES.map(z => (
        <div key={z.label} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: '10px 16px',
          border: '1px solid rgba(255,255,255,0.07)',
        }}>
          <div>
            <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#fff' }}>{z.label}</div>
            <div style={{ fontSize: '0.72rem', color: '#888' }}>{fmtDate(z.tz)}</div>
          </div>
          <div style={{ fontFamily: 'monospace', fontSize: '1.1rem', color: '#a78bfa', fontWeight: 700 }}>
            {fmt(z.tz)}
          </div>
        </div>
      ))}
    </div>
  )
}

function AnalogClock({ date, size = 120 }) {
  const r = size / 2
  const hand = (angle, len, width, color) => {
    const rad = (angle - 90) * Math.PI / 180
    return { x: r + Math.cos(rad) * len, y: r + Math.sin(rad) * len, width, color }
  }
  const s = date.getSeconds(), m = date.getMinutes(), h = date.getHours() % 12
  const sH = hand(s * 6, r * 0.8, 1.5, '#ef4444')
  const mH = hand((m + s / 60) * 6, r * 0.7, 2.5, '#e2e8f0')
  const hH = hand((h + m / 60) * 30, r * 0.5, 3.5, '#a78bfa')

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={r} cy={r} r={r - 2} fill="#0a0a1a" stroke="rgba(255,255,255,0.12)" strokeWidth={2} />
      {[...Array(12)].map((_, i) => {
        const a = (i * 30 - 90) * Math.PI / 180
        const inner = i % 3 === 0 ? 0.78 : 0.85
        return (
          <line key={i}
            x1={r + Math.cos(a) * r * inner} y1={r + Math.sin(a) * r * inner}
            x2={r + Math.cos(a) * r * 0.93} y2={r + Math.sin(a) * r * 0.93}
            stroke={i % 3 === 0 ? '#a78bfa' : '#444'} strokeWidth={i % 3 === 0 ? 2 : 1}
          />
        )
      })}
      {[hH, mH, sH].map((h, i) => (
        <line key={i} x1={r} y1={r} x2={h.x} y2={h.y} stroke={h.color} strokeWidth={h.width} strokeLinecap="round" />
      ))}
      <circle cx={r} cy={r} r={3} fill="#7c3aed" />
    </svg>
  )
}

// ── Alarm ────────────────────────────────────────────────────────────────────
function Alarms() {
  const STORAGE = 'revos_alarms'
  const [alarms, setAlarms] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE)) || [] } catch { return [] }
  })
  const [newTime, setNewTime] = useState('07:00')
  const [newLabel, setNewLabel] = useState('')

  const save = (list) => { setAlarms(list); localStorage.setItem(STORAGE, JSON.stringify(list)) }

  const add = () => {
    if (!newTime) return
    save([...alarms, { id: Date.now(), time: newTime, label: newLabel || 'Alarm', active: true }])
    setNewLabel('')
  }

  const toggle = (id) => save(alarms.map(a => a.id === id ? { ...a, active: !a.active } : a))
  const del = (id) => save(alarms.filter(a => a.id !== id))

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input type="time" value={newTime} onChange={e => setNewTime(e.target.value)}
          style={{ flex: 1, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, padding: '8px 12px', color: '#fff', fontSize: '0.9rem', outline: 'none' }} />
        <input placeholder="Label..." value={newLabel} onChange={e => setNewLabel(e.target.value)}
          style={{ flex: 2, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, padding: '8px 12px', color: '#fff', fontSize: '0.9rem', outline: 'none' }} />
        <button onClick={add} style={{ background: '#7c3aed', border: 'none', borderRadius: 10, padding: '8px 14px', cursor: 'pointer', color: '#fff' }}>
          <Plus size={16} />
        </button>
      </div>
      {alarms.length === 0 && (
        <div style={{ textAlign: 'center', color: '#555', padding: 40, fontSize: '0.85rem' }}>No alarms set</div>
      )}
      {alarms.map(a => (
        <div key={a.id} style={{
          display: 'flex', alignItems: 'center', gap: 12,
          background: 'rgba(255,255,255,0.04)', borderRadius: 14, padding: '14px 16px',
          border: `1px solid ${a.active ? 'rgba(124,58,237,0.4)' : 'rgba(255,255,255,0.07)'}`,
          opacity: a.active ? 1 : 0.5,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '1.8rem', fontWeight: 300, fontFamily: 'monospace', color: '#fff', letterSpacing: -1 }}>{a.time}</div>
            <div style={{ fontSize: '0.75rem', color: '#888' }}>{a.label}</div>
          </div>
          <button onClick={() => toggle(a.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: a.active ? '#7c3aed' : '#555', padding: 8 }}>
            {a.active ? <Bell size={20} /> : <BellOff size={20} />}
          </button>
          <button onClick={() => del(a.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 8 }}>
            <Trash2 size={16} />
          </button>
        </div>
      ))}
    </div>
  )
}

// ── Stopwatch ────────────────────────────────────────────────────────────────
function Stopwatch() {
  const [ms, setMs] = useState(0)
  const [running, setRunning] = useState(false)
  const [laps, setLaps] = useState([])
  const ref = useRef(null)
  const lastRef = useRef(0)

  useEffect(() => {
    if (running) {
      lastRef.current = Date.now() - ms
      ref.current = setInterval(() => setMs(Date.now() - lastRef.current), 16)
    } else clearInterval(ref.current)
    return () => clearInterval(ref.current)
  }, [running])

  const fmt = (t) => {
    const min = Math.floor(t / 60000).toString().padStart(2, '0')
    const sec = Math.floor((t % 60000) / 1000).toString().padStart(2, '0')
    const cent = Math.floor((t % 1000) / 10).toString().padStart(2, '0')
    return `${min}:${sec}.${cent}`
  }

  return (
    <div style={{ padding: 30, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
      <div style={{ fontFamily: 'monospace', fontSize: '3.5rem', fontWeight: 300, color: '#fff', letterSpacing: -2 }}>
        {fmt(ms)}
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        <button onClick={() => setRunning(r => !r)} style={{ background: running ? '#ef4444' : '#7c3aed', border: 'none', borderRadius: 50, width: 56, height: 56, cursor: 'pointer', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {running ? <Pause size={22} /> : <Play size={22} />}
        </button>
        <button onClick={() => { if (running) setLaps(l => [ms, ...l]); else { setMs(0); setLaps([]) } }} style={{ background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: 50, width: 56, height: 56, cursor: 'pointer', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {running ? <Bell size={20} /> : <RotateCcw size={20} />}
        </button>
      </div>
      <div style={{ width: '100%', maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {laps.map((l, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 12px', background: 'rgba(255,255,255,0.04)', borderRadius: 8, fontSize: '0.85rem', fontFamily: 'monospace' }}>
            <span style={{ color: '#888' }}>Lap {laps.length - i}</span>
            <span style={{ color: '#a78bfa' }}>{fmt(l)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Timer ────────────────────────────────────────────────────────────────────
function TimerApp() {
  const [input, setInput] = useState({ h: 0, m: 5, s: 0 })
  const [remaining, setRemaining] = useState(null)
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)
  const ref = useRef(null)

  const totalSecs = input.h * 3600 + input.m * 60 + input.s

  useEffect(() => {
    if (running && remaining > 0) {
      ref.current = setInterval(() => {
        setRemaining(r => {
          if (r <= 1) { clearInterval(ref.current); setRunning(false); setDone(true); return 0 }
          return r - 1
        })
      }, 1000)
    } else clearInterval(ref.current)
    return () => clearInterval(ref.current)
  }, [running])

  const start = () => {
    if (remaining === null) setRemaining(totalSecs)
    setRunning(true); setDone(false)
  }

  const reset = () => { clearInterval(ref.current); setRunning(false); setRemaining(null); setDone(false) }

  const display = remaining !== null ? remaining : totalSecs
  const h = Math.floor(display / 3600).toString().padStart(2, '0')
  const m = Math.floor((display % 3600) / 60).toString().padStart(2, '0')
  const s = (display % 60).toString().padStart(2, '0')
  const pct = remaining !== null ? (remaining / totalSecs) * 100 : 100

  return (
    <div style={{ padding: 30, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
      {done && (
        <div style={{ background: '#7c3aed', borderRadius: 14, padding: '12px 24px', color: '#fff', fontWeight: 600, fontSize: '0.95rem' }}>
          ⏰ Timer Complete!
        </div>
      )}
      {/* Circular progress */}
      <svg width={160} height={160} viewBox="0 0 160 160">
        <circle cx={80} cy={80} r={70} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={8} />
        <circle cx={80} cy={80} r={70} fill="none" stroke="#7c3aed" strokeWidth={8}
          strokeDasharray={440} strokeDashoffset={440 * (1 - pct / 100)}
          strokeLinecap="round" transform="rotate(-90 80 80)" style={{ transition: 'stroke-dashoffset 0.8s ease' }}
        />
        <text x={80} y={80} textAnchor="middle" dominantBaseline="middle" fill="#fff" fontSize={28} fontFamily="monospace" fontWeight={300}>
          {h}:{m}:{s}
        </text>
      </svg>

      {remaining === null && (
        <div style={{ display: 'flex', gap: 16 }}>
          {['h', 'm', 's'].map(unit => (
            <div key={unit} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <input type="number" min={0} max={unit === 'h' ? 23 : 59} value={input[unit]}
                onChange={e => setInput(p => ({ ...p, [unit]: parseInt(e.target.value) || 0 }))}
                style={{ width: 60, textAlign: 'center', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, padding: '8px', color: '#fff', fontSize: '1.1rem', outline: 'none' }}
              />
              <span style={{ fontSize: '0.7rem', color: '#888' }}>{unit}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 12 }}>
        {!running && (
          <button onClick={start} style={{ background: '#7c3aed', border: 'none', borderRadius: 50, width: 56, height: 56, cursor: 'pointer', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Play size={22} />
          </button>
        )}
        {running && (
          <button onClick={() => setRunning(false)} style={{ background: '#f59e0b', border: 'none', borderRadius: 50, width: 56, height: 56, cursor: 'pointer', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Pause size={22} />
          </button>
        )}
        <button onClick={reset} style={{ background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: 50, width: 56, height: 56, cursor: 'pointer', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <RotateCcw size={20} />
        </button>
      </div>
    </div>
  )
}

// ── Main ─────────────────────────────────────────────────────────────────────
const TABS = ['Clock', 'Alarm', 'Stopwatch', 'Timer']

export default function ClockAlarm() {
  const [tab, setTab] = useState('Clock')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0a0a14', color: '#fff' }}>
      <div style={{ display: 'flex', gap: 6, padding: '14px 16px 8px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        {TABS.map(t => <button key={t} onClick={() => setTab(t)} style={TAB_STYLE(tab === t)}>{t}</button>)}
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {tab === 'Clock' && <WorldClock />}
        {tab === 'Alarm' && <Alarms />}
        {tab === 'Stopwatch' && <Stopwatch />}
        {tab === 'Timer' && <TimerApp />}
      </div>
    </div>
  )
}
