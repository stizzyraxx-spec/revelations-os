"""
model/lora.py — LoRA (Low-Rank Adaptation) for ProverbsLM.

Injects trainable low-rank matrices into attention projections while
keeping the base model weights frozen.
"""

from __future__ import annotations

import sys
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from model.proverbs_lm import ProverbsLM  # noqa: E402


class LoraLinear(nn.Module):
    def __init__(self, linear: nn.Linear, rank: int = 8, alpha: float = 16):
        super().__init__()
        out_features, in_features = linear.weight.shape

        # Frozen copy of original weights
        self.weight = nn.Parameter(linear.weight.data.clone(), requires_grad=False)
        if linear.bias is not None:
            self.bias = nn.Parameter(linear.bias.data.clone(), requires_grad=False)
        else:
            self.bias = None

        # Trainable low-rank matrices
        self.lora_A = nn.Linear(in_features, rank, bias=False)
        self.lora_B = nn.Linear(rank, out_features, bias=False)
        self.scaling = alpha / rank

        # lora_A: kaiming_uniform (default for nn.Linear), lora_B: zeros
        nn.init.kaiming_uniform_(self.lora_A.weight, a=5 ** 0.5)
        nn.init.zeros_(self.lora_B.weight)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return F.linear(x, self.weight, self.bias) + self.scaling * self.lora_B(self.lora_A(x))

    def merge(self) -> None:
        """Fuse lora_A @ lora_B.T into weight in-place, then zero out lora params."""
        delta = self.scaling * (self.lora_B.weight @ self.lora_A.weight)
        self.weight.data += delta
        nn.init.zeros_(self.lora_A.weight)
        nn.init.zeros_(self.lora_B.weight)


class LoraModel(nn.Module):
    def __init__(self, base: ProverbsLM):
        super().__init__()
        self.base = base
        self._lora_layers: dict[str, LoraLinear] = {}

    def inject_lora(
        self,
        rank: int = 8,
        alpha: float = 16,
        target_modules: tuple[str, ...] = ("q_proj", "k_proj", "v_proj", "o_proj"),
    ) -> None:
        # Freeze all base parameters
        for param in self.base.parameters():
            param.requires_grad = False

        # Replace matching nn.Linear in each TransformerBlock's .attn with LoraLinear
        for layer_idx, block in enumerate(self.base.layers):
            attn = block.attn
            for name in target_modules:
                if not hasattr(attn, name):
                    continue
                original = getattr(attn, name)
                if not isinstance(original, nn.Linear):
                    continue
                lora_layer = LoraLinear(original, rank=rank, alpha=alpha)
                setattr(attn, name, lora_layer)
                key = f"layers.{layer_idx}.attn.{name}"
                self._lora_layers[key] = lora_layer

    def forward(self, *args, **kwargs):
        return self.base(*args, **kwargs)

    def lora_parameters(self):
        for layer in self._lora_layers.values():
            yield from layer.lora_A.parameters()
            yield from layer.lora_B.parameters()

    def save_adapter(self, path: str | Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        # Infer rank/alpha from first lora layer
        first = next(iter(self._lora_layers.values()))
        rank = first.lora_A.out_features
        alpha = first.scaling * rank
        lora_state = {k: v for k, v in self.state_dict().items() if "lora_" in k}
        torch.save({"rank": rank, "alpha": alpha, "state": lora_state}, path)

    def load_adapter(self, path: str | Path) -> None:
        path = Path(path)
        payload = torch.load(path, map_location="cpu", weights_only=False)
        self.load_state_dict(payload["state"], strict=False)

    def merge_and_unload(self) -> ProverbsLM:
        for layer in self._lora_layers.values():
            layer.merge()
        return self.base
