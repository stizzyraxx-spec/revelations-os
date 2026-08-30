"""
ab_testing.py — A/B test two ProverbsLM versions, auto-promoting the challenger
when it outperforms the control by a statistically meaningful margin.
"""

from __future__ import annotations

import json
import logging
import random
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

log = logging.getLogger("proverbs.ab_testing")

_AB_LOG = Path.home() / ".proverbs" / "ab_test_log.jsonl"


# ---------------------------------------------------------------------------
# Config / result dataclasses
# ---------------------------------------------------------------------------


@dataclass
class ABTestConfig:
    challenger_path: str
    challenger_fraction: float = 0.2
    min_samples: int = 50
    auto_promote: bool = True


@dataclass
class ABTestResult:
    version: str
    positive_signals: int = 0
    negative_signals: int = 0
    total_requests: int = 0

    @property
    def win_rate(self) -> float:
        scored = self.positive_signals + self.negative_signals
        if scored == 0:
            return 0.0
        return self.positive_signals / scored


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


class ABTestEngine:
    def __init__(
        self,
        control_generator,
        config: Optional[ABTestConfig] = None,
    ) -> None:
        self.control = control_generator
        self.challenger = None
        self.results: dict[str, ABTestResult] = {
            "control":    ABTestResult("control"),
            "challenger": ABTestResult("challenger"),
        }
        self.config = config
        self._request_count: int = 0
        self._last_version: dict[str, str] = {}

    # ------------------------------------------------------------------
    # Challenger management
    # ------------------------------------------------------------------

    def load_challenger(self, path: str, tokenizer_path: str) -> None:
        """Load a second ProverbsLM + ProverbsGenerator from *path*."""
        from model.proverbs_lm import ProverbsLM
        from inference.generate import ProverbsGenerator

        device = getattr(self.control, "device", "cpu")
        lm = ProverbsLM.load(path, device=device)
        lm.eval()
        self.challenger = ProverbsGenerator(
            model=lm, tokenizer_path=tokenizer_path, device=device
        )
        log.info("Challenger loaded from %s", path)

    # ------------------------------------------------------------------
    # Routing
    # ------------------------------------------------------------------

    def route(self, request_id: str) -> tuple:
        """Return (generator, version_str) for the given request."""
        self._request_count += 1

        if self.challenger is None or self.config is None:
            self._last_version[request_id] = "control"
            return (self.control, "control")

        if random.random() < self.config.challenger_fraction:
            version = "challenger"
            gen = self.challenger
        else:
            version = "control"
            gen = self.control

        self._last_version[request_id] = version
        self.results[version].total_requests += 1
        return (gen, version)

    # ------------------------------------------------------------------
    # Signal recording
    # ------------------------------------------------------------------

    def record_signal(self, request_id: str, positive: bool) -> None:
        """Increment quality counters; auto-promote if thresholds are met."""
        version = self._last_version.pop(request_id, None)
        if version is None:
            log.debug("record_signal: unknown request_id %s", request_id)
            return

        result = self.results[version]
        if positive:
            result.positive_signals += 1
        else:
            result.negative_signals += 1

        if self.config is None or not self.config.auto_promote:
            return

        ctrl = self.results["control"]
        chal = self.results["challenger"]
        ctrl_scored = ctrl.positive_signals + ctrl.negative_signals
        chal_scored = chal.positive_signals + chal.negative_signals

        if (
            ctrl_scored >= self.config.min_samples
            and chal_scored >= self.config.min_samples
            and chal.win_rate > ctrl.win_rate + 0.05
        ):
            self.promote()

    # ------------------------------------------------------------------
    # Promotion
    # ------------------------------------------------------------------

    def promote(self) -> None:
        """Swap challenger into the control position and reset counters."""
        if self.challenger is None:
            return

        log.info(
            "Promoting challenger (win_rate=%.3f) over control (win_rate=%.3f)",
            self.results["challenger"].win_rate,
            self.results["control"].win_rate,
        )

        _AB_LOG.parent.mkdir(parents=True, exist_ok=True)
        event = {
            "event": "promotion",
            "control_win_rate":    self.results["control"].win_rate,
            "challenger_win_rate": self.results["challenger"].win_rate,
            "control_requests":    self.results["control"].total_requests,
            "challenger_requests": self.results["challenger"].total_requests,
            "challenger_path":     self.config.challenger_path if self.config else "",
        }
        with _AB_LOG.open("a") as fh:
            fh.write(json.dumps(event) + "\n")

        self.control = self.challenger
        self.challenger = None
        self.results = {
            "control":    ABTestResult("control"),
            "challenger": ABTestResult("challenger"),
        }
        self._last_version.clear()

    # ------------------------------------------------------------------
    # Observability
    # ------------------------------------------------------------------

    def stats(self) -> dict:
        return {
            version: {
                "positive_signals": r.positive_signals,
                "negative_signals": r.negative_signals,
                "total_requests":   r.total_requests,
                "win_rate":         r.win_rate,
            }
            for version, r in self.results.items()
        }


# ---------------------------------------------------------------------------
# Module-level singleton (set by inference/server.py at startup)
# ---------------------------------------------------------------------------

ab_engine: Optional[ABTestEngine] = None
