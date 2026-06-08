import { useState, useEffect, useRef, useCallback } from 'react'
import { ChevronUp, ChevronDown, X } from 'lucide-react'

export default function FindBar({ webviewRef, onClose }) {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [activeMatch, setActiveMatch] = useState(0)
  const [totalMatches, setTotalMatches] = useState(0)
  const inputRef = useRef(null)

  // Autofocus on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Listen for found-in-page events from the webview
  useEffect(() => {
    const wv = webviewRef?.current
    if (!wv) return

    const handleFoundInPage = (e) => {
      const { activeMatchOrdinal, matches } = e.result
      setActiveMatch(activeMatchOrdinal ?? 0)
      setTotalMatches(matches ?? 0)
    }

    wv.addEventListener('found-in-page', handleFoundInPage)
    return () => {
      wv.removeEventListener('found-in-page', handleFoundInPage)
    }
  }, [webviewRef])

  const search = useCallback(
    (text, forward = true, findNext = false) => {
      const wv = webviewRef?.current
      if (!wv || !text) return
      wv.findInPage(text, { forward, findNext, matchCase: caseSensitive })
    },
    [webviewRef, caseSensitive]
  )

  const handleClose = useCallback(() => {
    const wv = webviewRef?.current
    if (wv) wv.stopFindInPage('clearSelection')
    setQuery('')
    setActiveMatch(0)
    setTotalMatches(0)
    onClose?.()
  }, [webviewRef, onClose])

  const handleNext = useCallback(() => {
    search(query, true, true)
  }, [search, query])

  const handlePrev = useCallback(() => {
    search(query, false, true)
  }, [search, query])

  // Re-run search whenever query or caseSensitive changes
  useEffect(() => {
    const wv = webviewRef?.current
    if (!query) {
      if (wv) wv.stopFindInPage('clearSelection')
      setActiveMatch(0)
      setTotalMatches(0)
      return
    }
    wv?.findInPage(query, { forward: true, findNext: false, matchCase: caseSensitive })
  }, [query, caseSensitive, webviewRef])

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      handleClose()
    } else if (e.key === 'Enter') {
      if (e.shiftKey) {
        handlePrev()
      } else {
        handleNext()
      }
    }
  }

  const matchLabel =
    query && totalMatches > 0
      ? `${activeMatch} / ${totalMatches}`
      : query && totalMatches === 0
        ? 'No results'
        : ''

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        height: '48px',
        background: 'rgba(10,10,20,0.97)',
        borderBottom: '1px solid rgba(255,255,255,0.1)',
        padding: '0 12px',
        gap: '8px',
        flexShrink: 0,
        userSelect: 'none',
      }}
    >
      {/* Search input */}
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in page…"
        style={{
          flex: 1,
          height: '30px',
          background: 'rgba(255,255,255,0.08)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: '6px',
          color: '#e8e8f0',
          fontSize: '13px',
          padding: '0 10px',
          outline: 'none',
          minWidth: 0,
        }}
      />

      {/* Match count */}
      <span
        style={{
          fontSize: '12px',
          color: totalMatches === 0 && query ? '#f87171' : 'rgba(255,255,255,0.5)',
          whiteSpace: 'nowrap',
          minWidth: '56px',
          textAlign: 'center',
        }}
      >
        {matchLabel}
      </span>

      {/* Case-sensitive toggle */}
      <button
        onClick={() => setCaseSensitive((v) => !v)}
        title="Match case"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '30px',
          height: '30px',
          borderRadius: '6px',
          border: '1px solid',
          borderColor: caseSensitive ? 'rgba(139,92,246,0.7)' : 'rgba(255,255,255,0.15)',
          background: caseSensitive ? 'rgba(139,92,246,0.2)' : 'transparent',
          color: caseSensitive ? '#a78bfa' : 'rgba(255,255,255,0.5)',
          fontSize: '12px',
          fontWeight: '700',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        Aa
      </button>

      {/* Prev button */}
      <button
        onClick={handlePrev}
        disabled={!query || totalMatches === 0}
        title="Previous match (Shift+Enter)"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '30px',
          height: '30px',
          borderRadius: '6px',
          border: '1px solid rgba(255,255,255,0.15)',
          background: 'transparent',
          color: !query || totalMatches === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.7)',
          cursor: !query || totalMatches === 0 ? 'default' : 'pointer',
          flexShrink: 0,
        }}
      >
        <ChevronUp size={15} />
      </button>

      {/* Next button */}
      <button
        onClick={handleNext}
        disabled={!query || totalMatches === 0}
        title="Next match (Enter)"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '30px',
          height: '30px',
          borderRadius: '6px',
          border: '1px solid rgba(255,255,255,0.15)',
          background: 'transparent',
          color: !query || totalMatches === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.7)',
          cursor: !query || totalMatches === 0 ? 'default' : 'pointer',
          flexShrink: 0,
        }}
      >
        <ChevronDown size={15} />
      </button>

      {/* Close button */}
      <button
        onClick={handleClose}
        title="Close (Escape)"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '30px',
          height: '30px',
          borderRadius: '6px',
          border: '1px solid rgba(255,255,255,0.15)',
          background: 'transparent',
          color: 'rgba(255,255,255,0.5)',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <X size={15} />
      </button>
    </div>
  )
}
