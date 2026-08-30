#!/usr/bin/env bash
# bake_model.sh — Instant-bake a custom Ollama model from ~/.proverbs/rules.md
# No training required — embeds rules directly into the system prompt.
#
# Usage: bash finetune/bake_model.sh

set -euo pipefail

RULES_FILE="$HOME/.proverbs/rules.md"
MODELFILE_PATH="$HOME/.proverbs/Modelfile"
ACTIVE_MODEL_FILE="$HOME/.proverbs/active_model"
MODEL_NAME="proverbs-custom"
BASE_MODEL="qwen2.5-coder:7b"

# ── helpers ────────────────────────────────────────────────────────────────────
info()  { printf '  \033[1;34m→\033[0m %s\n' "$*"; }
ok()    { printf '  \033[1;32m✔\033[0m %s\n' "$*"; }
warn()  { printf '  \033[1;33m!\033[0m %s\n' "$*" >&2; }
die()   { printf '\n\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

echo "=== Proverbs: Bake Custom Ollama Model ==="
echo ""

# ── preflight ──────────────────────────────────────────────────────────────────
command -v ollama >/dev/null 2>&1 || die "ollama not found. Install from https://ollama.com"

if [[ ! -f "$RULES_FILE" ]]; then
    die "Rules file not found: $RULES_FILE
Create it and add numbered rules (e.g. '1. Always add types')."
fi

# ── extract numbered rules ─────────────────────────────────────────────────────
info "Reading rules from $RULES_FILE ..."

# Capture lines that start with one or more digits followed by a dot
mapfile -t RULE_LINES < <(grep -E '^[0-9]+\.' "$RULES_FILE" || true)

if [[ ${#RULE_LINES[@]} -eq 0 ]]; then
    die "No numbered rules found in $RULES_FILE.
Add lines like:  1. Always add TypeScript types
                 2. Never use 'any'"
fi

info "Found ${#RULE_LINES[@]} rules."

# ── build the rules block ──────────────────────────────────────────────────────
RULES_BLOCK=""
for line in "${RULE_LINES[@]}"; do
    RULES_BLOCK+="${line}"$'\n'
done
# Trim trailing newline
RULES_BLOCK="${RULES_BLOCK%$'\n'}"

# ── generate Modelfile ─────────────────────────────────────────────────────────
mkdir -p "$(dirname "$MODELFILE_PATH")"
info "Generating $MODELFILE_PATH ..."

cat > "$MODELFILE_PATH" <<MODELFILE
FROM ${BASE_MODEL}

SYSTEM """
You are Proverbs, an expert AI coding assistant running locally on the user's machine.
You provide concise, accurate, and idiomatic code. You prioritize clarity and correctness.

## Your Permanent Rules (follow these in every response):
${RULES_BLOCK}
"""
MODELFILE

ok "Modelfile written."

# ── create the Ollama model ────────────────────────────────────────────────────
echo ""
info "Running: ollama create ${MODEL_NAME} -f ${MODELFILE_PATH}"
echo ""

if ! ollama create "${MODEL_NAME}" -f "$MODELFILE_PATH"; then
    die "ollama create failed. Check that the base model '${BASE_MODEL}' is pulled:
  ollama pull ${BASE_MODEL}"
fi

# ── update active model pointer ────────────────────────────────────────────────
echo "${MODEL_NAME}" > "$ACTIVE_MODEL_FILE"
ok "Active model set to '${MODEL_NAME}' in ${ACTIVE_MODEL_FILE}"

echo ""
ok "Custom model '${MODEL_NAME}' created. Proverbs will now use it automatically."
echo ""
echo "  Test it with:  ollama run ${MODEL_NAME}"
echo ""
