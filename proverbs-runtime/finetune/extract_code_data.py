#!/usr/bin/env python3
"""
extract_code_data.py — Build fine-tuning data from your actual projects.

Walks every registered project, splits code files into instruction/completion
pairs, and merges with any saved Proverbs session history.

Output: ~/.proverbs/finetune_data.jsonl
"""

from __future__ import annotations

import json
import os
import random
import re
import sys
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────

PROVERBS_DIR   = Path.home() / ".proverbs"
PROJECTS_FILE  = PROVERBS_DIR / "projects.json"
SESSIONS_DIR   = PROVERBS_DIR / "sessions"
OUTPUT_FILE    = PROVERBS_DIR / "finetune_data.jsonl"

RANDOM_SEED    = 42
MIN_FILE_LINES = 20       # skip very short files
MAX_FILE_CHARS = 12_000   # skip huge files (minified etc.)
MIN_SPLIT_LINE = 10       # always keep at least 10 lines as context
COMPLETION_RATIO = 0.40   # bottom 40% of each file is the "completion" target

CODE_EXTS = {
    ".js", ".jsx", ".ts", ".tsx", ".py", ".mjs", ".cjs",
    ".css", ".scss", ".html", ".json", ".md",
    ".sh", ".yml", ".yaml", ".toml",
}

SKIP_DIRS = {
    "node_modules", ".git", "dist", ".next", "build", "out",
    ".cache", "coverage", "__pycache__", ".venv", "venv",
    "venv_llm", ".turbo", ".vercel",
}

SKIP_PATTERNS = [
    re.compile(r"\.min\.(js|css)$"),
    re.compile(r"package-lock\.json$"),
    re.compile(r"yarn\.lock$"),
    re.compile(r"pnpm-lock\.yaml$"),
]


# ── Helpers ───────────────────────────────────────────────────────────────────

def is_skipped_path(p: Path) -> bool:
    for part in p.parts:
        if part in SKIP_DIRS:
            return True
    name = p.name
    return any(pat.search(name) for pat in SKIP_PATTERNS)


def lang_name(ext: str) -> str:
    return {
        ".js": "JavaScript", ".jsx": "JavaScript (React)",
        ".ts": "TypeScript", ".tsx": "TypeScript (React)",
        ".py": "Python", ".mjs": "JavaScript (ESM)", ".cjs": "JavaScript (CJS)",
        ".css": "CSS", ".scss": "SCSS", ".html": "HTML",
        ".json": "JSON", ".md": "Markdown",
        ".sh": "Bash", ".yml": "YAML", ".yaml": "YAML", ".toml": "TOML",
    }.get(ext, ext.lstrip(".").upper())


def make_completion_example(file_path: Path, content: str) -> dict | None:
    lines = content.splitlines()
    if len(lines) < MIN_FILE_LINES:
        return None
    split = max(MIN_SPLIT_LINE, int(len(lines) * (1 - COMPLETION_RATIO)))
    context    = "\n".join(lines[:split])
    completion = "\n".join(lines[split:])
    if not completion.strip():
        return None
    lang  = lang_name(file_path.suffix)
    rel   = str(file_path)
    return {
        "messages": [
            {
                "role": "system",
                "content": "You are an expert coding assistant. Complete the given code exactly as the original developer would.",
            },
            {
                "role": "user",
                "content": f"Complete this {lang} file (`{rel}`):\n\n```{file_path.suffix.lstrip('.')}\n{context}\n```",
            },
            {
                "role": "assistant",
                "content": f"```{file_path.suffix.lstrip('.')}\n{completion}\n```",
            },
        ]
    }


def collect_project_examples(project_path: Path) -> list[dict]:
    examples = []
    for root, dirs, files in os.walk(project_path):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fname in files:
            fp = Path(root) / fname
            if fp.suffix.lower() not in CODE_EXTS:
                continue
            if is_skipped_path(fp):
                continue
            try:
                content = fp.read_text(encoding="utf-8", errors="ignore")
            except Exception:
                continue
            if not content.strip() or len(content) > MAX_FILE_CHARS:
                continue
            ex = make_completion_example(fp.relative_to(project_path), content)
            if ex:
                examples.append(ex)
    return examples


def collect_session_examples() -> list[dict]:
    examples = []
    if not SESSIONS_DIR.exists():
        return examples
    for fp in sorted(SESSIONS_DIR.glob("*.jsonl")):
        try:
            for line in fp.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                obj = json.loads(line)
                msgs = obj.get("messages", [])
                if not msgs:
                    continue
                # Keep only turns where assistant gave a substantive reply
                assistant_content = next(
                    (m.get("content", "") for m in msgs if m.get("role") == "assistant"), ""
                )
                if len(assistant_content.strip()) >= 40:
                    examples.append({"messages": msgs})
        except Exception:
            continue
    return examples


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    random.seed(RANDOM_SEED)

    print("=== Proverbs: Extract Fine-Tune Data ===\n")

    # Load project registry
    if not PROJECTS_FILE.exists():
        print("[warn] No projects.json found. Run: node finetune/scan_projects.js")
        projects = {}
    else:
        projects = json.loads(PROJECTS_FILE.read_text())

    all_examples: list[dict] = []

    # Code completion examples from projects
    print(f"Scanning {len(projects)} projects...")
    for name, path_str in projects.items():
        p = Path(path_str)
        if not p.exists():
            continue
        exs = collect_project_examples(p)
        print(f"  {name:<35} {len(exs):>4} examples")
        all_examples.extend(exs)

    # Session history examples
    print("\nLoading session history...")
    session_exs = collect_session_examples()
    print(f"  {len(session_exs)} session examples")
    all_examples.extend(session_exs)

    if not all_examples:
        print("\n[error] No examples found. Nothing to write.")
        sys.exit(1)

    # Shuffle and deduplicate by first-message content
    random.shuffle(all_examples)
    seen: set[str] = set()
    deduped: list[dict] = []
    for ex in all_examples:
        key = ex["messages"][1]["content"][:200] if len(ex["messages"]) > 1 else ""
        if key not in seen:
            seen.add(key)
            deduped.append(ex)

    PROVERBS_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        for ex in deduped:
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")

    print(f"\n✓  {len(deduped)} examples → {OUTPUT_FILE}")
    print(f"   (removed {len(all_examples) - len(deduped)} duplicates)")


if __name__ == "__main__":
    main()
