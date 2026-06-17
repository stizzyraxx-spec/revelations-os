import { useState } from 'react'
import { Shield, HelpCircle, Mail, ChevronDown, ChevronRight } from 'lucide-react'

const FAQ = [
  {
    q: 'How do I reset my Revelations OS password?',
    a: 'Click on your avatar in the top-right corner → Sign Out, then re-launch the app. On the login screen you can enter any name to create a new session. For subscription account resets, email stizzyraxx@gmail.com.',
  },
  {
    q: 'My app is not loading inside the viewer. What should I do?',
    a: 'Make sure you have an active internet connection. Some apps require a subscription — click the app icon and follow the subscription flow. If a subscribed app fails, right-click the window → Close, then reopen it.',
  },
  {
    q: 'How do I cancel my subscription?',
    a: 'Email stizzyraxx@gmail.com with your account email and the app name. We process cancellations within 24 hours and confirm via email.',
  },
  {
    q: 'Is my data stored locally or in the cloud?',
    a: 'Revelations OS stores your local preferences (wallpaper, pinned dock apps, quick notes, calendar events) on your device only. Subscription apps may store data per their own privacy policies. We do not collect personal usage data from the OS itself.',
  },
  {
    q: 'Can I use Revelations OS on multiple computers?',
    a: 'The OS itself can be installed on any Mac. Subscription app licenses are tied to your account email — contact support to manage multi-device access.',
  },
  {
    q: 'How do I report a bug or request a feature?',
    a: 'Email stizzyraxx@gmail.com with the subject line "Bug Report" or "Feature Request". Include your OS version (visible in Settings) and a description of the issue.',
  },
]

function FAQItem({ q, a }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, overflow: 'hidden', marginBottom: 8 }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px',
        background: open ? 'rgba(124,58,237,0.1)' : 'rgba(255,255,255,0.02)', border: 'none', cursor: 'pointer', color: '#fff', textAlign: 'left',
      }}>
        {open ? <ChevronDown size={16} color="#a78bfa" /> : <ChevronRight size={16} color="#666" />}
        <span style={{ flex: 1, fontSize: '0.85rem', fontWeight: 500 }}>{q}</span>
      </button>
      {open && (
        <div style={{ padding: '0 16px 14px 44px', fontSize: '0.82rem', color: '#aaa', lineHeight: 1.7 }}>{a}</div>
      )}
    </div>
  )
}

export default function PrivacySupport({ initialTab = 'support' }) {
  const [tab, setTab] = useState(initialTab)
  const [form, setForm] = useState({ name: '', email: '', message: '' })
  const [sent, setSent] = useState(false)

  const handleSend = (e) => {
    e.preventDefault()
    // Opens default mail client with pre-filled message
    const subject = encodeURIComponent('Revelations OS Support Request')
    const body = encodeURIComponent(`Name: ${form.name}\nEmail: ${form.email}\n\nMessage:\n${form.message}`)
    window.open(`mailto:stizzyraxx@gmail.com?subject=${subject}&body=${body}`)
    setSent(true)
    setTimeout(() => setSent(false), 4000)
  }

  return (
    <div style={{ height: '100%', background: '#08080f', color: '#fff', fontFamily: 'system-ui', display: 'flex', flexDirection: 'column' }}>
      {/* Tabs */}
      <div style={{ display: 'flex', gap: 6, padding: '14px 20px 0', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        {[
          { id: 'support', icon: HelpCircle, label: 'Support' },
          { id: 'privacy', icon: Shield, label: 'Privacy Policy' },
        ].map(({ id, icon: Icon, label }) => (
          <button key={id} onClick={() => setTab(id)} style={{
            display: 'flex', alignItems: 'center', gap: 7, padding: '8px 16px 12px',
            border: 'none', background: 'none', cursor: 'pointer',
            color: tab === id ? '#a78bfa' : '#666', fontWeight: 500, fontSize: '0.85rem',
            borderBottom: `2px solid ${tab === id ? '#7c3aed' : 'transparent'}`, marginBottom: -1,
          }}>
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px' }}>
        {tab === 'support' && (
          <div style={{ maxWidth: 700 }}>
            <h2 style={{ fontWeight: 700, fontSize: '1.3rem', marginBottom: 6 }}>Support Center</h2>
            <p style={{ color: '#888', fontSize: '0.85rem', marginBottom: 24 }}>We typically respond within 48 hours. Email: <a href="mailto:stizzyraxx@gmail.com" style={{ color: '#a78bfa' }}>stizzyraxx@gmail.com</a></p>

            <h3 style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: 12, color: '#ccc' }}>Frequently Asked Questions</h3>
            {FAQ.map((f, i) => <FAQItem key={i} q={f.q} a={f.a} />)}

            <h3 style={{ fontWeight: 600, fontSize: '0.95rem', margin: '28px 0 14px', color: '#ccc' }}>Contact Us</h3>
            {sent ? (
              <div style={{ background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: 12, padding: '16px 20px', color: '#6ee7b7', fontWeight: 500 }}>
                ✓ Mail client opened — your message is ready to send!
              </div>
            ) : (
              <form onSubmit={handleSend} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', gap: 12 }}>
                  <input required placeholder="Your Name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '10px 14px', color: '#fff', fontSize: '0.85rem', outline: 'none' }} />
                  <input required type="email" placeholder="Your Email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                    style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '10px 14px', color: '#fff', fontSize: '0.85rem', outline: 'none' }} />
                </div>
                <textarea required rows={5} placeholder="Describe your issue or question..." value={form.message} onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '10px 14px', color: '#fff', fontSize: '0.85rem', outline: 'none', resize: 'vertical', fontFamily: 'inherit' }}
                />
                <button type="submit" style={{ background: '#7c3aed', border: 'none', borderRadius: 10, padding: '11px', cursor: 'pointer', color: '#fff', fontWeight: 600, fontSize: '0.88rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <Mail size={16} /> Open in Mail App
                </button>
              </form>
            )}
          </div>
        )}

        {tab === 'privacy' && (
          <div style={{ maxWidth: 700, fontSize: '0.85rem', lineHeight: 1.8, color: '#bbb' }}>
            <h2 style={{ fontWeight: 700, fontSize: '1.3rem', marginBottom: 6, color: '#fff' }}>Privacy Policy</h2>
            <p style={{ color: '#666', marginBottom: 24 }}>Last updated: June 2026 &nbsp;·&nbsp; RAXX BEATS STUDIOS LLC</p>

            {[
              { title: 'Who We Are', body: 'Revelations OS is developed by RAXX BEATS STUDIOS LLC, owned by Shane Bedasee. Contact: stizzyraxx@gmail.com' },
              { title: 'What We Collect', body: 'Revelations OS collects minimal data. Locally on your device: display name entered at login, wallpaper preference, dock pin settings, quick notes, and calendar events. None of this is transmitted to our servers. Subscription apps (accessed via the embedded viewer) may collect data per their own policies — please review each app\'s privacy policy.' },
              { title: 'How We Use Your Data', body: 'Local data is used solely to personalize your OS experience. We do not sell, share, or monetize any personal data collected through Revelations OS itself.' },
              { title: 'Third-Party Services', body: 'Subscription apps embedded in Revelations OS are independent services. When you access them, you are subject to their respective privacy policies. Payment processing for subscriptions uses Stripe — see stripe.com/privacy.' },
              { title: 'Cookies', body: 'Revelations OS does not use cookies. The embedded browser (Ephesians) may store cookies locally for sites you visit — these remain on your device and are not accessed by us.' },
              { title: 'Data Storage & Security', body: 'All OS data is stored locally on your device using Electron\'s localStorage. It is not encrypted at rest. Do not store sensitive information (passwords, financial data) in Quick Notes or Calendar.' },
              { title: 'Your Rights (GDPR/CCPA)', body: 'You may delete all local OS data at any time by uninstalling Revelations OS. For subscription app data deletion requests, contact the respective app\'s support or email us at stizzyraxx@gmail.com.' },
              { title: 'Children\'s Privacy', body: 'Revelations OS is not directed at children under 13. We do not knowingly collect data from minors.' },
              { title: 'Contact', body: 'For privacy concerns: stizzyraxx@gmail.com · RAXX BEATS STUDIOS LLC · Wellington, FL' },
            ].map(({ title, body }) => (
              <div key={title} style={{ marginBottom: 20 }}>
                <h3 style={{ fontWeight: 600, fontSize: '0.92rem', color: '#fff', marginBottom: 6 }}>{title}</h3>
                <p style={{ margin: 0 }}>{body}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
