"""
training/ast_chunker.py — Chunk code files at AST / syntax boundaries.

For Python files: uses the ``ast`` module to split at FunctionDef,
AsyncFunctionDef, and ClassDef nodes (with a size-based inner split when a
chunk exceeds max_chunk_lines).  Module-level code that sits between top-level
definitions is emitted as a MODULE chunk.

For all other languages: regex patterns detect function/class starts (covering
JS/TS/Go/Rust/C/C++/Java/Ruby/etc.) and split there; falls back to
fixed-size line-count windows when no patterns fire.

ASTChunkDataset wraps everything into a PyTorch Dataset compatible with the
rest of the Proverbs training pipeline.
"""

from __future__ import annotations

import ast
import os
import re
import sys
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import torch
from torch.utils.data import Dataset

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from tokenizer.bpe import ProverbsTokenizer  # noqa: E402

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MIN_CHUNK_LINES: int = 2          # discard chunks shorter than this
PAD_TOKEN_ID: int = 0
LABEL_IGNORE_INDEX: int = -100

_SKIP_DIRS: frozenset[str] = frozenset({
    "node_modules", ".git", "__pycache__", "dist", "build",
    ".venv", "venv", ".mypy_cache", ".pytest_cache",
})

_PYTHON_EXT: frozenset[str] = frozenset({".py", ".pyw"})

_GENERIC_EXTS: frozenset[str] = frozenset({
    ".js", ".jsx", ".ts", ".tsx",
    ".go", ".rs", ".java", ".c", ".cpp", ".cc", ".h", ".hpp",
    ".rb", ".swift", ".kt", ".cs", ".php", ".scala",
    ".sh", ".bash", ".zsh",
})

# Regex: lines that open a top-level (or any) function / class in non-Python langs.
# Patterns are tried in order; first match wins.
_FUNC_CLASS_PATTERNS: list[re.Pattern[str]] = [
    # JS/TS: function foo(  |  async function foo(  |  export function foo(
    re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s+\w+\s*\("),
    # JS/TS arrow assigned to const/let/var: const foo = (...) =>
    re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\("),
    # class Foo  |  export class Foo  |  abstract class Foo
    re.compile(r"^\s*(?:export\s+)?(?:abstract\s+)?class\s+\w+"),
    # Go: func (recv) Name(  |  func Name(
    re.compile(r"^\s*func\s+(?:\(\w+\s+\*?\w+\)\s+)?\w+\s*\("),
    # Rust: fn name(  |  pub fn name(  |  async fn name(
    re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+\w+\s*[\(<]"),
    # Java/Kotlin/C#: visibility? static? type name(
    re.compile(r"^\s*(?:(?:public|private|protected|internal|static|final|override|virtual|async)\s+){0,4}[\w<>\[\]]+\s+\w+\s*\("),
    # C/C++: return_type name(  (simple heuristic — at least one word before the paren)
    re.compile(r"^\s*\w[\w\s\*&:<>]*\s+\w+\s*\([^;]*$"),
    # Ruby: def name  |  def self.name
    re.compile(r"^\s*def\s+(?:self\.)?\w+"),
]


# ---------------------------------------------------------------------------
# Data class
# ---------------------------------------------------------------------------

@dataclass
class ASTChunk:
    """A contiguous slice of a source file with metadata."""

    filepath: str        # absolute path to the source file
    start_line: int      # 1-based, inclusive
    end_line: int        # 1-based, inclusive
    node_type: str       # e.g. "FunctionDef", "ClassDef", "MODULE", "GENERIC"
    name: str            # identifier / label (empty string if anonymous)
    text: str            # raw source text of the chunk

    @property
    def num_lines(self) -> int:
        return self.end_line - self.start_line + 1


# ---------------------------------------------------------------------------
# Python chunker
# ---------------------------------------------------------------------------

def _make_chunk(
    lines: list[str],
    filepath: str,
    start_line: int,
    end_line: int,
    node_type: str,
    name: str,
) -> ASTChunk:
    text = "".join(lines[start_line - 1 : end_line])
    return ASTChunk(
        filepath=filepath,
        start_line=start_line,
        end_line=end_line,
        node_type=node_type,
        name=name,
        text=text,
    )


def _collect_inner_splits(
    node: ast.AST,
    lines: list[str],
    filepath: str,
    max_chunk_lines: int,
) -> list[ASTChunk]:
    """
    Recursively split an oversized node at its direct child
    FunctionDef / AsyncFunctionDef / ClassDef boundaries.
    """
    child_nodes = [
        child for child in ast.iter_child_nodes(node)
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
        and hasattr(child, "end_lineno")
    ]

    if not child_nodes:
        # No inner splits available — return the whole node as one chunk
        return [_make_chunk(
            lines, filepath,
            node.lineno, node.end_lineno,  # type: ignore[attr-defined]
            type(node).__name__,
            getattr(node, "name", ""),
        )]

    chunks: list[ASTChunk] = []
    node_start: int = node.lineno  # type: ignore[attr-defined]
    node_end: int = node.end_lineno  # type: ignore[attr-defined]

    prev_end = node_start
    for child in child_nodes:
        # Lines between previous boundary and this child (preamble / decorators)
        preamble_start = prev_end
        preamble_end = child.lineno - 1
        if preamble_end >= preamble_start:
            chunk = _make_chunk(
                lines, filepath,
                preamble_start, preamble_end,
                type(node).__name__ + "_BODY",
                getattr(node, "name", ""),
            )
            if chunk.num_lines >= MIN_CHUNK_LINES:
                chunks.append(chunk)

        child_size = child.end_lineno - child.lineno + 1  # type: ignore[attr-defined]
        if child_size > max_chunk_lines:
            chunks.extend(_collect_inner_splits(child, lines, filepath, max_chunk_lines))
        else:
            chunk = _make_chunk(
                lines, filepath,
                child.lineno, child.end_lineno,  # type: ignore[attr-defined]
                type(child).__name__,
                getattr(child, "name", ""),
            )
            if chunk.num_lines >= MIN_CHUNK_LINES:
                chunks.append(chunk)

        prev_end = child.end_lineno + 1  # type: ignore[attr-defined]

    # Trailing lines after the last child
    if prev_end <= node_end:
        chunk = _make_chunk(
            lines, filepath,
            prev_end, node_end,
            type(node).__name__ + "_TAIL",
            getattr(node, "name", ""),
        )
        if chunk.num_lines >= MIN_CHUNK_LINES:
            chunks.append(chunk)

    return chunks


def chunk_python_file(
    filepath: str,
    max_chunk_lines: int = 60,
) -> list[ASTChunk]:
    """
    Parse *filepath* with the ``ast`` module and return one ASTChunk per
    top-level definition (FunctionDef / AsyncFunctionDef / ClassDef).

    Chunks larger than *max_chunk_lines* are recursively split at inner
    function/class boundaries.  Code between definitions (imports, constants,
    module-level statements) is grouped into MODULE chunks.
    """
    path = Path(filepath)
    try:
        source = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        warnings.warn(f"ast_chunker: cannot read {filepath}: {exc}")
        return []

    lines = source.splitlines(keepends=True)
    total_lines = len(lines)

    try:
        tree = ast.parse(source, filename=filepath)
    except SyntaxError as exc:
        warnings.warn(f"ast_chunker: SyntaxError in {filepath}: {exc}")
        return []

    # Collect top-level definitions only (direct children of Module)
    top_level = [
        node for node in ast.iter_child_nodes(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
        and hasattr(node, "end_lineno")
    ]

    chunks: list[ASTChunk] = []
    cursor = 1  # 1-based line pointer, tracks where un-assigned code starts

    for node in top_level:
        node_start: int = node.lineno
        node_end: int = node.end_lineno  # type: ignore[attr-defined]

        # Module-level code before this definition
        if node_start > cursor:
            chunk = _make_chunk(
                lines, filepath,
                cursor, node_start - 1,
                "MODULE", "",
            )
            if chunk.num_lines >= MIN_CHUNK_LINES:
                chunks.append(chunk)

        node_size = node_end - node_start + 1
        if node_size > max_chunk_lines:
            chunks.extend(_collect_inner_splits(node, lines, filepath, max_chunk_lines))
        else:
            chunk = _make_chunk(
                lines, filepath,
                node_start, node_end,
                type(node).__name__,
                node.name,
            )
            if chunk.num_lines >= MIN_CHUNK_LINES:
                chunks.append(chunk)

        cursor = node_end + 1

    # Trailing module-level code after the last definition
    if cursor <= total_lines:
        chunk = _make_chunk(
            lines, filepath,
            cursor, total_lines,
            "MODULE", "",
        )
        if chunk.num_lines >= MIN_CHUNK_LINES:
            chunks.append(chunk)

    # Edge case: file has no top-level defs — emit entire file as MODULE
    if not chunks and total_lines >= MIN_CHUNK_LINES:
        chunks.append(_make_chunk(lines, filepath, 1, total_lines, "MODULE", ""))

    return chunks


# ---------------------------------------------------------------------------
# Generic (non-Python) chunker
# ---------------------------------------------------------------------------

def chunk_generic_file(
    filepath: str,
    chunk_size: int = 50,
    overlap: int = 5,
) -> list[ASTChunk]:
    """
    Chunk a non-Python source file.

    1. Scan each line for function/class-start patterns.
    2. Split at pattern boundaries; if a resulting segment exceeds
       *chunk_size* lines it is further divided at *chunk_size* intervals.
    3. Adjacent segments share *overlap* lines so context is not lost at
       boundaries.
    4. If no patterns are found, fall back to plain line-count windows.
    """
    path = Path(filepath)
    try:
        source = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        warnings.warn(f"ast_chunker: cannot read {filepath}: {exc}")
        return []

    lines = source.splitlines(keepends=True)
    total_lines = len(lines)
    if total_lines < MIN_CHUNK_LINES:
        return []

    # Find lines that match a function/class pattern (0-based indices)
    split_indices: list[int] = [
        i for i, line in enumerate(lines)
        if any(pat.match(line) for pat in _FUNC_CLASS_PATTERNS)
    ]

    # Build boundary list (0-based start indices of each segment)
    if split_indices:
        boundaries = sorted(set(split_indices))
        # Prepend 0 only if the first pattern isn't at the very start
        if boundaries[0] != 0:
            boundaries = [0] + boundaries
    else:
        # No pattern matches — pure line-count fallback
        boundaries = list(range(0, total_lines, chunk_size - overlap))

    boundaries.append(total_lines)  # sentinel

    chunks: list[ASTChunk] = []

    for seg_idx in range(len(boundaries) - 1):
        seg_start = boundaries[seg_idx]        # 0-based
        seg_end = boundaries[seg_idx + 1] - 1  # 0-based inclusive

        # If this segment is larger than chunk_size, divide it further
        sub_starts = list(range(seg_start, seg_end + 1, chunk_size))
        for sub_idx, sub_start in enumerate(sub_starts):
            sub_end = min(sub_start + chunk_size - 1, seg_end)
            # Apply overlap: extend the previous sub-chunk's end
            if sub_idx > 0:
                overlap_start = max(seg_start, sub_start - overlap)
                actual_start = overlap_start
            else:
                actual_start = sub_start

            start_line = actual_start + 1   # convert to 1-based
            end_line = sub_end + 1          # convert to 1-based

            if end_line - start_line + 1 < MIN_CHUNK_LINES:
                continue

            text = "".join(lines[actual_start : sub_end + 1])
            # Try to name the chunk after the first matched line
            name = ""
            for i in range(actual_start, min(actual_start + 3, sub_end + 1)):
                m = next(
                    (pat.match(lines[i]) for pat in _FUNC_CLASS_PATTERNS
                     if pat.match(lines[i])),
                    None,
                )
                if m:
                    # Extract the first word token after common keywords
                    name_match = re.search(
                        r"(?:function|func|fn|def|class)\s+(\w+)", lines[i]
                    )
                    if name_match:
                        name = name_match.group(1)
                    break

            chunks.append(ASTChunk(
                filepath=filepath,
                start_line=start_line,
                end_line=end_line,
                node_type="GENERIC",
                name=name,
                text=text,
            ))

    return chunks


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

def chunk_file(filepath: str, **kwargs) -> list[ASTChunk]:
    """
    Route *filepath* to the appropriate chunker based on its extension.

    Keyword arguments are forwarded to the underlying chunker:
      - Python:  ``max_chunk_lines``  (default 60)
      - Generic: ``chunk_size``       (default 50), ``overlap`` (default 5)
    """
    ext = Path(filepath).suffix.lower()
    if ext in _PYTHON_EXT:
        return chunk_python_file(
            filepath,
            max_chunk_lines=kwargs.get("max_chunk_lines", 60),
        )
    return chunk_generic_file(
        filepath,
        chunk_size=kwargs.get("chunk_size", 50),
        overlap=kwargs.get("overlap", 5),
    )


# ---------------------------------------------------------------------------
# Directory walker
# ---------------------------------------------------------------------------

def chunk_directory(
    dirpath: str,
    extensions: Optional[list[str]] = None,
    skip_dirs: Optional[set[str]] = None,
    **kwargs,
) -> list[ASTChunk]:
    """
    Recursively walk *dirpath* and chunk every matching source file.

    Parameters
    ----------
    dirpath    : Root directory to walk.
    extensions : File extensions to include (e.g. ``[".py", ".js"]``).
                 Defaults to Python + all generic extensions.
    skip_dirs  : Directory names to skip.  Merged with the built-in skip set
                 (node_modules, .git, __pycache__, dist, build, …).
    **kwargs   : Forwarded to ``chunk_file``.
    """
    root = Path(dirpath).expanduser().resolve()
    if not root.is_dir():
        raise NotADirectoryError(f"chunk_directory: {dirpath} is not a directory")

    allowed_exts: frozenset[str] = (
        frozenset(e.lower() for e in extensions)
        if extensions is not None
        else (_PYTHON_EXT | _GENERIC_EXTS)
    )

    effective_skip: frozenset[str] = (
        _SKIP_DIRS | frozenset(skip_dirs)
        if skip_dirs is not None
        else _SKIP_DIRS
    )

    all_chunks: list[ASTChunk] = []

    for current_dir, subdirs, filenames in os.walk(root):
        # Prune unwanted subdirectories in-place (os.walk honours this)
        subdirs[:] = [
            d for d in subdirs
            if d not in effective_skip and not d.startswith(".")
        ]

        for fname in filenames:
            ext = Path(fname).suffix.lower()
            if ext not in allowed_exts:
                continue
            fpath = os.path.join(current_dir, fname)
            all_chunks.extend(chunk_file(fpath, **kwargs))

    return all_chunks


# ---------------------------------------------------------------------------
# PyTorch Dataset
# ---------------------------------------------------------------------------

class ASTChunkDataset(Dataset):
    """
    PyTorch Dataset that chunks all source files in a directory at AST
    boundaries and returns tokenized (input_ids, labels) pairs suitable for
    causal language-model training.

    Parameters
    ----------
    dirpath        : Root directory containing source files.
    tokenizer_path : Path to a ``ProverbsTokenizer`` save file.
    max_seq_len    : Sequences are truncated / padded to this length.
    extensions     : File extensions to include (None = all supported).
    skip_dirs      : Additional directory names to skip.
    min_tokens     : Discard chunks that tokenize to fewer than this many
                     tokens (default 8 — mirrors dataset.py's MIN_SEQ_LEN).
    **chunk_kwargs : Extra kwargs forwarded to ``chunk_directory``.
    """

    def __init__(
        self,
        dirpath: str,
        tokenizer_path: str = "~/.proverbs/tokenizer.json",
        max_seq_len: int = 2048,
        extensions: Optional[list[str]] = None,
        skip_dirs: Optional[set[str]] = None,
        min_tokens: int = 8,
        **chunk_kwargs,
    ) -> None:
        self.max_seq_len = max_seq_len

        tok_path = Path(tokenizer_path).expanduser().resolve()
        if not tok_path.exists():
            raise FileNotFoundError(
                f"Tokenizer not found: {tok_path}\n"
                "Run: python -m tokenizer.train_tokenizer first."
            )

        self._tokenizer = ProverbsTokenizer.load(str(tok_path))

        print(f"  Chunking directory: {dirpath}", flush=True)
        raw_chunks = chunk_directory(
            dirpath,
            extensions=extensions,
            skip_dirs=skip_dirs,
            **chunk_kwargs,
        )
        print(f"  Found {len(raw_chunks):,} raw chunks — tokenizing ...", flush=True)

        self._sequences: list[list[int]] = []
        self._chunk_meta: list[ASTChunk] = []

        for i, chunk in enumerate(raw_chunks):
            tokens = self._tokenizer.encode(chunk.text)
            if len(tokens) < min_tokens:
                continue
            self._sequences.append(tokens)
            self._chunk_meta.append(chunk)
            if (i + 1) % 5_000 == 0:
                print(f"    {i+1:,}/{len(raw_chunks):,} chunks processed", flush=True)

        print(
            f"  ASTChunkDataset: {len(self._sequences):,} chunks "
            f"(>= {min_tokens} tokens) ready.",
            flush=True,
        )

    # ------------------------------------------------------------------
    # Dataset interface
    # ------------------------------------------------------------------

    def __len__(self) -> int:
        return len(self._sequences)

    def __getitem__(self, idx: int) -> dict[str, torch.Tensor]:
        """
        Returns
        -------
        dict with keys:
          ``input_ids`` — LongTensor of shape (max_seq_len,)
          ``labels``    — LongTensor of shape (max_seq_len,); pad = -100
        """
        tokens = self._sequences[idx][: self.max_seq_len]
        seq_len = len(tokens)

        input_ids = torch.full((self.max_seq_len,), PAD_TOKEN_ID, dtype=torch.long)
        input_ids[:seq_len] = torch.tensor(tokens, dtype=torch.long)

        labels = input_ids.clone()
        labels[seq_len:] = LABEL_IGNORE_INDEX

        return {"input_ids": input_ids, "labels": labels}

    def chunk_meta(self, idx: int) -> ASTChunk:
        """Return the ASTChunk metadata for item *idx* (useful for debugging)."""
        return self._chunk_meta[idx]
