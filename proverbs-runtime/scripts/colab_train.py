# %% [markdown]
# # Proverbs LLM — Cloud Training (Free T4 GPU)
# Train your own code-focused LLM in ~2-3 hours on Google Colab's free GPU.
# After training, download the checkpoint and use it with the Proverbs server on your Mac.

# %%
# Cell 2 — Check GPU
import subprocess
result = subprocess.run(['nvidia-smi'], capture_output=True, text=True)
print(result.stdout or "No GPU detected — make sure Runtime > Change runtime type > T4 GPU is selected")

# %%
# Cell 3 — Install dependencies
# fmt: off
import subprocess as _sp
_sp.run(['pip', 'install', 'torch', 'datasets', 'tqdm', 'numpy', '--quiet'], check=True)
# fmt: on

# %%
# Cell 4 — Clone / upload project
# Option A: if you have the proverbs project in a zip, upload it
# Option B: paste the core model files inline
# We'll define everything inline so no upload needed
import os
os.makedirs('/content/proverbs/model', exist_ok=True)
os.makedirs('/content/proverbs/tokenizer', exist_ok=True)
os.makedirs('/content/proverbs/training', exist_ok=True)

# %%
# Cell 5 — Write model files inline

# ── model/__init__.py ─────────────────────────────────────────────────────────
open('/content/proverbs/model/__init__.py', 'w').write('')

# ── tokenizer/__init__.py ─────────────────────────────────────────────────────
open('/content/proverbs/tokenizer/__init__.py', 'w').write('')

# ── training/__init__.py ──────────────────────────────────────────────────────
open('/content/proverbs/training/__init__.py', 'w').write('')

# ── model/config.py ───────────────────────────────────────────────────────────
open('/content/proverbs/model/config.py', 'w').write(r'''
"""
ProverbsLM model configuration.

Three presets — pick based on your GPU VRAM:
  small  (~25M params)  — 4 GB VRAM, fast iteration
  medium (~130M params) — 8 GB VRAM, usable assistant
  large  (~370M params) — 16 GB VRAM, strong coding model
"""

from dataclasses import dataclass, field
from typing import Literal


@dataclass
class ProverbsConfig:
    # Architecture
    vocab_size: int = 32000
    d_model: int = 512          # embedding dimension
    n_heads: int = 8            # attention heads
    n_kv_heads: int = 8         # key/value heads (set < n_heads for GQA)
    n_layers: int = 6           # transformer depth
    d_ff: int = 2048            # feed-forward hidden dim
    max_seq_len: int = 2048     # max context length
    dropout: float = 0.0        # 0 for inference, 0.1 for training

    # RoPE
    rope_theta: float = 10000.0

    # Training
    pad_token_id: int = 0
    bos_token_id: int = 1
    eos_token_id: int = 2

    # Generation defaults
    temperature: float = 0.7
    top_p: float = 0.9
    max_new_tokens: int = 512

    # Custom logic layer
    rules_path: str = "~/.proverbs/rules.md"
    hooks_enabled: bool = True
    memory_enabled: bool = True
    tools_enabled: bool = True

    def __post_init__(self):
        assert self.d_model % self.n_heads == 0, "d_model must be divisible by n_heads"
        assert self.n_heads % self.n_kv_heads == 0, "n_heads must be divisible by n_kv_heads"

    @property
    def head_dim(self) -> int:
        return self.d_model // self.n_heads

    @classmethod
    def small(cls) -> "ProverbsConfig":
        """~25M params — 4 GB VRAM"""
        return cls(d_model=512, n_heads=8, n_kv_heads=8, n_layers=6, d_ff=2048)

    @classmethod
    def medium(cls) -> "ProverbsConfig":
        """~130M params — 8 GB VRAM"""
        return cls(d_model=1024, n_heads=16, n_kv_heads=8, n_layers=12, d_ff=4096)

    @classmethod
    def large(cls) -> "ProverbsConfig":
        """~370M params — 16 GB VRAM"""
        return cls(d_model=2048, n_heads=16, n_kv_heads=8, n_layers=24, d_ff=8192)

    def param_count(self) -> int:
        """Rough parameter count estimate."""
        embed = self.vocab_size * self.d_model
        attn = self.n_layers * (
            self.d_model * self.d_model             # Q
            + 2 * (self.n_kv_heads * self.head_dim) * self.d_model  # K, V
            + self.d_model * self.d_model            # O
        )
        ff = self.n_layers * (
            self.d_model * self.d_ff * 2             # gate + up (SwiGLU)
            + self.d_ff * self.d_model               # down
        )
        norms = self.n_layers * 2 * self.d_model + self.d_model
        lm_head = self.vocab_size * self.d_model
        return embed + attn + ff + norms + lm_head
'''.lstrip())

# ── model/attention.py ────────────────────────────────────────────────────────
open('/content/proverbs/model/attention.py', 'w').write(r'''
"""
Multi-head attention with Rotary Position Embeddings (RoPE).

Supports Grouped Query Attention (GQA): set n_kv_heads < n_heads in config
to share key/value heads across multiple query heads — reduces VRAM during
inference with no quality loss.
"""

import math
import torch
import torch.nn as nn
import torch.nn.functional as F
from .config import ProverbsConfig


# ── RoPE ─────────────────────────────────────────────────────────────────────

def _rope_freqs(head_dim: int, max_seq_len: int, theta: float, device: torch.device) -> torch.Tensor:
    """Precompute cos/sin rotation matrices for RoPE — shape (max_seq_len, head_dim)."""
    positions = torch.arange(max_seq_len, device=device).float()
    dims = torch.arange(0, head_dim, 2, device=device).float()
    inv_freq = 1.0 / (theta ** (dims / head_dim))
    angles = torch.outer(positions, inv_freq)          # (seq, head_dim/2)
    return torch.cat([angles, angles], dim=-1)          # (seq, head_dim)


def _rotate_half(x: torch.Tensor) -> torch.Tensor:
    """Rotate the second half of the last dimension."""
    half = x.shape[-1] // 2
    x1, x2 = x[..., :half], x[..., half:]
    return torch.cat([-x2, x1], dim=-1)


def apply_rope(q: torch.Tensor, k: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor) -> tuple:
    """Apply RoPE to query and key tensors."""
    cos = cos.unsqueeze(0).unsqueeze(0)  # (1, 1, seq, head_dim)
    sin = sin.unsqueeze(0).unsqueeze(0)
    q_rot = q * cos + _rotate_half(q) * sin
    k_rot = k * cos + _rotate_half(k) * sin
    return q_rot, k_rot


# ── Attention ─────────────────────────────────────────────────────────────────

class MultiHeadAttention(nn.Module):
    def __init__(self, cfg: ProverbsConfig):
        super().__init__()
        self.n_heads    = cfg.n_heads
        self.n_kv_heads = cfg.n_kv_heads
        self.head_dim   = cfg.head_dim
        self.n_rep      = cfg.n_heads // cfg.n_kv_heads  # repeat factor for GQA

        self.q_proj = nn.Linear(cfg.d_model, cfg.n_heads    * cfg.head_dim, bias=False)
        self.k_proj = nn.Linear(cfg.d_model, cfg.n_kv_heads * cfg.head_dim, bias=False)
        self.v_proj = nn.Linear(cfg.d_model, cfg.n_kv_heads * cfg.head_dim, bias=False)
        self.o_proj = nn.Linear(cfg.n_heads * cfg.head_dim, cfg.d_model,    bias=False)

        self.dropout = nn.Dropout(cfg.dropout)
        self.scale   = math.sqrt(cfg.head_dim)

        # Precomputed RoPE tables — registered as buffers (not parameters)
        angles = _rope_freqs(cfg.head_dim, cfg.max_seq_len, cfg.rope_theta, device=torch.device("cpu"))
        self.register_buffer("rope_cos", angles.cos())  # (max_seq_len, head_dim)
        self.register_buffer("rope_sin", angles.sin())

    def forward(
        self,
        x: torch.Tensor,                          # (B, T, d_model)
        mask: torch.Tensor | None = None,         # (B, 1, T, T) causal mask
        kv_cache: tuple | None = None,            # (k_cache, v_cache) for generation
    ) -> tuple:
        B, T, _ = x.shape

        q = self.q_proj(x).view(B, T, self.n_heads,    self.head_dim).transpose(1, 2)
        k = self.k_proj(x).view(B, T, self.n_kv_heads, self.head_dim).transpose(1, 2)
        v = self.v_proj(x).view(B, T, self.n_kv_heads, self.head_dim).transpose(1, 2)

        # Apply RoPE
        cos = self.rope_cos[:T].to(x.device)
        sin = self.rope_sin[:T].to(x.device)
        q, k = apply_rope(q, k, cos, sin)

        # KV cache append (used during autoregressive generation)
        if kv_cache is not None:
            k_cache, v_cache = kv_cache
            k = torch.cat([k_cache, k], dim=2)
            v = torch.cat([v_cache, v], dim=2)
        new_kv_cache = (k, v)

        # GQA: repeat K/V heads to match Q head count
        if self.n_rep > 1:
            k = k.unsqueeze(2).expand(-1, -1, self.n_rep, -1, -1).reshape(B, self.n_heads, -1, self.head_dim)
            v = v.unsqueeze(2).expand(-1, -1, self.n_rep, -1, -1).reshape(B, self.n_heads, -1, self.head_dim)

        # Scaled dot-product attention
        # Use PyTorch's built-in flash-attention when available (torch >= 2.0)
        if hasattr(F, "scaled_dot_product_attention") and mask is None:
            attn_out = F.scaled_dot_product_attention(q, k, v, dropout_p=self.dropout.p if self.training else 0.0, is_causal=True)
        else:
            scores = torch.matmul(q, k.transpose(-2, -1)) / self.scale
            if mask is not None:
                scores = scores + mask
            attn_weights = self.dropout(F.softmax(scores.float(), dim=-1).to(x.dtype))
            attn_out = torch.matmul(attn_weights, v)

        out = attn_out.transpose(1, 2).contiguous().view(B, T, -1)
        return self.o_proj(out), new_kv_cache
'''.lstrip())

# ── model/transformer.py ──────────────────────────────────────────────────────
open('/content/proverbs/model/transformer.py', 'w').write(r'''
"""
Transformer building blocks for ProverbsLM.

Uses modern design choices:
  - RMSNorm  (faster than LayerNorm, no mean subtraction)
  - SwiGLU   (gated activation — better than GELU for language models)
  - Pre-norm  (norm before attention/FFN, more stable training)
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
from .config import ProverbsConfig
from .attention import MultiHeadAttention


# ── RMSNorm ───────────────────────────────────────────────────────────────────

class RMSNorm(nn.Module):
    def __init__(self, dim: int, eps: float = 1e-6):
        super().__init__()
        self.eps   = eps
        self.scale = nn.Parameter(torch.ones(dim))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        rms = x.float().pow(2).mean(-1, keepdim=True).add(self.eps).sqrt()
        return (x.float() / rms * self.scale).to(x.dtype)


# ── SwiGLU Feed-Forward ───────────────────────────────────────────────────────

class SwiGLU(nn.Module):
    """
    SwiGLU FFN: out = (xW_gate * swish(xW_up)) @ W_down
    Two input projections (gate + up), one output projection (down).
    """
    def __init__(self, cfg: ProverbsConfig):
        super().__init__()
        self.gate = nn.Linear(cfg.d_model, cfg.d_ff, bias=False)
        self.up   = nn.Linear(cfg.d_model, cfg.d_ff, bias=False)
        self.down = nn.Linear(cfg.d_ff,    cfg.d_model, bias=False)
        self.drop = nn.Dropout(cfg.dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.drop(self.down(F.silu(self.gate(x)) * self.up(x)))


# ── Transformer Block ─────────────────────────────────────────────────────────

class TransformerBlock(nn.Module):
    def __init__(self, cfg: ProverbsConfig):
        super().__init__()
        self.attn      = MultiHeadAttention(cfg)
        self.ffn       = SwiGLU(cfg)
        self.norm_attn = RMSNorm(cfg.d_model)
        self.norm_ffn  = RMSNorm(cfg.d_model)

    def forward(
        self,
        x: torch.Tensor,
        mask: torch.Tensor | None = None,
        kv_cache: tuple | None = None,
    ) -> tuple:
        # Pre-norm attention with residual
        attn_out, new_kv = self.attn(self.norm_attn(x), mask=mask, kv_cache=kv_cache)
        x = x + attn_out

        # Pre-norm FFN with residual
        x = x + self.ffn(self.norm_ffn(x))

        return x, new_kv


# ── Causal Mask ───────────────────────────────────────────────────────────────

def make_causal_mask(seq_len: int, device: torch.device, dtype: torch.dtype) -> torch.Tensor:
    """Upper-triangular mask filled with -inf, shape (1, 1, T, T)."""
    mask = torch.full((seq_len, seq_len), float("-inf"), device=device, dtype=dtype)
    return torch.triu(mask, diagonal=1).unsqueeze(0).unsqueeze(0)
'''.lstrip())

# ── model/proverbs_lm.py ──────────────────────────────────────────────────────
open('/content/proverbs/model/proverbs_lm.py', 'w').write(r'''
"""
ProverbsLM — the full language model.

Architecture:
  token_embed → [TransformerBlock x N] → RMSNorm → lm_head (→ logits)

The model is hardware-agnostic: call .to_device() to place it on
cuda / mps / cpu automatically.
"""

import torch
import torch.nn as nn
from pathlib import Path

from .config import ProverbsConfig
from .transformer import TransformerBlock, RMSNorm, make_causal_mask


class ProverbsLM(nn.Module):
    def __init__(self, cfg: ProverbsConfig):
        super().__init__()
        self.cfg = cfg

        self.token_embed = nn.Embedding(cfg.vocab_size, cfg.d_model, padding_idx=cfg.pad_token_id)
        self.drop        = nn.Dropout(cfg.dropout)
        self.layers      = nn.ModuleList([TransformerBlock(cfg) for _ in range(cfg.n_layers)])
        self.norm        = RMSNorm(cfg.d_model)
        self.lm_head     = nn.Linear(cfg.d_model, cfg.vocab_size, bias=False)

        # Tie embedding weights to lm_head (halves params, standard practice)
        self.lm_head.weight = self.token_embed.weight

        self._init_weights()

    def _init_weights(self):
        for module in self.modules():
            if isinstance(module, nn.Linear):
                nn.init.normal_(module.weight, mean=0.0, std=0.02)
                if module.bias is not None:
                    nn.init.zeros_(module.bias)
            elif isinstance(module, nn.Embedding):
                nn.init.normal_(module.weight, mean=0.0, std=0.02)

    def forward(
        self,
        input_ids: torch.Tensor,            # (B, T)
        labels: torch.Tensor | None = None, # (B, T) for training
        kv_caches: list | None = None,      # list of (k, v) per layer
    ) -> dict:
        B, T = input_ids.shape
        device, dtype = input_ids.device, self.token_embed.weight.dtype

        x = self.drop(self.token_embed(input_ids).to(dtype))

        # Causal mask only needed when not using flash attention or during training
        mask = make_causal_mask(T, device, dtype) if T > 1 else None

        new_kv_caches = []
        for i, layer in enumerate(self.layers):
            kv = kv_caches[i] if kv_caches is not None else None
            x, new_kv = layer(x, mask=mask, kv_cache=kv)
            new_kv_caches.append(new_kv)

        x      = self.norm(x)
        logits = self.lm_head(x)  # (B, T, vocab_size)

        result = {"logits": logits, "kv_caches": new_kv_caches}

        if labels is not None:
            # Shift so token i predicts token i+1
            shift_logits = logits[:, :-1, :].contiguous()
            shift_labels = labels[:, 1:].contiguous()
            loss = nn.functional.cross_entropy(
                shift_logits.view(-1, self.cfg.vocab_size),
                shift_labels.view(-1),
                ignore_index=self.cfg.pad_token_id,
            )
            result["loss"] = loss

        return result

    # ── Persistence ───────────────────────────────────────────────────────────

    def save(self, path: str | Path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        torch.save({
            "config": self.cfg.__dict__,
            "state_dict": self.state_dict(),
        }, path)

    @classmethod
    def load(cls, path: str | Path, device: str | None = None) -> "ProverbsLM":
        device = device or _best_device()
        checkpoint = torch.load(path, map_location=device, weights_only=True)
        cfg = ProverbsConfig(**checkpoint["config"])
        model = cls(cfg)
        model.load_state_dict(checkpoint["state_dict"])
        return model.to(device)

    def to_device(self) -> "ProverbsLM":
        return self.to(_best_device())

    def param_count(self) -> int:
        return sum(p.numel() for p in self.parameters())

    def __repr__(self):
        return (
            f"ProverbsLM("
            f"params={self.param_count()/1e6:.1f}M, "
            f"layers={self.cfg.n_layers}, "
            f"d_model={self.cfg.d_model}, "
            f"heads={self.cfg.n_heads}"
            f")"
        )


def _best_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"
'''.lstrip())

# ── tokenizer/bpe.py ──────────────────────────────────────────────────────────
open('/content/proverbs/tokenizer/bpe.py', 'w').write(r'''
"""
ProverbsTokenizer — from-scratch Byte-Pair Encoding tokenizer.

No external dependencies; pure Python 3.10+ stdlib only.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from typing import Iterator


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

_WHITESPACE_RE = re.compile(r"\S+")


def _pretokenize(text: str) -> Iterator[str]:
    """
    Split *text* on whitespace; prefix each word with Ġ when it was preceded
    by at least one whitespace character (GPT-2 style).
    """
    prev_end = 0
    for m in _WHITESPACE_RE.finditer(text):
        start = m.start()
        word = m.group()
        has_preceding_space = start > prev_end or (start == 0 and text and text[0] == " ")
        if has_preceding_space:
            yield _SPACE_CHAR + word
        else:
            yield word
        prev_end = m.end()


def _word_to_chars(word: str) -> tuple[str, ...]:
    """Convert a (possibly Ġ-prefixed) word string to a tuple of char-tokens."""
    return tuple(word)


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

        if verbose:
            print(f"Training complete. Vocabulary size: {len(self.vocab)}")

    # ------------------------------------------------------------------
    # Encoding
    # ------------------------------------------------------------------

    def _apply_merges(self, char_seq: list[str]) -> list[str]:
        """Apply all learned merge rules to a list of character tokens."""
        if len(char_seq) <= 1:
            return char_seq

        merge_rank: dict[tuple[str, str], int] = {
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

        for word in _pretokenize(text):
            char_seq: list[str] = []
            for ch in word:
                if ch in self.vocab:
                    # Already a known single-char token (includes Ġ)
                    char_seq.append(ch)
                else:
                    # Encode as UTF-8 bytes, map each byte to its char representation
                    for byte_val in ch.encode("utf-8"):
                        byte_char = _BYTE_TO_CHAR[byte_val]
                        char_seq.append(byte_char)

            merged = self._apply_merges(char_seq)
            for tok in merged:
                ids.append(self.vocab.get(tok, unk_id))

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
'''.lstrip())

# ── training/pretrain_dataset.py ──────────────────────────────────────────────
open('/content/proverbs/training/pretrain_dataset.py', 'w').write(r'''
"""
pretrain_dataset.py — Dataset for pre-training ProverbsLM on raw code.

Reads the JSONL files produced by scripts/download_pretrain_data.py,
tokenizes each code document, packs multiple short documents into
fixed-length chunks (no padding waste), and yields (input_ids, labels)
pairs for next-token prediction.

Packing strategy: documents are concatenated with EOS tokens between
them, then sliced into max_seq_len windows. This maximises GPU utilisation
— no wasted compute on padding.
"""

import json
import random
import sys
import warnings
from pathlib import Path
from typing import Iterator

import torch
from torch.utils.data import Dataset, DataLoader

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from tokenizer.bpe import ProverbsTokenizer


class PretrainDataset(Dataset):
    """
    Packed pre-training dataset.

    All code documents are tokenized, concatenated with EOS separators,
    then carved into fixed max_seq_len+1 windows.  The +1 gives us the
    label shift (predict token i+1 from token i) without any extra copy.
    """

    def __init__(
        self,
        data_dir: str = "~/.proverbs/pretrain_data",
        tokenizer_path: str = "~/.proverbs/tokenizer.json",
        max_seq_len: int = 2048,
        split: str = "train",
        valid_ratio: float = 0.02,       # 2% held out for validation
        max_tokens: int = 0,             # 0 = use all data
        shuffle_docs: bool = True,
        seed: int = 42,
    ):
        self.max_seq_len = max_seq_len
        data_dir = Path(data_dir).expanduser()
        tokenizer_path = Path(tokenizer_path).expanduser()

        if not tokenizer_path.exists():
            raise FileNotFoundError(
                f"Tokenizer not found: {tokenizer_path}\n"
                "Run: python -m tokenizer.train_tokenizer first."
            )

        tok = ProverbsTokenizer.load(str(tokenizer_path))
        eos = tok.EOS_TOKEN_ID if hasattr(tok, "EOS_TOKEN_ID") else tok.vocab.get("<|eos|>", 2)

        # Collect all JSONL files
        jsonl_files = sorted(data_dir.glob("*.jsonl"))
        if not jsonl_files:
            raise FileNotFoundError(f"No JSONL files found in {data_dir}")

        # Load and optionally shuffle document list
        docs: list[str] = []
        for path in jsonl_files:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                        text = obj.get("text", "")
                        if text.strip():
                            docs.append(text)
                    except json.JSONDecodeError:
                        pass

        if shuffle_docs:
            rng = random.Random(seed)
            rng.shuffle(docs)

        # Deterministic train/valid split by document index
        n_valid = max(1, round(len(docs) * valid_ratio))
        if split == "valid":
            docs = docs[-n_valid:]
        else:
            docs = docs[:-n_valid]

        # Tokenize all documents into one long flat token stream
        print(f"  Tokenizing {len(docs):,} documents for {split} split ...", flush=True)
        flat: list[int] = []
        for i, doc in enumerate(docs):
            tokens = tok.encode(doc)
            if tokens:
                flat.extend(tokens)
                flat.append(eos)
            if max_tokens and len(flat) >= max_tokens:
                flat = flat[:max_tokens]
                break
            if (i + 1) % 10_000 == 0:
                print(f"    {i+1:,}/{len(docs):,} docs  ({len(flat)/1e6:.1f}M tokens)", flush=True)

        print(f"  {split}: {len(flat)/1e6:.2f}M tokens total")

        # Carve into (max_seq_len + 1) windows — last token is the final label
        window = max_seq_len + 1
        self.chunks: list[list[int]] = [
            flat[i : i + window]
            for i in range(0, len(flat) - window + 1, max_seq_len)
        ]
        print(f"  {split}: {len(self.chunks):,} chunks of {max_seq_len} tokens")

    def __len__(self) -> int:
        return len(self.chunks)

    def __getitem__(self, idx: int) -> dict:
        chunk = self.chunks[idx]
        t = torch.tensor(chunk, dtype=torch.long)
        return {
            "input_ids": t[:-1],   # tokens 0..T-1
            "labels":    t[1:],    # tokens 1..T  (next-token targets, no masking needed)
        }


def create_pretrain_dataloader(
    dataset: PretrainDataset,
    batch_size: int = 4,
    shuffle: bool = True,
    num_workers: int = 0,
) -> DataLoader:
    return DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=shuffle,
        num_workers=num_workers,
        pin_memory=torch.cuda.is_available(),
    )
'''.lstrip())

# ── training/trainer.py ───────────────────────────────────────────────────────
open('/content/proverbs/training/trainer.py', 'w').write(r'''
"""
training/trainer.py — ProverbsTrainer

Full training loop for ProverbsLM with:
  - AdamW + cosine LR schedule with linear warmup
  - Automatic mixed precision (CUDA only)
  - Gradient clipping
  - Periodic evaluation, checkpointing, and best-model tracking
  - Optional torch.compile (PyTorch >= 2.0)
  - tqdm progress bars (falls back to plain print)
"""

from __future__ import annotations

import math
import os
import sys
import time
from pathlib import Path
from typing import Iterator

import torch
import torch.nn as nn
from torch.utils.data import DataLoader

# ---------------------------------------------------------------------------
# Project root on sys.path
# ---------------------------------------------------------------------------
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from model.config import ProverbsConfig      # noqa: E402
from model.proverbs_lm import ProverbsLM     # noqa: E402

# ---------------------------------------------------------------------------
# Optional tqdm
# ---------------------------------------------------------------------------
try:
    from tqdm import tqdm as _tqdm
    _HAS_TQDM = True
except ImportError:
    _HAS_TQDM = False


def _best_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


# ---------------------------------------------------------------------------
# LR schedule helpers
# ---------------------------------------------------------------------------

def _cosine_lr(
    step: int,
    warmup_steps: int,
    max_steps: int,
    lr_max: float,
    lr_min: float = 1e-5,
) -> float:
    """Linear warmup then cosine decay to lr_min."""
    if step < warmup_steps:
        return lr_max * (step + 1) / max(warmup_steps, 1)
    progress = (step - warmup_steps) / max(max_steps - warmup_steps, 1)
    progress = min(progress, 1.0)
    return lr_min + 0.5 * (lr_max - lr_min) * (1.0 + math.cos(math.pi * progress))


def _set_lr(optimizer: torch.optim.Optimizer, lr: float) -> None:
    for group in optimizer.param_groups:
        group["lr"] = lr


# ---------------------------------------------------------------------------
# Infinite dataloader iterator
# ---------------------------------------------------------------------------

def _infinite(loader: DataLoader) -> Iterator[dict[str, torch.Tensor]]:
    """Yield batches forever, restarting the loader each epoch."""
    while True:
        yield from loader


# ---------------------------------------------------------------------------
# ProverbsTrainer
# ---------------------------------------------------------------------------

class ProverbsTrainer:
    """
    Training loop for ProverbsLM.

    Parameters
    ----------
    model        : A ProverbsLM instance (not yet on device — trainer handles that).
    train_loader : DataLoader for training data.
    valid_loader : DataLoader for validation data.
    cfg          : ProverbsConfig attached to the model.
    output_dir   : Directory for checkpoints.  Default: ~/.proverbs/checkpoints
    lr           : Peak learning rate for AdamW.
    warmup_steps : Number of linear warmup steps before cosine decay.
    max_steps    : Total optimiser steps before stopping.
    grad_clip    : Max gradient norm (0 or None disables clipping).
    log_every    : Print training metrics every N steps.
    eval_every   : Run validation every N steps.
    save_every   : Save a checkpoint every N steps.
    use_amp      : Enable automatic mixed precision (CUDA only).
    compile_model: Call torch.compile() on the model (requires PyTorch >= 2.0).
    """

    def __init__(
        self,
        model: ProverbsLM,
        train_loader: DataLoader,
        valid_loader: DataLoader,
        cfg: ProverbsConfig | None = None,
        output_dir: str = "~/.proverbs/checkpoints",
        lr: float = 3e-4,
        warmup_steps: int = 100,
        max_steps: int = 10_000,
        grad_clip: float = 1.0,
        log_every: int = 10,
        eval_every: int = 500,
        save_every: int = 1_000,
        use_amp: bool = True,
        compile_model: bool = False,
    ) -> None:
        self.cfg = cfg if cfg is not None else model.cfg
        self.train_loader = train_loader
        self.valid_loader = valid_loader
        self.lr = lr
        self.warmup_steps = warmup_steps
        self.max_steps = max_steps
        self.grad_clip = grad_clip
        self.log_every = log_every
        self.eval_every = eval_every
        self.save_every = save_every

        # Output directory
        self.output_dir = Path(output_dir).expanduser().resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)

        # Device
        self.device = _best_device()

        # Move model to device
        self.model: ProverbsLM = model.to(self.device)

        # Optional torch.compile
        if compile_model:
            if not hasattr(torch, "compile"):
                print("[trainer] WARNING: torch.compile not available (requires PyTorch >= 2.0). Skipping.")
            else:
                print("[trainer] Compiling model with torch.compile ...")
                self.model = torch.compile(self.model)  # type: ignore[assignment]

        # Optimizer — separate weight-decay from bias / norm params
        decay_params, nodecay_params = _split_params(self.model)
        self.optimizer = torch.optim.AdamW(
            [
                {"params": decay_params,   "weight_decay": 0.1},
                {"params": nodecay_params, "weight_decay": 0.0},
            ],
            lr=lr,
            betas=(0.9, 0.95),
            eps=1e-8,
            fused=self.device == "cuda",  # fused kernel when available on CUDA
        )

        # AMP — only on CUDA; MPS / CPU use full precision
        self.use_amp = use_amp and (self.device == "cuda")
        self.scaler = torch.cuda.amp.GradScaler(enabled=self.use_amp)

        # Training state
        self.step: int = 0
        self.best_valid_loss: float = float("inf")

        n_params = self.model.param_count() if hasattr(self.model, "param_count") else sum(
            p.numel() for p in self.model.parameters()
        )
        print(
            f"[trainer] ProverbsTrainer ready  |  "
            f"params={n_params/1e6:.1f}M  |  "
            f"device={self.device}  |  "
            f"AMP={'on' if self.use_amp else 'off'}  |  "
            f"output={self.output_dir}"
        )

    # ------------------------------------------------------------------
    # Main training loop
    # ------------------------------------------------------------------

    def train(self) -> None:
        """Run the training loop until max_steps is reached."""
        self.model.train()
        data_iter = _infinite(self.train_loader)

        # Tokens per batch (approx) for throughput reporting
        batch = next(data_iter)
        tokens_per_batch: int = int(batch["input_ids"].numel())
        # Put it back by restarting the iterator
        data_iter = _infinite(self.train_loader)

        if _HAS_TQDM:
            pbar = _tqdm(total=self.max_steps, initial=self.step, desc="training", unit="step")
        else:
            pbar = None

        t0 = time.perf_counter()

        while self.step < self.max_steps:
            batch = next(data_iter)
            input_ids: torch.Tensor = batch["input_ids"].to(self.device, non_blocking=True)
            labels: torch.Tensor    = batch["labels"].to(self.device, non_blocking=True)

            labels = labels.clone()
            labels[labels == -100] = self.cfg.pad_token_id

            self.optimizer.zero_grad(set_to_none=True)

            # Forward
            with torch.autocast(device_type=self.device, enabled=self.use_amp, dtype=torch.float16):
                out = self.model(input_ids=input_ids, labels=labels)
                loss: torch.Tensor = out["loss"]

            # Backward
            self.scaler.scale(loss).backward()

            # Gradient clip
            if self.grad_clip and self.grad_clip > 0:
                self.scaler.unscale_(self.optimizer)
                nn.utils.clip_grad_norm_(self.model.parameters(), self.grad_clip)

            # Optimiser step
            self.scaler.step(self.optimizer)
            self.scaler.update()

            # LR schedule
            new_lr = _cosine_lr(self.step, self.warmup_steps, self.max_steps, self.lr)
            _set_lr(self.optimizer, new_lr)

            self.step += 1

            # Logging
            if self.step % self.log_every == 0:
                t1 = time.perf_counter()
                elapsed = t1 - t0
                tok_per_sec = tokens_per_batch * self.log_every / max(elapsed, 1e-9)
                t0 = t1

                mem_str = ""
                if self.device == "cuda":
                    alloc_gb = torch.cuda.memory_allocated() / 1e9
                    reserved_gb = torch.cuda.memory_reserved() / 1e9
                    mem_str = f"  mem={alloc_gb:.1f}/{reserved_gb:.1f}GB"

                msg = (
                    f"step={self.step:>6d}/{self.max_steps}  "
                    f"loss={loss.item():.4f}  "
                    f"lr={new_lr:.2e}  "
                    f"tok/s={tok_per_sec:,.0f}"
                    f"{mem_str}"
                )
                if pbar is not None:
                    pbar.set_postfix_str(
                        f"loss={loss.item():.4f} lr={new_lr:.2e} tok/s={tok_per_sec:,.0f}"
                    )
                    pbar.update(self.log_every)
                else:
                    print(msg)

            # Evaluation
            if self.step % self.eval_every == 0:
                valid_loss = self.evaluate()
                is_best = valid_loss < self.best_valid_loss
                if is_best:
                    self.best_valid_loss = valid_loss
                self.save_checkpoint(self.step, is_best=is_best)
                best_str = "  *** new best ***" if is_best else ""
                print(
                    f"[eval]  step={self.step}  valid_loss={valid_loss:.4f}"
                    f"  best={self.best_valid_loss:.4f}{best_str}"
                )
                self.model.train()

            # Periodic checkpoint (skip if we just saved on eval_every overlap)
            elif self.step % self.save_every == 0:
                self.save_checkpoint(self.step, is_best=False)

        if pbar is not None:
            pbar.close()

        print(f"[trainer] Training complete at step {self.step}.  Best valid loss: {self.best_valid_loss:.4f}")

    # ------------------------------------------------------------------
    # Evaluation
    # ------------------------------------------------------------------

    def evaluate(self) -> float:
        """
        Run the model over the entire valid_loader and return mean cross-entropy loss.
        Gradient computation is disabled.
        """
        self.model.eval()
        total_loss = 0.0
        total_batches = 0

        with torch.no_grad():
            for batch in self.valid_loader:
                input_ids = batch["input_ids"].to(self.device, non_blocking=True)
                labels    = batch["labels"].to(self.device, non_blocking=True)

                # Remap ignore index
                labels = labels.clone()
                labels[labels == -100] = self.cfg.pad_token_id

                with torch.autocast(device_type=self.device, enabled=self.use_amp, dtype=torch.float16):
                    out = self.model(input_ids=input_ids, labels=labels)

                total_loss += out["loss"].item()
                total_batches += 1

        if total_batches == 0:
            return float("inf")
        return total_loss / total_batches

    # ------------------------------------------------------------------
    # Checkpointing
    # ------------------------------------------------------------------

    def save_checkpoint(self, step: int, is_best: bool = False) -> None:
        """
        Save model weights, optimizer state, and trainer metadata to
        output_dir/checkpoint-{step}.pt.
        If is_best is True, also copy to output_dir/best.pt.
        """
        ckpt_path = self.output_dir / f"checkpoint-{step}.pt"
        payload = {
            "step": step,
            "best_valid_loss": self.best_valid_loss,
            "model_state_dict": (
                self.model._orig_mod.state_dict()           # unwrap torch.compile
                if hasattr(self.model, "_orig_mod")
                else self.model.state_dict()
            ),
            "optimizer_state_dict": self.optimizer.state_dict(),
            "scaler_state_dict": self.scaler.state_dict(),
            "config": self.cfg.__dict__,
        }
        torch.save(payload, ckpt_path)
        print(f"[trainer] Saved checkpoint -> {ckpt_path}")

        if is_best:
            best_path = self.output_dir / "best.pt"
            torch.save(payload, best_path)
            print(f"[trainer] Saved best model -> {best_path}")

    # ------------------------------------------------------------------
    # Resume
    # ------------------------------------------------------------------

    @classmethod
    def resume(
        cls,
        checkpoint_path: str,
        train_loader: DataLoader,
        valid_loader: DataLoader,
        output_dir: str = "~/.proverbs/checkpoints",
        lr: float = 3e-4,
        warmup_steps: int = 100,
        max_steps: int = 10_000,
        grad_clip: float = 1.0,
        log_every: int = 10,
        eval_every: int = 500,
        save_every: int = 1_000,
        use_amp: bool = True,
        compile_model: bool = False,
    ) -> "ProverbsTrainer":
        """
        Load a saved checkpoint and return a ProverbsTrainer ready to continue.
        """
        device = _best_device()
        print(f"[trainer] Resuming from {checkpoint_path} ...")
        payload = torch.load(checkpoint_path, map_location=device, weights_only=False)

        cfg = ProverbsConfig(**payload["config"])
        model = ProverbsLM(cfg)
        model.load_state_dict(payload["model_state_dict"])

        trainer = cls(
            model=model,
            train_loader=train_loader,
            valid_loader=valid_loader,
            cfg=cfg,
            output_dir=output_dir,
            lr=lr,
            warmup_steps=warmup_steps,
            max_steps=max_steps,
            grad_clip=grad_clip,
            log_every=log_every,
            eval_every=eval_every,
            save_every=save_every,
            use_amp=use_amp,
            compile_model=compile_model,
        )

        # Restore optimizer and scaler
        trainer.optimizer.load_state_dict(payload["optimizer_state_dict"])
        trainer.scaler.load_state_dict(payload["scaler_state_dict"])

        # Restore bookkeeping
        trainer.step = payload["step"]
        trainer.best_valid_loss = payload.get("best_valid_loss", float("inf"))

        print(
            f"[trainer] Resumed at step {trainer.step}  |  "
            f"best_valid_loss={trainer.best_valid_loss:.4f}"
        )
        return trainer


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _split_params(
    model: nn.Module,
) -> tuple[list[torch.nn.Parameter], list[torch.nn.Parameter]]:
    """
    Separate parameters that should have weight decay applied from those that
    should not (biases, LayerNorm / RMSNorm weights, embedding weights).
    """
    decay: list[torch.nn.Parameter] = []
    no_decay: list[torch.nn.Parameter] = []

    for name, param in model.named_parameters():
        if not param.requires_grad:
            continue
        # Biases and 1-D params (norm scales) -> no decay
        if param.ndim == 1 or name.endswith(".bias"):
            no_decay.append(param)
        else:
            decay.append(param)

    return decay, no_decay
'''.lstrip())

print("All source files written to /content/proverbs/")
print("Packages: model/, tokenizer/, training/")

# %%
# Cell 6 — Download CodeSearchNet data
from datasets import load_dataset
import json, pathlib
DATA_DIR = pathlib.Path('/content/proverbs_data')
DATA_DIR.mkdir(exist_ok=True)

LANGS = ['python', 'javascript', 'go']  # enough for ~150M tokens
MAX_PER_LANG = 80000  # ~45 min download + tokenize

for lang in LANGS:
    out = DATA_DIR / f'{lang}.jsonl'
    if out.exists():
        print(f'{lang}: already downloaded')
        continue
    print(f'Downloading {lang}...')
    ds = load_dataset('code_search_net', lang, split='train', trust_remote_code=True)
    count = 0
    with open(out, 'w') as f:
        for row in ds:
            code = row.get('whole_func_string') or row.get('code', '')
            if code.strip():
                f.write(json.dumps({'text': code.strip(), 'lang': lang}) + '\n')
                count += 1
                if count >= MAX_PER_LANG: break
    print(f'{lang}: {count} examples saved')

# %%
# Cell 7 — Train tokenizer
import sys
sys.path.insert(0, '/content/proverbs')
from tokenizer.bpe import ProverbsTokenizer
import json, pathlib, random

print('Collecting texts...')
texts = []
for f in pathlib.Path('/content/proverbs_data').glob('*.jsonl'):
    for line in open(f):
        obj = json.loads(line)
        if obj.get('text', '').strip():
            texts.append(obj['text'])

random.seed(42)
random.shuffle(texts)
texts = texts[:200000]  # 200k samples is enough for tokenizer

print(f'Training BPE tokenizer on {len(texts):,} samples...')
tok = ProverbsTokenizer(vocab_size=32000)
tok.train(texts, verbose=True)
tok.save('/content/tokenizer.json')
print(f'Saved tokenizer: {len(tok.vocab)} tokens')

# %%
# Cell 8 — Configure training
import sys
sys.path.insert(0, '/content/proverbs')
from model.config import ProverbsConfig

# small = 58M params, ~2-3 hours on T4
# Change to 'medium' for a smarter but slower model
SIZE = 'small'

cfg = {'small': ProverbsConfig.small, 'medium': ProverbsConfig.medium}[SIZE]()
cfg.dropout = 0.1
print(f'Model: {SIZE} — {cfg.param_count()/1e6:.1f}M params')
print(f'Context: {cfg.max_seq_len} tokens')

# %%
# Cell 9 — Load dataset + train
from training.pretrain_dataset import PretrainDataset, create_pretrain_dataloader
from model.proverbs_lm import ProverbsLM
from training.trainer import ProverbsTrainer
import pathlib, torch

print('Loading dataset...')
train_ds = PretrainDataset('/content/proverbs_data', '/content/tokenizer.json',
                            cfg.max_seq_len, split='train')
valid_ds = PretrainDataset('/content/proverbs_data', '/content/tokenizer.json',
                            cfg.max_seq_len, split='valid')

train_loader = create_pretrain_dataloader(train_ds, batch_size=16, shuffle=True)
valid_loader = create_pretrain_dataloader(valid_ds, batch_size=16, shuffle=False)

model = ProverbsLM(cfg).to('cuda')

out_dir = pathlib.Path('/content/checkpoints')
out_dir.mkdir(exist_ok=True)

trainer = ProverbsTrainer(
    model=model,
    train_loader=train_loader,
    valid_loader=valid_loader,
    lr=3e-4,
    max_steps=50000,
    warmup_steps=500,
    output_dir=str(out_dir),
    use_amp=True,
    log_every=50,
    eval_every=1000,
    save_every=5000,
)

print('Starting training...')
trainer.train()

# Save final
raw = model._orig_mod if hasattr(model, '_orig_mod') else model
raw.save('/content/checkpoints/final.pt')
print('Training complete!')

# %%
# Cell 10 — Download the trained model
from google.colab import files

best = '/content/checkpoints/best.pt'
final = '/content/checkpoints/final.pt'

checkpoint = best if __import__('pathlib').Path(best).exists() else final
print(f'Downloading: {checkpoint}')
files.download(checkpoint)
files.download('/content/tokenizer.json')

print()
print('Next steps on your Mac:')
print('1. Move the downloaded files:')
print('   mv ~/Downloads/best.pt ~/.proverbs/checkpoints/best.pt')
print('   mv ~/Downloads/tokenizer.json ~/.proverbs/tokenizer.json')
print('2. Start the Proverbs server:')
print('   ~/.proverbs/venv/bin/python -m inference.server')
print('3. Use it in your terminal with the Proverbs CLI')
