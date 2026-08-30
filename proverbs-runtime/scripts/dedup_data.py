"""MinHash LSH deduplication for Proverbs training data."""

import argparse
import hashlib
import json
import os
import random
import struct
from pathlib import Path

BIG_PRIME = (1 << 61) - 1  # Mersenne prime


def shingles(text: str, k: int = 5) -> set[str]:
    return {text[i:i + k] for i in range(len(text) - k + 1)}


def minhash(shingle_set: set, n_hashes: int = 128) -> list[int]:
    rng = random.Random(42)
    params = [(rng.randint(1, BIG_PRIME - 1), rng.randint(0, BIG_PRIME - 1)) for _ in range(n_hashes)]
    signature = [BIG_PRIME] * n_hashes
    for s in shingle_set:
        h = struct.unpack("<Q", hashlib.sha256(s.encode()).digest()[:8])[0]
        for i, (a, b) in enumerate(params):
            v = (a * h + b) % BIG_PRIME
            if v < signature[i]:
                signature[i] = v
    return signature


class LSHIndex:
    def __init__(self, n_hashes: int = 128, n_bands: int = 16, threshold: float = 0.8):
        self.n_hashes = n_hashes
        self.n_bands = n_bands
        self.n_rows = n_hashes // n_bands
        self.threshold = threshold
        self.buckets: dict[tuple, list[int]] = {}
        self.signatures: dict[int, list[int]] = {}

    def add(self, doc_id: int, signature: list[int]) -> None:
        self.signatures[doc_id] = signature
        for band in range(self.n_bands):
            start = band * self.n_rows
            band_slice = tuple(signature[start:start + self.n_rows])
            key = (band, band_slice)
            self.buckets.setdefault(key, []).append(doc_id)

    def is_duplicate(self, signature: list[int]) -> bool:
        candidates: set[int] = set()
        for band in range(self.n_bands):
            start = band * self.n_rows
            band_slice = tuple(signature[start:start + self.n_rows])
            key = (band, band_slice)
            for doc_id in self.buckets.get(key, []):
                candidates.add(doc_id)
        for doc_id in candidates:
            other = self.signatures[doc_id]
            matches = sum(a == b for a, b in zip(signature, other))
            if matches / self.n_hashes >= self.threshold:
                return True
        return False


def dedup_jsonl_dir(data_dir: str, output_dir: str = None, threshold: float = 0.8) -> dict:
    data_path = Path(data_dir)
    if output_dir is None:
        out_path = data_path.parent / (data_path.name + "_deduped")
    else:
        out_path = Path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    index = LSHIndex(threshold=threshold)
    total = 0
    kept = 0
    removed = 0
    doc_id = 0

    for jsonl_file in sorted(data_path.glob("*.jsonl")):
        out_file = out_path / jsonl_file.name
        kept_lines = []
        with open(jsonl_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                total += 1
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                text = record.get("text", "") or record.get("content", "") or ""
                if not text:
                    kept += 1
                    kept_lines.append(line)
                    continue
                sg = shingles(text)
                if not sg:
                    kept += 1
                    kept_lines.append(line)
                    continue
                sig = minhash(sg)
                if index.is_duplicate(sig):
                    removed += 1
                else:
                    index.add(doc_id, sig)
                    doc_id += 1
                    kept += 1
                    kept_lines.append(line)
        with open(out_file, "w", encoding="utf-8") as f:
            f.write("\n".join(kept_lines))
            if kept_lines:
                f.write("\n")

    removal_rate = removed / total if total > 0 else 0.0
    return {"total": total, "kept": kept, "removed": removed, "removal_rate": removal_rate}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="MinHash LSH deduplication for training data")
    parser.add_argument("--data-dir", required=True, help="Directory containing *.jsonl files")
    parser.add_argument("--output-dir", default=None, help="Output directory (default: data_dir + '_deduped')")
    parser.add_argument("--threshold", type=float, default=0.8, help="Jaccard similarity threshold (default: 0.8)")
    parser.add_argument("--dry-run", action="store_true", help="Report stats without writing output")
    args = parser.parse_args()

    if args.dry_run:
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            stats = dedup_jsonl_dir(args.data_dir, output_dir=tmp, threshold=args.threshold)
        print(json.dumps(stats, indent=2))
    else:
        stats = dedup_jsonl_dir(args.data_dir, output_dir=args.output_dir, threshold=args.threshold)
        print(json.dumps(stats, indent=2))
