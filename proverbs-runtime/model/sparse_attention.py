"""
Sparse attention variants for ProverbsLM.

SlidingWindowAttention — O(n·w) causal attention where each token attends only
to the nearest `window_size` prior tokens (default 512), reducing memory for
long contexts while preserving local coherence.

LinearAttention — O(n) causal attention via the ELU+1 kernel feature map and
the cumulative-sum KV trick, trading exact softmax for linear-time inference.

Both modules share the same init signature, Q/K/V projections, and RoPE setup
as MultiHeadAttention so they are drop-in replacements inside transformer blocks.
"""

import math
import torch
import torch.nn as nn
import torch.nn.functional as F
from .config import ProverbsConfig
from .attention import _rope_freqs, apply_rope


# ── Sliding-Window Attention ──────────────────────────────────────────────────

class SlidingWindowAttention(nn.Module):
    """Causal attention restricted to a local window of `window_size` tokens."""

    def __init__(self, cfg: ProverbsConfig):
        super().__init__()
        self.n_heads    = cfg.n_heads
        self.n_kv_heads = cfg.n_kv_heads
        self.head_dim   = cfg.head_dim
        self.n_rep      = cfg.n_heads // cfg.n_kv_heads
        self.window_size = getattr(cfg, "sliding_window_size", 512)

        self.q_proj = nn.Linear(cfg.d_model, cfg.n_heads    * cfg.head_dim, bias=False)
        self.k_proj = nn.Linear(cfg.d_model, cfg.n_kv_heads * cfg.head_dim, bias=False)
        self.v_proj = nn.Linear(cfg.d_model, cfg.n_kv_heads * cfg.head_dim, bias=False)
        self.o_proj = nn.Linear(cfg.n_heads * cfg.head_dim, cfg.d_model,    bias=False)

        self.dropout = nn.Dropout(cfg.dropout)
        self.scale   = math.sqrt(cfg.head_dim)

        angles = _rope_freqs(cfg.head_dim, cfg.max_seq_len, cfg.rope_theta, device=torch.device("cpu"))
        self.register_buffer("rope_cos", angles.cos())  # (max_seq_len, head_dim)
        self.register_buffer("rope_sin", angles.sin())

    def _sliding_window_mask(self, T: int, S: int, device: torch.device) -> torch.Tensor:
        """Return an additive mask (1, 1, T, S) where out-of-window positions are -inf."""
        # q positions: 0..T-1, k positions: 0..S-1
        q_idx = torch.arange(T, device=device).unsqueeze(1)  # (T, 1)
        k_idx = torch.arange(S, device=device).unsqueeze(0)  # (1, S)
        # causal: k must not be in the future relative to q (accounting for cache offset)
        cache_offset = S - T
        q_abs = q_idx + cache_offset                          # absolute position of each query
        causal_ok  = k_idx <= q_abs                           # k is not in the future
        window_ok  = q_abs - k_idx < self.window_size         # k is within window
        allowed = causal_ok & window_ok                       # (T, S)
        mask = torch.zeros(T, S, device=device)
        mask[~allowed] = float("-inf")
        return mask.unsqueeze(0).unsqueeze(0)                 # (1, 1, T, S)

    def forward(
        self,
        x: torch.Tensor,                               # (B, T, d_model)
        mask: torch.Tensor | None = None,              # ignored — we build our own
        kv_cache: tuple | None = None,                 # (k_cache, v_cache) for generation
        decode_attn_mask: torch.Tensor | None = None,  # (B, 1, 1, S) for batched decode padding
        position_ids: torch.Tensor | None = None,      # (B, T) absolute positions (batched decode)
    ) -> tuple:
        B, T, _ = x.shape

        q = self.q_proj(x).view(B, T, self.n_heads,    self.head_dim).transpose(1, 2)
        k = self.k_proj(x).view(B, T, self.n_kv_heads, self.head_dim).transpose(1, 2)
        v = self.v_proj(x).view(B, T, self.n_kv_heads, self.head_dim).transpose(1, 2)

        # Apply RoPE at the tokens' absolute positions. During cached decode
        # (T==1) the new token sits at position past_len, not position 0.
        past_len = kv_cache[0].shape[2] if kv_cache is not None else 0
        if position_ids is not None:
            cos = self.rope_cos[position_ids].to(x.device)  # (B, T, head_dim)
            sin = self.rope_sin[position_ids].to(x.device)
        else:
            cos = self.rope_cos[past_len:past_len + T].to(x.device)
            sin = self.rope_sin[past_len:past_len + T].to(x.device)
        q, k = apply_rope(q, k, cos, sin)

        # KV cache append (autoregressive generation)
        if kv_cache is not None:
            k_cache, v_cache = kv_cache
            k = torch.cat([k_cache, k], dim=2)
            v = torch.cat([v_cache, v], dim=2)
        new_kv_cache = (k, v)

        S = k.shape[2]  # total key length (may include cache)

        # GQA: repeat K/V heads to match Q head count
        if self.n_rep > 1:
            k = k.unsqueeze(2).expand(-1, -1, self.n_rep, -1, -1).reshape(B, self.n_heads, S, self.head_dim)
            v = v.unsqueeze(2).expand(-1, -1, self.n_rep, -1, -1).reshape(B, self.n_heads, S, self.head_dim)

        # Build causal sliding-window additive mask, optionally combined with padding mask
        sw_mask = self._sliding_window_mask(T, S, x.device).to(x.dtype)
        if decode_attn_mask is not None:
            sw_mask = sw_mask + decode_attn_mask

        attn_out = F.scaled_dot_product_attention(
            q, k, v,
            attn_mask=sw_mask,
            dropout_p=self.dropout.p if self.training else 0.0,
            is_causal=False,   # we supply our own combined causal+window mask
        )

        out = attn_out.transpose(1, 2).contiguous().view(B, T, -1)
        return self.o_proj(out), new_kv_cache


# ── Linear Attention ──────────────────────────────────────────────────────────

class LinearAttention(nn.Module):
    """O(n) causal linear attention using the ELU+1 kernel and cumulative-sum KV trick."""

    def __init__(self, cfg: ProverbsConfig):
        super().__init__()
        self.n_heads    = cfg.n_heads
        self.n_kv_heads = cfg.n_kv_heads
        self.head_dim   = cfg.head_dim
        self.n_rep      = cfg.n_heads // cfg.n_kv_heads

        self.q_proj = nn.Linear(cfg.d_model, cfg.n_heads    * cfg.head_dim, bias=False)
        self.k_proj = nn.Linear(cfg.d_model, cfg.n_kv_heads * cfg.head_dim, bias=False)
        self.v_proj = nn.Linear(cfg.d_model, cfg.n_kv_heads * cfg.head_dim, bias=False)
        self.o_proj = nn.Linear(cfg.n_heads * cfg.head_dim, cfg.d_model,    bias=False)

        self.dropout = nn.Dropout(cfg.dropout)

        angles = _rope_freqs(cfg.head_dim, cfg.max_seq_len, cfg.rope_theta, device=torch.device("cpu"))
        self.register_buffer("rope_cos", angles.cos())  # (max_seq_len, head_dim)
        self.register_buffer("rope_sin", angles.sin())

    def forward(
        self,
        x: torch.Tensor,                               # (B, T, d_model)
        mask: torch.Tensor | None = None,              # unused — linear attn is always causal
        kv_cache: tuple | None = None,                 # (kv_state, z_state) for generation
        decode_attn_mask: torch.Tensor | None = None,  # unused — linear attn has no softmax
        position_ids: torch.Tensor | None = None,      # unused — state carries no positions
    ) -> tuple:
        B, T, _ = x.shape

        Q = self.q_proj(x).view(B, T, self.n_heads,    self.head_dim).transpose(1, 2)
        K = self.k_proj(x).view(B, T, self.n_kv_heads, self.head_dim).transpose(1, 2)
        V = self.v_proj(x).view(B, T, self.n_kv_heads, self.head_dim).transpose(1, 2)

        # Apply RoPE
        cos = self.rope_cos[:T].to(x.device)
        sin = self.rope_sin[:T].to(x.device)
        Q, K = apply_rope(Q, K, cos, sin)

        # GQA: repeat K/V heads to match Q head count
        if self.n_rep > 1:
            K = K.unsqueeze(2).expand(-1, -1, self.n_rep, -1, -1).reshape(B, self.n_heads, T, self.head_dim)
            V = V.unsqueeze(2).expand(-1, -1, self.n_rep, -1, -1).reshape(B, self.n_heads, T, self.head_dim)

        # ELU+1 feature map — positive, ensures kernel is non-negative
        phi = lambda t: F.elu(t) + 1
        phi_Q = phi(Q)  # (B, n_heads, T, head_dim)
        phi_K = phi(K)  # (B, n_heads, T, head_dim)

        if kv_cache is not None:
            # Autoregressive step: T==1; restore cumulative state from cache
            kv_state, z_state = kv_cache   # (B, H, D, E), (B, H, D, 1)
            # kv_state: outer product accumulator; z_state: normalizer accumulator
            new_kv = torch.einsum("bhd,bhe->bhde", phi_K[:, :, 0], V[:, :, 0])
            kv_state = kv_state + new_kv
            new_z    = phi_K[:, :, 0].sum(dim=-1, keepdim=True).clamp(min=1e-6)
            z_state  = z_state + new_z
            out = torch.einsum("bhd,bhde->bhe", phi_Q[:, :, 0], kv_state) / z_state
            out = out.unsqueeze(2)   # (B, H, 1, E)
            new_kv_cache = (kv_state, z_state)
        else:
            # Training / prefill: use cumulative-sum trick for O(n) causal attention
            # KV accumulator: (B, H, T, head_dim_k, head_dim_v)
            KV = torch.einsum("bhnd,bhne->bhnde", phi_K, V).cumsum(dim=2)
            # Normalizer: (B, H, T, 1)
            Z  = phi_K.cumsum(dim=2).sum(dim=-1, keepdim=True).clamp(min=1e-6)
            # Attend: (B, H, T, head_dim_v)
            out = torch.einsum("bhnd,bhnde->bhne", phi_Q, KV) / Z
            # Store final cumulative state for potential future cache use
            new_kv_cache = (KV[:, :, -1], Z[:, :, -1])

        # Merge heads and project
        out_flat = out.transpose(1, 2).contiguous().view(B, T, -1)
        return self.o_proj(out_flat), new_kv_cache
