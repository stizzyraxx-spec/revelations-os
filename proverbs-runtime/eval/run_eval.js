#!/usr/bin/env node
'use strict';
// Proverbs evaluation suite — local regression harness.
//
//   node eval/run_eval.js --quick                  fast subset (iteration)
//   node eval/run_eval.js                          full suite
//   node eval/run_eval.js --model llama3.1:8b      pick the model
//   node eval/run_eval.js --compare                score vs the previous run
//   node eval/run_eval.js --resume                 continue an interrupted run
//   node eval/run_eval.js --dimension coding       run one dimension only
//
// Why deterministic grading: on CPU-only hardware every generation is
// expensive, so an LLM judge would roughly triple the cost of a run. Each case
// is scored by code (see graders.js) instead.
//
// Results append to ~/.proverbs/eval/history.jsonl, matching the convention
// scripts/benchmark.py already uses for the from-scratch model.

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const http = require('http');
const { grade } = require('./graders.js');

const EVAL_DIR    = path.join(os.homedir(), '.proverbs', 'eval');
const HISTORY     = path.join(EVAL_DIR, 'history.jsonl');
const PARTIAL     = path.join(EVAL_DIR, 'partial.json');
const OLLAMA      = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

const DIMENSIONS = ['reasoning', 'coding', 'instruction', 'tooluse', 'memory',
                    'hallucination', 'selfcorrect', 'security'];

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has  = (f) => argv.includes(f);
const val  = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const QUICK     = has('--quick');
const COMPARE   = has('--compare');
const RESUME    = has('--resume');
const ONLY_DIM  = val('--dimension', null);
const MODEL     = val('--model', 'qwen2.5-coder:1.5b');
const LABEL     = val('--label', '');
const TIMEOUT   = parseInt(val('--timeout', '180'), 10) * 1000;

// ── ollama ───────────────────────────────────────────────────────────────────
function generate(model, prompt, maxTokens) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model, prompt, stream: false,
      options: { num_predict: maxTokens || 200, temperature: 0, seed: 42 },
    });
    const u = new URL('/api/generate', OLLAMA);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: TIMEOUT,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.error) return reject(new Error(j.error));
          resolve({ text: j.response || '', evalCount: j.eval_count || 0,
                    ms: Math.round((j.eval_duration || 0) / 1e6) });
        } catch (e) { reject(new Error('bad response: ' + data.slice(0, 120))); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timed out after ' + (TIMEOUT / 1000) + 's')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── cases ────────────────────────────────────────────────────────────────────
function loadCases() {
  const dir = path.join(__dirname, 'cases');
  let all = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    all = all.concat(parsed.cases || []);
  }
  if (QUICK)    all = all.filter(c => c.quick);
  if (ONLY_DIM) all = all.filter(c => c.dimension === ONLY_DIM);
  return all;
}

// ── scoring ──────────────────────────────────────────────────────────────────
function scoreByDimension(results) {
  const out = {};
  for (const d of DIMENSIONS) {
    const rs = results.filter(r => r.dimension === d);
    if (!rs.length) continue;
    out[d] = { passed: rs.filter(r => r.pass).length, total: rs.length,
               pct: Math.round((rs.filter(r => r.pass).length / rs.length) * 100) };
  }
  return out;
}

function bar(pct, width) {
  const w = width || 10;
  const filled = Math.round((pct / 100) * w);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, w - filled));
}

const C = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
            cyan: '\x1b[36m', bold: '\x1b[1m', reset: '\x1b[0m' };
const col = (c, s) => c + s + C.reset;

// ── history ──────────────────────────────────────────────────────────────────
function readHistory() {
  try {
    return fs.readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) { return []; }
}

function savePartial(state) {
  fs.mkdirSync(EVAL_DIR, { recursive: true });
  fs.writeFileSync(PARTIAL, JSON.stringify(state, null, 2));
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const cases = loadCases();
  if (!cases.length) { console.log('No cases matched.'); process.exit(1); }

  let results = [];
  let startIdx = 0;
  if (RESUME && fs.existsSync(PARTIAL)) {
    try {
      const p = JSON.parse(fs.readFileSync(PARTIAL, 'utf8'));
      if (p.model === MODEL) {
        results  = p.results || [];
        startIdx = results.length;
        console.log(col(C.yellow, `Resuming: ${startIdx}/${cases.length} already done.\n`));
      }
    } catch (_) {}
  }

  console.log(col(C.bold, '\n  Proverbs Evaluation Suite'));
  console.log(col(C.dim, `  model=${MODEL}  cases=${cases.length}  mode=${QUICK ? 'quick' : 'full'}`));
  console.log(col(C.dim, `  Deterministic grading — no judge model.\n`));

  const t0 = Date.now();
  for (let i = startIdx; i < cases.length; i++) {
    const c = cases[i];
    const tag = `[${String(i + 1).padStart(2)}/${cases.length}] ${c.dimension}/${c.id}`;
    process.stdout.write(col(C.dim, '  ' + tag.padEnd(46)));

    let r;
    try {
      const gen = await generate(MODEL, c.prompt, c.max_tokens);
      const g   = grade(c, gen.text);
      r = { id: c.id, dimension: c.dimension, pass: g.pass, detail: g.detail,
            ms: gen.ms, tokens: gen.evalCount, output: gen.text.slice(0, 400) };
    } catch (e) {
      r = { id: c.id, dimension: c.dimension, pass: false, detail: 'ERROR: ' + e.message,
            ms: 0, tokens: 0, output: '' };
    }
    results.push(r);
    savePartial({ model: MODEL, quick: QUICK, results });

    const secs = r.ms ? (r.ms / 1000).toFixed(1) + 's' : '-';
    console.log((r.pass ? col(C.green, ' PASS') : col(C.red, ' FAIL')) +
                col(C.dim, `  ${secs.padStart(7)}  ${r.detail.slice(0, 44)}`));
  }

  const wallSec = Math.round((Date.now() - t0) / 1000);
  const byDim   = scoreByDimension(results);
  const passed  = results.filter(r => r.pass).length;
  const overall = Math.round((passed / results.length) * 100);

  console.log(col(C.bold, '\n  ── Scores ──────────────────────────────────\n'));
  for (const d of DIMENSIONS) {
    if (!byDim[d]) continue;
    const s = byDim[d];
    const c = s.pct >= 80 ? C.green : s.pct >= 50 ? C.yellow : C.red;
    console.log('  ' + d.padEnd(16) + col(c, bar(s.pct)) + col(C.dim, ` ${String(s.pct).padStart(3)}%  (${s.passed}/${s.total})`));
  }
  console.log(col(C.bold, `\n  Overall: ${overall}%  (${passed}/${results.length})`) +
              col(C.dim, `   ${Math.floor(wallSec / 60)}m${wallSec % 60}s`));

  const record = {
    ts: new Date().toISOString(), model: MODEL, label: LABEL,
    quick: QUICK, dimension: ONLY_DIM, overall, passed, total: results.length,
    wall_seconds: wallSec, by_dimension: byDim,
    failures: results.filter(r => !r.pass).map(r => ({ id: r.id, detail: r.detail })),
  };

  // ── compare against the previous comparable run ────────────────────────────
  if (COMPARE) {
    const prior = readHistory().filter(h =>
      h.model === MODEL && h.quick === QUICK && (h.dimension || null) === (ONLY_DIM || null));
    const prev = prior[prior.length - 1];
    console.log(col(C.bold, '\n  ── Comparison ──────────────────────────────\n'));
    if (!prev) {
      console.log(col(C.dim, '  No prior comparable run — this becomes the baseline.\n'));
    } else {
      const delta = overall - prev.overall;
      const sign  = delta > 0 ? '+' : '';
      const c     = delta > 0 ? C.green : delta < 0 ? C.red : C.dim;
      console.log(col(C.dim, `  previous: ${prev.overall}%  (${prev.ts.slice(0, 16).replace('T', ' ')})`));
      console.log('  current:  ' + overall + '%   ' + col(c, `${sign}${delta} pts`));
      for (const d of DIMENSIONS) {
        if (!byDim[d] || !prev.by_dimension || !prev.by_dimension[d]) continue;
        const dd = byDim[d].pct - prev.by_dimension[d].pct;
        if (dd !== 0) {
          console.log(col(dd > 0 ? C.green : C.red,
            `     ${d.padEnd(16)} ${dd > 0 ? '+' : ''}${dd} pts`));
        }
      }
      // Regression gate: same rule benchmark.py uses — 90% of best.
      const best = Math.max(...prior.map(h => h.overall));
      const ok   = overall >= best * 0.90;
      console.log('\n  ' + (ok
        ? col(C.green, `  ✓ KEEP — ${overall}% is within 10% of best (${best}%)`)
        : col(C.red,   `  ✗ ROLL BACK — ${overall}% is below 90% of best (${best}%)`)) + '\n');
      record.verdict = ok ? 'keep' : 'rollback';
      record.best_prior = best;
    }
  }

  fs.mkdirSync(EVAL_DIR, { recursive: true });
  fs.appendFileSync(HISTORY, JSON.stringify(record) + '\n');
  try { fs.unlinkSync(PARTIAL); } catch (_) {}
  console.log(col(C.dim, `  History: ${HISTORY}\n`));

  if (record.verdict === 'rollback') process.exit(1);
}

main().catch(e => { console.error('\nEval failed:', e.message); process.exit(1); });
