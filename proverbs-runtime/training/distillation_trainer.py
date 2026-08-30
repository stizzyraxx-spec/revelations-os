"""
training/distillation_trainer.py — DistillationTrainer

Knowledge distillation: trains a ProverbsLM student to mimic a larger teacher
model by combining soft-target KL-divergence loss with standard hard-label
cross-entropy, using the same AdamW + cosine-LR loop as ProverbsTrainer.
"""

from __future__ import annotations

import math
import os
import sys
import time
from pathlib import Path
from typing import Callable, Iterator

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader

# ---------------------------------------------------------------------------
# Project root on sys.path
# ---------------------------------------------------------------------------
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from model.config import ProverbsConfig       # noqa: E402
from model.proverbs_lm import ProverbsLM      # noqa: E402

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
# LR schedule helpers (mirrors trainer.py)
# ---------------------------------------------------------------------------

def _cosine_lr(
    step: int,
    warmup_steps: int,
    max_steps: int,
    lr_max: float,
    lr_min: float = 1e-5,
) -> float:
    """Linear warmup then cosine decay to lr_min."""
    if step < warmup_steps:
        return lr_max * (step + 1) / max(warmup_steps, 1)
    progress = (step - warmup_steps) / max(max_steps - warmup_steps, 1)
    progress = min(progress, 1.0)
    return lr_min + 0.5 * (lr_max - lr_min) * (1.0 + math.cos(math.pi * progress))


def _set_lr(optimizer: torch.optim.Optimizer, lr: float) -> None:
    for group in optimizer.param_groups:
        group["lr"] = lr


def _infinite(loader: DataLoader) -> Iterator[dict[str, torch.Tensor]]:
    """Yield batches forever, restarting the loader each epoch."""
    while True:
        yield from loader


# ---------------------------------------------------------------------------
# Parameter grouping (mirrors trainer.py _split_params)
# ---------------------------------------------------------------------------

def _split_params(
    model: nn.Module,
) -> tuple[list[torch.nn.Parameter], list[torch.nn.Parameter]]:
    """Separate weight-decay params from bias / norm params."""
    decay: list[torch.nn.Parameter] = []
    no_decay: list[torch.nn.Parameter] = []
    for name, param in model.named_parameters():
        if not param.requires_grad:
            continue
        if param.ndim == 1 or name.endswith(".bias"):
            no_decay.append(param)
        else:
            decay.append(param)
    return decay, no_decay


# ---------------------------------------------------------------------------
# DistillationTrainer
# ---------------------------------------------------------------------------

class DistillationTrainer:
    """
    Knowledge-distillation training loop for ProverbsLM.

    The student is trained to minimize a weighted combination of:
      - Soft-target loss: KL-divergence between temperature-scaled teacher and
        student distributions (scaled by T^2 to preserve gradient magnitudes).
      - Hard-label loss: standard cross-entropy against ground-truth token IDs.

    Parameters
    ----------
    student           : ProverbsLM instance to be trained (moved to device here).
    teacher_generate_fn : Callable (input_ids) -> logits Tensor[B, T, vocab].
                          Can wrap a GGUF back-end or any other inference engine.
                          Called under torch.no_grad() — no grad graph required.
    train_loader      : DataLoader yielding {"input_ids": ..., "labels": ...}.
    valid_loader      : DataLoader for periodic validation.
    tokenizer         : ProverbsTokenizer (used to resolve pad_token_id when cfg
                        is not supplied).
    temperature       : Distillation temperature T.  Higher values soften the
                        teacher distribution more.  Default: 4.0.
    alpha             : Weight on the soft-target loss.  (1 - alpha) goes to the
                        hard-label loss.  Default: 0.5.
    lr                : Peak AdamW learning rate.  Default: 3e-4.
    warmup_steps      : Linear LR warmup steps before cosine decay.
    max_steps         : Total optimiser steps.
    grad_clip         : Max gradient L2 norm (0 / None disables).
    log_every         : Log metrics every N steps.
    eval_every        : Validate every N steps.
    save_every        : Save periodic checkpoint every N steps.
    use_amp           : Enable automatic mixed precision (CUDA / CPU).
    compile_model     : Call torch.compile() on the student (PyTorch >= 2.0).
    output_dir        : Directory for checkpoints.
    """

    def __init__(
        self,
        student: ProverbsLM,
        teacher_generate_fn: Callable[[torch.Tensor], torch.Tensor],
        train_loader: DataLoader,
        valid_loader: DataLoader,
        tokenizer,
        temperature: float = 4.0,
        alpha: float = 0.5,
        lr: float = 3e-4,
        warmup_steps: int = 100,
        max_steps: int = 5_000,
        grad_clip: float = 1.0,
        log_every: int = 10,
        eval_every: int = 500,
        save_every: int = 1_000,
        use_amp: bool = True,
        compile_model: bool = False,
        output_dir: str = "~/.proverbs/checkpoints",
    ) -> None:
        self.teacher_generate_fn = teacher_generate_fn
        self.train_loader = train_loader
        self.valid_loader = valid_loader
        self.tokenizer = tokenizer
        self.temperature = temperature
        self.alpha = alpha
        self.lr = lr
        self.warmup_steps = warmup_steps
        self.max_steps = max_steps
        self.grad_clip = grad_clip
        self.log_every = log_every
        self.eval_every = eval_every
        self.save_every = save_every

        # Output directory
        self.output_dir = Path(output_dir).expanduser().resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)

        # Device
        self.device = _best_device()

        # Student model
        self.student: ProverbsLM = student.to(self.device)
        self.cfg: ProverbsConfig = student.cfg

        # pad_token_id for ignore-index remapping
        self.pad_token_id: int = getattr(self.cfg, "pad_token_id", 0)

        # Optional torch.compile
        if compile_model:
            if not hasattr(torch, "compile"):
                print("[distill] WARNING: torch.compile not available (requires PyTorch >= 2.0). Skipping.")
            else:
                print("[distill] Compiling student with torch.compile ...")
                self.student = torch.compile(self.student)  # type: ignore[assignment]

        # Optimizer — AdamW with parameter groups
        decay_params, nodecay_params = _split_params(self.student)
        self.optimizer = torch.optim.AdamW(
            [
                {"params": decay_params,   "weight_decay": 0.1},
                {"params": nodecay_params, "weight_decay": 0.0},
            ],
            lr=lr,
            betas=(0.9, 0.95),
            eps=1e-8,
            fused=self.device == "cuda",
        )

        # AMP
        self.use_amp = use_amp and (self.device in ("cuda", "cpu"))
        if self.device == "cuda" and torch.cuda.is_bf16_supported():
            self.amp_dtype = torch.bfloat16
        elif self.device == "cpu":
            self.amp_dtype = torch.bfloat16
        else:
            self.amp_dtype = torch.float16
        self.scaler = torch.cuda.amp.GradScaler(
            enabled=self.use_amp and self.amp_dtype == torch.float16
        )

        # Training state
        self.step: int = 0
        self.best_valid_loss: float = float("inf")

        n_params = self.student.param_count() if hasattr(self.student, "param_count") else sum(
            p.numel() for p in self.student.parameters()
        )
        amp_label = f"{str(self.amp_dtype).split('.')[-1]}" if self.use_amp else "off"
        print(
            f"[distill] DistillationTrainer ready  |  "
            f"student_params={n_params / 1e6:.1f}M  |  "
            f"device={self.device}  |  "
            f"AMP={amp_label}  |  "
            f"T={self.temperature}  alpha={self.alpha}  |  "
            f"output={self.output_dir}"
        )

    # ------------------------------------------------------------------
    # Loss
    # ------------------------------------------------------------------

    def _distillation_loss(
        self,
        student_logits: torch.Tensor,   # (B, T, vocab)
        teacher_logits: torch.Tensor,   # (B, T, vocab) — same shape required
    ) -> torch.Tensor:
        """
        Soft-target KL-divergence loss scaled by T^2.

        KL(soft_teacher || soft_student) * T^2

        The T^2 rescaling compensates for the 1/T^2 gradient shrinkage that
        temperature introduces, ensuring the soft-target gradient magnitude is
        comparable to the hard-label cross-entropy gradient.
        """
        T = self.temperature
        # Flatten batch and time dimensions for batchmean reduction
        B, Tlen, V = student_logits.shape
        s_flat = student_logits.view(B * Tlen, V)
        t_flat = teacher_logits.view(B * Tlen, V)

        soft_targets = F.softmax(t_flat / T, dim=-1)
        log_probs    = F.log_softmax(s_flat / T, dim=-1)

        return F.kl_div(log_probs, soft_targets, reduction="batchmean") * T * T

    # ------------------------------------------------------------------
    # Single train step
    # ------------------------------------------------------------------

    def train_step(self, batch: dict[str, torch.Tensor]) -> dict[str, float]:
        """
        Execute one forward + backward pass.

        Returns a dict with keys: loss, distill_loss, hard_loss.
        Optimizer step and LR update are NOT performed here — they remain in
        the main train() loop so gradient clipping and AMP scaler can be applied
        consistently.
        """
        input_ids: torch.Tensor = batch["input_ids"].to(self.device, non_blocking=True)
        labels: torch.Tensor    = batch["labels"].to(self.device, non_blocking=True)

        # Remap dataset ignore index (-100) to model's pad_token_id
        labels = labels.clone()
        labels[labels == -100] = self.pad_token_id

        self.optimizer.zero_grad(set_to_none=True)

        # ----- Teacher forward (no gradients) --------------------------------
        with torch.no_grad():
            teacher_logits: torch.Tensor = self.teacher_generate_fn(input_ids)
            # Ensure teacher logits are on the same device / dtype as student
            teacher_logits = teacher_logits.to(device=self.device, dtype=torch.float32)

        # ----- Student forward -----------------------------------------------
        with torch.autocast(device_type=self.device, enabled=self.use_amp, dtype=self.amp_dtype):
            student_out = self.student(input_ids=input_ids, labels=labels)
            student_logits: torch.Tensor = student_out["logits"].float()  # (B, T, vocab)
            hard_loss: torch.Tensor = student_out["loss"]

            # Align sequence lengths (teacher may differ if GGUF trims tokens)
            T_len = min(student_logits.size(1), teacher_logits.size(1))
            distill_loss = self._distillation_loss(
                student_logits[:, :T_len, :],
                teacher_logits[:, :T_len, :],
            )

            loss = self.alpha * distill_loss + (1.0 - self.alpha) * hard_loss

        # ----- Backward ------------------------------------------------------
        self.scaler.scale(loss).backward()

        return {
            "loss":         loss.item(),
            "distill_loss": distill_loss.item(),
            "hard_loss":    hard_loss.item(),
        }

    # ------------------------------------------------------------------
    # Main training loop
    # ------------------------------------------------------------------

    def train(self) -> None:
        """Run the distillation loop until max_steps is reached."""
        self.student.train()
        data_iter = _infinite(self.train_loader)

        # Peek at first batch to compute tokens_per_batch
        _peek = next(data_iter)
        tokens_per_batch: int = int(_peek["input_ids"].numel())
        data_iter = _infinite(self.train_loader)

        if _HAS_TQDM:
            pbar = _tqdm(total=self.max_steps, initial=self.step, desc="distill", unit="step")
        else:
            pbar = None

        t0 = time.perf_counter()

        while self.step < self.max_steps:
            batch = next(data_iter)

            # train_step handles forward + backward, returns raw loss values
            metrics = self.train_step(batch)

            # Gradient clip
            if self.grad_clip and self.grad_clip > 0:
                self.scaler.unscale_(self.optimizer)
                nn.utils.clip_grad_norm_(self.student.parameters(), self.grad_clip)

            # Optimizer + scaler update
            self.scaler.step(self.optimizer)
            self.scaler.update()

            # LR schedule
            new_lr = _cosine_lr(self.step, self.warmup_steps, self.max_steps, self.lr)
            _set_lr(self.optimizer, new_lr)

            self.step += 1

            # Logging
            if self.step % self.log_every == 0:
                t1 = time.perf_counter()
                elapsed = t1 - t0
                tok_per_sec = tokens_per_batch * self.log_every / max(elapsed, 1e-9)
                t0 = t1

                mem_str = ""
                if self.device == "cuda":
                    alloc_gb   = torch.cuda.memory_allocated() / 1e9
                    reserve_gb = torch.cuda.memory_reserved() / 1e9
                    mem_str = f"  mem={alloc_gb:.1f}/{reserve_gb:.1f}GB"

                msg = (
                    f"step={self.step:>6d}/{self.max_steps}  "
                    f"loss={metrics['loss']:.4f}  "
                    f"distill={metrics['distill_loss']:.4f}  "
                    f"hard={metrics['hard_loss']:.4f}  "
                    f"lr={new_lr:.2e}  "
                    f"tok/s={tok_per_sec:,.0f}"
                    f"{mem_str}"
                )
                if pbar is not None:
                    pbar.set_postfix_str(
                        f"loss={metrics['loss']:.4f} "
                        f"distill={metrics['distill_loss']:.4f} "
                        f"hard={metrics['hard_loss']:.4f} "
                        f"lr={new_lr:.2e}"
                    )
                    pbar.update(self.log_every)
                else:
                    print(msg)

            # Evaluation
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
                self.student.train()

            # Periodic checkpoint (skip if eval already saved this step)
            elif self.step % self.save_every == 0:
                self.save_checkpoint(self.step, is_best=False)

        if pbar is not None:
            pbar.close()

        print(
            f"[distill] Training complete at step {self.step}.  "
            f"Best valid loss: {self.best_valid_loss:.4f}"
        )

    # ------------------------------------------------------------------
    # Evaluation
    # ------------------------------------------------------------------

    def evaluate(self) -> float:
        """
        Run the student over valid_loader and return mean hard-label cross-entropy
        loss (no teacher needed — we measure language-model quality directly).
        """
        self.student.eval()
        total_loss = 0.0
        total_batches = 0

        with torch.no_grad():
            for batch in self.valid_loader:
                input_ids = batch["input_ids"].to(self.device, non_blocking=True)
                labels    = batch["labels"].to(self.device, non_blocking=True)

                labels = labels.clone()
                labels[labels == -100] = self.pad_token_id

                with torch.autocast(device_type=self.device, enabled=self.use_amp, dtype=self.amp_dtype):
                    out = self.student(input_ids=input_ids, labels=labels)

                total_loss += out["loss"].item()
                total_batches += 1

        if total_batches == 0:
            return float("inf")
        return total_loss / total_batches

    # ------------------------------------------------------------------
    # Checkpointing
    # ------------------------------------------------------------------

    def save_checkpoint(self, step: int, is_best: bool = False) -> None:
        """Save student weights, optimizer, scaler, and trainer metadata."""
        ckpt_path = self.output_dir / f"distill-checkpoint-{step}.pt"
        payload = {
            "step":                step,
            "best_valid_loss":     self.best_valid_loss,
            "model_state_dict": (
                self.student._orig_mod.state_dict()   # unwrap torch.compile
                if hasattr(self.student, "_orig_mod")
                else self.student.state_dict()
            ),
            "optimizer_state_dict": self.optimizer.state_dict(),
            "scaler_state_dict":    self.scaler.state_dict(),
            "config":               self.cfg.__dict__,
            "distill_config": {
                "temperature": self.temperature,
                "alpha":       self.alpha,
                "lr":          self.lr,
                "max_steps":   self.max_steps,
            },
        }
        torch.save(payload, ckpt_path)
        print(f"[distill] Saved checkpoint → {ckpt_path}")

        if is_best:
            best_path = self.output_dir / "distill-best.pt"
            torch.save(payload, best_path)
            print(f"[distill] Saved best model → {best_path}")

    # ------------------------------------------------------------------
    # Resume
    # ------------------------------------------------------------------

    @classmethod
    def resume(
        cls,
        checkpoint_path: str,
        teacher_generate_fn: Callable[[torch.Tensor], torch.Tensor],
        train_loader: DataLoader,
        valid_loader: DataLoader,
        tokenizer,
        **kwargs,
    ) -> "DistillationTrainer":
        """
        Restore a DistillationTrainer from a saved checkpoint and return it
        ready to continue training.
        """
        device = _best_device()
        print(f"[distill] Resuming from {checkpoint_path} ...")
        payload = torch.load(checkpoint_path, map_location=device, weights_only=False)

        cfg     = ProverbsConfig(**payload["config"])
        student = ProverbsLM(cfg)
        student.load_state_dict(payload["model_state_dict"])

        dc = payload.get("distill_config", {})
        kwargs.setdefault("temperature", dc.get("temperature", 4.0))
        kwargs.setdefault("alpha",       dc.get("alpha",       0.5))
        kwargs.setdefault("lr",          dc.get("lr",          3e-4))
        kwargs.setdefault("max_steps",   dc.get("max_steps",   5_000))

        trainer = cls(
            student=student,
            teacher_generate_fn=teacher_generate_fn,
            train_loader=train_loader,
            valid_loader=valid_loader,
            tokenizer=tokenizer,
            **kwargs,
        )
        trainer.optimizer.load_state_dict(payload["optimizer_state_dict"])
        trainer.scaler.load_state_dict(payload["scaler_state_dict"])
        trainer.step            = payload["step"]
        trainer.best_valid_loss = payload.get("best_valid_loss", float("inf"))

        print(
            f"[distill] Resumed at step {trainer.step}  |  "
            f"best_valid_loss={trainer.best_valid_loss:.4f}"
        )
        return trainer


# ---------------------------------------------------------------------------
# GGUF convenience wrapper
# ---------------------------------------------------------------------------

def _make_gguf_teacher_fn(
    gguf_path: str,
) -> Callable[[torch.Tensor], torch.Tensor]:
    """
    Build a teacher_generate_fn that wraps a llama-cpp-python GGUF model.

    The returned callable accepts input_ids (B, T) and returns logits (B, T, vocab).
    Only batch size 1 is supported by most GGUF runtimes; the wrapper handles
    looping over the batch dimension transparently.

    Requires: llama-cpp-python (pip install llama-cpp-python).
    """
    try:
        from llama_cpp import Llama
    except ImportError as exc:
        raise ImportError(
            "llama-cpp-python is required for GGUF teacher inference. "
            "Install with: pip install llama-cpp-python"
        ) from exc

    llm = Llama(
        model_path=str(gguf_path),
        logits_all=True,
        verbose=False,
    )

    def _teacher_fn(input_ids: torch.Tensor) -> torch.Tensor:
        """
        input_ids : LongTensor (B, T)
        returns   : FloatTensor (B, T, vocab_size)
        """
        B, T = input_ids.shape
        all_logits: list[torch.Tensor] = []

        for b in range(B):
            tokens = input_ids[b].tolist()
            llm.reset()
            llm.eval(tokens)
            # llm.eval_logits shape: (T, vocab_size) as list-of-lists
            import numpy as np
            logits_np = np.array(llm.eval_logits, dtype=np.float32)  # (T, vocab)
            all_logits.append(torch.from_numpy(logits_np))  # (T, vocab)

        # Stack: (B, T, vocab) — pad if sequence lengths differ
        max_len = max(t.shape[0] for t in all_logits)
        vocab   = all_logits[0].shape[1]
        stacked = torch.zeros(B, max_len, vocab, dtype=torch.float32)
        for b, t in enumerate(all_logits):
            stacked[b, : t.shape[0], :] = t
        return stacked

    return _teacher_fn


def distill_from_gguf(
    gguf_path: str,
    student_path: str,
    data_dir: str,
    tokenizer_path: str,
    **kwargs,
) -> DistillationTrainer:
    """
    Convenience function: build and return a DistillationTrainer that uses a
    GGUF file as the teacher and a saved ProverbsLM checkpoint as the student.

    Parameters
    ----------
    gguf_path      : Path to the teacher .gguf model file.
    student_path   : Path to a ProverbsLM checkpoint (.pt) for the student, or
                     a ProverbsConfig dict / JSON path to initialise from scratch.
    data_dir       : Directory containing training session data.
    tokenizer_path : Path to the ProverbsTokenizer model file.
    **kwargs       : Forwarded to DistillationTrainer (temperature, alpha, lr,
                     max_steps, output_dir, etc.) and make_loaders
                     (batch_size, max_seq_len, val_split, packed).

    Returns
    -------
    DistillationTrainer  — call .train() to start distillation.
    """
    from tokenizer.tokenizer import ProverbsTokenizer  # local import avoids hard dep

    # ---- Tokenizer ----------------------------------------------------------
    tokenizer = ProverbsTokenizer.load(tokenizer_path)

    # ---- Student model ------------------------------------------------------
    student_path_obj = Path(student_path).expanduser().resolve()
    if student_path_obj.exists():
        print(f"[distill_from_gguf] Loading student from {student_path_obj}")
        student = ProverbsLM.load(str(student_path_obj))
    else:
        raise FileNotFoundError(
            f"Student checkpoint not found: {student_path_obj}. "
            "Pass an existing .pt checkpoint path."
        )

    # ---- Data loaders -------------------------------------------------------
    batch_size  = kwargs.pop("batch_size",  4)
    max_seq_len = kwargs.pop("max_seq_len", getattr(student.cfg, "max_seq_len", 512))
    val_split   = kwargs.pop("val_split",   0.1)
    packed      = kwargs.pop("packed",      False)

    from training.trainer import ProverbsTrainer
    train_loader, valid_loader = ProverbsTrainer.make_loaders(
        data_dir=data_dir,
        tokenizer=tokenizer,
        max_seq_len=max_seq_len,
        batch_size=batch_size,
        packed=packed,
        val_split=val_split,
    )

    # ---- Teacher ------------------------------------------------------------
    teacher_fn = _make_gguf_teacher_fn(gguf_path)

    # ---- Build trainer ------------------------------------------------------
    trainer = DistillationTrainer(
        student=student,
        teacher_generate_fn=teacher_fn,
        train_loader=train_loader,
        valid_loader=valid_loader,
        tokenizer=tokenizer,
        **kwargs,
    )
    return trainer
