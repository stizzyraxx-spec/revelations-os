import { useState, useCallback } from 'react'
import { useOSStore } from '../store'
import { TASKBAR_HEIGHT } from './BottomTaskbar'

export default function AppWindow({ win, ContentComponent }) {
  const {
    closeWindow, minimizeWindow, focusWindow, moveWindow, setBounds,
    toggleMaximize, snapWindow, popOutOfMaximize,
    desktops, activeDesktop, moveWindowToDesktop,
  } = useOSStore()
  const [contextMenu, setContextMenu] = useState(null)
  const [snapOpen, setSnapOpen] = useState(false)
  // Maximized/snapped state lives on the window itself so it survives
  // re-renders, minimise/restore and moving between desktops.
  const maximized = !!win.maximized

  const DOCK_W = 0   // dock auto-hides, windows use full width
  const TAB_W  = 0   // tab auto-hides, windows use full width

  const handleTitleMouseDown = useCallback((e) => {
    if (e.target.closest('[data-no-drag]')) return
    e.preventDefault()
    focusWindow(win.id)

    // Start from the window's current bounds — unless it is maximized, in which
    // case it pops back to its restored size centred under the cursor and the
    // drag continues from there.
    let curX = win.x, curY = win.y, curW = win.width
    if (maximized) {
      const r = win.restore || { width: 960, height: 640 }
      curW = r.width
      curX = Math.max(0, Math.round(e.clientX - curW / 2))
      curY = 40
      popOutOfMaximize(win.id, { x: curX, y: curY })
    }

    const startX = e.clientX - curX
    const startY = e.clientY - curY
    const onMove = (me) => {
      const nx = Math.max(DOCK_W, Math.min(me.clientX - startX, window.innerWidth - TAB_W - curW))
      const ny = Math.max(40, Math.min(me.clientY - startY, window.innerHeight - 60))
      moveWindow(win.id, nx, ny)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [win, maximized, focusWindow, moveWindow, popOutOfMaximize])

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

  const toggleMax = () => toggleMaximize(win.id)

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

        {/* Snap control — pick a quarter (or half) of the screen for this
            window, so four apps can share the desktop at once. */}
        <div data-no-drag style={{ position:'relative', flexShrink:0 }}>
          <button
            title="Snap to a corner"
            onClick={(e) => { e.stopPropagation(); focusWindow(win.id); setSnapOpen(v => !v) }}
            style={{
              display:'flex', alignItems:'center', justifyContent:'center', width:22, height:18,
              borderRadius:4, cursor:'pointer', padding:0,
              background: snapOpen ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.06)',
              border:'1px solid rgba(255,255,255,0.14)',
            }}
          >
            <span style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gridTemplateRows:'1fr 1fr', gap:1, width:11, height:9 }}>
              {[0,1,2,3].map(i => (
                <span key={i} style={{ background: 'rgba(255,255,255,0.75)', borderRadius:0.5 }} />
              ))}
            </span>
          </button>

          {snapOpen && (
            <>
              <div style={{ position:'fixed', inset:0, zIndex:9997 }} onClick={(e) => { e.stopPropagation(); setSnapOpen(false) }} />
              <div
                onClick={e => e.stopPropagation()}
                style={{
                  position:'absolute', top:24, right:0, zIndex:9998, padding:8, borderRadius:10,
                  background:'rgba(10,10,20,0.98)', border:'1px solid rgba(255,255,255,0.14)',
                  boxShadow:'0 14px 34px rgba(0,0,0,0.6)',
                }}
              >
                <div style={{ fontSize:'0.62rem', color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:6 }}>
                  Snap to
                </div>
                {/* A miniature of the screen: click the quarter you want. */}
                <div style={{ display:'grid', gridTemplateColumns:'34px 34px', gridTemplateRows:'26px 26px', gap:3 }}>
                  {[
                    { key:'tl', title:'Top left' },
                    { key:'tr', title:'Top right' },
                    { key:'bl', title:'Bottom left' },
                    { key:'br', title:'Bottom right' },
                  ].map(q => (
                    <button
                      key={q.key}
                      title={q.title}
                      onClick={() => { snapWindow(win.id, q.key); setSnapOpen(false) }}
                      style={{
                        cursor:'pointer', borderRadius:4,
                        background: win.snap === q.key ? 'var(--accent)' : 'rgba(255,255,255,0.09)',
                        border:`1px solid ${win.snap === q.key ? 'var(--accent)' : 'rgba(255,255,255,0.16)'}`,
                      }}
                    />
                  ))}
                </div>
                <div style={{ display:'flex', gap:3, marginTop:5 }}>
                  {[
                    { key:'left', label:'◧' },
                    { key:'right', label:'◨' },
                    { key:null, label:'↙', title:'Restore' },
                  ].map((h, i) => (
                    <button
                      key={i}
                      title={h.title || `Snap ${h.key}`}
                      onClick={() => { snapWindow(win.id, h.key); setSnapOpen(false) }}
                      style={{
                        flex:1, height:20, cursor:'pointer', borderRadius:4, fontSize:11,
                        color:'var(--text-primary)',
                        background: h.key && win.snap === h.key ? 'var(--accent)' : 'rgba(255,255,255,0.09)',
                        border:'1px solid rgba(255,255,255,0.16)',
                      }}
                    >
                      {h.label}
                    </button>
                  ))}
                </div>

                {desktops.length > 1 && (
                  <>
                    <div style={{ fontSize:'0.62rem', color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.08em', margin:'9px 0 5px' }}>
                      Move to desktop
                    </div>
                    <div style={{ display:'flex', flexWrap:'wrap', gap:3, maxWidth:74 }}>
                      {desktops.map((d, i) => (
                        <button
                          key={d.id}
                          title={d.name}
                          onClick={() => { moveWindowToDesktop(win.id, d.id); setSnapOpen(false) }}
                          style={{
                            width:20, height:20, cursor:'pointer', borderRadius:4, fontSize:10,
                            color:'var(--text-primary)',
                            background: win.desktop === d.id ? 'var(--accent)' : 'rgba(255,255,255,0.09)',
                            border:`1px solid ${d.id === activeDesktop ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.16)'}`,
                          }}
                        >
                          {i + 1}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </>
          )}
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
          <div className="context-menu-item" onClick={()=>{snapWindow(win.id,'tl');setContextMenu(null)}}>◤ Snap Top Left</div>
          <div className="context-menu-item" onClick={()=>{snapWindow(win.id,'tr');setContextMenu(null)}}>◥ Snap Top Right</div>
          <div className="context-menu-item" onClick={()=>{snapWindow(win.id,'bl');setContextMenu(null)}}>◣ Snap Bottom Left</div>
          <div className="context-menu-item" onClick={()=>{snapWindow(win.id,'br');setContextMenu(null)}}>◢ Snap Bottom Right</div>
          <div className="context-menu-separator"/>
          <div className="context-menu-item danger" onClick={()=>{closeWindow(win.id);setContextMenu(null)}}>✕ Close Window</div>
        </div>
      )}
      {contextMenu && <div style={{position:'fixed',inset:0,zIndex:9998}} onClick={()=>setContextMenu(null)}/>}
    </div>
  )
}
