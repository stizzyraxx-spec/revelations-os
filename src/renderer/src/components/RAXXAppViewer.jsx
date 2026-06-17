import { useState, useRef } from 'react'
import { RotateCcw, X, ExternalLink, ArrowLeft, ArrowRight, Lock, Globe } from 'lucide-react'


export default function RAXXAppViewer({ url, title, appId }) {
  const [loading, setLoading] = useState(true)
  const [currentUrl, setCurrentUrl] = useState(url)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [error, setError] = useState(null)
  const wvRef = useRef(null)

  const isSecure = currentUrl.startsWith('https://')

  const setupListeners = (wv) => {
    if (!wv) return
    wvRef.current = wv
    wv.addEventListener('did-start-loading', () => { setLoading(true); setError(null) })
    wv.addEventListener('did-stop-loading', () => {
      setLoading(false)
      setCanBack(wv.canGoBack())
      setCanForward(wv.canGoForward())
    })
    wv.addEventListener('did-navigate', (e) => setCurrentUrl(e.url))
    wv.addEventListener('did-navigate-in-page', (e) => setCurrentUrl(e.url))
    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode !== -3) setError(`Failed to load: ${e.errorDescription}`)
      setLoading(false)
    })
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#09090f' }}>
      {/* Mini nav bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: 'rgba(0,0,0,0.4)', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        <button onClick={() => wvRef.current?.goBack()} disabled={!canBack} style={navBtn(!canBack)}><ArrowLeft size={13} /></button>
        <button onClick={() => wvRef.current?.goForward()} disabled={!canForward} style={navBtn(!canForward)}><ArrowRight size={13} /></button>
        <button onClick={() => wvRef.current?.reload()} style={navBtn(false)}>
          {loading ? <X size={12} /> : <RotateCcw size={12} />}
        </button>

        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 6, padding: '4px 10px' }}>
          {isSecure ? <Lock size={11} style={{ color: '#6ee7b7', flexShrink: 0 }} /> : <Globe size={11} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />}
          <span style={{ flex: 1, fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentUrl}</span>
          {loading && <div style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid var(--accent)', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />}
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '2px 8px', borderRadius: 4, background: 'rgba(109,40,217,0.15)', border: '1px solid rgba(109,40,217,0.25)' }}>
          Live
        </div>
      </div>

      {/* Webview */}
      <div style={{ flex: 1, position: 'relative' }}>
        {error ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, color: '#f87171' }}>
            <div style={{ fontSize: 40 }}>⚠️</div>
            <div style={{ fontWeight: 600 }}>{title} is unreachable</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', maxWidth: 300 }}>{error}</div>
            <button onClick={() => { setError(null); wvRef.current?.reload() }} style={{ padding: '7px 18px', borderRadius: 8, background: 'rgba(109,40,217,0.3)', border: '1px solid rgba(109,40,217,0.5)', color: 'var(--accent)', cursor: 'pointer', fontSize: 13 }}>
              Retry
            </button>
          </div>
        ) : (
          <webview
            ref={setupListeners}
            src={url}
            partition={`persist:raxx_${appId}`}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none' }}
            webpreferences="allowRunningInsecureContent=no"
          />
        )}
      </div>
    </div>
  )
}

const navBtn = (disabled) => ({
  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)',
  color: disabled ? 'rgba(255,255,255,0.2)' : 'var(--text-secondary)',
  cursor: disabled ? 'default' : 'pointer', padding: '5px 8px', borderRadius: 6,
  display: 'flex', alignItems: 'center',
})
