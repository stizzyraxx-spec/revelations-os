import { useState, useRef, useCallback, useEffect } from 'react'
import {
  Plus, X, RotateCcw, ArrowLeft, ArrowRight, Home, Bookmark, BookmarkCheck,
  Lock, Globe, Star, Download, Settings, Clock, Search, WifiOff,
  ZoomIn, ZoomOut, Volume2, EyeOff,
} from 'lucide-react'
import DownloadManager from './DownloadManager'
import HistoryPanel from './HistoryPanel'
import FindBar from './FindBar'

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Ephesians/1.0'
const BOOKMARKS_KEY = 'ephesians_bookmarks'
const HISTORY_KEY = 'ephesians_history'

const SEARCH_ENGINES = {
  google: 'https://www.google.com/search?q=',
  bing: 'https://www.bing.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  brave: 'https://search.brave.com/search?q=',
}

let tabCounter = 1

function newTab(url, isPrivate = false) {
  const id = tabCounter++
  return {
    id,
    url: url || getHomePage(),
    title: 'New Tab',
    loading: false,
    canBack: false,
    canForward: false,
    favicon: null,
    isPrivate,
    isAudible: false,
    error: null,
  }
}

function getHomePage() {
  return localStorage.getItem('ephesians_home') || 'https://www.google.com'
}

function loadBookmarks() {
  try { return JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || '[]') } catch { return [] }
}
function saveBookmarks(bm) { localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bm)) }

function addHistory(url, title) {
  try {
    const h = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
    h.unshift({ url, title, ts: Date.now() })
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 500)))
  } catch (_) {}
}

function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') } catch { return [] }
}

export default function EphesiansBrowser() {
  const [tabs, setTabs] = useState(() => [newTab()])
  const [activeTabId, setActiveTabId] = useState(() => 1)
  const [urlInput, setUrlInput] = useState(getHomePage())
  const [bookmarks, setBookmarks] = useState(loadBookmarks)
  const [showBookmarks, setShowBookmarks] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showDownloads, setShowDownloads] = useState(false)
  const [showFind, setShowFind] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [downloads, setDownloads] = useState([])
  const [zoomLevels, setZoomLevels] = useState({})
  const [urlSuggestions, setUrlSuggestions] = useState([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(-1)
  const [searchEngine, setSearchEngine] = useState(() => localStorage.getItem('ephesians_search_engine') || 'google')
  const [homePage, setHomePage] = useState(getHomePage)
  const [loadProgress, setLoadProgress] = useState({})

  const webviewRefs = useRef({})
  const urlInputRef = useRef(null)
  const progressTimers = useRef({})
  const suggestionsRef = useRef(null)

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0]
  const activeWebviewRef = useRef(null)

  // Keep activeWebviewRef in sync for FindBar
  useEffect(() => {
    activeWebviewRef.current = webviewRefs.current[activeTabId] || null
  }, [activeTabId, tabs])

  // Sync URL input when switching tabs
  useEffect(() => {
    setUrlInput(activeTab.url)
  }, [activeTabId, activeTab.url])

  // Apply zoom when active tab changes or zoom changes
  useEffect(() => {
    const wv = webviewRefs.current[activeTabId]
    const zoom = zoomLevels[activeTabId] || 1.0
    if (wv && typeof wv.setZoomFactor === 'function') {
      try { wv.setZoomFactor(zoom) } catch (_) {}
    }
  }, [activeTabId, zoomLevels])

  // Load initial downloads list from IPC
  useEffect(() => {
    if (window.nexus?.downloadList) {
      window.nexus.downloadList().then((list) => {
        if (Array.isArray(list)) setDownloads(list)
      }).catch(() => {})
    }

    const unsubUpdate = window.nexus?.onDownloadUpdate?.((dl) => {
      setDownloads((prev) => {
        const idx = prev.findIndex((d) => d.id === dl.id)
        if (idx === -1) return [...prev, dl]
        const next = [...prev]
        next[idx] = dl
        return next
      })
    })
    const unsubDone = window.nexus?.onDownloadDone?.((dl) => {
      setDownloads((prev) => {
        const idx = prev.findIndex((d) => d.id === dl.id)
        if (idx === -1) return [...prev, dl]
        const next = [...prev]
        next[idx] = dl
        return next
      })
    })

    return () => {
      unsubUpdate?.()
      unsubDone?.()
    }
  }, [])

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e) => {
      const ctrl = e.ctrlKey || e.metaKey

      if (ctrl && e.key === 't') { e.preventDefault(); addTab() }
      else if (ctrl && e.key === 'w') { e.preventDefault(); closeTab(activeTabId) }
      else if ((ctrl && e.key === 'r') || e.key === 'F5') { e.preventDefault(); reload() }
      else if (ctrl && e.key === 'l') { e.preventDefault(); urlInputRef.current?.focus(); urlInputRef.current?.select() }
      else if (ctrl && e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault()
        setTabs((prev) => {
          const idx = prev.findIndex((t) => t.id === activeTabId)
          const next = prev[(idx + 1) % prev.length]
          setActiveTabId(next.id)
          return prev
        })
      }
      else if (ctrl && e.key === 'Tab' && e.shiftKey) {
        e.preventDefault()
        setTabs((prev) => {
          const idx = prev.findIndex((t) => t.id === activeTabId)
          const prev2 = prev[(idx - 1 + prev.length) % prev.length]
          setActiveTabId(prev2.id)
          return prev
        })
      }
      else if (ctrl && e.key === 'f') { e.preventDefault(); setShowFind(true) }
      else if (ctrl && (e.key === '=' || e.key === '+')) { e.preventDefault(); adjustZoom(activeTabId, 0.1) }
      else if (ctrl && e.key === '-') { e.preventDefault(); adjustZoom(activeTabId, -0.1) }
      else if (ctrl && e.key === '0') { e.preventDefault(); setZoom(activeTabId, 1.0) }
      else if (ctrl && e.key === 'd') { e.preventDefault(); toggleBookmark() }
      else if (e.key === 'Escape') {
        if (showFind) { setShowFind(false) }
        else if (showSuggestions) { setShowSuggestions(false) }
        else { urlInputRef.current?.blur() }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeTabId, showFind, showSuggestions, tabs, bookmarks, activeTab])

  const updateTab = useCallback((id, patch) => {
    setTabs((prev) => prev.map((t) => t.id === id ? { ...t, ...patch } : t))
  }, [])

  const getWebview = (id) => webviewRefs.current[id]

  const resolveUrl = (raw) => {
    const trimmed = raw.trim()
    if (!trimmed) return getHomePage()
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
    if (trimmed.includes('.') && !trimmed.includes(' ')) return `https://${trimmed}`
    const base = SEARCH_ENGINES[searchEngine] || SEARCH_ENGINES.google
    return `${base}${encodeURIComponent(trimmed)}`
  }

  const navigate = (url) => {
    const resolved = resolveUrl(url)
    updateTab(activeTabId, { url: resolved, loading: true, error: null })
    const wv = getWebview(activeTabId)
    if (wv) wv.loadURL(resolved)
    setShowSuggestions(false)
  }

  const handleNavKey = (e) => {
    if (e.key === 'Enter') {
      if (activeSuggestion >= 0 && urlSuggestions[activeSuggestion]) {
        navigate(urlSuggestions[activeSuggestion].url)
      } else {
        navigate(urlInput)
      }
      e.target.blur()
      setShowSuggestions(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveSuggestion((v) => Math.min(v + 1, urlSuggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveSuggestion((v) => Math.max(v - 1, -1))
    } else if (e.key === 'Escape') {
      setShowSuggestions(false)
      e.target.blur()
    }
  }

  const handleUrlChange = (e) => {
    const val = e.target.value
    setUrlInput(val)
    setActiveSuggestion(-1)
    if (val.length >= 2) {
      const h = getHistory().slice(0, 500)
      const bm = loadBookmarks()
      const q = val.toLowerCase()
      const seen = new Set()
      const results = []
      for (const item of [...h, ...bm]) {
        const url = item.url || ''
        const title = item.title || ''
        if (!seen.has(url) && (url.toLowerCase().includes(q) || title.toLowerCase().includes(q))) {
          seen.add(url)
          results.push({ url, title })
          if (results.length >= 6) break
        }
      }
      setUrlSuggestions(results)
      setShowSuggestions(results.length > 0)
    } else {
      setUrlSuggestions([])
      setShowSuggestions(false)
    }
  }

  const addTab = (url, isPrivate = false) => {
    const t = newTab(url, isPrivate)
    setTabs((prev) => [...prev, t])
    setActiveTabId(t.id)
  }

  const closeTab = (id) => {
    if (tabs.length === 1) { setTabs([newTab()]); setActiveTabId(tabCounter - 1); return }
    const idx = tabs.findIndex((t) => t.id === id)
    const next = tabs[idx === 0 ? 1 : idx - 1]
    setTabs((prev) => prev.filter((t) => t.id !== id))
    if (id === activeTabId) setActiveTabId(next.id)
    delete webviewRefs.current[id]
  }

  const goBack = () => getWebview(activeTabId)?.goBack()
  const goForward = () => getWebview(activeTabId)?.goForward()
  const reload = () => {
    updateTab(activeTabId, { error: null })
    getWebview(activeTabId)?.reload()
  }

  const toggleBookmark = () => {
    const exists = bookmarks.find((b) => b.url === activeTab.url)
    if (exists) {
      const updated = bookmarks.filter((b) => b.url !== activeTab.url)
      setBookmarks(updated); saveBookmarks(updated)
    } else {
      const updated = [...bookmarks, { url: activeTab.url, title: activeTab.title || activeTab.url, ts: Date.now() }]
      setBookmarks(updated); saveBookmarks(updated)
    }
  }

  const adjustZoom = (tabId, delta) => {
    setZoomLevels((prev) => {
      const cur = prev[tabId] || 1.0
      const next = Math.min(3.0, Math.max(0.3, Math.round((cur + delta) * 10) / 10))
      const wv = webviewRefs.current[tabId]
      if (wv && typeof wv.setZoomFactor === 'function') {
        try { wv.setZoomFactor(next) } catch (_) {}
      }
      return { ...prev, [tabId]: next }
    })
  }

  const setZoom = (tabId, val) => {
    setZoomLevels((prev) => {
      const wv = webviewRefs.current[tabId]
      if (wv && typeof wv.setZoomFactor === 'function') {
        try { wv.setZoomFactor(val) } catch (_) {}
      }
      return { ...prev, [tabId]: val }
    })
  }

  const startProgress = (id) => {
    if (progressTimers.current[id]) clearTimeout(progressTimers.current[id])
    setLoadProgress((prev) => ({ ...prev, [id]: 15 }))
    progressTimers.current[id] = setTimeout(() => {
      setLoadProgress((prev) => ({ ...prev, [id]: 70 }))
    }, 100)
  }

  const finishProgress = (id) => {
    if (progressTimers.current[id]) clearTimeout(progressTimers.current[id])
    setLoadProgress((prev) => ({ ...prev, [id]: 100 }))
    progressTimers.current[id] = setTimeout(() => {
      setLoadProgress((prev) => ({ ...prev, [id]: 0 }))
    }, 300)
  }

  const setupWebviewListeners = (id, wv) => {
    if (!wv) return

    wv.addEventListener('did-start-loading', () => {
      updateTab(id, { loading: true, error: null })
      startProgress(id)
    })

    wv.addEventListener('did-stop-loading', () => {
      updateTab(id, { loading: false, canBack: wv.canGoBack(), canForward: wv.canGoForward(), isAudible: false })
      finishProgress(id)
    })

    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode !== -3) {
        updateTab(id, { error: { code: e.errorCode, description: e.errorDescription } })
      }
      finishProgress(id)
    })

    wv.addEventListener('page-title-updated', (e) => {
      updateTab(id, { title: e.title })
      const tab = webviewRefs.current[`tab_${id}`]
      if (!tab?.isPrivate && wv.getURL()) addHistory(wv.getURL(), e.title)
    })

    wv.addEventListener('did-navigate', (e) => {
      updateTab(id, { url: e.url, error: null })
      if (id === activeTabId) setUrlInput(e.url)
    })

    wv.addEventListener('did-navigate-in-page', (e) => {
      updateTab(id, { url: e.url })
      if (id === activeTabId) setUrlInput(e.url)
    })

    wv.addEventListener('new-window', (e) => { addTab(e.url) })

    wv.addEventListener('page-favicon-updated', (e) => {
      if (e.favicons?.[0]) updateTab(id, { favicon: e.favicons[0] })
    })

    wv.addEventListener('media-started-playing', () => {
      updateTab(id, { isAudible: true })
    })

    wv.addEventListener('media-paused', () => {
      updateTab(id, { isAudible: false })
    })
  }

  const isBookmarked = bookmarks.some((b) => b.url === activeTab.url)
  const isSecure = activeTab.url.startsWith('https://')
  const activeZoom = zoomLevels[activeTabId] || 1.0
  const activeProgress = loadProgress[activeTabId] || 0
  const hasActiveDownloads = downloads.some((d) => d.state === 'progressing')
  const hasDownloads = downloads.length > 0

  const saveSettings = () => {
    localStorage.setItem('ephesians_home', homePage)
    localStorage.setItem('ephesians_search_engine', searchEngine)
    setShowSettings(false)
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#09090f' }}>
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .eph-nav-btn {
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.08);
          color: var(--text-secondary);
          cursor: pointer;
          padding: 5px 8px;
          border-radius: 6px;
          display: flex;
          align-items: center;
          transition: background 0.15s;
          flex-shrink: 0;
        }
        .eph-nav-btn:hover:not(:disabled) { background: rgba(255,255,255,0.1); }
        .eph-nav-btn:disabled { color: rgba(255,255,255,0.2); cursor: default; }
        .eph-suggestion-item:hover { background: rgba(255,255,255,0.08) !important; }
      `}</style>

      {/* Tab bar */}
      <div style={{ display: 'flex', alignItems: 'center', background: 'rgba(0,0,0,0.4)', borderBottom: '1px solid rgba(255,255,255,0.07)', minHeight: 36, overflowX: 'auto' }}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => setActiveTabId(tab.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5, padding: '0 8px 0 10px',
              height: 36, minWidth: 120, maxWidth: 200, cursor: 'pointer', userSelect: 'none', flexShrink: 0,
              background: tab.id === activeTabId ? 'rgba(255,255,255,0.06)' : 'transparent',
              borderRight: '1px solid rgba(255,255,255,0.06)',
              borderBottom: tab.id === activeTabId ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >
            {tab.loading ? (
              <div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid var(--accent)', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
            ) : tab.favicon ? (
              <img src={tab.favicon} style={{ width: 14, height: 14, objectFit: 'contain', flexShrink: 0 }} onError={(e) => { e.target.style.display = 'none' }} />
            ) : (
              <Globe size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
            )}
            {tab.isPrivate && <EyeOff size={10} style={{ color: '#a78bfa', flexShrink: 0 }} />}
            {tab.isAudible && <Volume2 size={10} style={{ color: '#6ee7b7', flexShrink: 0 }} />}
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: tab.id === activeTabId ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              {tab.title || 'New Tab'}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2, display: 'flex', borderRadius: 3, flexShrink: 0 }}
            >
              <X size={11} />
            </button>
          </div>
        ))}

        <button onClick={() => addTab()} title="New Tab" style={{ padding: '0 10px', height: 36, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          <Plus size={14} />
        </button>
        <button onClick={() => addTab(undefined, true)} title="New Private Tab" style={{ padding: '0 8px', height: 36, background: 'none', border: 'none', color: '#a78bfa', cursor: 'pointer', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          <EyeOff size={13} />
        </button>
      </div>

      {/* Nav bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 8px', background: 'rgba(0,0,0,0.3)', borderBottom: '1px solid rgba(255,255,255,0.06)', position: 'relative' }}>
        {/* Back | Forward | Reload | Home */}
        <button className="eph-nav-btn" onClick={goBack} title="Back" disabled={!activeTab.canBack}><ArrowLeft size={14} /></button>
        <button className="eph-nav-btn" onClick={goForward} title="Forward" disabled={!activeTab.canForward}><ArrowRight size={14} /></button>
        <button className="eph-nav-btn" onClick={reload} title="Reload">
          {activeTab.loading ? <X size={13} /> : <RotateCcw size={13} />}
        </button>
        <button className="eph-nav-btn" onClick={() => navigate(homePage)} title="Home"><Home size={13} /></button>

        {/* URL bar */}
        <div style={{ flex: 1, position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '5px 10px' }}>
            {isSecure ? <Lock size={12} style={{ color: '#6ee7b7', flexShrink: 0 }} /> : <Globe size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />}
            <input
              ref={urlInputRef}
              value={urlInput}
              onChange={handleUrlChange}
              onKeyDown={handleNavKey}
              onFocus={(e) => { e.target.select(); if (urlSuggestions.length > 0) setShowSuggestions(true) }}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: 13, minWidth: 0 }}
            />
            {activeZoom !== 1.0 && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                {Math.round(activeZoom * 100)}%
              </span>
            )}
          </div>

          {/* URL Suggestions dropdown */}
          {showSuggestions && urlSuggestions.length > 0 && (
            <div
              ref={suggestionsRef}
              style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 9999,
                background: 'rgba(15,15,25,0.98)', backdropFilter: 'blur(16px)',
                border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8,
                boxShadow: '0 8px 32px rgba(0,0,0,0.6)', marginTop: 4, overflow: 'hidden',
              }}
            >
              {urlSuggestions.map((s, i) => (
                <div
                  key={s.url}
                  className="eph-suggestion-item"
                  onMouseDown={() => { navigate(s.url) }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px',
                    cursor: 'pointer', background: i === activeSuggestion ? 'rgba(255,255,255,0.08)' : 'transparent',
                  }}
                >
                  <Globe size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title || s.url}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.url}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Zoom- | Zoom+ */}
        <button className="eph-nav-btn" onClick={() => adjustZoom(activeTabId, -0.1)} title="Zoom Out"><ZoomOut size={13} /></button>
        <button className="eph-nav-btn" onClick={() => adjustZoom(activeTabId, 0.1)} title="Zoom In"><ZoomIn size={13} /></button>

        {/* Find */}
        <button className="eph-nav-btn" onClick={() => setShowFind((v) => !v)} title="Find in page" style={{ background: showFind ? 'rgba(109,40,217,0.3)' : undefined }}>
          <Search size={13} />
        </button>

        {/* History */}
        <button className="eph-nav-btn" onClick={() => { setShowHistory((v) => !v); setShowDownloads(false) }} title="History" style={{ background: showHistory ? 'rgba(109,40,217,0.3)' : undefined }}>
          <Clock size={13} />
        </button>

        {/* Downloads */}
        <button
          className="eph-nav-btn"
          onClick={() => { setShowDownloads((v) => !v); setShowHistory(false) }}
          title="Downloads"
          style={{ position: 'relative', background: showDownloads ? 'rgba(109,40,217,0.3)' : undefined }}
        >
          <Download size={13} />
          {hasDownloads && (
            <span style={{
              position: 'absolute', top: 3, right: 3, width: 6, height: 6,
              borderRadius: '50%', background: hasActiveDownloads ? '#3b82f6' : '#6b7280',
            }} />
          )}
        </button>

        {/* Bookmark */}
        <button
          className="eph-nav-btn"
          onClick={toggleBookmark}
          title={isBookmarked ? 'Remove bookmark' : 'Bookmark'}
          style={{ color: isBookmarked ? '#fbbf24' : 'var(--text-muted)' }}
        >
          {isBookmarked ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
        </button>

        {/* Bookmarks panel toggle */}
        <button
          className="eph-nav-btn"
          onClick={() => setShowBookmarks((v) => !v)}
          title="Bookmarks"
          style={{ background: showBookmarks ? 'rgba(109,40,217,0.3)' : undefined }}
        >
          <Star size={13} />
        </button>

        {/* Settings */}
        <button
          className="eph-nav-btn"
          onClick={() => setShowSettings(true)}
          title="Settings"
        >
          <Settings size={13} />
        </button>
      </div>

      {/* Progress bar */}
      {activeProgress > 0 && (
        <div style={{ height: 3, background: 'rgba(255,255,255,0.06)', flexShrink: 0 }}>
          <div style={{
            height: '100%',
            width: `${activeProgress}%`,
            background: 'var(--accent, #7c3aed)',
            transition: 'width 2s ease',
            borderRadius: '0 2px 2px 0',
          }} />
        </div>
      )}

      {/* Bookmarks panel */}
      {showBookmarks && (
        <div style={{ position: 'absolute', top: 76, right: 10, width: 280, zIndex: 9999, background: 'rgba(15,15,25,0.98)', backdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.6)', padding: 12 }}>
          <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8, fontSize: 13 }}>Bookmarks</div>
          {bookmarks.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 12, textAlign: 'center', padding: 12 }}>No bookmarks yet</div>}
          {bookmarks.map((b) => (
            <div key={b.url} onClick={() => { navigate(b.url); setShowBookmarks(false) }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 12 }}
              onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
              onMouseLeave={(e) => e.currentTarget.style.background = ''}
            >
              <Globe size={12} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.title}</span>
              <button onClick={(e) => {
                e.stopPropagation()
                const updated = bookmarks.filter((bk) => bk.url !== b.url)
                setBookmarks(updated); saveBookmarks(updated)
              }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2 }}><X size={10} /></button>
            </div>
          ))}
        </div>
      )}

      {/* Webview area */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/* FindBar */}
        {showFind && (
          <FindBar
            webviewRef={activeWebviewRef}
            onClose={() => setShowFind(false)}
          />
        )}

        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {tabs.map((tab) => (
            <div key={tab.id} style={{ position: 'absolute', inset: 0, display: tab.id === activeTabId ? 'flex' : 'none', flexDirection: 'column' }}>
              <webview
                ref={(wv) => {
                  if (wv && webviewRefs.current[tab.id] !== wv) {
                    webviewRefs.current[tab.id] = wv
                    webviewRefs.current[`tab_${tab.id}`] = tab
                    setupWebviewListeners(tab.id, wv)
                  } else if (!wv) {
                    delete webviewRefs.current[tab.id]
                    delete webviewRefs.current[`tab_${tab.id}`]
                  }
                }}
                src={tab.url}
                partition={tab.isPrivate ? 'ephesians-private' : 'persist:ephesians'}
                useragent={USER_AGENT}
                style={{
                  flex: 1,
                  width: '100%',
                  border: 'none',
                  display: tab.error ? 'none' : 'flex',
                }}
                webpreferences="allowRunningInsecureContent=no, contextIsolation=yes"
              />

              {/* Error overlay */}
              {tab.id === activeTabId && tab.error && (
                <div style={{
                  flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  background: '#09090f', color: 'var(--text-primary)', gap: 16, padding: 40,
                }}>
                  <WifiOff size={56} style={{ color: 'rgba(255,255,255,0.2)' }} />
                  <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>Can't reach this page</div>
                  <div style={{ fontSize: 14, color: 'var(--text-muted)', textAlign: 'center', maxWidth: 400 }}>
                    {tab.error.description || `Error code: ${tab.error.code}`}
                  </div>
                  <button
                    onClick={reload}
                    style={{
                      marginTop: 8, padding: '9px 24px', borderRadius: 8, border: 'none',
                      background: 'var(--accent, #7c3aed)', color: '#fff', fontSize: 14,
                      fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    Try Again
                  </button>
                </div>
              )}
            </div>
          ))}

          {/* History Panel */}
          {showHistory && (
            <div style={{ position: 'absolute', top: 0, right: 0, width: 320, height: '100%', zIndex: 500 }}>
              <HistoryPanel
                onNavigate={(url) => { navigate(url) }}
                onClose={() => setShowHistory(false)}
              />
            </div>
          )}

          {/* Downloads Panel */}
          {showDownloads && (
            <div style={{ position: 'absolute', top: 0, right: 0, width: 320, height: '100%', zIndex: 500, background: 'rgba(15,15,25,0.98)', backdropFilter: 'blur(16px)', borderLeft: '1px solid rgba(255,255,255,0.1)' }}>
              <DownloadManager
                downloads={downloads}
                onOpen={(dl) => window.nexus?.downloadOpen?.(dl.savePath)}
                onReveal={(dl) => window.nexus?.downloadReveal?.(dl.savePath)}
                onClear={() => {
                  window.nexus?.downloadClear?.()
                  setDownloads([])
                }}
                onClose={() => setShowDownloads(false)}
              />
            </div>
          )}
        </div>
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowSettings(false) }}
        >
          <div style={{
            background: 'rgba(15,15,25,0.99)', backdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,255,255,0.12)', borderRadius: 14,
            padding: 28, width: 380, boxShadow: '0 24px 64px rgba(0,0,0,0.8)',
            display: 'flex', flexDirection: 'column', gap: 20,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Browser Settings</span>
              <button onClick={() => setShowSettings(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4, display: 'flex' }}><X size={16} /></button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Homepage URL</label>
              <input
                value={homePage}
                onChange={(e) => setHomePage(e.target.value)}
                placeholder="https://www.google.com"
                style={{
                  background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 8, padding: '8px 12px', color: 'var(--text-primary)', fontSize: 13, outline: 'none',
                }}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Search Engine</label>
              <select
                value={searchEngine}
                onChange={(e) => setSearchEngine(e.target.value)}
                style={{
                  background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 8, padding: '8px 12px', color: 'var(--text-primary)', fontSize: 13, outline: 'none', cursor: 'pointer',
                }}
              >
                <option value="google">Google</option>
                <option value="bing">Bing</option>
                <option value="duckduckgo">DuckDuckGo</option>
                <option value="brave">Brave Search</option>
              </select>
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => { localStorage.removeItem(HISTORY_KEY); alert('History cleared.') }}
                style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: '1px solid rgba(239,68,68,0.4)', background: 'rgba(239,68,68,0.1)', color: '#f87171', fontSize: 13, cursor: 'pointer', fontWeight: 600 }}
              >
                Clear History
              </button>
              <button
                onClick={() => { setBookmarks([]); saveBookmarks([]); alert('Bookmarks cleared.') }}
                style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: '1px solid rgba(239,68,68,0.4)', background: 'rgba(239,68,68,0.1)', color: '#f87171', fontSize: 13, cursor: 'pointer', fontWeight: 600 }}
              >
                Clear Bookmarks
              </button>
            </div>

            <button
              onClick={saveSettings}
              style={{
                padding: '10px 0', borderRadius: 8, border: 'none',
                background: 'var(--accent, #7c3aed)', color: '#fff', fontSize: 14,
                fontWeight: 700, cursor: 'pointer',
              }}
            >
              Save Settings
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
