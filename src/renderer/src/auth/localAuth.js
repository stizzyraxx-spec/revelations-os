// Local password gate for Revelations OS.
//
// A single local password unlocks the OS. It is never stored in plaintext:
// we keep a random per-install salt and the SHA-256 of (salt + password) in
// localStorage. This is a local access gate, not a secrets vault — it keeps
// the OS from opening without the password, and works fully offline.

const KEY = 'revos_auth_v1'

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

// Has the user set a password yet on this install?
export function hasPassword() {
  return !!localStorage.getItem(KEY)
}

// Create (or replace) the unlock password.
export async function setPassword(pw) {
  const salt = randomSalt()
  const hash = await sha256Hex(salt + pw)
  localStorage.setItem(KEY, JSON.stringify({ salt, hash, v: 1 }))
}

// Check a candidate password against the stored hash.
export async function verifyPassword(pw) {
  try {
    const { salt, hash } = JSON.parse(localStorage.getItem(KEY) || '{}')
    if (!salt || !hash) return false
    const candidate = await sha256Hex(salt + pw)
    return candidate === hash
  } catch {
    return false
  }
}

// Remove the stored password (e.g. for a reset flow).
export function clearPassword() {
  localStorage.removeItem(KEY)
}
