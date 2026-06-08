import { useState, useEffect } from 'react'
import { Battery, BatteryCharging, BatteryFull, Zap, RefreshCw, Thermometer } from 'lucide-react'

function BatteryGauge({ pct, charging }) {
  const color = pct > 50 ? '#22c55e' : pct > 20 ? '#f59e0b' : '#ef4444'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ position: 'relative', width: 140, height: 28, borderRadius: 6, border: '2px solid rgba(255,255,255,0.2)', overflow: 'hidden', background: 'rgba(255,255,255,0.05)' }}>
        <div style={{ position: 'absolute', inset: 0, width: `${pct}%`, background: color, borderRadius: 4, transition: 'width 0.6s ease' }} />
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.78rem', fontWeight: 700, color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,0.6)' }}>
          {pct}%
        </div>
      </div>
      {/* Terminal nub */}
      <div style={{ width: 5, height: 12, borderRadius: '0 3px 3px 0', background: 'rgba(255,255,255,0.2)' }} />
      {charging && <Zap size={14} style={{ color: '#fbbf24', marginLeft: 2 }} />}
    </div>
  )
}

function Stat({ label, value, sub }) {
  return (
    <div style={{ padding: '12px 14px', borderRadius: 10, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#f1f5f9' }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function healthColor(pct) {
  if (!pct) return 'var(--text-muted)'
  return pct >= 80 ? '#22c55e' : pct >= 60 ? '#f59e0b' : '#ef4444'
}

export default function BatteryPanel() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    const s = await window.nexus?.batteryStatus()
    if (s) setData(s)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const statusLabel = (s) => {
    if (!s) return '—'
    if (s.includes('charg') && !s.includes('discharg')) return 'Charging'
    if (s.includes('discharg')) return 'On Battery'
    if (s.includes('finish') || s.includes('full') || s.includes('charged')) return 'Fully Charged'
    return s
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>
      {/* Header */}
      <div style={{ padding: '18px 20px 16px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {data?.onAC ? <BatteryCharging size={20} style={{ color: '#22c55e' }} /> : <Battery size={20} style={{ color: '#60a5fa' }} />}
            <span style={{ fontSize: '1.05rem', fontWeight: 700 }}>Battery</span>
          </div>
          <button onClick={load} disabled={loading} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}>
            <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          </button>
        </div>

        {data?.percentage != null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <BatteryGauge pct={data.percentage} charging={data.onAC && data.status?.includes('charg')} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{statusLabel(data.status)}</div>
              {data.onAC && <span style={{ fontSize: '0.68rem', color: '#22c55e', background: 'rgba(34,197,94,0.1)', padding: '1px 7px', borderRadius: 10, border: '1px solid rgba(34,197,94,0.2)' }}>AC Power</span>}
            </div>
            {data.timeRemaining && (
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                {data.onAC && data.status?.includes('charg') ? `Full in ${data.timeRemaining}` : `${data.timeRemaining} remaining`}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Stats grid */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px 20px' }}>
        {!data && <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '40px 0', fontSize: '0.85rem' }}>Loading…</div>}

        {data && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Stat
              label="Battery Health"
              value={data.healthPct ? <span style={{ color: healthColor(data.healthPct) }}>{data.healthPct}%</span> : '—'}
              sub={data.healthPct >= 80 ? 'Good' : data.healthPct >= 60 ? 'Fair' : data.healthPct ? 'Replace Soon' : 'N/A'}
            />
            <Stat
              label="Cycle Count"
              value={data.cycleCount ?? '—'}
              sub={data.cycleCount ? (data.cycleCount < 500 ? 'Low usage' : data.cycleCount < 900 ? 'Moderate usage' : 'High usage') : ''}
            />
            <Stat
              label="Power Source"
              value={data.onAC ? 'AC Power' : 'Battery'}
              sub={data.onAC ? 'Plugged in' : 'Unplugged'}
            />
            <Stat
              label="Temperature"
              value={data.tempC ? `${data.tempC}°C` : '—'}
              sub={data.tempC ? `${(parseFloat(data.tempC) * 9/5 + 32).toFixed(1)}°F` : ''}
            />
          </div>
        )}

        {data && (
          <div style={{ marginTop: 14, padding: '12px 14px', borderRadius: 10, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
            💡 Battery health degrades below 80% after ~500–1000 charge cycles. Apple recommends replacement under 80%.
          </div>
        )}
      </div>
    </div>
  )
}
