"""
training/dataset.py — ProverbsDataset for next-token-prediction fine-tuning.

Session data lives in ~/.proverbs/sessions/*.jsonl.
Each line is a JSON object: {"messages": [{"role": "...", "content": "..."}, ...]}

The dataset:
  1. Loads every *.jsonl file from sessions_dir.
  2. Tokenizes each conversation via ProverbsTokenizer.encode_chat().
  3. Filters sequences shorter than MIN_SEQ_LEN tokens.
  4. Deterministically splits: last (valid_ratio * N) sequences → "valid", rest → "train".
  5. Returns padded/truncated (input_ids, labels) pairs for causal LM training.
     Labels mirror input_ids; pad positions are set to -100 (ignored by cross_entropy).
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Sequence

import torch
from torch.utils.data import DataLoader, Dataset

# ---------------------------------------------------------------------------
# sys.path surgery — make sure project root is importable regardless of how
# this module is invoked (as part of the package or as a standalone script).
# ---------------------------------------------------------------------------
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from tokenizer.bpe import ProverbsTokenizer  # noqa: E402

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
MIN_SEQ_LEN: int = 8        # discard sequences shorter than this
PAD_TOKEN_ID: int = 0       # must match ProverbsConfig.pad_token_id
LABEL_IGNORE_INDEX: int = -100  # cross_entropy ignore_index


# ---------------------------------------------------------------------------
# Dataset
# ---------------------------------------------------------------------------

class ProverbsDataset(Dataset):
    """
    PyTorch Dataset for causal language-model training on Proverbs session data.

    Parameters
    ----------
    sessions_dir : str
        Directory that contains *.jsonl session files.
        Defaults to ``~/.proverbs/sessions``.
    tokenizer_path : str
        Path to a saved ``tokenizer.json`` produced by ``ProverbsTokenizer.save()``.
        Defaults to ``~/.proverbs/tokenizer.json``.
    max_seq_len : int
        Sequences are truncated (or padded) to this length.
    split : {"train", "valid"}
        Which portion of the data to expose.
    valid_ratio : float
        Fraction of total sequences reserved for validation.
        The *last* ``ceil(N * valid_ratio)`` sequences become the valid split;
        the rest become the train split.  Splitting is deterministic (no shuffle).
    """

    def __init__(
        self,
        sessions_dir: str = "~/.proverbs/sessions",
        tokenizer_path: str = "~/.proverbs/tokenizer.json",
        max_seq_len: int = 2048,
        split: str = "train",
        valid_ratio: float = 0.05,
    ) -> None:
        if split not in ("train", "valid"):
            raise ValueError(f"split must be 'train' or 'valid', got {split!r}")

        self.max_seq_len = max_seq_len
        self.split = split

        # Resolve paths (expand ~)
        sessions_path = Path(sessions_dir).expanduser().resolve()
        tok_path = Path(tokenizer_path).expanduser().resolve()

        # Load tokenizer
        tokenizer = ProverbsTokenizer.load(str(tok_path))

        # Load and tokenize all sessions
        all_sequences: list[list[int]] = _load_sessions(sessions_path, tokenizer)

        # Filter short sequences
        all_sequences = [seq for seq in all_sequences if len(seq) >= MIN_SEQ_LEN]

        if not all_sequences:
            raise RuntimeError(
                f"No sequences with >= {MIN_SEQ_LEN} tokens found in {sessions_path}. "
                "Train the tokenizer and ensure session JSONL files exist."
            )

        # Deterministic train/valid split — last fraction → valid
        n_total = len(all_sequences)
        n_valid = max(1, math.ceil(n_total * valid_ratio))
        n_train = n_total - n_valid

        if split == "train":
            self._sequences: list[list[int]] = all_sequences[:n_train]
        else:
            self._sequences = all_sequences[n_train:]

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
        tokens: list[int] = self._sequences[idx]

        # Truncate
        tokens = tokens[: self.max_seq_len]
        seq_len = len(tokens)

        # Build input_ids (pad to max_seq_len)
        input_ids = torch.full((self.max_seq_len,), PAD_TOKEN_ID, dtype=torch.long)
        input_ids[:seq_len] = torch.tensor(tokens, dtype=torch.long)

        # Labels mirror input_ids; pad positions → LABEL_IGNORE_INDEX
        labels = input_ids.clone()
        labels[seq_len:] = LABEL_IGNORE_INDEX

        return {"input_ids": input_ids, "labels": labels}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_sessions(
    sessions_dir: Path,
    tokenizer: ProverbsTokenizer,
) -> list[list[int]]:
    """
    Walk every *.jsonl file in *sessions_dir*, parse each line as
    ``{"messages": [...]}`` and call ``tokenizer.encode_chat(messages)``.

    Malformed lines are skipped with a warning; missing files are ignored.
    """
    sequences: list[list[int]] = []

    jsonl_files = sorted(sessions_dir.glob("*.jsonl"))
    if not jsonl_files:
        import warnings
        warnings.warn(
            f"No *.jsonl files found in {sessions_dir}. "
            "The dataset will be empty.",
            stacklevel=4,
        )
        return sequences

    for fpath in jsonl_files:
        try:
            _parse_jsonl_file(fpath, tokenizer, sequences)
        except OSError as exc:
            import warnings
            warnings.warn(f"Could not read {fpath}: {exc}", stacklevel=4)

    return sequences


def _parse_jsonl_file(
    fpath: Path,
    tokenizer: ProverbsTokenizer,
    out: list[list[int]],
) -> None:
    """Parse one JSONL file and append tokenized sequences to *out*."""
    with fpath.open("r", encoding="utf-8", errors="replace") as fh:
        for lineno, raw in enumerate(fh, start=1):
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError as exc:
                import warnings
                warnings.warn(
                    f"{fpath.name}:{lineno} — JSON parse error: {exc}",
                    stacklevel=5,
                )
                continue

            messages = obj.get("messages")
            if not isinstance(messages, list) or not messages:
                continue

            try:
                token_ids: list[int] = tokenizer.encode_chat(messages)
            except Exception as exc:  # noqa: BLE001
                import warnings
                warnings.warn(
                    f"{fpath.name}:{lineno} — encode_chat failed: {exc}",
                    stacklevel=5,
                )
                continue

            if token_ids:
                out.append(token_ids)


# ---------------------------------------------------------------------------
# collate_fn
# ---------------------------------------------------------------------------

def collate_fn(batch: list[dict[str, torch.Tensor]]) -> dict[str, torch.Tensor]:
    """
    Stack a list of ``__getitem__`` dicts into batched tensors.

    Parameters
    ----------
    batch : list of dicts, each containing ``input_ids`` and ``labels``
            tensors of shape (max_seq_len,).

    Returns
    -------
    dict with:
      ``input_ids`` — LongTensor of shape (B, max_seq_len)
      ``labels``    — LongTensor of shape (B, max_seq_len)
    """
    input_ids = torch.stack([item["input_ids"] for item in batch], dim=0)
    labels = torch.stack([item["labels"] for item in batch], dim=0)
    return {"input_ids": input_ids, "labels": labels}


# ---------------------------------------------------------------------------
# create_dataloader
# ---------------------------------------------------------------------------

def create_dataloader(
    dataset: ProverbsDataset,
    batch_size: int = 8,
    shuffle: bool = True,
    num_workers: int = 0,
) -> DataLoader:
    """
    Convenience wrapper around ``torch.utils.data.DataLoader``.

    Parameters
    ----------
    dataset     : ProverbsDataset instance.
    batch_size  : Number of sequences per batch.
    shuffle     : Whether to shuffle samples each epoch (True for train).
    num_workers : Number of subprocesses for data loading.

    Returns
    -------
    DataLoader configured with the project's ``collate_fn``.
    """
    return DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=shuffle,
        num_workers=num_workers,
        collate_fn=collate_fn,
        pin_memory=torch.cuda.is_available(),
        drop_last=False,
    )
