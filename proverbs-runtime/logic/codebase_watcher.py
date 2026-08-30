"""
logic/codebase_watcher.py — Poll project files for changes and keep the RAG
index in sync by re-chunking/re-embedding modified files and pruning deleted
ones.

Usage:
    from logic.codebase_watcher import IndexUpdater, codebase_watcher
    from logic.rag import rag_index

    updater = IndexUpdater(rag_index, embedder, tokenizer)
    watcher = updater.start_watching("/path/to/project")
    # ... later ...
    watcher.stop()
"""

from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable

import numpy as np

from logic.rag import CodeChunker, _SKIP_DIRS

log = logging.getLogger("proverbs.codebase_watcher")


# ---------------------------------------------------------------------------
# FileWatcher
# ---------------------------------------------------------------------------

class FileWatcher:
    """
    Poll a project directory for added, modified, and deleted files.

    Only files whose extension is in *extensions* are tracked.
    """

    def __init__(
        self,
        project_dir: str | Path,
        extensions: tuple[str, ...] = (".py", ".js", ".ts", ".jsx", ".tsx", ".go", ".rs"),
        poll_interval: float = 2.0,
    ) -> None:
        self.project_dir = Path(project_dir).expanduser().resolve()
        self.extensions = frozenset(ext.lower() for ext in extensions)
        self.poll_interval = poll_interval

        self._mtimes: dict[str, float] = {}
        self._running: bool = False
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _is_tracked(self, path: Path) -> bool:
        return path.suffix.lower() in self.extensions

    def _collect_files(self) -> dict[str, float]:
        """Walk project_dir and return {filepath: mtime} for tracked files."""
        result: dict[str, float] = {}
        for root, dirs, files in os.walk(self.project_dir):
            dirs[:] = [
                d for d in dirs
                if d not in _SKIP_DIRS and not d.startswith(".")
            ]
            for fname in files:
                fpath = Path(root) / fname
                if self._is_tracked(fpath):
                    try:
                        result[str(fpath)] = fpath.stat().st_mtime
                    except OSError:
                        pass
        return result

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def scan(self) -> dict[str, list[str]]:
        """
        Compare current file mtimes against the last snapshot.

        Updates the internal mtime cache and returns a change dict:
            {"added": [...], "modified": [...], "deleted": [...]}
        """
        current = self._collect_files()
        prev = self._mtimes

        added: list[str] = []
        modified: list[str] = []
        deleted: list[str] = []

        for path, mtime in current.items():
            if path not in prev:
                added.append(path)
            elif mtime != prev[path]:
                modified.append(path)

        for path in prev:
            if path not in current:
                deleted.append(path)

        self._mtimes = current
        return {"added": added, "modified": modified, "deleted": deleted}

    def start(self, on_change: Callable[[dict[str, list[str]]], None]) -> None:
        """
        Start a background daemon thread that polls for changes and calls
        *on_change* whenever any are detected.

        An initial scan is performed immediately to seed the mtime snapshot
        without triggering *on_change*, so only genuinely new changes fire the
        callback.
        """
        if self._running:
            log.warning("FileWatcher already running; ignoring start().")
            return

        # Seed the initial snapshot silently.
        self._mtimes = self._collect_files()
        self._running = True

        def _loop() -> None:
            while self._running:
                try:
                    changes = self.scan()
                    if changes["added"] or changes["modified"] or changes["deleted"]:
                        log.debug(
                            "FileWatcher change — added=%d modified=%d deleted=%d",
                            len(changes["added"]),
                            len(changes["modified"]),
                            len(changes["deleted"]),
                        )
                        on_change(changes)
                except Exception:
                    log.exception("FileWatcher error during scan/callback")
                time.sleep(self.poll_interval)

        self._thread = threading.Thread(target=_loop, name="codebase-watcher", daemon=True)
        self._thread.start()
        log.info("FileWatcher started — watching %s (interval=%.1fs)", self.project_dir, self.poll_interval)

    def stop(self) -> None:
        """Signal the polling thread to stop. Returns immediately."""
        self._running = False
        log.info("FileWatcher stopped.")


# ---------------------------------------------------------------------------
# IndexUpdater
# ---------------------------------------------------------------------------

class IndexUpdater:
    """
    Receives file-change notifications from a FileWatcher and keeps a RAGIndex
    consistent by re-chunking/re-embedding changed files and removing chunks
    that belong to deleted files.
    """

    def __init__(self, rag_index: Any, embedder: Any, tokenizer: Any) -> None:
        self.rag_index = rag_index
        self.embedder = embedder
        self.tokenizer = tokenizer
        self._chunker = CodeChunker()
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _remove_file_chunks(self, filepath: str) -> None:
        """Drop all chunks (and their embeddings) that belong to *filepath*."""
        chunks = self.rag_index._chunks
        embeddings = self.rag_index._embeddings  # shape (n, d) or None

        keep_indices = [i for i, c in enumerate(chunks) if c.get("filepath") != filepath]

        self.rag_index._chunks = [chunks[i] for i in keep_indices]
        if embeddings is not None and len(embeddings):
            self.rag_index._embeddings = embeddings[keep_indices]
        else:
            self.rag_index._embeddings = np.empty(
                (0, self.rag_index.embed_dim), dtype=np.float32
            )

    def _add_file_chunks(self, filepath: str) -> None:
        """Chunk and embed *filepath*, then append to the index."""
        new_chunks = self._chunker.chunk_file(filepath)
        if not new_chunks:
            return

        texts = [c["text"] for c in new_chunks]
        new_embeddings = self.embedder.encode(texts, self.tokenizer).astype(np.float32)

        existing = self.rag_index._embeddings
        if existing is None or len(existing) == 0:
            self.rag_index._embeddings = new_embeddings
        else:
            self.rag_index._embeddings = np.concatenate(
                [existing, new_embeddings], axis=0
            )
        self.rag_index._chunks.extend(new_chunks)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def on_change(self, changes: dict[str, list[str]]) -> None:
        """
        Process a change dict produced by FileWatcher.scan() and update the
        RAG index in-place, then persist to disk.
        """
        added = changes.get("added", [])
        modified = changes.get("modified", [])
        deleted = changes.get("deleted", [])

        if not (added or modified or deleted):
            return

        with self._lock:
            # Modified files: remove old chunks first, then re-add.
            for filepath in modified:
                log.debug("Updating chunks for modified file: %s", filepath)
                self._remove_file_chunks(filepath)
                self._add_file_chunks(filepath)

            # Added files: just append.
            for filepath in added:
                log.debug("Indexing new file: %s", filepath)
                self._add_file_chunks(filepath)

            # Deleted files: remove their chunks.
            for filepath in deleted:
                log.debug("Removing chunks for deleted file: %s", filepath)
                self._remove_file_chunks(filepath)

            # Persist updated index to disk.
            try:
                self.rag_index._persist()
                log.info(
                    "RAG index updated — %d chunks total (added=%d modified=%d deleted=%d)",
                    len(self.rag_index._chunks),
                    len(added),
                    len(modified),
                    len(deleted),
                )
            except Exception:
                log.exception("Failed to persist RAG index after update")

    def start_watching(self, project_dir: str | Path) -> FileWatcher:
        """
        Create a FileWatcher for *project_dir*, wire it to self.on_change, and
        start the polling loop.

        Returns the running FileWatcher so the caller can stop it later.
        """
        watcher = FileWatcher(project_dir)
        watcher.start(self.on_change)
        return watcher


# ---------------------------------------------------------------------------
# Global instance
# ---------------------------------------------------------------------------

codebase_watcher: IndexUpdater | None = None
