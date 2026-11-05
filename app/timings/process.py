"""Process-wide latency histograms (M7.4), in memory only.

Per run, timings are spans (``app.timings.recorder``). Some costs belong to
the process instead: the store's lock and statements, shared by every run
and stream, and the server side of a live stream. These are kept here as
fixed-bucket histograms.

* **Fixed names.** Only the metrics in ``HISTOGRAM_NAMES`` and the counters
  in ``COUNTER_NAMES`` exist; there are no labels. An unknown name is
  ignored and counted (``unknown_names``), so memory never grows with use.
* **Fixed buckets.** ``BUCKET_BOUNDS_NS`` holds 48 inclusive upper bounds,
  log-spaced from 50 µs to 120 s; a 49th bucket counts overflow (above
  120 s). An observation ``v`` (integer nanoseconds, ``v >= 0``) goes to the
  first bucket whose bound is ``>= v``. Anything else (negative, not an
  integer) is counted as ``invalid`` and in no bucket. Each histogram also
  keeps ``count``, ``sum_ns``, ``min_ns`` and ``max_ns`` of valid
  observations: constant memory, whatever the number of observations.
* **Thread-safe.** Each histogram has its own lock: the store records from
  whichever thread writes, streams from the event loop.
* **Never raises.** An instrumentation failure is counted (``errors``) and
  dropped; the operation being measured is unaffected.
* **Reset at restart.** Nothing is persisted, and there is no HTTP endpoint
  or UI (review decision): the registry is read in-process, by tests.

Disabled (``SWARMOS_TIMINGS=0``, applied by ``configure``), nothing is
recorded and callers skip their clock reads.
"""

from __future__ import annotations

import threading
from bisect import bisect_left
from typing import Any

# 48 log-spaced inclusive upper bounds, 50 µs to 120 s, in nanoseconds.
BUCKET_COUNT = 48
LOWEST_BOUND_NS = 50_000
HIGHEST_BOUND_NS = 120_000_000_000
BUCKET_BOUNDS_NS: tuple[int, ...] = tuple(
    round(LOWEST_BOUND_NS * (HIGHEST_BOUND_NS / LOWEST_BOUND_NS) ** (i / (BUCKET_COUNT - 1)))
    for i in range(BUCKET_COUNT - 1)
) + (HIGHEST_BOUND_NS,)

HISTOGRAM_NAMES = (
    # RunStore: waiting for the store lock, then executing (and, for a
    # write, committing) while holding it.
    "db_read.lock_wait",
    "db_read.execute",
    "db_write.lock_wait",
    "db_write.execute",
    # A live stream: an event's commit to the stream yielding its frame
    # (app.streaming). Server side only: not delivery latency.
    "sse_commit_to_yield",
)
COUNTER_NAMES = (
    # Commit stamps not kept because the bounded map was full.
    "sse_commit_to_yield.stamps_dropped",
)


class Histogram:
    """One metric's fixed buckets and summary; see the module docstring."""

    __slots__ = ("_lock", "_counts", "_count", "_sum_ns", "_min_ns", "_max_ns", "_invalid")

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._reset()

    def _reset(self) -> None:
        self._counts = [0] * (len(BUCKET_BOUNDS_NS) + 1)
        self._count = 0
        self._sum_ns = 0
        self._min_ns: int | None = None
        self._max_ns: int | None = None
        self._invalid = 0

    def observe(self, value_ns: int) -> None:
        if type(value_ns) is not int or value_ns < 0:
            with self._lock:
                self._invalid += 1
            return
        index = bisect_left(BUCKET_BOUNDS_NS, value_ns)  # == len(bounds): overflow
        with self._lock:
            self._counts[index] += 1
            self._count += 1
            self._sum_ns += value_ns
            if self._min_ns is None or value_ns < self._min_ns:
                self._min_ns = value_ns
            if self._max_ns is None or value_ns > self._max_ns:
                self._max_ns = value_ns

    def reset(self) -> None:
        with self._lock:
            self._reset()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "count": self._count,
                "sum_ns": self._sum_ns,
                "min_ns": self._min_ns,
                "max_ns": self._max_ns,
                "counts": list(self._counts),
                "overflow": self._counts[-1],
                "invalid": self._invalid,
            }


class ProcessHistograms:
    """The fixed set of process histograms and counters."""

    def __init__(self, enabled: bool = True) -> None:
        self.enabled = enabled
        self._histograms = {name: Histogram() for name in HISTOGRAM_NAMES}
        self._lock = threading.Lock()
        self._counters = dict.fromkeys(COUNTER_NAMES, 0)
        self._unknown_names = 0
        self._errors = 0

    def observe(self, name: str, value_ns: int) -> None:
        """Add one observation; never raises."""
        if not self.enabled:
            return
        try:
            histogram = self._histograms.get(name)
            if histogram is None:
                with self._lock:
                    self._unknown_names += 1
                return
            histogram.observe(value_ns)
        except Exception:  # noqa: BLE001 - instrumentation never fails its caller
            self.failed()

    def increment(self, name: str) -> None:
        """Add one to a counter; never raises."""
        if not self.enabled:
            return
        try:
            with self._lock:
                if name in self._counters:
                    self._counters[name] += 1
                else:
                    self._unknown_names += 1
        except Exception:  # noqa: BLE001
            self.failed()

    def failed(self) -> None:
        """Count an instrumentation failure (here or in a caller); never raises."""
        try:
            with self._lock:
                self._errors += 1
        except Exception:  # noqa: BLE001 - nothing left to record it in
            pass

    def reset(self) -> None:
        """Empty every histogram and counter (tests; a restart does the same)."""
        for histogram in self._histograms.values():
            histogram.reset()
        with self._lock:
            self._counters = dict.fromkeys(COUNTER_NAMES, 0)
            self._unknown_names = 0
            self._errors = 0

    def snapshot(self) -> dict[str, Any]:
        """Everything recorded since start or reset, by name (a copy)."""
        with self._lock:
            counters = dict(self._counters)
            unknown, errors = self._unknown_names, self._errors
        return {
            "enabled": self.enabled,
            "bounds_ns": list(BUCKET_BOUNDS_NS),
            "histograms": {name: histogram.snapshot() for name, histogram in self._histograms.items()},
            "counters": counters,
            "unknown_names": unknown,
            "errors": errors,
        }


# The process's registry. Starts empty with the process; nothing persists.
PROCESS = ProcessHistograms()


def configure(enabled: bool) -> None:
    """Turn process recording on or off (from ``Settings.timings_enabled``)."""
    PROCESS.enabled = enabled
