"""The benchmark API in the public demo: read-only, catalog only, nothing private."""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.benchmarks.runner import ExperimentRunner
from app.benchmarks.store import BenchmarkStore
from app.service import RunService
from app.store import RunStore
from tests.conftest import make_settings

SECRET_KEY = "sk-bench-public-secret-000"
PRIVATE_URL = "http://10.20.30.40:11434/v1"
PRIVATE = {"base_url": PRIVATE_URL, "fast_model": "m", "api_key": SECRET_KEY}
PUBLIC = {"mode": "public_demo", "execution_sandbox": "restricted", "code_policy_enabled": True}
SAMPLE = "sample_tag_normalization"


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    """A database holding a finished catalog experiment (with errors that
    mention private configuration) and a local-fixtures one, made locally.
    Built once: the tests only read it."""
    root = tmp_path_factory.mktemp("public")
    db = root / "public.db"
    local = make_settings(root, db_path=db, **PRIVATE)
    store = RunStore(db)
    runner = ExperimentRunner(RunService(local, store), BenchmarkStore(store))

    async def build():
        catalog = runner.create("catalog", ["parallel", "sequential"], origin="cli", task_ids=[SAMPLE], provider="demo")
        await runner.run(catalog.experiment_id)
        # Errors that quote private configuration, as an exception text might.
        leaky = f"connection to {PRIVATE_URL} failed with key {SECRET_KEY}; see https://status.example/x"
        trials = runner.benchmarks.get_trials(catalog.experiment_id)
        runner.benchmarks.save_trial(trials[1].model_copy(update={"error": leaky}))
        stored = runner.benchmarks.get_experiment(catalog.experiment_id)
        runner.benchmarks.save_experiment(stored.model_copy(update={"error": leaky}))

        hidden = runner.create("local-fixtures", ["adaptive"], origin="cli", provider="openai")
        runner.benchmarks.save_experiment(hidden.model_copy(update={"status": "completed"}))
        return catalog.experiment_id, hidden.experiment_id

    try:
        catalog_id, hidden_id = asyncio.run(build())
    finally:
        store.close()
    return root, db, catalog_id, hidden_id


@pytest.fixture
def world(built, monkeypatch):
    """Serve the built database from the API with the given settings."""
    root, db, catalog_id, hidden_id = built

    def serve(**overrides) -> TestClient:
        monkeypatch.setattr(main_module, "settings", make_settings(root, db_path=db, **{**PRIVATE, **overrides}))
        return TestClient(main_module.app)

    return serve, catalog_id, hidden_id


def test_the_public_demo_shows_only_the_catalog(world):
    serve, catalog_id, hidden_id = world
    with serve(**PUBLIC) as client:
        suites = client.get("/api/benchmarks/suites").json()
        listed = client.get("/api/benchmarks/experiments").json()
        hidden = client.get(f"/api/benchmarks/experiments/{hidden_id}")
        unknown = client.get("/api/benchmarks/experiments/bex_unknown")
        hidden_cursor = client.get("/api/benchmarks/experiments", params={"cursor": hidden_id})
        unknown_cursor = client.get("/api/benchmarks/experiments", params={"cursor": "bex_unknown"})
    assert suites["can_create"] is False
    assert [suite["id"] for suite in suites["suites"]] == ["catalog"]
    assert [e["experiment_id"] for e in listed["experiments"]] == [catalog_id]
    # A hidden experiment is indistinguishable from an unknown one.
    assert hidden.status_code == unknown.status_code == 404
    assert hidden.json()["detail"] == f"experiment {hidden_id} not found"
    assert hidden_cursor.status_code == unknown_cursor.status_code == 400


def test_the_local_server_shows_every_suite(world):
    serve, catalog_id, hidden_id = world
    with serve() as client:
        listed = {e["experiment_id"] for e in client.get("/api/benchmarks/experiments").json()["experiments"]}
        assert client.get(f"/api/benchmarks/experiments/{hidden_id}").status_code == 200
    assert listed == {catalog_id, hidden_id}


def test_the_public_demo_is_read_only(world):
    serve, catalog_id, _ = world
    body = {"suite_id": "catalog", "arm_ids": ["parallel"]}
    with serve(**PUBLIC) as client:
        created = client.post("/api/benchmarks/experiments", json=body)
        cancel_known = client.post(f"/api/benchmarks/experiments/{catalog_id}/cancel")
        cancel_unknown = client.post("/api/benchmarks/experiments/bex_unknown/cancel")
        listed = client.get("/api/benchmarks/experiments").json()["experiments"]
    assert created.status_code == 403
    assert created.json() == {"detail": "creating benchmark experiments is not available in the public demo"}
    assert cancel_known.status_code == cancel_unknown.status_code == 403
    assert len(listed) == 1  # nothing was created


@pytest.mark.parametrize("path", ["/api/benchmarks/recover", "/api/benchmarks/experiments/{id}/recover"])
def test_there_is_no_recovery_endpoint(world, path):
    serve, catalog_id, _ = world
    with serve() as client:
        assert client.post(path.format(id=catalog_id)).status_code in {404, 405}


def test_public_detail_hides_host_details_and_keeps_the_rest(world):
    serve, catalog_id, _ = world
    with serve(**PUBLIC) as client:
        body = client.get(f"/api/benchmarks/experiments/{catalog_id}").json()
    environment = body["environment"]
    assert environment["python_version"] is None and environment["platform"] is None
    assert environment["scripted"] is True and environment["provider"] == "demo"
    assert environment["app_version"] and environment["verification_command"]
    assert len(body["trials"]) == 4 and body["aggregates"]  # with one warm-up per arm
    # Run timings (numbers, statuses and fixed reasons only) are public too.
    timed = [t["metrics"]["timings"] for t in body["trials"] if t["metrics"] and t["metrics"]["timings"]]
    assert len(timed) == 2 and all(t["measurement_status"] == "recorded" for t in timed)
    assert all(isinstance(t["lifecycle_ms"], float) for t in timed)
    for aggregate in body["aggregates"]:
        assert aggregate["warmups"] == 1 and aggregate["timings"]["measured"] == 1
        assert aggregate["sample_required"] == 20 and aggregate["sample_complete"] is False
    assert body["trials"][0]["run_path"].startswith("/api/runs/run_")


def test_no_benchmark_response_leaks_private_configuration(world):
    serve, catalog_id, _ = world
    with serve(**PUBLIC) as client:
        bodies = [
            client.get("/api/benchmarks/suites").text,
            client.get("/api/benchmarks/experiments").text,
            client.get(f"/api/benchmarks/experiments/{catalog_id}").text,
        ]
    for body in bodies:
        assert SECRET_KEY not in body
        assert PRIVATE_URL not in body
        assert "10.20.30.40" not in body
        assert "https://status.example" not in body  # no URL at all in the public demo
    detail = bodies[2]
    assert "[redacted]" in detail  # the planted errors were redacted, not dropped


def test_a_local_server_redacts_the_endpoint_and_key_too(world):
    serve, catalog_id, _ = world
    with serve() as client:
        body = client.get(f"/api/benchmarks/experiments/{catalog_id}").text
    assert SECRET_KEY not in body and PRIVATE_URL not in body
    assert "https://status.example/x" in body  # other URLs are left alone locally
