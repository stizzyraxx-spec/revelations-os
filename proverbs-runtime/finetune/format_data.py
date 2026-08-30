#!/usr/bin/env python3
"""
format_data.py — Proverbs fine-tune data formatter

Reads session JSONL files from ~/.proverbs/sessions/ and rules from
~/.proverbs/rules.md, then writes combined train/valid splits to
~/.proverbs/training/.
"""

import json
import os
import random
import re
import sys
from pathlib import Path

SESSIONS_DIR = Path.home() / ".proverbs" / "sessions"
RULES_FILE   = Path.home() / ".proverbs" / "rules.md"
TRAINING_DIR = Path.home() / ".proverbs" / "training"
TRAIN_FILE   = TRAINING_DIR / "train.jsonl"
VALID_FILE   = TRAINING_DIR / "valid.jsonl"

MIN_ASSISTANT_LEN = 20
VALID_SPLIT       = 0.10
RANDOM_SEED       = 42


def load_session_examples() -> list[dict]:
    """Load and filter all examples from session JSONL files."""
    examples = []

    if not SESSIONS_DIR.exists():
        print(f"  [warn] Sessions dir not found: {SESSIONS_DIR}")
        return examples

    jsonl_files = sorted(SESSIONS_DIR.glob("*.jsonl"))
    if not jsonl_files:
        print(f"  [warn] No JSONL files found in {SESSIONS_DIR}")
        return examples

    skipped = 0
    for path in jsonl_files:
        with open(path, "r", encoding="utf-8") as f:
            for lineno, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError as e:
                    print(f"  [warn] Skipping malformed JSON in {path.name}:{lineno} — {e}")
                    skipped += 1
                    continue

                messages = obj.get("messages", [])
                if not messages:
                    skipped += 1
                    continue

                # Find assistant reply and check it meets minimum length
                assistant_reply = ""
                for msg in messages:
                    if msg.get("role") == "assistant":
                        assistant_reply = msg.get("content", "")
                        break

                if len(assistant_reply.strip()) < MIN_ASSISTANT_LEN:
                    skipped += 1
                    continue

                examples.append({"messages": messages})

    print(f"  Loaded {len(examples)} session examples ({skipped} skipped)")
    return examples


def load_rules_example() -> list[dict]:
    """Convert rules.md into a single training example."""
    if not RULES_FILE.exists():
        print(f"  [warn] Rules file not found: {RULES_FILE}")
        return []

    rules_text = RULES_FILE.read_text(encoding="utf-8")

    # Extract numbered rules (lines matching ^\d+\.)
    rule_lines = [
        line.strip()
        for line in rules_text.splitlines()
        if re.match(r"^\d+\.", line.strip())
    ]

    if not rule_lines:
        print(f"  [warn] No numbered rules found in {RULES_FILE}")
        return []

    all_rules = "\n".join(rule_lines)
    assistant_content = f"Here are my rules:\n{all_rules}"

    example = {
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are Proverbs, an expert AI coding assistant. "
                    "Follow your permanent rules in every response."
                ),
            },
            {"role": "user", "content": "What are your coding rules?"},
            {"role": "assistant", "content": assistant_content},
        ]
    }

    print(f"  Loaded rules example ({len(rule_lines)} rules)")
    return [example]


def write_jsonl(path: Path, examples: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for ex in examples:
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")


def main() -> None:
    print("=== Proverbs: Format Training Data ===\n")

    print("Loading session examples...")
    session_examples = load_session_examples()

    print("Loading rules example...")
    rules_examples = load_rules_example()

    all_examples = session_examples + rules_examples
    total = len(all_examples)

    if total == 0:
        print("\n[error] No training examples found. Nothing to write.")
        sys.exit(1)

    # Shuffle deterministically then split
    random.seed(RANDOM_SEED)
    random.shuffle(all_examples)

    n_valid = max(1, round(total * VALID_SPLIT))
    n_train = total - n_valid

    train_examples = all_examples[:n_train]
    valid_examples = all_examples[n_train:]

    print(f"\nWriting training data to {TRAINING_DIR} ...")
    write_jsonl(TRAIN_FILE, train_examples)
    write_jsonl(VALID_FILE, valid_examples)

    print("\n--- Summary ---")
    print(f"  Total examples : {total}")
    print(f"  Train          : {n_train}  → {TRAIN_FILE}")
    print(f"  Valid          : {n_valid}  → {VALID_FILE}")
    print("\nDone.")


if __name__ == "__main__":
    main()
