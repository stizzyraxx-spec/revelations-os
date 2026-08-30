"""
Secure environment variable and secrets management for Proverbs LLM.

Secrets are persisted in ~/.proverbs/secrets.json (mode 0o600) and merged
with any environment variables prefixed with PROVERBS_. File is only re-read
when its mtime changes, so repeated get() calls are cache-fast.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

SECRETS_FILE: Path = Path.home() / ".proverbs" / "secrets.json"
ENV_PREFIX: str = "PROVERBS_"


def mask(value: str) -> str:
    """Return first 4 chars + '****' + last 2 chars; '****' for values shorter than 8 chars."""
    if len(value) < 8:
        return "****"
    return value[:4] + "****" + value[-2:]


class SecretsManager:
    """Thread-safe (GIL) secrets manager with file-backed persistence and env-var overlay."""

    def __init__(self) -> None:
        self._cache: dict[str, str] = {}
        self._file_ts: float = 0.0

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _load(self) -> dict[str, str]:
        """Load SECRETS_FILE if newer than _file_ts, merge with PROVERBS_ env vars."""
        data: dict[str, str] = {}

        if SECRETS_FILE.exists():
            try:
                mtime = SECRETS_FILE.stat().st_mtime
            except OSError:
                mtime = 0.0

            if mtime > self._file_ts:
                # Ensure restrictive permissions on every read.
                try:
                    os.chmod(SECRETS_FILE, 0o600)
                except OSError as exc:
                    logger.warning("Could not chmod secrets file: %s", exc)

                try:
                    raw = SECRETS_FILE.read_text(encoding="utf-8")
                    data = json.loads(raw) if raw.strip() else {}
                except (OSError, json.JSONDecodeError) as exc:
                    logger.error("Failed to read secrets file: %s", exc)
                    data = {}

                self._file_ts = mtime
            else:
                # File unchanged — use cached data (env overlay still applied below).
                data = {
                    k: v
                    for k, v in self._cache.items()
                    if not k.startswith("__env__")  # internal sentinel; never set
                }
                # Re-read from cache without mutating _cache yet.
                data = dict(self._cache)

        # Overlay environment variables (env wins over file for same key).
        for env_key, env_val in os.environ.items():
            if env_key.startswith(ENV_PREFIX):
                stripped = env_key[len(ENV_PREFIX):]
                if stripped:
                    data[stripped] = env_val

        self._cache = data
        return data

    def _current_file_data(self) -> dict[str, str]:
        """Read only the persisted file data (no env overlay), for write operations."""
        if not SECRETS_FILE.exists():
            return {}
        try:
            raw = SECRETS_FILE.read_text(encoding="utf-8")
            return json.loads(raw) if raw.strip() else {}
        except (OSError, json.JSONDecodeError) as exc:
            logger.error("Failed to read secrets file for write: %s", exc)
            return {}

    def _write_file(self, data: dict[str, str]) -> None:
        """Atomically write data to SECRETS_FILE with mode 0o600."""
        SECRETS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = SECRETS_FILE.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
            os.chmod(tmp, 0o600)
            tmp.replace(SECRETS_FILE)
            # Invalidate timestamp so next _load() re-reads.
            self._file_ts = 0.0
        except OSError as exc:
            logger.error("Failed to write secrets file: %s", exc)
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            raise

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get(self, key: str, default: Any = None) -> str | None:
        """Return secret value for key, or default if absent. Never logs the value."""
        # Check whether the file has changed since last load.
        current_mtime: float = 0.0
        if SECRETS_FILE.exists():
            try:
                current_mtime = SECRETS_FILE.stat().st_mtime
            except OSError:
                current_mtime = 0.0

        if current_mtime > self._file_ts or not self._cache:
            self._load()

        logger.debug("secrets.get accessed key=%r", key)
        return self._cache.get(key, default)

    def set(self, key: str, value: str) -> None:
        """Add or update key in persisted secrets and refresh cache."""
        logger.debug("secrets.set key=%r", key)
        data = self._current_file_data()
        data[key] = value
        self._write_file(data)
        self._load()

    def delete(self, key: str) -> bool:
        """Remove key from persisted secrets. Returns True if key existed."""
        logger.debug("secrets.delete key=%r", key)
        data = self._current_file_data()
        if key not in data:
            return False
        del data[key]
        self._write_file(data)
        self._load()
        return True

    def list_keys(self) -> list[str]:
        """Return a list of all known key names (values are never exposed)."""
        self._load()
        return list(self._cache.keys())

    def rotate(self, key: str) -> str:
        """Generate a new UUID4 value for key, persist it, and return the new value."""
        new_value = str(uuid.uuid4())
        logger.debug("secrets.rotate key=%r", key)
        self.set(key, new_value)
        return new_value


# Module-level singleton for convenient import.
secrets = SecretsManager()
