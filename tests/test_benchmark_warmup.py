"""Warm-up trials and the measured sample (M7.3): one excluded warm-up per
arm and task, raised local caps, and the public demo still read-only."""

from __future__ import annotations

import sqlite3
from collections import defaultdict

import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.benchmarks.metrics import WARMUP_REASON, TrialMetrics, aggregate, as_warmup
from app.benchmarks.runner import (
    MAX_REPETITIONS,
    MAX_TRIALS,
    WARMUP_REPETITIONS,
    ExperimentRunner,
    warmup_repetitions,
)
from app.benchmarks.store import _EXPERIMENT_COLUMNS, _TRIAL_COLUMNS, BenchmarkStore
from app.benchmarks.views import experiment_summary
from app.providers import ProviderConfigError
from app.service import RunService
from app.store import RunStore
from tests.conftest import make_settings
from tests.test_benchmark_store import experiment_with_trials

SAMPLE = "sample_tag_normalization"
PIPELINE = "sample_parallel_pipeline"
PUBLIC = {"mode": "public_demo", "execution_sandbox": "restricted", "code_policy_enabled": True}


@pytest.fixture
def harness(tmp_path):
    made: list[RunStore] = []

    def build(**overrides):
        store = RunStore(tmp_path / "warmup.db")
        made.append(store)
        service = RunService(make_settings(tmp_path, **overrides), store)
        return ExperimentRunner(service, BenchmarkStore(store), slot_poll_seconds=0.05), store

    yield build
    for store in made:
        store.close()


def metrics(outcome: str, **fields) -> TrialMetrics:
    base = {
        "run_id": "run_x",
        "status": "completed",
        "provider": "demo",
        "provider_kind": "demo",
        "scripted": True,
        "model_policy": "fixed-fast",
    }
    return TrialMetrics(**{**base, "outcome": outcome, **fields})


# ----------------------------------------------------------------------
# the warm-up policy
# ----------------------------------------------------------------------
async def test_repetition_zero_is_a_warmup_for_every_arm_and_task_independently(harness):
    runner, _ = harness()
    experiment = runner.create("catalog", ["parallel", "sequential"], 1, origin="cli", order_seed=5)
    finished = await runner.run(experiment.experiment_id)
    assert finished.status == "completed"

    scheduled = runner.benchmarks.get_trials(experiment.experiment_id)
    assert warmup_repetitions(experiment, scheduled) == WARMUP_REPETITIONS == 1
    by_pair = defaultdict(list)
    for trial in scheduled:
        by_pair[(trial.task_id, trial.arm_id)].append(trial)
    assert set(by_pair) == {(t, a) for t in (SAMPLE, PIPELINE) for a in ("parallel", "sequential")}
    for pair, trials in by_pair.items():
        warmups = [t for t in trials if t.metrics.excluded_reason == WARMUP_REASON]
        measured = [t for t in trials if t.metrics.counted]
        # Exactly one warm-up per pair, and it is that pair's repetition 0.
        assert [t.repetition for t in warmups] == [0], pair
        assert [t.repetition for t in measured] == [1], pair
        assert warmups[0].run_id and warmups[0].status == "done"  # it ran in full

    # Every pair's aggregate counts its measured trial only.
    for task_id in (SAMPLE, PIPELINE):
        for arm_id in ("parallel", "sequential"):
            trials = by_pair[(task_id, arm_id)]
            summary = aggregate(arm_id, [t.metrics for t in trials])
            assert (summary.trials, summary.counted, summary.excluded, summary.warmups) == (2, 1, 0, 1)
            assert summary.excluded_reasons == {} and summary.non_warmup_trials == 1
            assert summary.latency_ms.n == 1


async def test_every_warmup_runs_before_any_measured_trial(harness):
    runner, _ = harness()
    experiment = runner.create("catalog", ["parallel", "sequential"], 3, origin="cli", order_seed=9)
    trials = runner.benchmarks.get_trials(experiment.experiment_id)
    assert len(trials) == 2 * 2 * 4
    first_measured = min(t.ordinal for t in trials if t.repetition >= 1)
    assert all(t.ordinal < first_measured for t in trials if t.repetition == 0)


@pytest.mark.parametrize(
    "original",
    [
        metrics("success", task_success=True, latency_ms=10),
        metrics("failure", task_success=False, latency_ms=12),
        metrics("excluded", status="cancelled", excluded_reason="cancelled"),
    ],
)
def test_a_warmup_is_excluded_whatever_its_outcome(original):
    warm = as_warmup(original)
    assert warm.outcome == "excluded" and not warm.counted
    assert warm.excluded_reason == WARMUP_REASON
    assert warm.latency_ms is None and warm.task_success is None
    assert (warm.run_id, warm.status, warm.provider) == (original.run_id, original.status, original.provider)
    note = warm.null_reasons["*"]
    assert note.startswith("excluded from the comparison: warm-up")
    if original.outcome == "excluded":
        assert note.endswith("(the run itself was excluded: cancelled)")


def test_exclusions_reduce_the_measured_n_and_are_never_replaced():
    trials = [
        as_warmup(metrics("success", task_success=True, latency_ms=1)),
        metrics("success", task_success=True, latency_ms=10),
        metrics("excluded", status="cancelled", excluded_reason="cancelled"),
        metrics("failure", task_success=False, latency_ms=30),
    ]
    summary = aggregate("parallel", trials)
    assert (summary.trials, summary.counted, summary.excluded, summary.warmups) == (4, 2, 1, 1)
    assert summary.excluded_reasons == {"cancelled": 1}
    assert summary.latency_ms.n == 2 and summary.latency_ms.min == 10  # the warm-up's 1 ms is not in it


async def test_a_trial_that_could_not_start_is_not_rerun(harness, monkeypatch):
    runner, store = harness()
    experiment = runner.create("catalog", ["parallel"], 2, origin="cli", task_ids=[SAMPLE])
    original, calls = runner.service.start, []

    def start(request):
        calls.append(request)
        if len(calls) == 2:  # the first measured trial
            raise ProviderConfigError("endpoint removed")
        return original(request)

    monkeypatch.setattr(runner.service, "start", start)
    await runner.run(experiment.experiment_id)
    trials = runner.benchmarks.get_trials(experiment.experiment_id)
    assert [t.status for t in trials] == ["done", "error", "done"]
    assert len(calls) == 3 and len(store.list_runs(10)) == 2


# ----------------------------------------------------------------------
# experiments created before M7.3, and no schema change
# ----------------------------------------------------------------------
async def test_an_experiment_scheduled_without_warmups_counts_every_trial(harness, tmp_path):
    runner, _ = harness()
    # Scheduled as before M7.3: repetitions 0..n-1, all of them measured.
    legacy, scheduled = experiment_with_trials(tmp_path, repetitions=1)
    runner.benchmarks.create_experiment(legacy, scheduled, exclusive=True)
    assert warmup_repetitions(legacy, scheduled) == 0

    finished = await runner.run(legacy.experiment_id)
    trials = runner.benchmarks.get_trials(legacy.experiment_id)
    assert {t.repetition for t in trials} == {0} and len(trials) == 4
    assert all(t.metrics.counted for t in trials)
    summary = experiment_summary(finished, trials, runner.settings)
    assert (summary.repetitions, summary.warmup_repetitions) == (1, 0)


def test_the_warmup_count_comes_from_the_schedule(harness):
    runner, _ = harness()
    experiment = runner.create("catalog", ["parallel"], 3, origin="cli")
    trials = runner.benchmarks.get_trials(experiment.experiment_id)
    assert experiment.repetitions == 3 and max(t.repetition for t in trials) == 3
    assert warmup_repetitions(experiment, trials) == 1
    assert warmup_repetitions(experiment, []) == 0


def test_the_benchmark_tables_are_unchanged(tmp_path):
    db = tmp_path / "schema.db"
    RunStore(db).close()
    with sqlite3.connect(db) as connection:
        experiments = [row[1] for row in connection.execute("PRAGMA table_info(benchmark_experiments)")]
        trials = [row[1] for row in connection.execute("PRAGMA table_info(benchmark_trials)")]
    assert tuple(experiments) == _EXPERIMENT_COLUMNS
    assert tuple(trials) == _TRIAL_COLUMNS


# ----------------------------------------------------------------------
# caps and the public demo
# ----------------------------------------------------------------------
@pytest.fixture
def api(tmp_path, monkeypatch):
    def open_client(**overrides) -> TestClient:
        settings = make_settings(tmp_path, db_path=tmp_path / "api.db", **overrides)
        monkeypatch.setattr(main_module, "settings", settings)
        return TestClient(main_module.app)

    return open_client


def test_the_local_api_accepts_a_full_sample_and_reports_the_warmup(api):
    body = {"suite_id": "catalog", "arm_ids": ["parallel"], "task_ids": [SAMPLE], "repetitions": MAX_REPETITIONS}
    with api() as client:
        too_many = client.post("/api/benchmarks/experiments", json={**body, "repetitions": MAX_REPETITIONS + 1})
        created = client.post("/api/benchmarks/experiments", json=body)
        experiment_id = created.json()["experiment"]["experiment_id"]
        client.post(f"/api/benchmarks/experiments/{experiment_id}/cancel")
    assert too_many.status_code == 422
    assert created.status_code == 202
    summary = created.json()["experiment"]
    assert (summary["repetitions"], summary["warmup_repetitions"], summary["trials_total"]) == (20, 1, 21)


@pytest.mark.parametrize("repetitions", [1, MAX_REPETITIONS])
def test_raised_caps_do_not_open_creation_in_the_public_demo(api, repetitions):
    body = {"suite_id": "catalog", "arm_ids": ["parallel"], "repetitions": repetitions}
    with api(**PUBLIC) as client:
        suites = client.get("/api/benchmarks/suites").json()
        created = client.post("/api/benchmarks/experiments", json=body)
        listed = client.get("/api/benchmarks/experiments").json()["experiments"]
    assert suites["can_create"] is False
    assert (suites["max_repetitions"], suites["max_trials"]) == (MAX_REPETITIONS, MAX_TRIALS)
    assert created.status_code == 403
    assert created.json() == {"detail": "creating benchmark experiments is not available in the public demo"}
    assert listed == []
