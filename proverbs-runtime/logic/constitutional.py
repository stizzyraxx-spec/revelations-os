"""
constitutional.py — Constitutional AI self-critique and revision for Proverbs LLM.

After generation, critiques the response against sampled principles, revises it,
and saves the (original, critique, revision) triplet as a DPO training pair.
"""

from __future__ import annotations

import json
import os
import random
import sys
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from logic.self_learn import QUALITY_DIR  # noqa: E402

CONSTITUTION: list[str] = [
    "The response should contain correct, runnable code with no syntax errors.",
    "The response should directly answer what was asked without unnecessary preamble.",
    "Code examples should include the function signature and a brief usage example.",
    "The response should not hallucinate library functions that do not exist.",
    "If the question asks to fix a bug, the response must identify the bug before fixing it.",
    "The response should handle edge cases (empty input, None, zero, negative numbers).",
    "The response should use clear variable names and avoid magic numbers.",
    "The response should not include unnecessary imports or unused variables.",
    "If multiple approaches exist, the response should explain the trade-offs briefly.",
    "The response should match the programming language or framework mentioned in the question.",
    "The response should not truncate code examples mid-function or leave placeholders like '...'.",
    "The response should be concise — no repeated explanations or restating the question.",
]


class ConstitutionalAI:
    def __init__(self, generator, n_principles: int = 3) -> None:
        self.generator = generator
        self.n_principles = n_principles

    def critique(self, prompt: str, response: str) -> str:
        principles = random.sample(CONSTITUTION, min(self.n_principles, len(CONSTITUTION)))
        principles_text = "\n".join(f"- {p}" for p in principles)
        critique_prompt = (
            f"Given the question and response below, identify specific ways "
            f"the response violates these principles:\n{principles_text}\n\n"
            f"Question: {prompt}\nResponse: {response}\n\nCritique:"
        )
        return self.generator.generate(
            critique_prompt, max_new_tokens=200, temperature=0.7
        )

    def revise(self, prompt: str, response: str, critique: str) -> str:
        revision_prompt = (
            f"Revise the response to address the critique.\n\n"
            f"Question: {prompt}\nOriginal response: {response}\nCritique: {critique}\n\nRevised response:"
        )
        return self.generator.generate(
            revision_prompt, max_new_tokens=512, temperature=0.5
        )

    def apply(self, prompt: str, response: str) -> dict:
        critique = self.critique(prompt, response)
        revised = self.revise(prompt, response, critique)
        improved = revised != response and len(revised) > 50
        return {
            "original": response,
            "critique": critique,
            "revised": revised,
            "improved": improved,
        }

    def generate_dpo_pair(self, prompt: str, response: str) -> dict | None:
        result = self.apply(prompt, response)
        if not result["improved"]:
            return None

        pair = {
            "messages": [{"role": "user", "content": prompt}],
            "chosen": result["revised"],
            "rejected": result["original"],
            "quality": "constitutional",
        }

        QUALITY_DIR.mkdir(parents=True, exist_ok=True)
        counter = len(list(QUALITY_DIR.glob("constitutional-*.jsonl")))
        fname = f"constitutional-{os.getpid()}-{counter}.jsonl"
        (QUALITY_DIR / fname).write_text(json.dumps(pair) + "\n")

        return pair


constitutional_ai: ConstitutionalAI | None = None
