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
