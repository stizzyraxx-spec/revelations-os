#!/usr/bin/env node
/**
 * Tests tool-call recovery for small local models (qwen2.5-coder:1.5b).
 *
 * These models are tool-capable but often emit the call as fenced JSON in the
 * message body instead of native tool_call tokens, so Ollama reports
 * tool_calls:[] and the agent loop never fires the tool. The recovery parser
 * promotes those back into real calls.
 *
 * The risk to guard against is over-eager parsing: JSON the model is merely
 * SHOWING the user (a config sample, an API response it is explaining) must NOT
 * be hijacked into a tool invocation. Those negative cases are the important
 * half of this suite.
 */
const fs   = require('fs');
const path = require('path');

const CLI = path.join(process.env.HOME, 'proverbs', 'cli.js');
const src = fs.readFileSync(CLI, 'utf8');

// Pull the recovery helpers out of cli.js (not exported) and eval them together.
function extract(name, kind = 'function') {
  const re = kind === 'const'
    ? new RegExp(`const ${name}\\s*=\\s*\\/[\\s\\S]*?\\/[gimsuy]*;`)
    : new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`);
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + name);
  return m[0];
}

let _toolCallSeq = 0;
const harness = [
  extract('_TOOLCALL_FENCE_RE', 'const'),
  'function _genToolCallId(){ _toolCallSeq++; return "toolu_test_" + _toolCallSeq; }',
  extract('_looksLikeToolCall'),
  extract('_toCall'),
  extract('_recoverToolCallsFromText'),
  extract('_stripToolCallBlocks'),
  'return { _recoverToolCallsFromText, _stripToolCallBlocks, _looksLikeToolCall };',
].join('\n');

const api = new Function('_toolCallSeq', harness)(0);
const { _recoverToolCallsFromText: recover, _stripToolCallBlocks: strip } = api;

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  \x1b[32m✔\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✘\x1b[0m ${name}${detail ? '\n      ' + detail : ''}`); }
}

console.log('\n\x1b[1mTool-call recovery (small local models)\x1b[0m\n');

// ── POSITIVE: real calls that must be recovered ──────────────────────────────
console.log('\x1b[1mMust recover\x1b[0m');

// This is the EXACT output qwen2.5-coder:1.5b produced on this machine.
const realOutput = '```json\n{\n  "name": "read_file",\n  "arguments": {\n    "path": "/tmp/foo.txt"\n  }\n}\n```';
let r = recover(realOutput);
check('recovers the real qwen 1.5b output observed on this box', r.length === 1);
check('  → correct tool name', r[0]?.function?.name === 'read_file');
check('  → arguments parsed as an object', r[0]?.function?.arguments?.path === '/tmp/foo.txt');
check('  → carries an id for pairing', !!r[0]?.id);
check('  → strips the echoed JSON from user-visible text', strip(realOutput) === '');

r = recover('{"name":"list_files","arguments":{"dir":"."}}');
check('recovers a bare unfenced JSON object', r.length === 1 && r[0].function.name === 'list_files');

r = recover('```\n{"name":"run_bash","arguments":{"cmd":"ls"}}\n```');
check('recovers an unlabelled fence', r.length === 1 && r[0].function.name === 'run_bash');

r = recover('```json\n{"name":"write_file","arguments":"{\\"path\\":\\"a.txt\\"}"}\n```');
check('parses stringified arguments into an object',
      r.length === 1 && r[0].function.arguments.path === 'a.txt');

r = recover('I will read it.\n```json\n{"name":"read_file","arguments":{"path":"x"}}\n```');
check('recovers a call preceded by prose', r.length === 1);
check('  → keeps the prose, drops the JSON', strip('I will read it.\n```json\n{"name":"read_file","arguments":{"path":"x"}}\n```') === 'I will read it.');

r = recover('```json\n{"tool_calls":[{"name":"a","arguments":{}},{"name":"b","arguments":{}}]}\n```');
check('recovers a tool_calls array', r.length === 2);

// ── NEGATIVE: JSON that must NOT become an action ────────────────────────────
console.log('\n\x1b[1mMust NOT be hijacked\x1b[0m');

check('plain prose yields nothing', recover('Here is how you reverse a string.').length === 0);
check('empty input yields nothing', recover('').length === 0);

const configSample = '```json\n{\n  "name": "my-app",\n  "version": "1.0.0"\n}\n```';
check('package.json sample is NOT a tool call (no arguments key)', recover(configSample).length === 0);
check('  → and is left intact in the text', strip(configSample) === configSample);

const apiResp = '```json\n{"status":"ok","data":[1,2,3]}\n```';
check('an API response sample is NOT a tool call', recover(apiResp).length === 0);

check('array JSON is not a call', recover('```json\n[{"name":"x","arguments":{}}]\n```').length === 0);
check('object without a name is not a call', recover('```json\n{"arguments":{"a":1}}\n```').length === 0);
check('empty name is not a call', recover('```json\n{"name":"","arguments":{}}\n```').length === 0);
check('malformed JSON is ignored, not thrown on', recover('```json\n{name: broken,,}\n```').length === 0);

// A code block the model is explaining must survive untouched.
const codeBlock = '```javascript\nfunction f(){ return {name:"x", arguments:{}} }\n```';
check('a JS code block is not parsed as a call', recover(codeBlock).length === 0);
check('  → and survives stripping intact', strip(codeBlock) === codeBlock);

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
if (fail) { console.log('\nFailed:\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('\x1b[32mRecovery parser verified.\x1b[0m\n');
