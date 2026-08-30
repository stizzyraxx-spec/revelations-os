#!/usr/bin/env node
'use strict';
// ───────────────────────────────────────────────────────────────────────────
// Self-heal recovery test harness.
//
// Exercises the recovery ladder added to cli.js without booting the REPL:
//   1. error signature normalization + dedup
//   2. connection-error classification
//   3. healbook persistence
//   4. Claude usage guardrails (daily cap / cooldown / per-signature dedup)
//   5. full ladder, server reachable  → restart heals + LEARNS, zero Claude
//   6. full ladder, server unreachable → Claude (STUB) runs, recorded vs cap
//
// Uses a STUBBED `claude` binary so NO real Claude usage is ever spent.
// Run: node scripts/test_self_heal.js
// ───────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');

const CLI = path.join(__dirname, '..', 'cli.js');

// Isolate everything in a throwaway HOME so the real ~/.proverbs is untouched.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'proverbs-heal-test-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
fs.mkdirSync(path.join(TMP_HOME, '.proverbs'), { recursive: true });

// Stub `claude`: a fake binary that prints a FIX line and exits 0, so we prove
// the fallback wiring + learning WITHOUT spending any real Claude usage.
const STUB_BIN = path.join(TMP_HOME, 'claude-stub.sh');
fs.writeFileSync(STUB_BIN,
  '#!/bin/sh\necho "Investigated the crash."\necho "FIX: restarted the wedged inference server (stub)"\nexit 0\n');
fs.chmodSync(STUB_BIN, 0o755);

process.env.PROVERBS_CLAUDE_BIN              = STUB_BIN;
process.env.PROVERBS_CLAUDE_HEAL_MAX_PER_DAY = '5';
process.env.PROVERBS_CLAUDE_HEAL_COOLDOWN_MS = '0';
process.env.PROVERBS_CLAUDE_HEAL_TIMEOUT_MS  = '10000';
// Keep _autoStartServer() fast in tests: 2 polls × 150ms instead of 30 × 1s.
process.env.PROVERBS_START_POLLS   = '2';
process.env.PROVERBS_START_POLL_MS = '150';

const HEALBOOK = path.join(TMP_HOME, '.proverbs', 'healbook.json');
function readBook() { try { return JSON.parse(fs.readFileSync(HEALBOOK, 'utf8')); } catch (_) { return null; } }
function wipeBook() { try { fs.unlinkSync(HEALBOOK); } catch (_) {} }

// Re-require cli.js fresh so it re-reads env (OLLAMA_BASE etc.) at load time.
function loadCli() { delete require.cache[require.resolve(CLI)]; return require(CLI); }

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { console.log('  \x1b[32m✓\x1b[0m ' + name); pass++; }
  else { console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  → ' + extra : '')); fail++; }
}

function probe(url) {
  return new Promise(res => {
    const req = http.get(url + '/api/tags', r => { r.resume(); res(r.statusCode === 200); });
    req.on('error', () => res(false));
    req.setTimeout(1500, () => { req.destroy(); res(false); });
  });
}

(async () => {
  console.log('\n=== Self-heal recovery tests ===\n');

  const REAL = 'http://127.0.0.1:11435';
  const realUp = await probe(REAL);
  console.log('  (real Proverbs server on :11435 is ' + (realUp ? 'UP' : 'DOWN') + ')\n');

  process.env.PROVERBS_SERVER_URL = REAL;
  let H = loadCli();

  // ── 1. Error signature normalization ───────────────────────────────────────
  console.log('1) Error signature');
  const e1 = Object.assign(new Error('Proverbs server connection lost (ECONNRESET). Auto-restart in progress...'), { code: 'ECONNRESET' });
  const e2 = Object.assign(new Error('Proverbs server connection lost (ECONNRESET). Auto-restart in progress...'), { code: 'ECONNRESET' });
  ok('same crash → same signature', H._errorSignature(e1) === H._errorSignature(e2));
  const s3 = H._errorSignature(Object.assign(new Error('listen on :11435 failed at 2026-06-21T21:09:27 path /tmp/x'), { code: 'EADDRINUSE' }));
  ok('volatile bits stripped (port/ts/path)', !/11435|2026|\/tmp/.test(s3), s3);

  // ── 2. Connection-error classification ──────────────────────────────────────
  console.log('2) Connection-error detection');
  ok('ECONNRESET is connection error', H._isConnectionError({ code: 'ECONNRESET' }));
  ok('ENOTFOUND is connection error', H._isConnectionError({ code: 'ENOTFOUND' }));
  ok('"socket hang up" is connection error', H._isConnectionError({ message: 'socket hang up' }));
  ok('syntax error is NOT a connection error', !H._isConnectionError({ message: 'Unexpected token }' }));

  // ── 3. Healbook persistence ─────────────────────────────────────────────────
  console.log('3) Healbook load/save');
  wipeBook();
  const book = H._healbookLoad();
  ok('empty load returns shape', book && book.entries && Array.isArray(book.claudeLog));
  book.entries['X|test'] = { action: 'restart_server', successes: 1, fails: 0, lastTs: 1 };
  H._healbookSave(book);
  ok('saved to disk', fs.existsSync(HEALBOOK));
  ok('reload round-trips', H._healbookLoad().entries['X|test'].successes === 1);

  // ── 4. Claude usage guardrails ──────────────────────────────────────────────
  console.log('4) Claude usage guardrails');
  wipeBook();
  const sig = 'ECONNRESET|test';
  let b = H._healbookLoad();
  ok('fresh: Claude allowed', H._claudeHealAllowed(b, sig).allowed === true);
  b.claudeLog = [];
  for (let i = 0; i < 5; i++) b.claudeLog.push({ sig: 'other' + i, ts: 1, day: H._todayKey(), ok: true });
  ok('daily cap blocks 6th call', H._claudeHealAllowed(b, sig).allowed === false);
  ok('count today = 5', H._claudeCallsToday(b) === 5);
  b.claudeLog = [{ sig, ts: 1, day: H._todayKey(), ok: true }];
  ok('same-signature dedup blocks repeat', H._claudeHealAllowed(b, sig).allowed === false);

  // Cooldown (needs a fresh load with a non-zero cooldown).
  process.env.PROVERBS_CLAUDE_HEAL_COOLDOWN_MS = '999999';
  const Hc = loadCli();
  const bc = { entries: {}, claudeLog: [{ sig: 'whatever', ts: Date.now(), day: Hc._todayKey(), ok: true }] };
  ok('cooldown blocks rapid re-call', Hc._claudeHealAllowed(bc, 'new-sig').allowed === false);
  process.env.PROVERBS_CLAUDE_HEAL_COOLDOWN_MS = '0';

  // ── 5. Full ladder, server REACHABLE → restart heals + learns, no Claude ────
  console.log('5) Full ladder — server reachable');
  process.env.PROVERBS_SERVER_URL = REAL;
  const H5 = loadCli();
  wipeBook();
  if (!realUp) {
    console.log('  \x1b[33m⚠ skipped (real server not running on :11435)\x1b[0m');
  } else {
    H5._resetHealAttempts();
    const connErr = Object.assign(new Error('Proverbs server connection lost (ECONNRESET)'), { code: 'ECONNRESET' });
    const healed1 = await H5._selfHeal(connErr);
    const after = readBook();
    const csig = H5._errorSignature(connErr);
    ok('recovered (healed=true)', healed1 === true);
    ok('signature learned in healbook', after && !!after.entries[csig]);
    ok('NO Claude call needed when server reachable', (after.claudeLog || []).length === 0,
       'claudeLog len=' + (after.claudeLog || []).length);
    // Same signature again → free replay.
    H5._resetHealAttempts();
    const healed2 = await H5._selfHeal(Object.assign(new Error('Proverbs server connection lost (ECONNRESET)'), { code: 'ECONNRESET' }));
    ok('known issue replays successfully', healed2 === true);
    ok('still zero Claude calls (free replay)', (readBook().claudeLog || []).length === 0);
  }

  // ── 6. Full ladder, server UNREACHABLE → Claude stub runs, capped ───────────
  console.log('6) Full ladder — server unreachable (Claude rung)');
  process.env.PROVERBS_SERVER_URL = 'http://127.0.0.1:19999'; // nothing listens here
  const H6 = loadCli();
  wipeBook();
  H6._resetHealAttempts();
  const downErr = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
  const healed3 = await H6._selfHeal(downErr);
  const b6 = readBook();
  ok('Claude consulted exactly once (logged vs daily cap)', b6 && (b6.claudeLog || []).length === 1,
     'claudeLog=' + JSON.stringify(b6 && b6.claudeLog));
  ok('Claude call stamped with today key', b6 && b6.claudeLog[0] && b6.claudeLog[0].day === H6._todayKey());
  ok('returns false when server still down after fix attempt', healed3 === false);

  // Second identical crash → dedup blocks a SECOND Claude call (usage saved).
  H6._resetHealAttempts();
  await H6._selfHeal(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }));
  ok('per-signature dedup prevents a 2nd Claude call same day', (readBook().claudeLog || []).length === 1,
     'claudeLog len=' + (readBook().claudeLog || []).length);

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===\n');
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
