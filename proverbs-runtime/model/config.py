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

    # Attention type
    attention_type: str = "full"          # "full" | "sliding_window" | "linear"
    sliding_window_size: int = 512        # window size for SlidingWindowAttention

    # MoE
    use_moe: bool = False
    moe_n_experts: int = 8
    moe_top_k: int = 2

    # Multi-token prediction
    use_multi_token: bool = False
    n_future_tokens: int = 2

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
    def nano(cls) -> "ProverbsConfig":
        """~15M params — CPU-trainable on any machine, ~1-2h on Mac CPU
        Good for: personal fine-tuning on top of a GGUF base model."""
        return cls(d_model=256, n_heads=4, n_kv_heads=4, n_layers=6, d_ff=1024,
                   max_seq_len=1024)

    @classmethod
    def small(cls) -> "ProverbsConfig":
        """~58M params — 4 GB VRAM, ~3-6h on RTX 3080
        Good for: first real pre-train on code data."""
        return cls(d_model=512, n_heads=8, n_kv_heads=4, n_layers=8, d_ff=2048,
                   max_seq_len=4096)

    @classmethod
    def medium(cls) -> "ProverbsConfig":
        """~254M params — 8 GB VRAM, ~12-24h on RTX 3080
        Good for: strong coding assistant, comparable to GPT-2 large."""
        return cls(d_model=1024, n_heads=16, n_kv_heads=8, n_layers=16, d_ff=4096,
                   max_seq_len=4096)

    @classmethod
    def small_moe(cls) -> "ProverbsConfig":
        """small config with MoE: 4x experts, ~200M params at small compute cost"""
        cfg = cls.small()
        cfg.use_moe = True; cfg.moe_n_experts = 8; cfg.moe_top_k = 2
        return cfg

    @classmethod
    def large(cls) -> "ProverbsConfig":
        """~1.6B params — 16+ GB VRAM, days on RTX 3080
        Good for: production-grade coding model."""
        return cls(d_model=2048, n_heads=32, n_kv_heads=8, n_layers=24, d_ff=8192,
                   max_seq_len=8192)

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
