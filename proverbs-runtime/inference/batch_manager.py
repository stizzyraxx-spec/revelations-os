"""
ContinuousBatchManager — concurrent request scheduling for ProverbsLM.

Instead of processing requests serially, a pool of in-flight RequestSlots
share the event loop.  Each iteration of the run loop:
  1. Fills empty slots from the waiting queue.
  2. Prefills any slot that has not yet run a forward pass (kv_cache is None).
  3. Runs one decode step per active slot (one-at-a-time when KV lengths
     differ; see TODO below) and resolves Futures for finished slots.

The result is that I/O-bound callers (network, tool calls, post-processing)
overlap with inference, and head-of-line blocking from a single long request
is significantly reduced.
"""

from __future__ import annotations

import asyncio
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import torch
import torch.nn.functional as F

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from model.proverbs_lm import ProverbsLM
from tokenizer.bpe import ProverbsTokenizer
from inference.prefix_cache import PrefixCache, get_cache


def _auto_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _sample(logits: torch.Tensor, temperature: float, top_p: float) -> int:
    """Sample one token id from a 1-D logits tensor."""
    if temperature == 0.0:
        return int(torch.argmax(logits).item())

    logits = logits / temperature

    if top_p < 1.0:
        sorted_logits, sorted_indices = torch.sort(logits, descending=True)
        sorted_probs = F.softmax(sorted_logits, dim=-1)
        cum_probs = torch.cumsum(sorted_probs, dim=-1)
        remove = cum_probs - sorted_probs > top_p
        remove[0] = False
        logits[sorted_indices[remove]] = float("-inf")

    probs = F.softmax(logits, dim=-1)
    return int(torch.multinomial(probs, num_samples=1).item())


@dataclass
class RequestSlot:
    id: str
    prompt_ids: list
    generated_ids: list
    kv_cache: Optional[list]
    max_new_tokens: int
    temperature: float
    top_p: float
    done: bool = False
    result_future: asyncio.Future = field(default=None)  # type: ignore[assignment]


class ContinuousBatchManager:
    def __init__(
        self,
        model: ProverbsLM,
        tokenizer: ProverbsTokenizer,
        max_batch_size: int = 8,
        device: str = None,
        prefix_cache: PrefixCache | None = None,
    ) -> None:
        self.model = model.eval()
        self.tokenizer = tokenizer
        self.max_batch_size = max_batch_size
        self.device = device or _auto_device()
        self.model = self.model.to(self.device)

        self.active: list[RequestSlot] = []
        self.waiting: asyncio.Queue = asyncio.Queue()
        self.running: bool = False
        self.prefix_cache: PrefixCache = prefix_cache or get_cache()

        self._eos_id: int = model.cfg.eos_token_id

    async def submit(
        self,
        prompt: str | list,
        max_new_tokens: int = 512,
        temperature: float = 0.7,
        top_p: float = 0.9,
    ) -> str:
        if isinstance(prompt, list):
            prompt_ids = self.tokenizer.encode_chat(prompt)
        else:
            prompt_ids = self.tokenizer.encode(prompt, add_bos=True)

        if not prompt_ids:
            prompt_ids = [self.model.cfg.bos_token_id]

        loop = asyncio.get_event_loop()
        future: asyncio.Future = loop.create_future()

        slot = RequestSlot(
            id=uuid.uuid4().hex,
            prompt_ids=prompt_ids,
            generated_ids=[],
            kv_cache=None,
            max_new_tokens=max_new_tokens,
            temperature=temperature,
            top_p=top_p,
            result_future=future,
        )
        await self.waiting.put(slot)
        return await future

    @torch.inference_mode()
    def _prefill(self, slot: RequestSlot) -> None:
        """Run prefill, reusing a cached KV prefix when available."""
        cached_kv, matched_len = self.prefix_cache.lookup(slot.prompt_ids)

        full_hit = cached_kv is not None and matched_len == len(slot.prompt_ids)
        if full_hit:
            # Exact hit: the KV is fully cached but we still need the last
            # token's logits to sample from, so re-run just that token on
            # top of the cache trimmed by one position.
            matched_len -= 1
            cached_kv = [
                (kv[0][:, :, :matched_len, :], kv[1][:, :, :matched_len, :])
                if kv is not None else None
                for kv in cached_kv
            ]

        if cached_kv is not None and matched_len < len(slot.prompt_ids):
            # Cache hit: run only the suffix tokens on top of the cached KV.
            suffix_ids = slot.prompt_ids[matched_len:]
            inp = torch.tensor([suffix_ids], dtype=torch.long, device=self.device)
            kv_on_dev = [
                (kv[0].to(self.device), kv[1].to(self.device)) if kv is not None else None
                for kv in cached_kv
            ]
            out = self.model(inp, kv_caches=kv_on_dev)
        else:
            # Full prefill — no usable cache entry.
            inp = torch.tensor([slot.prompt_ids], dtype=torch.long, device=self.device)
            out = self.model(inp, kv_caches=None)

        slot.kv_cache = out["kv_caches"]
        # Cache the full prompt KV for future requests (skip if already stored).
        if not full_hit:
            self.prefix_cache.store(slot.prompt_ids, slot.kv_cache)

        logits = out["logits"][0, -1, :]
        next_tok = _sample(logits, slot.temperature, slot.top_p)
        slot.generated_ids.append(next_tok)
        if next_tok == self._eos_id or len(slot.generated_ids) >= slot.max_new_tokens:
            slot.done = True

    @torch.inference_mode()
    def _decode_step(self, slot: RequestSlot) -> None:
        """Run one decode step for a single slot and append the sampled token."""
        last_tok = slot.generated_ids[-1]
        inp = torch.tensor([[last_tok]], dtype=torch.long, device=self.device)

        # Slide the KV window if we have hit the context limit.
        if (len(slot.prompt_ids) + len(slot.generated_ids)) >= self.model.cfg.max_seq_len:
            slot.kv_cache = [
                (kv[0][:, :, 1:, :], kv[1][:, :, 1:, :]) if kv is not None else None
                for kv in slot.kv_cache
            ]

        out = self.model(inp, kv_caches=slot.kv_cache)
        slot.kv_cache = out["kv_caches"]
        logits = out["logits"][0, -1, :]
        next_tok = _sample(logits, slot.temperature, slot.top_p)
        slot.generated_ids.append(next_tok)
        if next_tok == self._eos_id or len(slot.generated_ids) >= slot.max_new_tokens:
            slot.done = True

    @torch.inference_mode()
    def _decode_step_batched(self, slots: list) -> None:
        """Run one decode step for multiple slots in a single batched forward pass.

        KV caches are right-padded to a common length and an additive attention
        mask is passed so padded positions are invisible to each query.  After
        the forward, each slot's KV cache is reconstructed by concatenating its
        valid prefix with the newly generated key/value (discarding the padding).
        """
        cfg = self.model.cfg

        # Slide KV window per-slot before measuring lengths.
        for slot in slots:
            if (len(slot.prompt_ids) + len(slot.generated_ids)) >= cfg.max_seq_len:
                slot.kv_cache = [
                    (kv[0][:, :, 1:, :], kv[1][:, :, 1:, :]) if kv is not None else None
                    for kv in slot.kv_cache
                ]

        kv_lens   = [slot.kv_cache[0][0].shape[2] for slot in slots]
        max_kv    = max(kv_lens)
        n_layers  = len(slots[0].kv_cache)
        B         = len(slots)

        # Stack KV caches per layer with right-padding to max_kv.
        batched_kv = []
        for layer_i in range(n_layers):
            k_list, v_list = [], []
            for slot in slots:
                k, v = slot.kv_cache[layer_i]        # [1, n_kv_heads, kv_len, head_dim]
                pad = max_kv - k.shape[2]
                if pad > 0:
                    k = F.pad(k, (0, 0, 0, pad))
                    v = F.pad(v, (0, 0, 0, pad))
                k_list.append(k)
                v_list.append(v)
            batched_kv.append((torch.cat(k_list, dim=0), torch.cat(v_list, dim=0)))

        # Input: last generated token per slot → [B, 1]
        inp = torch.tensor(
            [[s.generated_ids[-1]] for s in slots],
            dtype=torch.long, device=self.device,
        )

        # Additive attention mask [B, 1, 1, max_kv + 1].
        # After appending the new token inside attention the full KV length is max_kv+1.
        # Padded positions [kv_len[b], max_kv) get -inf; real + new positions get 0.
        dtype = self.model.token_embed.weight.dtype
        decode_attn_mask = torch.zeros(B, 1, 1, max_kv + 1, dtype=dtype, device=self.device)
        for b, kv_len in enumerate(kv_lens):
            if kv_len < max_kv:
                decode_attn_mask[b, 0, 0, kv_len:max_kv] = float("-inf")

        # Per-slot absolute positions: each new token sits at its own cache
        # length, not at the padded max_kv.
        position_ids = torch.tensor(
            [[kv_len] for kv_len in kv_lens], dtype=torch.long, device=self.device
        )

        out         = self.model(inp, kv_caches=batched_kv, decode_attn_mask=decode_attn_mask,
                                 position_ids=position_ids)
        new_kvs     = out["kv_caches"]   # list of (k, v) each [B, n_kv_heads, max_kv+1, head_dim]
        logits_all  = out["logits"]      # [B, 1, vocab_size]

        for b, slot in enumerate(slots):
            # Reconstruct this slot's KV: real prefix + newly appended entry (at index max_kv).
            # Discard the padded zeros at [kv_lens[b], max_kv).
            real_len = kv_lens[b]
            slot.kv_cache = [
                (
                    torch.cat([new_kvs[li][0][b:b+1, :, :real_len, :],
                               new_kvs[li][0][b:b+1, :, max_kv:,   :]], dim=2),
                    torch.cat([new_kvs[li][1][b:b+1, :, :real_len, :],
                               new_kvs[li][1][b:b+1, :, max_kv:,   :]], dim=2),
                )
                for li in range(n_layers)
            ]
            next_tok = _sample(logits_all[b, -1, :], slot.temperature, slot.top_p)
            slot.generated_ids.append(next_tok)
            if next_tok == self._eos_id or len(slot.generated_ids) >= slot.max_new_tokens:
                slot.done = True

    def _resolve(self, slot: RequestSlot) -> None:
        """Decode generated ids and resolve the caller's Future."""
        # Strip trailing EOS if present.
        ids = slot.generated_ids
        if ids and ids[-1] == self._eos_id:
            ids = ids[:-1]
        text = self.tokenizer.decode(ids, skip_special=True)
        if not slot.result_future.done():
            slot.result_future.set_result(text)

    async def _run_loop(self) -> None:
        while self.running:
            # Fill empty slots from the waiting queue.
            while len(self.active) < self.max_batch_size:
                try:
                    slot = self.waiting.get_nowait()
                    self.active.append(slot)
                except asyncio.QueueEmpty:
                    break

            if not self.active:
                await asyncio.sleep(0.001)
                continue

            loop = asyncio.get_event_loop()

            # Prefill slots individually (different prompt lengths make true batching complex).
            prefill_slots = [s for s in self.active if s.kv_cache is None]
            decode_slots  = [s for s in self.active if s.kv_cache is not None]

            for slot in prefill_slots:
                await loop.run_in_executor(None, self._prefill, slot)

            # Batch all decode slots into one forward pass when possible.
            # Linear attention uses a different state format and falls back to serial.
            can_batch = (
                len(decode_slots) > 1
                and getattr(self.model.cfg, "attention_type", "default") != "linear"
            )
            if can_batch:
                await loop.run_in_executor(None, self._decode_step_batched, decode_slots)
            else:
                for slot in decode_slots:
                    await loop.run_in_executor(None, self._decode_step, slot)

            # Resolve and evict finished slots.
            still_active = []
            for slot in self.active:
                if slot.done:
                    self._resolve(slot)
                else:
                    still_active.append(slot)
            self.active = still_active

    async def start(self) -> None:
        self.running = True
        asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        self.running = False


# ---------------------------------------------------------------------------
# Demo
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="ContinuousBatchManager async demo")
    parser.add_argument("--model", required=True, help="Path to .pt checkpoint")
    parser.add_argument("--tokenizer", default="~/.proverbs/tokenizer.json")
    parser.add_argument("--device", default=None)
    args = parser.parse_args()

    async def main() -> None:
        import os

        print(f"Loading model: {args.model}")
        lm = ProverbsLM.load(args.model, device=args.device)
        tok_path = os.path.expanduser(args.tokenizer)
        tokenizer = ProverbsTokenizer.load(tok_path)

        manager = ContinuousBatchManager(
            model=lm,
            tokenizer=tokenizer,
            max_batch_size=8,
            device=args.device,
        )
        await manager.start()

        prompts = [
            "The early bird",
            "A stitch in time",
            "Actions speak louder",
            "Every cloud has",
        ]

        tasks = [
            asyncio.create_task(
                manager.submit(p, max_new_tokens=64, temperature=0.8, top_p=0.9)
            )
            for p in prompts
        ]

        results = await asyncio.gather(*tasks)
        await manager.stop()

        for prompt, result in zip(prompts, results):
            print(f"\nPrompt : {prompt!r}")
            print(f"Output : {result!r}")

    asyncio.run(main())
