"""
PriorityInferenceQueue — priority-ordered request queue for the Proverbs inference server.

Requests are classified into four priority tiers (CRITICAL → BACKGROUND).  The
run loop drains higher-priority queues before lower ones, so interactive
completions are never stalled behind long background jobs.

Usage::

    from inference.priority_queue import PriorityInferenceQueue, Priority

    queue = PriorityInferenceQueue(generator, max_concurrent=2)
    await queue.start()

    result = await queue.submit(
        messages=[{"role": "user", "content": "Hello"}],
        model="proverbs",
        priority=Priority.INTERACTIVE,
        max_tokens=256,
        temperature=0.7,
        stream=False,
    )
    await queue.stop()
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any

log = logging.getLogger("proverbs.priority_queue")


# ---------------------------------------------------------------------------
# Priority tiers
# ---------------------------------------------------------------------------


class Priority(IntEnum):
    CRITICAL = 0     # health checks, urgent tool-calls
    INTERACTIVE = 1  # direct user chat completions
    NORMAL = 2       # default API requests
    BACKGROUND = 3   # batch jobs, self-learning, prefetch


# Priority labels used in stats output — ordered for display
_PRIORITY_NAMES: dict[Priority, str] = {
    Priority.CRITICAL:    "critical",
    Priority.INTERACTIVE: "interactive",
    Priority.NORMAL:      "normal",
    Priority.BACKGROUND:  "background",
}


# ---------------------------------------------------------------------------
# Request dataclass
# ---------------------------------------------------------------------------


@dataclass
class InferenceRequest:
    id: str
    messages: list[dict]
    model: str
    priority: Priority
    max_tokens: int
    temperature: float
    stream: bool
    created_at: float                    # time.monotonic() at submission
    future: asyncio.Future = field(repr=False)  # resolved with str result


# ---------------------------------------------------------------------------
# Queue
# ---------------------------------------------------------------------------


class PriorityInferenceQueue:
    """
    Wraps any generator with a .generate() method and dispatches requests
    in strict priority order, respecting a max-concurrency semaphore.
    """

    def __init__(self, generator: Any, max_concurrent: int = 2) -> None:
        self._generator = generator
        self._semaphore = asyncio.Semaphore(max_concurrent)
        self._max_concurrent = max_concurrent
        # Separate asyncio.Queue per priority tier so we never mix tiers.
        self._queues: dict[Priority, asyncio.Queue[InferenceRequest]] = {
            p: asyncio.Queue() for p in Priority
        }
        self._running = False
        self._active = 0
        self._loop_task: asyncio.Task | None = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def submit(
        self,
        messages: list[dict],
        model: str,
        priority: Priority = Priority.NORMAL,
        *,
        max_tokens: int = 512,
        temperature: float = 0.7,
        stream: bool = False,
    ) -> str:
        """
        Enqueue a generation request and wait for its result.

        Returns the completed text string (or raises if generation fails).
        """
        loop = asyncio.get_event_loop()
        future: asyncio.Future = loop.create_future()

        request = InferenceRequest(
            id=uuid.uuid4().hex,
            messages=messages,
            model=model,
            priority=priority,
            max_tokens=max_tokens,
            temperature=temperature,
            stream=stream,
            created_at=time.monotonic(),
            future=future,
        )

        await self._queues[priority].put(request)
        log.debug(
            "Enqueued request %s (priority=%s, model=%s)",
            request.id[:8],
            priority.name,
            model,
        )

        return await future

    async def start(self) -> None:
        """Start the background dispatch loop."""
        if self._running:
            return
        self._running = True
        self._loop_task = asyncio.create_task(self._run_loop())
        log.info(
            "PriorityInferenceQueue started (max_concurrent=%d)", self._max_concurrent
        )

    async def stop(self) -> None:
        """Signal the dispatch loop to stop after the current batch drains."""
        self._running = False
        if self._loop_task is not None:
            self._loop_task.cancel()
            try:
                await self._loop_task
            except asyncio.CancelledError:
                pass
            self._loop_task = None
        log.info("PriorityInferenceQueue stopped")

    def stats(self) -> dict:
        """
        Return a snapshot of current queue depths and active slot count.

        Example::

            {
                "queue_depths": {"critical": 0, "interactive": 2, "normal": 5, "background": 1},
                "active": 2,
            }
        """
        return {
            "queue_depths": {
                _PRIORITY_NAMES[p]: self._queues[p].qsize() for p in Priority
            },
            "active": self._active,
        }

    # ------------------------------------------------------------------
    # Internal dispatch loop
    # ------------------------------------------------------------------

    def _next_request(self) -> InferenceRequest | None:
        """
        Drain queues in strict priority order (CRITICAL first, BACKGROUND last).
        Returns the next request or None if all queues are empty.
        """
        for p in Priority:
            try:
                return self._queues[p].get_nowait()
            except asyncio.QueueEmpty:
                continue
        return None

    async def _run_loop(self) -> None:
        """
        Core dispatch loop.  Continuously polls priority queues and launches
        generation tasks up to the concurrency limit.
        """
        while self._running:
            request = self._next_request()

            if request is None:
                # All queues are empty — yield briefly and poll again.
                await asyncio.sleep(0.001)
                continue

            # Acquire the semaphore before spawning so we respect max_concurrent.
            await self._semaphore.acquire()
            self._active += 1

            asyncio.create_task(self._dispatch(request))

    async def _dispatch(self, request: InferenceRequest) -> None:
        """
        Run generation for a single request, then release the semaphore and
        resolve the caller's Future.
        """
        try:
            log.debug(
                "Dispatching request %s (priority=%s)",
                request.id[:8],
                request.priority.name,
            )

            loop = asyncio.get_event_loop()
            result: str = await loop.run_in_executor(
                None,
                lambda: self._generator.generate(
                    prompt=request.messages,
                    max_new_tokens=request.max_tokens,
                    temperature=request.temperature,
                    stream=request.stream,
                ),
            )

            if not request.future.done():
                request.future.set_result(result)

            elapsed = time.monotonic() - request.created_at
            log.debug(
                "Request %s completed in %.3fs (priority=%s)",
                request.id[:8],
                elapsed,
                request.priority.name,
            )

        except Exception as exc:
            log.error(
                "Request %s failed: %s",
                request.id[:8],
                exc,
                exc_info=True,
            )
            if not request.future.done():
                request.future.set_exception(exc)

        finally:
            self._active -= 1
            self._semaphore.release()
