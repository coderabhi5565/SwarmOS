"""The A/B overhead harness (scripts/measure_timings_overhead.py) runs and
reports what it says: one pair, no warm-up, one catalog task."""

from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path

import pytest

from app.demo_tasks import SAMPLE_TASK_ID

ROOT = Path(__file__).resolve().parent.parent


def load_harness():
    spec = importlib.util.spec_from_file_location("measure_timings_overhead", ROOT / "scripts" / "measure_timings_overhead.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_one_pair_is_measured_and_summarised():
    harness = load_harness()
    results = asyncio.run(harness.measure(pairs=1, warmup=0, tasks=(SAMPLE_TASK_ID,)))
    task = results["tasks"][SAMPLE_TASK_ID]
    assert task["on"]["n"] == task["off"]["n"] == 1
    assert task["on"]["median_ms"] > 0 and task["off"]["median_ms"] > 0
    # One pair: the difference is rounded from the raw times, the medians each
    # separately, so the two can disagree in the last digit (at most 0.0015).
    expected = task["on"]["median_ms"] - task["off"]["median_ms"]
    assert task["paired_difference_median_ms"] == pytest.approx(expected, abs=0.002)
    assert task["target_ms"] >= 2.0
    assert isinstance(task["within_target"], bool)


def test_nearest_rank_p95_is_an_observed_value():
    harness = load_harness()
    values = [float(v) for v in range(1, 21)]
    assert harness.p95(values) == 19.0
    assert harness.p95([5.0]) == 5.0
    assert harness.p95([]) is None
