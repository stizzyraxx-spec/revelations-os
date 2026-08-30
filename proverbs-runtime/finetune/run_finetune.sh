#!/bin/bash
# run_finetune.sh — End-to-end pipeline: extract data → train → serve
# Usage:
#   bash finetune/run_finetune.sh              # full pipeline
#   bash finetune/run_finetune.sh --serve-only # start HF server only
#   bash finetune/run_finetune.sh --steps 200  # quick test run

set -e

PROVERBS_DIR="$HOME/.proverbs"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$REPO_DIR/venv_llm"
PYTHON="$VENV/bin/python3"
OUTPUT_DIR="$PROVERBS_DIR/checkpoints/finetuned-qwen"

# ── Parse flags ───────────────────────────────────────────────────────────────

SERVE_ONLY=false
EXTRA_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --serve-only) SERVE_ONLY=true ;;
    *)            EXTRA_ARGS+=("$arg") ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────

step() { echo; echo "━━━  $1"; echo; }
ok()   { echo "  ✓  $1"; }
fail() { echo "  ✗  $1" >&2; exit 1; }

# ── Checks ────────────────────────────────────────────────────────────────────

[ -f "$PYTHON" ] || fail "venv not found at $VENV — run: cd $REPO_DIR && python3 -m venv venv_llm && venv_llm/bin/pip install torch transformers peft datasets accelerate"

for pkg in peft transformers datasets accelerate; do
  "$PYTHON" -c "import $pkg" 2>/dev/null || fail "Missing package: $pkg — run: $VENV/bin/pip install $pkg"
done

# ── Serve-only mode ───────────────────────────────────────────────────────────

if [ "$SERVE_ONLY" = true ]; then
  if [ ! -d "$OUTPUT_DIR" ]; then
    fail "No fine-tuned model found at $OUTPUT_DIR — run: bash finetune/run_finetune.sh"
  fi
  step "Starting HF inference server on port 11436"
  exec "$PYTHON" -m inference.hf_server --model "$OUTPUT_DIR" --port 11436 --host 0.0.0.0
fi

# ── Step 1: Scan projects ─────────────────────────────────────────────────────

step "Step 1/3 — Scan projects"
node "$REPO_DIR/finetune/scan_projects.js"
ok "Projects scanned"

# ── Step 2: Extract training data ─────────────────────────────────────────────

step "Step 2/3 — Extract training data from your code"
"$PYTHON" "$REPO_DIR/finetune/extract_code_data.py"

DATA_FILE="$PROVERBS_DIR/finetune_data.jsonl"
[ -f "$DATA_FILE" ] || fail "Data file not created: $DATA_FILE"

COUNT=$(wc -l < "$DATA_FILE")
ok "$COUNT training examples ready"

# ── Step 3: Fine-tune ─────────────────────────────────────────────────────────

step "Step 3/3 — Fine-tuning Qwen2.5-Coder-1.5B with LoRA"
if python3 -c "import torch; exit(0 if torch.cuda.is_available() or torch.backends.mps.is_available() else 1)" 2>/dev/null; then
  echo "  GPU detected. Estimated time: 20-60 minutes."
else
  echo "  No GPU detected — training on CPU. Estimated time: 1-3 hours."
  echo "  Tip: run overnight, or use --steps 50 for a quick 20-minute test."
fi
echo "  Progress is printed every 20 steps."
echo "  Press Ctrl+C to stop early (adapter checkpoint is saved every 50 steps)."
echo

"$PYTHON" "$REPO_DIR/finetune/finetune_qwen.py" \
  --output "$OUTPUT_DIR" \
  --data "$DATA_FILE" \
  "${EXTRA_ARGS[@]}"

# ── Done ──────────────────────────────────────────────────────────────────────

echo
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Fine-tuning complete!"
echo
echo "  To serve your model:"
echo "    bash finetune/run_finetune.sh --serve-only"
echo
echo "  Then in proverbs:"
echo "    /backend http://localhost:11436"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
