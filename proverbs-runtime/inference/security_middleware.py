"""
Proverbs Inference Server — Security middleware and input validation utilities.

Provides:
  SecurityHeadersMiddleware — injects hardened HTTP response headers
  validate_messages         — checks message list structure and content
  validate_model_name       — rejects path-traversal and malformed model IDs
  validate_max_tokens       — clamps token count to a safe range
  sanitize_string           — strips null bytes and enforces a length cap
  CORS_ORIGINS              — explicit allowlist for CORSMiddleware
"""

from __future__ import annotations

import re

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp

# ---------------------------------------------------------------------------
# Allowed CORS origins (used by server.py when replacing the wildcard config)
# ---------------------------------------------------------------------------

CORS_ORIGINS: list[str] = [
    "http://localhost",
    "http://127.0.0.1",
    "http://localhost:3000",
    "http://localhost:4300",
    "http://localhost:8080",
]

# ---------------------------------------------------------------------------
# Security headers middleware
# ---------------------------------------------------------------------------

_SECURITY_HEADERS: dict[str, str] = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "1; mode=block",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
}


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Attach hardened security headers to every outgoing response."""

    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next) -> Response:  # type: ignore[override]
        response: Response = await call_next(request)
        for header, value in _SECURITY_HEADERS.items():
            response.headers[header] = value
        return response


# ---------------------------------------------------------------------------
# Input validation helpers
# ---------------------------------------------------------------------------

_VALID_ROLES: frozenset[str] = frozenset({"user", "assistant", "system"})
_MAX_MESSAGES: int = 100
_MAX_CONTENT_CHARS: int = 32_000

# Alphanumeric plus the four punctuation chars that appear in real model IDs.
# Must NOT contain forward-slash, back-slash, or the ".." sequence.
_MODEL_NAME_RE: re.Pattern[str] = re.compile(r"^[A-Za-z0-9:.\-_]{1,64}$")

_MAX_TOKENS_MIN: int = 1
_MAX_TOKENS_MAX: int = 8_192


def validate_messages(messages: list) -> tuple[bool, str]:
    """
    Validate a messages list for safety and structural correctness.

    Returns (True, "") on success, or (False, <error_message>) on failure.

    Checks performed:
      - At most 100 messages.
      - Each message must be a dict with a ``role`` and ``content`` key.
      - Role must be one of: user, assistant, system.
      - Content must be a string of at most 32 000 characters.
      - Content must not contain null bytes.
    """
    if len(messages) > _MAX_MESSAGES:
        return False, f"Too many messages: {len(messages)} (max {_MAX_MESSAGES})"

    for idx, msg in enumerate(messages):
        if not isinstance(msg, dict):
            return False, f"Message {idx} is not a dict"

        role = msg.get("role")
        if role not in _VALID_ROLES:
            return False, (
                f"Message {idx} has invalid role {role!r}; "
                f"must be one of {sorted(_VALID_ROLES)}"
            )

        content = msg.get("content")
        if not isinstance(content, str):
            return False, f"Message {idx} content must be a string"

        if len(content) > _MAX_CONTENT_CHARS:
            return False, (
                f"Message {idx} content exceeds {_MAX_CONTENT_CHARS} characters "
                f"({len(content)} chars)"
            )

        if "\x00" in content:
            return False, f"Message {idx} content contains null bytes"

    return True, ""


def validate_model_name(name: str) -> bool:
    """
    Return True if *name* is a safe model identifier.

    Accepts alphanumerics plus ``:``, ``.``, ``-``, ``_`` up to 64 chars.
    Rejects anything containing ``/``, ``\\``, or the ``..`` sequence to
    prevent path-traversal attacks.
    """
    if not isinstance(name, str):
        return False
    if "/" in name or "\\" in name or ".." in name:
        return False
    return bool(_MODEL_NAME_RE.match(name))


def validate_max_tokens(n: int) -> int:
    """
    Clamp *n* to the inclusive range [1, 8192] and return the clamped value.

    Accepts any integer-like input; non-integer types are coerced via int().
    """
    try:
        n = int(n)
    except (TypeError, ValueError):
        return _MAX_TOKENS_MIN
    return max(_MAX_TOKENS_MIN, min(n, _MAX_TOKENS_MAX))


def sanitize_string(s: str, max_len: int = 10_000) -> str:
    """
    Remove null bytes from *s* and truncate to *max_len* characters.

    Returns the cleaned string.  Does not raise; non-string input is coerced
    to str before processing.
    """
    if not isinstance(s, str):
        s = str(s)
    s = s.replace("\x00", "")
    return s[:max_len]
