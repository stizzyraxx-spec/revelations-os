"""Sliding window rate limiter (in-memory, per-IP + per-API-key) with Starlette middleware."""

from __future__ import annotations

import threading
import time

from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request


class RateLimiter:
    def __init__(self, requests_per_minute: int = 60, burst: int = 10) -> None:
        self.requests_per_minute = requests_per_minute
        self.burst = burst
        self._windows: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def is_allowed(self, identifier: str) -> tuple[bool, dict]:
        now = time.time()
        cutoff = now - 60.0
        with self._lock:
            window = self._windows.get(identifier, [])
            window = [ts for ts in window if ts > cutoff]
            if len(window) >= self.requests_per_minute:
                oldest = window[0]
                retry_after = int(oldest + 60.0 - now) + 1
                self._windows[identifier] = window
                return False, {
                    "retry_after": retry_after,
                    "limit": self.requests_per_minute,
                    "remaining": 0,
                }
            window.append(now)
            self._windows[identifier] = window
            return True, {
                "limit": self.requests_per_minute,
                "remaining": self.requests_per_minute - len(window),
            }

    def reset(self, identifier: str) -> None:
        with self._lock:
            self._windows.pop(identifier, None)


class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path == "/health":
            return await call_next(request)
        host = request.client.host if request.client else "unknown"
        api_key = request.headers.get("X-API-Key", "anon")
        identifier = f"{host}:{api_key}"
        allowed, info = rate_limiter.is_allowed(identifier)
        if not allowed:
            return JSONResponse(
                {"error": "Rate limit exceeded", **info},
                status_code=429,
                headers={
                    "Retry-After": str(info["retry_after"]),
                    "X-RateLimit-Limit": str(info["limit"]),
                },
            )
        response = await call_next(request)
        response.headers["X-RateLimit-Remaining"] = str(info["remaining"])
        return response


rate_limiter = RateLimiter()
