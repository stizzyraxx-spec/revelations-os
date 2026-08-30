"""
RewardModel — quality scoring model trained on preference pairs.

Architecture:
  Shares transformer backbone (token_embed → [TransformerBlock x N] → RMSNorm)
  with a frozen ProverbsLM, then projects the hidden state at the last
  non-padding position through a scalar score_head.

Training uses Bradley-Terry loss over (chosen, rejected) pairs:
  -log(sigmoid(score_chosen - score_rejected))
"""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F
from pathlib import Path
from typing import Any

from .proverbs_lm import ProverbsLM, _best_device


class RewardModel(nn.Module):
    def __init__(self, lm: ProverbsLM):
        super().__init__()
        self.cfg = lm.cfg

        # Share backbone weights (no copy — same tensors)
        self.token_embed = lm.token_embed
        self.drop        = lm.drop
        self.layers      = lm.layers
        self.norm        = lm.norm
        # lm_head is intentionally excluded; reward is a scalar

        # Scalar head — near-zero init so early scores are near 0
        self.score_head = nn.Linear(self.cfg.d_model, 1, bias=False)
        nn.init.normal_(self.score_head.weight, mean=0.0, std=0.002)

    # ── Forward ───────────────────────────────────────────────────────────────

    def forward(self, input_ids: torch.Tensor) -> torch.Tensor:
        """
        Args:
            input_ids: (B, T) token ids, pad_token_id used for padding.
        Returns:
            scores: (B, 1) scalar reward score per example.
        """
        from .transformer import make_causal_mask

        cfg = self.cfg
        B, T = input_ids.shape
        device = input_ids.device
        dtype = self.token_embed.weight.dtype

        x = self.drop(self.token_embed(input_ids).to(dtype))

        mask = make_causal_mask(T, device, dtype) if T > 1 else None

        for layer in self.layers:
            x, _, _ = layer(x, mask=mask, kv_cache=None)

        x = self.norm(x)  # (B, T, d_model)

        # Find last non-padding position for each batch element
        pad_id = cfg.pad_token_id
        non_pad = (input_ids != pad_id).long()           # (B, T)
        # last non-pad index: argmax of reversed non_pad along T
        seq_lens = non_pad.sum(dim=1).clamp(min=1) - 1   # (B,)
        # gather hidden state at that position
        idx = seq_lens.view(B, 1, 1).expand(B, 1, x.size(-1))
        last_hidden = x.gather(dim=1, index=idx).squeeze(1)  # (B, d_model)

        scores = self.score_head(last_hidden)  # (B, 1)
        return scores

    # ── Convenience ───────────────────────────────────────────────────────────

    def score(self, prompt: str, response: str, tokenizer: Any) -> float:
        """
        Encode prompt+response, run forward, return scalar float.

        Args:
            prompt: raw prompt string.
            response: raw response string.
            tokenizer: object with an encode(text) -> list[int] method.
        Returns:
            Scalar quality score (higher is better).
        """
        text = prompt + response
        ids = tokenizer.encode(text)
        input_ids = torch.tensor([ids], dtype=torch.long,
                                 device=next(self.parameters()).device)
        with torch.no_grad():
            s = self.forward(input_ids)
        return float(s.squeeze())

    # ── Persistence ───────────────────────────────────────────────────────────

    def save(self, path: str | Path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        torch.save({"score_head": self.score_head.state_dict()}, path)

    def load(self, path: str | Path):
        checkpoint = torch.load(path, map_location=next(self.parameters()).device,
                                weights_only=True)
        self.score_head.load_state_dict(checkpoint["score_head"])


# ── Trainer ───────────────────────────────────────────────────────────────────

class RewardTrainer:
    def __init__(
        self,
        model: RewardModel,
        data: list[dict],          # list of {chosen_ids, rejected_ids}
        tokenizer: Any,
        lr: float = 1e-5,
        max_steps: int = 500,
    ):
        self.model     = model
        self.data      = data
        self.tokenizer = tokenizer
        self.max_steps = max_steps

        # Freeze backbone; only train score_head
        for param in model.parameters():
            param.requires_grad = False
        for param in model.score_head.parameters():
            param.requires_grad = True

        self.optimizer = torch.optim.AdamW(
            model.score_head.parameters(), lr=lr
        )

    def train(self) -> float:
        """
        Bradley-Terry training loop over preference pairs.

        Loss: -log(sigmoid(score_chosen - score_rejected))

        Returns:
            Final step loss (float).
        """
        model = self.model
        model.train()
        device = next(model.parameters()).device

        if not self.data:
            return 0.0

        loss_val = 0.0
        for step in range(self.max_steps):
            pair = self.data[step % len(self.data)]

            chosen_ids   = torch.tensor([pair["chosen_ids"]],   dtype=torch.long, device=device)
            rejected_ids = torch.tensor([pair["rejected_ids"]], dtype=torch.long, device=device)

            score_chosen   = model(chosen_ids)    # (1, 1)
            score_rejected = model(rejected_ids)  # (1, 1)

            # Bradley-Terry: -log σ(r_c - r_r)
            loss = -F.logsigmoid(score_chosen - score_rejected).mean()

            self.optimizer.zero_grad()
            loss.backward()
            self.optimizer.step()

            loss_val = loss.item()

        model.eval()
        return loss_val

    def save(self, path: str | Path):
        self.model.save(path)

    def load(self, path: str | Path):
        self.model.load(path)


# ── Factory ───────────────────────────────────────────────────────────────────

def load_reward_model(
    lm_path: str | Path,
    head_path: str | Path | None = None,
    device: str | None = None,
) -> RewardModel:
    """
    Load a ProverbsLM from lm_path, wrap it in a RewardModel, and
    optionally restore a previously saved score_head from head_path.
    """
    device = device or _best_device()
    lm     = ProverbsLM.load(lm_path, device=device)
    rm     = RewardModel(lm).to(device)
    if head_path is not None:
        rm.load(head_path)
    return rm


# ── Module-level singleton ────────────────────────────────────────────────────

reward_model: RewardModel | None = None
