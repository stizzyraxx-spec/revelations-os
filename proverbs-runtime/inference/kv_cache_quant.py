"""
INT8 KV cache quantization — halves memory for long-context inference by storing
k/v tensors as int8 with a per-tensor scale, dequantizing back to float16 before
attention computation.
"""

from __future__ import annotations

import torch


def quantize_kv(kv_caches: list) -> list:
    out = []
    for kv in kv_caches:
        if kv is None:
            out.append(None)
            continue
        k, v = kv
        scale_k = k.abs().max().clamp(min=1e-8) / 127.0
        scale_v = v.abs().max().clamp(min=1e-8) / 127.0
        k_int8 = (k / scale_k).round().clamp(-127, 127).to(torch.int8)
        v_int8 = (v / scale_v).round().clamp(-127, 127).to(torch.int8)
        out.append((k_int8, scale_k, v_int8, scale_v))
    return out


def dequantize_kv(quant_caches: list) -> list:
    out = []
    for entry in quant_caches:
        if entry is None:
            out.append(None)
            continue
        k_int8, scale_k, v_int8, scale_v = entry
        k = k_int8.to(torch.float16) * scale_k
        v = v_int8.to(torch.float16) * scale_v
        out.append((k, v))
    return out


def is_quantized(kv_caches: list) -> bool:
    for entry in kv_caches:
        if entry is None:
            continue
        return len(entry) == 4
    return False


class QuantizedKVCache:
    def __init__(self, enabled: bool = True) -> None:
        self.enabled = enabled

    def wrap(self, kv_caches: list) -> list:
        if self.enabled:
            return quantize_kv(kv_caches)
        return kv_caches

    def unwrap(self, kv_caches: list) -> list:
        if self.enabled:
            return dequantize_kv(kv_caches)
        return kv_caches
