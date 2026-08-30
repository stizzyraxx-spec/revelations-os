"""
training/packed_dataset.py — Sequence-packing IterableDataset that concatenates
multiple documents end-to-end into fixed-length packs, eliminating padding waste.
"""

from __future__ import annotations

import json
import sys
import warnings
from pathlib import Path
from typing import Iterator

import torch
from torch.utils.data import DataLoader, IterableDataset

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from tokenizer.bpe import ProverbsTokenizer  # noqa: E402

LABEL_IGNORE_INDEX: int = -100


class PackedDataset(IterableDataset):
    """
    IterableDataset that packs multiple tokenised documents into fixed-length
    sequences of exactly *max_seq_len* tokens with no padding.

    Parameters
    ----------
    data_dir : str
        Directory containing *.jsonl files.  Each line must be a JSON object
        with a ``"messages"`` key (same format as ProverbsDataset / sessions).
    tokenizer : ProverbsTokenizer
        Already-loaded tokenizer instance.
    max_seq_len : int
        Every yielded pack is exactly this many tokens long.
    buffer_size : int
        Minimum number of token sequences to accumulate before emitting packs.
        Acts as a soft shuffle window — sequences are consumed FIFO once the
        buffer holds at least *buffer_size* entries.
    """

    def __init__(
        self,
        data_dir: str,
        tokenizer: ProverbsTokenizer,
        max_seq_len: int = 2048,
        buffer_size: int = 100,
    ) -> None:
        self.data_dir = Path(data_dir).expanduser().resolve()
        self.tokenizer = tokenizer
        self.max_seq_len = max_seq_len
        self.buffer_size = buffer_size

    # ------------------------------------------------------------------
    # IterableDataset interface
    # ------------------------------------------------------------------

    def __iter__(self) -> Iterator[dict]:
        yield from self._packed_iter()

    def _packed_iter(self) -> Iterator[dict]:
        token_buffer: list[int] = []
        # positions (indices into token_buffer) where each doc begins
        doc_start_positions: list[int] = []

        for seq in self._iter_sequences():
            doc_start_positions.append(len(token_buffer))
            token_buffer.extend(seq)

            # Emit as many full packs as possible
            while len(token_buffer) >= self.max_seq_len:
                pack_tokens = token_buffer[: self.max_seq_len]
                remaining_tokens = token_buffer[self.max_seq_len :]

                # Collect doc starts inside this pack; carry forward the rest
                pack_doc_starts: list[int] = []
                carry_doc_starts: list[int] = []
                for pos in doc_start_positions:
                    if pos < self.max_seq_len:
                        pack_doc_starts.append(pos)
                    else:
                        carry_doc_starts.append(pos - self.max_seq_len)

                token_buffer = remaining_tokens
                doc_start_positions = carry_doc_starts

                input_ids = torch.tensor(pack_tokens, dtype=torch.long)
                labels = input_ids.clone()
                # Mask prediction at the first token of every document except the
                # very first one in the pack — those tokens would require attending
                # to the previous document to form a useful prediction target.
                for ds in pack_doc_starts[1:]:
                    labels[ds] = LABEL_IGNORE_INDEX

                yield {
                    "input_ids": input_ids,
                    "labels": labels,
                    "document_starts": pack_doc_starts,
                }

        # Discard any leftover tokens (less than max_seq_len) — no padding emitted.

    def _iter_sequences(self) -> Iterator[list[int]]:
        """Yield tokenised sequences from every *.jsonl file in data_dir."""
        jsonl_files = sorted(self.data_dir.glob("*.jsonl"))
        if not jsonl_files:
            warnings.warn(
                f"No *.jsonl files found in {self.data_dir}.",
                stacklevel=3,
            )
            return

        for fpath in jsonl_files:
            try:
                yield from self._parse_file(fpath)
            except OSError as exc:
                warnings.warn(f"Could not read {fpath}: {exc}", stacklevel=3)

    def _parse_file(self, fpath: Path) -> Iterator[list[int]]:
        with fpath.open("r", encoding="utf-8", errors="replace") as fh:
            for lineno, raw in enumerate(fh, start=1):
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    obj = json.loads(raw)
                except json.JSONDecodeError as exc:
                    warnings.warn(
                        f"{fpath.name}:{lineno} — JSON parse error: {exc}",
                        stacklevel=4,
                    )
                    continue

                messages = obj.get("messages")
                if not isinstance(messages, list) or not messages:
                    continue

                try:
                    ids: list[int] = self.tokenizer.encode_chat(messages)
                except Exception as exc:  # noqa: BLE001
                    warnings.warn(
                        f"{fpath.name}:{lineno} — encode_chat failed: {exc}",
                        stacklevel=4,
                    )
                    continue

                if ids:
                    yield ids


# ---------------------------------------------------------------------------
# Collate
# ---------------------------------------------------------------------------

def pack_collate_fn(batch: list[dict]) -> dict[str, torch.Tensor]:
    """Stack input_ids and labels into (B, T) tensors; drop document_starts."""
    input_ids = torch.stack([item["input_ids"] for item in batch], dim=0)
    labels = torch.stack([item["labels"] for item in batch], dim=0)
    return {"input_ids": input_ids, "labels": labels}


# ---------------------------------------------------------------------------
# Loader factory
# ---------------------------------------------------------------------------

def make_packed_loader(
    data_dir: str,
    tokenizer: ProverbsTokenizer,
    max_seq_len: int,
    batch_size: int,
    num_workers: int = 0,
) -> DataLoader:
    """
    Return a DataLoader backed by PackedDataset.

    IterableDataset does not support shuffle — randomisation happens in the
    document buffer inside PackedDataset itself.
    """
    dataset = PackedDataset(
        data_dir=data_dir,
        tokenizer=tokenizer,
        max_seq_len=max_seq_len,
    )
    return DataLoader(
        dataset,
        batch_size=batch_size,
        collate_fn=pack_collate_fn,
        num_workers=num_workers,
        pin_memory=torch.cuda.is_available(),
    )


# ---------------------------------------------------------------------------
# Quick smoke-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="PackedDataset smoke-test")
    parser.add_argument("--data-dir", default="~/.proverbs/sessions")
    parser.add_argument("--tokenizer", default="~/.proverbs/tokenizer.json")
    parser.add_argument("--max-seq-len", type=int, default=512)
    parser.add_argument("--batch-size", type=int, default=4)
    args = parser.parse_args()

    tok = ProverbsTokenizer.load(
        str(Path(args.tokenizer).expanduser().resolve())
    )

    # ---- packed stats ----
    packed_ds = PackedDataset(
        data_dir=args.data_dir,
        tokenizer=tok,
        max_seq_len=args.max_seq_len,
    )

    pack_count = 0
    total_real_tokens = 0
    masked_positions = 0

    for item in packed_ds:
        pack_count += 1
        total_real_tokens += args.max_seq_len
        masked_positions += (item["labels"] == LABEL_IGNORE_INDEX).sum().item()

    if pack_count == 0:
        print("No packs produced — check data_dir and tokenizer.")
        sys.exit(1)

    packed_useful = total_real_tokens - masked_positions
    utilization_pct = 100.0 * packed_useful / total_real_tokens

    # ---- padding baseline (what ProverbsDataset would waste) ----
    # Re-scan raw sequences to compute padding waste
    raw_ds = PackedDataset(
        data_dir=args.data_dir,
        tokenizer=tok,
        max_seq_len=args.max_seq_len,
    )
    seq_lens: list[int] = []
    for seq in raw_ds._iter_sequences():
        seq_lens.append(min(len(seq), args.max_seq_len))

    if seq_lens:
        padded_useful = sum(seq_lens)
        padded_total = len(seq_lens) * args.max_seq_len
        padding_util = 100.0 * padded_useful / padded_total
    else:
        padding_util = 0.0

    print(f"Packs produced      : {pack_count}")
    print(f"Tokens per pack     : {args.max_seq_len}")
    print(f"Total packed tokens : {total_real_tokens:,}")
    print(f"Masked (boundary)   : {masked_positions:,}")
    print(f"Token utilization   : {utilization_pct:.1f}%  (packed, excl. boundary masks)")
    print(f"Padding baseline    : {padding_util:.1f}%  (map-style dataset with padding)")
    print(f"Packing gain        : +{utilization_pct - padding_util:.1f} pp")
