// Staying signed in.
//
// Two separate problems were making Revelations OS look like it forgot you:
//
// 1. The signed-in session was never stored. Accounts persist fine -- localAuth
//    keeps them with a per-account salt and SHA-256 hash -- but `user.loggedIn`
//    lives only in the zustand store, which re-initialises on every page load.
//    So a returning user was pushed back through a screen that defaults to
//    "create account", which reads as the OS having lost them.
//
// 2. Served from the RaxxWare box, the OS sits behind the gateway's own auth at
//    the same origin. You already proved who you were to load the page at all,
//    so asking again is a second sign-in for one identity.
//
// Resolution order below is deliberate: the gateway is authoritative when it is
// reachable, the stored session covers reloads of the desktop build, and the
// login screen is the last resort rather than the default.

const SESSION_KEY = 'revos_session_v1';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

// Only ever the display identity. No password, no hash, no token: localStorage
// is readable by any script on the origin, so nothing here may be a credential.
// localAuth keeps the salted hashes; this file keeps a name and a clock.
export function saveSession(user) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      name: user.name,
      username: user.username || user.name,
      source: user.source || 'local',
      savedAt: Date.now(),
    }));
  } catch { /* private mode, quota — fall through to the login screen */ }
}

export function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!s || !s.name) return null;
    if (Date.now() - (s.savedAt || 0) > SESSION_TTL_MS) { clearSession(); return null; }
    return s;
  } catch { return null; }
}

export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* nothing to do */ }
}

// The gateway that serves this page. Same-origin, so the session cookie rides
// along; 401 simply means "not served from RaxxWare, or not signed in there",
// which is the normal case for the packaged desktop build.
async function gatewayIdentity() {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return null;
    const me = await res.json();
    if (!me || !me.username) return null;
    return { name: me.username, username: me.username, role: me.role, source: 'gateway' };
  } catch {
    return null; // offline or no gateway — not an error worth surfacing
  }
}

// Returns an identity to sign in with, or null to show the login screen.
export async function resolveIdentity() {
  const gw = await gatewayIdentity();
  if (gw) {
    // Refreshed on every boot so the stored copy cannot drift away from whoever
    // the gateway currently says is signed in.
    saveSession(gw);
    return gw;
  }
  return loadSession();
}
