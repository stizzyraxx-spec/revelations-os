"""
Paged KV cache — eliminates memory fragmentation by pre-allocating a fixed pool
of equal-sized pages that sequences claim dynamically as they grow.
"""

from __future__ import annotations

import torch
from torch import Tensor


class PagedKVCache:
    """
    Memory-pool-backed KV cache that assigns fixed-size pages to sequences,
    removing fragmentation caused by variable-length tensor allocations.

    Layout of the backing pools (k_pool / v_pool):
        [n_layers, max_pages, page_size, n_kv_heads, head_dim]

    Each sequence owns a list of page indices (its *page table*).  When the
    current last page fills up, the next free page is claimed.  When a
    sequence finishes, all of its pages are returned to the free set.
    """

    def __init__(
        self,
        n_layers: int,
        n_kv_heads: int,
        head_dim: int,
        page_size: int = 16,
        max_pages: int = 512,
        device: str = "cpu",
    ) -> None:
        """
        Args:
            n_layers:   Number of transformer layers (one K/V pair each).
            n_kv_heads: Number of key/value attention heads.
            head_dim:   Dimension of each attention head.
            page_size:  Number of token slots per page.
            max_pages:  Total pages in the pool (shared across all sequences).
            device:     Torch device string for the backing tensors.
        """
        self.n_layers = n_layers
        self.n_kv_heads = n_kv_heads
        self.head_dim = head_dim
        self.page_size = page_size
        self.max_pages = max_pages
        self.device = device

        # Backing stores — pre-allocated once, never reallocated.
        self.k_pool: Tensor = torch.zeros(
            n_layers, max_pages, page_size, n_kv_heads, head_dim,
            dtype=torch.float32, device=device,
        )
        self.v_pool: Tensor = torch.zeros(
            n_layers, max_pages, page_size, n_kv_heads, head_dim,
            dtype=torch.float32, device=device,
        )

        # Free-page inventory and per-sequence state.
        self.free_pages: set[int] = set(range(max_pages))
        self.seq_page_tables: dict[str, list[int]] = {}
        self.seq_lengths: dict[str, int] = {}

    # ------------------------------------------------------------------
    # Sequence lifecycle
    # ------------------------------------------------------------------

    def allocate(self, seq_id: str) -> None:
        """Claim the first page for a new sequence.

        Raises:
            MemoryError: If the pool contains no free pages.
            ValueError:  If *seq_id* is already registered.
        """
        if seq_id in self.seq_page_tables:
            raise ValueError(f"Sequence '{seq_id}' is already allocated.")
        page = self._claim_page()
        self.seq_page_tables[seq_id] = [page]
        self.seq_lengths[seq_id] = 0

    def free(self, seq_id: str) -> None:
        """Return all pages belonging to *seq_id* to the free pool.

        No-op if *seq_id* is not registered.
        """
        pages = self.seq_page_tables.pop(seq_id, [])
        self.free_pages.update(pages)
        self.seq_lengths.pop(seq_id, None)

    # ------------------------------------------------------------------
    # Read / write
    # ------------------------------------------------------------------

    def append(
        self,
        seq_id: str,
        layer: int,
        k: Tensor,
        v: Tensor,
    ) -> None:
        """Write one token's K and V vectors into the cache.

        Args:
            seq_id: Registered sequence identifier.
            layer:  Layer index (0-based).
            k:      Key tensor of shape (1, n_kv_heads, head_dim) or
                    (n_kv_heads, head_dim) — both forms are accepted.
            v:      Value tensor, same shape convention as *k*.

        Raises:
            KeyError:    If *seq_id* has not been allocated.
            MemoryError: If the pool is exhausted and a new page is needed.
        """
        if seq_id not in self.seq_page_tables:
            raise KeyError(f"Sequence '{seq_id}' is not allocated. Call allocate() first.")

        # Normalise to (n_kv_heads, head_dim).
        k = k.squeeze(0) if k.dim() == 3 else k
        v = v.squeeze(0) if v.dim() == 3 else v

        length = self.seq_lengths[seq_id]
        page_table = self.seq_page_tables[seq_id]

        slot_in_page = length % self.page_size

        # If the current last page is full, claim a new one.
        if length > 0 and slot_in_page == 0:
            new_page = self._claim_page()
            page_table.append(new_page)

        page_idx = page_table[length // self.page_size]

        self.k_pool[layer, page_idx, slot_in_page] = k.to(self.k_pool.dtype)
        self.v_pool[layer, page_idx, slot_in_page] = v.to(self.v_pool.dtype)

        self.seq_lengths[seq_id] = length + 1

    def gather(self, seq_id: str, layer: int) -> tuple[Tensor, Tensor]:
        """Collect all stored K and V vectors for *seq_id* at *layer*.

        Returns:
            A 2-tuple ``(k, v)`` where each tensor has shape
            ``(n_kv_heads, T, head_dim)`` and *T* is the number of tokens
            written so far.

        Raises:
            KeyError: If *seq_id* has not been allocated.
        """
        if seq_id not in self.seq_page_tables:
            raise KeyError(f"Sequence '{seq_id}' is not allocated.")

        length = self.seq_lengths[seq_id]
        page_table = self.seq_page_tables[seq_id]

        if length == 0:
            empty = torch.zeros(
                self.n_kv_heads, 0, self.head_dim,
                dtype=self.k_pool.dtype, device=self.device,
            )
            return empty, empty.clone()

        # Collect page slices into contiguous lists then cat once.
        k_slices: list[Tensor] = []
        v_slices: list[Tensor] = []

        remaining = length
        for page_idx in page_table:
            n_slots = min(remaining, self.page_size)
            # Shape: (n_slots, n_kv_heads, head_dim)
            k_slices.append(self.k_pool[layer, page_idx, :n_slots])
            v_slices.append(self.v_pool[layer, page_idx, :n_slots])
            remaining -= n_slots
            if remaining <= 0:
                break

        # Concatenate along token axis then transpose to (n_kv_heads, T, head_dim).
        k_full = torch.cat(k_slices, dim=0).permute(1, 0, 2).contiguous()
        v_full = torch.cat(v_slices, dim=0).permute(1, 0, 2).contiguous()
        return k_full, v_full

    # ------------------------------------------------------------------
    # Diagnostics
    # ------------------------------------------------------------------

    def utilization(self) -> float:
        """Return fraction of pages currently in use (0.0 – 1.0)."""
        used = self.max_pages - len(self.free_pages)
        return used / self.max_pages

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _claim_page(self) -> int:
        """Pop and return one page from the free pool.

        Raises:
            MemoryError: If no free pages remain.
        """
        if not self.free_pages:
            raise MemoryError(
                f"PagedKVCache is exhausted: all {self.max_pages} pages are in use. "
                "Increase max_pages or free completed sequences."
            )
        return self.free_pages.pop()
