"""
Proverbs Inference Server — API key authentication middleware.

Provides:
  AuthConfig          — load/save/manage API keys in ~/.proverbs/config.json
  APIKeyMiddleware    — Starlette BaseHTTPMiddleware enforcing key checks
  get_or_create_api_key — convenience helper for first-run setup
  auth_config         — module-level singleton
"""

from __future__ import annotations

import json
import logging
import uuid
from pathlib import Path
from typing import Any

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

log = logging.getLogger("proverbs.auth")

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_CONFIG_PATH = Path.home() / ".proverbs" / "config.json"

# Paths that bypass authentication entirely (health/compat probes)
_SKIP_AUTH_PATHS: frozenset[str] = frozenset({
    "/health",
    "/api/tags",
    "/v1/models",
})

# ---------------------------------------------------------------------------
# AuthConfig
# ---------------------------------------------------------------------------


class AuthConfig:
    """Manages API keys stored in ~/.proverbs/config.json."""

    def load(self) -> dict[str, Any]:
        """
        Read config.json and return its contents as a dict.

        If the file does not exist, or the ``api_keys`` list is missing/empty,
        a single UUID4 key is generated, written to disk, and the updated dict
        is returned.
        """
        config: dict[str, Any] = {}

        if _CONFIG_PATH.exists():
            try:
                config = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError) as exc:
                log.warning("Could not parse %s: %s — starting fresh", _CONFIG_PATH, exc)
                config = {}

        if not config.get("api_keys"):
            new_key = self.generate_key()
            config.setdefault("api_keys", [])
            config["api_keys"] = [new_key]
            self._write(config)
            log.info(
                "No API keys found — generated new key and saved to %s", _CONFIG_PATH
            )

        return config

    def get_keys(self) -> set[str]:
        """Return the current set of valid API key strings."""
        config = self.load()
        keys = config.get("api_keys", [])
        return set(str(k) for k in keys if k)

    def add_key(self, key: str) -> None:
        """Append *key* to the stored key list (no-op if already present)."""
        config = self.load()
        keys: list[str] = config.get("api_keys", [])
        if key not in keys:
            keys.append(key)
            config["api_keys"] = keys
            self._write(config)
            log.info("API key added")

    def remove_key(self, key: str) -> None:
        """Remove *key* from the stored key list (no-op if not present)."""
        config = self.load()
        keys: list[str] = config.get("api_keys", [])
        if key in keys:
            keys.remove(key)
            config["api_keys"] = keys
            self._write(config)
            log.info("API key removed")

    @staticmethod
    def generate_key() -> str:
        """Return a fresh UUID4 as a 32-character hex string (no hyphens)."""
        return uuid.uuid4().hex

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    @staticmethod
    def _write(config: dict[str, Any]) -> None:
        """Persist *config* to disk, creating parent directories as needed."""
        _CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        _CONFIG_PATH.write_text(
            json.dumps(config, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )


# ---------------------------------------------------------------------------
# APIKeyMiddleware
# ---------------------------------------------------------------------------


class APIKeyMiddleware(BaseHTTPMiddleware):
    """
    Starlette middleware that enforces API-key authentication on every request
    except the designated public paths.

    Key lookup order (first match wins):
      1. ``X-API-Key`` request header
      2. ``Authorization: Bearer <key>`` request header
      3. ``?api_key=<key>`` query parameter (browser compat)

    Returns HTTP 401 JSON on failure; passes the request through on success.
    """

    async def dispatch(self, request: Request, call_next):  # type: ignore[override]
        # Skip auth for health/compat probe paths
        if request.url.path in _SKIP_AUTH_PATHS:
            return await call_next(request)

        valid_keys = auth_config.get_keys()

        # 1. X-API-Key header
        key = request.headers.get("X-API-Key", "").strip()

        # 2. Authorization: Bearer <key>
        if not key:
            auth_header = request.headers.get("Authorization", "").strip()
            if auth_header.lower().startswith("bearer "):
                key = auth_header[len("bearer "):].strip()

        # 3. ?api_key= query parameter
        if not key:
            key = request.query_params.get("api_key", "").strip()

        if not key or key not in valid_keys:
            return JSONResponse(
                content={"error": "Unauthorized"},
                status_code=401,
            )

        return await call_next(request)


# ---------------------------------------------------------------------------
# Convenience helper
# ---------------------------------------------------------------------------


def get_or_create_api_key() -> str:
    """
    Return the first stored API key, generating and persisting one if needed.

    Intended for first-run setup / CLI display of the active key.
    """
    keys = auth_config.get_keys()
    if keys:
        return next(iter(sorted(keys)))  # deterministic: smallest hex value
    # get_keys() calls load() which auto-generates when empty, so this branch
    # is reached only if something cleared the list between the two calls.
    new_key = auth_config.generate_key()
    auth_config.add_key(new_key)
    return new_key


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

auth_config = AuthConfig()
