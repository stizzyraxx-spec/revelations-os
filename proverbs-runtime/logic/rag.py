"""
logic/rag.py — Internal RAG pipeline for Proverbs LLM.

Walks a project directory, chunks source files by line with overlap, embeds
chunks using ProverbsEmbedder, persists the index to disk, and injects
retrieved context into the message list using the same system-prepend pattern
as logic/rules.py.

Usage:
    from logic.rag import rag_index

    rag_index.build(project_dir, embedder, tokenizer)   # one-time index build
    rag_index.load()                                     # subsequent sessions
    messages = rag_index.inject(messages, query, embedder, tokenizer)
"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any

import numpy as np


# ---------------------------------------------------------------------------
# Language detection
# ---------------------------------------------------------------------------

_EXT_TO_LANG: dict[str, str] = {
    ".py":    "python",
    ".js":    "javascript",
    ".ts":    "typescript",
    ".jsx":   "javascript",
    ".tsx":   "typescript",
    ".rs":    "rust",
    ".go":    "go",
    ".c":     "c",
    ".h":     "c",
    ".cpp":   "cpp",
    ".cc":    "cpp",
    ".cxx":   "cpp",
    ".hpp":   "cpp",
    ".java":  "java",
    ".kt":    "kotlin",
    ".swift": "swift",
    ".rb":    "ruby",
    ".php":   "php",
    ".sh":    "bash",
    ".bash":  "bash",
    ".zsh":   "bash",
    ".lua":   "lua",
    ".r":     "r",
    ".R":     "r",
    ".cs":    "csharp",
    ".fs":    "fsharp",
    ".ex":    "elixir",
    ".exs":   "elixir",
    ".hs":    "haskell",
    ".ml":    "ocaml",
    ".mli":   "ocaml",
    ".scala": "scala",
    ".dart":  "dart",
    ".yml":   "yaml",
    ".yaml":  "yaml",
    ".toml":  "toml",
    ".json":  "json",
    ".md":    "markdown",
    ".html":  "html",
    ".htm":   "html",
    ".css":   "css",
    ".scss":  "css",
    ".sql":   "sql",
    ".tf":    "terraform",
}

# Files to skip when walking project directories.
_SKIP_DIRS: frozenset[str] = frozenset({
    ".git", ".hg", ".svn", "__pycache__", ".mypy_cache", ".pytest_cache",
    "node_modules", ".venv", "venv", "env", ".env", "dist", "build",
    ".tox", ".eggs", "*.egg-info",
})

_CODE_EXTENSIONS: frozenset[str] = frozenset(_EXT_TO_LANG.keys())


def _detect_language(filepath: str | Path) -> str:
    """Return a language tag for *filepath* based on its extension, or 'text'."""
    ext = Path(filepath).suffix.lower()
    return _EXT_TO_LANG.get(ext, "text")


# ---------------------------------------------------------------------------
# CodeChunker
# ---------------------------------------------------------------------------

class CodeChunker:
    """Split source files into overlapping line-based chunks."""

    def chunk_file(
        self,
        filepath: str | Path,
        chunk_size: int = 40,
        overlap: int = 5,
    ) -> list[dict[str, Any]]:
        """
        Read *filepath* and split it into overlapping chunks.

        Parameters
        ----------
        filepath:
            Absolute or relative path to the source file.
        chunk_size:
            Number of lines per chunk (default 40).
        overlap:
            Number of lines shared between consecutive chunks (default 5).

        Returns
        -------
        list of dicts with keys:
            filepath   — str, the path that was chunked
            start_line — int, 1-based index of the first line in this chunk
            end_line   — int, 1-based index of the last line in this chunk
            text       — str, the chunk content
            language   — str, detected programming language
        """
        filepath = Path(filepath)
        try:
            content = filepath.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return []

        lines = content.splitlines(keepends=True)
        if not lines:
            return []

        language = _detect_language(filepath)
        filepath_str = str(filepath)
        chunks: list[dict[str, Any]] = []

        step = max(1, chunk_size - overlap)
        i = 0
        while i < len(lines):
            end = min(i + chunk_size, len(lines))
            chunk_lines = lines[i:end]
            text = "".join(chunk_lines).rstrip()
            if text:
                chunks.append({
                    "filepath":   filepath_str,
                    "start_line": i + 1,           # 1-based
                    "end_line":   i + len(chunk_lines),
                    "text":       text,
                    "language":   language,
                })
            i += step

        return chunks


# ---------------------------------------------------------------------------
# RAGIndex
# ---------------------------------------------------------------------------

class RAGIndex:
    """
    Persistent, embedding-based code search index for a project directory.

    The index is stored as two files inside *index_path*:
        chunks.json      — serialized list[dict] of all code chunks
        embeddings.npy   — float32 numpy array of shape (n_chunks, embed_dim)
    """

    def __init__(
        self,
        index_path: str = "~/.proverbs/rag_index",
        embed_dim: int = 384,
    ) -> None:
        self.index_path = Path(index_path).expanduser()
        self.embed_dim = embed_dim
        self._chunks: list[dict[str, Any]] = []
        self._embeddings: np.ndarray | None = None   # shape (n, embed_dim)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @property
    def _chunks_file(self) -> Path:
        return self.index_path / "chunks.json"

    @property
    def _embeddings_file(self) -> Path:
        return self.index_path / "embeddings.npy"

    def _is_code_file(self, path: Path) -> bool:
        return path.suffix.lower() in _CODE_EXTENSIONS

    def _walk_project(self, project_dir: Path) -> list[Path]:
        """Yield all code file paths under *project_dir*, skipping noise dirs."""
        result: list[Path] = []
        for root, dirs, files in os.walk(project_dir):
            # Prune noisy directories in-place.
            dirs[:] = [
                d for d in dirs
                if d not in _SKIP_DIRS and not d.startswith(".")
            ]
            for fname in files:
                fpath = Path(root) / fname
                if self._is_code_file(fpath):
                    result.append(fpath)
        return result

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def build(self, project_dir: str | Path, embedder, tokenizer) -> int:
        """
        Walk *project_dir*, chunk every code file, embed, and persist to disk.

        Parameters
        ----------
        project_dir:
            Root of the project to index.
        embedder:
            A ProverbsEmbedder instance with an ``encode(texts, tokenizer)`` method.
        tokenizer:
            The tokenizer used by *embedder*.

        Returns
        -------
        int — number of chunks indexed.
        """
        project_dir = Path(project_dir).expanduser().resolve()
        chunker = CodeChunker()

        all_chunks: list[dict[str, Any]] = []
        for fpath in self._walk_project(project_dir):
            all_chunks.extend(chunker.chunk_file(fpath))

        if not all_chunks:
            self._chunks = []
            self._embeddings = np.empty((0, self.embed_dim), dtype=np.float32)
            self._persist()
            return 0

        texts = [c["text"] for c in all_chunks]
        embeddings = embedder.encode(texts, tokenizer).astype(np.float32)

        self._chunks = all_chunks
        self._embeddings = embeddings
        self._persist()

        return len(all_chunks)

    def _persist(self) -> None:
        """Write chunks.json and embeddings.npy to disk."""
        self.index_path.mkdir(parents=True, exist_ok=True)
        self._chunks_file.write_text(
            json.dumps(self._chunks, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        np.save(str(self._embeddings_file), self._embeddings)

    def load(self) -> bool:
        """
        Load a previously built index from disk.

        Returns
        -------
        bool — True if the index was loaded successfully, False otherwise.
        """
        if not self._chunks_file.exists() or not self._embeddings_file.exists():
            return False
        try:
            self._chunks = json.loads(
                self._chunks_file.read_text(encoding="utf-8")
            )
            self._embeddings = np.load(str(self._embeddings_file))
            return True
        except (OSError, json.JSONDecodeError, ValueError):
            self._chunks = []
            self._embeddings = None
            return False

    def search(
        self,
        query: str,
        embedder,
        tokenizer,
        top_k: int = 5,
    ) -> list[dict[str, Any]]:
        """
        Embed *query* and return the *top_k* most similar chunks.

        Each returned dict is a copy of the chunk dict with an additional
        ``score`` field (float, cosine similarity in [0, 1]).

        Returns an empty list if the index has not been built/loaded.
        """
        if self._embeddings is None or len(self._chunks) == 0:
            return []

        q_vec = embedder.encode([query], tokenizer).astype(np.float32)  # (1, d)
        # embedder already L2-normalises; cosine sim == dot product.
        scores: np.ndarray = (self._embeddings @ q_vec.T).squeeze(-1)   # (n,)

        k = min(top_k, len(self._chunks))
        top_indices = np.argsort(scores)[::-1][:k]

        results: list[dict[str, Any]] = []
        for idx in top_indices:
            chunk = dict(self._chunks[idx])
            chunk["score"] = float(scores[idx])
            results.append(chunk)

        return results

    def inject(
        self,
        messages: list[dict[str, Any]],
        query: str,
        embedder,
        tokenizer,
        top_k: int = 5,
    ) -> list[dict[str, Any]]:
        """
        Search the index for *query* and prepend a context block to *messages*.

        The system-message prepend follows the same pattern as logic/rules.py:
        - If a system message already exists, the context block is PREPENDED to
          its content, separated by a blank line.
        - Otherwise a new system message is inserted at index 0.
        - The original *messages* list is never mutated.

        Returns the augmented message list (or a shallow copy if no hits).
        """
        hits = self.search(query, embedder, tokenizer, top_k=top_k)
        if not hits:
            return list(messages)

        # Build the context block.
        lines: list[str] = ["Relevant code context:"]
        for hit in hits:
            filepath = hit.get("filepath", "")
            start = hit.get("start_line", "?")
            end = hit.get("end_line", "?")
            lang = hit.get("language", "text")
            score = hit.get("score", 0.0)
            text = hit.get("text", "")
            lines.append(
                f"\n# {filepath} (lines {start}-{end}, lang={lang}, score={score:.3f})\n"
                f"```{lang}\n{text}\n```"
            )
        context_text = "\n".join(lines)

        # Deep-copy so the caller's original is never mutated.
        result: list[dict[str, Any]] = copy.deepcopy(messages)

        # Find an existing system message (first occurrence).
        system_idx: int | None = None
        for i, msg in enumerate(result):
            if msg.get("role") == "system":
                system_idx = i
                break

        if system_idx is not None:
            existing: str = result[system_idx].get("content") or ""
            if existing:
                result[system_idx]["content"] = f"{context_text}\n\n{existing}"
            else:
                result[system_idx]["content"] = context_text
        else:
            result.insert(0, {"role": "system", "content": context_text})

        return result


# ---------------------------------------------------------------------------
# Global instance
# ---------------------------------------------------------------------------

rag_index = RAGIndex()
