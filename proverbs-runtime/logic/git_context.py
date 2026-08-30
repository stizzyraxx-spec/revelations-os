"""
logic/git_context.py — Automatic git state injection into system prompt.

Collects branch, status, diff, and recent log from the working directory and
prepends a compact block to the system message before every request.

Usage:
    from logic.git_context import git_context

    messages = [{"role": "user", "content": "what did I just change?"}]
    messages = git_context.inject(messages)
"""

from __future__ import annotations

import copy
import os
import subprocess


class GitContext:
    def __init__(self, max_diff_lines: int = 80, max_log_entries: int = 5) -> None:
        self.max_diff_lines = max_diff_lines
        self.max_log_entries = max_log_entries

    def _run(self, *args: str, cwd: str = None) -> str:
        try:
            result = subprocess.run(
                ["git", *args],
                capture_output=True,
                text=True,
                cwd=cwd or os.getcwd(),
                timeout=5,
            )
            return result.stdout.strip()
        except Exception:
            return ""

    def is_git_repo(self, cwd: str = None) -> bool:
        out = self._run("rev-parse", "--is-inside-work-tree", cwd=cwd)
        return out == "true"

    def get_branch(self, cwd: str = None) -> str:
        return self._run("rev-parse", "--abbrev-ref", "HEAD", cwd=cwd)

    def get_status(self, cwd: str = None) -> str:
        return self._run("status", "--short", cwd=cwd)

    def get_diff(self, cwd: str = None) -> str:
        stat = self._run("diff", "HEAD", "--stat", cwd=cwd)
        full = self._run("diff", "HEAD", cwd=cwd)
        lines = full.splitlines()
        if len(lines) > self.max_diff_lines:
            lines = lines[: self.max_diff_lines]
            lines.append(f"... (truncated, {len(full.splitlines()) - self.max_diff_lines} more lines)")
        diff_body = "\n".join(lines)
        parts = [p for p in (stat, diff_body) if p]
        return "\n".join(parts)

    def get_log(self, cwd: str = None) -> str:
        return self._run("log", "--oneline", f"-{self.max_log_entries}", cwd=cwd)

    def build_context_block(self, cwd: str = None) -> str:
        if not self.is_git_repo(cwd=cwd):
            return ""

        branch = self.get_branch(cwd=cwd)
        status = self.get_status(cwd=cwd)
        log = self.get_log(cwd=cwd)

        if not branch and not status and not log:
            return ""

        lines: list[str] = []

        # Header line: branch + changed-file count from status
        if status:
            changed_files = [l for l in status.splitlines() if l.strip()]
            header = f"Git: branch={branch} | {len(changed_files)} file{'s' if len(changed_files) != 1 else ''} changed"
        else:
            header = f"Git: branch={branch} | clean"
        lines.append(header)

        # Recent commits
        if log:
            log_lines = log.splitlines()
            for i, entry in enumerate(log_lines):
                prefix = "Recent: " if i == 0 else "        "
                lines.append(f"{prefix}{entry}")

        # Unstaged / staged changes summary
        if status:
            status_lines = [l for l in status.splitlines() if l.strip()]
            file_list = ", ".join(l[3:] for l in status_lines)
            flags = ", ".join(l[:2].strip() for l in status_lines)
            lines.append(f"Unstaged: {flags} {file_list}".rstrip())

        return "\n".join(lines)

    def inject(self, messages: list[dict], cwd: str = None) -> list[dict]:
        block = self.build_context_block(cwd=cwd)
        if not block:
            return list(messages)

        result: list[dict] = copy.deepcopy(messages)

        system_idx: int | None = None
        for i, msg in enumerate(result):
            if msg.get("role") == "system":
                system_idx = i
                break

        if system_idx is not None:
            existing: str = result[system_idx].get("content") or ""
            result[system_idx]["content"] = f"{block}\n\n{existing}" if existing else block
        else:
            result.insert(0, {"role": "system", "content": block})

        return result


git_context = GitContext()
