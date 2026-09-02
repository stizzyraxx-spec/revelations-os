import { useState, useEffect, useCallback } from 'react'
import { Bluetooth, BluetoothOff, Smartphone, Headphones, Laptop, Keyboard, Mouse, RefreshCw, CheckCircle2 } from 'lucide-react'
import { IS_WIN } from '../platform'

// Connect/disconnect needs blueutil on macOS and has no stock equivalent on
// Windows — point each platform at the right remedy instead of at Homebrew.
const NO_CONTROL_MSG = IS_WIN
  ? 'Pair and connect devices from Windows Bluetooth settings'
  : 'Install blueutil for device control'

function deviceIcon(type) {
  const t = (type || '').toLowerCase()
  if (t.includes('phone') || t.includes('iphone')) return Smartphone
  if (t.includes('headphone') || t.includes('audio') || t.includes('airpod')) return Headphones
  if (t.includes('keyboard')) return Keyboard
  if (t.includes('mouse') || t.includes('trackpad')) return Mouse
  if (t.includes('computer') || t.includes('mac')) return Laptop
  return Bluetooth
}

function DeviceRow({ device, onConnect, onDisconnect, loading }) {
  const Icon = deviceIcon(device.type)
  const isLoading = loading === device.address
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px',
      borderRadius: 10, marginBottom: 6,
      background: device.connected ? 'rgba(37,99,235,0.12)' : 'rgba(255,255,255,0.04)',
      border: `1px solid ${device.connected ? 'rgba(96,165,250,0.3)' : 'rgba(255,255,255,0.07)'}`,
    }}>
      <div style={{ width: 36, height: 36, borderRadius: 10, background: device.connected ? 'rgba(37,99,235,0.2)' : 'rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon size={18} style={{ color: device.connected ? '#60a5fa' : 'var(--text-muted)' }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#f1f5f9', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{device.name}</div>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 1 }}>
          {device.connected ? 'Connected' : 'Paired'}{device.battery ? ` · ${device.battery}` : ''}
        </div>
      </div>
      {device.connected ? (
        <button
          onClick={() => onDisconnect(device.address)}
          disabled={isLoading}
          style={{ padding: '4px 12px', borderRadius: 16, background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}
        >
          {isLoading ? '…' : 'Disconnect'}
        </button>
      ) : (
        <button
          onClick={() => onConnect(device.address)}
          disabled={isLoading}
          style={{ padding: '4px 12px', borderRadius: 16, background: 'rgba(37,99,235,0.8)', border: 'none', color: '#fff', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}
        >
          {isLoading ? '…' : 'Connect'}
        </button>
      )}
    </div>
  )
}

export default function BluetoothPanel() {
  const [state, setState] = useState(null)
  const [loading, setLoading] = useState(null)
  const [toggling, setToggling] = useState(false)
  const [toast, setToast] = useState(null)

  const showToast = (msg, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 3000) }

  const load = useCallback(async () => {
    const s = await window.nexus?.btStatus()
    if (s) setState(s)
  }, [])

  useEffect(() => { load() }, [])

  // macOS drives the radio through blueutil; Windows has no stock CLI for it, so
  // the main process opens the Windows Bluetooth settings instead. Either way
  // there is something to do, so the switch stays live on both platforms.
  const canToggle = !!state?.hasBlueutil || IS_WIN

  const handleToggle = async () => {
    if (!canToggle) return
    setToggling(true)
    const r = await window.nexus?.btToggle(!state.powered)
    if (r?.openedSettings) showToast('Opened Windows Bluetooth settings')
    await new Promise(r => setTimeout(r, 800))
    await load()
    setToggling(false)
  }

  const handleConnect = async (address) => {
    if (!state?.hasBlueutil) { showToast(NO_CONTROL_MSG, false); return }
    setLoading(address)
    const r = await window.nexus?.btConnect(address)
    setLoading(null)
    if (r?.ok) { showToast('Connected'); await load() }
    else showToast('Connection failed', false)
  }

  const handleDisconnect = async (address) => {
    if (!state?.hasBlueutil) { showToast(NO_CONTROL_MSG, false); return }
    setLoading(address)
    const r = await window.nexus?.btDisconnect(address)
    setLoading(null)
    if (r?.ok) { showToast('Disconnected'); await load() }
    else showToast('Failed to disconnect', false)
  }

  const connected = state?.devices.filter(d => d.connected) || []
  const paired = state?.devices.filter(d => !d.connected) || []

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>
      {/* Header */}
      <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Bluetooth size={20} style={{ color: '#60a5fa' }} />
            <span style={{ fontSize: '1.05rem', fontWeight: 700 }}>Bluetooth</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={load} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}>
              <RefreshCw size={14} />
            </button>
            {/* Power toggle */}
            <button
              onClick={handleToggle}
              disabled={toggling || !canToggle}
              title={state?.hasBlueutil ? 'Toggle Bluetooth' : IS_WIN ? 'Open Windows Bluetooth settings' : 'Install blueutil via Homebrew to toggle'}
              style={{
                width: 44, height: 24, borderRadius: 12, border: 'none', cursor: canToggle ? 'pointer' : 'default',
                background: state?.powered ? '#2563eb' : 'rgba(255,255,255,0.12)',
                position: 'relative', transition: 'background 0.2s', flexShrink: 0,
              }}
            >
              <div style={{
                position: 'absolute', top: 3, left: state?.powered ? 22 : 2,
                width: 18, height: 18, borderRadius: '50%', background: '#fff',
                transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
              }} />
            </button>
          </div>
        </div>

        {!state?.hasBlueutil && (
          <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.2)', fontSize: '0.72rem', color: '#fbbf24' }}>
            {IS_WIN ? (
              <>Windows has no command-line Bluetooth control — the switch above opens Windows Bluetooth settings, where you can pair and connect devices.</>
            ) : (
              <>Install blueutil for full control: <code style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: 4 }}>brew install blueutil</code></>
            )}
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px 20px' }}>
        {!state && <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '40px 0', fontSize: '0.85rem' }}>Loading…</div>}

        {state && !state.powered && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '40px 0' }}>
            <BluetoothOff size={32} style={{ marginBottom: 12, opacity: 0.4 }} />
            <div style={{ fontSize: '0.85rem' }}>Bluetooth is off</div>
          </div>
        )}

        {state?.powered && (
          <>
            {connected.length > 0 && (
              <>
                <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Connected</div>
                {connected.map(d => <DeviceRow key={d.address} device={d} onConnect={handleConnect} onDisconnect={handleDisconnect} loading={loading} />)}
              </>
            )}
            {paired.length > 0 && (
              <>
                <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '14px 0 8px' }}>Paired Devices</div>
                {paired.map(d => <DeviceRow key={d.address} device={d} onConnect={handleConnect} onDisconnect={handleDisconnect} loading={loading} />)}
              </>
            )}
            {connected.length === 0 && paired.length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '40px 0', fontSize: '0.85rem' }}>No paired devices found</div>
            )}
          </>
        )}
      </div>

      {toast && (
        <div style={{ position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)', padding: '8px 18px', borderRadius: 20, background: toast.ok ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)', border: `1px solid ${toast.ok ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)'}`, color: toast.ok ? '#86efac' : '#fca5a5', fontSize: '0.8rem', fontWeight: 600, whiteSpace: 'nowrap', zIndex: 10 }}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
