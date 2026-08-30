"""
training/muon.py — Muon optimizer: orthogonal gradient updates via Newton-Schulz
iteration for 2D Linear weights, AdamW fallback for all other parameters.
"""

from __future__ import annotations

import torch
import torch.nn as nn
from torch import Tensor


# ---------------------------------------------------------------------------
# Newton-Schulz orthogonalization
# ---------------------------------------------------------------------------

def zeropower_via_newtonschulz(G: Tensor, steps: int = 5) -> Tensor:
    """Return the nearest orthogonal matrix to G, rescaled to G's original Frobenius norm."""
    if G.ndim != 2:
        return G

    norm = G.norm()
    if norm == 0:
        return G

    # Normalize; work in float32 for numerical stability
    orig_dtype = G.dtype
    X = (G / norm).to(torch.float32)

    tall = X.shape[0] >= X.shape[1]  # (m, n) — tall if m >= n
    for _ in range(steps):
        if tall:
            X = 1.5 * X - 0.5 * X @ X.T @ X
        else:
            X = 1.5 * X - 0.5 * X.T @ X @ X

    return (X * norm).to(orig_dtype)


# ---------------------------------------------------------------------------
# Muon optimizer
# ---------------------------------------------------------------------------

class Muon(torch.optim.Optimizer):
    """
    Muon: momentum + Newton-Schulz orthogonalization for 2D Linear weights;
    AdamW for all other parameters.

    Parameters
    ----------
    params       : Iterable of parameters for the muon (orthogonal) group.
    lr           : Learning rate for muon group.
    momentum     : Momentum coefficient for muon group.
    nesterov     : If True, apply Nesterov momentum before orthogonalizing.
    ns_steps     : Newton-Schulz iteration count.
    adamw_params : Parameters for the AdamW fallback group (1D, embeddings, norms).
    adamw_lr     : Learning rate for AdamW group.
    adamw_betas  : (beta1, beta2) for AdamW group.
    adamw_wd     : Weight decay for AdamW group.
    """

    def __init__(
        self,
        params,
        lr: float = 0.02,
        momentum: float = 0.95,
        nesterov: bool = True,
        ns_steps: int = 5,
        adamw_params=None,
        adamw_lr: float = 3e-4,
        adamw_betas: tuple[float, float] = (0.9, 0.95),
        adamw_wd: float = 0.1,
    ) -> None:
        muon_defaults = dict(lr=lr, momentum=momentum, nesterov=nesterov, ns_steps=ns_steps)
        super().__init__(list(params), muon_defaults)

        # AdamW group stored as a separate internal optimizer
        if adamw_params is not None:
            adamw_list = list(adamw_params)
        else:
            adamw_list = []

        self._adamw: torch.optim.AdamW | None = None
        if adamw_list:
            self._adamw = torch.optim.AdamW(
                adamw_list,
                lr=adamw_lr,
                betas=adamw_betas,
                weight_decay=adamw_wd,
                eps=1e-8,
            )

    # ------------------------------------------------------------------
    # Expose AdamW state so ProverbsTrainer can save/load it
    # ------------------------------------------------------------------

    def state_dict(self):
        sd = super().state_dict()
        sd["_adamw_state"] = self._adamw.state_dict() if self._adamw is not None else None
        return sd

    def load_state_dict(self, state_dict: dict) -> None:
        adamw_sd = state_dict.pop("_adamw_state", None)
        super().load_state_dict(state_dict)
        if adamw_sd is not None and self._adamw is not None:
            self._adamw.load_state_dict(adamw_sd)

    def zero_grad(self, set_to_none: bool = True) -> None:
        super().zero_grad(set_to_none=set_to_none)
        if self._adamw is not None:
            self._adamw.zero_grad(set_to_none=set_to_none)

    # ------------------------------------------------------------------
    # Optimizer step
    # ------------------------------------------------------------------

    @torch.no_grad()
    def step(self, closure=None):
        loss = None
        if closure is not None:
            with torch.enable_grad():
                loss = closure()

        # --- Muon update (2D Linear weight params) ---
        for group in self.param_groups:
            lr = group["lr"]
            momentum = group["momentum"]
            nesterov = group["nesterov"]
            ns_steps = group["ns_steps"]

            for p in group["params"]:
                if p.grad is None:
                    continue

                g = p.grad

                state = self.state[p]
                if len(state) == 0:
                    state["buf"] = torch.zeros_like(g)

                buf: Tensor = state["buf"]
                buf.mul_(momentum).add_(g)

                if nesterov:
                    update_g = g + momentum * buf
                else:
                    update_g = buf

                # Orthogonalize — only meaningful for 2D
                ortho = zeropower_via_newtonschulz(update_g, steps=ns_steps)

                p.add_(ortho, alpha=-lr)

        # --- AdamW update (all other params) ---
        if self._adamw is not None:
            self._adamw.step()

        return loss


# ---------------------------------------------------------------------------
# Convenience constructor
# ---------------------------------------------------------------------------

def make_muon(
    model: nn.Module,
    lr: float = 0.02,
    adamw_lr: float = 3e-4,
) -> Muon:
    """Split model params into 2D Linear weights (muon) vs rest (AdamW) and return Muon."""
    muon_params: list[nn.Parameter] = []
    adamw_params: list[nn.Parameter] = []

    for module in model.modules():
        if isinstance(module, nn.Linear):
            for name, p in module.named_parameters(recurse=False):
                if p.requires_grad:
                    if p.ndim == 2:
                        muon_params.append(p)
                    else:
                        adamw_params.append(p)
        # Non-Linear modules: all params go to AdamW
        # (embeddings, norms, biases already caught above if not Linear)

    # Catch any remaining params not inside a Linear (e.g. embeddings, norm weights)
    linear_param_ids = {id(p) for p in muon_params} | {id(p) for p in adamw_params}
    for p in model.parameters():
        if p.requires_grad and id(p) not in linear_param_ids:
            adamw_params.append(p)

    return Muon(
        params=muon_params,
        lr=lr,
        adamw_params=adamw_params,
        adamw_lr=adamw_lr,
    )
