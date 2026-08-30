"""
INT8 weight quantization for ProverbsLM — in-process, no GGUF.

Per-output-channel scale factors; weights stored as int8, dequantized on-the-fly
at inference. Halves VRAM at ~1% quality loss. Works on CPU and CUDA.
"""

import argparse
import os
import sys
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from model.proverbs_lm import ProverbsLM
from model.config import ProverbsConfig


class Int8Linear(nn.Module):
    def __init__(self, weight: torch.Tensor, bias: torch.Tensor | None):
        super().__init__()
        scale = weight.float().abs().max(dim=1).values / 127.0
        scale = scale.clamp(min=1e-8)
        weight_int8 = (weight.float() / scale.unsqueeze(1)).round().clamp(-127, 127).to(torch.int8)
        self.register_buffer("weight_int8", weight_int8)
        self.register_buffer("scale", scale)
        if bias is not None:
            self.bias = nn.Parameter(bias)
        else:
            self.bias = None

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        w = self.weight_int8.float() * self.scale.unsqueeze(1)
        return F.linear(x, w, self.bias)

    @classmethod
    def from_linear(cls, linear: nn.Linear) -> "Int8Linear":
        return cls(linear.weight.data, linear.bias.data if linear.bias is not None else None)


def quantize_model(
    model: ProverbsLM,
    skip_modules: tuple = ("lm_head", "token_embed"),
) -> ProverbsLM:
    orig_bytes = sum(
        p.numel() * p.element_size() for p in model.parameters()
    ) + sum(
        b.numel() * b.element_size() for b in model.buffers()
    )

    count = 0
    for name, module in list(model.named_modules()):
        if not isinstance(module, nn.Linear):
            continue
        if any(skip in name for skip in skip_modules):
            continue
        parts = name.rsplit(".", 1)
        if len(parts) == 1:
            setattr(model, name, Int8Linear.from_linear(module))
        else:
            parent = model
            for attr in parts[0].split("."):
                parent = getattr(parent, attr)
            setattr(parent, parts[1], Int8Linear.from_linear(module))
        count += 1

    quant_bytes = sum(
        p.numel() * p.element_size() for p in model.parameters()
    ) + sum(
        b.numel() * b.element_size() for b in model.buffers()
    )

    orig_mb = orig_bytes / 1024 ** 2
    quant_mb = quant_bytes / 1024 ** 2
    print(f"Quantized {count} layers | {orig_mb:.1f} MB -> {quant_mb:.1f} MB ({100*quant_mb/orig_mb:.1f}%)")

    return model


def load_quantized(checkpoint_path: str, device: str = None) -> ProverbsLM:
    model = ProverbsLM.load(checkpoint_path, device=device)
    return quantize_model(model)


def save_quantized(model: ProverbsLM, path: str):
    torch.save(
        {
            "config": model.cfg.__dict__,
            "state_dict": model.state_dict(),
            "quantized": True,
        },
        path,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="INT8 quantize a ProverbsLM checkpoint")
    parser.add_argument("--checkpoint", required=True, help="Path to input checkpoint")
    parser.add_argument("--output", required=True, help="Path to save quantized checkpoint")
    parser.add_argument("--device", default=None, help="Device: cuda, mps, cpu (auto-detected if omitted)")
    args = parser.parse_args()

    orig_size_mb = os.path.getsize(args.checkpoint) / 1024 ** 2
    print(f"Loading {args.checkpoint} ({orig_size_mb:.1f} MB on disk) ...")

    model = load_quantized(args.checkpoint, device=args.device)
    save_quantized(model, args.output)

    quant_size_mb = os.path.getsize(args.output) / 1024 ** 2
    print(f"Saved  {args.output} ({quant_size_mb:.1f} MB on disk)")
    print(f"Disk reduction: {orig_size_mb:.1f} MB -> {quant_size_mb:.1f} MB ({100*quant_size_mb/orig_size_mb:.1f}%)")
