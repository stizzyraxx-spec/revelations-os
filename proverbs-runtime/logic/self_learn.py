"""
self_learn.py — Quality-signal detection and background retraining for Proverbs LLM.

How it works:
  1. After every assistant response, the CLI calls set_pending(messages, response)
  2. On the NEXT user message, on_user_message(text) scores the previous exchange
  3. Good exchanges go to ~/.proverbs/quality_sessions/
  4. Bad exchanges go to ~/.proverbs/rejected_sessions/ (excluded from training)
  5. When RETRAIN_THRESHOLD good examples accumulate, background retraining triggers
  6. After training, the server hot-reloads the new weights via /v1/admin/reload-model
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import time
from enum import Enum
from pathlib import Path

log = logging.getLogger("proverbs.self_learn")

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))


# ── Quality signal vocabulary ─────────────────────────────────────────────────

QUALITY_SIGNALS = {
    "positive": [
        "perfect", "yes exactly", "that works", "great job", "correct",
        "nice work", "exactly right", "that's right", "well done", "exactly",
        "love it", "works perfectly", "that's what i needed",
    ],
    "negative": [
        "that's wrong", "that is wrong", "completely wrong", "not right",
        "not correct", "that's not right", "that's not what",
        "doesn't work", "does not work", "doesn't make sense",
        "that won't work", "not what i wanted", "not what i asked",
        "nope, ", "no, that", "wrong answer", "incorrect answer",
    ],
}


class QualitySignal(Enum):
    POSITIVE = "positive"
    NEGATIVE = "negative"
    NEUTRAL  = "neutral"


def detect_signal(text: str) -> QualitySignal:
    """Detect quality signal from user text following an assistant response."""
    lower = text.lower()
    for phrase in QUALITY_SIGNALS["negative"]:
        if phrase in lower:
            return QualitySignal.NEGATIVE
    for phrase in QUALITY_SIGNALS["positive"]:
        if phrase in lower:
            return QualitySignal.POSITIVE
    return QualitySignal.NEUTRAL


# ── Persistence ───────────────────────────────────────────────────────────────

RETRAIN_THRESHOLD  = 20
RETRAIN_LOCK_FILE  = Path.home() / ".proverbs" / "retraining.lock"
NEW_EXAMPLES_FILE  = Path.home() / ".proverbs" / "new_examples_count.json"
QUALITY_DIR        = Path.home() / ".proverbs" / "quality_sessions"
REJECTED_DIR       = Path.home() / ".proverbs" / "rejected_sessions"
SESSIONS_DIR       = Path.home() / ".proverbs" / "sessions"

_CONSTITUTIONAL_THROTTLE_SECS = 300  # 5 minutes

# ── Code block extraction helper ─────────────────────────────────────────────

_CODE_FENCE_RE = re.compile(
    r"```(?:python)?\s*\n(.*?)```",
    re.DOTALL | re.IGNORECASE,
)


def _extract_python_code(text: str) -> str | None:
    """Return the first Python fenced code block found in *text*, or None."""
    match = _CODE_FENCE_RE.search(text)
    if match:
        return match.group(1)
    # Fallback: any indented block that looks like Python
    if "def " in text or "import " in text or "class " in text:
        return text
    return None


def count_new_examples() -> int:
    try:
        return json.loads(NEW_EXAMPLES_FILE.read_text()).get("count", 0)
    except Exception:
        return 0


def increment_example_count(delta: int = 1) -> int:
    count = count_new_examples() + delta
    NEW_EXAMPLES_FILE.parent.mkdir(parents=True, exist_ok=True)
    NEW_EXAMPLES_FILE.write_text(json.dumps({"count": count}))
    return count


def reset_example_count() -> None:
    NEW_EXAMPLES_FILE.write_text(json.dumps({"count": 0}))


def is_retraining() -> bool:
    return RETRAIN_LOCK_FILE.exists()


def save_quality_exchange(
    messages: list[dict],
    response: str,
    signal: QualitySignal,
) -> None:
    """Save a quality-tagged exchange to the appropriate directory.

    CHANGE 3: If the response contains Python code, score it with
    code_quality.score_code(). If the quality_score < 0.3 the signal is
    automatically overridden to NEGATIVE (auto-reject low-quality code).
    """
    # ── Code quality gate ─────────────────────────────────────────────────
    if signal != QualitySignal.NEGATIVE:
        code_block = _extract_python_code(response)
        if code_block is not None:
            try:
                from logic.code_quality import score_code
                report = score_code(code_block)
                quality_score = report.get("quality_score", 1.0)
                if quality_score < 0.3:
                    log.info(
                        "Code quality gate: score=%.3f < 0.3 — overriding signal to NEGATIVE",
                        quality_score,
                    )
                    signal = QualitySignal.NEGATIVE
            except Exception as exc:
                log.debug("code_quality scoring skipped: %s", exc)

    out_dir = REJECTED_DIR if signal == QualitySignal.NEGATIVE else QUALITY_DIR
    out_dir.mkdir(parents=True, exist_ok=True)

    # Filename uses pid + counter to avoid any time-based calls
    counter = count_new_examples()
    fname = f"ex-{os.getpid()}-{counter}.jsonl"
    entry = {
        "messages": messages + [{"role": "assistant", "content": response}],
        "quality":  signal.value,
    }
    (out_dir / fname).write_text(json.dumps(entry) + "\n")


def trigger_background_retrain(server_url: str = "http://localhost:11434") -> bool:
    """
    Spawn a background retraining process.
    Returns True if retraining was triggered.

    CHANGE 1: If quality_examples > 10 and reward_head.pt exists, a GRPO
    worker is spawned (100 steps) before the standard training paths.
    """
    lora_adapter_path = Path.home() / ".proverbs" / "checkpoints" / "adapter.pt"
    base_checkpoint   = Path.home() / ".proverbs" / "checkpoints" / "best.pt"
    reward_head_path  = Path.home() / ".proverbs" / "checkpoints" / "reward_head.pt"
    use_lora = lora_adapter_path.exists() and base_checkpoint.exists()

    if is_retraining():
        log.info("Retraining already in progress — skipping")
        return False
    if count_new_examples() < RETRAIN_THRESHOLD:
        return False

    # Merge quality_sessions into sessions dir
    if QUALITY_DIR.exists():
        import shutil
        SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
        for f in QUALITY_DIR.glob("*.jsonl"):
            dest = SESSIONS_DIR / f.name
            if not dest.exists():
                shutil.copy(f, dest)

    # Write the lock
    RETRAIN_LOCK_FILE.write_text(str(os.getpid()))

    venv_python = str(Path.home() / ".proverbs" / "venv" / "bin" / "python")
    project_root = str(_PROJECT_ROOT)
    lock_path    = str(RETRAIN_LOCK_FILE)
    count_path   = str(NEW_EXAMPLES_FILE)
    retrain_log  = str(Path.home() / ".proverbs" / "retrain.log")

    # ── CHANGE 1: GRPO hook ───────────────────────────────────────────────
    quality_count_for_grpo = len(list(QUALITY_DIR.glob("*.jsonl"))) if QUALITY_DIR.exists() else 0
    if quality_count_for_grpo > 10 and reward_head_path.exists() and base_checkpoint.exists():
        grpo_worker = f"""
import sys
from pathlib import Path

PROJECT_ROOT = {repr(project_root)}
sys.path.insert(0, PROJECT_ROOT)
lock_path        = {repr(lock_path)}
count_path       = {repr(count_path)}
best_pt          = {repr(str(base_checkpoint))}
reward_head_path = {repr(str(reward_head_path))}
tok_path         = {repr(str(Path.home() / ".proverbs" / "tokenizer.json"))}
quality_dir      = {repr(str(QUALITY_DIR))}

try:
    import json
    from training.grpo_trainer import GRPOTrainer, GRPOConfig
    from model.proverbs_lm import ProverbsLM
    from tokenizer.bpe import ProverbsTokenizer

    print("[grpo worker] Loading policy from", best_pt)
    policy = ProverbsLM.load(best_pt)
    tok = ProverbsTokenizer.load(tok_path)

    # Collect prompts from quality sessions
    prompts = []
    for fpath in sorted(Path(quality_dir).glob("*.jsonl")):
        try:
            obj = json.loads(fpath.read_text().strip())
            for msg in obj.get("messages", []):
                if msg.get("role") == "user":
                    prompts.append(msg["content"])
                    break
        except Exception:
            continue

    if not prompts:
        print("[grpo worker] No prompts found in quality sessions — skipping GRPO")
    else:
        cfg = GRPOConfig(
            reward_model_path=reward_head_path,
            use_code_reward=True,
        )
        trainer = GRPOTrainer(
            policy=policy,
            reference=None,
            tokenizer=tok,
            prompts=prompts,
            cfg=cfg,
            max_steps=100,
        )
        trainer.train()
        print("[grpo worker] GRPO 100-step run complete")

    Path(count_path).write_text('{{"count": 0}}')
except Exception as e:
    print("[grpo worker] Error:", e)
finally:
    try:
        Path(lock_path).unlink(missing_ok=True)
    except Exception:
        pass
"""
        grpo_script_path = Path.home() / ".proverbs" / "_grpo_retrain_worker.py"
        grpo_script_path.write_text(grpo_worker)

        log_fh = open(retrain_log, "a")
        subprocess.Popen(
            [venv_python, str(grpo_script_path)],
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            cwd=project_root,
        )

        reset_example_count()
        log.info(
            "Background GRPO retraining triggered (quality_examples=%d, reward_head=%s)",
            quality_count_for_grpo,
            reward_head_path,
        )
        return True

    if use_lora:
        lora_script = f"""
import sys
from pathlib import Path

PROJECT_ROOT = {repr(project_root)}
sys.path.insert(0, PROJECT_ROOT)
lock_path = {repr(lock_path)}
count_path = {repr(count_path)}
base_checkpoint = {repr(str(base_checkpoint))}
adapter_path = {repr(str(lora_adapter_path))}

try:
    from model.lora import LoraModel
    from training.lora_trainer import LoraTrainer
    from model.proverbs_lm import ProverbsLM

    base_model = ProverbsLM.load(base_checkpoint)
    lora_model = LoraModel(base_model)
    lora_model.inject_lora()
    if Path(adapter_path).exists():
        lora_model.load_adapter(adapter_path)
        print("Loaded existing adapter from", adapter_path)
    trainer = LoraTrainer(lora_model, max_steps=200)
    trainer.train()
    lora_model.save_adapter(adapter_path)
    print("LoRA adapter saved to", adapter_path)
    Path(count_path).write_text('{{"count": 0}}')
    print("LoRA self-learning cycle complete")
except Exception as e:
    print("LoRA retrain worker error:", e)
finally:
    try:
        Path(lock_path).unlink(missing_ok=True)
    except Exception:
        pass
"""
        lora_script_path = Path.home() / ".proverbs" / "_lora_retrain_worker.py"
        lora_script_path.write_text(lora_script)

        log_fh = open(retrain_log, "a")
        subprocess.Popen(
            [venv_python, str(lora_script_path)],
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            cwd=project_root,
        )

        reset_example_count()
        log.info("Background LoRA retraining triggered")
        return True

    # DPO path: prefer DPO over SFT when enough paired examples exist
    quality_count  = len(list(QUALITY_DIR.glob("*.jsonl")))  if QUALITY_DIR.exists()  else 0
    rejected_count = len(list(REJECTED_DIR.glob("*.jsonl"))) if REJECTED_DIR.exists() else 0
    dpo_eligible   = quality_count > 5 and rejected_count > 5

    if dpo_eligible:
        dpo_worker = f"""
import math, sys, urllib.request
from pathlib import Path
from torch.utils.data import DataLoader, random_split

PROJECT_ROOT = {repr(project_root)}
sys.path.insert(0, PROJECT_ROOT)
server_url = {repr(server_url)}
lock_path  = {repr(lock_path)}
count_path = {repr(count_path)}
best_pt    = {repr(str(base_checkpoint))}
output_dir = {repr(str(Path.home() / ".proverbs" / "checkpoints"))}
tok_path   = {repr(str(Path.home() / ".proverbs" / "tokenizer.json"))}

try:
    from training.dpo_trainer import DpoDataset, DpoTrainer, _dpo_collate
    from tokenizer.bpe import ProverbsTokenizer
    import torch

    tok = ProverbsTokenizer.load(tok_path)
    dataset = DpoDataset(data_dir=str(Path.home() / ".proverbs"), tokenizer=tok, max_seq_len=2048)

    if len(dataset) == 0:
        print("[dpo worker] No paired examples — falling back")
        raise RuntimeError("empty dataset")

    n_valid = max(1, math.ceil(len(dataset) * 0.1))
    n_train = len(dataset) - n_valid
    train_ds, valid_ds = random_split(dataset, [n_train, n_valid])

    pin = torch.cuda.is_available()
    train_loader = DataLoader(train_ds, batch_size=4, shuffle=True,  collate_fn=_dpo_collate, pin_memory=pin, drop_last=False)
    valid_loader = DataLoader(valid_ds, batch_size=4, shuffle=False, collate_fn=_dpo_collate, pin_memory=pin, drop_last=False)

    trainer = DpoTrainer.from_checkpoint(
        policy_path=best_pt,
        reference_path=best_pt,
        train_loader=train_loader,
        valid_loader=valid_loader,
        output_dir=output_dir,
        lr=1e-5,
        beta=0.1,
        max_steps=500,
        log_every=10,
        eval_every=200,
    )
    trainer.train()

    try:
        req = urllib.request.Request(
            server_url + "/v1/admin/reload-model",
            data=b"{{}}",
            headers={{"Content-Type": "application/json"}},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=60)
        print("[dpo worker] Hot-reload successful")
    except Exception as e:
        print(f"[dpo worker] Hot-reload failed: {{e}}")

    Path(count_path).write_text('{{"count": 0}}')
    print("[dpo worker] DPO self-learning cycle complete")
except Exception as e:
    print("[dpo worker] Error:", e)
finally:
    try:
        Path(lock_path).unlink(missing_ok=True)
    except Exception:
        pass
"""
        dpo_script_path = Path.home() / ".proverbs" / "_dpo_retrain_worker.py"
        dpo_script_path.write_text(dpo_worker)

        log_fh = open(retrain_log, "a")
        subprocess.Popen(
            [venv_python, str(dpo_script_path)],
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            cwd=project_root,
        )

        reset_example_count()
        log.info("Background DPO retraining triggered (chosen=%d rejected=%d)", quality_count, rejected_count)
        return True

    worker_script = f"""
import subprocess, sys, json, urllib.request
from pathlib import Path

PROJECT_ROOT = {repr(project_root)}
sys.path.insert(0, PROJECT_ROOT)
server_url = {repr(server_url)}
lock_path  = {repr(lock_path)}
count_path = {repr(count_path)}

try:
    result = subprocess.run(
        [sys.executable, "-m", "training.train",
         "--mode", "local", "--max-steps", "2000",
         "--log-every", "100", "--eval-every", "500", "--save-every", "1000"],
        cwd=PROJECT_ROOT,
        capture_output=True, text=True, timeout=7200
    )
    if result.returncode == 0:
        print("Training OK — checking benchmark before hot-reload")
        model_p = str(Path.home() / ".proverbs" / "checkpoints" / "best.pt")
        tok_p = str(Path.home() / ".proverbs" / "tokenizer.json")
        bench_ok = True
        try:
            from scripts.benchmark import run_benchmark
            bench = run_benchmark(model_p, tok_p)
            if not bench.get("passed", True):
                print("Benchmark regression - skipping hot-reload")
                bench_ok = False
        except Exception as be:
            print("Benchmark check skipped:", be)
        if bench_ok:
            try:
                req = urllib.request.Request(
                    server_url + "/v1/admin/reload-model",
                    data=b"{{}}",
                    headers={{"Content-Type": "application/json"}},
                    method="POST",
                )
                urllib.request.urlopen(req, timeout=60)
                print("Hot-reload successful")
            except Exception as e:
                print(f"Hot-reload failed: {{e}}")
        Path(count_path).write_text('{{"count": 0}}')
        print("Self-learning cycle complete")
    else:
        print("Training failed:", result.returncode, result.stderr[-500:])
except Exception as e:
    print("Retrain worker error:", e)
finally:
    try:
        Path(lock_path).unlink(missing_ok=True)
    except Exception:
        pass
"""

    script_path = Path.home() / ".proverbs" / "_retrain_worker.py"
    script_path.write_text(worker_script)

    log_fh = open(retrain_log, "a")
    subprocess.Popen(
        [venv_python, str(script_path)],
        stdout=log_fh,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        cwd=project_root,
    )

    reset_example_count()
    log.info("Background retraining triggered")
    return True


# ── Main coordinator ──────────────────────────────────────────────────────────

class SelfLearner:
    """
    Call set_pending() after every assistant response.
    Call on_user_message() at the start of every user turn.
    The learner scores the previous exchange and accumulates quality data.
    When RETRAIN_THRESHOLD good examples accumulate, background retraining fires.
    """

    def __init__(self, server_url: str = "http://localhost:11434"):
        self.server_url = server_url
        self._pending_messages: list[dict] = []
        self._pending_response: str = ""
        self._last_entropy: dict = {}
        self._last_constitutional_ts: float = 0.0

    def set_pending(self, messages: list[dict], response: str) -> None:
        self._pending_messages = list(messages)
        self._pending_response = response

    def set_entropy(self, stats: dict) -> None:
        self._last_entropy = dict(stats)

    def on_user_message(self, text: str) -> None:
        if not self._pending_response or not text.strip():
            return

        signal = detect_signal(text)
        if signal == QualitySignal.POSITIVE and self._last_entropy.get("high_uncertainty", 0) > 0.3:
            log.info("Downgrading positive signal - model uncertain (%.2f)", self._last_entropy["high_uncertainty"])
            signal = QualitySignal.NEUTRAL
        self._last_entropy = {}

        if signal == QualitySignal.POSITIVE:
            now = time.monotonic()
            if now - self._last_constitutional_ts >= _CONSTITUTIONAL_THROTTLE_SECS:
                self._last_constitutional_ts = now
                try:
                    from logic.constitutional import constitutional_ai
                    if constitutional_ai is not None and self._pending_response:
                        user_text_for_critique = self._pending_messages[-1].get("content", "") if self._pending_messages else ""
                        pair = constitutional_ai.generate_dpo_pair(user_text_for_critique, self._pending_response)
                        if pair:
                            log.info("Constitutional AI generated a DPO training pair")
                except Exception as e:
                    log.debug("Constitutional AI skipped: %s", e)

        save_quality_exchange(self._pending_messages, self._pending_response, signal)

        self._pending_messages = []
        self._pending_response = ""

        if signal == QualitySignal.NEGATIVE:
            return

        new_count = increment_example_count()
        if new_count >= RETRAIN_THRESHOLD and not is_retraining():
            triggered = trigger_background_retrain(self.server_url)
            if triggered:
                log.info("Background retraining triggered (%d examples)", new_count)

    # ── CHANGE 2: run_self_play ───────────────────────────────────────────

    def run_self_play(self, server_url: str = "http://localhost:11434") -> int:
        """
        Spawn logic/self_play.py as a non-blocking subprocess using the best
        available checkpoint and tokenizer.  Returns 0 immediately after
        spawning (fire-and-forget).
        """
        best_pt  = Path.home() / ".proverbs" / "checkpoints" / "best.pt"
        tok_path = Path.home() / ".proverbs" / "tokenizer.json"
        venv_python = str(Path.home() / ".proverbs" / "venv" / "bin" / "python")
        self_play_script = str(_PROJECT_ROOT / "logic" / "self_play.py")
        retrain_log = str(Path.home() / ".proverbs" / "self_play.log")

        cmd = [
            venv_python,
            self_play_script,
            "--model", str(best_pt),
            "--tokenizer", str(tok_path),
        ]

        try:
            log_fh = open(retrain_log, "a")
            subprocess.Popen(
                cmd,
                stdout=log_fh,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                cwd=str(_PROJECT_ROOT),
            )
            log.info("Self-play subprocess spawned (non-blocking)")
        except Exception as exc:
            log.warning("run_self_play: failed to spawn subprocess: %s", exc)

        return 0

    # ── CHANGE 4: status with active_learning_available ──────────────────

    def status(self) -> dict:
        active_learning_file = _PROJECT_ROOT / "logic" / "active_learning.py"
        active_learning_available: bool = (
            active_learning_file.exists()
            and len(list(SESSIONS_DIR.glob("*.jsonl"))) >= 5
            if SESSIONS_DIR.exists()
            else False
        )
        return {
            "new_examples":               count_new_examples(),
            "threshold":                  RETRAIN_THRESHOLD,
            "retraining":                 is_retraining(),
            "ready_to_train":             count_new_examples() >= RETRAIN_THRESHOLD,
            "active_learning_available":  active_learning_available,
        }


# Global instance used by the server and CLI
self_learner = SelfLearner()
