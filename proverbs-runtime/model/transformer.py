"""
Transformer building blocks for ProverbsLM.

Uses modern design choices:
  - RMSNorm  (faster than LayerNorm, no mean subtraction)
  - SwiGLU   (gated activation — better than GELU for language models)
  - Pre-norm  (norm before attention/FFN, more stable training)
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
from .config import ProverbsConfig
from .attention import MultiHeadAttention


# ── RMSNorm ───────────────────────────────────────────────────────────────────

class RMSNorm(nn.Module):
    def __init__(self, dim: int, eps: float = 1e-6):
        super().__init__()
        self.eps   = eps
        self.scale = nn.Parameter(torch.ones(dim))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        rms = x.float().pow(2).mean(-1, keepdim=True).add(self.eps).sqrt()
        return (x.float() / rms * self.scale).to(x.dtype)


# ── SwiGLU Feed-Forward ───────────────────────────────────────────────────────

class SwiGLU(nn.Module):
    """
    SwiGLU FFN: out = (xW_gate * swish(xW_up)) @ W_down
    Two input projections (gate + up), one output projection (down).
    """
    def __init__(self, cfg: ProverbsConfig):
        super().__init__()
        self.gate = nn.Linear(cfg.d_model, cfg.d_ff, bias=False)
        self.up   = nn.Linear(cfg.d_model, cfg.d_ff, bias=False)
        self.down = nn.Linear(cfg.d_ff,    cfg.d_model, bias=False)
        self.drop = nn.Dropout(cfg.dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.drop(self.down(F.silu(self.gate(x)) * self.up(x)))


# ── Transformer Block ─────────────────────────────────────────────────────────

class TransformerBlock(nn.Module):
    def __init__(self, cfg: ProverbsConfig):
        super().__init__()
        if cfg.attention_type == "sliding_window":
            from model.sparse_attention import SlidingWindowAttention
            self.attn = SlidingWindowAttention(cfg)
        elif cfg.attention_type == "linear":
            from model.sparse_attention import LinearAttention
            self.attn = LinearAttention(cfg)
        else:
            self.attn = MultiHeadAttention(cfg)
        self.norm_attn = RMSNorm(cfg.d_model)
        self.norm_ffn  = RMSNorm(cfg.d_model)
        if cfg.use_moe:
            from model.moe import MoEFFN, MoEConfig
            moe_cfg    = MoEConfig(n_experts=cfg.moe_n_experts, n_experts_per_token=cfg.moe_top_k)
            self.ffn   = MoEFFN(cfg, moe_cfg)
            self._use_moe = True
        else:
            self.ffn   = SwiGLU(cfg)
            self._use_moe = False

    def forward(
        self,
        x: torch.Tensor,
        mask: torch.Tensor | None = None,
        kv_cache: tuple | None = None,
        decode_attn_mask: torch.Tensor | None = None,
        position_ids: torch.Tensor | None = None,
    ) -> tuple:
        # Pre-norm attention with residual
        attn_out, new_kv = self.attn(self.norm_attn(x), mask=mask, kv_cache=kv_cache,
                                     decode_attn_mask=decode_attn_mask, position_ids=position_ids)
        x = x + attn_out

        # Pre-norm FFN with residual
        normed  = self.norm_ffn(x)
        ffn_out = self.ffn(normed)
        if self._use_moe and isinstance(ffn_out, tuple):
            ffn_out, aux_loss = ffn_out
        else:
            aux_loss = (
                self.ffn.auxiliary_loss(self.ffn.gate(normed.view(-1, normed.shape[-1])))
                if self._use_moe else None
            )
        x = x + ffn_out

        return x, new_kv, aux_loss


# ── Causal Mask ───────────────────────────────────────────────────────────────

def make_causal_mask(seq_len: int, device: torch.device, dtype: torch.dtype) -> torch.Tensor:
    """Upper-triangular mask filled with -inf, shape (1, 1, T, T)."""
    mask = torch.full((seq_len, seq_len), float("-inf"), device=device, dtype=dtype)
    return torch.triu(mask, diagonal=1).unsqueeze(0).unsqueeze(0)
