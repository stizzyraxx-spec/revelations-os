"""
logic/diff_editor.py — Generate and apply unified diffs instead of full rewrites.
"""

from __future__ import annotations

import difflib
import re
from pathlib import Path


PROMPT_FRAGMENT = (
    "When editing existing files, output a unified diff instead of the full file content.\n"
    "Format: --- a/filename\n+++ b/filename\n@@ ... @@ context lines here\n"
    "This is preferred for any file longer than 50 lines."
)


def make_diff(original: str, modified: str, filepath: str = "file") -> str:
    """Return a unified diff string between original and modified."""
    orig_lines = original.splitlines(keepends=True)
    mod_lines = modified.splitlines(keepends=True)
    diff_lines = difflib.unified_diff(
        orig_lines,
        mod_lines,
        fromfile=f"a/{filepath}",
        tofile=f"b/{filepath}",
    )
    return "".join(diff_lines)


def apply_diff(original: str, diff_text: str) -> str:
    """Apply a unified diff to original and return the modified string."""
    orig_lines = original.splitlines(keepends=True)
    result: list[str] = []
    src_pos = 0  # 0-based index into orig_lines

    hunk_re = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
    lines = diff_text.splitlines(keepends=True)

    # Skip file header (--- / +++ lines).
    i = 0
    while i < len(lines) and not lines[i].startswith("@@"):
        i += 1

    while i < len(lines):
        m = hunk_re.match(lines[i])
        if not m:
            i += 1
            continue

        src_start = int(m.group(1)) - 1  # convert to 0-based
        src_count = int(m.group(2)) if m.group(2) is not None else 1
        i += 1

        # Flush unchanged lines before this hunk.
        if src_pos < src_start:
            result.extend(orig_lines[src_pos:src_start])
            src_pos = src_start

        hunk_src_consumed = 0
        hunk_body: list[str] = []

        while i < len(lines) and not lines[i].startswith("@@"):
            line = lines[i]
            if line.startswith("-"):
                # Validate context.
                if src_pos + hunk_src_consumed >= len(orig_lines):
                    raise ValueError(
                        f"Diff conflict: hunk removes line past end of file at original line "
                        f"{src_pos + hunk_src_consumed + 1}"
                    )
                expected = orig_lines[src_pos + hunk_src_consumed]
                actual = line[1:]
                if actual != expected:
                    raise ValueError(
                        f"Diff conflict at original line {src_pos + hunk_src_consumed + 1}: "
                        f"expected {expected!r}, got {actual!r}"
                    )
                hunk_src_consumed += 1
            elif line.startswith("+"):
                hunk_body.append(line[1:])
            else:
                # Context line (space or bare newline).
                content = line[1:] if line.startswith(" ") else line
                if src_pos + hunk_src_consumed >= len(orig_lines):
                    raise ValueError(
                        f"Diff conflict: context line past end of file at original line "
                        f"{src_pos + hunk_src_consumed + 1}"
                    )
                expected = orig_lines[src_pos + hunk_src_consumed]
                if content != expected:
                    raise ValueError(
                        f"Diff conflict (context) at original line {src_pos + hunk_src_consumed + 1}: "
                        f"expected {expected!r}, got {content!r}"
                    )
                hunk_body.append(content)
                hunk_src_consumed += 1
            i += 1

        if hunk_src_consumed != src_count:
            raise ValueError(
                f"Diff conflict: hunk claims {src_count} source lines but consumed {hunk_src_consumed}"
            )

        result.extend(hunk_body)
        src_pos += hunk_src_consumed

    # Flush remaining unchanged lines.
    result.extend(orig_lines[src_pos:])
    return "".join(result)


def extract_diff_from_response(response: str) -> str | None:
    """Return diff text found inside ```diff fences or starting with '--- ', else None."""
    fenced = re.search(r"```diff\s*\n(.*?)```", response, re.DOTALL)
    if fenced:
        return fenced.group(1)

    bare = re.search(r"(^|\n)(--- .+)", response)
    if bare:
        start = response.index(bare.group(2))
        return response[start:]

    return None


def apply_diff_to_file(filepath: str, diff_text: str) -> dict:
    """Read file at filepath, apply diff_text, write back. Return result dict."""
    path = Path(filepath).expanduser()
    try:
        original = path.read_text(encoding="utf-8")
    except OSError as exc:
        return {"filepath": filepath, "lines_added": 0, "lines_removed": 0, "success": False, "error": str(exc)}

    try:
        modified = apply_diff(original, diff_text)
    except ValueError as exc:
        return {"filepath": filepath, "lines_added": 0, "lines_removed": 0, "success": False, "error": str(exc)}

    orig_lines = original.splitlines()
    mod_lines = modified.splitlines()
    lines_added = sum(1 for l in difflib.ndiff(orig_lines, mod_lines) if l.startswith("+ "))
    lines_removed = sum(1 for l in difflib.ndiff(orig_lines, mod_lines) if l.startswith("- "))

    try:
        path.write_text(modified, encoding="utf-8")
    except OSError as exc:
        return {"filepath": filepath, "lines_added": 0, "lines_removed": 0, "success": False, "error": str(exc)}

    return {
        "filepath": filepath,
        "lines_added": lines_added,
        "lines_removed": lines_removed,
        "success": True,
        "error": None,
    }
