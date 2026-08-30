import { useState, useRef, useEffect } from 'react'
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Shuffle, Repeat, Music, Upload, X } from 'lucide-react'

// Streaming services open their web player embedded inside the Music app; the
// user signs in there and plays. (DRM streaming can't be driven by custom
// controls without each service's official SDK + developer keys.)
const SERVICES = [
  { id: 'spotify', name: 'Spotify', url: 'https://open.spotify.com', color: '#1DB954' },
  { id: 'apple', name: 'Apple Music', url: 'https://music.apple.com', color: '#FA243C' },
  { id: 'youtube', name: 'YouTube Music', url: 'https://music.youtube.com', color: '#FF0000' },
  { id: 'pandora', name: 'Pandora', url: 'https://www.pandora.com', color: '#224099' },
]
const COVERS = ['#7c3aed', '#1d4ed8', '#0f766e', '#92400e', '#166534', '#be123c', '#7e22ce']

function fmtTime(s) {
  if (!Number.isFinite(s) || s <= 0) return '0:00'
  const m = Math.floor(s / 60)
  const ss = Math.floor(s % 60).toString().padStart(2, '0')
  return `${m}:${ss}`
}

export default function MusicPlayer() {
  const [library, setLibrary] = useState([]) // user-uploaded tracks — empty by default
  const [current, setCurrent] = useState(-1)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(0.8)
  const [shuffle, setShuffle] = useState(false)
  const [repeat, setRepeat] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [view, setView] = useState('library') // 'library' | service id
  const audioRef = useRef(null)
  const progressRef = useRef(null)
  const fileRef = useRef(null)

  const track = current >= 0 ? library[current] : null

  // Wire the audio element to the current track.
  useEffect(() => {
    const a = audioRef.current
    if (!a || !track) return
    if (a.src !== track.src) a.src = track.src
    if (playing) a.play().catch(() => {})
  }, [current])

  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    if (playing) a.play().catch(() => setPlaying(false))
    else a.pause()
  }, [playing])

  useEffect(() => { const a = audioRef.current; if (a) a.volume = muted ? 0 : volume }, [volume, muted])

  // Clean up object URLs on unmount
  useEffect(() => () => { library.forEach(t => { try { URL.revokeObjectURL(t.src) } catch {} }) }, [])

  const togglePlay = () => { if (track) setPlaying(p => !p) }
  const next = () => {
    if (!library.length) return
    const n = shuffle ? Math.floor(Math.random() * library.length) : (current + 1) % library.length
    setCurrent(n); setProgress(0); setPlaying(true)
  }
  const prev = () => {
    if (!library.length) return
    setCurrent(c => (c - 1 + library.length) % library.length); setProgress(0); setPlaying(true)
  }

  const onFiles = (e) => {
    const files = Array.from(e.target.files || []).filter(f => f.type.startsWith('audio/') || /\.(mp3|m4a|wav|ogg|flac|aac)$/i.test(f.name))
    if (!files.length) return
    const added = files.map((f, i) => ({
      id: `${Date.now()}-${i}`,
      title: f.name.replace(/\.[^.]+$/, ''),
      artist: 'Local file',
      src: URL.createObjectURL(f),
      cover: COVERS[(library.length + i) % COVERS.length],
    }))
    setLibrary(l => {
      const wasEmpty = l.length === 0
      const nl = [...l, ...added]
      if (wasEmpty) setCurrent(0)
      return nl
    })
    setView('library')
    e.target.value = ''
  }

  const onTimeUpdate = () => {
    const a = audioRef.current
    if (a && a.duration) { setProgress((a.currentTime / a.duration) * 100); setDuration(a.duration) }
  }
  const onEnded = () => {
    if (repeat && audioRef.current) { audioRef.current.currentTime = 0; audioRef.current.play().catch(() => {}) }
    else next()
  }
  const seek = (e) => {
    const a = audioRef.current
    if (!progressRef.current || !a?.duration) return
    const rect = progressRef.current.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    a.currentTime = pct * a.duration
    setProgress(pct * 100)
  }

  const activeService = SERVICES.find(s => s.id === view)

  return (
    <div style={{ display: 'flex', height: '100%', background: '#08080f', color: '#fff', fontFamily: 'system-ui' }}>
      <audio ref={audioRef} onTimeUpdate={onTimeUpdate} onEnded={onEnded} onLoadedMetadata={onTimeUpdate} />

      {/* Left — Now Playing + sources */}
      <div style={{ width: 264, display: 'flex', flexDirection: 'column', padding: 18, gap: 14, borderRight: '1px solid rgba(255,255,255,0.07)', flexShrink: 0, overflowY: 'auto' }}>
        <div style={{
          width: '100%', paddingBottom: '100%', borderRadius: 16, position: 'relative',
          background: `linear-gradient(135deg, ${track?.cover || '#333'}, #000)`,
          boxShadow: `0 8px 40px ${(track?.cover || '#000')}55`, overflow: 'hidden',
        }}>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Music size={64} color="rgba(255,255,255,0.3)" />
          </div>
        </div>

        <div style={{ textAlign: 'center', minHeight: 40 }}>
          <div style={{ fontWeight: 700, fontSize: '0.95rem', marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{track?.title || 'Nothing playing'}</div>
          <div style={{ color: '#888', fontSize: '0.78rem' }}>{track?.artist || 'Add music to begin'}</div>
        </div>

        <div>
          <div ref={progressRef} onClick={seek}
            style={{ height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 99, cursor: track ? 'pointer' : 'default', position: 'relative' }}>
            <div style={{ height: '100%', width: `${progress}%`, background: '#7c3aed', borderRadius: 99 }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: '0.68rem', color: '#666' }}>
            <span>{fmtTime((progress / 100) * duration)}</span>
            <span>{fmtTime(duration)}</span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          <button onClick={() => setShuffle(s => !s)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: shuffle ? '#7c3aed' : '#555', padding: 4 }}><Shuffle size={16} /></button>
          <button onClick={prev} disabled={!library.length} style={{ background: 'none', border: 'none', cursor: 'pointer', color: library.length ? '#ccc' : '#444', padding: 4 }}><SkipBack size={22} /></button>
          <button onClick={togglePlay} disabled={!track} style={{ background: track ? '#7c3aed' : '#333', border: 'none', borderRadius: '50%', width: 48, height: 48, cursor: track ? 'pointer' : 'default', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {playing ? <Pause size={22} /> : <Play size={22} />}
          </button>
          <button onClick={next} disabled={!library.length} style={{ background: 'none', border: 'none', cursor: 'pointer', color: library.length ? '#ccc' : '#444', padding: 4 }}><SkipForward size={22} /></button>
          <button onClick={() => setRepeat(r => !r)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: repeat ? '#7c3aed' : '#555', padding: 4 }}><Repeat size={16} /></button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={() => setMuted(m => !m)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#888', padding: 0 }}>
            {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>
          <input type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume}
            onChange={e => { setVolume(parseFloat(e.target.value)); setMuted(false) }}
            style={{ flex: 1, accentColor: '#7c3aed' }} />
        </div>

        {/* Add music */}
        <button onClick={() => fileRef.current?.click()}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 0', borderRadius: 10, border: '1px dashed rgba(124,58,237,0.6)', background: 'rgba(124,58,237,0.12)', color: '#c4b5fd', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600 }}>
          <Upload size={15} /> Add your music files
        </button>
        <input ref={fileRef} type="file" accept="audio/*" multiple onChange={onFiles} style={{ display: 'none' }} />

        {/* Streaming services */}
        <div style={{ fontSize: '0.66rem', color: '#555', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 4 }}>Streaming</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {SERVICES.map(s => (
            <button key={s.id} onClick={() => setView(s.id)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '9px 6px', borderRadius: 9, border: `1px solid ${view === s.id ? s.color : 'rgba(255,255,255,0.1)'}`, background: view === s.id ? `${s.color}22` : 'rgba(255,255,255,0.04)', color: '#fff', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 600 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color, flexShrink: 0 }} /> {s.name}
            </button>
          ))}
        </div>
        <button onClick={() => setView('library')}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 0', borderRadius: 8, border: '1px solid rgba(255,255,255,0.1)', background: view === 'library' ? 'rgba(255,255,255,0.08)' : 'transparent', color: '#ccc', cursor: 'pointer', fontSize: '0.76rem' }}>
          <Music size={14} /> My Library
        </button>
      </div>

      {/* Right — library or embedded service */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {activeService ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: activeService.color }} />
              <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>{activeService.name}</span>
              <span style={{ fontSize: '0.7rem', color: '#777' }}>— sign in to play</span>
              <button onClick={() => setView('library')} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#888', display: 'flex', padding: 4 }}><X size={16} /></button>
            </div>
            <webview src={activeService.url} partition={`persist:music-${activeService.id}`} style={{ flex: 1, width: '100%', border: 'none' }} />
          </>
        ) : (
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 12px' }}>
            <div style={{ fontSize: '0.7rem', color: '#555', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12, padding: '0 8px' }}>My Library</div>
            {library.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '70%', gap: 14, color: '#666', textAlign: 'center', padding: 24 }}>
                <Music size={54} color="rgba(255,255,255,0.12)" />
                <div style={{ fontSize: '0.95rem', color: '#aaa' }}>Your library is empty</div>
                <div style={{ fontSize: '0.8rem', maxWidth: 320, lineHeight: 1.5 }}>Add your own audio files with “Add your music files”, or connect a streaming service on the left.</div>
                <button onClick={() => fileRef.current?.click()} style={{ marginTop: 6, padding: '9px 18px', borderRadius: 9, border: 'none', background: '#7c3aed', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: '0.82rem' }}>Add music</button>
              </div>
            ) : library.map((t, i) => (
              <button key={t.id} onClick={() => { setCurrent(i); setProgress(0); setPlaying(true) }}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', background: current === i ? 'rgba(124,58,237,0.18)' : 'transparent', border: `1px solid ${current === i ? 'rgba(124,58,237,0.4)' : 'transparent'}`, borderRadius: 12, cursor: 'pointer', color: '#fff', textAlign: 'left' }}
                onMouseEnter={e => { if (current !== i) e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                onMouseLeave={e => { if (current !== i) e.currentTarget.style.background = 'transparent' }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: `linear-gradient(135deg, ${t.cover}, #000)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {current === i && playing ? <Pause size={16} color="#fff" /> : <Music size={16} color="rgba(255,255,255,0.5)" />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: current === i ? 600 : 400, fontSize: '0.85rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: current === i ? '#a78bfa' : '#fff' }}>{t.title}</div>
                  <div style={{ fontSize: '0.72rem', color: '#666' }}>{t.artist}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
