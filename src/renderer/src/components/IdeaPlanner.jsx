import { useState, useEffect, useRef, useCallback } from 'react'
import { Plus, Trash2, Save, Lightbulb, Link2, Download } from 'lucide-react'

const STORAGE_KEY = 'revelations_ideaplanner_board'
const NODE_COLORS = ['#b45309', '#7c3aed', '#0ea5e9', '#10b981', '#ec4899', '#f59e0b']

const loadBoard = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore corrupt board */ }
  return { nodes: [], nextId: 1 }
}

export default function IdeaPlanner() {
  const [board, setBoard] = useState(loadBoard)
  const [selectedId, setSelectedId] = useState(null)
  const [linkFrom, setLinkFrom] = useState(null)
  const canvasRef = useRef(null)
  const dragRef = useRef(null)

  // Persist on every change
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(board)) } catch { /* quota */ }
  }, [board])

  const addNode = useCallback(() => {
    setBoard(b => {
      const id = b.nextId
      const color = NODE_COLORS[(id - 1) % NODE_COLORS.length]
      const node = {
        id,
        text: 'New idea',
        x: 60 + ((id * 40) % 320),
        y: 60 + ((id * 30) % 220),
        color,
        links: [],
      }
      return { nodes: [...b.nodes, node], nextId: id + 1 }
    })
  }, [])

  const updateNode = (id, patch) =>
    setBoard(b => ({ ...b, nodes: b.nodes.map(n => n.id === id ? { ...n, ...patch } : n) }))

  const deleteNode = (id) =>
    setBoard(b => ({
      ...b,
      nodes: b.nodes
        .filter(n => n.id !== id)
        .map(n => ({ ...n, links: n.links.filter(l => l !== id) })),
    }))

  const toggleLink = (targetId) => {
    if (linkFrom == null) return
    if (linkFrom === targetId) { setLinkFrom(null); return }
    setBoard(b => ({
      ...b,
      nodes: b.nodes.map(n => {
        if (n.id !== linkFrom) return n
        const has = n.links.includes(targetId)
        return { ...n, links: has ? n.links.filter(l => l !== targetId) : [...n.links, targetId] }
      }),
    }))
    setLinkFrom(null)
  }

  const onPointerDown = (e, node) => {
    if (linkFrom != null) { toggleLink(node.id); return }
    setSelectedId(node.id)
    const rect = canvasRef.current.getBoundingClientRect()
    dragRef.current = { id: node.id, offX: e.clientX - rect.left - node.x, offY: e.clientY - rect.top - node.y }
  }

  const onPointerMove = (e) => {
    if (!dragRef.current) return
    const rect = canvasRef.current.getBoundingClientRect()
    const x = Math.max(0, e.clientX - rect.left - dragRef.current.offX)
    const y = Math.max(0, e.clientY - rect.top - dragRef.current.offY)
    updateNode(dragRef.current.id, { x, y })
  }

  const onPointerUp = () => { dragRef.current = null }

  const exportBoard = () => {
    const lines = board.nodes.map(n => {
      const linked = n.links
        .map(id => board.nodes.find(x => x.id === id)?.text)
        .filter(Boolean)
      return `• ${n.text}${linked.length ? ` → ${linked.join(', ')}` : ''}`
    })
    const blob = new Blob([`IdeaPlanner Board\n\n${lines.join('\n')}\n`], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'ideaplanner-board.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  const clearBoard = () => {
    if (board.nodes.length && !window.confirm('Clear the entire board?')) return
    setBoard({ nodes: [], nextId: 1 })
    setSelectedId(null)
    setLinkFrom(null)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'rgba(0,0,0,0.2)' }}>
        <Lightbulb size={18} color="#b45309" />
        <span style={{ fontWeight: 700, fontSize: '0.95rem', marginRight: 'auto' }}>IdeaPlanner</span>
        <ToolBtn onClick={addNode} icon={Plus} label="Add idea" />
        <ToolBtn
          onClick={() => { if (selectedId != null) setLinkFrom(f => f === selectedId ? null : selectedId) }}
          icon={Link2}
          label={linkFrom != null ? 'Pick target…' : 'Link'}
          active={linkFrom != null}
          disabled={selectedId == null}
        />
        <ToolBtn onClick={exportBoard} icon={Download} label="Export" disabled={!board.nodes.length} />
        <ToolBtn onClick={clearBoard} icon={Trash2} label="Clear" />
      </div>

      {/* Canvas */}
      <div
        ref={canvasRef}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onClick={(e) => { if (e.target === canvasRef.current) { setSelectedId(null); setLinkFrom(null) } }}
        style={{
          position: 'relative', flex: 1, overflow: 'auto',
          backgroundImage: 'radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
          cursor: linkFrom != null ? 'crosshair' : 'default',
        }}
      >
        {/* Link lines */}
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
          {board.nodes.flatMap(n =>
            n.links.map(targetId => {
              const t = board.nodes.find(x => x.id === targetId)
              if (!t) return null
              return (
                <line
                  key={`${n.id}-${targetId}`}
                  x1={n.x + 80} y1={n.y + 28} x2={t.x + 80} y2={t.y + 28}
                  stroke="rgba(124,58,237,0.5)" strokeWidth="2"
                />
              )
            })
          )}
        </svg>

        {board.nodes.length === 0 && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--text-muted)', pointerEvents: 'none' }}>
            <Lightbulb size={40} color="#b45309" />
            <div style={{ fontSize: '0.9rem' }}>Click “Add idea” to start mapping your thoughts</div>
          </div>
        )}

        {/* Nodes */}
        {board.nodes.map(node => (
          <div
            key={node.id}
            onPointerDown={(e) => onPointerDown(e, node)}
            style={{
              position: 'absolute', left: node.x, top: node.y, width: 160,
              background: 'rgba(10,10,20,0.95)',
              border: `2px solid ${node.id === selectedId ? '#fff' : node.color}`,
              borderRadius: 12, padding: 10, boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
              cursor: dragRef.current ? 'grabbing' : 'grab', userSelect: 'none',
              outline: linkFrom != null && linkFrom !== node.id ? '2px dashed rgba(255,255,255,0.4)' : 'none',
            }}
          >
            <div style={{ height: 4, borderRadius: 4, background: node.color, marginBottom: 8 }} />
            <textarea
              value={node.text}
              onChange={(e) => updateNode(node.id, { text: e.target.value })}
              onPointerDown={(e) => e.stopPropagation()}
              rows={2}
              style={{
                width: '100%', resize: 'none', background: 'transparent', border: 'none',
                color: 'var(--text-primary)', fontSize: '0.8rem', outline: 'none', fontFamily: 'inherit',
              }}
            />
            <button
              onClick={(e) => { e.stopPropagation(); deleteNode(node.id) }}
              onPointerDown={(e) => e.stopPropagation()}
              title="Delete"
              style={{ position: 'absolute', top: 6, right: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2, display: 'flex' }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function ToolBtn({ onClick, icon: Icon, label, active, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      style={{
        display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px', borderRadius: 8,
        fontSize: '0.74rem', fontWeight: 500, cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        background: active ? 'var(--accent)' : 'rgba(255,255,255,0.06)',
        color: active ? '#fff' : 'var(--text-secondary)',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        transition: 'var(--transition)',
      }}
    >
      <Icon size={14} />
      {label}
    </button>
  )
}
