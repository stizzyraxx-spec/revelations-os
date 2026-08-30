"""
training/dpo_trainer.py — Direct Preference Optimization trainer for ProverbsLM.

Loss: L_DPO = -log(sigmoid(beta * (log_ratio_chosen - log_ratio_rejected)))
where log_ratio = log(policy_prob) - log(reference_prob)

Data comes from ~/.proverbs/quality_sessions (chosen) and
~/.proverbs/rejected_sessions (rejected), paired by session index.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path
from typing import Iterator

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from model.config import ProverbsConfig          # noqa: E402
from model.proverbs_lm import ProverbsLM         # noqa: E402
from tokenizer.bpe import ProverbsTokenizer      # noqa: E402

try:
    from tqdm import tqdm as _tqdm
    _HAS_TQDM = True
except ImportError:
    _HAS_TQDM = False

PAD_TOKEN_ID: int = 0
LABEL_IGNORE_INDEX: int = -100
MIN_SEQ_LEN: int = 8


# ---------------------------------------------------------------------------
# DpoDataset
# ---------------------------------------------------------------------------

class DpoDataset(Dataset):
    """
    Pairs chosen (quality_sessions) with rejected (rejected_sessions) examples.

    Each JSONL line: {"messages": [...], "quality": "positive"|"negative"}
    __getitem__ returns chosen_ids, chosen_labels, rejected_ids, rejected_labels
    where labels mask the prompt tokens (only response tokens are scored).
    Unpaired examples are skipped.
    """

    def __init__(
        self,
        data_dir: str,
        tokenizer: ProverbsTokenizer,
        max_seq_len: int = 2048,
    ) -> None:
        self.max_seq_len = max_seq_len
        self.tokenizer = tokenizer

        data_path = Path(data_dir).expanduser().resolve()
        quality_dir = data_path / "quality_sessions"
        rejected_dir = data_path / "rejected_sessions"

        # Fall back to the self_learn canonical paths if data_dir is the proverbs root
        if not quality_dir.exists() and not rejected_dir.exists():
            quality_dir = Path.home() / ".proverbs" / "quality_sessions"
            rejected_dir = Path.home() / ".proverbs" / "rejected_sessions"

        chosen_seqs: list[tuple[list[int], int]] = []   # (token_ids, prompt_len)
        rejected_seqs: list[tuple[list[int], int]] = []

        for fpath in sorted(quality_dir.glob("*.jsonl")):
            _parse_preference_file(fpath, tokenizer, chosen_seqs)

        for fpath in sorted(rejected_dir.glob("*.jsonl")):
            _parse_preference_file(fpath, tokenizer, rejected_seqs)

        # Pair by position; drop extras from the longer list
        n = min(len(chosen_seqs), len(rejected_seqs))
        if n == 0:
            import warnings
            warnings.warn(
                f"DpoDataset: no paired examples found. "
                f"chosen={len(chosen_seqs)}, rejected={len(rejected_seqs)}",
                stacklevel=2,
            )
        self._pairs: list[tuple[
            list[int], int,   # chosen tokens, prompt_len
            list[int], int,   # rejected tokens, prompt_len
        ]] = [
            (chosen_seqs[i][0], chosen_seqs[i][1],
             rejected_seqs[i][0], rejected_seqs[i][1])
            for i in range(n)
        ]

    def __len__(self) -> int:
        return len(self._pairs)

    def __getitem__(self, idx: int) -> dict[str, torch.Tensor]:
        chosen_ids, chosen_prompt_len, rejected_ids, rejected_prompt_len = self._pairs[idx]

        chosen_input, chosen_labels = _pack(chosen_ids, chosen_prompt_len, self.max_seq_len)
        rejected_input, rejected_labels = _pack(rejected_ids, rejected_prompt_len, self.max_seq_len)

        return {
            "chosen_ids":      chosen_input,
            "chosen_labels":   chosen_labels,
            "rejected_ids":    rejected_input,
            "rejected_labels": rejected_labels,
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _pack(
    token_ids: list[int],
    prompt_len: int,
    max_seq_len: int,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Truncate/pad token_ids and build labels that ignore prompt positions."""
    ids = token_ids[:max_seq_len]
    seq_len = len(ids)

    input_ids = torch.full((max_seq_len,), PAD_TOKEN_ID, dtype=torch.long)
    input_ids[:seq_len] = torch.tensor(ids, dtype=torch.long)

    labels = input_ids.clone()
    # Mask padding
    labels[seq_len:] = LABEL_IGNORE_INDEX
    # Mask prompt tokens (only score the response)
    mask_end = min(prompt_len, seq_len)
    labels[:mask_end] = LABEL_IGNORE_INDEX

    return input_ids, labels


def _parse_preference_file(
    fpath: Path,
    tokenizer: ProverbsTokenizer,
    out: list[tuple[list[int], int]],
) -> None:
    """
    Parse one JSONL file into (token_ids, prompt_len) tuples.
    prompt_len = length of all messages except the last assistant turn,
    so labels only score the final assistant response.
    """
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
            if not isinstance(messages, list) or len(messages) < 2:
                continue

            try:
                all_ids: list[int] = tokenizer.encode_chat(messages)
            except Exception:  # noqa: BLE001
                continue

            if len(all_ids) < MIN_SEQ_LEN:
                continue

            # Compute prompt length: encode everything except the last message
            try:
                prompt_ids: list[int] = tokenizer.encode_chat(messages[:-1])
            except Exception:  # noqa: BLE001
                prompt_ids = []

            out.append((all_ids, len(prompt_ids)))


def _dpo_collate(batch: list[dict[str, torch.Tensor]]) -> dict[str, torch.Tensor]:
    return {
        "chosen_ids":      torch.stack([b["chosen_ids"]      for b in batch]),
        "chosen_labels":   torch.stack([b["chosen_labels"]   for b in batch]),
        "rejected_ids":    torch.stack([b["rejected_ids"]    for b in batch]),
        "rejected_labels": torch.stack([b["rejected_labels"] for b in batch]),
    }


# ---------------------------------------------------------------------------
# LR helpers (identical pattern to trainer.py)
# ---------------------------------------------------------------------------

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


def _best_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _split_params(
    model: nn.Module,
) -> tuple[list[torch.nn.Parameter], list[torch.nn.Parameter]]:
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
# DpoTrainer
# ---------------------------------------------------------------------------

class DpoTrainer:
    """
    DPO training loop for ProverbsLM.

    Parameters
    ----------
    policy        : Model being trained (weights updated each step).
    reference     : Frozen copy of the model before DPO (reference log-probs).
    train_loader  : DataLoader yielding DpoDataset batches.
    valid_loader  : DataLoader for evaluation.
    output_dir    : Checkpoint directory.
    lr            : Peak AdamW learning rate.
    beta          : KL-regularisation coefficient (DPO temperature).
    max_steps     : Total optimiser steps.
    grad_clip     : Max gradient norm (0 disables).
    log_every     : Print metrics every N steps.
    eval_every    : Run validation every N steps.
    use_amp       : Enable BF16 automatic mixed precision.
    """

    def __init__(
        self,
        policy: ProverbsLM,
        reference: ProverbsLM,
        train_loader: DataLoader,
        valid_loader: DataLoader,
        output_dir: str = "~/.proverbs/checkpoints",
        lr: float = 1e-5,
        beta: float = 0.1,
        max_steps: int = 1000,
        grad_clip: float = 1.0,
        log_every: int = 10,
        eval_every: int = 200,
        use_amp: bool = True,
    ) -> None:
        self.beta = beta
        self.lr = lr
        self.max_steps = max_steps
        self.grad_clip = grad_clip
        self.log_every = log_every
        self.eval_every = eval_every
        self.train_loader = train_loader
        self.valid_loader = valid_loader

        self.output_dir = Path(output_dir).expanduser().resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)

        self.device = _best_device()

        # Policy is trainable
        self.policy: ProverbsLM = policy.to(self.device)
        self.cfg = self.policy.cfg

        # Reference is frozen
        self.reference: ProverbsLM = reference.to(self.device)
        for param in self.reference.parameters():
            param.requires_grad_(False)
        self.reference.eval()

        # Optimizer (same param-split pattern as ProverbsTrainer)
        warmup_steps = max(1, max_steps // 10)
        self.warmup_steps = warmup_steps
        decay_params, nodecay_params = _split_params(self.policy)
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
        else:
            self.amp_dtype = torch.bfloat16
        self.scaler = torch.cuda.amp.GradScaler(
            enabled=self.use_amp and self.amp_dtype == torch.float16
        )

        self.step: int = 0
        self.best_valid_loss: float = float("inf")

        n_params = self.policy.param_count()
        amp_label = str(self.amp_dtype).split(".")[-1] if self.use_amp else "off"
        print(
            f"[dpo] DpoTrainer ready  |  "
            f"params={n_params/1e6:.1f}M  |  "
            f"device={self.device}  |  "
            f"AMP={amp_label}  |  "
            f"beta={beta}  |  "
            f"output={self.output_dir}"
        )

    # ------------------------------------------------------------------
    # Core log-prob computation
    # ------------------------------------------------------------------

    def _log_probs(
        self,
        model: ProverbsLM,
        input_ids: torch.Tensor,   # (B, T)
        labels: torch.Tensor,      # (B, T)  — LABEL_IGNORE_INDEX masked
    ) -> torch.Tensor:             # scalar
        """
        Forward pass through *model*, gather per-token log-probs at label
        positions, and sum over non-masked positions.  Returns a (B,) tensor.
        """
        out = model(input_ids=input_ids)
        logits = out["logits"]  # (B, T, V)

        # Shift: token i predicts token i+1, matching ProverbsLM.forward loss logic
        shift_logits = logits[:, :-1, :].contiguous()   # (B, T-1, V)
        shift_labels = labels[:, 1:].contiguous()        # (B, T-1)

        log_probs = F.log_softmax(shift_logits, dim=-1)  # (B, T-1, V)

        # Mask out LABEL_IGNORE_INDEX positions
        mask = (shift_labels != LABEL_IGNORE_INDEX)      # (B, T-1)
        # Replace ignore positions with 0 for safe gather
        safe_labels = shift_labels.clone()
        safe_labels[~mask] = 0

        gathered = log_probs.gather(
            dim=-1,
            index=safe_labels.unsqueeze(-1),
        ).squeeze(-1)                                    # (B, T-1)

        # Zero out masked positions and sum over sequence
        gathered = gathered * mask.float()
        return gathered.sum(dim=-1)                      # (B,)

    # ------------------------------------------------------------------
    # Training loop
    # ------------------------------------------------------------------

    def train(self) -> None:
        self.policy.train()
        data_iter = _infinite(self.train_loader)

        if _HAS_TQDM:
            pbar = _tqdm(total=self.max_steps, initial=self.step, desc="dpo", unit="step")
        else:
            pbar = None

        t0 = time.perf_counter()

        while self.step < self.max_steps:
            batch = next(data_iter)

            chosen_ids      = batch["chosen_ids"].to(self.device, non_blocking=True)
            chosen_labels   = batch["chosen_labels"].to(self.device, non_blocking=True)
            rejected_ids    = batch["rejected_ids"].to(self.device, non_blocking=True)
            rejected_labels = batch["rejected_labels"].to(self.device, non_blocking=True)

            self.optimizer.zero_grad(set_to_none=True)

            with torch.autocast(device_type=self.device, enabled=self.use_amp, dtype=self.amp_dtype):
                # Policy log-probs
                policy_chosen   = self._log_probs(self.policy, chosen_ids,   chosen_labels)
                policy_rejected = self._log_probs(self.policy, rejected_ids, rejected_labels)

                # Reference log-probs (no gradient)
                with torch.no_grad():
                    ref_chosen   = self._log_probs(self.reference, chosen_ids,   chosen_labels)
                    ref_rejected = self._log_probs(self.reference, rejected_ids, rejected_labels)

                chosen_ratio   = policy_chosen   - ref_chosen    # (B,)
                rejected_ratio = policy_rejected - ref_rejected   # (B,)

                loss = -F.logsigmoid(self.beta * (chosen_ratio - rejected_ratio)).mean()

            self.scaler.scale(loss).backward()

            if self.grad_clip and self.grad_clip > 0:
                self.scaler.unscale_(self.optimizer)
                nn.utils.clip_grad_norm_(self.policy.parameters(), self.grad_clip)

            self.scaler.step(self.optimizer)
            self.scaler.update()

            new_lr = _cosine_lr(self.step, self.warmup_steps, self.max_steps, self.lr)
            _set_lr(self.optimizer, new_lr)

            self.step += 1

            if self.step % self.log_every == 0:
                t1 = time.perf_counter()
                elapsed = t1 - t0
                t0 = t1

                chosen_reward  = chosen_ratio.mean().item()
                rejected_reward = rejected_ratio.mean().item()
                reward_margin  = chosen_reward - rejected_reward

                mem_str = ""
                if self.device == "cuda":
                    alloc_gb = torch.cuda.memory_allocated() / 1e9
                    mem_str = f"  mem={alloc_gb:.1f}GB"

                msg = (
                    f"step={self.step:>6d}/{self.max_steps}  "
                    f"loss={loss.item():.4f}  "
                    f"chosen_r={chosen_reward:.3f}  "
                    f"rejected_r={rejected_reward:.3f}  "
                    f"margin={reward_margin:.3f}  "
                    f"lr={new_lr:.2e}"
                    f"{mem_str}"
                )
                if pbar is not None:
                    pbar.set_postfix_str(
                        f"loss={loss.item():.4f} margin={reward_margin:.3f} lr={new_lr:.2e}"
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
                    f"[dpo eval]  step={self.step}  valid_loss={valid_loss:.4f}"
                    f"  best={self.best_valid_loss:.4f}{best_str}"
                )
                self.policy.train()

        if pbar is not None:
            pbar.close()

        print(
            f"[dpo] Training complete at step {self.step}.  "
            f"Best valid loss: {self.best_valid_loss:.4f}"
        )

    # ------------------------------------------------------------------
    # Evaluation
    # ------------------------------------------------------------------

    def evaluate(self) -> float:
        self.policy.eval()
        total_loss = 0.0
        total_batches = 0

        with torch.no_grad():
            for batch in self.valid_loader:
                chosen_ids      = batch["chosen_ids"].to(self.device, non_blocking=True)
                chosen_labels   = batch["chosen_labels"].to(self.device, non_blocking=True)
                rejected_ids    = batch["rejected_ids"].to(self.device, non_blocking=True)
                rejected_labels = batch["rejected_labels"].to(self.device, non_blocking=True)

                with torch.autocast(device_type=self.device, enabled=self.use_amp, dtype=self.amp_dtype):
                    policy_chosen   = self._log_probs(self.policy, chosen_ids,   chosen_labels)
                    policy_rejected = self._log_probs(self.policy, rejected_ids, rejected_labels)
                    ref_chosen      = self._log_probs(self.reference, chosen_ids,   chosen_labels)
                    ref_rejected    = self._log_probs(self.reference, rejected_ids, rejected_labels)

                    chosen_ratio   = policy_chosen   - ref_chosen
                    rejected_ratio = policy_rejected - ref_rejected
                    loss = -F.logsigmoid(self.beta * (chosen_ratio - rejected_ratio)).mean()

                total_loss += loss.item()
                total_batches += 1

        if total_batches == 0:
            return float("inf")
        return total_loss / total_batches

    # ------------------------------------------------------------------
    # Checkpointing (same format as ProverbsTrainer for hot-reload)
    # ------------------------------------------------------------------

    def save_checkpoint(self, step: int, is_best: bool = False) -> None:
        ckpt_path = self.output_dir / f"checkpoint-{step}.pt"
        payload = {
            "step": step,
            "best_valid_loss": self.best_valid_loss,
            "model_state_dict": (
                self.policy._orig_mod.state_dict()
                if hasattr(self.policy, "_orig_mod")
                else self.policy.state_dict()
            ),
            "optimizer_state_dict": self.optimizer.state_dict(),
            "scaler_state_dict": self.scaler.state_dict(),
            "config": self.cfg.__dict__,
        }
        torch.save(payload, ckpt_path)
        print(f"[dpo] Saved checkpoint → {ckpt_path}")

        if is_best:
            best_path = self.output_dir / "best.pt"
            torch.save(payload, best_path)
            print(f"[dpo] Saved best model → {best_path}")

    # ------------------------------------------------------------------
    # Factory
    # ------------------------------------------------------------------

    @classmethod
    def from_checkpoint(
        cls,
        policy_path: str,
        reference_path: str,
        train_loader: DataLoader,
        valid_loader: DataLoader,
        output_dir: str = "~/.proverbs/checkpoints",
        lr: float = 1e-5,
        beta: float = 0.1,
        max_steps: int = 1000,
        grad_clip: float = 1.0,
        log_every: int = 10,
        eval_every: int = 200,
        use_amp: bool = True,
    ) -> "DpoTrainer":
        """Load policy and reference from checkpoint files and return a ready DpoTrainer."""
        device = _best_device()
        policy    = ProverbsLM.load(policy_path, device=device)
        reference = ProverbsLM.load(reference_path, device=device)
        return cls(
            policy=policy,
            reference=reference,
            train_loader=train_loader,
            valid_loader=valid_loader,
            output_dir=output_dir,
            lr=lr,
            beta=beta,
            max_steps=max_steps,
            grad_clip=grad_clip,
            log_every=log_every,
            eval_every=eval_every,
            use_amp=use_amp,
        )


# ---------------------------------------------------------------------------
# __main__
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="DPO fine-tuning for ProverbsLM")
    parser.add_argument("--policy",     required=True, help="Path to policy checkpoint (.pt)")
    parser.add_argument("--reference",  required=True, help="Path to reference checkpoint (.pt)")
    parser.add_argument("--data-dir",   default="~/.proverbs", help="Root data directory")
    parser.add_argument("--output-dir", default="~/.proverbs/checkpoints", help="Checkpoint output dir")
    parser.add_argument("--tokenizer",  default="~/.proverbs/tokenizer.json", help="Tokenizer path")
    parser.add_argument("--steps",      type=int,   default=1000,  help="Training steps")
    parser.add_argument("--beta",       type=float, default=0.1,   help="DPO beta")
    parser.add_argument("--lr",         type=float, default=1e-5,  help="Learning rate")
    parser.add_argument("--batch-size", type=int,   default=4,     help="Batch size")
    parser.add_argument("--max-seq-len",type=int,   default=2048,  help="Max sequence length")
    parser.add_argument("--no-amp",     action="store_true",       help="Disable AMP")
    args = parser.parse_args()

    tok = ProverbsTokenizer.load(str(Path(args.tokenizer).expanduser()))

    dataset = DpoDataset(
        data_dir=args.data_dir,
        tokenizer=tok,
        max_seq_len=args.max_seq_len,
    )

    if len(dataset) == 0:
        print("[dpo] ERROR: dataset has no paired examples. Exiting.")
        sys.exit(1)

    # 90/10 split
    n_valid = max(1, math.ceil(len(dataset) * 0.1))
    n_train = len(dataset) - n_valid
    from torch.utils.data import random_split
    train_ds, valid_ds = random_split(dataset, [n_train, n_valid])

    train_loader = DataLoader(
        train_ds,
        batch_size=args.batch_size,
        shuffle=True,
        collate_fn=_dpo_collate,
        pin_memory=torch.cuda.is_available(),
        drop_last=False,
    )
    valid_loader = DataLoader(
        valid_ds,
        batch_size=args.batch_size,
        shuffle=False,
        collate_fn=_dpo_collate,
        pin_memory=torch.cuda.is_available(),
        drop_last=False,
    )

    trainer = DpoTrainer.from_checkpoint(
        policy_path=args.policy,
        reference_path=args.reference,
        train_loader=train_loader,
        valid_loader=valid_loader,
        output_dir=args.output_dir,
        lr=args.lr,
        beta=args.beta,
        max_steps=args.steps,
        use_amp=not args.no_amp,
    )
    trainer.train()
