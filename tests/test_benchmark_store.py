from __future__ import annotations

import sqlite3

import pytest

from app.benchmarks.arms import get_arm
from app.benchmarks.metrics import TrialMetrics
from app.benchmarks.models import BenchmarkExperiment, BenchmarkTrial
from app.benchmarks.provenance import arm_configuration, collect_provenance
from app.benchmarks.store import BenchmarkStore, BenchmarkStoreError
from app.benchmarks.suites import catalog_suite
from app.models import RunRecord, TraceEvent
from app.store import RunStore
from tests.conftest import make_settings

ARMS = ["parallel", "sequential"]


@pytest.fixture
def store(tmp_path):
    runs = RunStore(tmp_path / "bench.db")
    yield runs
    runs.close()


def experiment_with_trials(tmp_path, created_at: str | None = None, repetitions: int = 1):
    settings = make_settings(tmp_path)
    suite = catalog_suite()
    configs = [arm_configuration(get_arm(a), t, settings) for a in ARMS for t in suite.tasks]
    fields = {"created_at": created_at} if created_at else {}
    experiment = BenchmarkExperiment(
        origin="cli",
        suite_id=suite.id,
        suite_version=suite.version,
        provider="demo",
        provider_kind="demo",
        scripted=True,
        repetitions=repetitions,
        order_seed=7,
        arm_ids=ARMS,
        configurations=configs,
        provenance=collect_provenance(settings),
        **fields,
    )
    fingerprints = {(c.arm_id, c.task_id): c.fingerprint for c in configs}
    trials = [
        BenchmarkTrial(
            experiment_id=experiment.experiment_id,
            ordinal=index,
            arm_id=arm,
            task_id=task.id,
            repetition=rep,
            fingerprint=fingerprints[(arm, task.id)],
        )
        for index, (rep, task, arm) in enumerate(
            (rep, task, arm) for rep in range(repetitions) for task in suite.tasks for arm in ARMS
        )
    ]
    return experiment, trials


def tables(path) -> set[str]:
    with sqlite3.connect(path) as conn:
        return {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}


# ----------------------------------------------------------------------
# schema and migration
# ----------------------------------------------------------------------
def test_a_new_database_has_the_benchmark_tables(tmp_path, store):
    assert {"benchmark_experiments", "benchmark_trials", "runs", "trace_events"} <= tables(tmp_path / "bench.db")


def test_an_existing_database_gains_the_tables_and_keeps_its_runs(tmp_path):
    path = tmp_path / "old.db"
    first = RunStore(path)
    record = RunRecord(goal="a run from before M6", status="completed")
    first.save_run(record)
    first.append_event(TraceEvent(run_id=record.run_id, seq=1, kind="warning", message="kept"))
    first.close()
    # Make it a pre-M6 database: no benchmark tables.
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TABLE benchmark_trials")
        conn.execute("DROP TABLE benchmark_experiments")
    assert "benchmark_experiments" not in tables(path)

    reopened = RunStore(path)
    try:
        assert {"benchmark_experiments", "benchmark_trials"} <= tables(path)
        assert reopened.get_run(record.run_id) == record
        assert [e.message for e in reopened.get_events(record.run_id)] == ["kept"]
    finally:
        reopened.close()


def test_opening_twice_changes_nothing(tmp_path):
    path = tmp_path / "twice.db"
    RunStore(path).close()
    with sqlite3.connect(path) as conn:
        before = conn.execute("SELECT sql FROM sqlite_master ORDER BY name").fetchall()
    RunStore(path).close()
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT sql FROM sqlite_master ORDER BY name").fetchall() == before


# ----------------------------------------------------------------------
# experiments and trials
# ----------------------------------------------------------------------
def test_an_experiment_round_trips_with_its_trials(tmp_path, store):
    benchmarks = BenchmarkStore(store)
    experiment, trials = experiment_with_trials(tmp_path)
    benchmarks.create_experiment(experiment, trials)

    assert benchmarks.get_experiment(experiment.experiment_id) == experiment
    stored = benchmarks.get_trials(experiment.experiment_id)
    assert stored == trials
    assert [t.ordinal for t in stored] == list(range(len(trials)))
    assert benchmarks.get_experiment("bex_missing") is None


def test_creation_is_atomic(tmp_path, store):
    benchmarks = BenchmarkStore(store)
    experiment, trials = experiment_with_trials(tmp_path)
    duplicate = trials[0].model_copy(update={"trial_id": "btr_duplicate", "ordinal": 99})
    with pytest.raises(sqlite3.IntegrityError):
        benchmarks.create_experiment(experiment, [*trials, duplicate])
    assert benchmarks.get_experiment(experiment.experiment_id) is None
    assert benchmarks.get_trials(experiment.experiment_id) == []


def test_inconsistent_trials_are_refused(tmp_path, store):
    benchmarks = BenchmarkStore(store)
    experiment, trials = experiment_with_trials(tmp_path)
    with pytest.raises(BenchmarkStoreError, match="at least one trial"):
        benchmarks.create_experiment(experiment, [])
    with pytest.raises(BenchmarkStoreError, match="another experiment"):
        benchmarks.create_experiment(experiment, [trials[0].model_copy(update={"experiment_id": "bex_other"})])
    with pytest.raises(BenchmarkStoreError, match="does not compare"):
        benchmarks.create_experiment(experiment, [trials[0].model_copy(update={"arm_id": "adaptive"})])


def test_a_trial_links_its_run_and_keeps_a_metrics_snapshot(tmp_path, store):
    benchmarks = BenchmarkStore(store)
    experiment, trials = experiment_with_trials(tmp_path)
    benchmarks.create_experiment(experiment, trials)

    trial = trials[0]
    # A trial can only point at a run that exists.
    with pytest.raises(sqlite3.IntegrityError):
        benchmarks.save_trial(trial.model_copy(update={"run_id": "run_missing"}))

    record = RunRecord(goal="the trial's run", status="completed", provider_kind="demo")
    store.save_run(record)
    metrics = TrialMetrics(
        run_id=record.run_id, status="completed", outcome="success", task_success=True,
        verification_passed=True, provider="demo", provider_kind="demo", scripted=True,
        model_policy="config", latency_ms=1234, null_reasons={"tokens": "scripted provider: no usage is reported"},
    )
    done = trial.model_copy(update={"status": "done", "run_id": record.run_id, "metrics": metrics})
    benchmarks.save_trial(done)

    assert benchmarks.get_trials(experiment.experiment_id)[0] == done
    assert benchmarks.trial_for_run(record.run_id) == done
    assert benchmarks.trial_for_run("run_other") is None
    with sqlite3.connect(tmp_path / "bench.db") as conn:
        assert conn.execute(
            "SELECT metrics_version FROM benchmark_trials WHERE trial_id = ?", (trial.trial_id,)
        ).fetchone() == (metrics.metrics_version,)


def test_saving_an_unknown_row_is_an_error(tmp_path, store):
    benchmarks = BenchmarkStore(store)
    experiment, trials = experiment_with_trials(tmp_path)
    with pytest.raises(BenchmarkStoreError):
        benchmarks.save_trial(trials[0])
    with pytest.raises(BenchmarkStoreError):
        benchmarks.save_experiment(experiment)


def test_status_changes_are_saved_with_a_new_updated_at(tmp_path, store):
    benchmarks = BenchmarkStore(store)
    experiment, trials = experiment_with_trials(tmp_path, created_at="2026-01-01T00:00:00+00:00")
    experiment = experiment.model_copy(update={"updated_at": "2026-01-01T00:00:00+00:00"})
    benchmarks.create_experiment(experiment, trials)
    saved = benchmarks.save_experiment(experiment.model_copy(update={"status": "running", "started_at": "now"}))
    assert saved.updated_at != experiment.updated_at
    assert benchmarks.get_experiment(experiment.experiment_id) == saved
    assert [e.experiment_id for e in benchmarks.active_experiments()] == [experiment.experiment_id]
    benchmarks.save_experiment(saved.model_copy(update={"status": "completed"}))
    assert benchmarks.active_experiments() == []


def test_deleting_an_experiment_deletes_its_trials_not_its_runs(tmp_path, store):
    benchmarks = BenchmarkStore(store)
    experiment, trials = experiment_with_trials(tmp_path)
    benchmarks.create_experiment(experiment, trials)
    record = RunRecord(goal="the trial's run", status="completed")
    store.save_run(record)
    benchmarks.save_trial(trials[0].model_copy(update={"run_id": record.run_id}))
    with store.transaction() as conn:
        conn.execute("DELETE FROM benchmark_experiments WHERE experiment_id = ?", (experiment.experiment_id,))
    assert benchmarks.get_trials(experiment.experiment_id) == []
    assert store.get_run(record.run_id) == record


def test_experiments_page_newest_first(tmp_path, store):
    benchmarks = BenchmarkStore(store)
    created = []
    for day in (1, 2, 3):
        experiment, trials = experiment_with_trials(tmp_path, created_at=f"2026-01-0{day}T00:00:00+00:00")
        benchmarks.create_experiment(experiment, trials)
        created.append(experiment.experiment_id)

    first, cursor = benchmarks.list_experiments_page(limit=2)
    assert [e.experiment_id for e in first] == [created[2], created[1]]
    rest, end = benchmarks.list_experiments_page(limit=2, before=cursor)
    assert [e.experiment_id for e in rest] == [created[0]]
    assert end is None
    with pytest.raises(KeyError):
        benchmarks.list_experiments_page(before="bex_unknown")


def test_a_failed_transaction_leaves_the_store_usable(tmp_path, store):
    with pytest.raises(RuntimeError):
        with store.transaction() as conn:
            conn.execute(
                "INSERT INTO runs (run_id, created_at, updated_at, goal, provider, status, limits_json) "
                "VALUES ('run_rolled_back', 'x', 'x', 'g', 'demo', 'queued', '{}')"
            )
            raise RuntimeError("abort")
    assert store.get_run("run_rolled_back") is None
    record = RunRecord(goal="after a rollback", status="queued")
    store.save_run(record)
    assert store.get_run(record.run_id) == record
