"""
logic/test_generator.py — Auto-generate and run pytest unit tests for Python functions.

Uses the model to write 3 pytest unit tests per function (normal, edge, error cases),
executes them in a subprocess, and returns pass/fail counts as a reward signal.
"""

from __future__ import annotations

import ast
import os
import re
import subprocess
import sys
import tempfile
import textwrap
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from inference.generate import ProverbsGenerator


# ---------------------------------------------------------------------------
# AST-based function extraction
# ---------------------------------------------------------------------------

def extract_functions(source: str) -> list[dict]:
    """Parse *source* with ast.parse and return metadata for every FunctionDef.

    Returns a list of dicts with keys:
        name       — function name
        args       — list of argument names
        docstring  — first string literal in the body (or empty string)
        source     — the raw source lines for that function
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []

    source_lines = source.splitlines(keepends=True)
    results: list[dict] = []

    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef):
            continue

        # Argument names (positional + keyword-only, skip *args/**kwargs names)
        args: list[str] = [a.arg for a in node.args.args]
        if node.args.vararg:
            args.append(f"*{node.args.vararg.arg}")
        for a in node.args.kwonlyargs:
            args.append(a.arg)
        if node.args.kwarg:
            args.append(f"**{node.args.kwarg.arg}")

        # Docstring
        docstring = ast.get_docstring(node) or ""

        # Recover source text via line numbers
        start = node.lineno - 1          # ast lines are 1-based
        end = node.end_lineno            # end_lineno is 1-based inclusive
        func_source = "".join(source_lines[start:end])

        results.append(
            {
                "name": node.name,
                "args": args,
                "docstring": docstring,
                "source": func_source,
            }
        )

    return results


# ---------------------------------------------------------------------------
# Prompt builder
# ---------------------------------------------------------------------------

def generate_test_prompt(func_info: dict) -> str:
    """Return a prompt asking the model for 3 pytest tests for *func_info*."""
    source = func_info["source"]
    return (
        f"Write 3 pytest unit tests for this function: {source}. "
        "Include normal cases, edge cases (empty/None/zero), and error cases."
    )


# ---------------------------------------------------------------------------
# Test runner
# ---------------------------------------------------------------------------

_PASSED_RE = re.compile(r"(\d+)\s+passed")
_FAILED_RE = re.compile(r"(\d+)\s+failed")
_ERROR_RE  = re.compile(r"(\d+)\s+error")


def run_tests(test_code: str, original_code: str, timeout: int = 10) -> dict:
    """Write *original_code* + *test_code* to a temp file and run pytest on it.

    Returns:
        passed    — number of tests that passed
        failed    — number of tests that failed
        errors    — number of collection/setup errors
        output    — combined stdout + stderr from pytest
        returncode — raw pytest exit code
    """
    combined = textwrap.dedent(original_code) + "\n\n" + textwrap.dedent(test_code)

    tmpfile: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", dir="/tmp", delete=False
        ) as f:
            f.write(combined)
            tmpfile = f.name

        proc = subprocess.run(
            [sys.executable, "-m", "pytest", tmpfile, "-v", "--tb=short"],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd="/tmp",
        )
        output = proc.stdout + proc.stderr

        passed = int((_PASSED_RE.search(output) or type("", (), {"group": lambda s, n: "0"})()).group(1))
        failed = int((_FAILED_RE.search(output) or type("", (), {"group": lambda s, n: "0"})()).group(1))
        errors = int((_ERROR_RE.search(output)  or type("", (), {"group": lambda s, n: "0"})()).group(1))

        # Simpler extraction using helper
        def _extract(pattern: re.Pattern[str], text: str) -> int:
            m = pattern.search(text)
            return int(m.group(1)) if m else 0

        passed = _extract(_PASSED_RE, output)
        failed = _extract(_FAILED_RE, output)
        errors = _extract(_ERROR_RE, output)

        return {
            "passed": passed,
            "failed": failed,
            "errors": errors,
            "output": output,
            "returncode": proc.returncode,
        }

    except subprocess.TimeoutExpired:
        return {
            "passed": 0,
            "failed": 0,
            "errors": 1,
            "output": f"pytest timed out after {timeout}s",
            "returncode": -1,
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "passed": 0,
            "failed": 0,
            "errors": 1,
            "output": str(exc),
            "returncode": -1,
        }
    finally:
        if tmpfile:
            try:
                os.unlink(tmpfile)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# High-level class
# ---------------------------------------------------------------------------

class TestGenerator:
    """Generate and execute pytest unit tests for Python source code."""

    def __init__(self, generator: ProverbsGenerator) -> None:
        self.generator = generator

    # ------------------------------------------------------------------
    # Core method
    # ------------------------------------------------------------------

    def generate_and_run(
        self, source_code: str, func_name: str | None = None
    ) -> list[dict]:
        """Extract functions from *source_code*, generate tests, and run them.

        If *func_name* is given, only that function is processed.

        Returns a list of result dicts, one per function::

            {
                "func_name":  str,
                "tests_code": str,          # model-generated test source
                "results":    dict,         # from run_tests()
                "reward":     float,        # passed / (passed+failed+errors+0.01)
            }
        """
        functions = extract_functions(source_code)
        if not functions:
            return []

        if func_name is not None:
            functions = [f for f in functions if f["name"] == func_name]
            if not functions:
                return []

        output: list[dict] = []

        for func_info in functions:
            prompt = generate_test_prompt(func_info)
            raw_response: str = self.generator.generate(prompt)

            # Extract a python code block from the response if present;
            # fall back to the full response text.
            tests_code = _extract_python_block(raw_response)

            results = run_tests(tests_code, func_info["source"])

            passed = results["passed"]
            failed = results["failed"]
            errors = results["errors"]
            reward = passed / (passed + failed + errors + 0.01)

            output.append(
                {
                    "func_name": func_info["name"],
                    "tests_code": tests_code,
                    "results": results,
                    "reward": reward,
                }
            )

        return output

    # ------------------------------------------------------------------
    # Reward helper
    # ------------------------------------------------------------------

    def generate_reward(self, source_code: str) -> float:
        """Return the mean reward across all functions in *source_code*.

        Reward per function = passed / (passed + failed + errors + 0.01).
        Returns 0.0 if no functions are found.
        """
        results = self.generate_and_run(source_code)
        if not results:
            return 0.0
        return sum(r["reward"] for r in results) / len(results)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

_PY_FENCE_RE = re.compile(
    r"```(?:python)?\n(.*?)```",
    re.DOTALL | re.IGNORECASE,
)


def _extract_python_block(text: str) -> str:
    """Return the first fenced python block in *text*, or *text* itself."""
    m = _PY_FENCE_RE.search(text)
    return m.group(1) if m else text
