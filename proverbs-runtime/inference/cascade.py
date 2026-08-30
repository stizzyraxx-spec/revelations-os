"""
CascadeGenerator — automatic model-size routing based on per-token entropy.

Simple queries (low entropy from the fast/nano model) stay on the fast model.
Complex queries (high entropy) are restarted from scratch on the smart model.

Routing decision:
  After generating *min_tokens_before_switch* tokens with the fast generator,
  inspect fast_generator.last_entropy["mean"].  If it exceeds
  cfg.entropy_threshold and a smart generator is available, discard the
  partial output and regenerate the full response with the smart generator.
  Otherwise finish with the fast generator.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Ensure project root is importable regardless of cwd.
# ---------------------------------------------------------------------------
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from inference.generate import ProverbsGenerator  # noqa: E402
from model.proverbs_lm import ProverbsLM          # noqa: E402


# ---------------------------------------------------------------------------
# CascadeConfig
# ---------------------------------------------------------------------------

@dataclass
class CascadeConfig:
    """Tunable knobs for the cascade routing policy.

    Attributes:
        entropy_threshold:       Mean token entropy above which the smart model
                                 takes over.  2.5 nats is a reasonable default —
                                 lower values route more aggressively to the
                                 smart model; higher values keep more on the
                                 fast model.
        min_tokens_before_switch: Minimum new tokens to generate with the fast
                                  model before sampling entropy and deciding.
        fast_model_path:         Optional filesystem path to the fast (nano)
                                 model checkpoint.  Used by load_cascade().
        smart_model_path:        Optional filesystem path to the smart
                                 (small/medium) model checkpoint.  Used by
                                 load_cascade().  When None, routing is
                                 effectively disabled.
    """

    entropy_threshold: float = 2.5
    min_tokens_before_switch: int = 10
    fast_model_path: str | None = None
    smart_model_path: str | None = None


# ---------------------------------------------------------------------------
# CascadeGenerator
# ---------------------------------------------------------------------------

class CascadeGenerator:
    """Two-tier generator that routes prompts by measured entropy.

    Usage::

        fast  = ProverbsGenerator(nano_model, tokenizer_path="...")
        smart = ProverbsGenerator(small_model, tokenizer_path="...")
        cg    = CascadeGenerator(fast, smart)

        answer = cg.generate("What is 2 + 2?")
        print(cg.stats)  # {'fast_used': 1, 'smart_used': 0, 'switches': 0}
    """

    def __init__(
        self,
        fast_generator: ProverbsGenerator,
        smart_generator: ProverbsGenerator | None = None,
        cfg: CascadeConfig | None = None,
    ) -> None:
        """
        Args:
            fast_generator:  A ready-to-use ProverbsGenerator backed by the
                             small/nano model.  Always called first.
            smart_generator: Optional ProverbsGenerator backed by a larger
                             model.  When None the cascade is a no-op and all
                             queries go to the fast generator.
            cfg:             Routing configuration.  Defaults to CascadeConfig()
                             if not provided.
        """
        self.fast_generator: ProverbsGenerator = fast_generator
        self.smart_generator: ProverbsGenerator | None = smart_generator
        self.cfg: CascadeConfig = cfg or CascadeConfig()
        self.stats: dict[str, int] = {
            "fast_used": 0,
            "smart_used": 0,
            "switches": 0,
        }

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def generate(
        self,
        prompt: str | list[dict],
        max_new_tokens: int = 512,
        temperature: float = 0.7,
        **kwargs: Any,
    ) -> str:
        """Generate a response, routing to the smart model when needed.

        The fast generator produces the first *cfg.min_tokens_before_switch*
        tokens.  If the mean token entropy of that prefix exceeds
        *cfg.entropy_threshold* AND a smart generator is configured, the
        partial output is discarded and the smart generator regenerates the
        full response from scratch with identical parameters.

        Args:
            prompt:         Plain string or chat message list (same semantics
                            as ProverbsGenerator.generate).
            max_new_tokens: Maximum new tokens to generate.
            temperature:    Sampling temperature.
            **kwargs:       Forwarded verbatim to whichever generator handles
                            the request (top_p, top_k, repetition_penalty,
                            stop_tokens, early_exit_threshold, etc.).

        Returns:
            The complete generated string.
        """
        cfg = self.cfg

        # --- Phase 1: probe with the fast generator ---
        probe_tokens = cfg.min_tokens_before_switch
        probe_output: str = self.fast_generator.generate(
            prompt,
            max_new_tokens=probe_tokens,
            temperature=temperature,
            **kwargs,
        )  # type: ignore[assignment]  # stream=False → str

        probe_entropy = self.fast_generator.last_entropy.get("mean", 0.0)

        # --- Phase 2: route decision ---
        if (
            probe_entropy > cfg.entropy_threshold
            and self.smart_generator is not None
        ):
            # Entropy is high — restart from scratch with the smart model.
            self.stats["switches"] += 1
            self.stats["smart_used"] += 1
            return self.smart_generator.generate(  # type: ignore[return-value]
                prompt,
                max_new_tokens=max_new_tokens,
                temperature=temperature,
                **kwargs,
            )

        # --- Phase 3: low entropy — continue with the fast generator ---
        # We already have the probe prefix; now generate the remainder.
        # Remaining budget = max_new_tokens - tokens already emitted.
        # We estimate token count from the probe output length as a proxy;
        # for exact accounting we'd need access to the tokenizer here, but
        # that adds coupling.  Using a conservative word-level estimate keeps
        # this module dependency-free beyond ProverbsGenerator.
        remaining_tokens = max(1, max_new_tokens - probe_tokens)
        continuation: str = self.fast_generator.generate(
            prompt,
            max_new_tokens=max_new_tokens,  # regenerate fully to get proper output
            temperature=temperature,
            **kwargs,
        )  # type: ignore[assignment]

        self.stats["fast_used"] += 1
        return continuation

    # ------------------------------------------------------------------
    # Convenience
    # ------------------------------------------------------------------

    def reset_stats(self) -> None:
        """Zero all routing counters."""
        self.stats = {"fast_used": 0, "smart_used": 0, "switches": 0}

    def __repr__(self) -> str:  # pragma: no cover
        smart_label = (
            repr(self.smart_generator) if self.smart_generator else "None"
        )
        return (
            f"CascadeGenerator("
            f"fast={self.fast_generator!r}, "
            f"smart={smart_label}, "
            f"threshold={self.cfg.entropy_threshold}, "
            f"stats={self.stats})"
        )


# ---------------------------------------------------------------------------
# Factory helper
# ---------------------------------------------------------------------------

def load_cascade(
    fast_path: str,
    smart_path: str | None = None,
    tokenizer_path: str = "~/.proverbs/tokenizer.json",
    device: str | None = None,
    cfg: CascadeConfig | None = None,
) -> CascadeGenerator:
    """Load one or two model checkpoints and return a ready CascadeGenerator.

    Args:
        fast_path:       Path to the fast (nano/small) model checkpoint (.pt).
        smart_path:      Path to the smart (small/medium) model checkpoint.
                         Pass None to create a single-model cascade (routing
                         is effectively disabled — all queries go to fast).
        tokenizer_path:  Path to the shared tokenizer JSON file.
        device:          Target device (cuda/mps/cpu).  Auto-detected if None.
        cfg:             CascadeConfig override.  If None, a default config is
                         created with fast_path/smart_path stamped in.

    Returns:
        A fully initialised CascadeGenerator.
    """
    # Build config with paths recorded for introspection.
    if cfg is None:
        cfg = CascadeConfig(
            fast_model_path=fast_path,
            smart_model_path=smart_path,
        )
    else:
        cfg.fast_model_path = fast_path
        cfg.smart_model_path = smart_path

    # Load the fast model.
    fast_model = ProverbsLM.load(fast_path, device=device)
    fast_gen = ProverbsGenerator(
        model=fast_model,
        tokenizer_path=tokenizer_path,
        device=device,
    )

    # Load the smart model only when a path is provided.
    smart_gen: ProverbsGenerator | None = None
    if smart_path is not None:
        smart_model = ProverbsLM.load(smart_path, device=device)
        smart_gen = ProverbsGenerator(
            model=smart_model,
            tokenizer_path=tokenizer_path,
            device=device,
        )

    return CascadeGenerator(fast_gen, smart_gen, cfg)
