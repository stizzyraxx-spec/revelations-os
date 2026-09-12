const { app, BrowserWindow, ipcMain, session, nativeTheme, shell, globalShortcut, screen } = require('electron')
const path = require('path')
const os = require('os')
const fs = require('fs')
const https = require('https')
const { spawn } = require('child_process')

const IS_WIN = process.platform === 'win32'
// Windows implementations of the same IPC contracts (battery/volume/wifi/bt/fs).
// Required unconditionally so the bundler inlines it — behind `IS_WIN &&` it is
// left as an external require and the file is missing from the packaged app.
// The module itself touches nothing platform-specific at load time.
const win = require('./platform-win')
// Gatherings — believer-based event discovery (all upstream HTTP lives there).
const { registerEventsIpc } = require('./events')
registerEventsIpc()

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

// Locate the Claude Code CLI. A packaged Electron app inherits PATH from
// Explorer, which often misses the npm global bin and the native installer's
// directory — so when `claude` is not directly runnable, look where it actually
// installs before declaring it missing.
function resolveClaude() {
  const home = os.homedir()
  const candidates = IS_WIN
    ? [
        path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
        path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
        path.join(home, '.local', 'bin', 'claude.exe'),
        path.join(home, '.claude', 'local', 'claude.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude', 'claude.exe'),
      ]
    : [
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
        path.join(home, '.local', 'bin', 'claude'),
        path.join(home, '.claude', 'local', 'claude'),
        path.join(home, '.npm-global', 'bin', 'claude'),
      ]
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c } catch {}
  }
  return null
}

const CLAUDE_MISSING = [
  'Claude Code CLI not found on this machine.',
  'Install it, then run `claude` again:',
  '  npm install -g @anthropic-ai/claude-code',
  '  (or see https://claude.com/claude-code)',
].join('\n')

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
  // Prefer an absolute path when PATH doesn't carry claude into this process.
  const bin = resolveClaude()
  const exe = bin ? `"${bin}"` : 'claude'
  const cmdline = safe.startsWith('-')
    ? `${exe} ${safe}`
    : `${exe} -p "${safe.replace(/"/g, '\\"')}"`

  return new Promise(resolve => {
    const proc = spawn(cmdline, [], {
      shell: true,
      windowsHide: true,
      env: process.env,
    })
    let out = ''
    proc.stdout.on('data', d => { out += d.toString() })
    proc.stderr.on('data', d => { out += d.toString() })
    // With shell:true a missing binary isn't a spawn error — the shell reports
    // it on stderr and exits non-zero, so catch that wording too.
    proc.on('close', () => {
      if (/not recognized as|command not found|is not recognized/i.test(out)) return resolve(CLAUDE_MISSING)
      resolve(out || '(no output)')
    })
    proc.on('error', () => resolve(CLAUDE_MISSING))
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

// ─── TERMINAL X — real system shell ──────────────────────────────────────────
// Runs each command through the real system shell (PowerShell on Windows, bash
// otherwise) and reports the actual output. The working directory persists
// across commands by appending a marker that echoes $PWD after each run, so
// `cd` behaves like a normal shell. (Interactive full-screen TUI programs and
// $env/variable persistence across commands are out of scope.)
let termxCwd = null
function termxGetCwd() { if (!termxCwd) termxCwd = os.homedir(); return termxCwd }

ipcMain.handle('termx:cwd', () => termxGetCwd())

ipcMain.handle('termx:run', async (event, command) => {
  if (!rateOk('termx')) return { output: 'Rate limit exceeded', cwd: termxGetCwd() }
  let cmd = String(command || '').slice(0, 4000)
  if (!cmd.trim()) return { output: '', cwd: termxGetCwd() }

  // Interactive CLIs (Claude Code, Proverbs) would block forever in a one-shot
  // shell. Rewrite bare `claude <text>` to headless print mode so it answers
  // instead of hanging; the same for `proverbs`.
  const low = cmd.trim().toLowerCase()
  if (low === 'claude') {
    return {
      output: 'Claude Code is connected. Ask a question directly:\n  claude how do I list files here?\n  claude -p "summarise this folder"',
      cwd: termxGetCwd(),
    }
  }
  if (/^claude\b/.test(low)) {
    // Same PATH problem as claude:run — use the resolved binary when we have it.
    const bin = resolveClaude()
    const rest = cmd.trim().slice(6).trim()
    const passthrough = /^(-|mcp|config|setup-token|update|doctor)/i.test(rest)
    const exe = bin ? `"${bin}"` : 'claude'
    cmd = passthrough ? `${exe} ${rest}` : `${exe} -p "${rest.replace(/"/g, '\\"')}"`
  }

  const marker = '<<<TERMX_CWD:9f3a1c>>>'
  return new Promise((resolve) => {
    const shell = IS_WIN ? 'powershell.exe' : (process.env.SHELL || '/bin/bash')
    const wrapped = IS_WIN
      ? `${cmd}\r\nWrite-Output "${marker}$($PWD.Path)"`
      : `${cmd}\necho "${marker}$PWD"`
    const args = IS_WIN ? ['-NoLogo', '-NoProfile', '-Command', wrapped] : ['-lc', wrapped]
    let out = ''
    let done = false
    const proc = spawn(shell, args, { cwd: termxGetCwd(), windowsHide: true, env: process.env })
    proc.stdout.on('data', d => { out += d.toString() })
    proc.stderr.on('data', d => { out += d.toString() })
    const finish = () => {
      if (done) return
      done = true
      let cwd = termxGetCwd()
      const idx = out.lastIndexOf(marker)
      if (idx !== -1) {
        const after = out.slice(idx + marker.length)
        const nl = after.search(/[\r\n]/)
        cwd = (nl === -1 ? after : after.slice(0, nl)).trim() || cwd
        out = out.slice(0, idx)
      }
      termxCwd = cwd
      resolve({ output: out.replace(/\s+$/, ''), cwd })
    }
    proc.on('close', finish)
    proc.on('error', (err) => { if (!done) { done = true; resolve({ output: `Failed to run: ${err.message}`, cwd: termxGetCwd() }) } })
    setTimeout(() => { try { proc.kill() } catch {} ; finish() }, 60000)
  })
})

ipcMain.handle('app:getVersion', () => app.getVersion())

// ─── Updates — driven off GitHub Releases ────────────────────────────────────
// The build workflow attaches a .exe and a .dmg to each v* release, so "is there
// an update" is just "is the latest release newer than us". Done with plain
// https rather than electron-updater: no extra dependency, and the NSIS/dmg
// installers already produced by the pipeline are exactly what we hand back to
// the user. We download the installer and launch it; it upgrades in place.
//
// This MUST point at a repo whose releases are publicly readable. The source
// repo is private, and GitHub answers 404 (not 403) for unauthenticated reads
// of a private repo's releases — so a private target makes every check fail.
// Shipping a token to work around that would leak it to anyone who unpacks the
// app, so the release feed is public instead of the client being authenticated.
const UPDATE_REPO = process.env.REVOS_UPDATE_REPO || 'stizzyraxx-spec/revelations-os'

function httpsGet(url, opts = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'))
    const req = https.get(url, {
      headers: { 'User-Agent': 'RevelationsOS-Updater', Accept: 'application/vnd.github+json', ...(opts.headers || {}) },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return resolve(httpsGet(res.headers.location, opts, redirects + 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      resolve(res)
    })
    req.on('error', reject)
    req.setTimeout(20000, () => { req.destroy(new Error('Update check timed out')) })
  })
}

async function getJson(url) {
  const res = await httpsGet(url)
  let body = ''
  for await (const chunk of res) body += chunk
  return JSON.parse(body)
}

// Compare dotted numeric versions. Returns >0 when a is newer than b.
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

function pickAsset(assets = []) {
  const ext = process.platform === 'darwin' ? '.dmg' : '.exe'
  return assets.find(a => String(a.name).toLowerCase().endsWith(ext)) || null
}

let _latestRelease = null

ipcMain.handle('app:checkUpdate', async () => {
  const current = app.getVersion()
  try {
    const rel = await getJson(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`)
    const version = String(rel.tag_name || '').replace(/^v/i, '')
    const asset = pickAsset(rel.assets)
    _latestRelease = { version, asset }
    return {
      available: !!(version && asset && cmpVersion(version, current) > 0),
      version: version || current,
      current,
      notes: String(rel.body || '').slice(0, 4000),
      url: rel.html_url,
      // No installer for this platform on the release — tell the renderer so it
      // can point at the release page instead of offering a broken Install.
      asset: asset ? { name: asset.name, size: asset.size } : null,
    }
  } catch (e) {
    // 404 here almost always means the release feed isn't publicly readable
    // rather than "no releases" — say so instead of surfacing a bare status.
    const error = e.message === 'HTTP 404'
      ? `No public releases found for ${UPDATE_REPO} — the update feed must be a public repo`
      : e.message
    return { available: false, version: current, current, error }
  }
})

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

// Download a release asset to temp, streaming progress to the renderer.
// Resolves with the path on disk.
async function downloadAsset(asset, { progress = true } = {}) {
  const dest = path.join(app.getPath('temp'), asset.name)
  const res = await httpsGet(asset.browser_download_url, { headers: { Accept: 'application/octet-stream' } })
  const total = parseInt(res.headers['content-length'], 10) || asset.size || 0
  let received = 0
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest)
    res.on('data', (c) => {
      received += c.length
      if (total && progress) sendToRenderer('update:progress', { percent: Math.round((received / total) * 100), received, total })
    })
    res.on('error', reject)
    out.on('error', reject)
    out.on('finish', resolve)
    res.pipe(out)
  })
  // A truncated download would hand the user a broken installer — treat a short
  // file as a failure rather than running it.
  if (total && received < total) throw new Error('Download incomplete')
  return dest
}

// ─── Automatic updates ───────────────────────────────────────────────────────
// Updates install themselves: the app checks in the background, downloads the
// installer, and runs it silently when the app exits, so a user never has to go
// and install a new version by hand. `_pendingInstall` holds a downloaded
// installer that is waiting for that exit.
let _pendingInstall = null   // { version, file }
let _installLaunched = false
let _autoBusy = false

// Windows: electron-builder's NSIS accepts /S for a silent install; --force-run
// relaunches us afterwards, so the user lands back where they were.
// macOS: a .dmg cannot be applied silently without a signed installer, so the
// image is opened on exit and the user drags it across — same as before.
function runPendingInstaller() {
  if (!_pendingInstall || _installLaunched) return
  _installLaunched = true
  try {
    if (IS_WIN) {
      spawn(_pendingInstall.file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
    } else {
      shell.openPath(_pendingInstall.file)
    }
  } catch (e) {
    console.error('[update] could not start installer:', e.message)
  }
}

// Installing on exit only works if the installer is actually launched on the way
// out — before-quit covers Exit OS, the window close and an OS shutdown.
app.on('before-quit', runPendingInstaller)

async function checkAndStageUpdate() {
  // In dev there is nothing to replace, and a packaged build is the only thing
  // the installer knows how to update.
  if (!app.isPackaged || _autoBusy || _pendingInstall) return
  _autoBusy = true
  try {
    const current = app.getVersion()
    const rel = await getJson(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`)
    const version = String(rel.tag_name || '').replace(/^v/i, '')
    const asset = pickAsset(rel.assets)
    _latestRelease = { version, asset }
    if (!version || !asset || cmpVersion(version, current) <= 0) return

    sendToRenderer('update:state', { status: 'downloading', version })
    const file = await downloadAsset(asset, { progress: false })
    _pendingInstall = { version, file }
    // The renderer turns this into "restart to finish" — the update is already
    // on disk at this point, so there is nothing left for the user to fetch.
    sendToRenderer('update:state', { status: 'ready', version, silent: IS_WIN })
  } catch (e) {
    sendToRenderer('update:state', { status: 'error', error: e.message })
  } finally {
    _autoBusy = false
  }
}

// First pass shortly after launch so a stale install catches up right away,
// then every six hours for machines that stay signed in.
app.whenReady().then(() => {
  setTimeout(checkAndStageUpdate, 25000)
  setInterval(checkAndStageUpdate, 6 * 60 * 60 * 1000)
})

// Restart now rather than waiting for the next exit.
ipcMain.handle('app:restartForUpdate', async () => {
  if (!_pendingInstall) return { ok: false, error: 'No update is ready yet' }
  // relaunch() is a no-op once the NSIS installer relaunches us itself, but it
  // is what brings the app back on macOS after the dmg is opened.
  setTimeout(() => app.quit(), 250)
  return { ok: true, version: _pendingInstall.version }
})

ipcMain.handle('app:updateState', async () => ({
  current: app.getVersion(),
  pending: _pendingInstall ? { version: _pendingInstall.version, silent: IS_WIN } : null,
}))

// Manual path — Settings' "Check for updates" when someone would rather not
// wait for the background pass.
ipcMain.handle('app:applyUpdate', async () => {
  if (!rateOk('app:applyUpdate')) return { ok: false, error: 'Rate limit exceeded' }
  if (_pendingInstall) {
    setTimeout(() => app.quit(), 250)
    return { ok: true, installer: _pendingInstall.file, quitting: true }
  }
  const asset = _latestRelease?.asset
  if (!asset) return { ok: false, error: 'Run a check for updates first' }

  let dest
  try {
    dest = await downloadAsset(asset)
  } catch (e) {
    return { ok: false, error: `Download failed: ${e.message}` }
  }

  _pendingInstall = { version: _latestRelease.version, file: dest }
  setTimeout(() => app.quit(), 1200)
  return { ok: true, installer: dest, quitting: true }
})

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
  if (IS_WIN) {
    // Windows exposes no simple CLI to flip the Bluetooth radio; open the
    // Windows Bluetooth settings so the user can enable/disable it there.
    try { await shell.openExternal('ms-settings:bluetooth') } catch {}
    return { ok: true, openedSettings: true, note: 'Opened Windows Bluetooth settings.' }
  }
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
