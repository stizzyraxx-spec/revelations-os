#!/usr/bin/env python3
"""
generate_training_data.py — Bootstrap training data using the GGUF model.

Uses the already-downloaded qwen2.5-coder model to generate synthetic
coding examples. Saves them as session JSONL files for training.

Run time: ~20-40 minutes on CPU (50 examples, short responses).
"""

import json
import sys
import time
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from inference.gguf_backend import GGUFBackend

OUTPUT_DIR = Path.home() / ".proverbs" / "sessions"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

SYSTEM_PROMPT = (
    "You are Proverbs, an expert AI coding assistant. "
    "Give concise, correct, idiomatic code. No prose, just code and brief inline comments."
)

# 50 diverse coding tasks — short responses keep generation fast on CPU
TASKS = [
    # Python fundamentals
    "Write a Python function that flattens a nested list.",
    "Write a Python function that merges two sorted lists into one sorted list.",
    "Write a Python decorator that retries a function up to 3 times on exception.",
    "Write a Python context manager that times a block of code.",
    "Write a Python function that deep-copies a dictionary.",
    "Write a Python generator that yields fibonacci numbers.",
    "Write a Python function that groups a list of dicts by a key.",
    "Write a Python class that implements a simple LRU cache.",
    "Write a Python function that reads a JSON file safely.",
    "Write a Python function that chunks a list into batches of size n.",

    # JavaScript / TypeScript
    "Write a JavaScript function that debounces a callback.",
    "Write a JavaScript function that throttles a callback.",
    "Write a TypeScript function that deep-merges two objects.",
    "Write a JavaScript async function that retries a fetch with exponential backoff.",
    "Write a TypeScript interface and function to parse a paginated API response.",
    "Write a JavaScript function that converts a flat array of {id, parentId} objects into a tree.",
    "Write a TypeScript generic function that groups an array by a key.",
    "Write a JavaScript function that memoizes an async function.",
    "Write a TypeScript enum and a type guard for HTTP methods.",
    "Write a JavaScript function that deep-clones an object without JSON.",

    # Algorithms
    "Write a Python function that does binary search on a sorted list.",
    "Write a Python function that implements quicksort.",
    "Write a Python function that finds the two numbers in a list that sum to a target.",
    "Write a Python function that checks if a string is a palindrome.",
    "Write a Python function that counts word frequencies in a string.",
    "Write a Python function that finds all permutations of a string.",
    "Write a Python function that implements a stack with push, pop, and min in O(1).",
    "Write a Python function that checks if brackets in a string are balanced.",
    "Write a Python function that reverses the words in a sentence.",
    "Write a Python function that finds the longest common prefix of a list of strings.",

    # Node.js / backend
    "Write a Node.js function that reads a file with a timeout.",
    "Write an Express.js middleware that logs request duration.",
    "Write a Node.js function that walks a directory tree recursively.",
    "Write a Node.js function that limits concurrent async operations.",
    "Write a Node.js function that streams a large file line by line.",

    # Data / utilities
    "Write a Python function that parses a CSV string into a list of dicts.",
    "Write a Python function that validates an email address with a regex.",
    "Write a Python function that converts snake_case to camelCase.",
    "Write a Python function that slugifies a string for a URL.",
    "Write a Python function that truncates a string at a word boundary.",

    # Git / CLI patterns
    "Write a Python script that runs a shell command and returns stdout, stderr, and exit code.",
    "Write a Python function that finds all Python files in a directory recursively.",
    "Write a Python function that compares two text files and returns the diff.",
    "Write a Python function that watches a file for changes.",
    "Write a bash function that creates a timestamped backup of a file.",

    # Error handling / patterns
    "Write a Python function that wraps a function call and returns (result, error).",
    "Write a TypeScript function that wraps a Promise and returns [data, error].",
    "Write a Python class that represents a Result type (ok/err) like Rust.",
    "Write a Python function that validates a config dict against a schema.",
    "Write a Python function that safely parses an integer with a default value.,"
    # Next.js / React patterns
    "Write a Next.js API route handler that validates a POST request body with Zod.",
    "Write a React custom hook that fetches data with loading and error states.",
    "Write a React custom hook that debounces a value.",
    "Write a Next.js server action that creates a database record and revalidates a path.",
    "Write a React component that renders a virtualized list of 10000 items.",
    "Write a Next.js middleware that checks for an auth token in cookies.",
    "Write a React hook that syncs state with localStorage.",
    "Write a Next.js API route that streams a response using Server-Sent Events.",
    "Write a React context provider with useReducer for a shopping cart.",
    "Write a Next.js page that uses generateStaticParams for dynamic routes.",

    # Prisma / database patterns
    "Write a Prisma query that fetches paginated users with their posts count.",
    "Write a Prisma transaction that transfers balance between two accounts.",
    "Write a Prisma query that upserts a record.",
    "Write a TypeScript function that builds a Prisma where clause from search params.",
    "Write a Prisma middleware that soft-deletes records instead of hard deleting.",

    # Express / Node.js backend
    "Write an Express route that handles file uploads with multer.",
    "Write an Express middleware that rate-limits requests per IP.",
    "Write an Express route that returns paginated results from a database.",
    "Write a Node.js function that sends an email with nodemailer.",
    "Write an Express error handler middleware that formats errors as JSON.",

    # Stripe / payments
    "Write a Node.js function that creates a Stripe checkout session.",
    "Write an Express webhook handler that verifies and processes Stripe events.",
    "Write a Node.js function that cancels a Stripe subscription.",

    # Authentication patterns
    "Write a Node.js function that hashes and verifies passwords with bcrypt.",
    "Write a Node.js function that signs and verifies JWTs.",
    "Write a TypeScript middleware that validates a session token from cookies.",
    "Write a Next.js server action that logs in a user and sets a session cookie.",

    # Testing patterns
    "Write Jest tests for a function that validates an email address.",
    "Write a Jest mock for a database client with spy functions.",
    "Write a Vitest test for a React component that renders a user list.",
    "Write a pytest fixture that creates a temporary SQLite database.",
    "Write pytest parametrize tests for a sorting function.",

    # Python data processing
    "Write a Python function that reads a CSV file in chunks to process large files.",
    "Write a Python async function that fetches multiple URLs concurrently with aiohttp.",
    "Write a Python function that implements exponential backoff for retries.",
    "Write a Python function that parses ISO 8601 datetime strings.",
    "Write a Python dataclass with validation using __post_init__.",
    "Write a Python function that implements a simple pub/sub event system.",
    "Write a Python function that walks a directory and returns a file tree dict.",
    "Write a Python function that converts a list of dicts to a CSV string.",
    "Write a Python function that computes the moving average of a list.",
    "Write a Python async generator that yields lines from a large file.",

    # TypeScript advanced patterns
    "Write a TypeScript utility type that makes all properties optional recursively.",
    "Write a TypeScript function that narrows a union type with a discriminant.",
    "Write a TypeScript decorator that adds logging to a class method.",
    "Write a TypeScript class that implements an event emitter with typed events.",
    "Write a TypeScript function that implements a simple state machine.",
    "Write a TypeScript type-safe builder pattern for SQL queries.",
    "Write a TypeScript generic repository class with CRUD operations.",

    # Algorithms and data structures
    "Write a Python function that implements a trie for autocomplete.",
    "Write a Python function that finds all subsets of a set.",
    "Write a Python function that solves the coin change problem with DP.",
    "Write a Python class that implements a min-heap.",
    "Write a Python function that detects a cycle in a linked list.",
    "Write a Python function that finds the longest palindromic substring.",
    "Write a Python function that implements BFS on a graph.",
    "Write a Python function that topologically sorts a directed graph.",
    "Write a Python function that finds the kth largest element in an array.",

    # CLI and scripting
    "Write a Python CLI tool with argparse that converts JSON to CSV.",
    "Write a Node.js script that watches a directory and runs a command on change.",
    "Write a bash script that backs up a PostgreSQL database.",
    "Write a Python script that replaces text in all files in a directory.",

    # Configuration and environment
    "Write a TypeScript function that loads and validates environment variables.",
    "Write a Python function that merges configuration from file and environment.",
    "Write a Node.js function that loads .env files with dotenv fallbacks.",

    # Security patterns
    "Write a Node.js function that sanitizes HTML input to prevent XSS.",
    "Write a Python function that generates a cryptographically secure random token.",
    "Write a TypeScript function that validates and sanitizes file upload paths.",
    "Write a Node.js function that implements CSRF token generation and verification.",

    # Real-time / WebSocket
    "Write a Node.js WebSocket server that broadcasts messages to all clients.",
    "Write a React hook that connects to a WebSocket and handles reconnection.",

    # SQL / query building
    "Write a Python function that builds a parameterized SQL SELECT query.",
    "Write a TypeScript query builder for common SQL operations.",

    # Caching patterns  
    "Write a Node.js in-memory cache with TTL expiration.",
    "Write a Python function that caches function results to a JSON file.",
    "Write a TypeScript decorator that caches method results by arguments.",

    # Error handling advanced
    "Write a Python class hierarchy for custom API errors with HTTP status codes.",
    "Write a TypeScript Result type with map, flatMap, and match methods.",
    "Write a Node.js domain error handler that logs and formats errors.",

    # File system operations
    "Write a Node.js function that recursively copies a directory.",
    "Write a Python function that atomically writes a file using a temp file.",
    "Write a Node.js function that zips a directory using the archiver package.",

    # Validation
    "Write a Python function that validates a URL format.",
    "Write a TypeScript function that validates a credit card number with Luhn.",
    "Write a Python function that validates a JSON schema.",
    "Write a TypeScript function that validates and parses a date string.",

    # Sorting and search
    "Write a TypeScript function that sorts an array of objects by multiple keys.",
    "Write a Python function that implements merge sort.",
    "Write a Python function that searches a sorted 2D matrix.",

    # String manipulation
    "Write a Python function that extracts all email addresses from text.",
    "Write a JavaScript function that converts markdown to plain text.",
    "Write a Python function that finds and replaces with regex groups.",

    # Array/list operations
    "Write a JavaScript function that zips multiple arrays together.",
    "Write a Python function that finds duplicates in a list efficiently.",
    "Write a TypeScript function that rotates an array by k positions.",
    "Write a Python function that generates all combinations of k from n.",

    # Object/dict operations
    "Write a Python function that flattens a nested dict with dot notation keys.",
    "Write a JavaScript function that picks specified keys from an object.",
    "Write a Python function that deep-diffs two dictionaries.",

    # Date/time patterns
    "Write a JavaScript function that formats a duration in human-readable form.",
    "Write a Python function that calculates business days between two dates.",
    "Write a TypeScript function that creates a range of dates.",
]


def generate_example(gen: GGUFBackend, task: str, idx: int) -> dict:
    messages = [
        {"role": "system",    "content": SYSTEM_PROMPT},
        {"role": "user",      "content": task},
    ]
    response = gen.generate(
        messages,
        max_new_tokens=400,
        temperature=0.2,
        top_p=0.9,
        stream=False,
    )
    messages.append({"role": "assistant", "content": response.strip()})
    return {"messages": messages}


def main():
    print("=== Proverbs: Generate Synthetic Training Data ===\n")
    print(f"Output: {OUTPUT_DIR}")
    print(f"Tasks:  {len(TASKS)}")
    print()
    print("Loading GGUF model...")
    gen = GGUFBackend(verbose=False)
    print("Model ready.\n")

    out_file = OUTPUT_DIR / "synthetic_coding.jsonl"
    existing = 0
    if out_file.exists():
        existing = sum(1 for _ in open(out_file))
        print(f"Resuming — {existing} examples already written.\n")

    written = existing
    with open(out_file, "a", encoding="utf-8") as f:
        for i, task in enumerate(TASKS[existing:], start=existing):
            t0 = time.time()
            try:
                example = generate_example(gen, task, i)
                f.write(json.dumps(example) + "\n")
                f.flush()
                written += 1
                elapsed = time.time() - t0
                print(f"  [{written:2d}/{len(TASKS)}] {elapsed:.1f}s  {task[:60]}")
            except Exception as e:
                print(f"  [{i+1:2d}/{len(TASKS)}] ERROR: {e}")

    print(f"\nDone. {written} examples written to {out_file}")
    print("\nNext: run the full training pipeline:")
    print("  python -m tokenizer.train_tokenizer")
    print("  python -m training.train --mode local")


if __name__ == "__main__":
    main()
