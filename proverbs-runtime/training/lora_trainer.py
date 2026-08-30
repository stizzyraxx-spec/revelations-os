"""
training/lora_trainer.py — LoraTrainer

Fine-tunes only the LoRA adapter parameters of a LoraModel.
Same cosine LR + BF16 AMP pattern as ProverbsTrainer.
"""

from __future__ import annotations

import math
import sys
import time
from pathlib import Path
from typing import Iterator

import torch
import torch.nn as nn
from torch.utils.data import DataLoader

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from model.lora import LoraModel  # noqa: E402

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


def _cosine_lr(
    step: int,
    warmup_steps: int,
    max_steps: int,
    lr_max: float,
    lr_min: float = 1e-6,
) -> float:
    if step < warmup_steps:
        return lr_max * (step + 1) / max(warmup_steps, 1)
    progress = (step - warmup_steps) / max(max_steps - warmup_steps, 1)
    progress = min(progress, 1.0)
    return lr_min + 0.5 * (lr_max - lr_min) * (1.0 + math.cos(math.pi * progress))


def _set_lr(optimizer: torch.optim.Optimizer, lr: float) -> None:
    for group in optimizer.param_groups:
        group["lr"] = lr


def _infinite(loader: DataLoader) -> Iterator[dict[str, torch.Tensor]]:
    while True:
        yield from loader


class LoraTrainer:
    def __init__(
        self,
        lora_model: LoraModel,
        train_loader: DataLoader,
        valid_loader: DataLoader,
        output_dir: str = "~/.proverbs/checkpoints",
        lr: float = 1e-4,
        max_steps: int = 500,
        grad_clip: float = 1.0,
        log_every: int = 10,
        eval_every: int = 100,
    ) -> None:
        self.train_loader = train_loader
        self.valid_loader = valid_loader
        self.lr = lr
        self.max_steps = max_steps
        self.grad_clip = grad_clip
        self.log_every = log_every
        self.eval_every = eval_every

        self.output_dir = Path(output_dir).expanduser().resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)

        self.device = _best_device()

        # Ensure base params are frozen; move model to device
        for param in lora_model.base.parameters():
            param.requires_grad = False
        self.model: LoraModel = lora_model.to(self.device)

        # Optimizer over lora parameters only
        lora_params = list(self.model.lora_parameters())
        self.optimizer = torch.optim.AdamW(
            lora_params,
            lr=lr,
            betas=(0.9, 0.95),
            eps=1e-8,
        )

        # BF16 AMP (same policy as ProverbsTrainer)
        self.use_amp = self.device in ("cuda", "cpu")
        if self.device == "cuda" and torch.cuda.is_bf16_supported():
            self.amp_dtype = torch.bfloat16
        elif self.device == "cpu":
            self.amp_dtype = torch.bfloat16
        else:
            self.amp_dtype = torch.float16
        self.scaler = torch.cuda.amp.GradScaler(
            enabled=self.use_amp and self.amp_dtype == torch.float16
        )

        self.step: int = 0
        self.best_valid_loss: float = float("inf")

        n_lora = sum(p.numel() for p in lora_params)
        amp_label = str(self.amp_dtype).split(".")[-1] if self.use_amp else "off"
        print(
            f"[lora_trainer] LoraTrainer ready  |  "
            f"lora_params={n_lora/1e3:.1f}K  |  "
            f"device={self.device}  |  "
            f"AMP={amp_label}  |  "
            f"output={self.output_dir}"
        )

    def train(self) -> None:
        self.model.train()
        data_iter = _infinite(self.train_loader)

        pad_id = self.model.base.cfg.pad_token_id

        if _HAS_TQDM:
            pbar = _tqdm(total=self.max_steps, initial=self.step, desc="lora-train", unit="step")
        else:
            pbar = None

        t0 = time.perf_counter()

        while self.step < self.max_steps:
            batch = next(data_iter)
            input_ids: torch.Tensor = batch["input_ids"].to(self.device, non_blocking=True)
            labels: torch.Tensor    = batch["labels"].to(self.device, non_blocking=True)

            labels = labels.clone()
            labels[labels == -100] = pad_id

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

            new_lr = _cosine_lr(self.step, warmup_steps=max(self.max_steps // 10, 10),
                                 max_steps=self.max_steps, lr_max=self.lr)
            _set_lr(self.optimizer, new_lr)

            self.step += 1

            if self.step % self.log_every == 0:
                t1 = time.perf_counter()
                elapsed = t1 - t0
                t0 = t1
                msg = (
                    f"step={self.step:>5d}/{self.max_steps}  "
                    f"loss={loss.item():.4f}  "
                    f"lr={new_lr:.2e}  "
                    f"elapsed={elapsed:.1f}s"
                )
                if pbar is not None:
                    pbar.set_postfix_str(f"loss={loss.item():.4f} lr={new_lr:.2e}")
                    pbar.update(self.log_every)
                else:
                    print(msg)

            if self.step % self.eval_every == 0:
                valid_loss = self.evaluate()
                is_best = valid_loss < self.best_valid_loss
                if is_best:
                    self.best_valid_loss = valid_loss
                    adapter_path = self.output_dir / "adapter.pt"
                    self.model.save_adapter(adapter_path)
                    print(f"[lora_trainer] Saved adapter → {adapter_path}")
                print(
                    f"[lora_eval]  step={self.step}  valid_loss={valid_loss:.4f}"
                    f"  best={self.best_valid_loss:.4f}"
                    + ("  *** new best ***" if is_best else "")
                )
                self.model.train()

        if pbar is not None:
            pbar.close()

        print(f"[lora_trainer] Training complete at step {self.step}.  Best valid loss: {self.best_valid_loss:.4f}")

    def evaluate(self) -> float:
        self.model.eval()
        total_loss = 0.0
        total_batches = 0
        pad_id = self.model.base.cfg.pad_token_id

        with torch.no_grad():
            for batch in self.valid_loader:
                input_ids = batch["input_ids"].to(self.device, non_blocking=True)
                labels    = batch["labels"].to(self.device, non_blocking=True)

                labels = labels.clone()
                labels[labels == -100] = pad_id

                with torch.autocast(device_type=self.device, enabled=self.use_amp, dtype=self.amp_dtype):
                    out = self.model(input_ids=input_ids, labels=labels)

                total_loss += out["loss"].item()
                total_batches += 1

        if total_batches == 0:
            return float("inf")
        return total_loss / total_batches
