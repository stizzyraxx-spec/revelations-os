import { useState, useEffect, useCallback, useRef } from 'react'
import { Home, Folder, FileText, Download, Music2, Video, Search, ArrowLeft } from 'lucide-react'
import { IS_WIN } from '../platform'

// Scrolls — a Finder/Explorer-style file browser with a Locations sidebar and
// machine search, built on the OS file-system bridge (window.nexus).
//
// The same bundle ships on both platforms, so the machine-level entries below
// the home folders have to follow the host: drive roots on Windows, /Applications
// and /Volumes on a Mac. Home folders are identical apart from Movies vs Videos.
const LOCATIONS = [
  { label: 'Home', path: '~', icon: Home },
  { label: 'Desktop', path: '~/Desktop', icon: Folder },
  { label: 'Documents', path: '~/Documents', icon: FileText },
  { label: 'Downloads', path: '~/Downloads', icon: Download },
  { label: 'Pictures', path: '~/Pictures', icon: Folder },
  { label: 'Music', path: '~/Music', icon: Music2 },
  IS_WIN
    ? { label: 'Videos', path: '~/Videos', icon: Video }
    : { label: 'Movies', path: '~/Movies', icon: Video },
  ...(IS_WIN
    ? [
        { label: 'Program Files', path: 'C:\\Program Files', icon: Folder },
        { label: 'Program Files (x86)', path: 'C:\\Program Files (x86)', icon: Folder },
        { label: 'This PC (C:)', path: 'C:\\', icon: Folder },
      ]
    : [
        { label: 'Applications', path: '/Applications', icon: Folder },
        { label: 'Volumes', path: '/Volumes', icon: Folder },
      ]),
]

function fmtSize(n) {
  if (!n) return ''
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0, v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}

export default function Scrolls() {
  const [path, setPath] = useState('~')
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(false)
  const [history, setHistory] = useState([])
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState(null) // null = not in search mode
  const searchAbort = useRef(0)

  const load = useCallback(async (p, pushHistory = true) => {
    setLoading(true); setResults(null); setQuery('')
    try {
      const list = await window.nexus?.scanDirectory?.(p)
      setEntries(Array.isArray(list) ? sortEntries(list) : [])
      if (pushHistory) setHistory((h) => [...h, path])
      setPath(p)
    } catch { setEntries([]) }
    finally { setLoading(false) }
  }, [path])

  useEffect(() => { load('~', false) }, [])

  const goBack = () => {
    setHistory((h) => {
      if (!h.length) return h
      const prev = h[h.length - 1]
      load(prev, false)
      return h.slice(0, -1)
    })
  }

  const open = (entry) => {
    if (entry.type === 'folder') load(entry.fullPath)
    else window.nexus?.downloadOpen?.(entry.fullPath) // best-effort open with default app
  }

  // Bounded breadth-first machine search from the current location.
  const runSearch = useCallback(async (q) => {
    const token = ++searchAbort.current
    setSearching(true); setResults([])
    const needle = q.toLowerCase()
    const found = []
    const queue = [path]
    const started = Date.now()
    let scanned = 0
    while (queue.length && found.length < 400 && scanned < 1200 && (Date.now() - started) < 5000) {
      if (token !== searchAbort.current) return // superseded
      const dir = queue.shift(); scanned++
      const list = await window.nexus?.scanDirectory?.(dir)
      if (!Array.isArray(list)) continue
      for (const e of list) {
        if (e.name.toLowerCase().includes(needle)) found.push(e)
        if (e.type === 'folder') queue.push(e.fullPath)
      }
      if (found.length && scanned % 8 === 0) setResults([...found])
    }
    if (token === searchAbort.current) { setResults(found); setSearching(false) }
  }, [path])

  const onSearchKey = (e) => {
    if (e.key === 'Enter' && query.trim()) runSearch(query.trim())
    else if (e.key === 'Escape') { setQuery(''); setResults(null); searchAbort.current++ }
  }

  const list = results !== null ? results : entries

  return (
    <div style={{ height: '100%', display: 'flex', background: '#0b0b12', color: 'var(--text-primary)' }}>
      {/* Locations sidebar */}
      <div style={{ width: 180, flexShrink: 0, background: 'rgba(0,0,0,0.35)', borderRight: '1px solid rgba(255,255,255,0.07)', padding: '12px 8px', overflowY: 'auto' }}>
        <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '4px 8px 8px' }}>Locations</div>
        {LOCATIONS.map((loc) => {
          const Icon = loc.icon
          const active = path === loc.path
          return (
            <button key={loc.path} onClick={() => load(loc.path)}
              style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '7px 9px', borderRadius: 8, cursor: 'pointer', marginBottom: 2, textAlign: 'left', background: active ? 'rgba(109,40,217,0.28)' : 'transparent', border: '1px solid ' + (active ? 'var(--border-accent)' : 'transparent'), color: active ? '#fff' : 'var(--text-secondary)' }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.06)' }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent' }}>
              <Icon size={15} style={{ flexShrink: 0, color: active ? '#a78bfa' : 'var(--text-muted)' }} />
              <span style={{ fontSize: '0.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{loc.label}</span>
            </button>
          )
        })}
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <button onClick={goBack} disabled={!history.length} title="Back"
            style={{ display: 'flex', alignItems: 'center', padding: 6, borderRadius: 7, cursor: history.length ? 'pointer' : 'default', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: history.length ? 'var(--text-secondary)' : 'rgba(255,255,255,0.2)' }}>
            <ArrowLeft size={15} />
          </button>
          <div style={{ flex: 1, fontSize: '0.8rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '6px 10px', width: 240 }}>
            <Search size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey}
              placeholder="Search this location…"
              style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: 13, minWidth: 0 }} />
          </div>
        </div>

        {/* Status */}
        {(loading || searching || results !== null) && (
          <div style={{ padding: '6px 14px', fontSize: '0.72rem', color: 'var(--text-muted)', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
            {loading ? 'Loading…' : searching ? `Searching… ${list.length} found` : `${list.length} result${list.length === 1 ? '' : 's'} for "${query}"`}
          </div>
        )}

        {/* Entry list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px' }}>
          {list.map((e) => {
            const Icon = e.type === 'folder' ? Folder : FileText
            return (
              <div key={e.fullPath} onDoubleClick={() => open(e)} title={e.fullPath}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 7, cursor: 'default' }}
                onMouseEnter={(ev) => { ev.currentTarget.style.background = 'rgba(255,255,255,0.06)' }}
                onMouseLeave={(ev) => { ev.currentTarget.style.background = 'transparent' }}>
                <Icon size={17} style={{ flexShrink: 0, color: e.type === 'folder' ? '#d9a441' : 'var(--text-muted)' }} />
                <span style={{ flex: 1, fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
                {results !== null && <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.fullPath}</span>}
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', width: 64, textAlign: 'right', flexShrink: 0 }}>{e.type === 'file' ? fmtSize(e.size) : ''}</span>
              </div>
            )
          })}
          {!loading && !searching && list.length === 0 && (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)', fontSize: 13 }}>
              {results !== null ? 'Nothing found here.' : 'This folder is empty or not accessible.'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function sortEntries(list) {
  return [...list].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  })
}
