#!/usr/bin/env node
/**
 * Rigorous self-modification test for Proverbs.
 *
 * Verifies Proverbs can edit its OWN source and rebuild, end to end, without
 * the failure modes that have historically bitten this path:
 *   - the self-mod gate crashing on setRawMode in non-TTY contexts
 *   - the server path-validator refusing writes inside ~/proverbs
 *   - build.js silently producing a broken dist
 *   - an edit landing but the rebuild not picking it up
 *
 * Every test restores whatever it touched, and the suite verifies the repo is
 * byte-identical to its starting state at the end. Nothing here needs the
 * network or Anthropic credits.
 */
const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');

const ROOT   = path.join(process.env.HOME, 'proverbs');
const CLI    = path.join(ROOT, 'cli.js');
const SERVER = path.join(ROOT, 'server', 'server.js');

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  \x1b[32m✔\x1b[0m ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  \x1b[31m✘\x1b[0m ${name}${detail ? '\n      ' + detail : ''}`);
  }
}

function sh(cmd, opts = {}) {
  try {
    return { ok: true, out: cp.execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 180000, ...opts }) };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || ''), code: e.status };
  }
}

console.log('\n\x1b[1mProverbs self-modification test\x1b[0m\n');

// ── 0. Baseline: repo must be clean, or we can't prove we restored it ─────────
console.log('\x1b[1m0. Baseline\x1b[0m');
const dirty = sh('git status --porcelain');
check('repo starts clean (so restore is provable)', dirty.ok && dirty.out.trim() === '',
      dirty.out.trim() ? 'dirty:\n      ' + dirty.out.trim().split('\n').join('\n      ') : '');
const headBefore = sh('git rev-parse HEAD').out.trim();
const cliBefore    = fs.readFileSync(CLI, 'utf8');
const serverBefore = fs.readFileSync(SERVER, 'utf8');

// ── 1. The gate that used to crash every write ────────────────────────────────
console.log('\n\x1b[1m1. Self-mod gate\x1b[0m');
check('isSelfModFile() still guards ~/proverbs', /function isSelfModFile/.test(cliBefore));
const authFn = cliBefore.match(/async function checkSelfModAuth\(\)[\s\S]{0,220}/);
check('checkSelfModAuth() exists', !!authFn);
check('checkSelfModAuth() never calls setRawMode (the old crash)',
      !!authFn && !/setRawMode/.test(authFn[0]),
      authFn ? '' : 'function not found');
check('auto-rebuild is wired to self-mod turns',
      /_isSelfMod && _selfModUnlocked.*selfModRebuild/.test(cliBefore));

// ── 2. Server-side path validation must permit self-edit ─────────────────────
console.log('\n\x1b[1m2. Path policy\x1b[0m');
const validator = path.join(ROOT, 'logic', 'path_validator.py');
if (fs.existsSync(validator)) {
  const v = fs.readFileSync(validator, 'utf8');
  check('path_validator is config-driven, not a hardcoded allowlist',
        /load_policy|permissions/.test(v) && !/ALLOWED_BASE_DIRS\s*=\s*\[[^\]]*proverbs[^\]]*\]\s*$/m.test(v));
  check('sensitive paths still denied by default', /\.ssh|\.aws|gnupg/.test(v));
} else {
  check('path_validator.py present', false, 'missing: ' + validator);
}

// ── 3. REAL edit: write to our own source, rebuild, confirm it took ──────────
// This is the actual thing the user asked about. We add a uniquely-named marker
// (no Date.now/random — a fixed token so a failed cleanup is greppable).
console.log('\n\x1b[1m3. Live self-edit + rebuild\x1b[0m');
const MARKER = 'PROVERBS_SELFMOD_TEST_MARKER_a1b2c3';
let edited = false;
try {
  const patched = cliBefore.replace(
    '// ── Self-modification protection ─',
    `// ${MARKER}\n// ── Self-modification protection ─`
  );
  check('marker anchor found in cli.js', patched !== cliBefore);

  fs.writeFileSync(CLI, patched);
  edited = true;
  check('wrote to own source file', fs.readFileSync(CLI, 'utf8').includes(MARKER));

  const syn = sh(`node --check "${CLI}"`);
  check('edited source still parses', syn.ok, syn.out.trim().slice(0, 200));

  const build = sh('node build.js');
  check('build.js succeeds on edited source', build.ok, build.out.trim().split('\n').slice(-3).join('\n      '));

  const distPath = path.join(ROOT, 'dist', 'cli.js');
  check('dist/cli.js was regenerated', fs.existsSync(distPath) &&
        fs.statSync(distPath).mtimeMs > fs.statSync(CLI).mtimeMs - 120000);

  const distSyn = sh(`node --check "${distPath}"`);
  check('rebuilt dist/cli.js parses (not corrupted by obfuscator)', distSyn.ok,
        distSyn.out.trim().slice(0, 200));

  // The built artifact must actually RUN, not merely parse.
  const runs = sh(`node "${distPath}" --version`, { timeout: 60000 });
  check('rebuilt dist/cli.js executes', runs.ok || /\d+\.\d+/.test(runs.out),
        runs.out.trim().slice(0, 200));
} finally {
  if (edited) {
    fs.writeFileSync(CLI, cliBefore);
    check('own source restored after edit', fs.readFileSync(CLI, 'utf8') === cliBefore);
  }
}

// ── 4. Server self-edit (the file we changed today) ───────────────────────────
console.log('\n\x1b[1m4. Server self-edit\x1b[0m');
let sEdited = false;
try {
  const sPatched = serverBefore.replace(
    '// ─── HTTP helpers ─',
    `// ${MARKER}\n// ─── HTTP helpers ─`
  );
  check('marker anchor found in server.js', sPatched !== serverBefore);
  fs.writeFileSync(SERVER, sPatched);
  sEdited = true;
  const syn = sh(`node --check "${SERVER}"`);
  check('edited server.js parses', syn.ok, syn.out.trim().slice(0, 200));
} finally {
  if (sEdited) {
    fs.writeFileSync(SERVER, serverBefore);
    check('server.js restored', fs.readFileSync(SERVER, 'utf8') === serverBefore);
  }
}

// ── 5. Today's regression fixes must still be present ────────────────────────
console.log('\n\x1b[1m5. Today\'s fixes still in place\x1b[0m');
check('CPU fallback guard present (7B hang fix)', /pickFallbackModel/.test(serverBefore));
check('cloud failure is explained, not swallowed', /explainCloudFailure/.test(serverBefore));
check('progress-bar teardown walks back over prompt rows',
      /_pinnedPromptRows/.test(cliBefore));
check('spinner tears down before repaint (no stranded bars)',
      /_pinnedTeardown\(\);\s*\/\/ erase last tick/.test(cliBefore));

// ── 6. Restore proof ─────────────────────────────────────────────────────────
console.log('\n\x1b[1m6. Restore proof\x1b[0m');
const afterStatus = sh('git status --porcelain');
const strayFiles = afterStatus.out.trim();
check('working tree clean again (all edits reverted)',
      afterStatus.ok && strayFiles === '',
      strayFiles ? 'left behind:\n      ' + strayFiles.split('\n').join('\n      ') : '');
check('HEAD unchanged', sh('git rev-parse HEAD').out.trim() === headBefore);
// Exclude this suite itself — it necessarily contains the marker literal.
const stray = sh(`grep -rl "${MARKER}" --exclude-dir=node_modules --exclude-dir=.git --exclude=test_selfmod.js . || true`);
check('no test marker left anywhere in repo', !stray.out.trim(),
      stray.out.trim());

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
if (fail) { console.log('\nFailed:\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('\x1b[32mSelf-modification verified end to end.\x1b[0m\n');
