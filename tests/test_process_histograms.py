"""Process histograms (app.timings.process, M7.4): fixed buckets, fixed
names, thread-safe updates, constant memory, reset on restart, and no
instrumentation failure ever reaching the caller."""

from __future__ import annotations

import json
import subprocess
import sys
import threading
from itertools import pairwise
from pathlib import Path

import pytest

import app.timings.process as process_module
from app.timings.process import (
    BUCKET_BOUNDS_NS,
    COUNTER_NAMES,
    HISTOGRAM_NAMES,
    PROCESS,
    Histogram,
    ProcessHistograms,
    configure,
)

ROOT = Path(__file__).resolve().parent.parent
OVERFLOW = len(BUCKET_BOUNDS_NS)  # index of the overflow bucket


def bucket_of(histogram: Histogram, value: int) -> int:
    before = histogram.snapshot()["counts"]
    histogram.observe(value)
    after = histogram.snapshot()["counts"]
    (index,) = [i for i, (a, b) in enumerate(zip(before, after, strict=True)) if a != b]
    return index


# ----------------------------------------------------------------------
# buckets
# ----------------------------------------------------------------------
def test_the_bounds_are_48_log_spaced_values_from_50us_to_120s():
    assert len(BUCKET_BOUNDS_NS) == 48
    assert BUCKET_BOUNDS_NS[0] == 50_000 and BUCKET_BOUNDS_NS[-1] == 120_000_000_000
    assert all(isinstance(bound, int) for bound in BUCKET_BOUNDS_NS)
    assert all(a < b for a, b in pairwise(BUCKET_BOUNDS_NS))
    ratios = [b / a for a, b in pairwise(BUCKET_BOUNDS_NS)]
    assert max(ratios) - min(ratios) < 1e-4  # one constant ratio, about 1.367


@pytest.mark.parametrize(
    ("value", "bucket"),
    [
        (0, 0),
        (1, 0),
        (50_000, 0),  # a bound is inclusive: 50 µs is in the first bucket
        (50_001, 1),
        (BUCKET_BOUNDS_NS[1], 1),
        (BUCKET_BOUNDS_NS[1] + 1, 2),
        (BUCKET_BOUNDS_NS[23], 23),
        (BUCKET_BOUNDS_NS[46] + 1, 47),
        (120_000_000_000, 47),  # exactly 120 s: the last bucket
        (120_000_000_001, OVERFLOW),  # above 120 s: overflow
        (10**15, OVERFLOW),
    ],
)
def test_each_value_goes_to_the_first_bucket_whose_bound_is_not_below_it(value, bucket):
    assert bucket_of(Histogram(), value) == bucket


@pytest.mark.parametrize("value", [-1, -10**12, 1.5, float("nan"), True, None, "5"])
def test_an_invalid_observation_is_counted_apart_and_in_no_bucket(value):
    histogram = Histogram()
    histogram.observe(value)
    snapshot = histogram.snapshot()
    assert snapshot["invalid"] == 1
    assert snapshot["count"] == 0 and sum(snapshot["counts"]) == 0
    assert snapshot["min_ns"] is None and snapshot["max_ns"] is None


def test_count_sum_min_max_and_overflow_by_hand():
    histogram = Histogram()
    for value in (40_000, 50_000, 60_000, 200_000_000_000, 7):
        histogram.observe(value)
    snapshot = histogram.snapshot()
    assert snapshot["count"] == 5
    assert snapshot["sum_ns"] == 40_000 + 50_000 + 60_000 + 200_000_000_000 + 7
    assert (snapshot["min_ns"], snapshot["max_ns"]) == (7, 200_000_000_000)
    assert snapshot["counts"][0] == 3  # 7, 40 µs and 50 µs
    assert snapshot["counts"][1] == 1  # 60 µs
    assert snapshot["overflow"] == snapshot["counts"][OVERFLOW] == 1
    assert sum(snapshot["counts"]) == snapshot["count"]


def test_an_empty_histogram_is_null_not_zero_for_min_and_max():
    snapshot = Histogram().snapshot()
    assert snapshot["count"] == 0 and snapshot["sum_ns"] == 0
    assert snapshot["min_ns"] is None and snapshot["max_ns"] is None


# ----------------------------------------------------------------------
# the registry
# ----------------------------------------------------------------------
def test_the_registry_has_exactly_the_fixed_names():
    snapshot = ProcessHistograms().snapshot()
    assert tuple(snapshot["histograms"]) == HISTOGRAM_NAMES == (
        "db_read.lock_wait",
        "db_read.execute",
        "db_write.lock_wait",
        "db_write.execute",
        "sse_commit_to_yield",
    )
    assert tuple(snapshot["counters"]) == COUNTER_NAMES
    assert snapshot["bounds_ns"] == list(BUCKET_BOUNDS_NS)


def test_unknown_names_are_counted_and_never_create_a_metric():
    registry = ProcessHistograms()
    for i in range(1000):
        registry.observe(f"user_{i}", 1)  # would be unbounded cardinality
        registry.increment(f"counter_{i}")
    snapshot = registry.snapshot()
    assert snapshot["unknown_names"] == 2000
    assert tuple(snapshot["histograms"]) == HISTOGRAM_NAMES
    assert tuple(snapshot["counters"]) == COUNTER_NAMES
    assert all(item["count"] == 0 for item in snapshot["histograms"].values())


def test_memory_stays_constant_however_many_observations():
    registry = ProcessHistograms()
    for value in range(0, 200_000_000_000, 1_999_999):  # 100,001 observations
        registry.observe("db_write.execute", value)
    snapshot = registry.snapshot()
    item = snapshot["histograms"]["db_write.execute"]
    assert item["count"] == 100_001
    assert len(item["counts"]) == len(BUCKET_BOUNDS_NS) + 1 == 49
    assert len(snapshot["histograms"]) == len(HISTOGRAM_NAMES)
    # What a histogram stores is fixed: its slots, and a list of 49 counts.
    assert Histogram.__slots__ == ("_lock", "_counts", "_count", "_sum_ns", "_min_ns", "_max_ns", "_invalid")


def test_concurrent_updates_are_not_lost():
    registry = ProcessHistograms()
    threads, per_thread = 8, 5_000
    values = [1_000, 60_000, 5_000_000, 130_000_000_000]  # buckets 0, 1, a middle one, overflow
    barrier = threading.Barrier(threads)

    def work():
        barrier.wait()
        for i in range(per_thread):
            registry.observe("db_read.execute", values[i % 4])
            registry.increment("sse_commit_to_yield.stamps_dropped")

    workers = [threading.Thread(target=work) for _ in range(threads)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()
    snapshot = registry.snapshot()
    item = snapshot["histograms"]["db_read.execute"]
    total = threads * per_thread
    assert item["count"] == total
    assert item["sum_ns"] == (total // 4) * sum(values)
    assert item["counts"][0] == item["counts"][1] == item["overflow"] == total // 4
    assert sum(item["counts"]) == total
    assert snapshot["counters"]["sse_commit_to_yield.stamps_dropped"] == total


def test_reset_empties_everything():
    registry = ProcessHistograms()
    registry.observe("db_write.lock_wait", 10)
    registry.increment("sse_commit_to_yield.stamps_dropped")
    registry.observe("nope", 1)
    registry.reset()
    snapshot = registry.snapshot()
    assert all(item["count"] == 0 for item in snapshot["histograms"].values())
    assert set(snapshot["counters"].values()) == {0}
    assert snapshot["unknown_names"] == 0 and snapshot["errors"] == 0


def test_a_restarted_process_starts_empty():
    PROCESS.observe("db_write.execute", 123)  # this process has data...
    code = (
        "import json; from app.timings.process import PROCESS; "
        "s = PROCESS.snapshot(); "
        "print(json.dumps([sum(h['count'] for h in s['histograms'].values()), s['counters'], s['enabled']]))"
    )
    try:
        result = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True, timeout=60, check=True)
    finally:
        PROCESS.reset()
    # ...a new one has none: nothing is persisted.
    assert json.loads(result.stdout) == [0, {"sse_commit_to_yield.stamps_dropped": 0}, True]


# ----------------------------------------------------------------------
# disabled, and failures
# ----------------------------------------------------------------------
def test_a_disabled_registry_records_nothing():
    registry = ProcessHistograms(enabled=False)
    registry.observe("db_write.execute", 10)
    registry.increment("sse_commit_to_yield.stamps_dropped")
    registry.observe("unknown", 1)
    snapshot = registry.snapshot()
    assert snapshot["enabled"] is False
    assert snapshot["histograms"]["db_write.execute"]["count"] == 0
    assert snapshot["counters"]["sse_commit_to_yield.stamps_dropped"] == 0
    assert snapshot["unknown_names"] == 0


def test_configure_switches_the_process_registry(monkeypatch):
    monkeypatch.setattr(PROCESS, "enabled", True)
    configure(False)
    assert process_module.PROCESS.enabled is False
    configure(True)
    assert process_module.PROCESS.enabled is True


def test_an_instrumentation_failure_is_counted_and_never_raised(monkeypatch):
    registry = ProcessHistograms()

    class Broken(Histogram):
        __slots__ = ()

        def observe(self, value_ns):
            raise RuntimeError("bucket storage broke")

    monkeypatch.setitem(registry._histograms, "db_write.execute", Broken())
    registry.observe("db_write.execute", 10)  # does not raise
    registry.observe("db_read.execute", 10)  # the others still work
    snapshot = registry.snapshot()
    assert snapshot["errors"] == 1
    assert snapshot["histograms"]["db_read.execute"]["count"] == 1


def test_a_broken_counter_lock_is_swallowed(monkeypatch):
    registry = ProcessHistograms()

    class BrokenLock:
        def __enter__(self):
            raise RuntimeError("lock broke")

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(registry, "_lock", BrokenLock())
    registry.increment("sse_commit_to_yield.stamps_dropped")  # neither raises
    registry.observe("unknown", 1)
