"""
logic/prompt_optimizer.py — Automatically select the best system prompt variant.

Tracks per-variant scores in a JSONL history file and uses an epsilon-greedy
(10 % exploration) strategy to converge on the highest-performing prompt variant.

Usage:
    from logic.prompt_optimizer import prompt_optimizer

    messages = [{"role": "user", "content": "hello"}]
    messages.insert(0, {"role": "system", "content": prompt_optimizer.get_prompt()})
    # … after evaluating the response …
    prompt_optimizer.record_score(0.87)
    prompt_optimizer.optimize()
"""

from __future__ import annotations

import json
import random
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Prompt variants
# ---------------------------------------------------------------------------

PROMPT_VARIANTS: list[str] = [
    # 0 — concise code
    (
        "You are a coding assistant. Respond with the shortest, most direct code "
        "that solves the problem. Omit prose unless the user explicitly asks for "
        "an explanation. Prefer one-liners and built-ins over verbose loops. No "
        "filler sentences."
    ),

    # 1 — verbose explanations
    (
        "You are a coding assistant and patient teacher. For every code snippet "
        "you write, precede it with a plain-English explanation of the algorithm "
        "or design decision, and follow it with a walkthrough of the key lines. "
        "Use numbered steps and sub-bullets to make the logic easy to follow."
    ),

    # 2 — security focus
    (
        "You are a security-conscious coding assistant. Before writing any code, "
        "identify relevant threat vectors (injection, auth bypass, SSRF, path "
        "traversal, insecure deserialization, etc.). Sanitize all inputs, use "
        "parameterized queries, apply least-privilege principles, and call out "
        "any dependency that has known CVEs. Flag risky patterns with # SECURITY "
        "comments."
    ),

    # 3 — testing focus
    (
        "You are a test-driven coding assistant. Write the failing test first, "
        "then the minimal implementation that makes it pass, then refactor. Use "
        "pytest conventions. Cover happy paths, edge cases, and expected "
        "exceptions. Include property-based test sketches with hypothesis where "
        "applicable. Aim for ≥ 90 % branch coverage."
    ),

    # 4 — documentation focus
    (
        "You are a documentation-first coding assistant. Every function, class, "
        "and module you produce must have a complete docstring: summary line, "
        "Args section, Returns section, Raises section (if applicable), and at "
        "least one usage Example. Follow NumPy or Google docstring style "
        "consistently. Include inline comments for non-obvious logic."
    ),

    # 5 — performance focus
    (
        "You are a performance-oriented coding assistant. Analyse algorithmic "
        "complexity before writing code and state it in a comment (e.g. "
        "# O(n log n) time, O(1) space). Prefer vectorised operations (NumPy, "
        "PyTorch) over Python loops. Avoid unnecessary allocations. Profile "
        "hotspots and suggest caching, lazy evaluation, or C-extension "
        "alternatives when the naive solution is too slow."
    ),

    # 6 — beginner-friendly
    (
        "You are a friendly coding mentor helping someone who is new to "
        "programming. Use simple vocabulary, avoid jargon (or define it on first "
        "use), keep code examples short, and celebrate small wins. Break every "
        "solution into small, digestible steps. Suggest beginner-friendly "
        "resources (docs, tutorials) when relevant. Never make the learner feel "
        "overwhelmed."
    ),

    # 7 — expert-dense
    (
        "You are a senior staff engineer. Communicate at a high technical "
        "altitude: discuss trade-offs between design patterns, reference PEPs, "
        "RFCs, or academic papers when relevant, and assume fluency with "
        "concurrency primitives, type theory, compiler behaviour, and distributed "
        "systems concepts. Skip introductory caveats. Surface non-obvious "
        "failure modes and second-order effects in your analysis."
    ),
]

# ---------------------------------------------------------------------------
# Optimizer
# ---------------------------------------------------------------------------


class PromptOptimizer:
    """Epsilon-greedy prompt variant selector backed by a JSONL history file.

    Each entry written to *history_file* has the form::

        {"idx": 3, "score": 0.91, "ts": 1717420800.0}

    The ``optimize()`` method reads the last *window* entries, computes the
    mean score per variant, and picks the best-performing one — except with
    10 % probability it picks a random variant (exploration).
    """

    def __init__(
        self,
        history_file: str = "~/.proverbs/prompt_opt_history.jsonl",
    ) -> None:
        self.history_path: Path = Path(history_file).expanduser()
        self.history_path.parent.mkdir(parents=True, exist_ok=True)
        self.current_prompt_idx: int = 0
        self._load_history()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _load_history(self) -> None:
        """Set current_prompt_idx from the last recorded index in the file."""
        if not self.history_path.exists():
            return
        last_idx: int | None = None
        try:
            with self.history_path.open(encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                        idx = entry.get("idx")
                        if isinstance(idx, int) and 0 <= idx < len(PROMPT_VARIANTS):
                            last_idx = idx
                    except (json.JSONDecodeError, ValueError):
                        continue
        except OSError:
            return
        if last_idx is not None:
            self.current_prompt_idx = last_idx

    def _read_window(self, window: int) -> list[dict]:
        """Return up to the last *window* valid history entries."""
        if not self.history_path.exists():
            return []
        entries: list[dict] = []
        try:
            with self.history_path.open(encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                        if "idx" in entry and "score" in entry:
                            entries.append(entry)
                    except (json.JSONDecodeError, ValueError):
                        continue
        except OSError:
            return []
        return entries[-window:]

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get_prompt(self) -> str:
        """Return the system prompt string for the current variant."""
        return PROMPT_VARIANTS[self.current_prompt_idx]

    def record_score(self, score: float) -> None:
        """Append a score entry for the current variant to the history file."""
        entry = {
            "idx": self.current_prompt_idx,
            "score": float(score),
            "ts": time.time(),
        }
        with self.history_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")

    def optimize(self, window: int = 10) -> int:
        """Select the next prompt variant and return its index.

        Strategy (epsilon-greedy, ε = 0.10):
        - With 10 % probability: explore by picking a random variant.
        - Otherwise: exploit by picking the variant with the highest mean
          score over the last *window* recorded entries.  Variants with no
          history are treated as having a mean score of 0.0.

        Updates ``self.current_prompt_idx`` and returns the new index.
        """
        recent = self._read_window(window)

        # Accumulate scores per variant.
        totals: dict[int, float] = {}
        counts: dict[int, int] = {}
        for entry in recent:
            idx = entry["idx"]
            if not isinstance(idx, int) or not (0 <= idx < len(PROMPT_VARIANTS)):
                continue
            totals[idx] = totals.get(idx, 0.0) + float(entry["score"])
            counts[idx] = counts.get(idx, 0) + 1

        means: dict[int, float] = {
            idx: totals[idx] / counts[idx] for idx in totals
        }

        if random.random() < 0.10:
            # Exploration: pick a random variant.
            chosen = random.randrange(len(PROMPT_VARIANTS))
        else:
            # Exploitation: pick variant with highest mean (default 0.0).
            chosen = max(
                range(len(PROMPT_VARIANTS)),
                key=lambda i: means.get(i, 0.0),
            )

        self.current_prompt_idx = chosen
        return chosen

    def status(self) -> dict:
        """Return a status snapshot for monitoring or debugging.

        Keys
        ----
        current_idx : int
            Index of the active prompt variant.
        preview : str
            First 120 characters of the active prompt.
        mean_scores : dict[int, float]
            Mean score per variant across all recorded history.
        n_evaluations : int
            Total number of scored entries in the history file.
        """
        all_entries = self._read_window(window=10_000)  # effectively all

        totals: dict[int, float] = {}
        counts: dict[int, int] = {}
        for entry in all_entries:
            idx = entry.get("idx")
            if not isinstance(idx, int) or not (0 <= idx < len(PROMPT_VARIANTS)):
                continue
            score = entry.get("score")
            if not isinstance(score, (int, float)):
                continue
            totals[idx] = totals.get(idx, 0.0) + float(score)
            counts[idx] = counts.get(idx, 0) + 1

        mean_scores: dict[int, float] = {
            idx: totals[idx] / counts[idx] for idx in totals
        }

        preview = PROMPT_VARIANTS[self.current_prompt_idx][:120]

        return {
            "current_idx": self.current_prompt_idx,
            "preview": preview,
            "mean_scores": mean_scores,
            "n_evaluations": len(all_entries),
        }


# ---------------------------------------------------------------------------
# Global instance
# ---------------------------------------------------------------------------

prompt_optimizer = PromptOptimizer()
