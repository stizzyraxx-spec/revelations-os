"""
Export ProverbsLM checkpoint to GGUF format for llama.cpp.

Usage:
    python scripts/export_gguf.py --checkpoint ~/.proverbs/checkpoints/best.pt
    python scripts/export_gguf.py --checkpoint best.pt --output model.gguf --quantization Q4_K_M
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    from gguf import GGUFWriter
except ImportError:
    sys.exit("Install: pip install gguf")

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from model.proverbs_lm import ProverbsLM


def export_to_gguf(checkpoint_path: str, output_path: str, quantization: str = "F16") -> None:
    model = ProverbsLM.load(checkpoint_path, device="cpu")
    cfg = model.cfg
    sd = model.state_dict()

    writer = GGUFWriter(output_path, "llama")

    writer.add_name("ProverbsLM")
    writer.add_context_length(cfg.max_seq_len)
    writer.add_embedding_length(cfg.d_model)
    writer.add_feed_forward_length(cfg.d_ff)
    writer.add_block_count(cfg.n_layers)
    writer.add_head_count(cfg.n_heads)
    writer.add_head_count_kv(cfg.n_kv_heads)
    writer.add_rope_freq_base(cfg.rope_theta)
    writer.add_tokenizer_model("bpe")

    def _add(name: str, tensor) -> None:
        writer.add_tensor(name, tensor.float().numpy())

    _add("token_embd.weight", sd["token_embed.weight"])
    _add("output_norm.weight", sd["norm.scale"])

    for i in range(cfg.n_layers):
        _add(f"blk.{i}.attn_norm.weight",   sd[f"layers.{i}.norm_attn.scale"])
        _add(f"blk.{i}.ffn_norm.weight",    sd[f"layers.{i}.norm_ffn.scale"])
        _add(f"blk.{i}.attn_q.weight",      sd[f"layers.{i}.attn.q_proj.weight"])
        _add(f"blk.{i}.attn_k.weight",      sd[f"layers.{i}.attn.k_proj.weight"])
        _add(f"blk.{i}.attn_v.weight",      sd[f"layers.{i}.attn.v_proj.weight"])
        _add(f"blk.{i}.attn_output.weight", sd[f"layers.{i}.attn.o_proj.weight"])
        _add(f"blk.{i}.ffn_gate.weight",    sd[f"layers.{i}.ffn.gate.weight"])
        _add(f"blk.{i}.ffn_up.weight",      sd[f"layers.{i}.ffn.up.weight"])
        _add(f"blk.{i}.ffn_down.weight",    sd[f"layers.{i}.ffn.down.weight"])

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()

    size_mb = Path(output_path).stat().st_size / (1024 * 1024)
    print(f"Exported {output_path} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Export ProverbsLM to GGUF")
    parser.add_argument("--checkpoint", required=True, help="Path to .pt checkpoint")
    parser.add_argument("--output", default="proverbs.gguf", help="Output .gguf path")
    parser.add_argument(
        "--quantization",
        default="F16",
        choices=["F16", "Q8_0", "Q4_K_M"],
        help="Quantization type (note: actual quantization requires llama.cpp quantize tool)",
    )
    args = parser.parse_args()
    export_to_gguf(args.checkpoint, args.output, args.quantization)
