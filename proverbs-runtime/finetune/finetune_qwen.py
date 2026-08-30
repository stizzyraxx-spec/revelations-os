#!/usr/bin/env python3
"""
finetune_qwen.py — LoRA fine-tune Qwen2.5-Coder-1.5B-Instruct on your code.

Runs on Apple MPS (~30-90 min), CUDA (~10-20 min), or CPU (slow).
Saves a merged HF model to ~/.proverbs/checkpoints/finetuned-qwen/

Usage:
    python finetune/finetune_qwen.py
    python finetune/finetune_qwen.py --steps 300 --rank 8 --dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────

PROVERBS_DIR  = Path.home() / ".proverbs"
DATA_FILE     = PROVERBS_DIR / "finetune_data.jsonl"
OUTPUT_DIR    = PROVERBS_DIR / "checkpoints" / "finetuned-qwen"
HF_MODEL_ID   = "Qwen/Qwen2.5-Coder-1.5B-Instruct"

DEFAULTS = dict(
    steps      = 100,   # ~1-2h on CPU; bump to 400+ on a GPU machine
    rank       = 8,
    lr         = 2e-4,
    batch      = 1,
    grad_accum = 4,
    max_len    = 256,   # shorter = faster on CPU; increase on GPU
    warmup     = 10,
    save_every = 50,
)


# ── Arg parse ─────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(description="LoRA fine-tune Qwen2.5-Coder-1.5B on your code")
    p.add_argument("--steps",      type=int,   default=DEFAULTS["steps"])
    p.add_argument("--rank",       type=int,   default=DEFAULTS["rank"],    help="LoRA rank (4/8/16)")
    p.add_argument("--lr",         type=float, default=DEFAULTS["lr"])
    p.add_argument("--batch",      type=int,   default=DEFAULTS["batch"],   help="Per-device batch size (keep 1 on Mac)")
    p.add_argument("--grad-accum", type=int,   default=DEFAULTS["grad_accum"], dest="grad_accum")
    p.add_argument("--max-len",    type=int,   default=DEFAULTS["max_len"],  dest="max_len")
    p.add_argument("--warmup",     type=int,   default=DEFAULTS["warmup"])
    p.add_argument("--save-every", type=int,   default=DEFAULTS["save_every"], dest="save_every")
    p.add_argument("--model",      default=HF_MODEL_ID,  help="HuggingFace model ID")
    p.add_argument("--data",       default=str(DATA_FILE), help="Path to .jsonl training data")
    p.add_argument("--output",     default=str(OUTPUT_DIR), help="Where to save the merged model")
    p.add_argument("--dry-run",    action="store_true", help="Verify setup without training")
    return p.parse_args()


# ── Data ──────────────────────────────────────────────────────────────────────

def load_data(path: str) -> list[dict]:
    data = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    data.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return data


def tokenize_example(example: dict, tokenizer, max_len: int) -> dict | None:
    """Apply Qwen chat template and tokenize. Returns None if too long after truncation."""
    messages = example.get("messages", [])
    if not messages:
        return None

    try:
        text = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=False,
        )
    except Exception:
        return None

    ids = tokenizer(
        text,
        truncation=True,
        max_length=max_len,
        padding=False,
        return_tensors=None,
    )["input_ids"]

    if len(ids) < 8:
        return None

    return {"input_ids": ids, "labels": ids[:]}


def build_dataset(data: list[dict], tokenizer, max_len: int):
    """Tokenize all examples, drop empties, return a list of dicts."""
    tokenized = []
    for ex in data:
        t = tokenize_example(ex, tokenizer, max_len)
        if t:
            tokenized.append(t)
    return tokenized


# ── Collate ───────────────────────────────────────────────────────────────────

def collate_fn(batch, pad_id: int):
    import torch
    max_len = max(len(b["input_ids"]) for b in batch)
    input_ids = []
    labels    = []
    for b in batch:
        ids = b["input_ids"]
        lbl = b["labels"]
        pad_len = max_len - len(ids)
        input_ids.append(ids + [pad_id] * pad_len)
        labels.append(lbl + [-100] * pad_len)  # -100 = ignore in CE loss
    return {
        "input_ids": torch.tensor(input_ids, dtype=torch.long),
        "labels":    torch.tensor(labels,    dtype=torch.long),
    }


# ── Training ──────────────────────────────────────────────────────────────────

def cosine_lr(step: int, warmup: int, total: int, lr_max: float, lr_min: float = 1e-6) -> float:
    import math
    if step < warmup:
        return lr_max * (step + 1) / max(warmup, 1)
    t = (step - warmup) / max(total - warmup, 1)
    return lr_min + 0.5 * (lr_max - lr_min) * (1 + math.cos(math.pi * min(t, 1.0)))


def train(args) -> None:
    import torch
    from transformers import AutoTokenizer, AutoModelForCausalLM
    from peft import LoraConfig, get_peft_model, TaskType

    # ── Device ──────────────────────────────────────────────────────────────
    if torch.cuda.is_available():
        device = torch.device("cuda")
        dtype  = torch.bfloat16
    elif torch.backends.mps.is_available():
        device = torch.device("mps")
        dtype  = torch.float32   # bfloat16 on MPS can be unstable for training
    else:
        device = torch.device("cpu")
        dtype  = torch.float32

    print(f"\n  Device : {device}  ({dtype})")
    print(f"  Model  : {args.model}")
    print(f"  Steps  : {args.steps}  (effective batch = {args.batch * args.grad_accum})")
    print(f"  LoRA   : rank={args.rank}  alpha={args.rank * 2}")
    print(f"  Output : {args.output}\n")

    # ── Data ────────────────────────────────────────────────────────────────
    if not Path(args.data).exists():
        print(f"[error] Training data not found: {args.data}")
        print("  Run: python finetune/extract_code_data.py")
        sys.exit(1)

    raw = load_data(args.data)
    print(f"  Loaded {len(raw)} raw examples from {args.data}")

    # ── Tokenizer ───────────────────────────────────────────────────────────
    print(f"  Loading tokenizer from {args.model} ...")
    tokenizer = AutoTokenizer.from_pretrained(
        args.model, trust_remote_code=True, use_fast=True,
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    # ── Tokenize dataset ────────────────────────────────────────────────────
    print("  Tokenizing dataset ...")
    dataset = build_dataset(raw, tokenizer, args.max_len)
    print(f"  {len(dataset)} usable examples after filtering\n")

    if len(dataset) == 0:
        print("[error] No usable examples after tokenization. Check your data file.")
        sys.exit(1)

    if args.dry_run:
        print("  [dry-run] Setup OK — exiting before training.")
        return

    # ── Model ───────────────────────────────────────────────────────────────
    print(f"  Loading model {args.model} ...")
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        torch_dtype=dtype,
        trust_remote_code=True,
        device_map=None,   # manual placement
    )
    model = model.to(device)
    model.train()

    # Disable cache during training
    model.config.use_cache = False

    # ── LoRA ────────────────────────────────────────────────────────────────
    lora_cfg = LoraConfig(
        task_type     = TaskType.CAUSAL_LM,
        r             = args.rank,
        lora_alpha    = args.rank * 2,
        lora_dropout  = 0.05,
        target_modules= ["q_proj", "k_proj", "v_proj", "o_proj"],
        bias          = "none",
    )
    model = get_peft_model(model, lora_cfg)
    model.print_trainable_parameters()

    # ── Optimizer ───────────────────────────────────────────────────────────
    optimizer = torch.optim.AdamW(
        [p for p in model.parameters() if p.requires_grad],
        lr=args.lr,
        weight_decay=0.01,
    )

    # ── Training loop ───────────────────────────────────────────────────────
    pad_id  = tokenizer.pad_token_id
    ds_len  = len(dataset)
    step    = 0
    idx     = 0
    accum   = 0
    loss_sum = 0.0

    import torch.nn.functional as F
    from functools import partial
    _collate = partial(collate_fn, pad_id=pad_id)

    output_path = Path(args.output)
    output_path.mkdir(parents=True, exist_ok=True)

    print(f"\n  Training {args.steps} steps ...\n")
    optimizer.zero_grad()
    t0 = time.time()

    while step < args.steps:
        # Cyclic data access
        batch_raw = [dataset[idx % ds_len]]
        idx += 1

        batch = _collate(batch_raw)
        input_ids = batch["input_ids"].to(device)
        labels    = batch["labels"].to(device)

        out  = model(input_ids=input_ids, labels=labels)
        loss = out.loss / args.grad_accum
        loss.backward()
        loss_sum += loss.item() * args.grad_accum

        accum += 1
        if accum < args.grad_accum:
            continue

        # Gradient step
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        lr_now = cosine_lr(step, args.warmup, args.steps, args.lr)
        for g in optimizer.param_groups:
            g["lr"] = lr_now
        optimizer.step()
        optimizer.zero_grad()
        accum = 0
        step += 1

        if step % 20 == 0:
            elapsed = time.time() - t0
            tok_s   = (step * args.batch * args.grad_accum * args.max_len) / max(elapsed, 1)
            eta_s   = (args.steps - step) * (elapsed / max(step, 1))
            print(
                f"  step {step:>4}/{args.steps}  "
                f"loss={loss_sum/20:.4f}  "
                f"lr={lr_now:.2e}  "
                f"tok/s={tok_s:.0f}  "
                f"eta={eta_s/60:.1f}m"
            )
            loss_sum = 0.0

        if step % args.save_every == 0:
            ckpt = output_path / f"adapter-step-{step}"
            model.save_pretrained(str(ckpt))
            print(f"  [checkpoint] {ckpt}")

    # ── Save merged model ────────────────────────────────────────────────────
    print("\n  Merging LoRA adapter into base model ...")
    from peft import PeftModel
    merged = model.merge_and_unload()
    merged.save_pretrained(str(output_path), safe_serialization=True)
    tokenizer.save_pretrained(str(output_path))

    elapsed = time.time() - t0
    print(f"\n  ✓  Fine-tuning complete in {elapsed/60:.1f} minutes")
    print(f"  ✓  Model saved to {output_path}")
    print(f"\n  Start serving: bash finetune/run_finetune.sh --serve-only")
    print(f"  Then in proverbs: /backend http://localhost:11436\n")


# ── Entry ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    args = parse_args()
    train(args)
