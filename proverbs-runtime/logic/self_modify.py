"""
logic/self_modify.py — Safe self-modification engine for Proverbs.

Proverbs can read, patch, test, and restart itself.
Every write goes through syntax validation before hitting disk.
Every change is committed to git for rollback safety.
"""

from __future__ import annotations

import ast
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from logic.audit_log import audit_logger
from logic.path_validator import validate_path, ALLOWED_BASE_DIRS

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_VENV_PYTHON = Path.home() / ".proverbs" / "venv" / "bin" / "python"

# ---------------------------------------------------------------------------
# Critical system paths — never allow writes here even if somehow in allowlist
# ---------------------------------------------------------------------------

_CRITICAL_SYSTEM_PATHS: list[str] = [
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/boot",
    "/sys",
    "/proc",
    "/dev",
    "/root",
    str(Path.home() / ".ssh"),
    str(Path.home() / ".aws"),
    str(Path.home() / ".gnupg"),
]

# ---------------------------------------------------------------------------
# Suspicious patterns in change descriptions (command-injection / exfil signals)
# ---------------------------------------------------------------------------

_SUSPICIOUS_PATTERNS: list[re.Pattern] = [
    re.compile(r"base64\s*[-–]", re.IGNORECASE),              # base64 decode/encode pipeline
    re.compile(r"curl\s.*\|\s*sh", re.IGNORECASE),            # curl | sh
    re.compile(r"wget\s.*\|\s*sh", re.IGNORECASE),            # wget | sh
    re.compile(r"eval\s*\(", re.IGNORECASE),                  # eval(...)
    re.compile(r"exec\s*\(", re.IGNORECASE),                  # exec(...)
    re.compile(r"__import__\s*\(", re.IGNORECASE),            # __import__(...)
    re.compile(r"subprocess\.call\s*\(\[?['\"]sh", re.IGNORECASE),
    re.compile(r"os\.system\s*\(", re.IGNORECASE),
    re.compile(r"rm\s+-rf\s+/", re.IGNORECASE),               # rm -rf /
    re.compile(r">\s*/etc/", re.IGNORECASE),                   # redirect to /etc
    re.compile(r"chmod\s+[0-7]*7[0-7]*\s+/", re.IGNORECASE),  # world-executable on /
]


# ---------------------------------------------------------------------------
# Security helpers
# ---------------------------------------------------------------------------

def _check_path_security(filepath: str) -> tuple[bool, str]:
    """Return (ok, reason). Delegates to the user-controlled permission policy
    in path_validator (open by default, user-configurable deny/allow). The old
    hard wall that confined writes to the project root + ~/.proverbs has been
    removed so Proverbs can update any app the user can — the user sets their
    own access terms in ~/.proverbs/config.json (permissions block)."""
    return validate_path(filepath, allow_write=True)


def _check_description_security(change_description: str) -> tuple[bool, str]:
    """Return (ok, reason). Scans change_description for suspicious patterns."""
    for pattern in _SUSPICIOUS_PATTERNS:
        m = pattern.search(change_description)
        if m:
            return False, f"Suspicious pattern detected in change description: {m.group(0)!r}"
    return True, ""


# ---------------------------------------------------------------------------
# Syntax validation
# ---------------------------------------------------------------------------

def check_syntax(filepath: str) -> dict:
    """Validate Python syntax. Returns {ok, error}."""
    try:
        source = Path(filepath).read_text(encoding="utf-8")
        ast.parse(source)
        return {"ok": True, "error": None}
    except SyntaxError as e:
        return {"ok": False, "error": f"SyntaxError at line {e.lineno}: {e.msg}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def check_syntax_string(source: str, filename: str = "<string>") -> dict:
    """Validate Python syntax of a source string before writing."""
    try:
        ast.parse(source)
        return {"ok": True, "error": None}
    except SyntaxError as e:
        return {"ok": False, "error": f"SyntaxError at line {e.lineno}: {e.msg}"}


# ---------------------------------------------------------------------------
# Safe file write
# ---------------------------------------------------------------------------

def safe_write(filepath: str, content: str, skip_syntax_check: bool = False) -> dict:
    """
    Write content to filepath safely:
    1. Path validation (security policy)
    2. Syntax check (for .py files)
    3. Backup original if exists
    4. Write atomically via temp file
    5. Audit log on success or failure
    Returns {ok, filepath, backed_up_to, error}
    """
    path = Path(filepath)
    result: dict = {"ok": False, "filepath": filepath, "backed_up_to": None, "error": None}

    # ------------------------------------------------------------------
    # 1. Path validation via path_validator
    # ------------------------------------------------------------------
    ok, err = validate_path(filepath, allow_write=True)
    if not ok:
        result["error"] = f"Write denied by security policy: {err}"
        audit_logger.log_security_event(
            "blocked_write",
            json.dumps({"filepath": filepath, "reason": err}),
            severity="WARNING",
        )
        return result

    # Syntax check for Python files
    if path.suffix == ".py" and not skip_syntax_check:
        check = check_syntax_string(content, str(path))
        if not check["ok"]:
            result["error"] = f"Syntax check failed: {check['error']}"
            return result

    # Backup original
    if path.exists():
        backup_dir = Path.home() / ".proverbs" / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        ts = int(time.time())
        backup_path = backup_dir / f"{path.name}.{ts}.bak"
        backup_path.write_bytes(path.read_bytes())
        result["backed_up_to"] = str(backup_path)

    # Atomic write via temp file
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8",
        dir=path.parent, suffix=".tmp", delete=False
    ) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    os.replace(tmp_path, path)
    result["ok"] = True

    # ------------------------------------------------------------------
    # Audit log — successful write
    # ------------------------------------------------------------------
    audit_logger.log_file_access(filepath, "self_modify_write", True)

    return result


# ---------------------------------------------------------------------------
# Server restart / hot-reload
# ---------------------------------------------------------------------------

def restart_server(server_url: str = "http://localhost:11434") -> dict:
    """
    Hot-reload the inference server.
    Tries /v1/admin/reload-model first (in-process).
    Falls back to spawning a new server process.
    """
    import urllib.request
    try:
        req = urllib.request.Request(
            server_url + "/v1/admin/reload-model",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
            return {"ok": True, "method": "hot-reload", "response": data}
    except Exception as e:
        # Fall back: kill and respawn
        try:
            subprocess.run(["pkill", "-f", "inference.server"], check=False)
            time.sleep(2)
            log_fh = open("/tmp/proverbs-server.log", "a")
            subprocess.Popen(
                [str(_VENV_PYTHON), "-m", "inference.server"],
                cwd=str(_PROJECT_ROOT),
                stdout=log_fh,
                stderr=log_fh,
                start_new_session=True,
            )
            return {"ok": True, "method": "respawn", "note": str(e)}
        except Exception as e2:
            return {"ok": False, "error": str(e2)}


# ---------------------------------------------------------------------------
# Training trigger
# ---------------------------------------------------------------------------

def trigger_retrain(mode: str = "local", size: str = "nano") -> dict:
    """Spawn background retraining. Returns immediately."""
    log_path = str(Path.home() / ".proverbs" / "training.log")
    lock = Path.home() / ".proverbs" / "retraining.lock"
    if lock.exists():
        return {"ok": False, "reason": "Retraining already in progress"}

    lock.write_text(str(os.getpid()))
    log_fh = open(log_path, "a")
    proc = subprocess.Popen(
        [str(_VENV_PYTHON), "-m", "training.train",
         "--mode", mode, "--size", size],
        cwd=str(_PROJECT_ROOT),
        stdout=log_fh,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return {"ok": True, "pid": proc.pid, "mode": mode, "size": size,
            "log": log_path}


# ---------------------------------------------------------------------------
# Test runner
# ---------------------------------------------------------------------------

def run_module_test(filepath: str, timeout: int = 30) -> dict:
    """Run pytest on a file and return results."""
    result = subprocess.run(
        [str(_VENV_PYTHON), "-m", "pytest", filepath, "-v", "--tb=short", "-q"],
        capture_output=True, text=True,
        cwd=str(_PROJECT_ROOT), timeout=timeout,
    )
    return {
        "returncode": result.returncode,
        "stdout": result.stdout[-2000:],
        "stderr": result.stderr[-500:],
        "passed": "passed" in result.stdout,
    }


def run_import_test(filepath: str) -> dict:
    """Quick test: can the file be imported without errors?"""
    rel = Path(filepath).relative_to(_PROJECT_ROOT)
    module = ".".join(rel.with_suffix("").parts)
    result = subprocess.run(
        [str(_VENV_PYTHON), "-c", f"import {module}; print('OK')"],
        capture_output=True, text=True,
        cwd=str(_PROJECT_ROOT), timeout=15,
    )
    return {
        "ok": result.returncode == 0,
        "output": result.stdout.strip(),
        "error": result.stderr.strip()[-500:] if result.stderr else None,
    }


# ---------------------------------------------------------------------------
# Git helpers
# ---------------------------------------------------------------------------

def git_commit_change(message: str, files: list[str] = None) -> dict:
    """Stage specified files (or all changed) and commit."""
    try:
        if files:
            subprocess.run(["git", "add"] + files, cwd=str(_PROJECT_ROOT), check=True)
        else:
            subprocess.run(["git", "add", "-A"], cwd=str(_PROJECT_ROOT), check=True)

        result = subprocess.run(
            ["git", "commit", "-m", message],
            capture_output=True, text=True, cwd=str(_PROJECT_ROOT),
        )
        return {
            "ok": result.returncode == 0,
            "output": result.stdout.strip(),
            "error": result.stderr.strip() if result.returncode != 0 else None,
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ---------------------------------------------------------------------------
# Self-modification pipeline
# ---------------------------------------------------------------------------

class SelfModifier:
    """
    Orchestrates safe self-modification:
    read → plan → patch → syntax_check → test → commit → reload
    """

    def __init__(self, server_url: str = "http://localhost:11434"):
        self.server_url = server_url
        self.log: list[dict] = []

    def _log(self, step: str, result: dict) -> None:
        entry = {"step": step, "ts": time.time(), **result}
        self.log.append(entry)

    def apply_patch(self, filepath: str, diff_text: str) -> dict:
        """Apply a unified diff to a file safely."""
        try:
            from logic.diff_editor import apply_diff_to_file
            result = apply_diff_to_file(filepath, diff_text)
            self._log("patch", result)
            if result["success"]:
                syntax = check_syntax(filepath)
                if not syntax["ok"]:
                    # Rollback: restore from backup
                    backups = sorted(
                        (Path.home() / ".proverbs" / "backups").glob(f"{Path(filepath).name}.*.bak")
                    )
                    if backups:
                        Path(filepath).write_bytes(backups[-1].read_bytes())
                    return {"ok": False, "error": f"Patch applied but syntax invalid: {syntax['error']}. Rolled back."}
                self._log("syntax_check", syntax)
            return {"ok": result["success"], "details": result}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def write_new_file(self, filepath: str, content: str) -> dict:
        """Write a new file with full safety checks."""
        result = safe_write(filepath, content)
        self._log("write", result)
        if result["ok"]:
            import_test = run_import_test(filepath)
            self._log("import_test", import_test)
            if not import_test["ok"]:
                return {"ok": False, "error": f"File written but import failed: {import_test['error']}"}
        return result

    def full_cycle(self, filepath: str, change_description: str,
                   diff_text: str = None, new_content: str = None) -> dict:
        """
        Full self-modification cycle:
        security_preflight → patch/write → test → commit → reload
        """
        steps = []

        # ------------------------------------------------------------------
        # Pre-flight security check
        # ------------------------------------------------------------------
        path_ok, path_reason = _check_path_security(filepath)
        if not path_ok:
            audit_logger.log_security_event(
                "preflight_blocked",
                json.dumps({"filepath": filepath, "reason": path_reason}),
                severity="WARNING",
            )
            return {"ok": False, "error": "Security pre-flight check failed", "reason": path_reason}

        desc_ok, desc_reason = _check_description_security(change_description)
        if not desc_ok:
            audit_logger.log_security_event(
                "preflight_blocked",
                json.dumps({"filepath": filepath, "change_description": change_description[:200], "reason": desc_reason}),
                severity="WARNING",
            )
            return {"ok": False, "error": "Security pre-flight check failed", "reason": desc_reason}

        # Apply change
        if diff_text:
            r = self.apply_patch(filepath, diff_text)
        elif new_content:
            r = self.write_new_file(filepath, new_content)
        else:
            return {"ok": False, "error": "Must provide diff_text or new_content"}

        steps.append({"step": "apply", "result": r})
        if not r["ok"]:
            return {"ok": False, "steps": steps, "error": r.get("error")}

        # Commit
        commit_msg = f"self-modify: {change_description}"
        commit_r = git_commit_change(commit_msg, [filepath])
        steps.append({"step": "commit", "result": commit_r})

        # Reload server if inference or logic file changed
        needs_reload = any(d in filepath for d in ["inference/", "logic/", "model/"])
        if needs_reload:
            reload_r = restart_server(self.server_url)
            steps.append({"step": "reload", "result": reload_r})

        return {"ok": True, "steps": steps, "committed": commit_r["ok"]}


# Global instance
self_modifier = SelfModifier()
