#!/bin/bash
# Proverbs AI Coding Assistant — Developer Installer v3.1.0
# Sets up the full local stack: Node.js, Python training venv, and the
# built-in Proverbs inference server (node-llama-cpp). No Ollama required.
# Idempotent: safe to run multiple times.

set -euo pipefail

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

ok()   { echo -e "${GREEN}✓${RESET} $*"; }
err()  { echo -e "${RED}✗ ERROR:${RESET} $*" >&2; }
warn() { echo -e "${YELLOW}⚠${RESET} $*"; }
info() { echo -e "${CYAN}→${RESET} $*"; }

# ---------------------------------------------------------------------------
# Detect OS
# ---------------------------------------------------------------------------
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="mac" ;;
  Linux)  PLATFORM="linux" ;;
  *)
    err "Unsupported platform: $OS"
    echo "  Proverbs currently supports macOS and Linux."
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
echo ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${CYAN}║   Installing Proverbs AI Coding Assistant...     ║${RESET}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════╝${RESET}"
echo ""
info "Platform: $OS"
echo ""

# ---------------------------------------------------------------------------
# Helper: version-number comparison (major only)
# Returns 0 if installed version is >= required major
# ---------------------------------------------------------------------------
node_version_ok() {
  local ver
  ver=$(node --version 2>/dev/null | sed 's/v//')
  local major="${ver%%.*}"
  [[ "$major" -ge 18 ]] 2>/dev/null
}

# ---------------------------------------------------------------------------
# 1. Node.js 18+
# ---------------------------------------------------------------------------
echo -e "${BOLD}[1/5] Checking Node.js 18+...${RESET}"
if node_version_ok; then
  ok "Node.js $(node --version) already installed."
else
  warn "Node.js 18+ not found. Installing..."
  if [[ "$PLATFORM" == "mac" ]]; then
    if ! command -v brew &>/dev/null; then
      err "Homebrew is required but not installed."
      echo "  Install it first:  /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
      exit 1
    fi
    info "Running: brew install node"
    if brew install node; then
      ok "Node.js installed: $(node --version)"
    else
      err "brew install node failed."
      echo "  Manual fix: https://nodejs.org/en/download/"
      exit 1
    fi
  else
    # Linux — use apt if available, otherwise NodeSource
    if command -v apt-get &>/dev/null; then
      info "Updating apt and installing nodejs..."
      sudo apt-get update -qq
      if ! sudo apt-get install -y nodejs npm 2>&1 | tail -5; then
        err "apt-get install nodejs failed."
        echo "  Manual fix: https://nodejs.org/en/download/package-manager/"
        exit 1
      fi
      # Confirm version is acceptable; if distro ships old Node, use NodeSource
      if ! node_version_ok; then
        warn "Distro Node.js is too old. Installing via NodeSource (v20 LTS)..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
      fi
      ok "Node.js installed: $(node --version)"
    else
      err "apt-get not found and Homebrew not available."
      echo "  Manual fix: https://nodejs.org/en/download/package-manager/"
      exit 1
    fi
  fi
fi
echo ""

# ---------------------------------------------------------------------------
# 2. Python 3.11+
# ---------------------------------------------------------------------------
echo -e "${BOLD}[2/5] Checking Python 3.11+...${RESET}"

VENV_PYTHON="$HOME/.proverbs/venv/bin/python"

python_version_ok() {
  local py_bin="$1"
  local ver
  ver=$("$py_bin" --version 2>/dev/null | sed 's/Python //')
  local major="${ver%%.*}"
  local minor="${ver#*.}"; minor="${minor%%.*}"
  [[ "$major" -ge 3 && "$minor" -ge 11 ]] 2>/dev/null
}

if [[ -x "$VENV_PYTHON" ]] && python_version_ok "$VENV_PYTHON"; then
  ok "Python $($VENV_PYTHON --version 2>/dev/null) found in ~/.proverbs/venv."
else
  # Fall back to system python3
  SYS_PYTHON="$(command -v python3 2>/dev/null || true)"
  if [[ -n "$SYS_PYTHON" ]] && python_version_ok "$SYS_PYTHON"; then
    ok "System Python $($SYS_PYTHON --version 2>/dev/null) meets requirement."
  else
    err "Python 3.11+ is required but was not found."
    echo "  Expected location: ~/.proverbs/venv/bin/python (3.11+)"
    echo "  Or install Python 3.11+ system-wide."
    if [[ "$PLATFORM" == "mac" ]]; then
      echo "  macOS: brew install python@3.11"
    else
      echo "  Linux: sudo apt-get install python3.11 python3.11-venv"
    fi
    exit 1
  fi
fi
echo ""

# ---------------------------------------------------------------------------
# 3. llama-cpp-python in ~/.proverbs/venv
# ---------------------------------------------------------------------------
echo -e "${BOLD}[3/5] Checking llama-cpp-python in ~/.proverbs/venv...${RESET}"

if [[ -x "$VENV_PYTHON" ]]; then
  if "$VENV_PYTHON" -c "import llama_cpp" 2>/dev/null; then
    ok "llama-cpp-python is installed in ~/.proverbs/venv."
  else
    err "llama-cpp-python is not installed in ~/.proverbs/venv."
    echo "  To install it, activate the venv and run:"
    echo "    source ~/.proverbs/venv/bin/activate"
    echo "    pip install llama-cpp-python"
    exit 1
  fi
else
  err "~/.proverbs/venv does not exist or has no Python binary."
  echo "  Create the venv first:"
  echo "    python3.11 -m venv ~/.proverbs/venv"
  echo "    source ~/.proverbs/venv/bin/activate"
  echo "    pip install llama-cpp-python"
  exit 1
fi
echo ""

# ---------------------------------------------------------------------------
# 4. Register Proverbs Server launch agent (macOS only)
#    Runs the built-in node-llama-cpp server on port 11435 at login.
# ---------------------------------------------------------------------------
echo -e "${BOLD}[4/5] Registering Proverbs Server launch agent...${RESET}"

PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/com.proverbs.server.plist"
NODE_BIN="$(command -v node)"
SERVER_JS="$(npm prefix -g)/lib/node_modules/proverbs-ai/server/server.js"

if [[ "$PLATFORM" == "mac" ]]; then
  # If installed from local source, find server.js relative to this script
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "$SCRIPT_DIR/server/server.js" ]]; then
    SERVER_JS="$SCRIPT_DIR/server/server.js"
  fi

  info "Writing launch agent plist to $PLIST_PATH"
  mkdir -p "$PLIST_DIR"

  cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.proverbs.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${SERVER_JS}</string>
    <string>--port</string>
    <string>11435</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PROVERBS_MODELS_DIR</key><string>${HOME}/.proverbs/models</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/proverbs-server.log</string>
  <key>StandardErrorPath</key><string>/tmp/proverbs-server.log</string>
</dict>
</plist>
PLIST

  ok "Launch agent plist written (node=${NODE_BIN}, port=11435)."

  info "Registering with launchctl..."
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  if launchctl load "$PLIST_PATH"; then
    ok "Launch agent registered — Proverbs Server will start at login on port 11435."
  else
    err "launchctl load failed."
    echo "  Manual fix: launchctl load $PLIST_PATH"
    exit 1
  fi
else
  warn "Launch agent registration is macOS-only. Skipping on $OS."
  echo "  On Linux, add to your systemd user services or start manually with: proverbs /server start"
fi
echo ""

# ---------------------------------------------------------------------------
# 5. Install Proverbs CLI
# ---------------------------------------------------------------------------
echo -e "${BOLD}[5/5] Installing Proverbs CLI...${RESET}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "$SCRIPT_DIR/package.json" ]]; then
  info "Local package.json found — installing from source directory..."
  info "Running: npm install -g ."
  if (cd "$SCRIPT_DIR" && npm install -g .); then
    ok "Proverbs CLI installed from local source."
  else
    err "npm install -g . failed."
    echo "  Manual fix: cd $SCRIPT_DIR && npm install -g ."
    exit 1
  fi
else
  info "No local package.json found — installing from npm registry..."
  info "Running: npm install -g proverbs-ai"
  if npm install -g proverbs-ai; then
    ok "Proverbs CLI installed from npm."
  else
    err "npm install -g proverbs-ai failed."
    echo "  Manual fix: npm install -g proverbs-ai"
    echo "  If permission errors occur, try: sudo npm install -g proverbs-ai"
    exit 1
  fi
fi
echo ""

# ---------------------------------------------------------------------------
# 6. Verify install
# ---------------------------------------------------------------------------
echo -e "${BOLD}[6/6] Verifying installation...${RESET}"

PROVERBS_BIN="$(command -v proverbs 2>/dev/null || true)"

if [[ -n "$PROVERBS_BIN" ]]; then
  PROVERBS_VER="$(proverbs --version 2>/dev/null || echo 'installed')"
  ok "Proverbs binary found at: $PROVERBS_BIN"
  ok "Version: $PROVERBS_VER"
else
  # npm global bin might not be on PATH yet — check common locations
  NPM_BIN="$(npm bin -g 2>/dev/null || npm prefix -g 2>/dev/null)/bin/proverbs"
  if [[ -x "$NPM_BIN" ]]; then
    warn "Proverbs installed but not yet on PATH."
    echo "  Binary: $NPM_BIN"
    echo "  Add npm's global bin to your PATH:"
    echo "    export PATH=\"\$(npm prefix -g)/bin:\$PATH\""
    echo "  Then add that line to your ~/.bashrc or ~/.zshrc."
  else
    err "Could not locate the 'proverbs' binary after installation."
    echo "  Try opening a new terminal window and running: proverbs --version"
    echo "  If still missing, check: npm list -g proverbs-ai"
    exit 1
  fi
fi
echo ""

# ---------------------------------------------------------------------------
# Success
# ---------------------------------------------------------------------------
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════╗${RESET}"
echo -e "${GREEN}${BOLD}║  ✓ Proverbs v3.0.0 installed! Type 'proverbs'   ║${RESET}"
echo -e "${GREEN}${BOLD}║    in any terminal to start.                     ║${RESET}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════╝${RESET}"
echo ""
