"""
logic/code_runner.py — Sandboxed code execution feedback loop for ProverbsLM.

Extracts code blocks from model output, executes them in a restricted
subprocess environment, and feeds results back to the model for self-correction.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from typing import TYPE_CHECKING

from logic.sandbox import scan_code_for_dangers, run_sandboxed_bash

if TYPE_CHECKING:
    from inference.generate import ProverbsGenerator

# ---------------------------------------------------------------------------
# Blocked patterns (mirrors logic/tools.py _BLOCKED_PATTERNS)
# ---------------------------------------------------------------------------

_BLOCKED_PATTERNS: list[re.Pattern[str]] = [
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

# ---------------------------------------------------------------------------
# Fenced code block extraction
# ---------------------------------------------------------------------------

_FENCE_RE = re.compile(
    r"```(?P<lang>[a-zA-Z0-9_+-]*)\n(?P<code>.*?)```",
    re.DOTALL,
)

_SUPPORTED_LANGUAGES: frozenset[str] = frozenset({"python", "javascript", "bash", "sh"})


@dataclass
class CodeBlock:
    language: str
    code: str
    source_text: str  # raw from model output


def extract_code_blocks(text: str) -> list[CodeBlock]:
    blocks: list[CodeBlock] = []
    for match in _FENCE_RE.finditer(text):
        lang = match.group("lang").lower().strip()
        code = match.group("code")
        if lang in _SUPPORTED_LANGUAGES:
            blocks.append(CodeBlock(language=lang, code=code, source_text=match.group(0)))
    return blocks


# ---------------------------------------------------------------------------
# Minimal safe environment
# ---------------------------------------------------------------------------

def _minimal_env() -> dict[str, str]:
    path = "/usr/local/bin:/usr/bin:/bin"
    return {"PATH": path, "TMPDIR": "/tmp", "HOME": "/tmp"}


# ---------------------------------------------------------------------------
# Runners
# ---------------------------------------------------------------------------

def run_python(code: str, timeout: int = 10) -> dict:
    dangers = scan_code_for_dangers(code)
    if dangers:
        return {
            "stdout": "",
            "stderr": "Blocked: " + "; ".join(dangers),
            "returncode": 1,
            "timed_out": False,
            "error": None,
        }

    env = _minimal_env()
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".py", dir="/tmp", delete=False
    ) as f:
        f.write(code)
        tmpfile = f.name

    try:
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
            "error": None,
        }
    except subprocess.TimeoutExpired:
        return {
            "stdout": "",
            "stderr": "",
            "returncode": -1,
            "timed_out": True,
            "error": f"timed out after {timeout}s",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "stdout": "",
            "stderr": "",
            "returncode": -1,
            "timed_out": False,
            "error": str(exc),
        }
    finally:
        try:
            os.unlink(tmpfile)
        except OSError:
            pass


def run_javascript(code: str, timeout: int = 10) -> dict:
    node = shutil.which("node")
    if node is None:
        return {
            "stdout": "",
            "stderr": "",
            "returncode": -1,
            "timed_out": False,
            "error": "node not found",
        }

    env = _minimal_env()
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".js", dir="/tmp", delete=False
    ) as f:
        f.write(code)
        tmpfile = f.name

    try:
        proc = subprocess.run(
            [node, tmpfile],
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
            "error": None,
        }
    except subprocess.TimeoutExpired:
        return {
            "stdout": "",
            "stderr": "",
            "returncode": -1,
            "timed_out": True,
            "error": f"timed out after {timeout}s",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "stdout": "",
            "stderr": "",
            "returncode": -1,
            "timed_out": False,
            "error": str(exc),
        }
    finally:
        try:
            os.unlink(tmpfile)
        except OSError:
            pass


def run_bash(code: str, timeout: int = 10) -> dict:
    result = run_sandboxed_bash(code, timeout=timeout)
    # Normalise to the shape expected by the rest of this module (error key
    # instead of blocked key, empty string for error when not applicable).
    return {
        "stdout": result["stdout"],
        "stderr": result["stderr"],
        "returncode": result["returncode"],
        "timed_out": result["timed_out"],
        "error": result["stderr"] if result.get("blocked") else None,
    }


# ---------------------------------------------------------------------------
# Block dispatcher
# ---------------------------------------------------------------------------

def execute_block(block: CodeBlock) -> dict:
    if block.language == "python":
        result = run_python(block.code)
    elif block.language == "javascript":
        result = run_javascript(block.code)
    elif block.language in {"bash", "sh"}:
        result = run_bash(block.code)
    else:
        result = {
            "stdout": "",
            "stderr": "",
            "returncode": -1,
            "timed_out": False,
            "error": f"unsupported language: {block.language}",
        }

    result["language"] = block.language
    result["code_preview"] = block.code[:100]
    return result


# ---------------------------------------------------------------------------
# Formatting
# ---------------------------------------------------------------------------

def format_result(result: dict) -> str:
    lang = result.get("language", "unknown")
    rc = result.get("returncode", -1)
    timed_out = result.get("timed_out", False)
    error = result.get("error")
    stdout = result.get("stdout", "").rstrip()
    stderr = result.get("stderr", "").rstrip()

    if timed_out:
        return f"Execution timed out ({lang}):\n{error}"

    if error and rc == -1 and not stdout and not stderr:
        return f"Execution error ({lang}):\n{error}"

    if rc == 0:
        body = stdout if stdout else "(no output)"
        return f"Execution result ({lang}, exit {rc}):\n{body}"

    parts = [f"Execution failed ({lang}, exit {rc}):"]
    if stdout:
        parts.append(f"stdout: {stdout}")
    if stderr:
        parts.append(f"stderr: {stderr}")
    if error:
        parts.append(f"error: {error}")
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Feedback loop
# ---------------------------------------------------------------------------

class CodeExecutionFeedback:
    def __init__(self, generator: ProverbsGenerator, max_revision_rounds: int = 2) -> None:
        self.generator = generator
        self.max_revision_rounds = max_revision_rounds

    def run_and_feedback(self, prompt: str, response: str) -> dict:
        blocks = extract_code_blocks(response)
        if not blocks:
            return {"response": response, "executed": False, "rounds": 0}

        current_response = response
        rounds = 0

        for _ in range(self.max_revision_rounds + 1):
            blocks = extract_code_blocks(current_response)
            if not blocks:
                break

            results = [execute_block(b) for b in blocks]
            failures = [r for r in results if r.get("returncode") != 0]

            if not failures:
                return {
                    "response": current_response,
                    "executed": True,
                    "passed": True,
                    "rounds": rounds,
                }

            if rounds >= self.max_revision_rounds:
                break

            error_parts = ["The code above produced errors. Please fix it.\n"]
            for r in failures:
                error_parts.append(format_result(r))

            follow_up = "\n\n".join(error_parts)
            fix_prompt = f"{prompt}\n\n{current_response}\n\n{follow_up}"
            current_response = self.generator.generate(fix_prompt)
            rounds += 1

        return {
            "response": current_response,
            "executed": True,
            "passed": False,
            "rounds": rounds,
        }


# ---------------------------------------------------------------------------
# Global instance (initialized by inference/server.py)
# ---------------------------------------------------------------------------

code_feedback: CodeExecutionFeedback | None = None
