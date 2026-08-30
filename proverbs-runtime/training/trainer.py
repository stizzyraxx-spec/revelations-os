"""
training/trainer.py — ProverbsTrainer

Full training loop for ProverbsLM with:
  - AdamW + cosine LR schedule with linear warmup
  - Optional Muon optimizer (orthogonal gradient updates via Newton-Schulz)
  - Automatic mixed precision (CUDA only)
  - Gradient clipping
  - Periodic evaluation, checkpointing, and best-model tracking
  - Optional torch.compile (PyTorch >= 2.0)
  - Optional gradient checkpointing
  - Optional packed dataset support
  - Optional curriculum learning (dataset.set_progress)
  - Optional AST chunking via ASTChunkDataset
  - Optional knowledge distillation with teacher_generate_fn
  - tqdm progress bars (falls back to plain print)
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
from torch.utils.data import DataLoader, random_split

# ---------------------------------------------------------------------------
# Project root on sys.path
# ---------------------------------------------------------------------------
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from model.config import ProverbsConfig      # noqa: E402
from model.proverbs_lm import ProverbsLM     # noqa: E402

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
# LR schedule helpers
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


# ---------------------------------------------------------------------------
# Infinite dataloader iterator
# ---------------------------------------------------------------------------

def _infinite(loader: DataLoader) -> Iterator[dict[str, torch.Tensor]]:
    """Yield batches forever, restarting the loader each epoch."""
    while True:
        yield from loader


# ---------------------------------------------------------------------------
# ProverbsTrainer
# ---------------------------------------------------------------------------

class ProverbsTrainer:
    """
    Training loop for ProverbsLM.

    Parameters
    ----------
    model        : A ProverbsLM instance (not yet on device — trainer handles that).
    train_loader : DataLoader for training data.
    valid_loader : DataLoader for validation data.
    cfg          : ProverbsConfig attached to the model.
    output_dir   : Directory for checkpoints.  Default: ~/.proverbs/checkpoints
    lr           : Peak learning rate for AdamW.
    warmup_steps : Number of linear warmup steps before cosine decay.
    max_steps    : Total optimiser steps before stopping.
    grad_clip    : Max gradient norm (0 or None disables clipping).
    log_every    : Print training metrics every N steps.
    eval_every   : Run validation every N steps.
    save_every   : Save a checkpoint every N steps.
    use_amp      : Enable automatic mixed precision (CUDA only).
    compile_model: Call torch.compile() on the model (requires PyTorch >= 2.0).
    use_gradient_checkpointing: Trade compute for memory by checkpointing activations.
    use_muon     : Use Muon optimizer instead of AdamW (falls back to AdamW if unavailable).
    teacher_generate_fn : Optional callable (input_ids) -> logits Tensor[B, T, vocab].
                          When provided, distillation KL loss (alpha=0.5, T=4.0) is
                          blended with the hard-label cross-entropy loss each step.
    """

    def __init__(
        self,
        model: ProverbsLM,
        train_loader: DataLoader,
        valid_loader: DataLoader,
        cfg: ProverbsConfig | None = None,   # defaults to model.cfg
        output_dir: str = "~/.proverbs/checkpoints",
        lr: float = 3e-4,
        warmup_steps: int = 100,
        max_steps: int = 10_000,
        grad_clip: float = 1.0,
        log_every: int = 10,
        eval_every: int = 500,
        save_every: int = 1_000,
        use_amp: bool = True,
        compile_model: bool = False,
        device: str | None = None,           # ignored, model already placed
        use_gradient_checkpointing: bool = False,
        use_muon: bool = False,
        teacher_generate_fn: Callable | None = None,
    ) -> None:
        self.cfg = cfg if cfg is not None else model.cfg
        self.train_loader = train_loader
        self.valid_loader = valid_loader
        self.lr = lr
        self.warmup_steps = warmup_steps
        self.max_steps = max_steps
        self.grad_clip = grad_clip
        self.log_every = log_every
        self.eval_every = eval_every
        self.save_every = save_every

        # Distillation teacher (optional)
        self.teacher_generate_fn = teacher_generate_fn

        # Output directory
        self.output_dir = Path(output_dir).expanduser().resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)

        # Device
        self.device = _best_device()

        # Move model to device
        self.model: ProverbsLM = model.to(self.device)

        # Gradient checkpointing
        if use_gradient_checkpointing:
            if hasattr(self.model, "gradient_checkpointing_enable"):
                self.model.gradient_checkpointing_enable()
            else:
                from torch.utils.checkpoint import checkpoint as grad_ckpt
                for layer in self.model.layers:
                    _orig_fwd = layer.forward
                    def _ckpt_fwd(x, mask=None, kv_cache=None, _fwd=_orig_fwd):
                        return grad_ckpt(_fwd, x, mask, kv_cache, use_reentrant=False)
                    layer.forward = _ckpt_fwd
            print("[trainer] Gradient checkpointing enabled")

        # Optional torch.compile
        if compile_model:
            if not hasattr(torch, "compile"):
                print("[trainer] WARNING: torch.compile not available (requires PyTorch >= 2.0). Skipping.")
            else:
                print("[trainer] Compiling model with torch.compile …")
                self.model = torch.compile(self.model)  # type: ignore[assignment]

        # Optimizer — AdamW by default, Muon if requested
        decay_params, nodecay_params = _split_params(self.model)
        self.optimizer = torch.optim.AdamW(
            [
                {"params": decay_params,   "weight_decay": 0.1},
                {"params": nodecay_params, "weight_decay": 0.0},
            ],
            lr=lr,
            betas=(0.9, 0.95),
            eps=1e-8,
            fused=self.device == "cuda",  # fused kernel when available on CUDA
        )
        if use_muon:
            try:
                from training.muon import make_muon
                self.optimizer = make_muon(self.model, lr=lr, adamw_lr=lr * 0.1)
                print("[trainer] Using Muon optimizer")
            except ImportError:
                print("[trainer] Muon not found, falling back to AdamW")

        # AMP — bfloat16 on CUDA (Ampere+) or CPU; float16 on MPS/older CUDA.
        # BF16 has the same exponent range as FP32 so it never NaN-overflows.
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

        n_params = self.model.param_count() if hasattr(self.model, "param_count") else sum(
            p.numel() for p in self.model.parameters()
        )
        amp_label = f"{str(self.amp_dtype).split('.')[-1]}" if self.use_amp else "off"
        grad_ckpt_label = "on" if use_gradient_checkpointing else "off"
        muon_label = "on" if use_muon else "off"
        has_curriculum = hasattr(getattr(self.train_loader, "dataset", None), "set_progress")
        curriculum_label = "on" if has_curriculum else "off"
        ast_chunks_label = "on" if _loader_uses_ast_chunks(self.train_loader) else "off"
        distill_label = "on" if self.teacher_generate_fn is not None else "off"
        print(
            f"[trainer] ProverbsTrainer ready  |  "
            f"params={n_params/1e6:.1f}M  |  "
            f"device={self.device}  |  "
            f"AMP={amp_label}  |  "
            f"grad_ckpt={grad_ckpt_label}  |  "
            f"muon={muon_label}  |  "
            f"curriculum={curriculum_label}  |  "
            f"ast_chunks={ast_chunks_label}  |  "
            f"distill={distill_label}  |  "
            f"output={self.output_dir}"
        )

    # ------------------------------------------------------------------
    # Distillation loss
    # ------------------------------------------------------------------

    def _distillation_loss(
        self,
        student_logits: torch.Tensor,   # (B, T, vocab)
        teacher_logits: torch.Tensor,   # (B, T, vocab)
        T: float = 4.0,
    ) -> torch.Tensor:
        """
        Soft-target KL-divergence loss scaled by T^2.

        Mirrors the _distillation_loss pattern from distillation_trainer.py:
          KL(soft_teacher || soft_student) * T^2

        The T^2 rescaling compensates for the 1/T^2 gradient shrinkage that
        temperature introduces, ensuring the soft-target gradient magnitude is
        comparable to the hard-label cross-entropy gradient.
        """
        B, Tlen, V = student_logits.shape
        s_flat = student_logits.view(B * Tlen, V)
        t_flat = teacher_logits.view(B * Tlen, V)

        soft_targets = F.softmax(t_flat / T, dim=-1)
        log_probs    = F.log_softmax(s_flat / T, dim=-1)

        return F.kl_div(log_probs, soft_targets, reduction="batchmean") * T * T

    # ------------------------------------------------------------------
    # Main training loop
    # ------------------------------------------------------------------

    def train(self) -> None:
        """Run the training loop until max_steps is reached."""
        self.model.train()
        data_iter = _infinite(self.train_loader)

        # Check for curriculum learning support
        has_curriculum = hasattr(getattr(self.train_loader, "dataset", None), "set_progress")

        # Tokens per batch (approx) for throughput reporting
        batch = next(data_iter)
        tokens_per_batch: int = int(batch["input_ids"].numel())
        # Put it back by restarting the iterator
        data_iter = _infinite(self.train_loader)

        if _HAS_TQDM:
            pbar = _tqdm(total=self.max_steps, initial=self.step, desc="training", unit="step")
        else:
            pbar = None

        t0 = time.perf_counter()

        # Distillation hyper-parameters (fixed per design spec)
        _DISTILL_ALPHA = 0.5
        _DISTILL_T     = 4.0

        while self.step < self.max_steps:
            batch = next(data_iter)
            input_ids: torch.Tensor = batch["input_ids"].to(self.device, non_blocking=True)
            labels: torch.Tensor    = batch["labels"].to(self.device, non_blocking=True)

            # Map dataset's -100 ignore index to config's pad_token_id for the
            # model forward (model uses pad_token_id as ignore index internally,
            # but the loss shift means labels with -100 map correctly via
            # cross_entropy's ignore_index parameter which is already handled
            # inside ProverbsLM.forward using cfg.pad_token_id=0).
            # We pass labels as-is; cross_entropy inside the model uses
            # ignore_index=pad_token_id (0), but dataset uses -100.
            # Fix: remap -100 → pad_token_id so the model ignores them.
            labels = labels.clone()
            labels[labels == -100] = self.cfg.pad_token_id

            self.optimizer.zero_grad(set_to_none=True)

            # ----- Optional teacher forward (no gradients) -------------------
            teacher_logits: torch.Tensor | None = None
            if self.teacher_generate_fn is not None:
                with torch.no_grad():
                    teacher_logits = self.teacher_generate_fn(input_ids)
                    teacher_logits = teacher_logits.to(device=self.device, dtype=torch.float32)

            # ----- Student / model forward -----------------------------------
            with torch.autocast(device_type=self.device, enabled=self.use_amp, dtype=self.amp_dtype):
                out = self.model(input_ids=input_ids, labels=labels)
                loss: torch.Tensor = out["loss"]

                # Blend in distillation KL loss when a teacher is present
                if teacher_logits is not None:
                    student_logits: torch.Tensor = out["logits"].float()  # (B, T, vocab)
                    T_len = min(student_logits.size(1), teacher_logits.size(1))
                    distill_loss = self._distillation_loss(
                        student_logits[:, :T_len, :],
                        teacher_logits[:, :T_len, :],
                        T=_DISTILL_T,
                    )
                    loss = _DISTILL_ALPHA * distill_loss + (1.0 - _DISTILL_ALPHA) * loss

            # Backward
            self.scaler.scale(loss).backward()

            # Gradient clip
            if self.grad_clip and self.grad_clip > 0:
                self.scaler.unscale_(self.optimizer)
                nn.utils.clip_grad_norm_(self.model.parameters(), self.grad_clip)

            # Optimiser step
            self.scaler.step(self.optimizer)
            self.scaler.update()

            # LR schedule
            new_lr = _cosine_lr(self.step, self.warmup_steps, self.max_steps, self.lr)
            _set_lr(self.optimizer, new_lr)

            self.step += 1

            # Curriculum progress update
            if has_curriculum and self.step % self.log_every == 0:
                progress = self.step / self.max_steps
                self.train_loader.dataset.set_progress(progress)

            # Logging
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

                msg = (
                    f"step={self.step:>6d}/{self.max_steps}  "
                    f"loss={loss.item():.4f}  "
                    f"lr={new_lr:.2e}  "
                    f"tok/s={tok_per_sec:,.0f}"
                    f"{mem_str}"
                )
                if pbar is not None:
                    pbar.set_postfix_str(
                        f"loss={loss.item():.4f} lr={new_lr:.2e} tok/s={tok_per_sec:,.0f}"
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
                self.model.train()

            # Periodic checkpoint (skip if we just saved on eval_every overlap)
            elif self.step % self.save_every == 0:
                self.save_checkpoint(self.step, is_best=False)

        if pbar is not None:
            pbar.close()

        print(f"[trainer] Training complete at step {self.step}.  Best valid loss: {self.best_valid_loss:.4f}")

    # ------------------------------------------------------------------
    # Evaluation
    # ------------------------------------------------------------------

    def evaluate(self) -> float:
        """
        Run the model over the entire valid_loader and return mean cross-entropy loss.
        Gradient computation is disabled.
        """
        self.model.eval()
        total_loss = 0.0
        total_batches = 0

        with torch.no_grad():
            for batch in self.valid_loader:
                input_ids = batch["input_ids"].to(self.device, non_blocking=True)
                labels    = batch["labels"].to(self.device, non_blocking=True)

                # Remap ignore index
                labels = labels.clone()
                labels[labels == -100] = self.cfg.pad_token_id

                with torch.autocast(device_type=self.device, enabled=self.use_amp, dtype=self.amp_dtype):
                    out = self.model(input_ids=input_ids, labels=labels)

                total_loss += out["loss"].item()
                total_batches += 1

        if total_batches == 0:
            return float("inf")
        return total_loss / total_batches

    # ------------------------------------------------------------------
    # Checkpointing
    # ------------------------------------------------------------------

    def save_checkpoint(self, step: int, is_best: bool = False) -> None:
        """
        Save model weights, optimizer state, and trainer metadata to
        output_dir/checkpoint-{step}.pt.
        If is_best is True, also copy to output_dir/best.pt.
        """
        ckpt_path = self.output_dir / f"checkpoint-{step}.pt"
        payload = {
            "step": step,
            "best_valid_loss": self.best_valid_loss,
            "model_state_dict": (
                self.model._orig_mod.state_dict()           # unwrap torch.compile
                if hasattr(self.model, "_orig_mod")
                else self.model.state_dict()
            ),
            "optimizer_state_dict": self.optimizer.state_dict(),
            "scaler_state_dict": self.scaler.state_dict(),
            "config": self.cfg.__dict__,
        }
        torch.save(payload, ckpt_path)
        print(f"[trainer] Saved checkpoint → {ckpt_path}")

        if is_best:
            best_path = self.output_dir / "best.pt"
            torch.save(payload, best_path)
            print(f"[trainer] Saved best model → {best_path}")

    # ------------------------------------------------------------------
    # Resume
    # ------------------------------------------------------------------

    @classmethod
    def resume(
        cls,
        checkpoint_path: str,
        train_loader: DataLoader,
        valid_loader: DataLoader,
        output_dir: str = "~/.proverbs/checkpoints",
        lr: float = 3e-4,
        warmup_steps: int = 100,
        max_steps: int = 10_000,
        grad_clip: float = 1.0,
        log_every: int = 10,
        eval_every: int = 500,
        save_every: int = 1_000,
        use_amp: bool = True,
        compile_model: bool = False,
        use_gradient_checkpointing: bool = False,
        use_muon: bool = False,
        teacher_generate_fn: Callable | None = None,
    ) -> "ProverbsTrainer":
        """
        Load a saved checkpoint and return a ProverbsTrainer ready to continue.

        The ProverbsConfig, model weights, optimizer state, scaler state, and
        the step counter are all restored from *checkpoint_path*.
        """
        device = _best_device()
        print(f"[trainer] Resuming from {checkpoint_path} …")
        payload = torch.load(checkpoint_path, map_location=device, weights_only=False)

        cfg = ProverbsConfig(**payload["config"])
        model = ProverbsLM(cfg)
        model.load_state_dict(payload["model_state_dict"])

        trainer = cls(
            model=model,
            train_loader=train_loader,
            valid_loader=valid_loader,
            cfg=cfg,
            output_dir=output_dir,
            lr=lr,
            warmup_steps=warmup_steps,
            max_steps=max_steps,
            grad_clip=grad_clip,
            log_every=log_every,
            eval_every=eval_every,
            save_every=save_every,
            use_amp=use_amp,
            compile_model=compile_model,
            use_gradient_checkpointing=use_gradient_checkpointing,
            use_muon=use_muon,
            teacher_generate_fn=teacher_generate_fn,
        )

        # Restore optimizer and scaler
        trainer.optimizer.load_state_dict(payload["optimizer_state_dict"])
        trainer.scaler.load_state_dict(payload["scaler_state_dict"])

        # Restore bookkeeping
        trainer.step = payload["step"]
        trainer.best_valid_loss = payload.get("best_valid_loss", float("inf"))

        print(
            f"[trainer] Resumed at step {trainer.step}  |  "
            f"best_valid_loss={trainer.best_valid_loss:.4f}"
        )
        return trainer

    # ------------------------------------------------------------------
    # make_loaders
    # ------------------------------------------------------------------

    @classmethod
    def make_loaders(
        cls,
        data_dir: str,
        tokenizer,
        max_seq_len: int,
        batch_size: int,
        packed: bool = False,
        val_split: float = 0.1,
        use_ast_chunks: bool = False,
    ) -> tuple[DataLoader, DataLoader]:
        """
        Build train and validation DataLoaders.

        Parameters
        ----------
        data_dir       : Directory containing session data (or source files for AST mode).
        tokenizer      : ProverbsTokenizer instance.
        max_seq_len    : Sequence length for the dataset.
        batch_size     : Batch size for both loaders.
        packed         : If True, use make_packed_loader from training.packed_dataset.
        val_split      : Fraction of data to use for validation (non-packed only).
        use_ast_chunks : If True, use ASTChunkDataset (AST boundary chunking) instead
                         of ProverbsDataset.

        Returns
        -------
        (train_loader, val_loader)
        """
        if packed:
            from training.packed_dataset import make_packed_loader
            train_loader = make_packed_loader(data_dir, tokenizer, max_seq_len, batch_size)
            val_loader   = make_packed_loader(data_dir, tokenizer, max_seq_len, batch_size)
            return train_loader, val_loader

        if use_ast_chunks:
            from training.ast_chunker import ASTChunkDataset
            from training.dataset import collate_fn
            dataset = ASTChunkDataset(
                dirpath=data_dir,
                max_seq_len=max_seq_len,
            )
        else:
            from training.dataset import ProverbsDataset, collate_fn
            dataset = ProverbsDataset(
                sessions_dir=data_dir,
                max_seq_len=max_seq_len,
            )

        n_val = max(1, int(len(dataset) * val_split))
        n_train = len(dataset) - n_val
        train_ds, val_ds = random_split(dataset, [n_train, n_val])
        train_loader = DataLoader(
            train_ds,
            batch_size=batch_size,
            shuffle=True,
            collate_fn=collate_fn,
            pin_memory=torch.cuda.is_available(),
            drop_last=True,
        )
        val_loader = DataLoader(
            val_ds,
            batch_size=batch_size,
            shuffle=False,
            collate_fn=collate_fn,
            pin_memory=torch.cuda.is_available(),
            drop_last=False,
        )
        return train_loader, val_loader


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _split_params(
    model: nn.Module,
) -> tuple[list[torch.nn.Parameter], list[torch.nn.Parameter]]:
    """
    Separate parameters that should have weight decay applied from those that
    should not (biases, LayerNorm / RMSNorm weights, embedding weights).
    """
    decay: list[torch.nn.Parameter] = []
    no_decay: list[torch.nn.Parameter] = []

    for name, param in model.named_parameters():
        if not param.requires_grad:
            continue
        # Biases and 1-D params (norm scales) → no decay
        if param.ndim == 1 or name.endswith(".bias"):
            no_decay.append(param)
        else:
            decay.append(param)

    return decay, no_decay


def _loader_uses_ast_chunks(loader: DataLoader) -> bool:
    """Return True if the loader's underlying dataset is an ASTChunkDataset."""
    try:
        from training.ast_chunker import ASTChunkDataset
    except ImportError:
        return False
    ds = getattr(loader, "dataset", None)
    # Unwrap Subset (random_split wraps in Subset)
    if hasattr(ds, "dataset"):
        ds = ds.dataset
    return isinstance(ds, ASTChunkDataset)
