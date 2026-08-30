"""
scripts/synth_data.py — generate synthetic training data using the current model.

Each accepted example is written as a single-line JSONL record:
  {"messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}],
   "quality": "synthetic"}
"""

from __future__ import annotations

import ast
import json
import os
import re
import sys
from itertools import cycle
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from model.proverbs_lm import ProverbsLM  # noqa: E402
from inference.generate import ProverbsGenerator  # noqa: E402

# ---------------------------------------------------------------------------
# Seed prompts — 50 diverse coding tasks
# ---------------------------------------------------------------------------

SEED_PROMPTS: list[str] = [
    # Algorithm tasks
    "Implement binary search on a sorted list in Python. Return the index or -1 if not found.",
    "Write merge sort in Python that sorts a list of integers in ascending order.",
    "Implement BFS on an adjacency-list graph in Python. Return nodes in traversal order.",
    "Build an LRU cache in Python with O(1) get and put using a dict and doubly-linked list.",
    "Implement a singly linked list in Python with insert, delete, and reverse methods.",
    "Write a Python function to detect a cycle in a linked list using Floyd's algorithm.",
    "Implement quicksort in Python with a random pivot to avoid worst-case behaviour.",
    "Write DFS (iterative, not recursive) for a directed graph in Python.",
    "Implement a min-heap in Python from scratch with push, pop, and peek.",
    "Write a Python function to find the lowest common ancestor of two nodes in a BST.",
    "Implement Dijkstra's shortest-path algorithm in Python using a priority queue.",
    "Write a Python function that checks if a binary tree is balanced (height-balanced).",
    "Implement a trie (prefix tree) in Python with insert, search, and starts_with.",
    "Write a Python function to find all permutations of a string without using itertools.",
    "Implement a sliding-window maximum function in Python using a deque.",
    # Bug-fixing tasks
    "Fix this broken Python binary search:\ndef bsearch(arr, t):\n    l, r = 0, len(arr)\n    while l < r:\n        m = (l + r) // 2\n        if arr[m] == t: return m\n        elif arr[m] < t: l = m\n        else: r = m\n    return -1",
    "Fix this Python function that's supposed to flatten a nested list but recurses infinitely:\ndef flatten(lst):\n    result = []\n    for item in lst:\n        result.extend(flatten(item))\n    return result",
    "Fix this broken Python decorator that's supposed to cache results:\ndef memoize(fn):\n    cache = {}\n    def wrapper(*args):\n        if args not in cache:\n            cache[args] = fn(args)\n        return cache[args]\n    return wrapper",
    "Fix this Python generator that should yield Fibonacci numbers but produces wrong values:\ndef fib():\n    a, b = 0, 1\n    while True:\n        yield a\n        a, b = b, a",
    "Fix this broken Python context manager that doesn't release the lock on exception:\nclass Locked:\n    def __init__(self, lock): self.lock = lock\n    def __enter__(self): self.lock.acquire()\n    def __exit__(self, *args): self.lock.release()",
    "Fix this Python async function that causes a RuntimeError:\nasync def fetch_all(urls):\n    results = []\n    for url in urls:\n        results.append(await asyncio.gather(fetch(url)))\n    return results",
    "Fix this SQL query that should return the top 5 customers by total order value but returns wrong results:\nSELECT customer_id, SUM(amount) FROM orders GROUP BY customer_id LIMIT 5;",
    "Fix this JavaScript function that should debounce calls but fires immediately:\nfunction debounce(fn, delay) {\n  let timer;\n  return function(...args) {\n    clearTimeout(timer);\n    fn.apply(this, args);\n    timer = setTimeout(() => {}, delay);\n  };\n}",
    # Explanation tasks
    "Explain how Python decorators work, with a practical example showing a timing decorator.",
    "Explain Python generators and the yield keyword. Show how to implement a lazy range.",
    "Explain Python's async/await model. How does the event loop work? Give a minimal example.",
    "Explain Python context managers. Implement one using both __enter__/__exit__ and contextlib.",
    "Explain the difference between Python's deepcopy and shallow copy with a concrete example.",
    "Explain Python's GIL and when it matters. When should you use threads vs. processes?",
    "Explain how Python's descriptor protocol works. Show __get__, __set__, __delete__ in use.",
    "Explain metaclasses in Python. Write a metaclass that enforces method naming conventions.",
    "Explain how Python's import system resolves modules. What does __init__.py do?",
    "Explain the difference between @staticmethod and @classmethod in Python with examples.",
    # Refactoring tasks
    "Refactor this recursive Python function to an iterative one:\ndef factorial(n):\n    if n <= 1: return 1\n    return n * factorial(n - 1)",
    "Convert this callback-based JavaScript code to use async/await:\nfunction getData(url, callback) {\n  fetch(url).then(r => r.json()).then(data => callback(null, data)).catch(err => callback(err));\n}",
    "Refactor this Python code that uses a global variable to instead use a class:\ncount = 0\ndef increment(): global count; count += 1\ndef get(): return count",
    "Refactor this Python function to use a list comprehension and be more Pythonic:\ndef evens(nums):\n    result = []\n    for n in nums:\n        if n % 2 == 0:\n            result.append(n)\n    return result",
    "Convert this Python polling loop to use asyncio:\nimport time\ndef poll(check_fn, interval=1):\n    while True:\n        if check_fn(): break\n        time.sleep(interval)",
    "Refactor this Python class to use dataclasses:\nclass Point:\n    def __init__(self, x, y): self.x = x; self.y = y\n    def __repr__(self): return f'Point({self.x}, {self.y})'",
    "Refactor this Python try/except block to use contextlib.suppress:\ntry:\n    os.remove('tmp.txt')\nexcept FileNotFoundError:\n    pass",
    # Language variety — JavaScript
    "Implement a debounce function in JavaScript from scratch without lodash.",
    "Write a JavaScript function that deep-clones an object without using JSON.stringify.",
    "Implement a Promise.all equivalent in JavaScript from scratch.",
    "Write a JavaScript function that groups an array of objects by a given key.",
    "Implement event emitter (on, off, emit) in JavaScript without using Node's EventEmitter.",
    # Language variety — SQL
    "Write a SQL query to find all employees who earn more than their manager.",
    "Write a SQL query using window functions to compute a 7-day rolling average of daily sales.",
    "Write a SQL query to find duplicate rows in a table and return only the duplicates.",
    "Write a SQL query that pivots monthly sales data from rows to columns.",
    "Write a SQL query to find the second-highest salary in an employees table without using LIMIT.",
    # Mixed / advanced Python
    "Implement a thread-safe singleton in Python using a metaclass and a lock.",
    "Write a Python function that parses a simple arithmetic expression string and evaluates it without using eval().",
]

# ---------------------------------------------------------------------------
# Quality filters
# ---------------------------------------------------------------------------

def _is_repetitive(text: str, threshold: float = 0.4) -> bool:
    """Return True if any 5-word ngram appears more than threshold * total_ngrams times."""
    words = text.split()
    n = 5
    if len(words) < n:
        return False
    ngrams: list[tuple[str, ...]] = [
        tuple(words[i : i + n]) for i in range(len(words) - n + 1)
    ]
    total = len(ngrams)
    counts: dict[tuple[str, ...], int] = {}
    for ng in ngrams:
        counts[ng] = counts.get(ng, 0) + 1
    return any(c / total > threshold for c in counts.values())


def _code_quality_ok(text: str) -> bool:
    """Return False if any Python code block inside triple-backtick fences has a SyntaxError."""
    blocks = re.findall(r"```python\s*(.*?)```", text, re.DOTALL)
    if not blocks:
        return True
    for block in blocks:
        try:
            ast.parse(block)
        except SyntaxError:
            return False
    return True


# ---------------------------------------------------------------------------
# Main generation function
# ---------------------------------------------------------------------------

def generate_examples(
    model_path: str,
    tokenizer_path: str | None = None,
    n_examples: int = 100,
    temperature: float = 0.85,
    output_dir: str = "~/.proverbs/quality_sessions",
    verbose: bool = False,
) -> int:
    tok_path = tokenizer_path or "~/.proverbs/tokenizer.json"

    model = ProverbsLM.load(model_path, device=None)
    generator = ProverbsGenerator(model=model, tokenizer_path=tok_path)

    out_path = Path(output_dir).expanduser().resolve()
    out_path.mkdir(parents=True, exist_ok=True)

    pid = os.getpid()
    saved = 0
    prompt_cycle = cycle(SEED_PROMPTS)

    for attempt in range(n_examples):
        seed = next(prompt_cycle)
        messages = [{"role": "user", "content": seed}]

        completion: str = generator.generate(
            messages,
            max_new_tokens=300,
            temperature=temperature,
            top_p=0.9,
        )  # type: ignore[assignment]

        if len(completion.strip()) < 60:
            if verbose:
                print(f"[{attempt}] skip: too short ({len(completion.strip())} chars)")
            continue

        if _is_repetitive(completion):
            if verbose:
                print(f"[{attempt}] skip: repetitive")
            continue

        if not _code_quality_ok(completion):
            if verbose:
                print(f"[{attempt}] skip: syntax error in code block")
            continue

        record = {
            "messages": messages + [{"role": "assistant", "content": completion}],
            "quality": "synthetic",
        }
        out_file = out_path / f"synth-{pid}-{saved}.jsonl"
        with out_file.open("w", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")

        saved += 1
        if verbose:
            print(f"[{attempt}] saved #{saved} -> {out_file.name}")

    return saved


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Generate synthetic training data from the current ProverbsLM.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--model", required=True, help="Path to a saved .pt model checkpoint.")
    parser.add_argument(
        "--tokenizer",
        default=None,
        help="Path to tokenizer JSON. Defaults to ~/.proverbs/tokenizer.json.",
    )
    parser.add_argument("--n", type=int, default=100, dest="n", help="Number of generation attempts.")
    parser.add_argument("--temperature", type=float, default=0.85, help="Sampling temperature.")
    parser.add_argument(
        "--output-dir",
        default="~/.proverbs/quality_sessions",
        dest="output_dir",
        help="Directory to write JSONL files into.",
    )
    parser.add_argument("--verbose", action="store_true", help="Print per-example status.")

    args = parser.parse_args()

    total = generate_examples(
        model_path=args.model,
        tokenizer_path=args.tokenizer,
        n_examples=args.n,
        temperature=args.temperature,
        output_dir=args.output_dir,
        verbose=args.verbose,
    )
    print(f"Saved {total} examples to {args.output_dir}")
