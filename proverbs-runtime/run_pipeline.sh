#!/usr/bin/env bash
# run_pipeline.sh — Full end-to-end pipeline: data → tokenizer → train → serve
# Runs entirely on your Mac, fully offline.
#
# Usage: bash run_pipeline.sh

set -euo pipefail

VENV="$HOME/.proverbs/venv/bin/python"
ROOT="$(cd "$(dirname "$0")" && pwd)"
CHECKPOINTS="$HOME/.proverbs/checkpoints/local"

cd "$ROOT"

info() { printf '\n\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()   { printf '\033[1;32m  ✔ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║     Proverbs LLM — Full Local Pipeline       ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "  Step 1: Generate synthetic training data (~30-40 min)"
echo "  Step 2: Train tokenizer                  (~2 min)"
echo "  Step 3: Train micro model on CPU         (~1-2 hrs)"
echo "  Step 4: Start Proverbs server            (instant)"
echo ""

# ── Step 1: Generate training data ──────────────────────────────────────────
info "Step 1/4 — Generating synthetic coding training data"

SYNTHETIC="$HOME/.proverbs/sessions/synthetic_coding.jsonl"
if [[ -f "$SYNTHETIC" ]]; then
    COUNT=$(wc -l < "$SYNTHETIC")
    if [[ $COUNT -ge 50 ]]; then
        ok "Already have $COUNT synthetic examples — skipping generation"
    else
        echo "  Found $COUNT examples, resuming from where we left off..."
        "$VENV" scripts/generate_training_data.py
    fi
else
    "$VENV" scripts/generate_training_data.py
fi

# ── Step 2: Train tokenizer ──────────────────────────────────────────────────
info "Step 2/4 — Training tokenizer on session data"

TOKENIZER="$HOME/.proverbs/tokenizer.json"
if [[ -f "$TOKENIZER" ]]; then
    ok "Tokenizer already exists at $TOKENIZER — skipping"
else
    "$VENV" -m tokenizer.train_tokenizer \
        --data-dir "$HOME/.proverbs/sessions" \
        --vocab-size 8000 \
        --output "$TOKENIZER"
    ok "Tokenizer saved to $TOKENIZER"
fi

# ── Step 3: Train micro model ────────────────────────────────────────────────
info "Step 3/4 — Training micro model (5M params) on CPU"

BEST="$CHECKPOINTS/best.pt"
if [[ -f "$BEST" ]]; then
    ok "Checkpoint already exists at $BEST — skipping training"
else
    "$VENV" -m training.train \
        --mode local \
        --sessions "$HOME/.proverbs/sessions" \
        --tokenizer "$TOKENIZER" \
        --output-dir "$HOME/.proverbs/checkpoints" \
        --batch-size 2 \
        --max-steps 3000 \
        --log-every 50 \
        --eval-every 300 \
        --save-every 500
    ok "Training complete. Checkpoint at $BEST"
fi

# ── Step 4: Start the server ─────────────────────────────────────────────────
info "Step 4/4 — Starting Proverbs server"
echo ""
echo "  Starting on port 11434..."
echo "  In another terminal, run:  node $ROOT/cli.js"
echo ""
echo "  Press Ctrl+C to stop."
echo ""

if [[ -f "$BEST" ]]; then
    PROVERBS_MODEL_PATH="$BEST" \
    PROVERBS_TOKENIZER_PATH="$TOKENIZER" \
    PROVERBS_BACKEND="pytorch" \
        "$VENV" -m inference.server --port 11434
else
    # Fall back to GGUF if training was skipped
    "$VENV" -m inference.server --port 11434
fi
