import { useState, useRef, useCallback } from 'react'
import { FileText, Table, Image, Upload, Download, Save, Bold, Italic, Underline, AlignLeft, AlignCenter, AlignRight, Printer, ZoomIn, ZoomOut, ChevronLeft, ChevronRight } from 'lucide-react'

// ─── LAZY IMPORTS — only loaded when needed ────────────────────────────────
async function parseDOCX(arrayBuffer) {
  const mammoth = await import('mammoth')
  return mammoth.convertToHtml({ arrayBuffer })
}

// Cached XLSX module reference — set on first load, reused for sheet rendering
let _xlsxModule = null

async function parseXLSX(arrayBuffer) {
  const XLSX = await import('xlsx')
  _xlsxModule = XLSX
  const wb = XLSX.read(arrayBuffer, { type: 'array' })
  return wb
}

export default function Celestia() {
  const [file, setFile] = useState(null) // { name, type, content, pages, currentPage }
  const [docHtml, setDocHtml] = useState('')
  const [xlsxWorkbook, setXlsxWorkbook] = useState(null)
  const [activeSheet, setActiveSheet] = useState(0)
  const [pdfDoc, setPdfDoc] = useState(null)
  const [pdfPage, setPdfPage] = useState(1)
  const [zoom, setZoom] = useState(100)
  const [isDragging, setIsDragging] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(false)
  const editorRef = useRef(null)
  const canvasRef = useRef(null)
  const fileInputRef = useRef(null)

  const handleFile = useCallback(async (f) => {
    if (!f) return
    setLoading(true)
    setError(null)
    const ext = f.name.split('.').pop().toLowerCase()
    try {
      const buf = await f.arrayBuffer()
      if (['doc', 'docx'].includes(ext)) {
        const result = await parseDOCX(buf)
        setDocHtml(result.value)
        setFile({ name: f.name, type: 'word' })
        setXlsxWorkbook(null)
        setPdfDoc(null)
      } else if (['xls', 'xlsx', 'csv'].includes(ext)) {
        const wb = await parseXLSX(new Uint8Array(buf))
        setXlsxWorkbook(wb)
        setActiveSheet(0)
        setFile({ name: f.name, type: 'excel' })
        setDocHtml('')
        setPdfDoc(null)
      } else if (ext === 'pdf') {
        const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist')
        GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.js`
        const pdfData = new Uint8Array(buf)
        const doc = await getDocument({ data: pdfData }).promise
        setPdfDoc(doc)
        setPdfPage(1)
        setFile({ name: f.name, type: 'pdf', pages: doc.numPages })
        setDocHtml('')
        setXlsxWorkbook(null)
        renderPdfPage(doc, 1, zoom)
      } else if (['ppt', 'pptx'].includes(ext)) {
        setDocHtml('<div style="text-align:center;padding:40px;color:#94a3b8">PowerPoint preview: full editing coming soon. File loaded successfully.</div>')
        setFile({ name: f.name, type: 'ppt' })
      } else {
        const text = new TextDecoder().decode(buf)
        setDocHtml(`<pre style="white-space:pre-wrap;word-break:break-word">${text.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`)
        setFile({ name: f.name, type: 'text' })
      }
    } catch (err) {
      setError(`Failed to open "${f.name}": ${err.message}`)
    } finally {
      setLoading(false)
    }
  }, [zoom])

  const renderPdfPage = async (doc, pageNum, zoomLevel) => {
    if (!doc) return
    const page = await doc.getPage(pageNum)
    const scale = zoomLevel / 100
    const viewport = page.getViewport({ scale })
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = viewport.width
    canvas.height = viewport.height
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
  }

  const changePdfPage = (delta) => {
    if (!pdfDoc) return
    const newPage = Math.max(1, Math.min(file.pages, pdfPage + delta))
    setPdfPage(newPage)
    renderPdfPage(pdfDoc, newPage, zoom)
  }

  const changeZoom = (delta) => {
    const newZoom = Math.max(50, Math.min(200, zoom + delta))
    setZoom(newZoom)
    if (file?.type === 'pdf' && pdfDoc) renderPdfPage(pdfDoc, pdfPage, newZoom)
  }

  const execCmd = (cmd, val) => { document.execCommand(cmd, false, val) }

  const handleDrop = (e) => {
    e.preventDefault()
    setIsDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) handleFile(f)
  }

  const exportDoc = () => {
    if (!file) return
    if (file.type === 'word' || file.type === 'text' || file.type === 'ppt') {
      const blob = new Blob([editorRef.current?.innerHTML || docHtml], { type: 'text/html' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = file.name.replace(/\.[^.]+$/, '.html'); a.click()
      URL.revokeObjectURL(url)
    }
  }

  const renderSheetData = () => {
    if (!xlsxWorkbook) return null
    // _xlsxModule is set by parseXLSX before xlsxWorkbook state is ever set,
    // so it is always available here. No require() needed.
    const utils = _xlsxModule?.utils
    if (!utils) return null
    const sheetName = xlsxWorkbook.SheetNames[activeSheet]
    const sheet = xlsxWorkbook.Sheets[sheetName]
    const rows = utils.sheet_to_json(sheet, { header: 1, defval: '' })
    if (!rows.length) return <div style={{ padding: 20, color: 'var(--text-muted)' }}>Empty sheet</div>
    return (
      <div style={{ overflow: 'auto', flex: 1 }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 13, minWidth: '100%' }}>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} style={{ background: ri === 0 ? 'rgba(109,40,217,0.15)' : ri % 2 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                {row.map((cell, ci) => {
                  const Tag = ri === 0 ? 'th' : 'td'
                  return (
                    <Tag
                      key={ci}
                      contentEditable suppressContentEditableWarning
                      style={{ padding: '4px 8px', border: '1px solid rgba(255,255,255,0.07)', color: ri === 0 ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: ri === 0 ? 600 : 400, textAlign: 'left', outline: 'none', minWidth: 80 }}
                    >
                      {cell}
                    </Tag>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#090912' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderBottom: '1px solid rgba(255,255,255,0.07)', background: 'rgba(0,0,0,0.4)', flexWrap: 'wrap', minHeight: 44 }}>
        {/* File actions */}
        <button onClick={() => fileInputRef.current?.click()} style={btnSt} title="Open file">
          <Upload size={14} /> Open
        </button>
        <input ref={fileInputRef} type="file" accept=".doc,.docx,.xls,.xlsx,.csv,.pdf,.ppt,.pptx,.txt,.md" style={{ display: 'none' }} onChange={(e) => handleFile(e.target.files[0])} />
        {file && (
          <>
            <button onClick={exportDoc} style={btnSt} title="Export"><Download size={14} /> Export</button>
            <button onClick={() => window.print()} style={btnSt} title="Print"><Printer size={14} /></button>
            <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.1)' }} />
          </>
        )}

        {/* Text formatting — only for word docs */}
        {file?.type === 'word' && (
          <>
            <button onClick={() => execCmd('bold')} style={btnSt} title="Bold"><Bold size={13} /></button>
            <button onClick={() => execCmd('italic')} style={btnSt} title="Italic"><Italic size={13} /></button>
            <button onClick={() => execCmd('underline')} style={btnSt} title="Underline"><Underline size={13} /></button>
            <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.1)' }} />
            <button onClick={() => execCmd('justifyLeft')} style={btnSt}><AlignLeft size={13} /></button>
            <button onClick={() => execCmd('justifyCenter')} style={btnSt}><AlignCenter size={13} /></button>
            <button onClick={() => execCmd('justifyRight')} style={btnSt}><AlignRight size={13} /></button>
            <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.1)' }} />
            <select onChange={(e) => execCmd('fontSize', e.target.value)} defaultValue="3" style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text-primary)', borderRadius: 4, padding: '2px 4px', fontSize: 12 }}>
              {[1,2,3,4,5,6,7].map((s) => <option key={s} value={s}>{[8,10,12,14,18,24,36][s-1]}pt</option>)}
            </select>
            <input type="color" onChange={(e) => execCmd('foreColor', e.target.value)} title="Text color" style={{ width: 28, height: 24, borderRadius: 4, border: 'none', cursor: 'pointer', background: 'none' }} />
            <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.1)' }} />
          </>
        )}

        {/* Zoom */}
        {file && (
          <>
            <button onClick={() => changeZoom(-10)} style={btnSt}><ZoomOut size={13} /></button>
            <span style={{ color: 'var(--text-muted)', fontSize: 12, minWidth: 40, textAlign: 'center' }}>{zoom}%</span>
            <button onClick={() => changeZoom(10)} style={btnSt}><ZoomIn size={13} /></button>
          </>
        )}

        {/* PDF pagination */}
        {file?.type === 'pdf' && (
          <>
            <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.1)' }} />
            <button onClick={() => changePdfPage(-1)} disabled={pdfPage <= 1} style={btnSt}><ChevronLeft size={13} /></button>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{pdfPage} / {file.pages}</span>
            <button onClick={() => changePdfPage(1)} disabled={pdfPage >= file.pages} style={btnSt}><ChevronRight size={13} /></button>
          </>
        )}

        {/* File name */}
        {file && <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{file.name}</span>}
      </div>

      {/* Excel sheet tabs */}
      {file?.type === 'excel' && xlsxWorkbook && (
        <div style={{ display: 'flex', gap: 2, padding: '4px 10px', background: 'rgba(0,0,0,0.2)', borderBottom: '1px solid rgba(255,255,255,0.06)', overflowX: 'auto' }}>
          {xlsxWorkbook.SheetNames.map((name, i) => (
            <button key={name} onClick={() => setActiveSheet(i)} style={{ padding: '3px 12px', borderRadius: 4, border: '1px solid', borderColor: i === activeSheet ? 'rgba(109,40,217,0.6)' : 'rgba(255,255,255,0.1)', background: i === activeSheet ? 'rgba(109,40,217,0.2)' : 'rgba(255,255,255,0.04)', color: i === activeSheet ? 'var(--accent)' : 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}>{name}</button>
          ))}
        </div>
      )}

      {/* Content area */}
      <div
        style={{ flex: 1, overflowY: 'auto', position: 'relative' }}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        {/* Drop overlay */}
        {isDragging && (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(109,40,217,0.2)', border: '2px dashed var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, borderRadius: 8 }}>
            <div style={{ color: 'var(--accent)', fontSize: 18, fontWeight: 600 }}>Drop file to open</div>
          </div>
        )}

        {/* No file */}
        {!file && !loading && !error && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 20 }}>
            <div style={{ fontSize: 56 }}>📋</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>Celestia Office</div>
            <div style={{ color: 'var(--text-muted)', textAlign: 'center', maxWidth: 320, lineHeight: 1.6 }}>Open or drop any Word, Excel, PDF, or PowerPoint file to start editing</div>
            <div style={{ display: 'flex', gap: 12 }}>
              {[{ icon: '📝', label: 'Word / DOCX' }, { icon: '📊', label: 'Excel / XLSX' }, { icon: '📄', label: 'PDF' }, { icon: '📊', label: 'PowerPoint' }].map((t) => (
                <div key={t.label} style={{ padding: '10px 16px', borderRadius: 10, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
                  <div style={{ fontSize: 24, marginBottom: 6 }}>{t.icon}</div>
                  {t.label}
                </div>
              ))}
            </div>
            <button onClick={() => fileInputRef.current?.click()} style={{ padding: '10px 24px', borderRadius: 10, background: 'linear-gradient(135deg, #6d28d9, #1e40af)', border: 'none', color: 'white', fontWeight: 600, cursor: 'pointer', fontSize: 14 }}>
              Open File
            </button>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', gap: 10 }}>
            <div style={{ width: 20, height: 20, borderRadius: '50%', border: '2px solid var(--accent)', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }} />
            Opening file...
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#f87171', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 32 }}>⚠️</div>
            <div>{error}</div>
            <button onClick={() => setError(null)} style={{ ...btnSt, marginTop: 8 }}>Try Again</button>
          </div>
        )}

        {/* Word doc */}
        {file?.type === 'word' && !loading && (
          <div style={{ padding: 20 }}>
            <div
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              dangerouslySetInnerHTML={{ __html: docHtml }}
              style={{
                maxWidth: 800, margin: '0 auto', background: 'rgba(255,255,255,0.03)', padding: '40px 48px',
                borderRadius: 4, minHeight: 600, outline: 'none', color: 'var(--text-primary)',
                fontSize: `${(zoom / 100) * 14}px`, lineHeight: 1.7, boxShadow: '0 2px 16px rgba(0,0,0,0.3)',
                border: '1px solid rgba(255,255,255,0.06)',
              }}
            />
          </div>
        )}

        {/* Excel */}
        {file?.type === 'excel' && !loading && (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {renderSheetData()}
          </div>
        )}

        {/* PDF */}
        {file?.type === 'pdf' && !loading && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 20, background: 'rgba(0,0,0,0.2)' }}>
            <canvas ref={canvasRef} style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.5)', maxWidth: '100%' }} />
          </div>
        )}

        {/* PPT/text placeholder */}
        {(file?.type === 'ppt' || file?.type === 'text') && !loading && (
          <div style={{ padding: 20 }}>
            <div dangerouslySetInnerHTML={{ __html: docHtml }} style={{ color: 'var(--text-secondary)', lineHeight: 1.7, fontSize: `${(zoom / 100) * 14}px` }} />
          </div>
        )}
      </div>

      {/* Status bar */}
      {file && (
        <div style={{ padding: '3px 14px', borderTop: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.3)', color: 'var(--text-muted)', fontSize: 11, display: 'flex', gap: 16 }}>
          <span>{file.type.toUpperCase()}</span>
          <span>{file.name}</span>
          {file.type === 'pdf' && <span>Page {pdfPage} of {file.pages}</span>}
          <span>{zoom}% zoom</span>
        </div>
      )}
    </div>
  )
}

const btnSt = {
  display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderRadius: 5,
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
  color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12,
}
