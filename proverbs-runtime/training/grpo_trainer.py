"""
training/grpo_trainer.py — Group Relative Policy Optimization (GRPO) trainer.

Samples G responses per prompt, scores each with a reward model and/or code
execution, normalizes advantages within the group, then applies a policy
gradient loss regularized by a KL penalty against a frozen reference policy.
"""

from __future__ import annotations

import copy
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import torch
import torch.nn.functional as F

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from model.proverbs_lm import ProverbsLM  # noqa: E402

# ---------------------------------------------------------------------------
# Optional tqdm
# ---------------------------------------------------------------------------

try:
    from tqdm import tqdm as _tqdm
    _HAS_TQDM = True
except ImportError:
    _HAS_TQDM = False


# ---------------------------------------------------------------------------
# Device helper (mirrors trainer.py)
# ---------------------------------------------------------------------------

def _best_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


# ---------------------------------------------------------------------------
# GRPOConfig
# ---------------------------------------------------------------------------

@dataclass
class GRPOConfig:
    """Hyper-parameters for Group Relative Policy Optimization."""

    # Number of responses sampled per prompt (the "group")
    group_size: int = 8

    # KL penalty coefficient (policy vs. reference)
    kl_coeff: float = 0.01

    # Whether to augment reward with code execution signal
    use_code_reward: bool = True

    # Path to a saved RewardModel score_head checkpoint; None disables model scoring
    reward_model_path: str | None = None

    # Generation parameters
    max_new_tokens: int = 256
    temperature: float = 0.8

    # Minimum group std-dev to avoid division by zero in advantage normalization
    advantage_eps: float = 1e-8


# ---------------------------------------------------------------------------
# GRPOTrainer
# ---------------------------------------------------------------------------

class GRPOTrainer:
    """
    GRPO training loop for ProverbsLM.

    Parameters
    ----------
    policy        : The ProverbsLM to be fine-tuned (will be moved to device).
    reference     : Frozen reference copy of the policy; pass None to have the
                    trainer create one automatically via deepcopy.
    tokenizer     : ProverbsTokenizer (must expose .encode() and .decode()).
    prompts       : List of raw prompt strings used as training signal.
    cfg           : GRPOConfig controlling group size, KL coefficient, etc.
    lr            : Learning rate for AdamW.
    max_steps     : Total number of train_step calls in train().
    """

    def __init__(
        self,
        policy: ProverbsLM,
        reference: ProverbsLM | None,
        tokenizer: Any,
        prompts: list[str],
        cfg: GRPOConfig,
        lr: float = 1e-6,
        max_steps: int = 200,
    ) -> None:
        self.cfg = cfg
        self.tokenizer = tokenizer
        self.prompts = prompts
        self.lr = lr
        self.max_steps = max_steps

        self.device = _best_device()

        # Policy (trainable)
        self.policy: ProverbsLM = policy.to(self.device)
        self.policy.train()

        # Reference (frozen)
        if reference is None:
            reference = copy.deepcopy(policy)
        self.reference: ProverbsLM = reference.to(self.device)
        for param in self.reference.parameters():
            param.requires_grad = False
        self.reference.eval()

        # Optimizer — AdamW with small lr suitable for RL fine-tuning
        self.optimizer = torch.optim.AdamW(
            self.policy.parameters(),
            lr=lr,
            betas=(0.9, 0.95),
            eps=1e-8,
        )

        # Optional reward model
        self.reward_model = None
        if cfg.reward_model_path is not None:
            self._load_reward_model(cfg.reward_model_path)

        # Optional code runner (lazy import to avoid hard dependency)
        self._code_runner_available = False
        if cfg.use_code_reward:
            try:
                from logic.code_runner import extract_code_blocks, run_python  # noqa: F401
                self._code_runner_available = True
            except ImportError:
                print("[grpo] WARNING: logic.code_runner not importable; code reward disabled.")

        n_params = sum(p.numel() for p in self.policy.parameters())
        print(
            f"[grpo] GRPOTrainer ready  |  "
            f"params={n_params / 1e6:.1f}M  |  "
            f"device={self.device}  |  "
            f"group_size={cfg.group_size}  |  "
            f"kl_coeff={cfg.kl_coeff}  |  "
            f"code_reward={self._code_runner_available and cfg.use_code_reward}  |  "
            f"max_steps={max_steps}"
        )

    # ------------------------------------------------------------------
    # Reward model loading
    # ------------------------------------------------------------------

    def _load_reward_model(self, path: str) -> None:
        """Load a RewardModel score_head on top of the current policy backbone."""
        try:
            from model.reward_model import RewardModel
            rm = RewardModel(self.policy)
            rm.load(path)
            rm.to(self.device)
            rm.eval()
            self.reward_model = rm
            print(f"[grpo] Loaded reward model head from {path}")
        except Exception as exc:  # noqa: BLE001
            print(f"[grpo] WARNING: Could not load reward model: {exc}")

    # ------------------------------------------------------------------
    # Sampling
    # ------------------------------------------------------------------

    def _sample_responses(self, prompt: str) -> list[str]:
        """
        Sample cfg.group_size responses from the policy at temperature=0.8.

        Uses a simple greedy-with-temperature token-by-token loop so this
        module has no dependency on inference/generate.py.
        """
        prompt_ids = self.tokenizer.encode(prompt)
        prompt_tensor = torch.tensor(
            [prompt_ids], dtype=torch.long, device=self.device
        )

        responses: list[str] = []
        cfg = self.cfg

        self.policy.eval()
        with torch.no_grad():
            for _ in range(cfg.group_size):
                input_ids = prompt_tensor.clone()
                generated: list[int] = []

                for _ in range(cfg.max_new_tokens):
                    out = self.policy(input_ids=input_ids)
                    logits = out["logits"]  # (1, T, vocab_size)
                    next_logits = logits[0, -1, :]  # (vocab_size,)

                    if cfg.temperature > 0:
                        next_logits = next_logits / cfg.temperature
                    probs = F.softmax(next_logits, dim=-1)
                    next_token = torch.multinomial(probs, num_samples=1).item()

                    generated.append(int(next_token))
                    next_tensor = torch.tensor(
                        [[next_token]], dtype=torch.long, device=self.device
                    )
                    input_ids = torch.cat([input_ids, next_tensor], dim=1)

                    # Stop on EOS if the tokenizer exposes it
                    eos_id = getattr(self.policy.cfg, "eos_token_id", None)
                    if eos_id is not None and next_token == eos_id:
                        break

                text = self.tokenizer.decode(generated)
                responses.append(text)

        self.policy.train()
        return responses

    # ------------------------------------------------------------------
    # Scoring
    # ------------------------------------------------------------------

    def _score_response(self, prompt: str, response: str) -> float:
        """
        Compute a scalar reward in [-1, 1] for a (prompt, response) pair.

        - If a reward model is loaded: use its score (baseline 0.5 otherwise).
        - If use_code_reward: extract Python blocks, run them, and adjust score.
        - Final value is clamped to [-1, 1].
        """
        # Base score from reward model or prior
        if self.reward_model is not None:
            try:
                base_score = self.reward_model.score(prompt, response, self.tokenizer)
                # reward_model scores are unbounded; map via tanh to (-1, 1)
                base_score = float(torch.tanh(torch.tensor(base_score)).item())
            except Exception:  # noqa: BLE001
                base_score = 0.5
        else:
            base_score = 0.5

        # Code execution bonus/penalty
        if self.cfg.use_code_reward and self._code_runner_available:
            from logic.code_runner import extract_code_blocks, run_python

            blocks = extract_code_blocks(response)
            python_blocks = [b for b in blocks if b.language == "python"]

            if python_blocks:
                # Score all blocks; take the worst-case to penalize any failure
                all_passed = True
                any_error = False
                for block in python_blocks:
                    result = run_python(block.code, timeout=10)
                    if result["returncode"] != 0 or result.get("error"):
                        all_passed = False
                        any_error = True
                    elif result.get("timed_out"):
                        all_passed = False

                if all_passed:
                    base_score += 0.5
                elif any_error:
                    base_score -= 0.3

        return float(max(-1.0, min(1.0, base_score)))

    # ------------------------------------------------------------------
    # Log-probability computation
    # ------------------------------------------------------------------

    def _compute_log_probs(
        self,
        model: ProverbsLM,
        input_ids: torch.Tensor,
        response_start: int,
    ) -> torch.Tensor:
        """
        Run model forward on input_ids and return the sum of log-probabilities
        over response tokens (positions response_start .. T-1).

        Parameters
        ----------
        model          : Policy or reference model.
        input_ids      : (1, T) token ids (prompt + response concatenated).
        response_start : Token index where the response begins.

        Returns
        -------
        Scalar tensor: sum of log P(token_t | tokens_{<t}) for t in response.
        """
        out = model(input_ids=input_ids)
        logits = out["logits"]  # (1, T, vocab_size)

        # Shift: logits[t] predicts token[t+1]
        # Response tokens occupy positions [response_start .. T-1] in input_ids.
        # Their prediction logits are at positions [response_start-1 .. T-2].
        shift_logits = logits[0, response_start - 1 : -1, :]  # (R, vocab_size)
        target_ids = input_ids[0, response_start:]             # (R,)

        log_probs = F.log_softmax(shift_logits, dim=-1)        # (R, vocab_size)
        token_log_probs = log_probs.gather(
            dim=-1, index=target_ids.unsqueeze(-1)
        ).squeeze(-1)                                           # (R,)

        return token_log_probs.sum()

    # ------------------------------------------------------------------
    # Single training step
    # ------------------------------------------------------------------

    def train_step(self, prompt: str) -> dict:
        """
        Perform one GRPO update on a single prompt.

        Steps
        -----
        1. Sample G responses from the current policy.
        2. Score each response to get rewards r_1 .. r_G.
        3. Compute group-normalized advantages: A_i = (r_i - mean) / std.
        4. For each response compute:
               policy_log_prob  (with gradients)
               reference_log_prob (no grad)
               per-token KL = policy_log_prob_dist - ref_log_prob_dist  (averaged)
        5. Loss = -mean(A_i * policy_log_prob_i) + kl_coeff * mean(KL_i)
        6. Backprop and optimizer step.

        Returns
        -------
        dict with keys: loss, mean_reward, std_reward, mean_kl.
        """
        cfg = self.cfg
        prompt_ids = self.tokenizer.encode(prompt)
        prompt_len = len(prompt_ids)

        # 1. Sample responses
        responses = self._sample_responses(prompt)

        # 2. Score each response
        rewards = [self._score_response(prompt, r) for r in responses]
        rewards_t = torch.tensor(rewards, dtype=torch.float32)

        # 3. Group-normalize advantages
        r_mean = rewards_t.mean()
        r_std = rewards_t.std(unbiased=False).clamp(min=cfg.advantage_eps)
        advantages = (rewards_t - r_mean) / r_std  # shape: (G,)

        # 4. Compute log-probs and KL for each response
        policy_log_probs: list[torch.Tensor] = []
        kl_terms: list[torch.Tensor] = []

        for response, advantage in zip(responses, advantages):
            response_ids = self.tokenizer.encode(response)
            if not response_ids:
                # Empty response: skip (contribute zero to loss)
                policy_log_probs.append(torch.tensor(0.0, device=self.device))
                kl_terms.append(torch.tensor(0.0, device=self.device))
                continue

            full_ids = prompt_ids + response_ids
            input_ids = torch.tensor(
                [full_ids], dtype=torch.long, device=self.device
            )
            response_start = prompt_len

            # Policy log-prob (with grad)
            self.policy.train()
            policy_lp = self._compute_log_probs(self.policy, input_ids, response_start)
            policy_log_probs.append(policy_lp)

            # Per-token KL: E[log(pi/ref)] estimated from token distributions
            with torch.no_grad():
                ref_out = self.reference(input_ids=input_ids)
                ref_logits = ref_out["logits"]  # (1, T, vocab_size)

            # Re-run policy forward to get full distribution (detached for KL numerator)
            pol_out = self.policy(input_ids=input_ids)
            pol_logits = pol_out["logits"]  # (1, T, vocab_size)

            shift_slice = slice(response_start - 1, input_ids.shape[1] - 1)
            pol_log_dist = F.log_softmax(pol_logits[0, shift_slice, :], dim=-1)  # (R, V)
            ref_log_dist = F.log_softmax(ref_logits[0, shift_slice, :], dim=-1)  # (R, V)

            # KL(policy || reference) = sum_v policy * (log policy - log ref)
            pol_dist = pol_log_dist.exp()
            kl_per_token = (pol_dist * (pol_log_dist - ref_log_dist)).sum(dim=-1)  # (R,)
            kl_terms.append(kl_per_token.mean())

        # Stack into tensors
        policy_lp_t = torch.stack(policy_log_probs)          # (G,)
        kl_t = torch.stack(kl_terms)                         # (G,)
        adv_t = advantages.to(self.device)                   # (G,)

        # 5. GRPO loss
        pg_loss = -(adv_t * policy_lp_t).mean()
        kl_loss = kl_t.mean()
        loss = pg_loss + cfg.kl_coeff * kl_loss

        # 6. Backprop
        self.optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(self.policy.parameters(), max_norm=1.0)
        self.optimizer.step()

        return {
            "loss": loss.item(),
            "pg_loss": pg_loss.item(),
            "kl_loss": kl_loss.item(),
            "mean_reward": float(r_mean.item()),
            "std_reward": float(r_std.item()),
            "mean_kl": float(kl_t.mean().item()),
        }

    # ------------------------------------------------------------------
    # Full training loop
    # ------------------------------------------------------------------

    def train(self) -> list[dict]:
        """
        Run max_steps train_step calls, cycling through the prompt list.

        Returns
        -------
        List of per-step metric dicts (loss, mean_reward, std_reward, mean_kl).
        """
        if not self.prompts:
            raise ValueError("[grpo] prompts list is empty — cannot train.")

        history: list[dict] = []
        n_prompts = len(self.prompts)

        if _HAS_TQDM:
            pbar = _tqdm(total=self.max_steps, desc="grpo", unit="step")
        else:
            pbar = None

        for step in range(self.max_steps):
            prompt = self.prompts[step % n_prompts]
            metrics = self.train_step(prompt)
            metrics["step"] = step
            history.append(metrics)

            msg = (
                f"step={step + 1:>4d}/{self.max_steps}  "
                f"loss={metrics['loss']:.4f}  "
                f"pg={metrics['pg_loss']:.4f}  "
                f"kl={metrics['kl_loss']:.4f}  "
                f"mean_r={metrics['mean_reward']:.3f}  "
                f"std_r={metrics['std_reward']:.3f}"
            )
            if pbar is not None:
                pbar.set_postfix_str(
                    f"loss={metrics['loss']:.4f} "
                    f"mean_r={metrics['mean_reward']:.3f}"
                )
                pbar.update(1)
            else:
                print(f"[grpo] {msg}")

        if pbar is not None:
            pbar.close()

        print(
            f"[grpo] Training complete.  "
            f"Final loss={history[-1]['loss']:.4f}  "
            f"mean_reward={history[-1]['mean_reward']:.3f}"
        )
        return history
