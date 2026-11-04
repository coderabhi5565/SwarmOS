"""Benchmark aggregates v2 (M7.3), against hand-calculated datasets.

Conventions under test:

* P95 is nearest-rank: sort the n values, take the ceil(0.95 * n)-th
  (1-based). It is always an observed value; for n < 20 it is the maximum.
* The median is ``statistics.median``: the middle value, or the mean of the
  two middle values for even n.
* Measured n counts success and failure trials only. Warm-ups are counted
  apart; excluded trials (cancelled, interrupted, orchestration error) are
  counted by reason; neither ever enters a rate's numerator or a
  distribution, and nothing is rerun.
* Cancellation and interrupted rates are over every non-warm-up trial.
* Timing distributions use only counted trials with recorded measurements;
  every other counted trial is counted as unavailable by status.
"""

from __future__ import annotations

import pytest

from app.benchmarks.metrics import (
    CANCELLED_REASON,
    INTERRUPTED_REASON,
    MEASURED_SAMPLE,
    TIMING_FIELDS,
    WARMUP_REASON,
    TrialMetrics,
    TrialTimings,
    aggregate,
    percentile,
    timing_summary,
)
from app.benchmarks.suites import catalog_suite
from app.benchmarks.views import experiment_detail
from tests.conftest import make_settings
from tests.test_benchmark_store import experiment_with_trials


def trial(outcome: str, *, reason: str | None = None, success: bool | None = None, verified: bool | None = None, timings=None, version: int = 2) -> TrialMetrics:
    return TrialMetrics(
        metrics_version=version,
        run_id="run_x",
        status="completed" if outcome == "success" else "failed",
        outcome=outcome,
        excluded_reason=reason,
        task_success=success,
        verification_passed=verified,
        provider="demo",
        provider_kind="demo",
        scripted=True,
        model_policy="fixed-fast",
        timings=timings,
    )


def recorded(**values) -> TrialTimings:
    """Recorded timings with the given values; every other field is null
    with the reason "not established"."""
    reasons = {name: "not established" for name in TIMING_FIELDS if values.get(name) is None}
    reasons.update(values.pop("reasons", {}))
    return TrialTimings(measurement_status="recorded", measurements_version=1, null_reasons=reasons, **values)


def counted(lifecycle: float | None = None, **fields) -> TrialMetrics:
    timings = fields.pop("timings", None) or recorded(lifecycle_ms=lifecycle)
    return trial("success", success=True, verified=True, timings=timings, **fields)


# ----------------------------------------------------------------------
# percentile and summaries
# ----------------------------------------------------------------------
@pytest.mark.parametrize(
    ("values", "expected"),
    [
        ([7.0], 7.0),  # n=1: rank ceil(0.95) = 1
        ([1.0, 2.0], 2.0),  # n=2: rank ceil(1.9) = 2, the maximum
        ([float(v) for v in range(1, 20)], 19.0),  # n=19: rank ceil(18.05) = 19, the maximum
        ([float(v) for v in range(1, 21)], 19.0),  # n=20: rank 19, below the maximum
        ([float(v) for v in range(1, 22)], 20.0),  # n=21: rank ceil(19.95) = 20
        ([3.0, 1.0, 2.0], 3.0),  # unsorted input
        ([5.0] * 20, 5.0),  # all tied
        ([1.0] * 18 + [9.0, 9.0], 9.0),  # n=20, rank 19 falls in the tied top pair
        ([1.0] * 19 + [9.0], 1.0),  # n=20, rank 19 is below the single outlier
    ],
)
def test_p95_is_nearest_rank(values, expected):
    assert percentile(values, 95) == expected


def test_a_summary_counts_missing_values_with_their_reasons():
    summary = timing_summary([10.0, None, 30.0, None, 20.0, 40.0], ["no planner node ran", "spans dropped"])
    assert (summary.n, summary.missing) == (4, 2)
    assert summary.missing_reasons == {"no planner node ran": 1, "spans dropped": 1}
    assert summary.median == 25.0  # (20 + 30) / 2
    assert summary.p95 == 40.0  # rank ceil(3.8) = 4 of 4
    assert (summary.min, summary.max) == (10.0, 40.0)


def test_a_summary_of_only_missing_values_is_null_not_zero():
    summary = timing_summary([None, None], ["incomplete", "incomplete"])
    assert (summary.n, summary.missing, summary.missing_reasons) == (0, 2, {"incomplete": 2})
    assert summary.median is None and summary.p95 is None and summary.min is None and summary.max is None


# ----------------------------------------------------------------------
# a mixed dataset, by hand
# ----------------------------------------------------------------------
def mixed() -> list[TrialMetrics]:
    """10 trials: 1 warm-up; 5 counted (3 recorded, 1 flush failed, 1 from
    metrics v1); cancelled, interrupted and orchestration-error exclusions;
    1 still running."""
    return [
        trial("excluded", reason=WARMUP_REASON),
        counted(timings=recorded(lifecycle_ms=100.0, planner_ms=10.0, coder_busy_ms=90.0, coder_wall_ms=60.0)),
        counted(timings=recorded(lifecycle_ms=300.0, coder_busy_ms=250.0, coder_wall_ms=150.0, reasons={"planner_ms": "no planner node ran"})),
        trial(
            "failure",
            success=False,
            verified=False,
            timings=recorded(lifecycle_ms=200.0, planner_ms=30.0, coder_busy_ms=120.0, coder_wall_ms=120.0),
        ),
        trial(
            "failure",
            success=False,
            verified=True,  # verification passed, the task still failed: two facts
            timings=TrialTimings(measurement_status="measurement_flush_failed", null_reasons={"*": "x"}),
        ),
        trial("success", success=True, verified=False, version=1),
        trial("excluded", reason=CANCELLED_REASON),
        trial("excluded", reason=INTERRUPTED_REASON),
        trial("excluded", reason="orchestration error (run_crashed)"),
        trial("incomplete"),
    ]


def test_counts_and_denominators_by_hand():
    summary = aggregate("parallel", mixed())
    assert summary.trials == 10
    assert summary.warmups == 1
    assert summary.counted == 5  # measured n: 3 successes, 2 failures
    assert summary.excluded == 3 and summary.incomplete == 1
    assert summary.excluded_reasons == {
        CANCELLED_REASON: 1,
        INTERRUPTED_REASON: 1,
        "orchestration error (run_crashed)": 1,
    }
    # Every non-warm-up trial: 10 - 1 = 9.
    assert summary.non_warmup_trials == 9
    assert (summary.cancelled, summary.cancellation_rate) == (1, round(1 / 9, 4))
    assert (summary.interrupted, summary.interrupted_rate) == (1, round(1 / 9, 4))
    # Rates over counted trials only, and kept apart.
    assert summary.task_success_rate == 0.6  # 3 of 5
    assert summary.verification_pass_rate == 0.6  # 3 of 5, not the same trials
    assert summary.task_successes == summary.verification_passes == 3


def test_timing_distributions_never_mix_statuses():
    timings = aggregate("parallel", mixed()).timings
    # Only the three recorded trials are measured; the other two counted
    # trials are counted as unavailable, by status.
    assert timings.measured == 3
    assert timings.unavailable == {"measurement_flush_failed": 1, "metrics_v1": 1}
    lifecycle = timings.metrics["lifecycle_ms"]
    assert (lifecycle.n, lifecycle.missing) == (3, 0)
    assert lifecycle.median == 200.0
    assert lifecycle.p95 == 300.0  # rank ceil(2.85) = 3
    assert (lifecycle.min, lifecycle.max) == (100.0, 300.0)
    planner = timings.metrics["planner_ms"]
    assert (planner.n, planner.missing, planner.missing_reasons) == (2, 1, {"no planner node ran": 1})
    assert planner.median == 20.0 and planner.p95 == 30.0
    # Busy and wall are reported apart: overlapping work is never relabelled.
    assert timings.metrics["coder_busy_ms"].median == 120.0
    assert timings.metrics["coder_wall_ms"].median == 120.0
    assert timings.metrics["coder_busy_ms"].max == 250.0 and timings.metrics["coder_wall_ms"].max == 150.0
    # Every field is summarised, and n + missing is always the measured count.
    assert set(timings.metrics) == set(TIMING_FIELDS)
    assert all(item.n + item.missing == 3 for item in timings.metrics.values())


def test_excluded_and_warmup_values_never_enter_a_distribution():
    trials = [
        counted(5.0),
        trial("excluded", reason=WARMUP_REASON, timings=recorded(lifecycle_ms=9999.0)),
        trial("excluded", reason=CANCELLED_REASON, timings=recorded(lifecycle_ms=8888.0)),
    ]
    summary = aggregate("parallel", trials)
    assert summary.counted == 1 and summary.timings.measured == 1
    assert summary.timings.metrics["lifecycle_ms"].max == 5.0


# ----------------------------------------------------------------------
# the measured sample
# ----------------------------------------------------------------------
def test_exactly_twenty_eligible_trials_complete_the_sample():
    trials = [trial("excluded", reason=WARMUP_REASON)] + [counted(float(i)) for i in range(1, 21)]
    summary = aggregate("parallel", trials)
    assert (summary.counted, summary.warmups, summary.sample_required) == (20, 1, MEASURED_SAMPLE)
    assert summary.sample_complete is True
    assert summary.timings.metrics["lifecycle_ms"].p95 == 19.0  # rank 19 of 1..20
    assert not any("Sample incomplete" in note for note in summary.notes)
    assert not any("Timing P95s are from" in note for note in summary.notes)


def test_exclusions_leave_fewer_than_twenty_and_report_the_actual_n():
    # 21 measured repetitions scheduled, two excluded: n is 19, not topped up.
    trials = (
        [trial("excluded", reason=WARMUP_REASON)]
        + [counted(float(i)) for i in range(1, 20)]
        + [trial("excluded", reason=CANCELLED_REASON), trial("excluded", reason=INTERRUPTED_REASON)]
    )
    summary = aggregate("parallel", trials)
    assert summary.counted == 19 and summary.sample_complete is False
    assert summary.timings.metrics["lifecycle_ms"].n == 19
    assert summary.timings.metrics["lifecycle_ms"].p95 == 19.0  # n=19: the maximum
    assert "Sample incomplete: 19 measured trials; 20 per arm and task are required." in " ".join(summary.notes)
    assert any("Timing P95s are from 19 measured runs" in note for note in summary.notes)


def test_several_infrastructure_failures_by_hand():
    trials = (
        [trial("excluded", reason=WARMUP_REASON)]
        + [counted(1.0)] * 18
        + [trial("excluded", reason=CANCELLED_REASON)] * 3
        + [trial("excluded", reason=INTERRUPTED_REASON)] * 2
        + [trial("excluded", reason="orchestration error (graph_error)")] * 2
    )
    summary = aggregate("parallel", trials)
    assert summary.non_warmup_trials == 25
    assert (summary.cancelled, summary.cancellation_rate) == (3, 0.12)
    assert (summary.interrupted, summary.interrupted_rate) == (2, 0.08)
    assert summary.excluded == 7 and summary.counted == 18 and summary.sample_complete is False
    assert summary.excluded_reasons["orchestration error (graph_error)"] == 2


def test_nothing_measured_is_null_not_zero():
    summary = aggregate("parallel", [trial("excluded", reason=WARMUP_REASON)])
    assert summary.non_warmup_trials == 0
    assert summary.cancellation_rate is None and summary.interrupted_rate is None
    assert summary.timings.measured == 0
    assert summary.timings.metrics["lifecycle_ms"].median is None


# ----------------------------------------------------------------------
# arm and arm/task levels in the experiment detail
# ----------------------------------------------------------------------
def test_an_arm_is_complete_only_when_every_task_is(tmp_path):
    experiment, trials = experiment_with_trials(tmp_path, repetitions=21)
    sample, pipeline = (task.id for task in catalog_suite().tasks)
    finished = []
    for item in trials:
        if item.repetition == 0:
            metrics = trial("excluded", reason=WARMUP_REASON)
        elif item.arm_id == "parallel" and item.task_id == pipeline and item.repetition == 1:
            metrics = trial("excluded", reason=CANCELLED_REASON)  # parallel/pipeline drops to 19
        else:
            metrics = counted(float(item.repetition))
        finished.append(item.model_copy(update={"status": "done", "metrics": metrics}))

    detail = experiment_detail(experiment, finished, make_settings(tmp_path))
    by_task = {(a.arm_id, a.task_id): a for a in detail.task_aggregates}
    assert by_task[("parallel", sample)].sample_complete is True
    assert by_task[("parallel", pipeline)].counted == 19
    assert by_task[("parallel", pipeline)].sample_complete is False
    assert by_task[("sequential", pipeline)].sample_complete is True
    arms = {a.arm_id: a for a in detail.aggregates}
    assert arms["parallel"].sample_complete is False  # one task short
    assert arms["sequential"].sample_complete is True
    assert (arms["parallel"].warmups, arms["parallel"].counted, arms["parallel"].excluded) == (2, 39, 1)
    assert arms["parallel"].timings.metrics["lifecycle_ms"].n == 39
    # Sequential: repetitions 1..20 on each task, 40 values; the middle two
    # are 10 and 11, so the median is 10.5.
    assert arms["sequential"].timings.metrics["lifecycle_ms"].median == 10.5
    assert any("statistically significant" in note for note in detail.notes)
