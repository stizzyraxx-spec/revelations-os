import { useEffect, useMemo, useState } from 'react'
import {
  MapPin, Search, CalendarPlus, ExternalLink, RefreshCw, Settings2, Plus, Trash2,
  Check, AlertCircle, Ticket, Users, X,
} from 'lucide-react'

const CFG_KEY = 'revos_gatherings_config'
const LAST_KEY = 'revos_gatherings_last'
const CAL_KEY = 'revos_calendar_events'
const SAVED_KEY = 'revos_gatherings_saved'

const DEFAULT_CFG = {
  ticketmasterKey: '',
  serpApiKey: '',
  eventbriteToken: '',
  eventbriteOrganizers: [],
  icsFeeds: [],
}

const loadCfg = () => {
  try { return { ...DEFAULT_CFG, ...(JSON.parse(localStorage.getItem(CFG_KEY)) || {}) } }
  catch { return { ...DEFAULT_CFG } }
}
const saveCfg = (c) => localStorage.setItem(CFG_KEY, JSON.stringify(c))
const loadLast = () => {
  try { return JSON.parse(localStorage.getItem(LAST_KEY)) || {} } catch { return {} }
}
const loadSaved = () => {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY)) || [] } catch { return [] }
}

const RADII = [10, 25, 50, 100]
const RANGES = [
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'quarter', label: 'Next 3 months' },
]
const STRICTNESS = [
  { id: 'strict', label: 'Strict', hint: 'Only unmistakably Christian events' },
  { id: 'balanced', label: 'Balanced', hint: 'Clear faith signal required' },
  { id: 'broad', label: 'Broad', hint: 'Includes likely faith-adjacent events' },
]
const ALL_TAGS = ['Worship', 'Bible Study', 'Prayer', 'Conference', 'Youth', 'Music', 'Outreach', 'Family']

const SOURCE_META = {
  ics: { label: 'Church feed', color: '#7c3aed' },
  eventbrite: { label: 'Eventbrite', color: '#f97316' },
  ticketmaster: { label: 'Ticketmaster', color: '#0ea5e9' },
  google: { label: 'Google Events', color: '#22c55e' },
}

const MONTHS_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']

function fmtTime(isoStr, allDay) {
  if (!isoStr) return ''
  const d = new Date(isoStr)
  if (isNaN(d)) return ''
  if (allDay) return 'All day'
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function fmtDayLabel(isoStr) {
  if (!isoStr) return ''
  const d = new Date(isoStr)
  if (isNaN(d)) return ''
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

// Events land in the same localStorage shape the Calendar app reads, so a saved
// gathering shows up there without any extra sync step.
function addToCalendar(ev) {
  if (!ev.start) return false
  const d = new Date(ev.start)
  if (isNaN(d)) return false
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  let events = {}
  try { events = JSON.parse(localStorage.getItem(CAL_KEY)) || {} } catch { events = {} }
  const day = events[key] || []
  if (day.some(e => e.title === ev.title)) return true
  day.push({
    id: Date.now() + Math.floor(Math.random() * 1000),
    title: ev.title,
    time: ev.allDay ? '00:00' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    color: '#7c3aed',
  })
  events[key] = day
  localStorage.setItem(CAL_KEY, JSON.stringify(events))
  return true
}

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: 5, fontWeight: 600 }}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: '0.7rem', color: '#555', marginTop: 5, lineHeight: 1.6 }}>{hint}</div>}
    </div>
  )
}

const inputStyle = {
  width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 10, padding: '9px 12px', color: '#fff', fontSize: '0.82rem', outline: 'none',
  boxSizing: 'border-box',
}

function EventCard({ ev, onSave, saved }) {
  const meta = SOURCE_META[ev.source] || { label: ev.source, color: '#666' }
  const d = ev.start ? new Date(ev.start) : null
  const valid = d && !isNaN(d)

  const open = () => {
    if (!ev.url) return
    window.nexus?.eventsOpenExternal?.(ev.url)
  }

  return (
    <div style={{
      display: 'flex', gap: 14, padding: '14px 16px', marginBottom: 10,
      background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
      borderLeft: `4px solid ${meta.color}`, borderRadius: 14,
    }}>
      {/* Date block */}
      <div style={{
        width: 54, flexShrink: 0, textAlign: 'center', paddingTop: 2,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start',
      }}>
        {valid ? (
          <>
            <div style={{ fontSize: '0.62rem', color: '#a78bfa', fontWeight: 700, letterSpacing: 0.5 }}>{MONTHS_SHORT[d.getMonth()]}</div>
            <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff', lineHeight: 1.1 }}>{d.getDate()}</div>
            <div style={{ fontSize: '0.62rem', color: '#666' }}>{d.toLocaleDateString('en-US', { weekday: 'short' })}</div>
          </>
        ) : (
          <div style={{ fontSize: '0.65rem', color: '#666', lineHeight: 1.4 }}>{ev.whenText || 'Date TBA'}</div>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: '0.9rem', color: '#fff', marginBottom: 3, wordBreak: 'break-word' }}>
          {ev.title}
        </div>
        <div style={{ fontSize: '0.73rem', color: '#888', display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 6 }}>
          {valid && <span>{fmtDayLabel(ev.start)} · {fmtTime(ev.start, ev.allDay)}</span>}
          {ev.venue?.name && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
              <MapPin size={11} style={{ flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>
                {ev.venue.name}
              </span>
            </span>
          )}
          {ev.distance != null && <span style={{ color: '#666' }}>{ev.distance} mi</span>}
        </div>

        {ev.description && (
          <div style={{ fontSize: '0.74rem', color: '#777', lineHeight: 1.6, marginBottom: 8 }}>
            {ev.description.slice(0, 180)}{ev.description.length > 180 ? '…' : ''}
          </div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <span style={{
            fontSize: '0.64rem', padding: '3px 8px', borderRadius: 99, fontWeight: 600,
            background: `${meta.color}22`, color: meta.color, border: `1px solid ${meta.color}44`,
          }}>{meta.label}</span>
          {(ev.alsoOn || []).map(s => (
            <span key={s} style={{ fontSize: '0.64rem', padding: '3px 8px', borderRadius: 99, background: 'rgba(255,255,255,0.05)', color: '#777' }}>
              also on {SOURCE_META[s]?.label || s}
            </span>
          ))}
          {(ev.vendors || []).slice(0, 2).map(v => (
            <span key={v} style={{ fontSize: '0.64rem', padding: '3px 8px', borderRadius: 99, background: 'rgba(255,255,255,0.05)', color: '#777' }}>
              {v}
            </span>
          ))}
          {(ev.tags || []).slice(0, 3).map(t => (
            <span key={t} style={{ fontSize: '0.64rem', padding: '3px 8px', borderRadius: 99, background: 'rgba(124,58,237,0.12)', color: '#a78bfa' }}>{t}</span>
          ))}
          {ev.priceText && (
            <span style={{ fontSize: '0.64rem', padding: '3px 8px', borderRadius: 99, background: 'rgba(34,197,94,0.12)', color: '#22c55e' }}>{ev.priceText}</span>
          )}
          {ev.recurring && (
            <span style={{ fontSize: '0.64rem', padding: '3px 8px', borderRadius: 99, background: 'rgba(255,255,255,0.05)', color: '#777' }}>Recurring</span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0, justifyContent: 'center' }}>
        <button onClick={() => onSave(ev)} disabled={!ev.start} title={ev.start ? 'Add to Calendar' : 'No confirmed date'}
          style={{
            background: saved ? 'rgba(34,197,94,0.15)' : 'rgba(124,58,237,0.15)',
            border: `1px solid ${saved ? 'rgba(34,197,94,0.4)' : 'rgba(124,58,237,0.4)'}`,
            borderRadius: 9, padding: '7px 11px', cursor: ev.start ? 'pointer' : 'not-allowed',
            color: saved ? '#22c55e' : '#a78bfa', fontSize: '0.72rem', display: 'flex', alignItems: 'center', gap: 5,
            opacity: ev.start ? 1 : 0.4, whiteSpace: 'nowrap',
          }}>
          {saved ? <Check size={12} /> : <CalendarPlus size={12} />}
          {saved ? 'Added' : 'Add'}
        </button>
        {ev.url && (
          <button onClick={open} style={{
            background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 9, padding: '7px 11px', cursor: 'pointer', color: '#999',
            fontSize: '0.72rem', display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap',
          }}>
            <ExternalLink size={12} /> Open
          </button>
        )}
      </div>
    </div>
  )
}

function SourcesPanel({ cfg, setCfg }) {
  const [feedUrl, setFeedUrl] = useState('')
  const [feedLabel, setFeedLabel] = useState('')
  const [orgId, setOrgId] = useState('')

  const update = (patch) => { const next = { ...cfg, ...patch }; setCfg(next); saveCfg(next) }

  const addFeed = () => {
    const url = feedUrl.trim()
    if (!url) return
    update({ icsFeeds: [...cfg.icsFeeds, { url, label: feedLabel.trim() || 'Church calendar' }] })
    setFeedUrl(''); setFeedLabel('')
  }
  const addOrg = () => {
    const id = orgId.trim()
    if (!id || cfg.eventbriteOrganizers.includes(id)) return
    update({ eventbriteOrganizers: [...cfg.eventbriteOrganizers, id] })
    setOrgId('')
  }

  const card = {
    background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
    borderRadius: 14, padding: '16px 18px', marginBottom: 14,
  }
  const title = { fontWeight: 700, fontSize: '0.88rem', color: '#fff', marginBottom: 4 }
  const sub = { fontSize: '0.73rem', color: '#666', marginBottom: 14, lineHeight: 1.6 }

  return (
    <div style={{ padding: '16px 20px', overflowY: 'auto', height: '100%' }}>
      <div style={{ ...card, borderLeft: '4px solid #7c3aed' }}>
        <div style={title}>📋 Church calendar feeds</div>
        <div style={sub}>
          Works with no account or key. Most church sites publish an <b style={{ color: '#aaa' }}>.ics</b> link
          (Google Calendar → Settings → “Secret address in iCal format”, or a “Subscribe” button on the church’s
          events page). Feeds you add here are always trusted — every event on them is shown, keywords or not.
        </div>
        {cfg.icsFeeds.map((f, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', background: 'rgba(124,58,237,0.07)', borderRadius: 10, marginBottom: 7 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '0.8rem', color: '#fff', fontWeight: 600 }}>{f.label}</div>
              <div style={{ fontSize: '0.68rem', color: '#555', wordBreak: 'break-all' }}>{f.url}</div>
            </div>
            <button onClick={() => update({ icsFeeds: cfg.icsFeeds.filter((_, j) => j !== i) })}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#666', flexShrink: 0 }}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input value={feedLabel} onChange={e => setFeedLabel(e.target.value)} placeholder="Church name"
            style={{ ...inputStyle, flex: '0 0 150px' }} />
          <input value={feedUrl} onChange={e => setFeedUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && addFeed()}
            placeholder="https://…/calendar.ics" style={{ ...inputStyle, flex: 1 }} />
          <button onClick={addFeed} style={{ background: '#7c3aed', border: 'none', borderRadius: 10, padding: '0 14px', cursor: 'pointer', color: '#fff', fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
            <Plus size={13} /> Add
          </button>
        </div>
      </div>

      <div style={{ ...card, borderLeft: '4px solid #0ea5e9' }}>
        <div style={title}>🎟 Ticketmaster Discovery</div>
        <div style={sub}>
          Free API key — real distance-based search for worship nights, gospel concerts and conferences.
          Get one at <b style={{ color: '#aaa' }}>developer.ticketmaster.com</b> (Consumer Key).
        </div>
        <Field label="Consumer Key">
          <input value={cfg.ticketmasterKey} onChange={e => update({ ticketmasterKey: e.target.value.trim() })}
            type="password" placeholder="xxxxxxxxxxxxxxxxxxxxxxxx" style={inputStyle} />
        </Field>
      </div>

      <div style={{ ...card, borderLeft: '4px solid #22c55e' }}>
        <div style={title}>🌐 Google Events via SerpApi</div>
        <div style={sub}>
          The broadest source — Google Events aggregates <b style={{ color: '#aaa' }}>Eventbrite, Meetup, Facebook
          and church websites</b> in one query. Paid key from <b style={{ color: '#aaa' }}>serpapi.com</b>
          (free tier ≈ 100 searches/month; one search here uses four).
        </div>
        <Field label="SerpApi Key">
          <input value={cfg.serpApiKey} onChange={e => update({ serpApiKey: e.target.value.trim() })}
            type="password" placeholder="Paste your SerpApi key" style={inputStyle} />
        </Field>
      </div>

      <div style={{ ...card, borderLeft: '4px solid #f97316' }}>
        <div style={title}>🧡 Eventbrite (organizers you follow)</div>
        <div style={sub}>
          Eventbrite <b style={{ color: '#aaa' }}>retired its public event-search API in 2020</b> — no app can
          search “Eventbrite near me” anymore. What still works: name the organizers you care about (your church,
          a ministry, a conference) and their live listings come straight from Eventbrite. The organizer ID is the
          number in their page URL: eventbrite.com/o/<b style={{ color: '#aaa' }}>name-12345678</b>. Token from
          Account Settings → Developer Links → API Keys → “Private token”.
        </div>
        <Field label="Private Token">
          <input value={cfg.eventbriteToken} onChange={e => update({ eventbriteToken: e.target.value.trim() })}
            type="password" placeholder="Your Eventbrite private token" style={inputStyle} />
        </Field>
        <Field label="Organizer IDs">
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={orgId} onChange={e => setOrgId(e.target.value)} onKeyDown={e => e.key === 'Enter' && addOrg()}
              placeholder="12345678" style={{ ...inputStyle, flex: 1 }} />
            <button onClick={addOrg} style={{ background: '#f97316', border: 'none', borderRadius: 10, padding: '0 14px', cursor: 'pointer', color: '#fff', fontSize: '0.78rem', flexShrink: 0 }}>
              Add
            </button>
          </div>
        </Field>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {cfg.eventbriteOrganizers.map(id => (
            <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.72rem', padding: '4px 10px', borderRadius: 99, background: 'rgba(249,115,22,0.12)', color: '#fb923c' }}>
              {id}
              <button onClick={() => update({ eventbriteOrganizers: cfg.eventbriteOrganizers.filter(o => o !== id) })}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#fb923c', padding: 0, display: 'flex' }}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      </div>

      <div style={{ fontSize: '0.7rem', color: '#555', lineHeight: 1.7, padding: '0 4px 20px' }}>
        Keys are stored on this machine only and are sent straight to the provider you entered them for —
        never to Revelations OS servers.
      </div>
    </div>
  )
}

export default function GatheringsApp() {
  const last = loadLast()
  const [cfg, setCfg] = useState(loadCfg)
  const [tab, setTab] = useState('find')
  const [location, setLocation] = useState(last.location || '')
  const [radius, setRadius] = useState(last.radius || 25)
  const [range, setRange] = useState(last.range || 'month')
  const [strictness, setStrictness] = useState(last.strictness || 'balanced')
  const [activeTags, setActiveTags] = useState([])
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(loadSaved)

  const hasSources = !!(cfg.ticketmasterKey || cfg.serpApiKey || cfg.icsFeeds.length ||
    (cfg.eventbriteToken && cfg.eventbriteOrganizers.length))

  const search = async () => {
    if (!location.trim()) { setError('Enter a city or ZIP code'); return }
    if (!hasSources) { setTab('sources'); return }
    setLoading(true); setError('')
    localStorage.setItem(LAST_KEY, JSON.stringify({ location, radius, range, strictness }))
    try {
      const res = await window.nexus?.eventsSearch?.({ location, radius, range, strictness, config: cfg })
      if (!res) throw new Error('Event service unavailable')
      if (!res.ok && res.reason === 'no-sources') { setTab('sources'); setResult(null) }
      else if (!res.ok) setError(res.error || 'Search failed')
      else setResult(res)
    } catch (err) {
      setError(String(err.message || err))
    }
    setLoading(false)
  }

  // Repeat the last search on open so the app is never blank on return.
  useEffect(() => {
    if (last.location && hasSources) search()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onSave = (ev) => {
    if (!addToCalendar(ev)) return
    const next = [...new Set([...saved, ev.id])]
    setSaved(next)
    localStorage.setItem(SAVED_KEY, JSON.stringify(next))
  }

  const events = useMemo(() => {
    const list = result?.events || []
    if (!activeTags.length) return list
    return list.filter(e => (e.tags || []).some(t => activeTags.includes(t)))
  }, [result, activeTags])

  const tagCounts = useMemo(() => {
    const counts = {}
    for (const e of result?.events || []) for (const t of e.tags || []) counts[t] = (counts[t] || 0) + 1
    return counts
  }, [result])

  const toggleTag = (t) => setActiveTags(a => a.includes(t) ? a.filter(x => x !== t) : [...a, t])

  return (
    <div style={{ height: '100%', background: '#08080f', color: '#fff', fontFamily: 'system-ui', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ padding: '13px 18px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Users size={18} color="#7c3aed" />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: '0.98rem' }}>Gatherings</div>
          <div style={{ fontSize: '0.7rem', color: '#666' }}>Believer-based events near you</div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {[{ id: 'find', label: 'Find', icon: Search }, { id: 'sources', label: 'Sources', icon: Settings2 }].map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              background: tab === t.id ? '#7c3aed' : 'rgba(255,255,255,0.06)', border: 'none', borderRadius: 9,
              padding: '6px 12px', cursor: 'pointer', color: tab === t.id ? '#fff' : '#888', fontSize: '0.76rem',
              display: 'flex', alignItems: 'center', gap: 5, fontWeight: 600,
            }}>
              <t.icon size={12} /> {t.label}
              {t.id === 'sources' && !hasSources && (
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#f59e0b' }} />
              )}
            </button>
          ))}
        </div>
      </div>

      {tab === 'sources' && <SourcesPanel cfg={cfg} setCfg={setCfg} />}

      {tab === 'find' && (
        <>
          {/* Search bar */}
          <div style={{ padding: '12px 18px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <MapPin size={14} color="#666" style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)' }} />
                <input value={location} onChange={e => setLocation(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()}
                  placeholder="City or ZIP — e.g. Atlanta, GA or 30303"
                  style={{ ...inputStyle, paddingLeft: 32 }} />
              </div>
              <select value={radius} onChange={e => setRadius(Number(e.target.value))}
                style={{ ...inputStyle, width: 'auto', cursor: 'pointer' }}>
                {RADII.map(r => <option key={r} value={r} style={{ background: '#0d0d1a' }}>{r} mi</option>)}
              </select>
              <select value={range} onChange={e => setRange(e.target.value)}
                style={{ ...inputStyle, width: 'auto', cursor: 'pointer' }}>
                {RANGES.map(r => <option key={r.id} value={r.id} style={{ background: '#0d0d1a' }}>{r.label}</option>)}
              </select>
              <button onClick={search} disabled={loading} style={{
                background: loading ? '#374151' : '#7c3aed', border: 'none', borderRadius: 10, padding: '9px 18px',
                cursor: loading ? 'wait' : 'pointer', color: '#fff', fontWeight: 600, fontSize: '0.82rem',
                display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
              }}>
                {loading ? <RefreshCw size={13} style={{ animation: 'gspin 1s linear infinite' }} /> : <Search size={13} />}
                {loading ? 'Searching' : 'Search'}
              </button>
            </div>

            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.7rem', color: '#555', marginRight: 2 }}>Filter:</span>
              {STRICTNESS.map(s => (
                <button key={s.id} onClick={() => setStrictness(s.id)} title={s.hint} style={{
                  background: strictness === s.id ? 'rgba(124,58,237,0.25)' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${strictness === s.id ? 'rgba(124,58,237,0.5)' : 'rgba(255,255,255,0.07)'}`,
                  borderRadius: 99, padding: '4px 11px', cursor: 'pointer',
                  color: strictness === s.id ? '#a78bfa' : '#777', fontSize: '0.7rem',
                }}>{s.label}</button>
              ))}
              <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.1)', margin: '0 4px' }} />
              {ALL_TAGS.map(t => {
                const n = tagCounts[t] || 0
                const on = activeTags.includes(t)
                return (
                  <button key={t} onClick={() => toggleTag(t)} disabled={!n} style={{
                    background: on ? 'rgba(124,58,237,0.25)' : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${on ? 'rgba(124,58,237,0.5)' : 'rgba(255,255,255,0.07)'}`,
                    borderRadius: 99, padding: '4px 11px', cursor: n ? 'pointer' : 'default',
                    color: on ? '#a78bfa' : n ? '#777' : '#3a3a45', fontSize: '0.7rem',
                  }}>{t}{n ? ` ${n}` : ''}</button>
                )
              })}
            </div>
          </div>

          {/* Provider status */}
          {result?.providers?.length > 0 && (
            <div style={{ padding: '8px 18px', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              <span style={{ fontSize: '0.68rem', color: '#555' }}>
                {result.center?.label} · {events.length} of {result.events.length} shown
              </span>
              {result.providers.map(p => (
                <span key={p.source} title={p.error || ''} style={{
                  fontSize: '0.66rem', display: 'inline-flex', alignItems: 'center', gap: 4,
                  color: p.ok ? '#666' : '#ef4444',
                }}>
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: p.ok ? (SOURCE_META[p.source]?.color || '#666') : '#ef4444' }} />
                  {SOURCE_META[p.source]?.label || p.source}: {p.ok ? `${p.count} raw` : 'failed'}
                </span>
              ))}
            </div>
          )}

          {/* Results */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px' }}>
            {error && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 10, color: '#fca5a5', fontSize: '0.8rem', marginBottom: 14 }}>
                <AlertCircle size={14} /> {error}
              </div>
            )}

            {!hasSources && (
              <div style={{ textAlign: 'center', padding: '50px 30px', color: '#555' }}>
                <Ticket size={44} style={{ opacity: 0.15 }} />
                <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#888', marginTop: 16 }}>Connect a source to begin</div>
                <div style={{ fontSize: '0.8rem', color: '#555', maxWidth: 420, margin: '10px auto 18px', lineHeight: 1.7 }}>
                  Add your church’s calendar feed (free, no account) or a Ticketmaster key for
                  distance-based search. Gatherings then pulls from every connected source and shows
                  only believer-based events.
                </div>
                <button onClick={() => setTab('sources')} style={{
                  background: 'rgba(124,58,237,0.2)', border: '1px solid rgba(124,58,237,0.4)', borderRadius: 12,
                  padding: '10px 22px', cursor: 'pointer', color: '#a78bfa', fontWeight: 600, fontSize: '0.85rem',
                }}>Open Sources</button>
              </div>
            )}

            {hasSources && !result && !loading && !error && (
              <div style={{ textAlign: 'center', padding: '60px 30px', color: '#444', fontSize: '0.85rem' }}>
                Enter your city or ZIP above to find gatherings near you.
              </div>
            )}

            {hasSources && result && events.length === 0 && !loading && (
              <div style={{ textAlign: 'center', padding: '50px 30px', color: '#555' }}>
                <div style={{ fontSize: '0.9rem', fontWeight: 600, color: '#777' }}>No gatherings matched</div>
                <div style={{ fontSize: '0.78rem', color: '#555', marginTop: 8, maxWidth: 360, marginInline: 'auto', lineHeight: 1.7 }}>
                  {activeTags.length
                    ? 'Try clearing the category filters.'
                    : 'Try a wider radius, a longer date range, or the “Broad” filter. Adding your church’s .ics feed usually helps most.'}
                </div>
              </div>
            )}

            {events.map(ev => (
              <EventCard key={ev.id} ev={ev} onSave={onSave} saved={saved.includes(ev.id)} />
            ))}
          </div>
        </>
      )}

      <style>{`@keyframes gspin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}
