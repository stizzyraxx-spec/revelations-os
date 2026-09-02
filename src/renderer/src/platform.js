// One source of truth for host-OS differences in the renderer.
//
// The same bundle ships in both the .dmg and the .exe, so anything that names a
// path, a modifier key or a platform tool has to ask here rather than assume a
// Mac. `window.nexus.platform` comes from the preload bridge; the userAgent
// sniff is only a fallback for `electron-vite dev` in a plain browser tab.
const detected =
  window.nexus?.platform ||
  (/Windows|Win32|Win64/i.test(navigator.userAgent) ? 'win32' : 'darwin')

export const PLATFORM = detected
export const IS_WIN = detected === 'win32'
export const IS_MAC = detected === 'darwin'

// Modifier key label for keyboard hints. The handlers themselves accept both
// Cmd and Ctrl everywhere; this is purely what the user is told to press.
export const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl'

export const OS_LABEL = IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : 'Linux'
