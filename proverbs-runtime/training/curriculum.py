"""
training/curriculum.py — Difficulty-aware curriculum data scheduler.

Sorts examples from easiest to hardest (by length + char-level entropy), then
gradually unlocks harder stages as training progresses so the model sees easy
examples first and harder ones only after warmup_fraction of training is done.
"""

from __future__ import annotations

import math
import sys
from collections import Counter
from pathlib import Path
from typing import Iterator

import torch
from torch.utils.data import DataLoader, Dataset

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from training.dataset import collate_fn  # noqa: E402
from training.trainer import ProverbsTrainer, _infinite  # noqa: E402


# ---------------------------------------------------------------------------
# Difficulty estimation
# ---------------------------------------------------------------------------

def estimate_difficulty(text: str) -> float:
    """
    Return a float in [0, 1] where 0 = easiest, 1 = hardest.

    difficulty = 0.5 * normalized_length + 0.5 * normalized_entropy
      normalized_length = min(len(text) / 2000, 1.0)
      normalized_entropy = char-level Shannon entropy / log2(256)  (scaled to [0,1])
    """
    if not text:
        return 0.0

    normalized_length = min(len(text) / 2000.0, 1.0)

    counts = Counter(text)
    total = len(text)
    entropy = 0.0
    for c in counts.values():
        p = c / total
        entropy -= p * math.log2(p)
    # max possible char entropy is log2(256) = 8.0
    normalized_entropy = min(entropy / 8.0, 1.0)

    return 0.5 * normalized_length + 0.5 * normalized_entropy


# ---------------------------------------------------------------------------
# CurriculumDataset
# ---------------------------------------------------------------------------

class CurriculumDataset(Dataset):
    """
    Wraps a ProverbsDataset (or any Dataset whose __getitem__ returns a dict
    with 'input_ids' and 'labels' LongTensors) and exposes only the examples
    whose difficulty falls within the current curriculum stage.

    Parameters
    ----------
    base_dataset    : Source dataset; must support integer indexing.
    tokenizer       : ProverbsTokenizer, used to decode token ids to text for
                      difficulty estimation.
    n_stages        : Number of equal-width difficulty buckets (default 4).
    warmup_fraction : Training fraction at which all stages are unlocked (default 0.2).
    """

    def __init__(
        self,
        base_dataset: Dataset,
        tokenizer,
        n_stages: int = 4,
        warmup_fraction: float = 0.2,
    ) -> None:
        self.base_dataset = base_dataset
        self.tokenizer = tokenizer
        self.n_stages = n_stages
        self.warmup_fraction = warmup_fraction
        self.current_stage = 0

        # stage_thresholds[i] is the upper difficulty bound for stage i
        self.stage_thresholds = [i / n_stages for i in range(1, n_stages + 1)]

        # Precompute difficulty score for every example
        n = len(base_dataset)  # type: ignore[arg-type]
        difficulties: list[tuple[float, int]] = []
        for i in range(n):
            item = base_dataset[i]
            ids: list[int] = item["input_ids"].tolist()
            # strip pads (0) and decode
            real_ids = [t for t in ids if t != 0]
            text = tokenizer.decode(real_ids, skip_special=True)
            difficulties.append((estimate_difficulty(text), i))

        # Sort ascending by difficulty
        difficulties.sort(key=lambda x: x[0])

        self._sorted_difficulties: list[float] = [d for d, _ in difficulties]
        self._sorted_indices: list[int] = [i for _, i in difficulties]

        # Precompute the cutoff index for each stage (number of examples available)
        self._stage_sizes: list[int] = []
        for threshold in self.stage_thresholds:
            count = sum(1 for d in self._sorted_difficulties if d <= threshold)
            # always expose at least one example per stage
            self._stage_sizes.append(max(count, 1))
        # final stage always covers everything
        self._stage_sizes[-1] = n

    # ------------------------------------------------------------------

    def set_progress(self, fraction: float) -> None:
        """
        Update current_stage based on how far through training we are.

        fraction : 0.0 = start, 1.0 = end.
        At fraction >= warmup_fraction, all stages are unlocked (current_stage
        becomes n_stages - 1).
        """
        if fraction >= self.warmup_fraction:
            self.current_stage = self.n_stages - 1
        else:
            # Linearly map [0, warmup_fraction) → [0, n_stages)
            ratio = fraction / max(self.warmup_fraction, 1e-9)
            self.current_stage = min(int(ratio * self.n_stages), self.n_stages - 1)

    def _available_size(self) -> int:
        return self._stage_sizes[self.current_stage]

    def __len__(self) -> int:
        return self._available_size()

    def __getitem__(self, idx: int) -> dict[str, torch.Tensor]:
        n = self._available_size()
        if idx < 0 or idx >= n:
            raise IndexError(f"index {idx} out of range for CurriculumDataset with {n} examples")
        base_idx = self._sorted_indices[idx]
        return self.base_dataset[base_idx]


# ---------------------------------------------------------------------------
# CurriculumTrainer
# ---------------------------------------------------------------------------

class CurriculumTrainer(ProverbsTrainer):
    """
    ProverbsTrainer subclass that calls train_dataset.set_progress() every
    log_every steps and rebuilds the DataLoader whenever the stage advances.

    The train_loader passed in must have been built from a CurriculumDataset;
    CurriculumTrainer keeps a reference to the dataset to detect stage changes.
    """

    def train(self) -> None:
        """Training loop with curriculum stage gating."""
        import time

        try:
            from tqdm import tqdm as _tqdm
            _has_tqdm = True
        except ImportError:
            _has_tqdm = False

        self.model.train()

        # Resolve the CurriculumDataset from the loader
        cur_dataset: CurriculumDataset | None = None
        ds = self.train_loader.dataset
        if isinstance(ds, CurriculumDataset):
            cur_dataset = ds

        data_iter: Iterator[dict[str, torch.Tensor]] = _infinite(self.train_loader)

        # Snapshot batch size / worker settings for DataLoader rebuilds
        batch_size = self.train_loader.batch_size or 8
        num_workers = self.train_loader.num_workers

        # Tokens-per-batch estimate
        sample = next(data_iter)
        tokens_per_batch: int = int(sample["input_ids"].numel())
        data_iter = _infinite(self.train_loader)

        if _has_tqdm:
            pbar = _tqdm(total=self.max_steps, initial=self.step, desc="curriculum", unit="step")
        else:
            pbar = None

        t0 = time.perf_counter()
        last_stage = cur_dataset.current_stage if cur_dataset is not None else -1

        import torch.nn as nn

        while self.step < self.max_steps:
            # Update curriculum progress every log_every steps
            if cur_dataset is not None and self.step % self.log_every == 0:
                fraction = self.step / max(self.max_steps, 1)
                cur_dataset.set_progress(fraction)

                # Rebuild loader if stage changed
                if cur_dataset.current_stage != last_stage:
                    last_stage = cur_dataset.current_stage
                    self.train_loader = DataLoader(
                        cur_dataset,
                        batch_size=batch_size,
                        shuffle=True,
                        num_workers=num_workers,
                        collate_fn=collate_fn,
                        pin_memory=torch.cuda.is_available(),
                        drop_last=False,
                    )
                    data_iter = _infinite(self.train_loader)
                    print(
                        f"[curriculum] stage={last_stage + 1}/{cur_dataset.n_stages}  "
                        f"examples={len(cur_dataset)}  step={self.step}"
                    )

            batch = next(data_iter)
            input_ids = batch["input_ids"].to(self.device, non_blocking=True)
            labels = batch["labels"].to(self.device, non_blocking=True)

            labels = labels.clone()
            labels[labels == -100] = self.cfg.pad_token_id

            self.optimizer.zero_grad(set_to_none=True)

            with torch.autocast(device_type=self.device, enabled=self.use_amp, dtype=self.amp_dtype):
                out = self.model(input_ids=input_ids, labels=labels)
                loss: torch.Tensor = out["loss"]

            self.scaler.scale(loss).backward()

            if self.grad_clip and self.grad_clip > 0:
                self.scaler.unscale_(self.optimizer)
                nn.utils.clip_grad_norm_(self.model.parameters(), self.grad_clip)

            self.scaler.step(self.optimizer)
            self.scaler.update()

            from training.trainer import _cosine_lr, _set_lr
            new_lr = _cosine_lr(self.step, self.warmup_steps, self.max_steps, self.lr)
            _set_lr(self.optimizer, new_lr)

            self.step += 1

            if self.step % self.log_every == 0:
                t1 = time.perf_counter()
                elapsed = t1 - t0
                tok_per_sec = tokens_per_batch * self.log_every / max(elapsed, 1e-9)
                t0 = t1

                mem_str = ""
                if self.device == "cuda":
                    alloc_gb = torch.cuda.memory_allocated() / 1e9
                    reserved_gb = torch.cuda.memory_reserved() / 1e9
                    mem_str = f"  mem={alloc_gb:.1f}/{reserved_gb:.1f}GB"

                stage_str = (
                    f"  stage={cur_dataset.current_stage + 1}/{cur_dataset.n_stages}"
                    if cur_dataset is not None else ""
                )
                msg = (
                    f"step={self.step:>6d}/{self.max_steps}  "
                    f"loss={loss.item():.4f}  "
                    f"lr={new_lr:.2e}  "
                    f"tok/s={tok_per_sec:,.0f}"
                    f"{stage_str}{mem_str}"
                )
                if pbar is not None:
                    pbar.set_postfix_str(
                        f"loss={loss.item():.4f} lr={new_lr:.2e} tok/s={tok_per_sec:,.0f}{stage_str}"
                    )
                    pbar.update(self.log_every)
                else:
                    print(msg)

            if self.step % self.eval_every == 0:
                valid_loss = self.evaluate()
                is_best = valid_loss < self.best_valid_loss
                if is_best:
                    self.best_valid_loss = valid_loss
                self.save_checkpoint(self.step, is_best=is_best)
                best_str = "  *** new best ***" if is_best else ""
                print(
                    f"[eval]  step={self.step}  valid_loss={valid_loss:.4f}"
                    f"  best={self.best_valid_loss:.4f}{best_str}"
                )
                self.model.train()

            elif self.step % self.save_every == 0:
                self.save_checkpoint(self.step, is_best=False)

        if pbar is not None:
            pbar.close()

        print(
            f"[curriculum] Training complete at step {self.step}.  "
            f"Best valid loss: {self.best_valid_loss:.4f}"
        )
