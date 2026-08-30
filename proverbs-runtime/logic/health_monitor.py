"""
health_monitor.py — Resource monitor with automatic failover for Proverbs LLM.

Polls RAM, CPU, and GPU usage on a daemon thread and calls a user-supplied
on_critical callback when any threshold is exceeded, enabling the server to
shed load or trigger failover before OOM or runaway CPU kills the process.
"""

from __future__ import annotations

import logging
import platform
import subprocess
import threading
import time
from typing import Callable

log = logging.getLogger("proverbs.health_monitor")

_SYSTEM = platform.system()   # "Darwin" | "Linux" | other


# ── Low-level stat readers ────────────────────────────────────────────────────

def get_memory_usage() -> dict:
    """
    Return system RAM stats as {total_mb, used_mb, available_mb, percent_used}.

    macOS: parses `vm_stat` + `sysctl hw.pagesize`.
    Linux: parses /proc/meminfo.
    """
    if _SYSTEM == "Darwin":
        return _memory_macos()
    return _memory_linux()


def _memory_macos() -> dict:
    # Fetch page size via sysctl
    try:
        ps_out = subprocess.check_output(
            ["sysctl", "-n", "hw.pagesize"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        page_size = int(ps_out)
    except Exception:
        page_size = 4096

    # vm_stat output format:
    # "Pages wired down:   NNNN."
    # "Pages active:       NNNN."
    # "Pages inactive:     NNNN."
    # "Pages speculative:  NNNN."
    # "Pages free:         NNNN."
    try:
        vm_out = subprocess.check_output(
            ["vm_stat"],
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except Exception as exc:
        log.warning("vm_stat failed: %s", exc)
        return {"total_mb": 0, "used_mb": 0, "available_mb": 0, "percent_used": 0.0}

    pages: dict[str, int] = {}
    for line in vm_out.splitlines():
        for key, label in (
            ("wired", "Pages wired down"),
            ("active", "Pages active"),
            ("inactive", "Pages inactive"),
            ("speculative", "Pages speculative"),
            ("free", "Pages free"),
            ("purgeable", "Pages purgeable"),
        ):
            if line.startswith(label):
                raw = line.split(":")[-1].strip().rstrip(".")
                try:
                    pages[key] = int(raw)
                except ValueError:
                    pass

    wired      = pages.get("wired", 0)
    active     = pages.get("active", 0)
    inactive   = pages.get("inactive", 0)
    speculative= pages.get("speculative", 0)
    free       = pages.get("free", 0)
    purgeable  = pages.get("purgeable", 0)

    # Total physical RAM (hw.memsize gives bytes)
    try:
        mem_bytes = int(subprocess.check_output(
            ["sysctl", "-n", "hw.memsize"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip())
        total_pages = mem_bytes // page_size
    except Exception:
        total_pages = wired + active + inactive + speculative + free

    total_mb     = (total_pages * page_size) // (1024 * 1024)
    # "Used" = wired + active (inactive + speculative are reclaimable)
    used_mb      = ((wired + active) * page_size) // (1024 * 1024)
    available_mb = ((free + inactive + speculative + purgeable) * page_size) // (1024 * 1024)
    percent_used = (used_mb / total_mb * 100.0) if total_mb else 0.0

    return {
        "total_mb":     total_mb,
        "used_mb":      used_mb,
        "available_mb": available_mb,
        "percent_used": round(percent_used, 2),
    }


def _memory_linux() -> dict:
    try:
        with open("/proc/meminfo", "r") as fh:
            lines = fh.readlines()
    except OSError as exc:
        log.warning("/proc/meminfo unavailable: %s", exc)
        return {"total_mb": 0, "used_mb": 0, "available_mb": 0, "percent_used": 0.0}

    info: dict[str, int] = {}
    for line in lines:
        parts = line.split()
        if len(parts) >= 2:
            # Keys like "MemTotal:", values in kB
            info[parts[0].rstrip(":")] = int(parts[1])

    total_kb     = info.get("MemTotal", 0)
    available_kb = info.get("MemAvailable", info.get("MemFree", 0))
    used_kb      = total_kb - available_kb

    total_mb     = total_kb // 1024
    available_mb = available_kb // 1024
    used_mb      = used_kb // 1024
    percent_used = (used_mb / total_mb * 100.0) if total_mb else 0.0

    return {
        "total_mb":     total_mb,
        "used_mb":      used_mb,
        "available_mb": available_mb,
        "percent_used": round(percent_used, 2),
    }


# ─────────────────────────────────────────────────────────────────────────────

def get_cpu_percent(interval: float = 0.5) -> float:
    """
    Return CPU utilisation as a 0-100 float.

    Linux:  reads /proc/stat twice separated by `interval` seconds.
    macOS:  uses `top -l 2 -n 0` to get a real CPU idle reading; falls back
            to process_time delta if top is unavailable.
    """
    if _SYSTEM == "Linux":
        return _cpu_linux(interval)
    return _cpu_macos(interval)


def _cpu_linux(interval: float) -> float:
    def _read_stat() -> tuple[int, int]:
        """Return (idle, total) jiffy counts from /proc/stat cpu line."""
        try:
            with open("/proc/stat", "r") as fh:
                for line in fh:
                    if line.startswith("cpu "):
                        vals = list(map(int, line.split()[1:]))
                        # user nice system idle iowait irq softirq steal guest guest_nice
                        idle  = vals[3] + (vals[4] if len(vals) > 4 else 0)   # idle + iowait
                        total = sum(vals)
                        return idle, total
        except OSError:
            pass
        return 0, 0

    idle1, total1 = _read_stat()
    time.sleep(interval)
    idle2, total2 = _read_stat()

    d_total = total2 - total1
    d_idle  = idle2  - idle1

    if d_total == 0:
        return 0.0
    return round((1.0 - d_idle / d_total) * 100.0, 2)


def _cpu_macos(interval: float) -> float:
    # `top -l 2 -n 0 -s <interval>` prints two samples; the second is current.
    # We look for a line like:  CPU usage: 5.83% user, 8.33% sys, 85.83% idle
    try:
        delay = max(1, int(interval))   # top requires integer seconds
        out = subprocess.check_output(
            ["top", "-l", "2", "-n", "0", "-s", str(delay)],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=delay + 5,
        )
        idle_pct: float | None = None
        for line in reversed(out.splitlines()):
            if "CPU usage" in line or "cpu usage" in line.lower():
                # Example: "CPU usage: 5.83% user, 8.33% sys, 85.83% idle"
                for part in line.split(","):
                    part = part.strip()
                    if "idle" in part:
                        try:
                            idle_pct = float(part.split("%")[0].split()[-1])
                        except (ValueError, IndexError):
                            pass
                        break
                if idle_pct is not None:
                    break
        if idle_pct is not None:
            return round(100.0 - idle_pct, 2)
    except Exception as exc:
        log.debug("top CPU read failed (%s), falling back to process_time", exc)

    # Fallback: process_time delta (measures this process only, not system-wide)
    t1 = time.process_time()
    time.sleep(interval)
    t2 = time.process_time()
    cpu_frac = (t2 - t1) / interval
    return round(min(cpu_frac * 100.0, 100.0), 2)


# ─────────────────────────────────────────────────────────────────────────────

def get_gpu_memory() -> dict | None:
    """
    Return CUDA GPU memory stats as {allocated_mb, reserved_mb, percent} or
    None when CUDA is unavailable.
    """
    try:
        import torch
        if not torch.cuda.is_available():
            return None
        allocated  = torch.cuda.memory_allocated()
        reserved   = torch.cuda.memory_reserved()
        total      = torch.cuda.get_device_properties(0).total_memory
        percent    = (allocated / total * 100.0) if total else 0.0
        return {
            "allocated_mb": allocated // (1024 * 1024),
            "reserved_mb":  reserved  // (1024 * 1024),
            "percent":      round(percent, 2),
        }
    except Exception:
        return None


# ── HealthMonitor ─────────────────────────────────────────────────────────────

class HealthMonitor:
    """
    Daemon thread that polls RAM / CPU / GPU every `poll_interval` seconds and
    calls an optional `on_critical` callback when any threshold is exceeded.
    """

    def __init__(
        self,
        ram_threshold_pct: float = 85.0,
        cpu_threshold_pct: float = 95.0,
        gpu_threshold_pct: float = 90.0,
        poll_interval:     float = 10.0,
    ) -> None:
        self.ram_threshold_pct = ram_threshold_pct
        self.cpu_threshold_pct = cpu_threshold_pct
        self.gpu_threshold_pct = gpu_threshold_pct
        self.poll_interval     = poll_interval

        self.alerts: list[dict]    = []
        self._thread: threading.Thread | None = None
        self._running: bool        = False
        self._start_time: float    = 0.0
        self._last_check: dict     = {}

    # ── Public API ────────────────────────────────────────────────────────────

    def check(self) -> dict:
        """
        Run all stat collectors and return a snapshot:
          {memory, cpu, gpu, healthy, warnings}
        """
        memory   = get_memory_usage()
        cpu_pct  = get_cpu_percent(interval=0.5)
        gpu      = get_gpu_memory()

        warnings: list[str] = []
        healthy = True

        if memory.get("percent_used", 0) >= self.ram_threshold_pct:
            warnings.append("ram")
            healthy = False

        if cpu_pct >= self.cpu_threshold_pct:
            warnings.append("cpu")
            healthy = False

        if gpu is not None and gpu.get("percent", 0) >= self.gpu_threshold_pct:
            warnings.append("gpu")
            healthy = False

        result = {
            "memory":   memory,
            "cpu":      cpu_pct,
            "gpu":      gpu,
            "healthy":  healthy,
            "warnings": warnings,
        }
        self._last_check = result
        return result

    def start(self, on_critical: Callable[[str], None] | None = None) -> None:
        """
        Start the background polling thread.

        on_critical(resource) is called on the polling thread with resource in
        {"ram", "cpu", "gpu"} whenever a threshold is exceeded.
        """
        if self._running:
            return

        self._running    = True
        self._start_time = time.time()

        def _poll() -> None:
            while self._running:
                try:
                    snapshot = self.check()
                    for resource in snapshot["warnings"]:
                        alert = {
                            "resource":  resource,
                            "timestamp": time.time(),
                            "snapshot":  snapshot,
                        }
                        self.alerts.append(alert)
                        log.warning(
                            "Health alert: %s threshold exceeded (mem=%.1f%% cpu=%.1f%%)",
                            resource,
                            snapshot["memory"].get("percent_used", 0),
                            snapshot["cpu"],
                        )
                        if on_critical is not None:
                            try:
                                on_critical(resource)
                            except Exception as exc:
                                log.error("on_critical(%r) raised: %s", resource, exc)
                except Exception as exc:
                    log.error("Health poll error: %s", exc, exc_info=True)

                time.sleep(self.poll_interval)

        self._thread = threading.Thread(target=_poll, name="proverbs-health-monitor", daemon=True)
        self._thread.start()
        log.info(
            "HealthMonitor started (ram=%.0f%% cpu=%.0f%% gpu=%.0f%% interval=%.0fs)",
            self.ram_threshold_pct,
            self.cpu_threshold_pct,
            self.gpu_threshold_pct,
            self.poll_interval,
        )

    def stop(self) -> None:
        """Stop the background polling thread."""
        self._running = False
        log.info("HealthMonitor stopped")

    def status(self) -> dict:
        """Return last check snapshot plus alert_count and uptime_seconds."""
        uptime = (time.time() - self._start_time) if self._start_time else 0.0
        return {
            **self._last_check,
            "alert_count":    len(self.alerts),
            "uptime_seconds": round(uptime, 1),
            "running":        self._running,
        }


# Global instance
health_monitor = HealthMonitor()
