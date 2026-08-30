"""
training/train.py — CLI entry point for Proverbs LLM training.

Three modes:
  local     — train a tiny model (~5M params) on your Mac CPU, fully offline
  pretrain  — train on raw code files (requires GPU or patience)
  finetune  — fine-tune on your chat sessions

Usage:
    # Mac / offline — works right now on any machine:
    python -m training.train --mode local

    # GPU pre-train (cloud or NVIDIA machine):
    python -m training.train --mode pretrain --data ~/.proverbs/pretrain_data --size small

    # Fine-tune on your sessions (after pretrain):
    python -m training.train --mode finetune --resume ~/.proverbs/checkpoints/pretrain/best.pt
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

import torch

from model.config import ProverbsConfig
from model.proverbs_lm import ProverbsLM
from training.trainer import ProverbsTrainer


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="train",
        description="Train the Proverbs LLM.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--mode", choices=["local", "pretrain", "finetune"], default="local",
                   help="local=nano model on Mac CPU (offline), pretrain=GPU code training, finetune=chat sessions")
    p.add_argument("--size", choices=["nano", "small", "medium", "large"], default="small",
                   help="Model size (nano=15M/CPU, small=58M/4GB, medium=254M/8GB, large=1.6B/16GB)")
    p.add_argument("--data", default="~/.proverbs/pretrain_data", metavar="DIR",
                   help="[pretrain] Directory of JSONL code files")
    p.add_argument("--sessions", default="~/.proverbs/sessions", metavar="DIR",
                   help="[finetune] Directory of chat session JSONL files")
    p.add_argument("--tokenizer", default="~/.proverbs/tokenizer.json", metavar="FILE")
    p.add_argument("--output-dir", default="~/.proverbs/checkpoints", metavar="DIR")
    p.add_argument("--batch-size", type=int, default=4)
    p.add_argument("--lr", type=float, default=3e-4,
                   help="Peak learning rate (use 1e-4 for finetune)")
    p.add_argument("--max-steps", type=int, default=50_000,
                   help="Optimizer steps (pretrain: 50k; finetune: 2k)")
    p.add_argument("--warmup", type=int, default=500)
    p.add_argument("--max-tokens", type=int, default=0,
                   help="[pretrain] Cap total tokens (0=all)")
    p.add_argument("--resume", default=None, metavar="CKPT",
                   help="Checkpoint to resume or start finetune from")
    p.add_argument("--compile", action="store_true",
                   help="torch.compile() (PyTorch 2+ / Linux recommended)")
    p.add_argument("--no-amp", action="store_true",
                   help="Disable automatic mixed precision")
    p.add_argument("--log-every", type=int, default=20)
    p.add_argument("--eval-every", type=int, default=500)
    p.add_argument("--save-every", type=int, default=2000)
    return p


def _device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()

    print("=== Proverbs LLM Training ===\n")

    tokenizer_path = Path(args.tokenizer).expanduser()
    if not tokenizer_path.exists():
        print(f"[ERROR] Tokenizer not found: {tokenizer_path}")
        print("Run first:  python -m tokenizer.train_tokenizer")
        sys.exit(1)

    # ── Config ──────────────────────────────────────────────────────────────
    cfg = {"nano": ProverbsConfig.nano, "small": ProverbsConfig.small,
           "medium": ProverbsConfig.medium, "large": ProverbsConfig.large}[args.size]()
    cfg.dropout = 0.1

    device = _device()
    print(f"  Mode       : {args.mode}")
    print(f"  Model size : {args.size}  ({cfg.param_count()/1e6:.1f}M params)")
    print(f"  Device     : {device}")
    print(f"  AMP        : {'off' if args.no_amp else 'on'}")
    print()

    # ── Dataset ─────────────────────────────────────────────────────────────
    if args.mode == "local":
        # Nano model — CPU-trainable, runs on any Mac, trains in ~1-2 hours
        cfg = ProverbsConfig.nano()
        cfg.dropout = 0.1
        args.size = "nano"
        args.no_amp = True          # AMP not needed on CPU
        if args.max_steps == 50_000:
            args.max_steps = 5_000
        if args.warmup == 500:
            args.warmup = 100

        print(f"  Mode       : local (offline/CPU)")
        print(f"  Model size : micro  ({cfg.param_count()/1e6:.1f}M params)")
        print(f"  Device     : {device}")
        print(f"  Max steps  : {args.max_steps}  (~1-2 hrs on CPU)")
        print()
        print("  This trains a small personal model on your session data.")
        print("  For a smarter model, run the Colab notebook (scripts/colab_train.ipynb)")
        print("  or use the GGUF backend (already-downloaded model, works right now).\n")

        from training.dataset import ProverbsDataset, create_dataloader
        train_ds = ProverbsDataset(args.sessions, str(tokenizer_path), cfg.max_seq_len, split="train")
        valid_ds = ProverbsDataset(args.sessions, str(tokenizer_path), cfg.max_seq_len, split="valid")

        if len(train_ds) == 0:
            print("[WARN] No training examples found in sessions. The model will not learn much.")
            print(f"       Add session data to {args.sessions} or switch to --mode pretrain.\n")

        train_loader = create_dataloader(train_ds, min(args.batch_size, 2), shuffle=True)
        valid_loader = create_dataloader(valid_ds, min(args.batch_size, 2), shuffle=False)
        out_dir = Path(args.output_dir).expanduser() / "local"

    elif args.mode == "pretrain":
        from training.pretrain_dataset import PretrainDataset, create_pretrain_dataloader

        data_dir = Path(args.data).expanduser()
        if not data_dir.exists() or not list(data_dir.glob("*.jsonl")):
            print(f"[ERROR] No data found at {data_dir}")
            print("Run first:  python scripts/download_pretrain_data.py")
            sys.exit(1)

        print("Loading pre-training data...")
        train_ds = PretrainDataset(str(data_dir), str(tokenizer_path),
                                   cfg.max_seq_len, split="train",
                                   max_tokens=args.max_tokens)
        valid_ds = PretrainDataset(str(data_dir), str(tokenizer_path),
                                   cfg.max_seq_len, split="valid",
                                   max_tokens=max(0, args.max_tokens // 20) if args.max_tokens else 0)

        train_loader = create_pretrain_dataloader(train_ds, args.batch_size, shuffle=True)
        valid_loader = create_pretrain_dataloader(valid_ds, args.batch_size, shuffle=False)

        out_dir = Path(args.output_dir).expanduser() / "pretrain"

    else:  # finetune
        from training.dataset import ProverbsDataset, create_dataloader

        print("Loading fine-tune session data...")
        train_ds = ProverbsDataset(args.sessions, str(tokenizer_path),
                                   cfg.max_seq_len, split="train")
        valid_ds = ProverbsDataset(args.sessions, str(tokenizer_path),
                                   cfg.max_seq_len, split="valid")

        train_loader = create_dataloader(train_ds, args.batch_size, shuffle=True)
        valid_loader = create_dataloader(valid_ds, args.batch_size, shuffle=False)

        out_dir = Path(args.output_dir).expanduser() / "finetune"

        # Finetune-friendly defaults
        if args.lr == 3e-4:
            args.lr = 1e-4
        if args.max_steps == 50_000:
            args.max_steps = 2_000
        if args.warmup == 500:
            args.warmup = 50

    print(f"  Train chunks: {len(train_ds):,}   Valid chunks: {len(valid_ds):,}\n")
    out_dir.mkdir(parents=True, exist_ok=True)

    # ── Model ────────────────────────────────────────────────────────────────
    if args.resume:
        resume_path = Path(args.resume).expanduser()
        print(f"Loading checkpoint: {resume_path}")
        model = ProverbsLM.load(resume_path, device=device)
    else:
        model = ProverbsLM(cfg).to_device()

    if args.compile and hasattr(torch, "compile"):
        print("Compiling model with torch.compile() ...")
        model = torch.compile(model)
    elif args.compile:
        print("[WARN] torch.compile() not available — skipping")

    # ── Trainer ──────────────────────────────────────────────────────────────
    trainer = ProverbsTrainer(
        model=model,
        train_loader=train_loader,
        valid_loader=valid_loader,
        cfg=cfg,
        lr=args.lr,
        max_steps=args.max_steps,
        warmup_steps=args.warmup,
        output_dir=str(out_dir),
        use_amp=not args.no_amp,
        log_every=args.log_every,
        eval_every=args.eval_every,
        save_every=args.save_every,
    )

    print(f"Training for {args.max_steps:,} steps → {out_dir}\n")
    trainer.train()

    # ── Save final ───────────────────────────────────────────────────────────
    final_path = out_dir / "final.pt"
    raw = model._orig_mod if hasattr(model, "_orig_mod") else model
    raw.save(final_path)
    print(f"\nFinal model saved → {final_path}")

    if args.mode == "pretrain":
        print("\nNext: fine-tune on your sessions:")
        print(f"  python -m training.train --mode finetune --resume {final_path}")
    else:
        print("\nStart the server:")
        print(f"  ~/.proverbs/venv/bin/python -m inference.server --model {final_path}")


if __name__ == "__main__":
    main()
