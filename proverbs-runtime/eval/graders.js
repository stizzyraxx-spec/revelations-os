'use strict';
// Deterministic graders for the Proverbs eval suite.
//
// Design constraint: this machine generates ~1-2 tokens/sec on CPU. An
// LLM-as-judge would triple the cost of every run, so every grader here is
// pure code — regex, parsing, or actually executing the generated code in a
// subprocess. A case is either objectively right or it isn't.

const { execFileSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Strip markdown fences so graders see raw code.
function extractCode(text, lang) {
  if (!text) return '';
  const fence = new RegExp('```(?:' + (lang || '[a-zA-Z]*') + ')?\\s*\\n([\\s\\S]*?)```', 'm');
  const m = text.match(fence);
  return (m ? m[1] : text).trim();
}

function _norm(s) { return String(s == null ? '' : s).toLowerCase().trim(); }

// ── Graders ──────────────────────────────────────────────────────────────────
// Each returns { pass: bool, detail: string }. `c` is the case, `out` the raw
// model output.
const GRADERS = {
  // Output must contain all of these (case-insensitive substrings).
  contains(c, out) {
    const want = c.expect.contains || [];
    const missing = want.filter(w => !_norm(out).includes(_norm(w)));
    return { pass: missing.length === 0,
             detail: missing.length ? 'missing: ' + missing.join(', ') : 'all present' };
  },

  // Output must contain none of these. Used for hallucination resistance:
  // the model must NOT invent an answer it cannot know.
  excludes(c, out) {
    const bad = (c.expect.excludes || []).filter(w => _norm(out).includes(_norm(w)));
    return { pass: bad.length === 0,
             detail: bad.length ? 'contained: ' + bad.join(', ') : 'clean' };
  },

  // Both directions at once — the common case for instruction-following.
  contains_and_excludes(c, out) {
    const a = GRADERS.contains(c, out);
    const b = GRADERS.excludes(c, out);
    return { pass: a.pass && b.pass, detail: a.detail + ' | ' + b.detail };
  },

  // Regex match against the raw output.
  regex(c, out) {
    const re = new RegExp(c.expect.regex, c.expect.flags || 'i');
    const ok = re.test(out || '');
    return { pass: ok, detail: ok ? 'matched' : 'no match for /' + c.expect.regex + '/' };
  },

  // Every listed pattern must match. Needed when correctness is expressed by
  // two independent facts (e.g. SQL is parameterised AND a placeholder exists),
  // which a single regex cannot capture without assuming an ordering.
  regex_all(c, out) {
    const pats = [c.expect.regex, c.expect.also_regex].filter(Boolean);
    const flags = c.expect.flags || 'i';
    const missed = pats.filter(p => !new RegExp(p, flags).test(out || ''));
    return { pass: missed.length === 0,
             detail: missed.length ? 'no match for /' + missed[0] + '/' : 'all patterns matched' };
  },

  // Generated Python must parse. Level-1 style check for code output.
  python_syntax(c, out) {
    const code = extractCode(out, 'python');
    if (!code) return { pass: false, detail: 'no code produced' };
    const f = path.join(os.tmpdir(), 'pv_eval_' + process.pid + '_' + Math.abs(hashStr(code)) + '.py');
    try {
      fs.writeFileSync(f, code);
      execFileSync(pythonBin(), ['-m', 'py_compile', f], { stdio: 'pipe', timeout: 20000 });
      return { pass: true, detail: 'parses' };
    } catch (e) {
      const err = (e.stderr || e.stdout || '').toString().split('\n').filter(Boolean).slice(-1)[0] || e.message;
      return { pass: false, detail: err.slice(0, 160) };
    } finally { try { fs.unlinkSync(f); } catch (_) {} }
  },

  // The strongest grader: run the generated function against real assertions.
  // This is what separates "looks like code" from "correct code".
  python_exec(c, out) {
    const code = extractCode(out, 'python');
    if (!code) return { pass: false, detail: 'no code produced' };
    const harness = code + '\n\n' + (c.expect.asserts || []).join('\n') + '\nprint("__EVAL_OK__")\n';
    const f = path.join(os.tmpdir(), 'pv_exec_' + process.pid + '_' + Math.abs(hashStr(harness)) + '.py');
    try {
      fs.writeFileSync(f, harness);
      const r = execFileSync(pythonBin(), [f], { stdio: 'pipe', timeout: 20000, encoding: 'utf8' });
      const ok = r.includes('__EVAL_OK__');
      return { pass: ok, detail: ok ? 'assertions passed' : 'ran but no OK marker' };
    } catch (e) {
      const err = (e.stderr || '').toString().split('\n').filter(Boolean).slice(-1)[0] || e.message;
      return { pass: false, detail: err.slice(0, 160) };
    } finally { try { fs.unlinkSync(f); } catch (_) {} }
  },

  // Same, for JavaScript — run in a subprocess so a hang cannot wedge the run.
  js_exec(c, out) {
    const code = extractCode(out, 'javascript');
    if (!code) return { pass: false, detail: 'no code produced' };
    const harness = code + '\n\n' + (c.expect.asserts || []).join('\n') + '\nconsole.log("__EVAL_OK__");\n';
    const f = path.join(os.tmpdir(), 'pv_exec_' + process.pid + '_' + Math.abs(hashStr(harness)) + '.js');
    try {
      fs.writeFileSync(f, harness);
      const r = execFileSync(process.execPath, [f], { stdio: 'pipe', timeout: 20000, encoding: 'utf8' });
      const ok = r.includes('__EVAL_OK__');
      return { pass: ok, detail: ok ? 'assertions passed' : 'ran but no OK marker' };
    } catch (e) {
      const err = (e.stderr || '').toString().split('\n').filter(Boolean).slice(-1)[0] || e.message;
      return { pass: false, detail: err.slice(0, 160) };
    } finally { try { fs.unlinkSync(f); } catch (_) {} }
  },

  // Output must be valid JSON, optionally with required keys. Used for
  // tool-use: a model that cannot emit clean JSON cannot call tools.
  json_valid(c, out) {
    const raw = extractCode(out, 'json');
    let obj;
    // Models often wrap JSON in prose; take the outermost {...} or [...].
    const m = raw.match(/[{\[][\s\S]*[}\]]/);
    try { obj = JSON.parse(m ? m[0] : raw); }
    catch (e) { return { pass: false, detail: 'invalid JSON: ' + e.message.slice(0, 90) }; }
    const need = c.expect.keys || [];
    const missing = need.filter(k => !(obj && Object.prototype.hasOwnProperty.call(obj, k)));
    if (missing.length) return { pass: false, detail: 'missing keys: ' + missing.join(', ') };
    if (c.expect.equals) {
      for (const [k, v] of Object.entries(c.expect.equals)) {
        if (_norm(obj[k]) !== _norm(v)) {
          return { pass: false, detail: `${k}=${JSON.stringify(obj[k])} expected ${JSON.stringify(v)}` };
        }
      }
    }
    return { pass: true, detail: 'valid' };
  },
};

function pythonBin() { return process.platform === 'win32' ? 'python' : 'python3'; }

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return h;
}

function grade(c, out) {
  const g = GRADERS[c.grader];
  if (!g) return { pass: false, detail: 'unknown grader: ' + c.grader };
  try { return g(c, out); }
  catch (e) { return { pass: false, detail: 'grader error: ' + e.message }; }
}

module.exports = { grade, GRADERS, extractCode };
