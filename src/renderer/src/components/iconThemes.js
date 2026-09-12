// Per-app icon palettes. Each app gets its own two-stop gradient so the launcher
// reads as a set of distinct, Fluent-style tiles rather than one tinted icon
// repeated in different hues. `from` is the lit top-left face, `to` is the
// shaded bottom-right face; the bevel and shadows in AppIcon3D are built from
// those two stops.
//
//   id: [from, to]            -> white glyph
//   id: [from, to, glyph]     -> explicit glyph colour (light plates need a dark glyph)

export const ICON_THEMES = {
  // Faith
  'bible':          ['#8b5cf6', '#4c1d95'],
  'bible-plans':    ['#a78bfa', '#5b21b6'],
  'verse-of-day':   ['#fbbf24', '#c2410c'],
  'prayer-wall':    ['#f472b6', '#9d174d'],
  'petitions':      ['#fb923c', '#9a3412'],
  'forums':         ['#38bdf8', '#075985'],
  'community-hub':  ['#34d399', '#047857'],
  'live-stream':    ['#fb7185', '#9f1239'],
  'discover-faith': ['#c084fc', '#6b21a8'],
  'faith-games':    ['#67e8f9', '#0891b2'],
  'bookmarks':      ['#a3e635', '#3f6212'],
  'donate-faith':   ['#4ade80', '#15803d'],
  'gatherings':     ['#a78bfa', '#3730a3'],
  'my-profile':     ['#c4b5fd', '#6d28d9'],

  // System
  'calculator':     ['#94a3b8', '#1e293b'],
  'clock':          ['#22d3ee', '#0e7490'],
  'music':          ['#d8b4fe', '#7e22ce'],
  'photos':         ['#7dd3fc', '#0369a1'],
  'videos':         ['#f9a8d4', '#a21caf'],
  'calendar':       ['#f87171', '#991b1b'],
  'privacy':        ['#6ee7b7', '#065f46'],
  'support':        ['#93c5fd', '#1d4ed8'],
  'mail':           ['#38bdf8', '#0c4a6e'],
  'meetings':       ['#86efac', '#15803d'],
  'stickynotes':    ['#fde68a', '#ca8a04', '#422006'],
  'notifications':  ['#fdba74', '#ea580c'],
  'calconnect':     ['#a5b4fc', '#3730a3'],
  'ephesians':      ['#60a5fa', '#1e3a8a'],
  'files':          ['#fcd34d', '#b45309'],
  'scrolls':        ['#fbbf24', '#92400e'],
  'settings':       ['#cbd5e1', '#475569'],
  'terminal':       ['#34d399', '#064e3b'],
  'terminalx':      ['#6ee7b7', '#115e59'],
  'notepad':        ['#e2e8f0', '#64748b', '#1e293b'],
  'pcscanfix':      ['#86efac', '#166534'],
  'appstore':       ['#a78bfa', '#4338ca'],
  'celestia':       ['#5eead4', '#0f766e'],

  // Dev / admin
  'proverbs':       ['#818cf8', '#312e81'],
  'ideaplanner':    ['#facc15', '#a16207'],
  'admincenter':    ['#60a5fa', '#1e40af'],
  'raxxware':       ['#fbbf24', '#78350f'],
}

const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)))

function toRgb(hex) {
  let h = String(hex || '').replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h, 16)
  if (Number.isNaN(n) || h.length !== 6) return { r: 124, g: 58, b: 237 }
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

const toHex = ({ r, g, b }) =>
  '#' + [r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('')

/** Linear blend of two hex colours. t=0 -> a, t=1 -> b. */
export function mix(a, b, t) {
  const c1 = toRgb(a)
  const c2 = toRgb(b)
  return toHex({
    r: c1.r + (c2.r - c1.r) * t,
    g: c1.g + (c2.g - c1.g) * t,
    b: c1.b + (c2.b - c1.b) * t,
  })
}

/** Relative luminance, used to decide whether a plate needs a dark glyph. */
function luminance(hex) {
  const { r, g, b } = toRgb(hex)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

/**
 * Resolve the plate colours for an app. Apps listed in ICON_THEMES use their
 * hand-picked pair; anything else derives a lit/shaded pair from `app.color`
 * so newly registered apps still get a proper 3D plate.
 */
export function getIconTheme(app) {
  const preset = ICON_THEMES[app?.id]
  const base = app?.color || '#7c3aed'
  const from = preset ? preset[0] : mix(base, '#ffffff', 0.38)
  const to = preset ? preset[1] : mix(base, '#000000', 0.34)
  const glyph = preset?.[2] || (luminance(mix(from, to, 0.5)) > 0.72 ? '#1e293b' : '#ffffff')
  return {
    from,
    to,
    mid: mix(from, to, 0.48),
    edge: mix(from, '#ffffff', 0.55), // top rim catch-light
    deep: mix(to, '#000000', 0.45),   // contact shadow under the plate
    glyph,
  }
}
