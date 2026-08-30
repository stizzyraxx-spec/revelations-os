#!/bin/bash
# Proverbs AI Coding Assistant — Installer
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
echo -e "${BOLD}${CYAN}║   No Ollama. No cloud. Fully offline.            ║${RESET}"
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
echo -e "${BOLD}[1/4] Checking Node.js 18+...${RESET}"
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
    if command -v apt-get &>/dev/null; then
      info "Updating apt and installing nodejs..."
      sudo apt-get update -qq
      sudo apt-get install -y nodejs npm 2>&1 | tail -5
      if ! node_version_ok; then
        warn "Distro Node.js is too old. Installing via NodeSource (v20 LTS)..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
      fi
      ok "Node.js installed: $(node --version)"
    else
      err "apt-get not found."
      echo "  Manual fix: https://nodejs.org/en/download/package-manager/"
      exit 1
    fi
  fi
fi
echo ""

# ---------------------------------------------------------------------------
# 2. Install Proverbs CLI
# ---------------------------------------------------------------------------
echo -e "${BOLD}[2/4] Installing Proverbs CLI...${RESET}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "$SCRIPT_DIR/package.json" ]]; then
  info "Local package.json found — installing from source directory..."
  if (cd "$SCRIPT_DIR" && npm install -g .); then
    ok "Proverbs CLI installed from local source."
  else
    err "npm install -g . failed."
    exit 1
  fi
else
  info "Installing from npm registry..."
  if npm install -g proverbs-ai; then
    ok "Proverbs CLI installed."
  else
    err "npm install -g proverbs-ai failed."
    echo "  If permission errors occur, try: sudo npm install -g proverbs-ai"
    exit 1
  fi
fi
echo ""

# ---------------------------------------------------------------------------
# 3. Download default GGUF model
# ---------------------------------------------------------------------------
echo -e "${BOLD}[3/4] Downloading default model (Qwen2.5-Coder 1.5B, ~1.1 GB)...${RESET}"

MODELS_DIR="$HOME/.proverbs/models"
MODEL_FILE="Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf"
MODEL_URL="https://huggingface.co/bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/$MODEL_FILE"

mkdir -p "$MODELS_DIR"

if [[ -f "$MODELS_DIR/$MODEL_FILE" ]]; then
  ok "Model already downloaded: $MODEL_FILE"
else
  info "Downloading $MODEL_FILE from HuggingFace..."
  info "URL: $MODEL_URL"
  echo ""
  if command -v curl &>/dev/null; then
    if curl -L --progress-bar -o "$MODELS_DIR/$MODEL_FILE" "$MODEL_URL"; then
      ok "Model downloaded: $MODELS_DIR/$MODEL_FILE"
    else
      err "Download failed."
      echo "  Download manually and place in $MODELS_DIR/:"
      echo "    curl -L -o \"$MODELS_DIR/$MODEL_FILE\" \"$MODEL_URL\""
      echo "  Or run 'proverbs' and use /models download qwen2.5-coder-1.5b"
      # Non-fatal — user can download later
      warn "Continuing without model. Run '/server start' after adding a .gguf to $MODELS_DIR/"
    fi
  elif command -v wget &>/dev/null; then
    if wget -O "$MODELS_DIR/$MODEL_FILE" "$MODEL_URL"; then
      ok "Model downloaded: $MODELS_DIR/$MODEL_FILE"
    else
      err "wget download failed."
      warn "Continuing without model. Add a .gguf to $MODELS_DIR/ then run '/server start'"
    fi
  else
    warn "Neither curl nor wget found. Download the model manually:"
    echo "  URL: $MODEL_URL"
    echo "  Destination: $MODELS_DIR/$MODEL_FILE"
  fi
fi
echo ""

# ---------------------------------------------------------------------------
# 4. Verify install
# ---------------------------------------------------------------------------
echo -e "${BOLD}[4/4] Verifying installation...${RESET}"

PROVERBS_BIN="$(command -v proverbs 2>/dev/null || true)"

if [[ -n "$PROVERBS_BIN" ]]; then
  ok "Proverbs binary found at: $PROVERBS_BIN"
else
  NPM_BIN="$(npm prefix -g 2>/dev/null)/bin/proverbs"
  if [[ -x "$NPM_BIN" ]]; then
    warn "Proverbs installed but not yet on PATH."
    echo "  Binary: $NPM_BIN"
    echo "  Add to PATH:"
    echo "    export PATH=\"\$(npm prefix -g)/bin:\$PATH\""
    echo "  Then add that line to your ~/.bashrc or ~/.zshrc."
  else
    err "Could not locate the 'proverbs' binary after installation."
    echo "  Try: npm install -g proverbs-ai"
    exit 1
  fi
fi

MODEL_COUNT=$(ls "$MODELS_DIR"/*.gguf 2>/dev/null | wc -l | tr -d ' ')
if [[ "$MODEL_COUNT" -gt 0 ]]; then
  ok "Models ready in $MODELS_DIR: $MODEL_COUNT file(s)"
else
  warn "No .gguf models found in $MODELS_DIR"
  echo "  Add a model to get started:"
  echo "    Run 'proverbs' then type: /models download qwen2.5-coder-1.5b"
fi
echo ""

# ---------------------------------------------------------------------------
# Success
# ---------------------------------------------------------------------------
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════╗${RESET}"
echo -e "${GREEN}${BOLD}║  ✓ Proverbs installed!                           ║${RESET}"
echo -e "${GREEN}${BOLD}║                                                  ║${RESET}"
echo -e "${GREEN}${BOLD}║  Start the inference server:                     ║${RESET}"
echo -e "${GREEN}${BOLD}║    proverbs                                      ║${RESET}"
echo -e "${GREEN}${BOLD}║    /server start                                 ║${RESET}"
echo -e "${GREEN}${BOLD}║                                                  ║${RESET}"
echo -e "${GREEN}${BOLD}║  Then chat:  /backend auto                       ║${RESET}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════╝${RESET}"
echo ""
