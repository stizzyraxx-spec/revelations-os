"""
ProverbsLM — the full language model.

Architecture:
  token_embed → [TransformerBlock x N] → RMSNorm → lm_head (→ logits)

The model is hardware-agnostic: call .to_device() to place it on
cuda / mps / cpu automatically.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
from pathlib import Path

from .config import ProverbsConfig
from .transformer import TransformerBlock, RMSNorm, make_causal_mask


class ProverbsLM(nn.Module):
    def __init__(self, cfg: ProverbsConfig):
        super().__init__()
        self.cfg = cfg

        self.token_embed = nn.Embedding(cfg.vocab_size, cfg.d_model, padding_idx=cfg.pad_token_id)
        self.drop        = nn.Dropout(cfg.dropout)
        self.layers      = nn.ModuleList([TransformerBlock(cfg) for _ in range(cfg.n_layers)])
        self.norm        = RMSNorm(cfg.d_model)
        self.lm_head     = nn.Linear(cfg.d_model, cfg.vocab_size, bias=False)

        # Tie embedding weights to lm_head (halves params, standard practice)
        self.lm_head.weight = self.token_embed.weight

        if cfg.use_multi_token:
            try:
                from model.multi_token import MultiTokenHead
                self.extra_heads = MultiTokenHead(cfg.d_model, cfg.vocab_size, cfg.n_future_tokens)
            except ImportError:
                self.extra_heads = None
        else:
            self.extra_heads = None

        self._init_weights()

    def _init_weights(self):
        for module in self.modules():
            if isinstance(module, nn.Linear):
                nn.init.normal_(module.weight, mean=0.0, std=0.02)
                if module.bias is not None:
                    nn.init.zeros_(module.bias)
            elif isinstance(module, nn.Embedding):
                nn.init.normal_(module.weight, mean=0.0, std=0.02)

    def forward(
        self,
        input_ids: torch.Tensor,                       # (B, T)
        labels: torch.Tensor | None = None,            # (B, T) for training
        kv_caches: list | None = None,                 # list of (k, v) per layer
        decode_attn_mask: torch.Tensor | None = None,  # (B, 1, 1, S) for batched decode
        position_ids: torch.Tensor | None = None,      # (B, T) absolute positions
    ) -> dict:
        cfg = self.cfg
        B, T = input_ids.shape
        device, dtype = input_ids.device, self.token_embed.weight.dtype

        x = self.drop(self.token_embed(input_ids).to(dtype))

        # The explicit T×T causal mask is only consumed by the manual-attention
        # fallback; SDPA handles causality via is_causal, so skip the O(T²)
        # allocation entirely on modern PyTorch.
        need_mask = T > 1 and not hasattr(F, "scaled_dot_product_attention")
        mask = make_causal_mask(T, device, dtype) if need_mask else None

        new_kv_caches = []
        aux_losses    = []
        for i, layer in enumerate(self.layers):
            kv = kv_caches[i] if kv_caches is not None else None
            x, new_kv, aux_loss = layer(x, mask=mask, kv_cache=kv, decode_attn_mask=decode_attn_mask,
                                        position_ids=position_ids)
            new_kv_caches.append(new_kv)
            aux_losses.append(aux_loss)

        x      = self.norm(x)
        logits = self.lm_head(x)  # (B, T, vocab_size)

        result = {"logits": logits, "kv_caches": new_kv_caches}

        if labels is not None:
            # Shift so token i predicts token i+1
            shift_logits = logits[:, :-1, :].contiguous()
            shift_labels = labels[:, 1:].contiguous()
            loss = F.cross_entropy(
                shift_logits.view(-1, cfg.vocab_size),
                shift_labels.view(-1),
                ignore_index=cfg.pad_token_id,
            )
            total_aux = [l for l in aux_losses if l is not None]
            if total_aux:
                loss = loss + sum(total_aux)
            result["loss"] = loss

        if self.extra_heads is not None and labels is not None:
            extra_logits_list = self.extra_heads(x)  # list of [B, T, vocab]
            extra_loss = 0.0
            for i, extra_logits in enumerate(extra_logits_list):
                shift = i + 2  # predict t+2, t+3, etc.
                el = extra_logits[:, :-shift, :].contiguous()
                el_labels = labels[:, shift:].contiguous()
                extra_loss += F.cross_entropy(
                    el.view(-1, cfg.vocab_size),
                    el_labels.view(-1),
                    ignore_index=cfg.pad_token_id,
                )
            result["extra_loss"] = extra_loss / max(len(extra_logits_list), 1)
            if "loss" in result:
                result["loss"] = result["loss"] + 0.3 * result["extra_loss"]

        if self.extra_heads is not None and labels is None:
            result["extra_logits"] = self.extra_heads(x)

        return result

    # ── Persistence ───────────────────────────────────────────────────────────

    def save(self, path: str | Path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        torch.save({
            "config": self.cfg.__dict__,
            "state_dict": self.state_dict(),
        }, path)

    @classmethod
    def load(cls, path: str | Path, device: str | None = None) -> "ProverbsLM":
        device = device or _best_device()
        checkpoint = torch.load(path, map_location=device, weights_only=False)
        cfg = ProverbsConfig(**checkpoint["config"])
        model = cls(cfg)
        # Support both ProverbsLM.save() format ("state_dict") and
        # ProverbsTrainer.save_checkpoint() format ("model_state_dict")
        state = checkpoint.get("state_dict") or checkpoint.get("model_state_dict")
        if state is None:
            raise KeyError(f"No state_dict found in checkpoint. Keys: {list(checkpoint.keys())}")
        model.load_state_dict(state)
        return model.to(device)

    def to_device(self) -> "ProverbsLM":
        return self.to(_best_device())

    def param_count(self) -> int:
        return sum(p.numel() for p in self.parameters())

    def __repr__(self):
        return (
            f"ProverbsLM("
            f"params={self.param_count()/1e6:.1f}M, "
            f"layers={self.cfg.n_layers}, "
            f"d_model={self.cfg.d_model}, "
            f"heads={self.cfg.n_heads}"
            f")"
        )


def _best_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"
