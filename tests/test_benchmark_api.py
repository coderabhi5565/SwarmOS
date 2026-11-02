"""The benchmark API in local mode: contracts, validation, paging, lifecycle."""

from __future__ import annotations

import asyncio
import time

import pytest
from fastapi.testclient import TestClient

import app.main as main_module
import app.service as service_module
from app.api_models import (
    BenchmarkAggregate,
    BenchmarkArmConfiguration,
    BenchmarkDistribution,
    BenchmarkEnvironment,
    BenchmarkIdenticalArms,
    BenchmarkTrialMetrics,
)
from app.benchmarks.metrics import ArmAggregate, Distribution, TrialMetrics
from app.benchmarks.provenance import ArmConfiguration, EnvironmentProvenance, IdenticalArms
from app.benchmarks.runner import ExperimentRunner
from app.benchmarks.store import BenchmarkStore
from app.providers import ProviderConfigError
from app.providers.demo import DemoProvider
from app.service import RunService
from app.store import RunStore
from tests.conftest import make_settings

SAMPLE = "sample_tag_normalization"


@pytest.fixture
def api(tmp_path, monkeypatch):
    def open_client(**overrides) -> TestClient:
        settings = make_settings(tmp_path, db_path=tmp_path / "api.db", **overrides)
        monkeypatch.setattr(main_module, "settings", settings)
        return TestClient(main_module.app)

    open_client.db = tmp_path / "api.db"
    open_client.tmp = tmp_path
    return open_client


@pytest.fixture
def slow_demo(monkeypatch):
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


def prepare(api, build):
    """Run ``build(runner)`` on the API's database before the API starts."""
    store = RunStore(api.db)
    runner = ExperimentRunner(
        RunService(make_settings(api.tmp, db_path=api.db), store), BenchmarkStore(store), slot_poll_seconds=0.05
    )
    try:
        return asyncio.run(build(runner))
    finally:
        store.close()


def wait_for(client: TestClient, experiment_id: str, statuses: set[str], within: float = 30.0) -> dict:
    deadline = time.monotonic() + within
    while time.monotonic() < deadline:
        body = client.get(f"/api/benchmarks/experiments/{experiment_id}").json()
        if body["experiment"]["status"] in statuses:
            return body
        time.sleep(0.1)
    raise AssertionError(f"experiment did not reach {statuses}")


CREATE = {"suite_id": "catalog", "arm_ids": ["parallel", "sequential"], "task_ids": [SAMPLE]}


# ----------------------------------------------------------------------
# suites
# ----------------------------------------------------------------------
def test_suites_list_suites_arms_and_caps(api):
    with api() as client:
        body = client.get("/api/benchmarks/suites").json()
    assert body["can_create"] is True and body["mode"] == "local"
    assert [suite["id"] for suite in body["suites"]] == ["catalog", "local-fixtures"]
    catalog = body["suites"][0]
    assert catalog["public"] is True and catalog["version"].startswith("v1-")
    assert {task["id"] for task in catalog["tasks"]} == {SAMPLE, "sample_parallel_pipeline"}
    assert {arm["id"] for arm in body["arms"]} == {"parallel", "sequential", "fixed-fast", "adaptive", "multi-agent"}
    assert (body["max_repetitions"], body["max_trials"]) == (10, 60)


# ----------------------------------------------------------------------
# create, run, detail
# ----------------------------------------------------------------------
def test_create_runs_an_experiment_and_details_every_trial(api):
    with api() as client:
        created = client.post("/api/benchmarks/experiments", json={**CREATE, "order_seed": 4})
        assert created.status_code == 202
        detail = created.json()
        experiment_id = detail["experiment"]["experiment_id"]
        assert detail["experiment"]["status"] in {"queued", "running"}
        assert detail["experiment"]["origin"] == "api" and detail["order_seed"] == 4

        body = wait_for(client, experiment_id, {"completed"})
        run_paths = [trial["run_path"] for trial in body["trials"]]
        runs = [client.get(path) for path in run_paths]

    assert body["experiment"]["trials_total"] == body["experiment"]["trials_done"] == 2
    assert body["experiment"]["scripted"] is True
    assert body["notes"][0].startswith("Scripted provider")
    assert any("No arm is declared best" in note for note in body["notes"])
    for trial, run in zip(body["trials"], runs, strict=True):
        assert trial["status"] == "done"
        assert run.status_code == 200 and run.json()["run"]["run_id"] == trial["run_id"]
        metrics = trial["metrics"]
        assert metrics["outcome"] == "success" and metrics["verification_passed"] is True
        assert metrics["input_tokens"] is None and metrics["cost_usd"] is None
        assert metrics["null_reasons"]["tokens"].startswith("scripted provider")

    assert [a["arm_id"] for a in body["aggregates"]] == ["parallel", "sequential"]
    assert all(a["task_id"] is None and a["counted"] == 1 for a in body["aggregates"])
    assert [(a["arm_id"], a["task_id"]) for a in body["task_aggregates"]] == [
        ("parallel", SAMPLE),
        ("sequential", SAMPLE),
    ]
    assert body["aggregates"][0]["trial_statuses"] == {"done": 1}
    assert body["aggregates"][0]["task_success_rate"] == 1.0
    assert body["aggregates"][0]["latency_ms"]["n"] == 1
    # The sample task has no parallel wave: the two arms are identical by design.
    (group,) = body["identical_by_design"]
    assert sorted(group["arm_ids"]) == ["parallel", "sequential"] and group["task_id"] == SAMPLE
    assert {c["arm_id"] for c in body["configurations"]} == {"parallel", "sequential"}
    assert all(c["fingerprint"] for c in body["configurations"])
    assert body["environment"]["python_version"] and body["environment"]["platform"]
    assert body["environment"]["scripted"] is True


@pytest.mark.parametrize(
    "payload",
    [
        {**CREATE, "goal": "write arbitrary code please"},
        {**CREATE, "files": {"x.py": "print(1)"}},
        {**CREATE, "limits": {"max_agent_calls": 64}},
        {**CREATE, "model": "gpt-anything"},
        {**CREATE, "provider": "https://evil.example/v1"},
        {**CREATE, "repetitions": 0},
        {**CREATE, "repetitions": 11},
        {**CREATE, "arm_ids": []},
        {**CREATE, "order_seed": -1},
        {"arm_ids": ["parallel"]},
        {"suite_id": "catalog"},
    ],
)
def test_create_validates_the_body_strictly(api, payload):
    with api() as client:
        response = client.post("/api/benchmarks/experiments", json=payload)
        assert response.status_code == 422
        assert client.get("/api/benchmarks/experiments").json()["experiments"] == []


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ({**CREATE, "suite_id": "nope"}, "unknown benchmark suite"),
        ({**CREATE, "arm_ids": ["turbo"]}, "unknown benchmark arm"),
        ({**CREATE, "arm_ids": ["parallel", "parallel"]}, "once"),
        ({**CREATE, "task_ids": ["missing"]}, "no task"),
        ({"suite_id": "local-fixtures", "arm_ids": ["adaptive"]}, "needs a real model"),
        ({**CREATE, "provider": "openai"}, "OPENAI_COMPAT_BASE_URL"),
    ],
)
def test_create_refuses_what_it_cannot_run(api, payload, message):
    with api() as client:
        response = client.post("/api/benchmarks/experiments", json=payload)
    assert response.status_code == 400
    assert message in response.json()["detail"]


def test_only_one_experiment_may_be_active(api):
    async def queued(runner):
        return runner.create("catalog", ["parallel"], origin="cli", task_ids=[SAMPLE])

    # Queued by another process (say a bench command that has not started yet).
    stale = prepare(api, queued)
    with api() as client:
        # Startup recovery closes it: nothing else can be running it now.
        assert client.get(f"/api/benchmarks/experiments/{stale.experiment_id}").json()["experiment"]["status"] == "interrupted"
        first = client.post("/api/benchmarks/experiments", json=CREATE)
        assert first.status_code == 202
        second = client.post("/api/benchmarks/experiments", json=CREATE)
        assert second.status_code == 409
        assert "only one experiment may be active" in second.json()["detail"]
        wait_for(client, first.json()["experiment"]["experiment_id"], {"completed"})


def test_an_unknown_experiment_is_a_404(api):
    with api() as client:
        assert client.get("/api/benchmarks/experiments/bex_missing").status_code == 404
        response = client.post("/api/benchmarks/experiments/bex_missing/cancel")
    assert response.status_code == 404
    assert response.json() == {"detail": "experiment bex_missing not found"}


# ----------------------------------------------------------------------
# active experiments and cancellation
# ----------------------------------------------------------------------
def test_an_active_experiment_shows_its_progress_and_can_be_cancelled(api, slow_demo):
    slow_demo(0.5)
    with api() as client:
        experiment_id = client.post(
            "/api/benchmarks/experiments", json={**CREATE, "repetitions": 2}
        ).json()["experiment"]["experiment_id"]
        running = wait_for(client, experiment_id, {"running"})
        statuses = [trial["status"] for trial in running["trials"]]
        assert "pending" in statuses
        assert sum(running["aggregates"][i]["trial_statuses"].get("pending", 0) for i in range(2)) >= 1

        cancelled = client.post(f"/api/benchmarks/experiments/{experiment_id}/cancel")
        assert cancelled.status_code == 202
        assert cancelled.json() == {"experiment_id": experiment_id, "status": "cancelling"}

        body = wait_for(client, experiment_id, {"cancelled"})
        again = client.post(f"/api/benchmarks/experiments/{experiment_id}/cancel")
    assert again.status_code == 409
    assert "already finished: cancelled" in again.json()["detail"]
    trial_statuses = {trial["status"] for trial in body["trials"]}
    assert "not_run" in trial_statuses and "running" not in trial_statuses and "pending" not in trial_statuses


def test_cancel_refuses_an_experiment_this_server_is_not_running(api):
    with api() as client:
        # Created in this database but run by no one in this process.
        runner = main_module.app.state.experiments
        experiment = runner.create("catalog", ["parallel"], origin="cli", task_ids=[SAMPLE])
        response = client.post(f"/api/benchmarks/experiments/{experiment.experiment_id}/cancel")
        runner.recover_interrupted()
    assert response.status_code == 409
    assert "not running in this server process" in response.json()["detail"]


def test_stopping_the_server_interrupts_its_experiment(api, slow_demo):
    slow_demo(0.5)
    with api() as client:
        experiment_id = client.post(
            "/api/benchmarks/experiments", json={**CREATE, "repetitions": 3}
        ).json()["experiment"]["experiment_id"]
        wait_for(client, experiment_id, {"running"})
    # The server stopped (lifespan shutdown). Look at what it left behind.
    store = RunStore(api.db)
    try:
        benchmarks = BenchmarkStore(store)
        assert benchmarks.get_experiment(experiment_id).status == "interrupted"
        statuses = {trial.status for trial in benchmarks.get_trials(experiment_id)}
        assert not statuses & {"pending", "running"}
        assert {run.status for run in store.list_runs(50)} <= {"completed", "cancelled"}
    finally:
        store.close()


# ----------------------------------------------------------------------
# finished experiments
# ----------------------------------------------------------------------
def test_a_partial_experiment_reports_why_trials_did_not_run(api):
    async def partial(runner):
        experiment = runner.create("catalog", ["parallel", "sequential"], origin="cli", task_ids=[SAMPLE])
        original, calls = runner.service.start, []

        def start(request):
            calls.append(request)
            if len(calls) == 2:
                raise ProviderConfigError("endpoint removed")
            return original(request)

        runner.service.start = start
        return await runner.run(experiment.experiment_id)

    finished = prepare(api, partial)
    with api() as client:
        body = client.get(f"/api/benchmarks/experiments/{finished.experiment_id}").json()
    assert body["experiment"]["status"] == "partial"
    assert "1 of 2 trials did not run" in body["experiment"]["error"]
    errored = [t for t in body["trials"] if t["status"] == "error"]
    assert len(errored) == 1 and "endpoint removed" in errored[0]["error"]
    assert errored[0]["metrics"] is None and errored[0]["run_path"] is None
    arm = errored[0]["arm_id"]
    aggregate = next(a for a in body["aggregates"] if a["arm_id"] == arm)
    assert aggregate["trial_statuses"] == {"error": 1}
    assert aggregate["counted"] == 0 and aggregate["task_success_rate"] is None


def test_a_cancelled_run_is_an_excluded_trial_with_its_reason(api, slow_demo):
    slow_demo(0.4)

    async def cancelled(runner):
        experiment = runner.create("catalog", ["parallel"], 2, origin="cli", task_ids=[SAMPLE])
        task = asyncio.create_task(runner.run(experiment.experiment_id))
        for _ in range(500):
            if any(t.run_id for t in runner.benchmarks.get_trials(experiment.experiment_id)):
                break
            await asyncio.sleep(0.02)
        runner.cancel(experiment.experiment_id)
        return await task

    finished = prepare(api, cancelled)
    with api() as client:
        body = client.get(f"/api/benchmarks/experiments/{finished.experiment_id}").json()
    first, second = body["trials"]
    assert first["metrics"]["outcome"] == "excluded"
    assert first["metrics"]["excluded_reason"] == "cancelled"
    assert first["metrics"]["latency_ms"] is None and "excluded" in first["metrics"]["null_reasons"]["*"]
    assert second["status"] == "not_run" and second["error"]
    assert body["aggregates"][0]["excluded"] == 1 and body["aggregates"][0]["excluded_reasons"] == {"cancelled": 1}


# ----------------------------------------------------------------------
# paging
# ----------------------------------------------------------------------
def test_experiments_page_newest_first_with_a_stable_cursor(api):
    async def three(runner):
        made = []
        for _ in range(3):
            experiment = runner.create("catalog", ["parallel"], origin="cli", task_ids=[SAMPLE])
            runner.benchmarks.save_experiment(experiment.model_copy(update={"status": "completed"}))
            made.append(experiment.experiment_id)
            await asyncio.sleep(0.01)  # distinct created_at
        return made

    ids = prepare(api, three)
    with api() as client:
        first = client.get("/api/benchmarks/experiments", params={"limit": 2}).json()
        assert [e["experiment_id"] for e in first["experiments"]] == [ids[2], ids[1]]
        # A new experiment arriving between pages shifts nothing.
        created = client.post("/api/benchmarks/experiments", json=CREATE).json()["experiment"]["experiment_id"]
        rest = client.get("/api/benchmarks/experiments", params={"limit": 2, "cursor": first["next_cursor"]}).json()
        assert [e["experiment_id"] for e in rest["experiments"]] == [ids[0]]
        assert rest["next_cursor"] is None
        assert client.get("/api/benchmarks/experiments").json()["experiments"][0]["experiment_id"] == created
        assert client.get("/api/benchmarks/experiments", params={"cursor": "bex_unknown"}).status_code == 400
        assert client.get("/api/benchmarks/experiments", params={"limit": 51}).status_code == 422
        assert client.get("/api/benchmarks/experiments", params={"limit": 0}).status_code == 422
        wait_for(client, created, {"completed"})


# ----------------------------------------------------------------------
# contracts
# ----------------------------------------------------------------------
@pytest.mark.parametrize(
    ("api_model", "domain_model", "extra", "missing"),
    [
        (BenchmarkTrialMetrics, TrialMetrics, set(), set()),
        (BenchmarkAggregate, ArmAggregate, {"task_id", "trial_statuses"}, set()),
        (BenchmarkDistribution, Distribution, set(), set()),
        (BenchmarkArmConfiguration, ArmConfiguration, set(), set()),
        (BenchmarkIdenticalArms, IdenticalArms, set(), set()),
        (BenchmarkEnvironment, EnvironmentProvenance, set(), {"provider_choice"}),
    ],
)
def test_api_models_track_the_domain_models(api_model, domain_model, extra, missing):
    assert set(api_model.model_fields) == (set(domain_model.model_fields) | extra) - missing


def test_benchmark_schemas_mark_always_present_fields_required():
    schemas = main_module.app.openapi()["components"]["schemas"]
    required = lambda name: set(schemas[name].get("required", []))  # noqa: E731
    assert {"input_tokens", "cost_usd", "null_reasons", "latency_ms"} <= required("BenchmarkTrialMetrics")
    assert {"experiment", "aggregates", "trials", "identical_by_design", "environment"} <= required(
        "BenchmarkExperimentDetail"
    )
    assert {"run_id", "run_path", "metrics", "error"} <= required("BenchmarkTrialInfo")
    assert {"experiments", "next_cursor"} <= required("BenchmarkExperimentListResponse")
    # A request body requires only what the server cannot default.
    assert required("BenchmarkCreateRequest") == {"suite_id", "arm_ids"}
    assert schemas["BenchmarkCreateRequest"].get("additionalProperties") is False
