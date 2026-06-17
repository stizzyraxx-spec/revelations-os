import { useState, useEffect, useRef } from 'react'
import {
  Video, Plus, Calendar, Clock, Users, Link, Copy, Trash2,
  ChevronLeft, ChevronRight, Mic, MicOff, VideoOff, Phone,
  Share2, MessageSquare, Settings2, X, Check,
} from 'lucide-react'

const STORAGE = 'revos_meetings'
const load = () => { try { return JSON.parse(localStorage.getItem(STORAGE)) || [] } catch { return [] } }
const save = (m) => localStorage.setItem(STORAGE, JSON.stringify(m))

const PLATFORMS = [
  { id: 'zoom',  label: 'Zoom',          color: '#2d8cff', icon: '🎥' },
  { id: 'teams', label: 'Microsoft Teams',color: '#464eb8', icon: '💼' },
  { id: 'meet',  label: 'Google Meet',   color: '#00897b', icon: '📹' },
  { id: 'webex', label: 'Webex',         color: '#00bceb', icon: '🔵' },
  { id: 'custom',label: 'Custom Link',   color: '#7c3aed', icon: '🔗' },
]

const STATUS_COLORS = { upcoming: '#3b82f6', live: '#22c55e', done: '#555' }

function getMeetingStatus(m) {
  const now = Date.now()
  const start = new Date(m.startTime).getTime()
  const end = new Date(m.endTime).getTime()
  if (now < start) return 'upcoming'
  if (now >= start && now <= end) return 'live'
  return 'done'
}

function fmtDuration(start, end) {
  const mins = Math.round((new Date(end) - new Date(start)) / 60000)
  if (mins < 60) return `${mins} min`
  return `${Math.floor(mins / 60)}h ${mins % 60 > 0 ? `${mins % 60}m` : ''}`
}

// ── Meeting Form ──────────────────────────────────────────────────────────────
function MeetingForm({ initial, onSave, onCancel }) {
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1)
  const defDate = tomorrow.toISOString().slice(0, 10)
  const [form, setForm] = useState(initial || {
    title: '', date: defDate, startHour: '09', startMin: '00',
    endHour: '10', endMin: '00', platform: 'zoom', link: '',
    attendees: '', notes: '', recurring: 'none',
  })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const handleSave = () => {
    if (!form.title.trim() || !form.date) return
    const start = `${form.date}T${form.startHour}:${form.startMin}:00`
    const end   = `${form.date}T${form.endHour}:${form.endMin}:00`
    onSave({ ...form, startTime: start, endTime: end, id: initial?.id || Date.now() })
  }

  const plat = PLATFORMS.find(p => p.id === form.platform)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 20, gap: 14, overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <button onClick={onCancel} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#888' }}><ChevronLeft size={18} /></button>
        <h2 style={{ margin: 0, fontWeight: 700, fontSize: '1rem', color: '#fff' }}>{initial ? 'Edit Meeting' : 'New Meeting'}</h2>
      </div>

      {/* Title */}
      <div>
        <label style={{ fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: 5 }}>Meeting Title *</label>
        <input value={form.title} onChange={e => set('title', e.target.value)} placeholder="Weekly Standup, Bible Study..."
          style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '9px 12px', color: '#fff', fontSize: '0.88rem', outline: 'none', boxSizing: 'border-box' }}
        />
      </div>

      {/* Date + Time */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <div>
          <label style={{ fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: 5 }}>Date *</label>
          <input type="date" value={form.date} onChange={e => set('date', e.target.value)}
            style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '9px 12px', color: '#fff', fontSize: '0.85rem', outline: 'none', boxSizing: 'border-box' }}
          />
        </div>
        <div>
          <label style={{ fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: 5 }}>Start Time</label>
          <div style={{ display: 'flex', gap: 4 }}>
            <select value={form.startHour} onChange={e => set('startHour', e.target.value)} style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '9px 6px', color: '#fff', fontSize: '0.82rem', outline: 'none' }}>
              {Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')).map(h => <option key={h} value={h}>{h}</option>)}
            </select>
            <select value={form.startMin} onChange={e => set('startMin', e.target.value)} style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '9px 6px', color: '#fff', fontSize: '0.82rem', outline: 'none' }}>
              {['00', '15', '30', '45'].map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label style={{ fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: 5 }}>End Time</label>
          <div style={{ display: 'flex', gap: 4 }}>
            <select value={form.endHour} onChange={e => set('endHour', e.target.value)} style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '9px 6px', color: '#fff', fontSize: '0.82rem', outline: 'none' }}>
              {Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')).map(h => <option key={h} value={h}>{h}</option>)}
            </select>
            <select value={form.endMin} onChange={e => set('endMin', e.target.value)} style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '9px 6px', color: '#fff', fontSize: '0.82rem', outline: 'none' }}>
              {['00', '15', '30', '45'].map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* Platform */}
      <div>
        <label style={{ fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: 8 }}>Platform</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {PLATFORMS.map(p => (
            <button key={p.id} onClick={() => set('platform', p.id)} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
              background: form.platform === p.id ? `${p.color}33` : 'rgba(255,255,255,0.04)',
              border: `1px solid ${form.platform === p.id ? p.color : 'rgba(255,255,255,0.08)'}`,
              borderRadius: 20, cursor: 'pointer', color: '#fff', fontSize: '0.78rem',
            }}>
              {p.icon} {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Meeting link */}
      <div>
        <label style={{ fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: 5 }}>Meeting Link</label>
        <input value={form.link} onChange={e => set('link', e.target.value)} placeholder={`Paste your ${plat?.label || ''} link...`}
          style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '9px 12px', color: '#fff', fontSize: '0.85rem', outline: 'none', boxSizing: 'border-box' }}
        />
      </div>

      {/* Attendees */}
      <div>
        <label style={{ fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: 5 }}>Attendees (comma-separated emails)</label>
        <input value={form.attendees} onChange={e => set('attendees', e.target.value)} placeholder="alice@example.com, bob@example.com"
          style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '9px 12px', color: '#fff', fontSize: '0.85rem', outline: 'none', boxSizing: 'border-box' }}
        />
      </div>

      {/* Recurring */}
      <div>
        <label style={{ fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: 5 }}>Recurring</label>
        <select value={form.recurring} onChange={e => set('recurring', e.target.value)}
          style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '9px 12px', color: '#fff', fontSize: '0.85rem', outline: 'none' }}>
          <option value="none">One-time</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="biweekly">Bi-weekly</option>
          <option value="monthly">Monthly</option>
        </select>
      </div>

      {/* Notes */}
      <div>
        <label style={{ fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: 5 }}>Agenda / Notes</label>
        <textarea value={form.notes} onChange={e => set('notes', e.target.value)} rows={4} placeholder="Meeting agenda, topics to discuss..."
          style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '9px 12px', color: '#fff', fontSize: '0.85rem', outline: 'none', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6, boxSizing: 'border-box' }}
        />
      </div>

      <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
        <button onClick={handleSave} style={{ flex: 1, background: '#7c3aed', border: 'none', borderRadius: 10, padding: '11px', cursor: 'pointer', color: '#fff', fontWeight: 600, fontSize: '0.88rem' }}>
          {initial ? 'Save Changes' : 'Create Meeting'}
        </button>
        <button onClick={onCancel} style={{ background: 'rgba(255,255,255,0.06)', border: 'none', borderRadius: 10, padding: '11px 20px', cursor: 'pointer', color: '#aaa', fontSize: '0.88rem' }}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── Meeting Card ──────────────────────────────────────────────────────────────
function MeetingCard({ meeting, onJoin, onEdit, onDelete }) {
  const status = getMeetingStatus(meeting)
  const plat = PLATFORMS.find(p => p.id === meeting.platform) || PLATFORMS[4]
  const [copied, setCopied] = useState(false)
  const attendeeList = meeting.attendees ? meeting.attendees.split(',').map(s => s.trim()).filter(Boolean) : []

  const copyLink = () => {
    if (meeting.link) { navigator.clipboard.writeText(meeting.link).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 2000) }
  }

  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)', border: `1px solid ${status === 'live' ? '#22c55e55' : 'rgba(255,255,255,0.07)'}`,
      borderRadius: 16, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10,
      boxShadow: status === 'live' ? '0 0 0 1px #22c55e22, 0 4px 20px rgba(34,197,94,0.1)' : 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ width: 42, height: 42, borderRadius: 12, background: `${plat.color}22`, border: `1px solid ${plat.color}44`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0 }}>
          {plat.icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#fff', marginBottom: 3 }}>{meeting.title}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.75rem', color: '#888', flexWrap: 'wrap' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Calendar size={11} />{new Date(meeting.startTime).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Clock size={11} />{new Date(meeting.startTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} · {fmtDuration(meeting.startTime, meeting.endTime)}</span>
            {meeting.recurring !== 'none' && <span style={{ background: 'rgba(124,58,237,0.15)', border: '1px solid rgba(124,58,237,0.3)', borderRadius: 10, padding: '1px 7px', color: '#a78bfa', fontSize: '0.68rem' }}>{meeting.recurring}</span>}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLORS[status], boxShadow: status === 'live' ? '0 0 6px #22c55e' : 'none' }} />
          <span style={{ fontSize: '0.7rem', color: STATUS_COLORS[status], fontWeight: 600, textTransform: 'uppercase' }}>{status}</span>
        </div>
      </div>

      {attendeeList.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Users size={12} color="#666" />
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {attendeeList.slice(0, 4).map((a, i) => (
              <div key={i} style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 20, padding: '2px 8px', fontSize: '0.68rem', color: '#aaa' }}>{a}</div>
            ))}
            {attendeeList.length > 4 && <div style={{ color: '#555', fontSize: '0.68rem' }}>+{attendeeList.length - 4}</div>}
          </div>
        </div>
      )}

      {meeting.notes && (
        <div style={{ fontSize: '0.75rem', color: '#777', background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '8px 10px', borderLeft: '2px solid rgba(124,58,237,0.4)', lineHeight: 1.5 }}>
          {meeting.notes.slice(0, 120)}{meeting.notes.length > 120 ? '...' : ''}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        {meeting.link && (
          <button onClick={onJoin} style={{ flex: 1, background: status === 'live' ? '#22c55e' : '#7c3aed', border: 'none', borderRadius: 10, padding: '8px', cursor: 'pointer', color: '#fff', fontWeight: 600, fontSize: '0.82rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <Video size={14} /> {status === 'live' ? 'Join Now' : 'Join'}
          </button>
        )}
        {meeting.link && (
          <button onClick={copyLink} style={{ background: 'rgba(255,255,255,0.06)', border: 'none', borderRadius: 10, padding: '8px 12px', cursor: 'pointer', color: copied ? '#22c55e' : '#888', display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.78rem' }}>
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied!' : 'Copy'}
          </button>
        )}
        <button onClick={onEdit} style={{ background: 'rgba(255,255,255,0.06)', border: 'none', borderRadius: 10, padding: '8px 12px', cursor: 'pointer', color: '#888' }}>
          <Settings2 size={14} />
        </button>
        <button onClick={onDelete} style={{ background: 'rgba(255,255,255,0.06)', border: 'none', borderRadius: 10, padding: '8px 12px', cursor: 'pointer', color: '#ef4444' }}>
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function MeetingsApp() {
  const [meetings, setMeetings] = useState(load)
  const [view, setView] = useState('list') // list | new | edit
  const [editing, setEditing] = useState(null)
  const [filter, setFilter] = useState('all') // all | upcoming | live | done

  const update = (list) => { setMeetings(list); save(list) }

  const handleSave = (m) => {
    if (editing) {
      update(meetings.map(x => x.id === m.id ? m : x))
    } else {
      update([...meetings, m])
    }
    setEditing(null); setView('list')
  }

  const del = (id) => update(meetings.filter(m => m.id !== id))

  const join = (m) => {
    if (m.link) window.open(m.link, '_blank')
  }

  const filtered = meetings.filter(m => {
    if (filter === 'all') return true
    return getMeetingStatus(m) === filter
  }).sort((a, b) => new Date(a.startTime) - new Date(b.startTime))

  const liveMeetings = meetings.filter(m => getMeetingStatus(m) === 'live')

  if (view === 'new' || view === 'edit') {
    return (
      <div style={{ height: '100%', background: '#08080f', color: '#fff', overflowY: 'auto' }}>
        <MeetingForm initial={editing} onSave={handleSave} onCancel={() => { setView('list'); setEditing(null) }} />
      </div>
    )
  }

  return (
    <div style={{ height: '100%', background: '#08080f', color: '#fff', fontFamily: 'system-ui', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <Video size={18} color="#7c3aed" />
        <span style={{ fontWeight: 700, fontSize: '1rem', flex: 1 }}>Meetings</span>
        {liveMeetings.length > 0 && (
          <div style={{ background: '#22c55e22', border: '1px solid #22c55e55', borderRadius: 20, padding: '4px 10px', fontSize: '0.72rem', color: '#22c55e', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', animation: 'pulse 1.5s infinite' }} />
            {liveMeetings.length} Live
          </div>
        )}
        <button onClick={() => { setEditing(null); setView('new') }} style={{ background: '#7c3aed', border: 'none', borderRadius: 10, padding: '8px 14px', cursor: 'pointer', color: '#fff', fontWeight: 600, fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Plus size={14} /> New Meeting
        </button>
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 6, padding: '10px 18px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        {[['all', 'All'], ['live', 'Live'], ['upcoming', 'Upcoming'], ['done', 'Past']].map(([id, label]) => (
          <button key={id} onClick={() => setFilter(id)} style={{
            padding: '6px 14px 10px', border: 'none', background: 'none', cursor: 'pointer',
            color: filter === id ? '#a78bfa' : '#666', fontWeight: 500, fontSize: '0.8rem',
            borderBottom: `2px solid ${filter === id ? '#7c3aed' : 'transparent'}`, marginBottom: -1,
          }}>
            {label}
            {id === 'live' && liveMeetings.length > 0 && <span style={{ marginLeft: 5, background: '#22c55e', color: '#fff', borderRadius: 10, padding: '0 5px', fontSize: '0.65rem' }}>{liveMeetings.length}</span>}
          </button>
        ))}
      </div>

      {/* Meeting list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {filtered.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 200, gap: 12, color: '#444' }}>
            <Video size={36} style={{ opacity: 0.2 }} />
            <div style={{ fontSize: '0.85rem' }}>No {filter === 'all' ? '' : filter} meetings</div>
            <button onClick={() => setView('new')} style={{ background: 'rgba(124,58,237,0.15)', border: '1px solid rgba(124,58,237,0.3)', borderRadius: 10, padding: '8px 16px', cursor: 'pointer', color: '#a78bfa', fontSize: '0.8rem' }}>
              Schedule one
            </button>
          </div>
        )}
        {filtered.map(m => (
          <MeetingCard key={m.id} meeting={m}
            onJoin={() => join(m)}
            onEdit={() => { setEditing(m); setView('edit') }}
            onDelete={() => del(m.id)}
          />
        ))}
      </div>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>
    </div>
  )
}
