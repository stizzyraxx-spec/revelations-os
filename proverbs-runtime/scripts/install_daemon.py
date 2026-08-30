"""Install Proverbs server as a system daemon (macOS launchd or Linux systemd)."""

import argparse
import platform
import subprocess
import sys
from pathlib import Path

PLIST_LABEL = "com.proverbs.server"
PLIST_PATH = Path.home() / "Library/LaunchAgents/com.proverbs.server.plist"
SYSTEMD_PATH = Path.home() / ".config/systemd/user/proverbs.service"
VENV_PYTHON = Path.home() / ".proverbs/venv/bin/python"
PROJECT_ROOT = Path(__file__).resolve().parent.parent


def generate_plist() -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{VENV_PYTHON}</string>
        <string>-m</string>
        <string>inference.server</string>
    </array>
    <key>WorkingDirectory</key>
    <string>{PROJECT_ROOT}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/proverbs-server.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/proverbs-server.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PROVERBS_MODEL_PATH</key>
        <string></string>
        <key>PROVERBS_TOKENIZER_PATH</key>
        <string></string>
    </dict>
</dict>
</plist>
"""


def generate_systemd_unit() -> str:
    return f"""[Unit]
Description=Proverbs LLM Server
After=network.target

[Service]
ExecStart={VENV_PYTHON} -m inference.server
WorkingDirectory={PROJECT_ROOT}
Restart=always
RestartSec=5
Environment=PROVERBS_MODEL_PATH=
Environment=PROVERBS_TOKENIZER_PATH=

[Install]
WantedBy=default.target
"""


def _run(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=check, capture_output=True, text=True)


def install_macos() -> None:
    PLIST_PATH.parent.mkdir(parents=True, exist_ok=True)
    PLIST_PATH.write_text(generate_plist())
    print(f"Wrote plist to {PLIST_PATH}")
    result = _run(["launchctl", "load", str(PLIST_PATH)], check=False)
    if result.returncode != 0:
        print(f"launchctl load failed: {result.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    print(f"Daemon loaded. Check status with:\n  launchctl list {PLIST_LABEL}")


def install_linux() -> None:
    SYSTEMD_PATH.parent.mkdir(parents=True, exist_ok=True)
    SYSTEMD_PATH.write_text(generate_systemd_unit())
    print(f"Wrote unit file to {SYSTEMD_PATH}")
    for cmd in [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "proverbs"],
        ["systemctl", "--user", "start", "proverbs"],
    ]:
        result = _run(cmd, check=False)
        if result.returncode != 0:
            print(f"Command failed: {' '.join(cmd)}\n{result.stderr.strip()}", file=sys.stderr)
            sys.exit(1)
        print(f"  {' '.join(cmd)}")
    print("Daemon enabled and started.")


def uninstall() -> None:
    system = platform.system()
    if system == "Darwin":
        if PLIST_PATH.exists():
            _run(["launchctl", "unload", str(PLIST_PATH)], check=False)
            PLIST_PATH.unlink()
            print(f"Unloaded and removed {PLIST_PATH}")
        else:
            print("Plist not found; nothing to uninstall.")
    elif system == "Linux":
        if SYSTEMD_PATH.exists():
            _run(["systemctl", "--user", "stop", "proverbs"], check=False)
            _run(["systemctl", "--user", "disable", "proverbs"], check=False)
            SYSTEMD_PATH.unlink()
            _run(["systemctl", "--user", "daemon-reload"], check=False)
            print(f"Stopped, disabled, and removed {SYSTEMD_PATH}")
        else:
            print("Unit file not found; nothing to uninstall.")
    else:
        print(f"Unsupported platform: {system}", file=sys.stderr)
        sys.exit(1)


def status() -> None:
    system = platform.system()
    if system == "Darwin":
        result = _run(["launchctl", "list", PLIST_LABEL], check=False)
        if result.returncode == 0:
            print(f"Daemon is running:\n{result.stdout.strip()}")
        else:
            print("Daemon is not running.")
    elif system == "Linux":
        result = _run(["systemctl", "--user", "status", "proverbs"], check=False)
        print(result.stdout.strip() or result.stderr.strip())
    else:
        print(f"Unsupported platform: {system}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Manage the Proverbs server daemon.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("install", help="Install and start the daemon.")
    sub.add_parser("uninstall", help="Stop, disable, and remove the daemon.")
    sub.add_parser("status", help="Show daemon status.")
    args = parser.parse_args()

    system = platform.system()

    if args.command == "install":
        if system == "Darwin":
            install_macos()
        elif system == "Linux":
            install_linux()
        else:
            print(f"Unsupported platform: {system}", file=sys.stderr)
            sys.exit(1)
    elif args.command == "uninstall":
        uninstall()
    elif args.command == "status":
        status()
