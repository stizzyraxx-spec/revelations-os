"""
logic/hooks.py — Pre/post generation hook registry for Proverbs LLM.

Usage:
    from logic.hooks import hooks

    @hooks.register_pre("my_hook")
    def my_pre(messages: list[dict]) -> list[dict]:
        # mutate or filter messages before generation
        return messages

    @hooks.register_post("my_hook")
    def my_post(messages: list[dict], response: str) -> str:
        # transform the generated response string
        return response
"""

from __future__ import annotations

import re
from typing import Callable


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


class HookRegistry:
    """Registry of named callables that run before and after generation."""

    def __init__(self) -> None:
        self._pre_hooks: list[tuple[str, Callable[[list[dict]], list[dict]]]] = []
        self._post_hooks: list[tuple[str, Callable[[list[dict], str], str]]] = []

    # ------------------------------------------------------------------
    # Registration decorators
    # ------------------------------------------------------------------

    def register_pre(
        self, name: str
    ) -> Callable[
        [Callable[[list[dict]], list[dict]]],
        Callable[[list[dict]], list[dict]],
    ]:
        """Decorator — register a pre-generation hook.

        The decorated function receives the messages list and must return a
        (possibly modified) messages list.

        Example::

            @hooks.register_pre("log_input")
            def log_input(messages: list[dict]) -> list[dict]:
                print(f"sending {len(messages)} messages")
                return messages
        """

        def decorator(
            fn: Callable[[list[dict]], list[dict]],
        ) -> Callable[[list[dict]], list[dict]]:
            self._pre_hooks.append((name, fn))
            return fn

        return decorator

    def register_post(
        self, name: str
    ) -> Callable[
        [Callable[[list[dict], str], str]],
        Callable[[list[dict], str], str],
    ]:
        """Decorator — register a post-generation hook.

        The decorated function receives (messages, response_str) and must
        return the (possibly modified) response string.

        Example::

            @hooks.register_post("uppercase")
            def uppercase(messages: list[dict], response: str) -> str:
                return response.upper()
        """

        def decorator(
            fn: Callable[[list[dict], str], str],
        ) -> Callable[[list[dict], str], str]:
            self._post_hooks.append((name, fn))
            return fn

        return decorator

    # ------------------------------------------------------------------
    # Execution
    # ------------------------------------------------------------------

    def run_pre(self, messages: list[dict]) -> list[dict]:
        """Run all pre-hooks in registration order.

        Each hook receives the output of the previous hook, so hooks chain
        together.  The original list is not mutated.
        """
        result: list[dict] = list(messages)
        for _name, fn in self._pre_hooks:
            result = fn(result)
        return result

    def run_post(self, messages: list[dict], response: str) -> str:
        """Run all post-hooks in registration order.

        Each hook receives (messages, response) where *response* is the
        output of the previous hook.
        """
        result: str = response
        for _name, fn in self._post_hooks:
            result = fn(messages, result)
        return result

    # ------------------------------------------------------------------
    # Inspection
    # ------------------------------------------------------------------

    def list_hooks(self) -> dict[str, list[str]]:
        """Return the names of registered hooks grouped by phase."""
        return {
            "pre": [name for name, _ in self._pre_hooks],
            "post": [name for name, _ in self._post_hooks],
        }

    # Expose the underlying lists for callers that want direct access.
    @property
    def pre_hooks(self) -> list[Callable]:
        return [fn for _, fn in self._pre_hooks]

    @property
    def post_hooks(self) -> list[Callable]:
        return [fn for _, fn in self._post_hooks]


# ---------------------------------------------------------------------------
# Global instance
# ---------------------------------------------------------------------------

hooks = HookRegistry()


# ---------------------------------------------------------------------------
# Built-in hooks
# ---------------------------------------------------------------------------

# --- code_fence_fixer -------------------------------------------------------
# Ensure every opening code fence (```) that has no language tag gets "text"
# added so downstream renderers do not emit warnings.

_BARE_FENCE_RE = re.compile(r"^```\s*$", re.MULTILINE)


@hooks.register_post("code_fence_fixer")
def _code_fence_fixer(messages: list[dict], response: str) -> str:  # noqa: ARG001
    """Add a default language tag to bare opening code fences."""
    return _BARE_FENCE_RE.sub("```text", response)


# --- strip_thinking ---------------------------------------------------------
# Remove <thinking>...</thinking> blocks (including nested whitespace) that
# some chain-of-thought prompts emit.

_THINKING_RE = re.compile(r"<thinking>.*?</thinking>", re.DOTALL | re.IGNORECASE)


@hooks.register_post("strip_thinking")
def _strip_thinking(messages: list[dict], response: str) -> str:  # noqa: ARG001
    """Strip <thinking>...</thinking> tags and their content from response."""
    cleaned = _THINKING_RE.sub("", response)
    # Collapse runs of blank lines left by the removal (max two consecutive).
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()
