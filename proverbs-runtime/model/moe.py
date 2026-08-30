"""
Mixture of Experts FFN layer for ProverbsLM.

MoEFFN is a drop-in replacement for SwiGLU: N expert SwiGLU networks with
learned top-k token routing, sparse compute, and a load-balancing auxiliary loss.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
from dataclasses import dataclass

from .config import ProverbsConfig
from .transformer import SwiGLU, MultiHeadAttention, RMSNorm
from .attention import MultiHeadAttention


# ── MoEConfig ─────────────────────────────────────────────────────────────────

@dataclass
class MoEConfig:
    n_experts: int = 8
    n_experts_per_token: int = 2
    expert_capacity_factor: float = 1.25


# ── MoEFFN ────────────────────────────────────────────────────────────────────

class MoEFFN(nn.Module):
    def __init__(self, cfg: ProverbsConfig, moe_cfg: MoEConfig):
        super().__init__()
        self.experts  = nn.ModuleList([SwiGLU(cfg) for _ in range(moe_cfg.n_experts)])
        self.gate     = nn.Linear(cfg.d_model, moe_cfg.n_experts, bias=False)
        self.moe_cfg  = moe_cfg

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, T, d = x.shape
        x_flat = x.view(B * T, d)                                  # [N, d]
        N = x_flat.shape[0]

        gate_logits = self.gate(x_flat)                             # [N, n_experts]
        gate_probs  = F.softmax(gate_logits, dim=-1)               # [N, n_experts]

        top_k_weights, top_k_indices = torch.topk(
            gate_probs, k=self.moe_cfg.n_experts_per_token, dim=-1
        )                                                           # [N, k]

        # Normalize so weights sum to 1 per token
        top_k_weights = top_k_weights / top_k_weights.sum(dim=-1, keepdim=True)

        output = torch.zeros_like(x_flat)                          # [N, d]

        for e in range(self.moe_cfg.n_experts):
            # Tokens that have expert e in their top-k selection
            routed = (top_k_indices == e).any(dim=-1)              # [N] bool
            if not routed.any():
                continue

            x_e = x_flat[routed]                                   # [M, d]

            # Which slot in top_k_indices holds expert e for each routed token
            slot        = (top_k_indices[routed] == e).nonzero()[:, 1]  # [M]
            expert_w    = top_k_weights[routed][torch.arange(x_e.shape[0], device=x.device), slot]  # [M]

            output[routed] += expert_w.unsqueeze(-1) * self.experts[e](x_e)

        return output.view(B, T, d)

    def auxiliary_loss(self, gate_logits: torch.Tensor) -> torch.Tensor:
        # gate_logits: [N, n_experts]
        n_experts   = self.moe_cfg.n_experts
        k           = self.moe_cfg.n_experts_per_token

        gate_probs  = F.softmax(gate_logits, dim=-1)               # [N, n_experts]

        # f_i: fraction of tokens whose top-k includes expert i
        top_k_idx   = torch.topk(gate_probs, k=k, dim=-1).indices  # [N, k]
        onehot      = F.one_hot(top_k_idx, num_classes=n_experts).float()  # [N, k, E]
        token_routed = onehot.any(dim=1).float()                   # [N, E]
        f_i         = token_routed.mean(dim=0)                     # [E]

        # P_i: mean gate probability for expert i
        P_i         = gate_probs.mean(dim=0)                       # [E]

        aux_loss    = n_experts * (f_i * P_i).sum()
        return aux_loss * 0.01


# ── MoETransformerBlock ───────────────────────────────────────────────────────

class MoETransformerBlock(nn.Module):
    def __init__(self, cfg: ProverbsConfig, moe_cfg: MoEConfig):
        super().__init__()
        self.attn      = MultiHeadAttention(cfg)
        self.ffn       = MoEFFN(cfg, moe_cfg)
        self.norm_attn = RMSNorm(cfg.d_model)
        self.norm_ffn  = RMSNorm(cfg.d_model)

    def forward(
        self,
        x: torch.Tensor,
        mask: torch.Tensor | None = None,
        kv_cache: tuple | None = None,
    ) -> tuple:
        attn_out, new_kv = self.attn(self.norm_attn(x), mask=mask, kv_cache=kv_cache)
        x = x + attn_out

        normed      = self.norm_ffn(x)
        gate_logits = self.ffn.gate(normed.view(-1, normed.shape[-1]))
        ffn_out     = self.ffn(normed)
        aux_loss    = self.ffn.auxiliary_loss(gate_logits)

        x = x + ffn_out
        return x, new_kv, aux_loss


# ── upgrade_to_moe ────────────────────────────────────────────────────────────

def upgrade_to_moe(model, moe_cfg: MoEConfig):
    """Replace every TransformerBlock.ffn (SwiGLU) with MoEFFN in-place."""
    from .transformer import TransformerBlock

    for i, layer in enumerate(model.layers):
        if not isinstance(layer, TransformerBlock):
            continue

        original_ffn = layer.ffn
        moe_ffn      = MoEFFN(model.cfg, moe_cfg)

        # Copy original SwiGLU weights into expert[0]; rest are randomly initialized
        with torch.no_grad():
            moe_ffn.experts[0].gate.weight.copy_(original_ffn.gate.weight)
            moe_ffn.experts[0].up.weight.copy_(original_ffn.up.weight)
            moe_ffn.experts[0].down.weight.copy_(original_ffn.down.weight)

        moe_block           = MoETransformerBlock(model.cfg, moe_cfg)
        moe_block.attn      = layer.attn
        moe_block.norm_attn = layer.norm_attn
        moe_block.norm_ffn  = layer.norm_ffn
        moe_block.ffn       = moe_ffn

        model.layers[i] = moe_block

    return model
