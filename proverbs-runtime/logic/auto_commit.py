"""
logic/auto_commit.py — Model-generated commit messages and changelog entries.

Uses the ProverbsGenerator to write conventional commit messages and
Keep-a-Changelog entries from the current staged diff.

Usage::

    from inference.generate import ProverbsGenerator
    from logic.auto_commit import auto_commit

    result = auto_commit(generator, stage_all=True)
    print(result["message"])
"""

from __future__ import annotations

import subprocess
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from inference.generate import ProverbsGenerator


# ---------------------------------------------------------------------------
# Git helpers
# ---------------------------------------------------------------------------


def get_staged_diff() -> str:
    """Return a combined stat + full diff of the index, or '' if nothing staged.

    Runs ``git diff --cached --stat`` followed by ``git diff --cached`` and
    joins their output.  The full diff is capped at 200 lines to avoid
    overwhelming the model context.
    """
    try:
        stat_result = subprocess.run(
            ["git", "diff", "--cached", "--stat"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        full_result = subprocess.run(
            ["git", "diff", "--cached"],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return ""

    stat_output = stat_result.stdout.strip()
    full_output = full_result.stdout

    if not stat_output and not full_output.strip():
        return ""

    # Cap full diff at 200 lines.
    full_lines = full_output.splitlines()
    if len(full_lines) > 200:
        full_lines = full_lines[:200]
        full_lines.append("... [diff truncated at 200 lines]")
    full_trimmed = "\n".join(full_lines)

    parts: list[str] = []
    if stat_output:
        parts.append(stat_output)
    if full_trimmed.strip():
        parts.append(full_trimmed)

    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# Generation helpers
# ---------------------------------------------------------------------------


def generate_commit_message(generator: "ProverbsGenerator", diff: str) -> str:
    """Generate a conventional commit message subject line from *diff*.

    Prompts the model with the diff, samples at temperature 0.3 with at most
    80 new tokens, extracts the first non-empty line, and truncates it to 72
    characters.
    """
    prompt = (
        "Write a concise git commit message (max 72 chars subject line) for "
        "this diff. Format: type: description where type is one of "
        "feat/fix/refactor/docs/test/chore.\n\n"
        f"Diff:\n{diff}"
    )

    raw: str = generator.generate(
        prompt=prompt,
        temperature=0.3,
        max_new_tokens=80,
    )  # type: ignore[assignment]

    # Extract the first non-empty line and truncate to 72 chars.
    for line in raw.splitlines():
        line = line.strip()
        if line:
            return line[:72]

    return "chore: update files"


def generate_changelog_entry(
    generator: "ProverbsGenerator",
    diff: str,
    version: str | None = None,
) -> str:
    """Generate a Keep a Changelog entry from *diff*.

    Args:
        generator: A ProverbsGenerator instance.
        diff:      Staged diff text (from :func:`get_staged_diff`).
        version:   Optional version string to include in the header
                   (e.g. ``"1.2.0"``).  When omitted the entry has no
                   version header.

    Returns:
        A formatted changelog entry string.
    """
    version_hint = f" for version {version}" if version else ""
    prompt = (
        f"Write a changelog entry{version_hint} in Keep a Changelog format "
        "for these changes. Use sections like ### Added, ### Changed, "
        "### Fixed as appropriate.\n\n"
        f"Diff:\n{diff}"
    )

    raw: str = generator.generate(
        prompt=prompt,
        temperature=0.3,
        max_new_tokens=200,
    )  # type: ignore[assignment]

    return raw.strip()


# ---------------------------------------------------------------------------
# High-level auto_commit
# ---------------------------------------------------------------------------


def auto_commit(
    generator: "ProverbsGenerator",
    message: str | None = None,
    stage_all: bool = False,
) -> dict:
    """Stage changes (optionally), generate a commit message, and commit.

    Args:
        generator:  A ProverbsGenerator instance used to write the message
                    when *message* is None.
        message:    Explicit commit message.  When None the model generates
                    one from the staged diff.
        stage_all:  When True, runs ``git add -A`` before reading the diff.

    Returns:
        A dict with keys:

        * ``success`` (bool) — whether the commit succeeded.
        * ``message`` (str) — the commit message used (or error reason).
        * ``diff_stat`` (str) — the ``--stat`` portion of the staged diff
          (empty string on failure).
        * ``reason`` (str, only on failure) — human-readable failure reason.
    """
    # Optionally stage everything.
    if stage_all:
        try:
            subprocess.run(
                ["git", "add", "-A"],
                capture_output=True,
                text=True,
                timeout=15,
                check=True,
            )
        except subprocess.CalledProcessError as exc:
            return {
                "success": False,
                "message": "",
                "diff_stat": "",
                "reason": f"git add -A failed: {exc.stderr.strip()}",
            }
        except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
            return {
                "success": False,
                "message": "",
                "diff_stat": "",
                "reason": f"git add -A error: {exc}",
            }

    diff = get_staged_diff()
    if not diff:
        return {
            "success": False,
            "message": "",
            "diff_stat": "",
            "reason": "nothing staged",
        }

    # Extract stat portion (everything before the first blank line that
    # precedes the actual diff hunks, i.e. the first block).
    diff_stat = diff.split("\n\n")[0] if "\n\n" in diff else diff

    # Generate message if not supplied.
    if message is None:
        message = generate_commit_message(generator, diff)

    # Run the commit.
    try:
        result = subprocess.run(
            ["git", "commit", "-m", message],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        return {
            "success": False,
            "message": message,
            "diff_stat": diff_stat,
            "reason": f"git commit error: {exc}",
        }

    if result.returncode != 0:
        return {
            "success": False,
            "message": message,
            "diff_stat": diff_stat,
            "reason": result.stderr.strip() or result.stdout.strip(),
        }

    return {
        "success": True,
        "message": message,
        "diff_stat": diff_stat,
    }
