"""
Conversation memory system for Proverbs LLM.

Stores and retrieves conversation context across sessions.  Retrieval uses
semantic embeddings (sentence-transformers/all-MiniLM-L6-v2, ~80 MB) when
available, falling back to the built-in ProverbsEmbedder when loaded, and
finally to TF-IDF cosine similarity when neither is installed.

Embeddings are cached in memories.embeddings.npy alongside the JSONL file so
every retrieve() call is O(n) dot-product, not O(n * model_forward).

Per-project memory scoping is supported via the project_dir parameter or the
for_cwd() classmethod; each project gets its own subdirectory keyed by an
MD5 hash of the project path.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

import numpy as np

# Optional: sentence-transformers for semantic retrieval.
try:
    from sentence_transformers import SentenceTransformer as _ST
    _EMBED_MODEL: _ST | None = None  # lazy-loaded on first use

    def _get_embed_model() -> _ST:
        global _EMBED_MODEL
        if _EMBED_MODEL is None:
            _EMBED_MODEL = _ST("all-MiniLM-L6-v2")
        return _EMBED_MODEL

    _HAS_EMBEDDINGS = True
except ImportError:
    _HAS_EMBEDDINGS = False
    _get_embed_model = None  # type: ignore[assignment]

# Optional: built-in ProverbsEmbedder fallback.
try:
    from model.embeddings import embedder as _proverbs_embedder
    _HAS_PROVERBS_EMBEDDER = _proverbs_embedder is not None
except Exception:
    _proverbs_embedder = None  # type: ignore[assignment]
    _HAS_PROVERBS_EMBEDDER = False


# ---------------------------------------------------------------------------
# Stopword list (common English words that carry little semantic weight)
# ---------------------------------------------------------------------------
_STOPWORDS: frozenset[str] = frozenset({
    "a", "about", "above", "after", "again", "against", "all", "am", "an",
    "and", "any", "are", "aren't", "as", "at", "be", "because", "been",
    "before", "being", "below", "between", "both", "but", "by", "can",
    "can't", "cannot", "could", "couldn't", "did", "didn't", "do", "does",
    "doesn't", "doing", "don't", "down", "during", "each", "few", "for",
    "from", "further", "get", "got", "had", "hadn't", "has", "hasn't",
    "have", "haven't", "having", "he", "he'd", "he'll", "he's", "her",
    "here", "here's", "hers", "herself", "him", "himself", "his", "how",
    "how's", "i", "i'd", "i'll", "i'm", "i've", "if", "in", "into", "is",
    "isn't", "it", "it's", "its", "itself", "just", "let's", "like", "ll",
    "me", "more", "most", "mustn't", "my", "myself", "no", "nor", "not",
    "of", "off", "on", "once", "only", "or", "other", "ought", "our",
    "ours", "ourselves", "out", "over", "own", "re", "same", "shan't",
    "she", "she'd", "she'll", "she's", "should", "shouldn't", "so", "some",
    "such", "than", "that", "that's", "the", "their", "theirs", "them",
    "themselves", "then", "there", "there's", "these", "they", "they'd",
    "they'll", "they're", "they've", "this", "those", "through", "to",
    "too", "under", "until", "up", "us", "ve", "very", "was", "wasn't",
    "we", "we'd", "we'll", "we're", "we've", "were", "weren't", "what",
    "what's", "when", "when's", "where", "where's", "which", "while",
    "who", "who's", "whom", "why", "why's", "will", "with", "won't",
    "would", "wouldn't", "you", "you'd", "you'll", "you're", "you've",
    "your", "yours", "yourself", "yourselves",
})


def _tokenize(text: str) -> list[str]:
    """Lowercase and split text into alphabetic tokens, filtering stopwords."""
    tokens = re.findall(r"[a-z]+", text.lower())
    return [t for t in tokens if t not in _STOPWORDS and len(t) > 1]


def _term_frequencies(tokens: list[str]) -> dict[str, float]:
    """Compute normalised term frequency for a token list."""
    if not tokens:
        return {}
    counts: dict[str, int] = {}
    for t in tokens:
        counts[t] = counts.get(t, 0) + 1
    total = len(tokens)
    return {term: count / total for term, count in counts.items()}


def _extract_keywords(text: str, top_n: int = 20) -> list[str]:
    """Return the top_n most frequent non-stopword tokens from *text*."""
    tokens = _tokenize(text)
    counts: dict[str, int] = {}
    for t in tokens:
        counts[t] = counts.get(t, 0) + 1
    ranked = sorted(counts.items(), key=lambda x: x[1], reverse=True)
    return [term for term, _ in ranked[:top_n]]


# ---------------------------------------------------------------------------
# ConversationMemory
# ---------------------------------------------------------------------------

class ConversationMemory:
    """Persist and retrieve conversation context across Proverbs LLM sessions."""

    def __init__(
        self,
        memory_dir: str = "~/.proverbs/memories",
        max_memories: int = 1000,
        top_k: int = 3,
        min_similarity: float = 0.1,
        project_dir: str = None,
    ) -> None:
        memory_dir_base = Path(memory_dir).expanduser()
        if project_dir is not None:
            project_hash = hashlib.md5(project_dir.encode()).hexdigest()[:8]
            self.memory_dir = memory_dir_base / project_hash
            self.project_dir = project_dir
            self.project_hash = project_hash
        else:
            self.memory_dir = memory_dir_base
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        self.max_memories = max_memories
        self.top_k = top_k
        self.min_similarity = min_similarity
        self._memories_file = self.memory_dir / "memories.jsonl"
        self._embeddings_file = self.memory_dir / "memories.embeddings.npy"

    @classmethod
    def for_cwd(cls, **kwargs) -> ConversationMemory:
        return cls(project_dir=os.getcwd(), **kwargs)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _load_all(self) -> list[dict[str, Any]]:
        """Read all memory entries from disk."""
        if not self._memories_file.exists():
            return []
        entries: list[dict[str, Any]] = []
        with self._memories_file.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        entries.append(json.loads(line))
                    except json.JSONDecodeError:
                        # Silently skip corrupted lines.
                        pass
        return entries

    def _write_all(self, entries: list[dict[str, Any]]) -> None:
        """Overwrite the memories file with *entries*."""
        with self._memories_file.open("w", encoding="utf-8") as fh:
            for entry in entries:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def _append_entry(self, entry: dict[str, Any]) -> None:
        """Append a single entry to the memories file."""
        with self._memories_file.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")

    # ------------------------------------------------------------------
    # Embedding cache (sentence-transformers path)
    # ------------------------------------------------------------------

    def _load_embeddings(self) -> np.ndarray | None:
        """Load cached embeddings array, or None if it doesn't exist."""
        if not _HAS_EMBEDDINGS or not self._embeddings_file.exists():
            return None
        return np.load(str(self._embeddings_file))

    def _save_embeddings(self, embeddings: np.ndarray) -> None:
        np.save(str(self._embeddings_file), embeddings)

    def _rebuild_embeddings(self, entries: list[dict[str, Any]]) -> np.ndarray:
        """Embed all memory entries and write the cache."""
        model = _get_embed_model()
        texts = [self._entry_text(e) for e in entries]
        vecs = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
        self._save_embeddings(vecs)
        return vecs

    @staticmethod
    def _entry_text(entry: dict[str, Any]) -> str:
        """Flatten a memory entry into a single string for embedding."""
        parts: list[str] = []
        for msg in entry.get("messages", []):
            if msg.get("role") in ("user", "assistant"):
                parts.append(msg.get("content", ""))
        parts.append(entry.get("summary", ""))
        return " ".join(parts)[:512]  # cap at 512 chars — model handles the rest

    # ------------------------------------------------------------------
    # TF-IDF similarity
    # ------------------------------------------------------------------

    def _build_idf(self, entries: list[dict[str, Any]]) -> dict[str, float]:
        """Compute IDF for every keyword appearing in the memory corpus."""
        num_docs = len(entries)
        if num_docs == 0:
            return {}
        doc_freq: dict[str, int] = {}
        for entry in entries:
            for kw in set(entry.get("keywords", [])):
                doc_freq[kw] = doc_freq.get(kw, 0) + 1
        return {
            term: math.log((num_docs + 1) / (freq + 1)) + 1.0
            for term, freq in doc_freq.items()
        }

    def _score(
        self,
        query_tokens: list[str],
        entry: dict[str, Any],
        idf: dict[str, float],
    ) -> float:
        """Cosine-like TF-IDF similarity between query tokens and a memory entry."""
        entry_keywords: list[str] = entry.get("keywords", [])
        if not entry_keywords or not query_tokens:
            return 0.0

        query_tf = _term_frequencies(query_tokens)
        entry_tf = _term_frequencies(entry_keywords)

        # Build a combined vocabulary from query and document
        vocab = set(query_tf) | set(entry_tf)

        dot = 0.0
        query_norm = 0.0
        entry_norm = 0.0

        for term in vocab:
            idf_val = idf.get(term, 1.0)
            q_val = query_tf.get(term, 0.0) * idf_val
            e_val = entry_tf.get(term, 0.0) * idf_val
            dot += q_val * e_val
            query_norm += q_val ** 2
            entry_norm += e_val ** 2

        denom = math.sqrt(query_norm) * math.sqrt(entry_norm)
        if denom == 0.0:
            return 0.0
        return dot / denom

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def save_exchange(self, messages: list[dict[str, Any]], response: str) -> None:
        """
        Persist a completed exchange to long-term memory.

        Parameters
        ----------
        messages:
            The full message list that was sent to the model (may include
            system, user, and prior assistant turns).
        response:
            The assistant's response text for this exchange.
        """
        # Extract the last user message for keyword / summary purposes.
        user_text = ""
        for msg in reversed(messages):
            if msg.get("role") == "user":
                user_text = msg.get("content", "")
                break

        keywords = _extract_keywords(user_text + " " + response)
        summary = response[:100].replace("\n", " ").strip()

        entry: dict[str, Any] = {
            "id": str(uuid.uuid4()),
            "timestamp": time.time(),
            "messages": messages,
            "summary": summary,
            "keywords": keywords,
        }

        self._append_entry(entry)

        # Append embedding for the new entry (avoids full rebuild on every save).
        if _HAS_EMBEDDINGS:
            existing = self._load_embeddings()
            model = _get_embed_model()
            new_vec = model.encode(
                [self._entry_text(entry)],
                normalize_embeddings=True,
                show_progress_bar=False,
            )
            combined = np.vstack([existing, new_vec]) if existing is not None else new_vec
            self._save_embeddings(combined)

        # Prune if we have exceeded max_memories.
        all_entries = self._load_all()
        if len(all_entries) > self.max_memories:
            # Keep the most recent max_memories entries and rebuild embeddings.
            pruned = all_entries[-self.max_memories :]
            self._write_all(pruned)
            if _HAS_EMBEDDINGS:
                self._rebuild_embeddings(pruned)

    def retrieve_relevant(
        self,
        query: str,
        top_k: int | None = None,
    ) -> list[dict[str, Any]]:
        """
        Return up to *top_k* memory entries most relevant to *query*.

        Uses semantic embeddings (sentence-transformers) when available;
        falls back to ProverbsEmbedder when loaded; finally falls back to
        cosine TF-IDF.
        """
        k = top_k if top_k is not None else self.top_k
        all_entries = self._load_all()
        if not all_entries:
            return []

        if _HAS_EMBEDDINGS:
            return self._retrieve_semantic(query, all_entries, k)
        return self._retrieve_tfidf(query, all_entries, k)

    def _retrieve_semantic(
        self,
        query: str,
        all_entries: list[dict[str, Any]],
        k: int,
        tokenizer=None,
    ) -> list[dict[str, Any]]:
        """Embedding-based cosine retrieval."""
        if _HAS_EMBEDDINGS:
            embeddings = self._load_embeddings()
            if embeddings is None or len(embeddings) != len(all_entries):
                embeddings = self._rebuild_embeddings(all_entries)

            model = _get_embed_model()
            q_vec = model.encode([query], normalize_embeddings=True, show_progress_bar=False)
            scores: np.ndarray = (embeddings @ q_vec.T).squeeze(-1)

            top_indices = np.argsort(scores)[::-1][:k]
            return [
                all_entries[i]
                for i in top_indices
                if scores[i] >= self.min_similarity
            ]

        if _HAS_PROVERBS_EMBEDDER and _proverbs_embedder is not None:
            texts = [self._entry_text(e) for e in all_entries]
            corpus_vecs = _proverbs_embedder.encode(texts, tokenizer=tokenizer)
            q_vec = _proverbs_embedder.encode([query], tokenizer=tokenizer)
            # Both are already L2-normalised; cosine sim = dot product.
            scores = (corpus_vecs @ q_vec.T).squeeze(-1)

            top_indices = np.argsort(scores)[::-1][:k]
            return [
                all_entries[i]
                for i in top_indices
                if scores[i] >= self.min_similarity
            ]

        return self._retrieve_tfidf(query, all_entries, k)

    def _retrieve_tfidf(
        self,
        query: str,
        all_entries: list[dict[str, Any]],
        k: int,
    ) -> list[dict[str, Any]]:
        """TF-IDF cosine retrieval (fallback when sentence-transformers not installed)."""
        query_tokens = _tokenize(query)
        if not query_tokens:
            return []

        idf = self._build_idf(all_entries)
        scored = [
            (self._score(query_tokens, entry, idf), entry)
            for entry in all_entries
        ]
        scored.sort(key=lambda x: x[0], reverse=True)
        return [
            entry
            for score, entry in scored[:k]
            if score >= self.min_similarity
        ]

    def inject(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """
        Augment *messages* with relevant past context.

        The last user message is used as the retrieval query.  If relevant
        memories are found, a system-level context block is prepended to the
        message list (or merged into an existing leading system message).

        Returns a new list; the original is not modified.
        """
        query = ""
        for msg in reversed(messages):
            if msg.get("role") == "user":
                query = msg.get("content", "")
                break

        if not query:
            return list(messages)

        relevant = self.retrieve_relevant(query)
        if not relevant:
            return list(messages)

        # Build context block.
        lines: list[str] = ["Relevant past context:"]
        for mem in relevant:
            ts = mem.get("timestamp", 0.0)
            summary = mem.get("summary", "")
            lines.append(f"- [{time.strftime('%Y-%m-%d', time.localtime(ts))}] {summary}")
        context_text = "\n".join(lines)

        # Prepend / merge into system message.
        result = list(messages)
        if result and result[0].get("role") == "system":
            original_system = result[0].get("content", "")
            merged = context_text + "\n\n" + original_system if original_system else context_text
            result[0] = {**result[0], "content": merged}
        else:
            result.insert(0, {"role": "system", "content": context_text})

        return result

    def clear(self) -> None:
        """Delete all stored memories."""
        if self._memories_file.exists():
            self._memories_file.unlink()
        if self._embeddings_file.exists():
            self._embeddings_file.unlink()

    def stats(self) -> dict[str, int]:
        """Return a summary of current memory usage."""
        size_bytes = 0
        count = 0
        if self._memories_file.exists():
            size_bytes = self._memories_file.stat().st_size
            count = sum(1 for line in self._memories_file.open("r", encoding="utf-8") if line.strip())
        return {"count": count, "size_bytes": size_bytes}


# ---------------------------------------------------------------------------
# Global instance
# ---------------------------------------------------------------------------

memory = ConversationMemory()
