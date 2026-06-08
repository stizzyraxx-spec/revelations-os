import { Download, FolderOpen, Play, X, RefreshCw } from 'lucide-react'

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

function StateBadge({ state }) {
  if (state === 'completed') {
    return (
      <span style={{
        background: 'rgba(34,197,94,0.15)',
        color: '#22c55e',
        border: '1px solid rgba(34,197,94,0.3)',
        borderRadius: 4,
        padding: '1px 7px',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.3
      }}>Done</span>
    )
  }
  if (state === 'interrupted' || state === 'cancelled') {
    return (
      <span style={{
        background: 'rgba(239,68,68,0.15)',
        color: '#ef4444',
        border: '1px solid rgba(239,68,68,0.3)',
        borderRadius: 4,
        padding: '1px 7px',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.3
      }}>Failed</span>
    )
  }
  // progressing
  return (
    <span style={{
      background: 'rgba(59,130,246,0.15)',
      color: '#3b82f6',
      border: '1px solid rgba(59,130,246,0.3)',
      borderRadius: 4,
      padding: '1px 7px',
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: 0.3,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4
    }}>
      <RefreshCw size={10} style={{ animation: 'spin 1s linear infinite' }} />
      Downloading
    </span>
  )
}

export default function DownloadManager({ downloads = [], onOpen, onReveal, onClear, onClose }) {
  return (
    <>
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .dm-icon-btn {
          background: none;
          border: none;
          cursor: pointer;
          padding: 4px;
          border-radius: 4px;
          color: var(--text-secondary, #9ca3af);
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.15s, color 0.15s;
        }
        .dm-icon-btn:hover {
          background: var(--bg-hover, rgba(255,255,255,0.08));
          color: var(--text-primary, #f3f4f6);
        }
        .dm-progress-bar {
          width: 100%;
          height: 4px;
          background: var(--border, rgba(255,255,255,0.1));
          border-radius: 2px;
          overflow: hidden;
          margin-top: 6px;
        }
        .dm-progress-fill {
          height: 100%;
          background: #3b82f6;
          border-radius: 2px;
          transition: width 0.3s ease;
        }
      `}</style>

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--bg-secondary, #1a1a2e)',
        color: 'var(--text-primary, #f3f4f6)',
        fontFamily: 'inherit'
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          borderBottom: '1px solid var(--border, rgba(255,255,255,0.08))',
          flexShrink: 0
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Download size={16} style={{ color: '#3b82f6' }} />
            <span style={{ fontWeight: 600, fontSize: 14 }}>Downloads</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {downloads.length > 0 && (
              <button
                className="dm-icon-btn"
                onClick={onClear}
                title="Clear All"
                style={{ fontSize: 11, padding: '3px 8px', borderRadius: 4, color: 'var(--text-secondary, #9ca3af)' }}
              >
                Clear All
              </button>
            )}
            <button className="dm-icon-btn" onClick={onClose} title="Close">
              <X size={15} />
            </button>
          </div>
        </div>

        {/* List */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: downloads.length === 0 ? 0 : '8px 0'
        }}>
          {downloads.length === 0 ? (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              gap: 10,
              color: 'var(--text-secondary, #6b7280)',
              fontSize: 13
            }}>
              <Download size={32} style={{ opacity: 0.25 }} />
              <span>No downloads yet</span>
            </div>
          ) : (
            downloads.map((dl) => {
              const pct = dl.totalBytes > 0
                ? Math.round((dl.receivedBytes / dl.totalBytes) * 100)
                : 0

              return (
                <div
                  key={dl.id}
                  style={{
                    padding: '10px 16px',
                    borderBottom: '1px solid var(--border, rgba(255,255,255,0.05))',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4
                  }}
                >
                  {/* Row 1: filename + actions */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{
                      fontWeight: 700,
                      fontSize: 13,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1
                    }} title={dl.filename}>
                      {dl.filename}
                    </span>
                    {dl.state === 'completed' && (
                      <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                        <button
                          className="dm-icon-btn"
                          onClick={() => onReveal && onReveal(dl)}
                          title="Show in Folder"
                        >
                          <FolderOpen size={14} />
                        </button>
                        <button
                          className="dm-icon-btn"
                          onClick={() => onOpen && onOpen(dl)}
                          title="Open File"
                        >
                          <Play size={14} />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Row 2: size + badge */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary, #6b7280)' }}>
                      {dl.state === 'progressing' && dl.totalBytes > 0
                        ? `${formatBytes(dl.receivedBytes)} / ${formatBytes(dl.totalBytes)}`
                        : formatBytes(dl.totalBytes || dl.receivedBytes)}
                    </span>
                    <StateBadge state={dl.state} />
                    {dl.state === 'progressing' && dl.totalBytes > 0 && (
                      <span style={{ fontSize: 11, color: '#3b82f6', marginLeft: 'auto' }}>{pct}%</span>
                    )}
                  </div>

                  {/* Progress bar (only when progressing) */}
                  {dl.state === 'progressing' && dl.totalBytes > 0 && (
                    <div className="dm-progress-bar">
                      <div className="dm-progress-fill" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    </>
  )
}
