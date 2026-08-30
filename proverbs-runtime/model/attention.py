"""
Multi-head attention with Rotary Position Embeddings (RoPE).

Supports Grouped Query Attention (GQA): set n_kv_heads < n_heads in config
to share key/value heads across multiple query heads — reduces VRAM during
inference with no quality loss.
"""

import math
import torch
import torch.nn as nn
import torch.nn.functional as F
from .config import ProverbsConfig


# ── RoPE ─────────────────────────────────────────────────────────────────────

def _rope_freqs(head_dim: int, max_seq_len: int, theta: float, device: torch.device) -> torch.Tensor:
    """Precompute cos/sin rotation matrices for RoPE — shape (max_seq_len, head_dim)."""
    positions = torch.arange(max_seq_len, device=device).float()
    dims = torch.arange(0, head_dim, 2, device=device).float()
    inv_freq = 1.0 / (theta ** (dims / head_dim))
    angles = torch.outer(positions, inv_freq)          # (seq, head_dim/2)
    return torch.cat([angles, angles], dim=-1)          # (seq, head_dim)


def _rotate_half(x: torch.Tensor) -> torch.Tensor:
    """Rotate the second half of the last dimension."""
    half = x.shape[-1] // 2
    x1, x2 = x[..., :half], x[..., half:]
    return torch.cat([-x2, x1], dim=-1)


def apply_rope(q: torch.Tensor, k: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor) -> tuple:
    """Apply RoPE to query and key tensors."""
    if cos.dim() == 2:
        cos = cos.unsqueeze(0).unsqueeze(0)  # (1, 1, seq, head_dim)
        sin = sin.unsqueeze(0).unsqueeze(0)
    else:
        cos = cos.unsqueeze(1)  # (B, 1, seq, head_dim) — per-sequence positions
        sin = sin.unsqueeze(1)
    q_rot = q * cos + _rotate_half(q) * sin
    k_rot = k * cos + _rotate_half(k) * sin
    return q_rot, k_rot


# ── Attention ─────────────────────────────────────────────────────────────────

class MultiHeadAttention(nn.Module):
    def __init__(self, cfg: ProverbsConfig):
        super().__init__()
        self.n_heads    = cfg.n_heads
        self.n_kv_heads = cfg.n_kv_heads
        self.head_dim   = cfg.head_dim
        self.n_rep      = cfg.n_heads // cfg.n_kv_heads  # repeat factor for GQA

        self.q_proj = nn.Linear(cfg.d_model, cfg.n_heads    * cfg.head_dim, bias=False)
        self.k_proj = nn.Linear(cfg.d_model, cfg.n_kv_heads * cfg.head_dim, bias=False)
        self.v_proj = nn.Linear(cfg.d_model, cfg.n_kv_heads * cfg.head_dim, bias=False)
        self.o_proj = nn.Linear(cfg.n_heads * cfg.head_dim, cfg.d_model,    bias=False)

        self.dropout = nn.Dropout(cfg.dropout)
        self.scale   = math.sqrt(cfg.head_dim)

        # Precomputed RoPE tables — registered as buffers (not parameters)
        angles = _rope_freqs(cfg.head_dim, cfg.max_seq_len, cfg.rope_theta, device=torch.device("cpu"))
        self.register_buffer("rope_cos", angles.cos())  # (max_seq_len, head_dim)
        self.register_buffer("rope_sin", angles.sin())

    def forward(
        self,
        x: torch.Tensor,                               # (B, T, d_model)
        mask: torch.Tensor | None = None,              # (1, 1, T, T) causal mask
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
        # position_ids overrides this for batched decode, where right-padded
        # caches give each sequence a different true position.
        past_len = kv_cache[0].shape[2] if kv_cache is not None else 0
        if position_ids is not None:
            cos = self.rope_cos[position_ids].to(x.device)  # (B, T, head_dim)
            sin = self.rope_sin[position_ids].to(x.device)
        else:
            cos = self.rope_cos[past_len:past_len + T].to(x.device)
            sin = self.rope_sin[past_len:past_len + T].to(x.device)
        q, k = apply_rope(q, k, cos, sin)

        # KV cache append (used during autoregressive generation)
        if kv_cache is not None:
            k_cache, v_cache = kv_cache
            k = torch.cat([k_cache, k], dim=2)
            v = torch.cat([v_cache, v], dim=2)
        new_kv_cache = (k, v)

        # GQA: repeat K/V heads to match Q head count
        if self.n_rep > 1:
            k = k.unsqueeze(2).expand(-1, -1, self.n_rep, -1, -1).reshape(B, self.n_heads, -1, self.head_dim)
            v = v.unsqueeze(2).expand(-1, -1, self.n_rep, -1, -1).reshape(B, self.n_heads, -1, self.head_dim)

        # Scaled dot-product attention — use flash attention when available.
        # decode_attn_mask is provided during batched decode to mask padding across slots.
        if hasattr(F, "scaled_dot_product_attention"):
            if decode_attn_mask is not None:
                attn_out = F.scaled_dot_product_attention(
                    q, k, v,
                    attn_mask=decode_attn_mask,
                    dropout_p=self.dropout.p if self.training else 0.0,
                    is_causal=False,
                )
            elif kv_cache is not None and T > 1:
                # Multi-token step on top of a cache (e.g. speculative-decode
                # verification). is_causal can't express the position offset
                # (SDPA aligns its causal mask top-left), so build a boolean
                # mask aligned to the tokens' absolute positions.
                S = k.shape[2]
                q_pos = torch.arange(past_len, past_len + T, device=x.device)
                k_pos = torch.arange(S, device=x.device)
                causal_mask = k_pos.unsqueeze(0) <= q_pos.unsqueeze(1)  # (T, S)
                attn_out = F.scaled_dot_product_attention(
                    q, k, v,
                    attn_mask=causal_mask,
                    dropout_p=self.dropout.p if self.training else 0.0,
                    is_causal=False,
                )
            else:
                attn_out = F.scaled_dot_product_attention(
                    q, k, v,
                    dropout_p=self.dropout.p if self.training else 0.0,
                    is_causal=kv_cache is None,
                )
        else:
            scores = torch.matmul(q, k.transpose(-2, -1)) / self.scale
            effective_mask = decode_attn_mask if decode_attn_mask is not None else mask
            if effective_mask is not None:
                scores = scores + effective_mask
            attn_weights = self.dropout(F.softmax(scores.float(), dim=-1).to(x.dtype))
            attn_out = torch.matmul(attn_weights, v)

        out = attn_out.transpose(1, 2).contiguous().view(B, T, -1)
        return self.o_proj(out), new_kv_cache
