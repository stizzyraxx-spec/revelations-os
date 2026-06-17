import { useState, useRef, useEffect } from 'react'
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Shuffle, Repeat, Music } from 'lucide-react'

// Built-in Christian/worship playlist using public domain / royalty-free sources
const PLAYLIST = [
  { id: 1, title: 'Praise & Worship Mix', artist: 'Revelations Radio', duration: 0, src: null, cover: '#7c3aed' },
  { id: 2, title: 'Amazing Grace (Instrumental)', artist: 'Hymns Collection', duration: 0, src: null, cover: '#1d4ed8' },
  { id: 3, title: 'How Great Thou Art', artist: 'Classical Worship', duration: 0, src: null, cover: '#0f766e' },
  { id: 4, title: 'Holy, Holy, Holy', artist: 'Reverence Series', duration: 0, src: null, cover: '#92400e' },
  { id: 5, title: 'Great Is Thy Faithfulness', artist: 'Morning Devotion', duration: 0, src: null, cover: '#166534' },
]

function fmtTime(s) {
  if (!Number.isFinite(s)) return '0:00'
  const m = Math.floor(s / 60)
  const ss = Math.floor(s % 60).toString().padStart(2, '0')
  return `${m}:${ss}`
}

function Waveform({ playing }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: 24 }}>
      {[...Array(20)].map((_, i) => (
        <div key={i} style={{
          width: 3, borderRadius: 2,
          background: `rgba(167,139,250,${0.4 + (i % 4) * 0.15})`,
          height: playing ? `${12 + Math.random() * 12}px` : '4px',
          transition: playing ? `height ${0.3 + (i % 5) * 0.1}s ease-in-out` : 'height 0.3s',
          animation: playing ? `eq-bar-${i % 5} ${0.6 + (i % 3) * 0.2}s ease-in-out infinite alternate` : 'none',
        }} />
      ))}
    </div>
  )
}

export default function MusicPlayer() {
  const [current, setCurrent] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(0.8)
  const [shuffle, setShuffle] = useState(false)
  const [repeat, setRepeat] = useState(false)
  const [progress, setProgress] = useState(0)
  const [dragging, setDragging] = useState(false)
  const audioRef = useRef(null)
  const progressRef = useRef(null)

  const track = PLAYLIST[current]

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if (e.code === 'Space') { e.preventDefault(); togglePlay() }
      if (e.code === 'ArrowRight') next()
      if (e.code === 'ArrowLeft') prev()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [current, playing])

  const togglePlay = () => {
    if (audioRef.current?.src) {
      if (playing) audioRef.current.pause()
      else audioRef.current.play().catch(() => {})
    }
    setPlaying(p => !p)
  }

  const next = () => {
    const n = shuffle ? Math.floor(Math.random() * PLAYLIST.length) : (current + 1) % PLAYLIST.length
    setCurrent(n); setProgress(0)
  }

  const prev = () => {
    setCurrent(c => (c - 1 + PLAYLIST.length) % PLAYLIST.length); setProgress(0)
  }

  const seek = (e) => {
    if (!progressRef.current) return
    const rect = progressRef.current.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    setProgress(pct * 100)
    if (audioRef.current?.duration) audioRef.current.currentTime = pct * audioRef.current.duration
  }

  return (
    <div style={{ display: 'flex', height: '100%', background: '#08080f', color: '#fff', fontFamily: 'system-ui' }}>
      {/* Left — Now Playing */}
      <div style={{ width: 260, display: 'flex', flexDirection: 'column', padding: 20, gap: 16, borderRight: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        {/* Cover Art */}
        <div style={{
          width: '100%', paddingBottom: '100%', borderRadius: 16, position: 'relative',
          background: `linear-gradient(135deg, ${track.cover}, #000)`,
          boxShadow: `0 8px 40px ${track.cover}55`,
          overflow: 'hidden',
        }}>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Music size={64} color="rgba(255,255,255,0.3)" />
          </div>
          {playing && (
            <div style={{ position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)' }}>
              <Waveform playing={playing} />
            </div>
          )}
        </div>

        {/* Track info */}
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: '0.95rem', marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{track.title}</div>
          <div style={{ color: '#888', fontSize: '0.78rem' }}>{track.artist}</div>
        </div>

        {/* Progress bar */}
        <div>
          <div ref={progressRef} onClick={seek}
            style={{ height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 99, cursor: 'pointer', position: 'relative' }}
          >
            <div style={{ height: '100%', width: `${progress}%`, background: '#7c3aed', borderRadius: 99, transition: dragging ? 'none' : 'width 0.5s linear' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: '0.68rem', color: '#666' }}>
            <span>{fmtTime((progress / 100) * (audioRef.current?.duration || 0))}</span>
            <span>{fmtTime(audioRef.current?.duration || 0)}</span>
          </div>
        </div>

        {/* Controls */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          <button onClick={() => setShuffle(s => !s)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: shuffle ? '#7c3aed' : '#555', padding: 4 }}><Shuffle size={16} /></button>
          <button onClick={prev} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ccc', padding: 4 }}><SkipBack size={22} /></button>
          <button onClick={togglePlay} style={{ background: '#7c3aed', border: 'none', borderRadius: '50%', width: 48, height: 48, cursor: 'pointer', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {playing ? <Pause size={22} /> : <Play size={22} />}
          </button>
          <button onClick={next} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ccc', padding: 4 }}><SkipForward size={22} /></button>
          <button onClick={() => setRepeat(r => !r)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: repeat ? '#7c3aed' : '#555', padding: 4 }}><Repeat size={16} /></button>
        </div>

        {/* Volume */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={() => setMuted(m => !m)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#888', padding: 0 }}>
            {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>
          <input type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume}
            onChange={e => { setVolume(parseFloat(e.target.value)); setMuted(false) }}
            style={{ flex: 1, accentColor: '#7c3aed' }}
          />
        </div>
      </div>

      {/* Right — Playlist */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 12px' }}>
        <div style={{ fontSize: '0.7rem', color: '#555', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12, padding: '0 8px' }}>
          Worship Playlist
        </div>
        {PLAYLIST.map((t, i) => (
          <button key={t.id} onClick={() => { setCurrent(i); setProgress(0); setPlaying(true) }}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
              background: current === i ? 'rgba(124,58,237,0.18)' : 'transparent',
              border: `1px solid ${current === i ? 'rgba(124,58,237,0.4)' : 'transparent'}`,
              borderRadius: 12, cursor: 'pointer', color: '#fff', transition: 'all 0.15s', textAlign: 'left',
            }}
            onMouseEnter={e => { if (current !== i) e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
            onMouseLeave={e => { if (current !== i) e.currentTarget.style.background = 'transparent' }}
          >
            <div style={{ width: 40, height: 40, borderRadius: 10, background: `linear-gradient(135deg, ${t.cover}, #000)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {current === i && playing ? <Pause size={16} color="#fff" /> : <Music size={16} color="rgba(255,255,255,0.5)" />}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: current === i ? 600 : 400, fontSize: '0.85rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: current === i ? '#a78bfa' : '#fff' }}>{t.title}</div>
              <div style={{ fontSize: '0.72rem', color: '#666' }}>{t.artist}</div>
            </div>
            <div style={{ fontSize: '0.72rem', color: '#555' }}>—:——</div>
          </button>
        ))}

        <div style={{ margin: '20px 8px 8px', padding: '16px', background: 'rgba(124,58,237,0.08)', borderRadius: 12, border: '1px solid rgba(124,58,237,0.2)' }}>
          <div style={{ fontSize: '0.78rem', color: '#a78bfa', fontWeight: 600, marginBottom: 6 }}>🎵 About Music Player</div>
          <div style={{ fontSize: '0.72rem', color: '#888', lineHeight: 1.6 }}>
            Connect your own audio files by dragging them here, or stream from Ephesians browser. This playlist is curated worship music.
          </div>
        </div>
      </div>

      <style>{`
        @keyframes eq-bar-0 { from { height: 6px } to { height: 18px } }
        @keyframes eq-bar-1 { from { height: 14px } to { height: 8px } }
        @keyframes eq-bar-2 { from { height: 10px } to { height: 22px } }
        @keyframes eq-bar-3 { from { height: 18px } to { height: 6px } }
        @keyframes eq-bar-4 { from { height: 8px } to { height: 16px } }
      `}</style>
    </div>
  )
}
