import { useRef, useState, useCallback } from 'react'
import { useOSStore } from '../store'

export default function AppWindow({ win, ContentComponent }) {
  const { closeWindow, minimizeWindow, focusWindow, moveWindow, resizeWindow } = useOSStore()
  const [maximized, setMaximized] = useState(false)
  const [preMaxState, setPreMaxState] = useState(null)
  const [contextMenu, setContextMenu] = useState(null)
  const dragRef = useRef(null)
  const resizeRef = useRef(null)

  const handleTitleMouseDown = useCallback((e) => {
    if (e.target.closest('[data-no-drag]')) return
    if (maximized) return
    e.preventDefault()
    focusWindow(win.id)
    const startX = e.clientX - win.x
    const startY = e.clientY - win.y
    const onMove = (me) => {
      const nx = Math.max(0, Math.min(me.clientX - startX, window.innerWidth - win.width))
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

  const handleResizeMouseDown = useCallback((e) => {
    e.preventDefault(); e.stopPropagation()
    const startX = e.clientX, startY = e.clientY
    const startW = win.width, startH = win.height
    const onMove = (me) => {
      resizeWindow(win.id, Math.max(320, startW + me.clientX - startX), Math.max(200, startH + me.clientY - startY))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [win, resizeWindow])

  const toggleMax = () => {
    if (maximized) {
      moveWindow(win.id, preMaxState.x, preMaxState.y)
      resizeWindow(win.id, preMaxState.width, preMaxState.height)
      setMaximized(false)
    } else {
      setPreMaxState({ x: win.x, y: win.y, width: win.width, height: win.height })
      moveWindow(win.id, 0, 40)
      resizeWindow(win.id, window.innerWidth, window.innerHeight - 40)
      setMaximized(true)
    }
    focusWindow(win.id)
  }

  const handleContextMenu = (e) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  const style = maximized
    ? { position:'fixed', top:40, left:0, width:'100vw', height:'calc(100vh - 40px)', zIndex: win.zIndex }
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
          cursor: maximized ? 'default' : 'grab',
          userSelect:'none', flexShrink:0,
        }}
      >
        {/* Traffic lights */}
        <div data-no-drag style={{ display:'flex', gap:6, marginRight:12 }}>
          <button className="traffic-light" onClick={(e)=>{e.stopPropagation();closeWindow(win.id)}} style={{ background:'#ef4444' }} title="Close"/>
          <button className="traffic-light" onClick={(e)=>{e.stopPropagation();minimizeWindow(win.id)}} style={{ background:'#f59e0b' }} title="Minimize"/>
          <button className="traffic-light" onClick={(e)=>{e.stopPropagation();toggleMax()}} style={{ background:'#22c55e' }} title="Maximize"/>
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

      {/* Resize handle */}
      {!maximized && (
        <div
          onMouseDown={handleResizeMouseDown}
          style={{ position:'absolute', right:0, bottom:0, width:16, height:16, cursor:'se-resize', zIndex:10, background:'linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.1) 50%)' }}
        />
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
