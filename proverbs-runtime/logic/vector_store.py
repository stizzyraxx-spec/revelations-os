"""
HNSW (Hierarchical Navigable Small World) approximate nearest neighbor index.

Provides O(log n) approximate nearest neighbor search over L2-normalized
vectors using cosine distance, built from scratch in pure Python + numpy.
"""

from __future__ import annotations

import math
import pickle
import random
from pathlib import Path
from typing import Any

import numpy as np


class HNSWIndex:
    """
    Hierarchical Navigable Small World index for approximate nearest neighbor search.

    Vectors must be L2-normalized before insertion; distance metric is cosine
    distance (1 - dot product).  Supports persistence via pickle.
    """

    def __init__(
        self,
        dim: int,
        M: int = 16,
        ef_construction: int = 200,
        ef_search: int = 50,
    ) -> None:
        self.dim = dim
        self.M = M
        self.ef_construction = ef_construction
        self.ef_search = ef_search

        # Each node: {"id": int, "vector": np.ndarray, "connections": {layer: [id, ...]}}
        self.nodes: list[dict[str, Any]] = []
        self.entry_point: int = -1
        self.max_layer: int = 0

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _random_level(self) -> int:
        """Sample a level from the geometric distribution used by HNSW."""
        return math.floor(-math.log(random.random()) * (1.0 / math.log(self.M + 1)))

    def _dist(self, a: np.ndarray, b: np.ndarray) -> float:
        """Cosine distance assuming L2-normalized vectors: 1 - dot(a, b)."""
        return float(1.0 - np.dot(a, b))

    def _search_layer(
        self,
        query: np.ndarray,
        entry_id: int,
        ef: int,
        layer: int,
    ) -> list[int]:
        """
        Greedy beam search on a single HNSW layer.

        Returns up to *ef* node ids closest to *query*, starting from *entry_id*.
        Uses a min-heap (candidates to explore) and a max-heap (best found so far)
        represented as sorted lists to stay dependency-free.
        """
        entry_dist = self._dist(query, self.nodes[entry_id]["vector"])

        # candidates: (dist, id) — min-heap (closest first)
        candidates: list[tuple[float, int]] = [(entry_dist, entry_id)]
        # found: (dist, id) — we maintain this as a max-heap by negating dist
        # but store plain (dist, id) and track worst separately for simplicity.
        found: list[tuple[float, int]] = [(entry_dist, entry_id)]
        visited: set[int] = {entry_id}

        while candidates:
            # Pop the closest unprocessed candidate.
            c_dist, c_id = candidates[0]
            candidates = candidates[1:]

            # Determine the worst distance in our found set.
            worst_dist = max(d for d, _ in found)

            # Terminate early: if this candidate is farther than the worst found
            # and we already have ef results, no neighbor can improve things.
            if c_dist > worst_dist and len(found) >= ef:
                break

            for neighbor_id in self.nodes[c_id]["connections"].get(layer, []):
                if neighbor_id in visited:
                    continue
                visited.add(neighbor_id)

                n_dist = self._dist(query, self.nodes[neighbor_id]["vector"])
                worst_dist = max(d for d, _ in found)

                if n_dist < worst_dist or len(found) < ef:
                    # Add to candidates and found.
                    # Insert maintaining sorted order (O(ef) per insertion —
                    # acceptable for typical ef values ≤ 500).
                    _insert_sorted(candidates, (n_dist, neighbor_id))
                    _insert_sorted(found, (n_dist, neighbor_id))

                    if len(found) > ef:
                        # Remove the farthest element.
                        found.pop()

        return [node_id for _, node_id in found]

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def add(self, vector: np.ndarray) -> int:
        """
        Insert a new L2-normalized vector into the index.

        Returns the integer id assigned to the new node.
        """
        node_id = len(self.nodes)
        level = self._random_level()

        node: dict[str, Any] = {
            "id": node_id,
            "vector": np.asarray(vector, dtype=np.float32),
            "connections": {lyr: [] for lyr in range(level + 1)},
        }
        self.nodes.append(node)

        if self.entry_point == -1:
            # First node — becomes entry point for all layers.
            self.entry_point = node_id
            self.max_layer = level
            return node_id

        # Greedy descent from max_layer down to level + 1 (no insertion).
        current_entry = self.entry_point
        for lyr in range(self.max_layer, level, -1):
            neighbors = self._search_layer(vector, current_entry, ef=1, layer=lyr)
            current_entry = min(neighbors, key=lambda nid: self._dist(vector, self.nodes[nid]["vector"]))

        # Insert at each layer from min(level, max_layer) down to 0.
        for lyr in range(min(level, self.max_layer), -1, -1):
            candidates = self._search_layer(
                vector, current_entry, ef=self.ef_construction, layer=lyr
            )
            # Select M nearest as connections for the new node.
            candidates_sorted = sorted(
                candidates, key=lambda nid: self._dist(vector, self.nodes[nid]["vector"])
            )
            M_max = self.M * 2 if lyr == 0 else self.M
            selected = candidates_sorted[:M_max]

            node["connections"][lyr] = selected

            # Add bidirectional connections; prune neighbors that exceed M_max.
            for neighbor_id in selected:
                neighbor = self.nodes[neighbor_id]
                nbr_conns = neighbor["connections"].get(lyr, [])
                nbr_conns.append(node_id)

                if len(nbr_conns) > M_max:
                    # Prune: keep M_max closest neighbors by distance.
                    nbr_vec = neighbor["vector"]
                    nbr_conns = sorted(
                        nbr_conns,
                        key=lambda nid: self._dist(nbr_vec, self.nodes[nid]["vector"]),
                    )[:M_max]

                neighbor["connections"][lyr] = nbr_conns

            # Update entry point for the next layer.
            if candidates_sorted:
                current_entry = candidates_sorted[0]

        # Update global entry point if the new node occupies a higher layer.
        if level > self.max_layer:
            self.max_layer = level
            self.entry_point = node_id

        return node_id

    def search(self, query: np.ndarray, k: int = 10) -> list[tuple[float, int]]:
        """
        Return the k approximate nearest neighbors of *query*.

        Returns a list of (distance, node_id) pairs sorted by ascending distance.
        *query* must be L2-normalized.
        """
        if self.entry_point == -1:
            return []

        query = np.asarray(query, dtype=np.float32)
        current_entry = self.entry_point

        # Greedy descent from max_layer down to layer 1.
        for lyr in range(self.max_layer, 0, -1):
            neighbors = self._search_layer(query, current_entry, ef=1, layer=lyr)
            current_entry = min(
                neighbors,
                key=lambda nid: self._dist(query, self.nodes[nid]["vector"]),
            )

        # Full beam search at layer 0.
        candidates = self._search_layer(
            query, current_entry, ef=max(self.ef_search, k), layer=0
        )

        results = sorted(
            ((self._dist(query, self.nodes[nid]["vector"]), nid) for nid in candidates),
            key=lambda x: x[0],
        )
        return results[:k]

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def save(self, path: str | Path) -> None:
        """Pickle the index to *path*."""
        with open(path, "wb") as fh:
            pickle.dump(self, fh, protocol=pickle.HIGHEST_PROTOCOL)

    @classmethod
    def load(cls, path: str | Path) -> HNSWIndex:
        """Load a pickled HNSWIndex from *path*."""
        with open(path, "rb") as fh:
            obj = pickle.load(fh)
        if not isinstance(obj, cls):
            raise TypeError(f"Expected HNSWIndex, got {type(obj)}")
        return obj


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

def _insert_sorted(lst: list[tuple[float, int]], item: tuple[float, int]) -> None:
    """Insert *item* into *lst* maintaining ascending sort by first element."""
    dist = item[0]
    lo, hi = 0, len(lst)
    while lo < hi:
        mid = (lo + hi) // 2
        if lst[mid][0] < dist:
            lo = mid + 1
        else:
            hi = mid
    lst.insert(lo, item)
