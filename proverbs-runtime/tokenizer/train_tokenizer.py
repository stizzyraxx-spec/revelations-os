"""
train_tokenizer.py — Train a ProverbsTokenizer from session JSONL files
and optional extra text data, then save to disk.

Usage:
    python -m tokenizer.train_tokenizer [options]
    python tokenizer/train_tokenizer.py [options]

Arguments:
    --data-dir    Path to JSONL session files  (default: ~/.proverbs/sessions)
    --output      Where to save tokenizer.json (default: ~/.proverbs/tokenizer.json)
    --vocab-size  BPE vocabulary size          (default: 32000)
    --extra-data  Optional path to extra text files/dirs (*.txt *.py *.js *.ts *.md)
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# sys.path surgery so the script works both as:
#   python -m tokenizer.train_tokenizer   (package mode — relative import works)
#   python tokenizer/train_tokenizer.py   (direct mode — need path fixup)
# ---------------------------------------------------------------------------
def _ensure_importable() -> None:
    """Add the project root to sys.path when running as a plain script."""
    project_root = Path(__file__).resolve().parent.parent
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))


_ensure_importable()

try:
    from tokenizer.bpe import ProverbsTokenizer  # package import
except ImportError:
    try:
        from bpe import ProverbsTokenizer  # same-dir import (fallback)
    except ImportError as exc:
        print(
            "ERROR: Could not import ProverbsTokenizer from tokenizer.bpe.\n"
            "Make sure tokenizer/bpe.py exists and defines ProverbsTokenizer.\n"
            f"Original error: {exc}",
            file=sys.stderr,
        )
        sys.exit(1)


# ---------------------------------------------------------------------------
# Text collection helpers
# ---------------------------------------------------------------------------

_EXTRA_EXTENSIONS = {".txt", ".py", ".js", ".ts", ".md"}


def collect_from_jsonl(data_dir: Path) -> list[str]:
    """Extract all message content strings from *.jsonl files in data_dir."""
    texts: list[str] = []
    jsonl_files = sorted(data_dir.glob("*.jsonl"))
    if not jsonl_files:
        print(f"  [warn] No *.jsonl files found in {data_dir}", file=sys.stderr)
        return texts

    for fpath in jsonl_files:
        try:
            with fpath.open("r", encoding="utf-8", errors="replace") as fh:
                for lineno, raw in enumerate(fh, start=1):
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        obj = json.loads(raw)
                    except json.JSONDecodeError as e:
                        print(
                            f"  [warn] {fpath.name}:{lineno} — JSON parse error: {e}",
                            file=sys.stderr,
                        )
                        continue
                    # Format A: {"text": "..."} — pretrain/download format
                    if "text" in obj and isinstance(obj["text"], str) and obj["text"].strip():
                        texts.append(obj["text"])
                        continue
                    # Format B: {"messages": [{"role": "...", "content": "..."}, ...]}
                    messages = obj.get("messages", [])
                    if not isinstance(messages, list):
                        continue
                    for msg in messages:
                        content = msg.get("content", "")
                        if isinstance(content, str) and content.strip():
                            texts.append(content)
                        elif isinstance(content, list):
                            for block in content:
                                if isinstance(block, dict):
                                    text = block.get("text", "")
                                    if isinstance(text, str) and text.strip():
                                        texts.append(text)
        except OSError as e:
            print(f"  [warn] Could not read {fpath}: {e}", file=sys.stderr)

    print(f"  Collected {len(texts):,} message strings from {len(jsonl_files)} JSONL file(s).")
    return texts


def collect_from_extra(extra_path: Path) -> list[str]:
    """Recursively read *.txt, *.py, *.js, *.ts, *.md files under extra_path."""
    texts: list[str] = []

    if extra_path.is_file():
        candidates = [extra_path] if extra_path.suffix in _EXTRA_EXTENSIONS else []
    else:
        candidates = [
            p for p in extra_path.rglob("*")
            if p.is_file() and p.suffix in _EXTRA_EXTENSIONS
        ]

    if not candidates:
        print(
            f"  [warn] No supported files ({', '.join(sorted(_EXTRA_EXTENSIONS))}) "
            f"found under {extra_path}",
            file=sys.stderr,
        )
        return texts

    for fpath in sorted(candidates):
        try:
            content = fpath.read_text(encoding="utf-8", errors="replace").strip()
            if content:
                texts.append(content)
        except OSError as e:
            print(f"  [warn] Could not read {fpath}: {e}", file=sys.stderr)

    print(f"  Collected {len(texts):,} file(s) from extra-data path: {extra_path}")
    return texts


def deduplicate(texts: list[str]) -> list[str]:
    """Remove exact duplicates while preserving order of first occurrence."""
    seen: set[str] = set()
    out: list[str] = []
    for t in texts:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="train_tokenizer",
        description="Train a ProverbsTokenizer (BPE) from session data and save it.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument(
        "--data-dir",
        type=Path,
        default=Path("~/.proverbs/sessions").expanduser(),
        help="Directory containing *.jsonl session files.",
    )
    p.add_argument(
        "--output",
        type=Path,
        default=Path("~/.proverbs/tokenizer.json").expanduser(),
        help="Destination path for the saved tokenizer JSON.",
    )
    p.add_argument(
        "--vocab-size",
        type=int,
        default=32000,
        help="Target BPE vocabulary size.",
    )
    p.add_argument(
        "--extra-data",
        type=Path,
        default=None,
        metavar="PATH",
        help=(
            "Optional path to a file or directory containing extra training text "
            "(*.txt, *.py, *.js, *.ts, *.md are read recursively)."
        ),
    )
    return p


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)

    # Resolve paths
    data_dir: Path = args.data_dir.expanduser().resolve()
    output: Path = args.output.expanduser().resolve()
    vocab_size: int = args.vocab_size
    extra_data: Path | None = (
        args.extra_data.expanduser().resolve() if args.extra_data else None
    )

    # ------------------------------------------------------------------
    # 1. Validate inputs
    # ------------------------------------------------------------------
    if not data_dir.exists():
        print(f"[warn] --data-dir does not exist: {data_dir}", file=sys.stderr)
        print("       Proceeding without session data.", file=sys.stderr)

    if extra_data is not None and not extra_data.exists():
        print(f"ERROR: --extra-data path does not exist: {extra_data}", file=sys.stderr)
        sys.exit(1)

    if vocab_size < 256:
        print("ERROR: --vocab-size must be >= 256 (need at least all byte values).", file=sys.stderr)
        sys.exit(1)

    # ------------------------------------------------------------------
    # 2. Collect texts
    # ------------------------------------------------------------------
    print("\n=== Collecting training text ===")
    all_texts: list[str] = []

    if data_dir.exists():
        all_texts.extend(collect_from_jsonl(data_dir))

    if extra_data is not None:
        all_texts.extend(collect_from_extra(extra_data))

    if not all_texts:
        print(
            "ERROR: No training text collected. "
            "Provide session JSONL files or --extra-data.",
            file=sys.stderr,
        )
        sys.exit(1)

    # ------------------------------------------------------------------
    # 3. Deduplicate and shuffle
    # ------------------------------------------------------------------
    before = len(all_texts)
    all_texts = deduplicate(all_texts)
    after = len(all_texts)
    print(f"  Deduplicated: {before:,} → {after:,} unique texts.")

    random.seed(42)
    random.shuffle(all_texts)
    print(f"  Shuffled {after:,} texts (seed=42).")

    # ------------------------------------------------------------------
    # 4. Instantiate tokenizer
    # ------------------------------------------------------------------
    print(f"\n=== Instantiating ProverbsTokenizer (vocab_size={vocab_size:,}) ===")
    tokenizer = ProverbsTokenizer(vocab_size=vocab_size)

    # ------------------------------------------------------------------
    # 5. Train
    # ------------------------------------------------------------------
    print("\n=== Training ===")
    tokenizer.train(all_texts, verbose=True)

    # ------------------------------------------------------------------
    # 6. Save
    # ------------------------------------------------------------------
    print(f"\n=== Saving tokenizer → {output} ===")
    output.parent.mkdir(parents=True, exist_ok=True)
    tokenizer.save(str(output))
    print(f"  Saved to {output}")

    # ------------------------------------------------------------------
    # 7. Stats
    # ------------------------------------------------------------------
    print("\n=== Stats ===")
    actual_vocab = tokenizer.vocab_size if hasattr(tokenizer, "vocab_size") else vocab_size
    num_merges = len(tokenizer.merges) if hasattr(tokenizer, "merges") else "N/A"
    print(f"  Vocab size : {actual_vocab:,}")
    print(f"  # merges   : {num_merges:,}" if isinstance(num_merges, int) else f"  # merges   : {num_merges}")

    sample = "def hello_world():"
    try:
        ids = tokenizer.encode(sample)
        decoded = tokenizer.decode(ids)
        print(f"  Sample encode({sample!r})")
        print(f"    → token IDs : {ids}")
        print(f"    → decoded   : {decoded!r}")
    except Exception as e:
        print(f"  [warn] Sample encode/decode failed: {e}", file=sys.stderr)

    print("\nDone.")


if __name__ == "__main__":
    main()
