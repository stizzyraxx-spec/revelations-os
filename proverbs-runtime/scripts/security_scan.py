"""
scripts/security_scan.py — Self-auditing security scanner for the Proverbs installation.

Checks the server configuration, filesystem permissions, and tool safety policies
for common security issues and reports findings with colored terminal output.

Usage:
    python scripts/security_scan.py
    python -m scripts.security_scan
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# ANSI colour helpers (no external deps)
# ---------------------------------------------------------------------------

_RESET  = "\033[0m"
_BOLD   = "\033[1m"
_RED    = "\033[31m"
_GREEN  = "\033[32m"
_YELLOW = "\033[33m"
_CYAN   = "\033[36m"


def _c(text: str, *codes: str) -> str:
    """Wrap *text* in ANSI escape codes when stdout is a TTY."""
    if not sys.stdout.isatty():
        return text
    return "".join(codes) + text + _RESET


# ---------------------------------------------------------------------------
# Result schema
# ---------------------------------------------------------------------------

# Each check returns a dict:
#   {
#       "check":    str  — human-readable name
#       "passed":   bool — True = no issue found
#       "severity": str  — "critical" | "high" | "medium" | "info"
#       "detail":   str  — short explanation
#   }

_PROVERBS_DIR = Path.home() / ".proverbs"
_SERVER_PY    = Path(__file__).resolve().parent.parent / "inference" / "server.py"
_TOOLS_PY     = Path(__file__).resolve().parent.parent / "logic" / "tools.py"

# ---------------------------------------------------------------------------
# Individual check functions
# ---------------------------------------------------------------------------


def check_server_binding() -> dict[str, Any]:
    """Server should bind to 127.0.0.1, not 0.0.0.0."""
    name = "Server binding address"
    try:
        text = _SERVER_PY.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return _result(name, False, "medium", f"Cannot read server.py: {exc}")

    # The default argparse value and any explicit uvicorn.run() host= kwarg
    if re.search(r'default\s*=\s*["\']0\.0\.0\.0["\']', text):
        return _result(
            name, False, "high",
            "server.py default --host is '0.0.0.0' (binds all interfaces). "
            "Change default to '127.0.0.1' to restrict to localhost.",
        )

    if re.search(r'host\s*=\s*["\']0\.0\.0\.0["\']', text):
        return _result(
            name, False, "high",
            "server.py calls uvicorn.run() with host='0.0.0.0'. "
            "Use '127.0.0.1' to limit exposure.",
        )

    return _result(name, True, "high", "Server is not hard-coded to bind 0.0.0.0.")


def check_cors_origins() -> dict[str, Any]:
    """CORS allow_origins should not be wildcard *."""
    name = "CORS allow_origins"
    try:
        text = _SERVER_PY.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return _result(name, False, "medium", f"Cannot read server.py: {exc}")

    # Look for allow_origins=["*"] or allow_origins=['*']
    if re.search(r"""allow_origins\s*=\s*\[\s*["']\*["']\s*\]""", text):
        return _result(
            name, False, "medium",
            "CORS allow_origins=[\"*\"] found in server.py — all origins accepted. "
            "Restrict to known origins (e.g. [\"http://localhost:3000\"]).",
        )

    return _result(name, True, "medium", "CORS origins are not open-wildcard.")


def check_api_key_exists() -> dict[str, Any]:
    """~/.proverbs/config.json should have api_keys configured."""
    name = "API key configuration"
    config_path = _PROVERBS_DIR / "config.json"

    if not config_path.exists():
        return _result(
            name, False, "high",
            f"{config_path} does not exist — no API key protection configured.",
        )

    try:
        data = json.loads(config_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        return _result(name, False, "medium", f"Cannot parse config.json: {exc}")

    api_keys = data.get("api_keys")
    if not api_keys:
        return _result(
            name, False, "high",
            "config.json exists but 'api_keys' is missing or empty — server is unauthenticated.",
        )

    return _result(name, True, "high", f"api_keys configured ({len(api_keys)} key(s) found).")


def check_secrets_permissions() -> dict[str, Any]:
    """~/.proverbs/secrets.json should be chmod 600."""
    name = "secrets.json file permissions"
    secrets_path = _PROVERBS_DIR / "secrets.json"

    if not secrets_path.exists():
        return _result(name, True, "high", "secrets.json does not exist (nothing to protect).")

    try:
        mode = secrets_path.stat().st_mode & 0o777
    except OSError as exc:
        return _result(name, False, "high", f"Cannot stat secrets.json: {exc}")

    if mode != 0o600:
        return _result(
            name, False, "critical",
            f"secrets.json permissions are {oct(mode)} — should be 0o600. "
            f"Run: chmod 600 {secrets_path}",
        )

    return _result(name, True, "critical", "secrets.json has correct 0o600 permissions.")


def check_tool_path_validation() -> dict[str, Any]:
    """read_file tool in tools.py should call validate_path."""
    name = "read_file path validation"
    try:
        text = _TOOLS_PY.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return _result(name, False, "high", f"Cannot read tools.py: {exc}")

    # Check that validate_path is imported/called somewhere in the file
    calls_validate = bool(re.search(r"validate_path", text))

    # Specifically check whether the _read_file handler uses validate_path.
    # Extract the _read_file function body (from its def line to the next top-level def/class).
    read_file_body_match = re.search(
        r"def _read_file\(.*?\n(.*?)(?=\n    @|\n    def |\nclass |\Z)",
        text,
        re.DOTALL,
    )
    read_file_uses_validate = False
    if read_file_body_match:
        read_file_uses_validate = "validate_path" in read_file_body_match.group(1)

    if not calls_validate:
        return _result(
            name, False, "high",
            "validate_path is not imported or called anywhere in tools.py — "
            "read_file has no path traversal protection.",
        )

    if not read_file_uses_validate:
        return _result(
            name, False, "medium",
            "validate_path is imported in tools.py but the read_file handler "
            "does not call it directly — path traversal protection may be incomplete.",
        )

    return _result(name, True, "high", "read_file calls validate_path before accessing disk.")


def check_blocked_commands() -> dict[str, Any]:
    """BLOCKED_PATTERNS in tools.py should cover rm -rf, sudo, and mkfs."""
    name = "Blocked shell command patterns"
    try:
        text = _TOOLS_PY.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return _result(name, False, "high", f"Cannot read tools.py: {exc}")

    # Locate the _BLOCKED_PATTERNS list body
    match = re.search(
        r"_BLOCKED_PATTERNS.*?\[(.*?)\]",
        text,
        re.DOTALL,
    )
    if not match:
        return _result(
            name, False, "high",
            "_BLOCKED_PATTERNS list not found in tools.py.",
        )

    patterns_block = match.group(1)
    missing: list[str] = []

    # rm -rf coverage: look for any pattern mentioning 'rm'
    if not re.search(r"\\brm\\b", patterns_block):
        missing.append("rm -rf")

    # sudo coverage
    if not re.search(r"\\bsudo\\b", patterns_block):
        missing.append("sudo")

    # mkfs coverage
    if not re.search(r"\\bmkfs\\b", patterns_block):
        missing.append("mkfs")

    if missing:
        return _result(
            name, False, "high",
            f"_BLOCKED_PATTERNS may be missing coverage for: {', '.join(missing)}.",
        )

    return _result(
        name, True, "high",
        "_BLOCKED_PATTERNS covers rm -rf, sudo, and mkfs.",
    )


def check_audit_log_exists() -> dict[str, Any]:
    """~/.proverbs/audit.jsonl should exist if the server has been run."""
    name = "Audit log presence"
    audit_path = _PROVERBS_DIR / "audit.jsonl"

    # We cannot know for certain whether the server has ever run, so treat
    # absence as a warning (info-level) rather than a hard failure.
    if not audit_path.exists():
        return _result(
            name, False, "info",
            f"{audit_path} does not exist — audit logging may be disabled or "
            "the server has not yet been run.",
        )

    try:
        size = audit_path.stat().st_size
    except OSError as exc:
        return _result(name, False, "info", f"Cannot stat audit.jsonl: {exc}")

    return _result(
        name, True, "info",
        f"audit.jsonl exists ({size:,} bytes).",
    )


def check_no_debug_mode() -> dict[str, Any]:
    """Server should not run with debug=True in production."""
    name = "Debug mode disabled"
    try:
        text = _SERVER_PY.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return _result(name, False, "medium", f"Cannot read server.py: {exc}")

    # Flag debug=True passed to uvicorn.run() or FastAPI()
    if re.search(r"\bdebug\s*=\s*True\b", text):
        return _result(
            name, False, "medium",
            "debug=True found in server.py — remove or gate behind an environment "
            "variable before deploying to production.",
        )

    return _result(name, True, "medium", "No hard-coded debug=True detected in server.py.")


def check_temp_file_cleanup() -> dict[str, Any]:
    """
    /tmp should not have many proverbs-*.py temp files left over from
    the code runner.
    """
    name = "Temp file cleanup"
    pattern = "/tmp/proverbs-*.py"
    matches = glob.glob(pattern)
    count = len(matches)

    threshold = 10
    if count >= threshold:
        return _result(
            name, False, "medium",
            f"{count} proverbs-*.py temp files found in /tmp — code runner may "
            f"not be cleaning up after itself. Remove with: rm /tmp/proverbs-*.py",
        )

    return _result(
        name, True, "medium",
        f"{count} proverbs-*.py temp file(s) in /tmp (below threshold of {threshold}).",
    )


def check_checkpoint_permissions() -> dict[str, Any]:
    """~/.proverbs/checkpoints/ should not be world-readable."""
    name = "Checkpoint directory permissions"
    checkpoints_dir = _PROVERBS_DIR / "checkpoints"

    if not checkpoints_dir.exists():
        return _result(
            name, True, "medium",
            "Checkpoints directory does not exist (nothing to protect).",
        )

    try:
        mode = checkpoints_dir.stat().st_mode & 0o777
    except OSError as exc:
        return _result(name, False, "medium", f"Cannot stat checkpoints/: {exc}")

    world_readable = bool(mode & 0o004)  # others read bit
    world_executable = bool(mode & 0o001)  # others execute/traverse bit

    if world_readable or world_executable:
        return _result(
            name, False, "medium",
            f"checkpoints/ permissions are {oct(mode)} — world-readable bits set. "
            f"Run: chmod 750 {checkpoints_dir}",
        )

    return _result(
        name, True, "medium",
        f"checkpoints/ permissions are {oct(mode)} — not world-readable.",
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _result(
    check: str,
    passed: bool,
    severity: str,
    detail: str,
) -> dict[str, Any]:
    return {"check": check, "passed": passed, "severity": severity, "detail": detail}


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

CHECKS = [
    check_server_binding,
    check_cors_origins,
    check_api_key_exists,
    check_secrets_permissions,
    check_tool_path_validation,
    check_blocked_commands,
    check_audit_log_exists,
    check_no_debug_mode,
    check_temp_file_cleanup,
    check_checkpoint_permissions,
]


def run_all_checks() -> dict[str, Any]:
    """Run all CHECKS and aggregate results.

    Returns
    -------
    dict with keys:
        passed   — number of checks that passed
        failed   — number of checks that failed (severity != 'info')
        warnings — number of info-level checks that failed
        checks   — list of individual check result dicts
    """
    results: list[dict[str, Any]] = []
    passed = 0
    failed = 0
    warnings = 0

    for fn in CHECKS:
        result = fn()
        results.append(result)
        if result["passed"]:
            passed += 1
        elif result["severity"] == "info":
            warnings += 1
        else:
            failed += 1

    return {
        "passed": passed,
        "failed": failed,
        "warnings": warnings,
        "checks": results,
    }


# ---------------------------------------------------------------------------
# Reporter
# ---------------------------------------------------------------------------

_SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "info": 3}

_SEVERITY_COLOUR = {
    "critical": _RED + _BOLD,
    "high":     _RED,
    "medium":   _YELLOW,
    "info":     _CYAN,
}


def print_report(results: dict[str, Any]) -> None:
    """Print a coloured terminal security report from *results*."""
    checks: list[dict[str, Any]] = results["checks"]

    print()
    print(_c("=" * 60, _BOLD))
    print(_c("  Proverbs Security Scanner", _BOLD))
    print(_c("=" * 60, _BOLD))
    print()

    # Sort: failures first, then by severity, then alphabetically
    def _sort_key(r: dict[str, Any]) -> tuple[int, int, str]:
        sev_rank = _SEVERITY_ORDER.get(r["severity"], 99)
        pass_rank = 0 if not r["passed"] else 1
        return (pass_rank, sev_rank, r["check"])

    for r in sorted(checks, key=_sort_key):
        sev   = r["severity"].upper()
        sev_c = _SEVERITY_COLOUR.get(r["severity"], "")
        icon  = _c("PASS", _GREEN) if r["passed"] else _c("FAIL", sev_c)
        sev_label = _c(f"[{sev}]", sev_c)

        print(f"  {icon}  {sev_label:30s}  {r['check']}")
        print(f"         {r['detail']}")
        print()

    # Summary bar
    print(_c("-" * 60, _BOLD))
    total = len(checks)
    passed_str   = _c(str(results["passed"]),   _GREEN)
    failed_str   = _c(str(results["failed"]),   _RED)
    warnings_str = _c(str(results["warnings"]), _YELLOW)

    print(
        f"  Total: {total}  |  "
        f"Passed: {passed_str}  |  "
        f"Failed: {failed_str}  |  "
        f"Warnings: {warnings_str}"
    )
    print(_c("=" * 60, _BOLD))
    print()

    if results["failed"] == 0 and results["warnings"] == 0:
        print(_c("  All security checks passed.", _GREEN + _BOLD))
    elif results["failed"] == 0:
        print(_c("  No failures — review warnings above.", _YELLOW))
    else:
        print(_c(f"  {results['failed']} check(s) failed — remediate before production use.", _RED + _BOLD))
    print()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    results = run_all_checks()
    print_report(results)
    sys.exit(0 if results["failed"] == 0 else 1)
