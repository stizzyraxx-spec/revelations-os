"""
Prefix KV Cache — reuse computed KV for repeated prompt prefixes.

When multiple requests share a common prefix (e.g. a system prompt or
frequently-used context), the KV for that prefix is computed once and
reused, cutting TTFT (time-to-first-token) by 40-80%.

Cache key: SHA-256 hex of the token ID sequence.
Eviction:  LRU by last-access time, bounded by max_entries.
"""

from __future__ import annotations

import hashlib
import time
from collections import OrderedDict
from typing import Optional


def _hash_ids(token_ids: list[int]) -> str:
    data = b"".join(x.to_bytes(3, "little") for x in token_ids)
    return hashlib.sha256(data).hexdigest()


class PrefixCache:
    """
    LRU in-memory KV prefix cache for ContinuousBatchManager.

    Each entry stores:
        kv_caches  — list of (k, v) tensors per layer (the model output)
        token_len  — number of tokens whose KV is cached
        last_used  — monotonic timestamp for LRU eviction
        hits       — number of times this entry was reused
    """

    def __init__(self, max_entries: int = 64, ttl_seconds: float = 3600.0) -> None:
        self.max_entries = max_entries
        self.ttl = ttl_seconds
        self._cache: OrderedDict[str, dict] = OrderedDict()
        self._hits  = 0
        self._total = 0

    # ── Public API ────────────────────────────────────────────────────────────

    def lookup(self, prompt_ids: list[int]) -> tuple[Optional[list], int]:
        """
        Find the longest cached prefix of prompt_ids.

        Returns
        -------
        (kv_caches, matched_len)
            kv_caches   — list of (k, v) per layer, or None on miss
            matched_len — number of prompt tokens whose KV is already computed
        """
        self._total += 1
        if not self._cache:
            return None, 0
        now = time.monotonic()

        # One incremental SHA-256 pass yields the hash of every prefix in
        # O(n) total, instead of re-hashing each prefix from scratch (O(n²)).
        h = hashlib.sha256()
        digests: list[str] = []
        for x in prompt_ids:
            h.update(x.to_bytes(3, "little"))
            digests.append(h.hexdigest())

        # Walk from full length down to minimum useful prefix (>= 4 tokens).
        for length in range(len(prompt_ids), 3, -1):
            key = digests[length - 1]
            entry = self._cache.get(key)
            if entry is None:
                continue
            if now - entry["last_used"] > self.ttl:
                del self._cache[key]
                continue
            # Cache hit — move to end (most-recently-used).
            self._cache.move_to_end(key)
            entry["last_used"] = now
            entry["hits"] += 1
            self._hits += 1
            return entry["kv_caches"], length

        return None, 0

    def store(self, prompt_ids: list[int], kv_caches: list) -> None:
        """Store a newly computed KV cache for prompt_ids."""
        if len(prompt_ids) < 4:
            return
        key = _hash_ids(prompt_ids)
        self._cache[key] = {
            "kv_caches":  _clone_kv(kv_caches),
            "token_len":  len(prompt_ids),
            "last_used":  time.monotonic(),
            "hits":       0,
        }
        self._cache.move_to_end(key)
        self._evict()

    def stats(self) -> dict:
        hit_rate = self._hits / self._total if self._total else 0.0
        return {
            "entries":  len(self._cache),
            "hits":     self._hits,
            "total":    self._total,
            "hit_rate": round(hit_rate, 4),
        }

    def clear(self) -> None:
        self._cache.clear()
        self._hits = 0
        self._total = 0

    # ── Internal ──────────────────────────────────────────────────────────────

    def _evict(self) -> None:
        while len(self._cache) > self.max_entries:
            self._cache.popitem(last=False)  # remove LRU (first item)


def _clone_kv(kv_caches: list) -> list:
    """Deep-copy KV tensors so the cache is independent of future in-place ops."""
    import torch
    cloned = []
    for kv in kv_caches:
        if kv is None:
            cloned.append(None)
        else:
            k, v = kv
            cloned.append((k.detach().clone(), v.detach().clone()))
    return cloned


# Module-level singleton used by inference server and batch manager.
_global_cache: PrefixCache | None = None


def get_cache(max_entries: int = 64) -> PrefixCache:
    global _global_cache
    if _global_cache is None:
        _global_cache = PrefixCache(max_entries=max_entries)
    return _global_cache
