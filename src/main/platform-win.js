// ─── Windows platform layer ──────────────────────────────────────────────────
// Implements the same contracts as the macOS code paths in index.js, so the
// renderer keeps working unchanged. Everything here is PowerShell/netsh based —
// no extra binaries to install, all present on a stock Windows 10/11.
const os = require('os')
const path = require('path')

// PowerShell invocations are wrapped so a missing/blocked shell degrades to the
// same "unknown" shapes the mac parsers return on failure, never a crash.
function ps(runCmd, script, timeoutMs = 12000) {
  return runCmd(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    timeoutMs
  )
}

// ─── Battery ─────────────────────────────────────────────────────────────────
// Win32_Battery gives charge + status; EstimatedRunTime is minutes (71582788 =
// "unknown", the documented sentinel for AC power).
async function batteryStatus(runCmd) {
  const script = `
$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $b) { '{}' } else {
  $full = Get-CimInstance -Namespace root\\wmi -ClassName BatteryFullChargedCapacity -ErrorAction SilentlyContinue | Select-Object -First 1
  $des  = Get-CimInstance -Namespace root\\wmi -ClassName BatteryStaticData -ErrorAction SilentlyContinue | Select-Object -First 1
  [pscustomobject]@{
    charge = $b.EstimatedChargeRemaining
    status = $b.BatteryStatus
    runtime = $b.EstimatedRunTime
    maxCap = $(if ($full) { $full.FullChargedCapacity } else { $null })
    designCap = $(if ($des) { $des.DesignedCapacity } else { $null })
  } | ConvertTo-Json -Compress
}`
  const { out } = await ps(runCmd, script, 10000)
  try {
    const d = JSON.parse((out || '{}').trim() || '{}')
    if (d.charge == null) return { percentage: null, status: 'unknown', timeRemaining: null, onAC: true, cycleCount: null, healthPct: null, tempC: null }

    // BatteryStatus: 1 = discharging, 2 = on AC. Others are charging variants.
    const onAC = d.status !== 1
    const charging = d.status === 2 ? false : (onAC && d.charge < 100)

    // EstimatedRunTime is minutes; the sentinel means "not discharging".
    let timeRemaining = null
    if (d.runtime != null && d.runtime > 0 && d.runtime < 71582788) {
      const h = Math.floor(d.runtime / 60)
      const m = d.runtime % 60
      timeRemaining = `${h}:${String(m).padStart(2, '0')}`
    }

    return {
      percentage: d.charge,
      status: d.status === 1 ? 'discharging' : (charging ? 'charging' : 'charged'),
      timeRemaining,
      onAC,
      cycleCount: null, // Windows does not expose this via WMI
      healthPct: (d.designCap && d.maxCap) ? Math.round((d.maxCap / d.designCap) * 100) : null,
      tempC: null, // no reliable stock WMI source
    }
  } catch {
    return { percentage: null, status: 'unknown', timeRemaining: null, onAC: true, cycleCount: null, healthPct: null, tempC: null }
  }
}

// ─── Volume ──────────────────────────────────────────────────────────────────
// Drives the real endpoint via the IAudioEndpointVolume COM interface, compiled
// inline with Add-Type. This is the only stock way to read/set system volume;
// the alternative (SendKeys VK_VOLUME_*) can't read a level or set an absolute one.
const AUDIO_COM = `
if (-not ([System.Management.Automation.PSTypeName]'RevAudio').Type) {
Add-Type -Language CSharp @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
  int j();
  int GetMasterVolumeLevelScalar(out float level);
  int k(); int l();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
  int GetMute(out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class RevAudio {
  static IAudioEndpointVolume Vol() {
    var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice dev; e.GetDefaultAudioEndpoint(0, 1, out dev);
    var iid = typeof(IAudioEndpointVolume).GUID; object o;
    dev.Activate(ref iid, 23, IntPtr.Zero, out o);
    return (IAudioEndpointVolume)o;
  }
  public static float Get() { float v; Vol().GetMasterVolumeLevelScalar(out v); return v; }
  public static void Set(float v) { Guid g = Guid.Empty; Vol().SetMasterVolumeLevelScalar(v, ref g); }
  public static bool GetMute() { bool m; Vol().GetMute(out m); return m; }
  public static void SetMute(bool m) { Guid g = Guid.Empty; Vol().SetMute(m, ref g); }
}
'@
}`

async function volumeGet(runCmd) {
  const { out } = await ps(runCmd, `${AUDIO_COM}
"$([math]::Round([RevAudio]::Get()*100)) $([RevAudio]::GetMute())"`, 15000)
  const parts = (out || '').trim().split(/\s+/)
  const vol = parseInt(parts[0])
  return {
    volume: Number.isFinite(vol) ? vol : 0,
    muted: /true/i.test(parts[1] || ''),
  }
}

async function volumeSet(runCmd, level) {
  const clamped = Math.max(0, Math.min(100, Math.round(level)))
  await ps(runCmd, `${AUDIO_COM}
[RevAudio]::Set(${(clamped / 100).toFixed(4)})`, 15000)
  return { ok: true, volume: clamped }
}

async function volumeMute(runCmd, mute) {
  await ps(runCmd, `${AUDIO_COM}
[RevAudio]::SetMute($${mute ? 'true' : 'false'})`, 15000)
  return { ok: true }
}

// ─── WiFi ────────────────────────────────────────────────────────────────────
// netsh output is localized, so parse on structure (indentation + colon) rather
// than on English labels wherever possible.
async function wifiStatus(runCmd) {
  const { out } = await runCmd('netsh', ['wlan', 'show', 'interfaces'], 10000)
  const text = out || ''
  // "State" line tells us connected; SSID line (not BSSID) gives the name.
  const ssidM = text.match(/^\s*SSID\s*:\s*(.+)$/mi)
  const stateM = text.match(/^\s*State\s*:\s*(.+)$/mi)
  const connected = /connected/i.test(stateM ? stateM[1] : '') && !/disconnected/i.test(stateM ? stateM[1] : '')
  return {
    connected: connected && !!ssidM,
    ssid: connected && ssidM ? ssidM[1].trim() : null,
  }
}

function parseNetshScan(raw) {
  const networks = []
  let current = null
  for (const line of (raw || '').split('\n')) {
    const ssidM = line.match(/^SSID\s+\d+\s*:\s*(.*)$/i)
    if (ssidM) {
      if (current && current.ssid) networks.push(current)
      current = { ssid: ssidM[1].trim(), bssid: '', rssi: -100, security: 'NONE', secured: false }
      continue
    }
    if (!current) continue
    const authM = line.match(/^\s*Authentication\s*:\s*(.+)$/i)
    if (authM) {
      const auth = authM[1].trim()
      current.security = auth
      current.secured = !/^open$/i.test(auth)
      continue
    }
    const bssidM = line.match(/([0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2})/i)
    if (bssidM && !current.bssid) current.bssid = bssidM[1]
    // Signal is a percentage on Windows; map to the dBm scale the UI expects.
    const sigM = line.match(/^\s*Signal\s*:\s*(\d+)%/i)
    if (sigM) {
      const pct = parseInt(sigM[1])
      const rssi = Math.round(pct / 2 - 100)
      if (rssi > current.rssi) current.rssi = rssi
    }
  }
  if (current && current.ssid) networks.push(current)
  return networks
}

async function wifiScan(runCmd) {
  const { out, err } = await runCmd('netsh', ['wlan', 'show', 'networks', 'mode=bssid'], 15000)
  if (!(out || '').trim()) return { ok: false, networks: [], error: err || 'no wireless interface' }
  return { ok: true, networks: parseNetshScan(out) }
}

// Connecting by SSID needs a stored profile on Windows. If none exists and a
// password was supplied, write a temporary WPA2-PSK profile first.
async function wifiConnect(runCmd, ssid, password) {
  const { out: profiles } = await runCmd('netsh', ['wlan', 'show', 'profiles'], 10000)
  const known = (profiles || '').includes(ssid)

  if (!known && password) {
    const xml = `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>${escXml(ssid)}</name>
  <SSIDConfig><SSID><name>${escXml(ssid)}</name></SSID></SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>manual</connectionMode>
  <MSM><security>
    <authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption>
    <sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>${escXml(password)}</keyMaterial></sharedKey>
  </security></MSM>
</WLANProfile>`
    const fs = require('fs')
    const tmp = path.join(os.tmpdir(), `rev-wifi-${Date.now()}.xml`)
    try {
      fs.writeFileSync(tmp, xml, 'utf8')
      const { code, err } = await runCmd('netsh', ['wlan', 'add', 'profile', `filename=${tmp}`], 15000)
      if (code !== 0) return { ok: false, error: err || 'failed to add profile' }
    } catch (e) {
      return { ok: false, error: e.message }
    } finally {
      try { fs.unlinkSync(tmp) } catch {}
    }
  } else if (!known && !password) {
    return { ok: false, error: 'No saved profile for this network — a password is required.' }
  }

  const { code, err } = await runCmd('netsh', ['wlan', 'connect', `name=${ssid}`], 30000)
  return { ok: code === 0, error: err }
}

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

async function wifiDisconnect(runCmd) {
  const { code, err } = await runCmd('netsh', ['wlan', 'disconnect'], 10000)
  return { ok: code === 0, error: err }
}

// ─── Bluetooth ───────────────────────────────────────────────────────────────
// Enumerates PnP Bluetooth devices. Radio toggle needs the WinRT radio API,
// which is unavailable in stock PowerShell 5 without a package, so `hasBlueutil`
// (the renderer's "can I toggle?" flag) is reported false and the UI hides the
// switch — matching how it behaves on a Mac without blueutil installed.
async function btStatus(runCmd) {
  const script = `
$radio = Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'Radio|Adapter|Enumerator' } | Select-Object -First 1
$powered = $false
if ($radio -and $radio.Status -eq 'OK') { $powered = $true }
$devs = Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue |
  Where-Object { $_.FriendlyName -notmatch 'Radio|Adapter|Enumerator|Service|Profile|RFCOMM|HID Device$' } |
  ForEach-Object {
    [pscustomobject]@{
      name = $_.FriendlyName
      address = $_.InstanceId
      connected = ($_.Status -eq 'OK')
    }
  }
[pscustomobject]@{ powered = $powered; devices = @($devs) } | ConvertTo-Json -Compress -Depth 4`
  const { out } = await ps(runCmd, script, 15000)
  try {
    const d = JSON.parse((out || '').trim() || '{}')
    const raw = Array.isArray(d.devices) ? d.devices : (d.devices ? [d.devices] : [])
    return {
      powered: !!d.powered,
      devices: raw.map(x => ({
        name: x.name || 'Device',
        // Pull the MAC out of the PnP instance id when present (…_BTHENUM\Dev_AABBCC…).
        address: (String(x.address || '').match(/([0-9A-F]{12})/i) || [])[1] || String(x.address || ''),
        connected: !!x.connected,
        battery: null,
        type: 'Device',
      })),
      hasBlueutil: false,
    }
  } catch {
    return { powered: false, devices: [], hasBlueutil: false }
  }
}

const BT_UNSUPPORTED = { ok: false, error: 'Bluetooth control is not available on Windows — use Windows Settings.' }

// ─── Filesystem roots ────────────────────────────────────────────────────────
// The mac allowlist is ['/Users','/Applications','/tmp','/'] — the Windows
// equivalent is the user profile plus the available drive roots.
function fsAllowedRoots() {
  const home = os.homedir()
  const roots = [home, os.tmpdir()]
  const drives = []
  for (let c = 65; c <= 90; c++) {
    const d = `${String.fromCharCode(c)}:\\`
    try { if (require('fs').existsSync(d)) drives.push(d) } catch {}
  }
  return roots.concat(drives)
}

module.exports = {
  batteryStatus,
  volumeGet, volumeSet, volumeMute,
  wifiStatus, wifiScan, wifiConnect, wifiDisconnect,
  btStatus, BT_UNSUPPORTED,
  fsAllowedRoots,
  parseNetshScan,
}
