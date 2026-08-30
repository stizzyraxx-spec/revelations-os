"""
training/contrastive_trainer.py — SimCSE contrastive training for ProverbsEmbedder.

Trains only the EmbeddingHead (projection + LayerNorm) while the ProverbsLM
backbone remains frozen. Each text is encoded twice through the same embedder
in train mode so dropout produces two distinct views; SimCSE loss maximises
self-similarity on the diagonal and pushes other batch items apart.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import List

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

# ---------------------------------------------------------------------------
# Project root on sys.path
# ---------------------------------------------------------------------------
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from model.embeddings import EmbeddingHead, ProverbsEmbedder, load_embedder  # noqa: E402
from model.proverbs_lm import ProverbsLM                                      # noqa: E402

# ---------------------------------------------------------------------------
# Optional tqdm
# ---------------------------------------------------------------------------
try:
    from tqdm import tqdm as _tqdm
    _HAS_TQDM = True
except ImportError:
    _HAS_TQDM = False


def _best_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


# ---------------------------------------------------------------------------
# ContrastiveDataset
# ---------------------------------------------------------------------------

class ContrastiveDataset(Dataset):
    """
    Loads plain texts from JSONL files in *data_dir*.

    Each line must be a JSON object with a ``"text"`` key (or a bare JSON
    string). Texts shorter than 20 characters or longer than 500 characters
    are discarded. Texts are tokenized and padded / truncated to *max_len*
    tokens at __getitem__ time.
    """

    MIN_CHARS: int = 20
    MAX_CHARS: int = 500

    def __init__(self, data_dir: str, tokenizer, max_len: int = 256) -> None:
        self.tokenizer = tokenizer
        self.max_len = max_len
        self.texts: List[str] = []

        data_path = Path(data_dir).expanduser().resolve()
        if not data_path.exists():
            raise FileNotFoundError(f"data_dir does not exist: {data_path}")

        jsonl_files = sorted(data_path.rglob("*.jsonl"))
        if not jsonl_files:
            raise RuntimeError(f"No .jsonl files found under {data_path}")

        for fpath in jsonl_files:
            with fpath.open("r", encoding="utf-8") as fh:
                for lineno, line in enumerate(fh, 1):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(obj, str):
                        text = obj
                    elif isinstance(obj, dict):
                        text = obj.get("text", "")
                    else:
                        continue
                    if self.MIN_CHARS <= len(text) <= self.MAX_CHARS:
                        self.texts.append(text)

        if len(self.texts) == 0:
            raise RuntimeError(
                f"ContrastiveDataset: no valid texts found in {data_path}. "
                "Ensure JSONL files contain objects with a 'text' key of 20-500 chars."
            )

        print(f"[contrastive_dataset] Loaded {len(self.texts):,} texts from {data_path}")

    def __len__(self) -> int:
        return len(self.texts)

    def __getitem__(self, idx: int) -> dict[str, torch.Tensor]:
        text = self.texts[idx]
        ids = self.tokenizer.encode(text, add_bos=True)[: self.max_len]
        pad_len = self.max_len - len(ids)
        padded = ids + [0] * pad_len
        mask = [1] * len(ids) + [0] * pad_len
        return {
            "input_ids": torch.tensor(padded, dtype=torch.long),
            "attention_mask": torch.tensor(mask, dtype=torch.float),
        }


# ---------------------------------------------------------------------------
# SimCSE Loss
# ---------------------------------------------------------------------------

class SimCSELoss(nn.Module):
    """
    In-batch contrastive loss for SimCSE.

    Given two views emb_a and emb_b (both already L2-normalised, shape [B, dim]),
    the positive pair for row i is (emb_a[i], emb_b[i]); all other j != i pairs
    are treated as negatives. The loss is the mean cross-entropy where labels
    point to the diagonal of the similarity matrix.
    """

    def forward(
        self,
        emb_a: torch.Tensor,
        emb_b: torch.Tensor,
        temperature: float = 0.05,
    ) -> torch.Tensor:
        """
        Parameters
        ----------
        emb_a, emb_b : L2-normalised embeddings, shape [B, dim].
        temperature  : Scaling divisor; lower values sharpen the distribution.

        Returns
        -------
        Scalar cross-entropy loss.
        """
        # emb_a and emb_b are already L2-normalised by EmbeddingHead
        sim_matrix = emb_a @ emb_b.T / temperature          # [B, B]
        labels = torch.arange(emb_a.size(0), device=emb_a.device)
        return F.cross_entropy(sim_matrix, labels)


# ---------------------------------------------------------------------------
# ContrastiveTrainer
# ---------------------------------------------------------------------------

class ContrastiveTrainer:
    """
    SimCSE fine-tuning loop for the EmbeddingHead inside a ProverbsEmbedder.

    The ProverbsLM backbone (token_embed, layers, backbone_norm) is frozen by
    ProverbsEmbedder.__init__; only EmbeddingHead parameters receive gradients.

    Parameters
    ----------
    embedder    : ProverbsEmbedder with a frozen backbone.
    tokenizer   : ProverbsTokenizer (or any object with .encode()).
    data_dir    : Directory of JSONL files used by ContrastiveDataset.
    lr          : AdamW learning rate for the EmbeddingHead.
    batch_size  : Number of texts per step.
    max_steps   : Total optimiser steps before stopping.
    output_dir  : Directory where checkpoints are written.
    temperature : SimCSE softmax temperature.
    log_every   : Print metrics every N steps.
    save_every  : Save EmbeddingHead weights every N steps.
    """

    def __init__(
        self,
        embedder: ProverbsEmbedder,
        tokenizer,
        data_dir: str,
        lr: float = 3e-5,
        batch_size: int = 64,
        max_steps: int = 1000,
        output_dir: str = "~/.proverbs/checkpoints",
        temperature: float = 0.05,
        log_every: int = 10,
        save_every: int = 200,
        max_len: int = 256,
    ) -> None:
        self.embedder = embedder
        self.tokenizer = tokenizer
        self.lr = lr
        self.batch_size = batch_size
        self.max_steps = max_steps
        self.temperature = temperature
        self.log_every = log_every
        self.save_every = save_every

        self.device = embedder.device
        self.output_dir = Path(output_dir).expanduser().resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)

        # Dataset & loader
        dataset = ContrastiveDataset(data_dir, tokenizer, max_len=max_len)
        self.loader = DataLoader(
            dataset,
            batch_size=batch_size,
            shuffle=True,
            drop_last=True,
            pin_memory=(self.device == "cuda"),
            num_workers=0,
        )

        # Loss
        self.criterion = SimCSELoss()

        # Only train the EmbeddingHead
        trainable = list(embedder.head.parameters())
        self.optimizer = torch.optim.AdamW(trainable, lr=lr, weight_decay=0.01)

        head_params = sum(p.numel() for p in trainable)
        print(
            f"[contrastive_trainer] ready  |  "
            f"head_params={head_params:,}  |  "
            f"device={self.device}  |  "
            f"dataset={len(dataset):,}  |  "
            f"batch_size={batch_size}  |  "
            f"max_steps={max_steps}  |  "
            f"output_dir={self.output_dir}"
        )

    # ------------------------------------------------------------------
    # Internal: encode a batch with gradient, keeping backbone frozen
    # ------------------------------------------------------------------

    def _forward_head(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor,
    ) -> torch.Tensor:
        """
        Run the frozen backbone then the trainable EmbeddingHead.

        The backbone components are used without torch.inference_mode so that
        the EmbeddingHead receives a gradient-carrying tensor. Backbone
        parameters have requires_grad=False so no backbone gradients are
        computed or stored.
        """
        embedder = self.embedder
        dtype = next(embedder.token_embed.parameters()).dtype

        x = embedder.token_embed(input_ids).to(dtype)
        for layer in embedder.layers:
            x, _, _ = layer(x, mask=None, kv_cache=None)
        x = embedder.backbone_norm(x)
        # EmbeddingHead: pool → project → LayerNorm → L2-normalise
        return embedder.head(x, attention_mask)

    # ------------------------------------------------------------------
    # train
    # ------------------------------------------------------------------

    def train(self) -> float:
        """
        Run the contrastive training loop.

        Returns
        -------
        Average SimCSE loss over all steps (float).
        """
        self.embedder.head.train()

        # Infinite iterator over the loader
        def _infinite(loader: DataLoader):
            while True:
                yield from loader

        data_iter = _infinite(self.loader)

        if _HAS_TQDM:
            pbar = _tqdm(total=self.max_steps, desc="simcse", unit="step")
        else:
            pbar = None

        step = 0
        total_loss = 0.0
        t0 = time.perf_counter()

        while step < self.max_steps:
            batch = next(data_iter)
            input_ids: torch.Tensor = batch["input_ids"].to(self.device, non_blocking=True)
            attention_mask: torch.Tensor = batch["attention_mask"].to(self.device, non_blocking=True)

            self.optimizer.zero_grad(set_to_none=True)

            # Two independent forward passes — different dropout masks each time
            emb_a = self._forward_head(input_ids, attention_mask)
            emb_b = self._forward_head(input_ids, attention_mask)

            loss: torch.Tensor = self.criterion(emb_a, emb_b, temperature=self.temperature)
            loss.backward()
            self.optimizer.step()

            loss_val = loss.item()
            total_loss += loss_val
            step += 1

            if step % self.log_every == 0:
                t1 = time.perf_counter()
                elapsed = t1 - t0
                t0 = t1
                avg = total_loss / step
                msg = (
                    f"step={step:>6d}/{self.max_steps}  "
                    f"loss={loss_val:.4f}  "
                    f"avg_loss={avg:.4f}  "
                    f"elapsed={elapsed:.1f}s"
                )
                if pbar is not None:
                    pbar.set_postfix_str(f"loss={loss_val:.4f} avg={avg:.4f}")
                    pbar.update(self.log_every)
                else:
                    print(msg)

            if step % self.save_every == 0:
                ckpt_path = self.output_dir / f"head-step{step}.pt"
                self.save_head(str(ckpt_path))

        if pbar is not None:
            pbar.close()

        final_avg = total_loss / max(step, 1)
        print(
            f"[contrastive_trainer] Training complete.  "
            f"Steps={step}  avg_loss={final_avg:.4f}"
        )
        # Save final head
        self.save_head(str(self.output_dir / "head-final.pt"))
        return final_avg

    # ------------------------------------------------------------------
    # save_head
    # ------------------------------------------------------------------

    def save_head(self, path: str) -> None:
        """Save EmbeddingHead weights (and embed_dim) to *path*."""
        out = Path(path).expanduser().resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        torch.save(
            {
                "head": self.embedder.head.state_dict(),
                "embed_dim": self.embedder.embed_dim,
            },
            out,
        )
        print(f"[contrastive_trainer] Saved EmbeddingHead → {out}")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="SimCSE contrastive training for ProverbsEmbedder EmbeddingHead"
    )
    parser.add_argument(
        "--lm-path",
        required=True,
        help="Path to a ProverbsLM checkpoint (.pt) or directory containing one.",
    )
    parser.add_argument(
        "--data-dir",
        required=True,
        help="Directory containing JSONL files with 'text' fields.",
    )
    parser.add_argument(
        "--output-dir",
        default="~/.proverbs/checkpoints",
        help="Directory for EmbeddingHead checkpoints (default: ~/.proverbs/checkpoints).",
    )
    parser.add_argument(
        "--steps",
        type=int,
        default=1000,
        help="Total optimiser steps (default: 1000).",
    )
    parser.add_argument("--lr", type=float, default=3e-5, help="AdamW learning rate.")
    parser.add_argument("--batch-size", type=int, default=64, help="Batch size.")
    parser.add_argument("--temperature", type=float, default=0.05, help="SimCSE temperature.")
    parser.add_argument("--log-every", type=int, default=10, help="Log every N steps.")
    parser.add_argument("--save-every", type=int, default=200, help="Save checkpoint every N steps.")
    parser.add_argument("--head-path", default=None, help="Optional: load existing EmbeddingHead weights before training.")
    return parser.parse_args()


if __name__ == "__main__":
    args = _parse_args()

    # Lazy import tokenizer (same pattern as rest of codebase)
    try:
        from tokenizer.tokenizer import ProverbsTokenizer
        tokenizer = ProverbsTokenizer.load(str(Path(args.lm_path).parent))
    except Exception as exc:
        print(f"[contrastive_trainer] Could not load ProverbsTokenizer: {exc}")
        sys.exit(1)

    embedder = load_embedder(
        lm_path=args.lm_path,
        head_path=args.head_path,
    )

    trainer = ContrastiveTrainer(
        embedder=embedder,
        tokenizer=tokenizer,
        data_dir=args.data_dir,
        lr=args.lr,
        batch_size=args.batch_size,
        max_steps=args.steps,
        output_dir=args.output_dir,
        temperature=args.temperature,
        log_every=args.log_every,
        save_every=args.save_every,
    )

    avg_loss = trainer.train()
    print(f"[contrastive_trainer] Final average SimCSE loss: {avg_loss:.4f}")
