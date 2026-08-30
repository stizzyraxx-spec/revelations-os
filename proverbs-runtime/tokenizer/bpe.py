"""
ProverbsTokenizer — from-scratch Byte-Pair Encoding tokenizer.

No external dependencies; pure Python 3.10+ stdlib only.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _bytes_to_chars() -> dict[int, str]:
    """
    Build the GPT-2-style mapping from raw byte values (0-255) to printable
    Unicode characters.  Bytes that are already printable ASCII stay as-is;
    the remainder are mapped to code-points starting at U+0100 so they never
    collide with visible ASCII.
    """
    bs: list[int] = (
        list(range(ord("!"), ord("~") + 1))    # 33-126
        + list(range(ord("\xa1"), ord("\xac") + 1))  # 161-172
        + list(range(ord("\xae"), ord("\xff") + 1))  # 174-255
    )
    cs: list[int] = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return dict(zip(bs, (chr(c) for c in cs)))


_BYTE_TO_CHAR: dict[int, str] = _bytes_to_chars()
_CHAR_TO_BYTE: dict[str, int] = {v: k for k, v in _BYTE_TO_CHAR.items()}

# GPT-2 uses U+0120 (Ġ) as a prefix to mark a space-preceded word token.
_SPACE_CHAR = chr(0x0120)  # Ġ

# One alternation, evaluated in C by findall:
#   " ?\S+"        — a word, folding in at most one preceding space
#   "\s+?(?= \S)"  — a whitespace run, stopping before the space that
#                    belongs to the next word
#   "\s+"          — any remaining whitespace run (trailing, before \n, …)
_TOKEN_RE = re.compile(r" ?\S+|\s+?(?= \S)|\s+")


def _pretokenize(text: str) -> list[str]:
    """
    Split *text* into words and whitespace, losslessly.

    A single space before a word is folded into the word as a Ġ prefix
    (GPT-2 style, matches learned merges).  All other whitespace — newlines,
    tabs, runs of spaces — is emitted verbatim as its own token so encode →
    decode round-trips exactly (critical for code, where indentation and
    line breaks are semantic).
    """
    return _TOKEN_RE.findall(text)


def _word_to_chars(word: str) -> tuple[str, ...]:
    """
    Convert a raw pre-token to the byte-char alphabet used by BPE.

    A leading real space folded into a word becomes the Ġ marker; everything
    else is byte-encoded (printable ASCII maps to itself), so a literal Ġ in
    the input text becomes UTF-8 byte tokens and can never collide with the
    marker.
    """
    chars: list[str] = []
    if word[0] == " " and len(word) > 1 and not word[1].isspace():
        chars.append(_SPACE_CHAR)
        word = word[1:]
    for ch in word:
        if "!" <= ch <= "~":
            chars.append(ch)
        else:
            for byte_val in ch.encode("utf-8"):
                chars.append(_BYTE_TO_CHAR[byte_val])
    return tuple(chars)


# ---------------------------------------------------------------------------
# Core BPE helpers
# ---------------------------------------------------------------------------

def _get_pairs(vocab: dict[tuple[str, ...], int]) -> dict[tuple[str, str], int]:
    """Count every adjacent pair across all word sequences weighted by frequency."""
    pairs: dict[tuple[str, str], int] = defaultdict(int)
    for word_seq, freq in vocab.items():
        for a, b in zip(word_seq, word_seq[1:]):
            pairs[(a, b)] += freq
    return pairs


def _merge_vocab(
    pair: tuple[str, str],
    vocab: dict[tuple[str, ...], int],
) -> dict[tuple[str, ...], int]:
    """Return a new vocab dict with every occurrence of *pair* merged."""
    merged = pair[0] + pair[1]
    new_vocab: dict[tuple[str, ...], int] = {}
    for word_seq, freq in vocab.items():
        new_seq: list[str] = []
        i = 0
        while i < len(word_seq):
            if (
                i < len(word_seq) - 1
                and word_seq[i] == pair[0]
                and word_seq[i + 1] == pair[1]
            ):
                new_seq.append(merged)
                i += 2
            else:
                new_seq.append(word_seq[i])
                i += 1
        new_vocab[tuple(new_seq)] = freq
    return new_vocab


# ---------------------------------------------------------------------------
# ProverbsTokenizer
# ---------------------------------------------------------------------------

class ProverbsTokenizer:
    """
    Byte-Pair Encoding tokenizer built from scratch (no HuggingFace).

    Special tokens occupy ids 0-7; raw byte tokens occupy ids 8-263.
    All learned merge tokens start at id 264 and count up to *vocab_size - 1*.
    """

    # ------------------------------------------------------------------
    # Special token constants
    # ------------------------------------------------------------------
    PAD_TOKEN  = "<|pad|>"
    BOS_TOKEN  = "<|bos|>"
    EOS_TOKEN  = "<|eos|>"
    UNK_TOKEN  = "<|unk|>"
    SEP_TOKEN  = "<|sep|>"
    USER_TOKEN = "<|user|>"
    ASST_TOKEN = "<|asst|>"
    SYS_TOKEN  = "<|sys|>"

    _SPECIAL_TOKENS: list[str] = [
        PAD_TOKEN,   # 0
        BOS_TOKEN,   # 1
        EOS_TOKEN,   # 2
        UNK_TOKEN,   # 3
        SEP_TOKEN,   # 4
        USER_TOKEN,  # 5
        ASST_TOKEN,  # 6
        SYS_TOKEN,   # 7
    ]

    _ROLE_TO_SPECIAL: dict[str, str] = {
        "system":    SYS_TOKEN,
        "user":      USER_TOKEN,
        "assistant": ASST_TOKEN,
    }

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------

    def __init__(self, vocab_size: int = 32_000) -> None:
        self.vocab_size: int = vocab_size
        self.vocab: dict[str, int] = {}
        self.id_to_token: dict[int, str] = {}
        self.merges: list[tuple[str, str]] = []
        self._merge_rank: dict[tuple[str, str], int] = {}
        self._word_cache: dict[str, list[int]] = {}

        self._init_special_tokens()
        self._init_byte_vocab()

    def _init_special_tokens(self) -> None:
        for idx, tok in enumerate(self._SPECIAL_TOKENS):
            self.vocab[tok] = idx
            self.id_to_token[idx] = tok

    def _init_byte_vocab(self) -> None:
        """Add one token per byte value (ids 8-263)."""
        offset = len(self._SPECIAL_TOKENS)  # 8
        for byte_val in range(256):
            char = _BYTE_TO_CHAR[byte_val]
            token_id = offset + byte_val
            self.vocab[char] = token_id
            self.id_to_token[token_id] = char

    # ------------------------------------------------------------------
    # Training
    # ------------------------------------------------------------------

    def train(self, texts: list[str], verbose: bool = True) -> None:
        """
        Train BPE merges on *texts* until *self.vocab_size* is reached.

        Algorithm:
        1. Pre-tokenise each text (whitespace split, Ġ prefix).
        2. Convert each word to a tuple of single-character byte-tokens.
        3. Build a frequency dict: {word_char_tuple: count}.
        4. Repeatedly find the most frequent adjacent pair, merge it, add the
           new token and merge rule to the vocabulary.
        """
        num_merges_needed = self.vocab_size - len(self.vocab)
        if num_merges_needed <= 0:
            if verbose:
                print("Vocabulary already at target size; no training needed.")
            return

        # ----- Build word-frequency corpus -----
        word_freq: dict[tuple[str, ...], int] = defaultdict(int)
        for text in texts:
            for word in _pretokenize(text):
                char_seq = _word_to_chars(word)
                word_freq[char_seq] += 1

        if verbose:
            total_words = sum(word_freq.values())
            print(
                f"Training BPE: {len(word_freq)} unique words "
                f"({total_words} total), "
                f"target {num_merges_needed} merges ..."
            )

        # ----- Merge loop -----
        for merge_idx in range(num_merges_needed):
            pairs = _get_pairs(word_freq)
            if not pairs:
                if verbose:
                    print(f"No more pairs after {merge_idx} merges.")
                break

            # Break ties lexicographically for determinism
            best_pair = max(pairs, key=lambda p: (pairs[p], p))
            new_token = best_pair[0] + best_pair[1]

            # Register new token
            new_id = len(self.vocab)
            self.vocab[new_token] = new_id
            self.id_to_token[new_id] = new_token
            self.merges.append(best_pair)

            # Apply merge to corpus
            word_freq = _merge_vocab(best_pair, word_freq)

            if verbose and (merge_idx + 1) % 1_000 == 0:
                print(
                    f"  merge {merge_idx + 1:>6}/{num_merges_needed}  "
                    f"merged {best_pair!r} -> {new_token!r}  "
                    f"freq={pairs[best_pair]}"
                )

        # New merges invalidate any cached encodings
        self._word_cache.clear()

        if verbose:
            print(f"Training complete. Vocabulary size: {len(self.vocab)}")

    # ------------------------------------------------------------------
    # Encoding
    # ------------------------------------------------------------------

    def _apply_merges(self, char_seq: list[str]) -> list[str]:
        """Apply all learned merge rules to a list of character tokens."""
        if len(char_seq) <= 1:
            return char_seq

        # The rank map is invariant between training runs — rebuild only when
        # the merge list has changed, never per word.
        merge_rank = self._merge_rank
        if len(merge_rank) != len(self.merges):
            merge_rank = self._merge_rank = {
                pair: rank for rank, pair in enumerate(self.merges)
            }

        seq = list(char_seq)
        while True:
            best_rank = len(self.merges)  # sentinel: worse than any real rank
            best_idx = -1
            for i in range(len(seq) - 1):
                pair = (seq[i], seq[i + 1])
                rank = merge_rank.get(pair, len(self.merges))
                if rank < best_rank:
                    best_rank = rank
                    best_idx = i

            if best_idx == -1:
                break

            merged = seq[best_idx] + seq[best_idx + 1]
            seq = seq[:best_idx] + [merged] + seq[best_idx + 2:]

        return seq

    def encode(self, text: str, add_bos: bool = False, add_eos: bool = False) -> list[int]:
        """
        Encode *text* to a list of token ids.

        1. Pre-tokenise (whitespace split, Ġ prefix).
        2. Convert each character to its byte-char representation.
        3. Apply BPE merges.
        4. Map to ids; unknown characters fall back to UNK_TOKEN id.
        """
        unk_id = self.vocab[self.UNK_TOKEN]
        ids: list[int] = []

        if add_bos:
            ids.append(self.vocab[self.BOS_TOKEN])

        word_cache = self._word_cache
        for word in _pretokenize(text):
            cached = word_cache.get(word)
            if cached is None:
                merged = self._apply_merges(list(_word_to_chars(word)))
                cached = [self.vocab.get(tok, unk_id) for tok in merged]
                if len(word_cache) >= 65_536:
                    word_cache.clear()
                word_cache[word] = cached
            ids.extend(cached)

        if add_eos:
            ids.append(self.vocab[self.EOS_TOKEN])

        return ids

    # ------------------------------------------------------------------
    # Decoding
    # ------------------------------------------------------------------

    def decode(self, ids: list[int], skip_special: bool = True) -> str:
        """
        Decode a list of token ids back to a string.

        Special tokens are omitted when *skip_special* is True.
        Ġ prefixes are converted back to leading spaces (GPT-2 style).
        """
        special_ids: set[int] = {self.vocab[t] for t in self._SPECIAL_TOKENS}
        byte_buffer: list[int] = []
        result_parts: list[bytes] = []

        def flush() -> None:
            if byte_buffer:
                result_parts.append(bytes(byte_buffer))
                byte_buffer.clear()

        for token_id in ids:
            if token_id in special_ids:
                if skip_special:
                    flush()
                    continue
                flush()
                token_str = self.id_to_token.get(token_id, "")
                result_parts.append(token_str.encode("utf-8"))
                continue

            token_str = self.id_to_token.get(token_id, "")
            if not token_str:
                continue

            for ch in token_str:
                if ch == _SPACE_CHAR:
                    flush()
                    result_parts.append(b" ")
                elif ch in _CHAR_TO_BYTE:
                    byte_buffer.append(_CHAR_TO_BYTE[ch])
                else:
                    # Literal Unicode character (should not occur for normal tokens)
                    flush()
                    result_parts.append(ch.encode("utf-8"))

        flush()
        return b"".join(result_parts).decode("utf-8", errors="replace")

    # ------------------------------------------------------------------
    # Chat encoding
    # ------------------------------------------------------------------

    def encode_chat(self, messages: list[dict]) -> list[int]:
        """
        Encode a chat conversation to token ids.

        Format:
            [BOS] [SYS] system_text [SEP] [USER] user_text [SEP] [ASST] asst_text [EOS]

        Each message dict must have "role" and "content" keys.
        Roles: "system", "user", "assistant".
        The final message's trailing SEP is replaced by EOS.
        """
        ids: list[int] = [self.vocab[self.BOS_TOKEN]]

        for msg in messages:
            role: str = msg.get("role", "user")
            content: str = msg.get("content", "")

            role_token_str = self._ROLE_TO_SPECIAL.get(role, self.USER_TOKEN)
            ids.append(self.vocab[role_token_str])
            ids.extend(self.encode(content))
            ids.append(self.vocab[self.SEP_TOKEN])

        # Replace trailing SEP with EOS
        if ids and ids[-1] == self.vocab[self.SEP_TOKEN]:
            ids[-1] = self.vocab[self.EOS_TOKEN]
        else:
            ids.append(self.vocab[self.EOS_TOKEN])

        return ids

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def save(self, path: str) -> None:
        """Serialise vocab, merges, and metadata to a JSON file at *path*."""
        data = {
            "vocab_size": self.vocab_size,
            "vocab": self.vocab,
            "merges": self.merges,
        }
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)

    @classmethod
    def load(cls, path: str) -> "ProverbsTokenizer":
        """Load a previously saved tokenizer from *path*."""
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)

        tok = cls.__new__(cls)
        tok.vocab_size = data["vocab_size"]
        tok.vocab = {str(k): int(v) for k, v in data["vocab"].items()}
        tok.id_to_token = {int(v): str(k) for k, v in tok.vocab.items()}
        tok.merges = [tuple(pair) for pair in data["merges"]]  # type: ignore[misc]
        tok._merge_rank = {pair: rank for rank, pair in enumerate(tok.merges)}
        tok._word_cache = {}
        return tok

    # ------------------------------------------------------------------
    # Convenience
    # ------------------------------------------------------------------

    def __len__(self) -> int:
        return len(self.vocab)

    def __repr__(self) -> str:
        return (
            f"ProverbsTokenizer("
            f"vocab_size={self.vocab_size}, "
            f"current_vocab={len(self.vocab)}, "
            f"merges={len(self.merges)})"
        )
