"""
gguf_backend.py — Load any GGUF model directly, no Ollama binary required.

Works fully offline. Wraps llama-cpp-python with the same interface
as ProverbsGenerator so the server doesn't need to know the difference.

Usage:
    from inference.gguf_backend import GGUFBackend
    gen = GGUFBackend("/path/to/model.gguf")
    for token in gen.generate("def hello():", stream=True):
        print(token, end="", flush=True)
"""

import os
import sys
from pathlib import Path
from typing import Generator

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

# ── Model auto-discovery ──────────────────────────────────────────────────────
_MODELS_DIR  = Path.home() / ".proverbs" / "models"
_OLLAMA_BLOB = Path.home() / ".ollama" / "models" / "blobs" / \
    "sha256-29d8c98fa6b098e200069bfb88b9508dc3e85586d20cba59f8dda9a808165104"

# Priority list for auto-discovery:
# 1. PROVERBS_GGUF_PATH env var
# 2. Any .gguf in ~/.proverbs/models/ (prefer smaller/faster models first)
# 3. qwen2.5-coder:1.5b Ollama blob (if Ollama was used to download it)
_PREFERRED_ORDER = [
    "qwen2.5-coder-1.5b-Q4_K_M.gguf",
    "qwen2.5-coder-7b-Q4_K_M.gguf",
    "Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf",
    "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
    "deepseek-coder-7b-instruct-v1.5-Q4_K_M.gguf",
    "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
    "llama3.1-8b-Q4_K_M.gguf",
]

def _auto_discover_gguf() -> str:
    """Find the best available GGUF model without Ollama."""
    # Env var takes priority
    env_path = os.environ.get("PROVERBS_GGUF_PATH", "")
    if env_path and Path(os.path.expanduser(env_path)).exists():
        return os.path.expanduser(env_path)
    # Preferred models in ~/.proverbs/models/
    for name in _PREFERRED_ORDER:
        p = _MODELS_DIR / name
        if p.exists():
            return str(p)
    # Any .gguf in the models dir
    if _MODELS_DIR.exists():
        gguf_files = sorted(_MODELS_DIR.glob("*.gguf"), key=lambda f: f.stat().st_size)
        if gguf_files:
            return str(gguf_files[0])  # smallest first (fastest to load)
    # Ollama blob fallback
    if _OLLAMA_BLOB.exists():
        return str(_OLLAMA_BLOB)
    return ""

DEFAULT_GGUF = _auto_discover_gguf()


def _find_llama_cpp():
    try:
        import llama_cpp
        return llama_cpp
    except ImportError:
        print("[error] llama-cpp-python not installed.")
        print("        pip install llama-cpp-python")
        sys.exit(1)


class GGUFBackend:
    """
    Drop-in replacement for ProverbsGenerator that loads a GGUF model.
    Fully offline, no Ollama process needed.
    """

    def __init__(
        self,
        model_path: str | None = None,
        n_ctx: int | None = None,        # None = read from PROVERBS_GGUF_CTX env, default 8192
        n_threads: int | None = None,    # None = auto (all cores)
        n_gpu_layers: int = -1,          # -1 = auto (all layers on Metal/CUDA, 0 on CPU)
        verbose: bool = False,
    ):
        llama_cpp = _find_llama_cpp()

        path = model_path or DEFAULT_GGUF
        if not path:
            raise FileNotFoundError(
                "No GGUF model found.\n"
                "Download one: /models download qwen2.5-coder-7b\n"
                "Or set: PROVERBS_GGUF_PATH=~/.proverbs/models/yourmodel.gguf"
            )

        path = str(Path(path).expanduser())
        if not Path(path).exists():
            raise FileNotFoundError(f"GGUF file not found: {path}")

        import multiprocessing
        threads = n_threads or max(1, multiprocessing.cpu_count())

        # Context window: env var > explicit arg > default 8192
        ctx = n_ctx or int(os.environ.get("PROVERBS_GGUF_CTX", "8192"))

        # GPU layers. Explicit override wins:
        #   PROVERBS_GPU_LAYERS=0   → force CPU
        #   PROVERBS_GPU_LAYERS=999 → force all layers on GPU
        # Otherwise auto-detect via llama_cpp itself (not torch — torch may not
        # be installed, and its MPS probe is unrelated to llama.cpp's Metal build,
        # which is what actually runs inference here).
        env_layers = os.environ.get("PROVERBS_GPU_LAYERS")
        if env_layers is not None and env_layers.strip() != "":
            gpu_layers = int(env_layers)
        elif n_gpu_layers == -1:
            try:
                gpu_layers = 999 if llama_cpp.llama_supports_gpu_offload() else 0
            except Exception:
                gpu_layers = 0
        else:
            gpu_layers = n_gpu_layers

        model_name = Path(path).name
        print(f"  Loading GGUF: {model_name}")
        print(f"  Threads: {threads}  Context: {ctx}  GPU layers: {gpu_layers}")

        # Detect chat format from model name
        chat_fmt = "chatml"  # works for Qwen, DeepSeek, Phi, most modern models
        if "llama" in model_name.lower() or "mistral" in model_name.lower():
            chat_fmt = "llama-3"

        self._llm = llama_cpp.Llama(
            model_path=path,
            n_ctx=ctx,
            n_threads=threads,
            n_gpu_layers=gpu_layers,
            verbose=verbose,
            chat_format=chat_fmt,
        )
        self.model_path = path
        self.model_name = model_name

    def generate(
        self,
        prompt: str | list[dict],
        max_new_tokens: int = 512,
        temperature: float = 0.7,
        top_p: float = 0.9,
        top_k: int = 40,
        repetition_penalty: float = 1.1,
        stop_tokens: list[str] | None = None,
        stream: bool = False,
    ) -> str | Generator[str, None, None]:
        """
        Generate text from a prompt or chat messages list.
        Mirrors the ProverbsGenerator.generate() interface.
        """
        stop = stop_tokens or ["<|endoftext|>", "<|im_end|>"]

        if isinstance(prompt, list):
            # Chat messages format
            if stream:
                return self._chat_stream(prompt, max_new_tokens, temperature, top_p, top_k, stop)
            else:
                resp = self._llm.create_chat_completion(
                    messages=prompt,
                    max_tokens=max_new_tokens,
                    temperature=temperature,
                    top_p=top_p,
                    top_k=top_k,
                    repeat_penalty=repetition_penalty,
                    stop=stop,
                    stream=False,
                )
                return resp["choices"][0]["message"]["content"]
        else:
            # Raw text prompt
            if stream:
                return self._text_stream(prompt, max_new_tokens, temperature, top_p, top_k, stop, repetition_penalty)
            else:
                resp = self._llm(
                    prompt,
                    max_tokens=max_new_tokens,
                    temperature=temperature,
                    top_p=top_p,
                    top_k=top_k,
                    repeat_penalty=repetition_penalty,
                    stop=stop,
                    stream=False,
                )
                return resp["choices"][0]["text"]

    def _chat_stream(self, messages, max_tokens, temperature, top_p, top_k, stop):
        for chunk in self._llm.create_chat_completion(
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            top_k=top_k,
            stop=stop,
            stream=True,
        ):
            delta = chunk["choices"][0]["delta"]
            if "content" in delta and delta["content"]:
                yield delta["content"]

    def _text_stream(self, prompt, max_tokens, temperature, top_p, top_k, stop, repeat_penalty):
        for chunk in self._llm(
            prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            top_k=top_k,
            repeat_penalty=repeat_penalty,
            stop=stop,
            stream=True,
        ):
            text = chunk["choices"][0]["text"]
            if text:
                yield text

    @property
    def tokenizer(self):
        """Minimal tokenizer shim for token counting."""
        return _GGUFTokenizerShim(self._llm)

    def count_tokens(self, text: str) -> int:
        return len(self._llm.tokenize(text.encode()))


class _GGUFTokenizerShim:
    """Minimal shim so server.py token-count code works with GGUFBackend."""
    def __init__(self, llm):
        self._llm = llm

    def encode(self, text: str, **_) -> list[int]:
        return self._llm.tokenize(text.encode())

    def decode(self, ids: list[int], **_) -> str:
        return self._llm.detokenize(ids).decode(errors="replace")
