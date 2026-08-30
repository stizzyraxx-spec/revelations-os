"""
logic/audit_log.py — Security audit logging for all tool calls and API requests.

Appends structured JSON lines to ~/.proverbs/audit.jsonl; rotates the file when
it exceeds max_size_mb, renaming the old log to audit.jsonl.old.

Usage:
    from logic.audit_log import audit_logger

    audit_logger.log_tool_call("read_file", {"path": "/tmp/x"}, result_ok=True)
    audit_logger.log_api_request("POST", "/api/generate", ip="127.0.0.1", status_code=200)
"""

from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

AUDIT_LOG_PATH: Path = Path.home() / ".proverbs" / "audit.jsonl"

# ---------------------------------------------------------------------------
# AuditEvent field names (kept as a plain dict schema — no dataclass overhead)
# ---------------------------------------------------------------------------
#
# timestamp   : float   — Unix epoch from time.time()
# event_type  : str     — "tool_call" | "api_request" | "file_access" | "security_event"
# user_id     : str     — caller identity (empty string when unknown)
# ip_address  : str     — originating IP or "local"
# tool_name   : str     — name of the tool invoked (empty when not applicable)
# filepath    : str     — file path involved (empty when not applicable)
# command     : str     — raw command string (empty when not applicable)
# status      : str     — "ok" | "error" | "blocked" | HTTP status, etc.
# error       : str     — error message when status == "error", else empty


class AuditLogger:
    """Thread-safe JSONL audit logger with automatic rotation."""

    def __init__(
        self,
        log_path: Path = AUDIT_LOG_PATH,
        max_size_mb: float = 100,
    ) -> None:
        self._log_path = Path(log_path)
        self._max_bytes = int(max_size_mb * 1024 * 1024)
        self._lock = threading.Lock()
        self._log_path.parent.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _rotate_if_needed(self) -> None:
        """Rename audit.jsonl → audit.jsonl.old when size limit is exceeded."""
        try:
            if self._log_path.exists() and self._log_path.stat().st_size > self._max_bytes:
                old = self._log_path.with_suffix(".jsonl.old")
                self._log_path.replace(old)
        except OSError:
            pass  # best-effort; never crash the caller

    def _write(self, record: dict[str, Any]) -> None:
        """Append a single record as a JSON line, rotating first if needed."""
        self._rotate_if_needed()
        try:
            with self._log_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError:
            pass  # best-effort

    def _base_event(self, event_type: str, **kwargs: Any) -> dict[str, Any]:
        """Build a fully-populated AuditEvent dict with defaults."""
        return {
            "timestamp": time.time(),
            "event_type": event_type,
            "user_id": kwargs.get("user_id", ""),
            "ip_address": kwargs.get("ip_address", "local"),
            "tool_name": kwargs.get("tool_name", ""),
            "filepath": kwargs.get("filepath", ""),
            "command": kwargs.get("command", ""),
            "status": kwargs.get("status", ""),
            "error": kwargs.get("error", ""),
            # Extra fields from callers are stored as-is for queryability.
            **{k: v for k, v in kwargs.items() if k not in {
                "user_id", "ip_address", "tool_name", "filepath",
                "command", "status", "error",
            }},
        }

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def log(self, event_type: str, **kwargs: Any) -> None:
        """Build an AuditEvent dict and append it as a JSON line."""
        record = self._base_event(event_type, **kwargs)
        with self._lock:
            self._write(record)

    def log_tool_call(
        self,
        tool_name: str,
        parameters: dict[str, Any],
        result_ok: bool,
        ip: str = "local",
    ) -> None:
        """Record a tool invocation and whether it succeeded."""
        self.log(
            "tool_call",
            tool_name=tool_name,
            ip_address=ip,
            status="ok" if result_ok else "error",
            parameters=parameters,
        )

    def log_api_request(
        self,
        method: str,
        path: str,
        ip: str,
        status_code: int,
        api_key_hash: str = "",
    ) -> None:
        """Record an inbound HTTP API request."""
        self.log(
            "api_request",
            ip_address=ip,
            command=f"{method} {path}",
            status=str(status_code),
            api_key_hash=api_key_hash,
        )

    def log_file_access(
        self,
        filepath: str,
        operation: str,
        allowed: bool,
        ip: str = "local",
    ) -> None:
        """Record a filesystem access attempt."""
        self.log(
            "file_access",
            filepath=filepath,
            ip_address=ip,
            command=operation,
            status="ok" if allowed else "blocked",
        )

    def log_security_event(
        self,
        event: str,
        details: str,
        severity: str = "WARNING",
    ) -> None:
        """Record a security event; CRITICAL events are also printed to stderr."""
        severity = severity.upper()
        self.log(
            "security_event",
            tool_name=event,
            command=details,
            status=severity,
            severity=severity,
        )
        if severity == "CRITICAL":
            print(
                f"[PROVERBS AUDIT CRITICAL] {event}: {details}",
                file=sys.stderr,
                flush=True,
            )

    # ------------------------------------------------------------------
    # Query helpers
    # ------------------------------------------------------------------

    def recent(self, n: int = 50) -> list[dict[str, Any]]:
        """Return the last *n* audit entries from the log file."""
        with self._lock:
            try:
                lines = self._log_path.read_text(encoding="utf-8").splitlines()
            except OSError:
                return []
        entries: list[dict[str, Any]] = []
        for line in reversed(lines):
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
            if len(entries) >= n:
                break
        return list(reversed(entries))

    def suspicious(self, hours: float = 24) -> list[dict[str, Any]]:
        """Return entries with status='blocked' or severity='CRITICAL' in the past *hours*."""
        cutoff = time.time() - hours * 3600
        with self._lock:
            try:
                lines = self._log_path.read_text(encoding="utf-8").splitlines()
            except OSError:
                return []
        results: list[dict[str, Any]] = []
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("timestamp", 0) < cutoff:
                continue
            if record.get("status") == "blocked" or record.get("severity") == "CRITICAL":
                results.append(record)
        return results


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

audit_logger = AuditLogger()
