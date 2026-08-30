"""
constrained_decoding.py — Grammar-guided JSON generation via a finite-state machine
over token logits, ensuring ProverbsLM can only emit structurally valid JSON output.
"""

from __future__ import annotations

import copy
import sys
from enum import Enum, auto
from pathlib import Path
from typing import TYPE_CHECKING

import torch

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

if TYPE_CHECKING:
    from tokenizer.bpe import ProverbsTokenizer
    from inference.generate import ProverbsGenerator


# ---------------------------------------------------------------------------
# FSM state enum
# ---------------------------------------------------------------------------

class _State(Enum):
    START       = auto()  # Before any character has been emitted
    IN_OBJECT   = auto()  # Inside { ... }, expecting a key or closing }
    IN_KEY      = auto()  # Inside a double-quoted key string
    AFTER_KEY   = auto()  # After closing " of a key, expecting :
    AFTER_COLON = auto()  # After the :, expecting a value
    IN_STRING   = auto()  # Inside a double-quoted value string
    IN_NUMBER   = auto()  # Inside a numeric literal
    IN_BOOL     = auto()  # Inside true / false literal
    IN_NULL     = auto()  # Inside null literal
    AFTER_VALUE = auto()  # After a complete value, expecting , or }
    END         = auto()  # Top-level value complete — generation should stop


# ---------------------------------------------------------------------------
# JsonFSM
# ---------------------------------------------------------------------------

# Characters valid at the start of a JSON value (after : or at root level)
_VALUE_START_CHARS: frozenset[str] = frozenset(
    '"'           # string
    "0123456789"  # number (positive)
    "-"           # number (negative)
    "tf"          # true / false
    "n"           # null
    "{"           # nested object
    "["           # array (pass-through; treated like nested object for depth)
)


class JsonFSM:
    """
    Minimal deterministic FSM that accepts exactly the set of valid JSON
    objects (and scalar values).  Designed to be cheaply cloned so that
    ``ConstrainedSampler`` can replay generated text without mutating the
    original instance.

    Args:
        schema: Reserved for future schema-aware validation (unused now).
    """

    def __init__(self, schema: dict | None = None) -> None:
        self.schema = schema
        self.current_state: _State = _State.START
        # depth > 0 means we are inside nested { } or [ ]
        self.depth: int = 0
        # Tracks which literal we are building (e.g. "true", "false", "null")
        self._literal_buf: str = ""
        # Whether the previous character inside a string was a backslash
        self._escaped: bool = False

    # ------------------------------------------------------------------
    # valid_chars
    # ------------------------------------------------------------------

    def valid_chars(self) -> set[str]:
        """
        Return the set of characters that are syntactically valid as the
        *next* character given the current FSM state.
        """
        s = self.current_state

        if s == _State.START:
            # Root value can be any JSON value starter or whitespace
            return set(_VALUE_START_CHARS) | set(" \t\n\r")

        if s == _State.IN_OBJECT:
            # Expecting a key (opening "), whitespace, or closing }
            return {'"', '}', ' ', '\t', '\n', '\r'}

        if s == _State.IN_KEY:
            if self._escaped:
                # After a backslash: any escapable char
                return set('"\\' + "/bfnrtu")
            # Inside a key string: any printable char except unescaped "
            return set(
                "abcdefghijklmnopqrstuvwxyz"
                "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
                "0123456789"
                " _-.:/@#$%^&*()+=[]|<>?,!~`'"
                '\\'
                '"'    # closing quote
            )

        if s == _State.AFTER_KEY:
            return {':', ' ', '\t', '\n', '\r'}

        if s == _State.AFTER_COLON:
            return set(_VALUE_START_CHARS) | set(" \t\n\r")

        if s == _State.IN_STRING:
            if self._escaped:
                return set('"\\' + "/bfnrtu")
            return set(
                "abcdefghijklmnopqrstuvwxyz"
                "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
                "0123456789"
                " _-.:/@#$%^&*()+=[]|<>?,!~`'"
                '\\'
                '"'    # closing quote
            )

        if s == _State.IN_NUMBER:
            return set("0123456789.eE+-")

        if s == _State.IN_BOOL:
            # Accept any letter that could continue "true" or "false"
            return set("truefalsTRUEFALS")

        if s == _State.IN_NULL:
            return set("nulNUL")

        if s == _State.AFTER_VALUE:
            if self.depth > 0:
                # Inside a nested container: comma (next pair) or closing brace/bracket
                return {',', '}', ']', ' ', '\t', '\n', '\r'}
            # Top-level value done: only whitespace allowed before END
            return set(" \t\n\r")

        if s == _State.END:
            # No further characters are valid
            return set()

        return set()

    # ------------------------------------------------------------------
    # transition
    # ------------------------------------------------------------------

    def transition(self, char: str) -> bool:
        """
        Advance the FSM by consuming *char*.

        Returns:
            True  — the character is valid and the state has been updated.
            False — the character is invalid for the current state.
        """
        s = self.current_state
        valid = self.valid_chars()

        # Normalise: only the first character matters for multi-char tokens
        if not char:
            return False

        c = char[0]

        # Reject invalid characters early (except whitespace which is
        # allowed in many states and just ignored for state progression)
        if c not in valid:
            return False

        # Whitespace is structural noise in most states — consume silently
        _WS = {' ', '\t', '\n', '\r'}

        # ---- START ----
        if s == _State.START:
            if c in _WS:
                return True  # stay in START
            if c == '{':
                self.current_state = _State.IN_OBJECT
                self.depth += 1
                return True
            if c == '[':
                # Treat arrays like objects for depth tracking
                self.current_state = _State.IN_OBJECT
                self.depth += 1
                return True
            if c == '"':
                self.current_state = _State.IN_STRING
                return True
            if c in "0123456789-":
                self.current_state = _State.IN_NUMBER
                self._literal_buf = c
                return True
            if c == 't':
                self.current_state = _State.IN_BOOL
                self._literal_buf = 't'
                return True
            if c == 'f':
                self.current_state = _State.IN_BOOL
                self._literal_buf = 'f'
                return True
            if c == 'n':
                self.current_state = _State.IN_NULL
                self._literal_buf = 'n'
                return True
            return False

        # ---- IN_OBJECT ----
        if s == _State.IN_OBJECT:
            if c in _WS:
                return True
            if c == '"':
                self.current_state = _State.IN_KEY
                self._escaped = False
                return True
            if c in ('}', ']'):
                self.depth -= 1
                self.current_state = _State.AFTER_VALUE if self.depth > 0 else _State.END
                return True
            return False

        # ---- IN_KEY ----
        if s == _State.IN_KEY:
            if self._escaped:
                self._escaped = False
                return True
            if c == '\\':
                self._escaped = True
                return True
            if c == '"':
                self.current_state = _State.AFTER_KEY
                return True
            return True  # any other char is part of the key

        # ---- AFTER_KEY ----
        if s == _State.AFTER_KEY:
            if c in _WS:
                return True
            if c == ':':
                self.current_state = _State.AFTER_COLON
                return True
            return False

        # ---- AFTER_COLON ----
        if s == _State.AFTER_COLON:
            if c in _WS:
                return True
            if c == '{':
                self.current_state = _State.IN_OBJECT
                self.depth += 1
                return True
            if c == '[':
                self.current_state = _State.IN_OBJECT
                self.depth += 1
                return True
            if c == '"':
                self.current_state = _State.IN_STRING
                self._escaped = False
                return True
            if c in "0123456789-":
                self.current_state = _State.IN_NUMBER
                self._literal_buf = c
                return True
            if c == 't':
                self.current_state = _State.IN_BOOL
                self._literal_buf = 't'
                return True
            if c == 'f':
                self.current_state = _State.IN_BOOL
                self._literal_buf = 'f'
                return True
            if c == 'n':
                self.current_state = _State.IN_NULL
                self._literal_buf = 'n'
                return True
            return False

        # ---- IN_STRING ----
        if s == _State.IN_STRING:
            if self._escaped:
                self._escaped = False
                return True
            if c == '\\':
                self._escaped = True
                return True
            if c == '"':
                self.current_state = _State.AFTER_VALUE
                return True
            return True  # any other char is part of the string value

        # ---- IN_NUMBER ----
        if s == _State.IN_NUMBER:
            if c in "0123456789.eE+-":
                self._literal_buf += c
                return True
            # Any non-numeric char terminates the number; re-process as AFTER_VALUE
            self.current_state = _State.AFTER_VALUE
            return self.transition(char)

        # ---- IN_BOOL ----
        if s == _State.IN_BOOL:
            self._literal_buf += c
            # Detect completion of "true", "false"
            if self._literal_buf in ("true", "false"):
                self._literal_buf = ""
                self.current_state = _State.AFTER_VALUE
            return True

        # ---- IN_NULL ----
        if s == _State.IN_NULL:
            self._literal_buf += c
            if self._literal_buf == "null":
                self._literal_buf = ""
                self.current_state = _State.AFTER_VALUE
            return True

        # ---- AFTER_VALUE ----
        if s == _State.AFTER_VALUE:
            if c in _WS:
                return True
            if c == ',':
                # Another key-value pair in object or next element in array
                self.current_state = _State.IN_OBJECT
                return True
            if c in ('}', ']'):
                self.depth -= 1
                self.current_state = _State.AFTER_VALUE if self.depth > 0 else _State.END
                return True
            return False

        # ---- END ----
        if s == _State.END:
            return c in _WS  # trailing whitespace only

        return False

    # ------------------------------------------------------------------
    # is_complete
    # ------------------------------------------------------------------

    def is_complete(self) -> bool:
        """Return True when a complete JSON value has been generated."""
        return self.current_state == _State.END


# ---------------------------------------------------------------------------
# ConstrainedSampler
# ---------------------------------------------------------------------------

class ConstrainedSampler:
    """
    Wraps a ``ProverbsGenerator`` to force autoregressive output to conform
    to the JSON grammar defined by ``JsonFSM``.

    On each decoding step the sampler:
    1. Replays all previously generated text through a *clone* of the base FSM
       to recover the current parse state.
    2. Builds a boolean mask over the full vocabulary: a token passes the mask
       iff its first decoded character is in ``fsm.valid_chars()``.
    3. Sets masked-out logits to ``-inf`` before sampling.

    Args:
        tokenizer: A loaded ``ProverbsTokenizer`` instance.
        fsm:       A ``JsonFSM`` instance (will never be mutated here).
    """

    def __init__(self, tokenizer: "ProverbsTokenizer", fsm: JsonFSM) -> None:
        self.tokenizer = tokenizer
        self.fsm = fsm

        # Precompute token_id -> first printable character for fast masking.
        # We decode each token individually (skip_special=True) and take the
        # first character of the result; tokens that decode to empty strings
        # are mapped to None and will always be masked out.
        self._token_first_char: dict[int, str | None] = {}
        vocab_size = len(tokenizer.id_to_token)
        for token_id in range(vocab_size):
            decoded = tokenizer.decode([token_id], skip_special=True)
            self._token_first_char[token_id] = decoded[0] if decoded else None

    # ------------------------------------------------------------------
    # get_valid_mask
    # ------------------------------------------------------------------

    def get_valid_mask(self, generated_so_far: str) -> torch.Tensor:
        """
        Compute a boolean mask of shape ``(vocab_size,)`` where ``True``
        means the token is permitted by the JSON grammar at the current
        position.

        Args:
            generated_so_far: The full string of JSON output emitted so far
                               (not including the prompt).

        Returns:
            A 1-D bool ``torch.Tensor`` of length ``vocab_size``.
        """
        # Clone the FSM and replay the generated text to advance its state.
        live_fsm: JsonFSM = copy.deepcopy(self.fsm)
        for ch in generated_so_far:
            live_fsm.transition(ch)

        valid = live_fsm.valid_chars()
        vocab_size = len(self._token_first_char)
        mask = torch.zeros(vocab_size, dtype=torch.bool)
        for token_id, first_char in self._token_first_char.items():
            if first_char is not None and first_char in valid:
                mask[token_id] = True
        return mask

    # ------------------------------------------------------------------
    # constrained_generate
    # ------------------------------------------------------------------

    @torch.inference_mode()
    def constrained_generate(
        self,
        generator: "ProverbsGenerator",
        prompt: str | list[dict],
        max_tokens: int = 256,
    ) -> str:
        """
        Run autoregressive generation with JSON grammar constraints.

        At every step:
        - Get raw logits from the model.
        - Apply the FSM mask (set invalid token logits to ``-inf``).
        - Sample from the masked distribution (temperature from *generator*
          defaults, or greedy if temperature == 0).
        - Decode the sampled token, advance the FSM, and check for completion.

        Generation stops when:
        - The FSM reaches ``END`` (a complete JSON value has been emitted), or
        - The model emits an EOS token, or
        - ``max_tokens`` steps have been taken.

        Args:
            generator:  A configured ``ProverbsGenerator`` instance.
            prompt:     Plain string or chat-message list.
            max_tokens: Maximum number of new tokens to generate.

        Returns:
            The complete JSON string (without the prompt).
        """
        import torch.nn.functional as F

        model = generator.model
        tokenizer = generator.tokenizer
        device = generator.device

        # Encode the prompt
        if isinstance(prompt, list):
            input_ids: list[int] = tokenizer.encode_chat(prompt)
        else:
            input_ids = tokenizer.encode(prompt, add_bos=True)

        if not input_ids:
            input_ids = [model.cfg.bos_token_id]

        eos_id: int = model.cfg.eos_token_id

        # Prefill: run the prompt through the model
        ids_tensor = torch.tensor([input_ids], dtype=torch.long, device=device)
        out = model(ids_tensor, kv_caches=None)
        kv_caches = out["kv_caches"]

        all_ids: list[int] = list(input_ids)
        generated_chars: list[str] = []
        live_fsm: JsonFSM = copy.deepcopy(self.fsm)

        for _ in range(max_tokens):
            # Sliding-window KV cache truncation if needed
            if len(all_ids) >= model.cfg.max_seq_len:
                kv_caches = [
                    (kv[0][:, :, 1:, :], kv[1][:, :, 1:, :])
                    if kv is not None else None
                    for kv in kv_caches
                ]

            next_input = torch.tensor(
                [[all_ids[-1]]], dtype=torch.long, device=device
            )
            out = model(next_input, kv_caches=kv_caches)
            kv_caches = out["kv_caches"]

            # Logits for the single new position: shape (vocab_size,)
            logits: torch.Tensor = out["logits"][0, -1, :]

            # Build the FSM validity mask and apply it
            generated_so_far = "".join(generated_chars)
            valid_mask = self.get_valid_mask(generated_so_far).to(device)

            # If *no* token is valid (degenerate state), skip masking to avoid
            # a NaN softmax — the FSM is already broken so we stop.
            if not valid_mask.any():
                break

            logits = logits.masked_fill(~valid_mask, float("-inf"))

            # Sample (greedy when all mass is on one token, multinomial otherwise)
            probs = F.softmax(logits.float(), dim=-1)
            next_token_id = int(torch.multinomial(probs, num_samples=1).item())

            # EOS — stop
            if next_token_id == eos_id:
                break

            all_ids.append(next_token_id)

            # Decode the new token and advance the FSM character by character
            token_str = tokenizer.decode([next_token_id], skip_special=True)
            for ch in token_str:
                live_fsm.transition(ch)
            generated_chars.append(token_str)

            # Stop when a complete JSON value has been produced
            if live_fsm.is_complete():
                break

        return "".join(generated_chars)
