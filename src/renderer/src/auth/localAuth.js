// Local account system for Revelations OS.
//
// Accounts are stored locally (offline). Passwords are never kept in plaintext:
// each account has a random salt and the SHA-256 of (salt + password). This is a
// local access gate, not a secrets vault.

const ACCOUNTS_KEY = 'revos_accounts_v1'

function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return toHex(new Uint8Array(buf))
}
function randomSalt() {
  const a = new Uint8Array(16)
  crypto.getRandomValues(a)
  return toHex(a)
}

export function getAccounts() {
  try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '[]') } catch { return [] }
}
function saveAccounts(list) {
  try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list)) } catch {}
}

export function hasAccounts() {
  return getAccounts().length > 0
}

export function usernameTaken(username) {
  const u = String(username || '').trim().toLowerCase()
  return getAccounts().some((a) => a.username.toLowerCase() === u)
}

// Create a new account. Returns { ok, error?, account? }.
export async function createAccount({ username, name, email, phone, password }) {
  const uname = String(username || '').trim()
  if (uname.length < 3) return { ok: false, error: 'Username must be at least 3 characters' }
  if (!/^[a-zA-Z0-9_.-]+$/.test(uname)) return { ok: false, error: 'Username can only use letters, numbers, . _ -' }
  if (usernameTaken(uname)) return { ok: false, error: 'That username is already taken' }
  if (!String(name || '').trim()) return { ok: false, error: 'Please enter your name' }
  if (String(password || '').length < 6) return { ok: false, error: 'Password must be at least 6 characters' }

  const salt = randomSalt()
  const hash = await sha256Hex(salt + password)
  const account = {
    username: uname,
    name: String(name).trim(),
    email: String(email || '').trim(),
    phone: String(phone || '').trim(),
    salt,
    hash,
    createdAt: Date.now(),
  }
  const list = getAccounts()
  list.push(account)
  saveAccounts(list)
  return { ok: true, account: publicAccount(account) }
}

// Verify sign-in. Returns the public account on success, else null.
export async function verifyLogin(username, password) {
  const account = findAccount(username)
  if (!account) return null
  // A provisioned account has no hash yet. It must never be signable-into with
  // an empty password -- the set-password prompt is the only way in.
  if (!account.hash || account.pendingPassword) return null
  const candidate = await sha256Hex(account.salt + password)
  return candidate === account.hash ? publicAccount(account) : null
}

// Usernames are matched case-insensitively everywhere, so STIZZ, Stizz and
// stizz are one account. The original casing is kept only for display.
export function findAccount(username) {
  const u = String(username || '').trim().toLowerCase()
  if (!u) return null
  return getAccounts().find((a) => a.username.toLowerCase() === u) || null
}

// Create a local account for an identity the gateway has already authenticated.
// No password is set: the operator proved who they were to code.raxxware.com to
// load this page at all, and inventing one for them would be worse than asking.
// `pendingPassword` makes the OS prompt on arrival.
export function provisionAccount({ username, name, role }) {
  const uname = String(username || '').trim()
  if (!uname) return null
  const existing = findAccount(uname)
  if (existing) return publicAccount(existing)

  const account = {
    username: uname,
    // "stizz" reads better as "Stizz" on a lock screen.
    name: String(name || '').trim() || uname.charAt(0).toUpperCase() + uname.slice(1),
    email: '', phone: '',
    salt: randomSalt(),
    hash: null,
    pendingPassword: true,
    provisionedFrom: 'gateway',
    role: role || null,
    createdAt: Date.now(),
  }
  const list = getAccounts()
  list.push(account)
  saveAccounts(list)
  return publicAccount(account)
}

export function needsPassword(username) {
  const a = findAccount(username)
  return !!(a && (a.pendingPassword || !a.hash))
}

// Set (or reset) the password on an existing account.
export async function setPassword(username, password) {
  if (String(password || '').length < 6) {
    return { ok: false, error: 'Password must be at least 6 characters' }
  }
  const list = getAccounts()
  const u = String(username || '').trim().toLowerCase()
  const i = list.findIndex((a) => a.username.toLowerCase() === u)
  if (i < 0) return { ok: false, error: 'No such account' }

  // Fresh salt on every set, so a reset never reuses the old one.
  list[i].salt = randomSalt()
  list[i].hash = await sha256Hex(list[i].salt + password)
  list[i].pendingPassword = false
  saveAccounts(list)
  return { ok: true, account: publicAccount(list[i]) }
}

function publicAccount(a) {
  return { username: a.username, name: a.name, email: a.email, phone: a.phone }
}
