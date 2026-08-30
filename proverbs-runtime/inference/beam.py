"""
BeamSearchGenerator — beam search decoder for ProverbsLM.

Decoding strategy:
  - Prefill once with full prompt to prime KV caches.
  - Expand num_beams candidates each step using log-prob accumulation.
  - Apply length penalty at EOS: score / (length ** length_penalty).
  - Return the highest-scoring finished sequence.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import torch
import torch.nn.functional as F

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from model.proverbs_lm import ProverbsLM  # noqa: E402
from tokenizer.bpe import ProverbsTokenizer  # noqa: E402


def _auto_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


class BeamSearchGenerator:
    def __init__(
        self,
        model: ProverbsLM,
        tokenizer_path: str = "~/.proverbs/tokenizer.json",
        device: str | None = None,
    ) -> None:
        self.device: str = device or _auto_device()
        self.model: ProverbsLM = model.eval().to(self.device)

        tok_path = Path(os.path.expanduser(tokenizer_path))
        if not tok_path.exists():
            raise FileNotFoundError(
                f"Tokenizer not found at {tok_path}. "
                "Run tokenizer/train_tokenizer.py first, or pass --tokenizer."
            )
        self.tokenizer: ProverbsTokenizer = ProverbsTokenizer.load(str(tok_path))

    @torch.inference_mode()
    def generate(
        self,
        prompt: str | list,
        max_new_tokens: int = 256,
        num_beams: int = 4,
        length_penalty: float = 1.0,
        stop_tokens: list[str] | None = None,
    ) -> str:
        cfg = self.model.cfg

        # Encode prompt.
        if isinstance(prompt, list):
            input_ids: list[int] = self.tokenizer.encode_chat(prompt)
        else:
            input_ids = self.tokenizer.encode(prompt, add_bos=True)

        if not input_ids:
            input_ids = [cfg.bos_token_id]

        prompt_len = len(input_ids)

        # Resolve stop token ids.
        stop_ids: set[int] = {cfg.eos_token_id}
        if stop_tokens:
            for tok_str in stop_tokens:
                encoded = self.tokenizer.encode(tok_str, add_bos=False)
                if len(encoded) == 1:
                    stop_ids.add(encoded[0])

        # Prefill: run full prompt once to prime KV caches.
        ids_tensor = torch.tensor([input_ids], dtype=torch.long, device=self.device)
        out = self.model(ids_tensor, kv_caches=None)
        kv_caches_seed = out["kv_caches"]

        # Replicate KV caches num_beams times (deep copy per beam).
        def _clone_kv(kv_list: list) -> list:
            return [(k.clone(), v.clone()) for k, v in kv_list]

        # Each beam: {"ids": list[int], "score": float, "kv": list}
        beams: list[dict] = [
            {
                "ids": list(input_ids),
                "score": 0.0,
                "kv": _clone_kv(kv_caches_seed),
            }
            for _ in range(num_beams)
        ]

        finished: list[dict] = []

        for _ in range(max_new_tokens):
            if not beams:
                break

            # Gather log_probs for each beam independently (one token at a time).
            candidates: list[dict] = []

            for beam in beams:
                last_token = torch.tensor(
                    [[beam["ids"][-1]]], dtype=torch.long, device=self.device
                )

                # Slide KV cache if needed.
                kv = beam["kv"]
                if len(beam["ids"]) >= cfg.max_seq_len:
                    kv = [
                        (k[:, :, 1:, :], v[:, :, 1:, :])
                        for k, v in kv
                    ]

                out = self.model(last_token, kv_caches=kv)
                new_kv = out["kv_caches"]

                logits: torch.Tensor = out["logits"][0, -1, :]  # (vocab,)
                log_probs = F.log_softmax(logits, dim=-1)       # (vocab,)

                # Top-num_beams tokens per beam to limit candidate explosion.
                top_scores, top_ids = torch.topk(log_probs, num_beams)

                for score_t, token_id_t in zip(top_scores, top_ids):
                    token_id = int(token_id_t.item())
                    new_score = beam["score"] + float(score_t.item())
                    candidates.append({
                        "ids": beam["ids"] + [token_id],
                        "score": new_score,
                        "kv": new_kv,
                        "parent_kv_updated": True,
                    })

            # Select global top num_beams candidates.
            candidates.sort(key=lambda c: c["score"], reverse=True)
            top_candidates = candidates[:num_beams]

            # Clone KV caches so beams don't share state.
            new_beams: list[dict] = []
            for cand in top_candidates:
                last_token_id = cand["ids"][-1]
                if last_token_id in stop_ids:
                    seq_len = len(cand["ids"]) - prompt_len
                    if seq_len < 1:
                        seq_len = 1
                    penalized = cand["score"] / (seq_len ** length_penalty)
                    finished.append({"ids": cand["ids"], "score": penalized})
                else:
                    new_beams.append({
                        "ids": cand["ids"],
                        "score": cand["score"],
                        "kv": _clone_kv(cand["kv"]),
                    })

            beams = new_beams

            if not beams:
                break

        # If no beam finished via EOS, apply length penalty to remaining beams.
        if not finished:
            for beam in beams:
                seq_len = len(beam["ids"]) - prompt_len
                if seq_len < 1:
                    seq_len = 1
                penalized = beam["score"] / (seq_len ** length_penalty)
                finished.append({"ids": beam["ids"], "score": penalized})

        best = max(finished, key=lambda b: b["score"])
        output_ids = best["ids"][prompt_len:]
        return self.tokenizer.decode(output_ids, skip_special=True)

    def generate_for_code(self, prompt: str | list, **kwargs) -> str:
        kwargs.setdefault("num_beams", 4)
        kwargs.setdefault("length_penalty", 0.8)
        return self.generate(prompt, **kwargs)


# ---------------------------------------------------------------------------
# Command-line interface
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="ProverbsLM beam search generation CLI",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--model", required=True, help="Path to a saved .pt model checkpoint.")
    parser.add_argument(
        "--tokenizer",
        default="~/.proverbs/tokenizer.json",
        help="Path to the tokenizer JSON file.",
    )
    parser.add_argument("--prompt", required=True, help="Text prompt to generate from.")
    parser.add_argument(
        "--num-beams",
        type=int,
        default=4,
        dest="num_beams",
        help="Number of beams for beam search.",
    )
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=256,
        dest="max_tokens",
        help="Maximum number of new tokens to generate.",
    )
    parser.add_argument(
        "--length-penalty",
        type=float,
        default=1.0,
        dest="length_penalty",
        help="Length penalty exponent (>1 favors longer, <1 favors shorter).",
    )
    parser.add_argument(
        "--device",
        default=None,
        help="Device to run on (cuda / mps / cpu). Auto-detected if omitted.",
    )

    args = parser.parse_args()

    print(f"Loading model from {args.model} ...", file=sys.stderr)
    lm = ProverbsLM.load(args.model, device=args.device)
    print(f"  {lm}", file=sys.stderr)

    generator = BeamSearchGenerator(
        model=lm,
        tokenizer_path=args.tokenizer,
        device=args.device,
    )

    print(f"\n--- Prompt ---\n{args.prompt}\n--- Output ---", file=sys.stderr)
    result = generator.generate(
        prompt=args.prompt,
        max_new_tokens=args.max_tokens,
        num_beams=args.num_beams,
        length_penalty=args.length_penalty,
    )
    print(result)
