import { useState, useRef, useEffect, useCallback } from 'react'
import { Film, Upload, X, Trash2, Play, ChevronLeft, ChevronRight } from 'lucide-react'

// Same storage approach as Photos: blob URLs from the picker / drag-drop. Videos
// especially can't go through fs:readFile (10 MB cap), and a blob URL streams
// with seeking intact rather than buffering the whole file into memory.
const VIDEO_RE = /\.(mp4|webm|ogv|ogg|mov|m4v|mkv|avi)$/i

function fmtDuration(s) {
  if (!Number.isFinite(s) || s <= 0) return ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60).toString().padStart(2, '0')
  return h ? `${h}:${m.toString().padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

function fmtSize(bytes) {
  if (!bytes) return ''
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0, n = bytes
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`
}

export default function VideosApp() {
  const [videos, setVideos] = useState([])
  const [open, setOpen] = useState(-1)
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef(null)
  const playerRef = useRef(null)
  const videosRef = useRef(videos)
  useEffect(() => { videosRef.current = videos }, [videos])
  useEffect(() => () => { videosRef.current.forEach(v => { try { URL.revokeObjectURL(v.src) } catch {} }) }, [])

  const addFiles = useCallback((fileList) => {
    const files = Array.from(fileList || []).filter(f => f.type.startsWith('video/') || VIDEO_RE.test(f.name))
    if (!files.length) return
    setVideos(prev => [
      ...prev,
      ...files.map((f, i) => ({
        id: `${Date.now()}-${i}-${f.name}`,
        name: f.name,
        size: f.size,
        src: URL.createObjectURL(f),
        duration: 0,
      })),
    ])
  }, [])

  const onPick = (e) => { addFiles(e.target.files); e.target.value = '' }
  const onDrop = (e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer?.files) }

  // Each tile's own <video> reports its duration once metadata lands.
  const setDuration = (id, duration) => {
    setVideos(prev => prev.map(v => (v.id === id && !v.duration ? { ...v, duration } : v)))
  }

  const remove = (idx) => {
    setVideos(prev => {
      const v = prev[idx]
      if (v) { try { URL.revokeObjectURL(v.src) } catch {} }
      return prev.filter((_, i) => i !== idx)
    })
    setOpen(o => {
      if (o < 0) return o
      const remaining = videos.length - 1
      if (remaining <= 0) return -1
      return Math.min(o, remaining - 1)
    })
  }

  const step = useCallback((d) => {
    setOpen(o => (o < 0 || !videos.length) ? o : (o + d + videos.length) % videos.length)
  }, [videos.length])

  useEffect(() => {
    if (open < 0) return
    const onKey = (e) => {
      // Space/arrows belong to the video element once it has focus.
      if (e.target instanceof HTMLVideoElement) return
      if (e.key === 'Escape') setOpen(-1)
      else if (e.key === 'ArrowRight') step(1)
      else if (e.key === 'ArrowLeft') step(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, step])

  // Autoplay whichever video the player is switched to.
  useEffect(() => {
    if (open < 0) return
    const el = playerRef.current
    if (el) el.play().catch(() => {})
  }, [open])

  const current = open >= 0 ? videos[open] : null

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false) }}
      onDrop={onDrop}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#08080f', color: '#fff', fontFamily: 'system-ui', position: 'relative' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        <Film size={16} style={{ color: '#f472b6' }} />
        <span style={{ fontSize: '0.88rem', fontWeight: 600 }}>Videos</span>
        <span style={{ fontSize: '0.74rem', color: '#666' }}>
          {videos.length ? `${videos.length} video${videos.length === 1 ? '' : 's'}` : 'No videos yet'}
        </span>
        <button onClick={() => fileRef.current?.click()}
          style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8, border: 'none', background: '#db2777', color: '#fff', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer' }}>
          <Upload size={14} /> Add videos
        </button>
        <input ref={fileRef} type="file" accept="video/*" multiple onChange={onPick} style={{ display: 'none' }} />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {videos.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 14, color: '#666', textAlign: 'center', padding: 24 }}>
            <Film size={54} color="rgba(255,255,255,0.12)" />
            <div style={{ fontSize: '0.95rem', color: '#aaa' }}>No videos yet</div>
            <div style={{ fontSize: '0.8rem', maxWidth: 340, lineHeight: 1.5 }}>
              Drag video files anywhere into this window, or use “Add videos” to pick them from your machine.
            </div>
            <button onClick={() => fileRef.current?.click()}
              style={{ marginTop: 6, padding: '9px 18px', borderRadius: 9, border: 'none', background: '#db2777', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: '0.82rem' }}>
              Add videos
            </button>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
            {videos.map((v, i) => (
              <div key={v.id} onClick={() => setOpen(i)}
                style={{ borderRadius: 12, overflow: 'hidden', cursor: 'pointer', background: '#111', border: '1px solid rgba(255,255,255,0.07)' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(244,114,182,0.5)' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)' }}>
                <div style={{ position: 'relative', aspectRatio: '16/9', background: '#000' }}>
                  {/* The element itself is the thumbnail — preload metadata only
                      so a large library doesn't pull every file into memory. */}
                  <video src={v.src} preload="metadata" muted playsInline
                    onLoadedMetadata={(e) => setDuration(v.id, e.currentTarget.duration)}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.25)' }}>
                    <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Play size={18} fill="#fff" color="#fff" />
                    </div>
                  </div>
                  {v.duration > 0 && (
                    <div style={{ position: 'absolute', right: 6, bottom: 6, background: 'rgba(0,0,0,0.8)', borderRadius: 4, padding: '2px 6px', fontSize: '0.68rem' }}>
                      {fmtDuration(v.duration)}
                    </div>
                  )}
                  <button onClick={(e) => { e.stopPropagation(); remove(i) }} title="Remove"
                    style={{ position: 'absolute', top: 6, right: 6, background: 'rgba(0,0,0,0.6)', border: 'none', borderRadius: 6, padding: 4, cursor: 'pointer', color: '#fca5a5', display: 'flex' }}>
                    <Trash2 size={13} />
                  </button>
                </div>
                <div style={{ padding: '8px 10px' }}>
                  <div style={{ fontSize: '0.78rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.name}</div>
                  <div style={{ fontSize: '0.68rem', color: '#666', marginTop: 2 }}>{fmtSize(v.size)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {dragging && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 40, background: 'rgba(219,39,119,0.16)', border: '2px dashed #f472b6', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', fontSize: '1rem', fontWeight: 600, color: '#fce7f3' }}>
          Drop videos to add them
        </div>
      )}

      {/* Player */}
      {current && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.96)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', flexShrink: 0 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '0.84rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{current.name}</div>
              <div style={{ fontSize: '0.7rem', color: '#777' }}>
                {open + 1} of {videos.length}{current.size ? ` · ${fmtSize(current.size)}` : ''}
              </div>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
              <button onClick={() => remove(open)} title="Remove" style={{ ...playerBtn, color: '#fca5a5' }}><Trash2 size={16} /></button>
              <button onClick={() => setOpen(-1)} title="Close" style={playerBtn}><X size={18} /></button>
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', padding: '0 12px 12px' }}>
            {videos.length > 1 && (
              <button onClick={() => step(-1)} title="Previous" style={{ ...navBtn, left: 12 }}><ChevronLeft size={22} /></button>
            )}
            {/* key forces a fresh element per video so switching resets playback */}
            <video key={current.id} ref={playerRef} src={current.src} controls autoPlay
              style={{ maxWidth: '100%', maxHeight: '100%', outline: 'none', background: '#000' }} />
            {videos.length > 1 && (
              <button onClick={() => step(1)} title="Next" style={{ ...navBtn, right: 12 }}><ChevronRight size={22} /></button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const playerBtn = { background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: 7, padding: 7, cursor: 'pointer', color: '#ddd', display: 'flex', alignItems: 'center' }
const navBtn = { position: 'absolute', top: '50%', transform: 'translateY(-50%)', background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '50%', width: 40, height: 40, cursor: 'pointer', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2 }
