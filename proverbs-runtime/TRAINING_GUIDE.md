# Proverbs LLM — Training Guide

## What you're building

A transformer language model trained **only on code** — Python, JavaScript, Go, Java, TypeScript.
No general knowledge, no chat fluff. It learns code structure, patterns, and logic.

## Hardware requirements

| Model size | VRAM needed | Pre-train time (RTX 3080) |
|------------|-------------|--------------------------|
| small (58M)  | 4 GB  | ~3–6 hours  |
| medium (254M)| 8 GB  | ~12–24 hours |
| large (1.6B) | 16+ GB | Days         |

**Start with small.** It's fast to iterate, and 58M params on clean code data produces
a model that understands syntax, structure, and common patterns well.

---

## Step-by-step on your NVIDIA GPU machine

### 1. Copy the project to your GPU machine

```bash
rsync -av /Users/Stizzop/proverbs/ user@gpu-machine:~/proverbs/
# OR use git, scp, etc.
```

### 2. Set up Python environment on the GPU machine

```bash
cd ~/proverbs
python3.11 -m venv venv
source venv/bin/activate

# Install PyTorch with CUDA (check pytorch.org for your CUDA version)
pip install torch --index-url https://download.pytorch.org/whl/cu121
pip install datasets tqdm numpy fastapi uvicorn pydantic
```

### 3. Download code training data (~500MB)

```bash
python scripts/download_pretrain_data.py
# Downloads Python, JavaScript, Go, Java, TypeScript, Ruby from CodeSearchNet
# Output: ~/.proverbs/pretrain_data/*.jsonl
# Estimated: ~300M tokens total
```

For a faster test run, limit it:
```bash
python scripts/download_pretrain_data.py --max-per-lang 10000 --langs python javascript
```

### 4. Train the tokenizer on code data

```bash
python -m tokenizer.train_tokenizer \
  --extra-data ~/.proverbs/pretrain_data \
  --vocab-size 32000 \
  --output ~/.proverbs/tokenizer.json
```

### 5. Pre-train on code

```bash
python -m training.train \
  --mode pretrain \
  --size small \
  --data ~/.proverbs/pretrain_data \
  --batch-size 16 \
  --max-steps 50000 \
  --compile
```

Watch for the loss to drop below **2.0** — that means the model is learning code structure.
Below **1.5** means it's generating syntactically correct code most of the time.

Checkpoints save to `~/.proverbs/checkpoints/pretrain/`.

### 6. Fine-tune on your coding sessions

Once pre-training is done (or at any checkpoint), fine-tune on your actual usage:

```bash
python -m training.train \
  --mode finetune \
  --resume ~/.proverbs/checkpoints/pretrain/best.pt \
  --batch-size 4 \
  --max-steps 2000
```

This teaches the model your coding style, project conventions, and preferences.

### 7. Copy the trained model back to your Mac

```bash
scp user@gpu-machine:~/.proverbs/checkpoints/finetune/best.pt \
    ~/.proverbs/checkpoints/best.pt
```

### 8. Start the Proverbs server on your Mac

```bash
~/.proverbs/venv/bin/python -m inference.server \
  --model ~/.proverbs/checkpoints/best.pt \
  --port 11434
```

### 9. Use it

```bash
node /Users/Stizzop/proverbs/cli.js
```

The CLI connects to the Proverbs server exactly as before — same port, same format.

---

## What makes it good at coding

The model learns three things in order:

1. **Syntax and structure** (pre-training on code)
   — indentation, brackets, function signatures, class hierarchies

2. **Patterns and design** (pre-training on diverse languages)
   — how functions call each other, how APIs are structured, common algorithms

3. **Your style** (fine-tuning on sessions)
   — your naming conventions, preferred libraries, project architecture

After step 2, it can already suggest reasonable implementations.
After step 3, it suggests implementations that match *your* codebase.

---

## Adding your coding rules

Edit `~/.proverbs/rules.md` and add numbered rules:

```
# Proverbs Rules
1. Always use TypeScript with strict mode
2. Prefer functional patterns over classes
3. Every function needs a return type annotation
4. Never use 'any' type
5. Use async/await, not .then() chains
```

These inject into **every prompt automatically** — no retraining needed.

---

## Monitoring training

The trainer logs every 20 steps:
```
step 1000 | loss 3.241 | lr 2.95e-4 | tok/s 18432 | GPU: 3.1GB
step 1020 | loss 3.108 | lr 2.94e-4 | tok/s 18560 | GPU: 3.1GB
```

Loss milestones:
- **~10.5** — random init (where you start)
- **~3.0**  — learning basic code structure
- **~2.0**  — generating mostly valid syntax
- **~1.5**  — generating coherent, runnable code
- **~1.2**  — strong code understanding and generation
