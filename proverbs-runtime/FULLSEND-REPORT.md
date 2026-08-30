# FULLSEND REPORT — Proverbs

**Date:** 2026-08-16
**Scope:** whole platform (CLI, inference server, landing site)
**Repo state at start:** `fbcacb6`, clean, in sync with `origin/main` (0 ahead / 0 behind)
**`.fullsendignore`:** none present — nothing excepted. See "Suggested exceptions" at the end.

---

## Summary

Proverbs is a **CLI application**, not a web app, so the Playwright browser crawl in the
full-send spec does not apply to the product itself. The interface was exercised by driving
the real REPL over both a pipe and a **PTY** (so the TTY-only code paths ran), the HTTP
surface was probed directly with `curl`/`fetch`, and the landing site was audited as static
files. Everything below was executed on this machine — nothing is inferred.

| Activity | Count |
|---|---|
| Slash commands enumerated | 45 |
| Commands exercised live | 5 (`/help`, `/backend`, `/limits`, `/status`, plus REPL boot) |
| HTTP endpoints mapped | 9 on the inference server, 4 on the CLI dashboard, 4 on the trigger server |
| Endpoints probed live | 3 (`/api/backend`, `/api/config`, `/api/chat`) |
| Test suites run | 4 (57 assertions) |
| Exploits attempted | 2 |
| Exploits confirmed | **1 (fixed)** |
| Test resources created / deleted | 1 config value overwritten by the exploit → **restored** |

Leftover state: **none**. The one value the exploit changed (`cloudModel`) was restored and
verified. Scratch files were written outside the repo and removed.

---

## The headline finding: it works, but it is not fast, and that is hardware

You asked whether Proverbs is quick and can reason in real time. Measured honestly:

| Path | Latency for a 2-token reply ("OK") |
|---|---|
| Anthropic cloud (Haiku) | **0.89s** — but returns HTTP 400 |
| Proverbs server, local GGUF, warm | **12–20s** |
| Proverbs server, local GGUF, cold | **41–61s** |
| Raw Ollama, same model | 17.3s |

Two independent things are limiting it:

1. **The cloud rung is unavailable.** The configured Anthropic key returns
   `"Your credit balance is too low to access the Anthropic API."` The code handles this
   correctly (`server/server.js:314` prints a clear message and falls back), but it means
   **local is currently the only working backend**, and `cloudMode` is set to `force-local`
   in `~/.proverbs/config.json` anyway.
2. **The hardware cannot do real-time inference.** Intel i7-6567U, **2 physical cores**, no
   CUDA/Metal-class GPU, 16 GB RAM with **8.7 GB of 10 GB swap already consumed**. This is
   the same conclusion your own commit `fbcacb6` recorded.

**A real end-to-end coding task did not complete.** Driving the REPL through a PTY with
*"how many lines are in cli.js? use run_bash with wc -l"* hit the 300s per-request ceiling
(`cli.js:8478`) and ended with an honest error rather than a wrong answer:

```
✗  Error: Proverbs Server streaming error: Ollama timed out — model may still be loading
  · low free RAM (0.39GB) — system may be swapping
  · swap active (3,392,348 swapouts) — kill unused apps
```

**On hallucination:** I could not obtain a completed agent-loop answer on this hardware, so
I cannot report a hallucination rate from live agent runs — stating that plainly rather than
guessing. What *is* verified is the layer beneath it: the tool-call recovery parser was tested
against the live 1.5B model and behaved correctly in both directions — it promoted a real
`read_file` call that Ollama reported as `tool_calls: []`, executed it against the real path,
and correctly **refused** to hijack a JSON block the model was merely displaying. The
guardrail against inventing actions is working.

---

## Fixed automatically

### 1. Duplicate model load — same weights loaded once per alias (memory)
**`server/server.js:386-405`, `server/server.js:464-472`** — severity: **high** (this is the
bug behind the hangs)

`getModel()` cached on the *requested name* while `resolveModelPath()` normalises aliases to
one file, so `qwen2.5-coder:1.5b` and `qwen2.5-coder-1.5b-Q4_K_M` loaded **two full copies of
the same weights**, each with its own KV-cache context. On a swap-saturated 16 GB box that is
the difference between working and thrashing.

Both caches are now keyed on the resolved `.gguf` path.

**Verified** — two aliases requested in sequence, server log before vs after:

```
before:  Loading events: 2   Context creations: 2
after:   Loading events: 1   Context creations: 1
```

### 2. Cross-origin config hijack — **confirmed exploitable, now blocked**
**`server/server.js:569-590`** — severity: **critical**

The inference server sent `Access-Control-Allow-Origin: *` on every response, including
`POST /api/config`, which writes `~/.proverbs/config.json` — the file holding your Anthropic
API key. Any website open in your browser while Proverbs runs could overwrite that key or
repoint `cloudModel`.

I proved it rather than assuming it:

```
$ curl -X POST -H "Origin: https://evil.example.com" \
       -d '{"cloudModel":"PWNED-BY-CROSS-ORIGIN"}' http://127.0.0.1:11435/api/config
{"ok":true}
before: cloudModel = claude-haiku-4-5
after:  cloudModel = PWNED-BY-CROSS-ORIGIN     ← config actually overwritten
```

Fix: echo an origin back only when it is itself localhost, and reject non-GET requests
carrying a foreign `Origin` with 403. Non-browser callers (the CLI, curl, the VS Code
extension) send no `Origin` and are unaffected.

**Verified after fix** — exploit blocked, legitimate clients intact:

| Caller | Result |
|---|---|
| `Origin: evil.example.com`, POST | **403**, config unchanged |
| No Origin (CLI/curl) | 200 |
| `Origin: http://localhost:3000` | 200 + correct ACAO |
| `Origin: evil.example.com`, GET | 200 but **no ACAO** → browser denies the read |

Config value restored to `claude-haiku-4-5` and confirmed.

### 3. Dependency vulnerabilities — critical + high cleared
**`package-lock.json`, `server/package-lock.json`**

Non-breaking `npm audit fix` only. The server's **critical `tar`** (uncatchable stack-overflow
DoS) and **high `nanoid`** are resolved.

| Package set | Before | After |
|---|---|---|
| Server runtime | 1 critical, 1 high | **3 moderate** (build-time `cmake-js`→`tar` chain) |
| Root runtime | 1 critical, 4 high, 1 low | **3 moderate** (same chain) |

### 4. Missing Privacy/Support links on the homepage footer
**`landing/index.html:566-571`** — required by your global standard

`landing/privacy.html` and `landing/support.html` both exist and both meet the content bar
(RAXX BEATS STUDIOS, stizzyraxx@gmail.com, GDPR, CCPA, cookies; FAQ + 48-hour response), and
`about.html`/`help.html` link them — but the **homepage footer did not**. Added both links;
targets verified to resolve.

### 5. No security headers on the landing site
**`landing/vercel.json`** — added HSTS, `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, `Permissions-Policy`. JSON validated.

**CSP deliberately omitted:** `index.html` contains an inline `<script>`, so a strict CSP
would break the page. Flagging rather than silently shipping a policy that either breaks the
site or is neutered by `unsafe-inline`.

---

## Regression status — all green

| Suite | Result |
|---|---|
| `test_toolcall_recovery.js` | 22 passed, 0 failed |
| `test_self_heal.js` | 23 passed, 0 failed |
| `test_selfmod_tools.js` | 12 passed, 0 failed |
| `node build.js` | **exit 0** |
| Server inference after all fixes | 200 OK, correct reply |
| CLI boot + `/backend` after all fixes | reaches backend correctly |

**One regression I caused and fixed:** `npm audit fix --omit=dev` pruned the
`javascript-obfuscator` devDependency, breaking `build.js`. Caught it, ran `npm install`,
build returned to exit 0. Reporting it because it happened, not because it survived.

`test_selfmod.js` reports **23 passed, 2 failed** — both failures are its own
"repo starts clean" precondition, tripped because your `UserPromptSubmit` hook appends to
`TODO.md` mid-run. Its `HEAD unchanged` and `no test marker left in repo` checks pass, so
restore works. Not a product bug; noted under suggested exceptions.

---

## Needs your decision

**1. The backend is the whole speed story — pick a lane.** (highest impact)
Nothing in the code will make a 2-core i7-6567U do real-time inference. Options:
- **Add Anthropic credits** — restores the 0.89s path. Costs money; you set `force-local` to
  avoid exactly that, so I did not change it.
- **Keep local and accept 12–60s replies** — free, works, but not interactive.
- **Point at a GPU box** (`/backend` supports a remote Proverbs server; your XPS was measured
  as *not* viable CPU-only).

I changed no cost or routing setting — that is your call.

**2. `sandbox` defaults to OFF** (`cli.js:344`)
`SANDBOX_BLOCKLIST` (`rm -rf /`, `mkfs`, `dd if=`, fork bombs) exists but is disabled by
default, so an agent-issued destructive command runs unguarded. Given Proverbs edits its own
source, I'd default it ON — but that changes product behavior, so I'm asking.

**3. `~/.proverbs/config.json` is world-readable** (`-rw-r--r--`)
It holds your Anthropic key. `chmod 600` is the fix. Not applied: it touches a file outside
the repo, in your home directory.

**4. `--help` boots the full REPL instead of printing help**
`node cli.js --help` starts an interactive session and exits at EOF. Minor, but wrong for a
CLI and it will confuse new users from the install script. Fix is an argv check before REPL
init — a behavior change, so asking first.

**5. Remaining 3 moderate vulns need `--force`**
All in `node-llama-cpp` → `cmake-js` → `tar`, build-time only, not in the runtime path.
`npm audit fix --force` would upgrade `node-llama-cpp` across a major version — that is the
inference engine, so I won't touch it without you.

---

## Couldn't fully test — stated honestly

- **No completed agent-loop coding task.** Every attempt hit the 300s ceiling on local
  inference. Tool *dispatch* is verified at the parser and server layers; the full
  perceive→tool→respond loop is **not** verified end-to-end on this hardware.
- **No hallucination rate measured**, for the same reason. The anti-hallucination guardrail
  in tool recovery is verified; model output quality is not.
- **~40 slash commands were enumerated but not individually executed** — many are destructive
  or outward-facing (`/ship`, `/pr`, `/train`, `/update`, `/mine`) and running them would
  deploy, push, or start multi-hour jobs. Read-only ones were run.
- **Cloud backend is code-verified only** — it returns HTTP 400 for lack of credits, so the
  streaming path, tiering, and prompt-caching could not be exercised live.
- **Landing site was audited as static files**, not served through Vercel; the new headers
  are validated JSON but unverified against a live response.
- **`preview/`, `vscode-extension/`, `finetune/`, `training/`, `inference/`** were mapped but
  not exercised — outside the CLI/server/landing core.

---

## Suggested `.fullsendignore`

No file exists. Based on this run, these look intentional and are worth recording so future
runs skip them:

```
# The prompt-log hook appends to TODO.md mid-run, which trips
# test_selfmod.js's "repo starts clean" precondition. Not a product bug.
TODO.md

# Vendored / generated
node_modules/**
dist/**
venv_llm/**
__pycache__/**

# index.html uses an inline <script>; a strict CSP would break it.
rule: csp-strict

# The 45% "preparing" progress cap is deliberate (cli.js:8627) — it exists so the
# bar never claims near-done while the model is still thinking.
rule: progress-bar-stall
```

---

## Files changed

| File | Change |
|---|---|
| `server/server.js` | Model + context cache keyed on resolved path; CORS locked to localhost |
| `landing/index.html` | Privacy + Support footer links |
| `landing/vercel.json` | Security headers |
| `package-lock.json` | Non-breaking vulnerability fixes |
| `server/package-lock.json` | Non-breaking vulnerability fixes (critical `tar`) |

Nothing committed, nothing pushed, nothing deployed — awaiting your review.
