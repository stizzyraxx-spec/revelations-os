import AppIcon3D from './AppIcon3D'

// Shared app tile matching the Revelations icon language: a dark glass card with
// a bevelled 3D app plate that tilts under the pointer, and the app name beneath.
export default function AppTile({ app, onClick, onContextMenu, size = 'md', badge = null, title }) {
  const dims = {
    sm: { card: 88, icon: 40, radius: 14, font: '0.64rem', pad: '12px 6px' },
    md: { card: 104, icon: 50, radius: 18, font: '0.72rem', pad: '16px 8px' },
    lg: { card: 124, icon: 60, radius: 20, font: '0.78rem', pad: '18px 10px' },
  }[size] || {}

  return (
    <button
      className="rx-icon-host"
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={title || app.desc || app.name}
      style={{
        position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 10, padding: dims.pad, width: '100%', minHeight: dims.card,
        background: 'linear-gradient(160deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02))',
        border: '1px solid rgba(255,255,255,0.08)', borderRadius: dims.radius, cursor: 'pointer',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)', transition: 'transform 0.14s, border-color 0.14s, background 0.14s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.18)'; e.currentTarget.style.background = 'linear-gradient(160deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))' }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = ''; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; e.currentTarget.style.background = 'linear-gradient(160deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02))' }}
    >
      <AppIcon3D app={app} size={dims.icon} />
      <span style={{ fontSize: dims.font, fontWeight: 600, color: '#fff', textAlign: 'center', width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 1.2 }}>
        {app.name}
      </span>
      {badge}
    </button>
  )
}
