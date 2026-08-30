"""
code_quality.py — Static analysis code quality scorer for Proverbs LLM.

Parses Python source with the ast module (no external deps) and returns a
composite quality_score in [0.0, 1.0] from five weighted sub-scores:
cyclomatic complexity, nesting depth, naming conventions, docstring coverage,
and line length adherence.
"""

from __future__ import annotations

import ast
from typing import Any


# Single-character names that are conventionally acceptable.
_ALLOWED_SINGLE_CHAR: frozenset[str] = frozenset("ijkxynm")


# ---------------------------------------------------------------------------
# Sub-scorers
# ---------------------------------------------------------------------------


def cyclomatic_complexity(source: str) -> int:
    """Return 1 + number of decision points found in *source*.

    Decision points counted: if, elif, for, while, and, or, except, with,
    assert.  Each node type is counted once per occurrence in the AST.
    """
    tree = ast.parse(source)
    count = 0
    for node in ast.walk(tree):
        if isinstance(node, (ast.If, ast.For, ast.While, ast.With, ast.Assert)):
            count += 1
        elif isinstance(node, ast.ExceptHandler):
            count += 1
        elif isinstance(node, ast.BoolOp):
            # BoolOp covers `and` / `or`; each operator adds (n_values - 1)
            # branch points where n_values is the number of operands.
            count += len(node.values) - 1
    return 1 + count


def max_nesting_depth(source: str) -> int:
    """Return the maximum nesting depth of control-flow blocks in *source*.

    Blocks that increase depth: if, for, while, with, try.
    """
    tree = ast.parse(source)
    _DEPTH_NODES = (ast.If, ast.For, ast.While, ast.With, ast.Try)

    max_depth: list[int] = [0]

    def _walk(node: ast.AST, depth: int) -> None:
        for child in ast.iter_child_nodes(node):
            new_depth = depth + 1 if isinstance(child, _DEPTH_NODES) else depth
            if new_depth > max_depth[0]:
                max_depth[0] = new_depth
            _walk(child, new_depth)

    _walk(tree, 0)
    return max_depth[0]


def naming_score(source: str) -> float:
    """Return the fraction of identifiers that follow naming conventions.

    Penalties:
    - Single-character names not in {i, j, k, x, y, n, m}.
    - Names longer than 40 characters.
    """
    tree = ast.parse(source)
    total = 0
    well_named = 0

    for node in ast.walk(tree):
        name: str | None = None
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            name = node.name
        elif isinstance(node, ast.Name):
            name = node.id
        elif isinstance(node, ast.arg):
            name = node.arg

        if name is None or name.startswith("_") and len(name) == 1:
            # Skip dunder-style private markers — not user identifiers.
            continue
        if name in ("self", "cls", "args", "kwargs"):
            # Standard conventions — always acceptable.
            continue

        total += 1
        if len(name) == 1:
            if name in _ALLOWED_SINGLE_CHAR:
                well_named += 1
            # else: penalised (not counted as well-named)
        elif len(name) > 40:
            pass  # penalised
        else:
            well_named += 1

    return well_named / total if total > 0 else 1.0


def docstring_coverage(source: str) -> float:
    """Return fraction of FunctionDef/ClassDef nodes that have a docstring.

    Returns 1.0 when there are no functions or classes.
    """
    tree = ast.parse(source)
    total = 0
    documented = 0

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            total += 1
            body = node.body
            if (
                body
                and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)
            ):
                documented += 1

    return documented / total if total > 0 else 1.0


def line_length_score(source: str) -> float:
    """Return the fraction of non-empty lines that are <= 88 characters."""
    lines = [ln for ln in source.splitlines() if ln.strip()]
    if not lines:
        return 1.0
    return sum(1 for ln in lines if len(ln) <= 88) / len(lines)


# ---------------------------------------------------------------------------
# Composite scorer
# ---------------------------------------------------------------------------

# Weights must sum to 1.0.
_COMPLEXITY_WEIGHT = 0.30
_DEPTH_WEIGHT = 0.20
_NAMING_WEIGHT = 0.20
_DOCSTRING_WEIGHT = 0.15
_LINE_LENGTH_WEIGHT = 0.15

# Thresholds used to normalise raw integer metrics into [0, 1].
_COMPLEXITY_MAX = 20   # complexity >= this maps to score 0.0
_DEPTH_MAX = 6         # nesting depth >= this maps to score 0.0


def score_code(source: str, language: str = "python") -> dict[str, Any]:
    """Return a quality report dict for *source*.

    Keys returned
    -------------
    quality_score : float in [0.0, 1.0]
    complexity    : int   — raw cyclomatic complexity
    nesting_depth : int   — raw max nesting depth
    naming        : float — naming_score
    docstring_coverage : float
    line_length   : float — line_length_score

    Special cases
    -------------
    - language != "python": returns {quality_score: 0.5, skipped: True}
    - SyntaxError in source: returns {quality_score: 0.0, syntax_error: True}
    """
    if language.lower() != "python":
        return {"quality_score": 0.5, "skipped": True}

    try:
        ast.parse(source)
    except SyntaxError:
        return {"quality_score": 0.0, "syntax_error": True}

    complexity = cyclomatic_complexity(source)
    depth = max_nesting_depth(source)
    naming = naming_score(source)
    docstrings = docstring_coverage(source)
    line_len = line_length_score(source)

    # Normalise integer metrics: clamp to [0, 1], higher is better.
    complexity_norm = max(0.0, 1.0 - (complexity - 1) / max(_COMPLEXITY_MAX - 1, 1))
    depth_norm = max(0.0, 1.0 - depth / max(_DEPTH_MAX, 1))

    quality_score = (
        _COMPLEXITY_WEIGHT * complexity_norm
        + _DEPTH_WEIGHT * depth_norm
        + _NAMING_WEIGHT * naming
        + _DOCSTRING_WEIGHT * docstrings
        + _LINE_LENGTH_WEIGHT * line_len
    )
    quality_score = round(min(1.0, max(0.0, quality_score)), 4)

    return {
        "quality_score": quality_score,
        "complexity": complexity,
        "nesting_depth": depth,
        "naming": round(naming, 4),
        "docstring_coverage": round(docstrings, 4),
        "line_length": round(line_len, 4),
    }
