import { useState, useEffect, useCallback, useRef } from 'react'
import { Volume2, VolumeX, Volume1, Volume } from 'lucide-react'

function VolumeIcon({ volume, muted }) {
  if (muted || volume === 0) return <VolumeX size={22} style={{ color: '#f87171' }} />
  if (volume < 33) return <Volume size={22} style={{ color: '#60a5fa' }} />
  if (volume < 66) return <Volume1 size={22} style={{ color: '#60a5fa' }} />
  return <Volume2 size={22} style={{ color: '#60a5fa' }} />
}

const PRESETS = [
  { label: 'Silent', value: 0 },
  { label: 'Low', value: 25 },
  { label: 'Medium', value: 50 },
  { label: 'High', value: 75 },
  { label: 'Max', value: 100 },
]

export default function VolumePanel() {
  const [volume, setVolume] = useState(50)
  const [muted, setMuted] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [toast, setToast] = useState(null)
  const debounceRef = useRef(null)

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 1800) }

  const load = useCallback(async () => {
    const s = await window.nexus?.volumeGet()
    if (s) { setVolume(s.volume); setMuted(s.muted) }
  }, [])

  useEffect(() => { load() }, [])

  const applyVolume = useCallback((val) => {
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      await window.nexus?.volumeSet(val)
    }, 80)
  }, [])

  const handleSlider = (e) => {
    const val = parseInt(e.target.value)
    setVolume(val)
    if (muted && val > 0) {
      setMuted(false)
      window.nexus?.volumeMute(false)
    }
    applyVolume(val)
  }

  const handleMute = async () => {
    const next = !muted
    setMuted(next)
    await window.nexus?.volumeMute(next)
    showToast(next ? 'Muted' : 'Unmuted')
  }

  const handlePreset = async (val) => {
    setVolume(val)
    if (muted && val > 0) { setMuted(false); await window.nexus?.volumeMute(false) }
    await window.nexus?.volumeSet(val)
    showToast(`Volume: ${val}%`)
  }

  const pct = muted ? 0 : volume

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>
      {/* Header */}
      <div style={{ padding: '18px 20px 20px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
          <VolumeIcon volume={volume} muted={muted} />
          <span style={{ fontSize: '1.05rem', fontWeight: 700 }}>Volume</span>
        </div>

        {/* Big volume display */}
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div style={{ fontSize: '4rem', fontWeight: 800, color: muted ? '#f87171' : '#f1f5f9', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
            {muted ? '—' : `${volume}`}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4 }}>
            {muted ? 'Muted' : volume === 0 ? 'Silent' : volume < 33 ? 'Quiet' : volume < 66 ? 'Moderate' : volume < 90 ? 'Loud' : 'Maximum'}
          </div>
        </div>

        {/* Slider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Volume size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <div style={{ flex: 1, position: 'relative', height: 28, display: 'flex', alignItems: 'center' }}>
            <div style={{ position: 'absolute', left: 0, right: 0, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: muted ? '#ef4444' : 'linear-gradient(90deg, #2563eb, #60a5fa)', borderRadius: 3, transition: dragging ? 'none' : 'width 0.15s' }} />
            </div>
            <input
              type="range" min={0} max={100} value={volume}
              onChange={handleSlider}
              onMouseDown={() => setDragging(true)}
              onMouseUp={() => setDragging(false)}
              style={{ position: 'relative', width: '100%', zIndex: 1, opacity: 0, cursor: 'pointer', height: 28, margin: 0 }}
            />
          </div>
          <Volume2 size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        </div>
      </div>

      {/* Controls */}
      <div style={{ padding: '16px 20px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Mute button */}
        <button
          onClick={handleMute}
          style={{
            width: '100%', padding: '12px', borderRadius: 12, cursor: 'pointer',
            background: muted ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.06)',
            border: `1px solid ${muted ? 'rgba(239,68,68,0.3)' : 'rgba(255,255,255,0.08)'}`,
            color: muted ? '#f87171' : 'var(--text-secondary)',
            fontSize: '0.88rem', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            transition: 'all 0.15s',
          }}
        >
          {muted ? <><VolumeX size={16} /> Unmute</> : <><VolumeX size={16} /> Mute</>}
        </button>

        {/* Presets */}
        <div>
          <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Quick Set</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {PRESETS.map(p => (
              <button
                key={p.label}
                onClick={() => handlePreset(p.value)}
                style={{
                  flex: 1, padding: '8px 4px', borderRadius: 10, border: '1px solid',
                  borderColor: volume === p.value && !muted ? 'rgba(96,165,250,0.5)' : 'rgba(255,255,255,0.07)',
                  background: volume === p.value && !muted ? 'rgba(37,99,235,0.2)' : 'rgba(255,255,255,0.04)',
                  color: volume === p.value && !muted ? '#93c5fd' : 'var(--text-muted)',
                  fontSize: '0.7rem', fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                }}
              >
                <span style={{ fontSize: '0.78rem' }}>{p.value}%</span>
                <span style={{ fontSize: '0.62rem', opacity: 0.7 }}>{p.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {toast && (
        <div style={{ position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)', padding: '7px 16px', borderRadius: 20, background: 'rgba(37,99,235,0.25)', border: '1px solid rgba(96,165,250,0.35)', color: '#93c5fd', fontSize: '0.8rem', fontWeight: 600, whiteSpace: 'nowrap', zIndex: 10 }}>
          {toast}
        </div>
      )}
    </div>
  )
}
