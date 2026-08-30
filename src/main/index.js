const { app, BrowserWindow, ipcMain, session, nativeTheme, shell, globalShortcut, screen } = require('electron')
const path = require('path')
const os = require('os')
const fs = require('fs')
const { spawn } = require('child_process')

const IS_WIN = process.platform === 'win32'
// Windows implementations of the same IPC contracts (battery/volume/wifi/bt/fs).
// Required unconditionally so the bundler inlines it — behind `IS_WIN &&` it is
// left as an external require and the file is missing from the packaged app.
// The module itself touches nothing platform-specific at load time.
const win = require('./platform-win')

// Security: disable remote debugging
app.commandLine.appendSwitch('remote-debugging-port', '0')
nativeTheme.themeSource = 'dark'

// IPC rate limiter
const ipcRates = new Map()
function rateOk(ch) {
  const now = Date.now()
  const e = ipcRates.get(ch) || { n: 0, reset: now + 1000 }
  if (now > e.reset) { e.n = 0; e.reset = now + 1000 }
  e.n++; ipcRates.set(ch, e)
  return e.n <= 100
}

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    fullscreen: true,
    frame: false,
    backgroundColor: '#04040a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: true,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    }
  })

  // CSP
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' https:; img-src 'self' data: blob: https: file:; media-src 'self' blob:;"
        ],
        'X-Content-Type-Options': ['nosniff'],
        'X-Frame-Options': ['SAMEORIGIN'],
      }
    })
  })

  // Block navigation from main window (allow localhost in dev)
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const ok = url.startsWith('http://localhost') || url.startsWith('file://')
    if (!ok) event.preventDefault()
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // Download handler — must be inside app.whenReady / createWindow
  session.defaultSession.on('will-download', (event, item) => {
    const id = ++_dlId
    const dl = {
      id, filename: item.getFilename(), url: item.getURL(),
      totalBytes: item.getTotalBytes(), receivedBytes: 0,
      state: 'progressing',
      savePath: path.join(os.homedir(), 'Downloads', item.getFilename()),
    }
    item.setSavePath(dl.savePath)
    _downloads.set(id, dl)
    item.on('updated', (_, state) => {
      dl.receivedBytes = item.getReceivedBytes()
      dl.state = state
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('download:update', { ...dl })
    })
    item.on('done', (_, state) => {
      dl.state = state; dl.receivedBytes = item.getTotalBytes()
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('download:done', { ...dl })
    })
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// IPC handlers
ipcMain.on('app:exit', () => { if (rateOk('app:exit')) app.quit() })
ipcMain.on('app:minimize', () => {
  if (!rateOk('app:minimize') || !mainWindow) return
  mainWindow.setFullScreen(false)
  mainWindow.minimize()
})
ipcMain.on('app:restore', () => {
  if (!mainWindow) return
  mainWindow.restore()
  mainWindow.setFullScreen(true)
})

ipcMain.handle('app:getSystemInfo', async () => {
  if (!rateOk('sysinfo')) return null
  const cpus = os.cpus()
  return {
    platform: process.platform,
    hostname: os.hostname(),
    username: os.userInfo().username,
    totalRam: Math.round(os.totalmem() / 1073741824),
    freeRam: Math.round(os.freemem() / 1073741824),
    cpuModel: cpus[0]?.model || 'Unknown',
    cpuCount: cpus.length,
    arch: os.arch(),
    osRelease: os.release(),
    uptime: Math.floor(os.uptime() / 3600),
    homedir: os.homedir(),
  }
})

// The renderer addresses paths with a leading `~`; resolve it against the real
// home dir (path.resolve does not do this) and normalise separators so the
// renderer's '/'-joined breadcrumbs work on Windows too.
function expandHome(p) {
  if (!p) return p
  let s = String(p)
  if (s === '~') return os.homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(2))
  return IS_WIN ? s.replace(/\//g, path.sep) : s
}

ipcMain.handle('fs:scanDirectory', async (event, dirPath) => {
  if (!rateOk('scandir')) return []
  const home = os.homedir()
  const resolved = path.resolve(expandHome(dirPath) || home)
  const allowed = IS_WIN ? win.fsAllowedRoots() : [home, '/Applications', '/tmp', '/Users', '/']
  // Windows paths are case-insensitive, so compare case-folded there.
  const probe = IS_WIN ? resolved.toLowerCase() : resolved
  if (!allowed.some(p => probe.startsWith(IS_WIN ? p.toLowerCase() : p))) return []
  try {
    const entries = await fs.promises.readdir(resolved, { withFileTypes: true })
    const filtered = entries.filter(e => !e.name.startsWith('.') || dirPath === home)
    return await Promise.all(filtered.map(async e => {
      let size = 0, modified = ''
      try {
        const s = await fs.promises.stat(path.join(resolved, e.name))
        size = s.size
        modified = s.mtime.toISOString()
      } catch {}
      return {
        name: e.name,
        type: e.isDirectory() ? 'folder' : 'file',
        ext: path.extname(e.name).slice(1).toLowerCase(),
        size, modified,
        fullPath: path.join(resolved, e.name),
      }
    }))
  } catch { return [] }
})

ipcMain.handle('fs:readFile', async (event, filePath) => {
  if (!rateOk('readfile')) return null
  const home = os.homedir()
  const resolved = path.resolve(expandHome(filePath))
  const inHome = IS_WIN
    ? resolved.toLowerCase().startsWith(home.toLowerCase())
    : resolved.startsWith(home)
  if (!inHome) return null
  try {
    const stat = await fs.promises.stat(resolved)
    if (stat.size > 10 * 1024 * 1024) return null
    return await fs.promises.readFile(resolved)
  } catch { return null }
})

// Spawn a Node script using Electron's bundled Node instead of a `node` on
// PATH — a packaged Windows install has no standalone Node, and this keeps the
// mac and Windows behaviour identical.
function spawnNode(scriptArgs, opts = {}) {
  return spawn(process.execPath, scriptArgs, {
    ...opts,
    env: { ...process.env, ...opts.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
  })
}

// Resolve the Proverbs CLI entry point. The current version ships bundled
// inside the app (extraResources → resources/proverbs); we prefer that so the
// Terminal always runs the packaged version, and fall back to a dev checkout
// or a ~/proverbs clone for backwards compatibility.
function resolveProverbs() {
  const candidates = [
    // Packaged app: unpacked extraResources
    path.join(process.resourcesPath || '', 'proverbs', 'cli.js'),
    // Dev run from the repo
    path.join(process.cwd(), 'proverbs-runtime', 'cli.js'),
    // Legacy clones in the user's home
    path.join(os.homedir(), 'proverbs', 'cli.js'),
    path.join(os.homedir(), 'proverbs', 'index.js'),
  ]
  for (const entry of candidates) {
    try { if (entry && fs.existsSync(entry)) return { entry, dir: path.dirname(entry) } } catch {}
  }
  return null
}

ipcMain.handle('proverbs:run', async (event, cmd) => {
  if (!rateOk('proverbs')) return 'Rate limit exceeded'
  const safe = String(cmd || '').slice(0, 200).replace(/[;&|`$]/g, '')
  const resolved = resolveProverbs()
  if (!resolved) {
    return 'Proverbs CLI not found. Reinstall Revelations OS or clone proverbs-ai into ~/proverbs.'
  }
  return new Promise(resolve => {
    const args = safe.split(' ').filter(Boolean)
    const proc = spawnNode([resolved.entry, ...args], {
      cwd: resolved.dir,
      timeout: 10000,
    })
    let out = ''
    proc.stdout.on('data', d => { out += d.toString() })
    proc.stderr.on('data', d => { out += d.toString() })
    proc.on('close', () => resolve(out || '(no output)'))
    proc.on('error', () => resolve(`Proverbs CLI failed to launch from ${resolved.entry}`))
    setTimeout(() => { proc.kill(); resolve(out || 'Command timed out after 9s') }, 9000)
  })
})

// Run the Claude Code CLI installed on the host machine. Output is streamed
// back to the OS Terminal. If `claude` is not on PATH we return install
// guidance rather than an opaque spawn error.
ipcMain.handle('claude:run', async (event, cmd) => {
  if (!rateOk('claude')) return 'Rate limit exceeded'
  // Keep quotes/spaces (prompts need them); strip shell control metacharacters.
  const safe = String(cmd || '').slice(0, 2000).replace(/[;&|`$><\n\r]/g, '').trim()

  // The OS Terminal is a one-shot shell (no live TTY), so the interactive
  // Claude session can't run here. Bare `claude` prints a hint; a leading flag
  // is passed straight through; anything else is treated as a prompt via -p.
  if (!safe || safe === '--help') {
    return [
      '\x1b[36mClaude Code\x1b[0m is installed and signed in on this machine.',
      '',
      'This terminal runs one-shot commands, so type your question directly:',
      '  \x1b[32mclaude what does this OS do?\x1b[0m',
      '  \x1b[32mclaude -p "summarise the Book of Revelation"\x1b[0m',
      '',
      'For a full interactive Claude session, open a system PowerShell and run \x1b[32mclaude\x1b[0m.',
    ].join('\n')
  }
  const cmdline = safe.startsWith('-')
    ? `claude ${safe}`
    : `claude -p "${safe.replace(/"/g, '\\"')}"`

  return new Promise(resolve => {
    const proc = spawn(cmdline, [], {
      shell: true,
      windowsHide: true,
      env: process.env,
    })
    let out = ''
    proc.stdout.on('data', d => { out += d.toString() })
    proc.stderr.on('data', d => { out += d.toString() })
    proc.on('close', () => resolve(out || '(no output)'))
    proc.on('error', () => resolve(
      'Claude Code CLI not found on this machine.\n' +
      'Install it, then run `claude` again:\n' +
      '  npm install -g @anthropic-ai/claude-code\n' +
      '  (or see https://claude.com/claude-code)'
    ))
    // Claude runs can be long; allow up to 3 minutes before giving up.
    setTimeout(() => { try { proc.kill() } catch {} ; resolve(out || 'Claude command timed out after 180s') }, 180000)
  })
})

// ─── MULTI-MONITOR (Win+P style display projection) ──────────────────────────
let secondaryWindow = null

function loadRenderer(w) {
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    w.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    w.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function getExternalDisplay() {
  const primary = screen.getPrimaryDisplay()
  return screen.getAllDisplays().find((d) => d.id !== primary.id) || null
}

function closeSecondary() {
  if (secondaryWindow && !secondaryWindow.isDestroyed()) secondaryWindow.close()
  secondaryWindow = null
}

function openSecondaryOn(display) {
  if (secondaryWindow && !secondaryWindow.isDestroyed()) {
    secondaryWindow.setBounds(display.bounds)
    secondaryWindow.setFullScreen(true)
    return
  }
  secondaryWindow = new BrowserWindow({
    x: display.bounds.x, y: display.bounds.y,
    fullscreen: true, frame: false, backgroundColor: '#04040a', show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false, webviewTag: true,
      sandbox: false, webSecurity: true, devTools: !app.isPackaged,
    },
  })
  secondaryWindow.setWindowOpenHandler(() => ({ action: 'deny' }))
  secondaryWindow.once('ready-to-show', () => secondaryWindow.show())
  secondaryWindow.on('closed', () => { secondaryWindow = null })
  loadRenderer(secondaryWindow)
}

// Move a fullscreen window to a target display (must leave fullscreen first).
function moveWindowToDisplay(w, display) {
  if (!w || w.isDestroyed()) return
  w.setFullScreen(false)
  w.setBounds(display.bounds)
  w.setFullScreen(true)
}

ipcMain.handle('display:list', () => {
  const primary = screen.getPrimaryDisplay()
  const all = screen.getAllDisplays()
  return {
    count: all.length,
    hasExternal: all.length > 1,
    displays: all.map((d) => ({ id: d.id, primary: d.id === primary.id, width: d.size.width, height: d.size.height })),
  }
})

// mode: 'internal' (PC only) | 'duplicate' | 'extend' | 'external' (second only)
ipcMain.handle('display:setMode', (event, mode) => {
  const primary = screen.getPrimaryDisplay()
  const ext = getExternalDisplay()
  if (mode !== 'internal' && !ext) return { ok: false, reason: 'No second display detected' }
  try {
    if (mode === 'internal') {
      closeSecondary()
      moveWindowToDisplay(mainWindow, primary)
    } else if (mode === 'external') {
      closeSecondary()
      moveWindowToDisplay(mainWindow, ext)
    } else if (mode === 'duplicate' || mode === 'extend') {
      moveWindowToDisplay(mainWindow, primary)
      openSecondaryOn(ext)
    } else {
      return { ok: false, reason: 'Unknown display mode' }
    }
    return { ok: true, mode }
  } catch (err) {
    return { ok: false, reason: err.message }
  }
})

ipcMain.handle('app:getVersion', () => app.getVersion())
ipcMain.handle('app:checkUpdate', async () => ({ available: false, version: app.getVersion(), notes: '' }))
ipcMain.handle('app:applyUpdate', async () => ({ scheduled: true }))

// sys:openPrefs no longer needed — all panels are native now

// ─── Bluetooth IPC ───────────────────────────────────────────────────────────
function parseBTJson(json) {
  try {
    const data = JSON.parse(json)
    const entry = (data.SPBluetoothDataType || [])[0] || {}
    const props = entry.controller_properties || {}
    const powered = props.controller_state === 'attrib_enabled'
    const devices = []
    const addDevices = (map, connected) => {
      for (const [name, info] of Object.entries(map || {})) {
        devices.push({
          name,
          address: info.device_address || '',
          connected,
          battery: info.device_batteryPercent || null,
          type: info.device_minorType || info.device_majorType || 'Device',
        })
      }
    }
    addDevices(entry.device_connected, true)
    addDevices(entry.device_not_connected, false)
    return { powered, devices }
  } catch { return { powered: false, devices: [] } }
}

let _blueutilPath = undefined
async function findBlueutil() {
  if (_blueutilPath !== undefined) return _blueutilPath
  for (const p of ['/usr/local/bin/blueutil', '/opt/homebrew/bin/blueutil']) {
    const { code } = await runCmd(p, ['--version'])
    if (code === 0) { _blueutilPath = p; return p }
  }
  _blueutilPath = null
  return null
}

ipcMain.handle('bt:status', async () => {
  if (IS_WIN) return win.btStatus(runCmd)
  const { out } = await runCmd('system_profiler', ['SPBluetoothDataType', '-json'], 10000)
  const parsed = parseBTJson(out)
  const blueutilPath = await findBlueutil()
  return { ...parsed, hasBlueutil: !!blueutilPath }
})

ipcMain.handle('bt:toggle', async (event, on) => {
  if (IS_WIN) return win.BT_UNSUPPORTED
  const p = await findBlueutil()
  if (!p) return { ok: false, error: 'blueutil not installed' }
  const { code } = await runCmd(p, ['-p', on ? '1' : '0'])
  return { ok: code === 0 }
})

ipcMain.handle('bt:connect', async (event, address) => {
  if (IS_WIN) return win.BT_UNSUPPORTED
  const p = await findBlueutil()
  if (!p) return { ok: false, error: 'blueutil not installed' }
  const { code, err } = await runCmd(p, ['--connect', address], 20000)
  return { ok: code === 0, error: err }
})

ipcMain.handle('bt:disconnect', async (event, address) => {
  if (IS_WIN) return win.BT_UNSUPPORTED
  const p = await findBlueutil()
  if (!p) return { ok: false, error: 'blueutil not installed' }
  const { code, err } = await runCmd(p, ['--disconnect', address], 10000)
  return { ok: code === 0, error: err }
})

// ─── Short-lived caches ───────────────────────────────────────────────────────
const _cache = new Map()
function cached(key, ttlMs, fn) {
  const hit = _cache.get(key)
  if (hit && Date.now() < hit.exp) return Promise.resolve(hit.val)
  return fn().then(val => { _cache.set(key, { val, exp: Date.now() + ttlMs }); return val })
}

// ─── Battery IPC ─────────────────────────────────────────────────────────────
function parseIOReg(out) {
  const get = key => { const m = out.match(new RegExp(`"${key}"\\s*=\\s*(\\S+)`)); return m ? m[1] : null }
  const cycleCount = parseInt(get('CycleCount')) || null
  const designCap  = parseInt(get('DesignCapacity')) || null
  const maxCap     = parseInt(get('MaxCapacity')) || null
  const tempRaw    = parseInt(get('Temperature')) || null
  return {
    cycleCount,
    healthPct: (designCap && maxCap) ? Math.round((maxCap / designCap) * 100) : null,
    tempC: tempRaw ? (tempRaw / 10).toFixed(1) : null,
  }
}

ipcMain.handle('battery:status', () => cached('battery', 5000, async () => {
  if (IS_WIN) return win.batteryStatus(runCmd)
  const [pmOut, ioOut] = await Promise.all([
    runCmd('pmset', ['-g', 'batt']),
    runCmd('ioreg', ['-rn', 'AppleSmartBattery']),
  ])
  const m = pmOut.out.match(/(\d+)%;\s*([\w\s/]+?)(?:\s*;|$)/m)
  const timeM = pmOut.out.match(/(\d+:\d+)\s+remaining/)
  const onAC = pmOut.out.includes("'AC Power'")
  const extra = parseIOReg(ioOut.out)
  return {
    percentage: m ? parseInt(m[1]) : null,
    status: m ? m[2].trim() : 'unknown',
    timeRemaining: timeM ? timeM[1] : null,
    onAC,
    ...extra,
  }
}))

// ─── Volume IPC ──────────────────────────────────────────────────────────────
ipcMain.handle('volume:get', () => cached('volume', 3000, async () => {
  if (IS_WIN) return win.volumeGet(runCmd)
  const [volOut, muteOut] = await Promise.all([
    runCmd('osascript', ['-e', 'output volume of (get volume settings)']),
    runCmd('osascript', ['-e', 'output muted of (get volume settings)']),
  ])
  return {
    volume: parseInt(volOut.out.trim()) || 0,
    muted: muteOut.out.trim() === 'true',
  }
}))

ipcMain.handle('volume:set', async (event, level) => {
  if (IS_WIN) { const r = await win.volumeSet(runCmd, level); _cache.delete('volume'); return r }
  const clamped = Math.max(0, Math.min(100, Math.round(level)))
  await runCmd('osascript', ['-e', `set volume output volume ${clamped}`])
  _cache.delete('volume')
  return { ok: true, volume: clamped }
})

ipcMain.handle('volume:mute', async (event, mute) => {
  if (IS_WIN) { const r = await win.volumeMute(runCmd, mute); _cache.delete('volume'); return r }
  const cmd = mute ? 'set volume with output muted' : 'set volume without output muted'
  await runCmd('osascript', ['-e', cmd])
  _cache.delete('volume')
  return { ok: true }
})

// ─── WiFi IPC ───────────────────────────────────────────────────────────────
const AIRPORT = '/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport'
const WIFI_IF = 'en0'

function runCmd(bin, args, timeoutMs = 12000) {
  return new Promise(resolve => {
    // On Windows the targets (netsh, powershell) resolve through PATHEXT, which
    // bare spawn does not apply — hence shell:true there. windowsHide keeps the
    // console window from flashing on every poll.
    const proc = spawn(bin, args, IS_WIN ? { shell: true, windowsHide: true } : {})
    let out = '', err = ''
    proc.stdout.on('data', d => { out += d.toString() })
    proc.stderr.on('data', d => { err += d.toString() })
    proc.on('close', code => resolve({ code, out, err }))
    proc.on('error', e => resolve({ code: -1, out: '', err: e.message }))
    setTimeout(() => { proc.kill(); resolve({ code: -1, out, err: 'timeout' }) }, timeoutMs)
  })
}

function parseAirportScan(raw) {
  const lines = raw.trim().split('\n').slice(1)
  return lines.map(line => {
    const m = line.match(/([0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2})/i)
    if (!m) return null
    const bssid = m[1]
    const bssidIdx = line.indexOf(bssid)
    const ssid = line.substring(0, bssidIdx).trim()
    if (!ssid) return null
    const rest = line.substring(bssidIdx + bssid.length).trim().split(/\s+/)
    const rssi = parseInt(rest[0]) || -100
    const security = rest.slice(4).join(' ') || 'NONE'
    return { ssid, bssid, rssi, security, secured: !/NONE/i.test(security) }
  }).filter(Boolean)
}

ipcMain.handle('wifi:status', async () => {
  if (IS_WIN) return win.wifiStatus(runCmd)
  const { out } = await runCmd('networksetup', ['-getairportnetwork', WIFI_IF])
  const m = out.match(/Current Wi-Fi Network:\s*(.+)/)
  return { connected: !!m, ssid: m ? m[1].trim() : null }
})

ipcMain.handle('wifi:scan', async () => {
  if (IS_WIN) return win.wifiScan(runCmd)
  const { out, err } = await runCmd(AIRPORT, ['-s'], 15000)
  if (!out.trim()) return { ok: false, networks: [], error: err }
  return { ok: true, networks: parseAirportScan(out) }
})

ipcMain.handle('wifi:connect', async (event, ssid, password) => {
  if (IS_WIN) return win.wifiConnect(runCmd, ssid, password)
  const args = ['-setairportnetwork', WIFI_IF, ssid]
  if (password) args.push(password)
  const { code, err } = await runCmd('networksetup', args, 30000)
  return { ok: code === 0, error: err }
})

ipcMain.handle('wifi:disconnect', async () => {
  if (IS_WIN) return win.wifiDisconnect(runCmd)
  const { code, err } = await runCmd(AIRPORT, ['-z'])
  return { ok: code === 0, error: err }
})

// ─── Download IPC ────────────────────────────────────────────────────────────
const _downloads = new Map()
let _dlId = 0

app.on('browser-window-created', () => {})
ipcMain.handle('download:list', () => Array.from(_downloads.values()))
ipcMain.handle('download:open', (_, p) => shell.openPath(p))
ipcMain.handle('download:reveal', (_, p) => shell.showItemInFolder(p))
ipcMain.handle('download:clear', () => { _downloads.clear(); return true })

// ─── REV UPDATE — Proverbs-powered OS + repo fixer ──────────────────────────
const ALL_REPOS = [
  'revelations-os',
  'taxflow-pro', 'bowdwn', 'automix', 'legalvault-pro', 'fema-platform',
  'genmed-clinical-sync', 'rals-unified', 'liquor-ledger', 'leadforge',
  'proverbs', 'IdeaPlanner', 'freepost', 'cloutkiller', 'grow-clout-hub',
  'syllabus-script-space', 'artistmanager', 'petsitter-pro', 'groomtrack-pro',
  'mobile-massage', 'mobile-barber', 'mobile-salon', 'tradeiqdesk',
  'vybe-engine', 'business-software-management-services', 'black-wall-street-legacy',
  'school-manager', 'contractor-os', 'tuffbets', 'command-hq',
  'dealerflow-pro', 'govcoreerp', 'olive', 'admin-center', 'pcscanfix',
]

ipcMain.handle('rev:listRepos', async () => {
  const home = os.homedir()
  return ALL_REPOS.map(r => ({
    name: r,
    path: path.join(home, r),
    exists: fs.existsSync(path.join(home, r)),
  }))
})

function sendProgress(text) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('rev:progress', text)
  }
}

ipcMain.handle('rev:update', async (event, issue) => {
  if (!rateOk('rev:update')) return { ok: false, output: 'Rate limit exceeded' }

  const home = os.homedir()
  const resolvedProverbs = resolveProverbs()

  if (!resolvedProverbs) {
    return { ok: false, output: 'Proverbs CLI not found. Reinstall Revelations OS (it ships bundled) or clone proverbs-ai into ~/proverbs.' }
  }
  const proverbs = resolvedProverbs.entry

  // Build repo context list (only existing repos)
  const existingRepos = ALL_REPOS
    .map(r => path.join(home, r))
    .filter(p => fs.existsSync(p))

  // Detect which repos the issue likely refers to
  const issueLower = issue.toLowerCase()
  const mentionedRepos = existingRepos.filter(r => {
    const name = path.basename(r).toLowerCase()
    return issueLower.includes(name) ||
      issueLower.includes(name.replace(/-/g, ' ')) ||
      issueLower.includes(name.replace(/-/g, ''))
  })

  // OS-level keywords
  const osKeywords = ['os', 'revelations', 'terminal', 'browser', 'ephesians', 'desktop', 'login', 'window', 'topbar', 'sidebar', 'orb', 'settings', 'notepad', 'files', 'file manager', 'app store', 'celestia']
  const isOSIssue = osKeywords.some(k => issueLower.includes(k))

  // Target: mentioned repos + OS if OS keywords present
  const targetRepos = mentionedRepos.length > 0 ? mentionedRepos : existingRepos.slice(0, 5)
  if (isOSIssue && !targetRepos.includes(path.join(home, 'revelations-os'))) {
    targetRepos.unshift(path.join(home, 'revelations-os'))
  }

  sendProgress(`\x1b[35m[rev]\x1b[0m Analyzing issue: ${issue.slice(0, 80)}...\n`)
  sendProgress(`\x1b[35m[rev]\x1b[0m Target repos: ${targetRepos.map(r => path.basename(r)).join(', ')}\n`)
  sendProgress(`\x1b[35m[rev]\x1b[0m Invoking Proverbs CLI...\n\n`)

  // Build the full prompt for Proverbs
  const prompt = [
    `[Revelations OS — rev update]`,
    `ISSUE REPORTED BY USER: ${issue}`,
    ``,
    `CONTEXT:`,
    `- You are running inside Revelations OS`,
    `- The OS source is at ~/revelations-os`,
    `- Target repositories: ${targetRepos.join(', ')}`,
    ``,
    `INSTRUCTIONS:`,
    `1. Analyze the issue description`,
    `2. Identify which files in the target repos need to be changed`,
    `3. Apply the fix directly to the files`,
    `4. Report what was changed and why`,
    `5. If the issue is in revelations-os itself, note that a rebuild is needed`,
  ].join('\n')

  return new Promise(resolve => {
    let output = ''
    const args = ['--issue', prompt, '--repos', targetRepos.join(','), '--mode', 'fix']

    // Try proverbs first with structured args, fallback to simple stdin
    const proc = spawnNode([proverbs, ...args], {
      cwd: resolvedProverbs.dir,
      env: { REV_ISSUE: issue, REV_REPOS: targetRepos.join(','), REV_MODE: 'fix' },
    })

    proc.stdout.on('data', d => {
      const text = d.toString()
      output += text
      sendProgress(text)
    })
    proc.stderr.on('data', d => {
      const text = d.toString()
      output += text
      sendProgress(`\x1b[33m${text}\x1b[0m`)
    })
    proc.on('close', code => {
      const status = code === 0 ? '✓ Complete' : `⚠ Exited (${code})`
      const needsRebuild = isOSIssue || targetRepos.some(r => r.includes('revelations-os'))
      sendProgress(`\n\x1b[35m[rev]\x1b[0m ${status}\n`)
      if (needsRebuild) {
        sendProgress(`\x1b[35m[rev]\x1b[0m OS changes detected — run 'rev rebuild' to apply them.\n`)
      }
      resolve({ ok: code === 0, output, needsRebuild, targetRepos: targetRepos.map(r => path.basename(r)) })
    })
    proc.on('error', err => {
      const msg = `Proverbs error: ${err.message}`
      sendProgress(`\x1b[31m${msg}\x1b[0m\n`)
      resolve({ ok: false, output: msg, needsRebuild: false })
    })
    // 5 min timeout for complex fixes
    setTimeout(() => {
      proc.kill()
      sendProgress(`\n\x1b[31m[rev] Timed out after 5 minutes\x1b[0m\n`)
      resolve({ ok: false, output: output || 'Timed out', needsRebuild: false })
    }, 300000)
  })
})

ipcMain.handle('rev:rebuild', async () => {
  if (!rateOk('rev:rebuild')) return { ok: false, output: 'Rate limit exceeded' }

  const osDir = path.join(os.homedir(), 'revelations-os')
  if (!fs.existsSync(osDir)) return { ok: false, output: 'revelations-os repo not found at ~/revelations-os' }

  sendProgress(`\x1b[35m[rev]\x1b[0m Rebuilding Revelations OS...\n`)

  const evite = path.join(osDir, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
  if (!fs.existsSync(evite)) return { ok: false, output: 'electron-vite not installed. Run: cd ~/revelations-os && npm install' }

  return new Promise(resolve => {
    let output = ''
    const build = spawnNode([evite, 'build'], { cwd: osDir })
    build.stdout.on('data', d => { const t = d.toString(); output += t; sendProgress(t) })
    build.stderr.on('data', d => { const t = d.toString(); output += t; sendProgress(t) })
    build.on('close', code => {
      if (code !== 0) {
        sendProgress(`\x1b[31m[rev] Build failed (${code})\x1b[0m\n`)
        resolve({ ok: false, output })
        return
      }
      // On Windows there is no .app bundle to swap, and a running .exe cannot
      // overwrite itself — the rebuilt sources load on the next launch instead.
      if (IS_WIN) {
        sendProgress(`\x1b[32m[rev] Build succeeded — restart Revelations to apply.\x1b[0m\n`)
        resolve({ ok: true, output: output + '\nBuild complete — restart to apply.' })
        return
      }
      sendProgress(`\x1b[32m[rev] Build succeeded — copying to /Applications...\x1b[0m\n`)
      // Copy new .app to /Applications
      const cp = spawn('cp', ['-R', path.join(osDir, 'dist', 'mac', 'Revelations.app'), '/Applications/Revelations.app'])
      cp.on('close', cpCode => {
        if (cpCode === 0) {
          sendProgress(`\x1b[32m[rev] Revelations.app updated in /Applications. Restart to apply.\x1b[0m\n`)
          resolve({ ok: true, output: output + '\nInstalled to /Applications/Revelations.app' })
        } else {
          sendProgress(`\x1b[31m[rev] Copy failed — try: sudo cp -R ~/revelations-os/dist/mac/Revelations.app /Applications/\x1b[0m\n`)
          resolve({ ok: false, output })
        }
      })
      cp.on('error', e => resolve({ ok: false, output: e.message }))
    })
    build.on('error', e => resolve({ ok: false, output: e.message }))
    setTimeout(() => { build.kill(); resolve({ ok: false, output: 'Build timed out' }) }, 600000)
  })
})

// Adult content block-list — applies to all webviews (Ephesians + app viewers)
const BLOCKED_DOMAINS = [
  'onlyfans.com', 'pornhub.com', 'xvideos.com', 'xnxx.com', 'redtube.com',
  'youporn.com', 'tube8.com', 'spankbang.com', 'xhamster.com', 'tnaflix.com',
  'slutload.com', 'beeg.com', 'drtuber.com', 'nuvid.com', 'txxx.com',
  'hclips.com', 'hdtube.porn', 'brazzers.com', 'bangbros.com', 'realitykings.com',
  'mofos.com', 'naughtyamerica.com', 'digitalplayground.com', 'teamskeet.com',
  'porndig.com', 'porn.com', 'sex.com', 'adult.com', 'livejasmincams.com',
  'chaturbate.com', 'stripchat.com', 'bongacams.com', 'myfreecams.com',
  'livejasmin.com', 'cam4.com', 'camsoda.com', 'flirt4free.com',
]

function isBlockedUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return BLOCKED_DOMAINS.some(d => host === d || host.endsWith('.' + d))
  } catch { return false }
}

// Block permission escalation on all webcontents
app.on('web-contents-created', (_, contents) => {
  const type = contents.getType()
  if (type !== 'webview') {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith('http://localhost') && !url.startsWith('file://')) {
        event.preventDefault()
      }
    })
  } else {
    // Block adult sites in webviews (Ephesians browser + app viewers)
    contents.on('will-navigate', (event, url) => {
      if (isBlockedUrl(url)) event.preventDefault()
    })
    contents.on('will-frame-navigate', (event) => {
      if (isBlockedUrl(event.url)) event.preventDefault()
    })
  }
  // Prevent permission requests (camera, mic, etc.) without user approval
  session.defaultSession.setPermissionRequestHandler((webContents, permission, cb) => {
    const allowed = ['clipboard-read', 'notifications', 'fullscreen']
    cb(allowed.includes(permission))
  })
})

app.whenReady().then(() => {
  createWindow()
  // The window is frameless and fullscreen, so Windows shows no minimize or
  // close control and provides no default way out. macOS users can still reach
  // Mission Control / Cmd-Tab, but on Windows this would trap them — bind F11
  // to toggle fullscreen and Ctrl+Shift+M to minimize.
  if (IS_WIN) {
    globalShortcut.register('F11', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setFullScreen(!mainWindow.isFullScreen())
      }
    })
    globalShortcut.register('CommandOrControl+Shift+M', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setFullScreen(false)
        mainWindow.minimize()
      }
    })
  }
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
