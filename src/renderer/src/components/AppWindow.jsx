import { useRef, useState, useCallback } from 'react'
import { useOSStore } from '../store'
import { TASKBAR_HEIGHT } from './BottomTaskbar'

export default function AppWindow({ win, ContentComponent }) {
  const { closeWindow, minimizeWindow, focusWindow, moveWindow, resizeWindow, setBounds } = useOSStore()
  const [maximized, setMaximized] = useState(false)
  const [preMaxState, setPreMaxState] = useState(null)
  const [contextMenu, setContextMenu] = useState(null)
  const dragRef = useRef(null)
  const resizeRef = useRef(null)

  const DOCK_W = 0   // dock auto-hides, windows use full width
  const TAB_W  = 0   // tab auto-hides, windows use full width

  const handleTitleMouseDown = useCallback((e) => {
    if (e.target.closest('[data-no-drag]')) return
    if (maximized) return
    e.preventDefault()
    focusWindow(win.id)
    const startX = e.clientX - win.x
    const startY = e.clientY - win.y
    const onMove = (me) => {
      const nx = Math.max(DOCK_W, Math.min(me.clientX - startX, window.innerWidth - TAB_W - win.width))
      const ny = Math.max(40, Math.min(me.clientY - startY, window.innerHeight - 60))
      moveWindow(win.id, nx, ny)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [win, maximized, focusWindow, moveWindow])

  // Resize from any edge or corner. `dir` is a compass string (n/s/e/w/ne/…).
  // Dragging the north or west edge moves x/y as well as sizing, so we compute
  // the full bounds and commit them atomically via setBounds.
  const startResize = useCallback((e, dir) => {
    e.preventDefault(); e.stopPropagation()
    if (maximized) return
    focusWindow(win.id)
    const startX = e.clientX, startY = e.clientY
    const ox = win.x, oy = win.y, ow = win.width, oh = win.height
    const MIN_W = 320, MIN_H = 200
    const onMove = (me) => {
      const dx = me.clientX - startX
      const dy = me.clientY - startY
      let x = ox, y = oy, width = ow, height = oh
      if (dir.includes('e')) width = ow + dx
      if (dir.includes('s')) height = oh + dy
      if (dir.includes('w')) { width = ow - dx; x = ox + dx }
      if (dir.includes('n')) { height = oh - dy; y = oy + dy }
      // Honour minimums while keeping the anchored (opposite) edge fixed.
      if (width < MIN_W) { if (dir.includes('w')) x = ox + (ow - MIN_W); width = MIN_W }
      if (height < MIN_H) { if (dir.includes('n')) y = oy + (oh - MIN_H); height = MIN_H }
      setBounds(win.id, { x, y, width, height })
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [win, maximized, focusWindow, setBounds])

  const toggleMax = () => {
    if (maximized) {
      moveWindow(win.id, preMaxState.x, preMaxState.y)
      resizeWindow(win.id, preMaxState.width, preMaxState.height)
      setMaximized(false)
    } else {
      setPreMaxState({ x: win.x, y: win.y, width: win.width, height: win.height })
      moveWindow(win.id, DOCK_W, 40)
      resizeWindow(win.id, window.innerWidth - DOCK_W - TAB_W, window.innerHeight - 40 - TASKBAR_HEIGHT)
      setMaximized(true)
    }
    focusWindow(win.id)
  }

  const handleContextMenu = (e) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  const style = maximized
    ? { position:'fixed', top:40, left:DOCK_W, width:`calc(100vw - ${DOCK_W + TAB_W}px)`, height:`calc(100vh - ${40 + TASKBAR_HEIGHT}px)`, zIndex: win.zIndex }
    : { position:'absolute', top: win.y, left: win.x, width: win.width, height: win.height, zIndex: win.zIndex }

  return (
    <div
      style={{
        ...style,
        display:'flex', flexDirection:'column',
        borderRadius: maximized ? 0 : 16,
        overflow:'hidden',
        background:'var(--bg-glass-strong)',
        backdropFilter:'var(--blur-heavy)',
        WebkitBackdropFilter:'var(--blur-heavy)',
        border: `1px solid ${win.focused ? 'var(--border-accent)' : 'var(--border)'}`,
        boxShadow: win.focused ? 'var(--shadow-lg), var(--shadow-glow)' : '0 8px 32px rgba(0,0,0,0.6)',
        pointerEvents:'all',
        transition:'box-shadow 0.2s, border-color 0.2s',
      }}
      className="animate-scale-in"
      onClick={() => focusWindow(win.id)}
      onContextMenu={handleContextMenu}
    >
      {/* Title bar */}
      <div
        onMouseDown={handleTitleMouseDown}
        style={{
          height:36, display:'flex', alignItems:'center', padding:'0 12px',
          background: win.focused ? 'linear-gradient(180deg, rgba(255,255,255,0.06), var(--bg-tertiary))' : 'var(--bg-tertiary)',
          borderBottom:'1px solid var(--border)',
          cursor: 'default',
          userSelect:'none', flexShrink:0,
        }}
      >
        {/* Window controls — bright red close / yellow minimize / green expand */}
        <div data-no-drag style={{ display:'flex', gap:7, marginRight:12 }}>
          {[
            { bg:'#ff3b30', sym:'✕', title:'Close',    on:()=>closeWindow(win.id) },
            { bg:'#ffce00', sym:'−', title:'Minimize', on:()=>minimizeWindow(win.id) },
            { bg:'#28c93f', sym:'⛶', title:'Expand',   on:()=>toggleMax() },
          ].map((b) => (
            <button
              key={b.title}
              title={b.title}
              onClick={(e)=>{ e.stopPropagation(); b.on() }}
              style={{
                width:15, height:15, borderRadius:'50%', border:'none', cursor:'pointer',
                background:b.bg, color:'rgba(0,0,0,0.65)', fontSize:9, fontWeight:900, lineHeight:1,
                display:'flex', alignItems:'center', justifyContent:'center', padding:0,
                boxShadow:`0 0 6px ${b.bg}88`,
              }}
            >
              {b.sym}
            </button>
          ))}
        </div>
        {/* Title */}
        <div style={{ flex:1, textAlign:'center', fontSize:'0.78rem', fontWeight:500, color: win.focused ? 'var(--text-primary)' : 'var(--text-muted)', pointerEvents:'none', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
          {win.title}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex:1, overflow:'hidden', position:'relative' }}>
        <ContentComponent windowId={win.id} appId={win.appId} {...(win.props || {})} />
      </div>

      {/* Resize handles — 4 edges + 4 corners */}
      {!maximized && (() => {
        const EDGE = 6, CORNER = 14
        const handles = [
          { dir: 'n',  style: { top: 0, left: CORNER, right: CORNER, height: EDGE, cursor: 'ns-resize' } },
          { dir: 's',  style: { bottom: 0, left: CORNER, right: CORNER, height: EDGE, cursor: 'ns-resize' } },
          { dir: 'w',  style: { left: 0, top: CORNER, bottom: CORNER, width: EDGE, cursor: 'ew-resize' } },
          { dir: 'e',  style: { right: 0, top: CORNER, bottom: CORNER, width: EDGE, cursor: 'ew-resize' } },
          { dir: 'nw', style: { top: 0, left: 0, width: CORNER, height: CORNER, cursor: 'nwse-resize' } },
          { dir: 'ne', style: { top: 0, right: 0, width: CORNER, height: CORNER, cursor: 'nesw-resize' } },
          { dir: 'sw', style: { bottom: 0, left: 0, width: CORNER, height: CORNER, cursor: 'nesw-resize' } },
          { dir: 'se', style: { bottom: 0, right: 0, width: CORNER, height: CORNER, cursor: 'nwse-resize' } },
        ]
        return handles.map((h) => (
          <div
            key={h.dir}
            onMouseDown={(e) => startResize(e, h.dir)}
            style={{ position: 'absolute', zIndex: 20, ...h.style }}
          />
        ))
      })()}

      {/* Visual grip on the bottom-right corner */}
      {!maximized && (
        <div style={{ position:'absolute', right:0, bottom:0, width:16, height:16, pointerEvents:'none', zIndex:19, background:'linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.1) 50%)' }} />
      )}

      {/* Window context menu */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ top: contextMenu.y - win.y, left: contextMenu.x - win.x }}
          onClick={e=>e.stopPropagation()}
        >
          <div className="context-menu-item" onClick={()=>{focusWindow(win.id);setContextMenu(null)}}>⬆ Bring to Front</div>
          <div className="context-menu-item" onClick={()=>{toggleMax();setContextMenu(null)}}>{maximized?'↙ Restore':'⛶ Maximize'}</div>
          <div className="context-menu-item" onClick={()=>{minimizeWindow(win.id);setContextMenu(null)}}>— Minimize</div>
          <div className="context-menu-separator"/>
          <div className="context-menu-item danger" onClick={()=>{closeWindow(win.id);setContextMenu(null)}}>✕ Close Window</div>
        </div>
      )}
      {contextMenu && <div style={{position:'fixed',inset:0,zIndex:9998}} onClick={()=>setContextMenu(null)}/>}
    </div>
  )
}
