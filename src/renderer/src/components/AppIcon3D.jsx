import { useCallback, useRef } from 'react'
import { getAppIcon } from './appIcons'
import { getIconTheme } from './iconThemes'

// Maximum tilt, in degrees, at the far edge of the plate.
const MAX_TILT = 15

/**
 * A Windows-style app icon: a bevelled, gradient-filled squircle with a crisp
 * white glyph. On hover it tilts in 3D under the pointer and the glyph lifts off
 * the plate — no glow, all depth.
 *
 * The tilt also fires when an ancestor carrying `.rx-icon-host` is hovered, so a
 * tile or list row can drive the icon from anywhere inside it.
 */
export default function AppIcon3D({ app, size = 48, radius, className = '', style, interactive = true }) {
  const Icon = getAppIcon(app.icon)
  const t = getIconTheme(app)
  const stackRef = useRef(null)
  const rad = radius ?? Math.round(size * 0.26)

  const handleMove = useCallback((e) => {
    const el = stackRef.current
    if (!interactive || !el) return
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return
    const px = (e.clientX - r.left) / r.width - 0.5
    const py = (e.clientY - r.top) / r.height - 0.5
    el.style.setProperty('--rx-ry', `${(px * MAX_TILT * 2).toFixed(2)}deg`)
    el.style.setProperty('--rx-rx', `${(-py * MAX_TILT * 2).toFixed(2)}deg`)
    el.style.setProperty('--rx-mx', `${((px + 0.5) * 100).toFixed(1)}%`)
    el.style.setProperty('--rx-my', `${((py + 0.5) * 100).toFixed(1)}%`)
  }, [interactive])

  // Drop the inline overrides so the stylesheet's resting/hover values take back over.
  const handleLeave = useCallback(() => {
    const el = stackRef.current
    if (!el) return
    for (const p of ['--rx-rx', '--rx-ry', '--rx-mx', '--rx-my']) el.style.removeProperty(p)
  }, [])

  return (
    <span
      className={`rx-icon${interactive ? '' : ' rx-icon--static'}${className ? ' ' + className : ''}`}
      onMouseMove={interactive ? handleMove : undefined}
      onMouseLeave={interactive ? handleLeave : undefined}
      style={{
        '--rx-size': `${size}px`,
        '--rx-radius': `${rad}px`,
        '--rx-from': t.from,
        '--rx-mid': t.mid,
        '--rx-to': t.to,
        '--rx-edge': t.edge,
        '--rx-deep': t.deep,
        ...style,
      }}
    >
      <span className="rx-icon__stack" ref={stackRef}>
        <span className="rx-icon__plate" />
        <span className="rx-icon__sheen" />
        <span className="rx-icon__glyph">
          <Icon size={Math.round(size * 0.5)} color={t.glyph} strokeWidth={2.15} />
        </span>
      </span>
    </span>
  )
}
