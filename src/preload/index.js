const { contextBridge, ipcRenderer } = require('electron')

const VALID_SEND = ['app:exit', 'app:minimize', 'app:restore']
const VALID_INVOKE = [
  'app:getSystemInfo', 'fs:scanDirectory', 'fs:readFile',
  'proverbs:run', 'claude:run', 'app:checkUpdate', 'app:applyUpdate', 'app:getVersion',
  'display:list', 'display:setMode',
  'rev:update', 'rev:rebuild', 'rev:listRepos',
  'wifi:status', 'wifi:scan', 'wifi:connect', 'wifi:disconnect',
  'download:list', 'download:open', 'download:reveal', 'download:clear',
  'bt:status', 'bt:toggle', 'bt:connect', 'bt:disconnect',
  'battery:status',
  'volume:get', 'volume:set', 'volume:mute',
]

function safeSend(ch, ...args) {
  if (VALID_SEND.includes(ch)) ipcRenderer.send(ch, ...args)
}
function safeInvoke(ch, ...args) {
  if (VALID_INVOKE.includes(ch)) return ipcRenderer.invoke(ch, ...args)
  return Promise.reject(new Error('Invalid IPC channel: ' + ch))
}

contextBridge.exposeInMainWorld('nexus', {
  exitOS: () => safeSend('app:exit'),
  minimizeOS: () => safeSend('app:minimize'),
  restoreOS: () => safeSend('app:restore'),
  getSystemInfo: () => safeInvoke('app:getSystemInfo'),
  scanDirectory: (p) => safeInvoke('fs:scanDirectory', p),
  readFile: (p) => safeInvoke('fs:readFile', p),
  runProverbs: (cmd) => safeInvoke('proverbs:run', String(cmd).slice(0, 200)),
  runClaude: (cmd) => safeInvoke('claude:run', String(cmd).slice(0, 2000)),
  displayList: () => safeInvoke('display:list'),
  displaySetMode: (mode) => safeInvoke('display:setMode', String(mode)),
  getVersion: () => safeInvoke('app:getVersion'),
  checkForUpdate: () => safeInvoke('app:checkUpdate'),
  applyUpdate: () => safeInvoke('app:applyUpdate'),
  // rev update — Proverbs-powered OS + repo fixer
  revUpdate: (issue) => safeInvoke('rev:update', String(issue).slice(0, 2000)),
  revRebuild: () => safeInvoke('rev:rebuild'),
  revListRepos: () => safeInvoke('rev:listRepos'),
  onRevProgress: (cb) => {
    const fn = (_e, data) => cb(data)
    ipcRenderer.on('rev:progress', fn)
    return () => ipcRenderer.removeListener('rev:progress', fn)
  },
  wifiStatus: () => safeInvoke('wifi:status'),
  wifiScan: () => safeInvoke('wifi:scan'),
  wifiConnect: (ssid, pw) => safeInvoke('wifi:connect', ssid, pw),
  wifiDisconnect: () => safeInvoke('wifi:disconnect'),
  downloadList: () => safeInvoke('download:list'),
  downloadOpen: (p) => safeInvoke('download:open', p),
  downloadReveal: (p) => safeInvoke('download:reveal', p),
  downloadClear: () => safeInvoke('download:clear'),
  onDownloadUpdate: (cb) => { const fn = (_e, d) => cb(d); ipcRenderer.on('download:update', fn); return () => ipcRenderer.removeListener('download:update', fn) },
  onDownloadDone: (cb) => { const fn = (_e, d) => cb(d); ipcRenderer.on('download:done', fn); return () => ipcRenderer.removeListener('download:done', fn) },
  btStatus: () => safeInvoke('bt:status'),
  btToggle: (on) => safeInvoke('bt:toggle', on),
  btConnect: (addr) => safeInvoke('bt:connect', addr),
  btDisconnect: (addr) => safeInvoke('bt:disconnect', addr),
  batteryStatus: () => safeInvoke('battery:status'),
  volumeGet: () => safeInvoke('volume:get'),
  volumeSet: (level) => safeInvoke('volume:set', level),
  volumeMute: (mute) => safeInvoke('volume:mute', mute),
  onNotification: (cb) => {
    const fn = (_e, data) => { if (data?.title) cb(data) }
    ipcRenderer.on('notification:push', fn)
    return () => ipcRenderer.removeListener('notification:push', fn)
  },
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
})

delete window.require
delete window.exports
delete window.module
