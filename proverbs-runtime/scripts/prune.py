"""
prune.py — Magnitude-based weight pruning for ProverbsLM.

Removes the lowest-magnitude weights to produce a sparser (and after
re-saving, smaller) model, then optionally fine-tunes for a few steps to
recover the quality lost to pruning.

Usage:
    python -m scripts.prune --checkpoint ~/.proverbs/checkpoints/best.pt \\
                             --sparsity 0.25 --steps 500 --output pruned.pt

Sparsity 0.25 means 25% of individual weights are zeroed out.
Recommended range: 0.10–0.35 for coding models.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import torch
import torch.nn as nn
import torch.nn.utils.prune as prune

from model.proverbs_lm import ProverbsLM
from model.config import ProverbsConfig


# ── Helpers ────────────────────────────────────────────────────────────────────

def count_params(model: nn.Module) -> tuple[int, int]:
    """Return (total_params, nonzero_params)."""
    total = sum(p.numel() for p in model.parameters())
    nonzero = sum(int((p != 0).sum().item()) for p in model.parameters())
    return total, nonzero


def apply_magnitude_pruning(model: nn.Module, sparsity: float) -> list:
    """
    Apply global unstructured L1 magnitude pruning across all Linear layers.
    Returns the list of (module, 'weight') pairs that were pruned.
    """
    params_to_prune = [
        (module, "weight")
        for module in model.modules()
        if isinstance(module, nn.Linear)
    ]
    prune.global_unstructured(
        params_to_prune,
        pruning_method=prune.L1Unstructured,
        amount=sparsity,
    )
    return params_to_prune


def remove_pruning_hooks(params_to_prune: list) -> None:
    """Make the pruning permanent by removing the mask buffers."""
    for module, name in params_to_prune:
        try:
            prune.remove(module, name)
        except ValueError:
            pass


def fine_tune(
    model: nn.Module,
    checkpoint: dict,
    steps: int,
    lr: float = 2e-5,
    device: str = "cpu",
) -> None:
    """
    Fine-tune the pruned model for `steps` gradient steps on its own saved
    session data (quality_sessions), or skip if none exist.
    """
    import os
    import json
    import random

    quality_dir = Path(os.path.expanduser("~/.proverbs/quality_sessions"))
    files = sorted(quality_dir.glob("*.jsonl")) if quality_dir.exists() else []
    if not files:
        print("  No quality_sessions data — skipping fine-tune step.")
        return

    from tokenizer.bpe import ProverbsTokenizer
    tok_path = Path(os.path.expanduser("~/.proverbs/tokenizer.json"))
    if not tok_path.exists():
        print("  Tokenizer not found — skipping fine-tune step.")
        return

    tokenizer = ProverbsTokenizer.load(str(tok_path))
    cfg = model.cfg

    texts = []
    for f in files:
        for line in f.read_text(errors="replace").splitlines():
            try:
                obj = json.loads(line)
                msgs = obj.get("messages", [])
                text = " ".join(m.get("content", "") for m in msgs if m.get("role") != "system")
                if text.strip():
                    texts.append(text)
            except Exception:
                pass

    if not texts:
        print("  No usable fine-tune examples — skipping.")
        return

    random.shuffle(texts)
    model.train()
    optimizer = torch.optim.AdamW(
        [p for p in model.parameters() if p.requires_grad],
        lr=lr,
    )

    print(f"  Fine-tuning for {steps} steps on {len(texts)} examples …")
    step = 0
    losses = []
    while step < steps:
        for text in texts:
            if step >= steps:
                break
            ids = tokenizer.encode(text, add_bos=True)[:cfg.max_seq_len]
            if len(ids) < 4:
                continue
            inp = torch.tensor([ids[:-1]], dtype=torch.long, device=device)
            tgt = torch.tensor([ids[1:]], dtype=torch.long, device=device)
            out = model(inp, labels=tgt)
            loss = out["loss"]
            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            losses.append(loss.item())
            step += 1
            if step % 100 == 0:
                avg = sum(losses[-100:]) / min(len(losses), 100)
                print(f"    step {step}/{steps}  loss={avg:.4f}")

    model.eval()
    print("  Fine-tune complete.")


# ── Main ───────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(
        prog="prune",
        description="Magnitude-prune a ProverbsLM checkpoint.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--checkpoint", type=Path,
                   default=Path("~/.proverbs/checkpoints/local/best.pt").expanduser(),
                   help="Path to .pt model checkpoint.")
    p.add_argument("--sparsity", type=float, default=0.25,
                   help="Fraction of weights to zero out (0.0–0.9).")
    p.add_argument("--steps", type=int, default=0,
                   help="Fine-tune steps after pruning (0 = skip).")
    p.add_argument("--output", type=Path, default=None,
                   help="Output path (default: <checkpoint>_pruned.pt).")
    p.add_argument("--device", type=str, default=None,
                   help="Device override (cpu | cuda | mps).")
    args = p.parse_args(argv)

    ckpt = args.checkpoint.expanduser().resolve()
    if not ckpt.exists():
        print(f"ERROR: checkpoint not found: {ckpt}", file=sys.stderr)
        sys.exit(1)
    if not (0.0 < args.sparsity < 1.0):
        print("ERROR: --sparsity must be in (0, 1)", file=sys.stderr)
        sys.exit(1)

    output = args.output or ckpt.with_name(ckpt.stem + "_pruned.pt")

    print(f"\n=== Proverbs Weight Pruning ===")
    print(f"  Checkpoint : {ckpt}")
    print(f"  Sparsity   : {args.sparsity:.0%}")
    print(f"  Output     : {output}")

    device = args.device or ("mps" if torch.backends.mps.is_available() else
                             "cuda" if torch.cuda.is_available() else "cpu")
    print(f"  Device     : {device}\n")

    print("Loading model …")
    model = ProverbsLM.load(str(ckpt), device=device)
    raw_ckpt = torch.load(str(ckpt), map_location=device, weights_only=False)

    total_before, nonzero_before = count_params(model)
    sparsity_before = 1.0 - nonzero_before / total_before
    print(f"  Before pruning: {total_before/1e6:.1f}M params, {sparsity_before:.1%} already sparse")

    print(f"\nApplying {args.sparsity:.0%} global L1 magnitude pruning …")
    t0 = time.monotonic()
    params_to_prune = apply_magnitude_pruning(model, args.sparsity)
    remove_pruning_hooks(params_to_prune)
    elapsed = time.monotonic() - t0

    total_after, nonzero_after = count_params(model)
    sparsity_after = 1.0 - nonzero_after / total_after
    print(f"  After pruning : {total_after/1e6:.1f}M params, {sparsity_after:.1%} sparse  ({elapsed:.1f}s)")

    if args.steps > 0:
        print(f"\nFine-tuning for {args.steps} steps …")
        fine_tune(model, raw_ckpt, steps=args.steps, device=device)

    print(f"\nSaving → {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    model.save(str(output))
    size_mb = output.stat().st_size / 1e6
    print(f"  Saved ({size_mb:.1f} MB)")
    print("\nDone.")


if __name__ == "__main__":
    main()
