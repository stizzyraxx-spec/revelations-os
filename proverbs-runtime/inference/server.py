"""
Proverbs Inference Server — OpenAI-compatible FastAPI server for ProverbsLM.

Endpoints:
  POST /v1/chat/completions  — chat completion (streaming + non-streaming)
  GET  /v1/models            — list available models
  GET  /health               — server health + device info
  POST /v1/logic/hook        — apply pre/post logic hooks
  GET  /v1/health/resources  — RAM/CPU/GPU resource status from health monitor
  GET  /v1/queue/status      — priority queue depths and active slots
  POST /v1/rag/build         — build RAG index for a project directory
  GET  /v1/rag/status        — RAG index size and load status
  GET  /v1/cascade/stats     — cascade routing counters

Designed to run on port 11434 (same as Ollama) so cli.js requires no changes
when the backend is switched to the Proverbs inference server.

Usage:
  python inference/server.py --host 0.0.0.0 --port 11434
  PROVERBS_MODEL_PATH=~/.proverbs/checkpoints/best.pt python inference/server.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
import uuid
from pathlib import Path
from typing import AsyncGenerator, Literal

# ---------------------------------------------------------------------------
# Ensure the project root is on sys.path so model/ tokenizer/ inference/ can
# all be imported regardless of where the server is launched from.
# ---------------------------------------------------------------------------
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

import torch
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from inference.generate import ProverbsGenerator
from model.proverbs_lm import ProverbsLM

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("proverbs.server")

# ---------------------------------------------------------------------------
# App-level state (populated at startup)
# ---------------------------------------------------------------------------

_generator: ProverbsGenerator | None = None   # PyTorch backend
_gguf_backend = None                           # GGUFBackend (llama-cpp-python)
_active_backend = None                         # whichever loaded successfully
_device: str = "cpu"
_model_path: str = ""
_backend_type: str = "none"                    # "pytorch" | "gguf" | "none"
_system_kv_caches: list | None = None
_system_prompt_tokens: int = 0
_batch_manager: "ContinuousBatchManager | None" = None
_code_feedback: "CodeExecutionFeedback | None" = None
ab_engine: "ABTestEngine | None" = None
_health_monitor = None
_priority_queue = None

# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

from contextlib import asynccontextmanager

@asynccontextmanager
async def _lifespan(app: FastAPI):
    await _startup()
    yield

app = FastAPI(
    title="Proverbs Inference Server",
    lifespan=_lifespan,
    description="OpenAI-compatible REST API for ProverbsLM",
    version="1.0.0",
)

from inference.security_middleware import CORS_ORIGINS

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

try:
    from inference.security_middleware import SecurityHeadersMiddleware
    from inference.rate_limiter import RateLimitMiddleware
    from inference.auth import APIKeyMiddleware
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(RateLimitMiddleware)
    app.add_middleware(APIKeyMiddleware)
except ImportError as e:
    log.warning("Security middleware not loaded: %s", e)

# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class ChatCompletionRequest(BaseModel):
    model: str = "proverbs"
    messages: list[ChatMessage]
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    top_p: float = Field(default=0.9, ge=0.0, le=1.0)
    max_tokens: int = Field(default=512, ge=1, le=4096)
    stream: bool = False


class LogicHookRequest(BaseModel):
    phase: Literal["pre", "post"]
    messages: list[ChatMessage] = Field(default_factory=list)


class ReloadModelRequest(BaseModel):
    model_path: str | None = None
    tokenizer_path: str | None = None
    backend: str | None = None
    response: str | None = None


class RAGBuildRequest(BaseModel):
    project_dir: str


# ---------------------------------------------------------------------------
# Startup / shutdown
# ---------------------------------------------------------------------------


def _prefill_system_prompt(system_text: str) -> tuple:
    if not _generator or not system_text.strip():
        return ([], 0)
    ids = _generator.tokenizer.encode(system_text, add_bos=True)
    t = torch.tensor([ids], dtype=torch.long, device=_generator.device)
    with torch.inference_mode():
        out = _generator.model(t, kv_caches=None)
    return (out["kv_caches"], len(ids))


async def _startup() -> None:
    """
    Load model at startup.  Priority order:
      1. GGUF (llama-cpp-python) — works offline, no training needed
      2. PyTorch checkpoint      — your trained Proverbs LLM weights
      3. Neither found           — server starts but returns 503 on chat calls

    Environment variables:
      PROVERBS_GGUF_PATH      — path to a .gguf file
      PROVERBS_MODEL_PATH     — path to a .pt checkpoint
      PROVERBS_TOKENIZER_PATH — path to tokenizer.json (PyTorch mode only)
      PROVERBS_BACKEND        — "gguf" | "pytorch" | "auto" (default: auto)
    """
    global _generator, _gguf_backend, _active_backend, _device, _model_path, _backend_type, _batch_manager, _code_feedback

    # Resolve device
    if torch.cuda.is_available():
        _device = "cuda"
    elif torch.backends.mps.is_available():
        _device = "mps"
    else:
        _device = "cpu"
    log.info("Device: %s", _device)

    backend_pref = os.environ.get("PROVERBS_BACKEND", "auto").lower()
    gguf_path    = os.path.expanduser(os.environ.get("PROVERBS_GGUF_PATH", ""))
    pt_path      = os.path.expanduser(os.environ.get("PROVERBS_MODEL_PATH",
                                                       "~/.proverbs/checkpoints/best.pt"))
    tok_path     = os.path.expanduser(os.environ.get("PROVERBS_TOKENIZER_PATH",
                                                       "~/.proverbs/tokenizer.json"))

    # ── Try GGUF first (auto or explicit) ────────────────────────────────────
    if backend_pref in ("auto", "gguf"):
        from inference.gguf_backend import GGUFBackend, DEFAULT_GGUF
        candidate = gguf_path or DEFAULT_GGUF
        if candidate and Path(candidate).exists():
            try:
                log.info("Loading GGUF model: %s", candidate)
                _gguf_backend = GGUFBackend(candidate, verbose=False)
                _active_backend = _gguf_backend
                _model_path = candidate
                _backend_type = "gguf"
                log.info("GGUF backend ready — fully offline, no training needed")
                return
            except Exception as exc:
                log.warning("GGUF load failed (%s), falling back to PyTorch", exc)
        elif backend_pref == "gguf":
            log.error("PROVERBS_BACKEND=gguf but no GGUF file found at %s", candidate or "default path")

    # ── Try PyTorch checkpoint ────────────────────────────────────────────────
    if backend_pref in ("auto", "pytorch"):
        if not Path(pt_path).exists():
            log.warning(
                "No model found.\n"
                "  GGUF path: %s\n"
                "  PyTorch:   %s\n"
                "Server will return 503 until a model is loaded.\n"
                "Options:\n"
                "  1. Start the GGUF backend (no training needed):\n"
                "       PROVERBS_GGUF_PATH=~/.ollama/models/blobs/sha256-29d8c98fa6b098e200069bfb88b9508dc3e85586d20cba59f8dda9a808165104 python -m inference.server\n"
                "  2. Train and use your own model:\n"
                "       python -m training.train --mode pretrain\n"
                "       python -m inference.server --model ~/.proverbs/checkpoints/pretrain/best.pt",
                candidate if backend_pref == "auto" else gguf_path, pt_path,
            )
            _model_path = pt_path
            return

        if not Path(tok_path).exists():
            log.warning("Tokenizer not found at %s — PyTorch backend unavailable", tok_path)
            _model_path = pt_path
            return

        log.info("Loading PyTorch model: %s", pt_path)
        try:
            from model.proverbs_lm import ProverbsLM
            from inference.generate import ProverbsGenerator
            lm = ProverbsLM.load(pt_path, device=_device)
            lm.eval()
            _generator = ProverbsGenerator(model=lm, tokenizer_path=tok_path, device=_device)
            _active_backend = _generator
            _model_path = pt_path
            _backend_type = "pytorch"
            log.info("PyTorch backend ready: %s", lm)

            # Initialize health monitor
            try:
                from logic.health_monitor import HealthMonitor

                def _on_critical(resource: str) -> None:
                    if resource == "ram" and _generator is not None:
                        try:
                            log.warning(
                                "RAM pressure detected — switching model to INT8 quantisation"
                            )
                            _generator.model.to(torch.int8)
                        except Exception as _exc:
                            log.error("INT8 failover failed: %s", _exc)

                global _health_monitor
                _health_monitor = HealthMonitor()
                _health_monitor.start(on_critical=_on_critical)
                log.info("Health monitor started")
            except Exception as e:
                log.warning("Health monitor unavailable: %s", e)

            # Initialize priority queue
            try:
                from inference.priority_queue import PriorityInferenceQueue
                global _priority_queue
                _priority_queue = PriorityInferenceQueue(_generator, max_concurrent=2)
                await _priority_queue.start()
                log.info("Priority inference queue started")
            except Exception as e:
                log.warning("Priority queue unavailable: %s", e)

            # Initialize RAG index
            try:
                from logic.rag import rag_index
                rag_index.load()
                log.info(
                    "RAG index loaded (%d chunks)", len(rag_index._chunks)
                )
            except Exception as e:
                log.warning("RAG index unavailable: %s", e)

            # Initialize continuous batch manager
            try:
                from inference.batch_manager import ContinuousBatchManager
                _batch_manager = ContinuousBatchManager(_generator.model, _generator.tokenizer, max_batch_size=4, device=_device)
                await _batch_manager.start()
                log.info("Continuous batch manager started (max_batch=4)")
            except Exception as e:
                log.warning("Batch manager unavailable: %s", e)

            # Initialize code execution feedback
            try:
                from logic.code_runner import CodeExecutionFeedback
                _code_feedback = CodeExecutionFeedback(_generator, max_revision_rounds=2)
                log.info("Code execution feedback enabled")
            except Exception as e:
                log.warning("Code feedback unavailable: %s", e)

            # Initialize constitutional AI
            try:
                from logic.constitutional import ConstitutionalAI, constitutional_ai as _ca_global
                import logic.constitutional as _ca_mod
                _ca_mod.constitutional_ai = ConstitutionalAI(_generator, n_principles=3)
                log.info("Constitutional AI initialized")
            except Exception as e:
                log.warning("Constitutional AI unavailable: %s", e)

            global _system_kv_caches, _system_prompt_tokens
            try:
                from logic.rules import rules_injector
                sys_text = getattr(rules_injector, "get_system_prompt", lambda: "")() or ""
                if not sys_text:
                    rules_path = Path.home() / ".proverbs" / "rules.md"
                    sys_text = rules_path.read_text() if rules_path.exists() else ""
                if sys_text:
                    _system_kv_caches, _system_prompt_tokens = _prefill_system_prompt(sys_text)
                    log.info("System prompt KV cache: %d tokens pre-computed", _system_prompt_tokens)
            except Exception as e:
                log.warning("System prompt prefill skipped: %s", e)
        except Exception as exc:
            log.error("Failed to load PyTorch model: %s", exc, exc_info=True)
            _model_path = pt_path

    # Validate config with audit log and API key setup
    try:
        from logic.audit_log import audit_logger
        audit_logger.log("server_start", status="ok")
        from inference.auth import get_or_create_api_key
        key = get_or_create_api_key()
        log.info("API key configured (first 8 chars): %s...", key[:8])
    except Exception as e:
        log.warning("Auth setup: %s", e)

    # Initialize response cache, git context, metrics, and A/B engine
    global ab_engine
    try:
        from inference.response_cache import response_cache; log.info("Response cache ready")
    except Exception:
        pass
    try:
        from logic.git_context import git_context; log.info("Git context ready")
    except Exception:
        pass
    try:
        from logic.metrics import metrics; log.info("Metrics collector ready")
    except Exception:
        pass
    try:
        from inference.ab_testing import ABTestEngine, ABTestConfig
        ab_engine = ABTestEngine(_generator)
        log.info("A/B engine ready")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Helper: ensure model is ready
# ---------------------------------------------------------------------------


def _require_generator():
    """Return whichever backend loaded (GGUF or PyTorch). Both have .generate()."""
    if _active_backend is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "No model loaded. Start the server with a GGUF or PyTorch checkpoint.\n"
                "Quick start (offline, uses already-downloaded model):\n"
                "  PROVERBS_GGUF_PATH=~/.ollama/models/blobs/sha256-29d8c98fa6b098e200069bfb88b9508dc3e85586d20cba59f8dda9a808165104 "
                "python -m inference.server"
            ),
        )
    return _active_backend


# ---------------------------------------------------------------------------
# Helper: build OpenAI-style usage block
# ---------------------------------------------------------------------------


def _make_usage(prompt_tokens: int, completion_tokens: int) -> dict:
    return {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": prompt_tokens + completion_tokens,
    }


# ---------------------------------------------------------------------------
# Helper: count prompt tokens (best-effort)
# ---------------------------------------------------------------------------


def _count_prompt_tokens(gen: ProverbsGenerator, messages: list[dict]) -> int:
    try:
        return len(gen.tokenizer.encode_chat(messages))
    except Exception:
        return 0


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "model": "proverbs",
        "backend": _backend_type,         # "gguf" | "pytorch" | "none"
        "device": _device,
        "model_path": _model_path,
        "model_loaded": _active_backend is not None,
        "offline_capable": _backend_type == "gguf",
    }


@app.get("/v1/health/resources")
async def health_resources() -> dict:
    if _health_monitor is None:
        return {"available": False}
    return _health_monitor.status()


@app.get("/v1/queue/status")
async def queue_status() -> dict:
    if _priority_queue is None:
        return {"available": False}
    return _priority_queue.stats()


@app.post("/v1/rag/build")
async def rag_build(request: RAGBuildRequest) -> dict:
    try:
        from logic.rag import rag_index
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"RAG module unavailable: {exc}")

    project_dir = Path(request.project_dir).expanduser().resolve()
    if not project_dir.exists():
        raise HTTPException(
            status_code=400,
            detail=f"project_dir does not exist: {project_dir}",
        )

    if _generator is None:
        raise HTTPException(
            status_code=503,
            detail="PyTorch generator required to build RAG index (no generator loaded)",
        )

    try:
        from inference.embedder import ProverbsEmbedder
        embedder = ProverbsEmbedder(_generator.model)
        loop = asyncio.get_event_loop()
        n_chunks: int = await loop.run_in_executor(
            None,
            lambda: rag_index.build(project_dir, embedder, _generator.tokenizer),
        )
        return {
            "ok": True,
            "project_dir": str(project_dir),
            "indexed_chunks": n_chunks,
        }
    except Exception as exc:
        log.error("RAG build failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/v1/rag/status")
async def rag_status() -> dict:
    try:
        from logic.rag import rag_index
        loaded = (
            rag_index._embeddings is not None
            and len(rag_index._chunks) > 0
        )
        return {
            "indexed_chunks": len(rag_index._chunks),
            "loaded": loaded,
        }
    except Exception as exc:
        return {"indexed_chunks": 0, "loaded": False, "error": str(exc)}


@app.get("/v1/cascade/stats")
async def cascade_stats() -> dict:
    try:
        from inference.cascade import CascadeGenerator
        # Check if _active_backend is a CascadeGenerator instance.
        if isinstance(_active_backend, CascadeGenerator):
            return {"available": True, **_active_backend.stats}
        return {"available": False, "reason": "Active backend is not a CascadeGenerator"}
    except Exception as exc:
        return {"available": False, "reason": str(exc)}


@app.get("/v1/cache/status")
async def cache_status() -> dict:
    return {
        "system_prompt_cached": _system_kv_caches is not None and len(_system_kv_caches) > 0,
        "cached_tokens": _system_prompt_tokens,
    }


@app.post("/v1/cache/invalidate")
async def cache_invalidate() -> dict:
    global _system_kv_caches, _system_prompt_tokens
    _system_kv_caches = None
    _system_prompt_tokens = 0
    try:
        from logic.rules import rules_injector
        sys_text = getattr(rules_injector, "get_system_prompt", lambda: "")() or ""
        if not sys_text:
            rules_path = Path.home() / ".proverbs" / "rules.md"
            sys_text = rules_path.read_text() if rules_path.exists() else ""
        if sys_text:
            _system_kv_caches, _system_prompt_tokens = _prefill_system_prompt(sys_text)
        return {"ok": True}
    except Exception as e:
        log.warning("Cache invalidate prefill failed: %s", e)
        return {"ok": False}


@app.get("/v1/speculative/status")
async def speculative_status() -> dict:
    return {"available": False, "reason": "Load nano+main to enable"}


@app.get("/v1/batch/status")
async def batch_status() -> dict:
    if _batch_manager is None:
        return {"enabled": False}
    return {
        "enabled": True,
        "max_batch_size": _batch_manager.max_batch_size,
        "active_requests": len(_batch_manager.active),
        "waiting_requests": _batch_manager.waiting.qsize(),
    }


@app.get("/v1/code-feedback/status")
async def code_feedback_status() -> dict:
    if _code_feedback is None:
        return {"enabled": False}
    return {
        "enabled": True,
        "max_revision_rounds": _code_feedback.max_revision_rounds,
    }


@app.post("/v1/admin/reload-model", response_model=None)
async def reload_model_endpoint(request: ReloadModelRequest | None = None) -> dict:
    """
    Hot-reload model weights without restarting the server.
    Called automatically after background retraining completes.
    """
    global _generator, _gguf_backend, _active_backend, _model_path, _backend_type

    req = request or ReloadModelRequest()
    new_pt   = os.path.expanduser(req.model_path   or os.environ.get("PROVERBS_MODEL_PATH",   _model_path))
    new_tok  = os.path.expanduser(req.tokenizer_path or os.environ.get("PROVERBS_TOKENIZER_PATH", "~/.proverbs/tokenizer.json"))
    new_back = req.backend or os.environ.get("PROVERBS_BACKEND", "auto")

    log.info("Hot-reloading model: %s (backend=%s)", new_pt, new_back)
    old_backend = _active_backend

    try:
        if new_back in ("auto", "gguf"):
            from inference.gguf_backend import GGUFBackend, DEFAULT_GGUF
            cand = new_pt if new_pt.endswith(".gguf") else DEFAULT_GGUF
            if cand and Path(cand).exists():
                _gguf_backend = GGUFBackend(cand, verbose=False)
                _active_backend = _gguf_backend
                _model_path = cand
                _backend_type = "gguf"
                log.info("Hot-reload complete: gguf")
                return {"success": True, "backend": "gguf", "model": cand}

        if new_back in ("auto", "pytorch") and new_pt.endswith(".pt") and Path(new_pt).exists():
            from model.proverbs_lm import ProverbsLM
            from inference.generate import ProverbsGenerator
            lm = ProverbsLM.load(new_pt, device=_device)
            lm.eval()
            gen = ProverbsGenerator(model=lm, tokenizer_path=new_tok, device=_device)
            _generator     = gen
            _active_backend = gen
            _model_path    = new_pt
            _backend_type  = "pytorch"
            log.info("Hot-reload complete: pytorch %s", lm)
            return {"success": True, "backend": "pytorch", "model": new_pt}

        return {"success": False, "error": f"No model found at {new_pt}"}

    except Exception as exc:
        _active_backend = old_backend
        log.error("Hot-reload failed: %s", exc, exc_info=True)
        return {"success": False, "error": str(exc)}


@app.get("/v1/admin/learn-status")
async def learn_status() -> dict:
    """Self-learning and auto-heal status."""
    try:
        from logic.self_learn import self_learner
        return {
            "self_learning": self_learner.status(),
            "backend": _backend_type,
            "model":   _model_path,
        }
    except Exception as exc:
        return {"error": str(exc)}


@app.get("/v1/metrics/summary")
async def metrics_summary(last_n: int = 100) -> dict:
    try:
        from logic.metrics import metrics
        return metrics.summary(last_n=last_n)
    except Exception as exc:
        log.warning("metrics summary error: %s", exc)
        return {"error": str(exc), "available": False}


class LoadChallengerRequest(BaseModel):
    model_path: str
    tokenizer_path: str


@app.get("/v1/ab/stats")
async def ab_stats() -> dict:
    if ab_engine is None:
        return {"enabled": False}
    return ab_engine.stats()


@app.post("/v1/ab/load-challenger")
async def ab_load_challenger(request: LoadChallengerRequest) -> dict:
    if ab_engine is None:
        raise HTTPException(status_code=503, detail="A/B engine not initialized")
    try:
        ab_engine.load_challenger(request.model_path, request.tokenizer_path)
        return {"success": True, "model_path": request.model_path}
    except Exception as exc:
        log.error("load-challenger failed: %s", exc, exc_info=True)
        return {"success": False, "error": str(exc)}


@app.get("/v1/models")
async def list_models() -> dict:
    return {
        "object": "list",
        "data": [
            {
                "id": "proverbs",
                "object": "model",
                "created": int(time.time()),
                "owned_by": "proverbs",
            }
        ],
    }


@app.post("/v1/chat/completions", response_model=None)
async def chat_completions(request: ChatCompletionRequest):
    from inference.security_middleware import validate_messages, validate_model_name, validate_max_tokens
    if not validate_model_name(request.model):
        raise HTTPException(400, "Invalid model name")
    messages_list = [m.model_dump() for m in request.messages]
    validated_ok, err = validate_messages(messages_list)
    if not validated_ok:
        raise HTTPException(400, err)

    gen = _require_generator()

    messages_raw = messages_list

    # Check response cache
    _cached_response: str | None = None
    try:
        from inference.response_cache import response_cache as _rc
        _cached_response = _rc.get(messages_raw, request.model, request.temperature)
    except Exception:
        pass

    if _cached_response is not None:
        prompt_tokens = _count_prompt_tokens(gen, messages_raw)
        completion_tokens = len(gen.tokenizer.encode(_cached_response)) if _cached_response else 0
        response_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
        try:
            from logic.metrics import metrics as _m
            _m.record_generation(completion_tokens, 0.0, request.model, None, cached=True)
        except Exception:
            pass
        from fastapi.responses import JSONResponse
        return JSONResponse(
            content={
                "id": response_id,
                "object": "chat.completion",
                "created": int(time.time()),
                "model": request.model,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": _cached_response},
                        "finish_reason": "stop",
                    }
                ],
                "usage": _make_usage(prompt_tokens, completion_tokens),
            },
            headers={"X-Cache": "HIT"},
        )

    # Inject git context into messages
    try:
        from logic.git_context import git_context as _gc
        messages_raw = _gc.inject(messages_raw, cwd=os.getcwd())
    except Exception:
        pass

    prompt_tokens = _count_prompt_tokens(gen, messages_raw)

    if request.stream:
        return StreamingResponse(
            _stream_chat(gen, messages_raw, request, prompt_tokens),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    # Non-streaming: run generation in a thread-pool executor so the event
    # loop is not blocked by the CPU-bound inference work.
    _t0 = time.time()
    loop = asyncio.get_event_loop()
    completion_text: str = await loop.run_in_executor(
        None,
        lambda: _run_generation(gen, messages_raw, request),
    )
    _duration_ms = (time.time() - _t0) * 1000.0

    completion_tokens = len(gen.tokenizer.encode(completion_text)) if completion_text else 0
    response_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"

    # Store in response cache
    try:
        from inference.response_cache import response_cache as _rc2
        _rc2.put(messages_raw, request.model, request.temperature, completion_text)
    except Exception:
        pass

    # Record generation metrics
    try:
        from logic.metrics import metrics as _m2
        _m2.record_generation(completion_tokens, _duration_ms, request.model, None, cached=False)
    except Exception:
        pass

    return {
        "id": response_id,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": "proverbs",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": completion_text,
                },
                "finish_reason": "stop",
            }
        ],
        "usage": _make_usage(prompt_tokens, completion_tokens),
    }


async def _stream_chat(
    gen: ProverbsGenerator,
    messages: list[dict],
    request: ChatCompletionRequest,
    prompt_tokens: int,
) -> AsyncGenerator[str, None]:
    """
    Yield Server-Sent Event chunks for a streaming chat completion.

    Each chunk is a JSON-encoded delta followed by the final [DONE] sentinel.
    We run the synchronous token generator inside a thread executor and bridge
    it to the async generator via an asyncio.Queue.
    """
    response_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
    created = int(time.time())
    queue: asyncio.Queue[str | None] = asyncio.Queue()
    loop = asyncio.get_event_loop()

    def _produce() -> None:
        """Run synchronous generation; push tokens into the queue."""
        try:
            token_gen = gen.generate(
                prompt=messages,
                max_new_tokens=request.max_tokens,
                temperature=request.temperature,
                top_p=request.top_p,
                stream=True,
            )
            for token_str in token_gen:  # type: ignore[union-attr]
                loop.call_soon_threadsafe(queue.put_nowait, token_str)
        except Exception as exc:
            log.error("Streaming generation error: %s", exc, exc_info=True)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)  # sentinel

    # Launch producer in a thread to avoid blocking the event loop.
    loop.run_in_executor(None, _produce)

    completion_tokens = 0
    while True:
        token_str = await queue.get()
        if token_str is None:
            break

        completion_tokens += 1
        chunk = {
            "id": response_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": "proverbs",
            "choices": [
                {
                    "index": 0,
                    "delta": {"content": token_str},
                    "finish_reason": None,
                }
            ],
        }
        yield f"data: {json.dumps(chunk)}\n\n"

    # Final chunk with finish_reason=stop
    final_chunk = {
        "id": response_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": "proverbs",
        "choices": [
            {
                "index": 0,
                "delta": {},
                "finish_reason": "stop",
            }
        ],
        "usage": _make_usage(prompt_tokens, completion_tokens),
    }
    yield f"data: {json.dumps(final_chunk)}\n\n"
    yield "data: [DONE]\n\n"


def _run_generation(
    gen: ProverbsGenerator,
    messages: list[dict],
    request: ChatCompletionRequest,
) -> str:
    """Synchronous wrapper around ProverbsGenerator.generate() for executor use."""
    result = gen.generate(
        prompt=messages,
        max_new_tokens=request.max_tokens,
        temperature=request.temperature,
        top_p=request.top_p,
        stream=False,
    )
    # generate() returns str when stream=False
    return result  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Logic hook endpoint
# ---------------------------------------------------------------------------


@app.post("/v1/logic/hook")
async def logic_hook(request: LogicHookRequest) -> dict:
    """
    Apply pre/post logic hooks to messages or an assistant response.

    Pre-hook:  receives messages list, may modify/augment them.
               Returns {"messages": [...]}

    Post-hook: receives the assistant response string, may modify it.
               Returns {"response": "..."}

    This is an integration point for the logic layer (hooks.py, memory, rules,
    tools).  The current implementation is a pass-through stub that returns the
    inputs unchanged.  Replace the hook handlers below with calls to
    logic/hooks.py once that module is implemented.
    """
    if request.phase == "pre":
        # --- Pre-hook: process/augment the incoming messages ---
        messages = [m.model_dump() for m in request.messages]

        rules_path = Path(os.path.expanduser("~/.proverbs/rules.md"))
        if rules_path.exists():
            try:
                rules_content = rules_path.read_text(encoding="utf-8").strip()
                if rules_content:
                    # Inject rules as the first system message if not already present
                    has_system = any(m["role"] == "system" for m in messages)
                    if not has_system:
                        messages.insert(0, {
                            "role": "system",
                            "content": rules_content,
                        })
            except OSError as exc:
                log.warning("Could not read rules.md: %s", exc)

        return {"messages": messages}

    elif request.phase == "post":
        # --- Post-hook: process/filter the assistant response ---
        response = request.response or ""
        return {"response": response}

    else:
        raise HTTPException(status_code=400, detail=f"Unknown phase: {request.phase!r}")


# ---------------------------------------------------------------------------
# Ollama-compatible shim routes
# cli.js uses /api/chat and /api/tags when activeApiFormat == 'ollama'
# Providing thin shims here means the server works without any cli.js changes.
# ---------------------------------------------------------------------------


@app.get("/api/tags")
async def ollama_tags() -> dict:
    """Ollama-compatible model list endpoint."""
    return {
        "models": [
            {
                "name": "proverbs",
                "model": "proverbs",
                "modified_at": "2025-01-01T00:00:00Z",
                "size": 0,
                "digest": "proverbs",
                "details": {
                    "format": "gguf",
                    "family": "proverbs",
                    "families": ["proverbs"],
                    "parameter_size": "25M",
                    "quantization_level": "F32",
                },
            }
        ]
    }


@app.post("/api/chat", response_model=None)
async def ollama_chat(raw: Request):
    """
    Ollama-compatible /api/chat endpoint.

    Translates the Ollama request format to internal format, runs generation,
    and returns an Ollama-style response.  Supports streaming.
    """
    gen = _require_generator()
    body: dict = await raw.json()

    messages_raw: list[dict] = body.get("messages", [])
    options: dict = body.get("options", {})
    stream: bool = body.get("stream", True)

    temperature: float = float(options.get("temperature", 0.7))
    top_p: float = float(options.get("top_p", 0.9))
    max_tokens: int = int(options.get("num_predict", 512))

    prompt_tokens = _count_prompt_tokens(gen, messages_raw)

    if stream:
        return StreamingResponse(
            _ollama_stream(gen, messages_raw, temperature, top_p, max_tokens),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # Non-streaming Ollama response
    loop = asyncio.get_event_loop()
    req_obj = _SimpleGenRequest(
        messages=messages_raw,
        temperature=temperature,
        top_p=top_p,
        max_tokens=max_tokens,
    )
    completion_text: str = await loop.run_in_executor(
        None,
        lambda: _run_generation_simple(gen, messages_raw, temperature, top_p, max_tokens),
    )

    completion_tokens = len(gen.tokenizer.encode(completion_text)) if completion_text else 0

    return {
        "model": "proverbs",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "message": {"role": "assistant", "content": completion_text},
        "done": True,
        "total_duration": 0,
        "load_duration": 0,
        "prompt_eval_count": prompt_tokens,
        "eval_count": completion_tokens,
        "eval_duration": 0,
    }


async def _ollama_stream(
    gen: ProverbsGenerator,
    messages: list[dict],
    temperature: float,
    top_p: float,
    max_tokens: int,
) -> AsyncGenerator[str, None]:
    """Yield newline-delimited JSON chunks in Ollama streaming format."""
    queue: asyncio.Queue[str | None] = asyncio.Queue()
    loop = asyncio.get_event_loop()
    created_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    def _produce() -> None:
        try:
            token_gen = gen.generate(
                prompt=messages,
                max_new_tokens=max_tokens,
                temperature=temperature,
                top_p=top_p,
                stream=True,
            )
            for token_str in token_gen:  # type: ignore[union-attr]
                loop.call_soon_threadsafe(queue.put_nowait, token_str)
        except Exception as exc:
            log.error("Ollama streaming error: %s", exc, exc_info=True)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    loop.run_in_executor(None, _produce)

    while True:
        token_str = await queue.get()
        if token_str is None:
            break
        chunk = {
            "model": "proverbs",
            "created_at": created_at,
            "message": {"role": "assistant", "content": token_str},
            "done": False,
        }
        yield json.dumps(chunk) + "\n"

    # Final done chunk
    done_chunk = {
        "model": "proverbs",
        "created_at": created_at,
        "message": {"role": "assistant", "content": ""},
        "done": True,
        "total_duration": 0,
        "load_duration": 0,
        "prompt_eval_count": 0,
        "eval_count": 0,
        "eval_duration": 0,
    }
    yield json.dumps(done_chunk) + "\n"


@app.post("/api/tokenize")
async def ollama_tokenize(raw: Request) -> dict:
    """Ollama-compatible tokenize endpoint — used by cli.js for token counting."""
    gen = _require_generator()
    body: dict = await raw.json()
    text: str = body.get("prompt", "")
    token_ids = gen.tokenizer.encode(text)
    return {"tokens": token_ids}


@app.post("/api/embeddings")
async def ollama_embeddings(raw: Request) -> dict:
    """
    Ollama-compatible embeddings endpoint.
    Returns the last hidden state of the model averaged over sequence length.
    """
    gen = _require_generator()
    body: dict = await raw.json()
    prompt: str = body.get("prompt", "")
    token_ids = gen.tokenizer.encode(prompt, add_bos=True)
    if not token_ids:
        return {"embedding": []}
    import torch
    input_ids = torch.tensor([token_ids], dtype=torch.long).to(gen.device)
    with torch.inference_mode():
        out = gen.model(input_ids)
        # Mean-pool the last hidden state via logits projection inverse isn't available,
        # so we use the token embeddings as the representation
        embed = gen.model.token_embed(input_ids).mean(dim=1).squeeze(0)
    return {"embedding": embed.float().cpu().tolist()}


# ---------------------------------------------------------------------------
# Internal helper (used by Ollama shim)
# ---------------------------------------------------------------------------


class _SimpleGenRequest:
    """Minimal stand-in for ChatCompletionRequest used inside executor lambdas."""

    def __init__(
        self,
        messages: list[dict],
        temperature: float,
        top_p: float,
        max_tokens: int,
    ) -> None:
        self.messages = messages
        self.temperature = temperature
        self.top_p = top_p
        self.max_tokens = max_tokens


def _run_generation_simple(
    gen: ProverbsGenerator,
    messages: list[dict],
    temperature: float,
    top_p: float,
    max_tokens: int,
) -> str:
    result = gen.generate(
        prompt=messages,
        max_new_tokens=max_tokens,
        temperature=temperature,
        top_p=top_p,
        stream=False,
    )
    return result  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Proverbs Inference Server — OpenAI-compatible FastAPI server",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--host",
        default="0.0.0.0",
        help="Host address to bind to.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=11434,
        help="Port to listen on (default matches Ollama so cli.js needs no changes).",
    )
    parser.add_argument(
        "--model",
        default=None,
        dest="model_path",
        help="Path to the .pt model checkpoint. Overrides PROVERBS_MODEL_PATH env var.",
    )
    parser.add_argument(
        "--tokenizer",
        default=None,
        dest="tokenizer_path",
        help="Path to tokenizer.json. Overrides PROVERBS_TOKENIZER_PATH env var.",
    )
    parser.add_argument(
        "--log-level",
        default="info",
        choices=["debug", "info", "warning", "error"],
        dest="log_level",
        help="Uvicorn log level.",
    )

    args = parser.parse_args()

    # Allow CLI flags to override env vars before startup hook runs.
    if args.model_path:
        os.environ["PROVERBS_MODEL_PATH"] = args.model_path
    if args.tokenizer_path:
        os.environ["PROVERBS_TOKENIZER_PATH"] = args.tokenizer_path

    log.info(
        "Starting Proverbs Inference Server on %s:%d", args.host, args.port
    )
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level=args.log_level,
    )
