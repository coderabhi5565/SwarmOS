"""The benchmark experiment runner, on the real RunService and demo provider."""

from __future__ import annotations

import asyncio
from collections import Counter
from dataclasses import replace

import pytest

import app.service as service_module
from app.benchmarks.metrics import WARMUP_REASON
from app.benchmarks.runner import (
    MAX_REPETITIONS,
    MAX_TRIALS,
    WARMUP_REPETITIONS,
    ExperimentError,
    ExperimentRunner,
    plan_schedule,
    warmup_repetitions,
)
from app.benchmarks.store import BenchmarkStore, ExperimentBusyError
from app.benchmarks.suites import get_suite
from app.models import RunRecord
from app.providers import ProviderConfigError
from app.providers.demo import DemoProvider
from app.service import RunService
from app.store import RunStore
from tests.conftest import make_settings

SAMPLE = "sample_tag_normalization"
PIPELINE = "sample_parallel_pipeline"
PUBLIC = {"mode": "public_demo", "execution_sandbox": "restricted", "code_policy_enabled": True}


@pytest.fixture
def harness(tmp_path):
    """A store, service and runner on a fresh database; closed afterwards."""
    made: list[RunStore] = []

    def build(**overrides):
        store = RunStore(tmp_path / "runner.db")
        made.append(store)
        service = RunService(make_settings(tmp_path, **overrides), store)
        runner = ExperimentRunner(service, BenchmarkStore(store), slot_poll_seconds=0.05)
        return runner, service, store

    yield build
    for store in made:
        store.close()


@pytest.fixture
def slow_demo(monkeypatch):
    """The demo fixture with a delay per model call (still named "demo")."""

    def install(delay: float):
        class Slow(DemoProvider):
            async def complete(self, request):
                await asyncio.sleep(delay)
                return await super().complete(request)

        original = service_module.resolve_provider

        def resolve(name, settings):
            provider, provider_name, warning = original(name, settings)
            return (Slow() if provider_name == "demo" else provider), provider_name, warning

        monkeypatch.setattr(service_module, "resolve_provider", resolve)

    return install


async def wait_until(predicate, within: float = 20.0) -> None:
    """Poll a condition on the database (no event to wait on), up to ``within`` seconds."""
    for _ in range(int(within / 0.02)):
        if predicate():
            return
        await asyncio.sleep(0.02)
    raise TimeoutError("condition not reached")


# ----------------------------------------------------------------------
# schedule
# ----------------------------------------------------------------------
def test_the_schedule_is_deterministic_and_complete():
    order = plan_schedule(["a", "b"], ["x", "y", "z"], 2, seed=7)
    assert order == plan_schedule(["a", "b"], ["x", "y", "z"], 2, seed=7)
    assert len(order) == 12
    assert sorted(order) == sorted((r, t, a) for r in range(2) for t in "ab" for a in "xyz")
    assert {plan_schedule(["a"], ["x", "y", "z"], 1, seed=s)[0][2] for s in range(20)} == {"x", "y", "z"}


def test_the_schedule_interleaves_arms_fairly():
    arms = ["x", "y", "z"]
    order = plan_schedule(["a", "b", "c"], arms, 2, seed=3)
    blocks = [order[i : i + 3] for i in range(0, len(order), 3)]
    # Each (repetition, task) block runs every arm back to back...
    assert all(sorted(arm for _, _, arm in block) == arms for block in blocks)
    # ...and every arm takes every position equally often.
    for position in range(3):
        assert Counter(block[position][2] for block in blocks) == {"x": 2, "y": 2, "z": 2}


# ----------------------------------------------------------------------
# create
# ----------------------------------------------------------------------
def test_create_persists_every_trial_in_schedule_order_before_running(harness):
    runner, _, _ = harness()
    experiment = runner.create("catalog", ["parallel", "sequential"], 2, origin="cli", order_seed=11)
    assert experiment.status == "queued"
    assert experiment.scripted is True and experiment.provider == "demo"
    trials = runner.benchmarks.get_trials(experiment.experiment_id)
    assert (experiment.repetitions, warmup_repetitions(experiment, trials)) == (2, WARMUP_REPETITIONS)
    # Two measured repetitions plus the warm-up, scheduled as one block each.
    expected = plan_schedule([SAMPLE, PIPELINE], ["parallel", "sequential"], 3, 11)
    assert {t.repetition for t in trials[:4]} == {0}  # every warm-up runs first
    assert [(t.repetition, t.task_id, t.arm_id) for t in trials] == expected
    assert all(t.status == "pending" and t.run_id is None for t in trials)
    fingerprints = {(c.arm_id, c.task_id): c.fingerprint for c in experiment.configurations}
    assert all(t.fingerprint == fingerprints[(t.arm_id, t.task_id)] for t in trials)


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"suite_id": "nope", "arm_ids": ["parallel"]}, "unknown benchmark suite"),
        ({"arm_ids": []}, "at least one arm"),
        ({"arm_ids": ["parallel", "parallel"]}, "once"),
        ({"arm_ids": ["turbo"]}, "unknown benchmark arm"),
        ({"arm_ids": ["parallel"], "repetitions": 0}, "repetitions"),
        ({"arm_ids": ["parallel"], "repetitions": MAX_REPETITIONS + 1}, "repetitions"),
        ({"arm_ids": ["parallel"], "task_ids": ["missing"]}, "no task"),
        ({"suite_id": "local-fixtures", "arm_ids": ["adaptive"]}, "needs a real model"),
        ({"arm_ids": ["parallel"], "provider": "openai"}, "OPENAI_COMPAT_BASE_URL"),
    ],
)
def test_create_validates_the_request(harness, kwargs, message):
    runner, _, _ = harness()
    args = {"suite_id": "catalog", "repetitions": 1, **kwargs}
    with pytest.raises(ExperimentError, match=message):
        runner.create(args.pop("suite_id"), args.pop("arm_ids"), args.pop("repetitions"), origin="cli", **args)
    assert runner.benchmarks.list_experiments_page()[0] == []


ALL_ARMS = ["parallel", "sequential", "fixed-fast", "adaptive", "multi-agent"]


def test_the_trial_cap_fits_the_largest_suite_at_full_sample():
    largest = max(len(get_suite(suite).tasks) for suite in ("catalog", "local-fixtures"))
    assert largest * len(ALL_ARMS) * (MAX_REPETITIONS + WARMUP_REPETITIONS) == MAX_TRIALS == 315
    assert MAX_REPETITIONS == 20


def test_every_arm_at_the_full_sample_is_one_experiment(harness):
    runner, _, _ = harness()
    experiment = runner.create("catalog", ALL_ARMS, MAX_REPETITIONS, origin="cli")
    trials = runner.benchmarks.get_trials(experiment.experiment_id)
    assert len(trials) == 2 * 5 * 21
    assert Counter((t.task_id, t.arm_id) for t in trials) == {
        (task, arm): 21 for task in (SAMPLE, PIPELINE) for arm in ALL_ARMS
    }


def test_the_trial_cap_counts_every_combination_and_the_warmups(harness, monkeypatch):
    monkeypatch.setattr("app.benchmarks.runner.MAX_TRIALS", 3)
    runner, _, _ = harness()
    # 2 tasks x 1 arm x (1 measured + 1 warm-up) = 4 trials.
    expected = r"4 trials requested \(2 per arm and task, including 1 warm-up\); the limit is 3"
    with pytest.raises(ExperimentError, match=expected):
        runner.create("catalog", ["parallel"], 1, origin="cli")
    assert runner.benchmarks.list_experiments_page()[0] == []


def test_the_public_demo_runs_only_public_suites_on_the_server_provider(harness):
    runner, _, _ = harness(**PUBLIC)
    with pytest.raises(ExperimentError, match="not available in the public demo"):
        runner.create("local-fixtures", ["adaptive"], origin="api")
    with pytest.raises(ExperimentError, match="server's provider"):
        runner.create("catalog", ["parallel"], origin="api", provider="demo")
    assert runner.create("catalog", ["parallel"], origin="api").status == "queued"


def test_only_one_experiment_may_be_active(harness):
    runner, _, _ = harness()
    first = runner.create("catalog", ["parallel"], origin="cli")
    with pytest.raises(ExperimentBusyError, match=first.experiment_id):
        runner.create("catalog", ["sequential"], origin="cli")


# ----------------------------------------------------------------------
# run
# ----------------------------------------------------------------------
async def test_a_successful_experiment_links_runs_and_snapshots_metrics(harness):
    runner, service, store = harness()
    experiment = runner.create("catalog", ["parallel", "sequential"], origin="cli", task_ids=[SAMPLE])
    finished = await runner.run(experiment.experiment_id)

    assert finished.status == "completed" and finished.error is None
    assert finished.started_at and finished.finished_at
    trials = runner.benchmarks.get_trials(experiment.experiment_id)
    assert [t.status for t in trials] == ["done"] * 4
    for trial in trials:
        record = store.get_run(trial.run_id)
        assert record is not None and record.status == "completed"
        assert trial.metrics.run_id == record.run_id
        if trial.repetition == 0:  # the warm-up ran in full and is excluded
            assert trial.metrics.outcome == "excluded" and trial.metrics.excluded_reason == WARMUP_REASON
            assert trial.metrics.verification_passed is None
            continue
        assert trial.metrics.outcome == "success" and trial.metrics.verification_passed is True
        assert trial.metrics.input_tokens is None and trial.metrics.null_reasons["tokens"]
        config = next(c for c in finished.configurations if c.arm_id == trial.arm_id)
        assert record.limits == config.limits
        assert record.models_by_role == config.models_by_role
    assert len({t.run_id for t in trials}) == 4
    assert len(service.store.list_runs(50)) == 4


async def test_a_provider_failure_is_a_failed_trial_not_a_broken_experiment(harness):
    runner, _, _ = harness(base_url="http://127.0.0.1:1/v1", fast_model="m", request_timeout_seconds=2)
    experiment = runner.create("catalog", ["parallel"], origin="cli", task_ids=[SAMPLE], provider="openai")
    finished = await runner.run(experiment.experiment_id)
    assert finished.status == "completed"  # every trial ran...
    warmup, trial = runner.benchmarks.get_trials(experiment.experiment_id)
    assert warmup.status == trial.status == "done"
    assert warmup.metrics.excluded_reason == WARMUP_REASON
    assert trial.metrics.outcome == "failure"  # ...and the endpoint's failure is the task's
    assert trial.metrics.scripted is False


async def test_a_trial_that_cannot_start_makes_the_experiment_partial(harness, monkeypatch):
    runner, service, _ = harness()
    experiment = runner.create("catalog", ["parallel", "sequential"], origin="cli", task_ids=[SAMPLE])
    original, calls = service.start, []

    def start(request):
        calls.append(request)
        if len(calls) == 2:
            raise ProviderConfigError("endpoint removed")
        return original(request)

    monkeypatch.setattr(service, "start", start)
    finished = await runner.run(experiment.experiment_id)
    assert finished.status == "partial"
    assert "1 of 4 trials" in finished.error
    statuses = [t.status for t in runner.benchmarks.get_trials(experiment.experiment_id)]
    assert statuses == ["done", "error", "done", "done"]  # no rerun replaces it
    assert "endpoint removed" in runner.benchmarks.get_trials(experiment.experiment_id)[1].error


async def test_an_experiment_where_nothing_could_run_has_failed(harness, tmp_path):
    runner, service, store = harness()
    experiment = runner.create("catalog", ["parallel"], origin="cli", task_ids=[SAMPLE])
    # The server's configuration changes before the experiment runs.
    service.settings = replace(service.settings, max_agent_calls=2)
    finished = await runner.run(experiment.experiment_id)
    assert finished.status == "failed"
    assert "configuration changed" in finished.error
    trials = runner.benchmarks.get_trials(experiment.experiment_id)
    assert len(trials) == 2
    assert all(trial.status == "error" and trial.run_id is None for trial in trials)
    assert store.list_runs(10) == []  # nothing ran under a different configuration


async def test_cancelling_stops_the_current_run_and_skips_the_rest(harness, slow_demo):
    slow_demo(0.5)
    runner, service, store = harness()
    experiment = runner.create("catalog", ["parallel", "sequential"], 2, origin="cli", task_ids=[SAMPLE])
    task = asyncio.create_task(runner.run(experiment.experiment_id))
    await wait_until(lambda: any(t.run_id for t in runner.benchmarks.get_trials(experiment.experiment_id)))
    assert runner.cancel(experiment.experiment_id) is True

    finished = await asyncio.wait_for(task, 20)
    assert finished.status == "cancelled"
    trials = runner.benchmarks.get_trials(experiment.experiment_id)
    assert trials[0].status == "done" and trials[0].repetition == 0
    # The first trial is a warm-up: excluded as one, and still says it was cancelled.
    assert trials[0].metrics.outcome == "excluded"
    assert trials[0].metrics.excluded_reason == WARMUP_REASON
    assert trials[0].metrics.status == "cancelled"
    assert "the run itself was excluded: cancelled" in trials[0].metrics.null_reasons["*"]
    assert store.get_run(trials[0].run_id).status == "cancelled"
    assert [t.status for t in trials[1:]] == ["not_run"] * 5
    assert all(t.run_id is None for t in trials[1:])
    assert runner.cancel(experiment.experiment_id) is False  # no longer running


async def test_a_trial_waits_for_a_free_run_slot(harness, slow_demo):
    slow_demo(0.3)
    runner, service, store = harness(max_concurrent_runs=1)
    blocker, blocker_task = service.start(
        service_module.RunRequest(goal="occupy the only slot", demo_task=SAMPLE)
    )
    experiment = runner.create("catalog", ["parallel"], origin="cli", task_ids=[SAMPLE])
    task = asyncio.create_task(runner.run(experiment.experiment_id))

    await asyncio.sleep(0.4)
    waiting = runner.benchmarks.get_trials(experiment.experiment_id)[0]
    assert waiting.status == "running" and waiting.run_id is None  # claimed, waiting for the slot
    assert not blocker_task.done()

    finished = await asyncio.wait_for(task, 30)
    assert finished.status == "completed"
    trial = runner.benchmarks.get_trials(experiment.experiment_id)[0]
    assert blocker_task.done()
    assert store.get_run(trial.run_id).created_at >= store.get_run(blocker.run_id).updated_at


async def test_cancelling_while_waiting_for_a_slot_leaves_the_trial_unrun(harness, slow_demo):
    slow_demo(1.0)
    runner, service, store = harness(max_concurrent_runs=1)
    service.start(service_module.RunRequest(goal="occupy the only slot", demo_task=SAMPLE))
    experiment = runner.create("catalog", ["parallel"], origin="cli", task_ids=[SAMPLE])
    task = asyncio.create_task(runner.run(experiment.experiment_id))
    await asyncio.sleep(0.2)
    runner.cancel(experiment.experiment_id)
    finished = await asyncio.wait_for(task, 20)
    assert finished.status == "cancelled"
    trials = runner.benchmarks.get_trials(experiment.experiment_id)
    assert all(trial.status == "not_run" and trial.run_id is None for trial in trials)
    await service.drain()


async def test_a_stopped_runner_leaves_nothing_running(harness, slow_demo):
    slow_demo(0.5)
    runner, service, store = harness()
    experiment = runner.create("catalog", ["parallel", "sequential"], origin="cli", task_ids=[SAMPLE])
    task = asyncio.create_task(runner.run(experiment.experiment_id))
    await wait_until(lambda: any(t.run_id for t in runner.benchmarks.get_trials(experiment.experiment_id)))
    task.cancel()  # the process is shutting down
    with pytest.raises(asyncio.CancelledError):
        await task
    await service.drain()

    stored = runner.benchmarks.get_experiment(experiment.experiment_id)
    assert stored.status == "interrupted"
    trials = runner.benchmarks.get_trials(experiment.experiment_id)
    assert trials[0].status == "error" and trials[0].run_id is not None
    assert store.get_run(trials[0].run_id).status == "cancelled"
    assert trials[1].status == "not_run"


async def test_an_unexpected_error_fails_the_experiment_without_leaving_it_running(harness, monkeypatch):
    runner, _, _ = harness()
    experiment = runner.create("catalog", ["parallel", "sequential"], origin="cli", task_ids=[SAMPLE])

    def broken(trial):
        raise RuntimeError("disk full")

    monkeypatch.setattr(runner, "_finish_trial", broken)
    finished = await runner.run(experiment.experiment_id)
    assert finished.status == "failed" and "disk full" in finished.error
    statuses = [t.status for t in runner.benchmarks.get_trials(experiment.experiment_id)]
    assert "running" not in statuses and "pending" not in statuses


# ----------------------------------------------------------------------
# duplicates and recovery
# ----------------------------------------------------------------------
async def test_an_experiment_runs_once(harness):
    runner, _, store = harness()
    experiment = runner.create("catalog", ["parallel"], origin="cli", task_ids=[SAMPLE])
    first = asyncio.create_task(runner.run(experiment.experiment_id))
    await asyncio.sleep(0)
    with pytest.raises(ExperimentError, match="not queued"):
        await runner.run(experiment.experiment_id)
    await first
    with pytest.raises(ExperimentError, match="not queued"):
        await runner.run(experiment.experiment_id)
    assert len(store.list_runs(10)) == 2  # the warm-up and the measured trial


async def test_a_claimed_trial_is_never_started_again(harness):
    runner, _, store = harness()
    experiment = runner.create("catalog", ["parallel", "sequential"], origin="cli", task_ids=[SAMPLE])
    first = runner.benchmarks.get_trials(experiment.experiment_id)[0]
    # Another runner claimed the first trial already.
    assert runner.benchmarks.transition_trial(first.model_copy(update={"status": "running"}), "pending")
    assert not runner.benchmarks.transition_trial(first.model_copy(update={"status": "running"}), "pending")
    await runner.run(experiment.experiment_id)
    trials = runner.benchmarks.get_trials(experiment.experiment_id)
    assert trials[0].run_id is None  # skipped, not run a second time
    assert [t.status for t in trials[1:]] == ["done"] * 3
    assert len(store.list_runs(10)) == 3


async def test_recovery_closes_an_interrupted_experiment_without_resuming(harness):
    runner, service, store = harness()
    experiment = runner.create("catalog", ["parallel", "sequential"], 2, origin="cli", task_ids=[SAMPLE])
    trials = runner.benchmarks.get_trials(experiment.experiment_id)
    # A process died mid-trial: experiment running, first trial running with a live run.
    runner.benchmarks.save_experiment(experiment.model_copy(update={"status": "running"}))
    stranded = RunRecord(goal="stranded run", status="running", provider_kind="demo")
    store.save_run(stranded)
    runner.benchmarks.save_trial(trials[0].model_copy(update={"status": "running", "run_id": stranded.run_id}))

    # The next process starts: runs are recovered first, then experiments.
    store.recover_interrupted("interrupted: the server stopped before this run finished")
    restarted = ExperimentRunner(service, BenchmarkStore(store))
    assert restarted.recover_interrupted() == [experiment.experiment_id]

    stored = restarted.benchmarks.get_experiment(experiment.experiment_id)
    assert stored.status == "interrupted" and stored.finished_at
    after = restarted.benchmarks.get_trials(experiment.experiment_id)
    assert after[0].status == "done"
    assert after[0].metrics.outcome == "excluded"
    assert after[0].metrics.excluded_reason == WARMUP_REASON  # the stranded trial was a warm-up
    assert "server stopped" in after[0].metrics.null_reasons["*"]
    assert [t.status for t in after[1:]] == ["not_run"] * 5
    with pytest.raises(ExperimentError, match="not queued"):
        await restarted.run(experiment.experiment_id)
    assert restarted.recover_interrupted() == []  # idempotent


async def test_recovery_closes_a_queued_experiment_and_a_trial_without_a_run(harness):
    runner, service, store = harness()
    experiment = runner.create("catalog", ["parallel"], origin="cli", task_ids=[SAMPLE])
    trial = runner.benchmarks.get_trials(experiment.experiment_id)[0]
    runner.benchmarks.save_trial(trial.model_copy(update={"status": "running"}))  # claimed, no run yet
    recovered = ExperimentRunner(service, BenchmarkStore(store)).recover_interrupted()
    assert recovered == [experiment.experiment_id]
    after, rest = runner.benchmarks.get_trials(experiment.experiment_id)
    assert after.status == "error" and "server stopped" in after.error
    assert rest.status == "not_run"
    # A new experiment can start once the stale one is closed.
    assert runner.create("catalog", ["sequential"], origin="cli").status == "queued"


async def test_the_api_closes_stale_experiments_at_startup(tmp_path, monkeypatch):
    import app.main as main_module

    store = RunStore(tmp_path / "api.db")
    runner = ExperimentRunner(RunService(make_settings(tmp_path, db_path=tmp_path / "api.db"), store), BenchmarkStore(store))
    experiment = runner.create("catalog", ["parallel"], origin="cli")
    runner.benchmarks.save_experiment(experiment.model_copy(update={"status": "running"}))
    store.close()

    monkeypatch.setattr(main_module, "settings", make_settings(tmp_path, db_path=tmp_path / "api.db"))
    async with main_module.lifespan(main_module.app):
        stored = main_module.app.state.experiments.benchmarks.get_experiment(experiment.experiment_id)
    assert stored.status == "interrupted"


async def test_results_survive_reopening_the_database(harness, tmp_path):
    runner, _, store = harness()
    experiment = runner.create("catalog", ["parallel"], origin="cli", task_ids=[SAMPLE])
    finished = await runner.run(experiment.experiment_id)
    trials = runner.benchmarks.get_trials(experiment.experiment_id)
    store.close()

    reopened = RunStore(tmp_path / "runner.db")
    try:
        benchmarks = BenchmarkStore(reopened)
        assert benchmarks.get_experiment(experiment.experiment_id) == finished
        assert benchmarks.get_trials(experiment.experiment_id) == trials
        assert reopened.get_run(trials[0].run_id) is not None
    finally:
        reopened.close()


async def test_recovering_an_experiment_another_runner_still_owns(harness, slow_demo):
    """What `bench --recover` does to a live experiment (why it is operator-only)."""
    slow_demo(0.4)
    runner, service, store = harness()
    experiment = runner.create("catalog", ["parallel", "sequential"], origin="cli", task_ids=[SAMPLE])
    task = asyncio.create_task(runner.run(experiment.experiment_id))
    await wait_until(lambda: any(t.run_id for t in runner.benchmarks.get_trials(experiment.experiment_id)))

    # Another process recovers it while this runner still owns it.
    assert ExperimentRunner(service, BenchmarkStore(store)).recover_interrupted() == [experiment.experiment_id]
    finished = await asyncio.wait_for(task, 20)

    assert finished.status == "interrupted"
    first, second, *rest = runner.benchmarks.get_trials(experiment.experiment_id)
    # The trial in flight is recorded as an error; its run still completes and stays linked...
    assert first.status == "error" and first.metrics is None
    assert store.get_run(first.run_id).status == "completed"
    # ...and the owning runner starts nothing more.
    assert all(t.status == "not_run" and t.run_id is None for t in [second, *rest])
    assert len(store.list_runs(10)) == 1
