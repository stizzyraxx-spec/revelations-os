import { useEffect } from 'react'
import { useOSStore } from '../store'
import { X, ExternalLink, Star, Check } from 'lucide-react'
import AppIcon3D from './AppIcon3D'

const FEATURES_BY_CATEGORY = {
  finance: ['Real-time financial reporting', 'Multi-account management', 'Tax compliance automation', 'Invoice & billing system', 'AI-powered insights'],
  commerce: ['Product catalog management', 'Order processing & fulfillment', 'Customer management CRM', 'Payment processing', 'Analytics dashboard'],
  media: ['Professional audio processing', 'Stem separation technology', 'Cloud storage integration', 'Real-time preview', 'Export to all formats'],
  legal: ['Document management system', 'US legal corpus search', 'Client matter tracking', 'Billing & time tracking', 'Secure document vault'],
  health: ['Patient record management', 'HIPAA-compliant storage', 'Appointment scheduling', 'Lab result tracking', 'Reporting & analytics'],
  marketing: ['Campaign management', 'Audience targeting tools', 'ROI tracking & analytics', 'Multi-platform publishing', 'A/B testing suite'],
  dev: ['Code intelligence scanning', 'Project analysis engine', 'Security vulnerability detection', 'Performance optimization', 'Team collaboration'],
  productivity: ['Smart task management', 'Calendar integration', 'Team collaboration', 'File management', 'Progress tracking'],
  default: ['Streamlined workflow management', 'Team collaboration tools', 'Advanced analytics', 'Cloud sync & backup', 'Priority support'],
}

export default function SubscriptionModal() {
  const { subscriptionApp, closeSubscription } = useOSStore()

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') closeSubscription() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [])

  if (!subscriptionApp) return null
  const app = subscriptionApp
  const features = FEATURES_BY_CATEGORY[app.category] || FEATURES_BY_CATEGORY.default

  return (
    <div
      style={{ position:'fixed', inset:0, zIndex:9999, background:'rgba(0,0,0,0.8)', backdropFilter:'blur(16px)', WebkitBackdropFilter:'blur(16px)', display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={closeSubscription}
    >
      <div
        className="glass-strong animate-scale-in"
        style={{ width:560, maxHeight:'90vh', borderRadius:28, overflow:'hidden', boxShadow:'var(--shadow-lg)', display:'flex', flexDirection:'column' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Hero header */}
        <div style={{ padding:'32px 32px 24px', background:`linear-gradient(135deg, ${app.color}33, ${app.color}11)`, borderBottom:'1px solid var(--border)', position:'relative' }}>
          <button onClick={closeSubscription} style={{ position:'absolute', top:16, right:16, background:'rgba(255,255,255,0.06)', border:'1px solid var(--border)', borderRadius:8, cursor:'pointer', color:'var(--text-muted)', padding:6 }}>
            <X size={16}/>
          </button>
          <div style={{ display:'flex', alignItems:'center', gap:16 }}>
            <div className="rx-icon-host" style={{ display:'flex' }}>
              <AppIcon3D app={app} size={64}/>
            </div>
            <div>
              <h2 style={{ fontSize:'1.4rem', fontWeight:800, marginBottom:4 }}>{app.name}</h2>
              <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                <span style={{ padding:'2px 10px', borderRadius:20, fontSize:'0.72rem', fontWeight:600, background:`${app.color}33`, color:app.color, textTransform:'capitalize' }}>{app.category}</span>
                <div style={{ display:'flex', gap:1 }}>
                  {[1,2,3,4,5].map(i => <Star key={i} size={11} fill="#f59e0b" color="#f59e0b"/>)}
                </div>
              </div>
            </div>
          </div>
          <p style={{ marginTop:14, color:'var(--text-secondary)', fontSize:'0.88rem', lineHeight:1.6 }}>{app.desc}</p>
        </div>

        {/* Features + pricing */}
        <div style={{ flex:1, overflowY:'auto', padding:'24px 32px' }}>
          <div style={{ marginBottom:20 }}>
            <div style={{ fontSize:'0.78rem', fontWeight:600, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:12 }}>What's included</div>
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {features.map(f => (
                <div key={f} style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <div style={{ width:20, height:20, borderRadius:6, background:`${app.color}22`, border:`1px solid ${app.color}44`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    <Check size={12} color={app.color}/>
                  </div>
                  <span style={{ fontSize:'0.85rem', color:'var(--text-secondary)' }}>{f}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Pricing */}
          <div style={{ padding:20, borderRadius:16, background:'rgba(255,255,255,0.03)', border:'1px solid var(--border)', textAlign:'center', marginBottom:20 }}>
            <div style={{ fontSize:'2rem', fontWeight:800, color:'var(--text-primary)' }}>{app.price}</div>
            {app.trial && app.trial !== 'N/A' && (
              <div style={{ color:'#22c55e', fontSize:'0.82rem', marginTop:4 }}>✓ {app.trial} free trial — no credit card required</div>
            )}
            <div style={{ color:'var(--text-muted)', fontSize:'0.75rem', marginTop:6 }}>Cancel anytime. Secure payment via Stripe.</div>
          </div>
        </div>

        {/* Actions */}
        <div style={{ padding:'16px 32px 24px', borderTop:'1px solid var(--border)', display:'flex', gap:12 }}>
          <button
            className="btn-primary"
            style={{ flex:1, height:48, fontSize:'0.95rem' }}
            onClick={() => {
              // Open as live webview inside Revelations OS — updates sync automatically
              const liveUrl = app.liveUrl || `https://apps.revelationsos.com/${app.id}`
              useOSStore.getState().openWindow({
                appId: `raxx_${app.id}`,
                title: app.name,
                width: 1100,
                height: 720,
                props: { liveUrl, appId: app.id, appName: app.name },
              })
              closeSubscription()
            }}
          >
            <ExternalLink size={16}/> Launch {app.name}
          </button>
          <button className="btn-ghost" onClick={closeSubscription} style={{ height:48, padding:'0 20px' }}>
            Later
          </button>
        </div>
      </div>
    </div>
  )
}
