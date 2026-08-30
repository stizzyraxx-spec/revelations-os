"""
logic/tools.py — Tool routing layer for Proverbs LLM.

Detects when the model emits a <tool_call>...</tool_call> block, dispatches
to the registered handler, and replaces the block with a
<tool_result>...</tool_result> block containing the result.

Usage:
    from logic.tools import tool_router

    response = model_generate(messages)
    response = tool_router.route(response)

Registering a custom tool::

    @tool_router.register(
        "my_tool",
        "Does something useful",
        {"input": {"type": "string", "description": "The input"}},
    )
    def my_handler(input: str) -> str:
        return input.upper()
"""

from __future__ import annotations

import glob
import json
import re
import subprocess
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from logic.path_validator import safe_read, safe_write_path
from logic.audit_log import audit_logger


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class Tool:
    """A single registered tool."""

    name: str
    description: str
    parameters: dict[str, Any]  # JSON Schema for parameters
    handler: Callable[..., Any]


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

_TOOL_CALL_RE = re.compile(
    r"<tool_call>(.*?)</tool_call>",
    re.DOTALL,
)

# Commands that are never allowed in run_bash, regardless of context.
_BLOCKED_PATTERNS: list[re.Pattern[str]] = [
    re.compile(p, re.IGNORECASE)
    for p in [
        r"\brm\s+-[a-z]*r[a-z]*f",   # rm -rf / rm -fr / rm -Rf …
        r"\brm\s+-[a-z]*f[a-z]*r",
        r":\s*\(\s*\)\s*\{",          # fork bomb
        r"\bmkfs\b",                   # format filesystem
        r"\bdd\b.*\bof=/dev/",         # dd to block device
        r"\bshred\b",
        r">\s*/dev/sd",               # overwrite block device
        r"\bchmod\s+-[a-z]*R",        # recursive chmod (too broad)
        r"\bchown\s+-[a-z]*R",        # recursive chown
        r"\bsudo\b",
        r"\bsu\b\s",
        r"\bcurl\b.*\|\s*(ba)?sh",    # pipe curl to shell
        r"\bwget\b.*\|\s*(ba)?sh",
    ]
]


class ToolRouter:
    """Registry and dispatcher for model-invoked tools."""

    def __init__(self) -> None:
        self.tools: dict[str, Tool] = {}
        self._register_builtins()

    # ------------------------------------------------------------------
    # Registration
    # ------------------------------------------------------------------

    def register(
        self,
        name: str,
        description: str,
        parameters: dict[str, Any],
    ) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """Decorator factory — register a handler as a named tool.

        Example::

            @tool_router.register("echo", "Echo input", {"text": {"type": "string"}})
            def echo(text: str) -> str:
                return text
        """

        def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
            self.tools[name] = Tool(
                name=name,
                description=description,
                parameters=parameters,
                handler=fn,
            )
            return fn

        return decorator

    # ------------------------------------------------------------------
    # Routing
    # ------------------------------------------------------------------

    def route(self, response: str) -> str:
        """Replace every <tool_call> block in *response* with its result.

        Blocks are processed left-to-right in document order.  If a tool
        raises an exception the error message is returned as the result so
        the model can react to it.
        """

        def _replace(match: re.Match[str]) -> str:
            raw = match.group(1).strip()
            try:
                payload = json.loads(raw)
                tool_name: str = payload["name"]
                arguments: dict[str, Any] = payload.get("arguments") or payload.get("parameters") or {}
            except (json.JSONDecodeError, KeyError) as exc:
                result = {"error": f"Malformed tool_call: {exc}", "raw": raw}
                return f"<tool_result>{json.dumps(result)}</tool_result>"

            tool = self.tools.get(tool_name)
            if tool is None:
                result = {"error": f"Unknown tool: {tool_name!r}"}
                return f"<tool_result>{json.dumps(result)}</tool_result>"

            try:
                outcome = tool.handler(**arguments)
                result = {"result": outcome}
            except Exception as exc:  # noqa: BLE001
                result = {"error": str(exc)}

            return f"<tool_result>{json.dumps(result)}</tool_result>"

        result = _TOOL_CALL_RE.sub(_replace, response)

        if result == response:  # no tool_call tags were found
            try:
                from logic.code_runner import extract_code_blocks, execute_block, format_result
                blocks = extract_code_blocks(response)
                executable = [b for b in blocks if b.language in ("python", "javascript", "bash")]
                if executable and len(response) > 200:  # only auto-run on substantial responses
                    for block in executable[:1]:  # run only the first block automatically
                        block_result = execute_block(block)
                        if block_result.get("returncode") != 0 and block_result.get("stderr"):
                            result += "\n\n<execution_result>\n" + format_result(block_result) + "\n</execution_result>"
            except Exception:
                pass  # auto-execution is best-effort

        return result

    # ------------------------------------------------------------------
    # Introspection
    # ------------------------------------------------------------------

    def list_tools(self) -> list[dict[str, Any]]:
        """Return metadata for all registered tools (no handlers)."""
        return [
            {
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
            }
            for t in self.tools.values()
        ]

    def get_tool_prompt(self) -> str:
        """Return a system-prompt fragment describing all registered tools."""
        if not self.tools:
            return ""

        lines: list[str] = [
            "You have access to the following tools. To call a tool emit:",
            '  <tool_call>{"name": "<tool_name>", "arguments": {<key>: <value>, ...}}</tool_call>',
            "The result will be returned as:",
            "  <tool_result>{\"result\": ...}</tool_result>",
            "",
            "Available tools:",
        ]
        for t in self.tools.values():
            lines.append(f"\n  {t.name}: {t.description}")
            if t.parameters:
                lines.append("  Parameters:")
                for param_name, schema in t.parameters.items():
                    ptype = schema.get("type", "any")
                    pdesc = schema.get("description", "")
                    default = schema.get("default")
                    default_str = f" (default: {default!r})" if default is not None else ""
                    lines.append(f"    - {param_name} ({ptype}){default_str}: {pdesc}")

        return "\n".join(lines)

    # ------------------------------------------------------------------
    # Built-in tool registration
    # ------------------------------------------------------------------

    def _register_builtins(self) -> None:
        """Register the standard built-in tools."""

        # ----------------------------------------------------------------
        # 1. read_file
        # ----------------------------------------------------------------
        @self.register(
            "read_file",
            "Read a file from disk and return its contents.",
            {
                "path": {
                    "type": "string",
                    "description": "File path to read",
                }
            },
        )
        def _read_file(path: str) -> str:
            ok, content, err = safe_read(path)
            audit_logger.log_file_access(path, "read", ok)
            if not ok:
                return f"Access denied: {err}"

            max_chars = 5000
            if len(content) > max_chars:
                content = content[:max_chars] + f"\n[...truncated at {max_chars} chars]"
            return content

        # ----------------------------------------------------------------
        # 2. list_files
        # ----------------------------------------------------------------
        @self.register(
            "list_files",
            "List files in a directory, optionally filtered by a glob pattern.",
            {
                "path": {
                    "type": "string",
                    "description": "Directory path to list",
                },
                "pattern": {
                    "type": "string",
                    "description": "Glob pattern to filter results",
                    "default": "*",
                },
            },
        )
        def _list_files(path: str, pattern: str = "*") -> list[str]:
            base = Path(path).expanduser()
            matches = glob.glob(str(base / pattern))
            return sorted(matches)

        # ----------------------------------------------------------------
        # 3. run_bash
        # ----------------------------------------------------------------
        @self.register(
            "run_bash",
            "Run a shell command and return its output. Dangerous operations are blocked.",
            {
                "command": {
                    "type": "string",
                    "description": "Shell command to execute",
                },
                "timeout": {
                    "type": "integer",
                    "description": "Timeout in seconds",
                    "default": 10,
                },
            },
        )
        def _run_bash(command: str, timeout: int = 10) -> str:
            from logic.sandbox import run_sandboxed_bash

            for pattern in _BLOCKED_PATTERNS:
                if pattern.search(command):
                    audit_logger.log_tool_call("run_bash", {"command": command[:200]}, False)
                    return f"Error: command blocked by safety filter: {command!r}"

            # Run through sandbox for additional scanning before subprocess.
            sandbox_result = run_sandboxed_bash(command, timeout=timeout)
            ok = not sandbox_result.get("blocked", False) and sandbox_result.get("returncode", -1) == 0
            audit_logger.log_tool_call("run_bash", {"command": command[:200]}, ok)

            if sandbox_result.get("blocked"):
                return f"Error: command blocked by sandbox: {sandbox_result.get('stderr', '')}"
            if sandbox_result.get("timed_out"):
                return f"Error: command timed out after {timeout}s"

            output = sandbox_result.get("stdout", "") + sandbox_result.get("stderr", "")
            return output.strip() if output.strip() else "(no output)"

        # ----------------------------------------------------------------
        # 4. search_code
        # ----------------------------------------------------------------
        @self.register(
            "search_code",
            "Recursively search for a text pattern in files under a directory.",
            {
                "pattern": {
                    "type": "string",
                    "description": "Text or regex pattern to search for",
                },
                "directory": {
                    "type": "string",
                    "description": "Root directory to search in",
                    "default": ".",
                },
            },
        )
        def _search_code(pattern: str, directory: str = ".") -> list[str]:
            root = Path(directory).expanduser()
            compiled = re.compile(pattern)
            matches: list[str] = []
            max_matches = 200

            try:
                for filepath in sorted(root.rglob("*")):
                    if not filepath.is_file():
                        continue
                    # Skip binary-ish files and common non-text dirs.
                    if any(part.startswith(".") for part in filepath.parts):
                        continue
                    try:
                        text = filepath.read_text(encoding="utf-8", errors="ignore")
                    except OSError:
                        continue
                    for lineno, line in enumerate(text.splitlines(), start=1):
                        if compiled.search(line):
                            matches.append(f"{filepath}:{lineno}: {line.rstrip()}")
                            if len(matches) >= max_matches:
                                matches.append(f"[...truncated at {max_matches} matches]")
                                return matches
            except Exception as exc:  # noqa: BLE001
                return [f"Error during search: {exc}"]

            return matches if matches else ["No matches found."]

        # ----------------------------------------------------------------
        # 5. get_time
        # ----------------------------------------------------------------
        @self.register(
            "get_time",
            "Return the current date and time in ISO 8601 format.",
            {},
        )
        def _get_time() -> str:
            return datetime.now().isoformat()

        # ----------------------------------------------------------------
        # 6. execute_code
        # ----------------------------------------------------------------
        @self.register(
            "execute_code",
            "Execute a code block and return the output. Supports python, javascript, bash.",
            {
                "code": {
                    "type": "string",
                    "description": "The code to execute",
                },
                "language": {
                    "type": "string",
                    "description": "python | javascript | bash",
                    "default": "python",
                },
            },
        )
        def _execute_code(code: str, language: str = "python") -> str:
            from logic.sandbox import run_sandboxed_python, run_sandboxed_bash, scan_code_for_dangers
            try:
                if language == "python":
                    result = run_sandboxed_python(code)
                elif language == "bash":
                    result = run_sandboxed_bash(code)
                else:
                    # Fall back to code_runner for javascript and other languages.
                    from logic.code_runner import execute_block, format_result, CodeBlock
                    block = CodeBlock(language=language, code=code, source_text=code)
                    raw = execute_block(block)
                    result_ok = raw.get("returncode", -1) == 0
                    audit_logger.log_tool_call(
                        "execute_code",
                        {"language": language, "code": code[:100]},
                        result_ok,
                    )
                    return format_result(raw)

                result_ok = not result.get("blocked", False) and result.get("returncode", -1) == 0
                audit_logger.log_tool_call(
                    "execute_code",
                    {"language": language, "code": code[:100]},
                    result_ok,
                )

                if result.get("blocked"):
                    return f"Execution blocked: {result.get('stderr', '')}"
                if result.get("timed_out"):
                    return "Execution error: timed out"

                output = result.get("stdout", "")
                stderr = result.get("stderr", "")
                parts = [p for p in (output, stderr) if p]
                return "\n".join(parts).strip() if parts else "(no output)"
            except Exception as e:
                audit_logger.log_tool_call(
                    "execute_code",
                    {"language": language, "code": code[:100]},
                    False,
                )
                return f"Execution error: {e}"

        # ----------------------------------------------------------------
        # 7. patch_file
        # ----------------------------------------------------------------
        @self.register(
            "patch_file",
            "Apply a unified diff patch to a file. Use this instead of write_file for partial edits.",
            {
                "filepath": {
                    "type": "string",
                    "description": "Path to the file to patch",
                },
                "diff": {
                    "type": "string",
                    "description": "Unified diff string (--- a/file \n+++ b/file format)",
                },
            },
        )
        def _patch_file(filepath: str, diff: str) -> str:
            try:
                from logic.diff_editor import apply_diff_to_file
                result = apply_diff_to_file(filepath, diff)
                if result["success"]:
                    return f"Patched {filepath}: +{result['lines_added']} -{result['lines_removed']} lines"
                return f"Patch failed: {result['error']}"
            except Exception as e:
                return f"Error: {e}"

        # ----------------------------------------------------------------
        # 8. git_status
        # ----------------------------------------------------------------
        @self.register(
            "git_status",
            "Get current git branch, recent commits, and unstaged changes.",
            {},
        )
        def _git_status() -> str:
            try:
                from logic.git_context import git_context
                return git_context.build_context_block() or "Clean working tree, no changes."
            except Exception as e:
                return f"Git unavailable: {e}"

        # ----------------------------------------------------------------
        # 9. check_syntax  — validate Python before writing
        # ----------------------------------------------------------------
        @self.register(
            "check_syntax",
            "Validate Python syntax of a file or code string before saving.",
            {
                "filepath": {"type": "string", "description": "Path to .py file to check (optional)"},
                "code": {"type": "string", "description": "Python source code string to check (optional)"},
            },
        )
        def _check_syntax(filepath: str = "", code: str = "") -> str:
            try:
                from logic.self_modify import check_syntax, check_syntax_string
                if filepath:
                    r = check_syntax(filepath)
                elif code:
                    r = check_syntax_string(code)
                else:
                    return "Provide filepath or code."
                return "Syntax OK" if r["ok"] else f"Syntax error: {r['error']}"
            except Exception as e:
                return f"Error: {e}"

        # ----------------------------------------------------------------
        # 10. restart_server  — hot-reload inference server
        # ----------------------------------------------------------------
        @self.register(
            "restart_server",
            "Hot-reload the Proverbs inference server to pick up code changes.",
            {},
        )
        def _restart_server() -> str:
            try:
                from logic.self_modify import restart_server
                r = restart_server()
                if r["ok"]:
                    return f"Server reloaded via {r['method']}."
                return f"Reload failed: {r.get('error')}"
            except Exception as e:
                return f"Error: {e}"

        # ----------------------------------------------------------------
        # 11. trigger_retrain  — start background training
        # ----------------------------------------------------------------
        @self.register(
            "trigger_retrain",
            "Start background model retraining. Returns immediately — check training.log for progress.",
            {
                "mode": {"type": "string", "description": "local | pretrain | finetune (default: local)"},
                "size": {"type": "string", "description": "nano | small | medium (default: nano)"},
            },
        )
        def _trigger_retrain(mode: str = "local", size: str = "nano") -> str:
            try:
                from logic.self_modify import trigger_retrain
                r = trigger_retrain(mode, size)
                if r["ok"]:
                    return f"Retraining started (PID {r['pid']}, mode={r['mode']}, size={r['size']}). Watch: tail -f {r['log']}"
                return f"Could not start retraining: {r.get('reason')}"
            except Exception as e:
                return f"Error: {e}"

        # ----------------------------------------------------------------
        # 12. write_file_safe  — write with auto syntax-check + backup
        # ----------------------------------------------------------------
        @self.register(
            "write_file_safe",
            "Write content to a file. Auto syntax-checks Python files and creates a backup first.",
            {
                "filepath": {"type": "string", "description": "Path to write"},
                "content": {"type": "string", "description": "File content"},
            },
        )
        def _write_file_safe(filepath: str, content: str) -> str:
            ok, err = safe_write_path(filepath, content)
            audit_logger.log_file_access(filepath, "write", ok)
            if not ok:
                return f"Write denied: {err}"
            try:
                from logic.self_modify import safe_write
                r = safe_write(filepath, content)
                if r["ok"]:
                    backup = f" (backup: {r['backed_up_to']})" if r["backed_up_to"] else ""
                    return f"Written: {filepath}{backup}"
                return f"Write failed: {r['error']}"
            except Exception as e:
                return f"Error: {e}"



        # ----------------------------------------------------------------
        # 13. get_word_count  — count words/lines in any file
        # ----------------------------------------------------------------
        @self.register(
            "get_word_count",
            "Count words, lines, and characters in any file.",
            {
                "filepath": {
                    "type": "string",
                    "description": "Path to the file to analyze",
                },
            },
        )
        def _get_word_count(filepath: str) -> str:
            try:
                text = open(filepath, encoding="utf-8", errors="ignore").read()
                words = len(text.split())
                lines = text.count("\n")
                chars = len(text)
                return f"{words:,} words | {lines:,} lines | {chars:,} chars — {filepath}"
            except Exception as e:
                return f"Error reading {filepath}: {e}"

        # ----------------------------------------------------------------
        # 14. run_tests  — generate and run pytest tests for a source file
        # ----------------------------------------------------------------
        @self.register(
            "run_tests",
            "Auto-generate and run pytest unit tests for all functions in a Python file.",
            {
                "filepath": {
                    "type": "string",
                    "description": "Path to the Python source file to test",
                },
            },
        )
        def _run_tests(filepath: str) -> Any:
            try:
                from logic.test_generator import TestGenerator
            except ImportError as exc:
                return f"run_tests unavailable — could not import logic.test_generator: {exc}"
            try:
                from inference.generate import ProverbsGenerator
            except ImportError as exc:
                return f"run_tests unavailable — could not import inference.generate: {exc}"
            try:
                source = Path(filepath).expanduser().read_text(encoding="utf-8", errors="replace")
                # Generator requires a live model instance; use a minimal stub when none is available.
                try:
                    from inference.generate import get_generator
                    generator = get_generator()
                except Exception:
                    generator = None  # type: ignore[assignment]
                tg = TestGenerator(generator)
                results = tg.generate_and_run(source)
                if not results:
                    return {"error": "No functions found in file or source is empty."}
                return results
            except Exception as exc:
                return {"error": str(exc)}

        # ----------------------------------------------------------------
        # 15. get_dependencies  — static import graph for a file
        # ----------------------------------------------------------------
        @self.register(
            "get_dependencies",
            "Build a static import graph for the project and return context files for the given filepath.",
            {
                "filepath": {
                    "type": "string",
                    "description": "Absolute or relative path to the focal source file",
                },
                "depth": {
                    "type": "integer",
                    "description": "BFS depth limit for dependency traversal",
                    "default": 2,
                },
            },
        )
        def _get_dependencies(filepath: str, depth: int = 2) -> Any:
            try:
                from logic.dependency_graph import DependencyGraph
            except ImportError as exc:
                return f"get_dependencies unavailable — could not import logic.dependency_graph: {exc}"
            try:
                resolved = str(Path(filepath).expanduser().resolve())
                project_dir = str(Path(resolved).parent)
                dg = DependencyGraph(project_dir)
                dg.build()
                context_files = dg.get_context_files(resolved, max_files=10)
                deps = sorted(dg.get_dependencies(resolved, depth=depth))
                return {
                    "filepath": resolved,
                    "depth": depth,
                    "dependencies": deps,
                    "context_files": context_files,
                }
            except Exception as exc:
                return {"error": str(exc)}

        # ----------------------------------------------------------------
        # 16. auto_commit  — stage and commit with a model-generated message
        # ----------------------------------------------------------------
        @self.register(
            "auto_commit",
            "Stage changes (optionally) and commit them, generating the commit message automatically.",
            {
                "message": {
                    "type": "string",
                    "description": "Explicit commit message; omit to let the model generate one",
                    "default": "",
                },
                "stage_all": {
                    "type": "boolean",
                    "description": "When true, run git add -A before committing",
                    "default": False,
                },
            },
        )
        def _auto_commit(message: str = "", stage_all: bool = False) -> Any:
            try:
                from logic.auto_commit import auto_commit as _ac
            except ImportError as exc:
                return f"auto_commit unavailable — could not import logic.auto_commit: {exc}"
            try:
                try:
                    from inference.generate import get_generator
                    generator = get_generator()
                except Exception:
                    generator = None  # type: ignore[assignment]
                result = _ac(
                    generator,
                    message=message if message else None,
                    stage_all=stage_all,
                )
                return result
            except Exception as exc:
                return {"error": str(exc)}

        # ----------------------------------------------------------------
        # 17. score_code_quality  — static quality analysis for a Python file
        # ----------------------------------------------------------------
        @self.register(
            "score_code_quality",
            "Run static code quality analysis on a Python file and return a composite quality report.",
            {
                "filepath": {
                    "type": "string",
                    "description": "Path to the Python file to analyse",
                },
            },
        )
        def _score_code_quality(filepath: str) -> Any:
            try:
                from logic.code_quality import score_code
            except ImportError as exc:
                return f"score_code_quality unavailable — could not import logic.code_quality: {exc}"
            try:
                source = Path(filepath).expanduser().read_text(encoding="utf-8", errors="replace")
                report = score_code(source, language="python")
                report["filepath"] = str(Path(filepath).expanduser().resolve())
                return report
            except Exception as exc:
                return {"error": str(exc)}

        # ----------------------------------------------------------------
        # 18. compress_session  — summarise and compress the conversation history
        # ----------------------------------------------------------------
        @self.register(
            "compress_session",
            "Compress the current conversation history to reduce token usage while preserving context.",
            {},
        )
        def _compress_session() -> Any:
            try:
                from logic.session_compressor import compress_history
            except ImportError as exc:
                return f"compress_session unavailable — could not import logic.session_compressor: {exc}"
            try:
                # Resolve generator and tokenizer; fall back gracefully if not available.
                try:
                    from inference.generate import get_generator
                    generator = get_generator()
                except Exception as exc:
                    return f"compress_session unavailable — could not load generator: {exc}"
                try:
                    from tokenizer.tokenizer import ProverbsTokenizer
                    tokenizer = ProverbsTokenizer.load()
                except Exception as exc:
                    return f"compress_session unavailable — could not load tokenizer: {exc}"

                # Retrieve current session context from the conversation store if available.
                try:
                    from logic.conversation import get_current_messages
                    messages = get_current_messages()
                except Exception:
                    return "compress_session: no active session context found to compress."

                compressed = compress_history(generator, messages, tokenizer)
                original_len = len(messages)
                compressed_len = len(compressed)
                return {
                    "original_turns": original_len,
                    "compressed_turns": compressed_len,
                    "turns_removed": original_len - compressed_len,
                    "status": "compressed" if compressed_len < original_len else "already within budget",
                }
            except Exception as exc:
                return {"error": str(exc)}


# ---------------------------------------------------------------------------
# Global instance
# ---------------------------------------------------------------------------

tool_router = ToolRouter()
