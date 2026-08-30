#!/usr/bin/env bash
# run_training_pipeline.sh — Wait for tokenizer, then train nano model on 87k examples
set -euo pipefail

VENV="$HOME/.proverbs/venv/bin/python3"
ROOT="$(cd "$(dirname "$0")" && pwd)"
LOG="$HOME/.proverbs/training.log"

cd "$ROOT"

info() { printf '\n\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()   { printf '\033[1;32m  ✔ %s\033[0m\n' "$*"; }

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   ProverbsLM — Full Training Pipeline        ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── Step 1: Wait for tokenizer ────────────────────────────────────────────────
info "Step 1/3 — Waiting for tokenizer to finish training..."
TOKENIZER="$HOME/.proverbs/tokenizer.json"
WAIT=0
while pgrep -f "train_tokenizer" > /dev/null 2>&1; do
    sleep 10
    WAIT=$((WAIT + 10))
    printf "\r  Tokenizer training: %ds elapsed..." $WAIT
done
echo ""

if [[ -f "$TOKENIZER" ]]; then
    SIZE=$(stat -f%z "$TOKENIZER" 2>/dev/null || stat -c%s "$TOKENIZER" 2>/dev/null)
    ok "Tokenizer ready ($((SIZE/1024)) KB) — $TOKENIZER"
else
    echo "  ERROR: Tokenizer not found. Something went wrong."
    exit 1
fi

# ── Step 2: Train nano model on pretrain data ─────────────────────────────────
info "Step 2/3 — Pre-training nano (14.5M) model on 87k code examples..."
echo ""
echo "  This will train for 5,000 steps (~10-14 hours on CPU)"
echo "  Checkpoints saved every 500 steps to ~/.proverbs/checkpoints/pretrain/"
echo "  Press Ctrl+C to stop — training auto-saves and resumes from latest checkpoint"
echo ""

PRETRAIN_DIR="$HOME/.proverbs/pretrain_data"
CKPT_DIR="$HOME/.proverbs/checkpoints"

# Check for existing pretrain checkpoint to resume from
RESUME_ARG=""
if ls "$CKPT_DIR/pretrain/checkpoint-"*.pt > /dev/null 2>&1; then
    LATEST=$(ls -t "$CKPT_DIR/pretrain/checkpoint-"*.pt | head -1)
    echo "  Resuming from: $LATEST"
    RESUME_ARG="--resume $LATEST"
fi

"$VENV" -m training.train \
    --mode pretrain \
    --size nano \
    --data "$PRETRAIN_DIR" \
    --tokenizer "$TOKENIZER" \
    --output-dir "$CKPT_DIR" \
    --batch-size 4 \
    --max-steps 5000 \
    --lr 3e-4 \
    --warmup 200 \
    --log-every 20 \
    --eval-every 250 \
    --save-every 500 \
    $RESUME_ARG \
    2>&1 | tee -a "$LOG"

ok "Pre-training complete. Checkpoint at $CKPT_DIR/pretrain/best.pt"

# ── Step 3: Fine-tune on personal sessions ────────────────────────────────────
info "Step 3/3 — Fine-tuning on your coding sessions..."
BEST="$CKPT_DIR/pretrain/best.pt"
SESSIONS="$HOME/.proverbs/sessions"

SESSION_COUNT=$(ls "$SESSIONS"/*.jsonl 2>/dev/null | wc -l | tr -d ' ')
if [[ "$SESSION_COUNT" -lt 2 ]]; then
    echo "  Skipping fine-tune — not enough session data ($SESSION_COUNT files)"
else
    echo "  Fine-tuning on $SESSION_COUNT session files..."
    "$VENV" -m training.train \
        --mode finetune \
        --resume "$BEST" \
        --sessions "$SESSIONS" \
        --tokenizer "$TOKENIZER" \
        --output-dir "$CKPT_DIR" \
        --batch-size 2 \
        --max-steps 3000 \
        --lr 1e-4 \
        --log-every 20 \
        --eval-every 250 \
        --save-every 500 \
        2>&1 | tee -a "$LOG"
    ok "Fine-tuning complete."
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Training complete! Next steps:              ║"
echo "║                                              ║"
echo "║  1. In Proverbs CLI: /train export           ║"
echo "║     Converts best.pt → .gguf                 ║"
echo "║                                              ║"
echo "║  2. Restart the inference server:            ║"
echo "║     launchctl kickstart -k gui/$(id -u)/     ║"
echo "║     com.proverbs.server                      ║"
echo "║                                              ║"
echo "║  Your model. Your weights. Zero deps.        ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
