import Fuse from 'fuse.js'

// ─── FUZZY SEARCH ───────────────────────────────────────────────────────────
let fuseInstance = null

export function buildSearchIndex(items) {
  fuseInstance = new Fuse(items, {
    keys: ['name', 'description', 'category'],
    threshold: 0.35,
    includeScore: true,
  })
}

export function fuzzySearch(query) {
  if (!fuseInstance || !query) return []
  return fuseInstance.search(query).map((r) => r.item)
}

// ─── FILE CATEGORIZATION ────────────────────────────────────────────────────
const FILE_RULES = [
  { exts: ['jpg','jpeg','png','gif','svg','webp','bmp','tiff','heic'], cat: 'image', icon: '🖼️' },
  { exts: ['mp4','mov','avi','mkv','webm','m4v','flv'], cat: 'video', icon: '🎬' },
  { exts: ['mp3','wav','flac','aac','m4a','ogg','wma'], cat: 'audio', icon: '🎵' },
  { exts: ['pdf'], cat: 'document', icon: '📄' },
  { exts: ['doc','docx'], cat: 'word', icon: '📝' },
  { exts: ['xls','xlsx','csv'], cat: 'spreadsheet', icon: '📊' },
  { exts: ['ppt','pptx'], cat: 'presentation', icon: '📊' },
  { exts: ['js','jsx','ts','tsx','py','rb','go','rs','cpp','c','java','kt','swift'], cat: 'code', icon: '💻' },
  { exts: ['html','css','scss','json','xml','yaml','yml','toml'], cat: 'markup', icon: '🔧' },
  { exts: ['zip','tar','gz','rar','7z','bz2'], cat: 'archive', icon: '📦' },
  { exts: ['dmg','exe','msi','pkg','deb','rpm','AppImage'], cat: 'installer', icon: '⚙️' },
  { exts: ['txt','md','log','csv'], cat: 'text', icon: '📃' },
  { exts: ['ttf','otf','woff','woff2'], cat: 'font', icon: '🔤' },
]

export function categorizeFile(filename) {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const rule = FILE_RULES.find((r) => r.exts.includes(ext))
  return rule || { cat: 'other', icon: '📁' }
}

export function sortFiles(files, method = 'name-asc') {
  const arr = [...files]
  const [field, dir] = method.split('-')
  arr.sort((a, b) => {
    let va = a[field], vb = b[field]
    if (typeof va === 'string') va = va.toLowerCase()
    if (typeof vb === 'string') vb = vb.toLowerCase()
    if (va < vb) return dir === 'asc' ? -1 : 1
    if (va > vb) return dir === 'asc' ? 1 : -1
    return 0
  })
  return arr
}

// ─── ANOMALY DETECTION (Z-SCORE) ────────────────────────────────────────────
export function detectAnomalies(values, threshold = 2.5) {
  if (!values.length) return []
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  const std = Math.sqrt(variance) || 1
  return values.map((v, i) => ({
    index: i,
    value: v,
    zScore: Math.abs((v - mean) / std),
    isAnomaly: Math.abs((v - mean) / std) > threshold,
  }))
}

// ─── COMMAND SUGGESTIONS ─────────────────────────────────────────────────────
const CMD_MAP = {
  ls: 'List directory contents',
  cd: 'Change directory',
  pwd: 'Print working directory',
  clear: 'Clear terminal',
  help: 'Show available commands',
  proverbs: 'Launch Proverbs CLI',
  neofetch: 'System information',
  history: 'Command history',
  whoami: 'Current user',
  date: 'Current date and time',
  echo: 'Print text',
  cat: 'Display file contents',
  mkdir: 'Make directory',
  touch: 'Create file',
  rm: 'Remove file',
  cp: 'Copy file',
  mv: 'Move/rename file',
  grep: 'Search text',
  find: 'Find files',
}

export function suggestCommand(partial) {
  if (!partial) return []
  const p = partial.toLowerCase()
  return Object.entries(CMD_MAP)
    .filter(([cmd]) => cmd.startsWith(p))
    .map(([cmd, desc]) => ({ cmd, desc }))
}
