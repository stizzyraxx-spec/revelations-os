#!/usr/bin/env python3
"""
upload_hf.py — Upload Proverbs training data to Hugging Face and trigger AutoTrain.

Requires env vars:
  HF_TOKEN      — Hugging Face write-access token
  HF_USERNAME   — Your Hugging Face username

Usage:
  python upload_hf.py
"""

import os
import sys
from pathlib import Path

TRAINING_DIR = Path.home() / ".proverbs" / "training"
TRAIN_FILE   = TRAINING_DIR / "train.jsonl"
VALID_FILE   = TRAINING_DIR / "valid.jsonl"

REPO_SUFFIX       = "proverbs-training"
BASE_MODEL        = "Qwen/Qwen2.5-Coder-7B-Instruct"
LORA_RANK         = 16
EPOCHS            = 3


def check_huggingface_hub() -> bool:
    try:
        import huggingface_hub  # noqa: F401
        return True
    except ImportError:
        return False


def main() -> None:
    print("=== Proverbs: Upload Training Data to Hugging Face ===\n")

    # Dependency check
    if not check_huggingface_hub():
        print("[error] huggingface_hub is not installed.")
        print("        pip install huggingface_hub")
        sys.exit(1)

    from huggingface_hub import HfApi, create_repo

    # Env var check
    hf_token    = os.environ.get("HF_TOKEN", "").strip()
    hf_username = os.environ.get("HF_USERNAME", "").strip()

    missing = []
    if not hf_token:
        missing.append("HF_TOKEN")
    if not hf_username:
        missing.append("HF_USERNAME")
    if missing:
        print(f"[error] Missing required env vars: {', '.join(missing)}")
        print("        Export them before running:")
        for var in missing:
            print(f"          export {var}=your_value_here")
        sys.exit(1)

    # Training file check
    for fpath in (TRAIN_FILE, VALID_FILE):
        if not fpath.exists():
            print(f"[error] Training file not found: {fpath}")
            print("        Run  python finetune/format_data.py  first.")
            sys.exit(1)

    repo_id = f"{hf_username}/{REPO_SUFFIX}"
    print(f"Target repo : {repo_id} (private)")

    # Create dataset repo (idempotent — won't fail if it already exists)
    print("\nCreating / verifying dataset repo on Hugging Face...")
    try:
        create_repo(
            repo_id=repo_id,
            repo_type="dataset",
            private=True,
            token=hf_token,
            exist_ok=True,
        )
        print(f"  Repo ready: https://huggingface.co/datasets/{repo_id}")
    except Exception as e:
        print(f"[error] Could not create repo: {e}")
        sys.exit(1)

    # Upload files
    api = HfApi(token=hf_token)

    for local_path, remote_name in [
        (TRAIN_FILE, "train.jsonl"),
        (VALID_FILE, "valid.jsonl"),
    ]:
        print(f"\nUploading {local_path.name} ...")
        try:
            api.upload_file(
                path_or_fileobj=str(local_path),
                path_in_repo=remote_name,
                repo_id=repo_id,
                repo_type="dataset",
                token=hf_token,
            )
            print(f"  Uploaded → {remote_name}")
        except Exception as e:
            print(f"[error] Upload failed for {local_path.name}: {e}")
            sys.exit(1)

    # AutoTrain instructions
    autotrain_url = "https://ui.autotrain.huggingface.co/"
    dataset_url   = f"https://huggingface.co/datasets/{repo_id}"

    print("\n" + "=" * 60)
    print("Upload complete. Next: trigger AutoTrain fine-tuning")
    print("=" * 60)
    print(f"""
1. Open AutoTrain:
     {autotrain_url}

2. Click  "New Project"  →  "LLM Fine-Tuning"

3. Recommended settings:
     Base model  : {BASE_MODEL}
     Dataset     : {repo_id}
     Train file  : train.jsonl
     Valid file  : valid.jsonl
     Task        : Chat / Instruction (JSONL messages format)
     LoRA rank   : {LORA_RANK}
     Epochs      : {EPOCHS}
     Privacy     : Private

4. Your dataset is here:
     {dataset_url}

5. After training completes, download the GGUF from the model repo
   and run:
     bash finetune/import_model.sh /path/to/model.gguf
""")
    print("Done.")


if __name__ == "__main__":
    main()
