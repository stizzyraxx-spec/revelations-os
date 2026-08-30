"""
logic/active_learning.py — Active learning via model uncertainty for Proverbs LLM.

Selects the most informative training examples from unlabelled data by measuring
how much a ProverbsGenerator disagrees with itself across multiple stochastic
completions (mean pairwise normalised edit distance).

Public API
----------
compute_uncertainty(generator, text, n_samples=3) -> float
score_dataset(generator, data_dir, max_examples=200) -> list[dict]
ActiveDataset                   — torch.utils.data.Dataset of top-k uncertain examples
build_active_loader(...)        -> DataLoader
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path
from typing import Sequence

import torch
from torch.utils.data import DataLoader, Dataset

# ---------------------------------------------------------------------------
# Ensure project root is importable regardless of invocation context.
# ---------------------------------------------------------------------------
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from inference.generate import ProverbsGenerator  # noqa: E402
from tokenizer.bpe import ProverbsTokenizer       # noqa: E402

# ---------------------------------------------------------------------------
# Constants (mirror training/dataset.py)
# ---------------------------------------------------------------------------
PAD_TOKEN_ID: int = 0
LABEL_IGNORE_INDEX: int = -100
MIN_SEQ_LEN: int = 8


# ---------------------------------------------------------------------------
# Edit-distance helper (pure Python — no external deps)
# ---------------------------------------------------------------------------

def _edit_distance(a: str, b: str) -> int:
    """Standard dynamic-programming Levenshtein distance between two strings."""
    if a == b:
        return 0
    la, lb = len(a), len(b)
    if la == 0:
        return lb
    if lb == 0:
        return la

    # Use a single row rolling array for O(min(la,lb)) space.
    if la < lb:
        a, b, la, lb = b, a, lb, la

    prev = list(range(lb + 1))
    for i, ca in enumerate(a, 1):
        curr = [i] + [0] * lb
        for j, cb in enumerate(b, 1):
            curr[j] = min(
                prev[j] + 1,        # deletion
                curr[j - 1] + 1,    # insertion
                prev[j - 1] + (ca != cb),  # substitution
            )
        prev = curr
    return prev[lb]


# ---------------------------------------------------------------------------
# compute_uncertainty
# ---------------------------------------------------------------------------

def compute_uncertainty(
    generator: ProverbsGenerator,
    text: str,
    n_samples: int = 3,
) -> float:
    """
    Estimate model uncertainty on *text* by measuring output disagreement.

    Samples *n_samples* completions at temperature=0.8, then computes the mean
    pairwise edit distance between every unique pair of completions, normalised
    by the maximum length of the longer string in each pair.

    Parameters
    ----------
    generator : ProverbsGenerator
        A loaded, eval-mode generator.
    text : str
        The user message / prompt to complete.
    n_samples : int
        Number of stochastic completions to draw (>= 2 required for comparison).

    Returns
    -------
    float in [0, 1]
        0.0 = all completions identical (model is certain).
        1.0 = completions maximally dissimilar.
    """
    if n_samples < 2:
        raise ValueError("n_samples must be >= 2 to measure disagreement")

    completions: list[str] = []
    for _ in range(n_samples):
        try:
            out = generator.generate(
                prompt=text,
                max_new_tokens=128,
                temperature=0.8,
                top_p=0.9,
                top_k=0,
                repetition_penalty=1.1,
                stream=False,
            )
            completions.append(str(out))
        except Exception:  # noqa: BLE001
            completions.append("")

    # Mean pairwise normalised edit distance.
    total_dist = 0.0
    n_pairs = 0
    for i in range(len(completions)):
        for j in range(i + 1, len(completions)):
            a, b = completions[i], completions[j]
            max_len = max(len(a), len(b), 1)
            dist = _edit_distance(a, b) / max_len
            total_dist += dist
            n_pairs += 1

    if n_pairs == 0:
        return 0.0

    return min(total_dist / n_pairs, 1.0)


# ---------------------------------------------------------------------------
# score_dataset
# ---------------------------------------------------------------------------

def score_dataset(
    generator: ProverbsGenerator,
    data_dir: str | Path,
    max_examples: int = 200,
) -> list[dict]:
    """
    Load JSONL files from *data_dir*, sample up to *max_examples* user messages,
    score each by model uncertainty, and return results sorted descending.

    Each JSONL line must be ``{"messages": [{"role": ..., "content": ...}, ...]}``.
    Only lines that contain at least one user message are considered.

    Parameters
    ----------
    generator    : ProverbsGenerator
    data_dir     : Directory containing *.jsonl files.
    max_examples : Maximum number of examples to evaluate (randomly sampled when
                   the corpus is larger).

    Returns
    -------
    list of dicts, sorted by ``uncertainty`` descending::

        [
            {"filepath": "/path/to/file.jsonl", "text": "...", "uncertainty": 0.87},
            ...
        ]
    """
    data_path = Path(data_dir).expanduser().resolve()
    candidates: list[dict] = []

    for fpath in sorted(data_path.glob("*.jsonl")):
        try:
            with fpath.open("r", encoding="utf-8", errors="replace") as fh:
                for raw in fh:
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        obj = json.loads(raw)
                    except json.JSONDecodeError:
                        continue

                    messages = obj.get("messages")
                    if not isinstance(messages, list):
                        continue

                    # Extract the first user message as the prompt text.
                    user_text: str | None = None
                    for msg in messages:
                        if isinstance(msg, dict) and msg.get("role") == "user":
                            user_text = msg.get("content", "").strip()
                            break

                    if user_text:
                        candidates.append({"filepath": str(fpath), "text": user_text})
        except OSError:
            continue

    if not candidates:
        return []

    # Sub-sample if needed.
    if len(candidates) > max_examples:
        random.shuffle(candidates)
        candidates = candidates[:max_examples]

    # Score each candidate.
    scored: list[dict] = []
    for entry in candidates:
        uncertainty = compute_uncertainty(generator, entry["text"])
        scored.append({
            "filepath": entry["filepath"],
            "text": entry["text"],
            "uncertainty": uncertainty,
        })

    scored.sort(key=lambda x: x["uncertainty"], reverse=True)
    return scored


# ---------------------------------------------------------------------------
# ActiveDataset
# ---------------------------------------------------------------------------

class ActiveDataset(Dataset):
    """
    PyTorch Dataset built from the most uncertain examples returned by
    :func:`score_dataset`.

    Only the top ``top_fraction`` of scored examples (by uncertainty) are
    included.  Each example is tokenized and returned as a causal LM training
    pair ``(input_ids, labels)``.

    Parameters
    ----------
    scored_examples : list[dict]
        Output of :func:`score_dataset` (already sorted descending by uncertainty).
    tokenizer : ProverbsTokenizer
        Loaded tokenizer used to encode prompts.
    max_seq_len : int
        Sequences are truncated / padded to this length.
    top_fraction : float
        Fraction of *scored_examples* to keep (e.g. 0.3 = top 30 %).
    """

    def __init__(
        self,
        scored_examples: list[dict],
        tokenizer: ProverbsTokenizer,
        max_seq_len: int,
        top_fraction: float = 0.3,
    ) -> None:
        if not 0.0 < top_fraction <= 1.0:
            raise ValueError(f"top_fraction must be in (0, 1], got {top_fraction}")

        n_keep = max(1, int(len(scored_examples) * top_fraction))
        selected = scored_examples[:n_keep]  # already sorted descending

        self.max_seq_len = max_seq_len
        self._sequences: list[list[int]] = []

        for entry in selected:
            try:
                token_ids: list[int] = tokenizer.encode(entry["text"], add_bos=True)
            except Exception:  # noqa: BLE001
                token_ids = []
            if len(token_ids) >= MIN_SEQ_LEN:
                self._sequences.append(token_ids)

    # ------------------------------------------------------------------
    # Dataset interface
    # ------------------------------------------------------------------

    def __len__(self) -> int:
        return len(self._sequences)

    def __getitem__(self, idx: int) -> dict[str, torch.Tensor]:
        """
        Returns
        -------
        dict with keys:
          ``input_ids`` — LongTensor of shape (max_seq_len,)
          ``labels``    — LongTensor of shape (max_seq_len,); pad positions = -100
        """
        tokens = self._sequences[idx][: self.max_seq_len]
        seq_len = len(tokens)

        input_ids = torch.full((self.max_seq_len,), PAD_TOKEN_ID, dtype=torch.long)
        input_ids[:seq_len] = torch.tensor(tokens, dtype=torch.long)

        labels = input_ids.clone()
        labels[seq_len:] = LABEL_IGNORE_INDEX

        return {"input_ids": input_ids, "labels": labels}


# ---------------------------------------------------------------------------
# collate_fn (mirrors training/dataset.py)
# ---------------------------------------------------------------------------

def _collate_fn(batch: list[dict[str, torch.Tensor]]) -> dict[str, torch.Tensor]:
    input_ids = torch.stack([item["input_ids"] for item in batch], dim=0)
    labels = torch.stack([item["labels"] for item in batch], dim=0)
    return {"input_ids": input_ids, "labels": labels}


# ---------------------------------------------------------------------------
# build_active_loader
# ---------------------------------------------------------------------------

def build_active_loader(
    generator: ProverbsGenerator,
    data_dir: str | Path,
    tokenizer: ProverbsTokenizer,
    max_seq_len: int,
    batch_size: int = 4,
    top_fraction: float = 0.3,
) -> DataLoader:
    """
    End-to-end convenience function: score the dataset, build an
    :class:`ActiveDataset`, and return a :class:`~torch.utils.data.DataLoader`.

    Parameters
    ----------
    generator    : ProverbsGenerator (loaded model + tokenizer).
    data_dir     : Directory containing *.jsonl session files.
    tokenizer    : ProverbsTokenizer for encoding selected examples.
    max_seq_len  : Token sequence length (truncate/pad).
    batch_size   : DataLoader batch size.
    top_fraction : Fraction of most-uncertain examples to include.

    Returns
    -------
    DataLoader yielding ``{"input_ids": Tensor, "labels": Tensor}`` batches.
    """
    scored = score_dataset(generator, data_dir)
    dataset = ActiveDataset(
        scored_examples=scored,
        tokenizer=tokenizer,
        max_seq_len=max_seq_len,
        top_fraction=top_fraction,
    )
    return DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=True,
        num_workers=0,
        collate_fn=_collate_fn,
        pin_memory=torch.cuda.is_available(),
        drop_last=False,
    )


# ---------------------------------------------------------------------------
# Command-line interface
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Score dataset examples by model uncertainty (active learning).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--model",
        required=True,
        help="Path to a saved ProverbsLM .pt checkpoint.",
    )
    parser.add_argument(
        "--tokenizer",
        default="~/.proverbs/tokenizer.json",
        help="Path to the tokenizer JSON file.",
    )
    parser.add_argument(
        "--data-dir",
        default="~/.proverbs/sessions",
        dest="data_dir",
        help="Directory containing *.jsonl session files.",
    )
    parser.add_argument(
        "--top-fraction",
        type=float,
        default=0.3,
        dest="top_fraction",
        help="Fraction of most-uncertain examples to print (0 < f <= 1).",
    )
    parser.add_argument(
        "--max-examples",
        type=int,
        default=200,
        dest="max_examples",
        help="Maximum number of examples to evaluate.",
    )
    parser.add_argument(
        "--n-samples",
        type=int,
        default=3,
        dest="n_samples",
        help="Number of completions sampled per example to measure disagreement.",
    )
    parser.add_argument(
        "--device",
        default=None,
        help="Device to run on (cuda / mps / cpu).  Auto-detected if omitted.",
    )
    args = parser.parse_args()

    # Lazy import to avoid circular deps when used as a library.
    from model.proverbs_lm import ProverbsLM  # noqa: E402 (local)

    print(f"Loading model from {args.model} ...", file=sys.stderr)
    lm = ProverbsLM.load(args.model, device=args.device)
    print(f"  {lm}", file=sys.stderr)

    gen = ProverbsGenerator(
        model=lm,
        tokenizer_path=args.tokenizer,
        device=args.device,
    )

    print(f"Scoring examples in {args.data_dir} ...", file=sys.stderr)
    scored = score_dataset(gen, args.data_dir, max_examples=args.max_examples)

    if not scored:
        print("No scoreable examples found.", file=sys.stderr)
        sys.exit(1)

    n_show = max(1, int(len(scored) * args.top_fraction))
    top = scored[:n_show]

    print(f"\nTop {n_show} most uncertain examples (out of {len(scored)} scored):\n")
    for rank, entry in enumerate(top, 1):
        short_text = entry["text"][:120].replace("\n", " ")
        print(
            f"  [{rank:>3}] uncertainty={entry['uncertainty']:.4f}  "
            f"file={Path(entry['filepath']).name}  "
            f'text="{short_text}..."'
        )
