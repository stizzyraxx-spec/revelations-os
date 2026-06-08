import { useState, useCallback, useRef, useEffect } from 'react'
import { Plus, X, Save, FileText, Download } from 'lucide-react'

const STORAGE_KEY = 'revos_notepad_tabs'

function loadTabs() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    if (saved?.length) return saved
  } catch (_) {}
  return [{ id: 1, title: 'Untitled', content: '', modified: false }]
}

export default function Notepad() {
  const [tabs, setTabs] = useState(loadTabs)
  const [activeId, setActiveId] = useState(() => loadTabs()[0]?.id || 1)
  const [nextId, setNextId] = useState(100)
  const [wordWrap, setWordWrap] = useState(true)
  const [fontSize, setFontSize] = useState(14)
  const [showFind, setShowFind] = useState(false)
  const [findText, setFindText] = useState('')
  const textareaRef = useRef(null)

  const active = tabs.find((t) => t.id === activeId) || tabs[0]

  // Autosave on change
  useEffect(() => {
    const t = setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs.map((t) => ({ ...t, modified: false }))))
    }, 800)
    return () => clearTimeout(t)
  }, [tabs])

  const updateContent = useCallback((content) => {
    setTabs((prev) => prev.map((t) => t.id === activeId ? { ...t, content, modified: true } : t))
  }, [activeId])

  const newTab = () => {
    const id = nextId
    setNextId((n) => n + 1)
    setTabs((prev) => [...prev, { id, title: `Untitled ${id}`, content: '', modified: false }])
    setActiveId(id)
  }

  const closeTab = (id) => {
    if (tabs.length === 1) {
      setTabs([{ id: 1, title: 'Untitled', content: '', modified: false }])
      setActiveId(1)
      return
    }
    const idx = tabs.findIndex((t) => t.id === id)
    const newTabs = tabs.filter((t) => t.id !== id)
    setTabs(newTabs)
    if (id === activeId) setActiveId(newTabs[Math.max(0, idx - 1)]?.id || newTabs[0].id)
  }

  const renameTab = (id, newTitle) => {
    setTabs((prev) => prev.map((t) => t.id === id ? { ...t, title: newTitle } : t))
  }

  const saveAsFile = () => {
    const blob = new Blob([active.content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${active.title}.txt`
    a.click()
    URL.revokeObjectURL(url)
    setTabs((prev) => prev.map((t) => t.id === activeId ? { ...t, modified: false } : t))
  }

  const handleKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveAsFile() }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); setShowFind((v) => !v) }
    if ((e.ctrlKey || e.metaKey) && e.key === 't') { e.preventDefault(); newTab() }
    // Tab key inserts spaces
    if (e.key === 'Tab') {
      e.preventDefault()
      const ta = textareaRef.current
      const start = ta.selectionStart, end = ta.selectionEnd
      const newContent = active.content.slice(0, start) + '  ' + active.content.slice(end)
      updateContent(newContent)
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = start + 2 })
    }
  }

  const stats = { chars: active.content.length, words: active.content.trim() ? active.content.trim().split(/\s+/).length : 0, lines: active.content.split('\n').length }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0f0f1a' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'rgba(0,0,0,0.3)' }}>
        <button onClick={newTab} title="New tab (Ctrl+T)" style={btnSt}><Plus size={14} /></button>
        <button onClick={saveAsFile} title="Save (Ctrl+S)" style={btnSt}><Download size={14} /></button>
        <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.15)' }} />
        <label style={{ color: 'var(--text-muted)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input type="checkbox" checked={wordWrap} onChange={(e) => setWordWrap(e.target.checked)} />
          Wrap
        </label>
        <label style={{ color: 'var(--text-muted)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
          Size:
          <select value={fontSize} onChange={(e) => setFontSize(+e.target.value)} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', color: 'var(--text-primary)', borderRadius: 4, padding: '1px 4px', fontSize: 12 }}>
            {[11,12,13,14,16,18,20,24].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <button onClick={() => setShowFind((v) => !v)} style={btnSt}>Find</button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', alignItems: 'center', overflowX: 'auto', background: 'rgba(0,0,0,0.2)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => setActiveId(tab.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
              cursor: 'pointer', userSelect: 'none', flexShrink: 0,
              borderRight: '1px solid rgba(255,255,255,0.06)',
              background: tab.id === activeId ? 'rgba(109,40,217,0.25)' : 'transparent',
              color: tab.id === activeId ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: tab.id === activeId ? '2px solid var(--accent)' : '2px solid transparent',
              fontSize: 13,
            }}
          >
            <FileText size={12} />
            <span
              contentEditable suppressContentEditableWarning
              onBlur={(e) => renameTab(tab.id, e.target.textContent)}
              style={{ outline: 'none', minWidth: 60, maxWidth: 120 }}
            >
              {tab.title}
            </span>
            {tab.modified && <span style={{ color: 'var(--accent)', fontSize: 10 }}>●</span>}
            <button
              onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2, display: 'flex' }}
            >
              <X size={11} />
            </button>
          </div>
        ))}
      </div>

      {/* Find bar */}
      {showFind && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: 'rgba(109,40,217,0.1)', borderBottom: '1px solid rgba(109,40,217,0.3)' }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Find:</span>
          <input
            autoFocus
            value={findText}
            onChange={(e) => setFindText(e.target.value)}
            style={{ flex: 1, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4, padding: '3px 8px', color: 'var(--text-primary)', fontSize: 13, outline: 'none' }}
            placeholder="Search text..."
            onKeyDown={(e) => { if (e.key === 'Escape') setShowFind(false) }}
          />
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            {findText ? (active.content.split(findText).length - 1) : 0} matches
          </span>
          <button onClick={() => setShowFind(false)} style={btnSt}><X size={12} /></button>
        </div>
      )}

      {/* Editor */}
      <textarea
        ref={textareaRef}
        value={active.content}
        onChange={(e) => updateContent(e.target.value)}
        onKeyDown={handleKeyDown}
        spellCheck={false}
        style={{
          flex: 1, resize: 'none', background: 'transparent', border: 'none', outline: 'none',
          color: '#e2e8f0', fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontSize, padding: '16px 20px', lineHeight: 1.7,
          whiteSpace: wordWrap ? 'pre-wrap' : 'pre', overflowX: wordWrap ? 'hidden' : 'auto',
        }}
        placeholder="Start typing... (Ctrl+S save, Ctrl+T new tab, Ctrl+F find)"
      />

      {/* Status bar */}
      <div style={{ display: 'flex', gap: 16, padding: '3px 12px', borderTop: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.3)', color: 'var(--text-muted)', fontSize: 11 }}>
        <span>Ln {active.content.slice(0, textareaRef.current?.selectionStart || 0).split('\n').length}</span>
        <span>Words: {stats.words}</span>
        <span>Chars: {stats.chars}</span>
        <span>Lines: {stats.lines}</span>
        {active.modified && <span style={{ color: '#fbbf24' }}>● Unsaved</span>}
      </div>
    </div>
  )
}

const btnSt = {
  background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.1)',
  color: 'var(--text-secondary)', cursor: 'pointer', padding: '4px 8px',
  borderRadius: 6, display: 'flex', alignItems: 'center', gap: 4, fontSize: 12,
}
