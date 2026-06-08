import { useState, useEffect, useRef, useCallback } from 'react'
import { suggestCommand } from '../ai/LocalAI'
import { logError } from '../updater/UpdateSystem'

const BANNER = `\x1b[35m
██████╗ ███████╗██╗   ██╗███████╗██╗      █████╗ ████████╗██╗ ██████╗ ███╗   ██╗███████╗
██╔══██╗██╔════╝██║   ██║██╔════╝██║     ██╔══██╗╚══██╔══╝██║██╔═══██╗████╗  ██║██╔════╝
██████╔╝█████╗  ██║   ██║█████╗  ██║     ███████║   ██║   ██║██║   ██║██╔██╗ ██║███████╗
██╔══██╗██╔══╝  ╚██╗ ██╔╝██╔══╝  ██║     ██╔══██║   ██║   ██║██║   ██║██║╚██╗██║╚════██║
██║  ██║███████╗ ╚████╔╝ ███████╗███████╗██║  ██║   ██║   ██║╚██████╔╝██║ ╚████║███████║
╚═╝  ╚═╝╚══════╝  ╚═══╝  ╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝   ╚═╝ ╚═════╝ ╚═╝  ╚═══╝╚══════╝\x1b[0m
OS Terminal v1.0 — Proverbs CLI loaded. Type \x1b[32mhelp\x1b[0m for commands, \x1b[35mrev help\x1b[0m for OS repair tools.
`

const HELP_TEXT = `\x1b[33mSystem Commands:\x1b[0m
  help              Show this help
  clear             Clear terminal
  neofetch          System information
  whoami            Current user
  date              Current date/time
  pwd               Print working directory
  ls                List files (simulated)
  echo <text>       Print text
  history           Command history
  version           OS version info

\x1b[33mDeveloper Tools:\x1b[0m
  proverbs [args]   Launch Proverbs AI CLI

\x1b[35mRev OS Tools:\x1b[0m
  rev help          Show rev subcommands
  rev update        Describe an issue — Proverbs fixes it across repos + OS
  rev update <msg>  Fix described issue inline
  rev rebuild       Rebuild Revelations OS from source + reinstall
  rev repos         List all RAXX app repositories
  rev status        Show last rev run result`

const REV_HELP = `\x1b[35m[rev]\x1b[0m Proverbs-powered OS repair system

\x1b[33mUsage:\x1b[0m
  \x1b[36mrev update\x1b[0m              Enter interactive issue description mode
  \x1b[36mrev update <message>\x1b[0m    Fix the described issue immediately
  \x1b[36mrev rebuild\x1b[0m             Rebuild Revelations OS source + install to /Applications
  \x1b[36mrev repos\x1b[0m               List all registered RAXX app repos and their status
  \x1b[36mrev status\x1b[0m              Show results from the last rev update run

\x1b[33mHow it works:\x1b[0m
  1. You describe the issue in plain English
  2. Proverbs analyzes the relevant repos and OS source
  3. It edits the code directly in your repositories
  4. Run \x1b[36mrev rebuild\x1b[0m if the OS itself was changed

\x1b[33mExamples:\x1b[0m
  rev update the TaxFlow Pro login page is broken
  rev update the TopBar clock is not updating
  rev update Ephesians browser tabs are not rendering favicons
  rev update the PCFixScan progress bar animation is missing`

const NEOFETCH_ART = (user, platform) => `\x1b[35m
                    ⚔️
                   /|\\
                  / | \\
                 /  |  \\         \x1b[37m${user}\x1b[35m@\x1b[37mrevelations-os\x1b[0m
                /   |   \\        \x1b[35m─────────────────────\x1b[0m
               /    |    \\       \x1b[35mOS:\x1b[0m     Revelations OS 1.0
              / ████████  \\      \x1b[35mHost:\x1b[0m   RAXX Beats Studios LLC
             /  ██  ████   \\     \x1b[35mKernel:\x1b[0m Electron 29 + Node.js
            /  ████   ██    \\    \x1b[35mShell:\x1b[0m  Revelations Terminal
           / ██   █████      \\   \x1b[35mDE:\x1b[0m     Glass Morphism UI
          /  ████    ██       \\  \x1b[35mTheme:\x1b[0m  Celestial Dark (Purple)
         /_____________________ \\ \x1b[35mCPU:\x1b[0m    ${platform || 'macOS / Darwin'}
                                  \x1b[35mSec:\x1b[0m    AES-256-GCM + CSP + IPC Rate Limit
                                  \x1b[35mRev:\x1b[0m    Proverbs AI repair enabled\x1b[0m
`

// ANSI escape → styled spans
function ansiToHtml(text) {
  const map = {
    '\\x1b\\[0m':  '</span>',
    '\\x1b\\[30m': '<span style="color:#1e1e2e">',
    '\\x1b\\[31m': '<span style="color:#f87171">',
    '\\x1b\\[32m': '<span style="color:#6ee7b7">',
    '\\x1b\\[33m': '<span style="color:#fbbf24">',
    '\\x1b\\[34m': '<span style="color:#60a5fa">',
    '\\x1b\\[35m': '<span style="color:#a78bfa">',
    '\\x1b\\[36m': '<span style="color:#67e8f9">',
    '\\x1b\\[37m': '<span style="color:#f8fafc">',
  }
  let result = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  for (const [pat, rep] of Object.entries(map)) {
    result = result.replace(new RegExp(pat, 'g'), rep)
  }
  // Close any unclosed spans
  const openCount = (result.match(/<span/g) || []).length
  const closeCount = (result.match(/<\/span>/g) || []).length
  if (openCount > closeCount) result += '</span>'.repeat(openCount - closeCount)
  return result
}

export default function Terminal() {
  const [lines, setLines] = useState([{ type: 'html', text: BANNER }])
  const [input, setInput] = useState('')
  const [history, setHistory] = useState([])
  const [histIdx, setHistIdx] = useState(-1)
  const [suggestions, setSuggestions] = useState([])
  const [busy, setBusy] = useState(false)
  const [busyLabel, setBusyLabel] = useState('')
  // rev update interactive mode
  const [revMode, setRevMode] = useState(false) // awaiting issue description
  const [lastRevResult, setLastRevResult] = useState(null)
  const bottomRef = useRef(null)
  const inputRef = useRef(null)
  const progressUnsubRef = useRef(null)
  const userName = window.__revos_user || 'user'

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines])

  // Subscribe to rev:progress streaming from main process
  useEffect(() => {
    if (window.nexus?.onRevProgress) {
      progressUnsubRef.current = window.nexus.onRevProgress((text) => {
        addLine(text, 'stream')
      })
    }
    return () => progressUnsubRef.current?.()
  }, [])

  const addLine = useCallback((text, type = 'output') => {
    setLines(prev => [...prev, { type, text }])
  }, [])

  const runCommand = useCallback(async (raw) => {
    const cmd = raw.trim()
    if (!cmd) return

    // Rev interactive mode — treat any input as the issue description
    if (revMode) {
      setRevMode(false)
      addLine(`$ ${cmd}`, 'input')
      await handleRevUpdate(cmd)
      return
    }

    addLine(`$ ${cmd}`, 'input')
    setHistory(h => [cmd, ...h.slice(0, 99)])
    setHistIdx(-1)

    const parts = cmd.split(/\s+/)
    const base = parts[0].toLowerCase()
    const rest = parts.slice(1).join(' ')

    // ─── REV COMMANDS ─────────────────────────────────────────────────────
    if (base === 'rev') {
      const sub = parts[1]?.toLowerCase()
      switch (sub) {
        case 'help':
          addLine(REV_HELP, 'html')
          break

        case 'update': {
          const inline = parts.slice(2).join(' ').trim()
          if (inline) {
            await handleRevUpdate(inline)
          } else {
            setRevMode(true)
            addLine('\x1b[35m[rev]\x1b[0m Describe the issue (press Enter to send, Esc to cancel):', 'html')
            addLine("\x1b[33m  Tip: be specific - mention the app name, what is broken, and what you expected\x1b[0m", 'html')
          }
          break
        }

        case 'rebuild':
          await handleRevRebuild()
          break

        case 'repos':
          await handleRevRepos()
          break

        case 'status':
          if (lastRevResult) {
            addLine(`\x1b[35m[rev]\x1b[0m Last run — ${lastRevResult.ok ? '\x1b[32m✓ Success\x1b[0m' : '\x1b[31m✗ Failed\x1b[0m'}`, 'html')
            if (lastRevResult.targetRepos?.length) {
              addLine(`  Repos: ${lastRevResult.targetRepos.join(', ')}`, 'html')
            }
            if (lastRevResult.needsRebuild) {
              addLine(`  \x1b[33m⚠ OS rebuild needed — run: rev rebuild\x1b[0m`, 'html')
            }
          } else {
            addLine('\x1b[33m[rev]\x1b[0m No rev update has been run yet this session.', 'html')
          }
          break

        default:
          addLine('\x1b[31mUnknown rev subcommand.\x1b[0m Type \x1b[35mrev help\x1b[0m for usage.', 'html')
      }
      return
    }

    // ─── STANDARD COMMANDS ────────────────────────────────────────────────
    switch (base) {
      case 'clear':
        setLines([])
        break
      case 'help':
        addLine(HELP_TEXT, 'html')
        break
      case 'neofetch':
        addLine(NEOFETCH_ART(userName, window.nexus?.platform || 'darwin'), 'html')
        break
      case 'whoami':
        addLine(userName)
        break
      case 'date':
        addLine(new Date().toLocaleString())
        break
      case 'pwd':
        addLine(`/home/${userName}`)
        break
      case 'ls':
        addLine('Applications/  Desktop/  Documents/  Downloads/  Music/  Pictures/  Videos/')
        break
      case 'echo':
        addLine(rest || '')
        break
      case 'history':
        addLine(history.map((h, i) => `  ${String(i + 1).padStart(3)}  ${h}`).join('\n') || '(empty)')
        break
      case 'version':
        addLine('Revelations OS v1.0.0\nElectron 29 | React 18 | Tailwind 3 | Proverbs AI repair enabled')
        break
      case 'proverbs':
        setBusy(true)
        setBusyLabel('Running Proverbs...')
        addLine('\x1b[35m[proverbs]\x1b[0m Launching Proverbs CLI...', 'html')
        if (window.nexus?.runProverbs) {
          try {
            const result = await window.nexus.runProverbs(rest || '--help')
            addLine(result || '(no output)', 'output')
          } catch (err) {
            logError('Terminal:proverbs', err.message)
            addLine(`\x1b[31mError: ${err.message}\x1b[0m`, 'html')
          }
        } else {
          addLine('\x1b[31mProverbs CLI unavailable — package app to enable IPC.\x1b[0m', 'html')
        }
        setBusy(false)
        setBusyLabel('')
        break
      default:
        addLine(`\x1b[31mCommand not found:\x1b[0m ${base}. Type \x1b[33mhelp\x1b[0m for commands.`, 'html')
    }
  }, [revMode, addLine, history, lastRevResult, userName])

  // ─── REV HANDLERS ─────────────────────────────────────────────────────────
  const handleRevUpdate = async (issue) => {
    if (!window.nexus?.revUpdate) {
      addLine('\x1b[31m[rev] rev:update IPC not available — app must be rebuilt first.\x1b[0m\nRun: cd ~/revelations-os && npm run build && cp -R dist/mac/Revelations.app /Applications/', 'html')
      return
    }
    setBusy(true)
    setBusyLabel('Proverbs working...')
    addLine(`\x1b[35m[rev]\x1b[0m Issue: \x1b[37m${issue}\x1b[0m`, 'html')
    try {
      const result = await window.nexus.revUpdate(issue)
      setLastRevResult(result)
      if (result.ok) {
        addLine(`\x1b[32m[rev] ✓ Proverbs finished successfully\x1b[0m`, 'html')
        if (result.needsRebuild) {
          addLine(`\x1b[33m[rev] ⚠ OS source was modified — run \x1b[36mrev rebuild\x1b[33m to apply changes\x1b[0m`, 'html')
        }
      } else {
        addLine(`\x1b[31m[rev] Proverbs completed with errors\x1b[0m`, 'html')
      }
    } catch (err) {
      logError('Terminal:rev:update', err.message)
      addLine(`\x1b[31m[rev] Error: ${err.message}\x1b[0m`, 'html')
    } finally {
      setBusy(false)
      setBusyLabel('')
    }
  }

  const handleRevRebuild = async () => {
    if (!window.nexus?.revRebuild) {
      addLine('\x1b[31m[rev] rev:rebuild IPC not available.\x1b[0m', 'html')
      return
    }
    setBusy(true)
    setBusyLabel('Building OS...')
    addLine('\x1b[35m[rev]\x1b[0m Starting Revelations OS rebuild — this may take 2-3 minutes...', 'html')
    try {
      const result = await window.nexus.revRebuild()
      if (result.ok) {
        addLine(`\x1b[32m[rev] ✓ Rebuild complete — /Applications/Revelations.app updated\x1b[0m`, 'html')
        addLine(`\x1b[33m[rev] Restart Revelations OS to use the updated version\x1b[0m`, 'html')
      } else {
        addLine(`\x1b[31m[rev] Rebuild failed\x1b[0m`, 'html')
      }
    } catch (err) {
      logError('Terminal:rev:rebuild', err.message)
      addLine(`\x1b[31m[rev] Rebuild error: ${err.message}\x1b[0m`, 'html')
    } finally {
      setBusy(false)
      setBusyLabel('')
    }
  }

  const handleRevRepos = async () => {
    if (!window.nexus?.revListRepos) {
      // Fallback list
      addLine('\x1b[35m[rev]\x1b[0m RAXX App Repositories:', 'html')
      addLine(['taxflow-pro', 'bowdwn', 'automix', 'legalvault-pro', 'fema-platform', 'genmed-clinical-sync', 'rals-unified', 'liquor-ledger', 'leadforge', 'proverbs', 'IdeaPlanner', 'freepost', 'cloutkiller', 'grow-clout-hub', 'syllabus-script-space', 'artistmanager', 'petsitter-pro', 'groomtrack-pro', 'mobile-massage', 'mobile-barber', 'mobile-salon', 'tradeiqdesk', 'vybe-engine', 'business-software-management-services', 'black-wall-street-legacy', 'school-manager', 'contractor-os', 'tuffbets', 'command-hq', 'dealerflow-pro', 'govcoreerp', 'olive', 'admin-center', 'pcscanfix', 'revelations-os'].map(r => `  ~/` + r).join('\n'))
      return
    }
    try {
      const repos = await window.nexus.revListRepos()
      addLine('\x1b[35m[rev]\x1b[0m RAXX App Repositories:', 'html')
      const lines = repos.map(r => {
        const exists = r.exists ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
        return `  ${exists} ~/` + r.name
      }).join('\n')
      addLine(lines, 'html')
      const existing = repos.filter(r => r.exists).length
      addLine(`\n  \x1b[33m${existing}/${repos.length} repos present on this machine\x1b[0m`, 'html')
    } catch (err) {
      addLine(`\x1b[31m[rev] Error: ${err.message}\x1b[0m`, 'html')
    }
  }

  // ─── KEY HANDLERS ─────────────────────────────────────────────────────────
  const handleKey = (e) => {
    if (e.key === 'Enter' && !busy) {
      runCommand(input)
      setInput('')
      setSuggestions([])
    } else if (e.key === 'Escape') {
      if (revMode) {
        setRevMode(false)
        addLine('\x1b[33m[rev] Cancelled\x1b[0m', 'html')
      }
      setInput('')
      setSuggestions([])
    } else if (e.key === 'ArrowUp' && !revMode) {
      e.preventDefault()
      const idx = Math.min(histIdx + 1, history.length - 1)
      setHistIdx(idx)
      if (history[idx]) setInput(history[idx])
    } else if (e.key === 'ArrowDown' && !revMode) {
      e.preventDefault()
      const idx = Math.max(histIdx - 1, -1)
      setHistIdx(idx)
      setInput(idx === -1 ? '' : history[idx])
    } else if (e.key === 'Tab' && suggestions.length === 1) {
      e.preventDefault()
      setInput(suggestions[0].cmd + ' ')
      setSuggestions([])
    }
  }

  const handleInput = (e) => {
    const val = e.target.value
    setInput(val)
    if (!revMode) {
      const sugg = suggestCommand(val.split(' ')[0])
      setSuggestions(sugg.slice(0, 5))
    }
  }

  // Render a line
  const renderLine = (l, i) => {
    if (l.type === 'html' || l.type === 'stream') {
      return (
        <pre
          key={i}
          style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}
          dangerouslySetInnerHTML={{ __html: ansiToHtml(l.text) }}
        />
      )
    }
    const colors = { input: '#6ee7b7', output: '#e2e8f0', error: '#f87171', system: '#fbbf24', proverbs: '#38bdf8' }
    return (
      <pre key={i} style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: colors[l.type] || '#e2e8f0', lineHeight: 1.5 }}>
        {l.text}
      </pre>
    )
  }

  const prompt = revMode
    ? `\x1b[35m[rev]\x1b[0m Issue > `
    : `${userName}@revelations-os:~$`

  return (
    <div
      style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0a0a0f', fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace", fontSize: 13 }}
      onClick={() => inputRef.current?.focus()}
    >
      {/* Output area */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {lines.map(renderLine)}
        <div ref={bottomRef} />
      </div>

      {/* Autocomplete */}
      {suggestions.length > 0 && (
        <div style={{ padding: '4px 16px', display: 'flex', gap: 8, flexWrap: 'wrap', borderTop: '1px solid rgba(255,255,255,0.05)', background: 'rgba(0,0,0,0.3)' }}>
          {suggestions.map(s => (
            <button key={s.cmd} onClick={() => { setInput(s.cmd + ' '); setSuggestions([]); inputRef.current?.focus() }}
              style={{ background: 'rgba(109,40,217,0.3)', border: '1px solid rgba(109,40,217,0.5)', color: '#a78bfa', padding: '2px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
              {s.cmd} <span style={{ opacity: 0.6 }}>{s.desc}</span>
            </button>
          ))}
        </div>
      )}

      {/* Input row */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '8px 16px', borderTop: '1px solid rgba(255,255,255,0.08)', background: 'rgba(0,0,0,0.4)', gap: 8 }}>
        {/* Prompt label */}
        <span
          style={{ color: revMode ? '#a78bfa' : '#6ee7b7', flexShrink: 0, fontSize: 13 }}
          dangerouslySetInnerHTML={{ __html: ansiToHtml(prompt) }}
        />
        <input
          ref={inputRef}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKey}
          disabled={busy}
          autoFocus
          spellCheck={false}
          style={{
            flex: 1, background: 'transparent', border: 'none', outline: 'none',
            color: revMode ? '#e2e8f0' : '#e2e8f0',
            fontFamily: 'inherit', fontSize: 13,
            caretColor: revMode ? '#a78bfa' : '#6ee7b7',
          }}
          placeholder={
            busy ? busyLabel
            : revMode ? 'Describe the issue in plain English...'
            : ''
          }
        />
        {busy && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#a78bfa', fontSize: 12, flexShrink: 0 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', border: '2px solid #a78bfa', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }} />
            {busyLabel}
          </div>
        )}
        {revMode && !busy && (
          <span style={{ color: '#a78bfa', fontSize: 11, flexShrink: 0 }}>Enter to fix · Esc to cancel</span>
        )}
      </div>
    </div>
  )
}
