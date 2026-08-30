"""LRU cache for identical (temperature=0) chat queries, keyed by sha256 of canonical message JSON + model + temperature."""

from __future__ import annotations

import hashlib
import json
import time
from collections import OrderedDict


class ResponseCache:
    def __init__(self, max_size: int = 256, ttl_seconds: int = 3600) -> None:
        # OrderedDict gives O(1) LRU maintenance (move_to_end / popitem).
        self._cache: OrderedDict[str, dict] = OrderedDict()
        self.max_size = max_size
        self.ttl_seconds = ttl_seconds
        self._gets: int = 0
        self._hits: int = 0

    def _make_key(self, messages: list, model: str, temperature: float) -> str:
        canonical = json.dumps(messages, sort_keys=True, separators=(",", ":"))
        raw = f"{canonical}|{model}|{temperature}"
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    def get(self, messages: list, model: str, temperature: float) -> str | None:
        self._gets += 1
        key = self._make_key(messages, model, temperature)
        entry = self._cache.get(key)
        if entry is None:
            return None
        if time.time() - entry["timestamp"] > self.ttl_seconds:
            self._cache.pop(key, None)
            return None
        self._hits += 1
        entry["hits"] += 1
        self._cache.move_to_end(key)
        return entry["response"]

    def put(self, messages: list, model: str, temperature: float, response: str) -> None:
        if temperature != 0.0:
            return
        key = self._make_key(messages, model, temperature)
        if key not in self._cache and len(self._cache) >= self.max_size:
            self._cache.popitem(last=False)  # evict LRU
        self._cache[key] = {"response": response, "timestamp": time.time(), "hits": 0}
        self._cache.move_to_end(key)

    def stats(self) -> dict:
        return {
            "size": len(self._cache),
            "max_size": self.max_size,
            "total_hits": self._hits,
            "hit_rate": self._hits / self._gets if self._gets > 0 else 0.0,
        }

    def invalidate(self) -> None:
        self._cache.clear()


response_cache = ResponseCache()
