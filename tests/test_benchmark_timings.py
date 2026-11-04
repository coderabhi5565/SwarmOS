"""Trial timings (metrics v2, M7.3): a counted trial's run timings come from
its persisted span measurements; anything not established is null with a
reason, never zero. Times are hand-checkable ms on a zero-based clock."""

from __future__ import annotations

import asyncio

import pytest

from app.api_models import BenchmarkTrialTimings
from app.benchmarks.metrics import (
    METRICS_VERSION,
    TIMING_METRICS,
    WARMUP_REASON,
    TrialTimings,
    trial_timings,
)
from app.benchmarks.runner import ExperimentRunner
from app.benchmarks.store import BenchmarkStore
from app.service import RunService
from app.store import RunStore
from app.timings.recorder import SNAPSHOT_VERSION, SpanRecorder
from tests.conftest import make_settings

SAMPLE = "sample_tag_normalization"
PIPELINE = "sample_parallel_pipeline"
MS = 1_000_000


def wave() -> dict:
    """lifecycle 0-1000; graph 0-900 (parallel); dispatch at 100; steps A
    120-520 and B 130-830, calls A 150-450 and B 160-800 (overlapping), one
    HTTP attempt each; verification process 850-880."""
    r = SpanRecorder(clock=lambda: 0, zero=0)
    life = r.add("lifecycle", 0, 1000 * MS, parent=None)
    graph = r.add("graph", 0, 900 * MS, parent=life, parallel_coding=True)
    dispatch = r.add("dispatch", 100 * MS, 100 * MS, parent=graph)
    a = r.add("node", 120 * MS, 520 * MS, parent=graph, node="code_step", step_id="a", dispatch_id=dispatch)
    b = r.add("node", 130 * MS, 830 * MS, parent=graph, node="code_step", step_id="b", dispatch_id=dispatch)
    call_a = r.add("call", 150 * MS, 450 * MS, parent=a, role="coder", step_id="a", attempt=1)
    call_b = r.add("call", 160 * MS, 800 * MS, parent=b, role="coder", step_id="b", attempt=1)
    r.add("call.http_attempt", 151 * MS, 449 * MS, parent=call_a, outcome="ok")
    r.add("call.http_attempt", 161 * MS, 799 * MS, parent=call_b, outcome="ok")
    verify = r.add("node", 840 * MS, 890 * MS, parent=graph, node="verify")
    run = r.add("verify.run", 845 * MS, 885 * MS, parent=verify, diagnostic=False)
    r.add("verify.process", 850 * MS, 880 * MS, parent=run)
    return r.snapshot()


# ----------------------------------------------------------------------
# from a snapshot
# ----------------------------------------------------------------------
def test_overlapping_spans_give_busy_wall_and_critical_path_by_hand():
    timings = trial_timings("recorded", wave(), SNAPSHOT_VERSION, 12.5)
    assert timings.measurement_status == "recorded"
    assert timings.lifecycle_ms == 1000 and timings.graph_ms == 900
    assert timings.coder_busy_ms == 400 + 700  # sum: overlaps counted
    assert timings.coder_wall_ms == 830 - 120  # union
    assert timings.coder_critical_path_ms == 830 - 100  # dispatch to last step end
    assert timings.provider_calls == 2
    assert timings.provider_call_busy_ms == 300 + 640
    assert timings.provider_call_wall_ms == 800 - 150
    assert timings.http_attempts == 2
    assert timings.http_attempt_busy_ms == 298 + 638
    assert timings.http_attempt_wall_ms == 799 - 151
    assert timings.verification_ms == 30
    assert timings.trial_slot_wait_ms == 12.5
    # Never zero for what was not measured: no planner ran, no diagnostic run.
    assert timings.planner_ms is None and timings.null_reasons["planner_ms"] == "no planner node ran"
    assert timings.diagnostic_verification_ms is None
    assert timings.null_reasons["diagnostic_verification_ms"] == "no diagnostic verification ran"
    assert timings.slot_wait_total_ms is None
    assert timings.null_reasons["slot_wait_total_ms"] == "parallel coding: no coding slot"
    # Every null field has a reason, and no field has a reason it does not need.
    fields = timings.model_dump(exclude={"measurement_status", "measurements_version", "null_reasons"})
    assert {name for name, value in fields.items() if value is None} == set(timings.null_reasons)


@pytest.mark.parametrize(
    "status",
    [
        "predates_measurements",
        "process_crash",
        "measurement_flush_failed",
        "instrumentation_disabled",
        "not_recorded",
        "unreadable",
    ],
)
def test_a_run_without_measurements_leaves_every_run_metric_null(status):
    timings = trial_timings(status, None, None, 3.0)
    assert timings.measurement_status == status
    assert timings.null_reasons == {"*": f"no run measurements: {status}"}
    assert all(getattr(timings, name) is None for name in TIMING_METRICS)
    assert timings.trial_slot_wait_ms == 3.0  # measured by the runner, not the run


def test_an_unsupported_snapshot_version_is_not_derived():
    timings = trial_timings("recorded", wave(), SNAPSHOT_VERSION + 1, 1.0)
    assert timings.measurement_status == "unsupported_version"
    assert timings.lifecycle_ms is None
    assert timings.null_reasons["*"] == "no run measurements: unsupported_version"


def test_a_trial_finished_by_recovery_has_no_slot_wait():
    timings = trial_timings("recorded", wave(), SNAPSHOT_VERSION, None)
    assert timings.trial_slot_wait_ms is None
    assert timings.null_reasons["trial_slot_wait_ms"] == "not measured: the trial was finished by recovery"


def test_the_api_model_tracks_the_domain_model():
    assert set(BenchmarkTrialTimings.model_fields) == set(TrialTimings.model_fields)


# ----------------------------------------------------------------------
# on real experiments
# ----------------------------------------------------------------------
@pytest.fixture
def harness(tmp_path):
    made: list[RunStore] = []

    def build(**overrides):
        store = RunStore(tmp_path / "timings.db")
        made.append(store)
        service = RunService(make_settings(tmp_path, **overrides), store)
        return ExperimentRunner(service, BenchmarkStore(store), slot_poll_seconds=0.05), store

    yield build
    for store in made:
        store.close()


async def test_counted_trials_carry_recorded_timings_and_warmups_none(harness):
    runner, store = harness()
    experiment = runner.create("catalog", ["parallel", "sequential"], 1, origin="cli", task_ids=[PIPELINE])
    await runner.run(experiment.experiment_id)
    for trial in runner.benchmarks.get_trials(experiment.experiment_id):
        metrics = trial.metrics
        assert metrics.metrics_version == METRICS_VERSION == 2
        if trial.repetition == 0:
            assert metrics.excluded_reason == WARMUP_REASON and metrics.timings is None
            continue
        timings = metrics.timings
        assert timings.measurement_status == "recorded"
        assert timings.lifecycle_ms > 0 and timings.execution_ms > 0
        assert timings.coder_busy_ms >= timings.coder_wall_ms > 0  # busy counts overlaps
        assert timings.provider_calls >= 1 and timings.http_attempts == 0  # scripted provider
        assert timings.verification_ms is not None
        assert timings.trial_slot_wait_ms is not None and timings.trial_slot_wait_ms >= 0
        assert timings.null_reasons.get("*") is None
        if trial.arm_id == "sequential":
            assert timings.slot_wait_total_ms is not None
        else:
            assert timings.null_reasons["slot_wait_total_ms"] == "parallel coding: no coding slot"
    assert store.list_runs(10)  # the runs exist and are linked


async def test_disabled_instrumentation_is_a_status_not_zeros(harness):
    runner, _ = harness(timings_enabled=False)
    experiment = runner.create("catalog", ["parallel"], 1, origin="cli", task_ids=[SAMPLE])
    await runner.run(experiment.experiment_id)
    measured = runner.benchmarks.get_trials(experiment.experiment_id)[1]
    assert measured.metrics.counted
    timings = measured.metrics.timings
    assert timings.measurement_status == "instrumentation_disabled"
    assert all(getattr(timings, name) is None for name in TIMING_METRICS)
    assert timings.null_reasons["*"] == "no run measurements: instrumentation_disabled"
    assert timings.trial_slot_wait_ms is not None  # the runner still measured its own wait


async def test_an_excluded_trial_has_no_timings(harness, monkeypatch):
    import app.service as service_module
    from app.providers.demo import DemoProvider

    class Slow(DemoProvider):
        async def complete(self, request):
            await asyncio.sleep(0.3)
            return await super().complete(request)

    original = service_module.resolve_provider

    def resolve(name, settings):
        provider, provider_name, warning = original(name, settings)
        return (Slow() if provider_name == "demo" else provider), provider_name, warning

    monkeypatch.setattr(service_module, "resolve_provider", resolve)
    runner, _ = harness()
    experiment = runner.create("catalog", ["parallel"], 2, origin="cli", task_ids=[SAMPLE])
    task = asyncio.create_task(runner.run(experiment.experiment_id))
    for _ in range(1500):
        if any(t.run_id and t.repetition >= 1 for t in runner.benchmarks.get_trials(experiment.experiment_id)):
            break
        await asyncio.sleep(0.02)
    runner.cancel(experiment.experiment_id)
    await asyncio.wait_for(task, 30)
    cancelled = runner.benchmarks.get_trials(experiment.experiment_id)[1]
    assert cancelled.metrics.outcome == "excluded" and cancelled.metrics.excluded_reason == "cancelled"
    assert cancelled.metrics.timings is None
