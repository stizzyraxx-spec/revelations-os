import { useState } from 'react'
import { Search, Star, Download, ExternalLink, Shield, Zap, Users, TrendingUp } from 'lucide-react'
import { APP_REGISTRY } from '../constants'
import { useOSStore } from '../store'
import Fuse from 'fuse.js'

const CATEGORIES = ['All', 'Business', 'Finance', 'Legal', 'Healthcare', 'Entertainment', 'Productivity', 'Security']

const FEATURED = ['taxflow', 'legalvault', 'govcoreerp', 'commandhq']

const RATINGS = { taxflow: 4.9, legalvault: 4.8, govcoreerp: 4.7, bowdwn: 4.6, pcscanfix: 5.0, celestia: 4.8, commandhq: 4.9 }

const fuse = new Fuse(APP_REGISTRY, { keys: ['name', 'desc', 'category'], threshold: 0.4 })

export default function AppStore() {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All')
  const [detail, setDetail] = useState(null)
  const { openWindow, openSubscription } = useOSStore()

  const results = search
    ? fuse.search(search).map((r) => r.item)
    : category === 'All'
    ? APP_REGISTRY
    : APP_REGISTRY.filter((a) => a.category === category)

  const featured = APP_REGISTRY.filter((a) => FEATURED.includes(a.id))

  const handleOpen = (app) => {
    if (app.free) openWindow({ appId: app.id, title: app.name })
    else openSubscription(app)
  }

  if (detail) {
    return <AppDetail app={detail} onBack={() => setDetail(null)} onOpen={handleOpen} />
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#080812' }}>
      {/* Hero */}
      <div style={{ padding: '20px 24px 16px', background: 'linear-gradient(135deg, rgba(109,40,217,0.2) 0%, rgba(30,64,175,0.2) 100%)', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>RAXX App Store</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 14 }}>Business-grade software by RAXX Beats Studios LLC</div>
        {/* Search */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 10, padding: '8px 14px', maxWidth: 420 }}>
          <Search size={15} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search apps..."
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: 14 }}
          />
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
        {/* Featured */}
        {!search && category === 'All' && (
          <section style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Featured</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
              {featured.map((app) => (
                <FeaturedCard key={app.id} app={app} rating={RATINGS[app.id]} onClick={() => setDetail(app)} />
              ))}
            </div>
          </section>
        )}

        {/* Category filter */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              style={{
                padding: '5px 14px', borderRadius: 99, border: '1px solid',
                borderColor: category === c ? 'var(--accent)' : 'rgba(255,255,255,0.12)',
                background: category === c ? 'rgba(109,40,217,0.3)' : 'rgba(255,255,255,0.04)',
                color: category === c ? 'var(--accent)' : 'var(--text-secondary)',
                cursor: 'pointer', fontSize: 12, fontWeight: 500,
              }}
            >
              {c}
            </button>
          ))}
        </div>

        {/* App list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {results.map((app) => (
            <AppRow key={app.id} app={app} rating={RATINGS[app.id]} onDetail={() => setDetail(app)} onOpen={() => handleOpen(app)} />
          ))}
          {results.length === 0 && (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>No apps found</div>
          )}
        </div>
      </div>

      {/* Stats footer */}
      <div style={{ display: 'flex', gap: 24, justifyContent: 'center', padding: '10px 24px', borderTop: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.2)' }}>
        {[
          { icon: <Shield size={14} />, label: `${APP_REGISTRY.length} Apps` },
          { icon: <Users size={14} />, label: 'Enterprise Ready' },
          { icon: <Zap size={14} />, label: 'Instant Access' },
          { icon: <TrendingUp size={14} />, label: 'Live Updates' },
        ].map((s) => (
          <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--text-muted)', fontSize: 11 }}>
            {s.icon} {s.label}
          </div>
        ))}
      </div>
    </div>
  )
}

function FeaturedCard({ app, rating, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: 14, borderRadius: 12, cursor: 'pointer',
        background: 'linear-gradient(135deg, rgba(109,40,217,0.15), rgba(30,64,175,0.1))',
        border: '1px solid rgba(109,40,217,0.25)',
        transition: 'transform 0.15s, border-color 0.15s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = 'rgba(109,40,217,0.5)' }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = ''; e.currentTarget.style.borderColor = 'rgba(109,40,217,0.25)' }}
    >
      <div style={{ fontSize: 32, marginBottom: 8 }}>{app.icon || '📦'}</div>
      <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>{app.name}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, lineHeight: 1.4 }}>{app.desc?.slice(0, 60)}...</div>
      {rating && <div style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#fbbf24', fontSize: 11 }}><Star size={11} fill="#fbbf24" /> {rating}</div>}
    </div>
  )
}

function AppRow({ app, rating, onDetail, onOpen }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 12px', borderRadius: 10, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', cursor: 'pointer' }} onClick={onDetail}>
      <div style={{ fontSize: 32, width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10, background: 'rgba(109,40,217,0.15)' }}>{app.icon || '📦'}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 14 }}>{app.name}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{app.desc}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 3 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', background: 'rgba(255,255,255,0.06)', padding: '1px 6px', borderRadius: 4 }}>{app.category}</span>
          {rating && <span style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 11, color: '#fbbf24' }}><Star size={10} fill="#fbbf24" /> {rating}</span>}
        </div>
      </div>
      <div style={{ flexShrink: 0, textAlign: 'right' }}>
        <div style={{ fontSize: 12, color: app.free ? '#6ee7b7' : 'var(--accent)', fontWeight: 600, marginBottom: 4 }}>{app.free ? 'FREE' : app.price || 'Subscribe'}</div>
        <button
          onClick={(e) => { e.stopPropagation(); onOpen() }}
          style={{ padding: '5px 14px', borderRadius: 6, background: 'rgba(109,40,217,0.3)', border: '1px solid rgba(109,40,217,0.5)', color: '#a78bfa', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
        >
          {app.free ? 'Open' : 'Get'}
        </button>
      </div>
    </div>
  )
}

function AppDetail({ app, onBack, onOpen }) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#080812' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13 }}>← Back</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <div style={{ display: 'flex', gap: 20, marginBottom: 24 }}>
          <div style={{ fontSize: 64 }}>{app.icon || '📦'}</div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>{app.name}</div>
            <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>{app.desc}</div>
            <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
              <button onClick={() => onOpen(app)} style={{ padding: '9px 24px', borderRadius: 8, background: 'linear-gradient(135deg, #6d28d9, #1e40af)', border: 'none', color: 'white', fontWeight: 700, cursor: 'pointer', fontSize: 14 }}>
                {app.free ? 'Open App' : 'Subscribe & Open'}
              </button>
            </div>
          </div>
        </div>
        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          {app.longDescription || app.desc}
        </div>
        {app.features && (
          <div style={{ marginTop: 20 }}>
            <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 10 }}>Features</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {app.features.map((f, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)', fontSize: 13 }}>
                  <span style={{ color: '#6ee7b7' }}>✓</span> {f}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
