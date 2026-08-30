"""
logic/dependency_graph.py — Static import analysis for context expansion.

Walks .py, .js, and .ts source files in a project directory, resolves import
statements to real file paths (Python via ``ast``, JS/TS via regex), and
exposes BFS helpers so callers can retrieve the files most relevant to a given
file by following import edges in either direction.

Usage:
    from logic.dependency_graph import DependencyGraph

    dg = DependencyGraph("/path/to/project")
    dg.build()
    deps  = dg.get_dependencies("logic/tools.py", depth=2)
    users = dg.get_dependents("logic/tools.py", depth=1)
    ctx   = dg.get_context_files("logic/tools.py", max_files=5)

    dg.save("~/.proverbs/dep_graph.json")
    dg2 = DependencyGraph.load("~/.proverbs/dep_graph.json")
"""

from __future__ import annotations

import ast
import json
import os
import re
from collections import deque
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Skip-lists (shared with rag.py convention)
# ---------------------------------------------------------------------------

_SKIP_DIRS: frozenset[str] = frozenset({
    ".git", ".hg", ".svn", "__pycache__", ".mypy_cache", ".pytest_cache",
    "node_modules", ".venv", "venv", "env", ".env", "dist", "build",
    ".tox", ".eggs",
})

_PY_EXTENSIONS: frozenset[str] = frozenset({".py"})
_JS_EXTENSIONS: frozenset[str] = frozenset({".js", ".ts", ".jsx", ".tsx"})
_ALL_EXTENSIONS: frozenset[str] = _PY_EXTENSIONS | _JS_EXTENSIONS

# Regex patterns for JS/TS import resolution.
# Matches: import ... from '...', require('...'), export ... from '...'
_JS_IMPORT_RE = re.compile(
    r"""(?:import\s+.*?\s+from|require\s*\(|export\s+.*?\s+from)\s*['"](\.{1,2}/[^'"]+)['"]""",
    re.MULTILINE,
)


# ---------------------------------------------------------------------------
# DependencyGraph
# ---------------------------------------------------------------------------

class DependencyGraph:
    """
    Static import graph for a mixed Python / JS / TS project.

    Attributes
    ----------
    graph:
        Maps absolute filepath -> set of absolute filepaths it imports.
    reverse:
        Maps absolute filepath -> set of absolute filepaths that import it.
    """

    def __init__(self, project_dir: str | Path) -> None:
        self.project_dir: Path = Path(project_dir).expanduser().resolve()
        self.graph:   dict[str, set[str]] = {}
        self.reverse: dict[str, set[str]] = {}

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _walk_files(self) -> list[Path]:
        """Return all .py/.js/.ts files under project_dir, skipping noise."""
        result: list[Path] = []
        for root, dirs, files in os.walk(self.project_dir):
            dirs[:] = [
                d for d in dirs
                if d not in _SKIP_DIRS and not d.startswith(".")
            ]
            for fname in files:
                fpath = Path(root) / fname
                if fpath.suffix.lower() in _ALL_EXTENSIONS:
                    result.append(fpath)
        return result

    # -- Python ------------------------------------------------------------

    def _resolve_python_import(
        self,
        module_name: str,
        level: int,
        source_file: Path,
    ) -> str | None:
        """
        Convert a Python import to an absolute filepath, or return None if it
        cannot be resolved to a project-local file.

        Parameters
        ----------
        module_name:
            Dotted module name (may be empty for bare ``from . import x``).
        level:
            Number of leading dots (0 = absolute import).
        source_file:
            The file that contains the import statement.
        """
        if level == 0:
            # Absolute import — try to map "a.b.c" to project_dir/a/b/c.py
            # or project_dir/a/b/c/__init__.py
            parts = module_name.split(".") if module_name else []
            if not parts:
                return None
            candidate_mod  = self.project_dir.joinpath(*parts).with_suffix(".py")
            candidate_pkg  = self.project_dir.joinpath(*parts, "__init__.py")
            if candidate_mod.exists():
                return str(candidate_mod)
            if candidate_pkg.exists():
                return str(candidate_pkg)
            return None

        # Relative import — anchor from source_file's package directory.
        anchor = source_file.parent
        for _ in range(level - 1):
            anchor = anchor.parent

        parts = module_name.split(".") if module_name else []
        if parts:
            candidate_mod = anchor.joinpath(*parts).with_suffix(".py")
            candidate_pkg = anchor.joinpath(*parts, "__init__.py")
            if candidate_mod.exists():
                return str(candidate_mod)
            if candidate_pkg.exists():
                return str(candidate_pkg)
        else:
            # "from . import x" — the anchor itself is the package
            candidate_pkg = anchor / "__init__.py"
            if candidate_pkg.exists():
                return str(candidate_pkg)

        return None

    def _parse_python(self, fpath: Path) -> set[str]:
        """Return the set of project-local absolute paths imported by *fpath*."""
        try:
            source = fpath.read_text(encoding="utf-8", errors="replace")
            tree = ast.parse(source, filename=str(fpath))
        except (OSError, SyntaxError):
            return set()

        resolved: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    target = self._resolve_python_import(alias.name, 0, fpath)
                    if target:
                        resolved.add(target)
            elif isinstance(node, ast.ImportFrom):
                module = node.module or ""
                level  = node.level or 0
                target = self._resolve_python_import(module, level, fpath)
                if target:
                    resolved.add(target)

        return resolved

    # -- JS / TS -----------------------------------------------------------

    def _resolve_js_specifier(
        self, specifier: str, source_file: Path
    ) -> str | None:
        """
        Resolve a relative JS/TS specifier (e.g. ``'./utils'``) to an absolute
        path.  Only relative specifiers (starting with ``./`` or ``../``) are
        considered; bare module names are skipped.
        """
        if not specifier.startswith(("./", "../")):
            return None

        base = source_file.parent / specifier

        # Try the path as-is (already has extension), then common extensions.
        candidates = [base]
        for ext in (".ts", ".tsx", ".js", ".jsx"):
            candidates.append(base.with_suffix(ext))
        candidates.append(base / "index.ts")
        candidates.append(base / "index.js")

        for c in candidates:
            resolved = c.resolve()
            try:
                resolved.relative_to(self.project_dir)
            except ValueError:
                continue  # outside project root
            if resolved.exists():
                return str(resolved)

        return None

    def _parse_js(self, fpath: Path) -> set[str]:
        """Return the set of project-local absolute paths imported by *fpath*."""
        try:
            source = fpath.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return set()

        resolved: set[str] = set()
        for specifier in _JS_IMPORT_RE.findall(source):
            target = self._resolve_js_specifier(specifier, fpath)
            if target:
                resolved.add(target)

        return resolved

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def build(self) -> None:
        """
        Walk project_dir and populate ``graph`` and ``reverse``.

        Existing graph data is cleared before the walk begins.
        """
        self.graph   = {}
        self.reverse = {}

        all_files = self._walk_files()

        # Register every file as a node (even if it imports nothing).
        for fpath in all_files:
            key = str(fpath)
            if key not in self.graph:
                self.graph[key] = set()

        # Parse imports and fill edges.
        for fpath in all_files:
            key = str(fpath)
            ext = fpath.suffix.lower()

            if ext in _PY_EXTENSIONS:
                imports = self._parse_python(fpath)
            elif ext in _JS_EXTENSIONS:
                imports = self._parse_js(fpath)
            else:
                imports = set()

            # Only keep edges to files we know about in the project.
            valid_imports = imports & self.graph.keys()
            self.graph[key] = valid_imports

            for dep in valid_imports:
                self.reverse.setdefault(dep, set()).add(key)

        # Ensure every dependency also has a reverse entry.
        for key in self.graph:
            self.reverse.setdefault(key, set())

    def get_dependencies(self, filepath: str, depth: int = 1) -> set[str]:
        """
        Return all files that *filepath* depends on, up to *depth* hops.

        Parameters
        ----------
        filepath:
            Absolute path of the file to start from.
        depth:
            BFS depth limit (1 = direct imports only).

        Returns
        -------
        set[str] — absolute paths; does NOT include *filepath* itself.
        """
        filepath = str(Path(filepath).resolve())
        visited: set[str] = set()
        queue: deque[tuple[str, int]] = deque([(filepath, 0)])

        while queue:
            current, d = queue.popleft()
            if d >= depth:
                continue
            for dep in self.graph.get(current, set()):
                if dep not in visited:
                    visited.add(dep)
                    queue.append((dep, d + 1))

        visited.discard(filepath)
        return visited

    def get_dependents(self, filepath: str, depth: int = 1) -> set[str]:
        """
        Return all files that import *filepath*, up to *depth* hops.

        Parameters
        ----------
        filepath:
            Absolute path of the file to start from.
        depth:
            BFS depth limit (1 = direct importers only).

        Returns
        -------
        set[str] — absolute paths; does NOT include *filepath* itself.
        """
        filepath = str(Path(filepath).resolve())
        visited: set[str] = set()
        queue: deque[tuple[str, int]] = deque([(filepath, 0)])

        while queue:
            current, d = queue.popleft()
            if d >= depth:
                continue
            for dep in self.reverse.get(current, set()):
                if dep not in visited:
                    visited.add(dep)
                    queue.append((dep, d + 1))

        visited.discard(filepath)
        return visited

    def get_context_files(
        self, filepath: str, max_files: int = 5
    ) -> list[str]:
        """
        Return up to *max_files* files most relevant to *filepath* for context
        expansion, ordered by relevance: direct imports first, then direct
        importers, then transitive deps at depth 2.

        Parameters
        ----------
        filepath:
            Absolute path of the focal file.
        max_files:
            Maximum number of files to return (not counting *filepath* itself).

        Returns
        -------
        list[str] — absolute paths in relevance order, deduplicated.
        """
        filepath = str(Path(filepath).resolve())
        seen:   set[str]  = set()
        result: list[str] = []

        def _add(candidates: set[str]) -> None:
            for f in sorted(candidates):  # deterministic order within tier
                if f not in seen and f != filepath and len(result) < max_files:
                    seen.add(f)
                    result.append(f)

        # Tier 1: direct dependencies (depth=1)
        _add(self.get_dependencies(filepath, depth=1))
        if len(result) >= max_files:
            return result

        # Tier 2: direct dependents (depth=1)
        _add(self.get_dependents(filepath, depth=1))
        if len(result) >= max_files:
            return result

        # Tier 3: transitive dependencies (depth=2, excluding already added)
        _add(self.get_dependencies(filepath, depth=2) - seen)
        if len(result) >= max_files:
            return result

        # Tier 4: transitive dependents (depth=2, excluding already added)
        _add(self.get_dependents(filepath, depth=2) - seen)

        return result

    # ------------------------------------------------------------------
    # Serialisation
    # ------------------------------------------------------------------

    def save(self, path: str | Path) -> None:
        """
        Persist the graph to *path* as JSON.

        Both ``graph`` and ``reverse`` are serialised with set values converted
        to sorted lists so the file is deterministic and human-readable.
        """
        path = Path(path).expanduser()
        path.parent.mkdir(parents=True, exist_ok=True)

        data: dict[str, Any] = {
            "project_dir": str(self.project_dir),
            "graph":   {k: sorted(v) for k, v in self.graph.items()},
            "reverse": {k: sorted(v) for k, v in self.reverse.items()},
        }
        path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    @classmethod
    def load(cls, path: str | Path) -> "DependencyGraph":
        """
        Reconstruct a :class:`DependencyGraph` from a JSON file written by
        :meth:`save`.

        Parameters
        ----------
        path:
            Path to the JSON file.

        Returns
        -------
        DependencyGraph — with ``graph`` and ``reverse`` populated as sets.

        Raises
        ------
        FileNotFoundError
            If *path* does not exist.
        json.JSONDecodeError
            If the file is not valid JSON.
        """
        path = Path(path).expanduser()
        data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))

        instance = cls(data.get("project_dir", "."))
        instance.graph   = {k: set(v) for k, v in data.get("graph",   {}).items()}
        instance.reverse = {k: set(v) for k, v in data.get("reverse", {}).items()}
        return instance
