import { useEffect, useState } from 'react'
import { Download, X, RefreshCw, ExternalLink, Check } from 'lucide-react'
import { useOSStore } from '../store'

// Updates apply themselves: main checks in the background, downloads the
// installer and runs it silently when Revelations exits. This banner only
// reports that — the one button is a shortcut for "do it now" rather than a
// step the user has to take for the update to land.
export default function UpdateBanner() {
  const { pendingUpdate, setPendingUpdate, addNotification } = useOSStore()
  const [installing, setInstalling] = useState(false)
  const [percent, setPercent] = useState(0)
  const [auto, setAuto] = useState(null) // { status, version, silent }

  // Main streams download progress while a manual install comes down.
  useEffect(() => {
    if (!window.nexus?.onUpdateProgress) return
    return window.nexus.onUpdateProgress((d) => setPercent(d?.percent ?? 0))
  }, [])

  // Background updater state — 'downloading' then 'ready'.
  useEffect(() => {
    if (!window.nexus?.onUpdateState) return
    window.nexus.updateState?.().then(s => { if (s?.pending) setAuto({ status: 'ready', ...s.pending }) }).catch(() => {})
    return window.nexus.onUpdateState((s) => { if (s?.status) setAuto(s) })
  }, [])

  const staged = auto?.status === 'ready'
  if (!pendingUpdate && !staged) return null

  const version = auto?.version || pendingUpdate?.version
  // A release with no installer for this platform can still be opened on the
  // web — offering "Install" there would just fail.
  const canInstall = staged || !!pendingUpdate?.asset

  const install = async () => {
    setInstalling(true)
    setPercent(0)
    try {
      // Already downloaded in the background — this just restarts into it.
      const res = staged
        ? await window.nexus?.restartForUpdate?.()
        : await window.nexus?.applyUpdate?.()
      if (res?.ok) {
        addNotification({ title: 'Update', body: 'Revelations is restarting to finish updating.', type: 'success' })
        setPendingUpdate(null)
      } else {
        addNotification({ title: 'Update Failed', body: res?.error || 'Could not apply the update.', type: 'error' })
        setInstalling(false)
      }
    } catch (e) {
      addNotification({ title: 'Update Failed', body: e?.message || 'Could not apply the update.', type: 'error' })
      setInstalling(false)
    }
  }

  return (
    <div className="glass-strong animate-fade-in-down" style={{
      position: 'fixed', top: 48, left: '50%', transform: 'translateX(-50%)', zIndex: 9500,
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
      borderRadius: 12, border: '1px solid var(--border-accent)', boxShadow: 'var(--shadow-glow)',
      overflow: 'hidden',
    }}>
      {/* Download progress fills the banner behind its contents */}
      {installing && !staged && (
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: `${percent}%`,
          background: 'var(--accent)', opacity: 0.18, transition: 'width 0.25s ease', pointerEvents: 'none',
        }} />
      )}

      {staged
        ? <Check size={16} style={{ color: '#6ee7b7', flexShrink: 0, position: 'relative' }} />
        : <Download size={16} style={{ color: 'var(--accent)', flexShrink: 0, position: 'relative' }} />}
      <div style={{ fontSize: '0.82rem', color: 'var(--text-primary)', position: 'relative' }}>
        {staged ? (
          <>
            <strong>Update ready</strong>{version ? ` — v${version}` : ''}
            <span style={{ color: 'var(--text-muted)' }}>
              {auto?.silent ? ' · installs automatically when you close Revelations' : ' · finishes when you close Revelations'}
            </span>
          </>
        ) : auto?.status === 'downloading' ? (
          <><strong>Downloading update</strong>{version ? ` — v${version}` : ''}<span style={{ color: 'var(--text-muted)' }}> · it will install on its own</span></>
        ) : (
          <>
            <strong>Update available</strong>{version ? ` — v${version}` : ''}
            {installing && percent > 0 ? ` · ${percent}%` : ''}
          </>
        )}
      </div>

      {canInstall ? (
        <button onClick={install} disabled={installing} className="btn-primary" style={{ padding: '5px 14px', fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: 5, position: 'relative' }}>
          {installing ? <RefreshCw size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {installing ? (staged || percent >= 100 ? 'Restarting…' : 'Downloading…') : 'Restart now'}
        </button>
      ) : (
        <button onClick={() => window.nexus?.eventsOpenExternal?.(pendingUpdate?.url)} className="btn-primary" style={{ padding: '5px 14px', fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: 5, position: 'relative' }}>
          <ExternalLink size={12} /> View release
        </button>
      )}

      <button onClick={() => { setPendingUpdate(null); setAuto(null) }} title="Dismiss" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 3, display: 'flex', position: 'relative' }}>
        <X size={14} />
      </button>
    </div>
  )
}
