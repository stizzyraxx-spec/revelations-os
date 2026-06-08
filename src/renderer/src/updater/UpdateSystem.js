const STORAGE_KEY = 'revos_error_log'
const UPDATE_SEEN_KEY = 'revos_update_seen_ver'
const MAX_LOG = 200

export function logError(context, message, stack = '') {
  try {
    const logs = getErrorLog()
    logs.push({ ts: Date.now(), context, message: String(message).slice(0, 500), stack: String(stack).slice(0, 1000) })
    if (logs.length > MAX_LOG) logs.splice(0, logs.length - MAX_LOG)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(logs))
  } catch (_) {}
}

export function getErrorLog() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
  } catch (_) {
    return []
  }
}

export function analyzeErrors() {
  const logs = getErrorLog()
  if (!logs.length) return { total: 0, topContexts: [], recentErrors: [] }
  const ctx = {}
  logs.forEach((l) => { ctx[l.context] = (ctx[l.context] || 0) + 1 })
  const topContexts = Object.entries(ctx)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([context, count]) => ({ context, count }))
  const recentErrors = logs.slice(-10).reverse()
  return { total: logs.length, topContexts, recentErrors }
}

export function clearErrorLog() {
  localStorage.removeItem(STORAGE_KEY)
}

// Called on Monday check — returns true if we should prompt for update
export function shouldCheckUpdate(currentVersion) {
  const seen = localStorage.getItem(UPDATE_SEEN_KEY)
  return seen !== currentVersion
}

export function markUpdateSeen(version) {
  localStorage.setItem(UPDATE_SEEN_KEY, version)
}
