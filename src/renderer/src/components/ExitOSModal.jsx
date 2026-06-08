import { useEffect } from 'react'
import { useOSStore } from '../store'
import { LogOut, X } from 'lucide-react'

export default function ExitOSModal() {
  const { exitModalOpen, closeExitModal } = useOSStore()

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') closeExitModal() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  if (!exitModalOpen) return null

  const handleExit = () => {
    closeExitModal()
    window.nexus?.exitOS()
  }

  return (
    <div
      style={{ position:'fixed', inset:0, zIndex:9999, background:'rgba(0,0,0,0.78)', backdropFilter:'blur(12px)', WebkitBackdropFilter:'blur(12px)', display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={closeExitModal}
    >
      <div
        className="glass-strong animate-scale-in"
        style={{ width:440, borderRadius:24, padding:'40px 36px', boxShadow:'var(--shadow-lg)', textAlign:'center' }}
        onClick={e => e.stopPropagation()}
      >
        <button onClick={closeExitModal} style={{ position:'absolute', top:16, right:16, background:'none', border:'none', cursor:'pointer', color:'var(--text-muted)' }}>
          <X size={18}/>
        </button>
        <div style={{ width:64, height:64, borderRadius:'50%', background:'rgba(239,68,68,0.15)', border:'1px solid rgba(239,68,68,0.3)', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 20px' }}>
          <LogOut size={28} style={{ color:'#ef4444' }}/>
        </div>
        <h2 style={{ fontSize:'1.3rem', fontWeight:700, marginBottom:10 }}>Exit Revelations OS</h2>
        <p style={{ color:'var(--text-secondary)', fontSize:'0.9rem', lineHeight:1.6, marginBottom:28 }}>
          You will return to your host operating system.<br/>All unsaved work will be preserved in your session.
        </p>
        <div style={{ display:'flex', gap:12 }}>
          <button className="btn-ghost" onClick={closeExitModal} style={{ flex:1, height:44 }}>Cancel</button>
          <button onClick={handleExit} style={{ flex:1, height:44, background:'linear-gradient(135deg,#ef4444,#b91c1c)', color:'#fff', border:'none', borderRadius:12, cursor:'pointer', fontWeight:600, fontSize:'0.95rem', transition:'var(--transition)' }}
            onMouseEnter={e=>e.currentTarget.style.filter='brightness(1.1)'}
            onMouseLeave={e=>e.currentTarget.style.filter='brightness(1)'}
          >
            Exit OS
          </button>
        </div>
      </div>
    </div>
  )
}
