"""
self_play.py — Self-play data generation for Proverbs LLM.

The model generates both question and answer, then critiques the answer.
High-quality pairs (rating >= min_rating) are saved as JSONL training data,
providing an unlimited supply of synthetic coding examples without human input.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import re
import sys
from pathlib import Path

log = logging.getLogger("proverbs.self_play")

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))


# ---------------------------------------------------------------------------
# Question templates — 30 diverse coding prompts
# ---------------------------------------------------------------------------

QUESTION_TEMPLATES = [
    # Algorithms
    "Write a Python function to {algo} with time complexity better than O(n²).",
    "Implement {algo} in Python. Include edge case handling and a usage example.",
    "Explain the difference between {algo} and {algo2}, then implement both.",
    "Optimize this Python code that performs {algo}: show the before and after.",
    "Write a recursive solution for {algo}, then convert it to an iterative version.",

    # Debugging
    "Debug this Python snippet that should {task} but raises a {error}. Explain the fix.",
    "A Python function for {task} returns wrong results for edge inputs. How do you fix it?",
    "Why does this Python code cause a {error} when {condition}? Show the corrected version.",
    "Find and fix all bugs in this Python implementation of {algo}.",
    "Trace through this Python code step-by-step and identify where {task} logic breaks.",

    # Explanation
    "Explain how {concept} works in Python with a concrete code example.",
    "What is {concept} in programming and when should you use it? Give a Python example.",
    "How does Python's {concept} differ from {concept2}? Show code for both.",
    "Walk me through {concept} using an analogy and a minimal Python demo.",
    "Describe the time and space complexity of {algo} and explain why with an example.",

    # Refactoring
    "Refactor this nested Python code for {task} to use list comprehensions.",
    "Rewrite this Python function for {task} to be more Pythonic and readable.",
    "Convert this imperative Python loop that does {task} into a functional style.",
    "Simplify this Python class for {concept} by removing redundant code.",
    "Refactor this repetitive Python code for {task} using a decorator.",

    # JavaScript
    "Write a JavaScript function to {js_task} using modern ES6+ syntax.",
    "Explain JavaScript {js_concept} with a practical coding example.",
    "How do you handle {js_concept} in JavaScript async code? Show a working example.",
    "Implement a JavaScript solution for {algo} and compare it to the Python version.",
    "Debug this JavaScript code that should {js_task} but has a closure bug.",

    # SQL
    "Write a SQL query to {sql_task} with proper indexing considerations.",
    "Optimize this slow SQL query that does {sql_task} — explain each change.",
    "Explain the difference between {sql_concept} and {sql_concept2} with example queries.",
    "Write a SQL query using {sql_concept} to solve {sql_task}.",
    "How would you design a schema for {sql_task}? Show CREATE TABLE statements.",
]

# Filler concepts used to hydrate templates
_ALGOS = [
    "binary search", "merge sort", "quick sort", "BFS", "DFS",
    "dynamic programming on a 2D grid", "Dijkstra's algorithm",
    "Trie insertion and lookup", "sliding window maximum",
    "topological sort", "union-find", "longest common subsequence",
    "coin change", "edit distance", "interval merging",
]

_CONCEPTS = [
    "closures", "generators", "decorators", "context managers",
    "metaclasses", "descriptors", "coroutines", "dataclasses",
    "abstract base classes", "memoization", "lazy evaluation",
    "dependency injection", "observer pattern", "factory pattern",
]

_TASKS = [
    "flatten a nested list", "parse a CSV", "validate an email address",
    "merge two sorted arrays", "count word frequencies",
    "rotate a matrix 90 degrees", "find all permutations",
    "detect a cycle in a linked list", "serialize a binary tree",
    "group anagrams together",
]

_ERRORS = [
    "RecursionError", "KeyError", "IndexError", "TypeError",
    "AttributeError", "StopIteration", "MemoryError", "ValueError",
]

_CONDITIONS = [
    "the input list is empty", "a None value is passed",
    "the input contains duplicate keys", "n is negative",
    "the string has unicode characters", "the dict is deeply nested",
]

_JS_TASKS = [
    "debounce a search input", "deep clone an object",
    "flatten an array recursively", "implement a simple event emitter",
    "throttle API calls", "implement a promise-based retry",
]

_JS_CONCEPTS = [
    "event delegation", "promise chaining", "the prototype chain",
    "the event loop", "WeakMap vs Map", "optional chaining",
]

_SQL_TASKS = [
    "find the top-5 customers by total spend",
    "compute a 7-day rolling average",
    "detect duplicate rows",
    "pivot monthly sales data into columns",
    "find employees with no manager",
]

_SQL_CONCEPTS = [
    "INNER JOIN", "LEFT JOIN", "CTE", "window functions",
    "subquery", "GROUP BY with HAVING", "COALESCE",
]


def _random_fill(template: str) -> str:
    """Replace placeholder keys in a template with random concept strings."""
    replacements = {
        "{algo}":          random.choice(_ALGOS),
        "{algo2}":         random.choice(_ALGOS),
        "{concept}":       random.choice(_CONCEPTS),
        "{concept2}":      random.choice(_CONCEPTS),
        "{task}":          random.choice(_TASKS),
        "{error}":         random.choice(_ERRORS),
        "{condition}":     random.choice(_CONDITIONS),
        "{js_task}":       random.choice(_JS_TASKS),
        "{js_concept}":    random.choice(_JS_CONCEPTS),
        "{sql_task}":      random.choice(_SQL_TASKS),
        "{sql_concept}":   random.choice(_SQL_CONCEPTS),
        "{sql_concept2}":  random.choice(_SQL_CONCEPTS),
    }
    result = template
    for key, value in replacements.items():
        result = result.replace(key, value)
    return result


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def generate_question(generator, template: str | None = None) -> str:
    """
    Return a coding question string.

    If *template* is given it is used (after random concept filling).
    Otherwise a random template is selected.  When the model is capable enough,
    a second pass asks the model itself to invent a question (temperature=0.9).
    """
    if template is None:
        template = random.choice(QUESTION_TEMPLATES)

    filled = _random_fill(template)

    # Ask the model to rephrase/extend the filled template into a natural question.
    prompt = (
        f"Rephrase the following coding question to sound natural and self-contained "
        f"(one sentence to three sentences max). Output only the question, no preamble.\n\n"
        f"Draft: {filled}"
    )
    try:
        result = generator.generate(
            prompt=prompt,
            max_new_tokens=120,
            temperature=0.9,
        )
        question = result.strip()
        # If the model output looks too short or empty, fall back to the filled template.
        if len(question) < 20:
            return filled
        return question
    except Exception as exc:
        log.warning("generate_question model call failed (%s), using template fill.", exc)
        return filled


def generate_answer(generator, question: str) -> str:
    """Generate a coding answer for *question* (max 400 new tokens, temperature 0.7)."""
    messages = [{"role": "user", "content": question}]
    try:
        answer = generator.generate(
            prompt=messages,
            max_new_tokens=400,
            temperature=0.7,
        )
        return answer.strip()
    except Exception as exc:
        log.error("generate_answer failed: %s", exc)
        return ""


def generate_critique(generator, question: str, answer: str) -> dict:
    """
    Ask the model to rate the answer 1-10 and provide a brief explanation.

    Returns a dict with keys:
      - "rating" (int, 1-10; defaults to 5 on parse failure)
      - "critique" (str)
    """
    prompt = (
        f"Rate this coding answer 1-10 and explain briefly.\n\n"
        f"Question: {question}\n\n"
        f"Answer: {answer}\n\n"
        f"Rating:"
    )
    try:
        raw = generator.generate(
            prompt=prompt,
            max_new_tokens=150,
            temperature=0.3,
        ).strip()
    except Exception as exc:
        log.error("generate_critique failed: %s", exc)
        return {"rating": 5, "critique": ""}

    # Parse the first integer (1-10) from the response.
    match = re.search(r"\b([1-9]|10)\b", raw)
    if match:
        rating = int(match.group(1))
        # The critique is everything after the rating token.
        critique = raw[match.end():].strip().lstrip("/:- \n")
    else:
        rating = 5
        critique = raw

    return {"rating": rating, "critique": critique}


def run_self_play_loop(
    generator,
    n_examples: int = 50,
    output_dir: str = "~/.proverbs/quality_sessions",
    min_rating: int = 7,
) -> int:
    """
    Run the self-play loop for *n_examples* attempts.

    For each attempt:
      1. Generate a question.
      2. Generate an answer.
      3. Critique the answer.
      4. If rating >= min_rating, save to *output_dir* as JSONL.

    Returns the number of examples actually saved.
    """
    out_path = Path(os.path.expanduser(output_dir))
    out_path.mkdir(parents=True, exist_ok=True)

    saved = 0

    for i in range(n_examples):
        log.info("Self-play iteration %d/%d", i + 1, n_examples)

        question = generate_question(generator)
        if not question:
            log.warning("Empty question at iteration %d — skipping.", i + 1)
            continue

        answer = generate_answer(generator, question)
        if not answer:
            log.warning("Empty answer at iteration %d — skipping.", i + 1)
            continue

        critique = generate_critique(generator, question, answer)
        rating = critique.get("rating", 0)

        log.info(
            "  Q: %.60s…  rating=%d  critique=%.80s",
            question,
            rating,
            critique.get("critique", ""),
        )

        if rating < min_rating:
            log.debug("  Below threshold (%d < %d) — discarding.", rating, min_rating)
            continue

        # Save as JSONL with messages format compatible with the training pipeline.
        entry = {
            "messages": [
                {"role": "user",      "content": question},
                {"role": "assistant", "content": answer},
            ],
            "quality":  "self_play",
            "rating":   rating,
            "critique": critique.get("critique", ""),
        }
        fname = f"self_play-{os.getpid()}-{saved:04d}.jsonl"
        (out_path / fname).write_text(json.dumps(entry) + "\n")
        saved += 1
        log.info("  Saved (%d/%d so far).", saved, i + 1)

    log.info("Self-play complete: %d/%d examples met quality threshold.", saved, n_examples)
    return saved


# ---------------------------------------------------------------------------
# Command-line interface
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
    )

    parser = argparse.ArgumentParser(
        description="Proverbs self-play: generate synthetic Q&A training data.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--model",
        required=True,
        help="Path to a saved .pt model checkpoint.",
    )
    parser.add_argument(
        "--tokenizer",
        default="~/.proverbs/tokenizer.json",
        help="Path to the tokenizer JSON file.",
    )
    parser.add_argument(
        "--n",
        type=int,
        default=50,
        dest="n",
        help="Number of self-play attempts to run.",
    )
    parser.add_argument(
        "--min-rating",
        type=int,
        default=7,
        dest="min_rating",
        help="Minimum critique rating (1-10) required to save an example.",
    )
    parser.add_argument(
        "--output-dir",
        default="~/.proverbs/quality_sessions",
        dest="output_dir",
        help="Directory to write accepted JSONL examples.",
    )
    parser.add_argument(
        "--device",
        default=None,
        help="Device to run on (cuda / mps / cpu). Auto-detected if omitted.",
    )

    args = parser.parse_args()

    from model.proverbs_lm import ProverbsLM
    from inference.generate import ProverbsGenerator

    print(f"Loading model from {args.model} ...", file=sys.stderr)
    lm = ProverbsLM.load(args.model, device=args.device)
    print(f"  {lm}", file=sys.stderr)

    gen = ProverbsGenerator(
        model=lm,
        tokenizer_path=args.tokenizer,
        device=args.device,
    )

    saved_count = run_self_play_loop(
        generator=gen,
        n_examples=args.n,
        output_dir=args.output_dir,
        min_rating=args.min_rating,
    )
    print(f"Saved {saved_count} high-quality examples to {args.output_dir}")
