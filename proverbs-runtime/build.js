#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const SRC  = path.join(__dirname, 'cli.js');
const OUT  = path.join(__dirname, 'dist', 'cli.js');

// ── Obfuscation config ────────────────────────────────────────────────────────
// Goal: make decompiled/read source completely unintelligible
const OBFUSCATOR_OPTIONS = {
  // Compact single line — no whitespace for humans to follow
  compact: true,

  // Rename every identifier to _0xABCDEF hex style
  identifierNamesGenerator: 'hexadecimal',
  identifiersPrefix: '',

  // Rename top-level globals (functions, vars defined at the top)
  renameGlobals: false,   // keep require/process/module so Node still works

  // All string literals extracted into an encoded rotating array.
  // base64-only: rc4 decodes every string through a JS loop at runtime and
  // made the shipped CLI several times slower for no real security gain
  // (both decode trivially once the wrapper is found).
  stringArray: true,
  stringArrayShuffle: true,
  stringArrayRotate: true,
  stringArrayIndexShift: true,
  stringArrayCallsTransform: true,
  stringArrayCallsTransformThreshold: 0.75,
  stringArrayWrappersCount: 2,
  stringArrayWrappersParametersMaxCount: 2,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 0.75,
  stringArrayEncoding: ['base64'],

  // splitStrings/numbersToExpressions/deadCodeInjection multiply parse time
  // and memory of the 600KB bundle while adding little protection on top of
  // identifier renaming + string array. controlFlowFlattening at threshold 1
  // turned every hot loop (streaming render, file scan) into a switch state
  // machine — the single biggest runtime cost in the shipped build.
  splitStrings: false,
  numbersToExpressions: false,

  // Rename object keys (e.g. {role:'user'} → {_0x1a2b: 'user'})
  transformObjectKeys: true,

  controlFlowFlattening: false,
  deadCodeInjection: false,

  // Self-defending: resists beautifiers/formatters — overwrites itself if tampered
  selfDefending: true,

  // Debug protection: detects DevTools open and freezes execution
  debugProtection: false,  // off — would lock up terminal too

  // Disable console.log in the distributed build
  disableConsoleOutput: false,  // keep on — CLI needs its output

  // Unicode escapes for identifiers
  unicodeEscapeSequence: false,  // off — bloats file too much combined with rest

  log: false,
  seed: 0,
};

// ── Build ─────────────────────────────────────────────────────────────────────
console.log('Building Proverbs...');

let src = fs.readFileSync(SRC, 'utf8');

// Strip shebang — obfuscator can't handle it; we re-add it after
const shebang = src.startsWith('#!') ? src.slice(0, src.indexOf('\n') + 1) : '#!/usr/bin/env node\n';
if (src.startsWith('#!')) src = src.slice(src.indexOf('\n') + 1);

const result = JavaScriptObfuscator.obfuscate(src, OBFUSCATOR_OPTIONS);
const obfuscated = result.getObfuscatedCode();

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(OUT, shebang + obfuscated, 'utf8');
fs.chmodSync(OUT, 0o755);

// Copy server.js into dist/server/ so dist/cli.js can find it via __dirname
fs.mkdirSync(path.join(__dirname, 'dist', 'server'), { recursive: true });
fs.copyFileSync(
  path.join(__dirname, 'server', 'server.js'),
  path.join(__dirname, 'dist', 'server', 'server.js')
);
console.log('  Copied:      server/server.js → dist/server/server.js');

const srcSize  = (fs.statSync(SRC).size  / 1024).toFixed(1);
const outSize  = (fs.statSync(OUT).size  / 1024).toFixed(1);
console.log(`  Source:      ${srcSize} KB  (${SRC})`);
console.log(`  Obfuscated:  ${outSize} KB  (${OUT})`);
console.log('Done. Distribute dist/cli.js — source stays private.');
