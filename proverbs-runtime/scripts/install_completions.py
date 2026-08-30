"""Install shell autocompletion for proverbs slash commands."""

import argparse
import os
import sys
from pathlib import Path

PROVERBS_COMMANDS = [
    "/help",
    "/clear",
    "/model",
    "/projects",
    "/rules",
    "/memory",
    "/compress",
    "/plan",
    "/scan",
    "/ctx",
    "/tools",
    "/fix",
    "/voice",
    "/image",
    "/search",
    "/backend",
    "/session",
    "/undo",
    "/commit",
    "/bench",
    "/retrain",
    "/stats",
    "/version",
    "/exit",
    "/code",
    "/diff",
    "/test",
    "/quality",
    "/rag",
    "/train",
]

# Human-readable descriptions for zsh
_DESCRIPTIONS: dict[str, str] = {
    "/help": "Show help and available commands",
    "/clear": "Clear conversation history",
    "/model": "Switch or show the active LLM model",
    "/projects": "List or switch projects",
    "/rules": "View or edit project rules (.script)",
    "/memory": "View or edit persistent memory",
    "/compress": "Compress context to reduce token usage",
    "/plan": "Toggle cross-file edit planning mode",
    "/scan": "Scan codebase and build project profile",
    "/ctx": "Show current context window usage",
    "/tools": "List available tools",
    "/fix": "Auto-fix last error or lint issue",
    "/voice": "Toggle voice input mode",
    "/image": "Attach or analyse an image",
    "/search": "Search codebase or web",
    "/backend": "Show or switch inference backend",
    "/session": "Save, load, or list sessions",
    "/undo": "Undo last file write operation",
    "/commit": "Stage and commit changes via git",
    "/bench": "Run inference benchmark",
    "/retrain": "Kick off a fine-tune/retrain cycle",
    "/stats": "Show model and session statistics",
    "/version": "Print proverbs version",
    "/exit": "Exit proverbs",
    "/code": "Enter or paste a code block",
    "/diff": "Show pending diff for current file",
    "/test": "Run project test suite",
    "/quality": "Run linting and quality checks",
    "/rag": "Query the RAG knowledge base",
    "/train": "Start a full training pipeline run",
}


# ---------------------------------------------------------------------------
# Generators
# ---------------------------------------------------------------------------


def generate_bash_completion() -> str:
    """Return a bash completion function that completes proverbs slash commands.

    The function triggers when the current word starts with '/' so that typing
    '/' at the proverbs prompt and pressing Tab shows all slash commands.
    """
    cmds = " ".join(PROVERBS_COMMANDS)
    return f"""\
# Proverbs bash completion
# Source this file or place it in ~/.bash_completion.d/proverbs

_proverbs_complete() {{
    local cur="${{COMP_WORDS[COMP_CWORD]}}"
    local commands="{cmds}"

    # Only complete when the current word looks like a slash command
    if [[ "$cur" == /* ]]; then
        COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
        return 0
    fi
}}

complete -F _proverbs_complete proverbs
"""


def generate_zsh_completion() -> str:
    """Return a zsh _proverbs completion function with per-command descriptions."""
    lines = ["#compdef proverbs", "", "# Proverbs zsh completion", "# Place in a directory on $fpath, e.g. ~/.zsh/completions/_proverbs", "", "_proverbs() {", "    local -a commands", "    commands=("]
    for cmd in PROVERBS_COMMANDS:
        desc = _DESCRIPTIONS.get(cmd, "")
        # Zsh completion spec: 'word:description' — escape colons in the desc
        desc_escaped = desc.replace(":", "\\:")
        lines.append(f"        '{cmd}:{desc_escaped}'")
    lines += [
        "    )",
        "",
        "    # Complete slash commands when the current word starts with '/'",
        "    if [[ ${words[CURRENT]} == /* ]]; then",
        "        _describe 'proverbs command' commands",
        "    fi",
        "}",
        "",
        "_proverbs",
    ]
    return "\n".join(lines) + "\n"


def generate_fish_completion() -> str:
    """Return fish complete statements for all proverbs slash commands."""
    lines = [
        "# Proverbs fish completion",
        "# Place in ~/.config/fish/completions/proverbs.fish",
        "",
    ]
    for cmd in PROVERBS_COMMANDS:
        desc = _DESCRIPTIONS.get(cmd, "")
        # fish complete: -c command, -a argument, -d description
        lines.append(f"complete -c proverbs -f -a '{cmd}' -d '{desc}'")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Installers
# ---------------------------------------------------------------------------


def install_bash() -> str:
    """Write bash completion to ~/.bash_completion.d/proverbs and return the path."""
    dest = Path.home() / ".bash_completion.d" / "proverbs"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(generate_bash_completion())
    return str(dest)


def install_zsh() -> str:
    """Write zsh completion to ~/.zsh/completions/_proverbs and return the path."""
    dest = Path.home() / ".zsh" / "completions" / "_proverbs"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(generate_zsh_completion())
    return str(dest)


def install_fish() -> str:
    """Write fish completion to ~/.config/fish/completions/proverbs.fish and return the path."""
    dest = Path.home() / ".config" / "fish" / "completions" / "proverbs.fish"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(generate_fish_completion())
    return str(dest)


# ---------------------------------------------------------------------------
# Source instructions
# ---------------------------------------------------------------------------


def _print_bash_instructions(path: str) -> None:
    print(f"  Wrote: {path}")
    print("  To activate in the current shell, run:")
    print(f"    source {path}")
    print("  To activate automatically, add to ~/.bashrc:")
    print(f"    [ -f {path} ] && source {path}")


def _print_zsh_instructions(path: str) -> None:
    dest_dir = str(Path(path).parent)
    print(f"  Wrote: {path}")
    print("  Ensure the directory is on your fpath before compinit in ~/.zshrc:")
    print(f"    fpath=({dest_dir} $fpath)")
    print("    autoload -Uz compinit && compinit")
    print("  Then reload:")
    print("    exec zsh")


def _print_fish_instructions(path: str) -> None:
    print(f"  Wrote: {path}")
    print("  Fish loads completions automatically — restart fish or run:")
    print("    exec fish")


# ---------------------------------------------------------------------------
# Auto-detect shell
# ---------------------------------------------------------------------------


def _detect_shell() -> str:
    shell_env = os.environ.get("SHELL", "")
    if "zsh" in shell_env:
        return "zsh"
    if "fish" in shell_env:
        return "fish"
    # Default to bash for all other POSIX shells
    return "bash"


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Install shell autocompletion for proverbs slash commands.",
    )
    parser.add_argument(
        "--shell",
        choices=["bash", "zsh", "fish", "all"],
        default=None,
        help="Target shell (default: auto-detect from $SHELL).",
    )
    parser.add_argument(
        "--print",
        dest="print_only",
        action="store_true",
        help="Print the completion script to stdout instead of installing it.",
    )
    args = parser.parse_args()

    shell = args.shell or _detect_shell()

    if args.print_only:
        if shell == "all":
            print("# ── bash ──────────────────────────────────")
            print(generate_bash_completion())
            print("# ── zsh ───────────────────────────────────")
            print(generate_zsh_completion())
            print("# ── fish ──────────────────────────────────")
            print(generate_fish_completion())
        elif shell == "bash":
            print(generate_bash_completion(), end="")
        elif shell == "zsh":
            print(generate_zsh_completion(), end="")
        elif shell == "fish":
            print(generate_fish_completion(), end="")
        sys.exit(0)

    # Install
    targets: list[str] = ["bash", "zsh", "fish"] if shell == "all" else [shell]
    for target in targets:
        print(f"\n[{target}]")
        if target == "bash":
            path = install_bash()
            _print_bash_instructions(path)
        elif target == "zsh":
            path = install_zsh()
            _print_zsh_instructions(path)
        elif target == "fish":
            path = install_fish()
            _print_fish_instructions(path)
    print()
