# Proverbs Server Migration

## 1. Current Ollama URL/Port (cli.js)

| Line | Value |
|------|-------|
| 497 | `let OLLAMA_BASE = 'http://localhost:11434';` — primary base URL variable |
| 4068 | `{ name: 'Ollama', base: 'http://localhost:11434', api: 'ollama', checkPath: '/api/tags' }` — backend candidates table |

The Proverbs server runs on port 11434 (same default), so no URL change is needed unless you are running both side-by-side on different ports.

## 2. Exact Changes Required

### 2a. Backend candidates table (line 4068)

Change the Ollama entry to reflect the Proverbs server:

```diff
-  { name: 'Ollama',    base: 'http://localhost:11434', api: 'ollama',  checkPath: '/api/tags'   },
+  { name: 'Proverbs',  base: 'http://localhost:11434', api: 'ollama',  checkPath: '/api/tags'   },
```

### 2b. Default model (line 500)

```diff
-const DEFAULT_MODEL = 'qwen2.5-coder:7b';
+const DEFAULT_MODEL = 'proverbs';
```

### 2c. `ensureOllama` startup logic (lines 667-707)

This function tries to launch the Ollama binary if the server is unreachable. It should be skipped or replaced with a simple connectivity check, since the Proverbs server is managed independently.

Minimal change — add an early return at the top of `ensureOllama`:

```diff
 async function ensureOllama() {
-  if (activeApiFormat !== 'ollama') return;
+  // Proverbs server: skip Ollama binary startup; just check connectivity
+  if (activeApiFormat !== 'ollama') return;
+  // If not using the default Ollama name, skip auto-start logic
+  if (activeBackendName !== 'Ollama') return;
```

Or simply replace the function body with a plain health-check that does not try to spawn `ollama serve` / `brew services start ollama`.

### 2d. Error messages referencing `ollama pull` / `ollama serve`

These are cosmetic but confusing. Key locations:

| Lines | Message to update |
|-------|-------------------|
| 690–692 | "Ollama is not installed / https://ollama.com/download / ollama pull qwen2.5-coder:7b" |
| 2748 | "Install with: ollama pull nomic-embed-text" |
| 2969 | "Run: ollama pull llava" |
| 4801 | "Install it with: ollama pull ${activeModel}" |
| 4935 | "Ollama is not running. Start it with: ollama serve" |
| 4939 | "Ollama connection lost … Try: ollama serve" |

## 3. Model Name References to Update

| Line | Current value | Change to |
|------|--------------|-----------|
| 500 | `DEFAULT_MODEL = 'qwen2.5-coder:7b'` | `'proverbs'` |
| 95 | `EMBED_MODEL = 'nomic-embed-text'` | Keep or replace with Proverbs-compatible embed model |
| 104 | `LLAVA_MODEL = 'llava'` | Keep or replace if Proverbs exposes a vision model |

The `activeModel` variable (passed at runtime with `/model <name>`) also needs to be set to `proverbs` by the user, or `DEFAULT_MODEL` change above covers the default session.

## 4. Endpoint Used

The CLI uses **Ollama's native `/api/chat` endpoint** (not OpenAI-compatible `/v1/chat/completions`) for all primary chat calls:

- Line 2247: `httpPost(\`${OLLAMA_BASE}/api/chat\`, ...)`
- Line 2976: `httpPost(\`${OLLAMA_BASE}/api/chat\`, ...)` (vision/llava path)
- Line 3697: `httpPost(\`${OLLAMA_BASE}/api/chat\`, ...)` (summary path)
- Line 4372: `httpPost(OLLAMA_BASE + '/api/chat', ...)` (history compression)
- Line 4766: `new URL(OLLAMA_BASE + '/api/chat')` inside `streamOllamaChat`

Additional Ollama-specific endpoints also called:

- `/api/tags` — health check and model listing (lines 672, 699, 2942, 4427)
- `/api/tokenize` — token counting (line 1197)
- `/api/embeddings` — embedding generation (line 2744)

The Proverbs server must implement `/api/chat` (streaming NDJSON, Ollama wire format) for the CLI to work without changing `activeApiFormat`. If the Proverbs server only speaks `/v1/chat/completions`, change line 498 from `'ollama'` to `'openai'` and the CLI will automatically use `streamOpenAIChat` instead.
