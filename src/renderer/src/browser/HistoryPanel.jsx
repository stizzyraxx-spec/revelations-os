import { useState, useMemo } from 'react'
import { Clock, Globe, X, Search, Trash2 } from 'lucide-react'

const HISTORY_KEY = 'ephesians_history'

function getRelativeTime(ts) {
  const now = Date.now()
  const diff = now - ts
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function getDateLabel(ts) {
  const now = new Date()
  const date = new Date(ts)
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 86400000
  if (ts >= todayStart) return 'Today'
  if (ts >= yesterdayStart) return 'Yesterday'
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}

function groupByDate(entries) {
  const groups = {}
  const order = []
  for (const entry of entries) {
    const label = getDateLabel(entry.ts)
    if (!groups[label]) {
      groups[label] = []
      order.push(label)
    }
    groups[label].push(entry)
  }
  return order.map((label) => ({ label, entries: groups[label] }))
}

export default function HistoryPanel({ onNavigate, onClose }) {
  const [search, setSearch] = useState('')
  const [history, setHistory] = useState(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY)
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  })

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const items = q
      ? history.filter(
          (e) =>
            (e.url && e.url.toLowerCase().includes(q)) ||
            (e.title && e.title.toLowerCase().includes(q))
        )
      : history
    return [...items].sort((a, b) => b.ts - a.ts)
  }, [history, search])

  const groups = useMemo(() => groupByDate(filtered), [filtered])

  function handleClearAll() {
    localStorage.removeItem(HISTORY_KEY)
    setHistory([])
  }

  function handleNavigate(url) {
    onNavigate(url)
    onClose()
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'var(--bg-secondary)',
        color: 'var(--text-primary)',
        borderLeft: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 100,
        fontFamily: 'inherit',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 16px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <Clock size={16} style={{ opacity: 0.7 }} />
        <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>History</span>
        <button
          onClick={handleClearAll}
          title="Clear All"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 6,
            color: 'var(--text-primary)',
            cursor: 'pointer',
            padding: '4px 10px',
            fontSize: 12,
            opacity: 0.75,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.75')}
        >
          <Trash2 size={13} />
          Clear All
        </button>
        <button
          onClick={onClose}
          title="Close"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--text-primary)',
            cursor: 'pointer',
            padding: 4,
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            opacity: 0.7,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.7')}
        >
          <X size={16} />
        </button>
      </div>

      {/* Search */}
      <div
        style={{
          padding: '10px 16px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'var(--bg-primary, rgba(0,0,0,0.2))',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '6px 10px',
          }}
        >
          <Search size={14} style={{ opacity: 0.5, flexShrink: 0 }} />
          <input
            type="text"
            placeholder="Search history..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--text-primary)',
              fontSize: 13,
              flex: 1,
              minWidth: 0,
            }}
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-primary)',
                cursor: 'pointer',
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                opacity: 0.5,
              }}
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {groups.length === 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              gap: 12,
              opacity: 0.45,
              padding: 32,
              textAlign: 'center',
            }}
          >
            <Clock size={32} />
            <div style={{ fontSize: 14, fontWeight: 500 }}>No history yet</div>
            <div style={{ fontSize: 12 }}>
              {search ? 'No results match your search.' : 'Pages you visit will appear here.'}
            </div>
          </div>
        ) : (
          groups.map(({ label, entries: groupEntries }) => (
            <div key={label}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  opacity: 0.5,
                  padding: '8px 16px 4px',
                }}
              >
                {label}
              </div>
              {groupEntries.map((entry, i) => (
                <HistoryEntry
                  key={`${entry.url}-${entry.ts}-${i}`}
                  entry={entry}
                  onNavigate={handleNavigate}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function HistoryEntry({ entry, onNavigate }) {
  const [hovered, setHovered] = useState(false)

  const title = entry.title || entry.url || 'Untitled'
  const url = entry.url || ''

  return (
    <div
      onClick={() => url && onNavigate(url)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '7px 16px',
        cursor: url ? 'pointer' : 'default',
        background: hovered ? 'var(--bg-hover, rgba(255,255,255,0.06))' : 'transparent',
        transition: 'background 0.1s',
      }}
    >
      <Globe size={15} style={{ opacity: 0.45, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          title={title}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 11,
            opacity: 0.5,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            marginTop: 1,
          }}
          title={url}
        >
          {url}
        </div>
      </div>
      <div
        style={{
          fontSize: 11,
          opacity: 0.4,
          flexShrink: 0,
          whiteSpace: 'nowrap',
        }}
      >
        {getRelativeTime(entry.ts)}
      </div>
    </div>
  )
}
