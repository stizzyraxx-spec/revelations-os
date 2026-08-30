#!/usr/bin/env bash
# import_model.sh — Import a fine-tuned GGUF model into Ollama as 'proverbs-finetuned'
#
# Usage: bash finetune/import_model.sh /path/to/model.gguf

set -euo pipefail

MODELS_DIR="$HOME/.proverbs/models"
DEST_GGUF="$MODELS_DIR/proverbs-finetuned.gguf"
MODELFILE_PATH="$HOME/.proverbs/Modelfile.finetuned"
ACTIVE_MODEL_FILE="$HOME/.proverbs/active_model"
MODEL_NAME="proverbs-finetuned"

# ── helpers ────────────────────────────────────────────────────────────────────
info()  { printf '  \033[1;34m→\033[0m %s\n' "$*"; }
ok()    { printf '  \033[1;32m✔\033[0m %s\n' "$*"; }
die()   { printf '\n\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

echo "=== Proverbs: Import Fine-Tuned GGUF Model ==="
echo ""

# ── arg check ─────────────────────────────────────────────────────────────────
if [[ $# -lt 1 ]]; then
    die "No GGUF path provided.
Usage: bash finetune/import_model.sh /path/to/model.gguf"
fi

SRC_GGUF="$1"

# ── preflight ─────────────────────────────────────────────────────────────────
command -v ollama >/dev/null 2>&1 || die "ollama not found. Install from https://ollama.com"

[[ -f "$SRC_GGUF" ]] || die "GGUF file not found: $SRC_GGUF"

# Basic GGUF magic-byte check (first 4 bytes = GGUF)
MAGIC=$(xxd -l 4 -p "$SRC_GGUF" 2>/dev/null || hexdump -n 4 -e '1/1 "%02x"' "$SRC_GGUF" 2>/dev/null || true)
if [[ -n "$MAGIC" && "$MAGIC" != "47475546"* ]]; then
    die "File does not appear to be a valid GGUF: $SRC_GGUF
Expected magic bytes 47475546 (GGUF), got: $MAGIC"
fi

# ── copy GGUF ─────────────────────────────────────────────────────────────────
mkdir -p "$MODELS_DIR"
info "Copying GGUF to $DEST_GGUF ..."

# Use cp with progress if pv is available, otherwise plain cp
if command -v pv >/dev/null 2>&1; then
    pv "$SRC_GGUF" > "$DEST_GGUF"
else
    cp "$SRC_GGUF" "$DEST_GGUF"
fi

ok "GGUF copied."

# ── generate Modelfile ────────────────────────────────────────────────────────
info "Generating Modelfile at $MODELFILE_PATH ..."

cat > "$MODELFILE_PATH" <<MODELFILE
FROM ${DEST_GGUF}

SYSTEM """
You are Proverbs, an expert AI coding assistant fine-tuned on your personal coding
style and project conventions. Follow the user's established patterns and preferences
in every response.
"""
MODELFILE

ok "Modelfile written."

# ── create the Ollama model ───────────────────────────────────────────────────
echo ""
info "Running: ollama create ${MODEL_NAME} -f ${MODELFILE_PATH}"
echo ""

if ! ollama create "${MODEL_NAME}" -f "$MODELFILE_PATH"; then
    die "ollama create failed. Check the GGUF file is not corrupted and that
ollama has enough disk space / memory for this model size."
fi

# ── update active model pointer ───────────────────────────────────────────────
echo "${MODEL_NAME}" > "$ACTIVE_MODEL_FILE"
ok "Active model set to '${MODEL_NAME}' in ${ACTIVE_MODEL_FILE}"

echo ""
ok "Fine-tuned model '${MODEL_NAME}' imported successfully. Proverbs will now use it automatically."
echo ""
echo "  Test it with:  ollama run ${MODEL_NAME}"
echo "  Roll back with: echo 'proverbs-custom' > ${ACTIVE_MODEL_FILE}"
echo ""
