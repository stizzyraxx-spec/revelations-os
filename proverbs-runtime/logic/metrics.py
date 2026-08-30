"""
Lightweight metrics collector for Proverbs LLM.

Appends JSON lines to ~/.proverbs/metrics.jsonl for generation, training,
and benchmark events.  Exposes a summary() method for the /v1/metrics/summary
endpoint in inference/server.py.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any


class MetricsCollector:
    def __init__(self, metrics_file: str = "~/.proverbs/metrics.jsonl") -> None:
        self._path = Path(metrics_file).expanduser()
        self._path.parent.mkdir(parents=True, exist_ok=True)

    def _append(self, record: dict) -> None:
        with self._path.open("a") as fh:
            fh.write(json.dumps(record) + "\n")

    def record_generation(
        self,
        tokens_generated: int,
        duration_ms: float,
        model: str,
        entropy: float | None = None,
        cached: bool = False,
    ) -> None:
        tok_per_sec = (tokens_generated / duration_ms * 1000.0) if duration_ms > 0 else 0.0
        record: dict[str, Any] = {
            "ts": time.time(),
            "type": "generation",
            "tokens": tokens_generated,
            "duration_ms": duration_ms,
            "tok_per_sec": tok_per_sec,
            "model": model,
            "cached": cached,
        }
        if entropy is not None:
            record["entropy"] = entropy
        self._append(record)

    def record_training(
        self,
        step: int,
        loss: float,
        lr: float,
        tok_per_sec: float,
    ) -> None:
        self._append({
            "ts": time.time(),
            "type": "training",
            "step": step,
            "loss": loss,
            "lr": lr,
            "tok_per_sec": tok_per_sec,
        })

    def record_benchmark(self, score: dict) -> None:
        self._append({"ts": time.time(), "type": "benchmark", **score})

    def summary(self, last_n: int = 100) -> dict:
        if not self._path.exists():
            return {
                "avg_tok_per_sec": 0.0,
                "avg_latency_ms": 0.0,
                "cache_hit_rate": 0.0,
                "total_tokens": 0,
                "avg_entropy": None,
                "requests_per_hour": 0.0,
                "recent_tok_per_sec": [],
                "training_loss": [],
            }

        lines: list[str] = self._path.read_text().splitlines()
        tail = lines[-last_n:] if len(lines) > last_n else lines

        gen_records: list[dict] = []
        training_records: list[dict] = []

        for line in tail:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = rec.get("type", "generation")
            if t == "generation":
                gen_records.append(rec)
            elif t == "training":
                training_records.append(rec)

        # Generation stats
        total_tokens = sum(r.get("tokens", 0) for r in gen_records)
        latencies = [r["duration_ms"] for r in gen_records if "duration_ms" in r]
        tps_values = [r["tok_per_sec"] for r in gen_records if "tok_per_sec" in r]
        entropies = [r["entropy"] for r in gen_records if r.get("entropy") is not None]
        cached_count = sum(1 for r in gen_records if r.get("cached"))

        avg_latency = sum(latencies) / len(latencies) if latencies else 0.0
        avg_tps = sum(tps_values) / len(tps_values) if tps_values else 0.0
        cache_hit_rate = cached_count / len(gen_records) if gen_records else 0.0
        avg_entropy = sum(entropies) / len(entropies) if entropies else None

        # Requests per hour from timestamps in this window
        ts_values = [r["ts"] for r in gen_records if "ts" in r]
        if len(ts_values) >= 2:
            span_hours = (max(ts_values) - min(ts_values)) / 3600.0
            requests_per_hour = len(ts_values) / span_hours if span_hours > 0 else 0.0
        else:
            requests_per_hour = 0.0

        # Sparkline data: last 30 tok/sec values
        recent_tok_per_sec = tps_values[-30:]

        # Training loss history: last 50 steps
        training_loss = [
            {"step": r["step"], "loss": r["loss"]}
            for r in training_records[-50:]
            if "step" in r and "loss" in r
        ]

        return {
            "avg_tok_per_sec": round(avg_tps, 2),
            "avg_latency_ms": round(avg_latency, 2),
            "cache_hit_rate": round(cache_hit_rate, 4),
            "total_tokens": total_tokens,
            "avg_entropy": round(avg_entropy, 4) if avg_entropy is not None else None,
            "requests_per_hour": round(requests_per_hour, 2),
            "recent_tok_per_sec": [round(v, 2) for v in recent_tok_per_sec],
            "training_loss": training_loss,
        }


metrics = MetricsCollector()
