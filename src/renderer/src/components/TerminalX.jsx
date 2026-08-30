import { useState, useEffect, useRef, useCallback } from 'react'

// Terminal X — a real system shell. Commands are executed by the main process
// against PowerShell (Windows) / bash, and the actual output is streamed back.
export default function TerminalX() {
  const [lines, setLines] = useState([
    { type: 'banner', text: 'Terminal X — real system shell' },
    { type: 'muted', text: 'Runs actual commands on this machine. Type a command and press Enter. `clear` to reset.' },
  ])
  const [input, setInput] = useState('')
  const [cwd, setCwd] = useState('~')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState([])
  const [histIdx, setHistIdx] = useState(-1)
  const bottomRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    window.nexus?.termxCwd?.().then((c) => { if (c) setCwd(c) }).catch(() => {})
  }, [])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [lines])

  const add = useCallback((text, type = 'output') => setLines((p) => [...p, { type, text }]), [])

  const run = useCallback(async (raw) => {
    const cmd = raw.trim()
    if (!cmd) return
    setHistory((h) => [cmd, ...h.slice(0, 199)])
    setHistIdx(-1)
    add(`${cwd}> ${cmd}`, 'input')
    if (cmd === 'clear' || cmd === 'cls') { setLines([]); return }
    if (!window.nexus?.termxRun) { add('Shell bridge unavailable (run the packaged app).', 'error'); return }
    setBusy(true)
    try {
      const res = await window.nexus.termxRun(cmd)
      if (res?.cwd) setCwd(res.cwd)
      if (res?.output) add(res.output, 'output')
    } catch (err) {
      add(String(err?.message || err), 'error')
    } finally {
      setBusy(false)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [add, cwd])

  const onKey = (e) => {
    if (e.key === 'Enter' && !busy) { run(input); setInput('') }
    else if (e.key === 'ArrowUp') { e.preventDefault(); const i = Math.min(histIdx + 1, history.length - 1); setHistIdx(i); if (history[i]) setInput(history[i]) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); const i = Math.max(histIdx - 1, -1); setHistIdx(i); setInput(i === -1 ? '' : history[i]) }
  }

  const color = { banner: '#34d399', muted: '#64748b', input: '#6ee7b7', output: '#e2e8f0', error: '#f87171' }

  return (
    <div
      onClick={() => inputRef.current?.focus()}
      style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0a0a0f', fontFamily: "'JetBrains Mono','Fira Code','Courier New',monospace", fontSize: 13 }}
    >
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
        {lines.map((l, i) => (
          <pre key={i} style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: color[l.type] || '#e2e8f0', lineHeight: 1.5 }}>{l.text}</pre>
        ))}
        <div ref={bottomRef} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderTop: '1px solid rgba(255,255,255,0.08)', background: 'rgba(0,0,0,0.4)' }}>
        <span style={{ color: '#34d399', flexShrink: 0, maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cwd}&gt;</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          disabled={busy}
          autoFocus
          spellCheck={false}
          placeholder={busy ? 'running…' : ''}
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#e2e8f0', fontFamily: 'inherit', fontSize: 13, caretColor: '#34d399' }}
        />
        {busy && <div style={{ width: 10, height: 10, borderRadius: '50%', border: '2px solid #34d399', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />}
      </div>
    </div>
  )
}
