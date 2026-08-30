"""
logic/path_validator.py — User-controlled path policy for Proverbs file tools.

Proverbs no longer ships a hard-coded directory wall. By DEFAULT it can read and
write anywhere the operating system permits — the same access the user has — so
it can update any app on the user's machine, not just files under ~/proverbs.

The user sets their OWN access terms in ~/.proverbs/config.json under a
"permissions" block (shared with the CLI's permission-scope system):

    {
      "permissions": {
        "mode": "open",                 // "open" (default) | "scoped"
        "allow": ["~/code", "/srv/app"],// in "scoped" mode, only these roots
        "deny":  ["~/.ssh", "/etc"],    // always denied (even in open mode)
        "max_write_mb": 200             // optional size cap (default 200)
      }
    }

  • mode "open"  (default): everything is allowed except paths in `deny`.
  • mode "scoped": only paths inside `allow` are permitted (minus `deny`).

If there is no config / no "permissions" block, the policy is fully open with a
small, OVERRIDABLE default deny-list for credential files. Set "deny": [] to
remove even those.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

# ---------------------------------------------------------------------------
# Policy loading (user-controlled, cached per-process)
# ---------------------------------------------------------------------------

_CONFIG_FILE = Path.home() / ".proverbs" / "config.json"

# Sensible default deny-list (credentials/secrets). Fully overridable: a user
# who sets "deny": [] in their config removes these too. This is NOT a hard
# restriction — it is a default the user can clear.
_DEFAULT_DENY: list[str] = [
    str(Path.home() / ".ssh"),
    str(Path.home() / ".aws"),
    str(Path.home() / ".gnupg"),
    "/etc/shadow",
]

_DEFAULT_MAX_WRITE_MB = 200
_MAX_READ_BYTES = 50 * 1024 * 1024  # 50 MB read cap (generous; avoids OOM)

_policy_cache: dict | None = None


def _expand(p: str) -> str:
    return str(Path(os.path.expanduser(p)).resolve()) if p else p


def load_policy(force: bool = False) -> dict:
    """Load the user's permission policy from config.json (cached)."""
    global _policy_cache
    if _policy_cache is not None and not force:
        return _policy_cache

    perms: dict = {}
    try:
        if _CONFIG_FILE.exists():
            cfg = json.loads(_CONFIG_FILE.read_text(encoding="utf-8"))
            perms = cfg.get("permissions") or {}
    except (ValueError, OSError):
        perms = {}

    mode = perms.get("mode", "open")
    allow = [_expand(p) for p in perms.get("allow", []) if p]
    # If the user omits "deny" entirely, fall back to the overridable default
    # deny-list. If they set "deny": [] explicitly, honor that (deny nothing).
    if "deny" in perms:
        deny = [_expand(p) for p in (perms.get("deny") or []) if p]
    else:
        deny = [_expand(p) for p in _DEFAULT_DENY]
    max_write_mb = perms.get("max_write_mb", _DEFAULT_MAX_WRITE_MB)

    _policy_cache = {
        "mode": mode,
        "allow": allow,
        "deny": deny,
        "max_write_bytes": int(max_write_mb) * 1024 * 1024,
    }
    return _policy_cache


def _under(path_str: str, base: str) -> bool:
    return path_str == base or path_str.startswith(base + os.sep)


# ---------------------------------------------------------------------------
# Core validator
# ---------------------------------------------------------------------------

def validate_path(
    filepath: str,
    must_exist: bool = False,
    allow_write: bool = False,
) -> tuple[bool, str]:
    """Return (True, "") when *filepath* passes the user's permission policy."""
    try:
        path = Path(filepath).resolve()
    except (ValueError, OSError) as exc:
        return False, f"Invalid path: {exc}"

    path_str = str(path)
    policy = load_policy()

    # 1. Deny-list always wins (credential/secret protection the user controls).
    for blocked in policy["deny"]:
        if _under(path_str, blocked):
            return False, (
                f"Access denied: '{blocked}' is in your deny-list. "
                "Edit ~/.proverbs/config.json (permissions.deny) to allow it."
            )

    # 2. In "scoped" mode, the path must be inside an allowed root.
    if policy["mode"] == "scoped":
        if not policy["allow"]:
            return False, (
                "Access denied: permission mode is 'scoped' but no allowed "
                "directories are set. Add roots to permissions.allow in "
                "~/.proverbs/config.json, or set permissions.mode to 'open'."
            )
        if not any(_under(path_str, base) for base in policy["allow"]):
            return False, (
                "Access denied: outside your allowed directories "
                "(permissions.allow). Add this path or switch to 'open' mode."
            )
    # 3. In "open" mode (default), anything not denied is permitted.

    if must_exist and not path.exists():
        return False, "File not found"

    if allow_write:
        parent = path.parent
        if not parent.exists():
            # Allow creating nested dirs — callers may mkdir. Only fail if the
            # nearest existing ancestor is not writable.
            anc = parent
            while not anc.exists() and anc != anc.parent:
                anc = anc.parent
            if not os.access(anc, os.W_OK):
                return False, f"Access denied: {anc} is not writable"
        elif not os.access(parent, os.W_OK):
            return False, "Access denied: parent directory is not writable"

    return True, ""


# ---------------------------------------------------------------------------
# High-level helpers
# ---------------------------------------------------------------------------

def safe_read(filepath: str) -> tuple[bool, str, str]:
    """Read *filepath* after policy validation. Returns (ok, content, error)."""
    ok, err = validate_path(filepath, must_exist=True)
    if not ok:
        return False, "", err

    path = Path(filepath).resolve()
    try:
        size = path.stat().st_size
    except OSError as exc:
        return False, "", f"Cannot stat file: {exc}"

    if size > _MAX_READ_BYTES:
        return False, "", f"File too large: {size} bytes (limit {_MAX_READ_BYTES})"

    try:
        content = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return False, "", f"Cannot read file: {exc}"

    return True, content, ""


def safe_write_path(filepath: str, content: str) -> tuple[bool, str]:
    """Validate *filepath* for writing and enforce the user's size cap."""
    ok, err = validate_path(filepath, allow_write=True)
    if not ok:
        return False, err

    max_write = load_policy()["max_write_bytes"]
    encoded_size = len(content.encode("utf-8", errors="replace"))
    if encoded_size > max_write:
        return False, (
            f"Content too large: {encoded_size} bytes "
            f"(limit {max_write}; raise permissions.max_write_mb in config)"
        )

    return True, ""


# Backwards-compat shim: some modules import ALLOWED_BASE_DIRS by name.
# It is no longer used for enforcement (policy is config-driven) but is kept so
# imports don't break. Reflects the user's allow-list when in scoped mode.
ALLOWED_BASE_DIRS: list[str] = []
