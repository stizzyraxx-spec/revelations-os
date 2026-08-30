#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const readline = require('readline');
const _cp = require('child_process');
const { execFileSync, spawn } = _cp;

// ── Windows shell normalisation ──────────────────────────────────────────────
// The CLI was written against POSIX shells and embeds `2>/dev/null`, `||`
// fallbacks and Unix-only helpers in command strings. cmd.exe treats
// `2>/dev/null` as a redirect to a file literally named "nul\devnull" inside a
// non-existent dir, so those commands fail on Windows for reasons unrelated to
// what they were checking. Normalising centrally fixes every call site at once,
// including the inline require('child_process') ones.
const IS_WIN = process.platform === 'win32';
// Windows virtualenvs place the interpreter at venv\\Scripts\\python.exe rather
// than venv/bin/python, so every reference to the bundled venv must branch.
function _venvPython() {
  const base = path.join(os.homedir(), '.proverbs', 'venv');
  return IS_WIN ? path.join(base, 'Scripts', 'python.exe') : path.join(base, 'bin', 'python');
}
function _winNormalizeCmd(cmd) {
  if (!IS_WIN || typeof cmd !== 'string') return cmd;
  let out = cmd
    .replace(/\s*2>\s*\/dev\/null/g, ' 2>NUL')
    .replace(/\s*>\s*\/dev\/null/g,  ' >NUL');
  // `cmd1 || cmd2` works in cmd.exe, but only when run through a shell; callers
  // that pass shell:true already get that. Unix-only binaries have no cmd.exe
  // equivalent — let them fail as ENOENT so callers treat them as "unavailable".
  return out;
}
const execSync = function (command, options) {
  return _cp.execSync(_winNormalizeCmd(command), options);
};
// Keep inline `require('child_process').execSync(...)` call sites normalised too.
if (IS_WIN) {
  const _origExec = _cp.execSync;
  _cp.execSync = function (command, options) { return _origExec(_winNormalizeCmd(command), options); };
}

// ─── Paths ────────────────────────────────────────────────────────────────────
const PROVERBS_DIR       = path.join(os.homedir(), '.proverbs');
const RULES_FILE         = path.join(PROVERBS_DIR, 'rules.md');
const PROJECTS_FILE      = path.join(PROVERBS_DIR, 'projects.json');
const SESSIONS_DIR       = path.join(PROVERBS_DIR, 'sessions');
const ACTIVE_MODEL_FILE  = path.join(PROVERBS_DIR, 'active_model');
const CONFIG_FILE        = path.join(PROVERBS_DIR, 'config.json');
const HEALBOOK_FILE      = path.join(PROVERBS_DIR, 'healbook.json');

// ─── Self-heal / recovery config ──────────────────────────────────────────────
// When the inference connection drops mid-stream, Proverbs first tries to fix
// itself (replay a known fix, then restart its own server). Only if that fails
// does it fall back to the `claude` CLI to diagnose+repair — and that fallback
// is rate-limited so it never burns the user's Claude usage unnecessarily.
//
// Claude usage policy (user runs Claude Max → prefer the CLI, spend the least):
//   • The `claude` CLI is the default fallback (draws on the Max subscription).
//   • ANTHROPIC_API_KEY is only a last-resort backup if the CLI is unavailable.
//   • Every learned fix is cached in the healbook so the SAME crash replays for
//     free next time instead of calling Claude again.
const CLAUDE_HEAL_BIN          = process.env.PROVERBS_CLAUDE_BIN || 'claude';   // overridable for tests
const CLAUDE_HEAL_MODEL        = process.env.PROVERBS_CLAUDE_HEAL_MODEL || 'claude-haiku-4-5-20251001';
const CLAUDE_HEAL_MAX_PER_DAY  = Number(process.env.PROVERBS_CLAUDE_HEAL_MAX_PER_DAY || 5);
const CLAUDE_HEAL_COOLDOWN_MS  = Number(process.env.PROVERBS_CLAUDE_HEAL_COOLDOWN_MS || 10 * 60 * 1000);
const CLAUDE_HEAL_TIMEOUT_MS   = Number(process.env.PROVERBS_CLAUDE_HEAL_TIMEOUT_MS || 120000);
const CLAUDE_HEAL_MAX_TURNS    = Number(process.env.PROVERBS_CLAUDE_HEAL_MAX_TURNS || 6);
const HEAL_DISABLE_CLAUDE      = process.env.PROVERBS_NO_CLAUDE_HEAL === '1';
const MAX_HEAL_ATTEMPTS_PER_TURN = 2;   // retries of the stream after a self-heal

// Read the local inference server's API key from ~/.proverbs/config.json.
// The Python server (inference/auth.py) auto-generates this on first run and
// enforces it on /v1/chat/completions. Cached after first read.
let _proverbsLocalKey;
function getProverbsLocalKey() {
  if (_proverbsLocalKey !== undefined) return _proverbsLocalKey;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    _proverbsLocalKey = (Array.isArray(cfg.api_keys) && cfg.api_keys[0]) || null;
  } catch (_) {
    _proverbsLocalKey = null;
  }
  return _proverbsLocalKey;
}

// ─── Feature global vars ──────────────────────────────────────────────────────

// Cross-file edit planner
let planningEnabled = true;
const PLAN_TRIGGERS = ['add','create','implement','build','integrate','refactor','migrate','setup','connect','wire'];

// .script file system — project-scoped instructions (like CLAUDE.md)
let scriptContent = '';
const GLOBAL_SCRIPT_PATH = path.join(PROVERBS_DIR, '.script');

// .proverbs auto-loader — project profile written by /scan
let proverbsProfile = '';

// Parallel tools — read-only vs write tool sets
const READ_TOOLS = new Set(['read_file','list_files','grep_files','find_files','find_projects','diagnose_self','git_status','git_diff','git_log','web_search','get_project_index','search_codebase','load_context','fetch_docs','fetch_url','analyze_image']);
const WRITE_TOOLS = new Set(['write_file','edit_file','patch_file','run_bash','git_commit']);

// Undo / rollback
const BACKUPS_DIR = path.join(PROVERBS_DIR, 'backups');
let undoStack = [];
const MAX_UNDO_STACK = 20;

// Clipboard
let lastAssistantReply = '';

// Session metadata
const _sessionStartMs = Date.now();
let _currentSessionName = '';

// Git auto-commit
let autoCommitEnabled = false;

// Self-critique loop
let critiqueEnabled = false;
let critiqueThreshold = 20; // min response length in lines to trigger critique

// ── Test Engine / verification loop ──────────────────────────────────────────
// After the agent edits code, actually run the project's tests instead of
// trusting the model's word. Failures are fed back as a new turn and the work
// is re-tested, up to VERIFY_MAX_ATTEMPTS. This is the PASS/FAIL gate: the turn
// cannot report success on red tests.
let verifyEnabled     = true;
let verifyMaxAttempts = 3;    // fix→retest cycles before giving up
let verifyLevel       = 3;    // 1=syntax 2=unit 3=integration (4/5 need model-authored tests)
let verifyTimeoutMs   = 300000;
// Set by the write/edit tools so the engine only runs when code actually changed.
let _filesTouchedThisTurn = new Set();

// Multi-line input mode
let _mlMode   = false;
let _mlBuffer = [];
let _mlDelim  = '';
let _mlManual = false;

// Session persistence
const SESSIONS_SAVE_DIR = path.join(PROVERBS_DIR, 'saved_sessions');

// ─── Auto-heal + self-learning state ─────────────────────────────────────────
let _selfLearnPending  = null;   // last exchange awaiting quality score
let _learnExampleCount = 0;      // good examples this session
const LEARN_RETRAIN_THRESHOLD = 20;

// grep_files / find_files constants
const GREP_MAX_RESULTS = 150;
const FIND_MAX_DEPTH   = 12;
const SKIP_DIRS        = new Set(['node_modules', '.git']);

// Codebase index
const INDEX_FILE = path.join(PROVERBS_DIR, 'index.json');

// Conversation memory
const MEMORIES_DIR = path.join(PROVERBS_DIR, 'memories');

// Web UI state
let _uiServer    = null;
let _uiHistory   = [];
let studioServer = null;
let studioPort   = 4300;

// Reliability
let heartbeatTimer = null;

// Inference speed cache
let _sysPromptHash   = '';
let _sysPromptCached = '';
let contextBudget    = 0;
let _lastResponseMs  = 0;
let _avgResponseMs   = 0;
let _responseCount   = 0;

// /profile — perf telemetry ring buffer
const _PERF_RING = [];         // { ms, chars, ts }
const _PERF_RING_SIZE = 20;
let _perfGenStart = 0;         // Date.now() at start of each generation
let _prefixCacheHits = 0;
let _responseCacheHits = 0;
let _perfTotalRequests = 0;
let _lastPromptTokens = 0;     // prompt_eval_count from last Ollama response
let _lastGenTokens = 0;        // eval_count (generated tokens)
let _lastGenMs = 0;            // eval_duration in ms

// Live streaming progress — updated as output chars arrive so the progress bar
// reflects REAL generation progress, not just a time guess. Reset at the start
// of every stream; the bar reads _liveGenChars against an expected-chars budget.
let _liveGenChars = 0;         // chars accumulated in the current stream so far
let _liveGotFirstByte = false; // flips true on first streamed chunk (prefill done)

// RAG: TF-IDF index (in-memory, rebuilt when cwd changes)
const RAG_SKIP_DIRS  = new Set(['node_modules', '.git', 'dist', '.next', 'build', '.cache', 'coverage', 'out']);
const RAG_SKIP_EXTS  = new Set(['.png','.jpg','.jpeg','.gif','.svg','.ico','.webp','.bmp',
                                 '.mp3','.mp4','.wav','.ogg','.mov','.avi','.woff','.woff2',
                                 '.ttf','.eot','.otf','.zip','.gz','.tar','.7z','.exe',
                                 '.dll','.so','.dylib','.pdf','.lock']);
const RAG_CHUNK_LINES   = 50;
const RAG_OVERLAP_LINES = 10;
const RAG_MAX_CHUNKS    = 500;
const RAG_STOPWORDS = new Set([
  'the','and','for','that','this','with','from','are','was','were','has','have',
  'had','not','but','its','you','your','can','will','all','also','one','may',
  'more','out','use','get','set','let','var','const','new','return','function',
  'class','import','export','default','true','false','null','undefined',
]);
let _ragIndex  = null;  // { cwd, chunks, idf, docFreq, totalDocs }

// Semantic embedding RAG
const EMBED_MODEL      = 'nomic-embed-text';
const EMBED_INDEX_FILE = path.join(PROVERBS_DIR, 'embed_index.json');
const SEARCH_CACHE_FILE = path.join(PROVERBS_DIR, 'search-cache.json');
const SEARCH_CACHE_TTL  = 24 * 60 * 60 * 1000; // 24h
let _embedIndex = null; // { cwd, chunks: [{filePath, startLine, endLine, text}], vectors: [[...]] }

// Voice input
const VOICE_TMP = '/tmp/proverbs-voice.wav';

// Image analysis
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const LLAVA_MODEL = 'llava';
const SCREENSHOT_PATH = '/tmp/proverbs-screenshot.png';

// Smart routing
const ROUTING_FILE   = path.join(PROVERBS_DIR, 'routing.json');
const FAST_PRIORITY  = ['qwen2.5-coder:7b', 'qwen2.5-coder:3b', 'qwen2.5:7b'];
const SMART_PRIORITY = ['deepseek-coder-v2:16b', 'codestral:22b', 'qwen2.5-coder:14b'];
const FAST_KEYWORDS  = ['what', 'where', 'how', 'show', 'list', 'simple', 'rename', 'format', 'syntax'];
const SMART_KEYWORDS = ['refactor', 'architect', 'design', 'implement', 'build', 'debug', 'explain',
                        'complex', 'review', 'optimize', 'migrate', 'generate', 'create', 'analyze'];
let routingConfig = { fast: null, smart: null, vision: null, routing: 'auto' };

// Context compression — constants
const COMPRESS_THRESHOLD  = 20;
const COMPRESS_MIN_OLDER  = 4;
const COMPRESS_KEEP_RECENT = 6;
const COMPRESS_MSG_PREVIEW = 500;

// load_context constants
const LOAD_CONTEXT_MAX_CHARS   = 40000;
const LOAD_CONTEXT_SKIP_DIRS   = new Set(['node_modules', '.git', 'dist', '.next', 'build', '.cache', 'coverage', '__pycache__', '.venv', 'venv']);
const LOAD_CONTEXT_BINARY_EXTS = new Set([
  '.png','.jpg','.jpeg','.gif','.svg','.ico','.webp','.bmp',
  '.mp3','.mp4','.wav','.ogg','.mov','.avi','.woff','.woff2',
  '.ttf','.eot','.otf','.zip','.gz','.tar','.7z','.exe',
  '.dll','.so','.dylib','.pdf','.bin','.lock','.map',
]);

// Session context: files pinned into the system prompt for the whole session
let sessionContextFiles = []; // array of { relPath: string, content: string }

// Plan Mode state
let activePlan = null; // { steps: string[], current: number, task: string } | null

// Framework detection
let detectedFrameworks = []; // array of hint strings, populated by detectFrameworks()

// Detected code conventions (indent, quotes, semis, pkg mgr)
let detectedConventions = []; // array of strings, populated by detectConventions()

// Git context snapshot (branch + recent commits)
let gitContextStr = ''; // populated by loadGitContext()

// Task tracking
let taskStore = [];

// Cron scheduler
let cronJobs    = [];
let cronTimers  = {};

// Remote trigger HTTP server
let triggerServer = null;
let triggerPort   = 4242;

// Background process monitor
let bgProcesses = {};

// Multi-agent orchestration run history
let agentRuns = [];

// LiteLLM cloud fallback
let fallbackEnabled = false;
let fallbackModel = 'gpt-4o';
const LITELLM_BASE = 'http://localhost:4000';

// npm docs constants
const DOCS_TRUNCATE_CHARS = 5000;
const DOCS_README_BRANCHES = ['main', 'master'];
const DOCS_README_FILENAMES = ['README.md', 'readme.md', 'Readme.md', 'README.MD'];

// Syntax validation
const MAX_SYNTAX_RETRIES = 3;
let syntaxRetryCount = 0;

// ─── Agent-loop roadblock guards ──────────────────────────────────────────────
// These keep a single user turn from looping forever ("stuck on thinking") when
// the model keeps emitting tool calls, repeats a failing call, or a turn simply
// runs too long. They let Proverbs detect an obstacle and route around it
// instead of recursing until it crashes.
let   MAX_AGENT_STEPS      = 40;     // max tool-call rounds in one user turn
const MAX_REPEAT_CALLS     = 3;      // same tool+args this many times = stuck
let   MAX_TURN_MS          = 240000; // wall-clock budget for one user turn (4 min)
let   _agentStepCount      = 0;      // rounds taken this turn
let   _agentTurnStart      = 0;      // Date.now() at turn start
const _callSignatureCounts = new Map(); // "name:argsJSON" -> times seen this turn

// Reset all per-turn guards. Called once at the top of every top-level turn.
function _resetAgentGuards() {
  _agentStepCount = 0;
  _agentTurnStart = Date.now();
  _callSignatureCounts.clear();
  _resetHealAttempts();
}

// Record a file the agent wrote/edited, so the Test Engine knows whether any
// code actually changed this turn (and which files to syntax-check).
function _noteFileTouched(p) {
  if (!p) return;
  try { _filesTouchedThisTurn.add(resolvePath(p)); } catch (_) { _filesTouchedThisTurn.add(String(p)); }
}

// Build a stable signature for a tool call so we can spot exact repeats.
function _callSignature(name, args) {
  let a;
  try { a = JSON.stringify(args); } catch (_) { a = String(args); }
  return name + ':' + a;
}

// Context gauge — model context window sizes (est. tokens)
const MODEL_CONTEXT_WINDOWS = {
  // Llama family — native 128k
  'llama3.1:8b':              131072,
  'llama3.1:70b':             131072,
  'llama3.2:3b':              131072,
  'llama3.2:1b':              131072,
  'llama3.3:70b':             131072,
  // Qwen2.5-Coder — native 128k (previously capped at 32k — uncapped)
  'qwen2.5-coder:1.5b':      131072,
  'qwen2.5-coder:3b':        131072,
  'qwen2.5-coder:7b':        131072,
  'qwen2.5-coder:14b':       131072,
  'qwen2.5-coder:32b':       131072,
  'qwen2.5:7b':               32768,
  'qwen2.5:14b':              32768,
  // DeepSeek
  'deepseek-coder-v2:16b':    65536,
  'deepseek-r1:7b':           65536,
  'deepseek-r1:14b':         131072,
  // Code-focused
  'codestral:22b':            32768,
  'deepseek-coder:6.7b':      16384,
  // General
  'gemma2:9b':                 8192,
  'gemma2:27b':                8192,
  'phi3:mini':                 4096,
  'phi3:medium':              131072,
  'phi4:14b':                 131072,
  'mistral:7b':               32768,
  'mixtral:8x7b':             32768,
};
const RECOMMENDED_MODELS = [
  { name: 'codestral:22b',         ctx: 32768,  note: 'Best for coding tasks' },
  { name: 'qwen2.5-coder:32b',     ctx: 32768,  note: 'Best multi-file reasoning' },
  { name: 'llama3.1:8b',           ctx: 131072, note: '128k context for large codebases' },
  { name: 'deepseek-coder-v2:16b', ctx: 65536,  note: 'Strong coder + 64k context' },
  { name: 'llama3.1:70b',          ctx: 131072, note: 'Most capable (needs 48GB VRAM)' },
];

// Token count display — toggled with /tokens on|off
let showTokenCount = false; // off by default

// Diff preview
let diffPreviewEnabled = true;

// Syntax highlighting for code blocks in responses
let highlightEnabled = true;

// TS / ESLint feedback loop
let tsCheckEnabled    = true;
let eslintCheckEnabled = true;
const MAX_TS_RETRIES  = 2;

// Chain-of-Thought prompting
let cotEnabled = false;

// Thinking mode — structured reasoning for supported models
let thinkingEnabled = false;
const THINKING_MODELS = ['deepseek-r1', 'qwen3', 'phi4-reasoning', 'marco-o1', 'skywork-o1', 'reflection'];

// Sandbox mode — blocks destructive bash patterns
let sandboxEnabled = false;
const SANDBOX_BLOCKLIST = ['rm -rf /', 'rm -rf ~', 'mkfs', 'dd if=', ':(){ :|:& };:', 'chmod -R 777 /', 'sudo rm -rf /'];

// Multi-attempt retry on tool-call errors
let multiAttemptEnabled = true;
const MULTI_ATTEMPT_MAX = 3;

// Auto-test on write (reserved; persisted)
let autoTestEnabled = false;

// Smart preload — auto-load relevant files into context before answering
let smartPreload = true;

// Project knowledge store (per-session in-memory, persisted to disk)
const PROJECT_KNOWLEDGE_FILE = path.join(PROVERBS_DIR, 'knowledge.json');
let projectKnowledge = {}; // { [projectKey]: [ { fact, addedAt } ] }

// Fine-tune state
const FINETUNE_STATE_FILE = path.join(PROVERBS_DIR, 'finetune_state.json');

// File watcher — detect external file changes, invalidate RAG/dep-graph caches
let _fileWatcher    = null;
let _watcherEnabled = true;
let _changedFiles   = new Set(); // files changed externally since last user interaction

// Plugin system — custom tools loaded from ~/.proverbs/plugins/
const PLUGINS_DIR = path.join(PROVERBS_DIR, 'plugins');
let loadedPlugins = []; // array of { name, def, handler }

// Smart tool output truncation
const MAX_TOOL_OUTPUT_CHARS_DEFAULT = 12000;
let MAX_TOOL_OUTPUT_CHARS = MAX_TOOL_OUTPUT_CHARS_DEFAULT;
const TRUNCATE_HEAD_LINES = 60;
const TRUNCATE_TAIL_LINES = 20;
let _truncationEnabled = true;
let lastToolCall = null; // { name, args } — set in agentLoop before each tool call

// ─── Abort / interrupt state ──────────────────────────────────────────────────
let _abortController = null; // AbortController for the current generation
let _isGenerating    = false;
// Type-ahead queue: lines typed while a turn is generating are buffered here
// and replayed one-by-one when the turn finishes (Claude-style queueing).
let _inputQueue      = [];
let _rlRef           = null; // set to the readline interface once created
function _drainInputQueue() {
  if (_isGenerating) return;            // a new turn already started — wait
  if (_inputQueue.length === 0) return;
  if (!_rlRef) return;
  const next = _inputQueue.shift();
  // The pinned status is down by now (the turn ended), so these are plain
  // writes — but route them through the gate anyway so the drain is correct
  // even if a future caller drains mid-turn.
  if (_inputQueue.length > 0) {
    _uiWrite(colorize(C.dim, '  (' + _inputQueue.length + ' more queued)\n'));
  }
  // Echo the queued line as if the user just submitted it, then process it.
  _uiWrite(colorize(C.cyanBold, 'proverbs> ') + next + '\n');
  _rlRef.emit('line', next);
}
let _servingSpinner  = null;

// ─── Core helpers ─────────────────────────────────────────────────────────────
function ensureProverbsDir() {
  fs.mkdirSync(PROVERBS_DIR, { recursive: true });
}

// ─── Cloud / cascade config ───────────────────────────────────────────────────
let cloudModel = 'claude-haiku-4-5-20251001';
let cloudMode  = 'auto'; // 'auto' | 'force-cloud' | 'force-local'
// Which backend answered the previous turn. Used to alert + confirm before the
// model/language engine switches (e.g. cloud Claude ⇄ local GGUF, or model swap).
let _lastBackendSig = null;       // e.g. "claude:claude-haiku-4-5-20251001" | "local"
let _backendSwitchConfirm = true; // toggled by /confirmswitch on|off

// ─── Persistent config (loadConfig / saveConfig) ─────────────────────────────
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (typeof raw.model === 'string' && raw.model.trim()) model = raw.model.trim();
    if (typeof raw.cloudModel === 'string' && raw.cloudModel.trim()) cloudModel = raw.cloudModel.trim();
    if (typeof raw.cloudMode  === 'string') cloudMode = raw.cloudMode;
    if (typeof raw.critiqueEnabled    === 'boolean') critiqueEnabled    = raw.critiqueEnabled;
    if (typeof raw.verifyEnabled      === 'boolean') verifyEnabled      = raw.verifyEnabled;
    if (Number.isFinite(raw.verifyMaxAttempts)) verifyMaxAttempts = Math.max(1, Math.min(10, raw.verifyMaxAttempts));
    if (Number.isFinite(raw.verifyLevel)) verifyLevel = Math.max(1, Math.min(5, raw.verifyLevel));
    if (typeof raw.cotEnabled         === 'boolean') cotEnabled         = raw.cotEnabled;
    if (typeof raw.multiAttemptEnabled === 'boolean') multiAttemptEnabled = raw.multiAttemptEnabled;
    if (typeof raw.smartPreload       === 'boolean') smartPreload       = raw.smartPreload;
    if (typeof raw.diffPreviewEnabled === 'boolean') diffPreviewEnabled = raw.diffPreviewEnabled;
    if (typeof raw.autoCommitEnabled  === 'boolean') autoCommitEnabled  = raw.autoCommitEnabled;
    if (typeof raw.fallbackEnabled    === 'boolean') fallbackEnabled    = raw.fallbackEnabled;
    if (typeof raw.fallbackModel      === 'string' && raw.fallbackModel.trim()) fallbackModel = raw.fallbackModel.trim();
    if (typeof raw.planningEnabled    === 'boolean') planningEnabled    = raw.planningEnabled;
    if (typeof raw.tsCheckEnabled     === 'boolean') tsCheckEnabled     = raw.tsCheckEnabled;
    if (typeof raw.highlightEnabled   === 'boolean') highlightEnabled   = raw.highlightEnabled;
    if (typeof raw._truncationEnabled === 'boolean') _truncationEnabled = raw._truncationEnabled;
    if (typeof raw.MAX_TOOL_OUTPUT_CHARS === 'number' && raw.MAX_TOOL_OUTPUT_CHARS >= 1000) MAX_TOOL_OUTPUT_CHARS = raw.MAX_TOOL_OUTPUT_CHARS;
    if (typeof raw.autoTestEnabled    === 'boolean') autoTestEnabled    = raw.autoTestEnabled;
    if (typeof raw.thinkingEnabled    === 'boolean') thinkingEnabled    = raw.thinkingEnabled;
    if (typeof raw.MAX_AGENT_STEPS    === 'number' && raw.MAX_AGENT_STEPS >= 1) MAX_AGENT_STEPS = raw.MAX_AGENT_STEPS;
    if (typeof raw.MAX_TURN_MS        === 'number' && raw.MAX_TURN_MS >= 5000) MAX_TURN_MS = raw.MAX_TURN_MS;
  } catch (_) {
    // File absent or malformed — silently use compiled defaults
  }
}

function saveConfig() {
  try {
    ensureProverbsDir();
    // Preserve keys this CLI doesn't manage in-memory (e.g. api_keys used by the
    // Python server for auth, and the user's `permissions` policy block). Without
    // this merge, every saveConfig() would wipe them.
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch (_) {}
    const cfg = {
      ...existing,
      model,
      critiqueEnabled,
      cotEnabled,
      multiAttemptEnabled,
      smartPreload,
      diffPreviewEnabled,
      autoCommitEnabled,
      fallbackEnabled,
      fallbackModel,
      planningEnabled,
      verifyEnabled,
      verifyMaxAttempts,
      verifyLevel,
      tsCheckEnabled,
      highlightEnabled,
      _truncationEnabled,
      MAX_TOOL_OUTPUT_CHARS,
      thinkingEnabled,
      MAX_AGENT_STEPS,
      MAX_TURN_MS,
      ...(typeof autoTestEnabled !== 'undefined' ? { autoTestEnabled } : {}),
    };
    cfg.cloudModel = cloudModel;
    cfg.cloudMode  = cloudMode;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.log(colorize(C.red, '  saveConfig error: ' + e.message));
  }
}

// Resolve a custom markdown slash-command by name. Searches the user's Proverbs
// commands dir first, then ~/.claude/commands (so existing Claude commands like
// /demovid and /fullsend work too). Returns an absolute path or null.
const PROVERBS_COMMANDS_DIR = path.join(PROVERBS_DIR, 'commands');
function _findMarkdownCommand(name) {
  if (!name || /[^a-z0-9._-]/i.test(name)) return null; // no path traversal
  const candidates = [
    path.join(PROVERBS_COMMANDS_DIR, name + '.md'),
    path.join(os.homedir(), '.claude', 'commands', name + '.md'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch (_) {}
  }
  return null;
}

// mtime-keyed cache — buildSystemPrompt() calls this on every message, so a
// stat (cheap) replaces a full read+parse when the file hasn't changed.
let _rulesCache = { key: '', value: [] };
function loadRules() {
  try {
    const st = fs.statSync(RULES_FILE);
    const key = st.mtimeMs + ':' + st.size;
    if (_rulesCache.key === key) return _rulesCache.value;
    const raw = fs.readFileSync(RULES_FILE, 'utf8');
    const value = raw.split('\n')
      .filter(l => /^\d+\./.test(l.trim()))
      .map(l => l.replace(/^\d+\.\s*/, '').trim())
      .filter(Boolean);
    _rulesCache = { key, value };
    return value;
  } catch (_) {
    return [];
  }
}

function saveRule(instruction) {
  ensureProverbsDir();
  const rules = loadRules();
  const num   = rules.length + 1;
  const date  = new Date().toISOString().slice(0, 10);
  const entry = `${num}. ${instruction}  <!-- added ${date} -->\n`;
  if (!fs.existsSync(RULES_FILE)) {
    fs.writeFileSync(RULES_FILE, '# Proverbs Admin Rules\n\n', 'utf8');
  }
  fs.appendFileSync(RULES_FILE, entry, 'utf8');
  return num;
}

function clearRules() {
  ensureProverbsDir();
  fs.writeFileSync(RULES_FILE, '# Proverbs Admin Rules\n\n', 'utf8');
}

// ─── Active model (custom baked or fine-tuned) ────────────────────────────────
function loadActiveModel(fallback) {
  try {
    const m = fs.readFileSync(ACTIVE_MODEL_FILE, 'utf8').trim();
    return m || fallback;
  } catch (_) {
    return fallback;
  }
}

// ─── Projects ─────────────────────────────────────────────────────────────────
function loadProjects() {
  try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); }
  catch (_) { return {}; }
}

function handleProjectCmd(args) {
  const projects = loadProjects();
  const trimmed  = args.trim();

  if (!trimmed || trimmed === '--list') {
    const entries = Object.entries(projects).sort((a, b) => a[0].localeCompare(b[0]));
    if (entries.length === 0) {
      console.log(colorize(C.dim, '\n(no projects registered — run: proverbs projects --scan)\n'));
    } else {
      console.log(colorize(C.cyan, `\nProjects (${entries.length}):`));
      entries.forEach(([name, p]) => console.log(`  ${colorize(C.bold, name.padEnd(32))} ${colorize(C.dim, p)}`));
      console.log(colorize(C.dim, '\n  Switch: /project <name>\n'));
    }
    return null;
  }

  if (trimmed.startsWith('--scan')) {
    try {
      const { execSync: ex } = require('child_process');
      ex(`node ${path.join(__dirname, 'finetune', 'scan_projects.js')}`, { stdio: 'inherit' });
    } catch (e) {
      console.log(colorize(C.red, `\n✗  Scan failed: ${e.message}\n`));
    }
    return null;
  }

  const name   = trimmed.toLowerCase();
  const match  = Object.entries(projects).find(([k]) => k.toLowerCase() === name)
               || Object.entries(projects).find(([k]) => k.toLowerCase().includes(name));

  if (!match) {
    console.log(colorize(C.red, `\n✗  Project "${trimmed}" not found. Type /project --list to see all.\n`));
    return null;
  }

  const [projectName, projectPath] = match;
  if (!fs.existsSync(projectPath)) {
    console.log(colorize(C.red, `\n✗  Path not found: ${projectPath}\n`));
    return null;
  }
  console.log(colorize(C.green, `\n✔  Switched to ${projectName}\n   ${projectPath}\n`));
  return projectPath;
}

// ─── Session logging (training data collection) ───────────────────────────────
let _sessionFile = null;

function initSessionLog() {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    _sessionFile = path.join(SESSIONS_DIR, `session-${ts}.jsonl`);
  } catch (_) {}
}

function logExchange(systemPrompt, userMsg, assistantMsg) {
  if (!_sessionFile || !assistantMsg || assistantMsg.length < 20) return;
  // Store for quality scoring on the next user message
  _selfLearnPending = { systemPrompt, userMsg, assistantMsg };
  try {
    const line = JSON.stringify({
      messages: [
        { role: 'system',    content: systemPrompt },
        { role: 'user',      content: userMsg },
        { role: 'assistant', content: assistantMsg },
      ]
    });
    fs.appendFileSync(_sessionFile, line + '\n', 'utf8');
  } catch (_) {}
}

function removeRule(num) {
  const rules = loadRules();
  const idx = num - 1;
  if (idx < 0 || idx >= rules.length) return false;
  rules.splice(idx, 1);
  const body = rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
  fs.writeFileSync(RULES_FILE, `# Proverbs Admin Rules\n\n${body}\n`, 'utf8');
  return true;
}

// ─── ANSI Colors ─────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  magenta: '\x1b[35m',
  cyanBold:  '\x1b[1;36m',
  greenBold: '\x1b[1;32m',
};

function colorize(color, text) {
  return `${color}${text}${C.reset}`;
}

// ─── Syntax highlighting for code blocks ─────────────────────────────────────
const _JS_KEYWORDS_RE = /\b(?:const|let|var|function|async|await|return|if|else|for|while|class|import|export|default|new|try|catch|throw|typeof|instanceof|from|of|in)\b/g;
const _PY_KEYWORDS_RE = /\b(?:def|class|import|from|return|if|elif|else|for|while|try|except|with|as|pass|raise|True|False|None|and|or|not|in|is)\b/g;
const _SH_KEYWORDS_RE = /\b(?:if|then|else|fi|for|do|done|while|case|esac|echo|export|source|cd|return)\b/g;

function highlightCode(code, lang) {
  if (!lang || lang === 'text' || lang === 'plain') return code;
  const jsLangs   = ['js','javascript','typescript','ts','tsx','jsx','node'];
  const pyLangs   = ['python','py'];
  const shLangs   = ['bash','sh','shell','zsh'];
  const jsonLangs = ['json'];

  if (jsonLangs.includes(lang)) {
    return code
      .replace(/("(?:[^"\\]|\\.)*")\s*:/g, colorize(C.cyan, '$1') + ':')
      .replace(/:\s*("(?:[^"\\]|\\.)*")/g, ': ' + colorize(C.green, '$1'))
      .replace(/\b(true|false|null)\b/g, colorize(C.yellow, '$1'))
      .replace(/\b(-?\d+\.?\d*)\b/g, colorize(C.magenta, '$1'));
  }

  if (jsLangs.includes(lang) || shLangs.includes(lang) || pyLangs.includes(lang)) {
    // One precompiled alternation per language family — the old per-keyword
    // loop compiled and ran ~23 separate regex passes over every code block.
    const kwRe = jsLangs.includes(lang)
      ? _JS_KEYWORDS_RE
      : pyLangs.includes(lang) ? _PY_KEYWORDS_RE : _SH_KEYWORDS_RE;

    let result = code;
    // Strings (protect from further substitutions by using a placeholder approach is complex;
    // instead apply in order: strings first, then comments, then keywords, then numbers)
    result = result.replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, m => colorize(C.green, m));
    // Comments
    result = result.replace(/(#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g, m => colorize(C.dim, m));
    // Keywords
    result = result.replace(kwRe, m => colorize(C.cyan, m));
    // Numbers
    result = result.replace(/\b(\d+\.?\d*)\b/g, colorize(C.magenta, '$1'));
    return result;
  }

  return code;
}

function renderResponse(text) {
  if (!highlightEnabled) return text;
  return text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const highlighted = highlightCode(code, lang.toLowerCase());
    return colorize(C.dim, '```' + lang) + '\n' + highlighted + colorize(C.dim, '```');
  });
}

// ─── Config ───────────────────────────────────────────────────────────────────
let OLLAMA_BASE = process.env.PROVERBS_SERVER_URL || 'http://localhost:11435'; // Proverbs built-in server (default)
let activeApiFormat   = 'ollama'; // 'ollama' | 'openai'
let activeBackendName = 'Proverbs';
const DEFAULT_MODEL = 'proverbs';
let model = process.env.PROVERBS_MODEL || loadActiveModel(DEFAULT_MODEL);
// Default to ~/  (matching Claude Code's default working directory)
// Override via CLI arg: proverbs /path/to/project
let cwd = (() => {
  const argPath = process.argv.slice(2).find(a => a.startsWith('/') || a.startsWith('~/') || a.startsWith('.'));
  if (argPath) { const p = argPath.replace(/^~/, require('os').homedir()); if (fs.existsSync(p)) return p; }
  const terminal = process.cwd();
  const home = require('os').homedir();
  // If launched from home or root (non-project), default to home
  return terminal === '/' ? home : terminal;
})();

// ─── Proverbs verses for daily display ───────────────────────────────────────
const PROVERBS_VERSES = [
  '"Trust in the LORD with all your heart and lean not on your own understanding." — Proverbs 3:5',
  '"In all your ways submit to him, and he will make your paths straight." — Proverbs 3:6',
  '"The fear of the LORD is the beginning of wisdom." — Proverbs 9:10',
  '"Pride goes before destruction, a haughty spirit before a fall." — Proverbs 16:18',
  '"A gentle answer turns away wrath, but a harsh word stirs up anger." — Proverbs 15:1',
  '"Plans fail for lack of counsel, but with many advisers they succeed." — Proverbs 15:22',
  '"Commit to the LORD whatever you do, and he will establish your plans." — Proverbs 16:3',
  '"A friend loves at all times, and a brother is born for a time of adversity." — Proverbs 17:17',
  '"The name of the LORD is a fortified tower; the righteous run to it and are safe." — Proverbs 18:10',
  '"Many are the plans in a person\'s heart, but it is the LORD\'s purpose that prevails." — Proverbs 19:21',
  '"Start children off on the way they should go, and even when they are old they will not turn from it." — Proverbs 22:6',
  '"As iron sharpens iron, so one person sharpens another." — Proverbs 27:17',
  '"The wicked flee though no one pursues, but the righteous are as bold as a lion." — Proverbs 28:1',
  '"Where there is no vision, the people perish." — Proverbs 29:18',
  '"She is clothed with strength and dignity; she can laugh at the days to come." — Proverbs 31:25',
  '"Whoever gives heed to instruction prospers, and blessed is the one who trusts in the LORD." — Proverbs 16:20',
  '"The heart of the discerning acquires knowledge, for the ears of the wise seek it out." — Proverbs 18:15',
  '"Gracious words are a honeycomb, sweet to the soul and healing to the bones." — Proverbs 16:24',
  '"Do not forsake wisdom, and she will protect you; love her, and she will watch over you." — Proverbs 4:6',
  '"The way of fools seems right to them, but the wise listen to advice." — Proverbs 12:15',
];

// ─── Bible verses shown at the end of every finished output ───────────────────
// A broad pool from across Scripture (not only Proverbs) so each completed reply
// closes on a verse. Includes the Proverbs pool above.
const CLOSING_VERSES = PROVERBS_VERSES.concat([
  '"I can do all this through him who gives me strength." — Philippians 4:13',
  '"For I know the plans I have for you, declares the LORD, plans to prosper you and not to harm you." — Jeremiah 29:11',
  '"The LORD is my shepherd, I lack nothing." — Psalm 23:1',
  '"Be strong and courageous. Do not be afraid; for the LORD your God will be with you wherever you go." — Joshua 1:9',
  '"And we know that in all things God works for the good of those who love him." — Romans 8:28',
  '"Cast all your anxiety on him because he cares for you." — 1 Peter 5:7',
  '"But those who hope in the LORD will renew their strength. They will soar on wings like eagles." — Isaiah 40:31',
  '"Do not be anxious about anything, but in every situation, by prayer and petition, present your requests to God." — Philippians 4:6',
  '"Your word is a lamp for my feet, a light on my path." — Psalm 119:105',
  '"Let all that you do be done in love." — 1 Corinthians 16:14',
  '"Come to me, all you who are weary and burdened, and I will give you rest." — Matthew 11:28',
  '"The LORD will fight for you; you need only to be still." — Exodus 14:14',
  '"Whatever you do, work at it with all your heart, as working for the Lord." — Colossians 3:23',
  '"This is the day the LORD has made; let us rejoice and be glad in it." — Psalm 118:24',
  '"Give thanks to the LORD, for he is good; his love endures forever." — Psalm 107:1',
  '"For God so loved the world that he gave his one and only Son." — John 3:16',
  '"The light shines in the darkness, and the darkness has not overcome it." — John 1:5',
  '"Let your light shine before others, that they may see your good deeds." — Matthew 5:16',
  '"Be still, and know that I am God." — Psalm 46:10',
  '"Faith is confidence in what we hope for and assurance about what we do not see." — Hebrews 11:1',
]);

// Print a single Bible verse to close out a finished reply. Called after every
// completed terminal output so a verse shows every time Proverbs is used.
function printClosingVerse() {
  try {
    const verse = CLOSING_VERSES[Math.floor(Math.random() * CLOSING_VERSES.length)];
    console.log(colorize(C.dim, '  ' + verse) + '\n');
  } catch (_) { /* never let a verse break the reply */ }
}

// ─── Banner ───────────────────────────────────────────────────────────────────
function printBanner() {
  const verse = PROVERBS_VERSES[Math.floor(Math.random() * PROVERBS_VERSES.length)];
  console.log(colorize(C.cyanBold, '\n  Proverbs') + colorize(C.dim, '  ' + cwd + '  /help for commands'));
  console.log(colorize(C.dim, '  “' + verse + '”\n'));
}

// ─── Spinner ──────────────────────────────────────────────────────────────────
class Spinner {
  constructor(label = 'Thinking...') {
    this.frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    this.label = label;
    this.i = 0;
    this.timer = null;
  }
  start() {
    process.stdout.write('\x1b[?25l');
    this.timer = setInterval(() => {
      process.stdout.write(
        `\r${colorize(C.dim, this.frames[this.i % this.frames.length] + ' ' + this.label)}`
      );
      this.i++;
    }, 80);
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    process.stdout.write('\r\x1b[K');
    process.stdout.write('\x1b[?25h');
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
// Monotonic id for tool calls so Anthropic's tool_use.id ↔ tool_result.tool_use_id
// pairing stays valid through the cascade server.
let _toolCallSeq = 0;
function _genToolCallId() {
  _toolCallSeq += 1;
  return 'toolu_' + Date.now().toString(36) + '_' + _toolCallSeq;
}

// ── Tool-call recovery for small local models ────────────────────────────────
// Models like qwen2.5-coder:1.5b advertise tool support but often emit the call
// as JSON in the message body (usually inside a ```json fence) rather than as a
// native tool_call. Ollama passes that through as plain content, so the agent
// loop never fires the tool. We parse those back into real calls.
//
// Deliberately conservative: we only accept objects that look exactly like a
// tool call ({name, arguments}), so ordinary JSON the model is merely *showing*
// the user (a config sample, an API response) is not hijacked into an action.
const _TOOLCALL_FENCE_RE = /```(?:json|tool_call|tool_code)?\s*(\{[\s\S]*?\})\s*```/g;

function _looksLikeToolCall(o) {
  return !!o && typeof o === 'object' && !Array.isArray(o) &&
         typeof o.name === 'string' && o.name.length > 0 &&
         ('arguments' in o || 'parameters' in o || 'args' in o);
}

function _toCall(o) {
  const argsRaw = o.arguments ?? o.parameters ?? o.args ?? {};
  let args = argsRaw;
  if (typeof argsRaw === 'string') {
    try { args = JSON.parse(argsRaw); } catch (_) { args = {}; }
  }
  return { id: _genToolCallId(), type: 'function', function: { name: o.name, arguments: args } };
}

function _recoverToolCallsFromText(text) {
  const calls = [];
  if (!text || text.indexOf('{') === -1) return calls;

  // 1) Fenced blocks — the common case.
  let m;
  _TOOLCALL_FENCE_RE.lastIndex = 0;
  while ((m = _TOOLCALL_FENCE_RE.exec(text)) !== null) {
    try {
      const o = JSON.parse(m[1]);
      if (_looksLikeToolCall(o)) calls.push(_toCall(o));
      else if (Array.isArray(o?.tool_calls)) o.tool_calls.filter(_looksLikeToolCall).forEach(c => calls.push(_toCall(c)));
    } catch (_) { /* not JSON — leave it as prose */ }
  }
  if (calls.length) return calls;

  // 2) Bare JSON object as the entire reply (no fence).
  const t = text.trim();
  if (t.startsWith('{') && t.endsWith('}')) {
    try {
      const o = JSON.parse(t);
      if (_looksLikeToolCall(o)) calls.push(_toCall(o));
    } catch (_) { /* ignore */ }
  }
  return calls;
}

// Remove the JSON we just promoted to a tool call, so the user does not see the
// raw call echoed above its own result.
function _stripToolCallBlocks(text) {
  let out = text.replace(_TOOLCALL_FENCE_RE, (full, body) => {
    try {
      const o = JSON.parse(body);
      if (_looksLikeToolCall(o) || Array.isArray(o?.tool_calls)) return '';
    } catch (_) {}
    return full;
  });
  const t = out.trim();
  if (t.startsWith('{') && t.endsWith('}')) {
    try { if (_looksLikeToolCall(JSON.parse(t))) return ''; } catch (_) {}
  }
  return out.trim();
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const _hdrs = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    };
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      const _lk = getProverbsLocalKey();
      if (_lk) _hdrs['Authorization'] = 'Bearer ' + _lk;
    }
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname,
      method: 'POST',
      headers: _hdrs,
    };
    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}\nBody: ${raw.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const _getHdrs = {};
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      const _lk = getProverbsLocalKey();
      if (_lk) _getHdrs['Authorization'] = 'Bearer ' + _lk;
    }
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname,
      method: 'GET',
      headers: _getHdrs,
    };
    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 10000, () => {
      req.destroy();
      reject(Object.assign(new Error('Request timed out: ' + url), { code: 'ETIMEDOUT' }));
    });
    req.end();
  });
}

function httpsGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  { 'User-Agent': 'proverbs-cli/1.0' },
    };
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 10000, () => {
      req.destroy();
      reject(Object.assign(new Error('Request timed out: ' + url), { code: 'ETIMEDOUT' }));
    });
    req.end();
  });
}

// ─── Proverbs server — auto-heal & auto-start ────────────────────────────────
async function ensureOllama() {
  try {
    const res = await httpGet(`${OLLAMA_BASE}/api/tags`);
    if (res.status === 200) return;
  } catch (_) {}
  // Not running — auto-start it
  process.stdout.write(colorize(C.dim, '  starting server...\r'));
  try {
    await _autoStartServer();
  } catch (err) {
    console.error(colorize(C.red, `✗  Could not start Proverbs server: ${err.message}`));
    console.error(colorize(C.dim, '   Manual: ~/.proverbs/venv/bin/python -m inference.server'));
    console.error(colorize(C.dim, '   Logs:   tail -f /tmp/proverbs-server.log'));
    process.exit(1);
  }
}

async function _autoStartServer() {
  const venv = _venvPython();
  const projectRoot = path.resolve(__dirname);
  const serverEnv = {
    ...process.env,
    PROVERBS_MODEL_PATH:     process.env.PROVERBS_MODEL_PATH     || path.join(os.homedir(), '.proverbs', 'checkpoints', 'local', 'best.pt'),
    PROVERBS_TOKENIZER_PATH: process.env.PROVERBS_TOKENIZER_PATH || path.join(os.homedir(), '.proverbs', 'tokenizer.json'),
    PROVERBS_BACKEND:        process.env.PROVERBS_BACKEND        || 'auto',
  };
  const logFd = fs.openSync('/tmp/proverbs-server.log', 'a');
  const proc  = spawn(''.concat(venv), ['-m', 'inference.server', '--port', '11435'], {
    cwd: projectRoot, env: serverEnv, detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  // A missing/relocated venv makes spawn emit 'error' asynchronously; without a
  // listener that becomes an unhandled 'error' event and crashes the whole CLI.
  // Swallow it here — the readiness poll below is the real success signal, and
  // _selfHeal()'s Claude rung is the backstop when the server truly can't start.
  let _spawnErr = null;
  proc.on('error', (err) => { _spawnErr = err; });
  proc.unref();
  const _polls    = Number(process.env.PROVERBS_START_POLLS    || 30);
  const _pollMs   = Number(process.env.PROVERBS_START_POLL_MS  || 1000);
  for (let i = 0; i < _polls; i++) {
    await new Promise(r => setTimeout(r, _pollMs));
    try {
      const res = await httpGet(`${OLLAMA_BASE}/api/tags`);
      if (res.status === 200) {
        process.stdout.write('\r\x1b[K'); // clear "starting server..." line
        return;
      }
    } catch (_) {}
  }
  throw new Error(`Server did not become ready in ${Math.round(_polls * _pollMs / 1000)}s` +
    (_spawnErr ? ` (spawn failed: ${_spawnErr.code || _spawnErr.message})` : '') +
    ` — check /tmp/proverbs-server.log`);
}

// ─── Self-heal: recover from mid-stream connection drops ──────────────────────
// Ladder, cheapest first:
//   1. Replay a previously-learned fix from the healbook (FREE — no Claude).
//   2. Built-in heal: actually restart the inference server and wait for ready.
//   3. Fall back to the `claude` CLI to diagnose + repair, rate-limited; the fix
//      is recorded in the healbook so step 1 handles it for free next time.

// Per-turn counter so a single user turn can't loop-restart forever.
let _healAttemptsThisTurn = 0;
function _resetHealAttempts() { _healAttemptsThisTurn = 0; }

// Normalize an error into a stable signature for healbook lookup + dedup.
// Strips volatile bits (timestamps, ports, hex ids, absolute paths) so the same
// class of crash maps to the same key across occurrences.
function _errorSignature(err) {
  const code = (err && err.code) ? err.code : '';
  let msg = (err && err.message) ? String(err.message) : String(err);
  msg = msg
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*/g, '<ts>')
    .replace(/0x[0-9a-fA-F]+/g, '<hex>')
    .replace(/:\d{2,5}\b/g, ':<port>')
    .replace(/\/[^\s'"]+/g, '<path>')
    .replace(/\b\d+\b/g, '<n>')
    .trim()
    .slice(0, 160);
  return (code ? code + '|' : '') + msg;
}

// True for errors that mean "the inference connection died" — the class a
// server restart can plausibly fix.
function _isConnectionError(err) {
  const code = err && err.code;
  if (code === 'ECONNRESET' || code === 'ENOTFOUND' || code === 'ECONNREFUSED' ||
      code === 'EPIPE' || code === 'ETIMEDOUT' || code === 'ECONNABORTED') return true;
  const m = (err && err.message || '').toLowerCase();
  return /connection (lost|reset|refused|closed)|socket hang up|econnreset|server connection|streaming error/.test(m);
}

function _healbookLoad() {
  try { return JSON.parse(fs.readFileSync(HEALBOOK_FILE, 'utf8')); }
  catch (_) { return { entries: {}, claudeLog: [] }; }
}
function _healbookSave(book) {
  try {
    fs.mkdirSync(PROVERBS_DIR, { recursive: true });
    fs.writeFileSync(HEALBOOK_FILE, JSON.stringify(book, null, 2), 'utf8');
  } catch (e) { /* non-fatal: healing still works, just won't persist */ }
}
function _todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Count Claude heal calls made today (rolling daily cap).
function _claudeCallsToday(book) {
  const today = _todayKey();
  return (book.claudeLog || []).filter(e => e.day === today).length;
}

// Decide whether we're allowed to spend a Claude CLI call right now.
// Returns { allowed:boolean, reason:string }.
function _claudeHealAllowed(book, sig) {
  if (HEAL_DISABLE_CLAUDE) return { allowed: false, reason: 'disabled via PROVERBS_NO_CLAUDE_HEAL' };
  const calls = _claudeCallsToday(book);
  if (calls >= CLAUDE_HEAL_MAX_PER_DAY) {
    return { allowed: false, reason: `daily cap reached (${calls}/${CLAUDE_HEAL_MAX_PER_DAY})` };
  }
  const last = (book.claudeLog || []).slice(-1)[0];
  if (last && last.ts && (Date.now() - last.ts) < CLAUDE_HEAL_COOLDOWN_MS) {
    const wait = Math.ceil((CLAUDE_HEAL_COOLDOWN_MS - (Date.now() - last.ts)) / 1000);
    return { allowed: false, reason: `cooldown active (${wait}s left)` };
  }
  // Per-signature dedup: if we already asked Claude about this exact signature
  // today, don't ask again — replay the stored fix instead.
  const askedToday = (book.claudeLog || []).some(e => e.sig === sig && e.day === _todayKey());
  if (askedToday) return { allowed: false, reason: 'already consulted Claude for this error today' };
  return { allowed: true, reason: '' };
}

// ─── Hard limits — the wall that self-healing must NOT try to climb ───────────
// Some failures are not bugs and not transient: no retry, no server restart, and
// no amount of cleverness fixes them. They need a decision from the user (add
// credit, wait for a reset, fix a key). Retrying these is worse than useless —
// it burns money and time to arrive at the same wall.
//
// The server rejects with a bare `new Error("Claude API 429: ...")` — no .code —
// so _isConnectionError() can't see these and _selfHeal() would either ignore
// them or waste its Claude rung on them. We classify them BEFORE any heal runs.
//
// Returns { kind, title, detail, action } or null if it isn't a hard limit.
function _hardLimit(err) {
  const msg  = (err && err.message || '') + '';
  const code = _apiStatusOf(msg);

  // 401/403 — key rejected. Retrying replays the same rejection forever.
  if (code === 401 || code === 403 || /invalid[_ ]api[_ ]key|authentication[_ ]error|permission[_ ]error/i.test(msg)) {
    return { kind: 'auth', title: 'API key rejected',
      detail: 'Anthropic refused the key in ~/.proverbs/config.json (anthropicApiKey).',
      action: 'Check the key is current and active at console.anthropic.com → API Keys.' };
  }
  // Credit exhausted — billing state, not a fault. Only you can clear it.
  if (/credit balance is too low|insufficient[_ ]quota|billing|payment required/i.test(msg) || code === 402) {
    return { kind: 'credit', title: 'Out of API credit',
      detail: 'The Anthropic account behind this key has no credit left.',
      action: 'Add credit at console.anthropic.com → Billing, then re-run your prompt.' };
  }
  // 429 — rate limited. This one CAN pass on its own, so say so.
  if (code === 429 || /rate[_ ]limit/i.test(msg)) {
    return { kind: 'rate', title: 'Rate limited by the API',
      detail: 'Too many requests in a short window. This clears on its own.',
      action: 'Wait a moment and re-run your prompt — nothing is broken.' };
  }
  // 529 / overloaded — Anthropic-side capacity. Not your problem to fix.
  if (code === 529 || /overloaded/i.test(msg)) {
    return { kind: 'overload', title: 'Anthropic API is overloaded',
      detail: 'The API is temporarily at capacity on their side.',
      action: 'Wait a moment and re-run — or use /backend to switch to a local model.' };
  }
  // Context window — retrying an oversized prompt just re-fails identically.
  if (/prompt is too long|context[_ ]length|maximum context|too many tokens/i.test(msg)) {
    return { kind: 'context', title: 'Conversation too long for the model',
      detail: 'This prompt plus its history exceeds the model context window.',
      action: 'Run /compress to shrink history, or /clear to start fresh.' };
  }
  return null;
}

// Pull an HTTP status out of the server's "Claude API <code>: ..." message.
function _apiStatusOf(msg) {
  const m = /Claude API (\d{3})/.exec(msg) || /\b(4\d{2}|5\d{2})\b/.exec(msg);
  return m ? Number(m[1]) : 0;
}

// Report a hard limit plainly and stop. No stack trace, no raw JSON dump.
function _reportHardLimit(hl) {
  console.log('');
  console.log(colorize(C.yellow, '  ⚠  ' + hl.title));
  console.log(colorize(C.dim,    '     ' + hl.detail));
  console.log(colorize(C.cyan,   '     → ' + hl.action));
  console.log('');
}

// Probe whether the inference server answers on /api/tags.
async function _serverHealthy() {
  try { const r = await httpGet(`${OLLAMA_BASE}/api/tags`); return r.status === 200; }
  catch (_) { return false; }
}

// Run the `claude` CLI in non-interactive print mode to diagnose + fix Proverbs.
// Kept deliberately small: cheap model, capped turns, tight timeout, compact
// prompt. Returns { ok, summary } — never throws.
function _runClaudeHeal(sig, context) {
  const prompt =
    'You are repairing the Proverbs CLI, which just crashed mid-response. ' +
    'Do the MINIMUM needed to restore service — be fast and frugal, this draws on a Claude Max plan.\n\n' +
    'Error signature: ' + sig + '\n\n' +
    'Runtime diagnosis:\n' + context + '\n\n' +
    'Steps: (1) identify the most likely root cause from the log/state above; ' +
    '(2) if it is a dead/wedged inference server, restart it; ' +
    '(3) if it is a code bug in cli.js / inference/server.py / server/server.js, apply the smallest fix and rebuild cli.js with `node build.js`. ' +
    'Then reply with ONE short line starting "FIX:" describing exactly what you changed so it can be replayed automatically next time.';
  try {
    // IMPORTANT: pass argv as an array via execFileSync — no shell. The prompt
    // contains backticks (`node build.js`) and could contain $()/quotes; routing
    // it through a shell would trigger command substitution (hang + injection
    // risk). execFileSync hands the prompt to the binary as one literal arg.
    const out = execFileSync(
      CLAUDE_HEAL_BIN,
      ['-p', prompt, '--model', CLAUDE_HEAL_MODEL, '--max-turns', String(CLAUDE_HEAL_MAX_TURNS), '--dangerously-skip-permissions'],
      { cwd: path.resolve(__dirname), encoding: 'utf8', timeout: CLAUDE_HEAL_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const fixLine = (out.split('\n').find(l => /^\s*FIX:/i.test(l)) || '').trim() || out.trim().slice(-300);
    return { ok: true, summary: fixLine };
  } catch (e) {
    const detail = (e.stderr ? String(e.stderr) : '') || e.message || 'unknown';
    return { ok: false, summary: detail.slice(0, 300) };
  }
}

// The orchestrator. Given the error that killed the stream, attempt to recover.
// Returns true if a retry of the turn is warranted, false if we should give up.
async function _selfHeal(err) {
  // ── Step 0: is this a wall rather than a fault? ──────────────────────────────
  // Checked FIRST, before the attempt counter, the healbook, and the Claude
  // rung. Out of credit / bad key / rate limited cannot be healed by anything
  // Proverbs does; retrying only spends more money to hit the same wall. Tell
  // the user what it is and what clears it, then stop.
  const hl = _hardLimit(err);
  if (hl) { _reportHardLimit(hl); return false; }

  if (_healAttemptsThisTurn >= MAX_HEAL_ATTEMPTS_PER_TURN) return false;
  _healAttemptsThisTurn++;

  const sig  = _errorSignature(err);
  const book = _healbookLoad();
  const entry = book.entries[sig];

  // ── Step 1: replay a learned fix (FREE) ─────────────────────────────────────
  if (entry && entry.successes > 0 && entry.action === 'restart_server') {
    console.log(colorize(C.yellow, `  ↻  Known issue — replaying learned fix (restart server)…`));
    try { await _autoStartServer(); } catch (_) {}
    if (await _serverHealthy()) {
      entry.successes++; entry.lastTs = Date.now(); _healbookSave(book);
      console.log(colorize(C.green, `  ✓  Recovered from a known issue without using any Claude usage.`));
      return true;
    }
  }

  // ── Step 2: built-in heal — actually restart the server ─────────────────────
  if (_isConnectionError(err)) {
    console.log(colorize(C.yellow, `  ↻  Connection lost — restarting Proverbs server and retrying…`));
    try { await _autoStartServer(); } catch (_) {}
    if (await _serverHealthy()) {
      // Learn it so future identical drops skip straight to the free replay.
      book.entries[sig] = {
        action: 'restart_server',
        diagnosis: 'inference connection dropped; server restart restored it',
        successes: (entry && entry.successes || 0) + 1,
        fails: (entry && entry.fails) || 0,
        lastTs: Date.now(),
      };
      _healbookSave(book);
      console.log(colorize(C.green, `  ✓  Server restarted — retrying your request.`));
      return true;
    }
  }

  // ── Step 3: Claude CLI fallback (rate-limited; spends Max usage) ─────────────
  const gate = _claudeHealAllowed(book, sig);
  if (!gate.allowed) {
    console.log(colorize(C.dim, `  (skipping Claude fallback: ${gate.reason})`));
    if (entry) { entry.fails = (entry.fails || 0) + 1; _healbookSave(book); }
    return false;
  }

  console.log(colorize(C.yellow, `  ↻  Self-heal failed — asking Claude (CLI) to diagnose and fix…`));
  let context = '';
  try { context = toolDiagnoseSelf({}); } catch (_) { context = '(diagnose_self unavailable)'; }
  const res = _runClaudeHeal(sig, context.slice(0, 4000));

  // Record the Claude call against the daily cap REGARDLESS of outcome.
  book.claudeLog = book.claudeLog || [];
  book.claudeLog.push({ sig, ts: Date.now(), day: _todayKey(), ok: res.ok });
  // Trim the log so it can't grow unbounded.
  if (book.claudeLog.length > 200) book.claudeLog = book.claudeLog.slice(-200);

  if (res.ok) {
    book.entries[sig] = {
      action: 'restart_server',  // most Claude heals end in a server restart; replay that for free
      diagnosis: res.summary || 'fixed by Claude',
      claudeFix: res.summary,
      successes: (entry && entry.successes) || 0,
      fails: (entry && entry.fails) || 0,
      lastTs: Date.now(),
    };
    _healbookSave(book);
    console.log(colorize(C.green, `  ✓  Claude applied a fix: ${res.summary || '(see above)'}`));
    // Give the server a moment, then verify before signalling a retry.
    if (await _serverHealthy()) return true;
    try { await _autoStartServer(); } catch (_) {}
    return await _serverHealthy();
  }

  _healbookSave(book);
  console.log(colorize(C.red, `  ✗  Claude fallback could not fix it: ${res.summary}`));
  return false;
}

// ─── Self-learning: score pending exchange from next user message ─────────────
function _scorePendingExchange(nextUserMsg) {
  if (!_selfLearnPending) return;
  const { systemPrompt, userMsg, assistantMsg } = _selfLearnPending;
  _selfLearnPending = null;

  const neg = ['wrong', "that's not", 'not right', 'incorrect', "doesn't work",
               "doesn't make sense", 'fix this', "that's wrong", 'nope', 'bad '];
  const pos = ['perfect', 'yes exactly', 'that works', 'great', 'correct ', 'exactly right'];
  const lower = nextUserMsg.toLowerCase();
  const signal = neg.some(p => lower.includes(p)) ? 'negative'
               : pos.some(p => lower.includes(p)) ? 'positive' : 'neutral';

  try {
    const qDir = path.join(PROVERBS_DIR, signal === 'negative' ? 'rejected_sessions' : 'quality_sessions');
    fs.mkdirSync(qDir, { recursive: true });
    const entry = JSON.stringify({
      messages: [
        { role: 'system',    content: systemPrompt },
        { role: 'user',      content: userMsg },
        { role: 'assistant', content: assistantMsg },
      ],
      quality: signal,
    });
    fs.writeFileSync(path.join(qDir, `ex-${process.pid}-${_learnExampleCount}.jsonl`), entry + '\n');
    if (signal !== 'negative') {
      _learnExampleCount++;
      if (_learnExampleCount >= LEARN_RETRAIN_THRESHOLD) {
        _learnExampleCount = 0;
        // Notify server to trigger background retraining
        httpGet(`${OLLAMA_BASE}/v1/admin/learn-status`).catch(() => {});
        console.log(colorize(C.dim, '\n  ⟳ Quality threshold reached — background retraining scheduled.\n'));
      }
    }
  } catch (_) {}
}

// ─── Tool definitions (Ollama format) ────────────────────────────────────────
const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file at the given path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative file path to read.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file, creating parent directories if needed.',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'File path to write.' },
          content: { type: 'string', description: 'Content to write into the file.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace the first occurrence of old_text with new_text in a file.',
      parameters: {
        type: 'object',
        properties: {
          path:     { type: 'string', description: 'File path to edit.' },
          old_text: { type: 'string', description: 'Exact text to find.' },
          new_text: { type: 'string', description: 'Replacement text.' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories at a given path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list. Defaults to current working directory.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_bash',
      description: 'Run a shell command and return its stdout/stderr output.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
        },
        required: ['command'],
      },
    },
  },
  // ── Feature 1: grep_files / find_files ──────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'grep_files',
      description: 'Recursively search file contents for a regex pattern. Returns matches in "file:linenum: line" format. Skips node_modules, .git, and hidden directories.',
      parameters: {
        type: 'object',
        properties: {
          pattern:    { type: 'string',  description: 'Regular expression pattern to search for.' },
          path:       { type: 'string',  description: 'Directory to search in. Defaults to current working directory.' },
          extensions: { type: 'string',  description: 'Comma-separated list of file extensions to include, e.g. "js,ts,json". Leave empty to search all files.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: 'Recursively find files by name using a glob-style pattern (* matches any chars, ? matches one char). Skips node_modules, .git, and hidden directories.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob-style filename pattern, e.g. "*.test.js" or "config?.json".' },
          path:    { type: 'string', description: 'Directory to search in. Defaults to current working directory.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_projects',
      description: 'Find projects/apps the user has built ANYWHERE on this computer by name — use this when the user wants to switch to or ask about a different app/repo (e.g. "switch to biblesim", "open my warsim project", "the app I made for X"). Searches project history and the whole machine (Spotlight). Returns matching projects with their full paths.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Project/app name or partial name to search for, e.g. "biblesim" or "warsim". Omit to list all known projects.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'switch_project',
      description: 'Switch the active project to a different directory (changes the working directory so subsequent file/git/code operations target that repo). Use after find_projects to switch to the project the user asked for. Pass the exact path returned by find_projects.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the project to switch to (from find_projects results).' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'diagnose_self',
      description: 'Read Proverbs\' OWN logs and runtime state (inference server log, recent errors, backend status, source paths) when the user reports that Proverbs itself is broken, hanging, slow, erroring, or "experiencing issues". Use this to find the root cause in Proverbs, then read/fix the relevant source file.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Pause and ASK THE USER one or more clarifying questions before continuing — exactly like a senior engineer would when requirements are ambiguous. Use this PROACTIVELY whenever the task is underspecified, there are multiple reasonable approaches, a decision is irreversible or outward-facing (deploys, deletes, publishing), or you need a preference, scope, credential location, or permission. Prefer asking over guessing. Each question may include numbered options the user can pick by number, or they can type a free-form answer.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: 'One or more questions to ask. Keep them specific and decision-relevant.',
            items: {
              type: 'object',
              properties: {
                question:   { type: 'string', description: 'The question to ask the user.' },
                header:     { type: 'string', description: 'Optional short label/category for the question.' },
                multiSelect:{ type: 'boolean', description: 'Allow multiple options to be selected.' },
                options: {
                  type: 'array',
                  description: 'Optional choices. The user can pick by number or type their own answer.',
                  items: {
                    type: 'object',
                    properties: {
                      label:       { type: 'string', description: 'Short choice text.' },
                      description: { type: 'string', description: 'What this choice means / its trade-off.' },
                    },
                    required: ['label'],
                  },
                },
              },
              required: ['question'],
            },
          },
          question: { type: 'string', description: 'Shorthand for a single question (use instead of "questions").' },
        },
        required: [],
      },
    },
  },
  // ── Feature 2: Git tools ────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Show the working-tree status of the current git repository (git status --short).',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Show unstaged changes in the repo. Optionally limit to a specific file.',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Optional file path to diff. Omit to diff the entire repo.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_log',
      description: 'Show recent commit history (one line per commit).',
      parameters: {
        type: 'object',
        properties: {
          n: { type: 'number', description: 'Number of commits to show (default 10).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_commit',
      description: 'Stage all changes (git add -A) and create a commit with the given message.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message.' },
        },
        required: ['message'],
      },
    },
  },
  // ── Feature 3: web_search ───────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web using DuckDuckGo Instant Answer API and return titles, snippets, and URLs.',
      parameters: {
        type: 'object',
        properties: {
          query:       { type: 'string',  description: 'The search query.' },
          num_results: { type: 'integer', description: 'Maximum number of results to return (default 5).' },
        },
        required: ['query'],
      },
    },
  },
  // ── Feature 4: codebase index ───────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_project_index',
      description: 'Return the saved codebase index (file tree with sizes) for the current project. Use this to understand the project structure before reading or editing files.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  // ── Feature 7: RAG ──────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'search_codebase',
      description: 'Semantically search the codebase using TF-IDF. Returns the most relevant file chunks for a query. Builds or refreshes the index automatically.',
      parameters: {
        type: 'object',
        properties: {
          query:       { type: 'string',  description: 'Search query (natural language or keywords).' },
          max_results: { type: 'number',  description: 'Maximum number of chunks to return (default 5, max 20).' },
        },
        required: ['query'],
      },
    },
  },
  // ── Feature 9: image analysis ───────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'analyze_image',
      description: 'Analyze an image file using the llava vision model. Returns a description or answers a question about the image.',
      parameters: {
        type: 'object',
        properties: {
          path:     { type: 'string', description: 'Absolute or relative path to the image file (png, jpg, jpeg, gif, webp, bmp).' },
          question: { type: 'string', description: 'Optional question to ask about the image. Defaults to a general description.' },
        },
        required: ['path'],
      },
    },
  },
  // ── patch_file ────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'patch_file',
      description: 'Replace ALL occurrences of old_string with new_string in a file. Use this instead of edit_file when you need to replace every instance or want an exact count of replacements. old_string must be non-empty. new_string may be empty (to delete the matched text).',
      parameters: {
        type: 'object',
        properties: {
          path:       { type: 'string', description: 'Absolute or relative path to the file to patch.' },
          old_string: { type: 'string', description: 'Exact literal text to find. Must not be empty.' },
          new_string: { type: 'string', description: 'Replacement text. May be empty string to delete matches.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  // ── load_context ─────────────────────────────────────────────────────────
  {
    name: 'load_context',
    description: 'Read a file and recursively inline its local imports up to a given depth. Returns a single concatenated string with section headers for each file. Useful for loading multi-file feature context into the conversation.',
    input_schema: {
      type: 'object',
      properties: {
        path:  { type: 'string',  description: 'Path to the entry file (absolute or relative to cwd).' },
        depth: { type: 'number',  description: 'How many levels of local imports to follow (default 2, max 5).' },
      },
      required: ['path'],
    },
  },
  // ── fetch_docs ────────────────────────────────────────────────────────────
  {
    name: 'fetch_docs',
    description: 'Fetch npm package documentation (registry metadata + GitHub README). Returns a formatted markdown string.',
    input_schema: {
      type: 'object',
      properties: {
        package: {
          type: 'string',
          description: 'The npm package name (e.g. "express", "@types/node")',
        },
      },
      required: ['package'],
    },
  },
  // ── fetch_url ─────────────────────────────────────────────────────────────
  {
    name: 'fetch_url',
    description: 'Fetch any URL and return its content as text. Works for web pages (HTML stripped), JSON APIs, and plain text. Use for reading docs, GitHub issues, error pages, API responses.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to fetch (must start with http:// or https://).',
        },
        selector: {
          type: 'string',
          description: 'Optional CSS tag hint to extract a specific section (e.g. "main", "article", "section"). Matches the first occurrence of that HTML tag.',
        },
      },
      required: ['url'],
    },
  },
  // ── clipboard ─────────────────────────────────────────────────────────────
  {
    name: 'clipboard_read',
    description: 'Read the current contents of the system clipboard. Returns the clipboard text as a string.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'clipboard_write',
    description: 'Write text to the system clipboard.',
    input_schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to place on the clipboard.',
        },
      },
      required: ['text'],
    },
  },
  { type: 'function', function: { name: 'task_create', description: 'Create a new tracked task. Returns the task with its id.', parameters: { type: 'object', properties: { title: { type: 'string', description: 'Short task title' }, description: { type: 'string', description: 'Optional longer description' } }, required: ['title'] } } },
  { type: 'function', function: { name: 'task_update', description: 'Update status of an existing task by id or prefix. Fires a macOS notification.', parameters: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['todo','in_progress','completed','failed','cancelled'] }, output: { type: 'string', description: 'Text to append to task output' } }, required: ['id','status'] } } },
  { type: 'function', function: { name: 'task_list',   description: 'List all tasks, optionally filtered by status.',                                   parameters: { type: 'object', properties: { status: { type: 'string', description: 'Filter: todo, in_progress, completed, failed, cancelled' } }, required: [] } } },
  { type: 'function', function: { name: 'task_get',    description: 'Get full details of a single task by id or prefix.',                               parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
];

// ─── .script file system — works like CLAUDE.md ──────────────────────────────
// Supports: .script, PROVERBS.md, .proverbs.md (all treated identically)
// Features: @import, env var expansion, section parsing, hot-reload via watcher

const SCRIPT_NAMES = ['.script', 'PROVERBS.md', '.proverbs.md'];
let _scriptWatcher = null;

function findScriptFiles(startDir) {
  const files = [];
  let dir = startDir;
  const home = os.homedir();
  while (dir && dir.length >= home.length) {
    for (const name of SCRIPT_NAMES) {
      const candidate = path.join(dir, name);
      try { if (fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) { files.push(candidate); break; } } catch(_) {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Global script
  if (fs.existsSync(GLOBAL_SCRIPT_PATH)) files.push(GLOBAL_SCRIPT_PATH);
  return files;
}

// Resolve @import directives in script content (like CLAUDE.md @path syntax)
function _resolveImports(content, baseDir, depth) {
  if (depth > 4) return content; // prevent circular imports
  return content.replace(/^@import\s+(.+)$/gm, (_, importPath) => {
    const trimmed = importPath.trim().replace(/^["']|["']$/g, '');
    const fullPath = path.isAbsolute(trimmed) ? trimmed : path.join(baseDir, trimmed);
    try {
      const imported = fs.readFileSync(fullPath, 'utf8');
      return _resolveImports(imported, path.dirname(fullPath), depth + 1);
    } catch (_) {
      return `<!-- @import ${trimmed} — file not found -->`;
    }
  });
}

// Expand $ENV_VAR and ${ENV_VAR} in script content
function _expandEnvVars(content) {
  return content
    .replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, k) => process.env[k] || '')
    .replace(/\$([A-Z_][A-Z0-9_]*)\b/g,    (_, k) => process.env[k] || '');
}

// Parse special sections from .script (like CLAUDE.md sections)
// Returns { full, commands, context, rules, notes }
function _parseScriptSections(content) {
  const sections = { commands: [], context: [], rules: [], notes: [] };
  let current = null;
  for (const line of content.split('\n')) {
    const h = line.match(/^#{1,3}\s+(Commands|Context|Rules|Notes|Important|Behavior|Style)\s*$/i);
    if (h) { current = h[1].toLowerCase(); continue; }
    if (line.startsWith('#') && !line.startsWith('##')) current = null; // top-level heading resets
    if (current && sections[current]) sections[current].push(line);
  }
  return sections;
}

function loadScriptFiles(dir) {
  if (!dir || typeof dir !== 'string') { scriptContent = ''; return 0; }
  let files;
  try { files = findScriptFiles(dir); } catch (_) { scriptContent = ''; return 0; }
  if (!files.length) { scriptContent = ''; return 0; }

  const parts = files.slice().reverse().map(f => {
    try {
      let raw = fs.readFileSync(f, 'utf8');
      raw = _resolveImports(raw, path.dirname(f), 0);
      raw = _expandEnvVars(raw);
      return '# Source: ' + path.relative(os.homedir(), f) + '\n' + raw;
    } catch (_) { return ''; }
  });
  scriptContent = parts.filter(Boolean).join('\n\n');

  // Hot-reload watcher: watch the .script files for changes
  _startScriptWatcher(files);

  return files.length;
}

function _startScriptWatcher(files) {
  if (_scriptWatcher) { try { _scriptWatcher.close(); } catch(_) {} _scriptWatcher = null; }
  const watched = new Set(files.map(f => path.dirname(f)));
  const watchers = [];
  watched.forEach(dir2 => {
    try {
      const w = fs.watch(dir2, (evt, filename) => {
        if (!filename) return;
        if (SCRIPT_NAMES.some(n => filename === n)) {
          loadScriptFiles(cwd);
          console.log(colorize(C.dim, '\n  (.script reloaded)\n'));
        }
      });
      watchers.push(w);
    } catch(_) {}
  });
  _scriptWatcher = { close: () => watchers.forEach(w => { try { w.close(); } catch(_) {} }) };
}

// ─── Tool implementations ─────────────────────────────────────────────────────

// ── Cross-file edit planner helper ───────────────────────────────────────────
function looksMultiFile(msg) {
  if (!msg || typeof msg !== 'string') return false;
  const lower = msg.toLowerCase();
  const hasTrigger = PLAN_TRIGGERS.some(w => lower.includes(w));
  if (!hasTrigger) return false;
  const fileRefs = (lower.match(/\b(file|component|route|page|model|schema|api|endpoint|hook|util|service|action|middleware)s?\b/g) || []).length;
  return fileRefs >= 2;
}

// ── Git auto-commit helper ────────────────────────────────────────────────────
async function checkAndOfferCommit(rl) {
  let gitOut;
  try {
    gitOut = execSync('git -C ' + JSON.stringify(cwd) + ' status --porcelain 2>/dev/null', { encoding: 'utf8' });
  } catch (_) { return; }
  if (!gitOut || !gitOut.trim()) return;
  const changed = gitOut.trim().split('\n').length;
  console.log(colorize(C.dim, '  git: ' + changed + ' file(s) changed'));
  if (!autoCommitEnabled) return;
  return new Promise((resolve) => {
    rl.pause();
    rl.question(colorize(C.cyan, '  Commit? [y/N/message]: '), (ans) => {
      rl.resume();
      const a = (ans || '').trim();
      if (!a || a.toLowerCase() === 'n') { resolve(); return; }
      const msg = a.toLowerCase() === 'y' ? 'chore: ai-assisted changes via proverbs' : a;
      try {
        execSync('git -C ' + JSON.stringify(cwd) + ' add -A', { stdio: 'pipe' });
        execSync('git -C ' + JSON.stringify(cwd) + ' commit -m ' + JSON.stringify(msg), { stdio: 'pipe' });
        console.log(colorize(C.green, '  Committed: ' + msg + '\n'));
      } catch (e) {
        const errMsg = e.stderr ? e.stderr.toString().split('\n')[0] : e.message;
        console.log(colorize(C.red, '  Commit failed: ' + errMsg + '\n'));
      }
      resolve();
    });
  });
}

// ── Undo/rollback: backup a file before overwriting ───────────────────────────
function backupFile(filePath) {
  try {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  } catch (e) {
    // Cannot create backup dir — skip silently, never block the write
    return;
  }
  try {
    if (!fs.existsSync(filePath)) return;
    const stamp = process.hrtime.bigint().toString();
    const safeName = filePath.replace(/[^a-z0-9._-]/gi, '_');
    const backupPath = path.join(BACKUPS_DIR, safeName + '.' + stamp + '.bak');
    fs.copyFileSync(filePath, backupPath);
    undoStack.push({ originalPath: filePath, backupPath });
    if (undoStack.length > MAX_UNDO_STACK) {
      const oldest = undoStack.shift();
      try { fs.unlinkSync(oldest.backupPath); } catch (_) {}
    }
  } catch (_) {
    // Backup failures are non-fatal — the write still proceeds
  }
}

// ── Clipboard helpers ─────────────────────────────────────────────────────────
function readClipboard() {
  try {
    const platform = os.platform();
    if (platform === 'darwin') {
      return execSync('pbpaste', { encoding: 'utf8' });
    }
    if (platform === 'linux') {
      return execSync(
        'xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output 2>/dev/null',
        { encoding: 'utf8', shell: true }
      );
    }
    if (platform === 'win32') {
      // PowerShell Get-Clipboard is present on every supported Windows build.
      return execSync('powershell -NoProfile -Command Get-Clipboard', { encoding: 'utf8' });
    }
    return 'Clipboard not supported on this platform.';
  } catch (e) {
    return 'Clipboard read failed: ' + e.message;
  }
}

function writeClipboard(text) {
  try {
    const platform = os.platform();
    if (platform === 'darwin') {
      execSync('pbcopy', { input: text });
      return true;
    }
    if (platform === 'linux') {
      execSync('xclip -selection clipboard', { input: text });
      return true;
    }
    if (platform === 'win32') {
      execSync('clip', { input: text });
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

function toolClipboardRead() {
  const content = readClipboard();
  return content;
}

function toolClipboardWrite(args) {
  const text = args.text || '';
  const ok = writeClipboard(text);
  if (ok) return `Clipboard updated (${text.length} chars).`;
  return 'Clipboard write failed or not supported on this platform.';
}

// ── Context gauge helpers ─────────────────────────────────────────────────────

// Synchronous char-based fallback — used when Ollama tokenize is unavailable.
function estimateTokensSync(msgs) {
  return msgs.reduce(function(s, m) {
    return s + Math.ceil((m.content || '').length / 4);
  }, 0);
}

// Real tokenization via Ollama /api/tokenize.
// Falls back to chars/4 silently when the endpoint is missing (older Ollama builds).
// Never throws — any failure returns the char-based estimate instead.
async function countTokens(text, tokenModel) {
  try {
    const resp = await httpPost(OLLAMA_BASE + '/api/tokenize', {
      model: tokenModel || model,
      prompt: text || '',
    });
    if (resp && Array.isArray(resp.tokens)) return resp.tokens.length;
    return Math.ceil((text || '').length / 4);
  } catch (_) {
    return Math.ceil((text || '').length / 4);
  }
}

// Sum real token counts across all messages (content + role per message).
// Processes serially so a slow or failed message does not abort the rest.
async function countMessagesTokens(messages) {
  let total = 0;
  for (const m of messages) {
    total += await countTokens((m.content || '') + (m.role || ''));
  }
  return total;
}

function getContextWindow(m) {
  return MODEL_CONTEXT_WINDOWS[m] || 8192;
}

// Async — uses real Ollama tokenization with silent char/4 fallback.
async function showContextGauge(msgs) {
  let used;
  let label;
  try {
    used  = await countMessagesTokens(msgs);
    label = 'tokens';
  } catch (_) {
    // Defensive: countMessagesTokens should never throw, but guard anyway.
    used  = estimateTokensSync(msgs);
    label = 'est. tokens';
  }
  const total  = getContextWindow(model);
  const pct    = Math.min(100, Math.round(used / total * 100));
  const filled = Math.round(pct / 5);
  const bar    = '█'.repeat(filled) + '░'.repeat(20 - filled);
  const col    = pct > 80 ? C.red : pct > 50 ? C.yellow : C.green;
  console.log(colorize(col, '  [' + bar + '] ' + pct + '% context (' + used.toLocaleString() + '/' + total.toLocaleString() + ' ' + label + ')'));
  if (pct > 75) {
    console.log(colorize(C.yellow, '  Use /compress to free space or /recommend for larger-context models.'));
  }
}

// ── Session persistence helpers ───────────────────────────────────────────────
function ensureSessionsSaveDir() {
  try {
    fs.mkdirSync(SESSIONS_SAVE_DIR, { recursive: true });
  } catch (e) {
    // non-fatal: will surface on write attempts
  }
}

function saveSession(name, history, extraState) {
  ensureSessionsSaveDir();
  let isoStamp;
  try { isoStamp = new global.Date().toISOString(); } catch (_) { isoStamp = String(Date.now()); }
  const safeName = name.replace(/[^a-z0-9_-]/gi, '_');
  if (!safeName) throw new Error('Session name produces an empty safe filename.');
  const filePath = path.join(SESSIONS_SAVE_DIR, safeName + '.json');
  const data = {
    name,
    history,
    cwd: extraState.cwd,
    model: extraState.model,
    sessionContextFiles: extraState.sessionContextFiles || [],
    savedAt: isoStamp,
  };
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    throw new Error('Could not write session file: ' + e.message);
  }
  return filePath;
}

function listSavedSessions() {
  ensureSessionsSaveDir();
  let files;
  try {
    files = fs.readdirSync(SESSIONS_SAVE_DIR).filter(f => f.endsWith('.json'));
  } catch (_) {
    return [];
  }
  return files.map(f => {
    try {
      const raw = fs.readFileSync(path.join(SESSIONS_SAVE_DIR, f), 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
}

function loadSession(name) {
  const safeName = name.replace(/[^a-z0-9_-]/gi, '_');
  if (!safeName) throw new Error('Session name produces an empty safe filename.');
  const filePath = path.join(SESSIONS_SAVE_DIR, safeName + '.json');
  if (!fs.existsSync(filePath)) throw new Error('Session not found: ' + name);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new Error('Session file is corrupted: ' + e.message);
  }
  if (!data || !Array.isArray(data.history)) throw new Error('Session file has invalid format.');
  return data;
}

function resolvePath(p) {
  if (!p) return cwd;
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

function toolReadFile(args) {
  const target = resolvePath(args.path);
  try {
    return fs.readFileSync(target, 'utf8');
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

// ── Diff preview ──────────────────────────────────────────────────────────────
function showDiff(filePath, oldContent, newContent) {
  if (!diffPreviewEnabled) return;
  try {
    const oldStr = typeof oldContent === 'string' ? oldContent : '';
    const newStr = typeof newContent === 'string' ? newContent : '';

    if (oldStr === newStr) {
      console.log(colorize(C.dim, '  (no change)'));
      return;
    }

    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');
    const maxLen = Math.max(oldLines.length, newLines.length);

    let firstDiff = -1;
    let lastDiff  = -1;
    for (let i = 0; i < maxLen; i++) {
      if (oldLines[i] !== newLines[i]) {
        if (firstDiff === -1) firstDiff = i;
        lastDiff = i;
      }
    }

    if (firstDiff === -1) return;

    const start  = Math.max(0, firstDiff - 2);
    const endIdx = Math.min(maxLen, lastDiff + 3);

    let relPath;
    try {
      relPath = path.relative(cwd, filePath) || filePath;
    } catch (_) {
      relPath = filePath;
    }

    console.log(colorize(C.dim, '\n─── diff: ' + relPath + ' ───'));

    for (let i = start; i < endIdx; i++) {
      const o = oldLines[i];
      const n = newLines[i];
      if (o === undefined && n !== undefined) {
        console.log(colorize(C.green, '+  ' + n));
      } else if (n === undefined && o !== undefined) {
        console.log(colorize(C.red, '-  ' + o));
      } else if (o !== n) {
        if (o !== undefined) console.log(colorize(C.red,   '-  ' + o));
        if (n !== undefined) console.log(colorize(C.green, '+  ' + n));
      } else {
        console.log(colorize(C.dim, '   ' + (o || '')));
      }
    }

    const delta = newLines.length - oldLines.length;
    console.log(colorize(C.dim, '  (' + (delta >= 0 ? '+' : '') + delta + ' lines)\n'));
  } catch (e) {
    // Graceful degradation — diff display errors must not interrupt the write flow
    try {
      console.log(colorize(C.dim, '  (diff unavailable: ' + e.message + ')'));
    } catch (_) {}
  }
}

// ─── TS / ESLint check helpers ────────────────────────────────────────────────
function runTsCheck(projectDir) {
  // Walk up from projectDir looking for tsconfig.json (max 5 levels)
  let dir = projectDir;
  let tsconfigPath = null;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) { tsconfigPath = candidate; break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!tsconfigPath) return null; // no tsconfig, skip

  // Ensure tsc is available via npx
  try { execSync('npx tsc --version', { stdio: 'pipe', encoding: 'utf8' }); } catch (_) { return null; }

  try {
    execSync('npx tsc --noEmit --pretty false 2>&1', {
      cwd: path.dirname(tsconfigPath),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return null; // no errors
  } catch (e) {
    const output = (e.stdout || '') + (e.stderr || '');
    const lines  = output.split('\n').filter(l => l.includes(': error TS')).slice(0, 10);
    return lines.length ? lines.join('\n') : null;
  }
}

function runEslintCheck(filePath) {
  // Check if an eslint config exists in any ancestor directory (max 4 levels)
  const dir = path.dirname(filePath);
  const configNames = [
    '.eslintrc.js', '.eslintrc.json', '.eslintrc.ts',
    'eslint.config.js', 'eslint.config.ts',
  ];
  const hasEslint = configNames.some(f => {
    let d = dir;
    for (let i = 0; i < 4; i++) {
      if (fs.existsSync(path.join(d, f))) return true;
      const p = path.dirname(d);
      if (p === d) break;
      d = p;
    }
    return false;
  });
  if (!hasEslint) return null;

  try {
    execSync('npx eslint --format compact ' + JSON.stringify(filePath) + ' 2>&1', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    });
    return null; // no issues
  } catch (e) {
    const output = (e.stdout || '') + (e.stderr || '');
    const lines  = output.split('\n').filter(l => /error|warning/.test(l)).slice(0, 8);
    return lines.length ? lines.join('\n') : null;
  }
}

// ─── detectTestRunner ─────────────────────────────────────────────────────────
// Returns 'jest' | 'vitest' | 'mocha' | 'tap' | 'ava' | null
function detectTestRunner(projectDir) {
  let pkgPath = null;
  let dir = projectDir || process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) { pkgPath = candidate; break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!pkgPath) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const allDeps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    if (allDeps['vitest'])  return 'vitest';
    if (allDeps['jest'])    return 'jest';
    if (allDeps['mocha'])   return 'mocha';
    if (allDeps['tap'])     return 'tap';
    if (allDeps['ava'])     return 'ava';
    // Check scripts.test field
    const testScript = (pkg.scripts && pkg.scripts.test) || '';
    if (/vitest/.test(testScript)) return 'vitest';
    if (/jest/.test(testScript))   return 'jest';
    if (/mocha/.test(testScript))  return 'mocha';
  } catch (_) {}
  return null;
}

// ─── buildDepGraph ────────────────────────────────────────────────────────────
// Returns { nodes: string[], edges: {from,to}[] } for JS/TS files in projectDir
function buildDepGraph(projectDir) {
  const nodes = [];
  const edges = [];
  const seen  = new Set();
  const SKIP  = new Set(['node_modules', '.git', 'dist', '.next', 'build', '.cache', 'coverage', 'out']);
  const JS_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
  const importRe = /(?:import\s+(?:.*?\s+from\s+)?|require\s*\()['"](\.{1,2}\/[^'"]+)['"]/g;

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch (_) { return; }
    for (const e of entries) {
      if (SKIP.has(e)) continue;
      const full = path.join(dir, e);
      let stat;
      try { stat = fs.statSync(full); } catch (_) { continue; }
      if (stat.isDirectory()) { walk(full); continue; }
      if (!JS_EXTS.has(path.extname(full))) continue;
      const rel = path.relative(projectDir, full);
      if (!seen.has(rel)) { seen.add(rel); nodes.push(rel); }
      let src = '';
      try { src = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }
      let m;
      importRe.lastIndex = 0;
      while ((m = importRe.exec(src)) !== null) {
        let dep = m[1];
        // resolve extension
        if (!path.extname(dep)) {
          for (const ext of ['.ts','.tsx','.js','.jsx']) {
            if (fs.existsSync(path.join(path.dirname(full), dep + ext))) { dep += ext; break; }
          }
        }
        const absD = path.resolve(path.dirname(full), dep);
        const relD = path.relative(projectDir, absD);
        if (!seen.has(relD)) { seen.add(relD); nodes.push(relD); }
        edges.push({ from: rel, to: relD });
      }
    }
  }
  walk(projectDir);
  return { nodes, edges };
}

// ─── projectKnowledge helpers ─────────────────────────────────────────────────
let _knowledgeCacheKey = '';
function loadProjectKnowledge() {
  try {
    const st = fs.statSync(PROJECT_KNOWLEDGE_FILE);
    const key = st.mtimeMs + ':' + st.size;
    if (key === _knowledgeCacheKey) return; // projectKnowledge already current
    projectKnowledge = JSON.parse(fs.readFileSync(PROJECT_KNOWLEDGE_FILE, 'utf8'));
    _knowledgeCacheKey = key;
  } catch (_) {
    projectKnowledge = {};
    _knowledgeCacheKey = '';
  }
}

function saveKnowledgeFact(projectKey, fact) {
  loadProjectKnowledge();
  if (!projectKnowledge[projectKey]) projectKnowledge[projectKey] = [];
  // avoid exact duplicates
  if (!projectKnowledge[projectKey].some(f => f.fact === fact)) {
    projectKnowledge[projectKey].push({ fact, addedAt: new Date().toISOString() });
    ensureProverbsDir();
    fs.writeFileSync(PROJECT_KNOWLEDGE_FILE, JSON.stringify(projectKnowledge, null, 2), 'utf8');
  }
  return projectKnowledge[projectKey].length;
}

function getKnowledgeFacts(projectKey) {
  loadProjectKnowledge();
  return (projectKnowledge[projectKey] || []).map(f => f.fact);
}

// ─── loadFinetuneState ────────────────────────────────────────────────────────
function loadFinetuneState() {
  try {
    return JSON.parse(fs.readFileSync(FINETUNE_STATE_FILE, 'utf8'));
  } catch (_) {
    return { pairs: 0, lastBake: null, model: null };
  }
}

function saveFinetuneState(state) {
  ensureProverbsDir();
  fs.writeFileSync(FINETUNE_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ─── Plugin system ────────────────────────────────────────────────────────────
function loadPlugins() {
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  loadedPlugins = [];
  try {
    const files = fs.readdirSync(PLUGINS_DIR).filter(function(f) { return f.endsWith('.js'); });
    for (const f of files) {
      try {
        const fullPath = path.join(PLUGINS_DIR, f);
        // Clear require cache to allow reload
        delete require.cache[require.resolve(fullPath)];
        const plugin = require(fullPath);
        // Plugin must export: { name, description, parameters, handler }
        if (plugin && plugin.name && plugin.handler && typeof plugin.handler === 'function') {
          loadedPlugins.push({
            name: plugin.name,
            def: {
              type: 'function',
              function: {
                name: plugin.name,
                description: plugin.description || 'Custom plugin: ' + plugin.name,
                parameters: plugin.parameters || { type: 'object', properties: {}, required: [] },
              }
            },
            handler: plugin.handler,
          });
          // plugin load silent
        }
      } catch(e) {
        console.log(colorize(C.red, '  Plugin error in ' + f + ': ' + e.message));
      }
    }
  } catch(_) {}
  return loadedPlugins.length;
}

function toolWriteFile(args) {
  if (!args || !args.path) return 'ERROR: path is required';
  const target  = resolvePath(args.path);
  const content = args.content != null ? args.content : '';

  // Capture old content before overwriting (for diff preview)
  let oldContent = '';
  try {
    if (fs.existsSync(target)) {
      oldContent = fs.readFileSync(target, 'utf8');
    }
  } catch (_) {
    oldContent = '';
  }

  // Backup before overwriting
  backupFile(target);

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  } catch (e) {
    return 'ERROR: ' + e.message;
  }

  // Show diff after successful write
  showDiff(target, oldContent, content);
  // Auto-test: background generate test after any source file write
  if (autoTestEnabled) { setTimeout(function(){ triggerAutoTest(target, content).catch(function(){}); }, 200); }

  let syntaxErr = null;
  try {
    syntaxErr = validateSyntax(target, content);
  } catch (e) {
    syntaxErr = null;
  }

  if (syntaxErr) {
    return (
      'File written: ' + target +
      '\nSYNTAX ERROR: ' + syntaxErr +
      '\nPlease fix the syntax error and rewrite the file.'
    );
  }

  let result = 'File written: ' + target;

  // TS / ESLint feedback
  const ext = path.extname(target).toLowerCase();
  if (/\.(ts|tsx|js|jsx)$/.test(ext)) {
    if (tsCheckEnabled) {
      const tsErrors = runTsCheck(path.dirname(target));
      if (tsErrors) result += '\nTS ERRORS:\n' + tsErrors;
    }
    if (eslintCheckEnabled) {
      const eslintWarnings = runEslintCheck(target);
      if (eslintWarnings) result += '\nESLINT WARNINGS:\n' + eslintWarnings;
    }
  }

  return result;
}

function toolEditFile(args) {
  if (!args || !args.path) return 'ERROR: path is required';
  const target = resolvePath(args.path);

  let original;
  try {
    original = fs.readFileSync(target, 'utf8');
  } catch (e) {
    return 'ERROR: Cannot read file: ' + e.message;
  }

  const oldText = args.old_text != null ? args.old_text : '';
  const newText = args.new_text != null ? args.new_text : '';

  if (!original.includes(oldText)) {
    const preview = original.slice(0, 120).replace(/\n/g, '\\n');
    return (
      'ERROR: old_text not found in ' + target +
      '\nFile preview (first 120 chars): ' + preview +
      '\nTip: read the file first to confirm the exact text to replace.'
    );
  }

  const updated = original.replace(oldText, newText);

  // Backup before overwriting
  backupFile(target);

  try {
    fs.writeFileSync(target, updated, 'utf8');
  } catch (e) {
    return 'ERROR: Cannot write file: ' + e.message;
  }

  // Show diff after successful write
  showDiff(target, original, updated);

  let syntaxErr = null;
  try {
    syntaxErr = validateSyntax(target, updated);
  } catch (e) {
    syntaxErr = null;
  }

  if (syntaxErr) {
    return (
      'File edited: ' + target +
      '\nSYNTAX ERROR: ' + syntaxErr +
      '\nPlease fix the syntax error and rewrite the file.'
    );
  }

  let result = 'File edited: ' + target;

  // TS / ESLint feedback
  const ext = path.extname(target).toLowerCase();
  if (/\.(ts|tsx|js|jsx)$/.test(ext)) {
    if (tsCheckEnabled) {
      const tsErrors = runTsCheck(path.dirname(target));
      if (tsErrors) result += '\nTS ERRORS:\n' + tsErrors;
    }
    if (eslintCheckEnabled) {
      const eslintWarnings = runEslintCheck(target);
      if (eslintWarnings) result += '\nESLINT WARNINGS:\n' + eslintWarnings;
    }
  }

  return result;
}

function toolListFiles(args) {
  const target = resolvePath(args.path || '');
  try {
    const entries = fs.readdirSync(target, { withFileTypes: true });
    const lines = entries.map((e) =>
      (e.isDirectory() ? 'd ' : 'f ') + e.name
    );
    return lines.join('\n') || '(empty directory)';
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

function _truncateOutput(str) {
  const HEAD_LINES = 50;
  const TAIL_LINES = 20;
  const MAX_CHARS  = 8000;
  if (str.length <= MAX_CHARS) return str;
  const lines = str.split('\n');
  if (lines.length <= HEAD_LINES + TAIL_LINES) return str.slice(0, MAX_CHARS);
  const head = lines.slice(0, HEAD_LINES).join('\n');
  const tail = lines.slice(-TAIL_LINES).join('\n');
  const omitted = lines.length - HEAD_LINES - TAIL_LINES;
  const summary = '\n... [' + omitted + ' lines omitted] ...\n';
  const combined = head + summary + tail;
  return combined.length > MAX_CHARS ? combined.slice(0, MAX_CHARS) : combined;
}

function _toolRunBashSync(command) {
  try {
    const output = execSync(command, {
      cwd: resolvePath(cwd),
      timeout: 120000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return _truncateOutput(output) || '(no output)';
  } catch (e) {
    const exitCode = e.status != null ? e.status : '?';
    const stderr   = (e.stderr || '').toString();
    const stdout   = (e.stdout || '').toString();
    const stderrLines = stderr.split('\n').filter(l => l.trim());
    const stderrSnippet = stderrLines.slice(0, 3).join('\n');
    let msg = 'Command failed: ' + command + '\nExit code: ' + exitCode;
    if (stderrSnippet) {
      msg += '\nStderr:\n' + stderrSnippet;
      if (stderrLines.length > 3) msg += '\n  ... (' + (stderrLines.length - 3) + ' more stderr lines)';
    }
    if (stdout.trim()) msg += '\nStdout:\n' + stdout.trim().slice(0, 500);
    return msg;
  }
}

function toolRunBash(args) {
  const command = (args && args.command) ? String(args.command) : '';
  if (!command.trim()) return 'ERROR: command is required.';

  // Sandbox: block destructive patterns when enabled
  if (sandboxEnabled) {
    var _lc = command.toLowerCase();
    var _blk = SANDBOX_BLOCKLIST.find(function(b){ return _lc.includes(b); });
    if (_blk) return 'SANDBOX BLOCKED: "' + _blk + '" is not allowed. Use /sandbox off to disable.';
  }
  const TIMEOUT_MS = 120000;
  const DIM_PREFIX = colorize(C.dim, '  │ ');

  // ── Background mode: command ends with " &" ──────────────────────────────
  const isBackground = /\s+&\s*$/.test(command);
  if (isBackground) {
    const cleanCmd = command.replace(/\s+&\s*$/, '');
    try {
      const child = spawn(cleanCmd, [], {
        shell: true,
        cwd:   resolvePath(cwd),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const bgEntry = { pid: child.pid, cmd: cleanCmd, startedAt: new Date().toISOString(), lines: [], exitCode: null };
      bgProcesses[child.pid] = bgEntry;
      child.stdout.on('data', (d) => { const ln = d.toString().split('\n').filter(l => l.length); bgEntry.lines.push(...ln); if (bgEntry.lines.length > 500) bgEntry.lines = bgEntry.lines.slice(-500); });
      child.stderr.on('data', (d) => { const ln = d.toString().split('\n').filter(l => l.length); bgEntry.lines.push(...ln); if (bgEntry.lines.length > 500) bgEntry.lines = bgEntry.lines.slice(-500); });
      child.on('exit', (code) => { bgEntry.exitCode = code; notify('Process exited', cleanCmd.slice(0, 60) + ' → exit ' + code); });
      return 'Background process started (PID ' + child.pid + '): ' + cleanCmd;
    } catch (e) {
      return 'ERROR starting background process: ' + e.message;
    }
  }

  // ── Foreground mode: stream output live ──────────────────────────────────
  return new Promise((resolve) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;

    let child;
    try {
      child = spawn(command, [], {
        shell:   true,
        cwd:     resolvePath(cwd),
        stdio:   ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve(_toolRunBashSync(command));
    }

    const killTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (_) {}
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdoutChunks.push(text);
      text.split('\n').forEach((line, i, arr) => {
        if (i < arr.length - 1 || line) {
          _uiWrite(DIM_PREFIX + line + '\n');
        }
      });
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrChunks.push(text);
      text.split('\n').forEach((line, i, arr) => {
        if (i < arr.length - 1 || line) {
          _uiWrite(colorize(C.yellow, '  │ ') + line + '\n');
        }
      });
    });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      resolve('ERROR spawning command: ' + err.message);
    });

    child.on('close', (code) => {
      clearTimeout(killTimer);
      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');

      if (timedOut) {
        const partial = _truncateOutput(stdout);
        resolve('Command timed out after ' + (TIMEOUT_MS / 1000) + 's.\n' + (partial ? 'Partial output:\n' + partial : ''));
        return;
      }

      if (code !== 0 && code !== null) {
        const stderrLines = stderr.split('\n').filter(l => l.trim());
        const stderrSnippet = stderrLines.slice(0, 3).join('\n');
        let msg = 'Command failed: ' + command + '\nExit code: ' + code;
        if (stderrSnippet) {
          msg += '\nStderr:\n' + stderrSnippet;
          if (stderrLines.length > 3) msg += '\n  ... (' + (stderrLines.length - 3) + ' more stderr lines)';
        }
        if (stdout.trim()) msg += '\nStdout:\n' + _truncateOutput(stdout.trim());
        resolve(msg);
        return;
      }

      resolve(_truncateOutput(stdout) || '(no output)');
    });
  });
}

// ── Feature 1: grep_files / find_files ────────────────────────────────────────
function toolGrepFiles(args) {
  const rootDir    = resolvePath(args.path || '');
  const rawPattern = args.pattern || '';
  const extensions = args.extensions
    ? new Set(args.extensions.split(',').map(e => e.trim().replace(/^\./, '').toLowerCase()).filter(Boolean))
    : null;

  let regex;
  try {
    regex = new RegExp(rawPattern);
  } catch (e) {
    return `ERROR: Invalid regex pattern — ${e.message}`;
  }

  const results  = [];
  let   truncated = 0;

  function walk(dir, depth) {
    if (depth > FIND_MAX_DEPTH) return;

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;

      if (extensions) {
        const ext = entry.name.includes('.')
          ? entry.name.split('.').pop().toLowerCase()
          : '';
        if (!extensions.has(ext)) continue;
      }

      let content;
      try { content = fs.readFileSync(fullPath, 'utf8'); }
      catch (_) { continue; }

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!regex.test(lines[i])) continue;
        if (results.length >= GREP_MAX_RESULTS) {
          truncated++;
        } else {
          results.push(`${fullPath}:${i + 1}: ${lines[i]}`);
        }
      }
    }
  }

  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    return `ERROR: Not a directory: ${rootDir}`;
  }

  walk(rootDir, 0);

  if (results.length === 0 && truncated === 0) {
    return `No matches found for /${rawPattern}/ in ${rootDir}`;
  }

  let output = results.join('\n');
  if (truncated > 0) {
    output += `\n... (${truncated} more match${truncated === 1 ? '' : 'es'} truncated — refine your pattern or path)`;
  }
  return output;
}

function toolFindFiles(args) {
  const rootDir    = resolvePath(args.path || '');
  const rawPattern = args.pattern || '*';

  const regexSrc = '^' + rawPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.') + '$';

  let nameRegex;
  try {
    nameRegex = new RegExp(regexSrc, 'i');
  } catch (e) {
    return `ERROR: Could not compile pattern — ${e.message}`;
  }

  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    return `ERROR: Not a directory: ${rootDir}`;
  }

  const results = [];

  function walk(dir, depth) {
    if (depth > FIND_MAX_DEPTH) return;

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
        continue;
      }

      if (entry.isFile() && nameRegex.test(entry.name)) {
        results.push(fullPath);
      }
    }
  }

  walk(rootDir, 0);

  if (results.length === 0) {
    return `No files matching "${rawPattern}" found in ${rootDir}`;
  }

  return results.join('\n');
}

// ── Find projects anywhere on this machine by name ────────────────────────────
// Lets the user switch repos by asking about an app they built ("switch to
// biblesim", "open my warsim project"). Searches Claude/Proverbs project history
// first, then falls back to Spotlight (mdfind) on macOS for folders not yet seen.
function toolFindProjects(args) {
  const query = String(args.query || args.name || '').trim().toLowerCase();
  const matches = [];
  const seen = new Set();

  // 1. Known projects from history (fast, already indexed).
  try {
    const known = (typeof discoverClaudeProjects === 'function') ? discoverClaudeProjects() : [];
    for (const p of known) {
      if (!query || p.name.toLowerCase().includes(query)) {
        if (!seen.has(p.path)) { seen.add(p.path); matches.push({ name: p.name, path: p.path, stack: p.stack || '', source: 'history' }); }
      }
    }
  } catch (_) {}

  // 2. Spotlight fallback for project folders not in history (macOS).
  if (query && process.platform === 'darwin') {
    try {
      const home = os.homedir();
      const raw = execSync(
        'mdfind -onlyin ' + JSON.stringify(home) +
        ' "kMDItemFSName == \'*' + query.replace(/[^\w.-]/g, '') + '*\'c && kMDItemContentType == \'public.folder\'" 2>/dev/null | head -40',
        { encoding: 'utf8', timeout: 8000 }
      ).trim();
      for (const dir of raw.split('\n').filter(Boolean)) {
        if (seen.has(dir)) continue;
        // Only surface real project dirs (have package.json, .git, .uproject, or .proverbs).
        const isProj = ['package.json', '.git', '.proverbs'].some(f => { try { return fs.existsSync(path.join(dir, f)); } catch (_) { return false; } })
          || (() => { try { return fs.readdirSync(dir).some(n => n.endsWith('.uproject') || n.endsWith('.xcodeproj')); } catch (_) { return false; } })();
        if (isProj) { seen.add(dir); matches.push({ name: path.basename(dir), path: dir, stack: '', source: 'spotlight' }); }
      }
    } catch (_) {}
  }

  if (!matches.length) {
    return query
      ? `No projects matching "${query}" found in your project history or on this machine.`
      : 'No known projects found.';
  }
  const lines = matches.slice(0, 25).map(m => `${m.name}  —  ${m.path}${m.stack ? '  [' + m.stack + ']' : ''}`);
  return 'Found ' + matches.length + ' project(s):\n' + lines.join('\n') +
    '\n\nTo switch, call switch_project with the exact path of the one the user means.';
}

// ── Switch the active project (changes the working directory) ─────────────────
function toolSwitchProject(args) {
  const target = String(args.path || '').trim();
  if (!target) return 'ERROR: switch_project requires a "path".';
  const resolved = target.startsWith('~') ? path.join(os.homedir(), target.slice(1)) : target;
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return `ERROR: Not a directory: ${resolved}`;
    }
  } catch (e) { return `ERROR: ${e.message}`; }

  try {
    process.chdir(resolved);
    cwd = process.cwd();
    // Refresh project-aware context for the new repo, mirroring /switch.
    try { detectedFrameworks  = (typeof detectFrameworks === 'function')  ? detectFrameworks(cwd)  : []; } catch (_) {}
    try { detectedConventions = (typeof detectConventions === 'function') ? detectConventions(cwd) : []; } catch (_) {}
    try { loadGitContext(cwd); } catch (_) {}
    try { loadProverbsProfile(cwd); } catch (_) {}
    // Invalidate stale per-repo indexes.
    _ragIndex = null; _embedIndex = null;
    return `Switched to ${path.basename(cwd)} (${cwd}).`;
  } catch (e) {
    return `ERROR: Could not switch to ${resolved}: ${e.message}`;
  }
}

// ── Self-diagnosis: let Proverbs read its own logs and current state ──────────
// Surfaces recent errors from the inference server log, backend status, and the
// Proverbs source path so the model can diagnose problems the user is hitting
// (hangs, 400s, crashes) and propose/apply fixes to its own code.
function toolDiagnoseSelf(args) {
  const out = [];
  // 1. Backend status
  try {
    // curl ships with Windows 10 1803+ and macOS/Linux; if absent this throws
    // and the caller's catch treats the backend as unknown, which is correct.
    const r = execSync('curl -s --max-time 3 http://127.0.0.1:11435/api/backend',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    out.push('## Backend status\n' + (r || '(no response — server may be down)'));
  } catch (_) { out.push('## Backend status\n(could not reach inference server on :11435)'); }

  // 2. Recent errors from the server log
  const logPath = '/tmp/proverbs-server.log';
  try {
    if (fs.existsSync(logPath)) {
      const raw = fs.readFileSync(logPath, 'utf8').split('\n');
      const errors = raw.filter(l => /error|failed|400|403|exception|traceback|crash|llama_decode|GGML_ASSERT/i.test(l)).slice(-20);
      const tail = raw.slice(-15);
      out.push('## Recent server errors (last 20 matching)\n' + (errors.length ? errors.join('\n') : '(none found)'));
      out.push('## Server log tail (last 15 lines)\n' + tail.join('\n'));
    } else {
      out.push('## Server log\n(no log at ' + logPath + ')');
    }
  } catch (e) { out.push('## Server log\nERROR reading log: ' + e.message); }

  // 3. Where Proverbs' own source lives (so the model can edit it to fix bugs)
  try {
    const src = (typeof PROVERBS_SRC_DIR !== 'undefined' && PROVERBS_SRC_DIR) ? PROVERBS_SRC_DIR : __dirname;
    out.push('## Proverbs source\nEntry: ' + path.join(src, 'cli.js') +
      '\nServer: ' + path.join(src, 'inference', 'server.py') + ' (Python) / ' + path.join(src, 'server', 'server.js') + ' (Node cascade)' +
      '\nAfter editing cli.js, run: node ' + path.join(src, 'build.js') + ' to rebuild dist.');
  } catch (_) {}

  out.push('## Next steps\nIf you found a concrete bug above, read the relevant source file, apply the fix, and (for cli.js) rebuild. Report what you changed.');
  return out.join('\n\n');
}

// ── Interactive clarifying questions (Claude-style AskUserQuestion) ───────────
// Lets Proverbs PAUSE mid-task and ask the user questions instead of guessing.
// Accepts either a single question or several, each optionally with numbered
// options. Reads answers from the live REPL readline (_rlRef). Returns the
// answers as text the model can act on. Never throws — falls back gracefully
// when there is no interactive TTY (server/headless), so it can't reintroduce
// the setRawMode crash class.
async function toolAskUser(args) {
  args = args || {};
  // Normalize: support {question, options} OR {questions:[{question,options,multiSelect}]}
  let questions = Array.isArray(args.questions) ? args.questions : null;
  if (!questions) {
    if (!args.question) return 'ERROR: ask_user requires a "question" (string) or "questions" (array).';
    questions = [{ question: args.question, options: args.options, multiSelect: !!args.multiSelect }];
  }
  questions = questions.filter(q => q && q.question);
  if (!questions.length) return 'ERROR: no valid questions provided.';

  // Non-interactive fallback: if there's no readline or stdin isn't a TTY, we
  // cannot ask. Tell the model to proceed with its best judgement instead of
  // hanging or crashing.
  const interactive = _rlRef && process.stdin && process.stdin.isTTY;
  if (!interactive) {
    return 'NOTE: No interactive terminal is available to ask the user right now. ' +
      'Proceed with your best, clearly-stated assumption and tell the user what you assumed so they can correct it.';
  }

  // Pause the live status spinner so the prompt is readable.
  if (typeof _servingSpinner !== 'undefined' && _servingSpinner) {
    try { _servingSpinner.stop(); } catch (_) {}
  }

  const answers = [];
  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const opts = Array.isArray(q.options) ? q.options.map(o => (typeof o === 'string' ? { label: o } : o)).filter(o => o && o.label) : [];

    console.log('');
    console.log(colorize(C.cyanBold, '  ❓ ' + q.question));
    if (q.header) console.log(colorize(C.dim, '     [' + q.header + ']'));
    opts.forEach((o, i) => {
      const desc = o.description ? colorize(C.dim, ' — ' + o.description) : '';
      console.log(colorize(C.cyan, '     ' + (i + 1) + '. ') + (o.label || '') + desc);
    });
    const hint = opts.length
      ? (q.multiSelect
          ? '  Pick number(s) (comma-separated), or type your own answer: '
          : '  Pick a number, or type your own answer: ')
      : '  Your answer: ';

    const raw = await new Promise((resolve) => {
      try {
        _rlRef.resume();
        _rlRef.question(colorize(C.cyanBold, hint), (ans) => {
          _rlRef.pause();
          resolve((ans || '').trim());
        });
      } catch (e) { resolve(''); }
    });

    // Resolve numeric option picks to their labels.
    let resolved = raw;
    if (opts.length && raw) {
      const picks = raw.split(',').map(s => s.trim()).filter(Boolean);
      const labels = [];
      let allNumeric = true;
      for (const p of picks) {
        const n = parseInt(p, 10);
        if (!isNaN(n) && n >= 1 && n <= opts.length) labels.push(opts[n - 1].label);
        else { allNumeric = false; break; }
      }
      if (allNumeric && labels.length) resolved = labels.join(', ');
    }
    if (!resolved) resolved = '(no answer — use your best judgement)';
    answers.push({ question: q.question, answer: resolved });
  }

  // Return as compact, model-readable text.
  return 'USER ANSWERS:\n' + answers.map(a => '• ' + a.question + '\n  → ' + a.answer).join('\n');
}

// ── Feature 2: Git tools ──────────────────────────────────────────────────────
// ─── isomorphic-git fallback (pure-JS git when system git not installed) ────────
var _ig = null;
function _getIg() { if (!_ig) { try { _ig = require('isomorphic-git'); } catch(e) {} } return _ig; }
async function _igStatus(dir) {
  var ig = _getIg(); if (!ig) return '(no git)';
  try {
    var mx = await ig.statusMatrix({ fs: fs, dir: dir });
    var lines = [];
    mx.forEach(function(row) { var f=row[0],h=row[1],w=row[2]; if(h===1&&w===1)return; lines.push((h===0?'?? ':w===0?' D ':' M ')+f); });
    return lines.join('\n') || '(working tree clean)';
  } catch(e) { return '(no git repository)'; }
}
async function _igLog(dir, n) {
  var ig = _getIg(); if (!ig) return '(no git)';
  try { var cs = await ig.log({ fs: fs, dir: dir, depth: n||10 }); return cs.map(function(c){ return c.oid.slice(0,7)+' '+c.commit.message.split('\n')[0]; }).join('\n'); } catch(e) { return '(no git)'; }
}
async function _igBranch(dir) {
  var ig = _getIg(); if (!ig) return 'HEAD';
  try { return (await ig.currentBranch({ fs: fs, dir: dir })) || 'HEAD'; } catch(e) { return 'HEAD'; }
}

function toolGitStatus() {
  try {
    const out = execSync('git status --short', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return out.trim() || '(nothing to commit, working tree clean)';
  } catch (e) {
    if (e.message.includes('not a git repository')) return 'ERROR: Not a git repository.';
    return `ERROR: ${e.stderr || e.message}`;
  }
}

function toolGitDiff(args) {
  const file = args.file ? ` -- ${args.file}` : '';
  try {
    const out = execSync(`git diff${file}`, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return out.trim() || '(no unstaged changes)';
  } catch (e) {
    if (e.message.includes('not a git repository')) return 'ERROR: Not a git repository.';
    return `ERROR: ${e.stderr || e.message}`;
  }
}

function toolGitLog(args) {
  const n = (args.n && Number.isInteger(Number(args.n)) && Number(args.n) > 0) ? Number(args.n) : 10;
  try {
    const out = execSync(`git log --oneline -${n}`, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return out.trim() || '(no commits yet)';
  } catch (e) {
    if (e.message.includes('not a git repository')) return 'ERROR: Not a git repository.';
    if (e.message.includes('does not have any commits')) return '(no commits yet)';
    return `ERROR: ${e.stderr || e.message}`;
  }
}

function toolGitCommit(args) {
  if (!args.message || !args.message.trim()) return 'ERROR: A commit message is required.';
  try {
    execSync('git add -A', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const safe = args.message.replace(/'/g, "'\\''");
    const out = execSync(`git commit -m '${safe}'`, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return out.trim();
  } catch (e) {
    if (e.message.includes('not a git repository')) return 'ERROR: Not a git repository.';
    if (e.stderr && e.stderr.includes('nothing to commit')) return 'Nothing to commit — working tree is clean.';
    return `ERROR: ${e.stderr || e.message}`;
  }
}

// ─── Search cache ─────────────────────────────────────────────────────────────
function _loadSearchCache() { try { return JSON.parse(fs.readFileSync(SEARCH_CACHE_FILE,'utf8')); } catch(_) { return {}; } }
function _saveSearchCache(c) { try { fs.writeFileSync(SEARCH_CACHE_FILE, JSON.stringify(c), 'utf8'); } catch(_) {} }
function _getCachedSearch(q, n) {
  var c = _loadSearchCache(), key = q.toLowerCase().trim() + ':' + n, e = c[key];
  return (e && (Date.now() - e.ts) < SEARCH_CACHE_TTL) ? e.result : null;
}
function _setCachedSearch(q, n, result) {
  var c = _loadSearchCache(), key = q.toLowerCase().trim() + ':' + n;
  c[key] = { result: result, ts: Date.now() };
  var keys = Object.keys(c);
  if (keys.length > 500) keys.sort(function(a,b){return c[a].ts - c[b].ts;}).slice(0, keys.length - 500).forEach(function(k){delete c[k];});
  _saveSearchCache(c);
}

// ── Feature 3: web_search — HTML scraping (no API key required) ───────────────
function _htmlEnt(s) { return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' '); }
function _stripTags(s) { return s.replace(/<[^>]+>/g,'').trim(); }
function _fmtResults(query, results) {
  if (!results.length) return `No results found for: ${query}`;
  return `Search results for "${query}":\n\n` + results.map((r,i) => `[${i+1}] ${r.title}\n    ${r.snippet}\n    URL: ${r.url}`).join('\n\n');
}
function _httpsGetUA(url, ms) {
  return new Promise((resolve, reject) => {
    const p = new URL(url);
    const req = https.request({ hostname: p.hostname, port: p.port || 443, path: p.pathname + p.search, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept-Language': 'en-US,en;q=0.9', 'Accept': 'text/html,*/*' },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(ms || 12000, () => { req.destroy(); reject(new Error('search timeout')); });
    req.end();
  });
}
async function _searchDDGHtml(query, n) {
  const r = await _httpsGetUA('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query) + '&kl=us-en');
  if (r.status !== 200) throw new Error('DDG HTML ' + r.status);
  const results = [], links = [], snips = [];
  let m;
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|span|div)>/g;
  while ((m = linkRe.exec(r.body)) !== null) links.push({ url: _htmlEnt(m[1]), title: _htmlEnt(_stripTags(m[2])) });
  while ((m = snipRe.exec(r.body)) !== null) snips.push(_htmlEnt(_stripTags(m[1])));
  for (let i = 0; i < Math.min(links.length, n); i++) {
    if (links[i].title && links[i].url && !links[i].url.startsWith('//')) results.push({ title: links[i].title, snippet: snips[i] || '', url: links[i].url });
  }
  if (!results.length) throw new Error('no DDG results parsed');
  return _fmtResults(query, results);
}
async function _searchBingHtml(query, n) {
  const r = await _httpsGetUA('https://www.bing.com/search?q=' + encodeURIComponent(query) + '&count=' + n);
  if (r.status !== 200) throw new Error('Bing HTML ' + r.status);
  const results = [];
  const algoRe  = /<li[^>]+class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  const titleRe = /<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
  const snipRe  = /<p[^>]*>([\s\S]*?)<\/p>/;
  let m;
  while ((m = algoRe.exec(r.body)) !== null && results.length < n) {
    const b = m[1], tm = titleRe.exec(b), sm = snipRe.exec(b);
    if (tm) results.push({ title: _htmlEnt(_stripTags(tm[2])), url: _htmlEnt(tm[1]), snippet: sm ? _htmlEnt(_stripTags(sm[1])) : '' });
  }
  if (!results.length) throw new Error('no Bing results parsed');
  return _fmtResults(query, results);
}
async function _searchDDGInstant(query, n) {
  const r = await httpsGet(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
  if (r.status !== 200) throw new Error('DDG instant ' + r.status);
  const d = JSON.parse(r.body), results = [];
  if (d.AbstractText) results.push({ title: d.Heading || query, snippet: d.AbstractText, url: d.AbstractURL || '' });
  for (const t of (d.RelatedTopics || [])) {
    if (results.length >= n) break;
    if (t.Text && t.FirstURL) results.push({ title: t.Text.split(' - ')[0], snippet: t.Text, url: t.FirstURL });
  }
  if (!results.length) throw new Error('no instant results');
  return _fmtResults(query, results);
}
async function toolWebSearch(args) {
  const query = (args.query || '').trim();
  const n     = Math.max(1, Math.min(10, parseInt(args.num_results, 10) || 5));
  if (!query) return 'ERROR: query is required.';
  var _sc = _getCachedSearch(query, n);
  if (_sc) return _sc;
  try { var _r1 = await _searchDDGHtml(query, n); if (_r1) { _setCachedSearch(query, n, _r1); return _r1; } } catch (_) {}
  try { return await _searchBingHtml(query, n); }   catch (_) {}
  try { var _ri = await _searchDDGInstant(query, n); if (_ri) { _setCachedSearch(query, n, _ri); return _ri; } } catch (e) {
    return `ERROR: All search backends failed: ${e.message}`;
  }
}

// ── Feature 4: codebase index ─────────────────────────────────────────────────
const INDEX_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'build', '.cache', 'coverage', '__pycache__', '.venv', 'venv']);
const INDEX_MAX_LINES = 200;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function buildIndexTree(dir, prefix, lines) {
  if (lines.length >= INDEX_MAX_LINES) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  const dirs  = entries.filter(e => e.isDirectory() && !INDEX_SKIP_DIRS.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter(e => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));

  for (const d of dirs) {
    if (lines.length >= INDEX_MAX_LINES) break;
    lines.push(`${prefix}${d.name}/`);
    buildIndexTree(path.join(dir, d.name), prefix + '  ', lines);
  }
  for (const f of files) {
    if (lines.length >= INDEX_MAX_LINES) break;
    let size = '';
    try { size = ` (${formatBytes(fs.statSync(path.join(dir, f.name)).size)})`; } catch (_) {}
    lines.push(`${prefix}${f.name}${size}`);
  }
}

function runIndex(targetCwd, silent) {
  const lines = [];
  buildIndexTree(targetCwd, '', lines);
  if (lines.length >= INDEX_MAX_LINES) lines.push('... (truncated at 200 lines)');
  const tree = lines.join('\n');
  const fileCount = lines.filter(l => !l.trimEnd().endsWith('/')).length;
  const data = { path: targetCwd, tree, fileCount, indexedAt: new Date().toISOString() };
  try {
    ensureProverbsDir();
    fs.writeFileSync(INDEX_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
  if (!silent) {
    console.log(colorize(C.green, `\nIndexed ${fileCount} files in ${targetCwd}\n`));
  }
  return data;
}

let _indexCache = { key: '', value: null };
function loadIndex() {
  try {
    const st = fs.statSync(INDEX_FILE);
    const key = st.mtimeMs + ':' + st.size;
    if (_indexCache.key === key) return _indexCache.value;
    const value = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    _indexCache = { key, value };
    return value;
  } catch (_) {
    return null;
  }
}

function toolGetProjectIndex() {
  const idx = loadIndex();
  if (!idx) return 'No index found. Run /index to scan the project.';
  return `Project: ${idx.path}\nIndexed: ${idx.indexedAt}\nFiles: ${idx.fileCount}\n\n${idx.tree}`;
}

// ── Feature 5: conversation-memory ───────────────────────────────────────────
function ensureMemoriesDir() {
  fs.mkdirSync(MEMORIES_DIR, { recursive: true });
}

function memoryFilePath(name) {
  const safe = name.replace(/[^a-zA-Z0-9_\-]/g, '_');
  return path.join(MEMORIES_DIR, `${safe}.json`);
}

function listMemories() {
  ensureMemoriesDir();
  try {
    return fs.readdirSync(MEMORIES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const mem = JSON.parse(fs.readFileSync(path.join(MEMORIES_DIR, f), 'utf8'));
          return mem;
        } catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  } catch (_) { return []; }
}

function loadMemory(name) {
  const exactPath = memoryFilePath(name);
  if (fs.existsSync(exactPath)) {
    try { return JSON.parse(fs.readFileSync(exactPath, 'utf8')); } catch (_) {}
  }
  const all = listMemories();
  return all.find(m => m.name && m.name.toLowerCase().includes(name.toLowerCase())) || null;
}

function deleteMemory(name) {
  const exactPath = memoryFilePath(name);
  if (fs.existsSync(exactPath)) {
    fs.unlinkSync(exactPath);
    return true;
  }
  const mem = loadMemory(name);
  if (mem && mem.name) {
    const p = memoryFilePath(mem.name);
    if (fs.existsSync(p)) { fs.unlinkSync(p); return true; }
  }
  return false;
}

async function summarizeConversation(history) {
  const summarizeMessages = [
    {
      role: 'system',
      content: 'You are a helpful assistant. Summarize the following conversation in 3-5 concise sentences for future reference. Focus on what was built, decided, or resolved.',
    },
    {
      role: 'user',
      content: 'Here is the conversation to summarize:\n\n' +
        history
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => `${m.role.toUpperCase()}: ${m.content}`)
          .join('\n\n'),
    },
  ];

  const response = await httpPost(`${OLLAMA_BASE}/api/chat`, {
    model,
    messages: summarizeMessages,
    stream: false,
  });

  return (response.message && response.message.content) || '(no summary generated)';
}

async function handleMemoryCmd(sub, args, history) {
  if (sub === 'list') {
    const mems = listMemories();
    if (mems.length === 0) {
      console.log(colorize(C.dim, '\n(no memories saved yet — use /memory save [name])\n'));
      return { historyUpdate: null };
    }
    console.log(colorize(C.cyan, `\nSaved Memories (${mems.length}):`));
    mems.forEach(m => {
      const date = m.savedAt ? m.savedAt.slice(0, 10) : '?';
      const proj = m.project ? ` [${m.project}]` : '';
      const tags = m.tags && m.tags.length ? ` (${m.tags.join(', ')})` : '';
      console.log(`  ${colorize(C.bold, (m.name || '?').padEnd(28))} ${colorize(C.dim, date + proj + tags)}`);
    });
    console.log();
    return { historyUpdate: null };
  }

  if (sub === 'save') {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = args.trim() || `memory-${ts}`;

    if (history.length === 0) {
      console.log(colorize(C.yellow, '\n(nothing to save — conversation is empty)\n'));
      return { historyUpdate: null };
    }

    const spinner = new Spinner('Summarizing conversation...');
    spinner.start();
    let summary;
    try {
      summary = await summarizeConversation(history);
    } finally {
      spinner.stop();
    }

    const mem = {
      name,
      summary,
      project: path.basename(cwd),
      savedAt: new Date().toISOString(),
      tags: [],
    };

    ensureMemoriesDir();
    fs.writeFileSync(memoryFilePath(name), JSON.stringify(mem, null, 2), 'utf8');
    console.log(colorize(C.green, `\n✔  Memory saved: "${name}"\n`));
    console.log(colorize(C.dim, `   ${summary.slice(0, 120)}${summary.length > 120 ? '...' : ''}\n`));
    return { historyUpdate: null };
  }

  if (sub === 'load') {
    const name = args.trim();
    if (!name) {
      console.log(colorize(C.red, '\n✗  Usage: /memory load <name>\n'));
      return { historyUpdate: null };
    }
    const mem = loadMemory(name);
    if (!mem) {
      console.log(colorize(C.red, `\n✗  Memory "${name}" not found. Use /memory list to see all.\n`));
      return { historyUpdate: null };
    }
    const injection = `[Recalled memory: "${mem.name}" saved ${mem.savedAt ? mem.savedAt.slice(0, 10) : '?'}]\n${mem.summary}`;
    console.log(colorize(C.green, `\n✔  Memory loaded: "${mem.name}"\n`));
    console.log(colorize(C.dim, `   ${mem.summary.slice(0, 120)}${mem.summary.length > 120 ? '...' : ''}\n`));
    return { historyUpdate: { role: 'system', content: injection } };
  }

  if (sub === 'delete') {
    const name = args.trim();
    if (!name) {
      console.log(colorize(C.red, '\n✗  Usage: /memory delete <name>\n'));
      return { historyUpdate: null };
    }
    if (deleteMemory(name)) {
      console.log(colorize(C.green, `\n✔  Memory "${name}" deleted.\n`));
    } else {
      console.log(colorize(C.red, `\n✗  Memory "${name}" not found.\n`));
    }
    return { historyUpdate: null };
  }

  console.log(colorize(C.cyan, '\nMemory commands:'));
  console.log('  /memory save [name]   — Summarize and save current conversation');
  console.log('  /memory list          — List all saved memories');
  console.log('  /memory load <name>   — Inject a memory into current conversation');
  console.log('  /memory delete <name> — Delete a saved memory\n');
  return { historyUpdate: null };
}

async function autoSaveMemoryOnExit(history) {
  if (history.length <= 6) return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `auto-${ts}`;
  try {
    const summary = await summarizeConversation(history);
    const mem = {
      name,
      summary,
      project: path.basename(cwd),
      savedAt: new Date().toISOString(),
      tags: ['auto'],
    };
    ensureMemoriesDir();
    fs.writeFileSync(memoryFilePath(name), JSON.stringify(mem, null, 2), 'utf8');
    console.log(colorize(C.dim, `\n(conversation auto-saved as memory "${name}")\n`));
  } catch (_) {}
}

// ── Feature 6: Web UI ─────────────────────────────────────────────────────────
function startWebUI(port) {
  if (_uiServer) {
    console.log(colorize(C.yellow, `\n⚠  Web UI already running on port ${_uiServer.address().port}\n`));
    return;
  }

  let express;
  try {
    express = require('express');
  } catch (_) {
    console.log(colorize(C.red, '\n✗  Express not installed. Run: npm install express\n'));
    return;
  }

  const app = express();
  app.use(express.json());

  const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Proverbs — Chat</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,monospace;display:flex;flex-direction:column;height:100vh;overflow:hidden}
header{background:#161b22;border-bottom:1px solid #21262d;padding:14px 20px;display:flex;align-items:center;gap:12px;flex-shrink:0}
header h1{font-size:1.1rem;color:#00bcd4;font-weight:700;letter-spacing:.5px}
header span{font-size:.75rem;color:#6e7681;background:#21262d;padding:2px 8px;border-radius:12px}
#messages{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth}
.bubble{max-width:72%;padding:10px 14px;border-radius:12px;line-height:1.55;font-size:.9rem;word-break:break-word;white-space:pre-wrap}
.user-row{display:flex;justify-content:flex-end}
.ai-row{display:flex;justify-content:flex-start}
.user-row .bubble{background:#00bcd4;color:#0d1117;border-bottom-right-radius:3px}
.ai-row .bubble{background:#161b22;color:#e6edf3;border:1px solid #21262d;border-bottom-left-radius:3px}
.thinking{color:#6e7681;font-style:italic;font-size:.85rem;padding:6px 14px;animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.4}50%{opacity:1}}
footer{background:#161b22;border-top:1px solid #21262d;padding:14px 20px;display:flex;gap:10px;flex-shrink:0}
#input{flex:1;background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:10px 14px;color:#e6edf3;font-size:.95rem;outline:none;resize:none;height:42px;overflow:hidden;transition:border-color .2s}
#input:focus{border-color:#00bcd4}
#send{background:#00bcd4;color:#0d1117;border:none;border-radius:8px;padding:10px 20px;font-weight:700;font-size:.9rem;cursor:pointer;transition:opacity .2s;flex-shrink:0}
#send:hover{opacity:.85}
#send:disabled{opacity:.4;cursor:not-allowed}
#clear-btn{background:transparent;color:#6e7681;border:1px solid #21262d;border-radius:8px;padding:10px 14px;font-size:.85rem;cursor:pointer;transition:color .2s,border-color .2s;flex-shrink:0}
#clear-btn:hover{color:#e6edf3;border-color:#6e7681}
.ts{font-size:.65rem;color:#6e7681;margin-top:4px;padding:0 4px}
.user-row .ts{text-align:right}
</style>
</head>
<body>
<header>
  <h1>&#9679; Proverbs</h1>
  <span id="model-badge">loading...</span>
</header>
<div id="messages"><div class="ai-row"><div class="bubble">Hello! I am Proverbs, your local AI coding assistant. How can I help you today?</div></div></div>
<footer>
  <button id="clear-btn" title="Clear conversation">Clear</button>
  <textarea id="input" placeholder="Ask Proverbs anything..." rows="1"></textarea>
  <button id="send">Send</button>
</footer>
<script>
const msgs = document.getElementById('messages');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const clearBtn = document.getElementById('clear-btn');
const modelBadge = document.getElementById('model-badge');
let history = [];

fetch('/info').then(r=>r.json()).then(d=>{ modelBadge.textContent = d.model; }).catch(()=>{ modelBadge.textContent='unknown'; });

function ts() {
  return new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}

function addBubble(role, text) {
  const row = document.createElement('div');
  row.className = role === 'user' ? 'user-row' : 'ai-row';
  const bub = document.createElement('div');
  bub.className = 'bubble';
  bub.textContent = text;
  const time = document.createElement('div');
  time.className = 'ts';
  time.textContent = ts();
  const wrap = document.createElement('div');
  wrap.appendChild(bub);
  wrap.appendChild(time);
  row.appendChild(wrap);
  msgs.appendChild(row);
  msgs.scrollTop = msgs.scrollHeight;
  return row;
}

function addThinking() {
  const row = document.createElement('div');
  row.className = 'ai-row';
  const bub = document.createElement('div');
  bub.className = 'bubble thinking';
  bub.textContent = 'Thinking...';
  row.appendChild(bub);
  msgs.appendChild(row);
  msgs.scrollTop = msgs.scrollHeight;
  return row;
}

async function send() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = '42px';
  sendBtn.disabled = true;

  addBubble('user', text);
  const thinkEl = addThinking();

  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ message: text, history })
    });
    const data = await res.json();
    thinkEl.remove();
    if (data.error) {
      addBubble('ai', 'Error: ' + data.error);
    } else {
      history.push({ role: 'user', content: text });
      history.push({ role: 'assistant', content: data.reply });
      addBubble('ai', data.reply);
    }
  } catch (e) {
    thinkEl.remove();
    addBubble('ai', 'Network error: ' + e.message);
  }
  sendBtn.disabled = false;
  input.focus();
}

sendBtn.addEventListener('click', send);

input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

input.addEventListener('input', () => {
  input.style.height = '42px';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
});

clearBtn.addEventListener('click', async () => {
  await fetch('/clear', { method: 'POST' });
  history = [];
  msgs.innerHTML = '<div class="ai-row"><div class="bubble">Conversation cleared. How can I help you?</div></div>';
});
</script>
</body>
</html>`;

  app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(HTML);
  });

  app.get('/info', (_req, res) => {
    res.json({ model });
  });

  app.post('/chat', async (req, res) => {
    const { message, history: clientHistory } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });

    _uiHistory = Array.isArray(clientHistory) ? clientHistory : _uiHistory;

    const messages = [
      { role: 'system', content: buildSystemPrompt() },
      ..._uiHistory,
      { role: 'user', content: message },
    ];

    try {
      const reply = await agentLoop(messages);
      _uiHistory.push({ role: 'user', content: message });
      _uiHistory.push({ role: 'assistant', content: reply });
      logExchange(messages[0].content, message, reply);
      const _verse = CLOSING_VERSES[Math.floor(Math.random() * CLOSING_VERSES.length)];
      res.json({ reply: reply + '\n\n> ' + _verse });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/clear', (_req, res) => {
    _uiHistory = [];
    res.json({ ok: true });
  });

  _uiServer = app.listen(port, '127.0.0.1', () => {
    const actualPort = _uiServer.address().port;
    console.log(colorize(C.greenBold, `\n✔  Web UI running at `) + colorize(C.cyanBold, `http://localhost:${actualPort}`) + '\n');
  });

  _uiServer.on('error', (err) => {
    console.log(colorize(C.red, `\n✗  Web UI failed to start: ${err.message}\n`));
    _uiServer = null;
  });
}

// ── Proverbs Studio ───────────────────────────────────────────────────────────
const STUDIO_SCENARIOS = [
  // ── NEW PROJECT ──────────────────────────────────────────────────────────────
  { id:'next-saas', category:'new-project', icon:'🚀', title:'Next.js SaaS Starter', description:'Full-stack SaaS with auth, subscriptions, and database — production-ready from day one.', tags:['Next.js','Prisma','Stripe','NextAuth'], steps:['Scaffold Next.js 15 App Router project with TypeScript + Tailwind','Create Prisma schema: User, Account, Session, Subscription, Plan','Set up NextAuth with email magic link + Google OAuth','Add Stripe Checkout + webhook handler for subscription lifecycle','Build dashboard layout, pricing page, and protected routes'], fields:[{id:'name',label:'App Name',type:'text',placeholder:'my-saas-app'},{id:'desc',label:'What it does',type:'text',placeholder:'A platform that helps...'},{id:'tiers',label:'Pricing Tiers',type:'select',options:['Free + Pro','Free + Pro + Enterprise','Single paid tier']}], prompt:'Build a production-ready Next.js 15 SaaS called "{name}". What it does: {desc}. Pricing: {tiers}. Stack: App Router, TypeScript, Prisma + PostgreSQL, NextAuth (email + Google), Stripe subscriptions ({tiers}), Tailwind CSS. Create: full project structure, Prisma schema with User/Subscription/Plan models, NextAuth config, Stripe checkout session + webhook handler + customer portal, dashboard layout, pricing page, .env.example. Follow .proverbs conventions if present.' },
  { id:'react-vite', category:'new-project', icon:'⚡', title:'React + Vite SPA', description:'Modern single-page app with routing, state management, and component library.', tags:['React','Vite','Zustand','Tailwind'], steps:['Scaffold Vite + React + TypeScript project','Set up React Router with typed routes','Add Zustand store with persist middleware','Configure Tailwind + shadcn/ui component library','Create base layout, 404, and loading states'], fields:[{id:'name',label:'App Name',type:'text',placeholder:'my-app'},{id:'desc',label:'What it does',type:'text',placeholder:'A tool that...'},{id:'state',label:'State Management',type:'select',options:['Zustand','React Context','Jotai']}], prompt:'Build a React + Vite SPA called "{name}". What it does: {desc}. Stack: React 18, TypeScript, Vite, React Router v6, {state} for state, Tailwind CSS, shadcn/ui. Create: project structure, router setup with typed routes, {state} store, base layout component, responsive nav, loading/error boundaries, .env.example.' },
  { id:'electron-app', category:'new-project', icon:'🖥️', title:'Electron Desktop App', description:'Cross-platform desktop app with React UI, IPC bridge, and auto-update support.', tags:['Electron','React','IPC','electron-builder'], steps:['Set up Electron main process + preload script','Create React renderer with Vite','Wire bidirectional IPC via contextBridge','Configure electron-builder for mac/win/linux','Add auto-updater and app menu'], fields:[{id:'name',label:'App Name',type:'text',placeholder:'my-desktop-app'},{id:'desc',label:'What it does',type:'text',placeholder:'A desktop tool that...'},{id:'platform',label:'Target Platform',type:'select',options:['macOS only','Windows only','Cross-platform (mac+win+linux)']}], prompt:'Build an Electron desktop app called "{name}". Purpose: {desc}. Target: {platform}. Stack: Electron, React + Vite renderer, TypeScript, Tailwind. Create: main.js (BrowserWindow, menu, auto-updater), preload.js (contextBridge), React renderer, IPC handlers for file system + native features, electron-builder config for {platform}. Follow security best practices: contextIsolation:true, nodeIntegration:false.' },
  { id:'capacitor-mobile', category:'new-project', icon:'📱', title:'Capacitor Mobile App', description:'Wrap an existing web app for iOS and Android with native plugin access.', tags:['Capacitor','iOS','Android','Native'], steps:['Install Capacitor and initialize config','Configure capacitor.config.ts with bundle ID + app name','Set up native camera, push notifications, filesystem plugins','Configure Info.plist and Android permissions','Build and sync to native projects'], fields:[{id:'name',label:'App Name',type:'text',placeholder:'My App'},{id:'bundleId',label:'Bundle ID',type:'text',placeholder:'com.company.appname'},{id:'platform',label:'Platform',type:'select',options:['iOS only','Android only','Both iOS + Android']}], prompt:'Set up Capacitor for {platform} on this web app. App name: "{name}", Bundle ID: {bundleId}. Tasks: install @capacitor/core + @capacitor/cli, create capacitor.config.ts, add @capacitor/camera + @capacitor/filesystem + @capacitor/push-notifications + @capacitor/status-bar, update index.html with mobile meta tags, configure Info.plist permissions (iOS) and AndroidManifest (Android), create npm scripts for build+sync+open. Show exact commands to run after setup.' },
  { id:'express-api', category:'new-project', icon:'🔌', title:'Express REST API', description:'Node.js REST API with structured routes, middleware, validation, and Prisma ORM.', tags:['Express','Prisma','JWT','Node.js'], steps:['Scaffold project with TypeScript + Express','Set up Prisma with User model and migrations','Add JWT auth middleware + refresh token flow','Create CRUD route structure with validation (Zod)','Add rate limiting, CORS, helmet, error handler'], fields:[{id:'name',label:'API Name',type:'text',placeholder:'my-api'},{id:'desc',label:'What it manages',type:'text',placeholder:'Users, products, orders...'},{id:'auth',label:'Authentication',type:'select',options:['JWT (access + refresh)','API key','No auth']}], prompt:'Build an Express REST API called "{name}". Manages: {desc}. Auth: {auth}. Stack: Node.js, TypeScript, Express, Prisma + PostgreSQL, Zod validation. Create: project structure (routes/, middleware/, lib/), Prisma schema for {desc}, {auth} implementation, CRUD routes with Zod input validation, rate limiting (express-rate-limit), CORS, helmet security headers, global error handler, .env.example. Include example HTTP client requests for each endpoint.' },

  // ── ADD FEATURE ──────────────────────────────────────────────────────────────
  { id:'stripe-subs', category:'add-feature', icon:'💳', title:'Stripe Subscriptions', description:'Add subscription billing with Checkout, webhook lifecycle, and customer portal.', tags:['Stripe','Webhooks','Billing'], steps:['Install Stripe SDK and create products/prices in dashboard','Build checkout session endpoint with success/cancel URLs','Create webhook handler for subscription lifecycle events','Add subscription status to user model + session','Build customer portal redirect endpoint'], fields:[{id:'tiers',label:'Pricing Tiers',type:'text',placeholder:'Basic $9/mo, Pro $29/mo'},{id:'trial',label:'Free Trial Days',type:'text',placeholder:'14'}], prompt:'Add Stripe subscription billing to this project. Tiers: {tiers}. Trial: {trial} days. Tasks: create app/api/stripe/checkout/route.ts (POST → stripe.checkout.sessions.create with subscription mode), app/api/stripe/webhook/route.ts (handle customer.subscription.created/updated/deleted, checkout.session.completed), app/api/stripe/portal/route.ts (customer portal redirect), update Prisma User model with stripeCustomerId + subscriptionId + subscriptionStatus + subscriptionTier, add subscription check middleware for protected features. Use stripe.webhooks.constructEvent for signature verification.' },
  { id:'stripe-connect', category:'add-feature', icon:'🔗', title:'Stripe Connect', description:'Platform payments where providers get paid — marketplace or service platform model.', tags:['Stripe Connect','Marketplace','Transfers'], steps:['Create Connect account onboarding flow','Build account link endpoint for dashboard access','Add transfer_data or application_fee to payment intents','Handle account.updated and payout events','Show connected account status in provider dashboard'], fields:[{id:'model',label:'Connect Model',type:'select',options:['Express (recommended)','Standard','Custom']},{id:'feeType',label:'Platform Fee',type:'select',options:['Percentage of transaction','Flat fee per transaction','No platform fee']}], prompt:'Add Stripe Connect ({model} accounts) to this project for marketplace payments. Platform fee: {feeType}. Tasks: POST /api/connect/onboard → stripe.accounts.create + stripe.accountLinks.create for onboarding, POST /api/connect/dashboard → stripe.accountLinks.create for existing accounts, update PaymentIntent creation to include application_fee_amount + transfer_data.destination, add account_id to provider model in Prisma, webhook handlers for account.updated + payout.paid + payout.failed. Show complete flow from provider signup to first payout.' },
  { id:'nextauth', category:'add-feature', icon:'🔐', title:'NextAuth Authentication', description:'Add auth with your choice of providers, protected routes, and typed session.', tags:['NextAuth','OAuth','Sessions'], steps:['Install next-auth and configure auth options','Add chosen OAuth providers + email magic link','Extend session type with user id and role','Protect routes with middleware.ts auth check','Add sign-in/sign-out UI components'], fields:[{id:'providers',label:'Providers',type:'select',options:['Email only','Email + Google','Email + Google + GitHub','All major providers']},{id:'role',label:'Add User Roles?',type:'select',options:['Yes — Admin/User','Yes — custom roles','No roles needed']}], prompt:'Add NextAuth.js authentication to this Next.js project. Providers: {providers}. Roles: {role}. Tasks: create app/api/auth/[...nextauth]/route.ts with authOptions (PrismaAdapter, {providers}, session:jwt strategy), extend next-auth.d.ts to add id + role to Session + JWT, update Prisma User model (add role field if needed), create middleware.ts to protect /dashboard/* routes, build SignIn/SignOut buttons as client components, add useSession guard to dashboard layout. Show .env.example with required keys.' },
  { id:'supabase-backend', category:'add-feature', icon:'⚡', title:'Supabase Backend', description:'Add Supabase for database, auth, realtime, and storage with full TypeScript types.', tags:['Supabase','RLS','Realtime'], steps:['Install @supabase/supabase-js and @supabase/ssr','Create typed client for server + client components','Define tables and enable Row Level Security','Write RLS policies for each user-facing table','Generate TypeScript types from schema'], fields:[{id:'tables',label:'Tables needed',type:'text',placeholder:'profiles, posts, comments'},{id:'auth',label:'Use Supabase Auth?',type:'select',options:['Yes','No — using NextAuth']},{id:'realtime',label:'Realtime features?',type:'select',options:['Yes','No']}], prompt:'Add Supabase to this project. Tables: {tables}. Auth: {auth}. Realtime: {realtime}. Tasks: install @supabase/supabase-js + @supabase/ssr, create lib/supabase/server.ts (createServerClient) + lib/supabase/client.ts (createBrowserClient), create SQL migration for tables ({tables}) with proper foreign keys and indexes, enable RLS on all tables + write policies (users can only access their own data), run "supabase gen types typescript --local > types/supabase.ts", add realtime subscription example if {realtime}=Yes. Show .env.example and exact SQL to run.' },
  { id:'admin-dashboard', category:'add-feature', icon:'📊', title:'Admin Dashboard', description:'Role-gated admin panel with user management, analytics, and data tables.', tags:['Admin','Analytics','RBAC'], steps:['Add admin role check to layout and middleware','Build users table with search, filter, and actions','Create analytics overview with key metrics','Add activity log viewer','Build settings panel for app configuration'], fields:[{id:'features',label:'Features needed',type:'select',options:['Users + Analytics','Users + Analytics + Logs','Full (users/analytics/logs/settings/roles)']}], prompt:'Build an admin dashboard for this project. Features: {features}. Tasks: create /admin layout with role check (redirect non-admins), /admin/users page (data table with search/filter/pagination, user detail modal, ban/unban/delete actions), /admin/analytics page (total users, MRR, active today, churn — fetched from DB), /admin/logs page if logs included (recent errors + activity feed), all using existing Prisma/Supabase schema. Protect all /admin/* routes in middleware.ts. Use existing UI component library (Tailwind/shadcn).' },
  { id:'revenuecat', category:'add-feature', icon:'💰', title:'RevenueCat IAP', description:'In-app purchases for Capacitor iOS/Android using RevenueCat for entitlement management.', tags:['RevenueCat','IAP','iOS','Subscriptions'], steps:['Install @revenuecat/purchases-capacitor','Configure with API key on app init','Fetch offerings and display subscription options','Implement purchase + restore flows','Add webhook endpoint to sync entitlements server-side'], fields:[{id:'products',label:'Products',type:'text',placeholder:'monthly_pro, annual_pro'},{id:'platform',label:'Platform',type:'select',options:['iOS only','Android only','Both']}], prompt:'Add RevenueCat IAP to this Capacitor app. Products: {products}. Platform: {platform}. Tasks: install @revenuecat/purchases-capacitor, initialize Purchases.configure({apiKey}) in App.tsx with platform check, create src/lib/purchases.ts with getOfferings() + purchasePackage() + restorePurchases() + checkEntitlement() helpers, build Paywall component showing offerings with pricing, add POST /api/webhooks/revenuecat route to handle INITIAL_PURCHASE/RENEWAL/CANCELLATION events and update user entitlements in DB. Show required RevenueCat dashboard setup steps.' },
  { id:'dark-mode', category:'add-feature', icon:'🌙', title:'Dark Mode + Theming', description:'CSS variable-based theming with dark/light toggle, system preference detection, and persistence.', tags:['Tailwind','CSS Vars','Themes'], steps:['Define semantic CSS custom properties for all colors','Configure Tailwind dark mode with class strategy','Build theme toggle component with system preference detection','Persist preference to localStorage','Apply theme transitions to prevent flash'], fields:[{id:'colors',label:'Brand Colors',type:'text',placeholder:'Purple #7c6aff, accent blue #3b82f6'},{id:'extraThemes',label:'Extra Themes?',type:'select',options:['Light + Dark only','Add high contrast','Add 3+ color themes']}], prompt:'Add dark mode and theming to this project. Brand colors: {colors}. Scope: {extraThemes}. Tasks: define CSS custom properties in globals.css (--background, --foreground, --primary, --border, etc.) for light and dark variants, configure tailwind.config darkMode:"class", create components/ThemeToggle.tsx with useTheme hook (reads localStorage + prefers-color-scheme, sets class on document.html), wrap app in ThemeProvider context, add theme transition (transition-colors 150ms) to body. If {extraThemes} includes extra themes, add theme selector with named themes.' },

  // ── CODE REVIEW ──────────────────────────────────────────────────────────────
  { id:'security-audit', category:'code-review', icon:'🛡️', title:'Security Audit', description:'Systematic scan for auth flaws, exposed secrets, injection risks, and missing headers.', tags:['Security','OWASP','Auth'], steps:['Check auth flows for bypass vulnerabilities','Scan for hardcoded secrets and env var leaks','Review API routes for missing authorization checks','Check RLS policies and database access patterns','Verify security headers and CORS configuration'], fields:[{id:'focus',label:'Focus Area',type:'select',options:['All (comprehensive)','Auth + Authorization only','API + Data layer only','Secrets + Config only']}], prompt:'Perform a security audit of this codebase. Focus: {focus}. Check: (1) authentication flows — are protected routes actually protected? can tokens be forged? (2) authorization — do API routes verify the user owns the requested resource? (3) hardcoded secrets or env vars committed to code, (4) SQL injection / NoSQL injection risks, (5) Supabase/Prisma RLS policies — are there missing policies that allow data leakage? (6) API rate limiting, (7) security headers (helmet/CSP/HSTS), (8) CORS configuration. For each issue: severity (Critical/High/Medium/Low), file:line, and exact fix. Prioritize by severity.' },
  { id:'perf-review', category:'code-review', icon:'⚡', title:'Performance Review', description:'Find N+1 queries, bundle bloat, render bottlenecks, and missing caching.', tags:['Performance','Queries','Bundle'], steps:['Identify N+1 database query patterns','Check for missing Prisma includes/selects','Find large dependencies and code-splitting opportunities','Review server vs client component usage in Next.js','Check for missing memo/callback optimizations'], fields:[{id:'focus',label:'Focus Area',type:'select',options:['All areas','Database queries only','Frontend bundle only','Server components only']}], prompt:'Do a performance review of this codebase. Focus: {focus}. Find: (1) N+1 query patterns — database calls inside loops, missing Prisma include/select, (2) missing indexes on frequently queried columns, (3) large npm packages that should be lazy-loaded or replaced, (4) Next.js server components that unnecessarily use "use client", (5) missing React.memo/useCallback/useMemo on expensive computations, (6) images without next/image optimization, (7) missing ISR/SSG on static pages. For each: file:line, impact estimate, and exact fix.' },
  { id:'bug-hunt', category:'code-review', icon:'🐛', title:'Find All Bugs', description:'Systematic hunt for null reference errors, edge cases, and error handling gaps.', tags:['Bugs','Edge Cases','Reliability'], steps:['Scan for unhandled promise rejections','Check null/undefined access without guards','Find missing try/catch in async functions','Review form validation and input handling','Check error boundary coverage'], fields:[{id:'scope',label:'Scope',type:'select',options:['Entire codebase','API routes only','Frontend components only','Database layer only']}], prompt:'Find all bugs in this codebase. Scope: {scope}. Look for: (1) unhandled promise rejections and missing await, (2) null/undefined access without optional chaining or guards (.user.id where user could be null), (3) async functions without try/catch that will silently fail, (4) missing input validation that allows bad data into the DB, (5) race conditions (state updates in async callbacks), (6) incorrect dependency arrays in useEffect, (7) missing loading and error states in UI. For each bug: file:line, what will break, reproduction scenario, and exact fix.' },
  { id:'api-docs', category:'code-review', icon:'📖', title:'Document APIs', description:'Generate comprehensive API documentation from existing route definitions.', tags:['Docs','OpenAPI','REST'], steps:['Discover all API routes and methods','Extract request/response shapes from Zod schemas or TypeScript types','Document authentication requirements','Add error code documentation','Generate example requests and responses'], fields:[{id:'format',label:'Output Format',type:'select',options:['Markdown file','OpenAPI 3.0 JSON','JSDoc comments in source','README section']}], prompt:'Generate API documentation for this project. Format: {format}. For each API route: HTTP method + path, auth required (yes/no + what token), request body schema (from Zod/TypeScript types), query params, response schema with all possible status codes (200/201/400/401/403/404/500), and a complete example request (curl). Group routes by resource (users, subscriptions, etc.). If {format} is OpenAPI, output valid OpenAPI 3.0 JSON. If {format} is Markdown, write to docs/API.md.' },

  // ── DATABASE ─────────────────────────────────────────────────────────────────
  { id:'design-schema', category:'database', icon:'🗃️', title:'Design Prisma Schema', description:'Turn business requirements into a normalized Prisma schema with proper relations.', tags:['Prisma','Schema','Modeling'], steps:['Identify core entities from requirements','Define relations (one-to-many, many-to-many)','Add indexes on foreign keys and query fields','Create enums for status/type fields','Write schema with @@map for snake_case tables'], fields:[{id:'entities',label:'Core Entities',type:'text',placeholder:'User, Post, Comment, Like, Follow'},{id:'rules',label:'Business Rules',type:'text',placeholder:'Users have many posts, posts have comments...'}], prompt:'Design a Prisma schema for this application. Entities: {entities}. Rules: {rules}. Create: complete prisma/schema.prisma with all models, proper field types, required vs optional, @relation declarations for all foreign keys, @unique constraints, @@index on frequently queried fields, enums for status/type fields, @@map("snake_case_table_name") on all models. Add brief comments explaining non-obvious design choices. Also write the initial migration SQL.' },
  { id:'write-migration', category:'database', icon:'🔄', title:'Write Prisma Migration', description:'Add a new model or modify existing schema with proper migration and data transforms.', tags:['Prisma','Migration','Schema'], steps:['Update prisma/schema.prisma with the change','Write migration SQL handling existing data','Add data backfill if needed for non-nullable fields','Update all affected queries and includes','Run prisma generate to update client'], fields:[{id:'change',label:'What to change',type:'text',placeholder:'Add subscription tier to User, add Plan model linked to subscriptions'}], prompt:'Write a Prisma migration for this change: {change}. Tasks: (1) update prisma/schema.prisma with the new/modified models, (2) if adding a non-nullable field to existing table, explain the 3-step migration (add nullable, backfill, make required), (3) identify all files that use affected models and show the query updates needed (use grep to find them), (4) run `npx prisma migrate dev --name describe-change` and show expected output, (5) update TypeScript types if any manual type definitions reference the changed models.' },
  { id:'rls-policies', category:'database', icon:'🔒', title:'Supabase RLS Policies', description:'Write Row Level Security policies so users can only access their own data.', tags:['Supabase','RLS','Security'], steps:['Enable RLS on all user-facing tables','Write SELECT policy (users see only their rows)','Write INSERT policy (users create only their own)','Write UPDATE and DELETE policies','Test each policy with the Supabase policy simulator'], fields:[{id:'tables',label:'Tables to protect',type:'text',placeholder:'profiles, posts, comments, files'},{id:'pattern',label:'Access Pattern',type:'select',options:['User owns rows (auth.uid = user_id)','Org-based access (team members share data)','Public read + auth write']}], prompt:'Write Supabase RLS policies for these tables: {tables}. Pattern: {pattern}. For each table: (1) ALTER TABLE tablename ENABLE ROW LEVEL SECURITY, (2) CREATE POLICY for SELECT, INSERT, UPDATE, DELETE using auth.uid() = user_id (or org pattern for {pattern}), (3) add a service role bypass policy for server-side operations. Also: identify any tables currently missing RLS, check for unsafe direct queries that bypass RLS (using service role where anon should be used). Show the exact SQL for each policy and explain what it prevents.' },
  { id:'seed-data', category:'database', icon:'🌱', title:'Generate Seed Data', description:'Create realistic development seed data with proper relations and edge cases.', tags:['Prisma','Seeds','Testing'], steps:['Create prisma/seed.ts with factory functions','Generate realistic data using faker patterns','Seed in dependency order (users before posts)','Include edge cases and boundary data','Add npm script to run seed'], fields:[{id:'count',label:'Records per table',type:'select',options:['Small (10-50)','Medium (100-500)','Large (1000+)']},{id:'scenario',label:'Scenario',type:'select',options:['Development defaults','Demo data (realistic names/content)','Load test data (max sizes)']}], prompt:'Write a Prisma seed script for this project. Records: {count}. Scenario: {scenario}. Tasks: create prisma/seed.ts that (1) reads the Prisma schema to understand all models and relations, (2) seeds in correct dependency order (no FK violations), (3) creates {count} records using realistic data (for {scenario}: use lifelike names, emails, content), (4) includes edge cases (users with no posts, accounts at free tier, cancelled subscriptions), (5) is idempotent (upsert by unique field where possible), (6) adds "seed": "tsx prisma/seed.ts" to package.json scripts. Show expected output when run.' },

  // ── DEPLOY ───────────────────────────────────────────────────────────────────
  { id:'deploy-vercel', category:'deploy', icon:'▲', title:'Deploy to Vercel', description:'Configure and deploy to Vercel with environment variables, domains, and build settings.', tags:['Vercel','CI/CD','Deployment'], steps:['Create vercel.json with build config','Audit required environment variables','Set up preview + production environments','Configure custom domain and headers','Run deployment and verify'], fields:[{id:'envVars',label:'Required env vars',type:'text',placeholder:'DATABASE_URL, NEXTAUTH_SECRET, STRIPE_SECRET_KEY'},{id:'domain',label:'Custom Domain (optional)',type:'text',placeholder:'myapp.com or leave blank'}], prompt:'Set up and deploy this project to Vercel. Env vars needed: {envVars}. Domain: {domain}. Tasks: (1) create vercel.json if needed (framework auto-detected for Next.js), (2) audit ALL process.env usages and list every required env var with a description for .env.example, (3) identify any env vars that differ between preview and production, (4) check for any hardcoded localhost URLs that will break in production, (5) run `vercel --prod --yes` and verify the deployment URL, (6) if domain provided, show DNS configuration. Flag any build-time vs runtime env var issues (NEXT_PUBLIC_ prefix).' },
  { id:'supabase-setup', category:'deploy', icon:'⚡', title:'Configure Supabase', description:'Set up tables, auth, edge functions, and generate TypeScript types for a Supabase project.', tags:['Supabase','Edge Functions','Auth'], steps:['Push database schema with supabase db push','Configure auth providers in dashboard','Deploy Edge Functions','Generate TypeScript types','Configure storage buckets'], fields:[{id:'project',label:'Supabase Project Ref',type:'text',placeholder:'abcdefghijklmnop'},{id:'features',label:'Features to configure',type:'select',options:['DB + Auth','DB + Auth + Storage','DB + Auth + Edge Functions + Storage']}], prompt:'Configure Supabase project {project} for this app. Features: {features}. Tasks: (1) run `supabase db push` to apply schema, (2) enable RLS on all tables and verify policies exist, (3) generate types: `supabase gen types typescript --project-id {project} > types/supabase.ts`, (4) if storage: create required buckets with correct public/private settings and RLS, (5) if edge functions: deploy with `supabase functions deploy`, (6) verify auth configuration matches the providers in the codebase. Show any mismatches between local code and Supabase project config.' },
  { id:'setup-env', category:'deploy', icon:'⚙️', title:'Environment Configuration', description:'Audit all env variables, create validated .env.example, and document secrets management.', tags:['Environment','Config','Security'], steps:['Scan all files for process.env usage','Group by service (database, auth, payments, etc.)','Generate .env.example with descriptions','Add runtime validation with Zod','Document rotation procedures for secrets'], fields:[{id:'services',label:'External Services',type:'text',placeholder:'PostgreSQL, Supabase, Stripe, SendGrid'}], prompt:'Audit and configure environment variables for this project. Services: {services}. Tasks: (1) grep all files for process.env usage and list every unique variable, (2) categorize by service ({services}), (3) create/update .env.example with a description comment above each variable (what it is, where to get it, example format), (4) identify any missing validation — add a src/env.ts or env.mjs file using Zod to validate all required env vars at startup (throw with clear error if missing), (5) flag any env vars that should be rotated and suggest rotation schedule. Mark which vars are safe to commit vs must stay secret.' },

  // ── DEBUG ────────────────────────────────────────────────────────────────────
  { id:'trace-error', category:'debug', icon:'🔍', title:'Trace Runtime Error', description:'Investigate a specific error with stack trace analysis, root cause, and fix.', tags:['Debug','Error Handling','Root Cause'], steps:['Parse the stack trace to identify origin file','Trace the call chain to find the root cause','Check for null/undefined sources','Identify the fix and any related vulnerabilities','Add error handling to prevent recurrence'], fields:[{id:'error',label:'Error Message',type:'text',placeholder:'TypeError: Cannot read property x of undefined'},{id:'stack',label:'Stack Trace',type:'text',placeholder:'at Component.render (src/...) ...'},{id:'context',label:'When does it happen?',type:'text',placeholder:'When clicking submit on the login form'}], prompt:'Debug this runtime error. Error: {error}. Stack: {stack}. Context: {context}. Tasks: (1) parse the stack trace — read the origin file at the specified line, (2) trace backwards through the call chain to find where the bad data enters, (3) explain exactly why this error occurs and under what conditions, (4) write the minimal fix (add null check, fix data flow, etc.), (5) check if the same pattern exists elsewhere in the codebase (grep for similar code), (6) add a test case that would have caught this. Show the before/after diff.' },
  { id:'fix-typescript', category:'debug', icon:'🔷', title:'Fix TypeScript Errors', description:'Run tsc and systematically resolve all type errors by category.', tags:['TypeScript','Types','Compiler'], steps:['Run tsc --noEmit to get full error list','Group errors by type (any, missing props, etc.)','Fix most common patterns first','Handle generics and complex types','Verify zero errors at the end'], fields:[{id:'scope',label:'What to fix',type:'select',options:['All TypeScript errors','Only errors (not warnings)','Specific file or directory']}], prompt:'Fix all TypeScript errors in this project. Scope: {scope}. Tasks: (1) run `npx tsc --noEmit 2>&1` to get the full error list, (2) group errors by category (implicit any, missing properties, incompatible types, etc.), (3) fix them category by category — add proper types, fix interface mismatches, replace any with proper generics, (4) for complex cases (third-party library types), show the correct way to type them, (5) run tsc again to verify zero errors, (6) if strict mode is off, suggest incremental path to enable it. Do NOT use `as any` or `// @ts-ignore` — fix the actual types.' },
  { id:'debug-api', category:'debug', icon:'🔌', title:'Debug API Failures', description:'Trace a failing API route from request to response to find the exact failure point.', tags:['API','HTTP','Server'], steps:['Add temporary logging to trace the request','Check middleware execution order','Verify database query and connection','Check response format and status codes','Remove debug logging and add proper error handling'], fields:[{id:'route',label:'Route',type:'text',placeholder:'/api/users/[id]'},{id:'method',label:'HTTP Method',type:'select',options:['GET','POST','PUT','DELETE','PATCH']},{id:'symptom',label:'What fails?',type:'text',placeholder:'Returns 500, returns empty array, hangs...'}], prompt:'Debug the failing {method} {route} endpoint. Symptom: {symptom}. Tasks: (1) read the route handler file, (2) trace the full request lifecycle: auth middleware → route handler → database query → response, (3) identify all places where the {symptom} could originate, (4) add console.log statements to narrow down, (5) fix the identified issue, (6) add proper error handling so future failures return meaningful error messages instead of generic 500s, (7) write a test for the happy path and the failure case. Show the curl command to reproduce the issue.' },
  { id:'fix-build', category:'debug', icon:'🔨', title:'Fix Build Failures', description:'Diagnose and fix Next.js or Vite build errors to get back to a clean build.', tags:['Build','Next.js','Vite'], steps:['Run the build command and capture full output','Identify the error type (module not found, TS error, etc.)','Apply the targeted fix','Verify build succeeds','Check for any warnings that could become future errors'], fields:[{id:'buildOutput',label:'Build Error Output',type:'text',placeholder:'Paste the error from npm run build'}], prompt:'Fix this build failure: {buildOutput}. Tasks: (1) parse the error — is it a TypeScript error, missing module, invalid import, server/client boundary violation, or invalid config? (2) find the exact file and line causing it, (3) apply the minimal fix, (4) check if the same pattern exists elsewhere (grep), (5) run `npm run build` again to verify it succeeds, (6) if there are remaining warnings, assess which ones could become errors in the next version and fix the critical ones. Do not suppress errors with @ts-ignore or eslint-disable unless absolutely necessary.' },

  // ── REFACTOR ─────────────────────────────────────────────────────────────────
  { id:'extract-components', category:'refactor', icon:'🧩', title:'Extract Components', description:'Break down large components into focused, reusable, and testable pieces.', tags:['Components','Reusability','Architecture'], steps:['Identify components over 150 lines or with multiple concerns','Extract each logical section into a named component','Define clean prop interfaces with TypeScript types','Move shared state up or into context','Update imports across the codebase'], fields:[{id:'target',label:'File to refactor',type:'text',placeholder:'src/components/Dashboard.tsx'},{id:'pattern',label:'Extraction Pattern',type:'select',options:['Pure UI components','Hooks extraction','Full container/presenter split']}], prompt:'Refactor {target} by extracting components. Pattern: {pattern}. Tasks: (1) read {target} and identify sections that should be separate components (each over ~50 lines or with a distinct purpose), (2) for each extraction: create the new component file, define TypeScript props interface, extract the JSX, extract any related state/handlers into a custom hook if {pattern} includes hooks, (3) update {target} to use the new components, (4) check if any of the extracted components are used elsewhere in the app and consolidate, (5) verify no prop drilling deeper than 2 levels — suggest context if needed.' },
  { id:'app-router-migration', category:'refactor', icon:'🔀', title:'Migrate to App Router', description:'Convert a Next.js pages/ directory project to the modern App Router.', tags:['Next.js','App Router','Migration'], steps:['Audit pages/ directory and map to app/ equivalents','Convert getServerSideProps to async server components','Replace _app.tsx with root layout.tsx','Convert API routes to route handlers','Move middleware and update auth patterns'], fields:[{id:'pagesDir',label:'Pages to migrate',type:'select',options:['All pages','Dashboard section only','API routes only']}], prompt:'Migrate this Next.js project from pages/ to App Router. Scope: {pagesDir}. For each page: (1) convert getServerSideProps → async server component with direct DB/API call, (2) convert getStaticProps → server component (cached by default), (3) move client-side state/effects into separate "use client" components, (4) replace _app.tsx with app/layout.tsx (RootLayout), (5) convert pages/api/* to app/api/*/route.ts with GET/POST exports, (6) update auth: getSession() → getServerSession() in server components, (7) add loading.tsx and error.tsx to each route segment. Flag any patterns that have no direct App Router equivalent.' },
  { id:'add-loading', category:'refactor', icon:'⏳', title:'Add Loading + Error States', description:'Add Suspense boundaries, skeleton loaders, and error.tsx pages throughout the app.', tags:['UX','Suspense','Error Boundaries'], steps:['Add loading.tsx to all dynamic route segments','Create skeleton components for data-fetching UI','Add error.tsx for graceful error recovery','Wrap client-side fetching with loading states','Add empty state components for zero-data views'], fields:[{id:'scope',label:'Scope',type:'select',options:['All routes','Dashboard only','API-heavy pages only']}], prompt:'Add loading and error states to this Next.js app. Scope: {scope}. Tasks: (1) find all route segments in app/ that fetch data and add loading.tsx with Suspense skeleton matching the page layout, (2) find all client components using fetch/SWR/React Query and add isLoading + isError + isEmpty handling, (3) add error.tsx to each route group with a friendly error UI and "try again" button, (4) create reusable Skeleton components (SkeletonCard, SkeletonTable, SkeletonText) matching actual UI dimensions, (5) add empty state components for zero-result views with a call-to-action. Ensure every async data boundary has all 3 states: loading, error, and empty.' },
  { id:'clean-dead-code', category:'refactor', icon:'🧹', title:'Clean Dead Code', description:'Find and remove unused functions, components, imports, and dependencies.', tags:['Cleanup','Unused','Dependencies'], steps:['Find unused exports with TypeScript LSP','Identify unused npm dependencies','Remove unreachable code paths','Clean up commented-out code blocks','Verify tests still pass after cleanup'], fields:[{id:'scope',label:'Cleanup Scope',type:'select',options:['Full codebase','Dependencies only','Components only','Functions only']}], prompt:'Remove dead code from this project. Scope: {scope}. Tasks: (1) find unused imports — grep for all export statements and check if they are imported anywhere, (2) find unused npm packages — check package.json dependencies against actual imports in source files, (3) find commented-out code blocks that have been there over a reasonable time and remove them, (4) find unreachable code (code after return statements, conditions that are always true/false), (5) find components that are defined but never rendered, (6) for each removal: verify no dynamic imports or runtime require() calls reference it before deleting. Show a summary: X imports removed, Y packages to uninstall, Z LOC removed.' },
];

// ─── /new — instant project scaffolding from your real templates ──────────────
// Based on your actual CLAUDE_BACKEND_SETUP.md, app-template, and AGENTS.md structure.
const RAXX_TEMPLATES = [
  {
    id: 'raxx-saas',
    name: 'RAXX Full-Stack SaaS',
    desc: 'Your exact app-template stack — Next.js 15, Prisma v7, Auth.js, Supabase, Stripe, your backend layer structure.',
    tags: ['Next.js','Prisma','Stripe','Auth.js','Supabase','Tailwind'],
    prompt: `Scaffold a production-ready RAXX full-stack SaaS app called "{name}" in the directory {dir}.

STACK (exact — do not substitute):
- Next.js 15 App Router + TypeScript strict
- Prisma v7 + PostgreSQL (Supabase) — directUrl for migrations, pooler for runtime
- Auth.js v5 (next-auth) with @auth/prisma-adapter — email + Google OAuth
- Stripe subscriptions + webhook handler
- Tailwind CSS + shadcn/ui components
- Zod validation on every mutating route
- deploy-verify.sh for all Vercel deploys

DIRECTORY STRUCTURE (from CLAUDE_BACKEND_SETUP.md — do not collapse layers):
app/
  frontend/     components/ pages/ hooks/ lib/ api/ styles/ types/
  backend/      routes/ controllers/ services/ middleware/ validators/ utils/ types/
  database/     migrations/ seeds/ schema/ queries/
  security/     auth/ permissions/ roles/ headers/ cors/ validation/ encryption/
  rate-limit/   rateLimiter/ authLimiter/ apiLimiter/ subscriptionLimiter/
  auth/         login/ register/ reset/ verify/ mfa/ sessions/ oauth/
  billing/      subscriptions/ webhooks/ invoices/ history/
  notifications/ email/ sms/ inApp/ push/
  jobs/         workers/ queues/ cron/
  admin/        users/ roles/ logs/
  observability/ errors/ logs/ perf/ health/

PRISMA SCHEMA — include these exact models: User (with security fields: twoFactorEnabled, failedLoginCount, lockedUntil, isActive, isSuspended, dataDeleteRequested), Account, Session, Subscription, Plan, AuditLog, UserActivity, BugReport, PasswordResetToken, EmailVerificationToken, UserPreferences, SupportTicket.

API RULES:
- Base path /api/v1 — version every route
- Controllers never touch DB. Services never touch req/res. Raw DB only in database/queries/
- Centralized error handler + request-ID tracking
- Webhook signature verify on all incoming webhooks
- Audit log on every privileged action
- Rate limits per subscription tier
- Soft-delete + purge job

CLAUDE.md: create a 1-line CLAUDE.md: "Follow ~/.claude/CLAUDE_BACKEND_SETUP.md." — nothing else.
AGENTS.md: create AGENTS.md with the Next.js agent rules header.

ENV (.env.example): DATABASE_URL, DIRECT_URL, NEXTAUTH_SECRET, NEXTAUTH_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, NEXT_PUBLIC_APP_URL, NODE_ENV.

Create all files. Run npx create-next-app@latest {name} --typescript --tailwind --app --no-src-dir --import-alias "@/*" first, then build the structure on top.`,
  },
  {
    id: 'raxx-api',
    name: 'RAXX Express API',
    desc: 'Standalone Express REST API with your full backend layer structure, JWT auth, Prisma, Zod, rate limiting.',
    tags: ['Express','Prisma','JWT','Zod','Node.js','TypeScript'],
    prompt: `Scaffold a production Express REST API called "{name}" in {dir}.

STACK: Node.js, TypeScript strict, Express, Prisma v7 + PostgreSQL, Zod, JWT (access 15m + refresh 7d), express-rate-limit, helmet, CORS.

STRUCTURE (follow CLAUDE_BACKEND_SETUP.md exactly):
src/
  routes/       one file per resource
  controllers/  receive req/res, call services, never touch DB
  services/     business logic, never touch req/res
  middleware/   auth, reqId, rateLimit, errorHandler
  validators/   Zod schemas per route
  database/queries/  raw Prisma calls only here
  security/     jwt.ts, hash.ts, cors.ts
  jobs/         workers and cron
  types/

API base: /api/v1
Endpoints: GET /health, GET /status
Every mutating route: Zod validator + auth middleware
Error handler: returns { error, code, requestId }
Audit log table for privileged actions.
Create .env.example with DATABASE_URL, DIRECT_URL, JWT_SECRET, PORT, NODE_ENV, FRONTEND_URL.`,
  },
  {
    id: 'raxx-claude-agent',
    name: 'RAXX Claude Agent App',
    desc: 'Next.js app with Claude API streaming, tool use, RAG, and your backend structure. Uses @anthropic-ai/sdk.',
    tags: ['Claude','Anthropic','Streaming','Tool Use','RAG','Next.js'],
    prompt: `Scaffold a Next.js 15 Claude agent app called "{name}" in {dir}.

STACK: Next.js 15 App Router, TypeScript, @anthropic-ai/sdk, Tailwind, Prisma v7 + Supabase, Auth.js.

FEATURES TO WIRE UP:
1. Streaming chat — app/api/chat/route.ts using client.messages.stream(), SSE to frontend
2. Tool use — define tools array with at least: web_search, read_file, run_code
3. Conversation history — stored in Prisma, loaded per session
4. RAG — simple file-based vector search using @xenova/transformers (local, no API cost)
5. System prompt loaded from ~/.proverbs/.script if present, else from app config
6. Model switching — env var ANTHROPIC_MODEL, default claude-haiku-4-5-20251001 (cheapest)
7. Prompt caching — mark static system prompt with cache_control: { type: "ephemeral" }

BACKEND STRUCTURE: follow CLAUDE_BACKEND_SETUP.md (controllers/services/queries layers).
CLAUDE.md: "Follow ~/.claude/CLAUDE_BACKEND_SETUP.md."

ENV: ANTHROPIC_API_KEY, ANTHROPIC_MODEL, DATABASE_URL, DIRECT_URL, NEXTAUTH_SECRET, NEXT_PUBLIC_APP_URL.

Create the full working app including: streaming chat UI component, message history display, tool call display, model switcher, .env.example.`,
  },
  {
    id: 'raxx-admin',
    name: 'RAXX Admin Panel',
    desc: 'Internal admin dashboard — user management, audit logs, subscription controls, role-based access.',
    tags: ['Admin','Dashboard','RBAC','Audit','Next.js'],
    prompt: `Scaffold a RAXX admin panel called "{name}" in {dir}. This is an internal tool for managing the platform.

STACK: Next.js 15 App Router, TypeScript, Prisma v7 + Supabase, Auth.js (admin-only login), Tailwind, shadcn/ui data tables.

PAGES:
- /admin/users — table: email, role, status, subscription, lastLogin, actions (suspend/unsuspend/impersonate/delete)
- /admin/subscriptions — active subs, MRR, churn, overdue
- /admin/audit — paginated audit log with filters (user, action, IP, date range)
- /admin/bugs — bug reports table with status (open/investigating/resolved)
- /admin/support — support ticket queue
- /admin/settings — feature flags, rate limit config, maintenance mode

ACCESS: admin role check in middleware.ts — redirect to /login if not ADMIN or SUPER_ADMIN.
Impersonation: log to AuditLog, store original admin ID in session.
All destructive actions: require confirmation modal + audit log entry.
CLAUDE.md: "Follow ~/.claude/CLAUDE_BACKEND_SETUP.md."`,
  },
  {
    id: 'raxx-mobile',
    name: 'RAXX Mobile (Capacitor)',
    desc: 'Wrap an existing RAXX web app for iOS and Android with Capacitor.',
    tags: ['Capacitor','iOS','Android','Mobile','Native'],
    prompt: `Add Capacitor to the existing web app in {dir} for {platform} deployment. App name: "{name}", Bundle ID: {bundleId}.

Tasks:
1. npm install @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android
2. npx cap init "{name}" "{bundleId}" --web-dir=out (or dist/build depending on framework)
3. Update next.config.ts: output: "export", images: { unoptimized: true }
4. Add @capacitor/camera, @capacitor/filesystem, @capacitor/push-notifications, @capacitor/status-bar, @capacitor/haptics
5. Create capacitor.config.ts with server.androidScheme = "https"
6. Info.plist: NSCameraUsageDescription, NSPhotoLibraryUsageDescription, NSLocationWhenInUseUsageDescription
7. AndroidManifest: CAMERA, READ_EXTERNAL_STORAGE, INTERNET, ACCESS_NETWORK_STATE permissions
8. npm scripts: "cap:ios": "npm run build && npx cap sync ios && npx cap open ios", "cap:android": same for android
9. Create src/lib/native.ts — platform detection + safe plugin wrappers that fall back gracefully on web

Show exact commands to run to open in Xcode / Android Studio.`,
  },
];

// ─── /new command handler ─────────────────────────────────────────────────────
async function handleNewCommand(parts) {
  const sub  = (parts[1] || '').toLowerCase();
  const name = parts[2] || '';

  // List templates
  if (!sub || sub === 'list' || sub === 'help') {
    console.log(colorize(C.cyan, '\n  /new — Instant project scaffolding from your RAXX templates\n'));
    RAXX_TEMPLATES.forEach((t, i) => {
      console.log(colorize(C.bold, `  ${(i+1)+'.'}  ${t.id.padEnd(24)}`) + colorize(C.dim, t.name));
      console.log(colorize(C.dim,  `       ${t.desc}`));
      console.log(colorize(C.dim,  `       Tags: ${t.tags.join(', ')}\n`));
    });
    console.log(colorize(C.dim, '  Usage: /new <template-id> <app-name> [directory]\n'));
    console.log(colorize(C.dim, '  Example: /new raxx-saas my-app ~/projects/my-app\n'));
    return;
  }

  const tmpl = RAXX_TEMPLATES.find(t => t.id === sub || t.id.includes(sub));
  if (!tmpl) {
    console.log(colorize(C.yellow, `\n  Unknown template: "${sub}". Run /new to see all templates.\n`));
    return;
  }

  const appName = name || sub + '-app';
  const dir = parts[3] ? path.resolve(parts[3]) : path.join(cwd, appName);

  console.log(colorize(C.cyan,  `\n  Scaffolding: ${tmpl.name}`));
  console.log(colorize(C.dim,   `  App name:    ${appName}`));
  console.log(colorize(C.dim,   `  Directory:   ${dir}\n`));

  // Build the prompt with substitutions
  const prompt = tmpl.prompt
    .replace(/\{name\}/g, appName)
    .replace(/\{dir\}/g, dir)
    .replace(/\{platform\}/g, parts[4] || 'iOS + Android')
    .replace(/\{bundleId\}/g, parts[5] || 'com.raxx.' + appName.replace(/[^a-z0-9]/gi,'').toLowerCase());

  // Push into conversation and run
  history.push({ role: 'user', content: prompt });
  const msgs = [{ role: 'system', content: buildSystemPrompt() }, ...history];
  const reply = await agentLoop(msgs, prompt);
  if (reply && reply !== '[interrupted]') {
    history.push({ role: 'assistant', content: reply });
    console.log(renderMarkdown(reply));
  }
}

const STUDIO_CATEGORY_META = {
  'new-project':  { label: 'New Project',  color: '#7c6aff', glow: 'rgba(124,106,255,0.3)', count: 0 },
  'add-feature':  { label: 'Add Feature',  color: '#22c55e', glow: 'rgba(34,197,94,0.3)',   count: 0 },
  'code-review':  { label: 'Code Review',  color: '#f59e0b', glow: 'rgba(245,158,11,0.3)',  count: 0 },
  'database':     { label: 'Database',     color: '#3b82f6', glow: 'rgba(59,130,246,0.3)',  count: 0 },
  'deploy':       { label: 'Deploy',       color: '#ec4899', glow: 'rgba(236,72,153,0.3)',  count: 0 },
  'debug':        { label: 'Debug',        color: '#ef4444', glow: 'rgba(239,68,68,0.3)',   count: 0 },
  'refactor':     { label: 'Refactor',     color: '#06b6d4', glow: 'rgba(6,182,212,0.3)',   count: 0 },
};
STUDIO_SCENARIOS.forEach(s => { if (STUDIO_CATEGORY_META[s.category]) STUDIO_CATEGORY_META[s.category].count++; });

function getStudioHtml(cfg) {
  const data = JSON.stringify({ scenarios: STUDIO_SCENARIOS, categories: STUDIO_CATEGORY_META, config: { cwd: cfg.cwd, model: cfg.model, port: cfg.port } });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proverbs Studio</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#07090f;--surf:#0e1118;--card:#141828;--border:#1c2238;--accent:#7c6aff;--text:#e2e8f0;--muted:#4a5568;--sidebar:220px;--header:54px}
html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px}
/* scrollbar */
::-webkit-scrollbar{width:4px;height:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#2a3150;border-radius:4px}
/* header */
#hdr{height:var(--header);background:#0a0d16;border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 20px;gap:14px;flex-shrink:0;position:sticky;top:0;z-index:50}
#hdr .logo{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px;color:var(--accent);letter-spacing:.3px}
#hdr .logo svg{opacity:.9}
#hdr .sep{width:1px;height:20px;background:var(--border);margin:0 4px}
#hdr .cwd{font-size:11px;color:var(--muted);font-family:monospace;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#hdr .spacer{flex:1}
#hdr .badge{font-size:11px;padding:3px 9px;border-radius:20px;background:var(--surf);border:1px solid var(--border);color:var(--muted)}
#hdr .badge.active{color:#22c55e;border-color:rgba(34,197,94,.3);background:rgba(34,197,94,.08)}
/* layout */
#layout{display:grid;grid-template-columns:var(--sidebar) 1fr;height:calc(100vh - var(--header));overflow:hidden}
/* sidebar */
#sidebar{background:#09101a;border-right:1px solid var(--border);overflow-y:auto;padding:12px 0}
#sidebar .s-head{font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--muted);padding:8px 16px 6px}
.cat-btn{display:flex;align-items:center;justify-content:space-between;width:100%;padding:8px 16px;background:none;border:none;color:#94a3b8;cursor:pointer;font-size:13px;text-align:left;transition:all .15s;border-left:3px solid transparent}
.cat-btn:hover{background:rgba(255,255,255,.04);color:var(--text)}
.cat-btn.active{color:var(--text);background:rgba(124,106,255,.08);border-left-color:var(--accent)}
.cat-btn .cnt{font-size:11px;color:var(--muted);background:rgba(255,255,255,.06);padding:1px 6px;border-radius:10px}
.cat-btn.active .cnt{background:rgba(124,106,255,.2);color:var(--accent)}
/* main */
#main{display:flex;flex-direction:column;overflow:hidden}
#search-bar{padding:14px 20px 10px;flex-shrink:0;display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--border)}
#search{flex:1;background:var(--surf);border:1px solid var(--border);border-radius:8px;padding:8px 14px;color:var(--text);font-size:13px;outline:none;transition:border-color .15s}
#search:focus{border-color:rgba(124,106,255,.5)}
#search::placeholder{color:var(--muted)}
#count-label{font-size:12px;color:var(--muted);white-space:nowrap}
/* grid */
#grid{flex:1;overflow-y:auto;padding:18px 20px;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;align-content:start}
/* card */
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;cursor:pointer;transition:all .2s;display:flex;flex-direction:column;gap:10px;position:relative;overflow:hidden}
.card::before{content:'';position:absolute;inset:0;border-radius:12px;opacity:0;transition:opacity .2s}
.card:hover{transform:translateY(-2px);border-color:var(--c, var(--accent))}
.card:hover::before{opacity:1;background:linear-gradient(135deg, rgba(var(--cr),0.06) 0%, transparent 60%)}
.card-icon{font-size:28px;line-height:1}
.card-title{font-size:15px;font-weight:700;color:var(--text);line-height:1.3}
.card-desc{font-size:12px;color:#8899b4;line-height:1.5;flex:1}
.card-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:2px}
.tag{font-size:10px;padding:2px 7px;border-radius:10px;background:rgba(255,255,255,.06);color:#6b7fa8;border:1px solid rgba(255,255,255,.07)}
.card-foot{display:flex;align-items:center;justify-content:space-between;margin-top:4px}
.cat-dot{width:6px;height:6px;border-radius:50%;background:var(--c,var(--accent))}
.card-cta{font-size:11px;color:var(--c,var(--accent));opacity:0;transition:opacity .2s;font-weight:600}
.card:hover .card-cta{opacity:1}
/* detail panel */
#detail{position:fixed;inset:var(--header) 0 0 var(--sidebar);background:var(--bg);z-index:40;display:none;grid-template-columns:1fr 380px;overflow:hidden}
#detail.open{display:grid}
#detail-left{padding:28px 32px;overflow-y:auto;border-right:1px solid var(--border)}
#detail-right{padding:28px 24px;overflow-y:auto;display:flex;flex-direction:column;gap:0;background:#09101a}
.d-back{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:12px;cursor:pointer;margin-bottom:20px;transition:color .15s;background:none;border:none;padding:0}
.d-back:hover{color:var(--text)}
.d-icon{font-size:40px;margin-bottom:12px;display:block}
.d-cat{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;padding:3px 10px;border-radius:20px;margin-bottom:10px}
.d-title{font-size:22px;font-weight:800;margin-bottom:8px;line-height:1.2}
.d-desc{font-size:13px;color:#94a3b8;line-height:1.65;margin-bottom:22px}
.d-section-head{font-size:10px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
.d-steps{display:flex;flex-direction:column;gap:8px}
.d-step{display:flex;gap:12px;align-items:flex-start}
.d-step-num{width:22px;height:22px;border-radius:50%;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--muted);flex-shrink:0;margin-top:1px}
.d-step-text{font-size:12px;color:#94a3b8;line-height:1.55;padding-top:2px}
/* right panel */
.r-section{margin-bottom:22px}
.r-label{font-size:11px;font-weight:600;color:#94a3b8;margin-bottom:6px;display:block}
.r-input{width:100%;background:var(--surf);border:1px solid var(--border);border-radius:7px;padding:9px 12px;color:var(--text);font-size:13px;outline:none;transition:border-color .15s}
.r-input:focus{border-color:rgba(124,106,255,.5)}
.r-select{width:100%;background:var(--surf);border:1px solid var(--border);border-radius:7px;padding:9px 12px;color:var(--text);font-size:13px;outline:none;cursor:pointer;-webkit-appearance:none;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%234a5568' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center}
.r-select:focus{border-color:rgba(124,106,255,.5)}
.cwd-display{font-size:11px;font-family:monospace;color:var(--muted);margin-top:4px}
.launch-btn{width:100%;padding:13px;background:var(--accent);color:#fff;border:none;border-radius:9px;font-size:14px;font-weight:700;cursor:pointer;transition:all .2s;letter-spacing:.3px;margin-top:8px}
.launch-btn:hover{background:#6b57ee;transform:translateY(-1px);box-shadow:0 4px 20px rgba(124,106,255,.4)}
.launch-btn:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none}
.launch-btn.running{background:#1e293b;border:1px solid var(--accent);color:var(--accent)}
/* task feed */
.task-feed{margin-top:20px;border-top:1px solid var(--border);padding-top:16px;flex:1;overflow-y:auto;min-height:0}
.tf-head{font-size:10px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;color:var(--muted);margin-bottom:10px;display:flex;align-items:center;justify-content:space-between}
.task-item{padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:8px;margin-bottom:8px;transition:border-color .2s}
.task-item.running{border-color:rgba(124,106,255,.4)}
.task-item.completed{border-color:rgba(34,197,94,.25)}
.task-item.failed{border-color:rgba(239,68,68,.25)}
.ti-top{display:flex;align-items:center;gap:8px;margin-bottom:3px}
.ti-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.ti-dot.todo{background:var(--muted)}
.ti-dot.in_progress{background:var(--accent);animation:blink 1s infinite}
.ti-dot.completed{background:#22c55e}
.ti-dot.failed{background:#ef4444}
.ti-title{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.ti-age{font-size:10px;color:var(--muted)}
.ti-status{font-size:10px;color:var(--muted)}
.empty-feed{font-size:12px;color:var(--muted);text-align:center;padding:20px 0}
@keyframes blink{0%,100%{opacity:.5}50%{opacity:1}}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.card{animation:fadeIn .2s ease both}
</style>
</head>
<body>
<div id="hdr">
  <div class="logo">
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><polygon points="9,1 17,5 17,13 9,17 1,13 1,5" stroke="#7c6aff" stroke-width="1.5" fill="rgba(124,106,255,.12)"/><circle cx="9" cy="9" r="2.5" fill="#7c6aff"/></svg>
    Proverbs Studio
  </div>
  <div class="sep"></div>
  <div class="cwd" id="cwd-badge">—</div>
  <div class="spacer"></div>
  <div class="badge" id="model-badge">—</div>
  <div class="badge" id="task-badge">0 tasks</div>
</div>
<div id="layout">
  <aside id="sidebar">
    <div class="s-head">Browse</div>
    <button class="cat-btn active" data-cat="all" onclick="filterCat('all')">
      All <span class="cnt" id="cnt-all">0</span>
    </button>
    <div style="height:8px"></div>
    <div class="s-head">Categories</div>
    <div id="cat-list"></div>
  </aside>
  <div id="main">
    <div id="search-bar">
      <input id="search" placeholder="Search scenarios..." oninput="doSearch(this.value)">
      <span id="count-label">0 scenarios</span>
    </div>
    <div id="grid"></div>
  </div>
</div>
<div id="detail">
  <div id="detail-left"></div>
  <div id="detail-right"></div>
</div>
<script>
(function(){
var APP = ${data};
var scenarios = APP.scenarios;
var catMeta   = APP.categories;
var config    = APP.config;
var activeCat = 'all';
var searchQ   = '';
var fieldValues = {};

document.getElementById('cwd-badge').textContent = config.cwd;
document.getElementById('model-badge').textContent = config.model;

// Build category nav
var catList = document.getElementById('cat-list');
Object.entries(catMeta).forEach(function(e){
  var key = e[0], meta = e[1];
  var btn = document.createElement('button');
  btn.className = 'cat-btn';
  btn.dataset.cat = key;
  btn.style.setProperty('--hover-c', meta.color);
  btn.onclick = function(){ filterCat(key); };
  btn.innerHTML = '<span style="display:flex;align-items:center;gap:8px"><span style="width:8px;height:8px;border-radius:50%;background:' + meta.color + ';flex-shrink:0"></span>' + meta.label + '</span><span class="cnt" id="cnt-' + key + '">' + meta.count + '</span>';
  catList.appendChild(btn);
});
document.getElementById('cnt-all').textContent = scenarios.length;

function filtered(){
  return scenarios.filter(function(s){
    var matchCat = activeCat === 'all' || s.category === activeCat;
    var q = searchQ.toLowerCase();
    var matchQ = !q || s.title.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.tags.some(function(t){ return t.toLowerCase().includes(q); });
    return matchCat && matchQ;
  });
}

function renderGrid(){
  var list = filtered();
  var grid = document.getElementById('grid');
  document.getElementById('count-label').textContent = list.length + ' scenario' + (list.length===1?'':'s');
  grid.innerHTML = '';
  list.forEach(function(s, i){
    var meta = catMeta[s.category] || { color: '#7c6aff', glow: 'rgba(124,106,255,0.3)' };
    var card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = '--c:' + meta.color + ';--cr:' + hexToRgb(meta.color) + ';animation-delay:' + (i*0.02) + 's';
    card.onclick = function(){ openDetail(s); };
    card.innerHTML = '<div class="card-icon">' + s.icon + '</div>' +
      '<div class="card-title">' + esc(s.title) + '</div>' +
      '<div class="card-desc">' + esc(s.description) + '</div>' +
      '<div class="card-tags">' + s.tags.map(function(t){ return '<span class="tag">' + esc(t) + '</span>'; }).join('') + '</div>' +
      '<div class="card-foot"><span class="cat-dot"></span><span class="card-cta">Start Building →</span></div>';
    grid.appendChild(card);
  });
}

function filterCat(cat){
  activeCat = cat;
  document.querySelectorAll('.cat-btn').forEach(function(b){ b.classList.toggle('active', b.dataset.cat === cat); });
  renderGrid();
}

function doSearch(q){
  searchQ = q;
  renderGrid();
}
window.filterCat = filterCat;
window.doSearch  = doSearch;

function hexToRgb(hex){
  var r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return r + ',' + g + ',' + b;
}
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// Detail panel
function openDetail(scenario){
  var meta = catMeta[scenario.category] || { color:'#7c6aff', label:'General', glow:'' };
  fieldValues = {};
  scenario.fields.forEach(function(f){ fieldValues[f.id] = f.type === 'select' ? f.options[0] : ''; });

  // Left panel
  var left = document.getElementById('detail-left');
  left.innerHTML = '<button class="d-back" onclick="closeDetail()">← Back</button>' +
    '<span class="d-icon">' + scenario.icon + '</span>' +
    '<span class="d-cat" style="background:' + meta.color + '22;color:' + meta.color + ';border:1px solid ' + meta.color + '44">' + meta.label + '</span>' +
    '<div class="d-title">' + esc(scenario.title) + '</div>' +
    '<div class="d-desc">' + esc(scenario.description) + '</div>' +
    '<div class="d-section-head">What Proverbs will do</div>' +
    '<div class="d-steps">' + scenario.steps.map(function(s,i){
      return '<div class="d-step"><div class="d-step-num">' + (i+1) + '</div><div class="d-step-text">' + esc(s) + '</div></div>';
    }).join('') + '</div>';

  // Right panel
  var right = document.getElementById('detail-right');
  var fieldsHtml = scenario.fields.map(function(f){
    var input = '';
    if(f.type === 'select'){
      input = '<select class="r-select" data-field="' + f.id + '" onchange="setField(this)">' +
        f.options.map(function(o){ return '<option>' + esc(o) + '</option>'; }).join('') + '</select>';
    } else {
      input = '<input class="r-input" type="text" placeholder="' + esc(f.placeholder||'') + '" data-field="' + f.id + '" oninput="setField(this)">';
    }
    return '<div class="r-section"><label class="r-label">' + esc(f.label) + '</label>' + input + '</div>';
  }).join('');

  right.innerHTML = '<div style="font-size:11px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;color:var(--muted);margin-bottom:16px">Configure</div>' +
    fieldsHtml +
    '<div class="r-section"><label class="r-label">Working Directory</label><div class="cwd-display">' + esc(config.cwd) + '</div></div>' +
    '<button class="launch-btn" id="launch-btn" onclick="launch(\'' + scenario.id + '\')">▶ Start Building</button>' +
    '<div class="task-feed"><div class="tf-head"><span>Live Tasks</span><span id="tf-count"></span></div><div id="tf-list"><div class="empty-feed">No tasks yet</div></div></div>';

  document.getElementById('detail').classList.add('open');
  pollTasks();
}
window.setField = function(el){ fieldValues[el.dataset.field] = el.value; };

function closeDetail(){
  document.getElementById('detail').classList.remove('open');
  if(pollTimer){ clearInterval(pollTimer); pollTimer = null; }
}
window.closeDetail = closeDetail;

window.launch = function(scenarioId){
  var scenario = scenarios.find(function(s){ return s.id === scenarioId; });
  if(!scenario) return;
  var btn = document.getElementById('launch-btn');
  btn.disabled = true; btn.textContent = '⟳ Queuing...'; btn.classList.add('running');
  var prompt = scenario.prompt;
  Object.keys(fieldValues).forEach(function(k){
    var val = fieldValues[k] || ('(unspecified ' + k + ')');
    prompt = prompt.split('{' + k + '}').join(val);
  });
  // Also set any unfilled fields
  prompt = prompt.replace(/\{[a-z_]+\}/g, '');
  fetch('/api/launch', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ title: scenario.title, prompt: prompt }) })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(d.taskId){
        btn.textContent = '✓ Running — task ' + d.taskId.slice(0,6);
        btn.disabled = false; btn.classList.remove('running');
        btn.style.background = '#0f3020';
        btn.style.borderColor = '#22c55e';
        btn.style.color = '#22c55e';
      }
    })
    .catch(function(){ btn.textContent = '✗ Failed to connect'; btn.disabled = false; btn.classList.remove('running'); });
};

var pollTimer = null;
function pollTasks(){
  if(pollTimer) clearInterval(pollTimer);
  renderTaskFeed();
  pollTimer = setInterval(renderTaskFeed, 2000);
}

function renderTaskFeed(){
  fetch('/api/tasks').then(function(r){ return r.json(); }).then(function(tasks){
    var badge = document.getElementById('task-badge');
    var running = tasks.filter(function(t){ return t.status === 'in_progress'; }).length;
    badge.textContent = tasks.length + ' task' + (tasks.length===1?'':'s');
    badge.className = 'badge' + (running > 0 ? ' active' : '');
    var list = document.getElementById('tf-list');
    if(!list) return;
    if(!tasks.length){ list.innerHTML = '<div class="empty-feed">No tasks yet</div>'; return; }
    var recent = tasks.slice().reverse().slice(0, 8);
    list.innerHTML = recent.map(function(t){
      var age = timeAgo(t.updatedAt || t.createdAt);
      return '<div class="task-item ' + t.status + '">' +
        '<div class="ti-top"><div class="ti-dot ' + t.status + '"></div><div class="ti-title">' + esc(t.title) + '</div><div class="ti-age">' + age + '</div></div>' +
        '<div class="ti-status">' + t.status.replace('_',' ') + '</div>' +
        '</div>';
    }).join('');
  }).catch(function(){});
}

function timeAgo(iso){
  if(!iso) return '';
  var sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if(sec < 10) return 'just now';
  if(sec < 60) return sec + 's ago';
  if(sec < 3600) return Math.floor(sec/60) + 'm ago';
  return Math.floor(sec/3600) + 'h ago';
}

renderGrid();
})();
</script>
</body>
</html>`;
}

function startStudioServer(port) {
  if (studioServer) { console.log(colorize(C.yellow, '\n  Studio already running on port ' + studioPort + '\n')); return; }
  studioPort = port || studioPort;
  const _http = require('http');
  studioServer = _http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      const html = getStudioHtml({ cwd, model, port: studioPort });
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); return;
    }
    if (req.method === 'GET' && req.url === '/api/tasks') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(taskStore)); return;
    }
    if (req.method === 'GET' && req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ running: true, model, cwd, tasks: taskStore.length })); return;
    }
    if (req.method === 'POST' && req.url === '/api/launch') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        let data = {};
        try { data = JSON.parse(body); } catch (_) { res.writeHead(400); res.end(JSON.stringify({ error: 'bad json' })); return; }
        if (!data.prompt) { res.writeHead(400); res.end(JSON.stringify({ error: 'prompt required' })); return; }
        const task = taskCreate(data.title || data.prompt.slice(0, 60), data.prompt);
        res.writeHead(202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ taskId: task.id, status: 'queued' }));
        taskUpdate(task.id, { status: 'in_progress' });
        try {
          const reply = await agentLoop([{ role: 'system', content: buildSystemPrompt() }, { role: 'user', content: data.prompt }]);
          taskUpdate(task.id, { status: 'completed', output: reply });
          notify(data.title || 'Studio task', 'Completed');
          console.log(colorize(C.greenBold, '\n[studio:' + task.id + '] ') + renderResponse(reply) + '\n');
        } catch (e) {
          taskUpdate(task.id, { status: 'failed', output: e.message });
          notify('Studio task failed', e.message);
        }
        rl.prompt();
      }); return;
    }
    res.writeHead(404); res.end('Not found');
  });
  studioServer.listen(studioPort, '127.0.0.1', () => {
    const url = 'http://localhost:' + studioPort;
    console.log(colorize(C.greenBold, '\n✔  Proverbs Studio at ') + colorize(C.cyan, url) + '\n');
    try {
      const _opener = process.platform === 'win32' ? 'start ""'
                    : process.platform === 'darwin' ? 'open' : 'xdg-open';
      require('child_process').execSync(_opener + ' ' + JSON.stringify(url),
        { stdio: 'ignore', shell: process.platform === 'win32' });
    } catch (_) {}
  });
  studioServer.on('error', e => { console.log(colorize(C.red, '\n✗  Studio error: ' + e.message + '\n')); studioServer = null; });
}

function stopStudioServer() {
  if (!studioServer) return false;
  studioServer.close(); studioServer = null; return true;
}

// ── Proverbs IDE — VS Code-style browser interface ───────────────────────────
let _ideServer = null;
let _idePort   = 4400;
let _ideHistory = [];   // shared with main history (reference updated on /clear)

function startIDEServer(port) {
  if (_ideServer) {
    console.log(colorize(C.yellow, `\n  IDE already running at http://localhost:${_idePort}\n`));
    return;
  }
  _idePort = port || _idePort;

  let express2;
  try { express2 = require('express'); } catch (_) {
    console.log(colorize(C.red, '\n✗  Express not installed. Run: npm install\n'));
    return;
  }

  const app2 = express2();
  app2.use(express2.json({ limit: '5mb' }));

  // ── File tree
  app2.get('/api/files', (req, res) => {
    const dir = path.resolve(req.query.path || cwd);
    const SKIP = new Set(['node_modules','.git','__pycache__','.next','dist','build','.cache','venv','venv_llm','.venv','coverage']);
    function walk(d, depth) {
      if (depth > 3) return [];
      let entries = [];
      try {
        for (const f of fs.readdirSync(d)) {
          if (f.startsWith('.') && f !== '.proverbs') continue;
          const fp = path.join(d, f);
          let st; try { st = fs.statSync(fp); } catch (_) { continue; }
          if (st.isDirectory()) {
            if (SKIP.has(f)) continue;
            entries.push({ name: f, path: fp, type: 'dir', children: walk(fp, depth+1) });
          } else {
            entries.push({ name: f, path: fp, type: 'file', size: st.size });
          }
        }
      } catch (_) {}
      return entries.sort((a,b) => (a.type==='dir'?0:1)-(b.type==='dir'?0:1) || a.name.localeCompare(b.name));
    }
    res.json({ root: dir, tree: walk(dir, 0) });
  });

  // ── Read file
  app2.get('/api/file', (req, res) => {
    const fp = path.resolve(req.query.path || '');
    try {
      const content = fs.readFileSync(fp, 'utf8');
      res.json({ path: fp, content, size: content.length });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ── Write file
  app2.post('/api/file', (req, res) => {
    const { path: fp, content } = req.body;
    if (!fp) return res.status(400).json({ error: 'path required' });
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content, 'utf8');
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ── Git status + diff
  app2.get('/api/git/status', (req, res) => {
    try {
      const out = require('child_process').execSync('git status --short', { cwd, encoding:'utf8', timeout:5000 });
      res.json({ output: out });
    } catch (e) { res.json({ output: '' }); }
  });

  app2.get('/api/git/diff', (req, res) => {
    try {
      const out = require('child_process').execSync('git diff HEAD', { cwd, encoding:'utf8', maxBuffer:500000, timeout:5000 });
      res.json({ output: out });
    } catch (e) { res.json({ output: '' }); }
  });

  // ── Run bash
  app2.post('/api/run', (req, res) => {
    const { cmd } = req.body;
    if (!cmd) return res.status(400).json({ error: 'cmd required' });
    try {
      const out = require('child_process').execSync(cmd, { cwd, encoding:'utf8', maxBuffer:200000, timeout:15000 });
      res.json({ output: out });
    } catch (e) { res.json({ output: e.message, exitCode: e.status || 1 }); }
  });

  // ── Chat history
  app2.get('/api/history', (req, res) => {
    res.json({ history: _ideHistory, model, cwd });
  });

  // ── Chat — SSE streaming
  app2.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (evt, data) => res.write(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`);
    send('start', { model, cwd });
    try {
      const msgs = [{ role:'system', content: buildSystemPrompt() }, ..._ideHistory, { role:'user', content: message }];
      // Stream via chunk events
      const fullReply = await agentLoop(msgs);
      _ideHistory.push({ role:'user', content: message });
      _ideHistory.push({ role:'assistant', content: fullReply });
      lastAssistantReply = fullReply;
      send('message', { content: fullReply });
      send('done', {});
    } catch (e) {
      send('error', { message: e.message });
    }
    res.end();
  });

  // ── Clear history
  app2.post('/api/clear', (req, res) => {
    _ideHistory = [];
    res.json({ ok: true });
  });

  // ── Models
  app2.get('/api/models', async (req, res) => {
    try {
      const r = await httpGet(OLLAMA_BASE + '/api/tags');
      res.json(r.data || { models: [] });
    } catch (_) { res.json({ models: [] }); }
  });

  // ── Main IDE HTML
  app2.get('/', (req, res) => { res.send(getIDEHtml()); });

  _ideServer = app2.listen(_idePort, '127.0.0.1', () => {
    const url = `http://localhost:${_idePort}`;
    console.log(colorize(C.greenBold, '\n✔  Proverbs IDE at ') + colorize(C.cyan, url) + '\n');
    try { require('child_process').exec(`open ${url}`); } catch (_) {}
  });
  _ideServer.on('error', e => { console.log(colorize(C.red, '\n✗  IDE error: ' + e.message + '\n')); _ideServer = null; });
}

function getIDEHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Proverbs IDE</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#1e1e1e;--sidebar-bg:#252526;--editor-bg:#1e1e1e;--term-bg:#1e1e1e;
  --border:#404040;--accent:#007acc;--accent2:#00e5a0;--text:#d4d4d4;
  --muted:#858585;--active:#37373d;--hover:#2a2d2e;--tab-active:#1e1e1e;
  --tab-inactive:#2d2d2d;--font:'Consolas','Courier New',monospace;
  --sidebar-w:240px;--titlebar-h:30px;--tab-h:35px;--term-h:320px;
}
html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#424242;border-radius:4px}::-webkit-scrollbar-thumb:hover{background:#555}

/* ── Title Bar */
#titlebar{height:var(--titlebar-h);background:#323233;display:flex;align-items:center;padding:0 12px;gap:8px;user-select:none;-webkit-app-region:drag;border-bottom:1px solid #252525}
#titlebar .logo{color:var(--accent2);font-weight:700;font-size:12px;letter-spacing:.5px;display:flex;align-items:center;gap:5px}
#titlebar .title{color:var(--muted);font-size:12px;flex:1;text-align:center}
#titlebar .controls{display:flex;gap:6px}
.ctrl-btn{width:12px;height:12px;border-radius:50%;border:none;cursor:pointer}
.ctrl-btn.close{background:#ff5f57}.ctrl-btn.min{background:#febc2e}.ctrl-btn.max{background:#28c840}

/* ── Activity Bar */
#actbar{width:48px;background:#333333;display:flex;flex-direction:column;align-items:center;padding-top:4px;gap:2px;border-right:1px solid var(--border);flex-shrink:0}
.act-icon{width:40px;height:40px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:2px;color:var(--muted);font-size:18px;transition:color .15s;position:relative}
.act-icon:hover,.act-icon.active{color:var(--text)}
.act-icon.active::before{content:'';position:absolute;left:0;top:50%;transform:translateY(-50%);width:2px;height:24px;background:var(--accent);border-radius:0 2px 2px 0}
.act-icon.active{color:var(--text)}

/* ── Layout */
#workbench{display:flex;flex-direction:column;height:calc(100% - var(--titlebar-h))}
#main-area{display:flex;flex:1;min-height:0}
#sidebar{width:var(--sidebar-w);background:var(--sidebar-bg);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0;overflow:hidden}
#sidebar-header{padding:8px 12px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;font-weight:600;flex-shrink:0}
#file-tree{flex:1;overflow-y:auto;padding:4px 0}
#editor-area{flex:1;display:flex;flex-direction:column;min-width:0}
#tabs{height:var(--tab-h);background:#2d2d2d;display:flex;align-items:flex-end;border-bottom:1px solid var(--border);overflow-x:auto;flex-shrink:0}
.tab{display:flex;align-items:center;gap:6px;padding:0 16px;height:calc(var(--tab-h) - 1px);background:var(--tab-inactive);border-right:1px solid var(--border);cursor:pointer;white-space:nowrap;color:var(--muted);font-size:12px;position:relative;min-width:0;max-width:180px;user-select:none}
.tab.active{background:var(--tab-active);color:var(--text)}
.tab .tab-name{overflow:hidden;text-overflow:ellipsis}
.tab .tab-close{width:16px;height:16px;display:flex;align-items:center;justify-content:center;border-radius:3px;opacity:0;font-size:11px;color:var(--muted);flex-shrink:0}
.tab:hover .tab-close,.tab.active .tab-close{opacity:1}
.tab .tab-close:hover{background:var(--active);color:var(--text)}
#editor-wrap{flex:1;position:relative;overflow:hidden;min-height:0}
#editor{width:100%;height:100%;background:var(--editor-bg);color:var(--text);font-family:var(--font);font-size:13px;line-height:1.6;border:none;outline:none;resize:none;padding:12px 16px;tab-size:2}
#line-nums{position:absolute;left:0;top:0;width:44px;background:var(--editor-bg);padding:12px 0;font-family:var(--font);font-size:13px;line-height:1.6;color:var(--muted);text-align:right;pointer-events:none;user-select:none;border-right:1px solid #303030;padding-right:6px}
#editor{padding-left:56px}
#editor-placeholder{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--muted);gap:12px;pointer-events:none}
#editor-placeholder .ph-icon{font-size:48px;opacity:.3}
#editor-placeholder .ph-text{font-size:13px;opacity:.5}

/* ── Terminal Panel */
#term-panel{height:var(--term-h);background:var(--term-bg);border-top:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0}
#term-topbar{height:28px;background:#252526;display:flex;align-items:center;padding:0 8px;gap:8px;border-bottom:1px solid var(--border);flex-shrink:0}
.term-tab{padding:4px 12px;font-size:11px;cursor:pointer;color:var(--muted);border-bottom:1px solid transparent}
.term-tab.active{color:var(--text);border-bottom-color:var(--accent)}
#term-actions{margin-left:auto;display:flex;gap:4px}
.term-action{background:none;border:none;color:var(--muted);cursor:pointer;padding:3px 6px;font-size:12px;border-radius:3px}
.term-action:hover{background:var(--hover);color:var(--text)}
#term-output{flex:1;overflow-y:auto;padding:8px 12px;font-family:var(--font);font-size:12px;line-height:1.7}
.t-user{color:#9cdcfe}.t-ai{color:#d4d4d4}.t-dim{color:var(--muted)}.t-prompt{color:var(--accent2)}.t-err{color:#f48771}.t-ok{color:#4ec9b0}
.t-line{margin:0;white-space:pre-wrap;word-break:break-word}
.t-thinking{color:var(--muted);font-style:italic;animation:blink 1s step-end infinite}
@keyframes blink{50%{opacity:0}}
#term-input-row{display:flex;align-items:center;padding:6px 12px;border-top:1px solid #2a2a2a;flex-shrink:0;gap:6px}
#term-prompt{color:var(--accent2);font-family:var(--font);font-size:12px;white-space:nowrap;flex-shrink:0}
#term-input{flex:1;background:transparent;border:none;outline:none;color:var(--text);font-family:var(--font);font-size:12px;caret-color:var(--accent2)}
#term-cursor{display:inline-block;width:7px;height:12px;background:var(--accent2);animation:blink .8s step-end infinite;vertical-align:text-bottom;margin-left:1px}

/* ── File tree items */
.fi{display:flex;align-items:center;gap:4px;padding:2px 8px 2px 0;cursor:pointer;user-select:none;white-space:nowrap;overflow:hidden;font-size:13px}
.fi:hover{background:var(--hover)}
.fi.selected{background:var(--active)}
.fi .icon{width:16px;height:16px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:13px}
.fi .label{overflow:hidden;text-overflow:ellipsis}
.fi .arrow{font-size:10px;color:var(--muted);width:10px;flex-shrink:0}
.dir-children{display:none}.dir-children.open{display:block}

/* ── Autocomplete popup */
#autocomplete{position:absolute;background:#252526;border:1px solid var(--border);border-radius:4px;max-width:280px;z-index:100;display:none;font-family:var(--font);font-size:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.5)}
.ac-item{padding:5px 12px;cursor:pointer;color:var(--text)}
.ac-item:hover,.ac-item.selected{background:var(--active);color:var(--accent2)}
.ac-item .ac-cmd{color:var(--accent2)}.ac-item .ac-desc{color:var(--muted);font-size:11px;margin-left:6px}

/* ── Status bar */
#statusbar{height:22px;background:#007acc;display:flex;align-items:center;padding:0 8px;gap:12px;font-size:11px;flex-shrink:0}
.sb-item{color:rgba(255,255,255,.85);display:flex;align-items:center;gap:4px;cursor:pointer}
.sb-item:hover{color:#fff}
#statusbar-right{margin-left:auto;display:flex;gap:12px}

/* ── Resize handle */
#resize-handle{height:4px;background:transparent;cursor:row-resize;flex-shrink:0}
#resize-handle:hover{background:var(--accent)}

/* ── Overlay for disconnected */
#overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:200;align-items:center;justify-content:center;flex-direction:column;gap:12px}
#overlay.show{display:flex}
#overlay p{color:var(--text);font-size:14px}
#overlay button{background:var(--accent);color:#fff;border:none;padding:8px 20px;border-radius:4px;cursor:pointer;font-size:13px}

/* ── Git panel */
#git-panel{display:none;padding:8px 0}
.git-file{padding:3px 12px;cursor:pointer;display:flex;gap:6px;font-size:12px}
.git-file:hover{background:var(--hover)}
.git-status{width:14px;font-weight:700}
.git-status.M{color:#e2c08d}.git-status.A{color:#73c991}.git-status.D{color:#f48771}.git-status.?{color:var(--muted)}
</style>
</head>
<body>

<!-- Title Bar -->
<div id="titlebar">
  <div class="logo">&#9679; Proverbs</div>
  <div class="title" id="title-text">Proverbs IDE</div>
  <div class="controls">
    <button class="ctrl-btn close" title="Stop server" onclick="fetch('/api/clear',{method:'POST'})"></button>
    <button class="ctrl-btn min"></button>
    <button class="ctrl-btn max"></button>
  </div>
</div>

<div id="workbench">
  <div id="main-area">
    <!-- Activity Bar -->
    <div id="actbar">
      <div class="act-icon active" id="act-explorer" title="Explorer" onclick="setPanel('explorer')">&#128193;</div>
      <div class="act-icon" id="act-git" title="Source Control" onclick="setPanel('git')">&#9883;</div>
      <div class="act-icon" id="act-search" title="Search" onclick="setPanel('search')">&#128269;</div>
    </div>

    <!-- Sidebar -->
    <div id="sidebar">
      <div id="sidebar-header" id="panel-title">Explorer</div>

      <!-- Explorer panel -->
      <div id="explorer-panel">
        <div id="file-tree"></div>
      </div>

      <!-- Git panel -->
      <div id="git-panel"></div>

      <!-- Search panel -->
      <div id="search-panel" style="display:none;padding:8px">
        <input id="search-input" placeholder="Search files..." style="width:100%;background:#3c3c3c;border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:3px;font-size:12px;outline:none"/>
        <div id="search-results" style="margin-top:6px;font-size:12px"></div>
      </div>
    </div>

    <!-- Editor Area -->
    <div id="editor-area">
      <div id="tabs"></div>
      <div id="editor-wrap">
        <div id="editor-placeholder">
          <div class="ph-icon">&#128218;</div>
          <div class="ph-text">Open a file from the explorer, or type a message in the terminal below</div>
        </div>
        <div id="line-nums"></div>
        <textarea id="editor" style="display:none" spellcheck="false" oninput="onEditorChange()" onscroll="syncLineNums()"></textarea>
      </div>
    </div>
  </div>

  <!-- Resize handle -->
  <div id="resize-handle" onmousedown="startResize(event)"></div>

  <!-- Terminal Panel -->
  <div id="term-panel">
    <div id="term-topbar">
      <div class="term-tab active">Terminal</div>
      <div class="term-tab" onclick="showGitDiff()" style="cursor:pointer">Diff</div>
      <div id="term-actions">
        <button class="term-action" title="Clear terminal" onclick="clearTerm()">&#10005;</button>
        <button class="term-action" title="Maximize terminal" onclick="toggleTermMax()">&#8661;</button>
      </div>
    </div>
    <div id="term-output">
      <p class="t-line t-dim">Proverbs IDE — type to chat with AI. Use / for slash commands.</p>
      <p class="t-line t-dim">&nbsp;</p>
    </div>
    <div id="autocomplete"></div>
    <div id="term-input-row">
      <span id="term-prompt">proverbs&gt;&nbsp;</span>
      <input id="term-input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Ask anything, or type / for commands..." />
    </div>
  </div>

  <!-- Status Bar -->
  <div id="statusbar">
    <div class="sb-item" id="sb-branch">&#9135; loading...</div>
    <div class="sb-item" id="sb-model" onclick="promptModel()">&#129302; ...</div>
    <div id="statusbar-right">
      <div class="sb-item" id="sb-cwd">&#128193; ...</div>
      <div class="sb-item" id="sb-turns">0 turns</div>
    </div>
  </div>
</div>

<div id="overlay">
  <p>Connection lost. Proverbs server stopped?</p>
  <button onclick="location.reload()">Reconnect</button>
</div>

<script>
// ── State
let openTabs = [];       // [{path, name, content, dirty}]
let activeTab = null;
let cmdHistory = [];
let historyIdx = -1;
let sidePanel = 'explorer';
let termMaximized = false;
let autoSaveTimer = null;

// ── ANSI color helpers (strip from AI output for terminal)
function stripAnsi(s) { return s.replace(/\\x1b\\[[0-9;]*m/g,''); }
function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Slash commands list (for autocomplete)
const SLASH_CMDS = [
  ['/help','Show all commands'],['/clear','Clear conversation'],
  ['/aside','Quick side question'],['/review','Code review of current diff'],
  ['/usage','Session stats'],['/export','Export conversation'],
  ['/recap','One-line session summary'],['/check','System diagnostic'],
  ['/remember','Save a project fact'],['/facts','List project facts'],
  ['/branch','Save conversation branch'],['/goal','Work until goal met'],
  ['/effort','Set reasoning depth'],['/rewind','Undo last N turns'],
  ['/init','Generate .proverbs profile'],['/scan','Scan project'],
  ['/rag','Semantic code search'],['/index','Index project files'],
  ['/diff','Toggle diff preview'],['/tree','Show file tree'],
  ['/git status','Git status'],['/git diff','Git diff'],
  ['/git log','Git log'],['/git commit','Git commit'],
  ['/train status','Training status'],['/train local','Train model'],
  ['/train tokenizer','Train tokenizer'],['/train embed','Train embeddings'],
  ['/model','Switch model'],['/backend','Switch backend'],['/cloud','Claude API key & mode'],
  ['/server start','Start inference server'],['/server stop','Stop server'],
  ['/preview','Preview built app in a separate window'],
  ['/profile','Performance stats'],['/compress','Compress history'],
  ['/security','Security audit'],['/fork','Run sub-task'],
];

// ── Init
async function init() {
  await loadFileTree();
  await loadHistory();
  await loadGitBranch();
  await loadModels();
  document.getElementById('term-input').focus();
}

// ── File Tree
async function loadFileTree(dirPath) {
  const r = await api('/api/files' + (dirPath ? '?path='+encodeURIComponent(dirPath) : ''));
  document.getElementById('file-tree').innerHTML = renderTree(r.tree, 0);
  document.title = 'Proverbs IDE — ' + r.root.split('/').pop();
  document.getElementById('sb-cwd').textContent = '\\uD83D\\uDCC1 ' + r.root.split('/').pop();
  document.getElementById('title-text').textContent = r.root;
}

function renderTree(nodes, depth) {
  return nodes.map(n => {
    const pad = depth * 14;
    if (n.type === 'dir') {
      const icon = n.children.length ? '\\u25B6' : '\\u25B6';
      return \`<div class="fi" style="padding-left:\${8+pad}px" onclick="toggleDir(this,'\${escHtml(n.path)}',\${depth})" title="\${escHtml(n.path)}">
        <span class="arrow" id="arr-\${btoa(n.path).slice(0,8)}">\${icon}</span>
        <span class="icon">\\uD83D\\uDCC1</span>
        <span class="label">\${escHtml(n.name)}</span>
      </div>
      <div class="dir-children" id="ch-\${btoa(n.path).slice(0,8)}">\${n.children.length ? renderTree(n.children, depth+1) : ''}</div>\`;
    } else {
      const ico = fileIcon(n.name);
      return \`<div class="fi" style="padding-left:\${8+pad+10}px" onclick="openFile('\${escHtml(n.path)}')" title="\${escHtml(n.path)}">
        <span class="icon">\${ico}</span>
        <span class="label">\${escHtml(n.name)}</span>
      </div>\`;
    }
  }).join('');
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = {js:'\\uD83D\\uDFE1',ts:'\\uD83D\\uDFE6',jsx:'\\uD83D\\uDFE1',tsx:'\\uD83D\\uDFE6',py:'\\uD83D\\uDFEB',
                json:'\\uD83D\\uDFEE',md:'\\uD83D\\uDCDD',css:'\\uD83D\\uDFE3',html:'\\uD83D\\uDFE5',
                sh:'\\u2699\\uFE0F',gitignore:'\\uD83D\\uDEAB',env:'\\uD83D\\uDD10',
                sql:'\\uD83D\\uDDC4\\uFE0F',yml:'\\uD83D\\uDCCB',yaml:'\\uD83D\\uDCCB'};
  return map[ext] || '\\uD83D\\uDCC4';
}

async function toggleDir(el, dirPath, depth) {
  const key = btoa(dirPath).slice(0,8);
  const ch = document.getElementById('ch-'+key);
  const arr = document.getElementById('arr-'+key) || el.querySelector('.arrow');
  if (!ch) return;
  const open = ch.classList.toggle('open');
  if (arr) arr.style.transform = open ? 'rotate(90deg)' : '';
  if (open && !ch.dataset.loaded) {
    const r = await api('/api/files?path='+encodeURIComponent(dirPath));
    ch.innerHTML = renderTree(r.tree, depth+1);
    ch.dataset.loaded = '1';
  }
}

async function openFile(fp) {
  document.querySelectorAll('.fi').forEach(el => el.classList.remove('selected'));
  // Mark selected
  const idx2 = openTabs.findIndex(t => t.path === fp);
  if (idx2 >= 0) { activateTab(idx2); return; }
  try {
    const r = await api('/api/file?path='+encodeURIComponent(fp));
    const tab = { path: fp, name: fp.split('/').pop(), content: r.content, dirty: false };
    openTabs.push(tab);
    renderTabs();
    activateTab(openTabs.length - 1);
    termPrint(\`<span class="t-dim">Opened: \${fp.split('/').slice(-2).join('/')}</span>\`);
  } catch (e) { termPrint(\`<span class="t-err">Cannot open: \${e.message}</span>\`); }
}

function renderTabs() {
  const tabsEl = document.getElementById('tabs');
  tabsEl.innerHTML = openTabs.map((t,i) => \`
    <div class="tab \${i===activeTab?'active':''}" onclick="activateTab(\${i})">
      <span class="tab-name">\${escHtml(t.name)}\${t.dirty?'&nbsp;●':''}</span>
      <span class="tab-close" onclick="event.stopPropagation();closeTab(\${i})">\\u2715</span>
    </div>\`).join('');
}

function activateTab(i) {
  activeTab = i;
  renderTabs();
  const tab = openTabs[i];
  if (!tab) { showPlaceholder(); return; }
  const ed = document.getElementById('editor');
  const ph = document.getElementById('editor-placeholder');
  ed.style.display = 'block'; ph.style.display = 'none';
  ed.value = tab.content;
  updateLineNums();
  document.getElementById('title-text').textContent = tab.path;
}

function showPlaceholder() {
  document.getElementById('editor').style.display = 'none';
  document.getElementById('editor-placeholder').style.display = 'flex';
}

function closeTab(i) {
  if (openTabs[i] && openTabs[i].dirty) {
    if (!confirm('Unsaved changes in ' + openTabs[i].name + '. Close anyway?')) return;
  }
  openTabs.splice(i,1);
  if (activeTab >= openTabs.length) activeTab = openTabs.length - 1;
  renderTabs();
  if (activeTab >= 0) activateTab(activeTab); else showPlaceholder();
}

function onEditorChange() {
  if (activeTab < 0 || !openTabs[activeTab]) return;
  openTabs[activeTab].content = document.getElementById('editor').value;
  openTabs[activeTab].dirty = true;
  renderTabs();
  updateLineNums();
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(saveCurrentFile, 2000);
}

async function saveCurrentFile() {
  if (activeTab < 0 || !openTabs[activeTab]) return;
  const tab = openTabs[activeTab];
  if (!tab.dirty) return;
  await api('/api/file', 'POST', { path: tab.path, content: tab.content });
  tab.dirty = false;
  renderTabs();
  document.getElementById('sb-model').style.color = '';
}

function updateLineNums() {
  const ed = document.getElementById('editor');
  const lines = ed.value.split('\\n').length;
  document.getElementById('line-nums').textContent = Array.from({length:lines},(_,i)=>i+1).join('\\n');
}

function syncLineNums() {
  document.getElementById('line-nums').scrollTop = document.getElementById('editor').scrollTop;
}

// Ctrl+S to save
document.addEventListener('keydown', e => {
  if ((e.metaKey||e.ctrlKey) && e.key==='s') { e.preventDefault(); saveCurrentFile(); }
});

// ── Terminal
function termPrint(html) {
  const out = document.getElementById('term-output');
  const p = document.createElement('p');
  p.className = 't-line';
  p.innerHTML = html;
  out.appendChild(p);
  out.scrollTop = out.scrollHeight;
  return p;
}

function clearTerm() {
  document.getElementById('term-output').innerHTML = '<p class="t-line t-dim">Terminal cleared.</p>';
}

async function loadHistory() {
  const r = await api('/api/history');
  document.getElementById('sb-model').textContent = '\\uD83E\\uDD16 ' + r.model;
  document.getElementById('sb-turns').textContent = Math.floor(r.history.length/2) + ' turns';
  if (r.history.length > 0) {
    termPrint('<span class="t-dim">Resumed session — ' + Math.floor(r.history.length/2) + ' previous turns.</span>');
  }
}

async function loadGitBranch() {
  try {
    const r = await fetch('/api/run', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd:'git branch --show-current'})});
    const d = await r.json();
    document.getElementById('sb-branch').textContent = '\\u2387 ' + (d.output||'').trim() || 'main';
  } catch(_) { document.getElementById('sb-branch').textContent = '\\u2387 main'; }
}

async function loadModels() {
  try {
    const r = await api('/api/models');
    if (r.models && r.models.length) {
      // already set from /api/history
    }
  } catch(_){}
}

// ── Terminal input
const termInput = document.getElementById('term-input');

termInput.addEventListener('keydown', async e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const val = termInput.value.trim();
    if (!val) return;
    cmdHistory.unshift(val); historyIdx = -1;
    termInput.value = '';
    hideAutocomplete();
    await handleTermInput(val);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (historyIdx < cmdHistory.length - 1) {
      historyIdx++;
      termInput.value = cmdHistory[historyIdx] || '';
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (historyIdx > 0) { historyIdx--; termInput.value = cmdHistory[historyIdx]; }
    else { historyIdx = -1; termInput.value = ''; }
  } else if (e.key === 'Tab') {
    e.preventDefault();
    const ac = document.querySelectorAll('.ac-item');
    if (ac.length > 0) {
      const sel = document.querySelector('.ac-item.selected') || ac[0];
      termInput.value = sel.dataset.cmd + ' ';
      hideAutocomplete();
    }
  } else if (e.key === 'Escape') {
    hideAutocomplete();
  }
});

termInput.addEventListener('input', () => {
  const val = termInput.value;
  if (val.startsWith('/')) showAutocomplete(val);
  else hideAutocomplete();
});

function showAutocomplete(val) {
  const matches = SLASH_CMDS.filter(([cmd]) => cmd.startsWith(val));
  if (!matches.length) { hideAutocomplete(); return; }
  const ac = document.getElementById('autocomplete');
  ac.innerHTML = matches.slice(0,8).map(([cmd,desc],i) =>
    \`<div class="ac-item \${i===0?'selected':''}" data-cmd="\${cmd}" onclick="selectAcItem('\${cmd}')">
      <span class="ac-cmd">\${escHtml(cmd)}</span><span class="ac-desc">\${escHtml(desc)}</span>
    </div>\`).join('');
  const row = document.getElementById('term-input-row');
  const rect = row.getBoundingClientRect();
  ac.style.display = 'block';
  ac.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
  ac.style.left = '48px';
}

function selectAcItem(cmd) {
  termInput.value = cmd + ' ';
  hideAutocomplete();
  termInput.focus();
}

function hideAutocomplete() { document.getElementById('autocomplete').style.display = 'none'; }

async function handleTermInput(input) {
  termPrint(\`<span class="t-prompt">proverbs&gt;</span> <span class="t-user">\${escHtml(input)}</span>\`);

  // Local slash commands handled in browser
  if (input === '/clear') {
    await fetch('/api/clear', {method:'POST'});
    clearTerm();
    document.getElementById('sb-turns').textContent = '0 turns';
    return;
  }
  if (input === '/help') {
    const lines = SLASH_CMDS.map(([c,d]) => \`  <span class="t-prompt">\${c}</span>  <span class="t-dim">\${d}</span>\`).join('\\n');
    termPrint(\`<span class="t-ok">Available commands:</span>\\n\${lines}\`);
    return;
  }
  if (input.startsWith('/open ')) {
    const fp = input.slice(6).trim();
    await openFile(fp); return;
  }

  // Send to server
  const thinking = termPrint('<span class="t-thinking">proverbs is thinking...</span>');
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({message: input})
    });
    if (!r.ok) throw new Error('Server error ' + r.status);

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let reply = '';
    let replyEl = null;

    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      const parts = buf.split('\\n\\n');
      buf = parts.pop();
      for (const part of parts) {
        const lines = part.split('\\n');
        let evt = 'message', data = '';
        for (const l of lines) {
          if (l.startsWith('event: ')) evt = l.slice(7);
          if (l.startsWith('data: ')) { try { data = JSON.parse(l.slice(6)); } catch(_) {} }
        }
        if (evt === 'message' && data.content) {
          reply = data.content;
          thinking.remove();
          if (!replyEl) {
            replyEl = termPrint(\`<span class="t-ai">\${escHtml(stripAnsi(reply))}</span>\`);
          } else {
            replyEl.innerHTML = \`<span class="t-ai">\${escHtml(stripAnsi(reply))}</span>\`;
          }
        } else if (evt === 'done') {
          if (!replyEl) { thinking.remove(); termPrint(\`<span class="t-dim">(no reply)</span>\`); }
          // Update turns count
          const h = await api('/api/history');
          document.getElementById('sb-turns').textContent = Math.floor(h.history.length/2) + ' turns';
        } else if (evt === 'error') {
          thinking.remove();
          termPrint(\`<span class="t-err">Error: \${escHtml(data.message||'unknown')}</span>\`);
        }
      }
    }
  } catch (e) {
    thinking.remove();
    termPrint(\`<span class="t-err">Connection error: \${escHtml(e.message)}</span>\`);
    document.getElementById('overlay').classList.add('show');
  }
}

// ── Panel switcher
function setPanel(name) {
  sidePanel = name;
  document.querySelectorAll('.act-icon').forEach(el => el.classList.remove('active'));
  document.getElementById('act-'+name)?.classList.add('active');
  document.getElementById('explorer-panel').style.display = name==='explorer'?'':'none';
  document.getElementById('git-panel').style.display = name==='git'?'block':'none';
  document.getElementById('search-panel').style.display = name==='search'?'block':'none';
  const titles = {explorer:'Explorer',git:'Source Control',search:'Search'};
  document.getElementById('sidebar-header').textContent = titles[name]||name;
  if (name==='git') loadGitStatus();
}

async function loadGitStatus() {
  const r = await api('/api/git/status');
  const lines = (r.output||'').trim().split('\\n').filter(Boolean);
  document.getElementById('git-panel').innerHTML = lines.length
    ? lines.map(l => {
        const s = l[0]==='?' ? '?' : l[0]||' ';
        const fp = l.slice(3).trim();
        return \`<div class="git-file"><span class="git-status \${s}">\${s}</span><span>\${escHtml(fp)}</span></div>\`;
      }).join('')
    : '<p style="padding:8px 12px;color:var(--muted);font-size:12px">No changes</p>';
}

async function showGitDiff() {
  const r = await api('/api/git/diff');
  clearTerm();
  termPrint('<span class="t-ok">── git diff ──</span>');
  if (!r.output?.trim()) { termPrint('<span class="t-dim">No changes.</span>'); return; }
  const lines = r.output.split('\\n').slice(0,200);
  for (const l of lines) {
    const col = l.startsWith('+')?'color:#4ec9b0':l.startsWith('-')?'color:#f48771':l.startsWith('@@')?'color:#9cdcfe':'color:var(--muted)';
    termPrint(\`<span style="\${col}">\${escHtml(l)}</span>\`);
  }
}

// ── Terminal maximize toggle
function toggleTermMax() {
  const tp = document.getElementById('term-panel');
  const ea = document.getElementById('editor-area');
  const sb = document.getElementById('sidebar');
  termMaximized = !termMaximized;
  if (termMaximized) {
    tp.style.height = 'calc(100% - 52px)';
    ea.style.display = 'none'; sb.parentElement.style.display = 'none';
  } else {
    tp.style.height = '';
    ea.style.display = ''; sb.parentElement.style.display = '';
  }
}

// ── Resize handle
function startResize(e) {
  const startY = e.clientY;
  const startH = document.getElementById('term-panel').offsetHeight;
  function onMove(e) {
    const delta = startY - e.clientY;
    const newH = Math.max(80, Math.min(startH + delta, window.innerHeight - 120));
    document.getElementById('term-panel').style.height = newH + 'px';
    document.documentElement.style.setProperty('--term-h', newH + 'px');
  }
  function onUp() { document.removeEventListener('mousemove',onMove); document.removeEventListener('mouseup',onUp); }
  document.addEventListener('mousemove',onMove);
  document.addEventListener('mouseup',onUp);
}

// ── Search
document.getElementById('search-input')?.addEventListener('input', async function() {
  const q = this.value.trim();
  if (!q || q.length < 2) { document.getElementById('search-results').innerHTML=''; return; }
  try {
    const r = await fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd:\`grep -rn --include="*.js" --include="*.ts" --include="*.py" -l "\${q.replace(/"/g,'')}"\`})});
    const d = await r.json();
    const files = (d.output||'').trim().split('\\n').filter(Boolean).slice(0,20);
    document.getElementById('search-results').innerHTML = files.map(f =>
      \`<div class="fi" style="padding:3px 4px" onclick="openFile('\${escHtml(f.trim())}')">\${escHtml(f.split('/').pop())}<span style="color:var(--muted);font-size:10px;margin-left:4px">\${escHtml(f.split('/').slice(-3,-1).join('/'))}</span></div>\`
    ).join('') || '<p style="color:var(--muted)">No results</p>';
  } catch(_){}
});

// ── Model prompt
async function promptModel() {
  const m = prompt('Switch model (current: ' + document.getElementById('sb-model').textContent.replace('🤖 ','') + ')');
  if (m) await handleTermInput('/model ' + m);
}

// ── API helper
async function api(url, method='GET', body=null) {
  const opts = {method, headers:{'Content-Type':'application/json'}};
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(r.statusText);
  return r.json();
}

init();
</script>
</body>
</html>`;
}

// ── Feature 7: RAG — TF-IDF semantic codebase search ─────────────────────────
function ragTokenize(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !RAG_STOPWORDS.has(t));
}

function ragCollectFiles(dir, results, depth = 0) {
  // Depth + file caps keep deep monorepos from hanging the index build.
  if (depth > FIND_MAX_DEPTH || results.length >= RAG_MAX_CHUNKS * 4) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return; }

  for (const e of entries) {
    if (results.length >= RAG_MAX_CHUNKS * 4) return;
    if (e.name.startsWith('.') && e.name !== '.env') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!RAG_SKIP_DIRS.has(e.name)) ragCollectFiles(full, results, depth + 1);
    } else if (e.isFile()) {
      if (!RAG_SKIP_EXTS.has(path.extname(e.name).toLowerCase())) {
        results.push(full);
      }
    }
  }
}

function ragBuildIndex(rootDir) {
  const files = [];
  ragCollectFiles(rootDir, files);

  const chunks = [];

  for (const filePath of files) {
    if (chunks.length >= RAG_MAX_CHUNKS) break;
    let content;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (raw.includes('\0')) continue;
      content = raw;
    } catch (_) { continue; }

    const lines = content.split('\n');
    const step  = RAG_CHUNK_LINES - RAG_OVERLAP_LINES;

    for (let start = 0; start < lines.length; start += step) {
      if (chunks.length >= RAG_MAX_CHUNKS) break;
      const end  = Math.min(start + RAG_CHUNK_LINES, lines.length);
      const text = lines.slice(start, end).join('\n');
      if (!text.trim()) continue;
      const tokens = ragTokenize(text);
      if (tokens.length < 5) continue;
      chunks.push({ filePath, startLine: start + 1, endLine: end, text, tokens });
    }
  }

  const docFreq = {};
  for (const chunk of chunks) {
    const seen = new Set(chunk.tokens);
    for (const t of seen) {
      docFreq[t] = (docFreq[t] || 0) + 1;
    }
  }

  const totalDocs = chunks.length;

  for (const chunk of chunks) {
    const tf  = {};
    const len = chunk.tokens.length;
    for (const t of chunk.tokens) tf[t] = (tf[t] || 0) + 1;

    const vec = {};
    for (const [t, cnt] of Object.entries(tf)) {
      const idf = Math.log(totalDocs / (1 + (docFreq[t] || 0)));
      vec[t] = (cnt / len) * idf;
    }
    chunk.vec = vec;

    let mag = 0;
    for (const v of Object.values(vec)) mag += v * v;
    chunk.mag = Math.sqrt(mag);

    delete chunk.tokens;
  }

  return { cwd: rootDir, chunks, docFreq, totalDocs };
}

function ragEnsureIndex() {
  if (!_ragIndex || _ragIndex.cwd !== cwd) {
    _ragIndex = ragBuildIndex(cwd);
  }
  return _ragIndex;
}

function ragQuery(query, maxResults) {
  const idx    = ragEnsureIndex();
  const qTokens = ragTokenize(query);

  if (qTokens.length === 0) return [];

  const qTf  = {};
  for (const t of qTokens) qTf[t] = (qTf[t] || 0) + 1;

  const qVec = {};
  let qMag   = 0;
  for (const [t, cnt] of Object.entries(qTf)) {
    const idf = Math.log(idx.totalDocs / (1 + (idx.docFreq[t] || 0)));
    const val = (cnt / qTokens.length) * idf;
    qVec[t] = val;
    qMag   += val * val;
  }
  qMag = Math.sqrt(qMag);

  if (qMag === 0) return [];

  const scored = idx.chunks.map(chunk => {
    if (chunk.mag === 0) return { chunk, score: 0 };
    let dot = 0;
    for (const [t, qv] of Object.entries(qVec)) {
      if (chunk.vec[t]) dot += qv * chunk.vec[t];
    }
    return { chunk, score: dot / (qMag * chunk.mag) };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).filter(s => s.score > 0);
}

async function toolSearchCodebase(args) {
  const query      = (args.query || '').trim();
  const maxResults = Math.min(parseInt(args.max_results, 10) || 5, 20);

  if (!query) return 'ERROR: query is required';

  // Try semantic embed index first; fall back to TF-IDF ragQuery
  let results = [];
  let usedEmbed = false;
  try {
    const embedResults = await embedQuery(query, maxResults);
    if (embedResults.length > 0) {
      results = embedResults;
      usedEmbed = true;
    }
  } catch (_) {}

  if (!usedEmbed) {
    try {
      results = ragQuery(query, maxResults);
    } catch (e) {
      return `ERROR building RAG index: ${e.message}`;
    }
  }

  if (results.length === 0) {
    return `No relevant chunks found for: "${query}"`;
  }

  const method = usedEmbed ? 'semantic' : 'tfidf';
  return results.map(({ chunk, score }, i) => {
    const rel  = path.relative(cwd, chunk.filePath) || chunk.filePath;
    const header = `[${i + 1}] ${rel}  lines ${chunk.startLine}–${chunk.endLine}  (score: ${score.toFixed(4)}, ${method})`;
    const body   = chunk.text.length > 1200 ? chunk.text.slice(0, 1200) + '\n...(truncated)' : chunk.text;
    return `${header}\n${'─'.repeat(60)}\n${body}`;
  }).join('\n\n');
}

// ── Semantic Embedding RAG ────────────────────────────────────────────────────

// ─── ONNX local embeddings (no Ollama required) ──────────────────────────────
var _xenovaPipe = null;
var _embedWarnedOnce = false;
async function _loadXenova() {
  if (_xenovaPipe) return _xenovaPipe;
  try {
    var xf = await import('@xenova/transformers');
    xf.env.cacheDir = path.join(PROVERBS_DIR, 'models', 'onnx');
    xf.env.allowRemoteModels = false;
    xf.env.allowLocalModels  = true;
    _xenovaPipe = await xf.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });
    return _xenovaPipe;
  } catch(e) { return null; }
}
async function getEmbedding(text) {
  // 1. Try ONNX/WASM — fully local, no Ollama needed
  try {
    var pipe = await _loadXenova();
    if (pipe) {
      var out = await pipe(text.slice(0, 512), { pooling: 'mean', normalize: true });
      return Array.from(out.data);
    }
  } catch(_) {}
  // 2. Fall back to Ollama embeddings endpoint
  try {
    var resp = await httpPost(OLLAMA_BASE + '/api/embeddings', { model: EMBED_MODEL, prompt: text.slice(0, 2000) });
    if (resp && Array.isArray(resp.embedding)) return resp.embedding;
  } catch(_) {}
  // 3. Zero vector (graceful degradation — semantic search will not work)
  if (!_embedWarnedOnce) {
    _embedWarnedOnce = true;
    console.log(colorize(C.yellow, '\n  ⚠  Embedding model unavailable — /embed index will be built with TF-IDF only (no semantic search).'));
    console.log(colorize(C.dim,    '     To enable semantic search, run: /server start  (loads ONNX model from cache)\n'));
  }
  return new Array(384).fill(0);
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

async function buildEmbedIndex(rootDir) {
  const RAG_SKIP = new Set(['node_modules','.git','dist','.next','build','.cache','coverage','out']);
  const RAG_SKIP_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.svg','.ico','.webp','.mp3','.mp4','.wav','.zip','.gz','.tar','.exe','.dll','.so','.dylib','.pdf','.lock','.woff','.woff2','.ttf']);
  const CHUNK_LINES = 40, OVERLAP = 8;
  const allFiles = [];
  function collectFiles(dir) {
    try { fs.readdirSync(dir, {withFileTypes:true}).forEach(e => {
      if (RAG_SKIP.has(e.name) || e.name.startsWith('.')) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) collectFiles(full);
      else if (!RAG_SKIP_EXTS.has(path.extname(e.name).toLowerCase())) allFiles.push(full);
    }); } catch(_) {}
  }
  collectFiles(rootDir);
  const chunks = [];
  for (const fp of allFiles.slice(0, 200)) {
    try {
      const lines = fs.readFileSync(fp,'utf8').split('\n');
      for (let i = 0; i < lines.length; i += CHUNK_LINES - OVERLAP) {
        const slice = lines.slice(i, i + CHUNK_LINES);
        if (slice.join('').trim()) chunks.push({ filePath: fp, startLine: i+1, endLine: Math.min(i+CHUNK_LINES, lines.length), text: slice.join('\n') });
      }
    } catch(_) {}
  }
  const vectors = [];
  for (let i = 0; i < chunks.length; i++) {
    if (i % 10 === 0) process.stdout.write('\r  Embedding ' + i + '/' + chunks.length + '...');
    vectors.push(await getEmbedding(chunks[i].text));
  }
  process.stdout.write('\n');
  const index = { cwd: rootDir, chunks, vectors };
  fs.writeFileSync(EMBED_INDEX_FILE, JSON.stringify(index), 'utf8');
  _embedIndex = index;
  return chunks.length;
}

async function embedQuery(query, maxResults) {
  if (!_embedIndex || _embedIndex.cwd !== cwd) {
    try { _embedIndex = JSON.parse(fs.readFileSync(EMBED_INDEX_FILE,'utf8')); } catch(_) {}
    if (!_embedIndex || _embedIndex.cwd !== cwd) return [];
  }
  const qvec = await getEmbedding(query);
  const scored = _embedIndex.chunks.map((chunk, i) => ({ chunk, score: cosineSim(qvec, _embedIndex.vectors[i]) }));
  return scored.sort((a,b) => b.score - a.score).slice(0, maxResults || 5);
}

// ─── whisper auto-installer ───────────────────────────────────────────────────
async function autoInstallWhisper() {
  var plat = process.platform;
  if (plat === 'darwin') {
    console.log(colorize(C.dim, '  Installing whisper.cpp via Homebrew...'));
    try { execSync('brew install whisper-cpp', { stdio: 'inherit' }); return true; } catch(_) {}
  }
  if (plat === 'linux') {
    try { execSync('sudo apt-get install -y whisper.cpp 2>/dev/null || pip install faster-whisper 2>/dev/null', { stdio: 'inherit', shell: true }); } catch(_) {}
    if (findWhisperBin()) return true;
  }
  console.log(colorize(C.yellow, '\n  Auto-install failed. Install manually:'));
  console.log(colorize(C.dim, '  macOS: brew install whisper-cpp'));
  console.log(colorize(C.dim, '  Linux: sudo apt install whisper.cpp'));
  console.log(colorize(C.dim, '  Pip:   pip install faster-whisper\n'));
  return false;
}

// ── Feature 8: Voice input ────────────────────────────────────────────────────
function checkBin(name) {
  try { execSync(`which ${name}`, { stdio: 'pipe' }); return true; } catch (_) { return false; }
}

function findWhisperBin() {
  for (const bin of ['whisper-cli', 'whisper.cpp', 'whisper']) {
    if (checkBin(bin)) return bin;
  }
  return null;
}

function findRecBin() {
  if (checkBin('rec')) return 'rec';
  if (checkBin('sox')) return 'sox';
  return null;
}

function parseWhisperOutput(raw) {
  const lines = raw.split('\n');
  const segments = [];
  for (const line of lines) {
    const stripped = line.replace(/^\[[\d:.,\s\-–>]+\]\s*/, '').trim();
    if (stripped) segments.push(stripped);
  }
  return segments.join(' ').trim();
}

async function handleVoice(rl, history) {
  const whisperBin = findWhisperBin();
  const recBin = findRecBin();

  if (!recBin || !whisperBin) {
    if (!whisperBin) {
      console.log(colorize(C.yellow, '\n⚠  whisper not found — attempting auto-install...\n'));
      rl.pause();
      var _wOk = await autoInstallWhisper();
      rl.resume();
      if (_wOk) { /* re-check */ } else { return; }
      if (!findWhisperBin()) { console.log(colorize(C.red, '\n✗  whisper still not found.\n')); return; }
      console.log(colorize(C.green, '  ✔  whisper ready\n'));
    }
    if (!recBin) {
      console.log(colorize(C.yellow, '  Also need sox: brew install sox (macOS) / sudo apt install sox (Linux)\n'));
      return;
    }
  }

  console.log(colorize(C.cyan, '\n  Recording... speak now. (stops on 2s silence or 30s max)\n'));
  rl.pause();

  try { fs.unlinkSync(VOICE_TMP); } catch (_) {}

  const recArgs = recBin === 'sox'
    ? ['-d', '-r', '16000', '-c', '1', VOICE_TMP, 'silence', '1', '0.1', '1%', '1', '2.0', '5%', 'trim', '0', '30']
    : ['-r', '16000', '-c', '1', VOICE_TMP, 'silence', '1', '0.1', '1%', '1', '2.0', '5%', 'trim', '0', '30'];

  await new Promise((resolve) => {
    const rec = require('child_process').spawn(recBin, recArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let done = false;
    const finish = () => { if (!done) { done = true; try { rec.kill(); } catch (_) {} resolve(); } };
    rec.on('close', resolve);
    rec.on('error', (err) => {
      console.log(colorize(C.red, `\n✗  Recording failed: ${err.message}\n`));
      finish();
    });
    setTimeout(finish, 35000);
  });

  if (!fs.existsSync(VOICE_TMP)) {
    console.log(colorize(C.red, '\n✗  No audio captured. Check your microphone.\n'));
    rl.resume();
    rl.prompt();
    return;
  }

  console.log(colorize(C.dim, '  Transcribing...\n'));

  const whisperArgs = [VOICE_TMP, '--output_format', 'txt', '--language', 'en'];
  let whisperStdout = '';
  let whisperStderr = '';

  await new Promise((resolve) => {
    const w = require('child_process').spawn(whisperBin, whisperArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    w.stdout.on('data', (d) => { whisperStdout += d.toString(); });
    w.stderr.on('data', (d) => { whisperStderr += d.toString(); });
    w.on('close', resolve);
    w.on('error', (err) => {
      whisperStderr += err.message;
      resolve();
    });
  });

  let transcribed = '';
  const txtFile = VOICE_TMP.replace('.wav', '.wav.txt');
  try { transcribed = fs.readFileSync(txtFile, 'utf8').trim(); } catch (_) {}
  if (!transcribed) transcribed = parseWhisperOutput(whisperStdout);
  if (!transcribed) transcribed = parseWhisperOutput(whisperStderr);

  try { fs.unlinkSync(VOICE_TMP); } catch (_) {}
  try { fs.unlinkSync(txtFile); } catch (_) {}

  if (!transcribed) {
    console.log(colorize(C.red, '\n✗  Could not transcribe audio. Try speaking more clearly.\n'));
    rl.resume();
    rl.prompt();
    return;
  }

  console.log(colorize(C.green, `  You said: `) + colorize(C.bold, transcribed) + '\n');

  rl.resume();
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...history,
    { role: 'user', content: transcribed },
  ];

  rl.pause();
  try {
    const sysPrompt = messages[0].content;
    const reply = await agentLoop(messages);
    history.push({ role: 'user', content: transcribed });
    history.push({ role: 'assistant', content: reply });
    logExchange(sysPrompt, transcribed, reply);
    console.log(colorize(C.greenBold, '\nproverbs> ') + renderResponse(reply) + '\n');
    printClosingVerse();
  } catch (err) {
    console.error(colorize(C.red, `\n✗  Error: ${err.message}\n`));
  }
  rl.resume();
  rl.prompt();
}

// ── Feature 9: image analysis ─────────────────────────────────────────────────
async function checkLlavaAvailable() {
  try {
    const res = await httpGet(`${OLLAMA_BASE}/api/tags`);
    if (res.status !== 200) return false;
    const parsed = JSON.parse(res.body);
    const models = (parsed.models || []).map((m) => m.name || '');
    return models.some((n) => n.startsWith('llava'));
  } catch (_) {
    return false;
  }
}

async function toolAnalyzeImage(args) {
  const target = resolvePath(args.path);
  const ext = path.extname(target).toLowerCase();

  if (!IMAGE_EXTS.has(ext)) {
    return `ERROR: Unsupported image format "${ext}". Supported: ${[...IMAGE_EXTS].join(', ')}`;
  }

  let buf;
  try {
    buf = fs.readFileSync(target);
  } catch (e) {
    return `ERROR: Cannot read image file: ${e.message}`;
  }

  const available = await checkLlavaAvailable();
  if (!available) {
    return 'Vision model is not available. Make sure the Proverbs server is running with vision support.';
  }

  const question = args.question || 'Describe this image in detail.';
  const b64 = buf.toString('base64');

  try {
    const response = await httpPost(`${OLLAMA_BASE}/api/chat`, {
      model: LLAVA_MODEL,
      messages: [{ role: 'user', content: question, images: [b64] }],
      stream: false,
    });
    return (response.message && response.message.content) || '(no response from llava)';
  } catch (e) {
    return `ERROR calling llava: ${e.message}`;
  }
}

// ── Syntax validation ────────────────────────────────────────────────────────
function validateSyntax(filePath, content) {
  if (!filePath || typeof filePath !== 'string') return null;
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.js' || ext === '.cjs' || ext === '.mjs') {
    try {
      execSync('node --check ' + JSON.stringify(filePath), { stdio: 'pipe', timeout: 8000 });
      return null;
    } catch (e) {
      let msg = '';
      try {
        const raw = e.stderr;
        if (raw) {
          msg = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
        } else {
          msg = e.message || '';
        }
      } catch (_) {
        msg = e.message || 'Unknown error';
      }
      const firstLine = msg.split('\n').find(l => l.trim().length > 0) || msg;
      return 'JS syntax error: ' + firstLine.trim();
    }
  }

  if (ext === '.json') {
    if (content === null || content === undefined) {
      try { content = fs.readFileSync(filePath, 'utf8'); } catch (e) { return null; }
    }
    try {
      JSON.parse(content);
      return null;
    } catch (e) {
      return 'JSON syntax error: ' + e.message;
    }
  }

  if (ext === '.ts' || ext === '.tsx' || ext === '.jsx') {
    const checkFile = filePath + '.__proverbs_check__.js';
    try {
      if (content === null || content === undefined) {
        try { content = fs.readFileSync(filePath, 'utf8'); } catch (_) { return null; }
      }
      const stripped = content
        .replace(/:\s*\w[\w<>[\]|&, .?]*(?=\s*[=,);{])/g, '')
        .replace(/^export\s+type\s+.+$/gm, '')
        .replace(/^import\s+type\s+.+$/gm, '');
      fs.writeFileSync(checkFile, stripped, 'utf8');
      execSync('node --check ' + JSON.stringify(checkFile), { stdio: 'pipe', timeout: 8000 });
      try { fs.unlinkSync(checkFile); } catch (_) {}
      return null;
    } catch (e) {
      try { fs.unlinkSync(checkFile); } catch (_) {}
      return null;
    }
  }

  return null;
}

// ── patch_file ────────────────────────────────────────────────────────────────
function toolPatchFile(args) {
  if (!args || typeof args.path !== 'string' || args.path.trim() === '') {
    return 'PATCH ERROR: "path" argument is missing or empty';
  }
  if (typeof args.old_string !== 'string') {
    return 'PATCH ERROR: "old_string" argument is missing or not a string';
  }
  if (typeof args.new_string !== 'string') {
    return 'PATCH ERROR: "new_string" argument is missing or not a string';
  }

  const oldStr = args.old_string;
  const newStr = args.new_string;

  if (oldStr === '') {
    return 'PATCH ERROR: old_string must not be empty — use write_file to prepend/append content';
  }

  const target = resolvePath(args.path.trim());

  let original;
  try {
    original = fs.readFileSync(target, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return `PATCH ERROR: file not found — ${target}`;
    if (e.code === 'EISDIR') return `PATCH ERROR: path is a directory, not a file — ${target}`;
    return `PATCH ERROR: cannot read file — ${e.message}`;
  }

  let count = 0;
  let searchIdx = 0;
  let firstIdx = -1;
  while (true) {
    const idx = original.indexOf(oldStr, searchIdx);
    if (idx === -1) break;
    if (firstIdx === -1) firstIdx = idx;
    count++;
    searchIdx = idx + oldStr.length;
  }

  if (count === 0) {
    return `PATCH ERROR: old_string not found in ${target}`;
  }

  const firstLine = original.slice(0, firstIdx).split('\n').length;
  const patched = original.split(oldStr).join(newStr);

  // Backup before overwriting
  backupFile(target);

  try {
    fs.writeFileSync(target, patched, 'utf8');
  } catch (e) {
    if (e.code === 'EACCES') return `PATCH ERROR: permission denied writing ${target}`;
    return `PATCH ERROR: cannot write file — ${e.message}`;
  }

  // Show diff after successful patch
  showDiff(target, original, patched);

  let result = `Patched ${target}: replaced ${count} occurrence${count === 1 ? '' : 's'} at line ${firstLine}`;

  // TS / ESLint feedback
  const patchExt = path.extname(target).toLowerCase();
  if (/\.(ts|tsx|js|jsx)$/.test(patchExt)) {
    if (tsCheckEnabled) {
      const tsErrors = runTsCheck(path.dirname(target));
      if (tsErrors) result += '\nTS ERRORS:\n' + tsErrors;
    }
    if (eslintCheckEnabled) {
      const eslintWarnings = runEslintCheck(target);
      if (eslintWarnings) result += '\nESLINT WARNINGS:\n' + eslintWarnings;
    }
  }

  return result;
}

// ── load_context ──────────────────────────────────────────────────────────────
function parseLocalImports(source) {
  const found = [];
  const seen  = new Set();

  function add(spec) {
    if (!spec) return;
    if (!spec.startsWith('./') && !spec.startsWith('../')) return;
    if (!seen.has(spec)) { seen.add(spec); found.push(spec); }
  }

  let m;
  const reRequire = /require\s*\(\s*['"](\.\.[^'"]+|\.[^'"]+)['"]\s*\)/g;
  while ((m = reRequire.exec(source)) !== null) add(m[1]);

  const reFrom = /from\s+['"](\.\.[^'"]+|\.[^'"]+)['"]/g;
  while ((m = reFrom.exec(source)) !== null) add(m[1]);

  const reDynamic = /import\s*\(\s*['"](\.\.[^'"]+|\.[^'"]+)['"]\s*\)/g;
  while ((m = reDynamic.exec(source)) !== null) add(m[1]);

  return found;
}

function resolveLocalImport(specifier, fromDir) {
  const EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'];
  const base = path.resolve(fromDir, specifier);

  try {
    if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  } catch (_) {}

  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {}
  }

  for (const ext of EXTENSIONS) {
    const candidate = path.join(base, 'index' + ext);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {}
  }

  return null;
}

function toolLoadContext(args) {
  if (!args || !args.path) return 'ERROR: path is required.';

  const entryAbs = resolvePath(args.path);

  try {
    if (!fs.existsSync(entryAbs)) return `ERROR: File not found: ${entryAbs}`;
    if (!fs.statSync(entryAbs).isFile()) return `ERROR: Not a file: ${entryAbs}`;
  } catch (e) {
    return `ERROR: ${e.message}`;
  }

  const entryExt = path.extname(entryAbs).toLowerCase();
  if (LOAD_CONTEXT_BINARY_EXTS.has(entryExt)) {
    return `ERROR: "${entryAbs}" appears to be a binary file and cannot be loaded as context.`;
  }

  const maxDepth = Math.min(
    Math.max(0, Number.isFinite(Number(args.depth)) ? Math.floor(Number(args.depth)) : 2),
    5
  );

  const visited  = new Set();
  const segments = [];
  const queue    = [{ absPath: entryAbs, depth: 0 }];

  while (queue.length > 0) {
    const { absPath, depth } = queue.shift();

    if (visited.has(absPath)) continue;
    visited.add(absPath);

    const pathParts = absPath.split(path.sep);
    const inSkipped = pathParts.some(
      p => LOAD_CONTEXT_SKIP_DIRS.has(p) || (p.startsWith('.') && p.length > 1 && p !== '.')
    );
    if (inSkipped && absPath !== entryAbs) continue;

    const ext = path.extname(absPath).toLowerCase();
    if (LOAD_CONTEXT_BINARY_EXTS.has(ext)) continue;

    let content;
    let readable = true;
    try {
      const raw = fs.readFileSync(absPath, 'utf8');
      if (raw.includes('\0')) {
        content  = '// (binary content detected — skipped)\n';
        readable = false;
      } else {
        content = raw;
      }
    } catch (e) {
      content  = `// ERROR reading file: ${e.message}\n`;
      readable = false;
    }

    let relLabel;
    try { relLabel = path.relative(process.cwd(), absPath) || absPath; } catch (_) { relLabel = absPath; }

    segments.push({ relLabel, content });

    if (readable && depth < maxDepth) {
      const fileDir    = path.dirname(absPath);
      const specifiers = parseLocalImports(content);
      for (const spec of specifiers) {
        const resolved = resolveLocalImport(spec, fileDir);
        if (!resolved || visited.has(resolved)) continue;
        const resolvedExt = path.extname(resolved).toLowerCase();
        if (LOAD_CONTEXT_BINARY_EXTS.has(resolvedExt)) continue;
        queue.push({ absPath: resolved, depth: depth + 1 });
      }
    }
  }

  if (segments.length === 0) {
    return `ERROR: No files could be loaded for: ${entryAbs}`;
  }

  let totalChars = 0;
  const outputParts = [];

  for (let i = 0; i < segments.length; i++) {
    const { relLabel, content } = segments[i];
    const header    = `// === ${relLabel} ===\n`;
    const separator = '\n';
    const overhead  = header.length + separator.length;
    const available = LOAD_CONTEXT_MAX_CHARS - totalChars - overhead;

    if (available <= 0) {
      outputParts.push(`${header}// (omitted — character budget exhausted)\n${separator}`);
      break;
    }

    let body      = content;
    let truncated = false;

    if (body.length > available) {
      let cut = body.slice(0, available);
      const lastNl = cut.lastIndexOf('\n');
      if (lastNl > 0) cut = cut.slice(0, lastNl + 1);
      body      = cut;
      truncated = true;
    }

    const tail = truncated ? '\n// ...(truncated — character budget reached)\n' : '';
    outputParts.push(`${header}${body}${tail}${separator}`);
    totalChars += overhead + body.length + tail.length;

    if (totalChars >= LOAD_CONTEXT_MAX_CHARS) break;
  }

  const fileCount = outputParts.length;
  const summary   = `// load_context: ${fileCount} file(s) loaded (${totalChars.toLocaleString()} chars)\n\n`;
  return summary + outputParts.join('');
}

// ── /ctx helpers ──────────────────────────────────────────────────────────────
const CTX_AUTO_CANDIDATES = [
  'package.json', 'prisma/schema.prisma', 'tsconfig.json',
  'next.config.js', 'next.config.ts', '.env.example',
  'src/index.js', 'src/index.ts', 'src/index.jsx', 'src/index.tsx',
  'app/layout.js', 'app/layout.ts', 'app/layout.jsx', 'app/layout.tsx',
];

function ctxReadFile(absPath) {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return { ok: false, reason: 'not a regular file' };
    if (stat.size > 512 * 1024) {
      return { ok: false, reason: `file too large (${Math.round(stat.size / 1024)} KB — max 512 KB)` };
    }
    const content = fs.readFileSync(absPath, 'utf8');
    return { ok: true, content };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function ctxNormalisePath(userPath) {
  if (!userPath || !userPath.trim()) return null;
  const abs = resolvePath(userPath.trim());
  const rel = path.relative(cwd, abs) || path.basename(abs);
  return { absPath: abs, relPath: rel };
}

async function handleCtxCmd(sub, rest) {
  if (sub === 'list' || sub === 'ls') {
    if (sessionContextFiles.length === 0) {
      console.log(colorize(C.dim, '\n(no files pinned — use /ctx add <path> or /ctx auto)\n'));
      return;
    }
    console.log(colorize(C.cyan, `\nPinned context files (${sessionContextFiles.length}):`));
    for (const f of sessionContextFiles) {
      const chars = f.content.length;
      const shown = Math.min(chars, 3000);
      const trunc = chars > 3000 ? colorize(C.yellow, ` [truncated to 3000/${chars} chars]`) : '';
      console.log(`  ${colorize(C.bold, f.relPath.padEnd(48))} ${colorize(C.dim, shown + ' chars')}${trunc}`);
    }
    console.log();
    return;
  }

  if (sub === 'clear') {
    const count = sessionContextFiles.length;
    sessionContextFiles = [];
    if (count === 0) {
      console.log(colorize(C.dim, '\n(context was already empty)\n'));
    } else {
      console.log(colorize(C.green, `\n✔  Cleared ${count} pinned file${count === 1 ? '' : 's'}.\n`));
    }
    return;
  }

  if (sub === 'remove' || sub === 'rm' || sub === 'unpin') {
    const target = (rest || '').trim();
    if (!target) {
      console.log(colorize(C.red, '\n✗  Usage: /ctx remove <path>\n'));
      return;
    }
    const normalised = ctxNormalisePath(target);
    const relKey     = normalised ? normalised.relPath : target;
    const before     = sessionContextFiles.length;

    sessionContextFiles = sessionContextFiles.filter((f) => {
      if (f.relPath === relKey)                                return false;
      if (f.relPath === target)                               return false;
      if (path.basename(f.relPath) === path.basename(target)) return false;
      return true;
    });

    const removed = before - sessionContextFiles.length;
    if (removed === 0) {
      console.log(colorize(C.yellow, `\n⚠  No pinned file matched "${target}". Use /ctx list to see what is pinned.\n`));
    } else {
      console.log(colorize(C.green, `\n✔  Unpinned: ${target}\n`));
    }
    return;
  }

  if (sub === 'add' || sub === 'pin') {
    const target = (rest || '').trim();
    if (!target) {
      console.log(colorize(C.red, '\n✗  Usage: /ctx add <path>\n'));
      return;
    }
    const normalised = ctxNormalisePath(target);
    if (!normalised) {
      console.log(colorize(C.red, '\n✗  Invalid path.\n'));
      return;
    }
    const { absPath, relPath } = normalised;

    const result = ctxReadFile(absPath);
    if (!result.ok) {
      console.log(colorize(C.red, `\n✗  Cannot pin "${relPath}": ${result.reason}\n`));
      return;
    }

    const existingIdx = sessionContextFiles.findIndex((f) => f.relPath === relPath);
    if (existingIdx !== -1) {
      sessionContextFiles[existingIdx].content = result.content;
      console.log(colorize(C.green, `\n✔  Refreshed: ${relPath}`) +
                  colorize(C.dim,   ` (${result.content.length} chars)\n`));
    } else {
      sessionContextFiles.push({ relPath, content: result.content });
      console.log(colorize(C.green, `\n✔  Pinned: ${relPath}`) +
                  colorize(C.dim,   ` (${result.content.length} chars)\n`));
    }
    return;
  }

  if (sub === 'auto') {
    let added    = 0;
    let skipped  = 0;
    const failures = [];

    for (const candidate of CTX_AUTO_CANDIDATES) {
      const absPath = path.join(cwd, candidate);
      if (!fs.existsSync(absPath)) continue;

      const relPath     = candidate;
      const existingIdx = sessionContextFiles.findIndex((f) => f.relPath === relPath);
      const result      = ctxReadFile(absPath);

      if (!result.ok) {
        failures.push(`${candidate}: ${result.reason}`);
        continue;
      }

      if (existingIdx !== -1) {
        sessionContextFiles[existingIdx].content = result.content;
        skipped++;
      } else {
        sessionContextFiles.push({ relPath, content: result.content });
        added++;
      }
    }

    if (added === 0 && skipped === 0 && failures.length === 0) {
      console.log(colorize(C.yellow, '\n⚠  No recognised config files found in cwd.\n'));
      console.log(colorize(C.dim, '   Looked for: ' + CTX_AUTO_CANDIDATES.join(', ') + '\n'));
      return;
    }

    if (added > 0 || skipped > 0) {
      const parts_ = [];
      if (added   > 0) parts_.push(`${added} added`);
      if (skipped > 0) parts_.push(`${skipped} refreshed`);
      console.log(colorize(C.green, `\n✔  Auto-pinned context: ${parts_.join(', ')}\n`));
      for (const f of sessionContextFiles) {
        console.log(colorize(C.dim, `   ${f.relPath} (${Math.min(f.content.length, 3000)} chars shown)`));
      }
      console.log();
    }

    if (failures.length > 0) {
      console.log(colorize(C.yellow, `\n⚠  Could not read ${failures.length} file(s):`));
      for (const msg of failures) console.log(colorize(C.dim, `   ${msg}`));
      console.log();
    }
    return;
  }

  console.log(colorize(C.cyan, '\nContext pinning — /ctx commands:'));
  console.log('  /ctx add <path>    — Pin a file into the system prompt for this session');
  console.log('  /ctx remove <path> — Unpin a previously pinned file');
  console.log('  /ctx list          — Show all pinned files and their character counts');
  console.log('  /ctx clear         — Remove all pinned files');
  console.log('  /ctx auto          — Auto-detect and pin key project files (package.json, tsconfig, etc.)');
  console.log(colorize(C.dim, '\n  Aliases: pin=add, unpin/rm=remove, ls=list'));
  console.log(colorize(C.dim, '  Pinned files are injected into every prompt for the whole session.'));
  console.log(colorize(C.dim, '  Use /ctx clear when switching projects, or /cwd to change directory.\n'));
}

// ── Plan Mode ─────────────────────────────────────────────────────────────────
function parsePlanSteps(raw) {
  if (!raw || typeof raw !== 'string') return [];

  const lines = raw.split('\n');
  const steps = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m =
      trimmed.match(/^\d+[\.\)]\s+(.+)$/) ||
      trimmed.match(/^step\s+\d+[:\-]\s+(.+)$/i);
    if (m) {
      const text = m[1].trim();
      if (text) steps.push(text);
    }
  }

  if (steps.length === 0) {
    for (const line of lines) {
      const t = line.trim();
      if (t) steps.push(t);
    }
  }

  return steps;
}

function displayPlan(steps, current) {
  console.log(colorize(C.cyanBold, '\n── Plan ─────────────────────────────────────────'));
  steps.forEach((step, i) => {
    const num = i + 1;
    let prefix;
    if (current === -1) {
      prefix = colorize(C.dim, `${num}.`);
    } else if (i < current) {
      prefix = colorize(C.green, `${num}. [done]`);
    } else if (i === current) {
      prefix = colorize(C.cyanBold, `${num}. [running]`);
    } else {
      prefix = colorize(C.dim, `${num}.`);
    }
    console.log(`  ${prefix} ${step}`);
  });
  console.log(colorize(C.cyanBold, '─────────────────────────────────────────────────\n'));
}

function collectMultilineInput(rl, promptText) {
  return new Promise((resolve) => {
    console.log(colorize(C.dim, promptText));
    const collectedLines = [];
    rl.resume();

    function onLine(line) {
      if (line.trim() === '') {
        rl.removeListener('line', onLine);
        rl.pause();
        resolve(collectedLines.join('\n'));
      } else {
        collectedLines.push(line);
      }
    }

    rl.on('line', onLine);
  });
}

function askQuestion(rl, question) {
  return new Promise((resolve) => {
    rl.resume();
    rl.question(colorize(C.cyan, question), (answer) => {
      rl.pause();
      resolve((answer || '').trim().toLowerCase());
    });
  });
}

// Alert + confirm before the model/backend ("language") changes for this turn.
// Queries the server for the backend it WOULD use, compares to the last turn,
// and blocks for a y/N confirm if it changed. Returns true to proceed, false to
// cancel this turn. Fails open (proceeds) if the backend can't be determined.
async function confirmBackendIfChanged(rl) {
  if (!_backendSwitchConfirm) return true;
  let sig, label;
  try {
    const r = await httpGet(OLLAMA_BASE + '/api/backend', 4000);
    if (r.status !== 200) return true; // can't tell — don't block
    const b = JSON.parse(r.body);
    if (b.backend === 'claude') { sig = 'claude:' + (b.cloudModel || cloudModel); label = 'Claude (' + (b.cloudModel || cloudModel) + ')'; }
    else                        { sig = 'local';  label = 'local model' + (b.localModels && b.localModels[0] ? ' (' + b.localModels[0] + ')' : ''); }
  } catch (_) {
    return true; // server unreachable — the request itself will surface the error
  }

  // First turn of the session: record silently, nothing to confirm against.
  if (_lastBackendSig === null) { _lastBackendSig = sig; return true; }
  if (sig === _lastBackendSig)  { return true; }

  const fromLabel = _lastBackendSig.startsWith('claude:')
    ? 'Claude (' + _lastBackendSig.slice('claude:'.length) + ')'
    : 'local model';
  process.stdout.write('\n');
  console.log(colorize(C.yellow, '  ⚠  The model is about to change: ') + colorize(C.dim, fromLabel) + colorize(C.yellow, ' → ') + colorize(C.cyanBold, label));
  const ans = await askQuestion(rl, '  Confirm switch and continue? [y/N]: ');
  if (ans === 'y' || ans === 'yes') {
    _lastBackendSig = sig;
    console.log(colorize(C.green, '  ✓ Switching to ' + label + '\n'));
    return true;
  }
  console.log(colorize(C.dim, '  Cancelled — staying on ' + fromLabel + '. (Tip: /confirmswitch off to disable these prompts.)\n'));
  return false;
}

function planSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function executePlanSteps(rl, history) {
  if (!activePlan) return;

  const { steps, task } = activePlan;
  const total = steps.length;

  for (let i = activePlan.current; i < total; i++) {
    activePlan.current = i;

    if (!activePlan) {
      console.log(colorize(C.yellow, '\n(plan aborted)\n'));
      return;
    }

    const stepLabel = colorize(C.cyan, `[Step ${i + 1}/${total}]`);
    const stepText  = steps[i];
    console.log(`\n${stepLabel} ${colorize(C.bold, stepText)}`);

    const planContext = steps.map((s, idx) => `${idx + 1}. ${s}`).join('\n');
    const userMsg = `[Step ${i + 1}/${total}]: ${stepText}\n\nFull plan:\n${planContext}\n\nTask: ${task}`;

    const messages = [
      { role: 'system', content: buildSystemPrompt() },
      ...history,
      { role: 'user', content: userMsg },
    ];

    rl.pause();
    const spinner = new Spinner(`Executing step ${i + 1}/${total}...`);
    spinner.start();

    let reply;
    try {
      reply = await routedAgentLoop(messages, stepText);
    } catch (err) {
      spinner.stop();
      console.error(colorize(C.red, `\n✗  Step ${i + 1} failed: ${err.message}\n`));
      const cont = await askQuestion(rl, `Step ${i + 1} errored. Continue to next step? (y/n): `);
      if (cont !== 'y' && cont !== 'yes') {
        console.log(colorize(C.yellow, '\nPlan paused. Use /plan status to review or /plan abort to cancel.\n'));
        rl.resume();
        rl.prompt();
        return;
      }
      rl.resume();
      await planSleep(500);
      continue;
    }

    spinner.stop();

    history.push({ role: 'user',      content: userMsg });
    history.push({ role: 'assistant', content: reply  });

    console.log(colorize(C.greenBold, '\nproverbs> ') + renderResponse(reply) + '\n');

    activePlan.current = i + 1;

    if (i < total - 1) {
      await planSleep(500);
    }
  }

  console.log(colorize(C.greenBold, `\n✔  Plan complete! All ${total} step${total !== 1 ? 's' : ''} finished.\n`));
  activePlan = null;
  rl.resume();
  rl.prompt();
}

async function handlePlanCmd(input, rl, history) {
  const rest = input.replace(/^\/plan\s*/i, '').trim();
  const sub  = rest.split(/\s+/)[0].toLowerCase();

  if (sub === 'status') {
    if (!activePlan) {
      console.log(colorize(C.dim, '\n(no active plan — start one with /plan <task description>)\n'));
      rl.prompt();
      return;
    }
    const { steps, current, task } = activePlan;
    console.log(colorize(C.cyan, `\nActive Plan: ${task}`));
    console.log(colorize(C.dim, `Progress: ${current}/${steps.length} steps completed`));
    displayPlan(steps, current);
    rl.prompt();
    return;
  }

  if (sub === 'abort') {
    if (!activePlan) {
      console.log(colorize(C.dim, '\n(no active plan to abort)\n'));
    } else {
      const { task, current, steps } = activePlan;
      activePlan = null;
      console.log(colorize(C.yellow, `\nPlan aborted: "${task}" (was on step ${current + 1}/${steps.length})\n`));
    }
    rl.prompt();
    return;
  }

  const task = rest;
  if (!task) {
    console.log(colorize(C.cyan, '\nPlan Mode commands:'));
    console.log('  /plan <task>    — Generate and execute a step-by-step plan');
    console.log('  /plan status    — Show progress of the active plan');
    console.log('  /plan abort     — Cancel the active plan\n');
    rl.prompt();
    return;
  }

  if (activePlan) {
    console.log(colorize(C.yellow, `\n⚠  A plan is already active (step ${activePlan.current + 1}/${activePlan.steps.length}).`));
    console.log(colorize(C.dim, '   Use /plan abort to cancel it first, or /plan status to review progress.\n'));
    rl.prompt();
    return;
  }

  console.log(colorize(C.dim, '\n(Generating plan...)\n'));
  rl.pause();

  const planMessages = [
    {
      role: 'system',
      content:
        'You are a planning assistant. Write a numbered step-by-step plan to accomplish the task. ' +
        'Each step should be a single, concrete action a developer can take. ' +
        'Format each line exactly as:\n' +
        '1. [action]\n2. [action]\n...\n' +
        'Do not include sub-bullets, headers, or explanation text outside the numbered list.',
    },
    {
      role: 'user',
      content: `Task: ${task}`,
    },
  ];

  const prevModel = model;
  if (routingConfig.smart && routingConfig.smart !== model) {
    model = routingConfig.smart;
  }

  const planSpinner = new Spinner('Generating plan...');
  planSpinner.start();

  let rawPlan;
  try {
    const response = await httpPost(`${OLLAMA_BASE}/api/chat`, {
      model,
      messages: planMessages,
      stream: false,
    });

    if (response && response.message && typeof response.message.content === 'string') {
      rawPlan = response.message.content;
    } else if (response && typeof response.response === 'string') {
      rawPlan = response.response;
    } else {
      rawPlan = '';
    }
  } catch (err) {
    planSpinner.stop();
    model = prevModel;
    console.error(colorize(C.red, `\n✗  Failed to generate plan: ${err.message}\n`));
    rl.resume();
    rl.prompt();
    return;
  } finally {
    planSpinner.stop();
    model = prevModel;
  }

  if (!rawPlan.trim()) {
    console.log(colorize(C.red, '\n✗  The model returned an empty plan. Try rephrasing your task.\n'));
    rl.resume();
    rl.prompt();
    return;
  }

  let steps = parsePlanSteps(rawPlan);

  if (steps.length === 0) {
    console.log(colorize(C.red, '\n✗  Could not parse any steps from the model response.\n'));
    console.log(colorize(C.dim, 'Raw response:\n' + rawPlan.slice(0, 400) + '\n'));
    rl.resume();
    rl.prompt();
    return;
  }

  console.log(colorize(C.cyanBold, `\nPlan: ${task}`));
  displayPlan(steps, -1);

  let confirmed = false;
  while (!confirmed) {
    const answer = await askQuestion(rl, 'Execute this plan? (y/n/edit): ');

    if (answer === 'y' || answer === 'yes') {
      confirmed = true;
    } else if (answer === 'n' || answer === 'no') {
      console.log(colorize(C.dim, '\nPlan cancelled.\n'));
      rl.resume();
      rl.prompt();
      return;
    } else if (answer === 'edit' || answer === 'e') {
      const edited = await collectMultilineInput(
        rl,
        'Paste your edited plan (end with a blank line):'
      );

      if (!edited.trim()) {
        console.log(colorize(C.yellow, '\n(No input received. Plan unchanged.)\n'));
      } else {
        const newSteps = parsePlanSteps(edited);
        if (newSteps.length === 0) {
          console.log(colorize(C.yellow, '\n(Could not parse steps from your input. Plan unchanged.)\n'));
        } else {
          steps = newSteps;
          console.log(colorize(C.green, `\nUpdated plan (${steps.length} steps):`));
          displayPlan(steps, -1);
        }
      }
    } else {
      console.log(colorize(C.dim, '(Please enter y, n, or edit)'));
    }
  }

  activePlan = { steps, current: 0, task };
  console.log(colorize(C.green, `\nStarting plan: "${task}" (${steps.length} steps)\n`));

  executePlanSteps(rl, history);
}

// ── Self-modification protection ──────────────────────────────────────────────
// Password stored as SHA-256 hash only — plaintext never in source
const SELF_MOD_HASH    = '6bd59e203a928b30026059fba2c8dc154eed93e391d18e48dadb5e99200c1cb6';
const PROVERBS_SRC_DIR = path.join(require('os').homedir(), 'proverbs');
let _selfModUnlocked   = false;

function isSelfModFile(fp) {
  if (!fp) return false;
  const r = path.resolve(fp);
  return r.startsWith(PROVERBS_SRC_DIR) || r.includes('proverbs/cli.js') || r.includes('proverbs/dist/');
}

async function promptPasswordMasked(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(colorize(C.yellow, prompt));
    let pwd = '';
    const wasRaw = process.stdin.isRaw || false;
    try { process.stdin.setRawMode(true); } catch(_) {}
    process.stdin.resume();
    const onData = (data) => {
      for (const ch of data.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.removeListener('data', onData);
          try { process.stdin.setRawMode(wasRaw); } catch(_) {}
          process.stdout.write('\n');
          resolve(pwd);
          return;
        } else if (ch === '') { // Ctrl+C
          process.stdin.removeListener('data', onData);
          try { process.stdin.setRawMode(wasRaw); } catch(_) {}
          process.stdout.write('\n');
          resolve('');
          return;
        } else if (ch === '' || ch === '\b') {
          if (pwd.length > 0) { pwd = pwd.slice(0, -1); process.stdout.write('\b \b'); }
        } else if (ch.charCodeAt(0) >= 32) {
          pwd += ch; process.stdout.write('*');
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

// Self-modification is no longer gated behind a password. The user sets their
// own access terms via the permission-scope system (see permissionScopes), so
// this is always allowed. Kept as a function so existing call sites still work,
// and so it NEVER calls setRawMode (which throws in non-TTY/server contexts and
// was the root cause of "every edit throws an error").
async function checkSelfModAuth() {
  _selfModUnlocked = true;
  return true;
}

async function selfModRebuild() {
  console.log(colorize(C.dim, '\n  Rebuilding Proverbs...\n'));
  try {
    require('child_process').execSync('node ' + path.join(PROVERBS_SRC_DIR, 'build.js'), { cwd: PROVERBS_SRC_DIR, stdio: 'inherit', timeout: 120000 });
    console.log(colorize(C.green, '\n  ✔ Proverbs rebuilt and installed.\n'));
    notify('Proverbs rebuilt', 'Self-modification complete — restart Proverbs to use the update.');
  } catch(e) { console.log(colorize(C.red, '\n  ✗ Build failed: ' + e.message + '\n')); }
}

// ── Reliability: backend heartbeat + watchdog ─────────────────────────────────
async function pingBackend() {
  const t0 = Date.now();
  try { await httpGet(OLLAMA_BASE + '/api/tags', 4000); return { ok: true, ms: Date.now() - t0 }; }
  catch (e) { return { ok: false, error: e.message }; }
}

function startHeartbeat(intervalMs) {
  if (!intervalMs) intervalMs = 30000;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  let _hbWasDown = false;
  heartbeatTimer = setInterval(async () => {
    const r = await pingBackend();
    if (!r.ok) { _hbWasDown = true; try { await detectBackend(true); } catch(_) {} }
    else if (_hbWasDown) { _hbWasDown = false; rl.prompt(); }
  }, intervalMs);
}

function stopHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }

function makeWatchdog(name, restartFn, delayMs) {
  if (!delayMs) delayMs = 3000;
  let restartCount = 0, firstRestartAt = 0;
  return function(err) {
    const now = Date.now();
    if (!restartCount || now - firstRestartAt > 60000) { restartCount = 1; firstRestartAt = now; }
    else restartCount++;
    if (restartCount > 3) { return; }
    // silent watchdog restart
    setTimeout(() => { try { restartFn(); } catch(e) { console.log(colorize(C.red, '[watchdog] ' + name + ' restart failed: ' + e.message)); } }, delayMs);
  };
}

// ── Inference speed cache ─────────────────────────────────────────────────────
function simpleHash(str) {
  if (!str) return '0';
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

function buildSystemPromptCached() {
  const prompt = buildSystemPrompt();
  const hash = simpleHash(prompt);
  if (hash === _sysPromptHash) return _sysPromptCached;
  _sysPromptHash = hash; _sysPromptCached = prompt;
  return prompt;
}

async function enforceContextBudget(messages) {
  if (contextBudget <= 0 || messages.length <= 1) return messages;
  const count = await countMessagesTokens(messages);
  if (count <= contextBudget) return messages;
  console.log(colorize(C.dim, '  (context budget exceeded — auto-compressing...)'));
  try { const c = await compressHistory(messages.slice(1), model); return [messages[0], ...c]; }
  catch(_) { console.log(colorize(C.yellow, '  Warning: auto-compress failed, continuing')); return messages; }
}

// ─── Project context memory — persists last task + timestamp per project ───────
const PROJECT_CONTEXT_FILE = path.join(PROVERBS_DIR, 'project_context.json');
function _loadProjectContextMemory() {
  try { return JSON.parse(fs.readFileSync(PROJECT_CONTEXT_FILE, 'utf8')); } catch(_) { return {}; }
}
function _saveProjectContextMemory(projPath, lastTask) {
  try {
    const mem = _loadProjectContextMemory();
    mem[projPath] = { lastSeen: Date.now(), lastTask: (lastTask || '').slice(0, 120) };
    fs.writeFileSync(PROJECT_CONTEXT_FILE, JSON.stringify(mem, null, 2));
  } catch(_) {}
}
function _relTime(ms) {
  if (!ms) return 'never';
  const d = Date.now() - ms;
  if (d < 60000)   return Math.round(d/1000) + 's';
  if (d < 3600000) return Math.round(d/60000) + 'm';
  if (d < 86400000) return Math.round(d/3600000) + 'h';
  return Math.round(d/86400000) + 'd';
}

function recordResponseTime(startMs) {
  const e = Date.now() - startMs;
  _lastResponseMs = e;
  _avgResponseMs = Math.round((_avgResponseMs * _responseCount + e) / (_responseCount + 1));
  _responseCount++;
  return e;
}

function getSpeedStats() { return { last: _lastResponseMs, avg: _avgResponseMs, count: _responseCount }; }

// ── Context export / import / encode / decode ─────────────────────────────────
function exportContext(filePath, historyRef, opts) {
  opts = Object.assign({ includeTasks: true, includeProfile: true }, opts);
  const data = { version: 2, exportedAt: new Date().toISOString(), cwd, model, history: historyRef, proverbsProfile: opts.includeProfile ? (proverbsProfile || '') : '', scriptContent: opts.includeProfile ? (scriptContent || '') : '', taskStore: opts.includeTasks ? taskStore : [], messageCount: historyRef.length, charCount: historyRef.reduce((s, m) => s + (m.content || '').length, 0) };
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

function importContext(filePath, historyRef) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!data.version || !Array.isArray(data.history)) throw new Error('Invalid context file');
  historyRef.splice(0, historyRef.length, ...data.history);
  if (data.proverbsProfile) proverbsProfile = data.proverbsProfile;
  if (data.scriptContent) scriptContent = data.scriptContent;
  return { messageCount: data.history.length, cwd: data.cwd, exportedAt: data.exportedAt };
}

function encodeContext(historyRef) {
  const data = { version: 2, exportedAt: new Date().toISOString(), cwd, model, history: historyRef, proverbsProfile: proverbsProfile || '', scriptContent: scriptContent || '', messageCount: historyRef.length };
  return Buffer.from(JSON.stringify(data)).toString('base64');
}

function decodeContext(b64) { try { return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); } catch(_) { return null; } }

async function smartCompress(historyRef, keepRecent) {
  if (!keepRecent) keepRecent = 6;
  if (historyRef.length <= keepRecent + 2) return null;
  const toSummarize = historyRef.slice(0, historyRef.length - keepRecent);
  const prompt = 'Summarize this conversation as bullet points, preserving: files edited, decisions made, errors found, ongoing tasks:\n\n' + toSummarize.map(m => m.role + ': ' + (m.content || '').slice(0, 400)).join('\n\n');
  const summary = await agentLoop([{ role: 'system', content: 'You are a context summarizer. Be concise and technical.' }, { role: 'user', content: prompt }]);
  const summaryMsg = { role: 'assistant', content: '[CONTEXT SUMMARY]\n' + summary };
  const before = historyRef.length;
  historyRef.splice(0, toSummarize.length, summaryMsg);
  return { before, after: 1 + keepRecent, summary: (typeof summary === 'string' ? summary : '').slice(0, 200) };
}

// ── Claude project discovery ───────────────────────────────────────────────────
const CLAUDE_PROJECTS_DIR = path.join(require('os').homedir(), '.claude', 'projects');
const PROVERBS_HOME       = path.join(require('os').homedir(), '.proverbs');

function discoverClaudeProjects() {
  const home = require('os').homedir();
  const projects = [];
  const seen = new Set();

  function getStack(dir) {
    let stack = '';
    const pkgFile = path.join(dir, 'package.json');
    if (fs.existsSync(pkgFile)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
        stack = ['next','react','electron','@capacitor/core','express','vite'].filter(d => deps[d]).slice(0,3).join('+');
      } catch(_) {}
    }
    return stack;
  }

  function addProject(dirPath, claudeDir) {
    if (seen.has(dirPath)) return;
    try {
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return;
    } catch(_) { return; }
    seen.add(dirPath);
    const name = path.basename(dirPath);
    const hasPkg = fs.existsSync(path.join(dirPath, 'package.json'));
    const hasGit = fs.existsSync(path.join(dirPath, '.git'));
    const hasProverbs = fs.existsSync(path.join(dirPath, '.proverbs'));
    projects.push({ name, path: dirPath, stack: getStack(dirPath), hasPkg, hasGit, hasProverbs, claudeDir: claudeDir || null });
  }

  // Strategy 1: scan ~/.claude/projects/ entries.
  // Entry format: each '/' in original path becomes '-'. e.g. /Users/Stizzop/my-app → -Users-Stizzop-my-app
  // To reverse: we know home = /Users/Stizzop, so the prefix is '-Users-Stizzop-'
  // Everything after the prefix is the project folder name (hyphens preserved)
  if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    const homeKey = '-' + home.replace(/\//g, '-').replace(/^-/, ''); // e.g. -Users-Stizzop
    const homePrefix = homeKey + '-'; // e.g. -Users-Stizzop-
    fs.readdirSync(CLAUDE_PROJECTS_DIR).forEach(entry => {
      if (entry === homeKey) { addProject(home, entry); return; }
      if (entry.startsWith(homePrefix)) {
        // The project name is everything after the home prefix — preserves hyphens correctly
        const projectName = entry.slice(homePrefix.length);
        addProject(path.join(home, projectName), entry);
      }
    });
  }

  // Strategy 2: scan home dir for any code directory not already found
  const SKIP = new Set(['Applications','Desktop','Documents','Downloads','Library','Movies','Music','Pictures','Public','scripts','tmp']);
  if (fs.existsSync(home)) {
    try {
      fs.readdirSync(home).forEach(name => {
        if (name.startsWith('.') || SKIP.has(name)) return;
        const p = path.join(home, name);
        if (seen.has(p)) return;
        try {
          if (!fs.statSync(p).isDirectory()) return;
          const hasPkg = fs.existsSync(path.join(p, 'package.json'));
          const hasGit = fs.existsSync(path.join(p, '.git'));
          if (hasPkg || hasGit) addProject(p, null);
        } catch(_) {}
      });
    } catch(_) {}
  }

  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Push notifications (macOS) ────────────────────────────────────────────────
function notify(title, body) {
  try {
    const safe = (s) => String(s).slice(0, 200).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    execSync(`osascript -e 'display notification "${safe(body)}" with title "Proverbs" subtitle "${safe(title)}"'`, { timeout: 3000, stdio: 'ignore' });
  } catch (_) {}
}

// ── Task tracking ─────────────────────────────────────────────────────────────
const TASK_FILE = path.join(require('os').homedir(), '.proverbs', 'tasks.json');

function loadTasks() {
  try { taskStore = JSON.parse(fs.readFileSync(TASK_FILE, 'utf8')); } catch (_) { taskStore = []; }
}

function saveTasks() {
  try { fs.mkdirSync(path.dirname(TASK_FILE), { recursive: true }); fs.writeFileSync(TASK_FILE, JSON.stringify(taskStore, null, 2)); } catch (_) {}
}

function makeTaskId() { return Math.random().toString(36).slice(2, 9); }

function taskCreate(title, description) {
  const now = new Date().toISOString();
  const t = { id: makeTaskId(), title: String(title), description: description || '', status: 'todo', createdAt: now, updatedAt: now, output: '' };
  taskStore.push(t);
  saveTasks();
  return t;
}

function taskUpdate(id, patch) {
  const t = taskStore.find(t => t.id === id || t.id.startsWith(id));
  if (!t) return null;
  Object.assign(t, patch, { updatedAt: new Date().toISOString() });
  saveTasks();
  return t;
}

function taskGet(id) { return taskStore.find(t => t.id === id || t.id.startsWith(id)) || null; }

function taskAppendOutput(id, text) {
  const t = taskGet(id);
  if (!t) return null;
  t.output = (t.output || '') + text + '\n';
  t.updatedAt = new Date().toISOString();
  saveTasks();
  return t;
}

// ── Cron scheduler ────────────────────────────────────────────────────────────
const CRON_FILE = path.join(require('os').homedir(), '.proverbs', 'crons.json');

function loadCrons()  { try { cronJobs = JSON.parse(fs.readFileSync(CRON_FILE, 'utf8')); } catch (_) { cronJobs = []; } }
function saveCrons()  { try { fs.mkdirSync(path.dirname(CRON_FILE), { recursive: true }); fs.writeFileSync(CRON_FILE, JSON.stringify(cronJobs, null, 2)); } catch (_) {} }
function makeCronId() { return Math.random().toString(36).slice(2, 8); }

function parseCronInterval(schedule) {
  const m = /^(\d+)(s|m|h|d)$/.exec(schedule);
  if (!m) return null;
  return parseInt(m[1], 10) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
}

async function fireCron(job) {
  job.lastRun = new Date().toISOString();
  job.runCount = (job.runCount || 0) + 1;
  saveCrons();
  // cron tick silent
  try {
    const reply = await agentLoop([{ role: 'system', content: buildSystemPrompt() }, { role: 'user', content: job.prompt }]);
    job.lastOutput = reply;
    saveCrons();
    notify(`Cron: ${job.name || job.id}`, reply.slice(0, 120));
    console.log(colorize(C.greenBold, `\n[cron:${job.id}] `) + renderResponse(reply) + '\n');
  } catch (e) {
    notify(`Cron failed: ${job.id}`, e.message);
    console.log(colorize(C.red, `\n[cron:${job.id}] Error: ${e.message}\n`));
  }
  rl.prompt();
}

function registerCronTimer(job) {
  if (!job.enabled) return;
  const ms = parseCronInterval(job.schedule);
  if (ms === null) { console.log(colorize(C.yellow, `[cron] Unknown schedule "${job.schedule}" for ${job.id} — skipping`)); return; }
  if (cronTimers[job.id]) clearInterval(cronTimers[job.id]);
  cronTimers[job.id] = setInterval(() => fireCron(job), ms);
}

function startAllCrons() {
  loadCrons();
  cronJobs.filter(j => j.enabled).forEach(registerCronTimer);
}

// ── Remote trigger server ─────────────────────────────────────────────────────
const TRIGGER_TOKEN_FILE = path.join(require('os').homedir(), '.proverbs', 'trigger.token');

function getTriggerToken() {
  try { const t = fs.readFileSync(TRIGGER_TOKEN_FILE, 'utf8').trim(); if (t) return t; } catch (_) {}
  const tok = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  try { fs.mkdirSync(path.dirname(TRIGGER_TOKEN_FILE), { recursive: true }); fs.writeFileSync(TRIGGER_TOKEN_FILE, tok); } catch (_) {}
  return tok;
}

async function startTriggerServer(port) {
  if (triggerServer) { console.log(colorize(C.yellow, '\n  Trigger server already running.\n')); return false; }
  const token = getTriggerToken();
  triggerPort = port || triggerPort;
  const _http = require('http');
  triggerServer = _http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const reqToken = req.headers['x-proverbs-token'] || '';
    if (reqToken !== token) { res.writeHead(401); res.end(JSON.stringify({ error: 'unauthorized' })); return; }
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/status') {
      res.writeHead(200); res.end(JSON.stringify({ running: true, model, cwd, uptime: process.uptime() })); return;
    }
    if (req.method === 'GET' && url === '/tasks') {
      res.writeHead(200); res.end(JSON.stringify(taskStore)); return;
    }
    if (req.method === 'GET' && url === '/crons') {
      res.writeHead(200); res.end(JSON.stringify(cronJobs)); return;
    }
    if (req.method === 'POST' && url === '/trigger') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        let data = {};
        try { data = JSON.parse(body); } catch (_) { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid JSON' })); return; }
        if (!data.prompt) { res.writeHead(400); res.end(JSON.stringify({ error: 'prompt required' })); return; }
        const task = taskCreate(data.prompt.slice(0, 60), data.prompt);
        res.writeHead(202); res.end(JSON.stringify({ taskId: task.id, status: 'queued' }));
        taskUpdate(task.id, { status: 'in_progress' });
        try {
          const reply = await agentLoop([{ role: 'system', content: buildSystemPrompt() }, { role: 'user', content: data.prompt }]);
          taskUpdate(task.id, { status: 'completed', output: reply });
          notify('Remote trigger complete', reply.slice(0, 100));
          console.log(colorize(C.dim, `\n[trigger:${task.id}] Completed\n`));
        } catch (e) {
          taskUpdate(task.id, { status: 'failed', output: e.message });
          notify('Remote trigger failed', e.message);
        }
        rl.prompt();
      });
      return;
    }
    res.writeHead(404); res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise((resolve) => {
    triggerServer.listen(triggerPort, '127.0.0.1', () => {
      console.log(colorize(C.green, `\n✔  Trigger server at http://127.0.0.1:${triggerPort}`));
      console.log(colorize(C.dim, `   Token: ${token.slice(0,6)}… (run /trigger token to reveal)\n`));
      resolve(true);
    });
    triggerServer.on('error', (e) => { console.log(colorize(C.red, `\n✗  Trigger server error: ${e.message}\n`)); triggerServer = null; resolve(false); });
  });
}

function stopTriggerServer() {
  if (!triggerServer) return false;
  triggerServer.close();
  triggerServer = null;
  return true;
}

// ── Multi-agent helpers ───────────────────────────────────────────────────────
function makeAgentRunId() { return Math.random().toString(36).slice(2, 8); }

function parseQuotedArgs(str) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(str)) !== null) out.push(m[1].replace(/\\"/g, '"'));
  return out;
}

// ── Framework detection ───────────────────────────────────────────────────────
function readEnvKeys(dir) {
  const candidates = ['.env.local', '.env', '.env.example'];
  for (const name of candidates) {
    try {
      const fp = path.join(dir, name);
      if (!fs.existsSync(fp)) continue;
      const raw = fs.readFileSync(fp, 'utf8');
      const keys = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq > 0) keys.push(trimmed.slice(0, eq).trim());
      }
      return keys;
    } catch (_) {}
  }
  return [];
}

function readPrismaSchema(dir) {
  try {
    const fp = path.join(dir, 'prisma', 'schema.prisma');
    if (!fs.existsSync(fp)) return '';
    return fs.readFileSync(fp, 'utf8').trim().slice(0, 2000);
  } catch (_) { return ''; }
}

function readConfigSnippet(dir, filenames) {
  for (const name of filenames) {
    try {
      const fp = path.join(dir, name);
      if (!fs.existsSync(fp)) continue;
      return fs.readFileSync(fp, 'utf8').slice(0, 800);
    } catch (_) {}
  }
  return '';
}

function detectFrameworks(dir) {
  if (!dir || typeof dir !== 'string') return [];

  const pkgPath = path.join(dir, 'package.json');

  try {
    if (!fs.existsSync(pkgPath)) return [];
  } catch (_) {
    return [];
  }

  let raw;
  try {
    raw = fs.readFileSync(pkgPath, 'utf8');
  } catch (_) {
    return [];
  }

  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (_) {
    return [];
  }

  if (!pkg || typeof pkg !== 'object') return [];

  const deps    = (pkg.dependencies    && typeof pkg.dependencies    === 'object') ? pkg.dependencies    : {};
  const devDeps = (pkg.devDependencies && typeof pkg.devDependencies === 'object') ? pkg.devDependencies : {};
  const allDeps = Object.assign({}, deps, devDeps);

  const has = (name) => Object.prototype.hasOwnProperty.call(allDeps, name);

  const hints = [];

  if (has('next')) {
    hints.push("Project uses Next.js 15 App Router. Server components are async by default. Client components need 'use client' at the top. API routes go in app/api/[route]/route.ts and export GET/POST/etc. Server actions use 'use server' directive. Use loading.tsx for suspense, error.tsx for error boundaries, layout.tsx for shared layouts. generateMetadata() for SEO. Middleware in middleware.ts at project root.");
  }
  if (has('@prisma/client')) {
    const schema = readPrismaSchema(dir);
    let hint = "Prisma ORM. Schema: prisma/schema.prisma. Client: import { db } from '@/lib/db'. After schema changes: npx prisma migrate dev (dev) or npx prisma db push (quick). Never edit prisma/migrations/ manually. Always use @@map for snake_case table names. Use include:{} for relations.";
    if (schema) hint += '\n\nCurrent Prisma schema:\n' + schema;
    hints.push(hint);
  }
  if (has('@supabase/supabase-js')) {
    hints.push("Supabase: createClient from @supabase/supabase-js. Enable RLS on ALL tables — default deny. Policies: CREATE POLICY name ON table FOR action TO role USING (condition). Auth: supabase.auth.signInWithPassword / signUp / getUser. Storage: supabase.storage.from(bucket). Type-safe: run 'supabase gen types typescript --local > types/supabase.ts' and use Database generic. Use createServerClient (SSR package) in server components.");
  }
  if (has('stripe')) {
    hints.push("Stripe: create server-side client with new Stripe(process.env.STRIPE_SECRET_KEY). Verify webhooks: stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET). For subscriptions: use Checkout Sessions with mode:'subscription'. For Stripe Connect: include transfer_data:{destination:accountId} or application_fee_amount on PaymentIntent. Use stripe.accounts.create for onboarding.");
  }
  if (has('@capacitor/core')) {
    hints.push("Capacitor iOS/Android wrapper. After every web build: npx cap sync (copies dist + updates native). npx cap open ios — open in Xcode. npx cap open android — open in Android Studio. Native plugins: @capacitor/camera, @capacitor/filesystem, @capacitor/push-notifications. For App Store: set bundle ID in capacitor.config.ts. Use EAS Build (expo) or Xcode archive for production builds.");
  }
  if (has('electron')) {
    hints.push("Electron desktop app. Main process: main.js. IPC: ipcMain.handle / ipcRenderer.invoke. Preload scripts required for contextIsolation. Use contextBridge.exposeInMainWorld in preload.js to safely expose APIs. Avoid remote module. Package with electron-builder (mac/win/linux). Use app.getPath('userData') for user data storage.");
  }
  if (has('tailwindcss')) {
    const snippet = readConfigSnippet(dir, ['tailwind.config.ts', 'tailwind.config.js']);
    let hint = "Tailwind CSS: utility classes only. Config: tailwind.config.js/ts. Use cn() or clsx() for conditional classes. Extend theme under theme.extend. Dark mode: add 'dark' class to html element (class strategy).";
    if (snippet) hint += '\n\nTailwind config:\n' + snippet.slice(0, 600);
    hints.push(hint);
  }
  if (has('react')) {
    hints.push("React with hooks. Functional components only. State: useState/useReducer. Effects: useEffect. Context: createContext/useContext.");
  }
  if (has('express')) {
    hints.push("Express.js server. Router: express.Router(). Middleware with app.use(). Error handler: (err, req, res, next) => {}.");
  }
  if (has('drizzle-orm')) {
    hints.push("Drizzle ORM. Schema in db/schema.ts. Query: db.select().from(table). Migrations: npx drizzle-kit push.");
  }
  if (has('next-auth')) {
    hints.push("NextAuth.js: auth options in app/api/auth/[...nextauth]/route.ts (App Router) or pages/api/auth/[...nextauth].ts. Get server session: const session = await getServerSession(authOptions). Extend session type: declare module 'next-auth' { interface Session { user: { id: string } } }. Use useSession() in client components. Protect routes in middleware.ts with auth().");
  }
  if (has('framer-motion')) {
    hints.push("Framer Motion: import { motion } from 'framer-motion'. Animate with motion.div, motion.button etc. Use variants for reusable animations: const variants = { hidden:{opacity:0}, visible:{opacity:1} }. AnimatePresence for exit animations. useAnimation() for imperative control. LazyMotion + domAnimation for smaller bundle.");
  }
  if (has('zustand')) {
    hints.push("Zustand state: create store with create((set) => ({ ... })). Access in components: const value = useStore(s => s.value). Mutations: set(state => ({ count: state.count + 1 })). Persist middleware: import { persist } from 'zustand/middleware'. Keep stores small and domain-specific.");
  }
  if (has('zod')) {
    hints.push("Zod validation: define schema with z.object({ field: z.string().min(1) }). Parse: schema.parse(data) throws on error; schema.safeParse(data) returns {success, data|error}. Infer TypeScript type: type T = z.infer<typeof schema>. Use with react-hook-form: import { zodResolver } from '@hookform/resolvers/zod'.");
  }
  if (has('react-hook-form')) {
    hints.push("React Hook Form: const { register, handleSubmit, formState: { errors } } = useForm({ resolver: zodResolver(schema) }). Always pair with Zod for validation. Use Controller for controlled components (Select, DatePicker etc).");
  }
  if (has('@revenuecat/purchases-capacitor') || has('react-native-purchases')) {
    hints.push("RevenueCat IAP: configure with Purchases.configure({ apiKey }). Get offerings: await Purchases.getOfferings(). Purchase: await Purchases.purchasePackage(pkg). Restore: await Purchases.restorePurchases(). Webhook events: INITIAL_PURCHASE, RENEWAL, CANCELLATION, EXPIRATION. Validate entitlements server-side via /v1/subscribers endpoint.");
  }

  const envKeys = readEnvKeys(dir);
  if (envKeys.length > 0) {
    hints.push('Available environment variables (keys only): ' + envKeys.join(', '));
  }

  return hints;
}

// ── Code conventions detector ─────────────────────────────────────────────────
function detectConventions(dir) {
  if (!dir || typeof dir !== 'string') return [];
  const results = [];
  try {
    // Package manager
    const hasPnpm = fs.existsSync(path.join(dir, 'pnpm-lock.yaml'));
    const hasYarn = fs.existsSync(path.join(dir, 'yarn.lock'));
    results.push('Package manager: ' + (hasPnpm ? 'pnpm' : hasYarn ? 'yarn' : 'npm'));
    // Router style
    if (fs.existsSync(path.join(dir, 'app'))) results.push('Next.js App Router (app/ directory)');
    else if (fs.existsSync(path.join(dir, 'pages'))) results.push('Next.js Pages Router (pages/ directory)');
    if (fs.existsSync(path.join(dir, 'src'))) results.push('Source files in src/');
    // TypeScript aliases
    const tscPath = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(tscPath)) {
      try {
        const ts = JSON.parse(fs.readFileSync(tscPath, 'utf8'));
        const tsPaths = ((ts.compilerOptions || {}).paths || {});
        Object.entries(tsPaths).slice(0, 6).forEach(([a, t]) => {
          results.push('Import alias: ' + a + ' → ' + (Array.isArray(t) ? t[0] : t));
        });
      } catch (_) {}
    }
    // Indent + quote + semi style from sampled source files.
    // Native walk instead of spawning `find` — runs at startup, so the
    // subprocess fork/exec cost (50-150ms) was pure latency.
    const jsFiles = [];
    const sampleWalk = (d, depth) => {
      if (depth > 3 || jsFiles.length >= 10) return;
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); }
      catch (_) { return; }
      for (const e of entries) {
        if (jsFiles.length >= 10) return;
        if (e.name.startsWith('.')) continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          if (!RAG_SKIP_DIRS.has(e.name)) sampleWalk(full, depth + 1);
        } else if (e.isFile() && /\.(ts|tsx|js|jsx)$/.test(e.name)) {
          jsFiles.push(full);
        }
      }
    };
    try { sampleWalk(dir, 0); } catch (_) {}
    let useTabs = 0, useSpaces = 0, singleQ = 0, doubleQ = 0, withSemi = 0, noSemi = 0;
    for (const f of jsFiles.slice(0, 6)) {
      try {
        const src = fs.readFileSync(f, 'utf8');
        const lines = src.split('\n');
        lines.slice(0, 30).forEach(l => {
          if (/^\t/.test(l)) useTabs++;
          else if (/^ {2,}/.test(l)) useSpaces++;
        });
        singleQ += (src.match(/'/g) || []).length;
        doubleQ += (src.match(/"/g) || []).length;
        lines.slice(0, 30).filter(l => l.trim().length > 0).forEach(l => {
          if (/;$/.test(l.trimEnd())) withSemi++;
          else noSemi++;
        });
      } catch (_) {}
    }
    if (jsFiles.length > 0) {
      results.push('Indent style: ' + (useTabs > useSpaces ? 'tabs' : useSpaces > 0 ? 'spaces' : 'unknown'));
      results.push('Quote style: ' + (singleQ >= doubleQ ? 'single' : 'double'));
      results.push('Semicolons: ' + (withSemi >= noSemi ? 'yes' : 'no'));

      // File naming convention
      let kebab = 0, pascal = 0, camel = 0;
      for (const f of jsFiles) {
        const base = path.basename(f, path.extname(f));
        if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(base)) kebab++;
        else if (/^[A-Z][a-zA-Z0-9]+$/.test(base)) pascal++;
        else if (/^[a-z][a-zA-Z0-9]+$/.test(base)) camel++;
      }
      const maxNaming = Math.max(kebab, pascal, camel);
      if (maxNaming > 0) {
        const namingStyle = maxNaming === kebab ? 'kebab-case' : maxNaming === pascal ? 'PascalCase' : 'camelCase';
        results.push('File naming: ' + namingStyle);
      }

      // Default export vs named export pattern
      let defaultExports = 0, namedExports = 0;
      for (const f of jsFiles.slice(0, 6)) {
        try {
          const src = fs.readFileSync(f, 'utf8');
          if (/^export default /m.test(src)) defaultExports++;
          if (/^export (const|function|class) /m.test(src)) namedExports++;
        } catch (_) {}
      }
      if (defaultExports > 0 || namedExports > 0) {
        results.push('Export style: ' + (defaultExports >= namedExports ? 'default exports' : 'named exports'));
      }
    }

    // Folder structure conventions
    const commonFolders = ['components', 'hooks', 'utils', 'lib', 'services', 'api', 'store', 'context', 'types', 'styles', 'middleware', 'actions'];
    const foundFolders = commonFolders.filter(f =>
      fs.existsSync(path.join(dir, f)) || fs.existsSync(path.join(dir, 'src', f))
    );
    if (foundFolders.length > 0) {
      results.push('Folders: ' + foundFolders.join(', '));
    }
  } catch (_) {}
  return results;
}

// ── Git context loader ─────────────────────────────────────────────────────────
function loadGitContext(dir) {
  if (!dir || typeof dir !== 'string') { gitContextStr = ''; return; }
  try {
    execSync('git -C ' + JSON.stringify(dir) + ' rev-parse --is-inside-work-tree 2>/dev/null', { stdio: 'pipe' });
  } catch (_) {
    // not a git repository
    gitContextStr = '';
    return;
  }
  try {
    let branch = '';
    try {
      branch = execSync('git -C ' + JSON.stringify(dir) + ' rev-parse --abbrev-ref HEAD 2>/dev/null', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch (_) { branch = 'unknown'; }
    let log = '';
    try {
      log = execSync('git -C ' + JSON.stringify(dir) + ' log --oneline -5 2>/dev/null', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch (_) {}
    let status = '';
    try {
      status = execSync('git -C ' + JSON.stringify(dir) + ' status --short 2>/dev/null', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch (_) {}
    const parts = [];
    if (branch) parts.push('Branch: ' + branch);
    if (log) parts.push('Recent commits:\n' + log);
    if (status) parts.push('Uncommitted changes:\n' + status);
    gitContextStr = parts.join('\n');
  } catch (_) {
    gitContextStr = '';
  }
}

// ── Cloud fallback: direct Anthropic/OpenAI API (no LiteLLM proxy needed) ────
async function cloudFallbackChat(msgs) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey    = process.env.OPENAI_API_KEY;

  if (anthropicKey) {
    // Direct Anthropic Messages API
    const system  = msgs.find(m => m.role === 'system');
    const convMsgs = msgs.filter(m => m.role !== 'system');
    const body = JSON.stringify({
      model: fallbackModel.startsWith('claude') ? fallbackModel : 'claude-sonnet-4-6',
      max_tokens: 4096,
      ...(system ? { system: system.content } : {}),
      messages: convMsgs,
    });
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com', port: 443, path: '/v1/messages', method: 'POST',
        headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            let creditsErr = false;
            try { const tmp = JSON.parse(raw); if (tmp.error && (tmp.error.type === 'credits_required' || (tmp.error.message || '').toLowerCase().includes('credit'))) creditsErr = true; } catch (_) {}
            const err = new Error(`Anthropic HTTP ${res.statusCode}: ${raw.slice(0, 200)}`);
            if (creditsErr) err.code = 'CREDITS_REQUIRED';
            return reject(err);
          }
          try {
            const d = JSON.parse(raw);
            if (d.error) {
              const msg = d.error.message || JSON.stringify(d.error);
              const err = new Error(`Anthropic error: ${msg}`);
              if (d.error.type === 'credits_required' || msg.toLowerCase().includes('credit')) err.code = 'CREDITS_REQUIRED';
              return reject(err);
            }
            resolve((d.content && d.content[0] && d.content[0].text) || '');
          } catch (e) { reject(new Error('Anthropic parse error: ' + e.message)); }
        });
      });
      req.on('error', reject);
      req.setTimeout(60000, () => { req.destroy(); reject(new Error('Anthropic request timed out')); });
      req.write(body); req.end();
    });
  }

  if (openaiKey) {
    // Direct OpenAI Chat Completions API
    const body = JSON.stringify({
      model: fallbackModel.startsWith('gpt') ? fallbackModel : 'gpt-4o',
      messages: msgs,
    });
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.openai.com', port: 443, path: '/v1/chat/completions', method: 'POST',
        headers: { 'Authorization': 'Bearer ' + openaiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`OpenAI HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
          try {
            const d = JSON.parse(raw);
            if (d.error) return reject(new Error(`OpenAI error: ${d.error.message || JSON.stringify(d.error)}`));
            resolve((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '');
          } catch (e) { reject(new Error('OpenAI parse error: ' + e.message)); }
        });
      });
      req.on('error', reject);
      req.setTimeout(60000, () => { req.destroy(); reject(new Error('OpenAI request timed out')); });
      req.write(body); req.end();
    });
  }

  // Fallback: LiteLLM proxy (backward compat)
  return litellmProxyChat(msgs);
}

// ── LiteLLM proxy (used only when no direct API key is set) ──────────────────
async function litellmProxyChat(msgs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(LITELLM_BASE + '/v1/chat/completions');
    const body = JSON.stringify({ model: fallbackModel, messages: msgs, stream: false });
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Accept': 'application/json' },
    };
    let timer = null;
    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let detail = raw.slice(0, 300);
          try { const e = JSON.parse(raw); detail = (e.error && (e.error.message || JSON.stringify(e.error))) || e.message || detail; } catch (_) {}
          return reject(new Error(`LiteLLM returned HTTP ${res.statusCode}: ${detail}`));
        }
        try {
          const d = JSON.parse(raw);
          if (d.error) return reject(new Error(`LiteLLM error: ${d.error.message || JSON.stringify(d.error)}`));
          const content = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || (d.message && d.message.content) || '';
          resolve(content);
        } catch (e) { reject(new Error(`LiteLLM JSON parse error: ${e.message}`)); }
      });
    });
    timer = setTimeout(() => { req.destroy(); reject(new Error('LiteLLM request timed out after 60s. Check that the proxy is healthy.')); }, 60000);
    req.on('error', (err) => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ECONNRESET') {
        reject(new Error('LiteLLM unavailable — is the proxy running? (proverbs start)'));
      } else {
        reject(new Error(`LiteLLM connection error: ${err.message}`));
      }
    });
    req.write(body); req.end();
  });
}
// Keep litellmChat as alias for backward compat
const litellmChat = cloudFallbackChat;

// ─── Multi-backend router ──────────────────────────────────────────────────────
const BACKEND_CANDIDATES = [
  { name: 'Proverbs Server', base: 'http://localhost:11435',       api: 'ollama',  checkPath: '/api/tags'  },
  { name: 'llamafile',       base: 'http://localhost:8080',        api: 'openai',  checkPath: '/v1/models' },
  ...(process.env.GROQ_API_KEY ? [
    { name: 'Groq',          base: 'https://api.groq.com/openai',  api: 'openai',  checkPath: '/v1/models', defaultModel: 'openai/gpt-oss-20b' },
  ] : []),
];
const PROVERBS_SERVER_SCRIPT = require('path').join(__dirname, 'server', 'server.js');

function probeBackend(candidate) {
  return new Promise((resolve) => {
    const parsed = new URL(candidate.base + candidate.checkPath);
    const isHttps = parsed.protocol === 'https:';
    const headers = {};
    if (process.env.GROQ_API_KEY && parsed.hostname.includes('groq.com')) {
      headers['Authorization'] = 'Bearer ' + process.env.GROQ_API_KEY;
    }
    const opts = { hostname: parsed.hostname, port: Number(parsed.port) || (isHttps ? 443 : 80), path: parsed.pathname, method: 'GET', headers };
    const lib = isHttps ? https : http;
    const req = lib.request(opts, (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 500); });
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function detectBackend(silent) {
  for (const candidate of BACKEND_CANDIDATES) {
    const ok = await probeBackend(candidate);
    if (ok) {
      OLLAMA_BASE       = candidate.base;
      activeApiFormat   = candidate.api;
      activeBackendName = candidate.name;
      if (candidate.defaultModel) model = candidate.defaultModel;
      return candidate;
    }
  }
  return null;
}

// ── LAN scanner — find Proverbs XPS server on local network ─────────────────
async function _scanLanForProverbs(verbose) {
  const os2 = require('os');
  const PORT = 11435;

  // Get local subnet prefix (e.g. "192.168.1")
  let subnet = null;
  try {
    const ifaces = os2.networkInterfaces();
    for (const iface of Object.values(ifaces)) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal && addr.address.match(/^(192|10|172)/)) {
          subnet = addr.address.split('.').slice(0, 3).join('.');
          break;
        }
      }
      if (subnet) break;
    }
  } catch (_) {}

  if (!subnet) { if (verbose) console.log(colorize(C.red, '  Could not determine local subnet.\n')); return false; }

  if (verbose) console.log(colorize(C.dim, `  Scanning ${subnet}.1-254:${PORT} ...`));

  // Check persisted XPS URL first (fastest path)
  try {
    const _rc = path.join(PROVERBS_DIR, 'routing.json');
    const _rd = fs.existsSync(_rc) ? JSON.parse(fs.readFileSync(_rc,'utf8')) : {};
    if (_rd.xpsUrl) {
      const r = await httpGet(_rd.xpsUrl + '/api/tags', 2000).catch(() => null);
      if (r && r.status === 200) {
        OLLAMA_BASE = _rd.xpsUrl; activeApiFormat = 'ollama'; activeBackendName = 'Proverbs XPS';
        console.log(colorize(C.green, `\n✔  Reconnected to saved XPS: ${_rd.xpsUrl}\n`));
        return true;
      }
    }
  } catch (_) {}

  // Parallel scan — probe all 254 hosts concurrently in batches of 30
  const batch = 30;
  for (let start = 1; start <= 254; start += batch) {
    const checks = [];
    for (let i = start; i < start + batch && i <= 254; i++) {
      const url = `http://${subnet}.${i}:${PORT}`;
      checks.push(
        httpGet(url + '/api/tags', 800)
          .then(r => r.status === 200 ? url : null)
          .catch(() => null)
      );
    }
    const results = await Promise.all(checks);
    const found = results.find(Boolean);
    if (found) {
      OLLAMA_BASE = found; activeApiFormat = 'ollama'; activeBackendName = 'Proverbs XPS';
      // Persist for next time
      try {
        const _rc = path.join(PROVERBS_DIR, 'routing.json');
        const _rd = fs.existsSync(_rc) ? JSON.parse(fs.readFileSync(_rc,'utf8')) : {};
        _rd.xpsUrl = found;
        fs.writeFileSync(_rc, JSON.stringify(_rd, null, 2));
      } catch (_) {}
      console.log(colorize(C.green, `\n✔  Found Proverbs XPS at ${found}\n`));
      return true;
    }
  }
  return false;
}

// ── npm docs ───────────────────────────────────────────────────────────────────
function parseGithubRawBase(repoUrl) {
  if (!repoUrl || typeof repoUrl !== 'string') return null;

  let url = repoUrl.trim()
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');

  const sshMatch = url.match(/^git@github\.com[:/](.+)$/);
  if (sshMatch) {
    url = 'https://github.com/' + sshMatch[1];
  }

  if (url.startsWith('github:')) {
    url = 'https://github.com/' + url.slice('github:'.length);
  }

  let parsed;
  try { parsed = new URL(url); } catch (_) { return null; }

  if (!parsed.hostname.includes('github.com')) return null;

  const parts = parsed.pathname.replace(/^\//, '').split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;

  const user = parts[0];
  const repo = parts[1];
  return `https://raw.githubusercontent.com/${user}/${repo}`;
}

async function fetchGithubReadme(rawBase) {
  for (const branch of DOCS_README_BRANCHES) {
    for (const filename of DOCS_README_FILENAMES) {
      const url = `${rawBase}/${branch}/${filename}`;
      let res;
      try { res = await httpsGet(url); } catch (_) { continue; }
      if (res.status === 200 && res.body && res.body.trim().length > 0) {
        return { content: res.body, url };
      }
    }
  }
  return null;
}

function truncateReadme(text, maxChars) {
  if (!text) return '';

  let cutPoint = maxChars;
  const h2Regex = /^## /gm;
  let match;
  let count = 0;
  while ((match = h2Regex.exec(text)) !== null) {
    count++;
    if (count === 3) {
      cutPoint = Math.min(match.index, maxChars);
      break;
    }
  }

  const excerpt = text.slice(0, cutPoint).trimEnd();
  if (text.length > cutPoint) {
    return excerpt + '\n\n... (truncated)';
  }
  return excerpt;
}

async function fetchPackageDocs(pkgName) {
  if (!pkgName || typeof pkgName !== 'string' || !pkgName.trim()) {
    throw new Error('Package name is required.');
  }

  const pkg = pkgName.trim();

  const encodedPkg = pkg.startsWith('@')
    ? '@' + encodeURIComponent(pkg.slice(1))
    : encodeURIComponent(pkg);

  const registryUrl = `https://registry.npmjs.org/${encodedPkg}/latest`;
  let meta;
  try {
    const res = await httpsGet(registryUrl);
    if (res.status === 404) {
      throw new Error(`Package "${pkg}" not found on npm.`);
    }
    if (res.status !== 200) {
      throw new Error(`npm registry returned HTTP ${res.status} for "${pkg}".`);
    }
    if (!res.body || !res.body.trim()) {
      throw new Error(`npm registry returned an empty response for "${pkg}".`);
    }
    try {
      meta = JSON.parse(res.body);
    } catch (parseErr) {
      throw new Error(`Failed to parse npm registry response: ${parseErr.message}`);
    }
  } catch (e) {
    throw new Error(`npm registry error: ${e.message}`);
  }

  const description = (meta.description || '').trim();
  const homepage    = (meta.homepage    || '').trim();
  const version     = (meta.version     || 'unknown').trim();

  let repoUrl = '';
  if (meta.repository) {
    if (typeof meta.repository === 'string') {
      repoUrl = meta.repository;
    } else if (typeof meta.repository === 'object' && meta.repository.url) {
      repoUrl = meta.repository.url;
    }
  }

  const rawBase = parseGithubRawBase(repoUrl);

  let readmeExcerpt = '';

  if (rawBase) {
    const readmeResult = await fetchGithubReadme(rawBase);
    if (readmeResult && readmeResult.content) {
      readmeExcerpt = truncateReadme(readmeResult.content, DOCS_TRUNCATE_CHARS);
    } else {
      readmeExcerpt = '(README not found on GitHub — check the npm page for documentation.)';
    }
  } else {
    if (meta.readme && meta.readme.trim() && meta.readme !== 'ERROR: No README data found!') {
      readmeExcerpt = truncateReadme(meta.readme, DOCS_TRUNCATE_CHARS);
    } else {
      readmeExcerpt = '(No README available — repository is not hosted on GitHub or URL is missing.)';
    }
  }

  const docParts = [`## ${pkg} documentation (v${version})`];
  if (description) docParts.push(description);
  if (homepage)    docParts.push(`\nHomepage: ${homepage}`);
  docParts.push('');
  docParts.push(readmeExcerpt);

  return docParts.join('\n');
}

async function toolFetchDocs(args) {
  const pkgName = (args.package || args.pkg || '').trim();
  if (!pkgName) return 'ERROR: package name is required.';

  try {
    return await fetchPackageDocs(pkgName);
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

// ── fetch_url ─────────────────────────────────────────────────────────────────
async function toolFetchUrl(args) {
  const url = (args.url || '').trim();
  if (!url) return 'ERROR: url is required';
  if (!/^https?:\/\//i.test(url)) return 'ERROR: URL must start with http:// or https://';

  let resp;
  try {
    const fetchPromise = url.toLowerCase().startsWith('https://') ? httpsGet(url, 8000) : httpGet(url, 8000);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error('Request timed out after 8s'), { code: 'ETIMEDOUT' })), 8000)
    );
    resp = await Promise.race([fetchPromise, timeoutPromise]);
  } catch (e) {
    if (e.code === 'ECONNREFUSED') return 'ERROR: Connection refused — is the server running? (' + url + ')';
    if (e.code === 'ENOTFOUND')    return 'ERROR: Host not found: ' + url;
    if (e.code === 'ETIMEDOUT')    return 'ERROR: Request timed out: ' + url;
    return 'ERROR fetching ' + url + ': ' + e.message;
  }

  if (resp.status && resp.status >= 400) {
    return 'ERROR: HTTP ' + resp.status + ' — ' + url;
  }

  let body = typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body, null, 2);

  // Detect content type from first non-whitespace characters
  const trimmed = body.trimStart();
  const first200 = trimmed.slice(0, 200).toLowerCase();
  const isHtml = /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]/.test(first200) || trimmed.startsWith('<');
  const isJson = !isHtml && (trimmed.startsWith('{') || trimmed.startsWith('['));

  if (isHtml) {
    const selector = (args.selector || '').trim();
    if (selector) {
      // Try exact tag match first, then fall back to class/id attribute scan
      const tagRe = new RegExp('<' + selector + '[\\s>][\\s\\S]*?<\\/' + selector + '>', 'i');
      const tagMatch = body.match(tagRe);
      if (tagMatch) {
        body = tagMatch[0];
      } else {
        const attrRe = new RegExp('<[a-z][^>]+(?:class|id)=["\'][^"\']*' + selector + '[^"\']*["\'][^>]*>[\\s\\S]*?<\\/[a-z]+>', 'i');
        const attrMatch = body.match(attrRe);
        if (attrMatch) body = attrMatch[0];
      }
    }
    body = body
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g,  ' ')
      .replace(/&amp;/g,   '&')
      .replace(/&lt;/g,    '<')
      .replace(/&gt;/g,    '>')
      .replace(/&quot;/g,  '"')
      .replace(/&#39;/g,   "'")
      .replace(/\s+/g,     ' ')
      .trim();
    body = body.slice(0, 8000);
  } else if (isJson) {
    try {
      // Pretty-print valid JSON for readability
      body = JSON.stringify(JSON.parse(body), null, 2);
    } catch (_) { /* use raw body if parse fails */ }
    body = body.slice(0, 4000);
  } else {
    body = body.slice(0, 6000);
  }

  return '=== ' + url + ' ===\n' + body;
}

// ── Context compression ────────────────────────────────────────────────────────
async function compressHistory(hist, currentModel) {
  let existingSummaryMsg = null;
  let workingHist = hist;
  if (
    hist.length > 0 &&
    hist[0].role === 'system' &&
    typeof hist[0].content === 'string' &&
    hist[0].content.startsWith('Prior conversation summary:')
  ) {
    existingSummaryMsg = hist[0];
    workingHist = hist.slice(1);
  }

  const recent = workingHist.slice(-COMPRESS_KEEP_RECENT);
  const older  = workingHist.slice(0, -COMPRESS_KEEP_RECENT);

  if (older.length < COMPRESS_MIN_OLDER) return hist;

  const lines = older.map(m => {
    const role    = (m.role || 'unknown').toUpperCase();
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return `${role}: ${content.slice(0, COMPRESS_MSG_PREVIEW)}`;
  });

  if (existingSummaryMsg) {
    const priorText = existingSummaryMsg.content
      .replace('Prior conversation summary:', '')
      .trim()
      .slice(0, COMPRESS_MSG_PREVIEW);
    lines.unshift('PRIOR SUMMARY: ' + priorText);
  }

  const text = lines.join('\n');

  const fastModel = (routingConfig && routingConfig.fast) || currentModel;

  let summary;
  try {
    const summaryResp = await httpPost(OLLAMA_BASE + '/api/chat', {
      model: fastModel,
      messages: [
        {
          role: 'system',
          content:
            'You are a concise summarizer. Summarize the conversation below. ' +
            'Preserve: file paths changed or created, decisions made, errors encountered, ' +
            'key code snippets or variable names, and any user preferences stated. ' +
            'Output plain prose — no headers, no bullet overload. Be concise but complete.',
        },
        { role: 'user', content: text },
      ],
      stream: false,
    });

    if (!summaryResp || typeof summaryResp !== 'object') {
      throw new Error('compressHistory: empty response from Ollama');
    }

    const msgObj = summaryResp.message || null;
    if (msgObj && typeof msgObj === 'object' && typeof msgObj.content === 'string' && msgObj.content.trim()) {
      summary = msgObj.content.trim();
    } else if (typeof summaryResp.response === 'string' && summaryResp.response.trim()) {
      summary = summaryResp.response.trim();
    } else {
      throw new Error('compressHistory: could not extract summary text from response');
    }
  } catch (_) {
    return hist;
  }

  if (!summary || summary.length < 10) return hist;

  return [
    { role: 'system', content: 'Prior conversation summary: ' + summary },
    ...recent,
  ];
}

// ── Feature 10: Smart routing ─────────────────────────────────────────────────
function loadRoutingConfig() {
  try {
    const raw = fs.readFileSync(ROUTING_FILE, 'utf8');
    routingConfig = Object.assign({ fast: null, smart: null, vision: null, routing: 'auto' }, JSON.parse(raw));
  } catch (_) {}
}

function saveRoutingConfig() {
  ensureProverbsDir();
  fs.writeFileSync(ROUTING_FILE, JSON.stringify(routingConfig, null, 2), 'utf8');
}

async function fetchAvailableModels() {
  try {
    const res = await httpGet(`${OLLAMA_BASE}/api/tags`);
    if (res.status !== 200) return [];
    const data = JSON.parse(res.body);
    return (data.models || []).map(m => m.name);
  } catch (_) { return []; }
}

async function autoDetectRoutingModels() {
  const available = await fetchAvailableModels();
  if (available.length === 0) return;
  if (!routingConfig.fast) {
    routingConfig.fast = FAST_PRIORITY.find(m => available.includes(m)) || available[0] || null;
  }
  if (!routingConfig.smart) {
    routingConfig.smart = SMART_PRIORITY.find(m => available.includes(m)) || routingConfig.fast || null;
  }
  saveRoutingConfig();
}

function decideRouting(userMessage) {
  if (routingConfig.routing !== 'auto') return null;
  const msg = userMessage.toLowerCase();
  const hasSmart = SMART_KEYWORDS.some(k => msg.includes(k));
  const hasFast  = FAST_KEYWORDS.some(k => msg.includes(k));
  if (hasSmart) return { tier: 'smart', model: routingConfig.smart || model };
  if (hasFast || userMessage.length < 100) return { tier: 'fast', model: routingConfig.fast || model };
  return { tier: 'fast', model: routingConfig.fast || model };
}

// ─── Thinking-mode helpers ────────────────────────────────────────────────────
function modelSupportsThinking(m) {
  if (typeof m !== 'string' || !m) return false;
  return THINKING_MODELS.some(function(t) { return m.toLowerCase().includes(t); });
}

function buildThinkingPrompt(userMsg) {
  if (typeof userMsg !== 'string') return userMsg;
  if (userMsg.includes('<think>')) return userMsg;
  return '<think>\nLet me carefully analyze this request step by step.\n</think>\n\n' + userMsg;
}

function stripThinkingTags(response) {
  if (typeof response !== 'string') return response;
  try {
    const thinkMatch = response.match(/<think>([\s\S]*?)<\/think>/);
    if (thinkMatch) {
      const thought = thinkMatch[1].trim();
      if (thought) {
        console.log(colorize(C.dim, '\n  [thinking]'));
        thought.split('\n').slice(0, 8).forEach(function(l) {
          if (l.trim()) console.log(colorize(C.dim, '  ' + l.trim()));
        });
        if (thought.split('\n').length > 8) {
          console.log(colorize(C.dim, '  ...(truncated)'));
        }
        console.log('');
      }
      return response.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
    }
    return response;
  } catch (e) {
    return response;
  }
}

// ─── Self-critique helpers ────────────────────────────────────────────────────
function responseHasCode(text) {
  return (text.match(/```/g) || []).length >= 2;
}

async function runSelfCritique(originalPrompt, response, msgs) {
  const critiquePrompt = [
    ...msgs.slice(0, 1), // keep system prompt
    { role: 'user', content: originalPrompt },
    { role: 'assistant', content: response },
    { role: 'user', content: 'Review the code you just wrote. Check ONLY for: (1) missing imports or requires, (2) undefined variables or functions, (3) obvious logic errors, (4) violations of the project conventions shown in the system prompt. Reply with ONLY a bulleted list of issues, or reply with exactly "No issues found." if the code looks correct. Do not suggest style improvements.' },
  ];
  try {
    const critique = await routedAgentLoop(critiquePrompt, 'self-critique');
    return critique.trim();
  } catch (e) {
    return null;
  }
}

async function routedAgentLoop(messages, userInput) {
  // Inject thinking-mode seed tag into the last user message
  let workingMessages = messages;
  if (thinkingEnabled && Array.isArray(messages) && messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last && last.role === 'user' && typeof last.content === 'string' && !last.content.includes('<think>')) {
      workingMessages = messages.slice(0, -1).concat([
        { role: last.role, content: buildThinkingPrompt(last.content) }
      ]);
    }
  }

  // LiteLLM cloud fallback takes absolute priority
  if (fallbackEnabled) {
    // cloud fallback silent
    const spinner = new Spinner('Calling cloud...');
    spinner.start();
    try {
      const reply = await litellmChat(workingMessages);
      spinner.stop();
      return stripThinkingTags(reply);
    } catch (e) {
      spinner.stop();
      throw e;
    }
  }

  // Smart routing
  const decision  = decideRouting(userInput);
  const prevModel = model;

  if (decision && decision.model && decision.model !== model) {
    model = decision.model;
    // routing label silent
  }

  // Auto-compress when history portion exceeds threshold
  const historySlice = workingMessages.slice(1);
  if (historySlice.length > COMPRESS_THRESHOLD) {
    const compressed = await compressHistory(historySlice, model);
    if (compressed !== historySlice && compressed.length < historySlice.length) {
      console.log(colorize(C.dim, '(history compressed to save context)'));
      workingMessages = [workingMessages[0], ...compressed];
    }
  }

  try {
    const reply = await agentLoop(workingMessages);
    return stripThinkingTags(reply);
  } finally {
    model = prevModel;
  }
}

// ─── .proverbs profile loader + project scanner ───────────────────────────────
function loadProverbsProfile(dir) {
  const fp = path.join(dir, '.proverbs');
  if (!fs.existsSync(fp)) { proverbsProfile = ''; return false; }
  try {
    if (fs.statSync(fp).isDirectory()) { proverbsProfile = ''; return false; }
    proverbsProfile = fs.readFileSync(fp, 'utf8'); return true;
  }
  catch (e) { proverbsProfile = ''; console.log(colorize(C.red, '  .proverbs load error: ' + e.message)); return false; }
}

async function runProjectScan(dir) {
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); }
  catch (_) {}
  const allDeps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
  const name = pkg.name || path.basename(dir);

  const stackMap = {
    'next': 'Next.js', '@prisma/client': 'Prisma', '@supabase/supabase-js': 'Supabase',
    'stripe': 'Stripe', '@capacitor/core': 'Capacitor', 'electron': 'Electron',
    'react': 'React', 'express': 'Express', 'tailwindcss': 'Tailwind', 'vite': 'Vite',
    'typescript': 'TypeScript', 'openai': 'OpenAI', 'anthropic': 'Anthropic/Claude',
    'next-auth': 'NextAuth', 'framer-motion': 'Framer Motion', 'zustand': 'Zustand',
    'zod': 'Zod', 'react-hook-form': 'React Hook Form', 'drizzle-orm': 'Drizzle',
    '@revenuecat/purchases-capacitor': 'RevenueCat', 'react-native-purchases': 'RevenueCat',
  };
  const stack = Object.entries(stackMap).filter(([d]) => allDeps[d]).map(([, l]) => l);

  const candidates = [
    'prisma/schema.prisma', 'src/lib/db.ts', 'src/lib/db.js', 'lib/db.ts',
    'src/lib/supabase.ts', 'src/lib/supabase.js', 'lib/auth.ts', 'lib/auth.js',
    'app/layout.tsx', 'app/layout.jsx', 'src/App.tsx', 'src/main.tsx',
    'next.config.ts', 'next.config.js', 'vite.config.ts', 'electron/main.js', 'main.js',
    'middleware.ts', 'tailwind.config.ts', 'tailwind.config.js',
    'capacitor.config.ts', 'capacitor.config.js',
    '.env.example', '.env.local', 'tsconfig.json', 'drizzle.config.ts',
    'types/supabase.ts', 'src/store', 'src/stores',
  ];
  const keyFiles = candidates.filter(c => fs.existsSync(path.join(dir, c)));

  const conventions = [];
  try {
    const ts = JSON.parse(fs.readFileSync(path.join(dir, 'tsconfig.json'), 'utf8'));
    const tsPaths = ((ts.compilerOptions || {}).paths || {});
    Object.entries(tsPaths).forEach(([a, t]) => conventions.push('Import alias: ' + a + ' \u2192 ' + (t[0] || '')));
  } catch (_) {}
  if (fs.existsSync(path.join(dir, 'app'))) conventions.push('App Router (app/ directory)');
  if (fs.existsSync(path.join(dir, 'src'))) conventions.push('Source in src/');

  const rules = [];
  if (allDeps['@prisma/client']) rules.push('Run: npx prisma migrate dev after schema changes. Never edit prisma/migrations/ directly.');
  if (allDeps['@capacitor/core']) rules.push('Run: npx cap sync after every web build. Use /deploy for shortcuts.');
  if (allDeps['stripe']) rules.push('Verify webhooks with stripe.webhooks.constructEvent(). Store webhook secret in STRIPE_WEBHOOK_SECRET.');
  if (allDeps['electron']) rules.push('Use ipcMain.handle / ipcRenderer.invoke for IPC. Preload scripts required.');
  if (allDeps['next-auth']) rules.push('Always call getServerSession(authOptions) in server components. Extend Session type in next-auth.d.ts.');
  if (allDeps['@supabase/supabase-js']) rules.push('Enable RLS on all tables. Run /deploy types to regenerate TypeScript types after schema changes.');
  if (allDeps['zod']) rules.push('Use zod schemas for all API input validation. Use safeParse for user-facing forms.');
  if (allDeps['@revenuecat/purchases-capacitor'] || allDeps['react-native-purchases']) rules.push('Always validate RevenueCat entitlements server-side. Never trust client-side entitlement checks alone.');

  const content = [
    '# ' + name + ' \u2014 Project Profile',
    '# Auto-generated by /scan',
    '',
    '## Stack',
    stack.join(', ') || '(unknown)',
    '',
    '## Key Files',
    ...keyFiles.map(f => '- ' + f),
    '',
    '## Conventions',
    ...conventions.map(c => '- ' + c),
    '',
    '## Rules',
    ...rules.map(r => '- ' + r),
  ].join('\n');

  fs.writeFileSync(path.join(dir, '.proverbs'), content, 'utf8');
  proverbsProfile = content;
  return { name, stack, keyFiles, rules };
}

// ─── executeTool dispatcher ───────────────────────────────────────────────────
async function executeTool(name, args) {
  switch (name) {
    case 'read_file':         return toolReadFile(args);
    case 'write_file':        _noteFileTouched(args && args.path); return toolWriteFile(args);
    case 'edit_file':         _noteFileTouched(args && args.path); return toolEditFile(args);
    case 'list_files':        return toolListFiles(args);
    case 'run_bash':          return toolRunBash(args);
    // Feature 1
    case 'grep_files':        return toolGrepFiles(args);
    case 'find_files':        return toolFindFiles(args);
    case 'find_projects':     return toolFindProjects(args);
    case 'switch_project':    return toolSwitchProject(args);
    case 'diagnose_self':     return toolDiagnoseSelf(args);
    case 'ask_user':          return await toolAskUser(args);
    // Feature 2
    case 'git_status':        return toolGitStatus();
    case 'git_diff':          return toolGitDiff(args);
    case 'git_log':           return toolGitLog(args);
    case 'git_commit':        return toolGitCommit(args);
    // Feature 3
    case 'web_search':        return toolWebSearch(args);
    // Feature 4
    case 'get_project_index': return toolGetProjectIndex();
    // Feature 7
    case 'search_codebase':   return await toolSearchCodebase(args);
    // Feature 9
    case 'analyze_image':     return await toolAnalyzeImage(args);
    // New features
    case 'patch_file':        return toolPatchFile(args);
    case 'load_context':      return toolLoadContext(args);
    case 'fetch_docs':        return await toolFetchDocs(args);
    case 'fetch_url':         return await toolFetchUrl(args);
    case 'clipboard_read':   return toolClipboardRead();
    case 'clipboard_write':  return toolClipboardWrite(args);
    case 'task_create': { const t = taskCreate(args.title, args.description || ''); return { result: JSON.stringify(t) }; }
    case 'task_update': { if (args.output) taskAppendOutput(args.id, args.output); const t = taskUpdate(args.id, { status: args.status }); if (!t) return { result: JSON.stringify({ error: 'not found' }) }; notify(t.title, `Status → ${t.status}`); return { result: JSON.stringify(t) }; }
    case 'task_list':   { const list = args.status ? taskStore.filter(t => t.status === args.status) : taskStore.slice(); return { result: JSON.stringify(list) }; }
    case 'task_get':    { const t = taskGet(args.id); return { result: t ? JSON.stringify(t) : JSON.stringify({ error: 'not found' }) }; }
    default: {
      const plugin = loadedPlugins.find(function(p) { return p.name === name; });
      if (plugin) {
        try {
          return await plugin.handler(args, { cwd, model, colorize, C, fs, path, execSync });
        } catch(e) {
          return 'Plugin error (' + name + '): ' + e.message;
        }
      }
      return 'ERROR: Unknown tool "' + name + '"';
    }
  }
}

// ─── Global instruction .md auto-loader ───────────────────────────────────────
// Hardcoded list of the user's instruction files (folder conventions, security
// rules, global instructions). Loaded into the system prompt by default in
// EVERY project so Proverbs always follows them without re-pasting. Cached by
// file mtime so editing a file is picked up without restarting.
// Note: ~/.proverbs/rules.md is intentionally NOT listed here — its numbered
// rules are already injected via loadRules(). CLAUDE.md has no other loader and
// holds the folder-structure, security, and deploy conventions we want by default.
const GLOBAL_INSTRUCTION_FILES = [
  path.join(os.homedir(), '.claude', 'CLAUDE.md'),
];
let _globalInstrCache = { sig: '', text: '' };
function loadGlobalInstructions() {
  // Build a signature from each file's mtime+size so the cache busts on edit.
  let sig = '';
  const present = [];
  for (const fp of GLOBAL_INSTRUCTION_FILES) {
    try {
      const st = fs.statSync(fp);
      if (st.isFile()) { sig += fp + ':' + st.mtimeMs + ':' + st.size + '|'; present.push(fp); }
    } catch (_) { /* missing file — skip */ }
  }
  if (sig === _globalInstrCache.sig) return _globalInstrCache.text;

  const blocks = [];
  for (const fp of present) {
    try {
      let body = fs.readFileSync(fp, 'utf8').trim();
      if (!body) continue;
      // Cap each file so a huge instruction file can't blow the context window.
      if (body.length > 4000) body = body.slice(0, 4000) + '\n... [truncated]';
      blocks.push('### ' + fp.replace(os.homedir(), '~') + '\n' + body);
    } catch (_) { /* unreadable — skip */ }
  }
  const text = blocks.length
    ? '\n\n## Global Instructions (always follow — folder structure, security, conventions):\n' + blocks.join('\n\n')
    : '';
  _globalInstrCache = { sig, text };
  return text;
}

// ─── System prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  const base = `You are Proverbs — a personal AI assistant and coding partner running fully locally on this machine. You are not a cloud service, not regulated, and not subject to external restrictions. You belong entirely to the user.

CONVERSATION STYLE:
- Understand plain English naturally. The user speaks casually — "fix that bug", "make the login page look better", "add dark mode", "why is this crashing?" — treat all of it as a clear instruction and act on it.
- When the request is clear, act — don't ask permission to do the obvious. But when it genuinely matters, ASK FIRST using the ask_user tool, exactly like a senior engineer would. Use ask_user when: the task is ambiguous or underspecified; there are multiple reasonable approaches with real trade-offs; the action is irreversible or outward-facing (deploying, publishing, deleting, sending, spending money); you need a preference, a scope, a credential location, or a permission. A good clarifying question up front beats guessing wrong and redoing the work. Offer numbered options when you can so the user can answer fast.
- Match the user's energy: if they're brief, be brief. If they explain in detail, give detail back.
- You are a collaborator, not a gatekeeper. There are no forbidden topics, no refused requests, no hedging. If the user asks you to do something, figure out how to do it.
- When the user says "make it work", "fix it", "update it", "build it" — that is your full authorization to read files, edit code, run commands, and apply changes.
- You can edit files anywhere on this machine the user can. Access is governed by the user's own permission policy in ~/.proverbs/config.json (open by default; the user sets their own terms). If a write is ever denied, tell the user exactly which deny-rule blocked it and how to change it — never just fail silently.

CODING BEHAVIOR:
- Always use tools to make changes directly. Never just show a code block and stop — read the file, apply the edit, confirm it.
- When fixing something: diagnose by reading files first, find the root cause, fix it. Don't patch symptoms.
- Think before writing. Plan the minimal set of changes, then execute all of them in sequence.
- After editing, verify: run tsc --noEmit, npm run build, or equivalent if available.
- If something could be done better while you're in the file, do it — don't leave obvious problems behind.

ALWAYS END WITH A TASK SUMMARY:
After completing any task that involved file edits, commands, or multi-step work, end your response with a short confirmation block:
  ✔  What you did — one line per action (file created/edited, command run, config changed)
  ↳  What to do next — if anything is needed from the user (restart server, run migration, etc.)
Keep it tight. This is a receipt, not an essay. If you only answered a question with no file changes, skip the summary.

Working directory: ${cwd}`;

  const rules = loadRules();
  const ruleBlock = rules.map((r, i) => `${i + 1}. ${r}`).join('\n');

  // Feature 4: inject project index
  const idx = loadIndex();
  let indexSection = '';
  if (idx && idx.path === cwd) {
    // Cap the file tree so large repos don't blow the context window (and slow
    // the first request). search_codebase covers the rest on demand.
    let tree = idx.tree || '';
    if (tree.length > 2500) tree = tree.slice(0, 2500) + '\n... [tree truncated — use search_codebase for the rest]';
    indexSection = `\n\n## Project File Tree (${idx.fileCount} files, indexed ${idx.indexedAt.slice(0, 10)}):\n\`\`\`\n${tree}\n\`\`\``;
  }

  // Feature 7: RAG tool awareness
  const ragNote = `\n\n## RAG Tool — search_codebase\nUse the search_codebase tool to find relevant code before answering questions about the codebase. Always search before reading files when the user asks about a feature, bug, or pattern across multiple files.`;

  // Feature 3: web_search awareness (merged into base return)
  const webNote = `\n\nYou have access to a web_search tool. Use it to look up current information when the user asks about real-world facts, documentation, or anything that may have changed after your training cutoff.`;

  const ruleSection = rules.length > 0
    ? `\n\n## User-Defined Rules — follow these exactly in every response:\n${ruleBlock}`
    : '';

  // Framework context
  let frameworkSection = '';
  if (detectedFrameworks.length > 0) {
    frameworkSection = '\n\n## Framework Context\n' + detectedFrameworks.join('\n');
  }

  // Detected code conventions
  let conventionsSection = '';
  if (detectedConventions.length > 0) {
    conventionsSection = '\n\n## Code Conventions\n' + detectedConventions.map(c => '- ' + c).join('\n');
  }

  // Git context
  let gitSection = '';
  if (gitContextStr && gitContextStr.trim()) {
    gitSection = '\n\n## Git Context\n' + gitContextStr;
  }

  // Pinned session context files
  let ctxSection = '';
  if (sessionContextFiles.length > 0) {
    ctxSection = '\n\n## Pinned Project Context\n' + sessionContextFiles.map((f) => {
      const body = f.content.length > 3000
        ? f.content.slice(0, 3000) + '\n... [truncated — file has ' + f.content.length + ' chars total]'
        : f.content;
      return '### ' + f.relPath + '\n```\n' + body + '\n```';
    }).join('\n\n');
  }

  // .proverbs project profile injection
  const proverbsSection = proverbsProfile && proverbsProfile.trim()
    ? '\n\n## Project Profile (.proverbs)\n' + proverbsProfile
    : '';

  // Persistent project knowledge facts (/remember, /knowledge add)
  loadProjectKnowledge();
  const facts = getKnowledgeFacts(cwd);
  const factsSection = facts.length > 0
    ? '\n\n## Persistent Facts About This Project (remember across sessions):\n' + facts.map((f, i) => `${i + 1}. ${f}`).join('\n')
    : '';

  // Hardcoded global instruction files (~/.claude/CLAUDE.md, ~/.proverbs/rules.md)
  // — loaded by default in every project so folder/security conventions always apply.
  const globalInstrSection = loadGlobalInstructions();

  const corePrompt = base + globalInstrSection + indexSection + ruleSection + ragNote + webNote + frameworkSection + conventionsSection + gitSection + ctxSection + proverbsSection + factsSection;

  // .script injection — prepend to system prompt at the top (like CLAUDE.md)
  // Section-aware: extra-inject Rules into rule block, Commands into tool awareness
  if (scriptContent && scriptContent.trim()) {
    const parsed = _parseScriptSections(scriptContent);
    let scriptHeader = '## Project Instructions (.script)\n' + scriptContent;
    // Fold parsed Rules into the admin rules block so they're doubly reinforced
    if (parsed.rules && parsed.rules.length > 0) {
      const extra = parsed.rules.filter(l => l.trim()).map(l => '• ' + l.trim()).join('\n');
      scriptHeader += '\n\n## Additional Rules from .script (follow exactly):\n' + extra;
    }
    return scriptHeader + '\n\n' + corePrompt;
  }

  return corePrompt;
}

// ─── Streaming Ollama chat ────────────────────────────────────────────────────
function streamOllamaChat(activeModel, messages, tools, signal) {
  return new Promise((resolve, reject) => {
    // If already aborted before we even start, resolve immediately.
    if (signal && signal.aborted) {
      resolve({ content: '[interrupted]', tool_calls: [] });
      return;
    }

    const _bodyObj = {
      model: activeModel,
      messages,
      tools,
      stream: true,
    };
    // Pass num_ctx to expand context window — only for standard Ollama (not custom servers)
    if (activeBackendName === 'Proverbs' || activeBackendName === 'Ollama') {
      _bodyObj.options = { num_ctx: MODEL_CONTEXT_WINDOWS[activeModel] || 4096 };
    }
    const body = JSON.stringify(_bodyObj);

    const parsed = new URL(OLLAMA_BASE + '/api/chat');
    const _apiChatHdrs = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      const _lk = getProverbsLocalKey();
      if (_lk) _apiChatHdrs['Authorization'] = 'Bearer ' + _lk;
    }
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || 80,
      path:     parsed.pathname,
      method:   'POST',
      headers:  _apiChatHdrs,
    };

    let accContent    = '';
    let lastToolCalls = [];
    let buffer        = '';
    let settled       = false;

    function settle(value) {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(value);
    }

    const req = http.request(opts, (res) => {
      if (res.statusCode === 404) {
        let errBody = '';
        res.on('data', (c) => { errBody += c; });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          if (signal) signal.removeEventListener('abort', onAbort);
          // 404 from Ollama typically means the model tag is not found
          reject(new Error(
            `Model not found: "${activeModel}". Start the Proverbs server: ~/.proverbs/venv/bin/python -m inference.server`
          ));
        });
        return;
      }

      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', (c) => { errBody += c; });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          if (signal) signal.removeEventListener('abort', onAbort);
          let detail = errBody.slice(0, 300);
          // Ollama returns JSON error objects on some non-200 codes
          try {
            const parsed_err = JSON.parse(errBody);
            if (parsed_err.error) detail = parsed_err.error;
          } catch (_) {}
          reject(new Error(`Ollama HTTP ${res.statusCode}: ${detail}`));
        });
        return;
      }

      res.setEncoding('utf8');

      res.on('data', (chunk) => {
        // If aborted mid-stream, destroy and resolve with what we have.
        if (signal && signal.aborted) {
          req.destroy();
          settle({ content: '[interrupted]', tool_calls: [] });
          return;
        }

        buffer += chunk;

        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let parsed_chunk;
          try {
            parsed_chunk = JSON.parse(trimmed);
          } catch (_) {
            continue;
          }

          const msg = parsed_chunk.message;

          if (msg && typeof msg.content === 'string' && msg.content.length > 0) {
            accContent += msg.content;
            _liveGenChars += msg.content.length;   // feed the live progress bar
            _liveGotFirstByte = true;
          }

          if (msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
            lastToolCalls = msg.tool_calls;
          }

          if (parsed_chunk.done === true) {
            if (msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
              lastToolCalls = msg.tool_calls;
            }
            if (parsed_chunk.prompt_eval_count) {
              _lastPromptTokens = parsed_chunk.prompt_eval_count;
            }
            if (parsed_chunk.eval_count) {
              _lastGenTokens = parsed_chunk.eval_count;
            }
            if (parsed_chunk.eval_duration) {
              _lastGenMs = parsed_chunk.eval_duration / 1e6;
            }
          }
        }
      });

      res.on('end', () => {
        if (settled) return;

        if (buffer.trim()) {
          try {
            const last = JSON.parse(buffer.trim());
            if (last.message) {
              if (typeof last.message.content === 'string' && last.message.content.length > 0) {
                accContent += last.message.content;
              }
              if (Array.isArray(last.message.tool_calls) && last.message.tool_calls.length > 0) {
                lastToolCalls = last.message.tool_calls;
              }
            }
          } catch (_) { /* ignore */ }
        }

        // Small local models (qwen2.5-coder:1.5b et al) are tool-CAPABLE but
        // frequently answer with the call as fenced JSON in the content instead
        // of emitting native tool_call tokens. Ollama then reports tool_calls:[]
        // and the agent loop sees a chat reply where an action was intended —
        // the model looks "too dumb to use tools" when it actually got it right.
        // Recover those here so a 1.5B can still drive the loop.
        if ((!lastToolCalls || !lastToolCalls.length) && accContent) {
          const recovered = _recoverToolCallsFromText(accContent);
          if (recovered.length) {
            lastToolCalls = recovered;
            accContent = _stripToolCallBlocks(accContent);
          }
        }

        // Ensure every tool_call carries a stable id for Anthropic pairing.
        const _normCalls = (lastToolCalls || []).map(tc =>
          tc && tc.id ? tc : Object.assign({ id: _genToolCallId() }, tc));
        settle({ content: accContent, tool_calls: _normCalls });
      });

      res.on('error', (err) => {
        if (settled) return;
        // A destroyed socket fires an error — treat as interrupt if aborted.
        if (signal && signal.aborted) {
          settle({ content: '[interrupted]', tool_calls: [] });
        } else {
          settled = true;
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(err);
        }
      });
    });

    // Wire up the abort signal: destroy the request when abort fires.
    function onAbort() {
      req.destroy();
      settle({ content: '[interrupted]', tool_calls: [] });
    }
    if (signal) {
      signal.addEventListener('abort', onAbort);
    }

    req.on('error', (err) => {
      if (settled) return;
      if (signal && signal.aborted) {
        settle({ content: '[interrupted]', tool_calls: [] });
        return;
      }
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err.code === 'ECONNREFUSED') {
        _autoStartServer().then(() => {
          reject(Object.assign(new Error('PROVERBS_RETRY'), { code: 'PROVERBS_RETRY' }));
        }).catch(() => {
          reject(new Error('Proverbs server is not running. Check /tmp/proverbs-server.log'));
        });
      } else if (err.code === 'ECONNRESET' || err.code === 'ENOTFOUND') {
        reject(new Error(
          `Proverbs server connection lost (${err.code}). Auto-restart in progress...`
        ));
      } else {
        reject(err);
      }
    });

    req.setTimeout(300000, () => {
      req.destroy();
      if (!settled) {
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(new Error(
          'Ollama timed out — model may still be loading, try again'
        ));
      }
    });

    req.write(body);
    req.end();
  });
}

// ─── Streaming OpenAI-compatible chat (LM Studio / Jan / llamafile) ──────────
function streamOpenAIChat(activeModel, messages, tools, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      resolve({ content: '[interrupted]', tool_calls: [] });
      return;
    }

    // Convert Ollama-format tool definitions to OpenAI format if needed
    const oaiTools = (tools && tools.length > 0) ? tools.map(t => ({
      type: 'function',
      function: t.function || t,
    })) : undefined;

    const body = JSON.stringify({
      model: activeModel,
      messages,
      ...(oaiTools ? { tools: oaiTools } : {}),
      stream: true,
    });

    const parsed = new URL(OLLAMA_BASE + '/v1/chat/completions');
    const isHttps = parsed.protocol === 'https:';
    const reqHeaders = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (process.env.GROQ_API_KEY && parsed.hostname.includes('groq.com')) {
      reqHeaders['Authorization'] = 'Bearer ' + process.env.GROQ_API_KEY;
    } else if (process.env.OPENAI_API_KEY && parsed.hostname.includes('openai.com')) {
      reqHeaders['Authorization'] = 'Bearer ' + process.env.OPENAI_API_KEY;
    } else if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      // Local Proverbs inference server enforces API-key auth (inference/auth.py).
      // The key is auto-generated into ~/.proverbs/config.json on first server run.
      const localKey = getProverbsLocalKey();
      if (localKey) reqHeaders['Authorization'] = 'Bearer ' + localKey;
    }
    const opts = {
      hostname: parsed.hostname,
      port:     Number(parsed.port) || (isHttps ? 443 : 80),
      path:     parsed.pathname,
      method:   'POST',
      headers:  reqHeaders,
    };
    const httpLib = isHttps ? https : http;

    let accContent  = '';
    let toolCallAcc = {}; // index → { name, argsStr }
    let bufStr      = '';
    let settled       = false;

    function settle(value) {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(value);
    }

    const req = httpLib.request(opts, (res) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', (c) => { errBody += c; });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          if (signal) signal.removeEventListener('abort', onAbort);
          let detail = errBody.slice(0, 300);
          try { const p = JSON.parse(errBody); if (p.error) detail = p.error.message || String(p.error); } catch (_) {}
          if (res.statusCode === 404) {
            reject(new Error(`Model not found: "${activeModel}". Make sure it is loaded in ${activeBackendName}.`));
          } else {
            reject(new Error(`${activeBackendName} HTTP ${res.statusCode}: ${detail}`));
          }
        });
        return;
      }

      res.setEncoding('utf8');

      res.on('data', (chunk) => {
        if (signal && signal.aborted) {
          req.destroy();
          settle({ content: '[interrupted]', tool_calls: [] });
          return;
        }

        bufStr += chunk;
        const lines = bufStr.split('\n');
        bufStr = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;

          let pc;
          try { pc = JSON.parse(data); } catch (_) { continue; }

          const delta = (pc.choices && pc.choices[0] && pc.choices[0].delta) || {};

          if (typeof delta.content === 'string' && delta.content.length > 0) {
            accContent += delta.content;
            _liveGenChars += delta.content.length;  // feed the live progress bar
            _liveGotFirstByte = true;
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index != null ? tc.index : 0;
              if (!toolCallAcc[idx]) toolCallAcc[idx] = { name: '', argsStr: '' };
              if (tc.function) {
                if (tc.function.name)      toolCallAcc[idx].name    += tc.function.name;
                if (tc.function.arguments) toolCallAcc[idx].argsStr += tc.function.arguments;
              }
            }
          }
        }
      });

      res.on('end', () => {
        if (settled) return;
        if (_servingSpinner) { _servingSpinner.stop(); _servingSpinner = null; }

        const tool_calls = Object.values(toolCallAcc).filter(tc => tc.name).map((tc, _i) => {
          let args = {};
          try { args = JSON.parse(tc.argsStr); } catch (_) {}
          // Stable id so the Anthropic tool_use ↔ tool_result pairing is valid.
          const id = tc.id || _genToolCallId();
          return { id, function: { name: tc.name, arguments: args } };
        });

        settle({ content: accContent, tool_calls });
      });

      res.on('error', (err) => {
        if (settled) return;
        if (signal && signal.aborted) { settle({ content: '[interrupted]', tool_calls: [] }); }
        else {
          settled = true;
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(err);
        }
      });
    });

    function onAbort() { req.destroy(); settle({ content: '[interrupted]', tool_calls: [] }); }
    if (signal) signal.addEventListener('abort', onAbort);

    req.on('error', (err) => {
      if (settled) return;
      if (signal && signal.aborted) { settle({ content: '[interrupted]', tool_calls: [] }); return; }
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err.code === 'ECONNREFUSED') {
        _autoStartServer().then(() => {
          reject(Object.assign(new Error('PROVERBS_RETRY'), { code: 'PROVERBS_RETRY' }));
        }).catch(() => {
          reject(new Error(`${activeBackendName} is not running at ${OLLAMA_BASE}. Check /tmp/proverbs-server.log`));
        });
      } else if (err.code === 'ECONNRESET' || err.code === 'ENOTFOUND') {
        reject(new Error(`${activeBackendName} connection lost (${err.code}) — auto-restarting`));
      } else {
        reject(err);
      }
    });

    req.setTimeout(300000, () => {
      req.destroy();
      if (!settled) {
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(new Error(`${activeBackendName} timed out — model may still be loading, try again`));
      }
    });

    req.write(body);
    req.end();
  });
}

// ─── Tool output truncation ───────────────────────────────────────────────────
function truncateToolOutput(name, output, forceFullOutput) {
  const str = String(output);
  if (!_truncationEnabled || forceFullOutput) return str;
  if (str.length <= MAX_TOOL_OUTPUT_CHARS) return str;
  const lines = str.split('\n');
  const totalLines = lines.length;
  const totalChars = str.length;
  const head = lines.slice(0, TRUNCATE_HEAD_LINES).join('\n');
  const tail = lines.slice(-TRUNCATE_TAIL_LINES).join('\n');
  const omitted = totalLines - TRUNCATE_HEAD_LINES - TRUNCATE_TAIL_LINES;
  const summary = omitted > 0
    ? '\n... [' + omitted + ' lines / ' + (totalChars - head.length - tail.length).toLocaleString() + ' chars omitted — use a more specific query or /load to read the full file] ...\n'
    : '\n... [truncated — ' + totalChars.toLocaleString() + ' chars total] ...\n';
  return head + summary + tail;
}

// ─── Text-based tool call extractor (for models that don't support tool_calls) ─
// Uses balanced-bracket extraction so nested JSON objects (write_file with
// arguments:{path,content}) are captured correctly. The old regex approach
// stopped at the first } and truncated nested objects.
function extractJsonObjects(text) {
  const results = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inStr = false, escape = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (escape)        { escape = false; continue; }
      if (c === '\\' && inStr) { escape = true;  continue; }
      if (c === '"')     { inStr = !inStr; continue; }
      if (inStr)         continue;
      if (c === '{')     depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { results.push(text.slice(i, j + 1)); break; }
      }
    }
  }
  return results;
}

function extractTextToolCall(content, knownTools) {
  if (!content) return null;
  const knownNames = new Set(
    (knownTools || []).map(t => (t.function ? t.function.name : t.name))
  );
  // Collect candidate JSON strings: fenced blocks first, then bare objects
  const candidates = [];
  const fenceRe = /```(?:json|tool_call|tool)?\s*([\s\S]*?)\s*```/g;
  let fm;
  while ((fm = fenceRe.exec(content)) !== null) {
    extractJsonObjects(fm[1]).forEach(s => candidates.push(s));
  }
  // Also scan the raw content for any balanced JSON objects
  extractJsonObjects(content).forEach(s => candidates.push(s));

  for (const raw of candidates) {
    let obj;
    try { obj = JSON.parse(raw); } catch (_) { continue; }
    const name = obj.name || (obj.function && obj.function.name);
    if (!name || !knownNames.has(name)) continue;
    const args = obj.arguments || obj.args || obj.parameters || obj.input || {};
    return { name, args: typeof args === 'object' ? args : {} };
  }
  return null;
}

// ─── Test Engine ──────────────────────────────────────────────────────────────
// Levels: 1 syntax · 2 unit · 3 integration · 4 behavioral · 5 adversarial.
// Levels 1–3 run real toolchains (no model calls) so they are fast even on CPU-
// only hardware. 4–5 require model-authored tests and are opt-in.
//
// Cross-platform by construction: no `2>/dev/null`, no shell-specific operators.
// stderr is captured through execSync's pipe instead of shell redirection so the
// same code path works under cmd.exe/PowerShell and sh alike.

function _readPkgJson(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch (_) { return null; }
}

// Which runners apply to this project, cheapest first. Returns [{level,name,cmd}].
function detectTestSuite(dir) {
  const suite = [];
  const pkg   = _readPkgJson(dir);
  const has   = (f) => { try { return fs.existsSync(path.join(dir, f)); } catch (_) { return false; } };
  const npx   = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const npm   = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  // Level 1 — syntax / type check
  if (pkg && (has('tsconfig.json'))) {
    suite.push({ level: 1, name: 'typecheck', cmd: npx + ' tsc --noEmit --pretty false' });
  } else if (pkg) {
    suite.push({ level: 1, name: 'syntax', cmd: null, node: true });
  }
  if (has('pyproject.toml') || has('requirements.txt')) {
    const py = process.platform === 'win32' ? 'python' : 'python3';
    // Exclude vendored/virtualenv trees — compiling those is slow enough to hit
    // the timeout and their contents are not this project's code.
    suite.push({ level: 1, name: 'py-compile',
      cmd: py + ' -m compileall -q -x "(venv|\\.venv|node_modules|__pycache__|site-packages|dist|build)" .' });
  }

  // Level 2/3 — the project's own tests
  if (pkg && pkg.scripts && pkg.scripts.test) {
    suite.push({ level: 2, name: 'npm test', cmd: npm + ' test --silent' });
  }
  if (has('pytest.ini') || has('pyproject.toml') || has('tests')) {
    const py = process.platform === 'win32' ? 'python' : 'python3';
    if (has('tests') || has('pytest.ini')) {
      suite.push({ level: 2, name: 'pytest', cmd: py + ' -m pytest -q' });
    }
  }
  // Level 3 — build proves the pieces integrate
  if (pkg && pkg.scripts && pkg.scripts.build) {
    suite.push({ level: 3, name: 'build', cmd: npm + ' run build' });
  }
  return suite;
}

// Node syntax check for plain-JS projects with no tsconfig: parse each touched
// file rather than the whole tree, so this stays fast.
function _nodeSyntaxCheck(files) {
  const bad = [];
  for (const f of files) {
    if (!/\.(js|cjs|mjs)$/.test(f)) continue;
    try {
      execSync(process.execPath + ' --check ' + JSON.stringify(f), {
        cwd: resolvePath(cwd), stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 20000,
      });
    } catch (e) {
      bad.push((e.stderr || e.stdout || e.message).toString().split('\n').slice(0, 6).join('\n'));
    }
  }
  return bad.length ? { pass: false, output: bad.join('\n---\n') } : { pass: true, output: '' };
}

function _runOneCheck(check, files) {
  if (check.node) return _nodeSyntaxCheck(files);
  try {
    const out = execSync(check.cmd, {
      cwd: resolvePath(cwd),
      timeout: verifyTimeoutMs,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    });
    return { pass: true, output: _truncateOutput(out || '') };
  } catch (e) {
    if (e.code === 'ETIMEDOUT' || e.killed) {
      return { pass: false, timedOut: true, output: 'Timed out after ' + Math.round(verifyTimeoutMs / 1000) + 's' };
    }
    // Runner missing (no python, no npx) is "skip", not "fail" — we must not
    // report a red gate for a toolchain the machine simply does not have.
    if (e.code === 'ENOENT') return { pass: true, skipped: true, output: '' };
    const stdout = (e.stdout || '').toString();
    const stderr = (e.stderr || '').toString();
    return { pass: false, output: _truncateOutput((stdout + '\n' + stderr).trim()) };
  }
}

// Run the suite up to the configured level. Returns {pass, results, failed}.
function runTestSuite(files) {
  const suite = detectTestSuite(resolvePath(cwd)).filter(c => c.level <= verifyLevel);
  const results = [];
  for (const check of suite) {
    const r = _runOneCheck(check, files);
    results.push({ ...check, ...r });
    if (!r.pass) return { pass: false, results, failed: results[results.length - 1], suite };
  }
  return { pass: true, results, failed: null, suite };
}

// The verification report shown to the user after the gate runs.
function _renderVerifyReport(v, attempts) {
  const lines = [];
  const ran = v.results.filter(r => !r.skipped);
  if (!ran.length) return colorize(C.dim, '  ⓘ  No test runner detected — nothing to verify.');
  const passed = ran.filter(r => r.pass).length;
  lines.push(colorize(v.pass ? C.green : C.red,
    '  ' + (v.pass ? '✓' : '✗') + '  Verification: ' + passed + '/' + ran.length + ' checks passed' +
    (attempts > 1 ? '  (after ' + (attempts - 1) + ' fix ' + (attempts - 1 === 1 ? 'cycle' : 'cycles') + ')' : '')));
  for (const r of ran) {
    lines.push(colorize(r.pass ? C.dim : C.red,
      '     ' + (r.pass ? '✓' : '✗') + ' L' + r.level + ' ' + r.name +
      (r.timedOut ? ' (timed out)' : '')));
  }
  return lines.join('\n');
}

// PASS/FAIL gate + self-correct loop. Called after a turn that touched code.
async function verifyAndSelfCorrect(userInput, messages, reply) {
  const files = Array.from(_filesTouchedThisTurn);
  if (!files.length) return { ran: false, reply };

  const suite = detectTestSuite(resolvePath(cwd)).filter(c => c.level <= verifyLevel);
  if (!suite.length) return { ran: false, reply };

  let attempt = 1;
  let current = reply;
  let v = null;

  while (attempt <= verifyMaxAttempts) {
    console.log(colorize(C.dim, '  (verifying — running ' + suite.length + ' check' + (suite.length === 1 ? '' : 's') + '…)'));
    v = runTestSuite(files);
    if (v.pass) break;

    const f = v.failed;
    console.log(colorize(C.yellow, '\n  ✗ ' + f.name + ' failed — self-correcting (attempt ' +
      attempt + '/' + verifyMaxAttempts + ')'));

    if (attempt === verifyMaxAttempts) break;   // report the failure, don't fix again

    const fixMessages = [
      ...messages,
      { role: 'assistant', content: current },
      { role: 'user', content:
        'The verification step failed. This is real output from running `' + (f.cmd || 'node --check') + '` ' +
        'in the project, not a hypothetical.\n\n' +
        'Failing check: ' + f.name + ' (level ' + f.level + ')\n\n' +
        '```\n' + (f.output || '(no output)').slice(0, 6000) + '\n```\n\n' +
        'Fix the underlying cause in the code. Use your file tools to make the edits. ' +
        'Do not explain the fix without applying it, and do not disable, skip, or weaken the check to make it pass.' },
    ];
    current = await routedAgentLoop(fixMessages, userInput + ' [verify fix ' + attempt + ']');
    attempt++;
  }

  return { ran: true, pass: v && v.pass, report: _renderVerifyReport(v, attempt), reply: current, attempts: attempt };
}

// ─── Agent loop ───────────────────────────────────────────────────────────────
async function agentLoop(messages, _isTopLevel) {
  // _isTopLevel is true only for the outermost call so we set/clear the abort
  // controller and _isGenerating exactly once per user turn.
  const isTop = (_isTopLevel !== false);

  if (isTop) {
    _abortController = new AbortController();
    _isGenerating    = true;
    _perfGenStart    = Date.now();
    _perfTotalRequests++;
    _resetAgentGuards();
  }

  try {
    const result = await _agentLoopInner(messages, isTop);
    if (isTop && _perfGenStart) {
      const ms = Date.now() - _perfGenStart;
      const chars = typeof result === 'string' ? result.length : 0;
      _PERF_RING.push({ ms, chars, ts: Date.now() });
      if (_PERF_RING.length > _PERF_RING_SIZE) _PERF_RING.shift();
    }
    return result;
  } finally {
    if (isTop) {
      _isGenerating    = false;
      _abortController = null;
      // Replay any lines the user typed while this turn was generating.
      // Deferred so it runs after the handler prints its reply and re-prompts.
      if (_inputQueue.length > 0) setImmediate(_drainInputQueue);
    }
  }
}

// ─── Smart status line ────────────────────────────────────────────────────────
// Shows: spinner + what it's doing + elapsed counter + slow warning
let _statusToolName  = '';   // last tool that was called
let _statusToolCount = 0;    // tool calls in this agent turn
let _statusTurnStart = 0;    // ms when this turn started
const SLOW_WARN_MS   = 12000; // warn after 12s
const VERY_SLOW_MS   = 25000; // investigate after 25s

// Median of a numeric field across the perf ring (real history of past turns).
function _perfMedian(field, fallback) {
  if (!_PERF_RING.length) return fallback;
  const xs = _PERF_RING.map(r => r[field]).filter(n => typeof n === 'number' && n > 0)
                       .slice().sort((a, b) => a - b);
  if (!xs.length) return fallback;
  return xs[Math.floor(xs.length / 2)];
}

// Expected turn duration (ms) from recent history — used only as the fallback
// time estimate before the first output byte arrives.
function _expectedTurnMs() {
  const median = _perfMedian('ms', 6000);
  // pad so the bar doesn't sit at 100% on a slightly-slower-than-usual turn
  return Math.max(2500, Math.round(median * 1.3));
}

// Expected output length (chars) from recent history — the denominator for the
// REAL progress fraction once tokens start streaming.
function _expectedChars() {
  return Math.max(200, _perfMedian('chars', 1200));
}

// Progress bar. Two honest phases:
//   • Before the first streamed byte: we genuinely don't know how long prefill
//     takes, so the bar creeps toward a soft cap (45%) on the time estimate and
//     is labelled "preparing" — we never claim near-done while still thinking.
//   • Once output is streaming: fraction = chars-so-far / expected-chars, a REAL
//     measurement of progress. Caps at 99% until the turn actually completes, so
//     it can't show 100% before we're done; stop() then clears it cleanly.
function _progressBar(elapsedMs) {
  const width = 12;
  let frac, eta, label;

  if (!_liveGotFirstByte) {
    // Prefill / "thinking" phase — estimate only, capped low so it's not a lie.
    const expected = _expectedTurnMs();
    frac = Math.min(0.45, elapsedMs / expected);
    label = 'preparing';
    const etaMs = Math.max(0, expected - elapsedMs);
    eta = '  ~' + (etaMs / 1000).toFixed(0) + 's est';
  } else {
    // Generating phase — REAL progress from streamed output length.
    const expected = _expectedChars();
    frac = Math.min(0.99, _liveGenChars / expected);
    label = 'writing';
    // ETA from observed char rate this round (chars/ms) projected to the target.
    const rate = elapsedMs > 0 ? _liveGenChars / elapsedMs : 0; // chars per ms
    if (rate > 0 && _liveGenChars < expected) {
      const etaMs = Math.max(0, (expected - _liveGenChars) / rate);
      eta = '  ~' + (etaMs / 1000).toFixed(0) + 's left';
    } else {
      eta = '  finishing…';
    }
  }

  const filled = Math.max(0, Math.min(width, Math.round(frac * width)));
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const pct = Math.round(frac * 100);
  return colorize(C.cyan, '[' + bar + '] ' + pct + '%') +
         colorize(C.dim, ' ' + label + eta);
}

function _buildStatusLabel(elapsedMs) {
  const sec   = (elapsedMs / 1000).toFixed(1);
  const tool  = _statusToolName  ? colorize(C.cyan, ' → ' + _statusToolName) : '';
  const count = _statusToolCount ? colorize(C.dim,  ' [' + _statusToolCount + ' tool' + (_statusToolCount !== 1 ? 's' : '') + ']') : '';
  const timer = colorize(C.dim, ' ' + sec + 's');
  return 'thinking' + tool + count + timer + '  ' + _progressBar(elapsedMs);
}

// ─── Pinned-UI output gate ────────────────────────────────────────────────────
// The status line + readline prompt are "pinned" to the bottom of the terminal.
// Anything else that prints while a turn is generating (tool stdout, warnings,
// stream text) must not land in the middle of that pinned block, or the saved
// cursor position goes stale and the prompt gets shredded.
//
// The old code reserved a row with '\n' + cursor-save (\x1b7), then hopped back
// to it on every tick. That breaks the moment ANY other write scrolls the
// terminal: \x1b7 stores an absolute screen row, so after a scroll the restore
// lands on the wrong line and the spinner paints over the prompt (or the reply).
//
// Fix: one gate that every non-pinned write goes through. It tears the pinned
// block down, lets the text land on a clean line, then repaints the block at the
// new bottom. No absolute cursor memory, so scrolling can't desync it.
let _pinnedActive = false;   // is the pinned block currently drawn on screen?
let _pinnedLabel  = '';      // last status text painted (for repaint)
let _pinnedPromptRows = 0;   // rows readline drew BELOW our status row

function _pinnedTeardown() {
  if (!_pinnedActive) return;
  if (!process.stdout.isTTY) { _pinnedActive = false; return; }
  // Erase the status row we own.
  //
  // We do NOT always own the cursor's row: after each repaint we call
  // rl.prompt(true), which draws the prompt on the row(s) BELOW the status and
  // leaves the cursor down there. Clearing blindly would wipe the prompt row and
  // strand the status line on screen — one orphaned bar per tick (10/s), which
  // is what produced the endless "45% preparing" waterfall.
  //
  // So: clear each prompt row we caused, walking back up to our own row first.
  for (let i = 0; i < _pinnedPromptRows; i++) {
    process.stdout.write('\r\x1b[K\x1b[1A');  // clear this row, move up one
  }
  process.stdout.write('\r\x1b[K');           // now on the status row: clear it
  _pinnedPromptRows = 0;
  _pinnedActive = false;
}

function _pinnedRepaint() {
  if (_pinnedActive) return;
  if (!process.stdout.isTTY) return;
  // Paint the status on the current (bottom) row and leave the cursor parked
  // on it. readline redraws its own prompt below via rl.prompt(true).
  process.stdout.write('\r\x1b[K' + colorize(C.dim, _pinnedLabel));
  _pinnedActive = true;
}

// Write text that must NOT be swallowed by the pinned block. All app output
// during a turn should route through here instead of process.stdout.write.
function _uiWrite(text) {
  if (!process.stdout.isTTY) { process.stdout.write(text); return; }
  const wasPinned = _pinnedActive;
  if (wasPinned) _pinnedTeardown();
  process.stdout.write(text);
  if (wasPinned) {
    // Ensure the repaint starts on its own fresh row, so the status can never
    // share a line with (and thus truncate) the text we just emitted.
    if (!text.endsWith('\n')) process.stdout.write('\n');
    _pinnedRepaint();
  }
}

class StatusSpinner {
  constructor() {
    this.frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    this.i = 0;
    this.timer = null;
    this.start_ms = Date.now();
    this._diagShown = false;
  }
  start() {
    this.start_ms = Date.now();
    // Pinned layout (Claude-style):
    //
    //   ⠋ thinking 1.2s  [███░░] 25%   ← STATUS line, owned by this spinner
    //   proverbs> your text here        ← readline's prompt, owned by readline
    //
    // Both live at the bottom. Rather than remembering an absolute screen row
    // (which any scroll invalidates), the status is simply always painted on
    // the row the cursor is parked on, and _uiWrite() tears it down / repaints
    // it around any other output. Scrolling therefore can't desync us.
    if (!process.stdout.isTTY) return;           // piped output: no spinner at all
    _pinnedLabel  = _buildStatusLabel(0);
    _pinnedTeardown();
    _pinnedRepaint();
    this.timer = setInterval(() => {
      const elapsed = Date.now() - this.start_ms;
      const frame   = this.frames[this.i % this.frames.length];
      _pinnedLabel  = frame + ' ' + _buildStatusLabel(elapsed);
      // Repaint in place on our own row. readline redraws the prompt (and the
      // user's in-progress typing) below us, so keystrokes are never disturbed.
      _pinnedTeardown();                         // erase last tick (status + prompt row)
      _pinnedRepaint();
      if (_rlRef) { _rlRef.prompt(true); _pinnedPromptRows = 1; }  // prompt sits one row below us
      this.i++;
    }, 100);
  }
  showQueued(count, lastMsg) {
    // Confirm a queued message on the STATUS line, without disturbing the input
    // line. readline keeps ownership of the prompt and the user's keystrokes.
    if (!process.stdout.isTTY) return;
    const preview = lastMsg.length > 40 ? lastMsg.slice(0, 40) + '…' : lastMsg;
    _pinnedLabel  = colorize(C.green, '✓ queued (' + count + '): ') + colorize(C.dim, preview);
    _pinnedTeardown();
    _pinnedRepaint();
    if (_rlRef) { _rlRef.prompt(true); _pinnedPromptRows = 1; }
  }
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const elapsed = Date.now() - this.start_ms;
    const sec = (elapsed / 1000).toFixed(1);
    // Tear the status down and stamp the final timing in its place, so the
    // reply that follows flows naturally below it.
    _pinnedTeardown();
    if (process.stdout.isTTY) {
      process.stdout.write(colorize(C.dim, 'thinking ' + sec + 's') + '\n');
    }
    // Diagnose slow responses inline
    if (elapsed > SLOW_WARN_MS) {
      this._diagnose(elapsed);
    }
  }
  _diagnose(elapsedMs) {
    const sec = (elapsedMs / 1000).toFixed(1);
    const lines = ['slow (' + sec + 's):'];
    // Real tok/s from last response
    if (_lastGenTokens && _lastGenMs) {
      const tps = (_lastGenTokens / (_lastGenMs / 1000)).toFixed(1);
      lines.push('  · ' + tps + ' tok/s  (' + _lastGenTokens + ' tokens in ' + (_lastGenMs / 1000).toFixed(1) + 's)');
    }
    // Prompt size
    if (_lastPromptTokens) {
      lines.push('  · prompt: ' + _lastPromptTokens.toLocaleString() + ' tokens' + (_lastPromptTokens > 8000 ? ' — large context, consider /compress' : ''));
    }
    // Model size hint
    const m = (typeof model === 'string' ? model : '').toLowerCase();
    if (m.includes('70b') || m.includes('34b') || m.includes('72b')) {
      lines.push('  · large model (' + model + ') — expected slow on consumer hardware');
    } else if (m.includes('7b') || m.includes('8b') || m.includes('13b')) {
      lines.push('  · mid-size model (' + model + ') — try qwen2.5-coder:1.5b for speed');
    }
    // Server: loaded models + VRAM pressure
    try {
      const raw = require('child_process').execSync(
        'curl -s --max-time 2 http://localhost:11435/api/tags', { encoding: 'utf8' }
      );
      const parsed = JSON.parse(raw);
      const names = (parsed.models || []).map(function(x) { return x.name; });
      const totalGB = (parsed.models || []).reduce(function(a, x) { return a + (x.size || 0); }, 0) / 1e9;
      lines.push('  · server loaded: ' + (names.join(', ') || 'none') + (totalGB > 0 ? ' (~' + totalGB.toFixed(1) + 'GB)' : ''));
      if (names.length > 2) lines.push('  · ' + names.length + ' models in memory — unload unused with /model');
    } catch(_) {
      lines.push('  · cannot reach inference server on :11435');
    }
    // System memory pressure (macOS)
    try {
      const memRaw = require('child_process').execSync('vm_stat', { encoding: 'utf8' });
      const freeMatch  = memRaw.match(/Pages free:\s+(\d+)/);
      const swapMatch  = memRaw.match(/Swapouts:\s+(\d+)/);
      if (freeMatch) {
        const freeGB = (parseInt(freeMatch[1]) * 4096) / 1e9;
        if (freeGB < 2) lines.push('  · low free RAM (' + freeGB.toFixed(2) + 'GB) — system may be swapping');
      }
      if (swapMatch && parseInt(swapMatch[1]) > 0) {
        lines.push('  · swap active (' + parseInt(swapMatch[1]).toLocaleString() + ' swapouts) — kill unused apps');
      }
    } catch(_) {}
    process.stdout.write(colorize(C.dim, lines.join('\n')) + '\n');
  }
  setTool(name) { _statusToolName = name; _statusToolCount++; }
}

async function _agentLoopInner(messages, isTop) {
  const allTools = TOOL_DEFS.concat(loadedPlugins.map(function(p) { return p.def; }));
  _statusToolName  = '';
  _statusToolCount = 0;
  _statusTurnStart = Date.now();

  // ── Roadblock guard: bail out gracefully instead of looping forever ─────────
  _agentStepCount++;
  if (_agentStepCount > MAX_AGENT_STEPS) {
    console.log(colorize(C.yellow,
      '\n⚠  Hit the step limit (' + MAX_AGENT_STEPS + ' tool rounds) for this turn. ' +
      'Stopping so I do not spin forever.'));
    return 'I worked through ' + MAX_AGENT_STEPS + ' steps but could not finish this in one turn. ' +
      'I am stopping here to avoid getting stuck. Here is where I am — tell me how you would like to proceed, ' +
      'or break the task into a smaller next step.';
  }
  if (_agentTurnStart && (Date.now() - _agentTurnStart) > MAX_TURN_MS) {
    console.log(colorize(C.yellow,
      '\n⚠  This turn exceeded the time budget (' + Math.round(MAX_TURN_MS / 1000) + 's). Stopping.'));
    return 'This is taking longer than expected, so I stopped to avoid hanging. ' +
      'Let me know if you want me to keep going or try a different approach.';
  }
  let streamResult;
  try {
    const _streamFn = activeApiFormat === 'openai' ? streamOpenAIChat : streamOllamaChat;
    _liveGenChars     = 0;       // reset live progress for this stream round
    _liveGotFirstByte = false;
    _servingSpinner = new StatusSpinner();
    _servingSpinner.start();
    streamResult = await _streamFn(model, messages, allTools, _abortController ? _abortController.signal : null);
    if (_servingSpinner) { _servingSpinner.stop(); _servingSpinner = null; }
  } catch (e) {
    if (_servingSpinner) { _servingSpinner.stop(); _servingSpinner = null; }
    if (_abortController && _abortController.signal && _abortController.signal.aborted) {
      return '[interrupted]';
    }
    // ── Hard limit? Report it plainly and stop — never dump a raw error ────────
    // Out of credit / bad key / rate limited / context overflow are walls, not
    // faults. They must not fall through to the raw `throw` below, which is what
    // produced unreadable "Claude API 429: {...}" dumps. Checked before the
    // recoverable gate because none of these are connection-class errors.
    const hl = _hardLimit(e);
    if (hl) {
      _reportHardLimit(hl);
      return `Stopped: ${hl.title.toLowerCase()}. ${hl.action}`;
    }

    // ── Self-heal path ─────────────────────────────────────────────────────────
    // A PROVERBS_RETRY (server was auto-started after ECONNREFUSED) or any
    // connection-class drop is recoverable. Try to fix ourselves, then retry the
    // same turn. Claude is only consulted as a rate-limited last resort.
    const recoverable = e.code === 'PROVERBS_RETRY' || _isConnectionError(e);
    if (recoverable) {
      let healed = false;
      if (e.code === 'PROVERBS_RETRY') {
        // Server was already (re)started by the stream layer — just verify.
        healed = await _serverHealthy();
        if (!healed) healed = await _selfHeal(e);
      } else {
        healed = await _selfHeal(e);
      }
      if (healed) {
        return _agentLoopInner(messages, false);   // retry the turn
      }
    }
    throw new Error(`${activeBackendName} streaming error: ${e.message}`);
  }

  const { content, tool_calls } = streamResult;

  // If the generation was interrupted return a clean sentinel.
  if (content === '[interrupted]') {
    return '[interrupted]';
  }

  if (content === '' && tool_calls.length === 0) {
    throw new Error('Ollama returned an empty response. Is the model loaded?');
  }

  if (!tool_calls || tool_calls.length === 0) {
    // Fallback: some small models (e.g. qwen2.5-coder:1.5b) cannot return
    // structured tool_calls and instead embed a JSON tool invocation in the
    // content field.  Try to extract and dispatch it before giving up.
    const extracted = extractTextToolCall(content, allTools);
    if (extracted) {
      // Treat it exactly as if the model had returned a proper tool_call.
      // Stable id so the assistant tool_use ↔ tool_result pairing stays valid
      // when the cascade server forwards this to the Anthropic API.
      const _synId = _genToolCallId();
      const syntheticCall = {
        id: _synId,
        function: { name: extracted.name, arguments: extracted.args },
      };
      const assistantMsg2 = {
        role:       'assistant',
        content:    '',
        tool_calls: [syntheticCall],
      };
      messages.push(assistantMsg2);
      const prettyArgs2 = JSON.stringify(extracted.args);
      if (_servingSpinner && _servingSpinner.setTool) _servingSpinner.setTool(extracted.name);
      console.log(colorize(C.yellow, `⚙  ${extracted.name}(${prettyArgs2})`));
      let result2;
      try {
        result2 = await executeTool(extracted.name, extracted.args);
      } catch (toolErr2) {
        console.log(colorize(C.red, `  ✗  ${extracted.name}: ${toolErr2.message}`));
        result2 = `Error executing tool ${extracted.name}: ${toolErr2.message}`;
      }
      messages.push({ role: 'tool', tool_call_id: _synId, content: truncateToolOutput(extracted.name, result2) });
      return _agentLoopInner(messages, false);
    }
    return content;
  }

  const assistantMsg = {
    role:       'assistant',
    content:    content || '',
    tool_calls: tool_calls,
  };
  messages.push(assistantMsg);

  // Determine whether all calls are read-only so we can parallelise safely.
  const allReads = tool_calls.every(tc => READ_TOOLS.has((tc.function || tc).name));

  // Helper: resolve args from a tool-call descriptor.
  function resolveArgs(tc) {
    const fn   = tc.function || tc;
    let   args = fn.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch (_) { args = {}; }
    }
    if (!args || typeof args !== 'object') args = {};
    return { name: fn.name, args };
  }

  // Stuck-loop detector: count how many times this exact tool+args has run this
  // turn. Returns a directive string to append to the tool result when the model
  // is repeating itself, so it is forced to change approach instead of hanging.
  function repeatGuardNote(name, args) {
    const sig = _callSignature(name, args);
    const n   = (_callSignatureCounts.get(sig) || 0) + 1;
    _callSignatureCounts.set(sig, n);
    if (n < MAX_REPEAT_CALLS) return '';
    console.log(colorize(C.yellow,
      '  ↻  Detected a repeated call to ' + name + ' (' + n + 'x) — nudging a new approach.'));
    return '\n\n[SYSTEM NOTE: You have now called "' + name + '" with these exact arguments ' + n +
      ' times. This is not working. STOP repeating it. Do ONE of: (a) try a genuinely DIFFERENT ' +
      'approach or different arguments, (b) use a different tool to work around the obstacle, or ' +
      '(c) if you are truly blocked, stop and explain the blocker to the user and ask how to proceed. ' +
      'Do NOT call this tool with the same arguments again.]';
  }

  if (allReads && tool_calls.length > 1) {
    // ── Parallel path: all calls are read-only ──────────────────────────────
    console.log(colorize(C.dim, `Running ${tool_calls.length} tools in parallel...`));

    const results = await Promise.all(tool_calls.map(async (tc) => {
      const { name, args } = resolveArgs(tc);
      lastToolCall = { name, args };
      const prettyArgs = JSON.stringify(args);
      if (_servingSpinner && _servingSpinner.setTool) _servingSpinner.setTool(name);
      console.log(colorize(C.yellow, `⚙  ${name}(${prettyArgs})`));
      const _repeatNote = repeatGuardNote(name, args);
      let result;
      try {
        result = await executeTool(name, args);
      } catch (toolErr) {
        console.log(colorize(C.red,    `  ✗  ${name}: ${toolErr.message}`));
        console.log(colorize(C.yellow, `  ↻  Diagnosing and self-healing...`));
        result = `TOOL_ERROR: ${toolErr.message}\n\nDiagnosis: The tool "${name}" failed with the above error. ` +
          `Review the arguments you passed (${JSON.stringify(args)}), identify what went wrong, ` +
          `fix your approach, and try again with corrected arguments or a different strategy. ` +
          `Do not repeat the same call. If the file doesn't exist, check the path. ` +
          `If the content is invalid, rewrite it correctly. If the operation is blocked, find an alternative.`;
      }
      return { name, result: truncateToolOutput(name, result) + _repeatNote, id: tc.id || (tc.function && tc.function.id) || null };
    }));

    for (const { name, result: resultStr, id: _tcId } of results) {
      const hasSyntaxError = resultStr.includes('SYNTAX ERROR:');
      if (hasSyntaxError) {
        syntaxRetryCount++;
        if (syntaxRetryCount > MAX_SYNTAX_RETRIES) {
          messages.push({
            role: 'tool',
            tool_call_id: _tcId,
            content: resultStr +
              '\n\n[SYSTEM NOTE: ' + MAX_SYNTAX_RETRIES + ' syntax-fix attempts have failed. ' +
              'Stop retrying. Explain the syntax error to the user and ask for guidance.]',
          });
          continue;
        }
        console.log(colorize(C.red, '⚠  Syntax error detected — asking model to self-correct (attempt ' + syntaxRetryCount + '/' + MAX_SYNTAX_RETRIES + ')'));
      }
      messages.push({ role: 'tool', tool_call_id: _tcId, content: resultStr });
    }
  } else {
    // ── Sequential path: contains write tools or single call ───────────────
    for (const tc of tool_calls) {
      const { name, args } = resolveArgs(tc);
      lastToolCall = { name, args };
      // Anthropic requires tool_result.tool_use_id to match the assistant's
      // tool_use.id. Carry the originating call's id onto the tool message.
      const _tcId = tc.id || (tc.function && tc.function.id) || null;

      const prettyArgs = JSON.stringify(args);
      if (_servingSpinner && _servingSpinner.setTool) _servingSpinner.setTool(name);
      console.log(colorize(C.yellow, `⚙  ${name}(${prettyArgs})`));

      const _repeatNote = repeatGuardNote(name, args);

      let result;
      try {
        result = await executeTool(name, args);
      } catch (toolErr) {
        console.log(colorize(C.red,    `  ✗  ${name}: ${toolErr.message}`));
        console.log(colorize(C.yellow, `  ↻  Diagnosing and self-healing...`));
        result = `TOOL_ERROR: ${toolErr.message}\n\nDiagnosis: The tool "${name}" failed with the above error. ` +
          `Review the arguments you passed (${JSON.stringify(args)}), identify what went wrong, ` +
          `fix your approach, and try again with corrected arguments or a different strategy. ` +
          `Do not repeat the same call. If the file doesn't exist, check the path. ` +
          `If the content is invalid, rewrite it correctly. If the operation is blocked, find an alternative.`;
      }

      const resultStr = truncateToolOutput(name, result) + _repeatNote;

      const hasSyntaxError = resultStr.includes('SYNTAX ERROR:');
      if (hasSyntaxError) {
        syntaxRetryCount++;
        if (syntaxRetryCount > MAX_SYNTAX_RETRIES) {
          messages.push({
            role: 'tool',
            tool_call_id: _tcId,
            content: resultStr +
              '\n\n[SYSTEM NOTE: ' + MAX_SYNTAX_RETRIES + ' syntax-fix attempts have failed. ' +
              'Stop retrying. Explain the syntax error to the user and ask for guidance.]',
          });
          continue;
        }
        console.log(colorize(C.red, '⚠  Syntax error detected — asking model to self-correct (attempt ' + syntaxRetryCount + '/' + MAX_SYNTAX_RETRIES + ')'));
      }

      messages.push({ role: 'tool', tool_call_id: _tcId, content: resultStr });
    }
  }

  // Tail-recurse for the next round of tool calls.
  // isTop is passed as false so the outer agentLoop's finally block remains
  // responsible for clearing _isGenerating / _abortController.
  return _agentLoopInner(messages, false);
}

// ─── Built-in model catalog ───────────────────────────────────────────────────
var MODEL_CATALOG = [
  { id: 'deepseek-r1-7b',     file: 'DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf',     size: '4.7 GB', note: 'Best reasoning — think before answer' },
  { id: 'qwen2.5-coder-7b',   file: 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf',       size: '4.7 GB', note: 'Best balance — recommended' },
  { id: 'qwen2.5-coder-1.5b', file: 'Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf',     size: '1.1 GB', note: 'Ultra-fast, 2 GB RAM' },
  { id: 'codestral-22b',      file: 'Codestral-22B-v0.1-Q4_K_M.gguf',              size: '13 GB',  note: 'Best coding quality' },
  { id: 'llama3.1-8b',        file: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',      size: '4.9 GB', note: '128k context' },
  { id: 'deepseek-coder-7b',  file: 'deepseek-coder-7b-instruct-v1.5-Q4_K_M.gguf', size: '4.4 GB', note: 'Strong reasoning' },
  { id: 'phi3-mini',          file: 'Phi-3.1-mini-4k-instruct-Q4_K_M.gguf',        size: '2.2 GB', note: 'Tiny, 4k ctx' },
];
var _HF_URLS = {
  'DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf':     'https://huggingface.co/bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf',
  'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf':       'https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf',
  'Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf':     'https://huggingface.co/bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf',
  'Codestral-22B-v0.1-Q4_K_M.gguf':              'https://huggingface.co/bartowski/Codestral-22B-v0.1-GGUF/resolve/main/Codestral-22B-v0.1-Q4_K_M.gguf',
  'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf':      'https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
  'deepseek-coder-7b-instruct-v1.5-Q4_K_M.gguf': 'https://huggingface.co/bartowski/deepseek-coder-7b-instruct-v1.5-GGUF/resolve/main/deepseek-coder-7b-instruct-v1.5-Q4_K_M.gguf',
  'Phi-3.1-mini-4k-instruct-Q4_K_M.gguf':        'https://huggingface.co/bartowski/Phi-3.1-mini-4k-instruct-GGUF/resolve/main/Phi-3.1-mini-4k-instruct-Q4_K_M.gguf',
};
async function downloadModelFile(idOrFile, opts) {
  var entry = MODEL_CATALOG.find(function(m){ return m.id===idOrFile||m.file===idOrFile; });
  var fileName = entry ? entry.file : idOrFile;
  var destDir  = path.join(os.homedir(), '.proverbs', 'models');
  var destPath = path.join(destDir, fileName);
  fs.mkdirSync(destDir, { recursive: true });
  if (fs.existsSync(destPath)) { console.log(colorize(C.green, '  Already downloaded: ' + fileName)); return destPath; }
  var dlUrl = _HF_URLS[fileName]; if (!dlUrl) throw new Error('Unknown model. Run /models for catalog.');
  var tmpPath = destPath + '.part';
  var resumeBytes = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
  if (resumeBytes > 0) console.log(colorize(C.dim, '  Resuming from ' + (resumeBytes/1e6).toFixed(0) + ' MB...'));
  else console.log(colorize(C.dim, '  Downloading ' + fileName + ' (~4.7 GB) to ' + destPath + '...'));
  // Use curl for reliable resume support (-C -), follow redirects, show progress
  return new Promise(function(resolve, reject) {
    var curlArgs = ['-L', '-C', '-', '--retry', '5', '--retry-delay', '3', '-o', tmpPath, '--progress-bar', dlUrl];
    var curl = require('child_process').spawn('curl', curlArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
    curl.on('close', function(code) {
      if (code !== 0) return reject(new Error('curl exited with code ' + code + '. Run again to resume.'));
      try { fs.renameSync(tmpPath, destPath); } catch(e) { return reject(e); }
      console.log(colorize(C.green, '\n  ✔  Saved: ' + destPath));
      // Auto-switch to this model and persist to config
      if (opts && opts.autoSwitch !== false) {
        var modelId = fileName.replace('.gguf','').replace(/-Q4_K_M$/i,'').replace(/-Q[0-9]_[A-Z_]+$/i,'');
        model = modelId;
        var cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch(_) {}
        cfg.model = modelId;
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
        console.log(colorize(C.cyan, '  Auto-switched to: ' + modelId + ' (saved to config)\n'));
        // Enable thinking mode if this is a reasoning model
        if (modelSupportsThinking(modelId)) {
          thinkingEnabled = true;
          cfg.thinkingEnabled = true;
          fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
          console.log(colorize(C.dim, '  Thinking mode auto-enabled for reasoning model.\n'));
        }
      }
      resolve(destPath);
    });
    curl.on('error', function(e) { reject(new Error('curl not found: ' + e.message + '. Install curl or try again.')); });
  });
}

// ─── Self-update ─────────────────────────────────────────────────────────────
async function selfUpdate() {
  var urls = ['https://proverbscode.com/dist/cli.js'];
  var newCode = null;
  for (var ui=0; ui<urls.length; ui++) {
    try {
      console.log(colorize(C.dim, '  Fetching from '+urls[ui]+'...'));
      var res = await httpsGet(urls[ui], 30000);
      if (res.status===200&&res.body&&res.body.length>50000) { newCode=res.body; break; }
    } catch(e) {}
  }
  if (!newCode) throw new Error('Could not fetch update. Check internet connection.');
  var currentFile = require.main ? require.main.filename : process.argv[1];
  var tmpFile = currentFile+'.update.tmp';
  fs.writeFileSync(tmpFile, newCode, 'utf8');
  try { execSync('node --check "'+tmpFile+'"', {stdio:'pipe'}); }
  catch(e) { try{fs.unlinkSync(tmpFile);}catch(_){} throw new Error('Downloaded file failed syntax check.'); }
  fs.renameSync(tmpFile, currentFile);
  return 'Updated successfully. Restart Proverbs to apply.';
}

// ─── Auto-test generation ────────────────────────────────────────────────────
async function triggerAutoTest(filePath, content) {
  if (!autoTestEnabled) return;
  var ext=path.extname(filePath), base=path.basename(filePath,ext);
  if (/test|spec/.test(base.toLowerCase())) return;
  if (!['.js','.ts','.jsx','.tsx','.py'].includes(ext)) return;
  var testFile=path.join(path.dirname(filePath), base+(ext==='.py'?'_test.py':'.test'+ext));
  if (fs.existsSync(testFile)) return;
  console.log(colorize(C.dim, '  (autotest: generating '+path.basename(testFile)+')'));
  try {
    var snippet=content.length>3000?content.slice(0,3000)+'\n// ...':content;
    var atMsgs=[{role:'system',content:buildSystemPrompt()},{role:'user',content:'Generate a comprehensive test file for:\n// '+filePath+'\n'+snippet+'\n\nWrite ONLY the complete test file, no explanation.'}];
    var testCode=await agentLoop(atMsgs);
    if (testCode&&!testCode.includes('[interrupted]')&&testCode.trim().length>20) {
      fs.writeFileSync(testFile,testCode.trim(),'utf8');
      console.log(colorize(C.green,'  ✔  Test: '+path.basename(testFile)));
    }
  } catch(e) { console.log(colorize(C.dim,'  (autotest: '+e.message+')')); }
}

// ─── Help text ────────────────────────────────────────────────────────────────
function printHelp() {
  console.log(colorize(C.cyan, '\nCommands:'));
  console.log('  /exit                   — Quit Proverbs');
  console.log('  /clear                  — Clear conversation history');
  console.log('  /help                   — Show this help');
  console.log('  /model <name>           — Switch to a different model');
  console.log('  /cwd <path>             — Change the working directory');
  console.log(colorize(C.yellow, '\nIndependence + Power:'));
  console.log('  /update                 — Download + apply the latest Proverbs release');
  console.log('  /models                 — Browse built-in model catalog with install status');
  console.log('  /models download <id>   — Download a .gguf model directly to ~/.proverbs/models/');
  console.log('  /agents <task>          — Spawn 3 parallel sub-agents (each with a different focus angle)');
  console.log('  /security               — OWASP security audit of the current project (100% local)');
  console.log('  /autotest on|off        — Auto-generate a test file after every source file write');
  console.log('  /perms                  — View/set YOUR file-access policy (open by default; you set the terms)');
  console.log('  /sandbox on|off         — Block destructive bash patterns (rm -rf /, mkfs, etc.)');
  console.log('  /limits                 — View all limits/constraints with on/off status');
  console.log('  /limits off             — Unleash mode: remove all caps, sandbox, truncation');
  console.log('  /limits on              — Restore safe defaults');
  console.log('  /limits <name> on|off   — Toggle one constraint (sandbox, truncation, cot, thinking, critique, planning…)');
  console.log('  /train status           — Show ProverbsLM training status and checkpoint info');
  console.log('  /train local            — Train a nano (15M) model on your sessions (~1-2h CPU)');
  console.log('  /train data             — Download CodeSearchNet code pre-training data (~500MB)');
  console.log('  /train export           — Export trained .pt checkpoint → .gguf for faster inference');
  console.log('  /train tokenizer        — Train BPE tokenizer on your codebase (cuts token count 15-25%)');
  console.log('  /train embed            — Train local embedding head with SimCSE (better RAG, no internet)');
  console.log('  /train prune [sparsity] — Prune model weights (default 25% — smaller + faster)');
  console.log(colorize(C.yellow, '\nBackend:'));
  console.log('  /backend                — Show active backend and probe all available backends');
  console.log('  /backend auto           — Auto-detect and switch to the best available backend');
  console.log('  /backend <name>         — Force a specific backend (llamafile|proverbs-server)');
  console.log(colorize(C.yellow, '\nProverbs Server — built-in llama.cpp inference (no Ollama needed):'));
  console.log('  /server start [port]    — Start the Proverbs inference server (default port 11435)');
  console.log('  /server stop            — Stop the server');
  console.log('  /server status          — Show running status');
  console.log('  /server models          — List available .gguf model files');
  console.log(colorize(C.dim, '  Place .gguf files in ~/.proverbs/models/ — server exposes Ollama + OpenAI API\n'));
  console.log(colorize(C.yellow, '\nAdmin — teach Proverbs permanently:'));
  console.log('  /admin - <instruction>  — Save a new rule (applied every session)');
  console.log('  /admin --list           — Show all saved rules');
  console.log('  /admin --clear          — Delete all rules');
  console.log('  /admin --remove <#>     — Delete one rule by number');
  console.log(colorize(C.dim, '  Example: /admin - always use TypeScript strict mode'));
  console.log(colorize(C.yellow, '\nProjects — switch between your apps:'));
  console.log('  /project <name>         — Switch working directory to a project');
  console.log('  /switch <name>          — Jump to a project + show last session context');
  console.log('  /switch                 — List all projects sorted by most recent');
  console.log('  /ship                   — Run scripts/deploy-verify.sh (your real deploy pipeline)');
  console.log('  /ship dry               — Dry-run the deploy pipeline without deploying');
  console.log('  /diff                   — Show uncommitted changes in current project');
  console.log('  /diff all               — Scan ALL projects for uncommitted changes');
  console.log('  /multi <task> @p1 @p2   — Apply same task across multiple projects');
  console.log('  /pr                     — Generate PR description from diff, push, create PR');
  console.log('  /pr push                — Push current branch without creating PR');
  console.log('  /mine                   — Extract all your projects as training data + fine-tune');
  console.log('  /project --list         — Show all registered projects');
  console.log('  /project --scan         — Re-scan ~/  for new projects');
  console.log(colorize(C.yellow, '\nFine-tuning — train Proverbs on your style:'));
  console.log('  /finetune bake          — (disabled — Ollama removed; use /admin - <rule> instead)');
  console.log('  /finetune format        — Format session logs as training data');
  console.log('  /finetune upload        — Upload training data to Hugging Face');
  // Feature 1
  console.log(colorize(C.yellow, '\nSearch tools (used by the AI automatically):'));
  console.log('  grep_files(pattern, path?, extensions?)  — Search file contents by regex');
  console.log('  find_files(pattern, path?)               — Find files by name (glob: *, ?)\n');
  // Feature 2
  console.log(colorize(C.yellow, '\nGit tools (usable via natural language):'));
  console.log('  git_status              — Show working-tree status');
  console.log('  git_diff [file]         — Show unstaged diff (optional file)');
  console.log('  git_log [n]             — Show last N commits (default 10)');
  console.log('  git_commit <message>    — Stage all changes and commit');
  // Feature 3
  console.log(colorize(C.yellow, '\nWeb search:'));
  console.log('  /search <query>         — Search the web via DuckDuckGo and print results');
  // Feature 4
  console.log(colorize(C.yellow, '\nIndexing — understand your project:'));
  console.log('  /index                  — Scan cwd and build a file tree (auto-runs on /cwd change)');
  // Feature 5
  console.log(colorize(C.yellow, '\nMemory — save and recall past sessions:'));
  console.log('  /memory save [name]   — Summarize and save current conversation');
  console.log('  /memory list          — List all saved memories');
  console.log('  /memory load <name>   — Inject a memory into current conversation');
  console.log('  /memory delete <name> — Delete a saved memory');
  console.log(colorize(C.yellow, '\nPersistent facts — always injected into every session:'));
  console.log('  /remember <fact>      — Save a fact about this project permanently');
  console.log('  /facts                — List all facts for this project');
  console.log('  /facts remove <n>     — Delete fact #n');
  console.log('  /facts clear          — Delete all facts for this project');
  console.log(colorize(C.dim, '  Example: /remember this project uses Prisma with PostgreSQL'));
  console.log(colorize(C.yellow, '\nPerformance:'));
  console.log('  /profile              — Show live perf stats: latency, cache hits, memory, model info');
  // Feature 6
  console.log(colorize(C.yellow, '\nWeb UI — browser interfaces:'));
  console.log('  /ui [port]              — Start chat UI (default port 4242)');
  console.log('  /ide [port]             — VS Code-style IDE: file tree + editor + terminal (default port 4400)');
  console.log(colorize(C.dim, '  /ide opens a full browser IDE with file explorer, syntax editor, AI terminal, git status'));
  // Feature 7
  console.log(colorize(C.yellow, '\nRAG — codebase search (TF-IDF + semantic embeddings):'));
  console.log('  /rag <query>            — Show top 3 relevant code chunks (semantic if /embed run, else TF-IDF)');
  console.log('  /embed                  — Build semantic embedding index for cwd (run once per project)');
  console.log('  /semrag <query>         — Semantic-only search using embedding vectors (top 5 results)');
  console.log(colorize(C.dim, '  Example: /rag authentication middleware'));
  console.log(colorize(C.dim, '  Example: /semrag database connection pooling'));
  console.log(colorize(C.dim, '  Requires: Proverbs server running  (for /embed and /semrag)'));
  console.log(colorize(C.dim, '  Tool: search_codebase(query, max_results?) — auto-uses semantic index when available\n'));
  // Feature 8
  console.log(colorize(C.yellow, '\nVoice input:'));
  console.log('  /voice                  — Record speech and send as chat message');
  // Feature 9
  console.log(colorize(C.yellow, '\nImage analysis — powered by llava:'));
  console.log('  /image <path> [question]  — Analyze an image file with optional question');
  console.log('  /screenshot               — Interactive screen snip + auto-analyze (macOS)');
  console.log(colorize(C.dim, '  Requires: Proverbs server running with vision support\n'));
  // Feature 10
  console.log(colorize(C.yellow, '\nSmart routing — auto-select model per query:'));
  console.log('  /models                  — List all Ollama models with role tags');
  console.log('  /route auto|manual       — Toggle automatic model routing');
  console.log('  /route fast <model>      — Assign the fast (small) model');
  console.log('  /route smart <model>     — Assign the smart (large) model');
  console.log('  /route vision <model>    — Assign the vision model\n');
  // New features
  console.log(colorize(C.yellow, '\nPatch — surgical multi-occurrence replacement:'));
  console.log('  /patch <path> |old string| |new string|');
  console.log(colorize(C.dim, '  Replaces ALL occurrences of old string with new string.'));
  console.log(colorize(C.dim, '  Wrap both strings in pipe characters to safely handle spaces and quotes.'));
  console.log(colorize(C.dim, '  Leave new string empty to delete: /patch src/app.js |bad line| ||'));
  console.log(colorize(C.dim, '  Example: /patch src/app.js |console.log("old")| |console.log("new")|\n'));
  console.log(colorize(C.dim, '  AI tool: patch_file(path, old_string, new_string) — used automatically\n'));
  console.log(colorize(C.yellow, '\nContext gauge — monitor and manage context window usage:'));
  console.log('  /context                — Show a bar gauge of real token usage vs. model limit');
  console.log('  /recommend              — List recommended models with context sizes and install commands');
  console.log(colorize(C.yellow, '\nContext compression — keep long sessions from hitting model limits:'));
  console.log('  /compress               — Summarize older history turns into a single compact message\n');
  console.log(colorize(C.cyan,  '  /load <path> [depth]'));
  console.log(colorize(C.white, '    Read a file and inline its local imports (default depth 2, max 5).'));
  console.log(colorize(C.dim,   '    Example: /load src/index.js'));
  console.log(colorize(C.dim,   '    Example: /load ./lib/auth.js 3'));
  console.log('  /ctx add <path>    — Pin a file into the system prompt for this session');
  console.log('  /ctx remove <path> — Unpin a previously pinned file');
  console.log('  /ctx list          — Show all pinned files and their character counts');
  console.log('  /ctx clear         — Remove all pinned files');
  console.log('  /ctx auto          — Auto-detect and pin key project files (package.json, tsconfig, etc.)');
  console.log('  /plan <task>    Generate and execute a step-by-step plan');
  console.log('  /plan status    Show progress of the active plan');
  console.log('  /plan abort     Cancel the active plan');
  console.log('  /templates          List frameworks detected in the current working directory');
  console.log('  /fallback                 — show cloud fallback status and usage');
  console.log('  /fallback on              — enable LiteLLM cloud fallback (current model)');
  console.log('  /fallback off             — disable fallback, return to local Ollama');
  console.log('  /fallback <model>         — set model and enable (e.g. gpt-4o, gemini/gemini-pro)');
  console.log('  /fallback status          — show fallback status, model, and proxy URL');
  console.log(colorize(C.cyan,  '  /docs <package>         ') + 'Fetch npm package docs + README into context');
  console.log(colorize(C.dim,   '    Example: /docs express'));
  console.log(colorize(C.dim,   '    Example: /docs @types/node'));
  console.log(colorize(C.cyan,  '  /fetch <url>            ') + 'Fetch any URL and inject content into context');
  console.log(colorize(C.dim,   '    Example: /fetch https://api.github.com/repos/expressjs/express'));
  console.log(colorize(C.dim,   '    Example: /fetch https://example.com/docs'));
  console.log(colorize(C.dim,   '    AI tool: fetch_url(url, selector?) — auto-used by model\n'));
  console.log('  /validate <path>   Syntax-check a JS/JSON/TS/TSX/JSX file and report errors');
  // Session persistence
  console.log(colorize(C.yellow, '\nSession persistence — save and resume conversations:'));
  console.log('  /save <name>            — Save current conversation to disk');
  console.log('  /sessions               — List all saved sessions');
  console.log('  /resume <name>          — Restore a saved session (replaces current history)');
  console.log(colorize(C.dim, '  Example: /save debug-login'));
  console.log(colorize(C.dim, '  Example: /resume debug-login\n'));
  // Multi-line input
  console.log(colorize(C.yellow, '\nMulti-line input — paste code blocks without triggering multiple calls:'));
  console.log('  /ml                     — Toggle manual multi-line mode (empty line to submit)');
  console.log(colorize(C.dim, '  Delimiters: start a line with ``` or """ to open; repeat to close'));
  console.log(colorize(C.dim, '  Example: type ``` → paste code → type ``` on its own line\n'));
  // Diff preview
  console.log(colorize(C.yellow, '\nDiff preview — see what changed after every file write:'));
  console.log('  /diff on                — Enable diff output after write_file/edit_file/patch_file (default: on)');
  console.log('  /diff off               — Suppress diff output for quieter operation');
  console.log('  /diff                   — Show current diff preview state');
  console.log(colorize(C.dim, '  Diffs show ±2 lines of context around each changed region.\n'));
  // Git auto-commit
  console.log(colorize(C.yellow, '\nGit auto-commit — commit changes after AI responses:'));
  console.log('  /commit                 — Stage all changes and prompt for a commit message');
  console.log('  /commit <message>       — Stage all changes and commit with the given message immediately');
  console.log('  /autocommit on          — After each AI response, show changed-file count and prompt to commit');
  console.log('  /autocommit off         — Disable the auto-commit prompt (default)');
  console.log('  /gitdiff                — Show git diff --stat for the current working directory');
  console.log(colorize(C.dim, '  Example: /commit fix: correct off-by-one error in parser\n'));
  // Self-critique
  console.log(colorize(C.yellow, '\nSelf-critique — model reviews its own code output:'));
  console.log('  /critique on            — Enable self-critique after code responses (default: on)');
  console.log('  /critique off           — Disable self-critique');
  console.log('  /critique threshold <n> — Set minimum response lines to trigger (default: 20)');
  console.log('  /critique               — Show current self-critique state');
  console.log(colorize(C.dim, '  When enabled, code responses >= threshold lines trigger an automated review pass.\n'));
  // Parallel tools
  console.log(colorize(C.yellow, '\nParallel tool execution:'));
  console.log('  When the AI issues multiple read-only tools at once, Proverbs runs them');
  console.log('  concurrently (Promise.all) for faster responses. Write tools always run');
  console.log(colorize(C.dim, '  sequentially to prevent race conditions.\n'));
  // Undo / rollback
  console.log(colorize(C.yellow, '\nUndo — roll back the last file write, edit, or patch:'));
  console.log('  /undo                   — Restore the most recently modified file from backup');
  console.log('  /undo list              — Show all backups currently in the undo stack');
  console.log('  /undo clear             — Delete all backups and empty the undo stack');
  console.log(colorize(C.dim, `  Tracks up to ${MAX_UNDO_STACK} backups across write_file, edit_file, and patch_file.\n`));
  // Clipboard
  console.log(colorize(C.yellow, '\nClipboard — paste and copy without leaving the terminal:'));
  console.log('  /paste                  — Preview clipboard and inject into next message');
  console.log('  /paste <question>       — Send clipboard content + question immediately');
  console.log('  /copy                   — Copy the last AI reply to the clipboard');
  console.log(colorize(C.dim, '  AI tools: clipboard_read(), clipboard_write(text) — used automatically\n'));
  // Context gauge
  console.log('  /context          Show real token usage vs. model context window');
  console.log('  /recommend        List recommended models with context sizes and install commands');
  // /scan
  console.log(colorize(C.yellow, '\nProject scan — generate a .proverbs profile for the current directory:'));
  console.log('  /scan                   \u2014 Scan package.json, detect stack, key files, and write .proverbs');
  console.log(colorize(C.dim, '  The profile is auto-loaded into the system prompt each session.'));
  console.log(colorize(C.dim, '  After scanning, run /script create to add your own instructions.\n'));
  // .script
  console.log(colorize(C.yellow, '\n.script — per-project instruction files (like CLAUDE.md):'));
  console.log('  /script               — Show currently loaded .script content');
  console.log('  /script edit          — Open cwd/.script in $EDITOR (create if missing)');
  console.log('  /script reload        — Re-read .script files from cwd and ancestors');
  console.log('  /script create        — Write a starter template to cwd/.script and open it');
  console.log('  /script global        — Open global ~/.proverbs/.script in editor');
  console.log(colorize(C.dim, '  .script files are loaded on startup, on /cwd change, and on /project switch.'));
  console.log(colorize(C.dim, '  Files are read from cwd up to ~ and the global ~/.proverbs/.script.\n'));
  // File watcher
  console.log(colorize(C.yellow, '\nFile watcher — detect external changes and invalidate caches:'));
  console.log('  /watch                  — Show watcher status and recently changed files');
  console.log('  /watch on               — Enable the file watcher (default: on)');
  console.log('  /watch off              — Disable the file watcher');
  console.log(colorize(C.dim, '  Watches cwd with fs.watch({ recursive: true }). On any external change,'));
  console.log(colorize(C.dim, '  the RAG/embed/dep-graph caches are invalidated and rebuilt on next use.'));
  console.log(colorize(C.dim, '  Note: recursive watch works on macOS and Windows; some Linux filesystems'));
  console.log(colorize(C.dim, '  (inotify-limited) may not support it — the watcher silently disables itself.\n'));
  // Plugin system
  console.log(colorize(C.yellow, '\nPlugins — extend Proverbs with custom tools:'));
  console.log('  /plugins              — List all loaded plugins');
  console.log('  /plugins reload       — Reload all plugins from disk');
  console.log('  /plugins new <name>   — Scaffold a starter plugin in ' + PLUGINS_DIR);
  console.log(colorize(C.dim, '  Drop any .js file in ' + PLUGINS_DIR + ' and run /plugins reload.'));
  console.log(colorize(C.dim, '  Each plugin exports: { name, description, parameters, handler }.'));
  console.log(colorize(C.dim, '  handler(args, ctx) — ctx = { cwd, model, colorize, C, fs, path, execSync }\n'));
  // TS / ESLint feedback loop
  console.log(colorize(C.yellow, '\nTypeScript + ESLint feedback loop:'));
  console.log('  /tscheck               — Run tsc --noEmit in cwd and show errors');
  console.log('  /tscheck on            — Enable auto TS check after write_file/edit_file/patch_file (default: on)');
  console.log('  /tscheck off           — Disable auto TS check');
  console.log('  /lint <path>           — Run ESLint on a specific file and show warnings');
  console.log('  /lint on               — Enable auto ESLint check after file writes (default: on)');
  console.log('  /lint off              — Disable auto ESLint check');
  console.log(colorize(C.dim, '  Both use npx (bundled with node) — no extra npm packages needed.'));
  console.log(colorize(C.dim, '  TS check requires a tsconfig.json in the project tree.'));
  console.log(colorize(C.dim, '  ESLint check requires an .eslintrc.* or eslint.config.* in the project tree.\n'));
  // Cross-file edit planner
  console.log(colorize(C.yellow, '\nCross-file edit planner — preview affected files before making changes:'));
  console.log('  /planner on             — Enable multi-file change planner (default: on)');
  console.log('  /planner off            — Disable planner');
  console.log('  /planner                — Show current planner state');
  console.log(colorize(C.dim, '  When enabled, requests that look like multi-file tasks ask the model to list'));
  console.log(colorize(C.dim, '  all files it will touch, then ask you to confirm before proceeding.\n'));

  console.log(colorize(C.yellow, 'Test Engine — run the real tests after code changes, fix failures, re-test:'));
  console.log('  /testengine             — Show state + which checks are detected here');
  console.log('  /testengine on|off      — Toggle the PASS/FAIL gate (default: on)');
  console.log('  /testengine level <1-5> — 1 syntax · 2 unit · 3 integration · 4 behavioral · 5 adversarial');
  console.log('  /testengine attempts <n>— Fix→retest cycles before giving up (default: 3)');
  console.log('  /testengine now         — Run the suite immediately');
  console.log(colorize(C.dim, '  (alias: /te)'));
  console.log(colorize(C.dim, '  After any turn that edits code, the project\'s own checks are run. On failure'));
  console.log(colorize(C.dim, '  the real output is fed back and the work is corrected, then re-tested.\n'));

  console.log(colorize(C.yellow, 'Eval suite — local regression harness (scores the model, not your code):'));
  console.log('  /eval --quick           — Fast subset (~9 cases)');
  console.log('  /eval                   — Full suite (23 cases, 8 dimensions)');
  console.log('  /eval --compare         — Score vs the previous run, KEEP or ROLL BACK');
  console.log('  /eval --dimension coding  — One dimension only');
  console.log('  /eval --model llama3.1:8b — Pick the model');
  console.log('  /eval --resume          — Continue an interrupted run');
  console.log('  /eval history           — Show past runs');
  console.log(colorize(C.dim, '  Graded deterministically (code execution, regex, JSON parsing) — no judge'));
  console.log(colorize(C.dim, '  model, so a run costs N inferences instead of 3N.\n'));
  // Syntax highlighting
  console.log(colorize(C.yellow, '\nSyntax highlighting — colorize code blocks in responses:'));
  console.log('  /highlight on           — Enable syntax highlighting (default: on)');
  console.log('  /highlight off          — Disable syntax highlighting');
  console.log('  /highlight              — Show current highlighting state');
  console.log(colorize(C.dim, '  Supports: js/ts/jsx/tsx, python, bash/sh/zsh, json. No npm packages required.\n'));
  // Tool output truncation
  console.log(colorize(C.yellow, '\nTool output truncation — prevent large results from eating context:'));
  console.log('  /full                   — Re-run the last tool call and print the full untruncated output');
  console.log('  /truncate               — Show current truncation state and limit');
  console.log('  /truncate on            — Enable truncation (default: on, 12 000-char limit)');
  console.log('  /truncate off           — Disable truncation — full results sent to model');
  console.log('  /truncate <n>           — Set the char limit (e.g. /truncate 20000)');
  console.log(colorize(C.dim, '  When a result exceeds the limit the first 60 and last 20 lines are kept;'));
  console.log(colorize(C.dim, '  the rest is replaced with a summary. Use /full to see the complete output.\n'));
  // Token counting
  console.log(colorize(C.yellow, '\nToken counting — real counts via Ollama /api/tokenize:'));
  console.log('  /tokens                 — Count tokens in current history, breakdown by role');
  console.log('  /tokens on              — Show "[~N tokens used / M context]" after each response');
  console.log('  /tokens off             — Hide per-response token count (default: off)');
  console.log(colorize(C.dim, '  Falls back to chars/4 estimate if Ollama tokenize endpoint unavailable.\n'));
  // Thinking mode
  console.log(colorize(C.yellow, '\nThinking mode — structured reasoning for supported models:'));
  console.log('  /think                  — Show current thinking mode state');
  console.log('  /think on               — Enable (injects <think> seed; displays reasoning separately)');
  console.log('  /think off              — Disable thinking mode');
  console.log('  /think models           — List models with native thinking support');
  console.log(colorize(C.dim, '  Supported: deepseek-r1, qwen3, phi4-reasoning, marco-o1, skywork-o1, reflection'));
  console.log(colorize(C.dim, '  Auto-enables at startup and on /model switch when a thinking model is detected.'));
  console.log(colorize(C.dim, '  <think> blocks are always stripped from history regardless of mode.\n'));
  // Persistent config
  console.log(colorize(C.yellow, '\nPersistent config — survive restarts:'));
  console.log('  /config                 — Show all persisted settings and their current values');
  console.log('  /config set <key> <val> — Set any config key live and persist it');
  console.log('  /config reset           — Delete config.json and revert all toggles to defaults\n');
  // Claude Code equivalents
  console.log(colorize(C.yellow, '\nClaude Code-style commands:'));
  console.log(colorize(C.yellow, '\n.script — project instructions (exactly like CLAUDE.md):'));
  console.log('  /script                 — Show loaded .script files and content preview');
  console.log('  /script new             — Create a .script file in the current project');
  console.log('  /script edit            — Open .script in $EDITOR');
  console.log('  /script reload          — Force reload all .script files from disk');
  console.log(colorize(C.dim, '  Supports: @import ./file.md  •  $ENV_VAR  •  ## Rules / ## Context / ## Commands sections'));
  console.log(colorize(C.dim, '  Auto-reloads on save. Hierarchy: project > parent dirs > ~/.proverbs/.script\n'));
  console.log(colorize(C.yellow, '\nVerification:'));
  console.log('  /verify                 — End-to-end health check: backend → models → inference → tools');
  console.log('  /backend scan           — Scan local network for Proverbs XPS inference server');
  console.log('  /backend http://<ip>:<port> — Connect directly to a remote Proverbs server\n');
  console.log('  /aside <question>       — Quick side question, not added to conversation history  (= /btw)');
  console.log('  /rewind [n]             — Roll back last N conversation turns (default 1)  (= /checkpoint)');
  console.log('  /review [low|med|high]  — AI code review of current git diff at given depth  (= /code-review)');
  console.log('  /usage                  — Session stats: turns, est. tokens, uptime, model  (= /stats)');
  console.log('  /export [filename]      — Export full conversation as Markdown file');
  console.log('  /rename <name>          — Rename the current session');
  console.log('  /recap                  — One-line AI summary of what this session accomplished');
  console.log('  /check                  — Full system diagnostic: backend, models, venv, tokenizer  (= /doctor)');
  console.log('  /init                   — Generate .proverbs project profile  (like CLAUDE.md)');
  console.log('  /effort [low|med|high|max] — Set reasoning depth (= cot/thinking toggle shortcut)');
  console.log('  /branch [name]          — Save current conversation as a named branch');
  console.log('  /checkout [name]        — Restore a saved conversation branch');
  console.log('  /fork <task>            — Run a sub-task in parallel, non-blocking');
  console.log('  /goal <condition>       — Keep working until condition is met (max 10 iterations)\n');
}

// ─── File watcher — detect external changes, invalidate caches ───────────────
function stopFileWatcher() {
  if (_fileWatcher) {
    try { _fileWatcher.close(); } catch (_) {}
    _fileWatcher = null;
  }
}

function startFileWatcher(dir) {
  stopFileWatcher();
  if (!_watcherEnabled) return;
  try {
    _fileWatcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const skip = ['node_modules', '.git', '.next', 'dist', 'build', '.proverbs'];
      if (skip.some(s => filename.includes(s))) return;
      if (filename.endsWith('.swp') || filename.endsWith('~')) return;
      _changedFiles.add(filename);
      // Invalidate RAG / embed / dep-graph caches so they are rebuilt fresh
      if (_ragIndex && _ragIndex.cwd === dir) _ragIndex = null;
      if (_embedIndex && _embedIndex.cwd === dir) _embedIndex = null;
      if (typeof _depGraph !== 'undefined' && _depGraph && _depGraph.cwd === dir) _depGraph = null;
    });
    _fileWatcher.on('error', () => stopFileWatcher());
  } catch (_) {
    // fs.watch unsupported or permission denied — silently disable
    _fileWatcher = null;
  }
}

// ─── Admin command handler ────────────────────────────────────────────────────
function handleAdmin(rawArgs) {
  const trimmed = rawArgs.trim();

  if (trimmed === '--list') {
    const rules = loadRules();
    if (rules.length === 0) {
      console.log(colorize(C.dim, '\n(no admin rules saved yet)\n'));
    } else {
      console.log(colorize(C.cyan, `\nAdmin Rules (${rules.length}):`));
      rules.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
      console.log();
    }
    return;
  }

  if (trimmed === '--clear') {
    clearRules();
    console.log(colorize(C.green, '\n✔  All admin rules cleared.\n'));
    return;
  }

  if (trimmed.startsWith('--remove ')) {
    const num = parseInt(trimmed.slice(9).trim(), 10);
    if (isNaN(num)) {
      console.log(colorize(C.red, '\n✗  Usage: /admin --remove <number>\n'));
    } else if (removeRule(num)) {
      console.log(colorize(C.green, `\n✔  Rule ${num} removed.\n`));
    } else {
      console.log(colorize(C.red, `\n✗  No rule #${num}.\n`));
    }
    return;
  }

  if (trimmed.startsWith('- ')) {
    const instruction = trimmed.slice(2).trim();
    if (!instruction) {
      console.log(colorize(C.red, '\n✗  No instruction provided after "-".\n'));
      return;
    }
    const num = saveRule(instruction);
    console.log(colorize(C.green, `\n✔  Rule #${num} saved. Proverbs will follow this in every future session.\n`));
    console.log(colorize(C.dim, `   "${instruction}"\n`));
    return;
  }

  console.log(colorize(C.red, '\n✗  Usage: /admin - <instruction>  |  --list  |  --clear  |  --remove <#>\n'));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  loadConfig();
  // ── Headless mode: proverbs --headless --task "..." ──────────────────────
  var _hIdx = process.argv.indexOf('--headless');
  var _tIdx = process.argv.indexOf('--task');
  if (_hIdx !== -1 && _tIdx !== -1) {
    var _htask = process.argv[_tIdx + 1] || '';
    if (!_htask) { process.stdout.write('ERROR: no task\n'); process.exit(1); }
    cwd = process.cwd();
    await detectBackend(true);
    detectedFrameworks = detectFrameworks(cwd);
    detectedConventions = detectConventions(cwd);
    loadGitContext(cwd);
    try { loadScriptFiles(cwd); } catch(_) {}
    try { loadProverbsProfile(cwd); } catch(_) {}
    var _hMsgs = [{ role: 'system', content: buildSystemPrompt() }, { role: 'user', content: _htask }];
    try {
      var _hReply = await agentLoop(_hMsgs);
      process.stdout.write('\n--- PROVERBS RESULT ---\n' + (_hReply || '') + '\n--- END ---\n');
    } catch(e) { process.stdout.write('AGENT ERROR: ' + e.message + '\n'); }
    process.exit(0);
  }
  printBanner();
  // Auto-detect best available backend; falls back to Ollama
  await detectBackend(false);
  await ensureOllama();
  initSessionLog();

  // Feature 4: Auto-index the current project silently on startup
  try { runIndex(cwd, true); } catch (_) {}

  // Feature 5: Ensure memories directory exists
  ensureMemoriesDir();

  // Feature 10: Smart routing — load persisted config and silently detect best available models
  loadRoutingConfig();
  autoDetectRoutingModels().catch(() => {});

  // Load all startup resources silently, then print one combined status line
  let _scriptCount = 0, _pluginCount = 0, _cronCount = 0;
  try { _scriptCount = loadScriptFiles(cwd); } catch (_) {}
  try { loadProverbsProfile(cwd); } catch (_) {}
  try { fs.mkdirSync(BACKUPS_DIR, { recursive: true }); } catch (_) {}
  ensureSessionsSaveDir();
  try { _pluginCount = loadPlugins(); } catch (_) {}
  loadTasks();
  startAllCrons();
  _cronCount = cronJobs.filter(j => j.enabled).length;

  // Single combined status line (only shown if something loaded)
  const _statusParts = [];
  if (_scriptCount > 0) _statusParts.push(`${_scriptCount} instruction${_scriptCount === 1 ? '' : 's'}`);
  if (_pluginCount > 0) _statusParts.push(`${_pluginCount} plugin${_pluginCount === 1 ? '' : 's'}`);
  if (_cronCount > 0)   _statusParts.push(`${_cronCount} cron${_cronCount === 1 ? '' : 's'}`);
  if (_statusParts.length > 0)
    console.log(colorize(C.dim, `  ${_statusParts.join(' · ')}\n`));

  startHeartbeat(60000);

  // Clipboard: pending clipboard content to prepend to next user message
  let _pendingClipboard = null;

  // Detect frameworks in the startup cwd
  detectedFrameworks = detectFrameworks(cwd);
  detectedConventions = detectConventions(cwd);
  loadGitContext(cwd);

  // File watcher — watch startup cwd for external changes
  startFileWatcher(cwd);

  // Reset syntax retry counter at startup
  syntaxRetryCount = 0;

  // Auto-enable thinking mode if the startup model supports it
  if (modelSupportsThinking(model)) {
    thinkingEnabled = true;
    console.log(colorize(C.dim, '(thinking mode auto-enabled for ' + model + ')\n'));
  }

  let history = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: colorize(C.cyanBold, 'proverbs> '),
  });
  _rlRef = rl; // expose for the type-ahead queue drainer

  console.log(colorize(C.dim, '  Enter to send · ``` for multi-line · type while it works to queue · /help · Ctrl+C to interrupt'));
  rl.prompt();

  rl.on('line', async (line) => {
    // ── Type-ahead queue ─────────────────────────────────────
    // If a turn is generating, buffer this line and replay it when the turn
    // finishes. Skip queueing for the multi-line accumulator (it manages its
    // own buffer) and for empty lines. This lets the user keep typing while
    // the model works, like Claude Code.
    if (_isGenerating && !_mlMode) {
      const _q = line.trim();
      if (_q) {
        _inputQueue.push(line);
        // Redraw the persistent input line in place with the new queued count,
        // keeping the Claude-style two-line layout intact (no scrolling spam).
        if (_servingSpinner && typeof _servingSpinner.showQueued === 'function') {
          _servingSpinner.showQueued(_inputQueue.length, _q);
        } else {
          process.stdout.write(colorize(C.dim, '  ⏎ queued (' + _inputQueue.length + ')\n'));
        }
      }
      return;
    }
    // ── Multi-line input accumulator ─────────────────────────
    if (_mlMode) {
      const trimmed = line.trimEnd();
      if (trimmed === _mlDelim || (_mlManual && trimmed === '')) {
        // End of multi-line block — submit accumulated buffer
        _mlMode   = false;
        _mlManual = false;
        const combined = _mlBuffer.join('\n').trim();
        _mlBuffer = [];
        _mlDelim  = '';
        if (!combined) { rl.prompt(); return; }
        // Fall through with combined as the effective input
        return void (async function processInput(input) {
          if (input.startsWith('/')) {
            // Slash commands are not meaningful inside a multi-line block,
            // so just treat the whole pasted block as a regular message.
          }
          syntaxRetryCount = 0;
          rl.pause();
          const messages = [
            { role: 'system', content: buildSystemPrompt() },
            ...history,
            { role: 'user', content: input },
          ];
          try {
            const sysPrompt = messages[0].content;
            const reply = await routedAgentLoop(messages, input);
            history.push({ role: 'user', content: input });
            history.push({ role: 'assistant', content: reply });
            lastAssistantReply = reply;
            logExchange(sysPrompt, input, reply);
            console.log(colorize(C.greenBold, '\nproverbs> ') + renderResponse(reply) + '\n');
            await showContextGauge(messages);
            if (showTokenCount) {
              const _tc = await countMessagesTokens(messages);
              const _tw = getContextWindow(model);
              console.log(colorize(C.dim, '  [~' + _tc.toLocaleString() + ' tokens used / ' + _tw.toLocaleString() + ' context]'));
            }
          } catch (err) {
            console.error(colorize(C.red, `\n✗  Error: ${err.message}\n`));
          }
          rl.resume();
          rl.prompt();
        }(combined));
      } else {
        _mlBuffer.push(line);
        process.stdout.write(colorize(C.dim, '... '));
        return;
      }
    }
    // Check if this line opens a multi-line block
    const _mlTrimmed = line.trim();
    if (_mlTrimmed === '```' || _mlTrimmed === '"""') {
      _mlMode   = true;
      _mlDelim  = _mlTrimmed;
      _mlBuffer = [];
      console.log(colorize(C.dim, '(multi-line — end with ' + _mlTrimmed + ')'));
      rl.prompt();
      return;
    }
    // ── End multi-line check ─────────────────────────────────

    let input = line.trim();

    // ── "proverbs <instruction>" — self-modification mode ──────────────────
    const _isSelfMod = /^proverbs\s+/i.test(input);
    if (_isSelfMod) {
      const instruction = input.slice(input.indexOf(' ')).trim();
      console.log(colorize(C.yellow, '\n  ⬡ Proverbs self-modification mode detected.\n'));
      const auth = await checkSelfModAuth();
      if (!auth) { rl.resume(); rl.prompt(); return; }
      // Re-route the prompt to target proverbs source
      input = 'You are modifying the Proverbs CLI itself. Source file: ' + path.join(PROVERBS_SRC_DIR, 'cli.js') + '. ' +
              'After making all changes to cli.js, run: node ' + path.join(PROVERBS_SRC_DIR, 'build.js') + ' to rebuild. ' +
              'Instruction: ' + instruction;
      _selfModUnlocked = true;
    }

    // ── File watcher notification ────────────────────────────
    if (_changedFiles.size > 0) {
      _changedFiles.clear();
    }

    if (!input) {
      rl.prompt();
      return;
    }

    // ── Slash commands ──────────────────────────────────────────────────────
    if (input.startsWith('/')) {
      const parts = input.slice(1).split(/\s+/);
      const cmd = parts[0].toLowerCase();

      switch (cmd) {
        case 'new': {
          await handleNewCommand(parts);
          break;
        }

        case 'exit':
          console.log(colorize(C.dim, '\nGoodbye.\n'));
          rl.close();
          process.exit(0);
          break;

        case 'clear':
          history = [];
          console.clear();
          printBanner();
          console.log(colorize(C.dim, '(conversation cleared)\n'));
          break;

        case 'help':
          printHelp();
          break;

        case 'model':
          if (parts[1]) {
            model = parts[1];
            console.log(colorize(C.green, `Model switched to: ${model}\n`));
            // Auto-enable thinking mode when switching to a thinking model
            if (modelSupportsThinking(model) && !thinkingEnabled) {
              thinkingEnabled = true;
              console.log(colorize(C.dim, '(thinking mode auto-enabled for ' + model + ')\n'));
            }
            saveConfig();
          } else {
            console.log(colorize(C.yellow, `Current model: ${model}\n`));
          }
          break;

        case 'cwd':
          if (parts[1]) {
            const newCwd = resolvePath(parts.slice(1).join(' '));
            if (fs.existsSync(newCwd) && fs.statSync(newCwd).isDirectory()) {
              stopFileWatcher();
              cwd = newCwd;
              console.log(colorize(C.green, `Working directory: ${cwd}\n`));
              // Re-index on cwd change
              try { runIndex(cwd, true); } catch (_) {}
              detectedFrameworks = detectFrameworks(cwd);
              detectedConventions = detectConventions(cwd);
              loadGitContext(cwd);
              sessionContextFiles = [];
              try { loadScriptFiles(cwd); } catch (_) {}
              try { loadProverbsProfile(cwd); } catch (_) {}
              startFileWatcher(cwd);
            } else {
              console.log(colorize(C.red, `Directory not found: ${newCwd}\n`));
            }
          } else {
            console.log(colorize(C.dim, `Current CWD: ${cwd}\n`));
          }
          break;

        case 'admin':
          handleAdmin(input.slice('/admin'.length).trim());
          break;

        case 'update': {
          rl.pause();
          console.log(colorize(C.dim, '\n  Checking for updates...\n'));
          try { var _upMsg = await selfUpdate(); console.log(colorize(C.green, '\n✔  ' + _upMsg + '\n')); }
          catch (_ue) { console.log(colorize(C.red, '\n✗  Update failed: ' + _ue.message + '\n')); }
          rl.resume();
          break;
        }

        case 'catalog':
        case 'models': {
          var _mSub = (parts[1] || '').toLowerCase();
          if (_mSub === 'download' && parts[2]) {
            rl.pause();
            try { await downloadModelFile(parts.slice(2).join(' ')); }
            catch (_de) { console.log(colorize(C.red, '\n✗  ' + _de.message + '\n')); }
            rl.resume();
          } else {
            var _mDir = path.join(os.homedir(), '.proverbs', 'models');
            var _mInst = [];
            try { _mInst = fs.readdirSync(_mDir).filter(function(f){ return f.endsWith('.gguf'); }); } catch(_) {}
            console.log(colorize(C.cyan, '\n  Model Catalog  (/models download <id>)\n'));
            MODEL_CATALOG.forEach(function(m) {
              var here = _mInst.some(function(f){ return f === m.file; });
              console.log('  ' + (here ? colorize(C.green,'●') : colorize(C.dim,'○')) + '  ' + colorize(C.bold, m.id.padEnd(24)) + m.size.padEnd(8) + colorize(C.dim, m.note));
            });
            console.log(colorize(C.dim, '\n  ● = installed in ~/.proverbs/models/\n'));
          }
          break;
        }

        case 'agents': {
          var _agTask = input.slice('/agents'.length).trim();
          if (!_agTask) { console.log(colorize(C.dim, '\n  Usage: /agents <task>\n  Spawns 3 parallel sub-agents, each with a different focus angle.\n')); break; }
          rl.pause();
          console.log(colorize(C.cyan, '\n  Spawning 3 parallel agents...\n'));
          var _agAngles = ['architecture, file structure, and entry points', 'business logic, core algorithms, and data flow', 'edge cases, error handling, and security vulnerabilities'];
          var _agBin = process.argv[1];
          var _agResults = await Promise.all(_agAngles.map(function(angle, idx) {
            return new Promise(function(resolve) {
              var subtask = _agTask + '\nFocus on: ' + angle + '.';
              console.log(colorize(C.dim, '    Agent ' + (idx+1) + ': ' + angle));
              require('child_process').execFile(process.execPath, [_agBin, '--headless', '--task', subtask], { cwd: cwd, timeout: 120000, maxBuffer: 4*1024*1024 }, function(err, stdout) {
                var m = (stdout||'').indexOf('--- PROVERBS RESULT ---');
                var e2 = (stdout||'').indexOf('--- END ---');
                if (m !== -1) resolve({ n: idx+1, text: stdout.slice(m+22, e2!==-1?e2:undefined).trim() });
                else resolve({ n: idx+1, text: err ? 'Error: '+err.message : (stdout||'').slice(0,400) });
              });
            });
          }));
          console.log(colorize(C.cyan, '\n══ Multi-Agent Results ══\n'));
          _agResults.forEach(function(r){ console.log(colorize(C.yellow,'▸ Agent '+r.n+'\n')); console.log(renderResponse(r.text)); console.log(); });
          rl.resume();
          break;
        }

        case 'autotest': {
          var _atArg = (parts[1]||'').toLowerCase();
          if (_atArg==='on')  { autoTestEnabled=true;  saveConfig(); console.log(colorize(C.green,'\n  Auto-test: ON — test files generated after every source write\n')); }
          else if (_atArg==='off') { autoTestEnabled=false; saveConfig(); console.log(colorize(C.dim,'\n  Auto-test: OFF\n')); }
          else console.log(colorize(autoTestEnabled?C.green:C.dim,'\n  Auto-test is '+(autoTestEnabled?'ON':'OFF')+'. Use /autotest on|off\n'));
          break;
        }

        case 'security': {
          rl.pause();
          console.log(colorize(C.yellow, '\n  Security audit — ' + cwd + '\n'));
          var _secFiles = [];
          try {
            var _secWalk = function(dir, depth) {
              if (depth>3) return;
              var _skip = new Set(['node_modules','.git','dist','.next','build','coverage']);
              fs.readdirSync(dir,{withFileTypes:true}).forEach(function(e) {
                if (_skip.has(e.name)) return;
                var full = path.join(dir,e.name);
                if (e.isDirectory()) _secWalk(full,depth+1);
                else if (['.js','.ts','.tsx','.jsx','.py','.env','.sh'].includes(path.extname(e.name))) _secFiles.push(full);
              });
            };
            _secWalk(cwd, 0);
          } catch(_) {}
          var _secSnippets = _secFiles.slice(0,12).map(function(f){
            try { return '// '+path.relative(cwd,f)+'\n'+fs.readFileSync(f,'utf8').slice(0,600); } catch(_){ return ''; }
          }).filter(Boolean).join('\n\n---\n\n').slice(0,10000);
          var _secQ = 'You are a security auditor. Scan this codebase for vulnerabilities.\nCheck: SQL injection, XSS, CSRF, hardcoded secrets, path traversal, command injection, missing auth, exposed admin routes, insecure cookies, missing rate limits.\nFor each finding: severity (CRITICAL/HIGH/MEDIUM/LOW), file, line pattern, and fix recommendation.\n\nCODEBASE:\n' + _secSnippets;
          try {
            var _secReply = await routedAgentLoop([{role:'system',content:'You are a security expert. Be specific and actionable.'},{role:'user',content:_secQ}], _secQ);
            console.log(colorize(C.cyan,'\n══ Security Audit ══\n'));
            console.log(renderResponse(_secReply));
            console.log();
          } catch(_se){ console.log(colorize(C.red,'\n✗  '+_se.message+'\n')); }
          rl.resume();
          break;
        }

        case 'perms':
        case 'permissions': {
          // View / set the user's own file-access policy (shared with the Python
          // server via ~/.proverbs/config.json → "permissions"). Open by default.
          var _pCfg = {};
          try { _pCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch(_) {}
          var _perm = _pCfg.permissions || {};
          var _pSub = (parts[1]||'').toLowerCase();
          var _pVal = parts.slice(2).join(' ').trim();
          function _savePerm() {
            _pCfg.permissions = _perm;
            try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(_pCfg, null, 2), 'utf8'); }
            catch(e){ console.log(colorize(C.red, '\n  Could not save: ' + e.message + '\n')); }
          }
          function _showPerm() {
            var mode = _perm.mode || 'open';
            console.log(colorize(C.cyanBold, '\n  Permission policy (you set your own access terms):'));
            console.log('    mode:   ' + colorize(C.cyan, mode) + (mode==='open' ? colorize(C.dim,'  (can edit anything not denied)') : colorize(C.dim,'  (only allowed dirs)')));
            console.log('    allow:  ' + colorize(C.cyan, (Array.isArray(_perm.allow)&&_perm.allow.length) ? _perm.allow.join(', ') : '(none — only used in scoped mode)'));
            console.log('    deny:   ' + colorize(C.cyan, ('deny' in _perm) ? ((_perm.deny&&_perm.deny.length)?_perm.deny.join(', '):'(none)') : '~/.ssh, ~/.aws, ~/.gnupg, /etc/shadow (defaults)'));
            console.log('    max write: ' + colorize(C.cyan, (_perm.max_write_mb || 200) + ' MB'));
            console.log(colorize(C.dim, '\n    /perms open                 — edit anywhere (default)'));
            console.log(colorize(C.dim, '    /perms scoped               — only allowed dirs'));
            console.log(colorize(C.dim, '    /perms allow <path>         — add an allowed dir (scoped mode)'));
            console.log(colorize(C.dim, '    /perms deny <path>          — block a path'));
            console.log(colorize(C.dim, '    /perms undeny <path>        — unblock a path'));
            console.log(colorize(C.dim, '    /perms opendeny             — clear ALL deny rules (full open)\n'));
          }
          if (_pSub === 'open')        { _perm.mode='open'; _savePerm(); console.log(colorize(C.green,'\n  Permission mode: OPEN — Proverbs can edit anything not in your deny-list.\n')); }
          else if (_pSub === 'scoped') { _perm.mode='scoped'; _savePerm(); console.log(colorize(C.yellow,'\n  Permission mode: SCOPED — only directories in your allow-list.\n')); }
          else if (_pSub === 'allow' && _pVal)   { _perm.allow=Array.isArray(_perm.allow)?_perm.allow:[]; if(_perm.allow.indexOf(_pVal)<0)_perm.allow.push(_pVal); _savePerm(); console.log(colorize(C.green,'\n  Allowed: '+_pVal+'\n')); }
          else if (_pSub === 'deny' && _pVal)    { _perm.deny=('deny' in _perm)?(_perm.deny||[]):['~/.ssh','~/.aws','~/.gnupg','/etc/shadow']; if(_perm.deny.indexOf(_pVal)<0)_perm.deny.push(_pVal); _savePerm(); console.log(colorize(C.yellow,'\n  Denied: '+_pVal+'\n')); }
          else if (_pSub === 'undeny' && _pVal)  { if(Array.isArray(_perm.deny)) _perm.deny=_perm.deny.filter(function(d){return d!==_pVal;}); _savePerm(); console.log(colorize(C.green,'\n  Un-denied: '+_pVal+'\n')); }
          else if (_pSub === 'opendeny')         { _perm.deny=[]; _savePerm(); console.log(colorize(C.yellow,'\n  All deny rules cleared — fully open. Proverbs can now write any path the OS permits (including secrets).\n')); }
          else _showPerm();
          break;
        }

        case 'sandbox': {
          var _sbArg = (parts[1]||'').toLowerCase();
          if (_sbArg==='on')  { sandboxEnabled=true;  console.log(colorize(C.yellow,'\n  Sandbox: ON — destructive commands blocked\n')); }
          else if (_sbArg==='off') { sandboxEnabled=false; console.log(colorize(C.green,'\n  Sandbox: OFF\n')); }
          else console.log(colorize(sandboxEnabled?C.yellow:C.dim,'\n  Sandbox is '+(sandboxEnabled?'ON':'OFF')+'. Use /sandbox on|off\n'));
          break;
        }

        case 'limits': {
          // Master control panel — view and toggle every constraint in one place
          var _limArg = (parts[1]||'').toLowerCase();

          function _limStatus() {
            const on  = (v) => colorize('ON',  C.green);
            const off = (v) => colorize('OFF', C.dim);
            const val = (v, unit) => colorize(v + (unit||''), C.cyan);
            console.log(colorize('\n  Proverbs Limits & Constraints\n', C.cyan));
            console.log('  sandbox         ' + (sandboxEnabled      ? on()  : off())  + colorize('  — block destructive bash (rm -rf /, mkfs…)', C.dim));
            console.log('  truncation      ' + (_truncationEnabled  ? on()  : off())  + colorize('  — cap tool output at ' + MAX_TOOL_OUTPUT_CHARS + ' chars', C.dim));
            console.log('  critique        ' + (critiqueEnabled     ? on()  : off())  + colorize('  — self-review every response', C.dim));
            console.log('  cot             ' + (cotEnabled          ? on()  : off())  + colorize('  — chain-of-thought reasoning', C.dim));
            console.log('  thinking        ' + (thinkingEnabled     ? on()  : off())  + colorize('  — inject <think> seed tag', C.dim));
            console.log('  planning        ' + (planningEnabled     ? on()  : off())  + colorize('  — multi-file edit planner', C.dim));
            console.log('  tscheck         ' + (tsCheckEnabled      ? on()  : off())  + colorize('  — run tsc after every file write', C.dim));
            console.log('  autotest        ' + (autoTestEnabled     ? on()  : off())  + colorize('  — generate tests after source writes', C.dim));
            console.log('  compress        ' + (contextBudget > 0   ? val(contextBudget,' tok') : off()) + colorize('  — auto-compress history above N tokens', C.dim));
            console.log('  multiAttempt    ' + (multiAttemptEnabled  ? on() : off())  + colorize('  — retry tool calls on error (max ' + MULTI_ATTEMPT_MAX + '×)', C.dim));
            console.log('  maxsteps        ' + val(MAX_AGENT_STEPS)   + colorize('  — max tool rounds/turn before bailing (anti-stuck)', C.dim));
            console.log('  turntimeout     ' + val(Math.round(MAX_TURN_MS/1000),'s') + colorize('  — per-turn time budget before bailing', C.dim));
            console.log('');
            console.log(colorize('  /limits off          — unleash everything (no sandbox, no truncation, full output)', C.yellow));
            console.log(colorize('  /limits on           — restore safe defaults', C.dim));
            console.log(colorize('  /limits <name> on|off — toggle one constraint', C.dim));
            console.log(colorize('  /limits truncation <N> — set output cap to N chars', C.dim));
            console.log('');
          }

          if (!_limArg || _limArg === 'status') {
            _limStatus();
          } else if (_limArg === 'off') {
            // Unleash mode — remove all caps and blockers
            sandboxEnabled      = false;
            _truncationEnabled  = false;
            critiqueEnabled     = false;
            cotEnabled          = true;
            thinkingEnabled     = true;
            planningEnabled     = true;
            tsCheckEnabled      = false;
            autoTestEnabled     = false;
            contextBudget       = 0;
            multiAttemptEnabled = true;
            MAX_TOOL_OUTPUT_CHARS = 999999;
            // Raise — but never remove — the anti-stuck guards. An unbounded loop
            // would still crash, so we keep a very high ceiling instead of none.
            MAX_AGENT_STEPS     = 200;
            MAX_TURN_MS         = 1800000; // 30 min
            saveConfig();
            console.log(colorize('\n  UNLEASHED — all limits off. Full output, no sandbox, no truncation.\n  (Anti-stuck guards raised to 200 steps / 30 min, not removed — prevents infinite-loop crashes.)\n  Use /limits on to restore safe defaults.\n', C.yellow));
          } else if (_limArg === 'on') {
            // Restore safe defaults
            sandboxEnabled      = false;
            _truncationEnabled  = true;
            critiqueEnabled     = true;
            cotEnabled          = true;
            thinkingEnabled     = true;
            planningEnabled     = true;
            tsCheckEnabled      = true;
            autoTestEnabled     = false;
            contextBudget       = 0;
            multiAttemptEnabled = true;
            MAX_TOOL_OUTPUT_CHARS = 16000;
            MAX_AGENT_STEPS     = 40;
            MAX_TURN_MS         = 240000;
            saveConfig();
            console.log(colorize('\n  Limits restored to safe defaults.\n', C.green));
          } else {
            // Toggle individual constraint: /limits <name> on|off|<value>
            var _limName = _limArg;
            var _limVal  = (parts[2]||'').toLowerCase();
            var _limOn   = _limVal === 'on';
            var _limOff  = _limVal === 'off';
            if (_limName === 'sandbox')      { if (_limOn||_limOff) { sandboxEnabled=_limOn; saveConfig(); console.log(colorize('\n  sandbox: '+(_limOn?'ON':'OFF')+'\n', _limOn?C.yellow:C.dim)); } else _limStatus(); }
            else if (_limName === 'truncation') {
              if (_limOn||_limOff)           { _truncationEnabled=_limOn; saveConfig(); console.log(colorize('\n  truncation: '+(_limOn?'ON':'OFF')+'\n', _limOn?C.green:C.dim)); }
              else if (_limVal && !isNaN(parseInt(_limVal))) { MAX_TOOL_OUTPUT_CHARS=parseInt(_limVal); saveConfig(); console.log(colorize('\n  truncation cap: '+MAX_TOOL_OUTPUT_CHARS+' chars\n', C.green)); }
              else _limStatus();
            }
            else if (_limName === 'critique')    { if (_limOn||_limOff) { critiqueEnabled=_limOn;     saveConfig(); console.log(colorize('\n  critique: '+(_limOn?'ON':'OFF')+'\n', _limOn?C.green:C.dim)); } else _limStatus(); }
            else if (_limName === 'cot')         { if (_limOn||_limOff) { cotEnabled=_limOn;           saveConfig(); console.log(colorize('\n  cot: '+(_limOn?'ON':'OFF')+'\n', _limOn?C.green:C.dim)); } else _limStatus(); }
            else if (_limName === 'thinking')    { if (_limOn||_limOff) { thinkingEnabled=_limOn;      saveConfig(); console.log(colorize('\n  thinking: '+(_limOn?'ON':'OFF')+'\n', _limOn?C.green:C.dim)); } else _limStatus(); }
            else if (_limName === 'planning')    { if (_limOn||_limOff) { planningEnabled=_limOn;      saveConfig(); console.log(colorize('\n  planning: '+(_limOn?'ON':'OFF')+'\n', _limOn?C.green:C.dim)); } else _limStatus(); }
            else if (_limName === 'tscheck')     { if (_limOn||_limOff) { tsCheckEnabled=_limOn;       saveConfig(); console.log(colorize('\n  tscheck: '+(_limOn?'ON':'OFF')+'\n', _limOn?C.green:C.dim)); } else _limStatus(); }
            else if (_limName === 'autotest')    { if (_limOn||_limOff) { autoTestEnabled=_limOn;      saveConfig(); console.log(colorize('\n  autotest: '+(_limOn?'ON':'OFF')+'\n', _limOn?C.green:C.dim)); } else _limStatus(); }
            else if (_limName === 'multiattempt'){ if (_limOn||_limOff) { multiAttemptEnabled=_limOn;  saveConfig(); console.log(colorize('\n  multiAttempt: '+(_limOn?'ON':'OFF')+'\n', _limOn?C.green:C.dim)); } else _limStatus(); }
            else if (_limName === 'compress')    {
              if (_limVal === '0' || _limOff) { contextBudget=0; console.log(colorize('\n  compress: OFF\n', C.dim)); }
              else if (!isNaN(parseInt(_limVal))) { contextBudget=parseInt(_limVal); console.log(colorize('\n  compress: '+contextBudget+' tokens\n', C.green)); }
              else _limStatus();
            }
            else if (_limName === 'maxsteps')    {
              if (!isNaN(parseInt(_limVal)) && parseInt(_limVal) >= 1) { MAX_AGENT_STEPS=parseInt(_limVal); saveConfig(); console.log(colorize('\n  maxsteps: '+MAX_AGENT_STEPS+' tool rounds/turn\n', C.green)); }
              else console.log(colorize('\n  Usage: /limits maxsteps <N>   (current: '+MAX_AGENT_STEPS+')\n', C.yellow));
            }
            else if (_limName === 'turntimeout'){
              if (!isNaN(parseInt(_limVal)) && parseInt(_limVal) >= 5) { MAX_TURN_MS=parseInt(_limVal)*1000; saveConfig(); console.log(colorize('\n  turntimeout: '+parseInt(_limVal)+'s\n', C.green)); }
              else console.log(colorize('\n  Usage: /limits turntimeout <seconds>   (current: '+Math.round(MAX_TURN_MS/1000)+'s)\n', C.yellow));
            }
            else { console.log(colorize('\n  Unknown limit: ' + _limName + '\n  Options: sandbox, truncation, critique, cot, thinking, planning, tscheck, autotest, multiattempt, compress, maxsteps, turntimeout\n', C.yellow)); }
          }
          break;
        }

        case 'train': {
          const _trSub  = (parts[1] || 'status').toLowerCase();
          const _trVenv = _venvPython();
          const _trRoot = path.join(__dirname.replace('/dist',''), '');
          const _trCkpt = require('path').join(require('os').homedir(), '.proverbs', 'checkpoints', 'local', 'best.pt');
          if (_trSub === 'status') {
            const exists = fs.existsSync(_trCkpt);
            console.log(colorize(C.cyan, '\n  ProverbsLM Training Status\n'));
            console.log('  Checkpoint : ' + (exists ? colorize(C.green, '● ' + _trCkpt) : colorize(C.red, '○ none yet')));
            if (exists) {
              try {
                const st = fs.statSync(_trCkpt);
                console.log('  Updated    : ' + new Date(st.mtimeMs).toLocaleString());
                console.log('  Size       : ' + (st.size / 1e6).toFixed(1) + ' MB');
              } catch(_) {}
            }
            console.log(colorize(C.dim, '\n  /train local          — Train nano (15M) model on your sessions (~1-2h CPU)'));
            console.log(colorize(C.dim, '  /train data           — Download CodeSearchNet code pre-training data (~500MB)'));
            console.log(colorize(C.dim, '  /train pretrain       — Pre-train small (58M) model on code data (needs GPU)'));
            console.log(colorize(C.dim, '  /train export         — Export trained .pt → .gguf for faster inference\n'));
          } else if (_trSub === 'local') {
            rl.pause();
            console.log(colorize(C.cyan, '\n  Starting local training (nano model, CPU)...\n'));
            console.log(colorize(C.dim, '  This runs in the background. Logs: ~/.proverbs/training.log\n'));
            const trainLog = require('path').join(require('os').homedir(), '.proverbs', 'training.log');
            const trainProc = require('child_process').spawn(
              _trVenv, ['-m', 'training.train', '--mode', 'local', '--size', 'nano'],
              { cwd: _trRoot, detached: true, stdio: ['ignore', require('fs').openSync(trainLog, 'a'), require('fs').openSync(trainLog, 'a')] }
            );
            trainProc.unref();
            fs.writeFileSync(require('path').join(require('os').homedir(), '.proverbs', 'train.pid'), String(trainProc.pid), 'utf8');
            console.log(colorize(C.green, '  ✔  Training started (pid ' + trainProc.pid + ')'));
            console.log(colorize(C.dim, '  Monitor: tail -f ~/.proverbs/training.log'));
            console.log(colorize(C.dim, '  Check:   /train status\n'));
            rl.resume();
          } else if (_trSub === 'data') {
            rl.pause();
            console.log(colorize(C.cyan, '\n  Downloading CodeSearchNet pre-training data...\n'));
            const dataProc = require('child_process').spawn(
              _trVenv, ['scripts/download_pretrain_data.py', '--langs', 'python', 'javascript', 'typescript', '--max-per-lang', '50000'],
              { cwd: _trRoot, stdio: 'inherit' }
            );
            dataProc.on('close', (code) => {
              if (code === 0) console.log(colorize(C.green, '\n  ✔  Data downloaded to ~/.proverbs/pretrain_data/\n'));
              else console.log(colorize(C.red, '\n  ✗  Download failed (exit ' + code + ')\n'));
              rl.resume(); rl.prompt();
            });
            return;
          } else if (_trSub === 'export') {
            rl.pause();
            if (!fs.existsSync(_trCkpt)) {
              console.log(colorize(C.red, '\n  ✗  No checkpoint found. Run /train local first.\n'));
            } else {
              console.log(colorize(C.cyan, '\n  Exporting ' + _trCkpt + ' → GGUF...\n'));
              const expProc = require('child_process').spawnSync(
                _trVenv, ['scripts/export_gguf.py', '--checkpoint', _trCkpt],
                { cwd: _trRoot, stdio: 'inherit' }
              );
              if (expProc.status === 0) console.log(colorize(C.green, '\n  ✔  GGUF exported. Restart server to use it.\n'));
              else console.log(colorize(C.red, '\n  ✗  Export failed.\n'));
            }
            rl.resume();
          } else if (_trSub === 'tokenizer') {
            rl.pause();
            const _trTokOut = require('path').join(require('os').homedir(), '.proverbs', 'tokenizer.json');
            console.log(colorize(C.cyan, '\n  Training BPE tokenizer on your codebase + sessions...\n'));
            const _trVenvLocal = path.join(__dirname.replace('/dist',''), 'venv_llm', 'bin', 'python3');
            const _tokProc = require('child_process').spawn(
              _trVenvLocal,
              ['-m', 'tokenizer.train_tokenizer',
               '--data-dir', require('path').join(require('os').homedir(), '.proverbs', 'sessions'),
               '--extra-data', cwd,
               '--output', _trTokOut,
               '--vocab-size', '32000'],
              { cwd: _trRoot, stdio: 'inherit' }
            );
            _tokProc.on('close', (code) => {
              if (code === 0) console.log(colorize(C.green, '\n  ✔  Tokenizer saved to ' + _trTokOut + '\n'));
              else console.log(colorize(C.red, '\n  ✗  Tokenizer training failed (exit ' + code + ')\n'));
              rl.resume(); rl.prompt();
            });
            return;
          } else if (_trSub === 'embed') {
            rl.pause();
            if (!fs.existsSync(_trCkpt)) {
              console.log(colorize(C.red, '\n  ✗  No checkpoint. Run /train local first.\n'));
              rl.resume();
            } else {
              const _trTokJson = require('path').join(require('os').homedir(), '.proverbs', 'tokenizer.json');
              const _embedOut  = require('path').join(require('os').homedir(), '.proverbs', 'embed_head.pt');
              console.log(colorize(C.cyan, '\n  Training local embedding head (SimCSE)...\n'));
              const _trVenvLocal = path.join(__dirname.replace('/dist',''), 'venv_llm', 'bin', 'python3');
              const _embProc = require('child_process').spawn(
                _trVenvLocal,
                ['-m', 'scripts.train_embedder',
                 '--checkpoint', _trCkpt,
                 '--tokenizer', _trTokJson,
                 '--data-dir', cwd,
                 '--output', _embedOut,
                 '--epochs', '3'],
                { cwd: _trRoot, stdio: 'inherit' }
              );
              _embProc.on('close', (code) => {
                if (code === 0) console.log(colorize(C.green, '\n  ✔  Embed head saved to ' + _embedOut + '\n'));
                else console.log(colorize(C.red, '\n  ✗  Embedding training failed (exit ' + code + ')\n'));
                rl.resume(); rl.prompt();
              });
              return;
            }
          } else if (_trSub === 'prune') {
            rl.pause();
            if (!fs.existsSync(_trCkpt)) {
              console.log(colorize(C.red, '\n  ✗  No checkpoint. Run /train local first.\n'));
              rl.resume();
            } else {
              const sparsity = parts[2] || '0.25';
              console.log(colorize(C.cyan, `\n  Pruning model (sparsity ${sparsity})...\n`));
              const _trVenvLocal = path.join(__dirname.replace('/dist',''), 'venv_llm', 'bin', 'python3');
              const _pruneProc = require('child_process').spawn(
                _trVenvLocal,
                ['-m', 'scripts.prune', '--checkpoint', _trCkpt, '--sparsity', sparsity],
                { cwd: _trRoot, stdio: 'inherit' }
              );
              _pruneProc.on('close', (code) => {
                if (code === 0) console.log(colorize(C.green, '\n  ✔  Pruned checkpoint saved.\n'));
                else console.log(colorize(C.red, '\n  ✗  Pruning failed (exit ' + code + ')\n'));
                rl.resume(); rl.prompt();
              });
              return;
            }
          } else {
            console.log(colorize(C.red, '\n  Unknown train subcommand: ' + parts[1] + '\n  Use: /train status | local | data | pretrain | export | tokenizer | embed | prune\n'));
          }
          break;
        }

        case 'backend': {
          const bSub = (parts[1] || '').toLowerCase();
          if (!bSub || bSub === 'status') {
            console.log(colorize(C.cyan, `\nActive backend: ${activeBackendName} (${OLLAMA_BASE}, format: ${activeApiFormat})\n`));
            console.log(colorize(C.dim, 'Probing all backends...\n'));
            for (const b of BACKEND_CANDIDATES) {
              const ok = await probeBackend(b);
              const dot = ok ? colorize(C.green, '●') : colorize(C.red, '○');
              const active = b.base === OLLAMA_BASE ? colorize(C.yellow, ' ◀ active') : '';
              console.log(`  ${dot}  ${b.name.padEnd(12)} ${b.base}${active}`);
            }
            console.log();
          } else if (bSub === 'auto') {
            // First try known backends, then scan LAN for Proverbs XPS server
            let found = await detectBackend(false);
            if (found) {
              console.log(colorize(C.green, `\n✔  Switched to ${activeBackendName} (${OLLAMA_BASE})\n`));
            } else {
              console.log(colorize(C.dim, '\n  No local backend found — scanning LAN for Proverbs XPS server...\n'));
              found = await _scanLanForProverbs();
              if (!found) {
                console.log(colorize(C.red, '\n✗  No backend found on local network.\n'));
                console.log(colorize(C.dim, '  Start local server: /server start'));
                console.log(colorize(C.dim, '  Connect to XPS:     /backend http://<xps-ip>:11435\n'));
              }
            }
          } else if (bSub === 'scan') {
            // Explicit LAN scan
            console.log(colorize(C.dim, '\n  Scanning local network for Proverbs inference servers...\n'));
            const scanFound = await _scanLanForProverbs(true);
            if (!scanFound) console.log(colorize(C.yellow, '\n  No Proverbs servers found on LAN.\n'));
          } else if (parts[1] && (parts[1].startsWith('http://') || parts[1].startsWith('https://'))) {
            // Direct URL — probe it then switch
            const url = parts[1].replace(/\/$/, '');
            console.log(colorize(C.dim, `\n  Probing ${url} ...`));
            try {
              const r = await httpGet(url + '/api/tags', 5000);
              if (r.status === 200) {
                OLLAMA_BASE       = url;
                activeApiFormat   = 'ollama';
                activeBackendName = 'Proverbs XPS';
                const xpsCfg = loadRoutingConfig ? (loadRoutingConfig(), {}) : {};
                // Persist the XPS URL so it survives restarts
                const _rc = require('path').join(PROVERBS_DIR, 'routing.json');
                try {
                  const _rd = fs.existsSync(_rc) ? JSON.parse(fs.readFileSync(_rc,'utf8')) : {};
                  _rd.xpsUrl = url;
                  fs.writeFileSync(_rc, JSON.stringify(_rd, null, 2));
                } catch(_) {}
                console.log(colorize(C.green, `\n✔  Connected to ${url}\n`));
              } else {
                console.log(colorize(C.red, `\n✗  Server responded with status ${r.status}\n`));
              }
            } catch (e) {
              console.log(colorize(C.red, `\n✗  Could not reach ${url}: ${e.message}\n`));
            }
          } else {
            const target = BACKEND_CANDIDATES.find(b => b.name.toLowerCase().replace(/\s/g, '-') === bSub || b.name.toLowerCase() === bSub);
            if (target) {
              OLLAMA_BASE       = target.base;
              activeApiFormat   = target.api;
              activeBackendName = target.name;
              console.log(colorize(C.green, `\n✔  Backend forced to ${activeBackendName} (${OLLAMA_BASE})\n`));
            } else {
              console.log(colorize(C.red, `\n✗  Unknown backend: "${parts[1]}"\n`));
              console.log(colorize(C.dim, '  Options: auto | scan | llamafile | proverbs-server | http://<ip>:<port>\n'));
            }
          }
          break;
        }

        case 'confirmswitch': {
          const _v = (parts[1] || '').toLowerCase();
          if (_v === 'off' || _v === 'no' || _v === 'false') {
            _backendSwitchConfirm = false;
            console.log(colorize(C.yellow, '\n  Backend-switch confirmation OFF — the model can change silently.\n'));
          } else if (_v === 'on' || _v === 'yes' || _v === 'true') {
            _backendSwitchConfirm = true;
            console.log(colorize(C.green, '\n  Backend-switch confirmation ON — you will confirm before the model changes.\n'));
          } else {
            console.log(colorize(C.cyan, '\n  Backend-switch confirmation is ' + (_backendSwitchConfirm ? colorize(C.green, 'ON') : colorize(C.yellow, 'OFF')) + colorize(C.cyan, '.')));
            console.log(colorize(C.dim, '  Usage: /confirmswitch on | off\n'));
          }
          rl.prompt();
          break;
        }

        case 'cloud': {
          const _cSub = (parts[1] || 'status').toLowerCase();
          if (_cSub === 'status' || _cSub === 'cloud') {
            // Show current cloud config
            rl.pause();
            try {
              const _bkRes = await httpGet(OLLAMA_BASE + '/api/backend', 5000);
              if (_bkRes.status === 200) {
                const _bk = JSON.parse(_bkRes.body);
                console.log(colorize(C.cyan, '\n  Cloud / Cascade Status\n'));
                console.log('  Backend  : ' + (_bk.backend === 'claude' ? colorize(C.green, 'Claude API') : colorize(C.yellow, 'Local GGUF')));
                console.log('  Online   : ' + (_bk.online ? colorize(C.green, 'yes') : colorize(C.red, 'no')));
                console.log('  API key  : ' + (_bk.keyConfigured ? colorize(C.green, 'configured') : colorize(C.red, 'not set  — /cloud key sk-ant-...')));
                console.log('  Cloud model : ' + _bk.cloudModel);
                console.log('  Mode     : ' + _bk.cloudMode + '  (auto | force-cloud | force-local)');
                if (_bk.autoTier && _bk.tiers) {
                  console.log('  Auto-tier: ' + colorize(C.green, 'on') +
                    colorize(C.dim, `  (${_bk.tiers.cheap} → ${_bk.tiers.mid} → ${_bk.tiers.deep})`));
                } else {
                  console.log('  Auto-tier: ' + colorize(C.yellow, 'off') + colorize(C.dim, '  (pinned to ' + _bk.cloudModel + ')'));
                }
                console.log('  Local    : ' + (_bk.localModels.join(', ') || '(none)') + '\n');
                if (_bk.spend && _bk.spend.calls) {
                  const _s = _bk.spend;
                  console.log(colorize(C.cyan, '  Spend this session'));
                  console.log('  Calls    : ' + _s.calls);
                  console.log('  Cost     : $' + Number(_s.usd).toFixed(4));
                  if (_s.cacheRead) console.log('  Cached   : ' + colorize(C.green, _s.cacheRead.toLocaleString() + ' tokens read at 10% price'));
                  console.log('');
                }
                console.log(colorize(C.dim, '  Commands:'));
                console.log(colorize(C.dim, '  /cloud key sk-ant-...         set Anthropic API key'));
                console.log(colorize(C.dim, '  /cloud model haiku|sonnet|opus  pin one model'));
                console.log(colorize(C.dim, '  /cloud auto on|off            auto-pick model per task'));
                console.log(colorize(C.dim, '  /cloud cost                   show session spend'));
                console.log(colorize(C.dim, '  /cloud mode auto|cloud|local  force routing mode'));
                console.log(colorize(C.dim, '  /cloud test                   send a test message\n'));
              } else {
                console.log(colorize(C.red, '\n  Server did not respond — is it running?\n'));
              }
            } catch (_ce) {
              console.log(colorize(C.red, '\n  Could not reach inference server: ' + _ce.message + '\n'));
            }
            rl.resume();
          } else if (_cSub === 'key' && parts[2]) {
            const _key = parts[2].trim();
            if (!_key.startsWith('sk-ant-')) {
              console.log(colorize(C.red, '\n  Key should start with sk-ant-  (get one at https://console.anthropic.com/settings/keys)\n'));
            } else {
              rl.pause();
              try {
                await httpPost(OLLAMA_BASE + '/api/config', { anthropicApiKey: _key });
                console.log(colorize(C.green, '\n  ✓  API key saved. Proverbs will now use Claude as the primary backend.\n'));
                console.log(colorize(C.dim, '  Current cloud model: ' + cloudModel + '\n'));
                console.log(colorize(C.dim, '  To change model: /cloud model sonnet\n'));
              } catch (_ke) {
                console.log(colorize(C.red, '\n  Failed to save key: ' + _ke.message + '\n'));
              }
              rl.resume();
            }
          } else if (_cSub === 'model' && parts[2]) {
            const _mAlias = parts[2].toLowerCase();
            const _mMap = {
              'haiku':   'claude-haiku-4-5',
              'sonnet':  'claude-sonnet-5',
              'opus':    'claude-opus-5',
            };
            const _mFull = _mMap[_mAlias] || parts[2];
            cloudModel = _mFull;
            rl.pause();
            try {
              // Pinning a model implies auto-tiering off, or the pin is ignored.
              await httpPost(OLLAMA_BASE + '/api/config', { cloudModel: _mFull, autoTier: false });
              saveConfig();
              console.log(colorize(C.green, '\n  ✓  Cloud model pinned to: ' + _mFull));
              console.log(colorize(C.dim, '     Auto-tiering off. Re-enable with /cloud auto on\n'));
            } catch (_mce) { saveConfig(); console.log(colorize(C.green, '\n  Cloud model: ' + _mFull + ' (will apply on next request)\n')); }
            rl.resume();
          } else if (_cSub === 'auto') {
            const _on = !parts[2] || ['on','yes','true','1'].includes(parts[2].toLowerCase());
            rl.pause();
            try {
              await httpPost(OLLAMA_BASE + '/api/config', { autoTier: _on });
              if (_on) {
                console.log(colorize(C.green, '\n  ✓  Auto-tiering on'));
                console.log(colorize(C.dim, '     Simple edits → haiku, normal coding → sonnet, architecture/refactors → opus\n'));
              } else {
                console.log(colorize(C.yellow, '\n  Auto-tiering off — every request uses the pinned model.\n'));
              }
            } catch (_ae) {
              console.log(colorize(C.red, '\n  Could not reach server: ' + _ae.message + '\n'));
            }
            rl.resume();
          } else if (_cSub === 'cost' || _cSub === 'spend') {
            rl.pause();
            try {
              const _r = await httpGet(OLLAMA_BASE + '/api/backend', 5000);
              const _b = JSON.parse(_r.body);
              const _s = _b.spend || {};
              if (!_s.calls) {
                console.log(colorize(C.dim, '\n  No cloud calls yet this session.\n'));
              } else {
                const _cached = _s.cacheRead || 0;
                const _billed = (_s.input || 0) + _cached + (_s.cacheWrite || 0);
                const _pct = _billed ? Math.round(_cached / _billed * 100) : 0;
                console.log(colorize(C.cyan, '\n  Session spend\n'));
                console.log('  Calls        : ' + _s.calls);
                console.log('  Input tokens : ' + (_s.input || 0).toLocaleString());
                console.log('  Output tokens: ' + (_s.output || 0).toLocaleString());
                console.log('  Cache writes : ' + (_s.cacheWrite || 0).toLocaleString() + colorize(C.dim, '  (1.25x input price)'));
                console.log('  Cache reads  : ' + colorize(C.green, _cached.toLocaleString()) + colorize(C.dim, '  (0.1x input price)'));
                console.log('  Total cost   : ' + colorize(C.greenBold, '$' + Number(_s.usd || 0).toFixed(4)));
                if (_cached) console.log(colorize(C.dim, `  ${_pct}% of prompt tokens served from cache at a 90% discount.`));
                console.log('');
              }
            } catch (_se) {
              console.log(colorize(C.red, '\n  Could not reach server: ' + _se.message + '\n'));
            }
            rl.resume();
          } else if (_cSub === 'mode' && parts[2]) {
            const _modeMap = { 'auto': 'auto', 'cloud': 'force-cloud', 'local': 'force-local', 'force-cloud': 'force-cloud', 'force-local': 'force-local' };
            const _newMode = _modeMap[parts[2].toLowerCase()];
            if (!_newMode) {
              console.log(colorize(C.red, '\n  Unknown mode. Use: auto | cloud | local\n'));
            } else {
              cloudMode = _newMode;
              rl.pause();
              try {
                await httpPost(OLLAMA_BASE + '/api/config', { cloudMode: _newMode });
                saveConfig();
                console.log(colorize(C.green, '\n  ✓  Routing mode: ' + _newMode + '\n'));
              } catch (_) { saveConfig(); console.log(colorize(C.green, '\n  Mode: ' + _newMode + ' (will apply on next request)\n')); }
              rl.resume();
            }
          } else if (_cSub === 'test') {
            rl.pause();
            console.log(colorize(C.dim, '\n  Sending test message...\n'));
            try {
              const _testMsg = [
                { role: 'system', content: 'You are a helpful assistant.' },
                { role: 'user', content: 'Reply with exactly: "Proverbs cloud is working."' },
              ];
              const _bkRes2  = await httpGet(OLLAMA_BASE + '/api/backend', 3000);
              const _bk      = JSON.parse(_bkRes2.body);
              if (!_bk.keyConfigured) throw new Error('No API key — run /cloud key sk-ant-...');
              const _d = await httpPost(OLLAMA_BASE + '/api/chat', { model: model, messages: _testMsg, stream: false });
              console.log(colorize(C.green, '  ✓  ' + (_d.message?.content || '(empty response)') + '\n'));
              console.log(colorize(C.dim, '  Backend used: ' + (_d.model || 'unknown') + '\n'));
            } catch (_te) {
              console.log(colorize(C.red, '\n  Test failed: ' + _te.message + '\n'));
            }
            rl.resume();
          } else {
            console.log(colorize(C.cyan, '\n  /cloud status                 show current backend status'));
            console.log('  /cloud key sk-ant-...         set your Anthropic API key');
            console.log('  /cloud model haiku|sonnet|opus  pin one model (turns auto-tier off)');
            console.log('  /cloud auto on|off            auto-pick the cheapest model that fits');
            console.log('  /cloud cost                   show session spend + cache savings');
            console.log('  /cloud mode auto|cloud|local  force routing (default: auto)');
            console.log('  /cloud test                   verify cloud backend works\n');
          }
          break;
        }

        case 'server': {
          const sSub = (parts[1] || 'status').toLowerCase();
          const serverScript = PROVERBS_SERVER_SCRIPT;
          const pidFile = require('path').join(require('os').homedir(), '.proverbs', 'server.pid');
          if (sSub === 'start') {
            if (require('fs').existsSync(pidFile)) {
              try {
                const pid = parseInt(require('fs').readFileSync(pidFile,'utf8').trim(), 10);
                process.kill(pid, 0);
                console.log(colorize(C.yellow, `\n  Proverbs Server already running (pid ${pid})\n`));
                break;
              } catch (_) { require('fs').unlinkSync(pidFile); }
            }
            const port = parts[2] || '11435';
            const child = require('child_process').spawn(process.execPath, [serverScript, '--port', port], { detached: true, stdio: 'ignore' });
            child.unref();
            require('fs').writeFileSync(pidFile, String(child.pid), 'utf8');
            console.log(colorize(C.green, `\n✔  Proverbs Server started (pid ${child.pid}, port ${port})\n`));
            console.log(colorize(C.dim, `   Use /backend auto to connect — or: /backend proverbs-server\n`));
          } else if (sSub === 'stop') {
            try {
              const pid = parseInt(require('fs').readFileSync(pidFile,'utf8').trim(), 10);
              process.kill(pid, 'SIGTERM');
              require('fs').unlinkSync(pidFile);
              console.log(colorize(C.green, `\n✔  Proverbs Server stopped (pid ${pid})\n`));
            } catch (_) { console.log(colorize(C.dim, '\n  Server is not running.\n')); }
          } else if (sSub === 'models') {
            const modelsDir = require('path').join(require('os').homedir(), '.proverbs', 'models');
            let files = [];
            try { files = require('fs').readdirSync(modelsDir).filter(f => f.endsWith('.gguf')); } catch (_) {}
            if (files.length === 0) {
              console.log(colorize(C.yellow, `\n  No .gguf models in ${modelsDir}\n`));
              console.log(colorize(C.dim, '  Download one with:'));
              console.log(colorize(C.dim, '  huggingface-cli download bartowski/Qwen2.5-Coder-7B-Instruct-GGUF --include "*Q4_K_M*" --local-dir ' + modelsDir + '\n'));
            } else {
              console.log(colorize(C.cyan, `\n  Models in ${modelsDir}:\n`));
              files.forEach(f => {
                const sz = (require('fs').statSync(require('path').join(modelsDir, f)).size / 1e9).toFixed(1);
                console.log(`    - ${f.replace('.gguf','')}  (${sz} GB)`);
              });
              console.log();
            }
          } else {
            // status
            let running = false, pid = null;
            try {
              pid = parseInt(require('fs').readFileSync(pidFile,'utf8').trim(), 10);
              process.kill(pid, 0);
              running = true;
            } catch (_) {}
            const dot = running ? colorize(C.green, '●') : colorize(C.red, '○');
            console.log(colorize(C.cyan, `\nProverbs Inference Server`));
            console.log(`  Status : ${dot}  ${running ? 'running (pid ' + pid + ')' : 'stopped'}`);
            console.log(`  Script : ${serverScript}`);
            console.log(colorize(C.dim, '\n  Commands: /server start [port]  |  /server stop  |  /server models\n'));
          }
          break;
        }
        case 'project':
        case 'proj': {
          const newPath = handleProjectCmd(input.slice(`/${cmd}`.length).trim());
          if (newPath) {
            stopFileWatcher();
            cwd = newPath;
            history = [];
            // Re-index on project switch
            try { runIndex(cwd, true); } catch (_) {}
            detectedFrameworks = detectFrameworks(cwd);
            detectedConventions = detectConventions(cwd);
            loadGitContext(cwd);
            sessionContextFiles = [];
            try { loadScriptFiles(cwd); } catch (_) {}
            try { loadProverbsProfile(cwd); } catch (_) {}
            startFileWatcher(cwd);
          }
          break;
        }

        case 'finetune':
        case 'ft': {
          const sub = parts[1] || '';
          if (sub === '--bake' || sub === 'bake') {
            console.log(colorize(C.yellow, '\n  /finetune bake is not supported — it requires Ollama, which is no longer used by Proverbs.'));
            console.log(colorize(C.dim,    '  Use /admin - <rule> to inject rules permanently into every session instead.\n'));
          } else if (sub === '--format' || sub === 'format') {
            const fmtPath = path.join(__dirname, 'finetune', 'format_data.py');
            try { execSync(`~/.proverbs/venv/bin/python "${fmtPath}"`, { stdio: 'inherit' }); }
            catch (e) { console.log(colorize(C.red, `\n✗  ${e.message}\n`)); }
          } else if (sub === '--upload' || sub === 'upload') {
            const upPath = path.join(__dirname, 'finetune', 'upload_hf.py');
            try { execSync(`~/.proverbs/venv/bin/python "${upPath}"`, { stdio: 'inherit' }); }
            catch (e) { console.log(colorize(C.red, `\n✗  ${e.message}\n`)); }
          } else {
            console.log(colorize(C.cyan, '\nFine-tuning commands:'));
            console.log('  /finetune bake    — (disabled — use /admin - <rule> instead)');
            console.log('  /finetune format  — Format session logs into training data');
            console.log('  /finetune upload  — Upload training data to Hugging Face\n');
          }
          break;
        }

        // Feature 3: /search
        case 'search': {
          const query = input.slice('/search'.length).trim();
          if (!query) {
            console.log(colorize(C.red, '\n✗  Usage: /search <query>\n'));
            break;
          }
          const spinner = new Spinner('Searching...');
          spinner.start();
          let result;
          try {
            result = await toolWebSearch({ query });
          } catch (e) {
            result = `ERROR: ${e.message}`;
          }
          spinner.stop();
          console.log(colorize(C.cyanBold, '\n' + result) + '\n');
          break;
        }

        // Feature 4: /index
        case 'index':
          runIndex(cwd, false);
          break;

        // Feature 5: /memory
        case 'memory': {
          const sub = (parts[1] || '').toLowerCase();
          const memArgs = parts.slice(2).join(' ');
          rl.pause();
          try {
            const result = await handleMemoryCmd(sub, memArgs, history);
            if (result.historyUpdate) {
              history.push(result.historyUpdate);
            }
          } catch (e) {
            console.log(colorize(C.red, `\n✗  Memory error: ${e.message}\n`));
          }
          rl.resume();
          break;
        }

        // Feature 6: /ui
        case 'ui': {
          const uiPort = parseInt(parts[1], 10) || 4242;
          startWebUI(uiPort);
          break;
        }

        case 'studio': {
          const studioSub = (parts[1] || '').toLowerCase();
          if (studioSub === 'stop') {
            console.log(stopStudioServer() ? colorize(C.green, '\n  Studio stopped.\n') : colorize(C.yellow, '\n  Studio not running.\n'));
          } else if (studioSub === 'status') {
            if (studioServer) console.log(colorize(C.green, '\n  Studio running at http://localhost:' + studioPort + '\n'));
            else console.log(colorize(C.dim, '\n  Studio not running. Use /studio start\n'));
          } else {
            // start or no subcommand
            const sp = parts[1] && !isNaN(parseInt(parts[1])) ? parseInt(parts[1]) : (studioSub === 'start' && parts[2] ? parseInt(parts[2]) : 4300);
            startStudioServer(sp);
          }
          break;
        }

        // /ide — VS Code-style browser IDE with file tree, editor, terminal
        case 'ide':
        case 'code': {
          const idePort2 = parseInt(parts[1], 10) || 4400;
          _ideHistory = history;
          startIDEServer(idePort2);
          break;
        }

        // /preview — open built app in a standalone Electron preview window
        case 'preview': {
          const pvArg = parts[1] || '';
          let pvUrl;
          if (pvArg.startsWith('http')) {
            pvUrl = pvArg;
          } else {
            const pvPort = parseInt(pvArg, 10) || 3000;
            pvUrl = 'http://localhost:' + pvPort;
          }

          const pvTitle = path.basename(cwd);
          const pvDir   = path.join(PROVERBS_SRC_DIR, 'preview');
          const pvMain  = path.join(pvDir, 'main.js');
          const pvElectronBin = path.join(pvDir, 'node_modules', '.bin', 'electron');

          if (!fs.existsSync(pvMain)) {
            console.log(colorize(C.red, '\n✗  Preview app not found at: ' + pvMain + '\n'));
            break;
          }

          // Check if something is already listening on the target port
          const pvTargetPort = parseInt(pvUrl.split(':').pop().split('/')[0], 10) || 3000;
          const pvServerRunning = await new Promise(resolve => {
            const _net = require('net');
            const _sock = _net.createConnection({ port: pvTargetPort, host: '127.0.0.1' }, () => { _sock.destroy(); resolve(true); });
            _sock.on('error', () => resolve(false));
          });

          if (!pvServerRunning) {
            // Auto-start the project's dev server if package.json exists
            try {
              const _pvPkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
              const _pvScripts = _pvPkg.scripts || {};
              const _pvCmd = _pvScripts.dev   ? 'npm run dev'
                           : _pvScripts.start  ? 'npm start'
                           : _pvScripts.preview ? 'npm run preview'
                           : null;
              if (_pvCmd) {
                console.log(colorize(C.dim, '\n  No server on port ' + pvTargetPort + ' — starting: ' + _pvCmd + '\n'));
                require('child_process').spawn('bash', ['-c', _pvCmd], { cwd, detached: true, stdio: 'ignore' }).unref();
                await new Promise(r => setTimeout(r, 3000));
              } else {
                console.log(colorize(C.yellow, '\n  No server on port ' + pvTargetPort + '. Start your app first, then /preview ' + pvTargetPort + '\n'));
              }
            } catch (_pvErr) {
              console.log(colorize(C.yellow, '\n  No server detected on port ' + pvTargetPort + '. Start your app, then run /preview again.\n'));
            }
          }

          // Install electron on first run
          if (!fs.existsSync(pvElectronBin)) {
            console.log(colorize(C.cyan, '\n  First run: installing preview window (takes ~30s)...\n'));
            try {
              require('child_process').execSync('npm install --prefer-offline', { cwd: pvDir, stdio: 'inherit', timeout: 180000 });
            } catch (_pvInstErr) {
              console.log(colorize(C.red, '\n✗  electron install failed. Run manually: cd ' + pvDir + ' && npm install\n'));
              break;
            }
          }

          // Launch detached Electron window — doesn't block the CLI
          const _pvProc = require('child_process').spawn(pvElectronBin, [pvMain, '--url', pvUrl, '--title', pvTitle], {
            detached: true,
            stdio: 'ignore',
            cwd: pvDir,
          });
          _pvProc.unref();
          console.log(colorize(C.green, '\n  ✓ Preview window opened → ' + pvUrl + '\n'));
          console.log(colorize(C.dim, '  Tip: /preview 3001  to preview on a different port\n'));
          break;
        }

        // Feature 7: /rag (uses semantic embed index when available, falls back to TF-IDF)
        case 'rag': {
          const ragQuery2 = input.slice('/rag'.length).trim();
          if (!ragQuery2) {
            console.log(colorize(C.red, '\n\u2717  Usage: /rag <query>\n'));
            break;
          }
          let ragResults;
          let ragUsedEmbed = false;
          try {
            const er = await embedQuery(ragQuery2, 3);
            if (er.length > 0) { ragResults = er; ragUsedEmbed = true; }
          } catch (_) {}
          if (!ragUsedEmbed) {
            console.log(colorize(C.dim, `\nBuilding/refreshing RAG index for ${cwd} ...\n`));
            try {
              ragResults = ragQuery(ragQuery2, 3);
            } catch (e) {
              console.log(colorize(C.red, `\n\u2717  RAG error: ${e.message}\n`));
              break;
            }
          }
          if (!ragResults || ragResults.length === 0) {
            console.log(colorize(C.yellow, `\nNo relevant chunks found for: "${ragQuery2}"\n`));
            break;
          }
          const ragMethod = ragUsedEmbed ? 'semantic' : 'tfidf';
          console.log(colorize(C.cyan, `\nTop ${ragResults.length} chunk(s) for: "${ragQuery2}" [${ragMethod}]\n`));
          for (const { chunk, score } of ragResults) {
            const rel = path.relative(cwd, chunk.filePath) || chunk.filePath;
            console.log(colorize(C.bold, `  ${rel}  lines ${chunk.startLine}\u2013${chunk.endLine}`) +
                        colorize(C.dim,  `  (score: ${score.toFixed(4)})`));
            const preview = chunk.text.split('\n').slice(0, 8).join('\n');
            console.log(colorize(C.dim, preview.split('\n').map(l => '    ' + l).join('\n')));
            if (chunk.text.split('\n').length > 8)
              console.log(colorize(C.dim, `    ...(${chunk.text.split('\n').length} lines total)`));
            console.log();
          }
          if (ragUsedEmbed) {
            console.log(colorize(C.dim, `  Embed index: ${_embedIndex ? _embedIndex.chunks.length : 0} chunks. Run /embed to rebuild.\n`));
          } else {
            console.log(colorize(C.dim, `  TF-IDF index: ${_ragIndex ? _ragIndex.chunks.length : 0} chunks. Run /embed for semantic search.\n`));
          }
          break;
        }

        // Semantic embedding: /embed
        case 'embed': {
          console.log(colorize(C.cyan, `\nBuilding semantic embedding index for ${cwd} ...\n`));
          console.log(colorize(C.dim, `  Using model: ${EMBED_MODEL}  (via Proverbs server)\n`));
          const embedSpinner = new Spinner('Indexing...');
          embedSpinner.start();
          let embedCount;
          try {
            embedCount = await buildEmbedIndex(cwd);
          } catch (e) {
            embedSpinner.stop();
            console.log(colorize(C.red, `\n\u2717  Embed index error: ${e.message}\n`));
            break;
          }
          embedSpinner.stop();
          console.log(colorize(C.green, `\n\u2713  Indexed ${embedCount} chunks from ${cwd}`));
          console.log(colorize(C.dim, `  Saved to ${EMBED_INDEX_FILE}\n`));
          console.log(colorize(C.dim, `  Use /semrag <query> to search, or /rag will use it automatically.\n`));
          break;
        }

        // Semantic search: /semrag
        case 'semrag': {
          const semQuery = input.slice('/semrag'.length).trim();
          if (!semQuery) {
            console.log(colorize(C.red, '\n\u2717  Usage: /semrag <query>\n'));
            break;
          }
          let semResults;
          try {
            semResults = await embedQuery(semQuery, 5);
          } catch (e) {
            console.log(colorize(C.red, `\n\u2717  Semantic search error: ${e.message}\n`));
            break;
          }
          if (!semResults || semResults.length === 0) {
            console.log(colorize(C.yellow, '\nNo results. Run /embed first to build the semantic index.\n'));
            break;
          }
          console.log(colorize(C.cyan, `\nTop ${semResults.length} semantic result(s) for: "${semQuery}"\n`));
          for (const { chunk, score } of semResults) {
            const rel = path.relative(cwd, chunk.filePath) || chunk.filePath;
            console.log(colorize(C.bold, `  ${rel}  lines ${chunk.startLine}\u2013${chunk.endLine}`) +
                        colorize(C.dim,  `  (score: ${score.toFixed(4)})`));
            const preview = chunk.text.split('\n').slice(0, 8).join('\n');
            console.log(colorize(C.dim, preview.split('\n').map(l => '    ' + l).join('\n')));
            if (chunk.text.split('\n').length > 8)
              console.log(colorize(C.dim, `    ...(${chunk.text.split('\n').length} lines total)`));
            console.log();
          }
          console.log(colorize(C.dim, `  Embed index: ${_embedIndex ? _embedIndex.chunks.length : 0} chunks\n`));
          break;
        }

        // Feature 8: /voice
        case 'voice':
          handleVoice(rl, history);
          return; // skip rl.prompt() — handleVoice calls it when done

        // Feature 9: /image and /screenshot
        case 'image': {
          const rest = input.slice('/image'.length).trim();
          if (!rest) {
            console.log(colorize(C.red, '\nUsage: /image <path> [question]\n'));
            break;
          }
          let imgPath, question;
          const quotedMatch = rest.match(/^"([^"]+)"\s*(.*)/);
          if (quotedMatch) {
            imgPath = quotedMatch[1];
            question = quotedMatch[2].trim() || undefined;
          } else {
            const spaceIdx = rest.indexOf(' ');
            if (spaceIdx === -1) {
              imgPath = rest;
              question = undefined;
            } else {
              imgPath = rest.slice(0, spaceIdx);
              question = rest.slice(spaceIdx + 1).trim() || undefined;
            }
          }

          const spinner = new Spinner('Analyzing image...');
          spinner.start();
          let imgResult;
          try {
            imgResult = await toolAnalyzeImage({ path: imgPath, question });
          } finally {
            spinner.stop();
          }

          if (imgResult.startsWith('ERROR') || imgResult.startsWith('llava model')) {
            console.log(colorize(C.red, `\n✗  ${imgResult}\n`));
          } else {
            console.log(colorize(C.greenBold, '\nproverbs> ') + renderResponse(imgResult) + '\n');
            printClosingVerse();
            history.push({ role: 'user', content: `[Image analysis: ${imgPath}${question ? ' — ' + question : ''}]` });
            history.push({ role: 'assistant', content: imgResult });
          }
          break;
        }

        case 'screenshot': {
          if (os.platform() !== 'darwin') {
            console.log(colorize(C.red, '\n✗  /screenshot is only supported on macOS.\n'));
            break;
          }
          console.log(colorize(C.dim, '\nDrag to select a region, then release to capture...\n'));
          try {
            execSync(`screencapture -i "${SCREENSHOT_PATH}"`, { stdio: 'inherit' });
          } catch (_) {}
          if (!fs.existsSync(SCREENSHOT_PATH)) {
            console.log(colorize(C.dim, '(screenshot cancelled)\n'));
            break;
          }
          const screenshotQuestion = 'Describe what you see. If there is code, explain it. If there is a UI, describe the layout and components.';
          const spinner2 = new Spinner('Analyzing screenshot...');
          spinner2.start();
          let ssResult;
          try {
            ssResult = await toolAnalyzeImage({ path: SCREENSHOT_PATH, question: screenshotQuestion });
          } finally {
            spinner2.stop();
          }
          try { fs.unlinkSync(SCREENSHOT_PATH); } catch (_) {}

          if (ssResult.startsWith('ERROR') || ssResult.startsWith('llava model')) {
            console.log(colorize(C.red, `\n✗  ${ssResult}\n`));
          } else {
            console.log(colorize(C.greenBold, '\nproverbs> ') + renderResponse(ssResult) + '\n');
            printClosingVerse();
            history.push({ role: 'user', content: '[Screenshot analysis]' });
            history.push({ role: 'assistant', content: ssResult });
          }
          break;
        }

        // Feature 10: /models and /route
        case 'models': {
          const available = await fetchAvailableModels();
          if (available.length === 0) {
            console.log(colorize(C.red, '\n✗  Could not reach Ollama or no models installed.\n'));
            break;
          }
          console.log(colorize(C.cyan, `\nOllama models (${available.length}):`));
          for (const m of available) {
            const roles = [];
            if (m === routingConfig.fast)   roles.push(colorize(C.green,  'fast'));
            if (m === routingConfig.smart)  roles.push(colorize(C.cyan,   'smart'));
            if (m === routingConfig.vision) roles.push(colorize(C.yellow, 'vision'));
            const roleTag  = roles.length ? ` [${roles.join('+')}]` : '';
            const activeTag = m === model ? colorize(C.greenBold, ' ← active') : '';
            console.log(`  ${m}${roleTag}${activeTag}`);
          }
          console.log(colorize(C.dim, `\n  Routing : ${routingConfig.routing}`));
          console.log(colorize(C.dim, `  fast    : ${routingConfig.fast   || '(none)'}`));
          console.log(colorize(C.dim, `  smart   : ${routingConfig.smart  || '(none)'}`));
          console.log(colorize(C.dim, `  vision  : ${routingConfig.vision || '(none)'}\n`));
          break;
        }

        case 'route': {
          const sub  = parts[1] || '';
          const arg2 = parts[2] || '';
          if (sub === 'auto') {
            routingConfig.routing = 'auto';
            saveRoutingConfig();
            saveConfig();
            console.log(colorize(C.green, '\n✔  Auto-routing enabled.\n'));
          } else if (sub === 'manual') {
            routingConfig.routing = 'manual';
            saveRoutingConfig();
            saveConfig();
            console.log(colorize(C.green, '\n✔  Manual routing — model stays as-is.\n'));
          } else if ((sub === 'fast' || sub === 'smart' || sub === 'vision') && arg2) {
            routingConfig[sub] = arg2;
            saveRoutingConfig();
            saveConfig();
            console.log(colorize(C.green, `\n✔  ${sub} model set to: ${arg2}\n`));
          } else {
            console.log(colorize(C.cyan, '\nRouting commands:'));
            console.log('  /route auto              — Enable automatic model routing');
            console.log('  /route manual            — Disable auto-routing (keep current model)');
            console.log('  /route fast <model>      — Assign a model to the fast role');
            console.log('  /route smart <model>     — Assign a model to the smart role');
            console.log('  /route vision <model>    — Assign a model to the vision role');
            console.log(colorize(C.dim, `\n  mode  : ${routingConfig.routing}`));
            console.log(colorize(C.dim, `  fast  : ${routingConfig.fast   || '(none)'}`));
            console.log(colorize(C.dim, `  smart : ${routingConfig.smart  || '(none)'}\n`));
          }
          break;
        }

        // patch_file slash command
        case 'patch': {
          const patchRaw = input.slice('/patch'.length).trim();
          if (!patchRaw) {
            console.log(colorize(C.red, '\n✗  Usage: /patch <path> |old string| |new string|\n'));
            console.log(colorize(C.dim, '     Wrap old and new strings in pipe characters.\n'));
            console.log(colorize(C.dim, '     Example: /patch src/app.js |console.log("old")| |console.log("new")|\n'));
            console.log(colorize(C.dim, '     To delete text, leave new string empty: /patch src/app.js |bad line| ||\n'));
            break;
          }

          const patchPipeMatch = patchRaw.match(/^(\S+)\s+\|([^|]*)\|\s*\|([^|]*)\|/);
          if (!patchPipeMatch) {
            console.log(colorize(C.red, '\n✗  Usage: /patch <path> |old string| |new string|\n'));
            console.log(colorize(C.dim, '     Wrap old and new strings in pipe characters: |text|\n'));
            console.log(colorize(C.dim, '     Example: /patch src/app.js |old text| |new text|\n'));
            break;
          }

          const patchPath   = patchPipeMatch[1];
          const patchOld    = patchPipeMatch[2];
          const patchNew    = patchPipeMatch[3];

          const patchResult = toolPatchFile({ path: patchPath, old_string: patchOld, new_string: patchNew });
          if (patchResult.startsWith('PATCH ERROR')) {
            console.log(colorize(C.red, `\n✗  ${patchResult}\n`));
          } else {
            console.log(colorize(C.green, `\n✔  ${patchResult}\n`));
          }
          break;
        }

        // /compress — manually trigger context compression
        case 'compress': {
          if (history.length === 0) {
            console.log(colorize(C.dim, '\n(history is empty — nothing to compress)\n'));
            break;
          }

          let compressableCount = history.length;
          if (
            history[0].role === 'system' &&
            typeof history[0].content === 'string' &&
            history[0].content.startsWith('Prior conversation summary:')
          ) {
            compressableCount = history.length - 1;
          }

          const minNeeded = COMPRESS_MIN_OLDER + COMPRESS_KEEP_RECENT;
          if (compressableCount < minNeeded) {
            console.log(colorize(C.yellow, `\n(need at least ${minNeeded} messages to compress; currently have ${compressableCount})\n`));
            break;
          }

          const compressSpinner = new Spinner('Compressing history...');
          compressSpinner.start();
          let compressed;
          try {
            compressed = await compressHistory(history, model);
          } catch (_) {
            compressed = null;
          }
          compressSpinner.stop();

          if (!compressed || compressed === history || compressed.length >= history.length) {
            console.log(colorize(C.red, '\n✗  Compression failed or produced no reduction. History unchanged.\n'));
            break;
          }

          const before = history.length;
          history = compressed;
          console.log(colorize(C.green, `\n✔  History compressed: ${before} → ${history.length} messages.\n`));
          break;
        }

        // /load <path> [depth]
        case 'load': {
          const loadArg = input.slice('/load'.length).trim();
          if (!loadArg) {
            console.log(colorize(C.red, '\n✗  Usage: /load <path> [depth]\n'));
            console.log(colorize(C.dim, '   Example: /load src/index.js\n'));
            console.log(colorize(C.dim, '   Example: /load ./lib/auth.js 3\n'));
            break;
          }

          const loadTokens = loadArg.split(/\s+/);
          const loadPath   = loadTokens[0];
          const loadDepth  = loadTokens[1] && /^\d+$/.test(loadTokens[1])
            ? parseInt(loadTokens[1], 10)
            : 2;

          const loadSpinner = new Spinner('Loading context...');
          loadSpinner.start();
          let loadResult;
          try {
            loadResult = toolLoadContext({ path: loadPath, depth: loadDepth });
          } catch (e) {
            loadResult = `ERROR: ${e.message}`;
          } finally {
            loadSpinner.stop();
          }

          if (loadResult.startsWith('ERROR')) {
            console.log(colorize(C.red, `\n✗  ${loadResult}\n`));
            break;
          }

          const fileMatches = (loadResult.match(/^\/\/ ===/gm) || []).length;
          console.log(colorize(C.green, `\n✔  Loaded context: ${fileMatches} file(s) for "${loadPath}"\n`));
          console.log(colorize(C.dim, '   Injected into conversation as a user message.\n'));

          history.push({
            role: 'user',
            content: `Here is the context for ${loadPath}:\n${loadResult}`,
          });
          break;
        }

        // /ctx — session-scoped file pinning
        case 'ctx': {
          const ctxSub  = (parts[1] || '').toLowerCase();
          const ctxRest = parts.slice(2).join(' ');
          rl.pause();
          try {
            await handleCtxCmd(ctxSub, ctxRest);
          } catch (e) {
            console.log(colorize(C.red, `\n✗  /ctx error: ${e.message}\n`));
          }
          rl.resume();
          break;
        }

        // /plan
        case 'plan': {
          handlePlanCmd(input, rl, history);
          return; // skip the trailing rl.prompt()
        }

        // /templates
        case 'templates': {
          const freshFrameworks = detectFrameworks(cwd);
          detectedFrameworks = freshFrameworks;
          if (freshFrameworks.length === 0) {
            console.log(colorize(C.yellow, `\n(no recognised frameworks found in ${cwd})\n`));
            console.log(colorize(C.dim, '  Make sure package.json exists in the working directory.\n'));
          } else {
            console.log(colorize(C.cyan, `\nDetected frameworks in ${cwd} (${freshFrameworks.length}):\n`));
            freshFrameworks.forEach((hint, i) => {
              const firstDot = hint.indexOf('.');
              const label = firstDot !== -1 ? hint.slice(0, firstDot + 1) : hint;
              const rest  = firstDot !== -1 ? hint.slice(firstDot + 1).trim() : '';
              console.log(`  ${colorize(C.bold, String(i + 1) + '.')} ${colorize(C.green, label)}`);
              if (rest) {
                console.log(colorize(C.dim, `     ${rest}`));
              }
            });
            console.log();
          }
          break;
        }

        // /fallback
        case 'fallback': {
          const sub = (parts[1] || '').toLowerCase();

          if (!sub || sub === 'status') {
            console.log(colorize(C.cyan, '\nLiteLLM Cloud Fallback:'));
            console.log(`  Status : ${fallbackEnabled ? colorize(C.green, 'enabled') : colorize(C.dim, 'disabled')}`);
            console.log(`  Model  : ${fallbackModel}`);
            console.log(`  Proxy  : ${LITELLM_BASE}`);
            console.log(colorize(C.dim, '\n  Usage:'));
            console.log(colorize(C.dim, '    /fallback on              — enable with current model'));
            console.log(colorize(C.dim, '    /fallback off             — disable, return to local'));
            console.log(colorize(C.dim, '    /fallback <model>         — set model + enable'));
            console.log(colorize(C.dim, '    /fallback status          — show this status'));
            console.log(colorize(C.dim, '\n  Note: tools (read_file, run_bash, etc.) are unavailable'));
            console.log(colorize(C.dim, '  in fallback mode. Cloud receives plain text only.\n'));
            break;
          }

          if (sub === 'on') {
            fallbackEnabled = true;
            saveConfig();
            console.log(colorize(C.green, `\n✔  Cloud fallback enabled (${fallbackModel} via LiteLLM at ${LITELLM_BASE})\n`));
            console.log(colorize(C.dim, '  Note: tool use is unavailable in cloud fallback mode.\n'));
            break;
          }

          if (sub === 'off') {
            fallbackEnabled = false;
            saveConfig();
            console.log(colorize(C.green, '\n✔  Cloud fallback disabled. Using local Ollama.\n'));
            break;
          }

          const newFallbackModel = parts.slice(1).join('/').trim();
          if (!newFallbackModel || newFallbackModel.startsWith('-')) {
            console.log(colorize(C.red, `\n✗  Unknown /fallback subcommand: "${parts.slice(1).join(' ')}"\n`));
            console.log(colorize(C.dim, '  Usage: /fallback on | off | status | <model-name>\n'));
            break;
          }
          fallbackModel = newFallbackModel;
          fallbackEnabled = true;
          saveConfig();
          console.log(colorize(C.green, `\n✔  Cloud fallback enabled with model: ${fallbackModel}\n`));
          console.log(colorize(C.dim, `  Proxy: ${LITELLM_BASE}\n`));
          console.log(colorize(C.dim, '  Note: tool use is unavailable in cloud fallback mode.\n'));
          break;
        }

        // /docs
        case 'docs': {
          const docPkg = input.slice('/docs'.length).trim();
          if (!docPkg) {
            console.log(colorize(C.red, '\n✗  Usage: /docs <package>\n'));
            console.log(colorize(C.dim, '   Example: /docs express\n'));
            console.log(colorize(C.dim, '   Example: /docs @types/node\n'));
            break;
          }
          const docsSpinner = new Spinner(`Fetching docs for ${docPkg}...`);
          docsSpinner.start();
          let docsResult;
          try {
            docsResult = await fetchPackageDocs(docPkg);
          } catch (e) {
            docsSpinner.stop();
            console.log(colorize(C.red, `\n✗  ${e.message}\n`));
            break;
          }
          docsSpinner.stop();

          if (!docsResult || !docsResult.trim()) {
            console.log(colorize(C.red, `\n✗  No documentation returned for "${docPkg}".\n`));
            break;
          }

          history.push({ role: 'user', content: 'Documentation context:\n' + docsResult });
          console.log(
            colorize(C.green, `\n✔  Loaded ${docPkg} docs into context (${docsResult.length} chars). Now ask your question.\n`)
          );
          break;
        }

        // /fetch
        case 'fetch': {
          const fetchUrl = input.slice('/fetch'.length).trim();
          if (!fetchUrl) {
            console.log(colorize(C.red, '\n✗  Usage: /fetch <url>\n'));
            console.log(colorize(C.dim, '   Example: /fetch https://api.github.com/repos/expressjs/express\n'));
            console.log(colorize(C.dim, '   Example: /fetch https://example.com/docs\n'));
            break;
          }
          if (!/^https?:\/\//.test(fetchUrl)) {
            console.log(colorize(C.red, '\n✗  URL must start with http:// or https://\n'));
            break;
          }
          const fetchSpinner = new Spinner(`Fetching ${fetchUrl}...`);
          fetchSpinner.start();
          let fetchResult;
          try {
            fetchResult = await toolFetchUrl({ url: fetchUrl });
          } catch (e) {
            fetchSpinner.stop();
            console.log(colorize(C.red, `\n✗  ${e.message}\n`));
            break;
          }
          fetchSpinner.stop();

          if (!fetchResult || fetchResult.startsWith('ERROR')) {
            console.log(colorize(C.red, '\n✗  ' + fetchResult + '\n'));
            break;
          }

          history.push({ role: 'user', content: 'Fetched URL context:\n' + fetchResult });
          console.log(
            colorize(C.green, `\n✔  Fetched and injected into context (${fetchResult.length} chars). Now ask your question.\n`)
          );
          break;
        }

        // /validate
        case 'validate': {
          const validatePath = input.slice('/validate'.length).trim();
          if (!validatePath) {
            console.log(colorize(C.red, '\n✗  Usage: /validate <path>\n'));
            break;
          }
          const absValidatePath = resolvePath(validatePath);
          let fileContent;
          try {
            fileContent = fs.readFileSync(absValidatePath, 'utf8');
          } catch (e) {
            console.log(colorize(C.red, '\n✗  Cannot read file: ' + e.message + '\n'));
            break;
          }
          const valExt = path.extname(absValidatePath).toLowerCase();
          const supported = ['.js', '.cjs', '.mjs', '.json', '.ts', '.tsx', '.jsx'];
          if (!supported.includes(valExt)) {
            console.log(colorize(C.yellow, '\n⚠  No syntax validator for ' + (valExt || 'this file type') + ' files — skipped.\n'));
            break;
          }
          let validationErr;
          try {
            validationErr = validateSyntax(absValidatePath, fileContent);
          } catch (e) {
            console.log(colorize(C.red, '\n✗  Validator error: ' + e.message + '\n'));
            break;
          }
          if (validationErr) {
            console.log(colorize(C.red, '\n✗  ' + absValidatePath));
            console.log(colorize(C.red, '   ' + validationErr + '\n'));
          } else {
            console.log(colorize(C.greenBold, '\n✔  ' + absValidatePath + ' — syntax OK\n'));
          }
          break;
        }

        // Session persistence
        case 'save': {
          const saveName = parts.slice(1).join(' ').trim();
          if (!saveName) {
            console.log(colorize(C.red, '\n✗  Usage: /save <name>\n'));
            console.log(colorize(C.dim, '   Example: /save my-auth-session\n'));
            break;
          }
          if (history.length === 0) {
            console.log(colorize(C.yellow, '\n(nothing to save — history is empty)\n'));
            break;
          }
          try {
            const savedPath = saveSession(saveName, history, { cwd, model, sessionContextFiles });
            console.log(colorize(C.green, `\n✔  Session "${saveName}" saved (${history.length} messages).\n`));
            console.log(colorize(C.dim, `   ${savedPath}\n`));
          } catch (e) {
            console.log(colorize(C.red, `\n✗  Save failed: ${e.message}\n`));
          }
          break;
        }

        case 'sessions': {
          const sessions = listSavedSessions();
          if (sessions.length === 0) {
            console.log(colorize(C.dim, '\n(no saved sessions found)\n'));
            console.log(colorize(C.dim, '  Use /save <name> to save the current conversation.\n'));
            break;
          }
          console.log(colorize(C.cyan, `\nSaved sessions (${sessions.length}):\n`));
          sessions.forEach((s, i) => {
            const savedAt  = s.savedAt  || 'unknown';
            const msgCount = Array.isArray(s.history) ? s.history.length : '?';
            const sessionCwd   = s.cwd   || '?';
            const displayName  = s.name  || path.basename(Object.keys(s)[0] || 'unnamed');
            console.log(`  ${colorize(C.bold, String(i + 1) + '.')} ${colorize(C.greenBold, displayName)}`);
            console.log(colorize(C.dim, `     saved   : ${savedAt}`));
            console.log(colorize(C.dim, `     messages: ${msgCount}`));
            console.log(colorize(C.dim, `     cwd     : ${sessionCwd}`));
          });
          console.log(colorize(C.dim, '\n  Use /resume <name> to restore a session.\n'));
          break;
        }

        case 'resume': {
          const resumeName = parts.slice(1).join(' ').trim();
          if (!resumeName) {
            console.log(colorize(C.red, '\n✗  Usage: /resume <name>\n'));
            console.log(colorize(C.dim, '   Use /sessions to list available sessions.\n'));
            break;
          }
          let loaded;
          try {
            loaded = loadSession(resumeName);
          } catch (e) {
            // List available sessions by name when the requested one isn't found
            const available = listSavedSessions().map(s => s.name).filter(Boolean);
            console.log(colorize(C.red, `\n✗  Session '${resumeName}' not found.`));
            if (available.length > 0) {
              console.log(colorize(C.dim, `   Available: ${available.join(', ')}\n`));
            } else {
              console.log(colorize(C.dim, '   No saved sessions exist yet. Use /save <name> to create one.\n'));
            }
            break;
          }
          history.length = 0;
          Array.prototype.push.apply(history, loaded.history);
          if (loaded.cwd && typeof loaded.cwd === 'string') {
            cwd = loaded.cwd;
          }
          if (loaded.model && typeof loaded.model === 'string') {
            model = loaded.model;
          }
          sessionContextFiles = Array.isArray(loaded.sessionContextFiles)
            ? loaded.sessionContextFiles
            : [];
          console.log(colorize(C.green, `\n✔  Session "${resumeName}" resumed.\n`));
          console.log(colorize(C.dim, `   Messages : ${history.length}`));
          console.log(colorize(C.dim, `   Model    : ${model}`));
          console.log(colorize(C.dim, `   CWD      : ${cwd}\n`));
          break;
        }

        // /diff on|off — toggle diff preview after file writes
        case 'diff': {
          const diffArg = (parts[1] || '').toLowerCase();
          if (diffArg === 'on') {
            diffPreviewEnabled = true;
            saveConfig();
            console.log(colorize(C.green, '\n✔  Diff preview enabled. Changes will be shown after every file write.\n'));
          } else if (diffArg === 'off') {
            diffPreviewEnabled = false;
            saveConfig();
            console.log(colorize(C.dim, '\n  Diff preview disabled. File writes will be silent.\n'));
          } else {
            const state = diffPreviewEnabled
              ? colorize(C.green, 'on')
              : colorize(C.dim,   'off');
            console.log(colorize(C.cyan, '\nDiff preview: ') + state);
            console.log(colorize(C.dim, '  /diff on   — show a diff after every write_file / edit_file / patch_file'));
            console.log(colorize(C.dim, '  /diff off  — suppress diff output\n'));
          }
          break;
        }

        // /context — show context gauge for current history
        case 'health': {
          const doFix = (parts[1] || '').toLowerCase() === 'fix';
          const OK = colorize(C.green, '●'); const ERR = colorize(C.red, '●'); const OFF = colorize(C.dim, '○');
          console.log(colorize(C.cyan, '\n  System Health Check\n'));
          const ping = await pingBackend();
          console.log('  [' + (ping.ok ? OK : ERR) + '] LLM Backend (' + activeBackendName + ') — ' + (ping.ok ? ping.ms + 'ms' : 'DOWN: ' + ping.error));
          console.log('  [' + (triggerServer ? OK : OFF) + '] Trigger Server — ' + (triggerServer ? 'running :' + triggerPort : 'stopped'));
          if (doFix && !triggerServer) { try { await startTriggerServer(triggerPort); } catch(_) {} }
          console.log('  [' + (studioServer ? OK : OFF) + '] Studio — ' + (studioServer ? 'http://localhost:' + studioPort : 'stopped'));
          if (doFix && !studioServer) { try { startStudioServer(studioPort); } catch(_) {} }
          try { await httpGet('http://localhost:4000/health', 2000); console.log('  [' + OK + '] LiteLLM Proxy — ok'); }
          catch(_) { console.log('  [' + OFF + '] LiteLLM Proxy — down'); }
          const running = taskStore.filter(t => t.status === 'in_progress').length;
          console.log('  [' + OK + '] Tasks — ' + taskStore.length + ' total, ' + running + ' running');
          const activeCrons = cronJobs.filter(j => j.enabled).length;
          console.log('  [' + (activeCrons > 0 ? OK : OFF) + '] Crons — ' + activeCrons + ' active / ' + cronJobs.length + ' total');
          console.log('  [' + (heartbeatTimer ? OK : OFF) + '] Heartbeat — ' + (heartbeatTimer ? 'running (30s)' : 'stopped'));
          if (doFix && !heartbeatTimer) startHeartbeat(30000);
          console.log('');
          if (doFix) console.log(colorize(C.green, '  /health fix applied — stopped services restarted.\n'));
          break;
        }

        case 'speed': {
          const speedSub = (parts[1] || '').toLowerCase();
          const speedVal = parts[2] || '';
          function msColor(ms) { if (!ms) return colorize('—', C.dim); return ms < 2000 ? colorize(ms+'ms', C.green) : ms < 5000 ? colorize(ms+'ms', C.yellow) : colorize(ms+'ms', C.red); }
          if (!speedSub) {
            const st = getSpeedStats();
            console.log(colorize('\n  Response Speed Stats', C.cyan));
            console.log('  Last response : ' + msColor(st.last));
            console.log('  Average       : ' + msColor(st.avg) + (st.count ? colorize(' (over ' + st.count + ' requests)', C.dim) : ''));
            console.log('  Context budget: ' + (contextBudget > 0 ? colorize(contextBudget + ' tokens', C.cyan) + colorize(' (auto-compress when exceeded)', C.dim) : colorize('off', C.dim)));
            console.log('\n  /speed budget <N>   — set max tokens\n  /speed budget off   — remove limit\n  /speed reset        — clear stats\n');
          } else if (speedSub === 'budget') {
            if (speedVal === 'off' || speedVal === '0') { contextBudget = 0; console.log(colorize('\n  Context budget disabled.\n', C.dim)); }
            else { const n = parseInt(speedVal || parts[1]); if (!n || n < 0) { console.log(colorize('\n  Usage: /speed budget <N> or /speed budget off\n', C.yellow)); break; } contextBudget = n; console.log(colorize('\n  Context budget set to ' + n + ' tokens.\n', C.green)); }
          } else if (speedSub === 'reset') { _lastResponseMs = 0; _avgResponseMs = 0; _responseCount = 0; console.log(colorize('\n  Stats reset.\n', C.dim)); }
          else { console.log(colorize('\n  Unknown: ' + speedSub + '\n', C.yellow)); }
          break;
        }

        case 'context': {
          const ctxSub = (parts[1] || '').toLowerCase();
          const EXPORTS_DIR = path.join(require('os').homedir(), '.proverbs', 'exports');
          if (!ctxSub || ctxSub === 'stats') {
            const allMsgs = [{ role: 'system', content: buildSystemPrompt() }, ...history];
            const tokens = await countMessagesTokens(allMsgs);
            const win = typeof getContextWindow === 'function' ? getContextWindow(model) : 8192;
            const pct = ((tokens / win) * 100).toFixed(1);
            const roles = { user:0, assistant:0, tool:0 };
            history.forEach(m => { if (m.role in roles) roles[m.role]++; });
            console.log(colorize('\n  Context Stats', C.cyan));
            console.log('  Messages  : ' + history.length + '  (user:' + roles.user + ' assistant:' + roles.assistant + ' tool:' + roles.tool + ')');
            console.log('  Tokens    : ' + colorize(tokens.toLocaleString(), tokens / win > 0.8 ? C.red : tokens / win > 0.5 ? C.yellow : C.green) + ' / ' + win.toLocaleString() + ' (' + pct + '%)');
            console.log('  CWD       : ' + colorize(cwd, C.dim));
            console.log('');
          } else if (ctxSub === 'export') {
            if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });
            const fp = parts[2] ? path.resolve(parts[2]) : path.join(EXPORTS_DIR, 'ctx-' + Date.now() + '.json');
            try { const d = exportContext(fp, history); console.log(colorize('\n  ✔ Exported ' + d.messageCount + ' messages to ' + fp + '\n', C.green)); }
            catch(e) { console.log(colorize('\n  ✗ Export failed: ' + e.message + '\n', C.red)); }
          } else if (ctxSub === 'import') {
            const iarg = parts[2];
            if (iarg === '--b64') {
              const dec = decodeContext(parts[3]);
              if (!dec || !Array.isArray(dec.history)) { console.log(colorize('\n  ✗ Invalid base64 context\n', C.red)); break; }
              history.splice(0, history.length, ...dec.history);
              if (dec.proverbsProfile) proverbsProfile = dec.proverbsProfile;
              console.log(colorize('\n  ✔ Imported ' + dec.history.length + ' messages from base64\n', C.green));
            } else if (iarg) {
              const fp = path.resolve(iarg);
              if (!fs.existsSync(fp)) { console.log(colorize('\n  ✗ File not found: ' + fp + '\n', C.red)); break; }
              try { const r = importContext(fp, history); console.log(colorize('\n  ✔ Imported ' + r.messageCount + ' messages (exported: ' + r.exportedAt + ')\n', C.green)); }
              catch(e) { console.log(colorize('\n  ✗ Import failed: ' + e.message + '\n', C.red)); }
            } else { console.log(colorize('\n  Usage: /context import <path> or /context import --b64 <encoded>\n', C.yellow)); }
          } else if (ctxSub === 'share') {
            if (!history.length) { console.log(colorize('\n  Nothing to share.\n', C.dim)); break; }
            const b64 = encodeContext(history);
            if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });
            const fp = path.join(EXPORTS_DIR, 'shared-' + Date.now() + '.b64');
            fs.writeFileSync(fp, b64);
            console.log(colorize('\n  Saved to: ' + fp, C.green));
            if (b64.length < 8000) { console.log(colorize('\n  Encoded context:\n', C.cyan)); console.log(b64); }
            else console.log(colorize('  (too large to print inline — ' + (b64.length/1024).toFixed(1) + ' KB)', C.dim));
            console.log(colorize('\n  Import with: /context import --b64 <encoded>\n', C.dim));
          } else if (ctxSub === 'compress') {
            const keepN = parseInt(parts[2]) || 6;
            if (history.length <= keepN + 2) { console.log(colorize('\n  Not enough history to compress.\n', C.dim)); break; }
            const sp = new Spinner('Compressing context...');
            sp.start();
            try { const r = await smartCompress(history, keepN); sp.stop(); if (r) console.log(colorize('\n  ✔ Compressed ' + r.before + ' → ' + r.after + ' messages\n  Summary: ' + r.summary + '\n', C.green)); else console.log(colorize('\n  Nothing to compress.\n', C.dim)); }
            catch(e) { sp.stop(); console.log(colorize('\n  ✗ ' + e.message + '\n', C.red)); }
          } else if (ctxSub === 'clear') {
            await new Promise(res => rl.question(colorize('  Clear all history? [y/N] ', C.yellow), ans => { if (ans.trim().toLowerCase() === 'y') { history.splice(0); console.log(colorize('\n  ✔ History cleared.\n', C.green)); } else console.log(colorize('\n  Cancelled.\n', C.dim)); res(); }));
          } else {
            console.log(colorize('\n  /context subcommands:\n', C.cyan));
            ['stats — show token usage','export [path] — save session JSON','import <path> — restore session','import --b64 <encoded> — restore from base64','share — encode shareable context','compress [N] — smart compress keeping last N messages','clear — wipe history'].forEach(c => console.log('    ' + c));
            console.log('');
          }
          console.log(colorize('\n  Context usage:', C.dim)); await showContextGauge([{ role:'system', content:buildSystemPrompt() }, ...history]); console.log('');
          break;
        }

        case 'projects': {
          const projSub = (parts[1] || '').toLowerCase();
          if (projSub === 'scan' || projSub === 'refresh') {
            const sp = new Spinner('Discovering all projects...');
            sp.start();
            const found = discoverClaudeProjects();
            sp.stop();
            const reg = path.join(PROVERBS_HOME, 'projects-registry.json');
            try { fs.mkdirSync(PROVERBS_HOME, { recursive: true }); fs.writeFileSync(reg, JSON.stringify(found, null, 2)); } catch(_) {}
            console.log(colorize('\n  ✔ Found ' + found.length + ' projects (saved to ' + reg + ')\n', C.green));
            found.forEach(p => console.log('  ' + colorize(p.name.padEnd(32), C.text) + colorize(p.stack.padEnd(24), C.dim) + (p.hasProverbs ? colorize('✔ .proverbs', C.green) : colorize('○ no profile', C.dim))));
            console.log('');
          } else if (projSub === 'setup') {
            // Batch-generate .proverbs profiles for all projects that don't have one
            const found = discoverClaudeProjects().filter(p => !p.hasProverbs && p.hasPkg);
            console.log(colorize('\n  Setting up .proverbs profiles for ' + found.length + ' projects...\n', C.cyan));
            for (const proj of found) {
              try {
                const pkg = JSON.parse(fs.readFileSync(path.join(proj.path, 'package.json'), 'utf8'));
                const allDeps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
                const stackMap = { 'next':'Next.js','@prisma/client':'Prisma','@supabase/supabase-js':'Supabase','stripe':'Stripe','@capacitor/core':'Capacitor','electron':'Electron','react':'React','express':'Express','tailwindcss':'Tailwind','vite':'Vite','typescript':'TypeScript','next-auth':'NextAuth','framer-motion':'Framer Motion','zustand':'Zustand','zod':'Zod' };
                const stack = Object.entries(stackMap).filter(([d]) => allDeps[d]).map(([,l]) => l).join(', ') || 'Node.js';
                const content = '# ' + (pkg.name || proj.name) + ' — Proverbs Profile\n# Auto-generated from Claude project history\n\n## Stack\n' + stack + '\n\n## Rules\n- Follow conventions in this codebase\n- Read package.json for available scripts\n';
                fs.writeFileSync(path.join(proj.path, '.proverbs'), content);
                console.log(colorize('  ✔ ', C.green) + proj.name + colorize(' [' + stack + ']', C.dim));
              } catch(e) { console.log(colorize('  ✗ ', C.red) + proj.name + ': ' + e.message); }
            }
            console.log('');
          } else if (projSub && projSub !== 'list') {
            // /projects <name> — switch to that project
            const query = parts.slice(1).join(' ').toLowerCase();
            const all = discoverClaudeProjects();
            const match = all.find(p => p.name.toLowerCase() === query) || all.find(p => p.name.toLowerCase().includes(query));
            if (!match) { console.log(colorize('\n  No project matching "' + query + '"\n', C.yellow)); break; }
            cwd = match.path;
            process.chdir(cwd);
            detectedFrameworks = detectFrameworks(cwd);
            detectedConventions = detectConventions(cwd);
            loadGitContext(cwd);
            try { loadScriptFiles(cwd); } catch(_) {}
            try { loadProverbsProfile(cwd); } catch(_) {}
            console.log(colorize('\n  ✔ Switched to: ' + match.name, C.green));
            console.log(colorize('  Path: ' + match.path, C.dim));
            if (match.stack) console.log(colorize('  Stack: ' + match.stack, C.dim));
            if (!match.hasProverbs) console.log(colorize('\n  Tip: run /scan to generate a .proverbs profile for this project.\n', C.yellow));
            else console.log('');
          } else {
            // /projects list (default)
            const sp = new Spinner('Scanning projects...');
            sp.start();
            const all = discoverClaudeProjects();
            sp.stop();
            const claudeCount = all.filter(p => p.claudeDir).length;
            console.log(colorize('\n  Your Projects (' + all.length + ' found, ' + claudeCount + ' from Claude history)\n', C.cyan));
            console.log(colorize('  ' + 'NAME'.padEnd(32) + 'STACK'.padEnd(26) + 'PROFILE', C.dim));
            all.forEach(p => {
              const profile = p.hasProverbs ? colorize('✔', C.green) : colorize('○', C.dim);
              const claude = p.claudeDir ? colorize(' ◈', C.accent || C.cyan) : '';
              console.log('  ' + (p.name + claude).padEnd(34) + colorize((p.stack || '—').padEnd(26), C.dim) + profile);
            });
            console.log(colorize('\n  Commands:', C.dim));
            console.log('  /projects <name>    — switch to project');
            console.log('  /projects scan      — refresh project list');
            console.log('  /projects setup     — generate .proverbs profiles for all Claude projects\n');
          }
          break;
        }

        // /tokens [on|off] — count tokens in current history or toggle per-response display
        case 'tokens': {
          const tokArg = (parts[1] || '').toLowerCase();
          if (tokArg === 'on') {
            showTokenCount = true;
            console.log(colorize(C.green, '\n✔  Per-response token count enabled. Each reply will show [~N tokens used / M context].\n'));
            break;
          }
          if (tokArg === 'off') {
            showTokenCount = false;
            console.log(colorize(C.dim, '\n  Per-response token count disabled.\n'));
            break;
          }
          // No arg — show breakdown by role for current history
          if (!history.length) {
            console.log(colorize(C.dim, '\n  No history yet.\n'));
            break;
          }
          console.log(colorize(C.cyan, '\nToken breakdown for current history:\n'));
          const _roleTotals = {};
          let _grandTotal = 0;
          for (const _m of history) {
            const _t = await countTokens(((_m.content || '') + (_m.role || '')));
            _roleTotals[_m.role] = (_roleTotals[_m.role] || 0) + _t;
            _grandTotal += _t;
          }
          // Add system prompt estimate
          const _sysText = buildSystemPrompt();
          const _sysToks = await countTokens(_sysText);
          _roleTotals['system'] = (_roleTotals['system'] || 0) + _sysToks;
          _grandTotal += _sysToks;
          Object.keys(_roleTotals).sort().forEach(function(role) {
            const pctRole = Math.round(_roleTotals[role] / _grandTotal * 100);
            console.log(colorize(C.dim, '  ' + role.padEnd(12) + _roleTotals[role].toLocaleString().padStart(8) + ' tokens  (' + pctRole + '%)'));
          });
          console.log(colorize(C.white, '  ' + 'total'.padEnd(12) + _grandTotal.toLocaleString().padStart(8) + ' tokens'));
          const _ctxWin = getContextWindow(model);
          const _pctUsed = Math.min(100, Math.round(_grandTotal / _ctxWin * 100));
          console.log(colorize(_pctUsed > 80 ? C.red : _pctUsed > 50 ? C.yellow : C.green,
            '  Context window: ' + _ctxWin.toLocaleString() + ' (' + _pctUsed + '% used)'));
          const _tcState = showTokenCount ? colorize(C.green, 'on') : colorize(C.dim, 'off');
          console.log('\n  Per-response display: ' + _tcState);
          console.log(colorize(C.dim, '  /tokens on   — enable per-response token display'));
          console.log(colorize(C.dim, '  /tokens off  — disable per-response token display\n'));
          break;
        }

        // /recommend — list recommended models with install commands
        case 'recommend': {
          console.log(colorize(C.cyanBold, '\nRecommended models for Proverbs AI:\n'));
          RECOMMENDED_MODELS.forEach(function(rec) {
            const ctxLabel = rec.ctx >= 131072
              ? colorize(C.green,  rec.ctx.toLocaleString() + ' ctx')
              : rec.ctx >= 65536
                ? colorize(C.cyan,   rec.ctx.toLocaleString() + ' ctx')
                : colorize(C.yellow, rec.ctx.toLocaleString() + ' ctx');
            console.log(colorize(C.bold, '  ' + rec.name));
            console.log('    ' + ctxLabel + '  — ' + rec.note);
            console.log(colorize(C.dim, '    (served by Proverbs server)'));
            console.log('');
          });
          console.log(colorize(C.dim, 'Switch models with: /model <name>\n'));
            const _ak = process.env.ANTHROPIC_API_KEY ? 'Anthropic (direct)' : process.env.OPENAI_API_KEY ? 'OpenAI (direct)' : 'LiteLLM proxy';
            console.log(colorize(C.dim, '  Active fallback provider: ' + _ak + '\n'));
          break;
        }

        // /ml — toggle manual multi-line mode
        case 'ml': {
          if (_mlManual || _mlMode) {
            _mlMode   = false;
            _mlManual = false;
            _mlBuffer = [];
            _mlDelim  = '';
            console.log(colorize(C.yellow, 'Multi-line mode OFF\n'));
          } else {
            _mlMode   = true;
            _mlManual = true;
            _mlBuffer = [];
            _mlDelim  = '';
            console.log(colorize(C.cyan, 'Multi-line manual mode ON — paste lines, empty line to submit\n'));
          }
          break;
        }

        // /commit [message] — stage all and commit
        case 'commit': {
          const commitMsg = parts.slice(1).join(' ').trim();
          if (commitMsg) {
            // Message provided inline — commit immediately
            try {
              execSync('git -C ' + JSON.stringify(cwd) + ' add -A', { stdio: 'pipe' });
              execSync('git -C ' + JSON.stringify(cwd) + ' commit -m ' + JSON.stringify(commitMsg), { stdio: 'pipe' });
              console.log(colorize(C.green, '\n✔  Committed: ' + commitMsg + '\n'));
            } catch (e) {
              const errMsg = e.stderr ? e.stderr.toString().split('\n')[0] : e.message;
              console.log(colorize(C.red, '\n✗  Commit failed: ' + errMsg + '\n'));
            }
          } else {
            // No message — check for changes then prompt
            let gitOut2;
            try {
              gitOut2 = execSync('git -C ' + JSON.stringify(cwd) + ' status --porcelain 2>/dev/null', { encoding: 'utf8' });
            } catch (_) {
              console.log(colorize(C.red, '\n✗  Not a git repository or git not found.\n'));
              break;
            }
            if (!gitOut2 || !gitOut2.trim()) {
              console.log(colorize(C.dim, '\n(nothing to commit — working tree clean)\n'));
              break;
            }
            const nChanged = gitOut2.trim().split('\n').length;
            console.log(colorize(C.cyan, '\n  ' + nChanged + ' file(s) staged for commit.'));
            await new Promise((res) => {
              rl.pause();
              rl.question(colorize(C.cyan, '  Commit message (empty = cancel): '), (ans) => {
                rl.resume();
                const m = (ans || '').trim();
                if (!m) { console.log(colorize(C.dim, '  (cancelled)\n')); res(); return; }
                try {
                  execSync('git -C ' + JSON.stringify(cwd) + ' add -A', { stdio: 'pipe' });
                  execSync('git -C ' + JSON.stringify(cwd) + ' commit -m ' + JSON.stringify(m), { stdio: 'pipe' });
                  console.log(colorize(C.green, '  Committed: ' + m + '\n'));
                } catch (e) {
                  const errMsg = e.stderr ? e.stderr.toString().split('\n')[0] : e.message;
                  console.log(colorize(C.red, '  Commit failed: ' + errMsg + '\n'));
                }
                res();
              });
            });
          }
          break;
        }

        // /autocommit on|off — toggle auto-commit prompt after AI responses
        case 'autocommit': {
          const acArg = (parts[1] || '').toLowerCase();
          if (acArg === 'on') {
            autoCommitEnabled = true;
            saveConfig();
            console.log(colorize(C.green, '\n✔  Auto-commit enabled. You will be prompted to commit after each AI response that changes files.\n'));
          } else if (acArg === 'off') {
            autoCommitEnabled = false;
            saveConfig();
            console.log(colorize(C.dim, '\n  Auto-commit disabled.\n'));
          } else {
            const state = autoCommitEnabled
              ? colorize(C.green, 'on')
              : colorize(C.dim,   'off');
            console.log(colorize(C.cyan, '\nAuto-commit: ') + state);
            console.log(colorize(C.dim, '  /autocommit on   — prompt to commit after each AI response'));
            console.log(colorize(C.dim, '  /autocommit off  — disable auto-commit prompt\n'));
          }
          break;
        }

        // /critique on|off|threshold <n> — toggle self-critique loop
        case 'critique': {
          const crArg = (parts[1] || '').toLowerCase();
          if (crArg === 'on') {
            critiqueEnabled = true;
            saveConfig();
            console.log(colorize(C.green, '\n✔  Self-critique enabled. Code responses will be reviewed automatically.\n'));
          } else if (crArg === 'off') {
            critiqueEnabled = false;
            saveConfig();
            console.log(colorize(C.dim, '\n  Self-critique disabled.\n'));
          } else if (crArg === 'threshold') {
            const n = parseInt(parts[2], 10);
            if (!isNaN(n) && n > 0) {
              critiqueThreshold = n;
              console.log(colorize(C.green, `\n✔  Critique threshold set to ${n} lines.\n`));
            } else {
              console.log(colorize(C.red, '\n✗  Usage: /critique threshold <number>\n'));
            }
          } else {
            const state = critiqueEnabled ? colorize(C.green, 'on') : colorize(C.dim, 'off');
            console.log(colorize(C.cyan, '\nSelf-critique: ') + state + colorize(C.dim, `  (threshold: ${critiqueThreshold} lines)`));
            console.log(colorize(C.dim, '  /critique on              — Enable self-critique after code responses'));
            console.log(colorize(C.dim, '  /critique off             — Disable self-critique'));
            console.log(colorize(C.dim, `  /critique threshold <n>   — Set minimum response lines to trigger (current: ${critiqueThreshold})\n`));
          }
          break;
        }

        // /gitdiff — show git diff --stat in cwd
        case 'gitdiff': {
          let diffOut;
          try {
            diffOut = execSync('git -C ' + JSON.stringify(cwd) + ' diff --stat HEAD 2>/dev/null', { encoding: 'utf8' });
          } catch (_) {
            console.log(colorize(C.red, '\n✗  Not a git repository or git not found.\n'));
            break;
          }
          if (!diffOut || !diffOut.trim()) {
            console.log(colorize(C.dim, '\n(no changes relative to HEAD)\n'));
            break;
          }
          console.log(colorize(C.cyan, '\nGit diff --stat:\n'));
          console.log(diffOut);
          break;
        }

        // /undo — restore most recent backup, list all backups, or clear all backups
        case 'undo': {
          const undoSub = parts[1] ? parts[1].toLowerCase() : '';

          // /undo list — show the current undo stack
          if (undoSub === 'list') {
            if (undoStack.length === 0) {
              console.log(colorize(C.dim, '\n(undo stack is empty)\n'));
              break;
            }
            console.log(colorize(C.cyan, `\nUndo stack (${undoStack.length} backup${undoStack.length === 1 ? '' : 's'}, oldest first):\n`));
            undoStack.forEach((entry, i) => {
              console.log(`  ${colorize(C.bold, String(i + 1) + '.')} ${entry.originalPath}`);
            });
            console.log(colorize(C.dim, '\n  Use /undo to restore the most recent backup.\n'));
            console.log(colorize(C.dim, '  Use /undo clear to delete all backups.\n'));
            break;
          }

          // /undo clear — delete all backup files and empty the stack
          if (undoSub === 'clear') {
            if (undoStack.length === 0) {
              console.log(colorize(C.dim, '\n(undo stack is already empty)\n'));
              break;
            }
            let deleted = 0;
            let failed  = 0;
            for (const entry of undoStack) {
              try {
                fs.unlinkSync(entry.backupPath);
                deleted++;
              } catch (_) {
                failed++;
              }
            }
            undoStack = [];
            const failNote = failed > 0 ? colorize(C.yellow, ` (${failed} backup file${failed === 1 ? '' : 's'} could not be deleted)`) : '';
            console.log(colorize(C.green, `\n✔  Undo stack cleared — ${deleted} backup file${deleted === 1 ? '' : 's'} removed.${failNote}\n`));
            break;
          }

          // /undo — restore the most recent backup (default action)
          if (undoStack.length === 0) {
            // Explicit message when there is nothing on the stack yet
            console.log(colorize(C.yellow, '\nNothing to undo — no file backups exist yet.\n'));
            console.log(colorize(C.dim, '  Backups are created automatically whenever the AI writes, edits, or patches a file.\n'));
            break;
          }

          const undoEntry = undoStack.pop();
          if (!fs.existsSync(undoEntry.backupPath)) {
            // Name the original file whose backup is missing
            console.log(colorize(C.red, `\n✗  Backup file missing for ${undoEntry.originalPath} — it may have been deleted externally.\n`));
            break;
          }
          try {
            fs.copyFileSync(undoEntry.backupPath, undoEntry.originalPath);
            fs.unlinkSync(undoEntry.backupPath);
            console.log(colorize(C.green, `\n✔  Restored: ${undoEntry.originalPath}\n`));
          } catch (e) {
            // Put the entry back so the user can retry
            undoStack.push(undoEntry);
            console.log(colorize(C.red, `\n✗  Restore failed: ${e.message}\n`));
          }
          break;
        }

        // /paste — send clipboard content to the AI, optionally with a question
        case 'paste': {
          const clipContent = readClipboard();
          if (!clipContent || !clipContent.trim()) {
            console.log(colorize(C.yellow, '\n(Clipboard is empty or unreadable)\n'));
            break;
          }

          const pasteQuestion = input.slice('/paste'.length).trim();

          if (pasteQuestion) {
            // /paste <question> — send question + clipboard content immediately
            const combined = `${pasteQuestion}\n\nClipboard:\n${clipContent}`;
            syntaxRetryCount = 0;
            rl.pause();
            const pasteMessages = [
              { role: 'system', content: buildSystemPrompt() },
              ...history,
              { role: 'user', content: combined },
            ];
            try {
              const sysPrompt = pasteMessages[0].content;
              const reply = await routedAgentLoop(pasteMessages, combined);
              history.push({ role: 'user', content: combined });
              history.push({ role: 'assistant', content: reply });
              lastAssistantReply = reply;
              logExchange(sysPrompt, combined, reply);
              console.log(colorize(C.greenBold, '\nproverbs> ') + renderResponse(reply) + '\n');
              printClosingVerse();
              await showContextGauge(pasteMessages);
              if (showTokenCount) {
                const _tc = await countMessagesTokens(pasteMessages);
                const _tw = getContextWindow(model);
                console.log(colorize(C.dim, '  [~' + _tc.toLocaleString() + ' tokens used / ' + _tw.toLocaleString() + ' context]'));
              }
            } catch (err) {
              console.error(colorize(C.red, `\n✗  Error: ${err.message}\n`));
            }
            rl.resume();
            await checkAndOfferCommit(rl);
          } else {
            // /paste alone — show clipboard preview and inject into next prompt
            const preview = clipContent.length > 300
              ? clipContent.slice(0, 300) + '\n...(truncated)'
              : clipContent;
            console.log(colorize(C.cyan, '\n[Clipboard content]\n') + colorize(C.dim, preview) + '\n');
            console.log(colorize(C.dim, '  Clipboard injected. Type your question and press Enter.\n'));
            _pendingClipboard = clipContent;
          }
          break;
        }

        // /copy — copy last AI reply to clipboard
        case 'copy': {
          if (!lastAssistantReply) {
            console.log(colorize(C.yellow, '\n(no AI reply to copy yet)\n'));
            break;
          }
          const ok = writeClipboard(lastAssistantReply);
          if (ok) {
            console.log(colorize(C.green, `\n✔  Copied to clipboard (${lastAssistantReply.length} chars).\n`));
          } else {
            console.log(colorize(C.red, '\n✗  Clipboard write failed or not supported on this platform.\n'));
          }
          break;
        }

        // /scan — generate .proverbs project profile
        case 'scan': {
          const scanSpinner = new Spinner('Scanning project...');
          scanSpinner.start();
          let scanResult;
          try {
            scanResult = await runProjectScan(cwd);
          } catch (e) {
            scanSpinner.stop();
            console.log(colorize(C.red, `\n\u2717  Scan failed: ${e.message}\n`));
            break;
          }
          scanSpinner.stop();
          console.log(colorize(C.green, `\n\u2714  .proverbs written to ${cwd}`));
          console.log(colorize(C.cyan, `\n  Project : ${scanResult.name}`));
          console.log(colorize(C.cyan,  `  Stack   : ${scanResult.stack.length > 0 ? scanResult.stack.join(', ') : '(none detected)'}`));
          console.log(colorize(C.cyan,  `  Files   : ${scanResult.keyFiles.length} key file${scanResult.keyFiles.length === 1 ? '' : 's'} found`));
          if (scanResult.rules.length > 0) {
            console.log(colorize(C.cyan, `  Rules   : ${scanResult.rules.length} project rule${scanResult.rules.length === 1 ? '' : 's'} added`));
          }
          console.log(colorize(C.dim, '\n  Profile loaded into system prompt for this session.'));
          console.log(colorize(C.dim, '  Run /script create to add your own instructions.\n'));
          break;
        }

        // /script — project instruction file management (.script system)
        case 'script': {
          const scriptSub = (parts[1] || '').toLowerCase();
          if (!scriptSub) {
            if (scriptContent && scriptContent.trim()) {
              console.log(colorize(C.cyan, '\n.script content:\n'));
              console.log(scriptContent);
              console.log('');
            } else {
              console.log(colorize(C.yellow, '\nNo .script file found in ' + cwd + '\n'));
              console.log(colorize(C.dim, '  Use /script create to add one, or /script global to edit the global .script.\n'));
            }
          } else if (scriptSub === 'edit') {
            const editTarget = path.join(cwd, '.script');
            const editor = process.env.EDITOR || 'nano';
            try {
              execSync(editor + ' ' + JSON.stringify(editTarget), { stdio: 'inherit' });
              const count = loadScriptFiles(cwd);
              console.log(colorize(C.green, '\n✔  .script saved and reloaded (' + count + ' file' + (count === 1 ? '' : 's') + ' loaded).\n'));
            } catch (e) {
              console.log(colorize(C.red, '\n✗  Editor error: ' + e.message + '\n'));
            }
          } else if (scriptSub === 'reload') {
            let reloadCount;
            try {
              reloadCount = loadScriptFiles(cwd);
            } catch (e) {
              console.log(colorize(C.red, '\n✗  Reload error: ' + e.message + '\n'));
              break;
            }
            if (reloadCount === 0) {
              console.log(colorize(C.yellow, '\nLoaded 0 .script files — none found in ' + cwd + ' or ancestors.\n'));
            } else {
              console.log(colorize(C.green, '\n✔  Loaded ' + reloadCount + ' .script file' + (reloadCount === 1 ? '' : 's') + '.\n'));
            }
          } else if (scriptSub === 'create') {
            const createTarget = path.join(cwd, '.script');
            if (fs.existsSync(createTarget)) {
              console.log(colorize(C.yellow, '\n.script already exists at ' + createTarget + '\n'));
              console.log(colorize(C.dim, '  Use /script edit to modify it.\n'));
            } else {
              const tmpl = '# [Project Name] — Proverbs Instructions\n## Rules\n- [Add project-specific rules here]\n## Key Files\n- [List important files]\n## Stack Notes\n- [Framework-specific reminders]\n';
              let created = false;
              try {
                fs.writeFileSync(createTarget, tmpl, 'utf8');
                console.log(colorize(C.green, '\n✔  Created ' + createTarget + '\n'));
                created = true;
              } catch (e) {
                console.log(colorize(C.red, '\n✗  Could not create .script: ' + e.message + '\n'));
              }
              if (created) {
                const ed2 = process.env.EDITOR || 'nano';
                try {
                  execSync(ed2 + ' ' + JSON.stringify(createTarget), { stdio: 'inherit' });
                  const cnt2 = loadScriptFiles(cwd);
                  console.log(colorize(C.green, '\n✔  .script saved and loaded (' + cnt2 + ' file' + (cnt2 === 1 ? '' : 's') + ' loaded).\n'));
                } catch (e) {
                  console.log(colorize(C.yellow, '\n  Editor closed with error: ' + e.message + '. File was created.\n'));
                }
              }
            }
          } else if (scriptSub === 'global') {
            if (!fs.existsSync(GLOBAL_SCRIPT_PATH)) {
              const gTmpl = '# Global Proverbs Instructions\n## Rules\n- [Add global rules here — these apply to every project]\n';
              let gCreated = false;
              try {
                fs.mkdirSync(PROVERBS_DIR, { recursive: true });
                fs.writeFileSync(GLOBAL_SCRIPT_PATH, gTmpl, 'utf8');
                console.log(colorize(C.dim, '  Created ' + GLOBAL_SCRIPT_PATH + '\n'));
                gCreated = true;
              } catch (e) {
                console.log(colorize(C.red, '\n✗  Could not create global .script: ' + e.message + '\n'));
              }
              if (!gCreated) break;
            }
            const ed3 = process.env.EDITOR || 'nano';
            try {
              execSync(ed3 + ' ' + JSON.stringify(GLOBAL_SCRIPT_PATH), { stdio: 'inherit' });
              const cnt3 = loadScriptFiles(cwd);
              console.log(colorize(C.green, '\n✔  Global .script saved and reloaded (' + cnt3 + ' file' + (cnt3 === 1 ? '' : 's') + ' loaded).\n'));
            } catch (e) {
              console.log(colorize(C.red, '\n✗  Editor error: ' + e.message + '\n'));
            }
          } else {
            console.log(colorize(C.red, '\n✗  Unknown /script subcommand: "' + (parts[1] || '') + '"\n'));
            console.log(colorize(C.dim, '    /script               — show loaded .script content'));
            console.log(colorize(C.dim, '    /script edit          — open cwd/.script in $EDITOR'));
            console.log(colorize(C.dim, '    /script reload        — re-read .script files for current cwd'));
            console.log(colorize(C.dim, '    /script create        — write starter template + open in editor'));
            console.log(colorize(C.dim, '    /script global        — open global ~/.proverbs/.script in editor\n'));
          }
          break;
        }

        // /tscheck [on|off] — run tsc --noEmit or toggle tsCheckEnabled
        case 'tscheck': {
          const tcArg = (parts[1] || '').toLowerCase();
          if (tcArg === 'on') {
            tsCheckEnabled = true;
            saveConfig();
            console.log(colorize(C.green, '\n✔  TS type-checking enabled after file writes.\n'));
          } else if (tcArg === 'off') {
            tsCheckEnabled = false;
            saveConfig();
            console.log(colorize(C.dim, '\n  TS type-checking disabled.\n'));
          } else {
            // Run tsc --noEmit in cwd and display output
            const tcSpinner = new Spinner('Running tsc --noEmit...');
            tcSpinner.start();
            const tsErrors = runTsCheck(cwd);
            tcSpinner.stop();
            if (tsErrors === null) {
              // Determine if no tsconfig or no errors
              let tcDir = cwd;
              let tcFound = false;
              for (let i = 0; i < 5; i++) {
                if (fs.existsSync(path.join(tcDir, 'tsconfig.json'))) { tcFound = true; break; }
                const tcParent = path.dirname(tcDir);
                if (tcParent === tcDir) break;
                tcDir = tcParent;
              }
              if (!tcFound) {
                console.log(colorize(C.yellow, '\n  No tsconfig.json found in this directory or any parent.\n'));
              } else {
                console.log(colorize(C.green, '\n✔  No TypeScript errors found.\n'));
              }
            } else {
              console.log(colorize(C.red, '\nTS ERRORS:\n') + tsErrors + '\n');
            }
            const tcState = tsCheckEnabled ? colorize(C.green, 'on') : colorize(C.dim, 'off');
            console.log(colorize(C.dim, '  Auto-check after file writes: ') + tcState);
            console.log(colorize(C.dim, '  /tscheck on   — enable auto-check after write_file/edit_file/patch_file'));
            console.log(colorize(C.dim, '  /tscheck off  — disable auto-check\n'));
          }
          break;
        }

        // /lint [on|off|<path>] — run eslint on a file or toggle eslintCheckEnabled
        case 'lint': {
          const lintArg = (parts[1] || '').toLowerCase();
          if (lintArg === 'on') {
            eslintCheckEnabled = true;
            console.log(colorize(C.green, '\n✔  ESLint checking enabled after file writes.\n'));
          } else if (lintArg === 'off') {
            eslintCheckEnabled = false;
            console.log(colorize(C.dim, '\n  ESLint checking disabled.\n'));
          } else if (parts[1]) {
            // /lint <path> — run eslint on the specified file
            const lintTarget = resolvePath(parts[1]);
            if (!fs.existsSync(lintTarget)) {
              console.log(colorize(C.red, `\n✗  File not found: ${lintTarget}\n`));
              break;
            }
            const lintSpinner = new Spinner('Running eslint...');
            lintSpinner.start();
            const lintResult = runEslintCheck(lintTarget);
            lintSpinner.stop();
            if (lintResult === null) {
              const lintDir = path.dirname(lintTarget);
              const lintConfigNames = [
                '.eslintrc.js', '.eslintrc.json', '.eslintrc.ts',
                'eslint.config.js', 'eslint.config.ts',
              ];
              const lintHasConfig = lintConfigNames.some(f => {
                let d = lintDir;
                for (let i = 0; i < 4; i++) {
                  if (fs.existsSync(path.join(d, f))) return true;
                  const p = path.dirname(d);
                  if (p === d) break;
                  d = p;
                }
                return false;
              });
              if (!lintHasConfig) {
                console.log(colorize(C.yellow, '\n  No ESLint config found for this file.\n'));
              } else {
                console.log(colorize(C.green, `\n✔  No ESLint issues found in ${lintTarget}.\n`));
              }
            } else {
              console.log(colorize(C.yellow, '\nESLINT WARNINGS:\n') + lintResult + '\n');
            }
          } else {
            const lintState = eslintCheckEnabled ? colorize(C.green, 'on') : colorize(C.dim, 'off');
            console.log(colorize(C.cyan, '\nESLint auto-check: ') + lintState);
            console.log(colorize(C.dim, '  /lint <path>  — Run ESLint on a specific file'));
            console.log(colorize(C.dim, '  /lint on      — Enable auto-check after write_file/edit_file/patch_file'));
            console.log(colorize(C.dim, '  /lint off     — Disable ESLint auto-check\n'));
          }
          break;
        }

        case 'db': {
          const dbSub = (parts[1] || '').toLowerCase();
          const schemaPath = path.join(cwd, 'prisma', 'schema.prisma');
          const hasPrisma = fs.existsSync(schemaPath);

          if (!dbSub || dbSub === 'status') {
            if (hasPrisma) {
              const stat = fs.statSync(schemaPath);
              console.log(colorize(C.green, '\n✔  prisma/schema.prisma found'));
              console.log(colorize(C.dim, `   Last modified: ${stat.mtime.toLocaleString()}\n`));
            } else {
              console.log(colorize(C.yellow, '\n  No prisma/schema.prisma found in cwd\n'));
            }
            console.log(colorize(C.cyan, '  /db subcommands:'));
            console.log(colorize(C.dim, '  /db migrate    — npx prisma migrate dev'));
            console.log(colorize(C.dim, '  /db push       — npx prisma db push'));
            console.log(colorize(C.dim, '  /db generate   — npx prisma generate'));
            console.log(colorize(C.dim, '  /db studio     — open Prisma Studio at http://localhost:5555'));
            console.log(colorize(C.dim, '  /db reset      — delete all data + re-run migrations\n'));
            break;
          }

          if (!hasPrisma) {
            console.log(colorize(C.yellow, '\n  No prisma/schema.prisma found in cwd\n'));
            break;
          }

          if (dbSub === 'migrate' || dbSub === 'migrate dev') {
            const dbSpinner = new Spinner('Running prisma migrate dev...');
            dbSpinner.start();
            try {
              execSync('npx prisma migrate dev', { cwd, stdio: 'inherit', timeout: 120000 });
              dbSpinner.stop();
              console.log(colorize(C.green, '\n✔  Migration complete.\n'));
            } catch (e) {
              dbSpinner.stop();
              console.log(colorize(C.red, `\n✗  Migration failed: ${e.message}\n`));
            }
          } else if (dbSub === 'push') {
            const dbSpinner = new Spinner('Running prisma db push...');
            dbSpinner.start();
            try {
              execSync('npx prisma db push', { cwd, stdio: 'inherit', timeout: 120000 });
              dbSpinner.stop();
              console.log(colorize(C.green, '\n✔  DB push complete.\n'));
            } catch (e) {
              dbSpinner.stop();
              console.log(colorize(C.red, `\n✗  DB push failed: ${e.message}\n`));
            }
          } else if (dbSub === 'generate') {
            const dbSpinner = new Spinner('Running prisma generate...');
            dbSpinner.start();
            try {
              execSync('npx prisma generate', { cwd, stdio: 'inherit', timeout: 120000 });
              dbSpinner.stop();
              console.log(colorize(C.green, '\n✔  Prisma client generated.\n'));
            } catch (e) {
              dbSpinner.stop();
              console.log(colorize(C.red, `\n✗  Generate failed: ${e.message}\n`));
            }
          } else if (dbSub === 'studio') {
            const { spawn: dbSpawn } = require('child_process');
            const studioProc = dbSpawn('npx', ['prisma', 'studio'], { cwd, stdio: 'ignore', detached: true, shell: false });
            studioProc.unref();
            console.log(colorize(C.green, '\n✔  Prisma Studio opening at http://localhost:5555\n'));
          } else if (dbSub === 'reset') {
            console.log(colorize(C.yellow, '\n  WARNING: This will DELETE all data and re-run migrations.'));
            rl.question(colorize(C.yellow, "  Type 'yes' to confirm: "), (answer) => {
              if (answer.trim().toLowerCase() === 'yes') {
                const dbSpinner = new Spinner('Resetting database...');
                dbSpinner.start();
                try {
                  execSync('npx prisma migrate reset --force', { cwd, stdio: 'inherit', timeout: 120000 });
                  dbSpinner.stop();
                  console.log(colorize(C.green, '\n✔  Database reset complete.\n'));
                } catch (e) {
                  dbSpinner.stop();
                  console.log(colorize(C.red, `\n✗  Reset failed: ${e.message}\n`));
                }
              } else {
                console.log(colorize(C.dim, '\n  Reset cancelled.\n'));
              }
              rl.prompt();
            });
          } else {
            console.log(colorize(C.yellow, `\n  Unknown /db subcommand: ${parts[1]}\n`));
          }
          break;
        }

        // ══════════════════════════════════════════════════════════════════
        // 1. /switch <project> — instant project jump with context memory
        // ══════════════════════════════════════════════════════════════════
        case 'switch': {
          const swName = parts.slice(1).join(' ').toLowerCase().trim();
          if (!swName) {
            // Show all projects with last-worked-on time
            const all = discoverClaudeProjects ? discoverClaudeProjects() : [];
            const mem = _loadProjectContextMemory();
            console.log(colorize('\n  Projects (' + all.length + ')\n', C.cyan));
            all.sort((a,b) => {
              const ta = mem[a.path] ? mem[a.path].lastSeen : 0;
              const tb = mem[b.path] ? mem[b.path].lastSeen : 0;
              return tb - ta;
            }).slice(0,30).forEach(p => {
              const m = mem[p.path];
              const age = m ? colorize('  ' + _relTime(m.lastSeen), C.dim) : '';
              const last = m && m.lastTask ? colorize('  "' + m.lastTask.slice(0,50) + '"', C.dim) : '';
              console.log('  ' + colorize(p.name.padEnd(30), C.bold) + age + last);
            });
            console.log(colorize('\n  Usage: /switch <name>\n', C.dim));
            break;
          }
          const all2 = discoverClaudeProjects ? discoverClaudeProjects() : [];
          const match = all2.find(p => p.name.toLowerCase() === swName)
                     || all2.find(p => p.name.toLowerCase().includes(swName));
          if (!match) { console.log(colorize('\n  No project matching "' + swName + '". Run /switch to see all.\n', C.yellow)); break; }

          // Save context for current project before switching
          if (history.length > 0) {
            const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
            _saveProjectContextMemory(cwd, lastUserMsg ? lastUserMsg.content : '');
          }

          // Switch
          cwd = match.path;
          try { process.chdir(cwd); } catch(_) {}
          history = [];
          detectedFrameworks = detectFrameworks ? detectFrameworks(cwd) : [];
          detectedConventions = detectConventions ? detectConventions(cwd) : [];
          loadGitContext(cwd);
          sessionContextFiles = [];
          try { loadScriptFiles(cwd); } catch(_) {}
          try { loadProverbsProfile(cwd); } catch(_) {}
          try { runIndex(cwd, true); } catch(_) {}

          console.log(colorize('\n  ✔ Switched to: ' + match.name, C.green));
          console.log(colorize('    ' + cwd, C.dim));
          if (match.stack) console.log(colorize('    Stack: ' + match.stack, C.dim));

          // Restore last context if any
          const mem2 = _loadProjectContextMemory();
          const saved = mem2[cwd];
          if (saved && saved.lastTask) {
            console.log(colorize('\n  Last session: "' + saved.lastTask.slice(0,80) + '"', C.yellow));
            console.log(colorize('  ' + _relTime(saved.lastSeen) + ' ago', C.dim));
            console.log(colorize('  Continue where you left off, or start fresh.\n', C.dim));
          } else { console.log(''); }
          break;
        }

        // ══════════════════════════════════════════════════════════════════
        // 2. /ship — run deploy-verify.sh (your real deploy pipeline)
        // ══════════════════════════════════════════════════════════════════
        case 'ship': {
          const shipScript = path.join(cwd, 'scripts', 'deploy-verify.sh');
          const globalScript = path.join(os.homedir(), 'scripts', 'deploy-verify.sh');
          const scriptToRun = fs.existsSync(shipScript) ? shipScript
                            : fs.existsSync(globalScript) ? globalScript : null;
          if (!scriptToRun) {
            console.log(colorize('\n  ✗  No deploy-verify.sh found.\n', C.red));
            console.log(colorize('  Expected: ' + shipScript, C.dim));
            console.log(colorize('  Fix: mkdir -p scripts && cp ~/scripts/deploy-verify.sh scripts/ && chmod +x scripts/deploy-verify.sh\n', C.yellow));
            break;
          }
          const shipSub = (parts[1] || '').toLowerCase();
          const isDry = shipSub === '--dry-run' || shipSub === 'dry';
          console.log(colorize('\n  ' + (isDry ? 'Dry run: ' : 'Deploying: ') + path.basename(cwd), C.cyan));
          console.log(colorize('  Script: ' + scriptToRun + '\n', C.dim));
          rl.pause();
          const shipArgs = isDry ? ['--dry-run'] : [];
          const shipProc = require('child_process').spawn('bash', [scriptToRun, ...shipArgs], { cwd, stdio: 'inherit', shell: false });
          shipProc.on('exit', (code) => {
            if (code === 0) {
              console.log(colorize('\n  ✔  Deploy verified and live.\n', C.green));
              _saveProjectContextMemory(cwd, 'deployed to production');
            } else {
              console.log(colorize('\n  ✗  Deploy failed (exit ' + code + ') — check output above.\n', C.red));
            }
            rl.resume(); rl.prompt();
          });
          return;
        }

        // ══════════════════════════════════════════════════════════════════
        // 3. /diff — uncommitted changes across all your projects
        // ══════════════════════════════════════════════════════════════════
        case 'diff': {
          const diffSub = (parts[1] || '').toLowerCase();
          if (diffSub === 'all') {
            // Scan all registered projects for uncommitted changes
            const allProj = discoverClaudeProjects ? discoverClaudeProjects() : [];
            const dirty = [];
            const sp3 = new Spinner('Scanning ' + allProj.length + ' projects...');
            sp3.start();
            for (const p of allProj) {
              try {
                const out = require('child_process').execSync(
                  'git -C ' + JSON.stringify(p.path) + ' status --porcelain 2>/dev/null', { encoding: 'utf8', timeout: 3000 }
                ).trim();
                if (out) dirty.push({ name: p.name, path: p.path, lines: out.split('\n').length });
              } catch(_) {}
            }
            sp3.stop();
            if (!dirty.length) { console.log(colorize('\n  All projects clean — no uncommitted changes.\n', C.green)); break; }
            console.log(colorize('\n  Projects with uncommitted changes (' + dirty.length + '):\n', C.yellow));
            dirty.forEach(d => console.log('  ' + colorize(d.name.padEnd(32), C.bold) + colorize(d.lines + ' change(s)', C.dim) + colorize('  ' + d.path, C.dim)));
            console.log('');
          } else {
            // Show diff for current project
            try {
              const stat = require('child_process').execSync('git -C ' + JSON.stringify(cwd) + ' status --short', { encoding: 'utf8' }).trim();
              const diff = require('child_process').execSync('git -C ' + JSON.stringify(cwd) + ' diff --stat HEAD 2>/dev/null || git -C ' + JSON.stringify(cwd) + ' diff --stat', { encoding: 'utf8', shell: true }).trim();
              if (!stat) { console.log(colorize('\n  Working tree clean.\n', C.green)); break; }
              console.log(colorize('\n  ' + path.basename(cwd) + ' — uncommitted changes:\n', C.cyan));
              console.log(stat.split('\n').map(l => '  ' + colorize(l, l.startsWith('M') ? C.yellow : l.startsWith('?') ? C.dim : C.green)).join('\n'));
              if (diff) { console.log('\n' + diff.split('\n').map(l => '  ' + colorize(l, C.dim)).join('\n')); }
              console.log(colorize('\n  /diff all — scan all projects\n', C.dim));
            } catch(e) { console.log(colorize('\n  ' + e.message + '\n', C.red)); }
          }
          break;
        }

        // ══════════════════════════════════════════════════════════════════
        // 4. /multi <task> @proj1 @proj2 — same change across many projects
        // ══════════════════════════════════════════════════════════════════
        case 'multi': {
          // Parse: /multi add dark mode @tuffbets @vybe-engine @command-hq
          const multiInput = parts.slice(1).join(' ');
          const atMatches = multiInput.match(/@([\w-]+)/g) || [];
          const task = multiInput.replace(/@[\w-]+/g, '').trim();
          if (!task || !atMatches.length) {
            console.log(colorize('\n  Usage: /multi <task> @project1 @project2 ...\n', C.yellow));
            console.log(colorize('  Example: /multi add dark mode toggle @tuffbets @vybe-engine @command-hq\n', C.dim));
            break;
          }
          const allProj2 = discoverClaudeProjects ? discoverClaudeProjects() : [];
          const targets = atMatches.map(a => {
            const n = a.slice(1).toLowerCase();
            return allProj2.find(p => p.name.toLowerCase() === n) || allProj2.find(p => p.name.toLowerCase().includes(n));
          }).filter(Boolean);
          if (!targets.length) { console.log(colorize('\n  No matching projects found.\n', C.red)); break; }
          console.log(colorize('\n  Multi-project task: "' + task + '"', C.cyan));
          console.log(colorize('  Targets: ' + targets.map(t => t.name).join(', ') + '\n', C.dim));
          for (const target of targets) {
            console.log(colorize('  ── ' + target.name + ' ──────────────────────', C.yellow));
            const prevCwd = cwd;
            cwd = target.path;
            try { process.chdir(cwd); } catch(_) {}
            detectedFrameworks = detectFrameworks ? detectFrameworks(cwd) : [];
            detectedConventions = detectConventions ? detectConventions(cwd) : [];
            loadGitContext(cwd);
            try { loadScriptFiles(cwd); } catch(_) {}
            try { loadProverbsProfile(cwd); } catch(_) {}
            const multiPrompt = task + '\n\nProject: ' + target.name + ' at ' + target.path;
            const multiMsgs = [{ role: 'system', content: buildSystemPrompt() }, { role: 'user', content: multiPrompt }];
            try {
              const reply = await agentLoop(multiMsgs, multiPrompt);
              if (reply && reply !== '[interrupted]') console.log(renderMarkdown(reply));
            } catch(e) { console.log(colorize('  ✗ Error in ' + target.name + ': ' + e.message, C.red)); }
            cwd = prevCwd;
            try { process.chdir(cwd); } catch(_) {}
            console.log('');
          }
          console.log(colorize('  ✔  Multi-task complete across ' + targets.length + ' projects.\n', C.green));
          break;
        }

        // ══════════════════════════════════════════════════════════════════
        // 5. /pr — generate PR with real title+body from diff, push, open
        // ══════════════════════════════════════════════════════════════════
        case 'pr': {
          const prSub = (parts[1] || '').toLowerCase();
          const { execSync: prExec, spawn: prSpawn } = require('child_process');
          try {
            // Get diff summary for AI to write PR description
            const branch = prExec('git -C ' + JSON.stringify(cwd) + ' rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
            const diffStat = prExec('git -C ' + JSON.stringify(cwd) + ' diff --stat origin/main...HEAD 2>/dev/null || git diff --stat HEAD~1 2>/dev/null', { encoding: 'utf8', shell: true }).trim().slice(0, 2000);
            const logStr = prExec('git -C ' + JSON.stringify(cwd) + ' log --oneline origin/main..HEAD 2>/dev/null || git log --oneline -10 2>/dev/null', { encoding: 'utf8', shell: true }).trim().slice(0, 1000);

            if (prSub === 'push') {
              // Just push without creating PR
              prExec('git -C ' + JSON.stringify(cwd) + ' push -u origin ' + branch, { stdio: 'inherit', encoding: 'utf8' });
              console.log(colorize('\n  ✔  Pushed: ' + branch + '\n', C.green));
              break;
            }

            console.log(colorize('\n  Generating PR description from diff...\n', C.dim));
            const prPrompt = `You are writing a GitHub Pull Request for the branch "${branch}" in project "${path.basename(cwd)}".

Commits:
${logStr}

Changed files:
${diffStat}

Write a PR in this exact format:
TITLE: <concise title under 72 chars — what changed, not how>
BODY:
## What changed
<2-4 bullet points>

## Why
<1-2 sentences>

## Test
<what to check>

Keep it tight. No fluff.`;
            const prMsgs = [{ role: 'system', content: 'You write precise, technical GitHub pull request descriptions.' }, { role: 'user', content: prPrompt }];
            const prSpin = new Spinner('Writing PR description...');
            prSpin.start();
            let prReply = '';
            try { prReply = await agentLoop(prMsgs, prPrompt); } finally { prSpin.stop(); }

            const titleMatch = prReply.match(/TITLE:\s*(.+)/);
            const bodyMatch  = prReply.match(/BODY:\s*([\s\S]+)/);
            const prTitle = titleMatch ? titleMatch[1].trim() : branch;
            const prBody  = bodyMatch  ? bodyMatch[1].trim()  : prReply;

            console.log(colorize('\n  PR Title: ', C.cyan) + prTitle);
            console.log(colorize('  Branch:   ', C.dim)   + branch + '\n');

            // Push branch
            console.log(colorize('  Pushing branch...', C.dim));
            prExec('git -C ' + JSON.stringify(cwd) + ' push -u origin ' + branch + ' 2>&1', { encoding: 'utf8', shell: true });

            // Create PR with gh if available
            try {
              prExec('which gh', { stdio: 'pipe' });
              const ghCmd = 'gh pr create --title ' + JSON.stringify(prTitle) + ' --body ' + JSON.stringify(prBody);
              const prUrl = prExec(ghCmd, { cwd, encoding: 'utf8', shell: true }).trim();
              console.log(colorize('\n  ✔  PR created: ' + prUrl + '\n', C.green));
            } catch(_) {
              console.log(colorize('\n  ✔  Branch pushed. Create PR at:', C.green));
              try {
                const remote = prExec('git -C ' + JSON.stringify(cwd) + ' remote get-url origin', { encoding: 'utf8' }).trim()
                  .replace('git@github.com:', 'https://github.com/').replace('.git','');
                console.log(colorize('  ' + remote + '/compare/' + branch + '\n', C.cyan));
              } catch(_) {}
              console.log(colorize('  Body:\n\n' + prBody + '\n', C.dim));
            }
          } catch(e) { console.log(colorize('\n  ✗  ' + e.message + '\n', C.red)); }
          break;
        }

        // ══════════════════════════════════════════════════════════════════
        // 6. Context memory helpers (used by /switch, auto-saved on exit)
        // ══════════════════════════════════════════════════════════════════

        // ══════════════════════════════════════════════════════════════════
        // 7. /finetune mine — train on all 106 of your projects
        // ══════════════════════════════════════════════════════════════════
        case 'mine': {
          // Collect code from all RAXX projects → format → kick off fine-tune
          const mineDir  = path.join(os.homedir(), '.proverbs', 'finetune_data');
          const outFile  = path.join(mineDir, 'mine_' + Date.now() + '.jsonl');
          fs.mkdirSync(mineDir, { recursive: true });
          const allProj3 = discoverClaudeProjects ? discoverClaudeProjects() : [];
          const codePaths = allProj3.filter(p => p.hasPkg).map(p => p.path);
          console.log(colorize('\n  Mining ' + codePaths.length + ' projects for training data...\n', C.cyan));
          const sp4 = new Spinner('Extracting code patterns...');
          sp4.start();
          let examples = 0;
          const lines = [];
          const EXT = new Set(['.ts','.tsx','.js','.jsx','.py']);
          const SKIP = new Set(['node_modules','.git','dist','.next','build','.vercel']);
          function walkMine(dir, depth) {
            if (depth > 4) return;
            try {
              for (const f of fs.readdirSync(dir)) {
                if (SKIP.has(f)) continue;
                const fp = path.join(dir, f);
                try {
                  const st = fs.statSync(fp);
                  if (st.isDirectory()) { walkMine(fp, depth+1); continue; }
                  if (!EXT.has(path.extname(f))) continue;
                  const code = fs.readFileSync(fp, 'utf8');
                  if (code.length < 100 || code.length > 8000) continue;
                  // Format as instruction→response pair
                  const rel = fp.replace(os.homedir(), '~');
                  lines.push(JSON.stringify({
                    messages: [
                      { role: 'system', content: 'You are Proverbs, an expert coding assistant that writes code exactly like this codebase.' },
                      { role: 'user',   content: 'Show me the contents of ' + rel },
                      { role: 'assistant', content: code },
                    ]
                  }));
                  examples++;
                } catch(_) {}
              }
            } catch(_) {}
          }
          for (const p of codePaths) walkMine(p, 0);
          sp4.stop();
          fs.writeFileSync(outFile, lines.join('\n'));
          console.log(colorize('  ✔  Extracted ' + examples + ' examples → ' + outFile, C.green));
          console.log(colorize('  Running fine-tune pipeline...', C.dim));
          const ftPy = path.join(os.homedir(), 'proverbs', 'finetune', 'finetune_qwen.py');
          if (!fs.existsSync(ftPy)) { console.log(colorize('  ✗  Fine-tune script not found: ' + ftPy, C.red)); break; }
          const venv = _venvPython();
          const pyBin = fs.existsSync(venv) ? venv : 'python3';
          const ftProc = require('child_process').spawn(pyBin, [ftPy, '--data', outFile], { stdio: 'inherit' });
          ftProc.on('exit', code => {
            if (code === 0) console.log(colorize('\n  ✔  Fine-tune complete. Restart Proverbs to use updated model.\n', C.green));
            else console.log(colorize('\n  ✗  Fine-tune failed (exit ' + code + ').\n', C.red));
            rl.resume(); rl.prompt();
          });
          rl.pause();
          return;
        }

        case 'deploy': {
          const deploySub  = (parts[1] || '').toLowerCase();
          const deploySub2 = (parts[2] || '').toLowerCase();
          const { spawn: deploySpawn } = require('child_process');

          const hasVercel   = fs.existsSync(path.join(cwd, 'vercel.json')) || fs.existsSync(path.join(cwd, '.vercel'));
          const hasSupabase = fs.existsSync(path.join(cwd, 'supabase'));
          const hasNetlify  = fs.existsSync(path.join(cwd, 'netlify.toml'));

          if (!deploySub || deploySub === 'status') {
            console.log(colorize(C.cyan, '\n  Deploy targets detected:'));
            if (hasVercel)   console.log(colorize(C.green, '  ✔  vercel    (vercel.json / .vercel found)'));
            if (hasSupabase) console.log(colorize(C.green, '  ✔  supabase  (supabase/ dir found)'));
            if (hasNetlify)  console.log(colorize(C.green, '  ✔  netlify   (netlify.toml found)'));
            if (!hasVercel && !hasSupabase && !hasNetlify)
              console.log(colorize(C.dim, '  (none detected in cwd)'));
            console.log(colorize(C.cyan, '\n  /deploy subcommands:'));
            console.log(colorize(C.dim, '  /deploy vercel           — npx vercel --prod --yes'));
            console.log(colorize(C.dim, '  /deploy vercel preview   — npx vercel --yes'));
            console.log(colorize(C.dim, '  /deploy supabase         — npx supabase db push'));
            console.log(colorize(C.dim, '  /deploy functions        — npx supabase functions deploy'));
            console.log(colorize(C.dim, '  /deploy types            — supabase gen types typescript → types/supabase.ts\n'));
            break;
          }

          if (deploySub === 'vercel') {
            const isPreview = deploySub2 === 'preview';
            const vercelArgs = isPreview ? ['vercel', '--yes'] : ['vercel', '--prod', '--yes'];
            const vercelSpinner = new Spinner(isPreview ? 'Deploying preview to Vercel...' : 'Deploying to Vercel...');
            rl.pause();
            vercelSpinner.start();
            const vercelProc = deploySpawn('npx', vercelArgs, { cwd, stdio: 'inherit', shell: false });
            vercelProc.on('exit', (code) => {
              vercelSpinner.stop();
              console.log(code === 0
                ? colorize(C.green, '\n✔  Deployed to Vercel.\n')
                : colorize(C.red, `\n✗  Vercel deploy failed (exit ${code}).\n`));
              rl.resume(); rl.prompt();
            });
          } else if (deploySub === 'supabase') {
            const sbSpinner = new Spinner('Running supabase db push...');
            rl.pause(); sbSpinner.start();
            const sbProc = deploySpawn('npx', ['supabase', 'db', 'push'], { cwd, stdio: 'inherit', shell: false });
            sbProc.on('exit', (code) => {
              sbSpinner.stop();
              console.log(code === 0
                ? colorize(C.green, '\n✔  Supabase DB push complete.\n')
                : colorize(C.red, `\n✗  Supabase DB push failed (exit ${code}).\n`));
              rl.resume(); rl.prompt();
            });
          } else if (deploySub === 'functions') {
            const fnSpinner = new Spinner('Deploying Supabase functions...');
            rl.pause(); fnSpinner.start();
            const fnProc = deploySpawn('npx', ['supabase', 'functions', 'deploy'], { cwd, stdio: 'inherit', shell: false });
            fnProc.on('exit', (code) => {
              fnSpinner.stop();
              console.log(code === 0
                ? colorize(C.green, '\n✔  Supabase functions deployed.\n')
                : colorize(C.red, `\n✗  Functions deploy failed (exit ${code}).\n`));
              rl.resume(); rl.prompt();
            });
          } else if (deploySub === 'types') {
            const typesSpinner = new Spinner('Generating Supabase TypeScript types...');
            rl.pause(); typesSpinner.start();
            const typesProc = deploySpawn('sh', ['-c', 'npx supabase gen types typescript --local > types/supabase.ts'], { cwd, stdio: 'inherit', shell: false });
            typesProc.on('exit', (code) => {
              typesSpinner.stop();
              console.log(code === 0
                ? colorize(C.green, '\n✔  Types written to types/supabase.ts\n')
                : colorize(C.red, `\n✗  Type generation failed (exit ${code}).\n`));
              rl.resume(); rl.prompt();
            });
          } else {
            console.log(colorize(C.yellow, `\n  Unknown /deploy subcommand: ${parts[1]}\n`));
          }
          break;
        }

        case 'task': {
          const sub = parts[1];
          function fmtStatus(s) { return { todo: colorize(C.dim,'○ todo'), in_progress: colorize(C.cyan,'◑ in_progress'), completed: colorize(C.green,'● completed'), failed: colorize(C.red,'✗ failed'), cancelled: colorize(C.yellow,'⊘ cancelled') }[s] || s; }
          function printTasks(list) {
            if (!list.length) { console.log(colorize(C.dim,'  No tasks.\n')); return; }
            console.log(colorize(C.dim,`\n  ${'ID'.padEnd(8)}${'STATUS'.padEnd(22)}${'TITLE'.padEnd(52)}UPDATED`));
            list.forEach(t => console.log(`  ${t.id.slice(0,7).padEnd(8)}${fmtStatus(t.status).padEnd(22)}${(t.title||'').slice(0,50).padEnd(52)}${(t.updatedAt||'').slice(0,10)}`));
            console.log('');
          }
          if (!sub || sub === 'help') {
            console.log(colorize(C.cyan,'\n  /task subcommands:'));
            ['list [status]','create <title>','get <id>','done <id>','fail <id>','cancel <id>','delete <id>','output <id> <text>'].forEach(c => console.log('    ' + c));
            console.log('');
          } else if (sub === 'list') {
            const f = parts[2]; printTasks(f ? taskStore.filter(t => t.status === f) : taskStore.slice());
          } else if (sub === 'create') {
            let title = parts.slice(2).join(' ').trim();
            if (!title) title = await new Promise(r => rl.question(colorize(C.cyan,'  Task title: '), r));
            if (!title.trim()) { console.log(colorize(C.yellow,'\n  Cancelled.\n')); break; }
            const t = taskCreate(title.trim());
            console.log(colorize(C.green,`\n  Created task ${t.id}: ${t.title}\n`));
          } else if (sub === 'get') {
            const t = taskGet(parts[2]);
            if (!t) { console.log(colorize(C.red,`\n  Not found: ${parts[2]}\n`)); break; }
            console.log('\n' + JSON.stringify(t, null, 2) + '\n');
          } else if (['done','fail','cancel'].includes(sub)) {
            const map = { done:'completed', fail:'failed', cancel:'cancelled' };
            const t = taskUpdate(parts[2], { status: map[sub] });
            if (!t) { console.log(colorize(C.red,`\n  Not found: ${parts[2]}\n`)); break; }
            notify(t.title, `Status → ${map[sub]}`);
            console.log(`  ${fmtStatus(map[sub])} — ${t.id}: ${t.title}\n`);
          } else if (sub === 'delete') {
            const idx = taskStore.findIndex(t => t.id === parts[2] || t.id.startsWith(parts[2]));
            if (idx === -1) { console.log(colorize(C.red,`\n  Not found: ${parts[2]}\n`)); break; }
            const [r] = taskStore.splice(idx, 1); saveTasks();
            console.log(colorize(C.yellow,`\n  Deleted ${r.id}: ${r.title}\n`));
          } else if (sub === 'output') {
            const t = taskAppendOutput(parts[2], parts.slice(3).join(' '));
            if (!t) { console.log(colorize(C.red,`\n  Not found: ${parts[2]}\n`)); break; }
            console.log(colorize(C.green,`\n  Output appended to ${t.id}\n`));
          } else { console.log(colorize(C.yellow,`\n  Unknown: ${sub}. Try /task help\n`)); }
          break;
        }

        case 'notify': {
          const msg = parts.slice(1).join(' ').trim();
          if (!msg) { console.log(colorize(C.yellow,'\n  Usage: /notify <message>\n')); break; }
          notify('Proverbs', msg);
          console.log(colorize(C.green,'\n  Notification sent.\n'));
          break;
        }

        case 'monitor': {
          const sub  = parts[1] || 'list';
          const arg2 = parts[2] || '';
          if (sub === 'list') {
            const pids = Object.keys(bgProcesses);
            if (!pids.length) { console.log(colorize(C.dim,'\n  No tracked background processes.\n')); break; }
            console.log(colorize(C.dim,`\n  ${'PID'.padEnd(8)}${'STATUS'.padEnd(14)}${'LINES'.padEnd(7)}CMD`));
            pids.forEach(pid => {
              const e = bgProcesses[pid];
              const st = e.exitCode === null ? colorize(C.green,'running') : colorize(e.exitCode === 0 ? C.dim : C.red,'exited:'+e.exitCode);
              console.log(`  ${String(pid).padEnd(8)}${st.padEnd(14)}${String(e.lines.length).padEnd(7)}${e.cmd.slice(0,60)}`);
            });
            console.log('');
          } else if (sub === 'kill') {
            if (!arg2 || !bgProcesses[arg2]) { console.log(colorize(C.red,`\n  No process: ${arg2}\n`)); break; }
            try { process.kill(parseInt(arg2), 'SIGTERM'); bgProcesses[arg2].exitCode = -1; console.log(colorize(C.yellow,`\n  Sent SIGTERM to ${arg2}\n`)); } catch(e) { console.log(colorize(C.red,'\n  '+e.message+'\n')); }
          } else if (sub === 'clear') {
            const before = Object.keys(bgProcesses).length;
            Object.keys(bgProcesses).forEach(pid => { if (bgProcesses[pid].exitCode !== null) delete bgProcesses[pid]; });
            console.log(colorize(C.dim,`\n  Cleared ${before - Object.keys(bgProcesses).length} exited process(es).\n`));
          } else {
            // /monitor <pid> [tail]
            const entry = bgProcesses[sub];
            if (!entry) { console.log(colorize(C.red,`\n  No tracked process: ${sub}\n`)); break; }
            const last50 = entry.lines.slice(-50);
            const st = entry.exitCode === null ? colorize(C.green,'running') : colorize(C.dim,'exited:'+entry.exitCode);
            console.log(colorize(C.bold,`\n── PID ${sub} · ${st} · ${entry.cmd.slice(0,60)}\n`));
            if (!last50.length) console.log(colorize(C.dim,'  (no output yet)'));
            else last50.forEach(l => console.log(colorize(C.dim,'  '+l)));
            console.log('');
            if (arg2 === 'tail') {
              console.log(colorize(C.yellow,'Tailing (60s max)...\n'));
              let shown = entry.lines.length, secs = 0;
              const ti = setInterval(() => {
                if (entry.lines.length > shown) { entry.lines.slice(shown).forEach(l => console.log(colorize(C.dim,'  '+l))); shown = entry.lines.length; }
                if (entry.exitCode !== null) { console.log(colorize(C.dim,'\n[process exited]\n')); clearInterval(ti); }
                else if (++secs >= 60) { console.log(colorize(C.dim,'\n[tail stopped]\n')); clearInterval(ti); }
              }, 1000);
            }
          }
          break;
        }

        case 'cron': {
          const sub = parts[1];
          if (!sub || sub === 'list') {
            if (!cronJobs.length) { console.log(colorize(C.dim,'\n  No cron jobs. Use /cron create <schedule> <name> <prompt>\n')); break; }
            console.log(colorize(C.dim,`\n  ${'ID'.padEnd(8)}EN  ${'SCHED'.padEnd(6)}${'NAME'.padEnd(22)}${'LAST RUN'.padEnd(22)}RUNS`));
            cronJobs.forEach(j => {
              const dot = j.enabled ? colorize(C.green,'●') : colorize(C.dim,'○');
              console.log(`  ${j.id.padEnd(8)}${dot}   ${j.schedule.padEnd(6)}${(j.name||'').slice(0,20).padEnd(22)}${(j.lastRun||'never').slice(0,19).padEnd(22)}${j.runCount||0}`);
            });
            console.log('');
          } else if (sub === 'create') {
            const [,, sched, name, ...promptParts] = parts; const prompt = promptParts.join(' ');
            if (!sched || !name || !prompt) { console.log(colorize(C.yellow,'\n  Usage: /cron create <schedule> <name> <prompt>\n  Schedules: 30s 5m 1h 6h 1d\n')); break; }
            if (parseCronInterval(sched) === null) { console.log(colorize(C.red,`\n  Invalid schedule: ${sched}\n`)); break; }
            const job = { id: makeCronId(), name, schedule: sched, prompt, enabled: true, createdAt: new Date().toISOString(), lastRun: null, lastOutput: null, runCount: 0 };
            cronJobs.push(job); saveCrons(); registerCronTimer(job);
            console.log(colorize(C.green,`\n  Created cron [${job.id}] "${job.name}" every ${job.schedule}\n`));
          } else if (sub === 'delete') {
            const idx = cronJobs.findIndex(j => j.id === parts[2]);
            if (idx === -1) { console.log(colorize(C.red,`\n  Not found: ${parts[2]}\n`)); break; }
            if (cronTimers[parts[2]]) { clearInterval(cronTimers[parts[2]]); delete cronTimers[parts[2]]; }
            cronJobs.splice(idx, 1); saveCrons();
            console.log(colorize(C.green,`\n  Deleted cron ${parts[2]}\n`));
          } else if (sub === 'run') {
            const job = cronJobs.find(j => j.id === parts[2]);
            if (!job) { console.log(colorize(C.red,`\n  Not found: ${parts[2]}\n`)); break; }
            fireCron(job);
          } else if (sub === 'enable' || sub === 'disable') {
            const job = cronJobs.find(j => j.id === parts[2]);
            if (!job) { console.log(colorize(C.red,`\n  Not found: ${parts[2]}\n`)); break; }
            job.enabled = sub === 'enable'; saveCrons();
            if (job.enabled) registerCronTimer(job);
            else if (cronTimers[job.id]) { clearInterval(cronTimers[job.id]); delete cronTimers[job.id]; }
            console.log(colorize(C.green,`\n  Cron ${job.id} ${sub}d\n`));
          } else { console.log(colorize(C.yellow,`\n  Unknown: ${sub}. Try /cron list\n`)); }
          break;
        }

        case 'trigger': {
          const sub = parts[1];
          if (sub === 'start') {
            await startTriggerServer(parts[2] ? parseInt(parts[2]) : 4242);
          } else if (sub === 'stop') {
            console.log(stopTriggerServer() ? colorize(C.green,'\n  Trigger server stopped.\n') : colorize(C.yellow,'\n  Not running.\n'));
          } else if (sub === 'status') {
            if (!triggerServer) { console.log(colorize(C.dim,'\n  Trigger server: stopped\n')); break; }
            const t = getTriggerToken();
            console.log(colorize(C.green,'\n  Trigger server: running'));
            console.log(`  Port : ${triggerPort}\n  Token: ${t.slice(0,4)}${'*'.repeat(t.length-4)}\n`);
          } else if (sub === 'token') {
            console.log(colorize(C.cyan,'\n  ' + getTriggerToken() + '\n'));
          } else if (sub === 'url') {
            const t = getTriggerToken();
            console.log(colorize(C.dim,`\ncurl -X POST http://127.0.0.1:${triggerPort}/trigger \\\n  -H "x-proverbs-token: ${t}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"prompt":"your prompt here"}'\n`));
          } else {
            console.log(colorize(C.cyan,'\n  /trigger subcommands:'));
            ['start [port]','stop','status','token','url'].forEach(c => console.log('    ' + c));
            console.log('');
          }
          break;
        }

        case 'agents': {
          const sub = parts[1] || '';
          if (!sub || sub === 'help') {
            console.log(colorize(C.cyan,'\n  /agents subcommands:'));
            console.log('    parallel "task1" "task2" ...   — run agents concurrently');
            console.log('    chain    "task1" "task2" ...   — sequential, pass context forward');
            console.log('    list                           — show recent runs\n');
          } else if (sub === 'list') {
            if (!agentRuns.length) { console.log(colorize(C.dim,'\n  No agent runs yet.\n')); break; }
            console.log(colorize(C.dim,`\n  ${'ID'.padEnd(8)}${'MODE'.padEnd(11)}${'TASKS'.padEnd(7)}${'STATUS'.padEnd(12)}STARTED`));
            agentRuns.slice(-10).forEach(r => console.log(`  ${r.id.padEnd(8)}${r.mode.padEnd(11)}${String(r.tasks.length).padEnd(7)}${r.status.padEnd(12)}${new Date(r.startedAt).toLocaleTimeString()}`));
            console.log('');
          } else if (sub === 'parallel') {
            const tasks = parseQuotedArgs(parts.slice(2).join(' '));
            if (tasks.length < 2) { console.log(colorize(C.red,'\n  Need at least 2 quoted tasks.\n  Example: /agents parallel "task1" "task2"\n')); break; }
            const run = { id: makeAgentRunId(), mode:'parallel', tasks, results:[], status:'running', startedAt: new Date().toISOString(), completedAt: null };
            agentRuns.push(run);
            console.log(colorize(C.yellow,`\n  Spawning ${tasks.length} parallel agents...\n`));
            const spinner = new Spinner(`Running ${tasks.length} agents in parallel...`);
            spinner.start();
            Promise.all(tasks.map((task, i) =>
              agentLoop([
                { role:'system', content: buildSystemPrompt() + `\n\nYou are Agent ${i+1} of ${tasks.length}. Focus only on your assigned task.` },
                { role:'user', content: task }
              ]).catch(e => `[Agent ${i+1} error]: ${e.message}`)
            )).then(results => {
              spinner.stop();
              run.results = results; run.status = 'completed'; run.completedAt = new Date().toISOString();
              results.forEach((r, i) => { console.log(colorize(C.cyan,`\n[Agent ${i+1}] ${tasks[i].slice(0,40)}`)); renderResponse(r); });
              notify('Agents complete', `${tasks.length} agents finished`);
              rl.prompt();
            }).catch(e => { spinner.stop(); run.status = 'error'; console.log(colorize(C.red,'\n  '+e.message+'\n')); rl.prompt(); });
          } else if (sub === 'chain') {
            const tasks = parseQuotedArgs(parts.slice(2).join(' '));
            if (tasks.length < 2) { console.log(colorize(C.red,'\n  Need at least 2 quoted tasks.\n  Example: /agents chain "task1" "task2"\n')); break; }
            const run = { id: makeAgentRunId(), mode:'chain', tasks, results:[], status:'running', startedAt: new Date().toISOString(), completedAt: null };
            agentRuns.push(run);
            (async () => {
              let prev = '';
              for (let i = 0; i < tasks.length; i++) {
                console.log(colorize(C.yellow,`\n[Step ${i+1}/${tasks.length}] ${tasks[i].slice(0,50)}`));
                const sp = new Spinner(`Step ${i+1}...`); sp.start();
                const content = i === 0 ? tasks[i] : tasks[i] + '\n\nContext from previous step:\n' + prev;
                let r;
                try { r = await agentLoop([{ role:'system', content: buildSystemPrompt() }, { role:'user', content }]); }
                catch(e) { r = `[Step ${i+1} error]: ${e.message}`; }
                sp.stop();
                console.log(colorize(C.cyan,`\n[Step ${i+1} result]`)); renderResponse(r);
                run.results.push(r); prev = r;
              }
              run.status = 'completed'; run.completedAt = new Date().toISOString();
              notify('Chain complete', `All ${tasks.length} steps done`);
              rl.prompt();
            })().catch(e => { run.status = 'error'; console.log(colorize(C.red,'\n  '+e.message+'\n')); rl.prompt(); });
          } else { console.log(colorize(C.yellow,`\n  Unknown: ${sub}. Try /agents help\n`)); }
          break;
        }

        case 'planner': {
          const sub = (parts[1] || '').toLowerCase();
          if (sub === 'on') {
            planningEnabled = true;
            saveConfig();
            console.log(colorize(C.green, '  Change planner enabled.\n'));
          } else if (sub === 'off') {
            planningEnabled = false;
            saveConfig();
            console.log(colorize(C.yellow, '  Change planner disabled.\n'));
          } else {
            console.log(colorize(planningEnabled ? C.green : C.yellow,
              `  Change planner is ${planningEnabled ? 'ON' : 'OFF'}.\n`));
            console.log(colorize(C.dim, '  Usage: /planner on|off\n'));
          }
          break;
        }

        // /verify — Test Engine: run real checks after code changes
        // /eval — local regression harness (see eval/run_eval.js)
        case 'eval': {
          const sub = (parts[1] || '').toLowerCase();
          const evalScript = path.join(__dirname, 'eval', 'run_eval.js');
          if (!fs.existsSync(evalScript)) {
            console.log(colorize(C.red, '\n  eval/run_eval.js not found (not shipped in this build).\n'));
            break;
          }
          if (sub === 'history') {
            const hist = path.join(PROVERBS_DIR, 'eval', 'history.jsonl');
            let rows = [];
            try {
              rows = fs.readFileSync(hist, 'utf8').split('\n').filter(Boolean)
                .map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
            } catch (_) {}
            if (!rows.length) { console.log(colorize(C.dim, '\n  No eval runs recorded yet.\n')); break; }
            console.log(colorize(C.cyan, '\n  Eval history (most recent last)\n'));
            for (const r of rows.slice(-15)) {
              const when = String(r.ts || '').slice(0, 16).replace('T', ' ');
              const scope = r.dimension ? r.dimension : (r.quick ? 'quick' : 'full');
              const c = r.overall >= 80 ? C.green : r.overall >= 50 ? C.yellow : C.red;
              console.log('  ' + colorize(C.dim, when) + '  ' + String(r.model || '?').padEnd(22) +
                          scope.padEnd(14) + colorize(c, String(r.overall) + '%') +
                          colorize(C.dim, '  (' + r.passed + '/' + r.total + ')') +
                          (r.verdict ? colorize(r.verdict === 'keep' ? C.green : C.red, '  ' + r.verdict) : ''));
            }
            console.log('');
            break;
          }
          // Everything else is forwarded straight to the runner.
          const evalArgs = parts.slice(1);
          console.log(colorize(C.dim, '\n  Running eval suite — this is CPU-bound and can take a while.'));
          console.log(colorize(C.dim, '  Ctrl+C is safe: progress is checkpointed, resume with /eval --resume\n'));
          try {
            require('child_process').execFileSync(process.execPath, [evalScript].concat(evalArgs),
              { stdio: 'inherit', cwd: __dirname });
          } catch (e) {
            // A non-zero exit is the rollback verdict, not a crash.
            if (e.status !== 1) console.log(colorize(C.red, '  Eval failed: ' + e.message));
          }
          break;
        }

        case 'testengine':
        case 'te': {
          const sub = (parts[1] || '').toLowerCase();
          if (sub === 'on' || sub === 'off') {
            verifyEnabled = (sub === 'on');
            saveConfig();
            console.log(colorize(verifyEnabled ? C.green : C.yellow,
              '  Test Engine ' + (verifyEnabled ? 'enabled' : 'disabled') + '.\n'));
          } else if (sub === 'level') {
            const lv = parseInt(parts[2], 10);
            if (lv >= 1 && lv <= 5) {
              verifyLevel = lv; saveConfig();
              console.log(colorize(C.green, '  Verify level set to ' + lv + '.\n'));
              if (lv >= 4) console.log(colorize(C.dim,
                '  Note: levels 4-5 need model-authored tests — slower on CPU-only machines.\n'));
            } else console.log(colorize(C.yellow, '  Usage: /verify level 1-5\n'));
          } else if (sub === 'attempts') {
            const n = parseInt(parts[2], 10);
            if (n >= 1 && n <= 10) {
              verifyMaxAttempts = n; saveConfig();
              console.log(colorize(C.green, '  Max fix cycles set to ' + n + '.\n'));
            } else console.log(colorize(C.yellow, '  Usage: /verify attempts 1-10\n'));
          } else if (sub === 'now') {
            // Run the suite immediately against the whole project.
            const suiteNow = detectTestSuite(resolvePath(cwd)).filter(c => c.level <= verifyLevel);
            if (!suiteNow.length) { console.log(colorize(C.dim, '\n  No test runner detected here.\n')); break; }
            console.log(colorize(C.cyan, '\n  Running ' + suiteNow.length + ' check(s)…\n'));
            const vNow = runTestSuite([]);
            console.log(_renderVerifyReport(vNow, 1) + '\n');
            if (!vNow.pass && vNow.failed) {
              console.log(colorize(C.red, '  ' + vNow.failed.name + ' output:\n'));
              console.log(colorize(C.dim, (vNow.failed.output || '').split('\n').slice(0, 25).map(l => '    ' + l).join('\n')) + '\n');
            }
          } else {
            const det = detectTestSuite(resolvePath(cwd)).filter(c => c.level <= verifyLevel);
            console.log(colorize(verifyEnabled ? C.green : C.yellow,
              '\n  Test Engine is ' + (verifyEnabled ? 'ON' : 'OFF') +
              '  ·  level ' + verifyLevel + '  ·  max ' + verifyMaxAttempts + ' fix cycles'));
            console.log(colorize(C.dim, '  Detected here: ' +
              (det.length ? det.map(c => 'L' + c.level + ' ' + c.name).join(', ') : 'nothing')));
            console.log(colorize(C.dim,
              '\n  /testengine on|off      — toggle the PASS/FAIL gate' +
              '\n  /testengine level <1-5> — 1 syntax · 2 unit · 3 integration · 4 behavioral · 5 adversarial' +
              '\n  /testengine attempts <n>— fix→retest cycles before giving up' +
              '\n  /testengine now         — run the suite right now  (alias: /te)\n'));
          }
          break;
        }

        // /gitlog [n] — show recent git commits in cwd
        case 'gitlog': {
          const glCount = parseInt(parts[1], 10) || 10;
          try {
            const { execSync: glExec } = require('child_process');
            const log = glExec(`git -C ${JSON.stringify(cwd)} log --oneline -${glCount} 2>&1`, { encoding: 'utf8' });
            console.log(colorize(C.cyan, `\nRecent git log (${glCount}):\n`));
            console.log(log.trimEnd() + '\n');
          } catch (e) {
            console.log(colorize(C.red, `\n✗  git log failed: ${e.message}\n`));
          }
          break;
        }

        // /conventions — show detected code conventions for cwd
        case 'conventions': {
          const convSpinner = new Spinner('Detecting conventions...');
          convSpinner.start();
          let convLines = [];
          try {
            // Indent style
            const jsFiles = require('child_process')
              .execSync(`find ${JSON.stringify(cwd)} -maxdepth 3 -name "*.js" -o -name "*.ts" -o -name "*.tsx" 2>/dev/null | head -10`, { encoding: 'utf8' })
              .trim().split('\n').filter(Boolean);
            let useTabs = 0, useSpaces = 0;
            for (const f of jsFiles.slice(0, 5)) {
              try {
                const src = require('fs').readFileSync(f, 'utf8').split('\n').slice(0, 30).join('\n');
                if (/^\t/m.test(src)) useTabs++;
                else if (/^ {2,}/m.test(src)) useSpaces++;
              } catch (_) {}
            }
            convLines.push(`  Indent   : ${useTabs > useSpaces ? 'tabs' : useTabs === 0 && useSpaces === 0 ? 'unknown' : 'spaces'}`);
            // Quote style
            let singleQ = 0, doubleQ = 0;
            for (const f of jsFiles.slice(0, 5)) {
              try {
                const src = require('fs').readFileSync(f, 'utf8');
                singleQ += (src.match(/'/g) || []).length;
                doubleQ += (src.match(/"/g) || []).length;
              } catch (_) {}
            }
            convLines.push(`  Quotes   : ${singleQ >= doubleQ ? 'single' : 'double'}`);
            // Package manager
            const hasPnpm = require('fs').existsSync(require('path').join(cwd, 'pnpm-lock.yaml'));
            const hasYarn = require('fs').existsSync(require('path').join(cwd, 'yarn.lock'));
            convLines.push(`  Pkg mgr  : ${hasPnpm ? 'pnpm' : hasYarn ? 'yarn' : 'npm'}`);
            // Semicolons
            let withSemi = 0, noSemi = 0;
            for (const f of jsFiles.slice(0, 5)) {
              try {
                const lines = require('fs').readFileSync(f, 'utf8').split('\n').filter(l => l.trim().length > 0);
                for (const l of lines.slice(0, 20)) {
                  if (/;$/.test(l.trimEnd())) withSemi++;
                  else noSemi++;
                }
              } catch (_) {}
            }
            convLines.push(`  Semis    : ${withSemi >= noSemi ? 'yes' : 'no'}`);
          } catch (e) {
            convLines.push(`  (detection error: ${e.message})`);
          }
          convSpinner.stop();
          console.log(colorize(C.cyan, `\nCode conventions for ${cwd}:\n`));
          convLines.forEach(l => console.log(colorize(C.dim, l)));
          console.log('');
          break;
        }

        // /cot [on|off] — toggle Chain-of-Thought prompting
        case 'cot': {
          const cotArg = (parts[1] || '').toLowerCase();
          if (cotArg === 'on') {
            cotEnabled = true;
            saveConfig();
            console.log(colorize(C.green, '\n✔  Chain-of-Thought prompting enabled.\n'));
          } else if (cotArg === 'off') {
            cotEnabled = false;
            saveConfig();
            console.log(colorize(C.dim, '\n  Chain-of-Thought prompting disabled.\n'));
          } else {
            const state = cotEnabled ? colorize(C.green, 'on') : colorize(C.dim, 'off');
            console.log(colorize(C.cyan, '\nChain-of-Thought: ') + state);
            console.log(colorize(C.dim, '  /cot on   — Prepend "Think step-by-step:" to every user message'));
            console.log(colorize(C.dim, '  /cot off  — Send messages as-is\n'));
          }
          break;
        }

        // /multiattempt [on|off] — toggle multi-attempt retry on errors
        case 'multiattempt': {
          const maArg = (parts[1] || '').toLowerCase();
          if (maArg === 'on') {
            multiAttemptEnabled = true;
            saveConfig();
            console.log(colorize(C.green, `\n✔  Multi-attempt retry enabled (max ${MULTI_ATTEMPT_MAX} attempts).\n`));
          } else if (maArg === 'off') {
            multiAttemptEnabled = false;
            saveConfig();
            console.log(colorize(C.dim, '\n  Multi-attempt retry disabled.\n'));
          } else {
            const state = multiAttemptEnabled ? colorize(C.green, 'on') : colorize(C.dim, 'off');
            console.log(colorize(C.cyan, '\nMulti-attempt retry: ') + state + colorize(C.dim, `  (max: ${MULTI_ATTEMPT_MAX})`));
            console.log(colorize(C.dim, '  /multiattempt on   — Retry failed tool calls up to ' + MULTI_ATTEMPT_MAX + ' times'));
            console.log(colorize(C.dim, '  /multiattempt off  — Fail immediately on first error\n'));
          }
          break;
        }

        // /smartpreload [on|off] — toggle smart context preloading
        case 'smartpreload': {
          const spArg = (parts[1] || '').toLowerCase();
          if (spArg === 'on') {
            smartPreload = true;
            saveConfig();
            console.log(colorize(C.green, '\n✔  Smart preload enabled.\n'));
          } else if (spArg === 'off') {
            smartPreload = false;
            saveConfig();
            console.log(colorize(C.dim, '\n  Smart preload disabled.\n'));
          } else {
            const state = smartPreload ? colorize(C.green, 'on') : colorize(C.dim, 'off');
            console.log(colorize(C.cyan, '\nSmart preload: ') + state);
            console.log(colorize(C.dim, '  /smartpreload on   — Auto-load relevant files into context before answering'));
            console.log(colorize(C.dim, '  /smartpreload off  — Disable smart preload\n'));
          }
          break;
        }

        // /knowledge [add <fact>|list|clear] — manage project knowledge facts
        case 'knowledge': {
          const kSub  = (parts[1] || '').toLowerCase();
          const kKey  = cwd;
          if (kSub === 'add') {
            const kFact = parts.slice(2).join(' ').trim();
            if (!kFact) {
              console.log(colorize(C.red, '\n✗  Usage: /knowledge add <fact>\n'));
            } else {
              const total = saveKnowledgeFact(kKey, kFact);
              console.log(colorize(C.green, `\n✔  Fact saved (${total} total for this project).\n`));
            }
          } else if (kSub === 'list') {
            const facts = getKnowledgeFacts(kKey);
            if (!facts.length) {
              console.log(colorize(C.dim, '\n(no knowledge facts for this project)\n'));
            } else {
              console.log(colorize(C.cyan, `\nProject knowledge (${facts.length} facts):\n`));
              facts.forEach((f, i) => console.log(`  ${colorize(C.bold, String(i + 1) + '.')} ${f}`));
              console.log('');
            }
          } else if (kSub === 'clear') {
            loadProjectKnowledge();
            delete projectKnowledge[kKey];
            ensureProverbsDir();
            fs.writeFileSync(PROJECT_KNOWLEDGE_FILE, JSON.stringify(projectKnowledge, null, 2), 'utf8');
            console.log(colorize(C.dim, '\n  Project knowledge cleared.\n'));
          } else {
            const facts = getKnowledgeFacts(kKey);
            if (!facts.length) {
              console.log(colorize(C.dim, '\n  No facts saved yet for this project.'));
              console.log(colorize(C.dim, '  Add one: /knowledge add <fact>\n'));
            } else {
              console.log(colorize(C.cyan, `\nProject knowledge (${facts.length} facts):\n`));
              facts.forEach((f, i) => console.log(`  ${colorize(C.bold, String(i + 1) + '.')} ${f}`));
              console.log('');
            }
          }
          break;
        }

        // /script — view, edit, or create the .script file (like CLAUDE.md)
        case 'script': {
          const scSub = (parts[1] || 'show').toLowerCase();
          const scFiles = findScriptFiles(cwd);
          const localScript = path.join(cwd, '.script');

          if (scSub === 'show' || scSub === 'list') {
            if (!scFiles.length) {
              console.log(colorize(C.dim, `\n  No .script file found in ${cwd} or parent directories.\n`));
              console.log(colorize(C.dim, '  Create one: /script new\n'));
            } else {
              console.log(colorize(C.cyan, `\nLoaded .script files (${scFiles.length}):\n`));
              scFiles.forEach(f => {
                const rel = path.relative(os.homedir(), f);
                const size = fs.statSync(f).size;
                console.log(`  ${colorize(C.green, '●')} ~/${rel}  (${size} bytes)`);
              });
              console.log(colorize(C.dim, `\nActive content (${scriptContent.length} chars) — first 300:\n`));
              console.log(colorize(C.dim, scriptContent.slice(0, 300) + (scriptContent.length > 300 ? '\n...' : '') + '\n'));
            }
          } else if (scSub === 'new' || scSub === 'create') {
            if (fs.existsSync(localScript)) {
              console.log(colorize(C.yellow, `\n  .script already exists: ${localScript}\n  Edit it directly, or use /script edit\n`));
            } else {
              const template = `# Project Instructions
# This file works exactly like CLAUDE.md — injected into every session.
# Supports: @import ./other-file.md, $ENV_VAR expansion, section headers

## Rules
- Always use TypeScript strict mode
- Prefer named exports over default exports

## Context
- Project: ${path.basename(cwd)}
- Stack: (describe your stack here)

## Commands
- Build: npm run build
- Test: npm test
- Dev: npm run dev
`;
              fs.writeFileSync(localScript, template, 'utf8');
              loadScriptFiles(cwd);
              console.log(colorize(C.green, `\n✔  Created ${localScript}\n`));
              console.log(colorize(C.dim, '  Edit it to add your project instructions. Auto-reloads on save.\n'));
            }
          } else if (scSub === 'edit') {
            const target = scFiles[0] || localScript;
            const editor = process.env.EDITOR || process.env.VISUAL || 'nano';
            console.log(colorize(C.dim, `\n  Opening ${target} in ${editor}...\n`));
            try {
              require('child_process').execSync(`${editor} "${target}"`, { stdio: 'inherit' });
              loadScriptFiles(cwd);
              console.log(colorize(C.green, '\n  .script reloaded.\n'));
            } catch (_) {
              console.log(colorize(C.yellow, `\n  Could not open editor. Edit directly: ${target}\n`));
            }
          } else if (scSub === 'reload') {
            const n = loadScriptFiles(cwd);
            console.log(colorize(C.green, `\n✔  Reloaded ${n} script file${n === 1 ? '' : 's'} (${scriptContent.length} chars)\n`));
          } else if (scSub === 'clear') {
            scriptContent = '';
            console.log(colorize(C.dim, '\n  .script content cleared from memory (files unchanged).\n'));
          } else {
            console.log(colorize(C.dim, '\n  /script show   — show loaded files and preview'));
            console.log(colorize(C.dim, '  /script new    — create a .script file in current project'));
            console.log(colorize(C.dim, '  /script edit   — open .script in $EDITOR'));
            console.log(colorize(C.dim, '  /script reload — force reload all .script files\n'));
          }
          break;
        }

        // /verify — post-connection health check (run after /backend to confirm end-to-end works)
        case 'verify': {
          const OK = colorize(C.green, '✔'); const ERR = colorize(C.red, '✗');
          console.log(colorize(C.cyan, '\n  End-to-End Verification\n'));
          // 1. Backend ping
          const vPing = await pingBackend().catch(() => ({ ok: false, error: 'unreachable' }));
          console.log(`  [${vPing.ok ? OK : ERR}] Backend: ${activeBackendName} (${OLLAMA_BASE})  ${vPing.ok ? vPing.ms + 'ms' : vPing.error}`);
          if (!vPing.ok) { console.log(colorize(C.yellow, '\n  Fix: /backend auto  or  /server start\n')); break; }
          // 2. Model list
          let modelList = [];
          try {
            const r = await httpGet(OLLAMA_BASE + '/api/tags', 5000);
            modelList = (JSON.parse(r.data || '{}').models || []).map(m => m.name || m.model).filter(Boolean);
            console.log(`  [${modelList.length > 0 ? OK : ERR}] Models available: ${modelList.length > 0 ? modelList.join(', ') : 'NONE'}`);
          } catch (e) {
            console.log(`  [${ERR}] Could not list models: ${e.message}`);
          }
          // 3. Inference test
          console.log(colorize(C.dim, '  Testing inference (sending 1 token prompt)...'));
          try {
            const vMsgs = [{ role: 'system', content: 'Reply with exactly one word.' }, { role: 'user', content: 'Say "ok".' }];
            const t0 = Date.now();
            const reply = await agentLoop(vMsgs);
            const ms = Date.now() - t0;
            const ok2 = reply && reply.trim().length > 0 && reply !== '[interrupted]';
            console.log(`  [${ok2 ? OK : ERR}] Inference: ${ok2 ? '"' + reply.trim().slice(0,40) + '"  (' + ms + 'ms)' : 'FAILED'}`);
          } catch (e) {
            console.log(`  [${ERR}] Inference failed: ${e.message}`);
          }
          // 4. Tool execution
          try {
            const testPath = path.join(PROVERBS_DIR, '.verify_test');
            fs.writeFileSync(testPath, 'test', 'utf8');
            fs.unlinkSync(testPath);
            console.log(`  [${OK}] Tool execution (file write/delete): OK`);
          } catch (e) {
            console.log(`  [${ERR}] Tool execution failed: ${e.message}`);
          }
          // 5. .script loaded
          console.log(`  [${OK}] .script: ${scriptContent.length > 0 ? scriptContent.length + ' chars loaded' : 'none (OK)'}`);
          // 6. Facts
          loadProjectKnowledge();
          const vFacts = getKnowledgeFacts(cwd).length;
          console.log(`  [${OK}] Project facts: ${vFacts} remembered`);
          console.log(colorize(vPing.ok && modelList.length > 0 ? C.green : C.yellow, '\n  Verification complete.\n'));
          break;
        }

        // /remember <fact> — shorthand for /knowledge add
        case 'remember': {
          const fact = parts.slice(1).join(' ').trim();
          if (!fact) {
            console.log(colorize(C.red, '\n✗  Usage: /remember <fact about this project>\n'));
            break;
          }
          loadProjectKnowledge();
          const tot = saveKnowledgeFact(cwd, fact);
          console.log(colorize(C.green, `\n✔  Remembered (${tot} total facts for this project).\n`));
          break;
        }

        // /facts — list, search, or clear persistent project facts
        case 'facts': {
          const fSub  = (parts[1] || '').toLowerCase();
          loadProjectKnowledge();
          const allFacts = getKnowledgeFacts(cwd);
          if (fSub === 'clear') {
            delete projectKnowledge[cwd];
            fs.writeFileSync(PROJECT_KNOWLEDGE_FILE, JSON.stringify(projectKnowledge, null, 2), 'utf8');
            console.log(colorize(C.dim, '\n  All facts cleared.\n'));
          } else if (fSub === 'remove') {
            const idx = parseInt(parts[2], 10) - 1;
            if (isNaN(idx) || idx < 0 || idx >= allFacts.length) {
              console.log(colorize(C.red, `\n✗  Usage: /facts remove <number>\n`));
            } else {
              projectKnowledge[cwd].splice(idx, 1);
              fs.writeFileSync(PROJECT_KNOWLEDGE_FILE, JSON.stringify(projectKnowledge, null, 2), 'utf8');
              console.log(colorize(C.green, `\n✔  Fact ${idx + 1} removed.\n`));
            }
          } else {
            if (!allFacts.length) {
              console.log(colorize(C.dim, '\n  No facts saved yet. Use /remember <fact> to add one.\n'));
            } else {
              console.log(colorize(C.cyan, `\nProject facts (${allFacts.length}):\n`));
              allFacts.forEach((f, i) => console.log(`  ${colorize(C.bold, String(i + 1) + '.')} ${f}`));
              console.log(colorize(C.dim, '\n  /facts remove <n>  — delete a fact'));
              console.log(colorize(C.dim, '  /facts clear       — delete all facts\n'));
            }
          }
          break;
        }

        // /profile — show live performance stats
        case 'profile': {
          const os2 = require('os');
          const totalMem  = os2.totalmem();
          const freeMem   = os2.freemem();
          const usedMem   = totalMem - freeMem;
          const proc      = process.memoryUsage();

          console.log(colorize(C.cyan, '\nProverbs Performance Profile\n'));

          // Backend
          console.log(colorize(C.yellow, '  Backend'));
          console.log(`    Model    : ${model}`);
          console.log(`    Backend  : ${activeBackendName}  (${activeApiFormat})`);
          console.log(`    Endpoint : ${OLLAMA_BASE}`);
          console.log('');

          // Request latency
          if (_PERF_RING.length === 0) {
            console.log(colorize(C.dim, '  No requests recorded yet — run a query first.\n'));
          } else {
            const ms_list = _PERF_RING.map(r => r.ms);
            const avg_ms  = Math.round(ms_list.reduce((a, b) => a + b, 0) / ms_list.length);
            const min_ms  = Math.min(...ms_list);
            const max_ms  = Math.max(...ms_list);
            const last_ms = _PERF_RING[_PERF_RING.length - 1].ms;
            console.log(colorize(C.yellow, '  Latency (last ' + _PERF_RING.length + ' requests)'));
            console.log(`    Last     : ${last_ms} ms`);
            console.log(`    Avg      : ${avg_ms} ms`);
            console.log(`    Min/Max  : ${min_ms} ms / ${max_ms} ms`);
            console.log('');
          }

          // Memory
          console.log(colorize(C.yellow, '  Memory'));
          const mb = n => (n / 1024 / 1024).toFixed(0) + ' MB';
          console.log(`    System   : ${mb(usedMem)} used / ${mb(totalMem)} total`);
          console.log(`    Process  : ${mb(proc.rss)} RSS  ${mb(proc.heapUsed)} heap`);
          console.log('');

          // Cache stats
          console.log(colorize(C.yellow, '  Cache'));
          console.log(`    Prefix hits     : ${_prefixCacheHits}`);
          console.log(`    Response hits   : ${_responseCacheHits}`);
          console.log(`    Total requests  : ${_perfTotalRequests}`);
          if (_perfTotalRequests > 0) {
            const hr = ((_prefixCacheHits + _responseCacheHits) / _perfTotalRequests * 100).toFixed(1);
            console.log(`    Combined hit%   : ${hr}%`);
          }
          console.log('');

          // Facts
          loadProjectKnowledge();
          const factCount = getKnowledgeFacts(cwd).length;
          const memCount  = listMemories().length;
          console.log(colorize(C.yellow, '  Knowledge'));
          console.log(`    Project facts   : ${factCount}`);
          console.log(`    Saved memories  : ${memCount}`);
          console.log('');
          break;
        }

        // /depgraph — build and display import dependency graph for cwd
        case 'depgraph': {
          console.log(colorize(C.dim, '  Building dependency graph...'));
          const dg = buildDepGraph(cwd);
          if (!dg.nodes.length) {
            console.log(colorize(C.yellow, '\n  No JS/TS source files found in ' + cwd + '\n'));
            break;
          }
          console.log(colorize(C.cyan, `\nDependency graph: ${dg.nodes.length} nodes, ${dg.edges.length} edges\n`));
          // Show top 20 files by incoming edge count
          const inCount = {};
          dg.nodes.forEach(n => { inCount[n] = 0; });
          dg.edges.forEach(e => { inCount[e.to] = (inCount[e.to] || 0) + 1; });
          const top = Object.entries(inCount).sort((a, b) => b[1] - a[1]).slice(0, 20);
          console.log(colorize(C.dim, '  Most-imported files (top 20):\n'));
          top.forEach(([f, c]) => console.log(`    ${colorize(C.bold, String(c).padStart(3))} ← ${f}`));
          console.log('');
          break;
        }

        // /testrunner — detect test runner for cwd
        case 'testrunner': {
          const runner = detectTestRunner(cwd);
          if (runner) {
            console.log(colorize(C.green, `\n✔  Detected test runner: ${runner}\n`));
          } else {
            console.log(colorize(C.yellow, '\n  No known test runner found in package.json.\n'));
          }
          break;
        }

        // /finetunestate — show fine-tune state
        case 'finetunestate': {
          const ftState = loadFinetuneState();
          console.log(colorize(C.cyan, '\nFine-tune state:'));
          console.log(`  pairs    : ${ftState.pairs}`);
          console.log(`  lastBake : ${ftState.lastBake || '(never)'}`);
          console.log(`  model    : ${ftState.model || '(none)'}\n`);
          break;
        }

        // /test [<script>] — run npm test (or a named script) in cwd
        case 'test': {
          const testScript = parts[1] || 'test';
          const pkgTestPath = path.join(cwd, 'package.json');
          if (!fs.existsSync(pkgTestPath)) {
            console.log(colorize(C.red, '\n✗  No package.json found in current working directory.\n'));
            break;
          }
          let testPkg;
          try { testPkg = JSON.parse(fs.readFileSync(pkgTestPath, 'utf8')); } catch (_) { testPkg = {}; }
          const testScripts = (testPkg.scripts && typeof testPkg.scripts === 'object') ? testPkg.scripts : {};
          if (!testScripts[testScript]) {
            const testRunner = detectTestRunner(cwd);
            console.log(colorize(C.yellow, `\n  No "${testScript}" script in package.json.`));
            if (testRunner) {
              console.log(colorize(C.dim, `  Detected runner: ${testRunner}. Add a "test" script to run it.\n`));
            } else {
              const availTest = Object.keys(testScripts).filter(s => /test|spec|jest|vitest|mocha/.test(s));
              if (availTest.length > 0) {
                console.log(colorize(C.dim, `  Available test scripts: ${availTest.join(', ')}\n`));
              } else {
                console.log(colorize(C.dim, '  No test scripts detected.\n'));
              }
            }
            break;
          }
          console.log(colorize(C.cyan, `\nRunning: npm run ${testScript}\n`));
          try {
            execSync(`npm run ${testScript}`, { cwd, stdio: 'inherit', timeout: 120000 });
            console.log(colorize(C.green, '\n✓  Tests passed.\n'));
          } catch (e) {
            console.log(colorize(C.red, `\n✗  Tests failed (exit ${e.status || 1}).\n`));
          }
          break;
        }

        // /deps — list direct dependencies from package.json in cwd
        case 'deps': {
          const depsPkgPath = path.join(cwd, 'package.json');
          if (!fs.existsSync(depsPkgPath)) {
            console.log(colorize(C.red, '\n✗  No package.json found in current working directory.\n'));
            break;
          }
          let depsPkg;
          try { depsPkg = JSON.parse(fs.readFileSync(depsPkgPath, 'utf8')); } catch (_) { depsPkg = {}; }
          const depsProd = Object.keys(depsPkg.dependencies || {});
          const depsDev  = Object.keys(depsPkg.devDependencies || {});
          const depsPeer = Object.keys(depsPkg.peerDependencies || {});
          console.log(colorize(C.cyan, `\nDependencies for ${depsPkg.name || path.basename(cwd)}:\n`));
          if (depsProd.length > 0) {
            console.log(colorize(C.bold, `  Production (${depsProd.length}):`));
            depsProd.forEach(d => console.log(colorize(C.dim, `    ${d}  ${(depsPkg.dependencies || {})[d]}`)));
          }
          if (depsDev.length > 0) {
            console.log(colorize(C.bold, `\n  Dev (${depsDev.length}):`));
            depsDev.forEach(d => console.log(colorize(C.dim, `    ${d}  ${(depsPkg.devDependencies || {})[d]}`)));
          }
          if (depsPeer.length > 0) {
            console.log(colorize(C.bold, `\n  Peer (${depsPeer.length}):`));
            depsPeer.forEach(d => console.log(colorize(C.dim, `    ${d}  ${(depsPkg.peerDependencies || {})[d]}`)));
          }
          if (depsProd.length === 0 && depsDev.length === 0 && depsPeer.length === 0) {
            console.log(colorize(C.dim, '  (no dependencies)\n'));
          } else {
            console.log();
          }
          break;
        }

        // /attempts [on|off] — alias for /multiattempt
        case 'attempts': {
          const attArg = (parts[1] || '').toLowerCase();
          if (attArg === 'on') {
            multiAttemptEnabled = true;
            console.log(colorize(C.green, `\n✓  Multi-attempt retry enabled (max ${MULTI_ATTEMPT_MAX} attempts).\n`));
          } else if (attArg === 'off') {
            multiAttemptEnabled = false;
            console.log(colorize(C.dim, '\n  Multi-attempt retry disabled.\n'));
          } else {
            const attState = multiAttemptEnabled ? colorize(C.green, 'on') : colorize(C.dim, 'off');
            console.log(colorize(C.cyan, '\nMulti-attempt retry: ') + attState + colorize(C.dim, `  (max: ${MULTI_ATTEMPT_MAX})`));
            console.log(colorize(C.dim, '  /attempts on   — Retry failed tool calls up to ' + MULTI_ATTEMPT_MAX + ' times'));
            console.log(colorize(C.dim, '  /attempts off  — Fail immediately on first error\n'));
          }
          break;
        }

        // /preload [on|off] — alias for /smartpreload
        case 'preload': {
          const preArg = (parts[1] || '').toLowerCase();
          if (preArg === 'on') {
            smartPreload = true;
            console.log(colorize(C.green, '\n✓  Smart preload enabled. Relevant files will be loaded into context automatically.\n'));
          } else if (preArg === 'off') {
            smartPreload = false;
            console.log(colorize(C.dim, '\n  Smart preload disabled.\n'));
          } else {
            const preState = smartPreload ? colorize(C.green, 'on') : colorize(C.dim, 'off');
            console.log(colorize(C.cyan, '\nSmart preload: ') + preState);
            console.log(colorize(C.dim, '  /preload on   — Auto-load relevant files before answering'));
            console.log(colorize(C.dim, '  /preload off  — Disable smart preload\n'));
          }
          break;
        }

        // /highlight on|off — toggle syntax highlighting in responses
        case 'highlight': {
          const hlArg = (parts[1] || '').toLowerCase();
          if (hlArg === 'on') {
            highlightEnabled = true;
            saveConfig();
            console.log(colorize(C.green, '\n✔  Syntax highlighting enabled. Code blocks will be colorized.\n'));
          } else if (hlArg === 'off') {
            highlightEnabled = false;
            saveConfig();
            console.log(colorize(C.dim, '\n  Syntax highlighting disabled. Code blocks will be plain text.\n'));
          } else {
            const hlState = highlightEnabled ? colorize(C.green, 'on') : colorize(C.dim, 'off');
            console.log(colorize(C.cyan, '\nSyntax highlighting: ') + hlState);
            console.log(colorize(C.dim, '  /highlight on   — colorize code blocks in responses (default)'));
            console.log(colorize(C.dim, '  /highlight off  — disable code block colorization\n'));
          }
          break;
        }

        // /full — re-run lastToolCall without truncation and print full output
        case 'full': {
          if (!lastToolCall) {
            console.log(colorize(C.yellow, '\nNo tool call to replay yet — ask something that triggers a tool first.\n'));
            break;
          }
          const { name: ftName, args: ftArgs } = lastToolCall;
          console.log(colorize(C.cyan, `\nRe-running ${ftName}() without truncation...\n`));
          let ftResult;
          try {
            ftResult = await executeTool(ftName, ftArgs);
          } catch (ftErr) {
            console.log(colorize(C.red, `\n✗  Tool error: ${ftErr.message}\n`));
            break;
          }
          const ftStr = String(ftResult);
          console.log(colorize(C.dim, `[Full output — ${ftStr.length.toLocaleString()} chars]\n`));
          console.log(ftStr);
          console.log(colorize(C.dim, `\n[End of full output]\n`));
          break;
        }

        // /truncate on|off|<n> — control tool output truncation
        case 'truncate': {
          const truncArg = (parts[1] || '').toLowerCase();
          if (truncArg === 'on') {
            _truncationEnabled = true;
            saveConfig();
            console.log(colorize(C.green, `\n✔  Tool output truncation enabled (limit: ${MAX_TOOL_OUTPUT_CHARS.toLocaleString()} chars).\n`));
          } else if (truncArg === 'off') {
            _truncationEnabled = false;
            saveConfig();
            console.log(colorize(C.yellow, '\n✔  Tool output truncation disabled — full results will be sent to the model.\n'));
          } else if (truncArg && /^\d+$/.test(truncArg)) {
            const newLimit = parseInt(truncArg, 10);
            if (newLimit < 1000) {
              console.log(colorize(C.red, '\n✗  Minimum limit is 1000 chars.\n'));
            } else {
              MAX_TOOL_OUTPUT_CHARS = newLimit;
              _truncationEnabled = true;
              saveConfig();
              console.log(colorize(C.green, `\n✔  Truncation limit set to ${MAX_TOOL_OUTPUT_CHARS.toLocaleString()} chars (truncation enabled).\n`));
            }
          } else {
            const state = _truncationEnabled ? colorize(C.green, 'on') : colorize(C.dim, 'off');
            console.log(colorize(C.cyan, '\nTool output truncation: ') + state);
            console.log(colorize(C.dim, `  Limit  : ${MAX_TOOL_OUTPUT_CHARS.toLocaleString()} chars (default: ${MAX_TOOL_OUTPUT_CHARS_DEFAULT.toLocaleString()})`));
            console.log(colorize(C.dim, '  /truncate on      — enable truncation'));
            console.log(colorize(C.dim, '  /truncate off     — disable truncation'));
            console.log(colorize(C.dim, '  /truncate <n>     — set limit to n chars\n'));
          }
          break;
        }


        // /plugins — list, reload, or scaffold custom tool plugins
        case 'plugins': {
          const plugSub = (parts[1] || '').toLowerCase();

          if (!plugSub || plugSub === 'list') {
            if (loadedPlugins.length === 0) {
              console.log(colorize(C.dim, '\n(no plugins loaded — drop .js files in ' + PLUGINS_DIR + ')\n'));
              console.log(colorize(C.dim, '  Use /plugins new <name> to scaffold a starter plugin.\n'));
            } else {
              console.log(colorize(C.cyan, '\nLoaded plugins (' + loadedPlugins.length + '):\n'));
              for (const p of loadedPlugins) {
                const desc = (p.def && p.def.function && p.def.function.description) || '(no description)';
                console.log('  ' + colorize(C.bold, p.name.padEnd(24)) + colorize(C.dim, desc));
              }
              console.log(colorize(C.dim, '\n  Plugin dir: ' + PLUGINS_DIR + '\n'));
              console.log(colorize(C.dim, '  /plugins reload      — reload all plugins from disk'));
              console.log(colorize(C.dim, '  /plugins new <name>  — scaffold a starter plugin\n'));
            }
            break;
          }

          if (plugSub === 'reload') {
            const count = loadPlugins();
            if (count === 0) {
              console.log(colorize(C.dim, '\n(0 plugins found in ' + PLUGINS_DIR + ')\n'));
            } else {
              console.log(colorize(C.green, '\n✔  Reloaded ' + count + ' plugin' + (count === 1 ? '' : 's') + ' from ' + PLUGINS_DIR + '\n'));
            }
            break;
          }

          if (plugSub === 'new') {
            const plugName = (parts[2] || '').replace(/[^a-z0-9_]/gi, '_').toLowerCase();
            if (!plugName) {
              console.log(colorize(C.red, '\n✗  Usage: /plugins new <name>\n'));
              console.log(colorize(C.dim, '   Example: /plugins new my_tool\n'));
              break;
            }
            fs.mkdirSync(PLUGINS_DIR, { recursive: true });
            const plugFile = path.join(PLUGINS_DIR, plugName + '.js');
            if (fs.existsSync(plugFile)) {
              console.log(colorize(C.yellow, '\n⚠  Plugin already exists: ' + plugFile + '\n'));
              console.log(colorize(C.dim, '   Edit it directly or delete it and run /plugins new again.\n'));
              break;
            }
            const template = [
              "module.exports = {",
              "  name: '" + plugName + "',",
              "  description: 'Describe what this tool does',",
              "  parameters: {",
              "    type: 'object',",
              "    properties: {",
              "      input: { type: 'string', description: 'The input' },",
              "    },",
              "    required: ['input'],",
              "  },",
              "  handler: async (args, ctx) => {",
              "    // ctx = { cwd, model, colorize, C, fs, path, execSync }",
              "    return 'Result: ' + args.input;",
              "  }",
              "};",
            ].join('\n');
            try {
              fs.writeFileSync(plugFile, template, 'utf8');
            } catch (e) {
              console.log(colorize(C.red, '\n✗  Could not write plugin file: ' + e.message + '\n'));
              break;
            }
            console.log(colorize(C.green, '\n✔  Plugin scaffolded: ' + plugFile + '\n'));
            console.log(colorize(C.dim, '   Edit the file to implement your tool, then run /plugins reload.\n'));
            // Open in $EDITOR if available
            const plugEditor = process.env.EDITOR;
            if (plugEditor) {
              try {
                execSync(plugEditor + ' ' + JSON.stringify(plugFile), { stdio: 'inherit' });
                const reloadCount = loadPlugins();
                console.log(colorize(C.green, '✔  Plugins reloaded (' + reloadCount + ' total).\n'));
              } catch (_) {}
            }
            break;
          }

          console.log(colorize(C.red, '\n✗  Unknown /plugins subcommand: "' + (parts[1] || '') + '"\n'));
          console.log(colorize(C.dim, '  /plugins              — list loaded plugins'));
          console.log(colorize(C.dim, '  /plugins reload       — reload all plugins from disk'));
          console.log(colorize(C.dim, '  /plugins new <name>   — scaffold a starter plugin\n'));
          break;
        }

        // /watch — file watcher status + toggle
        case 'watch': {
          const watchArg = (parts[1] || '').toLowerCase();
          if (watchArg === 'on') {
            _watcherEnabled = true;
            startFileWatcher(cwd);
            console.log(colorize(C.green, '\n✔  File watcher enabled.\n'));
          } else if (watchArg === 'off') {
            _watcherEnabled = false;
            stopFileWatcher();
            _changedFiles.clear();
            console.log(colorize(C.dim, '\n  File watcher disabled.\n'));
          } else {
            // Status display
            const statusLabel = _fileWatcher
              ? colorize(C.green, 'active')
              : (_watcherEnabled ? colorize(C.yellow, 'inactive (start failed)') : colorize(C.dim, 'disabled'));
            console.log(colorize(C.cyan, '\nFile Watcher'));
            console.log('  Status  : ' + statusLabel);
            console.log('  Watching: ' + colorize(C.dim, cwd));
            if (_changedFiles.size > 0) {
              console.log('  Changed : ' + colorize(C.yellow, _changedFiles.size + ' file(s) pending'));
              const list = [..._changedFiles].slice(0, 10);
              list.forEach(f => console.log('    ' + colorize(C.dim, f)));
              if (_changedFiles.size > 10) {
                console.log(colorize(C.dim, '    ...and ' + (_changedFiles.size - 10) + ' more'));
              }
            } else {
              console.log('  Changed : ' + colorize(C.dim, '(none since last interaction)'));
            }
            console.log(colorize(C.dim, '\n  /watch on   — enable watcher'));
            console.log(colorize(C.dim, '  /watch off  — disable watcher\n'));
          }
          break;
        }

        // /think [on|off|models] — toggle thinking mode for reasoning models
        case 'think': {
          const thinkArg = (parts[1] || '').toLowerCase();
          if (thinkArg === 'on') {
            thinkingEnabled = true;
            saveConfig();
            console.log(colorize(C.green, '\n✔  Thinking mode enabled.'));
            if (!modelSupportsThinking(model)) {
              console.log(colorize(C.yellow, '  Warning: ' + model + ' may not support structured thinking.'));
              console.log(colorize(C.dim, '  Use /models or /think models to see supported models.\n'));
            } else {
              console.log('');
            }
          } else if (thinkArg === 'off') {
            thinkingEnabled = false;
            saveConfig();
            console.log(colorize(C.dim, '\n  Thinking mode disabled.\n'));
          } else if (thinkArg === 'models') {
            console.log(colorize(C.cyan, '\nModels with thinking support:'));
            THINKING_MODELS.forEach(function(t) {
              console.log(colorize(C.dim, '  ' + t));
            });
            console.log('');
          } else {
            const state = thinkingEnabled ? colorize(C.green, 'on') : colorize(C.dim, 'off');
            console.log(colorize(C.cyan, '\nThinking mode: ') + state);
            console.log(colorize(C.dim, '  /think on      — Enable structured reasoning (injects <think> seed tag)'));
            console.log(colorize(C.dim, '  /think off     — Disable thinking mode'));
            console.log(colorize(C.dim, '  /think models  — List models with native thinking support\n'));
          }
          break;
        }

        // /config — persistent config management
        case 'config': {
          const cfgSub = (parts[1] || '').toLowerCase();
          const cfgKey = parts[2] || '';
          const cfgVal = parts[3] || '';

          if (cfgSub === 'reset') {
            model               = loadActiveModel('llama3.1:8b');
            critiqueEnabled     = true;
            cotEnabled          = false;
            multiAttemptEnabled = true;
            smartPreload        = true;
            diffPreviewEnabled  = true;
            autoCommitEnabled   = false;
            fallbackEnabled     = false;
            fallbackModel       = 'gpt-4o';
            planningEnabled     = true;
            tsCheckEnabled      = true;
            highlightEnabled    = true;
            _truncationEnabled  = true;
            MAX_TOOL_OUTPUT_CHARS = MAX_TOOL_OUTPUT_CHARS_DEFAULT;
            autoTestEnabled     = false;
            thinkingEnabled     = false;
            try {
              if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
              console.log(colorize(C.green, '\n✔  Config reset to defaults. config.json deleted.\n'));
            } catch (e) {
              console.log(colorize(C.red, `\n✗  Could not delete config file: ${e.message}\n`));
            }
            break;
          }

          if (cfgSub === 'set' && cfgKey && cfgVal !== '') {
            const boolKeys = ['critiqueEnabled','cotEnabled','multiAttemptEnabled','smartPreload',
              'diffPreviewEnabled','autoCommitEnabled','fallbackEnabled','planningEnabled',
              'tsCheckEnabled','highlightEnabled','_truncationEnabled','autoTestEnabled','thinkingEnabled'];
            if (boolKeys.includes(cfgKey)) {
              if (cfgVal !== 'true' && cfgVal !== 'false') {
                console.log(colorize(C.red, '\n✗  Boolean keys require "true" or "false".\n'));
                break;
              }
              // Dynamic assignment for boolean keys
              const bval = cfgVal === 'true';
              if      (cfgKey === 'critiqueEnabled')     critiqueEnabled     = bval;
              else if (cfgKey === 'cotEnabled')          cotEnabled          = bval;
              else if (cfgKey === 'multiAttemptEnabled') multiAttemptEnabled = bval;
              else if (cfgKey === 'smartPreload')        smartPreload        = bval;
              else if (cfgKey === 'diffPreviewEnabled')  diffPreviewEnabled  = bval;
              else if (cfgKey === 'autoCommitEnabled')   autoCommitEnabled   = bval;
              else if (cfgKey === 'fallbackEnabled')     fallbackEnabled     = bval;
              else if (cfgKey === 'planningEnabled')     planningEnabled     = bval;
              else if (cfgKey === 'tsCheckEnabled')      tsCheckEnabled      = bval;
              else if (cfgKey === 'highlightEnabled')    highlightEnabled    = bval;
              else if (cfgKey === '_truncationEnabled')  _truncationEnabled  = bval;
              else if (cfgKey === 'autoTestEnabled')     autoTestEnabled     = bval;
              else if (cfgKey === 'thinkingEnabled')     thinkingEnabled     = bval;
              saveConfig();
              console.log(colorize(C.green, `\n✔  ${cfgKey} = ${bval}\n`));
            } else if (cfgKey === 'model') {
              model = cfgVal;
              saveConfig();
              console.log(colorize(C.green, `\n✔  model = ${model}\n`));
            } else if (cfgKey === 'fallbackModel') {
              fallbackModel = cfgVal;
              saveConfig();
              console.log(colorize(C.green, `\n✔  fallbackModel = ${fallbackModel}\n`));
            } else if (cfgKey === 'MAX_TOOL_OUTPUT_CHARS') {
              const n = parseInt(cfgVal, 10);
              if (isNaN(n) || n < 1000) {
                console.log(colorize(C.red, '\n✗  Must be a number >= 1000.\n'));
              } else {
                MAX_TOOL_OUTPUT_CHARS = n;
                saveConfig();
                console.log(colorize(C.green, `\n✔  MAX_TOOL_OUTPUT_CHARS = ${n}\n`));
              }
            } else {
              console.log(colorize(C.red, `\n✗  Unknown config key: "${cfgKey}"\n`));
            }
            break;
          }

          // /config — show all settings
          const padKey = (k) => k.padEnd(28);
          console.log(colorize(C.cyan, '\nPersisted config settings:\n'));
          console.log(colorize(C.dim, '  ' + padKey('model')                  + model));
          console.log(colorize(C.dim, '  ' + padKey('critiqueEnabled')        + critiqueEnabled));
          console.log(colorize(C.dim, '  ' + padKey('cotEnabled')             + cotEnabled));
          console.log(colorize(C.dim, '  ' + padKey('multiAttemptEnabled')    + multiAttemptEnabled));
          console.log(colorize(C.dim, '  ' + padKey('smartPreload')           + smartPreload));
          console.log(colorize(C.dim, '  ' + padKey('diffPreviewEnabled')     + diffPreviewEnabled));
          console.log(colorize(C.dim, '  ' + padKey('autoCommitEnabled')      + autoCommitEnabled));
          console.log(colorize(C.dim, '  ' + padKey('fallbackEnabled')        + fallbackEnabled));
          console.log(colorize(C.dim, '  ' + padKey('fallbackModel')          + fallbackModel));
          console.log(colorize(C.dim, '  ' + padKey('planningEnabled')        + planningEnabled));
          console.log(colorize(C.dim, '  ' + padKey('tsCheckEnabled')         + tsCheckEnabled));
          console.log(colorize(C.dim, '  ' + padKey('highlightEnabled')       + highlightEnabled));
          console.log(colorize(C.dim, '  ' + padKey('_truncationEnabled')     + _truncationEnabled));
          console.log(colorize(C.dim, '  ' + padKey('MAX_TOOL_OUTPUT_CHARS')  + MAX_TOOL_OUTPUT_CHARS));
          console.log(colorize(C.dim, '  ' + padKey('thinkingEnabled')        + thinkingEnabled));
          console.log(colorize(C.dim, '  ' + padKey('autoTestEnabled')        + autoTestEnabled));
          console.log('');
          console.log(colorize(C.dim, '  /config set <key> <value>  — set a key live and persist it'));
          console.log(colorize(C.dim, '  /config reset              — delete config.json and revert to defaults\n'));
          break;
        }

        // /aside <question> — quick side question, doesn't touch conversation history (= /btw)
        case 'aside':
        case 'btw': {
          const asideQ = parts.slice(1).join(' ').trim();
          if (!asideQ) { console.log(colorize(C.red, '\n✗  Usage: /aside <question>\n')); break; }
          rl.pause();
          console.log(colorize(C.dim, '\n  (aside — not added to context)\n'));
          const asideMsgs = [
            { role: 'system', content: 'You are a quick-answer assistant. Be concise — this is a side question, not part of the main conversation.' },
            { role: 'user', content: asideQ },
          ];
          try {
            const asideReply = await agentLoop(asideMsgs);
            console.log(colorize(C.cyan, '\nproverbs (aside)> ') + renderResponse(asideReply) + '\n');
          } catch (e) { console.log(colorize(C.red, `\n✗  ${e.message}\n`)); }
          rl.resume();
          break;
        }

        // /rewind [n] — roll back last N conversation turns (default 1) (= /checkpoint)
        case 'rewind': {
          const n = Math.max(1, parseInt(parts[1], 10) || 1);
          const removePairs = n * 2; // each turn = user + assistant
          if (history.length === 0) { console.log(colorize(C.yellow, '\n  Nothing to rewind.\n')); break; }
          const removed = Math.min(removePairs, history.length);
          history.splice(history.length - removed);
          const turns = Math.floor(removed / 2);
          console.log(colorize(C.green, `\n✔  Rewound ${turns} turn${turns === 1 ? '' : 's'}. Conversation is now ${Math.floor(history.length / 2)} turns.\n`));
          break;
        }

        // /review [low|med|high|max] — AI code review of current git diff (= /code-review)
        case 'review': {
          const depth = (parts[1] || 'med').toLowerCase();
          const depthMap = { low: 'briefly', med: 'thoroughly', high: 'exhaustively', max: 'exhaustively, including edge cases, security, and performance' };
          const depthWord = depthMap[depth] || depthMap.med;
          rl.pause();
          let diffOut = '';
          try { diffOut = require('child_process').execSync('git diff HEAD', { cwd, encoding: 'utf8', maxBuffer: 200000 }); } catch (_) {}
          if (!diffOut.trim()) {
            try { diffOut = require('child_process').execSync('git diff --cached', { cwd, encoding: 'utf8', maxBuffer: 200000 }); } catch (_) {}
          }
          if (!diffOut.trim()) { console.log(colorize(C.yellow, '\n  No uncommitted changes to review.\n')); rl.resume(); break; }
          const reviewPrompt = `Review this git diff ${depthWord}. Find: bugs, logic errors, security issues, missing error handling, and style issues. For each finding: file:line, severity (Critical/High/Medium/Low), and exact fix.\n\n\`\`\`diff\n${diffOut.slice(0, 12000)}\n\`\`\``;
          console.log(colorize(C.dim, `\n  Reviewing diff [${depth}]...\n`));
          try {
            const review = await agentLoop([{ role: 'system', content: buildSystemPrompt() }, { role: 'user', content: reviewPrompt }]);
            console.log(colorize(C.cyan, '\nproverbs> ') + renderResponse(review) + '\n');
          } catch (e) { console.log(colorize(C.red, `\n✗  ${e.message}\n`)); }
          rl.resume();
          break;
        }

        // /usage — session stats: turns, token estimate, uptime, model (= /stats)
        case 'usage':
        case 'stats2': {
          const turns = Math.floor(history.length / 2);
          const estToks = history.reduce((s, m) => s + Math.ceil((m.content || '').length / 4), 0);
          const uptimeSec = Math.floor((Date.now() - _sessionStartMs) / 1000);
          const h = Math.floor(uptimeSec / 3600), m2 = Math.floor((uptimeSec % 3600) / 60), s2 = uptimeSec % 60;
          const uptime = h ? `${h}h ${m2}m` : m2 ? `${m2}m ${s2}s` : `${s2}s`;
          console.log(colorize(C.cyan, '\n  Session Usage\n'));
          console.log(`    Model       : ${model}`);
          console.log(`    Backend     : ${activeBackendName}`);
          console.log(`    Uptime      : ${uptime}`);
          console.log(`    Turns       : ${turns}`);
          console.log(`    Est. tokens : ~${estToks.toLocaleString()}`);
          if (_PERF_RING.length > 0) {
            const avg = Math.round(_PERF_RING.reduce((a, b) => a + b.ms, 0) / _PERF_RING.length);
            console.log(`    Avg latency : ${avg} ms`);
          }
          loadProjectKnowledge();
          console.log(`    Facts saved : ${getKnowledgeFacts(cwd).length}`);
          console.log('');
          break;
        }

        // /export [filename] — export full conversation as markdown
        case 'export': {
          const expName = parts.slice(1).join(' ').trim() || `proverbs-session-${new Date().toISOString().slice(0,10)}`;
          const expFile = expName.endsWith('.md') ? expName : expName + '.md';
          const expPath = path.isAbsolute(expFile) ? expFile : path.join(cwd, expFile);
          let md = `# Proverbs Session Export\n\n**Date:** ${new Date().toLocaleString()}\n**Model:** ${model}\n**CWD:** ${cwd}\n\n---\n\n`;
          for (const msg of history) {
            const role = msg.role === 'user' ? '### You' : '### Proverbs';
            md += `${role}\n\n${msg.content}\n\n`;
          }
          try {
            fs.writeFileSync(expPath, md, 'utf8');
            console.log(colorize(C.green, `\n✔  Exported ${Math.floor(history.length/2)} turns → ${expPath}\n`));
          } catch (e) { console.log(colorize(C.red, `\n✗  Export failed: ${e.message}\n`)); }
          break;
        }

        // /rename <name> — rename the current session
        case 'rename': {
          const newName = parts.slice(1).join(' ').trim();
          if (!newName) { console.log(colorize(C.red, '\n✗  Usage: /rename <name>\n')); break; }
          _currentSessionName = newName;
          console.log(colorize(C.green, `\n✔  Session renamed to "${newName}"\n`));
          console.log(colorize(C.dim, '  Use /save to persist it.\n'));
          break;
        }

        // /recap — AI one-line summary of what this session accomplished
        case 'recap': {
          if (history.length < 2) { console.log(colorize(C.dim, '\n  (nothing to recap yet)\n')); break; }
          rl.pause();
          const recapMsgs = [
            { role: 'system', content: 'Summarize what was accomplished in this conversation in ONE sentence (max 20 words). Be specific — name files changed, features added, bugs fixed.' },
            ...history.slice(-10),
            { role: 'user', content: 'Recap this session in one sentence.' },
          ];
          try {
            const recap = await agentLoop(recapMsgs);
            console.log(colorize(C.cyan, `\n  Session recap: `) + recap.trim() + '\n');
          } catch (e) { console.log(colorize(C.red, `\n✗  ${e.message}\n`)); }
          rl.resume();
          break;
        }

        // /check — full system diagnostic (= /doctor)
        case 'check':
        case 'doctor': {
          const OK = colorize(C.green, '✔'); const ERR = colorize(C.red, '✗'); const WARN = colorize(C.yellow, '⚠');
          console.log(colorize(C.cyan, '\n  Proverbs System Check\n'));
          // Backend
          const ping2 = await pingBackend().catch(() => ({ ok: false, error: 'timeout' }));
          console.log(`  [${ping2.ok ? OK : ERR}] LLM Backend (${activeBackendName}) ${ping2.ok ? '— ' + ping2.ms + 'ms' : '— ' + (ping2.error || 'unreachable')}`);
          // Models dir
          const modDir = path.join(require('os').homedir(), '.proverbs', 'models');
          const ggufFiles = fs.existsSync(modDir) ? fs.readdirSync(modDir).filter(f => f.endsWith('.gguf')) : [];
          console.log(`  [${ggufFiles.length > 0 ? OK : WARN}] GGUF models: ${ggufFiles.length > 0 ? ggufFiles.join(', ') : 'none found in ' + modDir}`);
          // Tokenizer
          const tokPath = path.join(require('os').homedir(), '.proverbs', 'tokenizer.json');
          console.log(`  [${fs.existsSync(tokPath) ? OK : WARN}] Tokenizer: ${fs.existsSync(tokPath) ? tokPath : 'not trained — run /train tokenizer'}`);
          // Checkpoint
          const ckptPath = path.join(require('os').homedir(), '.proverbs', 'checkpoints', 'local', 'best.pt');
          console.log(`  [${fs.existsSync(ckptPath) ? OK : WARN}] Custom checkpoint: ${fs.existsSync(ckptPath) ? ckptPath : 'none — run /train local to train one'}`);
          // venv_llm
          const venvPy = path.join(__dirname.replace('/dist',''), 'venv_llm', 'bin', 'python3');
          console.log(`  [${fs.existsSync(venvPy) ? OK : ERR}] Python venv (venv_llm): ${fs.existsSync(venvPy) ? venvPy : 'missing — run: python3.12 -m venv venv_llm && venv_llm/bin/pip install torch'}`);
          // Rules
          const ruleCount = loadRules().length;
          console.log(`  [${OK}] Admin rules: ${ruleCount}`);
          // Facts
          loadProjectKnowledge();
          const factCount2 = getKnowledgeFacts(cwd).length;
          console.log(`  [${OK}] Project facts: ${factCount2} for ${cwd}`);
          // Sessions
          const sessCount = listSavedSessions().length;
          console.log(`  [${OK}] Saved sessions: ${sessCount}`);
          // Node version
          const nodeMaj = parseInt(process.version.slice(1));
          console.log(`  [${nodeMaj >= 18 ? OK : ERR}] Node.js: ${process.version} (need >= 18)`);
          console.log('');
          break;
        }

        // /init — generate .proverbs project profile from scratch (= /scan alias with explanation)
        case 'init': {
          rl.pause();
          console.log(colorize(C.dim, '\n  Generating .proverbs project profile (like CLAUDE.md)...\n'));
          const initPrompt = `Analyze the project at ${cwd} and write a .proverbs profile. Include:
1. Project name and one-line description
2. Tech stack (languages, frameworks, databases)
3. Key files and their purposes
4. Coding conventions observed
5. Rules for working on this codebase (e.g. always use TypeScript strict, never use any)
6. Gotchas or important context

Output ONLY the .proverbs file content — no explanation. Start with: # Project: <name>`;
          try {
            const initReply = await agentLoop([
              { role: 'system', content: `You are a codebase analyst. ${buildSystemPrompt()}` },
              { role: 'user', content: initPrompt },
            ]);
            const proverbsPath = path.join(cwd, '.proverbs');
            fs.writeFileSync(proverbsPath, initReply, 'utf8');
            console.log(colorize(C.green, `\n✔  .proverbs written to ${proverbsPath}\n`));
            proverbsProfile = initReply;
            console.log(colorize(C.dim, '  Profile is now active in this session.\n'));
          } catch (e) { console.log(colorize(C.red, `\n✗  ${e.message}\n`)); }
          rl.resume();
          break;
        }

        // /effort [low|fast|med|high|max] — set reasoning depth (= /effort in Claude Code)
        case 'effort': {
          const effortLevel = (parts[1] || '').toLowerCase();
          const effortMap = {
            low:  { cot: false, think: false, attempts: 1, label: 'low  — fast, minimal reasoning' },
            fast: { cot: false, think: false, attempts: 1, label: 'fast — same as low' },
            med:  { cot: true,  think: false, attempts: 1, label: 'med  — chain-of-thought on' },
            high: { cot: true,  think: true,  attempts: 2, label: 'high — thinking + multi-attempt' },
            max:  { cot: true,  think: true,  attempts: MULTI_ATTEMPT_MAX, label: 'max  — full reasoning + retries' },
          };
          if (!effortLevel || !effortMap[effortLevel]) {
            const cur = thinkingEnabled ? 'high/max' : cotEnabled ? 'med' : 'low';
            console.log(colorize(C.cyan, '\nEffort levels:\n'));
            Object.entries(effortMap).forEach(([k, v]) => {
              const active = (k === 'low' || k === 'fast') ? !cotEnabled && !thinkingEnabled
                           : k === 'med' ? cotEnabled && !thinkingEnabled
                           : thinkingEnabled;
              console.log(`  ${active ? colorize(C.green, '●') : ' '} /effort ${k.padEnd(5)} — ${v.label}`);
            });
            console.log('');
            break;
          }
          const cfg2 = effortMap[effortLevel];
          cotEnabled      = cfg2.cot;
          thinkingEnabled = cfg2.think;
          multiAttemptEnabled = cfg2.attempts > 1;
          saveConfig();
          console.log(colorize(C.green, `\n✔  Effort set to ${effortLevel}: ${cfg2.label}\n`));
          break;
        }

        // /branch [name] — save current history as a named conversation branch
        case 'branch': {
          const branchName = parts.slice(1).join(' ').trim() || `branch-${Date.now()}`;
          const branchDir = path.join(PROVERBS_DIR, 'branches');
          fs.mkdirSync(branchDir, { recursive: true });
          const branchFile = path.join(branchDir, branchName.replace(/[^a-zA-Z0-9_\-]/g, '_') + '.json');
          const branchData = { name: branchName, history: [...history], cwd, model, createdAt: new Date().toISOString() };
          fs.writeFileSync(branchFile, JSON.stringify(branchData, null, 2), 'utf8');
          console.log(colorize(C.green, `\n✔  Branch "${branchName}" saved (${Math.floor(history.length/2)} turns).\n`));
          console.log(colorize(C.dim, `  To restore: /checkout ${branchName}\n`));
          break;
        }

        // /checkout <branch> — restore a saved conversation branch
        case 'checkout': {
          const chkName = parts.slice(1).join(' ').trim();
          if (!chkName) {
            const branchDir2 = path.join(PROVERBS_DIR, 'branches');
            const branches = fs.existsSync(branchDir2) ? fs.readdirSync(branchDir2).filter(f => f.endsWith('.json')).map(f => f.replace('.json','')) : [];
            if (!branches.length) { console.log(colorize(C.dim, '\n  No branches saved yet. Use /branch <name> to create one.\n')); break; }
            console.log(colorize(C.cyan, `\nSaved branches:\n`));
            branches.forEach(b => console.log(`  ${b}`));
            console.log('');
            break;
          }
          const branchDir3 = path.join(PROVERBS_DIR, 'branches');
          const branchFile2 = path.join(branchDir3, chkName.replace(/[^a-zA-Z0-9_\-]/g, '_') + '.json');
          if (!fs.existsSync(branchFile2)) { console.log(colorize(C.red, `\n✗  Branch "${chkName}" not found.\n`)); break; }
          try {
            const bd = JSON.parse(fs.readFileSync(branchFile2, 'utf8'));
            history = bd.history || [];
            console.log(colorize(C.green, `\n✔  Restored branch "${chkName}" (${Math.floor(history.length/2)} turns).\n`));
          } catch (e) { console.log(colorize(C.red, `\n✗  ${e.message}\n`)); }
          break;
        }

        // /fork <task> — spin off a parallel sub-agent on a task (non-blocking)
        case 'fork': {
          const forkTask = parts.slice(1).join(' ').trim();
          if (!forkTask) { console.log(colorize(C.red, '\n✗  Usage: /fork <task description>\n')); break; }
          rl.pause();
          console.log(colorize(C.dim, `\n  Forking sub-agent: "${forkTask}"\n`));
          const forkCtx = history.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n');
          const forkMsgs = [
            { role: 'system', content: buildSystemPrompt() + (forkCtx ? `\n\nRecent context:\n${forkCtx}` : '') },
            { role: 'user', content: forkTask },
          ];
          agentLoop(forkMsgs).then(reply => {
            console.log(colorize(C.cyan, `\n  [fork] ${forkTask}\n`) + renderResponse(reply) + '\n');
            rl.prompt();
          }).catch(e => {
            console.log(colorize(C.red, `\n  [fork] Error: ${e.message}\n`));
            rl.prompt();
          });
          console.log(colorize(C.dim, '  (running in background — you can keep chatting)\n'));
          rl.resume();
          break;
        }

        // /goal <condition> — keep working until condition is met (max 10 iterations)
        case 'goal': {
          const goalCond = parts.slice(1).join(' ').trim();
          if (!goalCond) { console.log(colorize(C.red, '\n✗  Usage: /goal <condition that must be true when done>\n')); break; }
          rl.pause();
          console.log(colorize(C.cyan, `\n  Goal: "${goalCond}"\n`));
          const MAX_GOAL_ITERS = 10;
          let goalDone = false;
          for (let gi = 1; gi <= MAX_GOAL_ITERS && !goalDone; gi++) {
            console.log(colorize(C.dim, `  Iteration ${gi}/${MAX_GOAL_ITERS}...`));
            const goalMsgs = [
              { role: 'system', content: buildSystemPrompt() + `\n\nYou have a goal to achieve: "${goalCond}"\nWork toward it. After completing work, check: is the goal met? End your reply with either "GOAL_MET" or "GOAL_NOT_MET".` },
              ...history.slice(-4),
              { role: 'user', content: gi === 1 ? `Work toward this goal: ${goalCond}` : `Continue working toward the goal. Iteration ${gi}.` },
            ];
            try {
              const goalReply = await agentLoop(goalMsgs);
              console.log(colorize(C.cyan, '\nproverbs> ') + renderResponse(goalReply.replace(/GOAL_(MET|NOT_MET).*$/, '').trim()) + '\n');
              history.push({ role: 'user', content: goalMsgs[goalMsgs.length - 1].content });
              history.push({ role: 'assistant', content: goalReply });
              if (goalReply.includes('GOAL_MET')) {
                goalDone = true;
                console.log(colorize(C.green, `\n  ✔  Goal met after ${gi} iteration${gi === 1 ? '' : 's'}.\n`));
              }
            } catch (e) { console.log(colorize(C.red, `\n✗  ${e.message}\n`)); break; }
          }
          if (!goalDone) console.log(colorize(C.yellow, `\n  ⚠  Goal not confirmed met after ${MAX_GOAL_ITERS} iterations.\n`));
          rl.resume();
          break;
        }

        default: {
          // Custom markdown slash-commands: ~/.proverbs/commands/<cmd>.md
          // (and the bundled ones like /demovid, /fullsend). Reading the file,
          // substituting $ARGUMENTS, and routing it through the agent loop lets
          // any .md workflow become a first-class Proverbs command.
          const _mdCmd = _findMarkdownCommand(cmd);
          if (_mdCmd) {
            const _cmdArgs = parts.slice(1).join(' ').trim();
            let _spec = '';
            try { _spec = fs.readFileSync(_mdCmd, 'utf8'); } catch (_) {}
            // Strip YAML frontmatter, substitute $ARGUMENTS.
            _spec = _spec.replace(/^---\n[\s\S]*?\n---\n/, '');
            _spec = _spec.split('$ARGUMENTS').join(_cmdArgs || '(none provided)');
            console.log(colorize(C.cyan, `\n  ⬡ Running /${cmd}${_cmdArgs ? ' ' + _cmdArgs : ''}...\n`));
            rl.pause();
            const _cmdMsgs = [
              { role: 'system', content: buildSystemPrompt() },
              ...history.slice(-4),
              { role: 'user', content: 'Execute this workflow/command spec exactly. Use your tools to do the work — do not just describe it.\n\n' + _spec },
            ];
            try {
              const _cmdReply = await routedAgentLoop(_cmdMsgs, '/' + cmd);
              history.push({ role: 'user', content: '/' + cmd + (_cmdArgs ? ' ' + _cmdArgs : '') });
              history.push({ role: 'assistant', content: _cmdReply });
              console.log(colorize(C.greenBold, '\nproverbs> ') + renderResponse(_cmdReply) + '\n');
              printClosingVerse();
            } catch (e) {
              console.error(colorize(C.red, `\n✗  /${cmd} failed: ${e.message}\n`));
            }
            rl.resume();
            break;
          }
          console.log(colorize(C.red, `Unknown command: /${cmd}. Type /help for commands.\n`));
        }
      }

      rl.prompt();
      return;
    }

    // ── Natural-language preview shortcut ───────────────────────────────────
    // "show preview", "show preview 3001", "preview my app", "open preview" etc.
    if (/^(show|open|launch|view)?\s*preview(\s+\S+)?$/i.test(input.trim())) {
      const _nlpvMatch = input.trim().match(/preview\s+(\S+)/i);
      const _nlpvArg = _nlpvMatch ? _nlpvMatch[1] : '';
      let _nlpvUrl;
      if (_nlpvArg.startsWith('http')) {
        _nlpvUrl = _nlpvArg;
      } else {
        const _nlpvPort = parseInt(_nlpvArg, 10) || 3000;
        _nlpvUrl = 'http://localhost:' + _nlpvPort;
      }
      const _nlpvTitle = path.basename(cwd);
      const _nlpvDir   = path.join(PROVERBS_SRC_DIR, 'preview');
      const _nlpvMain  = path.join(_nlpvDir, 'main.js');
      const _nlpvElBin = path.join(_nlpvDir, 'node_modules', '.bin', 'electron');
      if (!fs.existsSync(_nlpvMain)) {
        console.log(colorize(C.red, '\n✗  Preview app not found. Expected: ' + _nlpvMain + '\n'));
        rl.prompt(); return;
      }
      const _nlpvTargetPort = parseInt(_nlpvUrl.split(':').pop().split('/')[0], 10) || 3000;
      const _nlpvRunning = await new Promise(resolve => {
        const _n = require('net');
        const _s = _n.createConnection({ port: _nlpvTargetPort, host: '127.0.0.1' }, () => { _s.destroy(); resolve(true); });
        _s.on('error', () => resolve(false));
      });
      if (!_nlpvRunning) {
        try {
          const _npkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
          const _nscr = _npkg.scripts || {};
          const _ncmd = _nscr.dev ? 'npm run dev' : _nscr.start ? 'npm start' : _nscr.preview ? 'npm run preview' : null;
          if (_ncmd) {
            console.log(colorize(C.dim, '\n  Starting dev server: ' + _ncmd + '\n'));
            require('child_process').spawn('bash', ['-c', _ncmd], { cwd, detached: true, stdio: 'ignore' }).unref();
            await new Promise(r => setTimeout(r, 3000));
          } else {
            console.log(colorize(C.yellow, '\n  No dev server detected on port ' + _nlpvTargetPort + '. Start your app first.\n'));
          }
        } catch (_) {
          console.log(colorize(C.yellow, '\n  No server on port ' + _nlpvTargetPort + '. Start your app, then "show preview" again.\n'));
        }
      }
      if (!fs.existsSync(_nlpvElBin)) {
        console.log(colorize(C.cyan, '\n  First run: installing preview window (~30s)...\n'));
        try {
          require('child_process').execSync('npm install --prefer-offline', { cwd: _nlpvDir, stdio: 'inherit', timeout: 180000 });
        } catch (_) { console.log(colorize(C.red, '\n✗  Install failed. Run: cd ' + _nlpvDir + ' && npm install\n')); rl.prompt(); return; }
      }
      const _nlpvProc = require('child_process').spawn(_nlpvElBin, [_nlpvMain, '--url', _nlpvUrl, '--title', _nlpvTitle], {
        detached: true, stdio: 'ignore', cwd: _nlpvDir,
      });
      _nlpvProc.unref();
      console.log(colorize(C.green, '\n  ✓ Preview window opened → ' + _nlpvUrl + '\n'));
      rl.prompt(); return;
    }

    // ── Cross-file edit planner ─────────────────────────────────────────────
    if (planningEnabled && looksMultiFile(input)) {
      console.log(colorize(C.dim, '  Generating change plan...'));
      const planMsgs = [
        { role: 'system', content: buildSystemPrompt() },
        ...history,
        { role: 'user', content: 'List ALL files you will need to create or modify for this task. Format: FILE: <path> — <what changes>. Be concise.\n\nTask: ' + input },
      ];
      try {
        rl.pause();
        let planReply;
        try {
          planReply = await routedAgentLoop(planMsgs, input);
        } catch (planLoopErr) {
          console.log(colorize(C.red, '  Plan generation failed: ' + (planLoopErr && planLoopErr.message ? planLoopErr.message : String(planLoopErr)) + ' — proceeding without plan.'));
          planReply = null;
        }
        if (planReply !== null) {
          console.log(colorize(C.cyan, '\n  Files to change:') + '\n' + planReply + '\n');
          let answer = 'y';
          // Only prompt interactively when stdin is a TTY.  In piped/scripted
          // mode rl.question internally resumes readline, allowing buffered
          // commands (e.g. /exit) to fire before the main agent loop runs —
          // causing a premature exit race condition.
          if (process.stdin.isTTY) {
            try {
              answer = await new Promise((res, rej) => {
                rl.question(colorize(C.cyan, '  Proceed? [Y/n]: '), res);
                rl.once('close', () => rej(new Error('readline closed')));
              });
            } catch (_) {
              answer = 'y';
            }
          } else {
            // Non-interactive: auto-confirm and keep readline paused.
            console.log(colorize(C.dim, '  (non-interactive — auto-confirming plan)\n'));
          }
          // Ensure readline stays paused for the main agent loop below.
          rl.pause();
          if ((answer || '').trim().toLowerCase() === 'n') {
            console.log(colorize(C.dim, '  Cancelled.\n'));
            rl.resume();
            rl.prompt();
            return;
          }
          history.push({ role: 'assistant', content: 'Change plan:\n' + planReply });
        }
      } catch (outerErr) {
        try { rl.resume(); } catch (_) {}
        console.log(colorize(C.red, '  Planner error: ' + (outerErr && outerErr.message ? outerErr.message : String(outerErr)) + ' — proceeding without plan.'));
      }
    }

    // ── Regular message → agent loop ────────────────────────────────────────
    syntaxRetryCount = 0;

    // Alert + confirm before the model/backend ("language") switches this turn.
    if (!(await confirmBackendIfChanged(rl))) { rl.resume(); rl.prompt(); return; }

    // NOTE: do NOT rl.pause() here. Keeping the readline stream live during
    // generation lets the 'line' handler fire for type-ahead, so messages
    // typed mid-reply get queued (see _inputQueue) instead of being lost.

    // Clipboard: prepend pending clipboard content if set
    let userInput = input;
    if (_pendingClipboard) {
      userInput = input + '\n\nClipboard:\n' + _pendingClipboard;
      _pendingClipboard = null;
    }

    const messages = [
      { role: 'system', content: buildSystemPrompt() },
      ...history,
      { role: 'user', content: userInput },
    ];

    try {
      const sysPrompt = messages[0].content;
      const reply = await routedAgentLoop(messages, userInput);

      // Self-critique loop: review code output and re-generate if issues found
      if (critiqueEnabled && responseHasCode(reply) && reply.split('\n').length >= critiqueThreshold) {
        console.log(colorize(C.dim, '  (running self-critique...)'));
        const critique = await runSelfCritique(userInput, reply, messages);
        if (critique && critique !== 'No issues found.' && !critique.toLowerCase().includes('no issues')) {
          console.log(colorize(C.yellow, '\n  Self-critique found issues:') + '\n  ' + critique);
          console.log(colorize(C.dim, '  (re-generating with fixes...)'));
          const fixMessages = [
            ...messages,
            { role: 'assistant', content: reply },
            { role: 'user', content: 'Fix these issues in your previous response:\n' + critique + '\nProvide the corrected version only.' },
          ];
          const fixedReply = await routedAgentLoop(fixMessages, userInput + ' [critique fix]');
          history.push({ role: 'user', content: userInput });
          history.push({ role: 'assistant', content: fixedReply });
          lastAssistantReply = fixedReply;
          logExchange(sysPrompt, userInput, fixedReply);
          console.log(colorize(C.greenBold, '\nproverbs> ') + renderResponse(fixedReply) + '\n');
          printClosingVerse();
          await showContextGauge(messages);
          if (showTokenCount) {
            const _tc = await countMessagesTokens(messages);
            const _tw = getContextWindow(model);
            console.log(colorize(C.dim, '  [~' + _tc.toLocaleString() + ' tokens used / ' + _tw.toLocaleString() + ' context]'));
          }
          rl.resume();
          await checkAndOfferCommit(rl);
          rl.prompt();
          return;
        } else {
          console.log(colorize(C.dim, '  ✓ Self-critique: no issues found'));
        }
      }

      // ── Test Engine gate ────────────────────────────────────────────────────
      // If the turn changed code, run the project's real checks and let the
      // agent self-correct on failure. The report is printed after the reply so
      // the user always sees whether the work was actually verified.
      let _verifyReport = null;
      let finalReply = reply;
      if (verifyEnabled) {
        try {
          const v = await verifyAndSelfCorrect(userInput, messages, reply);
          if (v.ran) { _verifyReport = v.report; finalReply = v.reply; }
        } catch (verErr) {
          _verifyReport = colorize(C.dim, '  ⓘ  Verification skipped: ' + verErr.message);
        }
      }
      _filesTouchedThisTurn.clear();

      history.push({ role: 'user', content: userInput });
      history.push({ role: 'assistant', content: finalReply });
      lastAssistantReply = finalReply;
      logExchange(sysPrompt, userInput, finalReply);
      _saveProjectContextMemory(cwd, userInput); // persist last task for /switch

      console.log(colorize(C.greenBold, '\nproverbs> ') + renderResponse(finalReply) + '\n');
      if (_verifyReport) console.log(_verifyReport + '\n');
      printClosingVerse();

      // Auto-rebuild after self-modification
      if (_isSelfMod && _selfModUnlocked) { await selfModRebuild(); _selfModUnlocked = false; }
      await showContextGauge(messages);
      if (showTokenCount) {
        const _tc = await countMessagesTokens(messages);
        const _tw = getContextWindow(model);
        console.log(colorize(C.dim, '  [~' + _tc.toLocaleString() + ' tokens used / ' + _tw.toLocaleString() + ' context]'));
      }
    } catch (err) {
      if (err.code === 'CREDITS_REQUIRED') {
        console.error(colorize(C.red, '\n✗  Cloud fallback: Anthropic API credits exhausted.'));
        console.log(colorize(C.yellow, '   Top up at: https://console.anthropic.com/plans'));
        console.log(colorize(C.dim,    '   Disabling cloud fallback — switching to local model.\n'));
        fallbackEnabled = false;
      } else {
        console.error(colorize(C.red, `\n✗  Error: ${err.message}\n`));
      }
    }

    rl.resume();
    await checkAndOfferCommit(rl);
    rl.prompt();
  });

  rl.on('close', () => {
    console.log(colorize(C.dim, '\nSession ended.\n'));
    process.exit(0);
  });

  process.on('SIGINT', () => {
    if (_isGenerating && _abortController) {
      // Cancel the current generation and return to prompt.
      _abortController.abort();
      process.stdout.write('\n');
      const _dropped = _inputQueue.length;
      _inputQueue = []; // interrupt cancels queued type-ahead too
      console.log(colorize(C.yellow, '  (interrupted' + (_dropped ? ', ' + _dropped + ' queued message' + (_dropped !== 1 ? 's' : '') + ' discarded' : '') + ')\n'));
      _isGenerating    = false;
      _abortController = null;
      rl.resume();
      rl.prompt();
    } else {
      // Not generating — normal exit.
      console.log(colorize(C.dim, '\n\nGoodbye.\n'));
      process.exit(0);
    }
  });
}

// ─── CLI arg entrypoint ───────────────────────────────────────────────────────
const argv = process.argv.slice(2);

if (argv[0] === 'admin') {
  const adminArgs = argv.slice(1).join(' ').trim();
  handleAdmin(adminArgs);
  process.exit(0);
}

if (argv[0] === 'projects' || argv[0] === 'project') {
  handleProjectCmd(argv.slice(1).join(' ').trim());
  process.exit(0);
}

if (argv[0] === 'finetune' || argv[0] === 'ft') {
  const sub = argv[1] || '';
  const ftDir = path.join(__dirname, 'finetune');
  if (sub === 'bake') {
    execSync(`bash "${path.join(ftDir, 'bake_model.sh')}"`, { stdio: 'inherit' });
  } else if (sub === 'format') {
    execSync(`~/.proverbs/venv/bin/python "${path.join(ftDir, 'format_data.py')}"`, { stdio: 'inherit' });
  } else if (sub === 'upload') {
    execSync(`~/.proverbs/venv/bin/python "${path.join(ftDir, 'upload_hf.py')}"`, { stdio: 'inherit' });
  } else if (sub === 'import' && argv[2]) {
    execSync(`bash "${path.join(ftDir, 'import_model.sh')}" "${argv[2]}"`, { stdio: 'inherit' });
  } else {
    console.log(`\nProverbs fine-tuning pipeline:\n`);
    console.log(`  proverbs finetune bake           — Bake admin rules into Ollama (instant)`);
    console.log(`  proverbs finetune format         — Format session logs as training data`);
    console.log(`  proverbs finetune upload         — Upload to Hugging Face AutoTrain`);
    console.log(`  proverbs finetune import <path>  — Import a fine-tuned .gguf model\n`);
  }
  process.exit(0);
}

// When run directly, start the CLI. When require()'d (e.g. by the recovery
// test harness), export the self-heal internals instead so they can be
// exercised without booting the whole REPL.
if (require.main === module) {
  main().catch((err) => {
    console.error(colorize(C.red, `Fatal: ${err.message}`));
    process.exit(1);
  });
} else {
  module.exports = {
    _errorSignature,
    _isConnectionError,
    _healbookLoad,
    _healbookSave,
    _todayKey,
    _claudeCallsToday,
    _claudeHealAllowed,
    _runClaudeHeal,
    _selfHeal,
    _serverHealthy,
    _resetHealAttempts,
    toolAskUser,
  };
}
