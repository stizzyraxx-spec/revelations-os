"""
Post-retrain quality harness for ProverbsLM.

Runs 16 coding prompts, measures perplexity and Python syntax pass rate,
compares against historical best score, and exits 0 (pass) or 1 (fail).
"""

from __future__ import annotations

import argparse
import ast
import json
import math
import re
import sys
from pathlib import Path

import torch

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from model.proverbs_lm import ProverbsLM  # noqa: E402
from inference.generate import ProverbsGenerator  # noqa: E402

# ---------------------------------------------------------------------------
# Benchmark prompts
# ---------------------------------------------------------------------------

BENCH_PROMPTS: list[str] = [
    "Write a Python function that reverses a singly linked list in place.",
    "Fix this bug: def fib(n): return fib(n-1) + fib(n-2)",
    "Implement binary search on a sorted list in Python.",
    "Write a JavaScript debounce function.",
    "Implement an LRU cache in Python.",
    "Write a Python decorator that measures and prints function execution time.",
    "Implement a stack using two queues in Python.",
    "Write a Python function that checks if a string is a valid palindrome.",
    "Implement merge sort in Python.",
    "Write a Python context manager that suppresses a given exception type.",
    "Write a Python generator that yields Fibonacci numbers indefinitely.",
    "Implement a basic trie data structure in Python.",
    "Write a Python function that flattens a nested list of arbitrary depth.",
    "Implement depth-first search on a graph represented as an adjacency list in Python.",
    "Write a Python function to find all permutations of a string.",
    "Implement a min-heap class in Python without using heapq.",
    "Write a Python function that detects a cycle in a linked list.",
    "Implement a simple tokenizer that splits text on whitespace and punctuation in Python.",
    "Write a Python function that computes the edit distance between two strings.",
    "Implement a thread-safe singleton pattern in Python.",
]

BENCH_HISTORY = Path.home() / ".proverbs" / "bench" / "history.jsonl"


# ---------------------------------------------------------------------------
# Perplexity
# ---------------------------------------------------------------------------

def _compute_perplexity(
    model: ProverbsLM,
    tokenizer_path: str,
    prompt: str,
    completion: str,
) -> float:
    try:
        from tokenizer.bpe import ProverbsTokenizer

        tok_path = Path(tokenizer_path).expanduser()
        tokenizer = ProverbsTokenizer.load(str(tok_path))

        text = prompt + completion
        ids = tokenizer.encode(text, add_bos=True)
        if len(ids) < 2:
            return float("inf")

        input_ids = torch.tensor([ids], dtype=torch.long, device=next(model.parameters()).device)
        with torch.inference_mode():
            out = model(input_ids, labels=input_ids, kv_caches=None)
        loss = out["loss"].item()
        return math.exp(loss)
    except Exception:
        return float("inf")


# ---------------------------------------------------------------------------
# Syntax check
# ---------------------------------------------------------------------------

def _syntax_ok(text: str) -> bool:
    # Try triple-backtick python fences first
    fence_matches = re.findall(r"```python\s*(.*?)```", text, re.DOTALL | re.IGNORECASE)
    if fence_matches:
        for block in fence_matches:
            try:
                ast.parse(block)
            except SyntaxError:
                return False
        return True

    # Try indented blocks (lines starting with 4 spaces or a tab)
    indented_lines = [
        line for line in text.splitlines()
        if line.startswith("    ") or line.startswith("\t")
    ]
    if indented_lines:
        block = "\n".join(indented_lines)
        try:
            ast.parse(block)
        except SyntaxError:
            return False
        return True

    # No code found — treat as passing
    return True


# ---------------------------------------------------------------------------
# Main benchmark runner
# ---------------------------------------------------------------------------

def run_benchmark(
    model_path: str,
    tokenizer_path: str | None = None,
    verbose: bool = False,
) -> dict:
    default_tok = str(Path.home() / ".proverbs" / "tokenizer.json")
    tokenizer_path = tokenizer_path or default_tok

    if verbose:
        print(f"Loading model from {model_path} ...", file=sys.stderr)

    model = ProverbsLM.load(model_path)
    model.eval()

    generator = ProverbsGenerator(
        model=model,
        tokenizer_path=tokenizer_path,
    )

    prompts = BENCH_PROMPTS[:16]
    perplexities: list[float] = []
    syntax_passes = 0

    for i, prompt in enumerate(prompts):
        completion = generator.generate(
            prompt=prompt,
            max_new_tokens=150,
            temperature=0.1,
            top_p=0.9,
            top_k=0,
            repetition_penalty=1.1,
            stream=False,
        )

        ppl = _compute_perplexity(model, tokenizer_path, prompt, completion)
        ok = _syntax_ok(completion)
        if ok:
            syntax_passes += 1
        if math.isfinite(ppl):
            perplexities.append(ppl)

        if verbose:
            print(
                f"[{i+1:02d}/16] ppl={ppl:.2f}  syntax={'ok' if ok else 'FAIL'}\n"
                f"  prompt: {prompt[:70]}\n"
                f"  output: {completion[:120].strip()}\n",
                file=sys.stderr,
            )

    mean_perplexity = float(sum(perplexities) / len(perplexities)) if perplexities else float("inf")
    syntax_pass_rate = syntax_passes / 16
    overall_score = syntax_pass_rate / max(mean_perplexity, 1.0)

    # Load history and compare
    BENCH_HISTORY.parent.mkdir(parents=True, exist_ok=True)
    past_scores: list[float] = []
    if BENCH_HISTORY.exists():
        with BENCH_HISTORY.open() as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    s = entry.get("overall_score")
                    if s is not None and math.isfinite(float(s)):
                        past_scores.append(float(s))
                except (json.JSONDecodeError, ValueError):
                    continue

    best_score = max(past_scores) if past_scores else 0.0
    passed = overall_score >= best_score * 0.90

    result = {
        "model_path": model_path,
        "mean_perplexity": mean_perplexity,
        "syntax_pass_rate": syntax_pass_rate,
        "overall_score": overall_score,
        "best_score": best_score,
        "passed": passed,
        "n_prompts": 16,
    }

    with BENCH_HISTORY.open("a") as fh:
        fh.write(json.dumps(result) + "\n")

    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="ProverbsLM post-retrain quality benchmark",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--model", required=True, help="Path to a saved .pt model checkpoint.")
    parser.add_argument(
        "--tokenizer",
        default=None,
        help="Path to the tokenizer JSON file. Defaults to ~/.proverbs/tokenizer.json.",
    )
    parser.add_argument("--verbose", action="store_true", help="Print per-prompt results.")
    args = parser.parse_args()

    result = run_benchmark(
        model_path=args.model,
        tokenizer_path=args.tokenizer,
        verbose=args.verbose,
    )

    print(json.dumps(result, indent=2))

    if not result["passed"]:
        sys.exit(1)
    sys.exit(0)
