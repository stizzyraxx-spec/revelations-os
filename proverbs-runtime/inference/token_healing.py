"""
token_healing.py — fix token boundary artifacts by backtracking the prompt
one token, re-sampling with a prefix-constrained mask, then continuing
generation normally.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import TYPE_CHECKING

import torch
import torch.nn.functional as F

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

if TYPE_CHECKING:
    from inference.generate import ProverbsGenerator
    from tokenizer.bpe import ProverbsTokenizer

# ---------------------------------------------------------------------------
# Prefix mask cache: prefix string -> boolean Tensor[vocab_size]
# ---------------------------------------------------------------------------

_prefix_mask_cache: dict[str, torch.Tensor] = {}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def find_heal_prefix(
    tokenizer: "ProverbsTokenizer",
    prompt: str,
) -> tuple[str, list[int]]:
    """
    Identify the heal prefix caused by the prompt ending mid-token.

    Encode *prompt* to token ids, then decode all-but-the-last id to obtain
    *healed_prompt* — the longest prefix of *prompt* that ends on a clean
    token boundary.  The characters in *prompt* that are absent from
    *healed_prompt* are the heal prefix that must be regenerated.

    Args:
        tokenizer: A ProverbsTokenizer instance.
        prompt:    The raw prompt string.

    Returns:
        A 2-tuple of:
          - healed_prompt (str): prompt decoded from all-but-last token ids.
          - last_token_ids (list[int]): list containing only the final token id.
    """
    ids = tokenizer.encode(prompt, add_bos=False)

    if len(ids) <= 1:
        # Only one (or zero) tokens — nothing to backtrack.
        return prompt, ids[-1:] if ids else []

    healed_prompt = tokenizer.decode(ids[:-1], skip_special=True)
    last_token_id = ids[-1]
    return healed_prompt, [last_token_id]


def build_prefix_token_mask(
    tokenizer: "ProverbsTokenizer",
    prefix: str,
    device: str = "cpu",
) -> torch.Tensor:
    """
    Build a boolean mask over the full vocabulary where True means the decoded
    token string starts with *prefix*.

    Results are cached by prefix string so repeated calls for the same prefix
    are free.  The cache stores CPU tensors; the returned tensor is moved to
    *device* on each call.

    Args:
        tokenizer: A ProverbsTokenizer instance.
        prefix:    The heal prefix string that candidate tokens must begin with.
        device:    Target device for the returned tensor.

    Returns:
        Boolean Tensor of shape (vocab_size,) on *device*.
    """
    if prefix in _prefix_mask_cache:
        return _prefix_mask_cache[prefix].to(device)

    vocab_size = len(tokenizer)
    mask = torch.zeros(vocab_size, dtype=torch.bool)

    for token_id, token_str in tokenizer.id_to_token.items():
        if token_id >= vocab_size:
            continue
        # Decode the single token to its surface string.
        decoded = tokenizer.decode([token_id], skip_special=False)
        if decoded.startswith(prefix):
            mask[token_id] = True

    _prefix_mask_cache[prefix] = mask
    return mask.to(device)


def heal_generate(
    generator: "ProverbsGenerator",
    prompt: str,
    **kwargs,
) -> str:
    """
    Generate a response from *prompt* with token-boundary healing.

    If *prompt* ends on a clean token boundary, delegates directly to
    ``generator.generate``.  Otherwise:

    1. Strips the final partial token from *prompt* to obtain *healed_prompt*.
    2. Computes the heal prefix (the stripped characters).
    3. Runs a single forward pass on *healed_prompt* to obtain next-token logits.
    4. Builds a vocabulary mask allowing only tokens whose decoded text starts
       with *heal_prefix*, sets all other logits to -inf, and samples one token.
    5. Feeds that token back into the generator to continue generation normally.
    6. Returns the generated text with the original *prompt* prefix removed.

    Args:
        generator: A ProverbsGenerator instance.
        prompt:    The raw prompt string (may end mid-token).
        **kwargs:  Forwarded verbatim to ``generator.generate``.

    Returns:
        Generated response string (not including *prompt*).
    """
    healed_prompt, _ = find_heal_prefix(generator.tokenizer, prompt)

    # Fast path: prompt already ends on a token boundary.
    if healed_prompt == prompt:
        full = generator.generate(prompt, **kwargs)
        return full[len(prompt):]

    # Characters in prompt that were trimmed — must be the start of the next token.
    heal_prefix: str = prompt[len(healed_prompt):]

    # --- Forward pass on healed_prompt to get next-token logits ---
    healed_ids = generator.tokenizer.encode(healed_prompt, add_bos=True)
    if not healed_ids:
        healed_ids = [generator.model.cfg.bos_token_id]

    ids_tensor = torch.tensor(
        [healed_ids], dtype=torch.long, device=generator.device
    )

    with torch.inference_mode():
        out = generator.model(ids_tensor, kv_caches=None)

    logits: torch.Tensor = out["logits"][0, -1, :]  # shape (vocab_size,)

    # --- Apply prefix mask ---
    mask = build_prefix_token_mask(
        generator.tokenizer, heal_prefix, device=generator.device
    )

    if not mask.any():
        # No token starts with heal_prefix — fall back to unhealed generation.
        full = generator.generate(prompt, **kwargs)
        return full[len(prompt):]

    logits = logits.clone()
    logits[~mask] = float("-inf")

    # --- Sample one bridging token ---
    temperature: float = kwargs.get("temperature", 0.7)
    if temperature == 0.0:
        bridge_token_id = int(torch.argmax(logits).item())
    else:
        scaled = logits / temperature
        probs = F.softmax(scaled, dim=-1)
        bridge_token_id = int(torch.multinomial(probs, num_samples=1).item())

    bridge_token_str = generator.tokenizer.decode(
        [bridge_token_id], skip_special=True
    )

    # --- Continue generation from healed_prompt + bridge token ---
    # Build the new prompt: healed_prompt + the bridge token surface text.
    # This ensures the model sees a well-formed token boundary going forward.
    continued_prompt = healed_prompt + bridge_token_str

    # Generate with the continued prompt; strip that prefix from the result.
    full = generator.generate(continued_prompt, **kwargs)
    response = full[len(continued_prompt):]

    # Prepend the portion of the bridge token that completes heal_prefix.
    # bridge_token_str starts with heal_prefix, so the suffix beyond heal_prefix
    # is genuinely new content that belongs at the head of the response.
    bridge_suffix = bridge_token_str[len(heal_prefix):]
    return bridge_suffix + response
