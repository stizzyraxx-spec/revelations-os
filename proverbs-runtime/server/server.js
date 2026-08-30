#!/usr/bin/env node
// ─── Proverbs Inference Server v3.0.0 ────────────────────────────────────────
// Smart cascade router: Claude API (primary) → local GGUF (offline fallback).
// Exposes Ollama-compatible API at localhost:11435.
//
// Usage: node server.js [--port 11435] [--models-dir ~/.proverbs/models]

import http  from 'http';
import https from 'https';
import fs    from 'fs';
import path  from 'path';
import os    from 'os';
import net   from 'net';
import { getLlama, LlamaChatSession } from 'node-llama-cpp';

// ─── Config ───────────────────────────────────────────────────────────────────
const argv      = process.argv.slice(2);
const portIdx   = argv.indexOf('--port');
const modelsIdx = argv.indexOf('--models-dir');

const PORT       = portIdx   !== -1 ? parseInt(argv[portIdx + 1], 10)  : (parseInt(process.env.PROVERBS_SERVER_PORT, 10) || 11435);
const MODELS_DIR = modelsIdx !== -1 ? argv[modelsIdx + 1] : (process.env.PROVERBS_MODELS_DIR || path.join(os.homedir(), '.proverbs', 'models'));
const CONFIG_PATH = path.join(os.homedir(), '.proverbs', 'config.json');

fs.mkdirSync(MODELS_DIR, { recursive: true });

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) { return {}; }
}
function writeConfig(patch) {
  const existing = readConfig();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...existing, ...patch }, null, 2));
}

function getApiKey()    { return process.env.ANTHROPIC_API_KEY || readConfig().anthropicApiKey || ''; }
function getCloudModel(){ return process.env.PROVERBS_CLOUD_MODEL || readConfig().cloudModel || TIERS.cheap; }
function isCloudForced(){ const m = readConfig().cloudMode; return m === 'force-cloud'; }
function isLocalForced(){ const m = readConfig().cloudMode; return m === 'force-local'; }

// ─── Model tiers ──────────────────────────────────────────────────────────────
// Prices are $ per 1M tokens (input / output), used for the local cost estimate.
const TIERS = {
  cheap: 'claude-haiku-4-5',   // boilerplate, renames, formatting, status checks
  mid:   'claude-sonnet-5',    // day-to-day coding
  deep:  'claude-opus-5',      // architecture, multi-file refactors, hard debugging
};

const PRICING = {
  'claude-haiku-4-5':  { in: 1.00, out:  5.00 },
  'claude-sonnet-5':   { in: 3.00, out: 15.00 },
  'claude-opus-5':     { in: 5.00, out: 25.00 },
};

// Auto-tier picks the cheapest model that fits the task, unless the user pinned
// one via /cloud model or PROVERBS_CLOUD_MODEL. Escalation is deliberately
// conservative: it only fires on signals that reliably mean "hard".
const ESCALATE_DEEP = /\b(architect(ure)?|refactor|redesign|migrat(e|ion)|security\s+(audit|review)|race condition|deadlock|memory leak)\b/i;
const ESCALATE_MID  = /\b(implement|debug|fix|why|explain|design|test|review|optimi[sz]e)\b/i;

function pickTier(messages) {
  const cfg = readConfig();
  // An explicit pin always wins over auto-tiering.
  if (process.env.PROVERBS_CLOUD_MODEL) return process.env.PROVERBS_CLOUD_MODEL;
  if (cfg.autoTier === false) return cfg.cloudModel || TIERS.cheap;

  // Last user turn drives the decision.
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const text = typeof lastUser?.content === 'string'
    ? lastUser.content
    : Array.isArray(lastUser?.content)
      ? lastUser.content.map(c => (typeof c === 'string' ? c : c?.text || '')).join(' ')
      : '';

  // Long conversations mean accumulated context worth reasoning over.
  const turns = messages.filter(m => m.role === 'user').length;

  if (ESCALATE_DEEP.test(text) || text.length > 4000) return TIERS.deep;
  if (ESCALATE_MID.test(text)  || turns > 6)          return TIERS.mid;
  return TIERS.cheap;
}

// ─── Cost + cache accounting ──────────────────────────────────────────────────
const _spend = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, usd: 0, calls: 0 };

function recordUsage(model, usage) {
  if (!usage) return;
  const p = PRICING[model] || PRICING[TIERS.cheap];
  const input      = usage.input_tokens                || 0;
  const output     = usage.output_tokens               || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cacheRead  = usage.cache_read_input_tokens     || 0;

  // Cache writes bill at 1.25x input, reads at 0.1x.
  const usd = (input      * p.in  / 1e6)
            + (cacheWrite * p.in  * 1.25 / 1e6)
            + (cacheRead  * p.in  * 0.10 / 1e6)
            + (output     * p.out / 1e6);

  _spend.input      += input;
  _spend.output     += output;
  _spend.cacheWrite += cacheWrite;
  _spend.cacheRead  += cacheRead;
  _spend.usd        += usd;
  _spend.calls      += 1;

  const savedUsd = cacheRead * p.in * 0.90 / 1e6; // vs paying full input price
  console.log(
    `[proverbs-server] ${model} in=${input} cache_w=${cacheWrite} cache_r=${cacheRead} out=${output} ` +
    `$${usd.toFixed(4)}${cacheRead ? ` (saved $${savedUsd.toFixed(4)})` : ''}`
  );
}

// ─── Connectivity check (TCP only, 30s cache) ─────────────────────────────────
let _connTs     = 0;
let _connResult = false;
const CONN_TTL  = 30_000;

async function isOnline() {
  const apiKey = getApiKey();
  if (!apiKey)           return false;
  if (isLocalForced())   return false;
  if (isCloudForced())   return true;   // skip check, user forced cloud

  const now = Date.now();
  if (now - _connTs < CONN_TTL) return _connResult;
  _connTs = now;

  try {
    await new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: 'api.anthropic.com', port: 443 }, () => {
        sock.destroy(); resolve();
      });
      sock.setTimeout(2500);
      sock.on('timeout', () => { sock.destroy(); reject(new Error('timeout')); });
      sock.on('error',   reject);
    });
    _connResult = true;
  } catch (_) {
    _connResult = false;
  }
  return _connResult;
}

// ─── Claude API streaming ─────────────────────────────────────────────────────
async function callClaudeStreaming(messages, cloudModel, tools, onChunk) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('No ANTHROPIC_API_KEY configured');

  const systemMsg    = messages.find(m => m.role === 'system');
  const chatMessages = messages
    .filter(m => m.role !== 'system')
    .map(m => {
      if (m.role === 'tool') {
        return {
          role:    'user',
          content: [{ type: 'tool_result', tool_use_id: m.tool_call_id || 'unknown', content: String(m.content || '') }],
        };
      }
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const parts = [];
        if (m.content) parts.push({ type: 'text', text: m.content });
        m.tool_calls.forEach(tc => {
          let input = tc.function?.arguments ?? {};
          if (typeof input === 'string') { try { input = JSON.parse(input); } catch (_) { input = {}; } }
          parts.push({ type: 'tool_use', id: tc.id || 'toolu_' + Math.random().toString(36).slice(2, 10), name: tc.function?.name || tc.name, input });
        });
        return { role: 'assistant', content: parts };
      }
      return { role: m.role, content: m.content || '' };
    });

  const payload = {
    model:      cloudModel,
    max_tokens: 8192,
    stream:     true,
    messages:   chatMessages,
  };

  // ── Prompt caching ──────────────────────────────────────────────────────────
  // Render order is tools → system → messages, and caching is a *prefix* match:
  // any byte change invalidates everything after it. Both the tool list and the
  // system prompt are byte-stable across a session, so a breakpoint on the last
  // system block caches tools+system together. Cache reads bill at 0.1x input,
  // which is where nearly all the savings come from on a tool-heavy agent loop.
  //
  // Tools are sorted by name so a caller reordering them can't silently bust the
  // cache. Nothing volatile (timestamps, ids) may go in either block.
  if (tools?.length) {
    payload.tools = tools
      .map(t => {
        const fn = t.function || t;
        return {
          name:         fn.name,
          description:  fn.description || '',
          input_schema: fn.parameters  || { type: 'object', properties: {} },
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  if (systemMsg?.content) {
    payload.system = [{
      type: 'text',
      text: String(systemMsg.content),
      cache_control: { type: 'ephemeral' },
    }];
  } else if (payload.tools?.length) {
    // No system prompt — put the breakpoint on the last tool so the tool list
    // still caches. (cache_control on a tool caches everything up to and
    // including it.)
    payload.tools[payload.tools.length - 1].cache_control = { type: 'ephemeral' };
  }

  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers:  {
        'Content-Type':      'application/json',
        'Content-Length':    Buffer.byteLength(body),
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      timeout: 120_000,
    }, (res) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', c => { errBody += c; });
        res.on('end',  () => reject(new Error(`Claude API ${res.statusCode}: ${errBody.slice(0, 300)}`)));
        return;
      }

      let buf         = '';
      let fullText    = '';
      let curBlock    = null;
      let toolInBuf   = '';
      let usage       = null;

      res.on('data', chunk => {
        buf += chunk.toString();
        const parts = buf.split('\n');
        buf = parts.pop();

        for (const line of parts) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data) continue;
          try {
            const ev = JSON.parse(data);
            // input + cache counts arrive on message_start; the final output
            // count arrives on message_delta. Merge both for accurate costing.
            if (ev.type === 'message_start' && ev.message?.usage) {
              usage = { ...ev.message.usage };
            } else if (ev.type === 'message_delta' && ev.usage) {
              usage = { ...(usage || {}), ...ev.usage };
            }
            if (ev.type === 'content_block_start') {
              curBlock   = ev.content_block;
              toolInBuf  = '';
            } else if (ev.type === 'content_block_delta') {
              const d = ev.delta;
              if (d.type === 'text_delta') {
                fullText += d.text;
                onChunk(d.text);
              } else if (d.type === 'input_json_delta') {
                toolInBuf += d.partial_json;
              }
            } else if (ev.type === 'content_block_stop') {
              if (curBlock?.type === 'tool_use') {
                let input = {};
                try { input = JSON.parse(toolInBuf); } catch (_) {}
                const toolCall = '\n```json\n' + JSON.stringify({ name: curBlock.name, arguments: input }) + '\n```\n';
                fullText += toolCall;
                onChunk(toolCall);
                toolInBuf = '';
              }
              curBlock = null;
            }
          } catch (_) {}
        }
      });

      res.on('end',   () => { recordUsage(cloudModel, usage); resolve(fullText); });
      res.on('error', reject);
    });

    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Claude API request timed out')); });
    req.write(body);
    req.end();
  });
}

// ─── Local GGUF state ─────────────────────────────────────────────────────────
let llama = null;
const loadedModels   = {};
const cachedContexts = {};

// CPU-only fallback sizing.
// This box has no CUDA GPU, so llama.cpp runs on CPU. A 7B Q4 model does not
// finish a short prompt in ten minutes here (measured) — it just pins two cores
// and grows past 8GB RSS while the client sits at "preparing" forever. That is
// the freeze this guards against: when we fall back off the cloud, we must pick
// a model that can ACTUALLY complete, not the one the request happened to name.
const CPU_FALLBACK_MODEL = 'qwen2.5-coder-1.5b-Q4_K_M';

// Turn a cloud failure into a one-line explanation the user can act on.
// Returns '' for transient errors (a retry/fallback is genuinely silent-worthy).
function explainCloudFailure(err) {
  const msg = String(err && err.message || err);
  if (/credit balance is too low|billing|payment/i.test(msg)) {
    return '⚠️  Anthropic credits exhausted — add credits at console.anthropic.com → Plans & Billing.\n' +
           '    Falling back to the local model (smaller + slower).\n\n';
  }
  if (/401|invalid x-api-key|authentication/i.test(msg)) {
    return '⚠️  Anthropic API key rejected — check anthropicApiKey in ~/.proverbs/config.json.\n' +
           '    Falling back to the local model (smaller + slower).\n\n';
  }
  if (/429|rate limit/i.test(msg)) {
    return '⚠️  Anthropic rate limit hit — falling back to the local model for now.\n\n';
  }
  return '';
}

function pickFallbackModel(requestedModel) {
  if (process.env.PROVERBS_FALLBACK_MODEL) return process.env.PROVERBS_FALLBACK_MODEL;
  const cfg = readConfig();
  if (cfg.allowLargeCpuFallback) return requestedModel;   // opt in to the slow path
  if (/1\.5b|1_5b/i.test(requestedModel || '')) return requestedModel;  // already small
  if (requestedModel && requestedModel !== CPU_FALLBACK_MODEL) {
    console.error(`[proverbs-server] CPU fallback: using ${CPU_FALLBACK_MODEL} instead of ${requestedModel} (7B+ cannot finish on CPU). Set allowLargeCpuFallback:true to override.`);
  }
  return CPU_FALLBACK_MODEL;
}

async function initLlama() {
  try {
    llama = await getLlama();
    return true;
  } catch (e) {
    console.error('[proverbs-server] Failed to initialize llama.cpp:', e.message);
    return false;
  }
}

function listModelFiles() {
  try {
    return fs.readdirSync(MODELS_DIR)
      .filter(f => f.endsWith('.gguf'))
      .map(f => {
        const full = path.join(MODELS_DIR, f);
        const stat = fs.statSync(full);
        return { name: f.replace('.gguf', ''), file: f, size: stat.size, modified_at: stat.mtime.toISOString() };
      });
  } catch (_) { return []; }
}

const MODEL_ALIASES = new Set(['proverbs', 'default', 'best', 'latest', 'auto']);

function resolveModelPath(name) {
  if (MODEL_ALIASES.has(name.toLowerCase())) {
    const files = fs.existsSync(MODELS_DIR) ? fs.readdirSync(MODELS_DIR).filter(f => f.endsWith('.gguf')) : [];
    if (!files.length) return null;
    const pref = files.find(f => /coder|code|stral|deepseek/i.test(f))
               || files.sort((a, b) => fs.statSync(path.join(MODELS_DIR, b)).size - fs.statSync(path.join(MODELS_DIR, a)).size)[0];
    return path.join(MODELS_DIR, pref);
  }
  const normalized = name.replace(':', '-');
  if (fs.existsSync(name)) return name;
  let p = path.join(MODELS_DIR, name);
  if (fs.existsSync(p)) return p;
  p = path.join(MODELS_DIR, name + '.gguf');
  if (fs.existsSync(p)) return p;
  p = path.join(MODELS_DIR, normalized + '.gguf');
  if (fs.existsSync(p)) return p;
  const nl    = normalized.toLowerCase();
  const files = fs.readdirSync(MODELS_DIR).filter(f =>
    f.endsWith('.gguf') && (f.toLowerCase().includes(name.toLowerCase()) || f.toLowerCase().includes(nl))
  );
  return files.length > 0 ? path.join(MODELS_DIR, files[0]) : null;
}

// Cache on the RESOLVED path, not the requested name: several aliases
// ("qwen2.5-coder:1.5b", "qwen2.5-coder-1.5b-Q4_K_M") map to one .gguf, and
// keying on the alias loaded the same weights into RAM once per alias.
async function getModel(name) {
  if (loadedModels[name]) return loadedModels[name];
  if (!llama) throw new Error('llama.cpp not initialized');
  const modelPath = resolveModelPath(name);
  if (!modelPath) {
    const avail = listModelFiles().map(m => m.name).join(', ') || '(none)';
    throw new Error(`Model "${name}" not found in ${MODELS_DIR}. Available: ${avail}`);
  }
  const already = Object.values(loadedModels).find(e => e.path === modelPath);
  if (already) {
    loadedModels[name] = already;
    return already;
  }
  console.log(`[proverbs-server] Loading: ${path.basename(modelPath)}`);
  const model = await llama.loadModel({ modelPath });
  loadedModels[name] = { model, path: modelPath };
  console.log(`[proverbs-server] Ready: ${path.basename(modelPath)}`);
  return loadedModels[name];
}

function formatToolDefs(tools) {
  if (!tools || !tools.length) return '';
  const defs = tools.map(t => {
    const fn = t.function || t;
    return JSON.stringify({ name: fn.name, description: fn.description || '', parameters: fn.parameters || {} }, null, 2);
  }).join('\n\n');
  return [
    '', '# Tools',
    'You have access to the following tools. To call a tool output ONLY a fenced JSON block — no text before or after:',
    '```json', '{"name": "<tool_name>", "arguments": {<args>}}', '```',
    'After each tool call you will receive a <tool_response> message with the result.',
    'Chain as many tool calls as needed. When done, reply normally.', '', defs,
  ].join('\n');
}

function buildChatHistory(nonSystemMessages) {
  const history = [];
  for (const msg of nonSystemMessages) {
    const content = typeof msg.content === 'string' ? msg.content : (msg.content ? JSON.stringify(msg.content) : '');
    if (msg.role === 'user') {
      history.push({ type: 'user', text: content });
    } else if (msg.role === 'assistant') {
      let text = content;
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        const calls = msg.tool_calls.map(tc => {
          const fn = tc.function || tc;
          let args = fn.arguments;
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch (_) { args = {}; } }
          return '```json\n' + JSON.stringify({ name: fn.name, arguments: args || {} }) + '\n```';
        }).join('\n');
        text = (text ? text + '\n' : '') + calls;
      }
      history.push({ type: 'model', response: [text] });
    } else if (msg.role === 'tool') {
      history.push({ type: 'user', text: '<tool_response>\n' + content + '\n</tool_response>' });
    }
  }
  return history;
}

async function runLocalChat(modelEntry, modelName, messages, tools, onChunk) {
  const sysMsg  = messages.find(m => m.role === 'system');
  const nonSys  = messages.filter(m => m.role !== 'system');
  const systemPrompt = (sysMsg ? sysMsg.content : '') + formatToolDefs(tools);

  let lastUserIdx = -1;
  for (let i = nonSys.length - 1; i >= 0; i--) {
    if (nonSys[i].role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) throw new Error('Last message must be a user message');

  const historyMsgs  = nonSys.slice(0, lastUserIdx);
  const lastUserText = nonSys[lastUserIdx].content || '';
  const chatHistory  = buildChatHistory(historyMsgs);

  // Keyed on the resolved .gguf path for the same reason as loadedModels —
  // a per-alias context doubles KV-cache memory for one set of weights.
  const ctxKey = modelEntry.path || modelName;
  if (!cachedContexts[ctxKey]) {
    console.log(`[proverbs-server] Creating context: ${modelName} (one-time, ~10-30s)...`);
    cachedContexts[ctxKey] = await modelEntry.model.createContext({ sequences: 4 });
    console.log(`[proverbs-server] Context ready: ${modelName}`);
  }
  const context  = cachedContexts[ctxKey];
  const sequence = context.getSequence();
  const session  = new LlamaChatSession({
    contextSequence: sequence,
    ...(systemPrompt    ? { systemPrompt }   : {}),
    ...(chatHistory.length > 0 ? { chatHistory } : {}),
  });

  let full = '';
  try {
    await session.prompt(lastUserText, {
      onTextChunk: (text) => { full += text; if (onChunk) onChunk(text); },
    });
  } finally {
    sequence.dispose();
  }
  return full;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end',  () => resolve(raw));
    req.on('error', reject);
  });
}

// ─── Cascade chat: Claude → GGUF fallback ────────────────────────────────────
async function cascadeChat(messages, requestedModel, tools, stream, res, createdAt) {
  const online = await isOnline();

  if (online) {
    const cloudModel = pickTier(messages);
    console.log(`[proverbs-server] Routing to Claude (${cloudModel})`);

    if (stream) {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Transfer-Encoding': 'chunked', 'X-Backend': 'claude' });
      try {
        await callClaudeStreaming(messages, cloudModel, tools, (text) => {
          res.write(JSON.stringify({ model: cloudModel, created_at: createdAt, message: { role: 'assistant', content: text }, done: false }) + '\n');
        });
        res.write(JSON.stringify({ model: cloudModel, created_at: createdAt, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n');
        res.end();
        return;
      } catch (err) {
        console.error('[proverbs-server] Claude failed, falling back to local GGUF:', err.message);
        // Headers already sent — continue streaming from local.
        const localModel = pickFallbackModel(requestedModel);
        // Tell the user WHY they dropped off the cloud, in the stream itself.
        // Billing/auth failures are not transient: silently grinding a local
        // model instead just looks like a hang.
        const notice = explainCloudFailure(err);
        if (notice) {
          res.write(JSON.stringify({ model: localModel, created_at: createdAt, message: { role: 'assistant', content: notice }, done: false }) + '\n');
        }
        const entry = await getModel(localModel);
        await runLocalChat(entry, localModel, messages, tools, (text) => {
          res.write(JSON.stringify({ model: localModel, created_at: createdAt, message: { role: 'assistant', content: text }, done: false }) + '\n');
        });
        res.write(JSON.stringify({ model: localModel, created_at: createdAt, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n');
        res.end();
        return;
      }
    } else {
      try {
        const full = await callClaudeStreaming(messages, cloudModel, tools, () => {});
        sendJSON(res, 200, { model: cloudModel, created_at: createdAt, message: { role: 'assistant', content: full }, done: true });
        return;
      } catch (err) {
        console.error('[proverbs-server] Claude failed, falling back to local GGUF:', err.message);
      }
    }
  }

  // Local GGUF path
  console.log(`[proverbs-server] Using local GGUF: ${requestedModel}`);
  const modelEntry = await getModel(requestedModel);
  if (stream) {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Transfer-Encoding': 'chunked', 'X-Backend': 'local' });
    await runLocalChat(modelEntry, requestedModel, messages, tools, (text) => {
      res.write(JSON.stringify({ model: requestedModel, created_at: createdAt, message: { role: 'assistant', content: text }, done: false }) + '\n');
    });
    res.write(JSON.stringify({ model: requestedModel, created_at: createdAt, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n');
    res.end();
  } else {
    const full = await runLocalChat(modelEntry, requestedModel, messages, tools, null);
    sendJSON(res, 200, { model: requestedModel, created_at: createdAt, message: { role: 'assistant', content: full }, done: true });
  }
}

// ─── Server ───────────────────────────────────────────────────────────────────
// This server holds the Anthropic API key and binds to loopback, so the only
// remote caller that can reach it is a page in the user's own browser. A
// wildcard ACAO let any visited site POST /api/config and overwrite that key,
// so echo an origin back only when it is itself localhost. Non-browser callers
// (the CLI, curl, the VS Code extension) send no Origin and are unaffected.
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && LOCAL_ORIGIN_RE.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // A cross-origin browser POST is a forged request even if the browser would
  // discard the response — reject it before it can mutate config.
  if (origin && !LOCAL_ORIGIN_RE.test(origin) && req.method !== 'GET') {
    return sendJSON(res, 403, { error: 'Cross-origin requests are not allowed.' });
  }

  const url    = req.url.split('?')[0];
  const method = req.method;

  try {
    // GET /api/tags — include cloud model if key configured
    if (method === 'GET' && url === '/api/tags') {
      const local  = listModelFiles().map(m => ({ name: m.name, modified_at: m.modified_at, size: m.size, details: { format: 'gguf' } }));
      const apiKey = getApiKey();
      if (apiKey) {
        const cm = getCloudModel();
        local.unshift({ name: cm, modified_at: new Date().toISOString(), size: 0, details: { format: 'cloud' } });
      }
      return sendJSON(res, 200, { models: local });
    }

    // GET /v1/models
    if (method === 'GET' && url === '/v1/models') {
      return sendJSON(res, 200, { object: 'list', data: listModelFiles().map(m => ({ id: m.name, object: 'model', created: 0, owned_by: 'proverbs' })) });
    }

    // GET /api/backend — status
    if (method === 'GET' && url === '/api/backend') {
      const online     = await isOnline();
      const apiKey     = getApiKey();
      const cfg        = readConfig();
      return sendJSON(res, 200, {
        backend:        online ? 'claude' : 'local',
        cloudModel:     getCloudModel(),
        localModels:    listModelFiles().map(m => m.name),
        keyConfigured:  !!apiKey,
        online,
        cloudMode:      cfg.cloudMode || 'auto',
        autoTier:       cfg.autoTier !== false,
        tiers:          TIERS,
        spend:          { ..._spend, usd: Number(_spend.usd.toFixed(4)) },
      });
    }

    // POST /api/config — save key / model / mode
    if (method === 'POST' && url === '/api/config') {
      const body = JSON.parse(await readBody(req));
      const patch = {};
      if (typeof body.anthropicApiKey === 'string')  patch.anthropicApiKey = body.anthropicApiKey;
      if (typeof body.cloudModel      === 'string')  patch.cloudModel      = body.cloudModel;
      if (typeof body.cloudMode       === 'string')  patch.cloudMode       = body.cloudMode;
      if (typeof body.autoTier        === 'boolean') patch.autoTier        = body.autoTier;
      writeConfig(patch);
      _connTs = 0; // bust connectivity cache so next request re-checks
      return sendJSON(res, 200, { ok: true });
    }

    // POST /api/chat
    if (method === 'POST' && url === '/api/chat') {
      const { model: modelName, messages, tools, stream = true } = JSON.parse(await readBody(req));
      if (!modelName) return sendJSON(res, 400, { error: 'model is required' });
      await cascadeChat(messages, modelName, tools || [], stream, res, new Date().toISOString());
      return;
    }

    // POST /v1/chat/completions — OpenAI-compatible
    if (method === 'POST' && url === '/v1/chat/completions') {
      const { model: modelName, messages, tools, stream = true } = JSON.parse(await readBody(req));
      if (!modelName) return sendJSON(res, 400, { error: { message: 'model is required' } });

      const online      = await isOnline();
      const createdAt   = new Date().toISOString();
      const chatId      = 'chatcmpl-proverbs-' + Date.now();
      const created     = Math.floor(Date.now() / 1000);
      const activeModel = online ? pickTier(messages) : modelName;

      const onChunk = online
        ? (text) => callClaudeStreaming  // placeholder, handled inline below
        : null;

      if (online) {
        if (stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Transfer-Encoding': 'chunked' });
          try {
            await callClaudeStreaming(messages, activeModel, tools || [], (text) => {
              res.write('data: ' + JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model: activeModel, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) + '\n\n');
            });
          } catch (err) {
            console.error('[proverbs-server] Claude /v1 failed, falling back:', err.message);
            const localModel = pickFallbackModel(modelName);
            const notice = explainCloudFailure(err);
            if (notice) {
              res.write('data: ' + JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model: localModel, choices: [{ index: 0, delta: { content: notice }, finish_reason: null }] }) + '\n\n');
            }
            const entry = await getModel(localModel);
            await runLocalChat(entry, localModel, messages, tools || [], (text) => {
              res.write('data: ' + JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model: localModel, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) + '\n\n');
            });
          }
          res.write('data: ' + JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model: activeModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
          res.end();
        } else {
          try {
            const full = await callClaudeStreaming(messages, activeModel, tools || [], () => {});
            return sendJSON(res, 200, { id: chatId, object: 'chat.completion', created, model: activeModel, choices: [{ index: 0, message: { role: 'assistant', content: full }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
          } catch (err) {
            console.error('[proverbs-server] Claude /v1 failed, falling back:', err.message);
          }
        }
      }

      // Local GGUF fallback for /v1
      if (!res.writableEnded) {
        const localModel = pickFallbackModel(modelName);
        const entry = await getModel(localModel);
        if (stream && !res.headersSent) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Transfer-Encoding': 'chunked' });
          await runLocalChat(entry, localModel, messages, tools || [], (text) => {
            res.write('data: ' + JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model: localModel, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) + '\n\n');
          });
          res.write('data: ' + JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model: localModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
          res.end();
        } else if (!stream) {
          const full = await runLocalChat(entry, localModel, messages, tools || [], null);
          return sendJSON(res, 200, { id: chatId, object: 'chat.completion', created, model: localModel, choices: [{ index: 0, message: { role: 'assistant', content: full }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
        }
      }
      return;
    }

    // POST /api/embeddings
    if (method === 'POST' && url === '/api/embeddings') {
      const { model: modelName, prompt } = JSON.parse(await readBody(req));
      if (!modelName || !prompt) return sendJSON(res, 400, { error: 'model and prompt required' });
      const modelEntry = await getModel(modelName);
      const context    = await modelEntry.model.createContext({ contextSize: 512, embedding: true });
      let embedding = [];
      try { embedding = Array.from(await context.getEmbeddingFor(prompt)); } catch (_) { embedding = new Array(384).fill(0); }
      await context.dispose();
      return sendJSON(res, 200, { embedding });
    }

    sendJSON(res, 404, { error: `Not found: ${method} ${url}` });
  } catch (e) {
    console.error('[proverbs-server] Error:', e.message);
    try { sendJSON(res, 500, { error: e.message }); } catch (_) {}
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
console.log('\n  Proverbs Inference Server v3.0.0');
console.log('  Models directory: ' + MODELS_DIR);

const ok = await initLlama();
if (!ok) { console.error('  llama.cpp init failed — local GGUF unavailable (cloud still works)'); }

const models = listModelFiles();
const apiKey = getApiKey();

if (models.length === 0) {
  console.log('  No .gguf models found locally.');
} else {
  models.forEach(m => console.log('  - ' + m.name + '  (' + (m.size / 1e9).toFixed(1) + ' GB)  [local]'));
}
if (apiKey) {
  console.log('  - ' + getCloudModel() + '  [cloud — primary]');
} else {
  console.log('\n  No API key configured. Run /cloud key <key> to enable Claude backend.');
  console.log('  Get a key at: https://console.anthropic.com/settings/keys');
}
console.log();

const HOST = (() => {
  const hostIdx = argv.indexOf('--host');
  if (hostIdx !== -1) return argv[hostIdx + 1];
  return process.env.PROVERBS_HOST || '127.0.0.1';
})();

server.listen(PORT, HOST, () => {
  console.log('  Listening on http://' + HOST + ':' + PORT);
  console.log('  Mode: ' + (apiKey ? 'Claude → local GGUF fallback' : 'local GGUF only') + '\n');
});

process.on('SIGINT',  () => { console.log('\n  Shutting down...'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n  Shutting down...'); process.exit(0); });
