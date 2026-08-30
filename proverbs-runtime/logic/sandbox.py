"""
logic/sandbox.py — Enhanced sandboxed code execution with AST-level danger scanning.

Provides AST-based static analysis of Python code before execution and a hardened
bash runner layered on top of the patterns already defined in logic/tools.py.
"""

from __future__ import annotations

import ast
import os
import re
import subprocess
import sys
import tempfile
from typing import Any

# ---------------------------------------------------------------------------
# Blocked import targets (module or attribute paths)
# ---------------------------------------------------------------------------

BLOCKED_IMPORTS: frozenset[str] = frozenset(
    {
        "os.system",
        "subprocess",
        "socket",
        "requests",
        "urllib",
        "ftplib",
        "smtplib",
        "telnetlib",
        "xmlrpc",
        "pickle",
        "marshal",
        "ctypes",
        "cffi",
    }
)

# ---------------------------------------------------------------------------
# Blocked builtins (names that must not appear as calls)
# ---------------------------------------------------------------------------

BLOCKED_BUILTINS: frozenset[str] = frozenset(
    {
        "__import__",
        "eval",
        "exec",
        "compile",
        "open",
        "input",
    }
)

# ---------------------------------------------------------------------------
# Bash patterns inherited from tools.py + additional escapes
# ---------------------------------------------------------------------------

_BASE_BASH_PATTERNS: list[re.Pattern[str]] = [
    re.compile(p, re.IGNORECASE)
    for p in [
        r"\brm\s+-[a-z]*r[a-z]*f",
        r"\brm\s+-[a-z]*f[a-z]*r",
        r":\s*\(\s*\)\s*\{",
        r"\bmkfs\b",
        r"\bdd\b.*\bof=/dev/",
        r"\bshred\b",
        r">\s*/dev/sd",
        r"\bchmod\s+-[a-z]*R",
        r"\bchown\s+-[a-z]*R",
        r"\bsudo\b",
        r"\bsu\b\s",
        r"\bcurl\b.*\|\s*(ba)?sh",
        r"\bwget\b.*\|\s*(ba)?sh",
    ]
]

_EXTRA_BASH_PATTERNS: list[re.Pattern[str]] = [
    re.compile(p, re.IGNORECASE)
    for p in [
        # netcat variants
        r"\bnc\b",
        r"\bncat\b",
        r"\bnmap\b",
        # curl with an explicit method flag (often used for exfil)
        r"\bcurl\b[^|]*-X\s",
        # wget posting data
        r"\bwget\b[^|]*--post(?:-data|-file)",
        # write to /etc
        r">\s*/etc/",
        r">>\s*/etc/",
        # python -c with eval or exec
        r"\bpython[23]?\b[^|]*-c[^|]*\b(?:eval|exec)\b",
    ]
]

_ALL_BASH_PATTERNS: list[re.Pattern[str]] = _BASE_BASH_PATTERNS + _EXTRA_BASH_PATTERNS


# ---------------------------------------------------------------------------
# AST danger scanner
# ---------------------------------------------------------------------------

def _module_blocked(name: str) -> bool:
    """Return True if *name* (or any of its parent packages) is in BLOCKED_IMPORTS."""
    parts = name.split(".")
    for length in range(1, len(parts) + 1):
        candidate = ".".join(parts[:length])
        if candidate in BLOCKED_IMPORTS:
            return True
    return False


def scan_code_for_dangers(code: str) -> list[str]:
    """Parse *code* with the AST and return a list of danger descriptions.

    Returns an empty list when the code is considered safe enough to run.
    A non-empty list means execution should be blocked; each entry describes
    one detected threat.
    """
    dangers: list[str] = []

    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        # A broken AST cannot be executed anyway; surface the parse error.
        dangers.append(f"syntax error: {exc}")
        return dangers

    for node in ast.walk(tree):
        # -----------------------------------------------------------------
        # Blocked imports — ast.Import / ast.ImportFrom
        # -----------------------------------------------------------------
        if isinstance(node, ast.Import):
            for alias in node.names:
                if _module_blocked(alias.name):
                    dangers.append(f"blocked import: {alias.name}")

        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            # "from subprocess import run" → check the module
            if _module_blocked(module):
                dangers.append(f"blocked import: {module}")
            # "from os import system" → check fully qualified form
            for alias in node.names:
                fq = f"{module}.{alias.name}" if module else alias.name
                if _module_blocked(fq):
                    dangers.append(f"blocked import: {fq}")

        # -----------------------------------------------------------------
        # Blocked builtins used as function calls
        # -----------------------------------------------------------------
        elif isinstance(node, ast.Call):
            # Direct call: eval(...), exec(...), open(...), __import__(...)
            if isinstance(node.func, ast.Name):
                if node.func.id in BLOCKED_BUILTINS:
                    dangers.append(f"blocked builtin call: {node.func.id}()")

            # Attribute call: builtins.eval(...), io.open(...)
            elif isinstance(node.func, ast.Attribute):
                if node.func.attr in BLOCKED_BUILTINS:
                    dangers.append(
                        f"blocked builtin call via attribute: {node.func.attr}()"
                    )

        # -----------------------------------------------------------------
        # __builtins__ manipulation
        # -----------------------------------------------------------------
        elif isinstance(node, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
            targets: list[Any] = []
            if isinstance(node, ast.Assign):
                targets = node.targets
            elif isinstance(node, (ast.AugAssign, ast.AnnAssign)):
                if node.target is not None:
                    targets = [node.target]

            for target in targets:
                name = None
                if isinstance(target, ast.Name):
                    name = target.id
                elif isinstance(target, ast.Attribute):
                    name = target.attr
                if name in ("__builtins__", "__globals__"):
                    dangers.append(f"__builtins__/__globals__ tampering via assignment to '{name}'")

        # -----------------------------------------------------------------
        # sys.modules tampering — subscript assign or .update / .pop on it
        # -----------------------------------------------------------------
        elif isinstance(node, ast.Subscript):
            # sys.modules["x"] = ...  detected via parent context (assign)
            if (
                isinstance(node.value, ast.Attribute)
                and node.value.attr == "modules"
                and isinstance(node.value.value, ast.Name)
                and node.value.value.id == "sys"
            ):
                dangers.append("sys.modules subscript access (potential module tampering)")

        # Call: sys.modules.update / sys.modules.pop / sys.modules.clear
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Attribute) and node.func.attr in (
                "update",
                "pop",
                "clear",
                "__setitem__",
            ):
                val = node.func.value
                if (
                    isinstance(val, ast.Attribute)
                    and val.attr == "modules"
                    and isinstance(val.value, ast.Name)
                    and val.value.id == "sys"
                ):
                    dangers.append(
                        f"sys.modules.{node.func.attr}() call (potential module tampering)"
                    )

        # -----------------------------------------------------------------
        # open() called with write mode
        # -----------------------------------------------------------------
        if isinstance(node, ast.Call):
            is_open = (
                (isinstance(node.func, ast.Name) and node.func.id == "open")
                or (
                    isinstance(node.func, ast.Attribute)
                    and node.func.attr == "open"
                )
            )
            if is_open and len(node.args) >= 2:
                mode_node = node.args[1]
                if isinstance(mode_node, ast.Constant) and isinstance(
                    mode_node.value, str
                ):
                    if any(c in mode_node.value for c in ("w", "a", "x", "+")):
                        dangers.append(
                            f"open() called with write/append mode '{mode_node.value}'"
                        )
            # keyword form: open(path, mode="w")
            if is_open:
                for kw in node.keywords:
                    if kw.arg == "mode" and isinstance(kw.value, ast.Constant):
                        mode = kw.value.value
                        if isinstance(mode, str) and any(
                            c in mode for c in ("w", "a", "x", "+")
                        ):
                            dangers.append(
                                f"open() called with write/append mode '{mode}'"
                            )

        # -----------------------------------------------------------------
        # Network socket creation: socket.socket(...)
        # -----------------------------------------------------------------
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Attribute) and node.func.attr == "socket":
                dangers.append("network socket creation via socket.socket()")
            # socket() bare call after "from socket import socket"
            if isinstance(node.func, ast.Name) and node.func.id == "socket":
                dangers.append("network socket creation via bare socket() call")

        # -----------------------------------------------------------------
        # Process spawning: os.system / subprocess.* / os.popen / os.exec*
        # -----------------------------------------------------------------
        if isinstance(node, ast.Call):
            func = node.func
            # os.system(...), os.popen(...), os.execv(...), os.spawn*(...)
            if (
                isinstance(func, ast.Attribute)
                and isinstance(func.value, ast.Name)
                and func.value.id == "os"
                and func.attr
                in (
                    "system",
                    "popen",
                    "execv",
                    "execve",
                    "execvp",
                    "execvpe",
                    "execlp",
                    "execl",
                    "execle",
                    "spawnl",
                    "spawnle",
                    "spawnlp",
                    "spawnlpe",
                    "spawnv",
                    "spawnve",
                    "spawnvp",
                    "spawnvpe",
                )
            ):
                dangers.append(f"process spawning via os.{func.attr}()")

            # subprocess.*
            if isinstance(func, ast.Attribute) and isinstance(
                func.value, ast.Name
            ):
                if func.value.id == "subprocess":
                    dangers.append(f"process spawning via subprocess.{func.attr}()")

            # bare calls after "from subprocess import run" etc.
            if isinstance(func, ast.Name) and func.id in (
                "Popen",
                "call",
                "run",
                "check_call",
                "check_output",
                "getoutput",
                "getstatusoutput",
            ):
                dangers.append(f"possible process spawning via {func.id}()")

    return dangers


# ---------------------------------------------------------------------------
# Minimal environment helper
# ---------------------------------------------------------------------------

def _sandboxed_env() -> dict[str, str]:
    return {
        "PATH": "/usr/bin:/bin",
        "HOME": "/tmp",
        "PYTHONPATH": "",
    }


# ---------------------------------------------------------------------------
# Python sandbox runner
# ---------------------------------------------------------------------------

def run_sandboxed_python(code: str, timeout: int = 10) -> dict:
    """Run *code* in a sandboxed Python subprocess.

    Steps:
    1. Statically scan with :func:`scan_code_for_dangers`.
    2. If dangerous, return immediately with ``blocked=True``.
    3. Otherwise write to a temp file and execute with a minimal environment.

    Returns a dict with keys: stdout, stderr, returncode, timed_out, blocked.
    """
    dangers = scan_code_for_dangers(code)
    if dangers:
        return {
            "stdout": "",
            "stderr": "BLOCKED: " + str(dangers),
            "returncode": 1,
            "timed_out": False,
            "blocked": True,
        }

    env = _sandboxed_env()

    tmpfile: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", dir="/tmp", delete=False
        ) as f:
            f.write(code)
            tmpfile = f.name

        proc = subprocess.run(
            [sys.executable, tmpfile],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd="/tmp",
            env=env,
        )
        return {
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "returncode": proc.returncode,
            "timed_out": False,
            "blocked": False,
        }

    except subprocess.TimeoutExpired:
        return {
            "stdout": "",
            "stderr": f"timed out after {timeout}s",
            "returncode": -1,
            "timed_out": True,
            "blocked": False,
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "stdout": "",
            "stderr": str(exc),
            "returncode": -1,
            "timed_out": False,
            "blocked": False,
        }
    finally:
        if tmpfile is not None:
            try:
                os.unlink(tmpfile)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Bash sandbox runner
# ---------------------------------------------------------------------------

def run_sandboxed_bash(code: str, timeout: int = 10) -> dict:
    """Run a bash snippet with pattern-based safety filtering.

    Applies all patterns from logic/tools.py plus additional escape vectors.
    Execution happens with a minimal environment rooted in /tmp.

    Returns a dict with keys: stdout, stderr, returncode, timed_out, blocked.
    """
    for pattern in _ALL_BASH_PATTERNS:
        if pattern.search(code):
            return {
                "stdout": "",
                "stderr": f"BLOCKED: command matched safety filter '{pattern.pattern}'",
                "returncode": 1,
                "timed_out": False,
                "blocked": True,
            }

    env = _sandboxed_env()

    try:
        proc = subprocess.run(
            ["bash", "-c", code],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd="/tmp",
            env=env,
            shell=False,
        )
        return {
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "returncode": proc.returncode,
            "timed_out": False,
            "blocked": False,
        }

    except subprocess.TimeoutExpired:
        return {
            "stdout": "",
            "stderr": f"timed out after {timeout}s",
            "returncode": -1,
            "timed_out": True,
            "blocked": False,
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "stdout": "",
            "stderr": str(exc),
            "returncode": -1,
            "timed_out": False,
            "blocked": False,
        }
