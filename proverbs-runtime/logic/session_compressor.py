"""
session_compressor — compress old conversation turns using the Proverbs model.

When a session's message history grows beyond a token budget, older turns are
summarised into a single system message so the context window stays manageable
without discarding intent.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from inference.generate import ProverbsGenerator
    from tokenizer.bpe import ProverbsTokenizer


# ---------------------------------------------------------------------------
# Token estimation
# ---------------------------------------------------------------------------

def estimate_tokens(messages: list[dict], tokenizer: "ProverbsTokenizer") -> int:
    """Return the approximate total token count for *messages*.

    Each message's ``content`` field is encoded independently and the token
    counts are summed.  A small per-message overhead (4 tokens) is added to
    approximate role / delimiter tokens that a chat template would insert.
    """
    total = 0
    for msg in messages:
        content = msg.get("content", "")
        if content:
            total += len(tokenizer.encode(content, add_bos=False))
        total += 4  # role + separator overhead
    return total


# ---------------------------------------------------------------------------
# Message splitting
# ---------------------------------------------------------------------------

def split_messages(
    messages: list[dict],
    keep_recent: int = 6,
) -> tuple[list[dict], list[dict]]:
    """Split *messages* into an *old* portion and a *recent* portion.

    The system message at index 0 is always preserved — it is excluded from
    the *old* slice and must be re-prepended by the caller.

    Args:
        messages:    Full message list, system message first.
        keep_recent: Number of tail messages to keep verbatim.

    Returns:
        ``(old, recent)`` where ``old = messages[1:-keep_recent]`` and
        ``recent = messages[-keep_recent:]``.
    """
    if len(messages) <= 1:
        return [], messages

    body = messages[1:]  # everything after the system message
    if keep_recent >= len(body):
        return [], body

    old = body[:-keep_recent]
    recent = body[-keep_recent:]
    return old, recent


# ---------------------------------------------------------------------------
# Summarisation
# ---------------------------------------------------------------------------

def summarize_messages(
    generator: "ProverbsGenerator",
    messages: list[dict],
) -> str:
    """Ask the model to summarise *messages* in under 150 words.

    The conversation is formatted as a plain ``Role: content`` transcript and
    fed to the generator with a low temperature so the summary is factual and
    concise.

    Args:
        generator: A ``ProverbsGenerator`` instance.
        messages:  The message turns to summarise (no system message required).

    Returns:
        The generated summary string (stripped of leading/trailing whitespace).
    """
    # Build a readable transcript of the turns to compress.
    lines: list[str] = []
    for msg in messages:
        role = msg.get("role", "unknown").capitalize()
        content = msg.get("content", "").strip()
        if content:
            lines.append(f"{role}: {content}")

    transcript = "\n".join(lines)

    prompt_messages = [
        {
            "role": "system",
            "content": (
                "You are a concise technical summariser. "
                "Summarise the following conversation in under 150 words. "
                "Focus on: what was built, key decisions made, and files modified. "
                "Be specific and factual. Do not include filler or pleasantries."
            ),
        },
        {
            "role": "user",
            "content": f"Conversation to summarise:\n\n{transcript}",
        },
    ]

    summary: str = generator.generate(
        prompt=prompt_messages,
        temperature=0.3,
        max_new_tokens=200,
        stream=False,
    )

    return summary.strip()


# ---------------------------------------------------------------------------
# Main compression entry point
# ---------------------------------------------------------------------------

def compress_history(
    generator: "ProverbsGenerator",
    messages: list[dict],
    tokenizer: "ProverbsTokenizer",
    token_budget: int = 2000,
    keep_recent: int = 6,
) -> list[dict]:
    """Compress *messages* so the total token count stays within *token_budget*.

    If the history is already within budget, the original list is returned
    unchanged.  Otherwise the older turns (everything except the system message
    and the most-recent ``keep_recent`` turns) are summarised into a single
    ``[Earlier context]`` system message inserted after the original system
    message.

    Args:
        generator:    A ``ProverbsGenerator`` used to produce the summary.
        messages:     Full message list; ``messages[0]`` must be the system message.
        tokenizer:    The project tokenizer used for token estimation.
        token_budget: Compression is skipped when total tokens are below this.
        keep_recent:  Number of tail messages always kept verbatim.

    Returns:
        Either the original *messages* list (unchanged) or a new compressed
        list of the form:
        ``[system_msg, earlier_context_msg, *recent_msgs]``.
    """
    if estimate_tokens(messages, tokenizer) < token_budget:
        return messages

    old, recent = split_messages(messages, keep_recent=keep_recent)

    if not old:
        # Nothing to compress — the recent window covers the whole history.
        return messages

    summary = summarize_messages(generator, old)

    rebuilt: list[dict] = [
        messages[0],
        {"role": "system", "content": "[Earlier context]: " + summary},
        *recent,
    ]
    return rebuilt
