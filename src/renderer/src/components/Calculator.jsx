import { useState, useEffect, useCallback } from 'react'

const BTN = [
  ['C', '±', '%', '÷'],
  ['7', '8', '9', '×'],
  ['4', '5', '6', '−'],
  ['1', '2', '3', '+'],
  ['0', '.', '⌫', '='],
]

const isOp = (v) => ['÷', '×', '−', '+'].includes(v)

export default function Calculator() {
  const [display, setDisplay] = useState('0')
  const [expr, setExpr] = useState([])
  const [fresh, setFresh] = useState(true)
  const [history, setHistory] = useState([])

  const press = useCallback((val) => {
    if (val === 'C') { setDisplay('0'); setExpr([]); setFresh(true); return }
    if (val === '±') { setDisplay(d => d.startsWith('-') ? d.slice(1) : '-' + d); return }
    if (val === '%') { setDisplay(d => String(parseFloat(d) / 100)); return }
    if (val === '⌫') { setDisplay(d => d.length > 1 ? d.slice(0, -1) : '0'); return }

    if (isOp(val)) {
      setExpr([parseFloat(display), val])
      setFresh(true)
      return
    }

    if (val === '=') {
      if (expr.length === 2) {
        const [a, op] = expr
        const b = parseFloat(display)
        const opMap = { '÷': a/b, '×': a*b, '−': a-b, '+': a+b }
        const result = opMap[op]
        const resultStr = Number.isFinite(result) ? String(parseFloat(result.toFixed(10))) : 'Error'
        setHistory(h => [`${a} ${op} ${b} = ${resultStr}`, ...h].slice(0, 10))
        setDisplay(resultStr)
        setExpr([])
        setFresh(true)
      }
      return
    }

    if (val === '.') {
      if (fresh) { setDisplay('0.'); setFresh(false); return }
      if (!display.includes('.')) setDisplay(d => d + '.')
      return
    }

    if (fresh) { setDisplay(val); setFresh(false) }
    else setDisplay(d => d === '0' ? val : d + val)
  }, [display, expr, fresh])

  useEffect(() => {
    const map = { '/': '÷', '*': '×', '-': '−', '+': '+', 'Backspace': '⌫', 'Escape': 'C', 'Enter': '=' }
    const handler = (e) => {
      const v = map[e.key] || (e.key.match(/^[0-9.]$/) ? e.key : null)
      if (v) { e.preventDefault(); press(v) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [press])

  const btnColor = (v) => {
    if (['÷', '×', '−', '+', '='].includes(v)) return '#7c3aed'
    if (['C', '±', '%'].includes(v)) return '#374151'
    return '#1f2937'
  }

  return (
    <div style={{ display: 'flex', height: '100%', background: '#111', color: '#fff', fontFamily: 'system-ui' }}>
      {/* Calculator */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 16, gap: 12 }}>
        {/* Display */}
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'flex-end',
          background: '#000', borderRadius: 14, padding: '12px 18px', minHeight: 100,
        }}>
          <div style={{ fontSize: '0.75rem', color: '#666', marginBottom: 4 }}>
            {expr.length ? `${expr[0]} ${expr[1]}` : ''}
          </div>
          <div style={{ fontSize: display.length > 12 ? '1.6rem' : '2.8rem', fontWeight: 300, letterSpacing: -1 }}>
            {display}
          </div>
        </div>

        {/* Buttons */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {BTN.flat().map((v, i) => (
            <button key={i} onClick={() => press(v)} style={{
              height: 64, borderRadius: 14, border: 'none', cursor: 'pointer',
              background: btnColor(v),
              color: '#fff', fontSize: v === '0' ? '1.3rem' : '1.1rem', fontWeight: 500,
              gridColumn: v === '0' ? 'span 2' : 'span 1',
              transition: 'filter 0.1s',
            }}
              onMouseEnter={e => e.currentTarget.style.filter = 'brightness(1.2)'}
              onMouseLeave={e => e.currentTarget.style.filter = 'brightness(1)'}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* History */}
      {history.length > 0 && (
        <div style={{ width: 180, borderLeft: '1px solid #222', padding: '16px 12px', overflowY: 'auto' }}>
          <div style={{ fontSize: '0.7rem', color: '#666', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>History</div>
          {history.map((h, i) => (
            <div key={i} style={{ fontSize: '0.75rem', color: '#aaa', marginBottom: 8, lineHeight: 1.5 }}>{h}</div>
          ))}
        </div>
      )}
    </div>
  )
}
