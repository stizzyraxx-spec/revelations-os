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
  const uname = String(username || '').trim().toLowerCase()
  const account = getAccounts().find((a) => a.username.toLowerCase() === uname)
  if (!account) return null
  const candidate = await sha256Hex(account.salt + password)
  return candidate === account.hash ? publicAccount(account) : null
}

function publicAccount(a) {
  return { username: a.username, name: a.name, email: a.email, phone: a.phone }
}
