#!/bin/bash
set -e

echo "Starting Proverbs services..."

# Start the Node.js inference server (llama.cpp-based, port 11435)
if lsof -ti:11435 > /dev/null 2>&1; then
  echo "Inference server already running on port 11435."
else
  echo "Starting inference server on port 11435..."
  node "$(dirname "$0")/server/server.js" \
    --port 11435 \
    --models-dir "$HOME/.proverbs/models" \
    > /tmp/proverbs-server.log 2>&1 &
  SERVER_PID=$!
  echo $SERVER_PID > /tmp/proverbs-server.pid
  echo "Inference server started (pid $SERVER_PID). Log: /tmp/proverbs-server.log"
fi

# Optionally start the HF fine-tuned model server (port 11436)
# Started automatically when ~/.proverbs/checkpoints/finetuned-qwen/ exists.
HF_MODEL="${PROVERBS_HF_MODEL:-$HOME/.proverbs/checkpoints/finetuned-qwen}"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -d "$HF_MODEL" ]; then
  if lsof -ti:11436 > /dev/null 2>&1; then
    echo "Fine-tuned model server already running on port 11436."
  else
    echo "Starting fine-tuned model server on port 11436..."
    "$REPO_DIR/venv_llm/bin/python3" "$REPO_DIR/inference/hf_server.py" \
      --model "$HF_MODEL" --host 0.0.0.0 --port 11436 \
      > /tmp/proverbs-hf-server.log 2>&1 &
    HF_PID=$!
    echo $HF_PID > /tmp/proverbs-hf-server.pid
    echo "Fine-tuned model server started (pid $HF_PID). Log: /tmp/proverbs-hf-server.log"
  fi
else
  echo "Skipping fine-tuned model server — run fine-tuning first:"
  echo "  bash finetune/run_finetune.sh"
fi

echo ""
echo "Proverbs services running:"
echo "  GGUF server (base models)  : http://localhost:11435"
echo "  HF server (fine-tuned)     : http://localhost:11436  $([ -d "$HF_MODEL" ] && echo '✓' || echo '(not trained yet)')"
