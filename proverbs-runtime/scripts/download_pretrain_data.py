#!/usr/bin/env python3
"""
download_pretrain_data.py — Download open-access code datasets for ProverbsLM pre-training.

Uses only publicly accessible, no-auth-required datasets:
  1. sahil2801/CodeAlpaca-20k         — 20k instruction-code pairs, multi-language
  2. iamtarun/python_code_instructions_18k_alpaca — 18k Python
  3. nampdn-ai/tiny-codes             — Multi-language code examples
  4. TokenBender/code_instructions_122k_alpaca_style — 122k diverse code

Total: ~150k+ high-quality code instruction examples.

Usage:
    python scripts/download_pretrain_data.py
    python scripts/download_pretrain_data.py --max 50000
"""

import argparse
import json
import os
import sys
from pathlib import Path

PRETRAIN_DIR = Path.home() / ".proverbs" / "pretrain_data"
STATS_FILE   = PRETRAIN_DIR / "stats.json"

# Open datasets — no HuggingFace token required
OPEN_DATASETS = [
    {
        "id": "sahil2801/CodeAlpaca-20k",
        "split": "train",
        "text_field": None,          # use instruction+output
        "instruction_field": "instruction",
        "output_field": "output",
        "max": 20000,
        "desc": "CodeAlpaca 20k (multi-language)",
    },
    {
        "id": "iamtarun/python_code_instructions_18k_alpaca",
        "split": "train",
        "text_field": None,
        "instruction_field": "instruction",
        "output_field": "output",
        "max": 18000,
        "desc": "Python code instructions 18k",
    },
    {
        "id": "nampdn-ai/tiny-codes",
        "split": "train",
        "text_field": "response",
        "instruction_field": "prompt",
        "output_field": "response",
        "max": 50000,
        "desc": "Tiny codes (multi-language, 50k)",
    },
    {
        "id": "TokenBender/code_instructions_122k_alpaca_style",
        "split": "train",
        "text_field": None,
        "instruction_field": "instruction",
        "output_field": "output",
        "max": 50000,
        "desc": "Code instructions 122k alpaca-style",
    },
]


def check_deps():
    try:
        import datasets  # noqa: F401
    except ImportError:
        print("[error] 'datasets' not installed.")
        print("        python -m pip install datasets")
        sys.exit(1)


def fmt_example(row: dict, ds_cfg: dict) -> str | None:
    """Format a dataset row as a Proverbs training example."""
    if ds_cfg["text_field"] and ds_cfg["text_field"] in row:
        text = row[ds_cfg["text_field"]]
        if text and len(text.strip()) > 30:
            return text.strip()

    instr = row.get(ds_cfg["instruction_field"], "").strip()
    out   = row.get(ds_cfg["output_field"], "").strip()

    if not instr or not out or len(out) < 20:
        return None

    # Format as a code assistant exchange (matches Proverbs session format)
    return f"User: {instr}\n\nAssistant:\n{out}"


def download_dataset(ds_cfg: dict, max_examples: int, out_dir: Path) -> int:
    from datasets import load_dataset

    ds_id   = ds_cfg["id"]
    ds_name = ds_id.split("/")[-1]
    out_file = out_dir / f"{ds_name}.jsonl"

    if out_file.exists():
        count = sum(1 for _ in open(out_file))
        if count >= min(max_examples, ds_cfg["max"]) // 2:
            print(f"  ✔ {ds_cfg['desc']:45s} already downloaded ({count:,} examples)")
            return count
        out_file.unlink()

    print(f"  ↓ {ds_cfg['desc']:45s} downloading...", flush=True)
    try:
        ds = load_dataset(ds_id, split=ds_cfg["split"], streaming=True, trust_remote_code=False)
    except Exception as e:
        print(f"  ✗ {ds_id}: {e}")
        return 0

    effective_max = min(max_examples, ds_cfg["max"])
    count = 0
    with open(out_file, "w", encoding="utf-8") as f:
        for row in ds:
            text = fmt_example(row, ds_cfg)
            if not text:
                continue
            # Skip very short or very long examples
            if len(text) < 50 or len(text) > 8000:
                continue
            f.write(json.dumps({"text": text, "source": ds_id}) + "\n")
            count += 1
            if count % 10000 == 0:
                print(f"    {count:,}/{effective_max:,}...", flush=True)
            if count >= effective_max:
                break

    print(f"  ✔ {ds_cfg['desc']:45s} {count:,} examples  →  {out_file.name}")
    return count


def compute_token_estimate(out_dir: Path) -> int:
    total_chars = sum(f.stat().st_size for f in out_dir.glob("*.jsonl"))
    return total_chars // 4


def main():
    parser = argparse.ArgumentParser(description="Download code pre-training data for Proverbs LLM")
    parser.add_argument("--max", type=int, default=50000,
                        help="Max examples per dataset (default: 50000)")
    parser.add_argument("--output", default=str(PRETRAIN_DIR),
                        help=f"Output directory (default: {PRETRAIN_DIR})")
    args = parser.parse_args()

    check_deps()

    out_dir = Path(args.output).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)

    print("=== Proverbs LLM: Download Pre-Training Data ===\n")
    print(f"Datasets  : {len(OPEN_DATASETS)} open-access sources")
    print(f"Max/source: {args.max:,}")
    print(f"Output    : {out_dir}\n")

    stats = {}
    total = 0
    for ds_cfg in OPEN_DATASETS:
        n = download_dataset(ds_cfg, args.max, out_dir)
        stats[ds_cfg["id"]] = n
        total += n

    est_tokens = compute_token_estimate(out_dir)
    stats["total_examples"] = total
    stats["estimated_tokens"] = est_tokens

    with open(STATS_FILE, "w") as f:
        json.dump(stats, f, indent=2)

    print(f"\n{'─'*55}")
    print(f"  Total examples  : {total:,}")
    print(f"  Estimated tokens: {est_tokens/1e6:.1f}M")
    print(f"  Output          : {out_dir}")
    print()
    if total > 0:
        print("Next: pre-train the model")
        print(f"  python -m training.train --mode pretrain --size small --data {out_dir}")
    print()


if __name__ == "__main__":
    main()
