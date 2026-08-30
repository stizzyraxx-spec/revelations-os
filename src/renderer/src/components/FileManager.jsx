import { useState, useEffect, useCallback } from 'react'
import { Home, ChevronRight, Folder, File, ArrowLeft, ArrowRight, RefreshCw, Grid, List, Search, HardDrive, Download, Music, Image, Video, FileText } from 'lucide-react'
import { categorizeFile, sortFiles } from '../ai/LocalAI'
import { useOSStore } from '../store'

// Windows names the video folder "Videos" and has no /Applications; everything
// else maps 1:1 between the two platforms.
const IS_WIN = typeof navigator !== 'undefined' && /win/i.test(navigator.userAgentData?.platform || navigator.platform || '')

const QUICK_ACCESS = [
  { label: 'Home', path: '~', icon: Home },
  { label: 'Desktop', path: '~/Desktop', icon: HardDrive },
  { label: 'Documents', path: '~/Documents', icon: FileText },
  { label: 'Downloads', path: '~/Downloads', icon: Download },
  { label: 'Music', path: '~/Music', icon: Music },
  { label: 'Pictures', path: '~/Pictures', icon: Image },
  IS_WIN
    ? { label: 'Videos', path: '~/Videos', icon: Video }
    : { label: 'Movies', path: '~/Movies', icon: Video },
  IS_WIN
    ? { label: 'This PC', path: 'C:\\', icon: Grid }
    : { label: 'Applications', path: '/Applications', icon: Grid },
]

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${(bytes / 1073741824).toFixed(2)} GB`
}

function formatDate(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function FileManager() {
  const [path, setPath] = useState('~')
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [history, setHistory] = useState(['~'])
  const [histIdx, setHistIdx] = useState(0)
  const [viewMode, setViewMode] = useState('grid') // 'grid' | 'list'
  const [sortBy, setSortBy] = useState('name-asc')
  const [search, setSearch] = useState('')
  const [contextMenu, setContextMenu] = useState(null)
  const [selected, setSelected] = useState(null)

  const navigate = useCallback(async (newPath) => {
    setLoading(true)
    setError(null)
    setSearch('')
    setSelected(null)
    try {
      if (window.nexus?.scanDirectory) {
        const result = await window.nexus.scanDirectory(newPath)
        if (result.error) { setError(result.error); setEntries([]) }
        else {
          const enriched = (result.entries || []).map((e) => ({
            ...e,
            ...( e.type === 'file' ? categorizeFile(e.name) : { icon: '📁', cat: 'folder' }),
          }))
          setEntries(enriched)
          setPath(result.resolvedPath || newPath)
        }
      } else {
        // Dev mode placeholder
        setEntries([
          { name: 'Documents', type: 'dir', size: 0, modified: Date.now(), icon: '📁', cat: 'folder' },
          { name: 'Downloads', type: 'dir', size: 0, modified: Date.now(), icon: '📁', cat: 'folder' },
          { name: 'example.pdf', type: 'file', size: 204800, modified: Date.now(), icon: '📄', cat: 'document' },
          { name: 'notes.txt', type: 'file', size: 1024, modified: Date.now(), icon: '📃', cat: 'text' },
          { name: 'photo.jpg', type: 'file', size: 2048000, modified: Date.now(), icon: '🖼️', cat: 'image' },
        ])
        setPath(newPath)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { navigate('~') }, [navigate])

  const goTo = (newPath) => {
    const newHist = history.slice(0, histIdx + 1).concat(newPath)
    setHistory(newHist)
    setHistIdx(newHist.length - 1)
    navigate(newPath)
  }

  const goBack = () => {
    if (histIdx > 0) { const idx = histIdx - 1; setHistIdx(idx); navigate(history[idx]) }
  }
  const goForward = () => {
    if (histIdx < history.length - 1) { const idx = histIdx + 1; setHistIdx(idx); navigate(history[idx]) }
  }

  const openEntry = (entry) => {
    if (entry.type === 'dir') goTo(`${path}/${entry.name}`)
    else setSelected(entry)
  }

  const filtered = sortFiles(
    search ? entries.filter((e) => e.name.toLowerCase().includes(search.toLowerCase())) : entries,
    sortBy
  )
  const dirs = filtered.filter((e) => e.type === 'dir')
  const files = filtered.filter((e) => e.type !== 'dir')
  const sorted = [...dirs, ...files]

  const breadcrumbs = path.replace(/^~/, 'Home').split('/').filter(Boolean)

  return (
    <div style={{ height: '100%', display: 'flex', background: '#0a0a14' }} onClick={() => setContextMenu(null)}>
      {/* Sidebar */}
      <div style={{ width: 180, borderRight: '1px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', background: 'rgba(0,0,0,0.3)', flexShrink: 0 }}>
        <div style={{ padding: '12px 10px 6px', color: 'var(--text-muted)', fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Quick Access</div>
        {QUICK_ACCESS.map((qa) => {
          const Icon = qa.icon
          return (
            <button
              key={qa.label}
              onClick={() => goTo(qa.path)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', background: path === qa.path ? 'rgba(109,40,217,0.25)' : 'none', border: 'none', color: path === qa.path ? 'var(--accent)' : 'var(--text-secondary)', cursor: 'pointer', textAlign: 'left', fontSize: 13, borderRadius: 6, margin: '1px 4px' }}
            >
              <Icon size={14} />
              {qa.label}
            </button>
          )
        })}
      </div>

      {/* Main pane */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.07)', background: 'rgba(0,0,0,0.2)' }}>
          <button onClick={goBack} disabled={histIdx === 0} style={navBtn(histIdx === 0)}><ArrowLeft size={14} /></button>
          <button onClick={goForward} disabled={histIdx >= history.length - 1} style={navBtn(histIdx >= history.length - 1)}><ArrowRight size={14} /></button>
          <button onClick={() => navigate(path)} style={navBtn(false)}><RefreshCw size={13} /></button>

          {/* Breadcrumbs */}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 2, overflow: 'hidden' }}>
            {breadcrumbs.map((crumb, i) => (
              <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                {i > 0 && <ChevronRight size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />}
                <span
                  onClick={() => goTo(breadcrumbs.slice(0, i + 1).join('/') || '~')}
                  style={{ color: i === breadcrumbs.length - 1 ? 'var(--text-primary)' : 'var(--text-muted)', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }}
                >
                  {crumb}
                </span>
              </span>
            ))}
          </div>

          {/* Search */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, padding: '4px 10px' }}>
            <Search size={13} style={{ color: 'var(--text-muted)' }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter..."
              style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: 13, width: 120 }}
            />
          </div>

          {/* Sort */}
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text-secondary)', borderRadius: 6, padding: '4px 6px', fontSize: 12 }}>
            <option value="name-asc">Name ↑</option>
            <option value="name-desc">Name ↓</option>
            <option value="size-desc">Size ↓</option>
            <option value="modified-desc">Date ↓</option>
          </select>

          {/* View toggle */}
          <button onClick={() => setViewMode('grid')} style={{ ...navBtn(false), background: viewMode === 'grid' ? 'rgba(109,40,217,0.3)' : undefined }}><Grid size={14} /></button>
          <button onClick={() => setViewMode('list')} style={{ ...navBtn(false), background: viewMode === 'list' ? 'rgba(109,40,217,0.3)' : undefined }}><List size={14} /></button>
        </div>

        {/* File area */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {loading && <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>Loading...</div>}
          {error && <div style={{ textAlign: 'center', padding: 40, color: '#f87171' }}>{error}</div>}
          {!loading && !error && sorted.length === 0 && <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>Empty folder</div>}

          {!loading && !error && viewMode === 'grid' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: 8 }}>
              {sorted.map((entry) => (
                <div
                  key={entry.name}
                  onDoubleClick={() => openEntry(entry)}
                  onClick={() => setSelected(entry)}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, entry }) }}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: 10,
                    borderRadius: 8, cursor: 'pointer', userSelect: 'none',
                    background: selected?.name === entry.name ? 'rgba(109,40,217,0.3)' : 'rgba(255,255,255,0.03)',
                    border: `1px solid ${selected?.name === entry.name ? 'rgba(109,40,217,0.5)' : 'transparent'}`,
                    transition: 'background 0.15s',
                  }}
                  title={entry.name}
                >
                  <span style={{ fontSize: 32 }}>{entry.icon}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)', textAlign: 'center', wordBreak: 'break-word', lineHeight: 1.3, maxWidth: '100%' }}>{entry.name}</span>
                </div>
              ))}
            </div>
          )}

          {!loading && !error && viewMode === 'list' && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ color: 'var(--text-muted)', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                  <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>Name</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Size</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Modified</th>
                  <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>Type</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((entry) => (
                  <tr
                    key={entry.name}
                    onDoubleClick={() => openEntry(entry)}
                    onClick={() => setSelected(entry)}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, entry }) }}
                    style={{
                      background: selected?.name === entry.name ? 'rgba(109,40,217,0.2)' : 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <td style={{ padding: '5px 8px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span>{entry.icon}</span> {entry.name}
                    </td>
                    <td style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--text-muted)' }}>{formatSize(entry.size)}</td>
                    <td style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--text-muted)' }}>{formatDate(entry.modified)}</td>
                    <td style={{ padding: '5px 8px', color: 'var(--text-muted)' }}>{entry.cat}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Status bar */}
        <div style={{ padding: '4px 16px', borderTop: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.2)', color: 'var(--text-muted)', fontSize: 11, display: 'flex', gap: 16 }}>
          <span>{sorted.length} items</span>
          <span>{dirs.length} folders, {files.length} files</span>
          {selected && <span>Selected: {selected.name} ({formatSize(selected.size)})</span>}
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div className="context-menu" style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 9999 }}>
          <div className="context-menu-item" onClick={() => {
            const e = contextMenu.entry
            if (e.type === 'dir') goTo(`${path}/${e.name}`)
            else useOSStore.getState().addNotification({ title: e.name, body: `${e.cat || 'File'} • ${formatSize(e.size)} — preview not yet supported`, type: 'info' })
            setContextMenu(null)
          }}>Open</div>
          <div className="context-menu-item" onClick={() => { navigator.clipboard?.writeText(contextMenu.entry.name); setContextMenu(null) }}>Copy Name</div>
          <div className="context-menu-separator" />
          <div className="context-menu-item" onClick={() => { navigator.clipboard?.writeText(`${path}/${contextMenu.entry.name}`); setContextMenu(null) }}>Copy Path</div>
          <div className="context-menu-item" onClick={() => {
            const e = contextMenu.entry
            useOSStore.getState().addNotification({
              title: `Info: ${e.name}`,
              body: `${e.type === 'dir' ? 'Folder' : e.cat || 'File'} • ${formatSize(e.size)} • Modified ${formatDate(e.modified)} • ${path}/${e.name}`,
              type: 'info',
            })
            setContextMenu(null)
          }}>Get Info</div>
        </div>
      )}
    </div>
  )
}

const navBtn = (disabled) => ({
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
  color: disabled ? 'rgba(255,255,255,0.25)' : 'var(--text-secondary)',
  cursor: disabled ? 'default' : 'pointer', padding: '5px 8px',
  borderRadius: 6, display: 'flex', alignItems: 'center',
})
