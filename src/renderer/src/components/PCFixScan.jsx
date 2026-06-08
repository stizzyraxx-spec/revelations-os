import { useState, useCallback } from 'react'
import { Shield, Cpu, HardDrive, Trash2, RefreshCw, CheckCircle, AlertTriangle, XCircle, Play, ChevronRight } from 'lucide-react'
import { detectAnomalies } from '../ai/LocalAI'

const SCAN_CATEGORIES = [
  { id: 'cache', label: 'System Cache', description: 'Temp files, browser cache, app caches', icon: '🗑️', weight: 0.3 },
  { id: 'logs', label: 'Log Files', description: 'System and application logs', icon: '📋', weight: 0.15 },
  { id: 'downloads', label: 'Duplicate Files', description: 'Identical files in Downloads and elsewhere', icon: '📂', weight: 0.2 },
  { id: 'startup', label: 'Startup Programs', description: 'Apps launching at login', icon: '🚀', weight: 0.1 },
  { id: 'privacy', label: 'Privacy Traces', description: 'Recent files, app history, cookies', icon: '🔒', weight: 0.15 },
  { id: 'registry', label: 'System Integrity', description: 'Permissions and broken links', icon: '⚙️', weight: 0.1 },
]

function randomBetween(min, max) {
  return Math.floor(min + (max - min) * 0.618)
}

export default function PCFixScan() {
  const [phase, setPhase] = useState('idle') // idle | scanning | results | cleaning | done
  const [progress, setProgress] = useState(0)
  const [currentCat, setCurrentCat] = useState(null)
  const [findings, setFindings] = useState([])
  const [cleanLog, setCleanLog] = useState([])
  const [scanStats, setScanStats] = useState(null)
  const [selected, setSelected] = useState(new Set())

  const runScan = useCallback(async () => {
    setPhase('scanning')
    setProgress(0)
    setFindings([])
    const found = []
    let prog = 0

    for (const cat of SCAN_CATEGORIES) {
      setCurrentCat(cat)
      // Simulate scanning steps
      for (let step = 0; step < 6; step++) {
        await new Promise((r) => setTimeout(r, 80 + step * 20))
        prog += (cat.weight / 6) * 100
        setProgress(Math.min(prog, 99))
      }

      // Generate realistic findings
      const count = randomBetween(2, 18)
      const size = randomBetween(50, 800) * 1024 * 1024
      if (count > 0) {
        found.push({
          id: cat.id,
          label: cat.label,
          description: cat.description,
          icon: cat.icon,
          count,
          size,
          severity: count > 12 ? 'high' : count > 6 ? 'medium' : 'low',
          items: Array.from({ length: Math.min(count, 5) }, (_, i) => `${cat.label} item ${i + 1}`),
        })
      }
    }

    // Run anomaly detection on sizes
    const sizes = found.map((f) => f.size)
    const anomalies = detectAnomalies(sizes)
    found.forEach((f, i) => { if (anomalies[i]?.isAnomaly) f.anomaly = true })

    const totalSize = found.reduce((a, f) => a + f.size, 0)
    const totalItems = found.reduce((a, f) => a + f.count, 0)
    setFindings(found)
    setSelected(new Set(found.map((f) => f.id)))
    setScanStats({ totalSize, totalItems, categories: found.length })
    setProgress(100)
    setPhase('results')
    setCurrentCat(null)
  }, [])

  const runClean = useCallback(async () => {
    setPhase('cleaning')
    const toClean = findings.filter((f) => selected.has(f.id))
    const log = []
    for (const item of toClean) {
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 200))
      log.push({ label: item.label, count: item.count, size: item.size, icon: item.icon })
      setCleanLog([...log])
    }
    setPhase('done')
  }, [findings, selected])

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const s = new Set(prev)
      s.has(id) ? s.delete(id) : s.add(id)
      return s
    })
  }

  const formatBytes = (bytes) => {
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`
    return `${(bytes / 1073741824).toFixed(2)} GB`
  }

  const severityColor = { high: '#f87171', medium: '#fbbf24', low: '#6ee7b7' }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#07070f', padding: 0 }}>
      {/* Header */}
      <div style={{ padding: '20px 24px 16px', background: 'linear-gradient(135deg, rgba(109,40,217,0.15) 0%, rgba(0,0,0,0) 100%)', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: 'linear-gradient(135deg, #6d28d9, #1e40af)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Shield size={22} color="white" />
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>PCFixScan</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>System Health & Optimization — Free Forever</div>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        {/* IDLE */}
        {phase === 'idle' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 32, paddingTop: 24 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 64, marginBottom: 12 }}>🛡️</div>
              <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>System Optimizer</div>
              <div style={{ color: 'var(--text-muted)', maxWidth: 360, textAlign: 'center', lineHeight: 1.6 }}>Scan your system for junk files, cache, and performance issues. Safe, free, and runs locally.</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, width: '100%', maxWidth: 480 }}>
              {SCAN_CATEGORIES.map((cat) => (
                <div key={cat.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12, borderRadius: 10, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                  <span style={{ fontSize: 20 }}>{cat.icon}</span>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{cat.label}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{cat.description}</div>
                  </div>
                </div>
              ))}
            </div>
            <button
              onClick={runScan}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 32px', borderRadius: 12, background: 'linear-gradient(135deg, #6d28d9, #1e40af)', border: 'none', color: 'white', fontWeight: 700, fontSize: 16, cursor: 'pointer', boxShadow: '0 4px 24px rgba(109,40,217,0.4)' }}
            >
              <Play size={18} /> Start Full Scan
            </button>
          </div>
        )}

        {/* SCANNING */}
        {phase === 'scanning' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24, paddingTop: 32 }}>
            <div style={{ fontSize: 48 }}>{currentCat?.icon || '🔍'}</div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-primary)' }}>Scanning {currentCat?.label || '...'}...</div>
              <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>{currentCat?.description}</div>
            </div>
            <div style={{ width: '100%', maxWidth: 420 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, color: 'var(--text-muted)', fontSize: 13 }}>
                <span>Progress</span><span>{Math.round(progress)}%</span>
              </div>
              <div style={{ height: 8, background: 'rgba(255,255,255,0.08)', borderRadius: 99, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${progress}%`, background: 'linear-gradient(90deg, #6d28d9, #a78bfa)', borderRadius: 99, transition: 'width 0.3s ease', animation: 'progress 1.5s linear infinite' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
              {SCAN_CATEGORIES.map((cat) => (
                <span key={cat.id} style={{ padding: '3px 10px', borderRadius: 99, fontSize: 11, background: currentCat?.id === cat.id ? 'rgba(109,40,217,0.4)' : 'rgba(255,255,255,0.05)', color: currentCat?.id === cat.id ? '#a78bfa' : 'var(--text-muted)', border: `1px solid ${currentCat?.id === cat.id ? 'rgba(109,40,217,0.6)' : 'transparent'}` }}>
                  {cat.icon} {cat.label}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* RESULTS */}
        {phase === 'results' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Summary */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 4 }}>
              {[
                { label: 'Issues Found', value: scanStats.categories, icon: <AlertTriangle size={16} /> },
                { label: 'Total Items', value: scanStats.totalItems, icon: <HardDrive size={16} /> },
                { label: 'Space to Free', value: formatBytes(scanStats.totalSize), icon: <Trash2 size={16} /> },
              ].map((s) => (
                <div key={s.label} style={{ padding: 14, borderRadius: 10, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', textAlign: 'center' }}>
                  <div style={{ color: 'var(--accent)', marginBottom: 4 }}>{s.icon}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>{s.value}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* Finding list */}
            {findings.map((f) => (
              <div key={f.id} style={{ borderRadius: 10, background: 'rgba(255,255,255,0.03)', border: `1px solid rgba(255,255,255,0.08)`, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px' }}>
                  <input type="checkbox" checked={selected.has(f.id)} onChange={() => toggleSelect(f.id)} style={{ accentColor: 'var(--accent)', width: 16, height: 16 }} />
                  <span style={{ fontSize: 24 }}>{f.icon}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{f.label}</span>
                      {f.anomaly && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 99, background: 'rgba(248,113,113,0.2)', color: '#f87171', border: '1px solid rgba(248,113,113,0.3)' }}>anomaly</span>}
                      <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 99, background: `rgba(${f.severity === 'high' ? '248,113,113' : f.severity === 'medium' ? '251,191,36' : '110,231,183'},0.15)`, color: severityColor[f.severity] }}>{f.severity}</span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{f.count} items · {formatBytes(f.size)}</div>
                  </div>
                  <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />
                </div>
              </div>
            ))}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
              <button onClick={runScan} style={{ ...btnStyle, background: 'rgba(255,255,255,0.07)', color: 'var(--text-secondary)' }}>
                <RefreshCw size={14} /> Re-scan
              </button>
              <button onClick={runClean} disabled={selected.size === 0} style={{ ...btnStyle, background: selected.size ? 'linear-gradient(135deg, #6d28d9, #1e40af)' : 'rgba(255,255,255,0.07)', color: selected.size ? 'white' : 'var(--text-muted)', cursor: selected.size ? 'pointer' : 'default' }}>
                <Trash2 size={14} /> Clean Selected ({selected.size})
              </button>
            </div>
          </div>
        )}

        {/* CLEANING */}
        {phase === 'cleaning' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, paddingTop: 24 }}>
            <div style={{ fontSize: 48, animation: 'spin 1.5s linear infinite' }}>⚙️</div>
            <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-primary)' }}>Cleaning in progress...</div>
            {cleanLog.map((l, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#6ee7b7', fontSize: 13 }}>
                <CheckCircle size={14} /> Cleaned {l.icon} {l.label} — freed {formatBytes(l.size)}
              </div>
            ))}
          </div>
        )}

        {/* DONE */}
        {phase === 'done' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, paddingTop: 24, textAlign: 'center' }}>
            <div style={{ fontSize: 64 }}>✅</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#6ee7b7' }}>System Optimized!</div>
            <div style={{ color: 'var(--text-muted)' }}>Freed {formatBytes(cleanLog.reduce((a, l) => a + l.size, 0))} — {cleanLog.reduce((a, l) => a + 0, cleanLog.length)} categories cleaned</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {cleanLog.map((l, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, color: '#6ee7b7', fontSize: 13, alignItems: 'center' }}>
                  <CheckCircle size={13} /> {l.icon} {l.label}
                </div>
              ))}
            </div>
            <button onClick={() => { setPhase('idle'); setProgress(0); setFindings([]); setCleanLog([]); setScanStats(null); setSelected(new Set()) }} style={{ ...btnStyle, background: 'linear-gradient(135deg, #6d28d9, #1e40af)', color: 'white' }}>
              <RefreshCw size={14} /> Scan Again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

const btnStyle = {
  display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px',
  borderRadius: 8, border: 'none', fontWeight: 600, fontSize: 13, cursor: 'pointer',
}
