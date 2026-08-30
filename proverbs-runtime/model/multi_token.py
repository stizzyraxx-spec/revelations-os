"""
multi_token.py — Multi-token prediction heads for ProverbsLM.

Adds N extra heads that predict t+2, t+3, ... in parallel with the main head (t+1).
During training all heads contribute to the loss (weight=0.3 from literature).
During inference the extra heads act as a built-in speculative decoder: accept an
extra-head token greedily when its probability exceeds 0.9, verify on the next pass.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .proverbs_lm import ProverbsLM


# ── MultiTokenHead ────────────────────────────────────────────────────────────

class MultiTokenHead(nn.Module):
    def __init__(self, d_model: int, vocab_size: int, n_future: int = 2):
        super().__init__()
        # Each head: Linear(d_model→d_model) → SiLU → Linear(d_model→vocab_size)
        self.heads = nn.ModuleList([
            nn.Sequential(
                nn.Linear(d_model, d_model, bias=False),
                nn.SiLU(),
                nn.Linear(d_model, vocab_size, bias=False),
            )
            for _ in range(n_future)
        ])
        self.n_future = n_future

    def forward(self, hidden_states: torch.Tensor) -> list[torch.Tensor]:
        return [head(hidden_states) for head in self.heads]


# ── Attach heads + patch forward ─────────────────────────────────────────────

def add_multi_token_heads(model: "ProverbsLM", n_future: int = 2) -> "ProverbsLM":
    """Attach MultiTokenHead to model and monkey-patch forward to include extra losses."""
    model.extra_heads = MultiTokenHead(model.cfg.d_model, model.cfg.vocab_size, n_future)

    _orig_forward = model.__class__.forward

    def _patched_forward(self, input_ids, labels=None, kv_caches=None):
        result = _orig_forward(self, input_ids, labels=labels, kv_caches=kv_caches)

        if labels is None:
            # Inference: expose extra logits so speculative decode can use them
            # We need hidden states — re-run the norm output from the last layer.
            # Since we cannot easily extract hidden states without refactoring,
            # we store them on the result via a side-channel set in forward.
            # Instead, expose raw logits derived from lm_head inverse is not possible;
            # use a lightweight re-embed trick: run extra_heads on lm_head weight
            # projected back — but that is lossy. The clean path is to cache h below.
            # We therefore store h in result["_hidden"] when extra_heads is present.
            h = result.get("_hidden")
            if h is not None:
                result["extra_logits"] = self.extra_heads(h)
            return result

        # Training: compute extra-head losses
        h = result.get("_hidden")
        if h is None:
            return result

        pad = self.cfg.pad_token_id
        extra_losses = []
        for i, head_logits in enumerate(self.extra_heads(h)):
            shift = i + 2   # head 0 → t+2, head 1 → t+3, ...
            # logits: predict position t → target t+shift
            # valid source positions: 0 .. T-shift-1
            # valid target positions: shift .. T-1
            T = head_logits.shape[1]
            if T <= shift:
                continue
            src_logits = head_logits[:, :T - shift, :].contiguous()
            tgt_labels = labels[:, shift:].contiguous()
            extra_losses.append(
                F.cross_entropy(
                    src_logits.view(-1, self.cfg.vocab_size),
                    tgt_labels.view(-1),
                    ignore_index=pad,
                )
            )

        if extra_losses and "loss" in result:
            result["loss"] = result["loss"] + 0.3 * torch.stack(extra_losses).mean()

        return result

    # Patch ProverbsLM.forward to stash hidden states so extra heads can use them
    _orig_cls_forward = model.__class__.forward

    def _hidden_capturing_forward(self, input_ids, labels=None, kv_caches=None):
        import torch
        from .transformer import make_causal_mask

        B, T = input_ids.shape
        device, dtype = input_ids.device, self.token_embed.weight.dtype

        x = self.drop(self.token_embed(input_ids).to(dtype))
        mask = make_causal_mask(T, device, dtype) if T > 1 else None

        new_kv_caches = []
        aux_losses = []
        for i, layer in enumerate(self.layers):
            kv = kv_caches[i] if kv_caches is not None else None
            x, new_kv, aux_loss = layer(x, mask=mask, kv_cache=kv)
            new_kv_caches.append(new_kv)
            aux_losses.append(aux_loss)

        x = self.norm(x)
        logits = self.lm_head(x)

        result = {"logits": logits, "kv_caches": new_kv_caches, "_hidden": x}

        if labels is not None:
            shift_logits = logits[:, :-1, :].contiguous()
            shift_labels = labels[:, 1:].contiguous()
            loss = torch.nn.functional.cross_entropy(
                shift_logits.view(-1, self.cfg.vocab_size),
                shift_labels.view(-1),
                ignore_index=self.cfg.pad_token_id,
            )
            total_aux = [l for l in aux_losses if l is not None]
            if total_aux:
                loss = loss + sum(total_aux)
            result["loss"] = loss

        return result

    import types
    model.forward = types.MethodType(_hidden_capturing_forward, model)

    # Now layer the extra-head loss on top
    _base_forward = model.forward

    def _full_forward(input_ids, labels=None, kv_caches=None):
        result = _base_forward(input_ids, labels=labels, kv_caches=kv_caches)

        h = result.get("_hidden")
        if h is None:
            return result

        extra_head_outputs = model.extra_heads(h)

        if labels is None:
            result["extra_logits"] = extra_head_outputs
            return result

        pad = model.cfg.pad_token_id
        extra_losses = []
        for i, head_logits in enumerate(extra_head_outputs):
            shift = i + 2
            T = head_logits.shape[1]
            if T <= shift:
                continue
            src_logits = head_logits[:, :T - shift, :].contiguous()
            tgt_labels = labels[:, shift:].contiguous()
            extra_losses.append(
                F.cross_entropy(
                    src_logits.view(-1, model.cfg.vocab_size),
                    tgt_labels.view(-1),
                    ignore_index=pad,
                )
            )

        if extra_losses and "loss" in result:
            result["loss"] = result["loss"] + 0.3 * torch.stack(extra_losses).mean()

        return result

    model.forward = _full_forward
    return model


# ── Speculative multi-token generation ───────────────────────────────────────

def multi_token_generate(
    model: "ProverbsLM",
    tokenizer,
    prompt_ids: list[int],
    max_new_tokens: int,
    temperature: float = 0.7,
) -> list[int]:
    """
    Autoregressive generation with speculative acceptance of extra-head predictions.

    After each main token, extra head i predicts token t+(i+2).  If the
    probability of that prediction exceeds 0.9, it is tentatively accepted.
    On the next forward pass the main head re-scores the candidate; if the
    main head agrees (argmax matches), the token is kept, otherwise a sample
    from the main head is used instead.
    """
    device = next(model.parameters()).device
    has_extra = hasattr(model, "extra_heads")

    ids = list(prompt_ids)
    # speculative slots: index → candidate token id
    speculative: dict[int, int] = {}

    generated = 0
    while generated < max_new_tokens:
        input_ids = torch.tensor([ids], dtype=torch.long, device=device)
        with torch.no_grad():
            out = model(input_ids)

        logits = out["logits"][0, -1, :]  # (vocab_size,)
        extra_logits: list[torch.Tensor] = out.get("extra_logits", [])

        # Sample / pick main token at position len(ids)
        if temperature <= 0.0:
            next_tok = int(logits.argmax())
        else:
            probs = F.softmax(logits / temperature, dim=-1)
            next_tok = int(torch.multinomial(probs, 1))

        # Verify any speculative token that was staged for this position
        pos = len(ids)
        if pos in speculative:
            candidate = speculative.pop(pos)
            main_probs = F.softmax(logits, dim=-1)
            if int(main_probs.argmax()) == candidate:
                next_tok = candidate  # accept speculative token
            # else: keep next_tok sampled from main head

        ids.append(next_tok)
        generated += 1

        if next_tok == tokenizer.eos_token_id if hasattr(tokenizer, "eos_token_id") else False:
            break

        # Stage extra-head predictions for future positions
        if has_extra:
            for i, el in enumerate(extra_logits):
                future_pos = pos + i + 2   # head 0 → pos+2, head 1 → pos+3
                if future_pos in speculative:
                    continue  # already staged from an earlier pass
                head_logits_last = el[0, -1, :]  # (vocab_size,)
                head_probs = F.softmax(head_logits_last, dim=-1)
                best_prob, best_tok = head_probs.max(dim=-1)
                if float(best_prob) > 0.9:
                    speculative[future_pos] = int(best_tok)

        if generated >= max_new_tokens:
            break

    return ids[len(prompt_ids):]
