#!/usr/bin/env python3
"""
extract_codebase_training_data.py — Convert all 50 RAXX projects into
LoRA fine-tuning training examples.

Scans every source file across all projects and creates instruction-following
examples in the format the model needs to learn:
  - "Given this project context, write this component"
  - "Given this schema, write this API route"
  - "Given this component, write its test"
  etc.

Output: ~/.proverbs/pretrain_data/raxx_codebase.jsonl
Total expected: ~50,000-200,000 high-quality training examples

Usage:
    python scripts/extract_codebase_training_data.py
    python scripts/extract_codebase_training_data.py --projects-dir ~/
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
from pathlib import Path

PROJECTS_ROOT = Path.home()
OUTPUT_FILE   = Path.home() / ".proverbs" / "pretrain_data" / "raxx_codebase.jsonl"

# Source file extensions to include
CODE_EXTS = {".ts", ".tsx", ".js", ".jsx", ".py", ".prisma", ".sql", ".sh", ".yaml", ".yml", ".json"}

# Dirs to always skip
SKIP_DIRS = {
    "node_modules", ".next", "dist", "build", ".git", "__pycache__",
    "coverage", ".cache", "out", "venv", ".venv", "vendor",
    "public", "assets", ".turbo",
}

# Files to skip (generated/lock files)
SKIP_FILES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "*.min.js", "*.min.css", ".env", ".env.local",
}

# Max file size to include (skip huge generated files)
MAX_FILE_CHARS = 8000

# The 50 RAXX app directories
RAXX_APPS = [
    "admin-center", "app-template", "artistmanager", "automix",
    "black-wall-street-legacy", "bowdwn", "business-software-management-services",
    "civiccore-erp", "cloutkiller", "command-hq", "contractor-os",
    "dealerflow-pro", "fb-discover", "fb-engage", "fema-platform",
    "fitscan", "freepost", "genmed-clinical-sync", "gov-core-solutions",
    "govcoreerp", "groomtrack-pro", "grow-clout-hub", "homeowner-finder",
    "iaop-platform", "lap3000-dashboard", "leadforge", "leadforge-desktop",
    "legalvault-pro", "liquor-ledger", "mobile-barber", "mobile-massage",
    "mobile-salon", "mybartendar", "pcscanfix", "pcscanfix-web",
    "petsitter-pro", "proverbs", "rals-demo", "rals-poct", "rals-unified",
    "remote-terminal", "school-manager", "SmallBizManager", "SoldierTalk",
    "syllabus-script-space", "taxflow-pro", "tradeiqdesk", "traintrack-pro",
    "tuffbets", "vybe-engine", "WellnessCommandPlatform",
]

# Instruction templates — diverse question styles for richer training
INSTRUCTION_TEMPLATES = [
    # Direct: show file, ask what it does
    "What does this {lang} file do?\n\n```{ext}\n{content}\n```",
    # Context: show file, ask to extend it
    "Given this {lang} code in `{filepath}`:\n\n```{ext}\n{content}\n```\n\nExplain what it does and how it fits in a {stack} app.",
    # Generation: show partial, ask to complete
    "Continue this {lang} implementation:\n\n```{ext}\n{partial}\n```",
    # Pattern recognition
    "This is from a {stack} app. What pattern does it implement?\n\n```{ext}\n{content}\n```",
    # Debugging
    "Review this {lang} code for potential issues:\n\n```{ext}\n{content}\n```",
    # Stack-specific
    "{stack_question}\n\nHere's the relevant code:\n\n```{ext}\n{content}\n```",
]

STACK_QUESTIONS = {
    "prisma": [
        "How would you optimize this Prisma query?",
        "What indexes would you add to this Prisma schema?",
        "How do you handle pagination with this Prisma model?",
    ],
    "stripe": [
        "How do you handle webhook verification for this Stripe integration?",
        "What happens if the Stripe webhook fails to process?",
    ],
    "capacitor": [
        "How do you sync this web build to an iOS app with Capacitor?",
        "What native APIs could you add to this Capacitor implementation?",
    ],
    "next": [
        "Should this be a server component or client component?",
        "How would you add loading states to this Next.js page?",
        "How would you cache this Next.js API route?",
    ],
    "electron": [
        "How do you handle IPC between main and renderer for this Electron feature?",
        "How would you package this Electron app for distribution?",
    ],
    "supabase": [
        "What RLS policies would you add for this Supabase table?",
        "How do you handle real-time updates for this Supabase query?",
    ],
}

def detect_stack(project_path: Path) -> list[str]:
    """Detect the tech stack from package.json."""
    pkg_path = project_path / "package.json"
    if not pkg_path.exists():
        return ["javascript"]
    try:
        pkg = json.loads(pkg_path.read_text())
        deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
        stack = []
        if "next" in deps:          stack.append("Next.js")
        if "@prisma/client" in deps: stack.append("Prisma")
        if "@supabase/supabase-js" in deps: stack.append("Supabase")
        if "stripe" in deps:        stack.append("Stripe")
        if "@capacitor/core" in deps: stack.append("Capacitor")
        if "electron" in deps:      stack.append("Electron")
        if "react" in deps:         stack.append("React")
        if "express" in deps:       stack.append("Express")
        if "tailwindcss" in deps:   stack.append("Tailwind")
        if "drizzle-orm" in deps:   stack.append("Drizzle")
        return stack or ["Node.js"]
    except Exception:
        return ["JavaScript"]

def get_lang_name(ext: str) -> str:
    return {
        ".ts": "TypeScript", ".tsx": "TypeScript/React",
        ".js": "JavaScript", ".jsx": "JavaScript/React",
        ".py": "Python", ".prisma": "Prisma Schema",
        ".sql": "SQL", ".sh": "Bash",
        ".yaml": ".yml": "YAML", ".json": "JSON",
    }.get(ext, ext.lstrip(".").upper())

def should_skip(filepath: Path) -> bool:
    for part in filepath.parts:
        if part in SKIP_DIRS:
            return True
    if filepath.name in SKIP_FILES:
        return True
    if any(filepath.name.endswith(s.lstrip("*")) for s in SKIP_FILES if "*" in s):
        return True
    return False

def extract_interesting_section(content: str, max_chars: int = 4000) -> str:
    """Extract the most interesting part of a large file."""
    if len(content) <= max_chars:
        return content
    # Try to find main function/class/component
    patterns = [
        r"export default function\s+\w+",
        r"export default class\s+\w+",
        r"const \w+ = \(\) =>",
        r"async function\s+\w+",
        r"class \w+",
    ]
    for pat in patterns:
        m = re.search(pat, content)
        if m:
            start = max(0, m.start() - 100)
            return content[start:start + max_chars] + "\n// ... [truncated]"
    return content[:max_chars] + "\n// ... [truncated]"

def make_example(filepath: str, content: str, stack: list[str], rel_path: str) -> dict | None:
    """Create a training example from a source file."""
    ext = Path(filepath).suffix.lower()
    lang = get_lang_name(ext)
    stack_str = " + ".join(stack) if stack else "Node.js"
    ext_name = ext.lstrip(".")

    # Pick instruction style
    tmpl_idx = hash(filepath) % len(INSTRUCTION_TEMPLATES)
    template = INSTRUCTION_TEMPLATES[tmpl_idx]

    # Find stack-specific question
    stack_q = "Explain the purpose of this code in a " + stack_str + " application."
    for key, questions in STACK_QUESTIONS.items():
        if any(key in s.lower() for s in stack) or key in content.lower():
            stack_q = questions[hash(filepath + key) % len(questions)]
            break

    # Build the content snippet
    snippet = extract_interesting_section(content)

    # Build partial (first 60% of file) for completion tasks
    partial_end = int(len(snippet) * 0.6)
    partial = snippet[:partial_end]

    instruction = template.format(
        lang=lang,
        ext=ext_name,
        content=snippet,
        partial=partial,
        filepath=rel_path,
        stack=stack_str,
        stack_question=stack_q,
    )

    # Response: the actual file content with context
    response = f"This is a {lang} file in a {stack_str} application.\n\n```{ext_name}\n{snippet}\n```\n\nThis file implements the {Path(filepath).stem.replace('-', ' ').replace('_', ' ')} functionality."

    return {
        "messages": [
            {"role": "system", "content": f"You are Proverbs, an expert coding assistant. You specialize in {stack_str} applications built by RAXX BEATS STUDIOS. Be concise and precise."},
            {"role": "user", "content": instruction},
            {"role": "assistant", "content": response},
        ],
        "source": "raxx_codebase",
        "project": str(Path(filepath).parent.parent.name),
        "stack": stack,
    }

def scan_project(project_path: Path, examples: list) -> int:
    """Scan a project directory and extract training examples."""
    stack = detect_stack(project_path)
    count = 0

    for root, dirs, files in os.walk(project_path):
        # Prune skip dirs
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]

        for fname in files:
            filepath = Path(root) / fname
            ext = filepath.suffix.lower()

            if ext not in CODE_EXTS:
                continue
            if should_skip(filepath):
                continue

            try:
                content = filepath.read_text(encoding="utf-8", errors="replace")
                content = content.strip()
            except Exception:
                continue

            if len(content) < 50 or len(content) > MAX_FILE_CHARS * 3:
                continue

            rel_path = str(filepath.relative_to(project_path))
            example = make_example(str(filepath), content, stack, rel_path)
            if example:
                examples.append(example)
                count += 1

    return count


def main():
    parser = argparse.ArgumentParser(description="Extract RAXX codebase training data")
    parser.add_argument("--projects-dir", default=str(Path.home()), help="Root directory containing all projects")
    parser.add_argument("--output", default=str(OUTPUT_FILE))
    parser.add_argument("--apps", nargs="+", default=RAXX_APPS, help="App directories to scan")
    args = parser.parse_args()

    root = Path(args.projects_dir).expanduser()
    out  = Path(args.output).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)

    print("=== RAXX Codebase → Training Data ===\n")
    print(f"Scanning {len(args.apps)} apps in {root}")
    print(f"Output: {out}\n")

    all_examples = []
    total_files  = 0

    for app_name in sorted(args.apps):
        app_path = root / app_name
        if not app_path.exists():
            continue
        stack = detect_stack(app_path)
        examples_before = len(all_examples)
        n = scan_project(app_path, all_examples)
        total_files += n
        if n > 0:
            print(f"  ✔  {app_name:35s} {n:4d} files  [{', '.join(stack[:3])}]")

    # Shuffle for better training distribution
    random.shuffle(all_examples)

    print(f"\n  Total files scanned : {total_files:,}")
    print(f"  Training examples  : {len(all_examples):,}")

    # Write output
    with open(out, "w", encoding="utf-8") as f:
        for ex in all_examples:
            f.write(json.dumps(ex) + "\n")

    size_mb = out.stat().st_size / 1e6
    print(f"  Written to         : {out}  ({size_mb:.1f} MB)")
    print()
    print("This data captures your full coding style across all 50 RAXX apps.")
    print("Use it for LoRA fine-tuning to teach the model your exact patterns.")
    print()
    print("Next step:")
    print("  python scripts/prepare_lora_dataset.py  # format for LoRA training")


if __name__ == "__main__":
    main()
