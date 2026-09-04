import { useState, useEffect, useRef, useMemo } from 'react'
import { useOSStore } from '../store'
import { APP_REGISTRY } from '../constants'
import { Search, X } from 'lucide-react'
import { getAppIcon } from './appIcons'
import { MOD_KEY } from '../platform'

export default function Spotlight({ open, onClose }) {
  const { openWindow } = useOSStore()
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef(null)

  useEffect(() => {
    if (open) { setQuery(''); setSel(0); setTimeout(() => inputRef.current?.focus(), 50) }
  }, [open])

  const results = useMemo(() => {
    if (!query.trim()) return APP_REGISTRY.filter(a => a.free).slice(0, 8)
    const q = query.toLowerCase()
    return APP_REGISTRY
      .filter(a => a.name.toLowerCase().includes(q) || a.desc.toLowerCase().includes(q) || a.category.toLowerCase().includes(q))
      .slice(0, 10)
  }, [query])

  useEffect(() => { setSel(0) }, [results.length])

  const launch = (app) => {
    if (app.free) {
      openWindow({
        appId: app.id, title: app.name,
        props: app.liveUrl ? { liveUrl: app.liveUrl, appId: app.id, appName: app.name } : {},
        ...(app.id === 'calculator' ? { width: 440, height: 520 } : {}),
        ...(app.id === 'clock' ? { width: 480, height: 560 } : {}),
        ...(app.id === 'calendar' ? { width: 780, height: 560 } : {}),
        ...(app.id === 'music' ? { width: 680, height: 480 } : {}),
        ...(app.id === 'photos' ? { width: 1000, height: 680 } : {}),
        ...(app.id === 'videos' ? { width: 1040, height: 700 } : {}),
      })
    } else {
      useOSStore.getState().openSubscription(app)
    }
    onClose()
  }

  const onKey = (e) => {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, results.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)) }
    if (e.key === 'Enter' && results[sel]) launch(results[sel])
  }

  if (!open) return null

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9500,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '18vh',
      }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 560, background: 'rgba(8,8,20,0.97)',
          borderRadius: 18, overflow: 'hidden',
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.8), 0 0 0 1px rgba(124,58,237,0.2)',
          backdropFilter: 'blur(32px)',
        }}
        className="animate-scale-in"
      >
        {/* Search field */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 18px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <Search size={18} style={{ color: '#a78bfa', flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search apps, settings, files..."
            style={{ flex: 1, background: 'none', border: 'none', color: '#fff', fontSize: '1.05rem', outline: 'none', fontFamily: 'inherit' }}
          />
          {query && (
            <button onClick={() => setQuery('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#555', padding: 0 }}>
              <X size={14} />
            </button>
          )}
          <kbd style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '2px 8px', fontSize: '0.7rem', color: '#666', flexShrink: 0 }}>ESC</kbd>
        </div>

        {/* Results */}
        <div style={{ maxHeight: 400, overflowY: 'auto', padding: '8px 8px 10px' }}>
          {!query.trim() && (
            <div style={{ padding: '4px 12px 6px', fontSize: '0.68rem', color: '#555', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Quick Launch</div>
          )}
          {results.map((app, i) => {
            const Icon = getAppIcon(app.icon)
            return (
              <button
                key={app.id}
                onClick={() => launch(app)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px',
                  background: i === sel ? 'rgba(124,58,237,0.25)' : 'transparent',
                  border: `1px solid ${i === sel ? 'rgba(124,58,237,0.4)' : 'transparent'}`,
                  borderRadius: 12, cursor: 'pointer', color: '#fff', textAlign: 'left',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={() => setSel(i)}
              >
                <div style={{ width: 38, height: 38, borderRadius: 10, background: `linear-gradient(135deg, ${app.color}44, ${app.color}99)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Icon size={18} color={app.color} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.88rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{app.name}</div>
                  <div style={{ fontSize: '0.72rem', color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{app.desc}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {!app.free && <span style={{ fontSize: '0.65rem', color: '#f59e0b' }}>{app.price}</span>}
                  <span style={{ fontSize: '0.65rem', color: '#444', textTransform: 'uppercase' }}>{app.category}</span>
                </div>
              </button>
            )
          })}
          {results.length === 0 && (
            <div style={{ padding: '24px', textAlign: 'center', color: '#555', fontSize: '0.88rem' }}>No results for "{query}"</div>
          )}
        </div>

        <div style={{ padding: '8px 18px', borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', gap: 16 }}>
          {[['↑↓', 'Navigate'], ['↵', 'Open'], [`${MOD_KEY} Space`, 'Toggle']].map(([key, label]) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <kbd style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 5, padding: '2px 6px', fontSize: '0.68rem', color: '#777' }}>{key}</kbd>
              <span style={{ fontSize: '0.68rem', color: '#555' }}>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
