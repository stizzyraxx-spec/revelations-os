"""
ProverbsEmbedder — internal embedding model built on the ProverbsLM backbone.

Uses frozen transformer layers + mean pooling + a trainable projection head
to produce fixed-size, L2-normalized embeddings without any external downloads.
"""

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from pathlib import Path

from .proverbs_lm import ProverbsLM, _best_device


class EmbeddingHead(nn.Module):
    def __init__(self, d_model: int, embed_dim: int = 384):
        super().__init__()
        self.proj = nn.Linear(d_model, embed_dim, bias=False)
        self.norm = nn.LayerNorm(embed_dim)

    def forward(self, hidden_states: torch.Tensor, attention_mask: torch.Tensor = None) -> torch.Tensor:
        if attention_mask is not None:
            mask = attention_mask.unsqueeze(-1).float()
            pooled = (hidden_states * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1e-9)
        else:
            pooled = hidden_states.mean(dim=1)
        projected = self.proj(pooled)
        normed = self.norm(projected)
        return F.normalize(normed, p=2, dim=-1)


class ProverbsEmbedder:
    def __init__(self, lm: ProverbsLM, embed_dim: int = 384, device: str = None):
        self.device = device or _best_device()
        self.embed_dim = embed_dim

        self.token_embed = lm.token_embed
        self.layers = lm.layers
        self.backbone_norm = lm.norm

        for p in self.token_embed.parameters():
            p.requires_grad_(False)
        for p in self.layers.parameters():
            p.requires_grad_(False)
        for p in self.backbone_norm.parameters():
            p.requires_grad_(False)

        self.head = EmbeddingHead(lm.cfg.d_model, embed_dim).to(self.device)

    @torch.inference_mode()
    def encode(self, texts: list[str], tokenizer, batch_size: int = 32,
               normalize: bool = True) -> np.ndarray:
        all_embeddings = []
        dtype = next(self.token_embed.parameters()).dtype

        for start in range(0, len(texts), batch_size):
            batch_texts = texts[start: start + batch_size]

            encoded = [tokenizer.encode(t, add_bos=True)[:256] for t in batch_texts]
            max_len = max(len(ids) for ids in encoded)
            padded = [ids + [0] * (max_len - len(ids)) for ids in encoded]
            masks = [[1] * len(ids) + [0] * (max_len - len(ids)) for ids in encoded]

            input_ids = torch.tensor(padded, dtype=torch.long, device=self.device)
            attention_mask = torch.tensor(masks, dtype=torch.float, device=self.device)

            x = self.token_embed(input_ids).to(dtype)

            for layer in self.layers:
                x, _, _ = layer(x, mask=None, kv_cache=None)

            x = self.backbone_norm(x)
            embeddings = self.head(x, attention_mask)

            if not normalize:
                embeddings = embeddings  # head already L2-normalizes; skip nothing
            all_embeddings.append(embeddings.float().cpu().numpy())

        return np.concatenate(all_embeddings, axis=0)

    def save(self, path: str):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        torch.save({"head": self.head.state_dict(), "embed_dim": self.embed_dim}, path)

    def load_head(self, path: str):
        checkpoint = torch.load(path, map_location=self.device, weights_only=False)
        self.embed_dim = checkpoint["embed_dim"]
        self.head.load_state_dict(checkpoint["head"])


def load_embedder(lm_path: str, head_path: str = None, device: str = None) -> ProverbsEmbedder:
    device = device or _best_device()
    lm = ProverbsLM.load(lm_path, device=device)
    embedder = ProverbsEmbedder(lm, device=device)
    if head_path and Path(head_path).exists():
        embedder.load_head(head_path)
    return embedder


embedder: ProverbsEmbedder | None = None
