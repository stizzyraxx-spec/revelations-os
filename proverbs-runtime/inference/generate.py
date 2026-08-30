"""
ProverbsGenerator — autoregressive text generation engine for ProverbsLM.

Sampling strategies supported:
  - Temperature scaling
  - Top-p (nucleus) sampling
  - Top-k sampling
  - Repetition penalty

Supports both single-shot and streaming generation.
"""

from __future__ import annotations

import sys
import os
from pathlib import Path
from typing import Generator

import torch
import torch.nn.functional as F

# ---------------------------------------------------------------------------
# Ensure the project root is on sys.path so `model/` and `tokenizer/` can be
# imported regardless of the current working directory.
# ---------------------------------------------------------------------------
_PROJECT_ROOT = Path(__file__).resolve().parent.parent  # /Users/Stizzop/proverbs
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from model.proverbs_lm import ProverbsLM  # noqa: E402
from tokenizer.bpe import ProverbsTokenizer  # noqa: E402

try:
    from inference.kv_cache_quant import QuantizedKVCache  # noqa: E402
except ImportError:
    QuantizedKVCache = None  # type: ignore[assignment,misc]


# ---------------------------------------------------------------------------
# Module-level cascade routing
# ---------------------------------------------------------------------------

cascade_generator = None


def set_cascade(gen) -> None:
    """Set the module-level cascade generator used for routing."""
    global cascade_generator
    cascade_generator = gen


# ---------------------------------------------------------------------------
# Module-level sampling helpers
# ---------------------------------------------------------------------------

def top_p_filter(logits: torch.Tensor, p: float) -> torch.Tensor:
    """
    Apply nucleus (top-p) sampling mask to *logits* (1-D tensor).

    Tokens whose cumulative probability mass exceeds *p* are masked to -inf.
    The top token is always kept so generation never stalls.

    Returns the filtered logits tensor (same shape, in-place modification on
    a copy).
    """
    if p >= 1.0:
        return logits

    logits = logits.clone()
    sorted_logits, sorted_indices = torch.sort(logits, descending=True)
    sorted_probs = F.softmax(sorted_logits, dim=-1)
    cumulative_probs = torch.cumsum(sorted_probs, dim=-1)

    # Remove tokens with cumulative probability above p (shift right by 1 so
    # we keep the token that first pushes us over the threshold).
    sorted_indices_to_remove = cumulative_probs - sorted_probs > p
    # Always keep at least the top token.
    sorted_indices_to_remove[0] = False

    indices_to_remove = sorted_indices[sorted_indices_to_remove]
    logits[indices_to_remove] = float("-inf")
    return logits


def top_k_filter(logits: torch.Tensor, k: int) -> torch.Tensor:
    """
    Apply top-k sampling mask to *logits* (1-D tensor).

    Only the *k* highest-probability tokens are kept; the rest are set to
    -inf.  When *k* <= 0 the function is a no-op.

    Returns a new filtered logits tensor.
    """
    if k <= 0:
        return logits

    logits = logits.clone()
    values, _ = torch.topk(logits, min(k, logits.size(-1)))
    min_value = values[-1]
    logits[logits < min_value] = float("-inf")
    return logits


def apply_repetition_penalty(
    logits: torch.Tensor,
    generated_ids: list[int],
    penalty: float,
) -> torch.Tensor:
    """
    Penalise tokens that already appear in *generated_ids*.

    For each token id that was previously generated:
      - If the current score is positive, divide it by *penalty*.
      - If the current score is negative, multiply it by *penalty*.

    This makes repetition less likely without completely banning tokens.

    Args:
        logits:        1-D float tensor of shape (vocab_size,).
        generated_ids: List of token ids generated so far (including prompt).
        penalty:       Values > 1.0 suppress repetition; 1.0 = no-op.

    Returns a new penalised logits tensor.
    """
    if penalty == 1.0 or not generated_ids:
        return logits

    logits = logits.clone()
    vocab_size = logits.size(0)
    unique_ids = [t for t in set(generated_ids) if t < vocab_size]
    if not unique_ids:
        return logits

    # Vectorised: one gather + one scatter instead of a Python loop that
    # launches two kernels per previously-seen token.
    idx = torch.tensor(unique_ids, dtype=torch.long, device=logits.device)
    scores = logits[idx]
    logits[idx] = torch.where(scores > 0, scores / penalty, scores * penalty)
    return logits


# ---------------------------------------------------------------------------
# ProverbsGenerator
# ---------------------------------------------------------------------------

def _auto_device() -> str:
    """Return the best available device string."""
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


class ProverbsGenerator:
    """
    High-level text generation wrapper around ProverbsLM.

    Usage::

        gen = ProverbsGenerator(model, tokenizer_path="~/.proverbs/tokenizer.json")
        text = gen.generate("Once upon a time")

        # Streaming:
        for token in gen.generate("Once upon a time", stream=True):
            print(token, end="", flush=True)
    """

    def __init__(
        self,
        model: ProverbsLM,
        tokenizer_path: str = "~/.proverbs/tokenizer.json",
        device: str | None = None,
        use_kv_quant: bool = False,
        use_compile: bool = False,
        dtype: torch.dtype | None = None,
    ) -> None:
        """
        Args:
            model:          A ProverbsLM instance (trained or freshly loaded).
            tokenizer_path: Path to the saved tokenizer JSON file.
            device:         Target device string.  If None, auto-detected.
            use_kv_quant:   If True, quantize KV cache to INT8 to reduce memory.
            use_compile:    If True, apply torch.compile for ~1.5-2x speedup (CUDA only).
            dtype:          Override inference dtype.  Defaults to bfloat16 on CUDA,
                            float32 elsewhere.
        """
        self.device: str = device or _auto_device()

        # Auto-select dtype: bfloat16 on CUDA (halves memory + faster matmuls),
        # float32 on MPS/CPU (bfloat16 support is still incomplete on those backends).
        if dtype is None:
            dtype = torch.bfloat16 if self.device == "cuda" else torch.float32

        # Place model in eval mode, move to device, cast to inference dtype.
        self.model: ProverbsLM = model.eval().to(self.device).to(dtype)

        # torch.compile uses the Inductor backend which only supports CUDA/CPU.
        # Wrap in try/except so a bad PyTorch version degrades gracefully.
        if use_compile and self.device != "mps":
            try:
                self.model = torch.compile(self.model)
            except Exception:
                pass

        # Load the tokenizer.
        tok_path = Path(os.path.expanduser(tokenizer_path))
        if not tok_path.exists():
            raise FileNotFoundError(
                f"Tokenizer not found at {tok_path}. "
                "Run tokenizer/train_tokenizer.py first, or pass --tokenizer."
            )
        self.tokenizer: ProverbsTokenizer = ProverbsTokenizer.load(str(tok_path))
        self.last_entropy: dict = {}

        if QuantizedKVCache is not None:
            self._kv_quant = QuantizedKVCache(enabled=use_kv_quant)

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
        top_k: int = 0,
        repetition_penalty: float = 1.1,
        stop_tokens: list[str] | None = None,
        stream: bool = False,
        early_exit_threshold: float = 0.0,
        use_token_healing: bool = False,
        constrained_schema: dict = None,
    ) -> str | Generator[str, None, None]:
        """
        Generate text autoregressively from *prompt*.

        Args:
            prompt:               A plain string or a list of chat message dicts
                                  (each with "role" and "content" keys).
            max_new_tokens:       Maximum number of new tokens to generate.
            temperature:          Softmax temperature.  Lower = more deterministic.
                                  1.0 = unscaled; < 1.0 sharpens; > 1.0 flattens.
                                  Set to 0 for greedy decoding.
            top_p:                Nucleus sampling probability threshold.
                                  1.0 = disabled.
            top_k:                Top-k sampling.  0 = disabled.
            repetition_penalty:   Penalty applied to already-generated tokens.
                                  1.0 = no penalty; > 1.0 reduces repetition.
            stop_tokens:          Optional list of strings.  Generation stops
                                  immediately when any of these is decoded.
            stream:               If True, return a generator that yields decoded
                                  token strings one at a time.  If False, return
                                  the complete generated string.
            early_exit_threshold: Entropy threshold for early exit.  When token
                                  entropy stays below this value for 3 consecutive
                                  tokens and at least 20 new tokens have been
                                  generated, generation stops early.  0.0 = disabled.
            use_token_healing:    If True and prompt is a plain string, attempt
                                  token-boundary healing via heal_generate from
                                  inference.token_healing.  Falls through silently
                                  on ImportError.
            constrained_schema:   If provided (a dict), attempt JSON-constrained
                                  decoding via ConstrainedSampler and JsonFSM from
                                  inference.constrained_decoding.  Falls through
                                  silently on ImportError.

        Returns:
            str if stream=False; Generator[str, None, None] if stream=True.
        """
        # --- Constrained decoding path ---
        if constrained_schema is not None:
            try:
                from inference.constrained_decoding import ConstrainedSampler, JsonFSM
                fsm = JsonFSM(schema=constrained_schema)
                sampler = ConstrainedSampler(self.tokenizer, fsm)
                return sampler.constrained_generate(
                    self,
                    prompt,
                    max_tokens=max_new_tokens,
                )
            except ImportError:
                pass

        # --- Token healing path ---
        if use_token_healing and isinstance(prompt, str):
            try:
                from inference.token_healing import heal_generate
                return heal_generate(
                    self,
                    prompt,
                    max_new_tokens=max_new_tokens,
                    temperature=temperature,
                    top_p=top_p,
                    top_k=top_k,
                    repetition_penalty=repetition_penalty,
                    stop_tokens=stop_tokens,
                    stream=stream,
                    early_exit_threshold=early_exit_threshold,
                )
            except ImportError:
                pass

        # --- Encode the prompt ---
        if isinstance(prompt, list):
            input_ids: list[int] = self.tokenizer.encode_chat(prompt)
        else:
            input_ids = self.tokenizer.encode(prompt, add_bos=True)

        if not input_ids:
            input_ids = [self.model.cfg.bos_token_id]

        # --- Resolve stop token ids and multi-token stop sequences ---
        stop_ids: set[int] = {self.model.cfg.eos_token_id}
        stop_seqs: list[list[int]] = []
        if stop_tokens:
            for tok_str in stop_tokens:
                encoded = self.tokenizer.encode(tok_str, add_bos=False)
                if len(encoded) == 1:
                    stop_ids.add(encoded[0])
                elif len(encoded) > 1:
                    stop_seqs.append(encoded)

        # --- Dispatch to the appropriate generator ---
        gen = self._generate_tokens(
            input_ids=input_ids,
            max_new_tokens=max_new_tokens,
            temperature=temperature,
            top_p=top_p,
            top_k=top_k,
            repetition_penalty=repetition_penalty,
            stop_ids=stop_ids,
            stop_seqs=stop_seqs,
            early_exit_threshold=early_exit_threshold,
        )

        if stream:
            return gen  # caller iterates the generator directly

        # Collect all tokens and return a single string.
        return "".join(gen)

    # ------------------------------------------------------------------
    # Internal token-level generator
    # ------------------------------------------------------------------

    @torch.inference_mode()
    def _generate_tokens(
        self,
        input_ids: list[int],
        max_new_tokens: int,
        temperature: float,
        top_p: float,
        top_k: int,
        repetition_penalty: float,
        stop_ids: set[int],
        stop_seqs: list[list[int]] | None = None,
        early_exit_threshold: float = 0.0,
    ) -> Generator[str, None, None]:
        """
        Core autoregressive loop.  Yields decoded strings for each new token.

        Multi-token stop sequences are handled via a pending buffer: we hold
        back up to max(len(seq)) tokens so we can retract them if a stop
        sequence completes, preventing partial stop strings from leaking into
        the output.
        """
        _entropy_per_token: list = []
        _low_entropy_streak: int = 0
        cfg = self.model.cfg
        stop_seqs = stop_seqs or []

        # Size of the look-ahead buffer: largest multi-token stop sequence.
        max_pend = max((len(s) for s in stop_seqs), default=0)

        # Convert prompt ids to a tensor; shape (1, T).
        ids_tensor = torch.tensor(
            [input_ids], dtype=torch.long, device=self.device
        )

        # We keep all generated ids (prompt + new) for repetition penalty.
        all_ids: list[int] = list(input_ids)

        # Pending buffer — tokens sampled but not yet yielded.
        pending: list[int] = []

        # Hoist the KV-quant feature check out of the per-token loop.
        kv_quant = getattr(self, "_kv_quant", None)
        kv_quant_on = kv_quant is not None and kv_quant.enabled

        # Prefill: run the full prompt through the model to prime KV caches.
        out = self.model(ids_tensor, kv_caches=None)
        kv_caches = out["kv_caches"]

        # Autoregressive generation loop.
        try:
            for _ in range(max_new_tokens):
                # The last generated token becomes the next input.
                next_input = torch.tensor(
                    [[all_ids[-1]]], dtype=torch.long, device=self.device
                )

                # Check context length limit; truncate KV cache if needed.
                if len(all_ids) >= cfg.max_seq_len:
                    # Drop oldest KV cache entry — simple sliding window.
                    kv_caches = [
                        (kv[0][:, :, 1:, :], kv[1][:, :, 1:, :])
                        if kv is not None else None
                        for kv in kv_caches
                    ]

                # Dequantize KV caches before passing to model if needed.
                kv_caches_for_model = (
                    kv_quant.unwrap(kv_caches) if kv_quant_on else kv_caches
                )

                out = self.model(next_input, kv_caches=kv_caches_for_model)
                kv_caches = out["kv_caches"]

                # Quantize KV caches after model forward if enabled.
                if kv_quant_on:
                    kv_caches = kv_quant.wrap(kv_caches)

                # Extract logits for the single new token: shape (vocab_size,).
                logits: torch.Tensor = out["logits"][0, -1, :]

                # Apply repetition penalty.
                logits = apply_repetition_penalty(logits, all_ids, repetition_penalty)

                # Compute entropy over temperature-scaled distribution
                _scaled = logits / max(temperature, 1e-8)
                _probs_e = F.softmax(_scaled.float(), dim=-1)
                _token_entropy = float(-(_probs_e * (_probs_e + 1e-10).log()).sum().item())
                _entropy_per_token.append(_token_entropy)

                # Early exit: stop if model is consistently confident.
                if early_exit_threshold > 0:
                    if _token_entropy < early_exit_threshold:
                        _low_entropy_streak += 1
                    else:
                        _low_entropy_streak = 0
                    if _low_entropy_streak >= 3 and len(all_ids) > len(input_ids) + 20:
                        break  # model is confident, stop early

                # Greedy decoding path (temperature == 0).
                if temperature == 0.0:
                    next_token_id = int(torch.argmax(logits).item())
                else:
                    # Temperature scaling.
                    logits = logits / temperature

                    # Top-k filter.
                    if top_k > 0:
                        logits = top_k_filter(logits, top_k)

                    # Top-p (nucleus) filter.
                    if top_p < 1.0:
                        logits = top_p_filter(logits, top_p)

                    # Convert to probabilities and sample.
                    probs = F.softmax(logits, dim=-1)
                    next_token_id = int(torch.multinomial(probs, num_samples=1).item())

                # Single-token stop (EOS or stop_ids): flush pending then halt.
                if next_token_id in stop_ids:
                    for pid in pending:
                        yield self.tokenizer.decode([pid], skip_special=True)
                    break

                all_ids.append(next_token_id)
                pending.append(next_token_id)

                # Multi-token stop sequence check — runs BEFORE flushing so the
                # matching tokens are still in pending and can be dropped cleanly.
                stop_hit = False
                for seq in stop_seqs:
                    n = len(seq)
                    if len(all_ids) >= n and all_ids[-n:] == seq:
                        # Remove the stop sequence from the pending buffer and stop.
                        del pending[-n:]
                        for pid in pending:
                            yield self.tokenizer.decode([pid], skip_special=True)
                        stop_hit = True
                        break
                if stop_hit:
                    break

                # Flush the oldest pending token once the buffer exceeds max_pend.
                # This keeps the invariant: last max_pend tokens stay in pending.
                while len(pending) > max_pend:
                    yield self.tokenizer.decode([pending.pop(0)], skip_special=True)
            else:
                # max_new_tokens reached — flush anything still buffered.
                for pid in pending:
                    yield self.tokenizer.decode([pid], skip_special=True)
        finally:
            if _entropy_per_token:
                self.last_entropy = {
                    "mean": sum(_entropy_per_token) / len(_entropy_per_token),
                    "max": max(_entropy_per_token),
                    "n_tokens": len(_entropy_per_token),
                    "high_uncertainty": sum(1 for e in _entropy_per_token if e > 3.0) / max(len(_entropy_per_token), 1),
                }
            else:
                self.last_entropy = {}


# ---------------------------------------------------------------------------
# Command-line interface
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="ProverbsLM text generation CLI",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--model",
        required=True,
        help="Path to a saved .pt model checkpoint.",
    )
    parser.add_argument(
        "--tokenizer",
        default="~/.proverbs/tokenizer.json",
        help="Path to the tokenizer JSON file.",
    )
    parser.add_argument(
        "--prompt",
        required=True,
        help="Text prompt to generate from.",
    )
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=512,
        dest="max_tokens",
        help="Maximum number of new tokens to generate.",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.7,
        help="Sampling temperature (0 = greedy).",
    )
    parser.add_argument(
        "--top-p",
        type=float,
        default=0.9,
        dest="top_p",
        help="Nucleus sampling probability threshold (1.0 = disabled).",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=0,
        dest="top_k",
        help="Top-k sampling (0 = disabled).",
    )
    parser.add_argument(
        "--repetition-penalty",
        type=float,
        default=1.1,
        dest="repetition_penalty",
        help="Repetition penalty (1.0 = none).",
    )
    parser.add_argument(
        "--stream",
        action="store_true",
        help="Stream tokens to stdout as they are generated.",
    )
    parser.add_argument(
        "--device",
        default=None,
        help="Device to run on (cuda / mps / cpu).  Auto-detected if omitted.",
    )

    args = parser.parse_args()

    print(f"Loading model from {args.model} ...", file=sys.stderr)
    lm = ProverbsLM.load(args.model, device=args.device)
    print(f"  {lm}", file=sys.stderr)

    generator = ProverbsGenerator(
        model=lm,
        tokenizer_path=args.tokenizer,
        device=args.device,
    )

    print(f"\n--- Prompt ---\n{args.prompt}\n--- Output ---", file=sys.stderr)

    result = generator.generate(
        prompt=args.prompt,
        max_new_tokens=args.max_tokens,
        temperature=args.temperature,
        top_p=args.top_p,
        top_k=args.top_k,
        repetition_penalty=args.repetition_penalty,
        stream=args.stream,
    )

    if args.stream:
        for token_str in result:  # type: ignore[union-attr]
            print(token_str, end="", flush=True)
        print()  # final newline
    else:
        print(result)
