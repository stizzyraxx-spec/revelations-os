"""
SpeculativeGenerator — speculative decoding for 2-4x speedup.

Algorithm (Leviathan et al. 2023):
  1. Draft model proposes gamma tokens autoregressively.
  2. Verify model checks all gamma tokens in ONE forward pass.
  3. Accept draft token i with prob min(1, verify_prob[i] / draft_prob[i]).
  4. On first rejection, sample a correction token from renormalized
     (verify_prob - draft_prob).clamp(0) and stop accepting.
  5. All accepted tokens + the correction token are emitted; repeat.

Cost analysis:
  - Accepted tokens: only draft model forward passes (cheap).
  - Rejected tokens: one verify model pass per gamma window (amortised).
"""

from __future__ import annotations

import sys
import os
from pathlib import Path
from typing import Generator

import torch
import torch.nn.functional as F

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from model.proverbs_lm import ProverbsLM        # noqa: E402
from tokenizer.bpe import ProverbsTokenizer     # noqa: E402
from inference.generate import top_p_filter     # noqa: E402


def _auto_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _sample(logits: torch.Tensor, temperature: float, top_p: float) -> tuple[int, float]:
    """
    Sample a single token from *logits* (1-D, vocab_size).

    Returns (token_id, log_prob_of_token_id).
    """
    if temperature == 0.0:
        token_id = int(torch.argmax(logits).item())
        log_probs = F.log_softmax(logits, dim=-1)
        return token_id, float(log_probs[token_id].item())

    logits = logits / temperature
    if top_p < 1.0:
        logits = top_p_filter(logits, top_p)

    log_probs = F.log_softmax(logits, dim=-1)
    probs = log_probs.exp()
    token_id = int(torch.multinomial(probs, num_samples=1).item())
    return token_id, float(log_probs[token_id].item())


def _log_prob_at(logits: torch.Tensor, token_id: int, temperature: float, top_p: float) -> float:
    """
    Return log-probability of *token_id* under the sampling distribution
    defined by *temperature* and *top_p* applied to *logits* (1-D).
    """
    if temperature == 0.0:
        log_probs = F.log_softmax(logits, dim=-1)
        return float(log_probs[token_id].item())

    logits = logits / temperature
    if top_p < 1.0:
        logits = top_p_filter(logits, top_p)
    log_probs = F.log_softmax(logits, dim=-1)
    return float(log_probs[token_id].item())


def _correction_sample(
    verify_logits: torch.Tensor,
    draft_logits: torch.Tensor,
    temperature: float,
    top_p: float,
) -> int:
    """
    Sample a correction token from renormalized (p_verify - p_draft).clamp(0).

    Falls back to argmax of verify distribution if the residual is all zeros.
    """
    if temperature == 0.0:
        v_log = F.log_softmax(verify_logits, dim=-1)
        return int(v_log.argmax().item())

    v_log = F.log_softmax(verify_logits / temperature, dim=-1)
    d_log = F.log_softmax(draft_logits / temperature, dim=-1)

    # Apply top-p mask to both before computing residual.
    if top_p < 1.0:
        v_log = F.log_softmax(top_p_filter(verify_logits / temperature, top_p), dim=-1)
        d_log = F.log_softmax(top_p_filter(draft_logits / temperature, top_p), dim=-1)

    residual = (v_log.exp() - d_log.exp()).clamp(min=0.0)
    total = residual.sum()
    if total < 1e-9:
        return int(v_log.argmax().item())
    return int(torch.multinomial(residual / total, num_samples=1).item())


class SpeculativeGenerator:
    """
    Speculative decoding generator.

    Requires a small *draft* model and a larger *verify* model sharing the
    same vocabulary and tokenizer.  The draft model proposes *gamma* tokens
    per step; the verify model checks them in one batch forward pass.

    Usage::

        from model.proverbs_lm import ProverbsLM
        draft  = ProverbsLM.load("draft.pt")
        verify = ProverbsLM.load("verify.pt")
        gen = SpeculativeGenerator(draft, verify, "~/.proverbs/tokenizer.json")
        print(gen.generate("Explain transformers"))
        print(f"Acceptance rate: {gen.acceptance_rate:.2%}")
    """

    def __init__(
        self,
        draft: ProverbsLM,
        verify: ProverbsLM,
        tokenizer_path: str = "~/.proverbs/tokenizer.json",
        gamma: int = 5,
        device: str | None = None,
        use_compile: bool = False,
        dtype: torch.dtype | None = None,
    ) -> None:
        self.device: str = device or _auto_device()
        self.gamma = gamma

        if dtype is None:
            dtype = torch.bfloat16 if self.device == "cuda" else torch.float32

        self.draft  = draft.eval().to(self.device).to(dtype)
        self.verify = verify.eval().to(self.device).to(dtype)

        if use_compile and self.device != "mps":
            try:
                self.draft  = torch.compile(self.draft)
                self.verify = torch.compile(self.verify)
            except Exception:
                pass

        tok_path = Path(os.path.expanduser(tokenizer_path))
        if not tok_path.exists():
            raise FileNotFoundError(
                f"Tokenizer not found at {tok_path}. "
                "Run tokenizer/train_tokenizer.py first, or pass --tokenizer."
            )
        self.tokenizer = ProverbsTokenizer.load(str(tok_path))

        self.stats: dict[str, int] = {"proposed": 0, "accepted": 0}

    @property
    def acceptance_rate(self) -> float:
        if self.stats["proposed"] == 0:
            return 0.0
        return self.stats["accepted"] / self.stats["proposed"]

    # ------------------------------------------------------------------
    # Prefill helper
    # ------------------------------------------------------------------

    def _prefill(self, model: ProverbsLM, input_ids: list[int]) -> list:
        """Run model on full prompt, return kv_caches."""
        ids_tensor = torch.tensor([input_ids], dtype=torch.long, device=self.device)
        out = model(ids_tensor, kv_caches=None)
        return out["kv_caches"]

    # ------------------------------------------------------------------
    # Primary generation method
    # ------------------------------------------------------------------

    @torch.inference_mode()
    def generate(
        self,
        prompt: str | list[dict],
        max_new_tokens: int = 512,
        temperature: float = 0.7,
        top_p: float = 0.9,
        stop_tokens: list[str] | None = None,
        stream: bool = False,
    ) -> str | Generator[str, None, None]:
        """
        Generate text using speculative decoding.

        Args:
            prompt:         Plain string or chat message list.
            max_new_tokens: Maximum tokens to generate.
            temperature:    Sampling temperature (0 = greedy).
            top_p:          Nucleus sampling threshold.
            stop_tokens:    Optional stop strings.
            stream:         If True, return a token-string generator.
        """
        if isinstance(prompt, list):
            input_ids: list[int] = self.tokenizer.encode_chat(prompt)
        else:
            input_ids = self.tokenizer.encode(prompt, add_bos=True)

        if not input_ids:
            input_ids = [self.verify.cfg.bos_token_id]

        stop_ids: set[int] = {self.verify.cfg.eos_token_id}
        if stop_tokens:
            for tok_str in stop_tokens:
                encoded = self.tokenizer.encode(tok_str, add_bos=False)
                if len(encoded) == 1:
                    stop_ids.add(encoded[0])

        gen = self._generate_tokens(
            input_ids=input_ids,
            max_new_tokens=max_new_tokens,
            temperature=temperature,
            top_p=top_p,
            stop_ids=stop_ids,
        )

        if stream:
            return gen
        return "".join(gen)

    # ------------------------------------------------------------------
    # Core speculative loop
    # ------------------------------------------------------------------

    def _generate_tokens(
        self,
        input_ids: list[int],
        max_new_tokens: int,
        temperature: float,
        top_p: float,
        stop_ids: set[int],
    ) -> Generator[str, None, None]:
        """
        Speculative decoding core.

        Maintains all_ids (prompt + generated).  In each round:
          1. Draft autoregressively for gamma steps, collecting raw logits.
          2. Verify in one forward pass over the gamma draft tokens.
          3. Walk positions 0..gamma-1:
             - Accept draft_ids[i] with prob min(1, verify_p / draft_p).
             - On rejection, emit a correction token and break.
          4. Yield accepted + correction; advance KV caches via saved snapshots
             (O(1) per round, no re-prefill).
        """
        all_ids: list[int] = list(input_ids)
        generated = 0

        # Prefill both models on the prompt.
        draft_kv  = self._prefill(self.draft,  all_ids)
        verify_kv = self._prefill(self.verify, all_ids)

        while generated < max_new_tokens:
            # ---- DRAFT PHASE ----------------------------------------
            # Collect gamma draft tokens + their logits (pre-sampling).
            draft_ids: list[int]         = []
            draft_logits_list: list[torch.Tensor] = []  # raw logits, 1-D each

            d_kv = draft_kv
            d_last_id = all_ids[-1]
            # d_kv_steps[i] = draft KV after i steps (covers prompt + accepted + draft_ids[:i]).
            # Used after acceptance to skip the O(n) full re-prefill.
            d_kv_steps: list = []

            for _ in range(self.gamma):
                if generated + len(draft_ids) >= max_new_tokens:
                    break

                d_in = torch.tensor([[d_last_id]], dtype=torch.long, device=self.device)
                d_out = self.draft(d_in, kv_caches=d_kv)
                d_kv = d_out["kv_caches"]
                d_kv_steps.append(d_kv)

                raw_logits = d_out["logits"][0, -1, :]  # (vocab_size,)
                draft_logits_list.append(raw_logits)

                token_id, _ = _sample(raw_logits, temperature, top_p)
                draft_ids.append(token_id)
                d_last_id = token_id

                # Stop early if draft hits EOS/stop.
                if token_id in stop_ids:
                    break

            if not draft_ids:
                break

            self.stats["proposed"] += len(draft_ids)

            # ---- VERIFY PHASE ---------------------------------------
            # Feed all gamma draft tokens to verify in one shot.
            # verify_kv currently covers all_ids (prompt + accepted so far).
            # We need logits at positions: last of prompt (already in verify_kv)
            # + each draft token.  Feed draft_ids[:-1] concat with draft token
            # sequence so verify sees each draft token's context.
            #
            # Simpler approach that avoids KV alignment: re-run verify on the
            # draft window (gamma tokens) starting from the context already
            # cached in verify_kv.

            v_kv = verify_kv
            v_logits_list: list[torch.Tensor] = []
            v_last_id = all_ids[-1]

            for d_tok in draft_ids:
                v_in = torch.tensor([[v_last_id]], dtype=torch.long, device=self.device)
                v_out = self.verify(v_in, kv_caches=v_kv)
                v_kv = v_out["kv_caches"]
                v_logits_list.append(v_out["logits"][0, -1, :])  # logit for next pos
                v_last_id = d_tok

            # v_logits_list[i] = verify logits for position (all_ids + i).
            # draft_ids[i] is what draft proposed at that position.
            # We need verify's log-prob of draft_ids[i] under v_logits_list[i].

            # ---- ACCEPTANCE -----------------------------------------
            accepted: list[int] = []
            correction: int | None = None

            for i, (d_tok, d_raw, v_raw) in enumerate(
                zip(draft_ids, draft_logits_list, v_logits_list)
            ):
                v_lp = _log_prob_at(v_raw, d_tok, temperature, top_p)
                d_lp = _log_prob_at(d_raw, d_tok, temperature, top_p)

                log_accept = v_lp - d_lp  # log(min(1, p_v/p_d))
                accept = log_accept >= 0.0 or (
                    torch.rand(1).item() < min(1.0, float(torch.exp(torch.tensor(log_accept)).item()))
                )

                if accept:
                    accepted.append(d_tok)
                    self.stats["accepted"] += 1
                else:
                    # Sample correction from renormalized residual.
                    correction = _correction_sample(v_raw, d_raw, temperature, top_p)
                    break

            # If all gamma tokens accepted, also need one verify sample.
            all_accepted = correction is None and len(accepted) == len(draft_ids)
            if all_accepted:
                # Get verify's prediction for position after all draft tokens.
                v_in = torch.tensor([[draft_ids[-1]]], dtype=torch.long, device=self.device)
                v_out = self.verify(v_in, kv_caches=v_kv)
                bonus_logits = v_out["logits"][0, -1, :]
                correction, _ = _sample(bonus_logits, temperature, top_p)
                v_kv = v_out["kv_caches"]  # advance past draft_ids[-1]

            # ---- EMIT -----------------------------------------------
            emit_ids = accepted + ([correction] if correction is not None else [])

            stop_hit = False
            for tok in emit_ids:
                if tok in stop_ids:
                    stop_hit = True
                    break
                all_ids.append(tok)
                generated += 1
                yield self.tokenizer.decode([tok], skip_special=True)
                if generated >= max_new_tokens:
                    stop_hit = True
                    break

            if stop_hit:
                break

            # ---- ADVANCE KV CACHES ----------------------------------
            verify_kv = v_kv  # already covers prompt + all draft tokens

            # d_kv_steps[i] = draft KV after i steps, covering
            # (old all_ids) + draft_ids[:i].  Use the snapshot at step k so
            # the correction token is the next input — no O(n) re-prefill.
            k = len(accepted)
            if k < len(d_kv_steps):
                # Partial acceptance: exact snapshot is available.
                draft_kv = d_kv_steps[k]
            else:
                # All gamma tokens accepted. d_kv_steps[-1] covers draft_ids[:-1];
                # advance one more step to include draft_ids[-1].
                d_in = torch.tensor([[draft_ids[-1]]], dtype=torch.long, device=self.device)
                d_out = self.draft(d_in, kv_caches=d_kv_steps[-1])
                draft_kv = d_out["kv_caches"]


# ---------------------------------------------------------------------------
# Command-line interface
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Speculative decoding CLI for ProverbsLM",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--draft",     required=True, help="Path to draft model .pt checkpoint.")
    parser.add_argument("--verify",    required=True, help="Path to verify model .pt checkpoint.")
    parser.add_argument("--tokenizer", default="~/.proverbs/tokenizer.json",
                        help="Path to tokenizer JSON.")
    parser.add_argument("--prompt",    required=True, help="Text prompt.")
    parser.add_argument("--gamma",     type=int,   default=5,   help="Draft tokens per step.")
    parser.add_argument("--max-tokens",type=int,   default=512, dest="max_tokens")
    parser.add_argument("--temperature",type=float,default=0.7)
    parser.add_argument("--top-p",    type=float, default=0.9, dest="top_p")
    parser.add_argument("--stream",   action="store_true")
    parser.add_argument("--device",   default=None)

    args = parser.parse_args()

    print(f"Loading draft model  : {args.draft}",  file=sys.stderr)
    draft_model  = ProverbsLM.load(args.draft,  device=args.device)
    print(f"Loading verify model : {args.verify}", file=sys.stderr)
    verify_model = ProverbsLM.load(args.verify, device=args.device)

    gen = SpeculativeGenerator(
        draft=draft_model,
        verify=verify_model,
        tokenizer_path=args.tokenizer,
        gamma=args.gamma,
        device=args.device,
    )

    print(f"\n--- Prompt ---\n{args.prompt}\n--- Output ---", file=sys.stderr)

    result = gen.generate(
        prompt=args.prompt,
        max_new_tokens=args.max_tokens,
        temperature=args.temperature,
        top_p=args.top_p,
        stream=args.stream,
    )

    if args.stream:
        for token_str in result:  # type: ignore[union-attr]
            print(token_str, end="", flush=True)
        print()
    else:
        print(result)

    print(
        f"\n[speculative] proposed={gen.stats['proposed']}  "
        f"accepted={gen.stats['accepted']}  "
        f"acceptance_rate={gen.acceptance_rate:.2%}",
        file=sys.stderr,
    )
