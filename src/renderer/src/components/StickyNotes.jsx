import { useState, useRef, useCallback } from 'react'
import { Plus, Trash2, X } from 'lucide-react'

const STORAGE = 'revos_sticky_notes'
const COLORS = [
  { bg: '#fef08a', border: '#eab308', text: '#78350f' },
  { bg: '#bbf7d0', border: '#22c55e', text: '#14532d' },
  { bg: '#bfdbfe', border: '#3b82f6', text: '#1e3a8a' },
  { bg: '#fecaca', border: '#ef4444', text: '#7f1d1d' },
  { bg: '#e9d5ff', border: '#a855f7', text: '#3b0764' },
  { bg: '#fed7aa', border: '#f97316', text: '#7c2d12' },
]

const load = () => { try { return JSON.parse(localStorage.getItem(STORAGE)) || [] } catch { return [] } }
const save = (notes) => localStorage.setItem(STORAGE, JSON.stringify(notes))

let gId = Date.now()
const uid = () => ++gId

export default function StickyNotes() {
  const [notes, setNotes] = useState(load)
  const [dragging, setDragging] = useState(null)
  const dragOffset = useRef({ x: 0, y: 0 })
  const containerRef = useRef(null)

  const update = (list) => { setNotes(list); save(list) }

  const addNote = () => {
    const color = COLORS[notes.length % COLORS.length]
    const id = uid()
    const x = 40 + (notes.length % 5) * 24
    const y = 40 + (notes.length % 4) * 24
    update([...notes, { id, text: '', color, x, y, w: 200, h: 200, zIndex: uid() }])
  }

  const del = (id) => update(notes.filter(n => n.id !== id))

  const setText = (id, text) => {
    const list = notes.map(n => n.id === id ? { ...n, text } : n)
    update(list)
  }

  const setColor = (id, color) => update(notes.map(n => n.id === id ? { ...n, color } : n))

  const bringFront = (id) => update(notes.map(n => n.id === id ? { ...n, zIndex: uid() } : n))

  const onMouseDown = useCallback((e, id) => {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'BUTTON' || e.target.closest('button')) return
    e.preventDefault()
    const note = notes.find(n => n.id === id)
    if (!note) return
    dragOffset.current = { x: e.clientX - note.x, y: e.clientY - note.y }
    setDragging(id)
    bringFront(id)

    const onMove = (me) => {
      const cont = containerRef.current
      if (!cont) return
      const rect = cont.getBoundingClientRect()
      const nx = Math.max(0, Math.min(me.clientX - dragOffset.current.x, rect.width - 200))
      const ny = Math.max(0, Math.min(me.clientY - dragOffset.current.y, rect.height - 200))
      setNotes(prev => prev.map(n => n.id === id ? { ...n, x: nx, y: ny } : n))
    }
    const onUp = () => {
      setDragging(null)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setNotes(prev => { save(prev); return prev })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [notes])

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%', height: '100%', background: '#1a1a2e', overflow: 'hidden' }}>
      {/* Toolbar */}
      <div style={{
        position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', alignItems: 'center', gap: 8, zIndex: 9999,
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(12px)',
        border: '1px solid rgba(255,255,255,0.1)', borderRadius: 24, padding: '6px 14px',
      }}>
        <span style={{ fontSize: '0.75rem', color: '#888', marginRight: 4 }}>Sticky Notes</span>
        <button onClick={addNote} style={{
          background: '#7c3aed', border: 'none', borderRadius: 20, padding: '5px 12px',
          cursor: 'pointer', color: '#fff', display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.78rem', fontWeight: 600,
        }}>
          <Plus size={13} /> New Note
        </button>
        <span style={{ fontSize: '0.7rem', color: '#555' }}>{notes.length} note{notes.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Empty state */}
      {notes.length === 0 && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, pointerEvents: 'none' }}>
          <div style={{ fontSize: 48, opacity: 0.15 }}>📝</div>
          <div style={{ color: 'rgba(255,255,255,0.2)', fontSize: '0.88rem' }}>Click "New Note" to add a sticky</div>
        </div>
      )}

      {/* Notes */}
      {[...notes].sort((a, b) => a.zIndex - b.zIndex).map(note => (
        <div
          key={note.id}
          onMouseDown={(e) => onMouseDown(e, note.id)}
          onClick={() => bringFront(note.id)}
          style={{
            position: 'absolute',
            left: note.x, top: note.y,
            width: note.w, minHeight: note.h,
            background: note.color.bg,
            border: `1px solid ${note.color.border}`,
            borderRadius: 4,
            boxShadow: dragging === note.id
              ? '0 12px 40px rgba(0,0,0,0.5)'
              : '0 4px 16px rgba(0,0,0,0.3), 2px 2px 0 rgba(0,0,0,0.08)',
            zIndex: note.zIndex,
            display: 'flex', flexDirection: 'column',
            cursor: 'grab',
            userSelect: dragging === note.id ? 'none' : 'auto',
            transform: dragging === note.id ? 'rotate(1deg) scale(1.02)' : 'rotate(0deg) scale(1)',
            transition: dragging === note.id ? 'none' : 'box-shadow 0.2s, transform 0.15s',
          }}
        >
          {/* Header bar */}
          <div style={{
            height: 28, background: note.color.border + '44',
            borderRadius: '3px 3px 0 0', display: 'flex', alignItems: 'center',
            padding: '0 6px 0 8px', gap: 4, flexShrink: 0,
          }}>
            {/* Color swatches */}
            {COLORS.map((c, i) => (
              <div key={i} onClick={(e) => { e.stopPropagation(); setColor(note.id, c) }}
                style={{
                  width: 10, height: 10, borderRadius: '50%', background: c.border, cursor: 'pointer',
                  border: note.color.border === c.border ? '2px solid rgba(0,0,0,0.5)' : '1px solid rgba(0,0,0,0.15)',
                  flexShrink: 0,
                }}
              />
            ))}
            <div style={{ flex: 1 }} />
            <button onClick={(e) => { e.stopPropagation(); del(note.id) }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: note.color.text, opacity: 0.6, padding: 2, display: 'flex', alignItems: 'center' }}
              onMouseEnter={e => e.currentTarget.style.opacity = '1'}
              onMouseLeave={e => e.currentTarget.style.opacity = '0.6'}
            >
              <X size={12} />
            </button>
          </div>

          {/* Text area */}
          <textarea
            value={note.text}
            onChange={(e) => setText(note.id, e.target.value)}
            placeholder="Type your note..."
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              flex: 1, resize: 'none', border: 'none', background: 'transparent',
              padding: '8px 10px', color: note.color.text, fontSize: '0.82rem',
              lineHeight: 1.6, outline: 'none', fontFamily: 'inherit', minHeight: 140,
              cursor: 'text',
            }}
          />

          {/* Resize handle */}
          <div
            onMouseDown={(e) => {
              e.preventDefault(); e.stopPropagation()
              const startX = e.clientX, startY = e.clientY
              const startW = note.w, startH = note.h
              const onMove = (me) => {
                setNotes(prev => prev.map(n => n.id === note.id
                  ? { ...n, w: Math.max(160, startW + me.clientX - startX), h: Math.max(140, startH + me.clientY - startY) }
                  : n
                ))
              }
              const onUp = () => {
                document.removeEventListener('mousemove', onMove)
                document.removeEventListener('mouseup', onUp)
                setNotes(prev => { save(prev); return prev })
              }
              document.addEventListener('mousemove', onMove)
              document.addEventListener('mouseup', onUp)
            }}
            style={{
              position: 'absolute', bottom: 0, right: 0, width: 14, height: 14,
              cursor: 'se-resize',
              background: `linear-gradient(135deg, transparent 50%, ${note.color.border}88 50%)`,
              borderRadius: '0 0 3px 0',
            }}
          />
        </div>
      ))}
    </div>
  )
}
