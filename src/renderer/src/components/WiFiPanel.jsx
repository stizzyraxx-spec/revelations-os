import { useState, useEffect, useCallback } from 'react'
import { Wifi, WifiOff, Lock, RefreshCw, CheckCircle2, XCircle, Eye, EyeOff } from 'lucide-react'

function SignalBars({ rssi }) {
  const strength = rssi >= -50 ? 4 : rssi >= -60 ? 3 : rssi >= -70 ? 2 : 1
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 16 }}>
      {[1, 2, 3, 4].map(i => (
        <div key={i} style={{
          width: 4,
          height: 4 + i * 3,
          borderRadius: 2,
          background: i <= strength ? '#60a5fa' : 'rgba(255,255,255,0.15)',
        }} />
      ))}
    </div>
  )
}

function NetworkRow({ net, currentSsid, onConnect, connecting }) {
  const [showPw, setShowPw] = useState(false)
  const [pw, setPw] = useState('')
  const [expanded, setExpanded] = useState(false)
  const isConnected = net.ssid === currentSsid

  const handleConnect = () => {
    if (net.secured && !pw.trim()) { setExpanded(true); return }
    onConnect(net.ssid, net.secured ? pw : undefined)
    setPw('')
    setExpanded(false)
  }

  return (
    <div style={{
      borderRadius: 10,
      background: isConnected ? 'rgba(37,99,235,0.15)' : 'rgba(255,255,255,0.04)',
      border: `1px solid ${isConnected ? 'rgba(96,165,250,0.35)' : 'rgba(255,255,255,0.07)'}`,
      marginBottom: 6,
      overflow: 'hidden',
      transition: 'all 0.2s ease',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px' }}>
        <SignalBars rssi={net.rssi} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#f1f5f9', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {net.ssid}
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 1 }}>
            {net.rssi} dBm {net.security !== 'NONE' ? `· ${net.security.split('(')[0]}` : '· Open'}
          </div>
        </div>
        {net.secured && <Lock size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />}
        {isConnected ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#60a5fa', fontSize: '0.75rem', fontWeight: 600 }}>
            <CheckCircle2 size={14} /> Connected
          </div>
        ) : (
          <button
            onClick={handleConnect}
            disabled={connecting === net.ssid}
            style={{
              padding: '5px 14px', borderRadius: 20, fontSize: '0.75rem', fontWeight: 600,
              background: connecting === net.ssid ? 'rgba(255,255,255,0.08)' : 'rgba(37,99,235,0.8)',
              color: '#fff', border: 'none', cursor: connecting === net.ssid ? 'default' : 'pointer',
              flexShrink: 0, transition: 'background 0.15s',
            }}
          >
            {connecting === net.ssid ? 'Connecting…' : 'Connect'}
          </button>
        )}
      </div>

      {/* Password input — expands inline for secured networks */}
      {expanded && net.secured && !isConnected && (
        <div style={{ padding: '0 14px 12px', display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <input
              autoFocus
              type={showPw ? 'text' : 'password'}
              value={pw}
              onChange={e => setPw(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleConnect(); if (e.key === 'Escape') { setExpanded(false); setPw('') } }}
              placeholder="Wi-Fi Password"
              style={{
                width: '100%', height: 36, paddingLeft: 12, paddingRight: 36,
                borderRadius: 8, background: 'rgba(255,255,255,0.07)',
                border: '1px solid rgba(255,255,255,0.12)', color: '#f1f5f9',
                fontSize: '0.85rem', outline: 'none', boxSizing: 'border-box',
              }}
            />
            <button
              onClick={() => setShowPw(v => !v)}
              style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2, display: 'flex' }}
            >
              {showPw ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
          <button
            onClick={handleConnect}
            style={{ padding: '8px 16px', borderRadius: 8, background: '#2563eb', color: '#fff', border: 'none', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600, flexShrink: 0 }}
          >
            Join
          </button>
          <button
            onClick={() => { setExpanded(false); setPw('') }}
            style={{ padding: '8px', borderRadius: 8, background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)', border: 'none', cursor: 'pointer', display: 'flex' }}
          >
            <XCircle size={16} />
          </button>
        </div>
      )}
    </div>
  )
}

export default function WiFiPanel() {
  const [status, setStatus] = useState(null)
  const [networks, setNetworks] = useState([])
  const [scanning, setScanning] = useState(false)
  const [connecting, setConnecting] = useState(null)
  const [toast, setToast] = useState(null)
  const [scanError, setScanError] = useState(null)

  const showToast = (msg, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3500)
  }

  const loadStatus = useCallback(async () => {
    const s = await window.nexus?.wifiStatus()
    if (s) setStatus(s)
  }, [])

  const scan = useCallback(async () => {
    setScanning(true)
    setScanError(null)
    const result = await window.nexus?.wifiScan()
    setScanning(false)
    if (result?.ok) {
      const sorted = result.networks.sort((a, b) => b.rssi - a.rssi)
      setNetworks(sorted)
    } else {
      setScanError('Scan failed. Make sure Wi-Fi is on.')
    }
  }, [])

  useEffect(() => {
    loadStatus()
    scan()
  }, [])

  const handleConnect = async (ssid, password) => {
    setConnecting(ssid)
    const result = await window.nexus?.wifiConnect(ssid, password)
    setConnecting(null)
    if (result?.ok) {
      showToast(`Connected to ${ssid}`)
      await loadStatus()
    } else {
      showToast(result?.error?.includes('timeout') ? 'Connection timed out.' : 'Failed — check the password and try again.', false)
    }
  }

  const handleDisconnect = async () => {
    const result = await window.nexus?.wifiDisconnect()
    if (result?.ok) {
      showToast('Disconnected')
      setStatus({ connected: false, ssid: null })
    } else {
      showToast('Could not disconnect.', false)
    }
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontFamily: 'var(--font-sans)' }}>
      {/* Header */}
      <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Wifi size={20} style={{ color: '#60a5fa' }} />
          <span style={{ fontSize: '1.05rem', fontWeight: 700 }}>Wi-Fi</span>
        </div>

        {/* Current connection */}
        <div style={{ marginTop: 14, padding: '12px 14px', borderRadius: 12, background: status?.connected ? 'rgba(37,99,235,0.12)' : 'rgba(255,255,255,0.04)', border: `1px solid ${status?.connected ? 'rgba(96,165,250,0.3)' : 'rgba(255,255,255,0.07)'}` }}>
          {status?.connected ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e' }} />
                <div>
                  <div style={{ fontSize: '0.82rem', fontWeight: 600 }}>{status.ssid}</div>
                  <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 1 }}>Connected</div>
                </div>
              </div>
              <button
                onClick={handleDisconnect}
                style={{ padding: '4px 12px', borderRadius: 16, background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer' }}
              >
                Disconnect
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)' }}>
              <WifiOff size={14} />
              <span style={{ fontSize: '0.82rem' }}>Not connected</span>
            </div>
          )}
        </div>
      </div>

      {/* Network list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Available Networks {networks.length > 0 && `(${networks.length})`}
          </span>
          <button
            onClick={scan}
            disabled={scanning}
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 16, background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: '0.72rem', cursor: scanning ? 'default' : 'pointer' }}
          >
            <RefreshCw size={12} style={{ animation: scanning ? 'spin 1s linear infinite' : 'none' }} />
            {scanning ? 'Scanning…' : 'Refresh'}
          </button>
        </div>

        {scanError && (
          <div style={{ padding: '12px 14px', borderRadius: 10, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171', fontSize: '0.8rem', marginBottom: 10 }}>
            {scanError}
          </div>
        )}

        {scanning && networks.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem', padding: '32px 0' }}>
            Scanning for networks…
          </div>
        )}

        {!scanning && networks.length === 0 && !scanError && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem', padding: '32px 0' }}>
            No networks found. Click Refresh to scan.
          </div>
        )}

        {networks.map(net => (
          <NetworkRow
            key={net.bssid}
            net={net}
            currentSsid={status?.ssid}
            onConnect={handleConnect}
            connecting={connecting}
          />
        ))}
      </div>

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)',
          padding: '8px 18px', borderRadius: 20,
          background: toast.ok ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)',
          border: `1px solid ${toast.ok ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)'}`,
          color: toast.ok ? '#86efac' : '#fca5a5',
          fontSize: '0.8rem', fontWeight: 600, whiteSpace: 'nowrap',
          zIndex: 10,
        }}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
