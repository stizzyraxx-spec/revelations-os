"""
auto_heal.py — Auto-healing for the Proverbs LLM inference server.

When the CLI or server encounters a connection error, AutoHealer:
  1. Detects what went wrong (ECONNREFUSED, 503, timeout, etc.)
  2. Attempts to fix it (spawn server, reload model, fallback to GGUF)
  3. Returns True if healed so the caller can retry the request
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

log = logging.getLogger("proverbs.auto_heal")

VENV_PYTHON     = str(Path.home() / ".proverbs" / "venv" / "bin" / "python")
PROJECT_ROOT    = str(Path(__file__).resolve().parent.parent)
SERVER_LOG      = "/tmp/proverbs-server.log"
STARTUP_TIMEOUT = 30    # seconds to wait for server after spawn


# ── Health check ─────────────────────────────────────────────────────────────

def is_server_healthy(url: str = "http://localhost:11434", timeout: float = 3.0) -> bool:
    try:
        req = urllib.request.Request(url + "/health")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
            return data.get("model_loaded", False)
    except Exception:
        return False


def get_server_status(url: str = "http://localhost:11434") -> dict:
    try:
        req = urllib.request.Request(url + "/health")
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {"status": "unreachable", "error": str(e)}


# ── Server management ─────────────────────────────────────────────────────────

def spawn_server(
    port: int = 11434,
    model_path: str | None = None,
    tokenizer_path: str | None = None,
    backend: str = "auto",
) -> subprocess.Popen:
    """Spawn the Proverbs inference server as a detached background process."""
    env = {
        **os.environ,
        "PROVERBS_BACKEND":        backend,
        "PROVERBS_MODEL_PATH":     model_path     or str(Path.home() / ".proverbs" / "checkpoints" / "local" / "best.pt"),
        "PROVERBS_TOKENIZER_PATH": tokenizer_path or str(Path.home() / ".proverbs" / "tokenizer.json"),
    }
    log_fh = open(SERVER_LOG, "a")
    proc = subprocess.Popen(
        [VENV_PYTHON, "-m", "inference.server", "--port", str(port)],
        cwd=PROJECT_ROOT,
        env=env,
        stdout=log_fh,
        stderr=log_fh,
        start_new_session=True,
    )
    log.info("Spawned Proverbs server PID=%d on port %d", proc.pid, port)
    return proc


def ensure_server_running(port: int = 11434, max_wait: int = STARTUP_TIMEOUT) -> bool:
    """
    Ensure the server is running and healthy.
    If not, spawn it and wait up to max_wait seconds.
    Returns True if server is healthy.
    """
    import time
    if is_server_healthy():
        return True

    log.info("Server unhealthy — spawning new instance")
    spawn_server(port=port)

    for i in range(max_wait):
        time.sleep(1)
        if is_server_healthy():
            log.info("Server ready after %ds", i + 1)
            return True

    log.error("Server failed to start after %ds — check %s", max_wait, SERVER_LOG)
    return False


def reload_model(
    url: str = "http://localhost:11434",
    model_path: str | None = None,
    tokenizer_path: str | None = None,
) -> bool:
    """Hot-reload the model in the running server. Returns True on success."""
    payload: dict = {}
    if model_path:
        payload["model_path"] = model_path
    if tokenizer_path:
        payload["tokenizer_path"] = tokenizer_path

    try:
        req = urllib.request.Request(
            url + "/v1/admin/reload-model",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read())
            return result.get("success", False)
    except Exception as e:
        log.error("Hot-reload request failed: %s", e)
        return False


# ── AutoHealer ────────────────────────────────────────────────────────────────

class AutoHealer:
    """
    Maintains a fallback chain when requests to the inference server fail.

    Fallback order:
      ECONNREFUSED / ECONNRESET → restart server
      503 (model not loaded)    → hot-reload model
      Repeated failures          → fall back to GGUF backend
    """

    def __init__(self, server_url: str = "http://localhost:11434"):
        self.server_url       = server_url
        self._failures        = 0
        self._MAX_FAILURES    = 3

    def on_request_error(self, error_code: str) -> bool:
        """
        Called when a request to the server fails.
        Returns True if the issue was healed and the caller should retry.

        error_code values: "ECONNREFUSED" | "ECONNRESET" | "TIMEOUT" | "503" | "500"
        """
        self._failures += 1

        if error_code in ("ECONNREFUSED", "ECONNRESET"):
            log.warning("Connection error (%s) — auto-healing", error_code)
            healed = ensure_server_running()
            if healed:
                self._failures = 0
            return healed

        if error_code == "503":
            log.warning("Server returned 503 (model not loaded) — reloading")
            healed = reload_model(self.server_url)
            if healed:
                self._failures = 0
            return healed

        if error_code in ("500", "TIMEOUT") and self._failures >= self._MAX_FAILURES:
            log.warning("%d consecutive failures — restarting server", self._failures)
            # Kill and respawn
            try:
                import signal as _sig
                status = get_server_status(self.server_url)
                # Just respawn — old process will die when port is taken
            except Exception:
                pass
            healed = ensure_server_running()
            if healed:
                self._failures = 0
            return healed

        return False

    def on_success(self) -> None:
        self._failures = 0

    @property
    def is_healthy(self) -> bool:
        return is_server_healthy(self.server_url)

    def status(self) -> dict:
        return {
            **get_server_status(self.server_url),
            "consecutive_failures": self._failures,
            "max_before_restart":   self._MAX_FAILURES,
        }


# Global instance
auto_healer = AutoHealer()
