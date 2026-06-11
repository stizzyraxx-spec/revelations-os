import { useState } from 'react'
import { Download, X, RefreshCw } from 'lucide-react'
import { useOSStore } from '../store'

export default function UpdateBanner() {
  const { pendingUpdate, setPendingUpdate, addNotification } = useOSStore()
  const [installing, setInstalling] = useState(false)

  if (!pendingUpdate) return null

  const install = async () => {
    setInstalling(true)
    try {
      await window.nexus?.applyUpdate?.()
      addNotification({ title: 'Update', body: 'Update applied — restart to finish.', type: 'success' })
      setPendingUpdate(null)
    } catch {
      addNotification({ title: 'Update Failed', body: 'Could not apply the update. Try again later.', type: 'error' })
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="glass-strong animate-fade-in-down" style={{
      position: 'fixed', top: 48, left: '50%', transform: 'translateX(-50%)', zIndex: 9500,
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
      borderRadius: 12, border: '1px solid var(--border-accent)', boxShadow: 'var(--shadow-glow)',
    }}>
      <Download size={16} style={{ color: 'var(--accent)', flexShrink: 0 }} />
      <div style={{ fontSize: '0.82rem', color: 'var(--text-primary)' }}>
        <strong>Update available</strong>
        {pendingUpdate.version ? ` — v${pendingUpdate.version}` : ''}
      </div>
      <button onClick={install} disabled={installing} className="btn-primary" style={{ padding: '5px 14px', fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: 5 }}>
        {installing ? <RefreshCw size={12} className="animate-spin" /> : <Download size={12} />}
        {installing ? 'Installing…' : 'Install'}
      </button>
      <button onClick={() => setPendingUpdate(null)} title="Dismiss" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 3, display: 'flex' }}>
        <X size={14} />
      </button>
    </div>
  )
}
