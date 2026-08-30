"""
train_embedder.py — Train the ProverbsEmbedder head with SimCSE.

Uses a simple contrastive self-supervised objective: each code chunk is its
own positive pair (two different random crops), and all other chunks in the
batch are negatives.  Only the EmbeddingHead (projection + norm) is trained;
the transformer backbone stays frozen.

Requires a trained LM checkpoint and tokenizer.

Usage:
    python -m scripts.train_embedder \\
        --checkpoint ~/.proverbs/checkpoints/local/best.pt \\
        --tokenizer  ~/.proverbs/tokenizer.json \\
        --data-dir   ~/path/to/code \\
        --output     ~/.proverbs/embed_head.pt \\
        --epochs     3
"""

from __future__ import annotations

import argparse
import os
import random
import sys
import time
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import numpy as np
import torch
import torch.nn.functional as F

from model.proverbs_lm import ProverbsLM
from model.embeddings import ProverbsEmbedder
from tokenizer.bpe import ProverbsTokenizer


# ── Data helpers ───────────────────────────────────────────────────────────────

_CODE_EXTS = {".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".c", ".cpp",
              ".java", ".rb", ".sh", ".md"}
_SKIP_DIRS = {"node_modules", ".git", "__pycache__", ".venv", "venv", "venv_llm",
              "dist", "build", ".next", "target"}


def collect_chunks(data_dir: Path, min_len: int = 64, max_len: int = 512) -> list[str]:
    """Walk data_dir and collect non-trivial code/text snippets."""
    chunks = []
    for root, dirs, files in os.walk(data_dir):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS and not d.startswith(".")]
        for fname in files:
            fpath = Path(root) / fname
            if fpath.suffix.lower() not in _CODE_EXTS:
                continue
            try:
                text = fpath.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            lines = text.splitlines()
            # Sliding window of ~20 lines per chunk
            for i in range(0, len(lines), 10):
                chunk = "\n".join(lines[i : i + 20]).strip()
                if min_len <= len(chunk) <= max_len:
                    chunks.append(chunk)
    return chunks


def random_crop(text: str, max_len: int = 400) -> str:
    """Return a random sub-sequence of text (SimCSE augmentation)."""
    if len(text) <= max_len:
        return text
    start = random.randint(0, len(text) - max_len)
    return text[start : start + max_len]


# ── SimCSE loss ────────────────────────────────────────────────────────────────

def simcse_loss(embeddings_a: torch.Tensor, embeddings_b: torch.Tensor, temp: float = 0.05) -> torch.Tensor:
    """
    In-batch negatives contrastive loss.
    embeddings_a, embeddings_b: [B, D] L2-normalized
    """
    B = embeddings_a.shape[0]
    # Similarity matrix [B, B]
    sim = torch.mm(embeddings_a, embeddings_b.T) / temp
    labels = torch.arange(B, device=embeddings_a.device)
    # Symmetric loss
    loss_a = F.cross_entropy(sim, labels)
    loss_b = F.cross_entropy(sim.T, labels)
    return (loss_a + loss_b) / 2.0


# ── Main ───────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(
        prog="train_embedder",
        description="Train ProverbsEmbedder head with SimCSE on local code.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--checkpoint", type=Path,
                   default=Path("~/.proverbs/checkpoints/local/best.pt").expanduser())
    p.add_argument("--tokenizer", type=Path,
                   default=Path("~/.proverbs/tokenizer.json").expanduser())
    p.add_argument("--data-dir", type=Path, default=Path(".").resolve())
    p.add_argument("--output", type=Path,
                   default=Path("~/.proverbs/embed_head.pt").expanduser())
    p.add_argument("--epochs", type=int, default=3)
    p.add_argument("--batch-size", type=int, default=32)
    p.add_argument("--lr", type=float, default=3e-4)
    p.add_argument("--embed-dim", type=int, default=384)
    p.add_argument("--device", type=str, default=None)
    args = p.parse_args(argv)

    ckpt = args.checkpoint.expanduser().resolve()
    tok_path = args.tokenizer.expanduser().resolve()
    data_dir = args.data_dir.expanduser().resolve()
    output = args.output.expanduser().resolve()

    for label, path in [("checkpoint", ckpt), ("tokenizer", tok_path), ("data-dir", data_dir)]:
        if not path.exists():
            print(f"ERROR: --{label} not found: {path}", file=sys.stderr)
            sys.exit(1)

    device = args.device or ("mps" if torch.backends.mps.is_available() else
                             "cuda" if torch.cuda.is_available() else "cpu")

    print(f"\n=== ProverbsEmbedder Training (SimCSE) ===")
    print(f"  Data dir   : {data_dir}")
    print(f"  Output     : {output}")
    print(f"  Device     : {device}\n")

    print("Loading model and tokenizer …")
    lm = ProverbsLM.load(str(ckpt), device=device)
    tokenizer = ProverbsTokenizer.load(str(tok_path))
    embedder = ProverbsEmbedder(lm, embed_dim=args.embed_dim, device=device)

    print("Collecting code chunks …")
    chunks = collect_chunks(data_dir)
    if len(chunks) < args.batch_size * 2:
        print(f"  Only {len(chunks)} chunks — need at least {args.batch_size * 2}. "
              "Try a larger --data-dir.", file=sys.stderr)
        sys.exit(1)
    print(f"  {len(chunks):,} chunks collected.")

    optimizer = torch.optim.AdamW(embedder.head.parameters(), lr=args.lr)
    embedder.head.train()

    for epoch in range(1, args.epochs + 1):
        random.shuffle(chunks)
        epoch_loss = 0.0
        batches = 0
        t0 = time.monotonic()

        for i in range(0, len(chunks) - args.batch_size, args.batch_size):
            batch = chunks[i : i + args.batch_size]

            # Two random crops of each chunk = positive pair
            crops_a = [random_crop(c) for c in batch]
            crops_b = [random_crop(c) for c in batch]

            # Encode both crops through the frozen backbone + trainable head
            # We need gradients through the head but not the backbone.
            encoded_a = _encode_with_grad(embedder, crops_a, tokenizer, device)
            encoded_b = _encode_with_grad(embedder, crops_b, tokenizer, device)

            loss = simcse_loss(encoded_a, encoded_b)
            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(embedder.head.parameters(), 1.0)
            optimizer.step()

            epoch_loss += loss.item()
            batches += 1

        elapsed = time.monotonic() - t0
        avg = epoch_loss / max(batches, 1)
        print(f"  Epoch {epoch}/{args.epochs}  loss={avg:.4f}  ({elapsed:.0f}s)")

    print(f"\nSaving embedding head → {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    embedder.save(str(output))
    print("Done.")


def _encode_with_grad(embedder: ProverbsEmbedder, texts: list[str],
                      tokenizer, device: str) -> torch.Tensor:
    """Encode texts, keeping gradients through the head only."""
    dtype = next(embedder.token_embed.parameters()).dtype
    max_len = 256

    encoded = [tokenizer.encode(t, add_bos=True)[:max_len] for t in texts]
    max_l = max(len(ids) for ids in encoded)
    padded = [ids + [0] * (max_l - len(ids)) for ids in encoded]
    masks = [[1] * len(ids) + [0] * (max_l - len(ids)) for ids in encoded]

    input_ids = torch.tensor(padded, dtype=torch.long, device=device)
    attn_mask = torch.tensor(masks, dtype=torch.float, device=device)

    # Frozen backbone pass — no gradients needed
    with torch.no_grad():
        x = embedder.token_embed(input_ids).to(dtype)
        for layer in embedder.layers:
            x, _, _ = layer(x, mask=None, kv_cache=None)
        x = embedder.backbone_norm(x)

    # Trainable head — gradients flow here
    emb = embedder.head(x, attn_mask)
    return emb


if __name__ == "__main__":
    main()
