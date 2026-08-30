"""
Performance and stability tests for Proverbs LLM components.
Run with: ~/.proverbs/venv/bin/python perf_test.py
"""

from __future__ import annotations

import sys
import os
import time
import threading

# Ensure project root on path
sys.path.insert(0, "/Users/Stizzop/proverbs")

RESULTS: list[dict] = []


def record(name: str, passed: bool, timing_s: float, notes: str = "") -> None:
    status = "PASS" if passed else "FAIL"
    print(f"  [{status}] {name} — {timing_s*1000:.1f} ms{' | ' + notes if notes else ''}")
    RESULTS.append({"name": name, "passed": passed, "timing_s": timing_s, "notes": notes})


# ---------------------------------------------------------------------------
# Test 1: Rate Limiter Stress Test
# ---------------------------------------------------------------------------

def test_rate_limiter() -> None:
    print("\n=== Test 1: Rate Limiter Stress Test ===")
    t0 = time.perf_counter()
    try:
        from inference.rate_limiter import RateLimiter
        rl = RateLimiter(requests_per_minute=10, burst=5)
        identifier = "test-client"

        allowed_count = 0
        denied_count = 0

        for i in range(15):
            ok, info = rl.is_allowed(identifier)
            if ok:
                allowed_count += 1
            else:
                denied_count += 1

        elapsed = time.perf_counter() - t0

        # First 10 should be allowed, last 5 denied
        passes = (allowed_count == 10 and denied_count == 5)
        notes = f"allowed={allowed_count}/10 denied={denied_count}/5"
        record("rate_limiter_stress", passes, elapsed, notes)

        # Verify False return after limit
        ok2, _ = rl.is_allowed(identifier)
        t1 = time.perf_counter()
        record("rate_limiter_returns_false_after_limit", ok2 is False, t1 - t0,
               f"11th call returned {'False' if ok2 is False else 'True (WRONG)'}")

    except Exception as exc:
        elapsed = time.perf_counter() - t0
        record("rate_limiter_stress", False, elapsed, f"Exception: {exc}")
        record("rate_limiter_returns_false_after_limit", False, elapsed, f"Exception: {exc}")


# ---------------------------------------------------------------------------
# Test 2: Concurrent Tool Calls (thread safety)
# ---------------------------------------------------------------------------

def test_concurrent_tool_calls() -> None:
    print("\n=== Test 2: Concurrent Tool Calls (Thread Safety) ===")
    t0 = time.perf_counter()
    try:
        from logic.tools import tool_router

        # Use the built-in read_file tool via route()
        # Build a read_file tool_call block pointing to a file we know exists
        target_file = "/Users/Stizzop/proverbs/inference/rate_limiter.py"
        tool_call_block = (
            f'<tool_call>{{"name": "read_file", "arguments": {{"path": "{target_file}"}}}}</tool_call>'
        )

        results = [None] * 10
        errors = []

        def call_tool(idx: int) -> None:
            try:
                result = tool_router.route(tool_call_block)
                results[idx] = result
            except Exception as exc:
                errors.append(f"Thread {idx}: {exc}")

        threads = [threading.Thread(target=call_tool, args=(i,)) for i in range(10)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()

        elapsed = time.perf_counter() - t0

        # All results should be non-None and contain <tool_result>
        valid = sum(1 for r in results if r and "<tool_result>" in r)
        passes = (valid == 10 and len(errors) == 0)
        notes = f"valid_results={valid}/10 errors={len(errors)}"
        record("concurrent_tool_calls", passes, elapsed, notes)

    except Exception as exc:
        elapsed = time.perf_counter() - t0
        record("concurrent_tool_calls", False, elapsed, f"Exception: {exc}")


# ---------------------------------------------------------------------------
# Test 3: Large Input Handling
# ---------------------------------------------------------------------------

def test_large_input() -> None:
    print("\n=== Test 3: Large Input Handling (50000 chars) ===")
    t0 = time.perf_counter()
    try:
        from inference.security_middleware import validate_messages

        large_content = "A" * 50_000
        messages = [{"role": "user", "content": large_content}]
        ok, err = validate_messages(messages)
        elapsed = time.perf_counter() - t0

        # Should be rejected (max is 32000)
        passes = (ok is False and "32" in err)
        notes = f"rejected={not ok} error_msg='{err[:80]}'"
        record("large_input_rejected", passes, elapsed, notes)

    except Exception as exc:
        elapsed = time.perf_counter() - t0
        record("large_input_rejected", False, elapsed, f"Exception: {exc}")


# ---------------------------------------------------------------------------
# Test 4: Memory Usage + Model Load Time
# ---------------------------------------------------------------------------

def test_memory_and_model_load() -> None:
    print("\n=== Test 4: Memory Usage + Model Load Time ===")
    try:
        import psutil
        process = psutil.Process()
        mem_before_mb = process.memory_info().rss / 1024 / 1024
    except ImportError:
        mem_before_mb = None

    t0 = time.perf_counter()
    try:
        from model.config import ProverbsConfig
        from model.proverbs_lm import ProverbsLM
        import torch

        cfg = ProverbsConfig.nano()
        model = ProverbsLM(cfg)
        model.eval()

        elapsed = time.perf_counter() - t0

        try:
            mem_after_mb = psutil.Process().memory_info().rss / 1024 / 1024
            mem_delta_mb = mem_after_mb - mem_before_mb
            notes = f"load_time={elapsed*1000:.0f}ms mem_delta={mem_delta_mb:.1f}MB"
        except Exception:
            notes = f"load_time={elapsed*1000:.0f}ms mem_delta=N/A (psutil missing)"

        passes = elapsed < 30.0
        record("model_load_under_30s", passes, elapsed, notes)

    except Exception as exc:
        elapsed = time.perf_counter() - t0
        record("model_load_under_30s", False, elapsed, f"Exception: {exc}")


# ---------------------------------------------------------------------------
# Test 5: Tokenizer Performance (1000 encodes in < 5s)
# ---------------------------------------------------------------------------

def test_tokenizer_performance() -> None:
    print("\n=== Test 5: Tokenizer Performance ===")
    t0 = time.perf_counter()
    try:
        from tokenizer.bpe import ProverbsTokenizer

        tok_path = os.path.expanduser("~/.proverbs/tokenizer.json")
        tok = ProverbsTokenizer.load(tok_path)

        strings = [f"Hello world {i} from Proverbs LLM" for i in range(1000)]

        encode_start = time.perf_counter()
        for s in strings:
            tok.encode(s)
        elapsed = time.perf_counter() - encode_start
        total_elapsed = time.perf_counter() - t0

        passes = elapsed < 5.0
        notes = f"1000 encodes in {elapsed*1000:.0f}ms (limit 5000ms)"
        record("tokenizer_1000_encodes", passes, elapsed, notes)

    except Exception as exc:
        elapsed = time.perf_counter() - t0
        record("tokenizer_1000_encodes", False, elapsed, f"Exception: {exc}")


# ---------------------------------------------------------------------------
# Test 6: HNSW Index Performance
# ---------------------------------------------------------------------------

def test_hnsw_performance() -> None:
    print("\n=== Test 6: HNSW Index Performance ===")
    t0 = time.perf_counter()
    try:
        import numpy as np
        from logic.vector_store import HNSWIndex

        dim = 128
        n_vectors = 1000
        n_queries = 10

        # Build random L2-normalized vectors
        rng = np.random.default_rng(42)
        vecs = rng.standard_normal((n_vectors, dim)).astype(np.float32)
        norms = np.linalg.norm(vecs, axis=1, keepdims=True)
        vecs = vecs / norms

        index = HNSWIndex(dim=dim)

        build_start = time.perf_counter()
        for vec in vecs:
            index.add(vec)
        build_elapsed = time.perf_counter() - build_start

        # Run 10 queries
        query_vecs = rng.standard_normal((n_queries, dim)).astype(np.float32)
        query_vecs = query_vecs / np.linalg.norm(query_vecs, axis=1, keepdims=True)

        search_start = time.perf_counter()
        search_results = []
        for qv in query_vecs:
            results = index.search(qv, k=5)
            search_results.append(results)
        search_elapsed = time.perf_counter() - search_start

        total_elapsed = time.perf_counter() - t0

        # Validate results have content
        results_valid = all(len(r) > 0 for r in search_results)
        passes = results_valid

        notes = (
            f"build={build_elapsed*1000:.0f}ms for {n_vectors} vectors | "
            f"search={search_elapsed*1000:.0f}ms for {n_queries} queries | "
            f"results_valid={results_valid}"
        )
        record("hnsw_build_1000_vectors", passes, build_elapsed, notes)
        record("hnsw_search_10_queries", results_valid, search_elapsed,
               f"10 queries in {search_elapsed*1000:.1f}ms, all returned results={results_valid}")

    except Exception as exc:
        elapsed = time.perf_counter() - t0
        record("hnsw_build_1000_vectors", False, elapsed, f"Exception: {exc}")
        record("hnsw_search_10_queries", False, elapsed, f"Exception: {exc}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    print("=" * 60)
    print("Proverbs LLM Performance & Stability Test Suite")
    print("=" * 60)

    test_rate_limiter()
    test_concurrent_tool_calls()
    test_large_input()
    test_memory_and_model_load()
    test_tokenizer_performance()
    test_hnsw_performance()

    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    passed = sum(1 for r in RESULTS if r["passed"])
    total = len(RESULTS)
    for r in RESULTS:
        status = "PASS" if r["passed"] else "FAIL"
        print(f"  [{status}] {r['name']} ({r['timing_s']*1000:.1f}ms)")
    print(f"\n{passed}/{total} tests passed")

    # Output machine-readable JSON for the caller
    import json
    print("\n--- JSON_RESULTS_START ---")
    print(json.dumps(RESULTS))
    print("--- JSON_RESULTS_END ---")


if __name__ == "__main__":
    main()
