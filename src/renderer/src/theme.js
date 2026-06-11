// Live theme application — wallpaper + accent color from revos_settings.
// Settings.jsx dispatches 'revos:settings-changed' after every update;
// Desktop listens to re-render the wallpaper, and applyAccent hot-swaps CSS vars.

export const WALLPAPERS = {
  nebula: 'linear-gradient(135deg, #000428, #00235a, #003a8c, #001f4d, #000c2e, #001a5c, #000428)',
  cosmos: 'linear-gradient(135deg, #0d0221, #2d0b4e, #1a0533, #3b0764, #170230, #2d0b4e, #0d0221)',
  aurora: 'linear-gradient(135deg, #001510, #013a2d, #00574a, #014d3c, #00251c, #013a2d, #001510)',
  void: 'linear-gradient(135deg, #000000, #0c0c14, #16161f, #0a0a12, #050508, #101018, #000000)',
}

// Derived shades per accent so glow/hover/border stay consistent with the swatch
const ACCENT_VARIANTS = {
  '#6d28d9': { two: '#7c3aed', hover: '#8b5cf6', glow: 'rgba(109,40,217,0.28)', border: 'rgba(109,40,217,0.42)' },
  '#2563eb': { two: '#3b82f6', hover: '#60a5fa', glow: 'rgba(37,99,235,0.28)', border: 'rgba(37,99,235,0.42)' },
  '#059669': { two: '#10b981', hover: '#34d399', glow: 'rgba(5,150,105,0.28)', border: 'rgba(5,150,105,0.42)' },
  '#dc2626': { two: '#ef4444', hover: '#f87171', glow: 'rgba(220,38,38,0.28)', border: 'rgba(220,38,38,0.42)' },
  '#d97706': { two: '#f59e0b', hover: '#fbbf24', glow: 'rgba(217,119,6,0.28)', border: 'rgba(217,119,6,0.42)' },
  '#db2777': { two: '#ec4899', hover: '#f472b6', glow: 'rgba(219,39,119,0.28)', border: 'rgba(219,39,119,0.42)' },
}

export function applyAccent(color) {
  if (!color) return
  const v = ACCENT_VARIANTS[color] || ACCENT_VARIANTS['#6d28d9']
  const root = document.documentElement.style
  root.setProperty('--accent', color)
  root.setProperty('--accent-2', v.two)
  root.setProperty('--accent-hover', v.hover)
  root.setProperty('--accent-glow', v.glow)
  root.setProperty('--border-accent', v.border)
}

export function getSettings() {
  try { return JSON.parse(localStorage.getItem('revos_settings') || 'null') || {} } catch { return {} }
}

// Apply persisted accent on boot
export function applySavedTheme() {
  applyAccent(getSettings().accentColor)
}
