import { useState } from 'react'
import { ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

const COLORS = ['#7c3aed','#ef4444','#f59e0b','#10b981','#3b82f6','#ec4899','#14b8a6']

const STORAGE = 'revos_calendar_events'
const loadEvents = () => { try { return JSON.parse(localStorage.getItem(STORAGE)) || {} } catch { return {} } }
const saveEvents = (e) => localStorage.setItem(STORAGE, JSON.stringify(e))

// Faith-based recurring events
const FAITH_EVENTS = {
  // Keys are MM-DD (month-day) patterns
  recurring: [
    { title: 'Sunday Worship', day: 0, color: '#7c3aed' }, // weekday 0 = Sunday
  ],
}

export default function CalendarApp() {
  const today = new Date()
  const [viewDate, setViewDate] = useState(new Date(today.getFullYear(), today.getMonth(), 1))
  const [selected, setSelected] = useState(today)
  const [events, setEvents] = useState(loadEvents)
  const [newTitle, setNewTitle] = useState('')
  const [newColor, setNewColor] = useState(COLORS[0])
  const [newTime, setNewTime] = useState('09:00')
  const [view, setView] = useState('month') // month | agenda

  const year = viewDate.getFullYear()
  const month = viewDate.getMonth()

  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  const prevMonth = () => setViewDate(new Date(year, month - 1, 1))
  const nextMonth = () => setViewDate(new Date(year, month + 1, 1))

  const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  const selKey = dateKey(selected)

  const selEvents = events[selKey] || []

  const addEvent = () => {
    if (!newTitle.trim()) return
    const updated = { ...events, [selKey]: [...(events[selKey] || []), { id: Date.now(), title: newTitle.trim(), time: newTime, color: newColor }] }
    setEvents(updated); saveEvents(updated); setNewTitle('')
  }

  const delEvent = (key, id) => {
    const updated = { ...events, [key]: (events[key] || []).filter(e => e.id !== id) }
    setEvents(updated); saveEvents(updated)
  }

  const hasEvents = (day) => {
    const d = new Date(year, month, day)
    const k = dateKey(d)
    return (events[k] || []).length > 0 || d.getDay() === 0
  }

  // Agenda: next 30 days
  const agendaDays = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(today); d.setDate(today.getDate() + i)
    return d
  }).filter(d => (events[dateKey(d)] || []).length > 0 || d.getDay() === 0)

  const isToday = (day) => {
    const d = new Date(year, month, day)
    return d.toDateString() === today.toDateString()
  }

  const isSelected = (day) => {
    const d = new Date(year, month, day)
    return d.toDateString() === selected.toDateString()
  }

  return (
    <div style={{ display: 'flex', height: '100%', background: '#08080f', color: '#fff', fontFamily: 'system-ui' }}>
      {/* Main calendar */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.07)', gap: 12 }}>
          <button onClick={prevMonth} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#aaa', padding: 4 }}><ChevronLeft size={18} /></button>
          <div style={{ flex: 1, textAlign: 'center', fontWeight: 700, fontSize: '1rem' }}>{MONTHS[month]} {year}</div>
          <button onClick={nextMonth} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#aaa', padding: 4 }}><ChevronRight size={18} /></button>
          <button onClick={() => { setViewDate(new Date(today.getFullYear(), today.getMonth(), 1)); setSelected(today) }}
            style={{ background: 'rgba(124,58,237,0.2)', border: '1px solid rgba(124,58,237,0.4)', borderRadius: 8, padding: '4px 10px', cursor: 'pointer', color: '#a78bfa', fontSize: '0.75rem' }}>
            Today
          </button>
          <div style={{ display: 'flex', gap: 4 }}>
            {['month', 'agenda'].map(v => (
              <button key={v} onClick={() => setView(v)} style={{ background: view === v ? '#7c3aed' : 'rgba(255,255,255,0.06)', border: 'none', borderRadius: 8, padding: '4px 10px', cursor: 'pointer', color: view === v ? '#fff' : '#888', fontSize: '0.75rem' }}>
                {v.charAt(0).toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {view === 'month' && (
          <div style={{ flex: 1, padding: '0 8px 8px', overflowY: 'auto' }}>
            {/* Day headers */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, padding: '8px 0 4px' }}>
              {DAYS.map(d => <div key={d} style={{ textAlign: 'center', fontSize: '0.7rem', color: d === 'Sun' ? '#a78bfa' : '#666', fontWeight: 600, padding: '4px 0' }}>{d}</div>)}
            </div>
            {/* Day grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
              {[...Array(firstDay)].map((_, i) => <div key={`e${i}`} />)}
              {[...Array(daysInMonth)].map((_, i) => {
                const day = i + 1
                const d = new Date(year, month, day)
                const isSun = d.getDay() === 0
                return (
                  <button key={day} onClick={() => setSelected(new Date(year, month, day))}
                    style={{
                      background: isSelected(day) ? '#7c3aed' : isToday(day) ? 'rgba(124,58,237,0.2)' : 'rgba(255,255,255,0.02)',
                      border: `1px solid ${isToday(day) && !isSelected(day) ? 'rgba(124,58,237,0.5)' : 'rgba(255,255,255,0.05)'}`,
                      borderRadius: 10, padding: '8px 4px 6px', cursor: 'pointer',
                      color: isSelected(day) ? '#fff' : isSun ? '#a78bfa' : '#ccc',
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, minHeight: 52,
                    }}
                  >
                    <span style={{ fontWeight: isToday(day) ? 700 : 400, fontSize: '0.82rem' }}>{day}</span>
                    {isSun && <div style={{ width: 4, height: 4, borderRadius: '50%', background: '#7c3aed', opacity: 0.7 }} />}
                    {(events[dateKey(d)] || []).slice(0, 2).map(ev => (
                      <div key={ev.id} style={{ width: '80%', height: 3, borderRadius: 99, background: ev.color }} />
                    ))}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {view === 'agenda' && (
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
            {agendaDays.length === 0 && (
              <div style={{ textAlign: 'center', color: '#555', padding: 40, fontSize: '0.85rem' }}>No upcoming events</div>
            )}
            {agendaDays.map(d => {
              const k = dateKey(d)
              const dayEvents = events[k] || []
              const isSun = d.getDay() === 0
              return (
                <div key={k} style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: '0.75rem', color: isSun ? '#a78bfa' : '#888', fontWeight: 600, marginBottom: 6 }}>
                    {d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
                  </div>
                  {isSun && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'rgba(124,58,237,0.1)', borderRadius: 10, border: '1px solid rgba(124,58,237,0.2)', marginBottom: 4 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#7c3aed', flexShrink: 0 }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '0.82rem', fontWeight: 600 }}>Sunday Worship</div>
                        <div style={{ fontSize: '0.72rem', color: '#888' }}>Weekly</div>
                      </div>
                    </div>
                  )}
                  {dayEvents.map(ev => (
                    <div key={ev.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'rgba(255,255,255,0.04)', borderRadius: 10, marginBottom: 4 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: ev.color, flexShrink: 0 }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '0.82rem', fontWeight: 600 }}>{ev.title}</div>
                        <div style={{ fontSize: '0.72rem', color: '#888' }}>{ev.time}</div>
                      </div>
                      <button onClick={() => delEvent(k, ev.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#555', padding: 4 }}><Trash2 size={12} /></button>
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Sidebar — selected day events */}
      <div style={{ width: 240, borderLeft: '1px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 14px 8px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <div style={{ fontWeight: 700, fontSize: '0.88rem', marginBottom: 2 }}>
            {selected.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
          </div>
          {selected.getDay() === 0 && (
            <div style={{ fontSize: '0.72rem', color: '#a78bfa' }}>☩ Sunday — Worship Day</div>
          )}
        </div>

        {/* Add event */}
        <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input value={newTitle} onChange={e => setNewTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && addEvent()}
            placeholder="Add event..."
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '6px 10px', color: '#fff', fontSize: '0.8rem', outline: 'none' }}
          />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="time" value={newTime} onChange={e => setNewTime(e.target.value)}
              style={{ flex: 1, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '5px 8px', color: '#fff', fontSize: '0.78rem', outline: 'none' }}
            />
            {COLORS.map(c => (
              <div key={c} onClick={() => setNewColor(c)} style={{ width: 14, height: 14, borderRadius: '50%', background: c, cursor: 'pointer', border: newColor === c ? '2px solid #fff' : '2px solid transparent', flexShrink: 0 }} />
            ))}
          </div>
          <button onClick={addEvent} style={{ background: '#7c3aed', border: 'none', borderRadius: 8, padding: '7px', cursor: 'pointer', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: '0.78rem' }}>
            <Plus size={14} /> Add Event
          </button>
        </div>

        {/* Day events list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {selected.getDay() === 0 && (
            <div style={{ background: 'rgba(124,58,237,0.12)', borderRadius: 10, padding: '10px 12px', border: '1px solid rgba(124,58,237,0.25)' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#7c3aed' }} />
                <div style={{ fontWeight: 600, fontSize: '0.82rem' }}>Sunday Worship</div>
              </div>
              <div style={{ fontSize: '0.72rem', color: '#888', marginTop: 4 }}>Weekly recurring</div>
            </div>
          )}
          {selEvents.length === 0 && selected.getDay() !== 0 && (
            <div style={{ color: '#444', fontSize: '0.78rem', textAlign: 'center', paddingTop: 20 }}>No events</div>
          )}
          {selEvents.map(ev => (
            <div key={ev.id} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: '10px 12px', border: `1px solid ${ev.color}33` }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: ev.color, flexShrink: 0, marginTop: 3 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.82rem', wordBreak: 'break-word' }}>{ev.title}</div>
                  <div style={{ fontSize: '0.72rem', color: '#888', marginTop: 2 }}>{ev.time}</div>
                </div>
                <button onClick={() => delEvent(selKey, ev.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#555', padding: 2, flexShrink: 0 }}><Trash2 size={12} /></button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
