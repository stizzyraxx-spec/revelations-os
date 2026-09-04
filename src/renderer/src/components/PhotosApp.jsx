import { useState, useRef, useEffect, useCallback } from 'react'
import { Image as ImageIcon, Upload, X, ChevronLeft, ChevronRight, Trash2, Download, ZoomIn, ZoomOut } from 'lucide-react'

// Photos are held as blob URLs from the file picker / drag-drop rather than read
// through fs IPC: fs:readFile caps at 10 MB and file:// URLs don't load from the
// dev server's http origin. Blob URLs work identically in dev and packaged.
const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|avif|svg|heic|heif)$/i

function fmtSize(bytes) {
  if (!bytes) return ''
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0, n = bytes
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`
}

export default function PhotosApp() {
  const [photos, setPhotos] = useState([])
  const [open, setOpen] = useState(-1)   // index in the lightbox, -1 = grid
  const [zoom, setZoom] = useState(1)
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef(null)
  // Kept in a ref so the unmount cleanup sees the final list, not the first one.
  const photosRef = useRef(photos)
  useEffect(() => { photosRef.current = photos }, [photos])
  useEffect(() => () => { photosRef.current.forEach(p => { try { URL.revokeObjectURL(p.src) } catch {} }) }, [])

  const addFiles = useCallback((fileList) => {
    const files = Array.from(fileList || []).filter(f => f.type.startsWith('image/') || IMAGE_RE.test(f.name))
    if (!files.length) return
    setPhotos(prev => [
      ...prev,
      ...files.map((f, i) => ({
        id: `${Date.now()}-${i}-${f.name}`,
        name: f.name,
        size: f.size,
        modified: f.lastModified,
        src: URL.createObjectURL(f),
      })),
    ])
  }, [])

  const onPick = (e) => { addFiles(e.target.files); e.target.value = '' }

  const onDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    addFiles(e.dataTransfer?.files)
  }

  const remove = (idx) => {
    setPhotos(prev => {
      const p = prev[idx]
      if (p) { try { URL.revokeObjectURL(p.src) } catch {} }
      return prev.filter((_, i) => i !== idx)
    })
    setOpen(o => {
      if (o < 0) return o
      // Closing the last photo drops back to the grid; otherwise stay in place.
      const remaining = photos.length - 1
      if (remaining <= 0) return -1
      return Math.min(o, remaining - 1)
    })
  }

  const step = useCallback((d) => {
    setZoom(1)
    setOpen(o => (o < 0 || !photos.length) ? o : (o + d + photos.length) % photos.length)
  }, [photos.length])

  // Arrow keys / Escape drive the lightbox.
  useEffect(() => {
    if (open < 0) return
    const onKey = (e) => {
      if (e.key === 'Escape') { setOpen(-1); setZoom(1) }
      else if (e.key === 'ArrowRight') step(1)
      else if (e.key === 'ArrowLeft') step(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, step])

  const current = open >= 0 ? photos[open] : null

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false) }}
      onDrop={onDrop}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#08080f', color: '#fff', fontFamily: 'system-ui', position: 'relative' }}
    >
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        <ImageIcon size={16} style={{ color: '#38bdf8' }} />
        <span style={{ fontSize: '0.88rem', fontWeight: 600 }}>Photos</span>
        <span style={{ fontSize: '0.74rem', color: '#666' }}>
          {photos.length ? `${photos.length} photo${photos.length === 1 ? '' : 's'}` : 'No photos yet'}
        </span>
        <button onClick={() => fileRef.current?.click()}
          style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8, border: 'none', background: '#0284c7', color: '#fff', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer' }}>
          <Upload size={14} /> Add photos
        </button>
        <input ref={fileRef} type="file" accept="image/*" multiple onChange={onPick} style={{ display: 'none' }} />
      </div>

      {/* Grid */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {photos.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 14, color: '#666', textAlign: 'center', padding: 24 }}>
            <ImageIcon size={54} color="rgba(255,255,255,0.12)" />
            <div style={{ fontSize: '0.95rem', color: '#aaa' }}>No photos yet</div>
            <div style={{ fontSize: '0.8rem', maxWidth: 340, lineHeight: 1.5 }}>
              Drag images anywhere into this window, or use “Add photos” to pick them from your machine.
            </div>
            <button onClick={() => fileRef.current?.click()}
              style={{ marginTop: 6, padding: '9px 18px', borderRadius: 9, border: 'none', background: '#0284c7', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: '0.82rem' }}>
              Add photos
            </button>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
            {photos.map((p, i) => (
              <div key={p.id} onClick={() => { setOpen(i); setZoom(1) }}
                style={{ position: 'relative', aspectRatio: '1', borderRadius: 12, overflow: 'hidden', cursor: 'pointer', background: '#111', border: '1px solid rgba(255,255,255,0.07)' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(56,189,248,0.5)' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)' }}>
                <img src={p.src} alt={p.name} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '16px 8px 6px', background: 'linear-gradient(transparent, rgba(0,0,0,0.85))', fontSize: '0.68rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {p.name}
                </div>
                <button onClick={(e) => { e.stopPropagation(); remove(i) }} title="Remove"
                  style={{ position: 'absolute', top: 6, right: 6, background: 'rgba(0,0,0,0.6)', border: 'none', borderRadius: 6, padding: 4, cursor: 'pointer', color: '#fca5a5', display: 'flex' }}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Drop overlay */}
      {dragging && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 40, background: 'rgba(2,132,199,0.16)', border: '2px dashed #38bdf8', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', fontSize: '1rem', fontWeight: 600, color: '#e0f2fe' }}>
          Drop images to add them
        </div>
      )}

      {/* Lightbox */}
      {current && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.94)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', flexShrink: 0 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '0.84rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{current.name}</div>
              <div style={{ fontSize: '0.7rem', color: '#777' }}>
                {open + 1} of {photos.length}{current.size ? ` · ${fmtSize(current.size)}` : ''}
              </div>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
              <button onClick={() => setZoom(z => Math.max(1, z - 0.25))} title="Zoom out" style={lightboxBtn}><ZoomOut size={16} /></button>
              <span style={{ fontSize: '0.72rem', color: '#888', width: 40, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
              <button onClick={() => setZoom(z => Math.min(4, z + 0.25))} title="Zoom in" style={lightboxBtn}><ZoomIn size={16} /></button>
              <a href={current.src} download={current.name} title="Save a copy" style={{ ...lightboxBtn, textDecoration: 'none' }}><Download size={16} /></a>
              <button onClick={() => remove(open)} title="Remove" style={{ ...lightboxBtn, color: '#fca5a5' }}><Trash2 size={16} /></button>
              <button onClick={() => { setOpen(-1); setZoom(1) }} title="Close" style={lightboxBtn}><X size={18} /></button>
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'auto' }}>
            {photos.length > 1 && (
              <button onClick={() => step(-1)} title="Previous" style={{ ...navBtn, left: 12 }}><ChevronLeft size={22} /></button>
            )}
            <img src={current.src} alt={current.name}
              style={{ maxWidth: zoom === 1 ? '100%' : 'none', maxHeight: zoom === 1 ? '100%' : 'none', width: zoom === 1 ? 'auto' : `${zoom * 100}%`, objectFit: 'contain', display: 'block' }} />
            {photos.length > 1 && (
              <button onClick={() => step(1)} title="Next" style={{ ...navBtn, right: 12 }}><ChevronRight size={22} /></button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const lightboxBtn = { background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: 7, padding: 7, cursor: 'pointer', color: '#ddd', display: 'flex', alignItems: 'center' }
const navBtn = { position: 'absolute', top: '50%', transform: 'translateY(-50%)', background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '50%', width: 40, height: 40, cursor: 'pointer', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2 }
