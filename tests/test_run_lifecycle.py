"""Run lifecycle reliability: deadlines, cancellation, progress, and recovery."""

from __future__ import annotations

import asyncio
import json
import time

import pytest
from fastapi.testclient import TestClient

import app.main as main_module
import app.service as service_module
from app.demo_tasks import SAMPLE_PLAN
from app.models import Limits, RunRecord, RunRequest
from app.providers.demo import DemoProvider
from app.review_evidence import validate_review
from app.runtime.workspace import Workspace
from app.service import RunService
from app.store import RunStore
from tests.conftest import (
    PLAN_THREE_STEPS,
    SEED_OK,
    ScriptedProvider,
    coder_response,
    make_settings,
    plan_response,
    review_response,
)

SLOW_TEST = {"tests/test_slow.py": "import time\n\n\ndef test_slow():\n    time.sleep(30)\n"}


def approving_handler(request, index):
    if request.role == "planner":
        return plan_response(PLAN_THREE_STEPS)
    if request.role == "coder":
        return coder_response(json.loads(request.user)["step"]["id"])
    return review_response("approve")


def leave_seconds(runtime, seconds: float) -> None:
    """Move the run's start back so only ``seconds`` of wall clock remain."""
    runtime.ledger.started_monotonic -= runtime.limits.max_wall_seconds - seconds


# ----------------------------------------------------------------------
# wall clock
# ----------------------------------------------------------------------
async def test_a_model_call_cannot_outlive_the_run_deadline(build_run):
    provider = ScriptedProvider(approving_handler, delay=5.0)
    orchestrator, runtime, record = build_run(provider, files=SEED_OK)
    leave_seconds(runtime, 0.3)

    started = time.perf_counter()
    result = await orchestrator.run(record)

    assert time.perf_counter() - started < 3.0
    assert result.record.status == "timed_out"
    assert "wall-clock limit" in (result.record.error or "")
    abandoned = [
        e for e in result.events
        if e.kind == "agent_invocation" and e.payload.get("error_class") == "timeout"
    ]
    assert len(abandoned) == 1
    assert runtime.ledger.reserved_usd == 0  # the reservation was released


async def test_verification_is_cut_off_at_the_run_deadline(build_run):
    provider = ScriptedProvider(approving_handler)
    orchestrator, runtime, record = build_run(provider, files=SLOW_TEST)
    leave_seconds(runtime, 1.5)

    started = time.perf_counter()
    result = await orchestrator.run(record)

    # The configured verification timeout is 60s; the deadline wins.
    assert time.perf_counter() - started < 15.0
    assert result.record.status == "timed_out"
    assert result.record.verification is not None
    assert result.record.verification.exit_code == 124


async def test_no_verification_starts_after_the_deadline(build_run):
    provider = ScriptedProvider(approving_handler)
    orchestrator, runtime, _ = build_run(provider, files=SEED_OK)
    leave_seconds(runtime, 0.0)

    updates = await orchestrator._verify({"verification_attempts": 0})

    assert "verification" not in updates
    (halt,) = updates["halt"]
    assert halt.status == "timed_out"


async def test_call_limit_is_still_reported_as_limit_exceeded(build_run):
    provider = ScriptedProvider(approving_handler)
    orchestrator, _, record = build_run(
        provider, files=SEED_OK, limits=Limits(max_agent_calls=2)
    )
    result = await orchestrator.run(record)
    assert result.record.status == "limit_exceeded"


# ----------------------------------------------------------------------
# parallel_coding
# ----------------------------------------------------------------------
@pytest.mark.parametrize("parallel", [True, False])
async def test_parallel_coding_flag_controls_concurrency(build_run, parallel):
    provider = ScriptedProvider(approving_handler, delay=0.05)
    orchestrator, _, record = build_run(
        provider, files=SEED_OK, limits=Limits(parallel_coding=parallel)
    )
    result = await orchestrator.run(record)

    assert result.record.status == "completed"
    assert (provider.max_in_flight >= 2) is parallel
    first_wave = next(
        e for e in result.events
        if e.kind == "routing_decision" and e.payload.get("decision") == "dispatch_coding"
    )
    assert first_wave.payload["steps"] == ["alpha", "beta"]
    assert first_wave.payload["parallel"] is parallel


# ----------------------------------------------------------------------
# live progress
# ----------------------------------------------------------------------
async def test_progress_is_persisted_while_the_run_is_in_flight(build_run, tmp_path):
    store = RunStore(tmp_path / "progress.db")
    seen: list[RunRecord] = []

    def handler(request, index):
        if request.role == "reviewer":
            seen.append(store.get_run(record.run_id))
        return approving_handler(request, index)

    try:
        provider = ScriptedProvider(handler)
        orchestrator, _, record = build_run(provider, files=SEED_OK, store=store)
        store.save_run(record)
        await orchestrator.run(record)
    finally:
        store.close()

    (mid_run,) = seen
    assert mid_run.status == "running"
    assert mid_run.plan is not None
    assert [step.id for step in mid_run.plan.steps] == ["alpha", "beta", "gamma"]
    assert mid_run.agent_calls == 4  # planner + three coders, before the review
    assert mid_run.changed_files == ["out/alpha.txt", "out/beta.txt", "out/gamma.txt"]
    assert mid_run.models_by_role["coder"]


# ----------------------------------------------------------------------
# cancellation, shutdown, recovery
# ----------------------------------------------------------------------
@pytest.fixture
def service(tmp_path, monkeypatch):
    provider = ScriptedProvider(approving_handler, delay=10.0)
    monkeypatch.setattr(
        service_module, "resolve_provider", lambda name, settings: (provider, "scripted", None)
    )
    store = RunStore(tmp_path / "service.db")
    svc = RunService(make_settings(tmp_path), store)
    svc.provider = provider  # type: ignore[attr-defined]
    yield svc
    store.close()


async def wait_until(predicate, within: float = 5.0) -> None:
    deadline = time.monotonic() + within
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached")
        await asyncio.sleep(0.01)


def goal_request() -> RunRequest:
    return RunRequest(goal="Create the three output files", files=SEED_OK)


async def test_cancelling_an_in_flight_run(service):
    record = service.submit(goal_request())
    await wait_until(lambda: service.provider.in_flight > 0)

    assert service.cancel(record.run_id) is True
    await service.drain()

    stored = service.store.get_run(record.run_id)
    assert stored.status == "cancelled"
    assert stored.error == "cancelled on request"
    finished = [e for e in service.store.get_events(record.run_id) if e.kind == "run_finished"]
    assert finished[-1].payload["status"] == "cancelled"
    assert not service.is_active(record.run_id)
    assert service.cancel(record.run_id) is False


async def test_cancelling_a_run_before_it_starts(service):
    record = service.submit(goal_request())
    assert service.cancel(record.run_id) is True  # no await: execute never ran
    await service.drain()

    stored = service.store.get_run(record.run_id)
    assert stored.status == "cancelled"
    assert service.provider.calls == []


async def test_shutdown_cancels_runs_that_do_not_finish(service):
    record = service.submit(goal_request())
    await wait_until(lambda: service.provider.in_flight > 0)

    await service.shutdown(grace_seconds=0.05)

    stored = service.store.get_run(record.run_id)
    assert stored.status == "cancelled"
    assert "server shut down" in stored.error


def test_interrupted_runs_are_recovered_at_startup(tmp_path):
    store = RunStore(tmp_path / "recover.db")
    try:
        running = RunRecord(goal="was running", status="running")
        queued = RunRecord(goal="was queued", status="queued")
        done = RunRecord(goal="finished", status="completed")
        for record in (running, queued, done):
            store.save_run(record)

        recovered = store.recover_interrupted("interrupted: test restart")

        assert sorted(recovered) == sorted([running.run_id, queued.run_id])
        assert store.get_run(running.run_id).status == "failed"
        assert store.get_run(running.run_id).error == "interrupted: test restart"
        assert store.get_run(done.run_id).status == "completed"
        (event,) = store.get_events(queued.run_id)
        assert event.kind == "run_finished"
        assert event.payload["recovered"] is True
    finally:
        store.close()


async def test_a_running_verification_process_can_be_killed(tmp_path):
    workspace = Workspace(tmp_path / "ws")
    workspace.seed(SLOW_TEST)
    started = time.perf_counter()
    pending = asyncio.create_task(
        asyncio.to_thread(workspace.run_command, "python -m pytest -q", 60)
    )
    await wait_until(lambda: workspace._active_process is not None, within=15)

    assert workspace.kill_active_process() is True
    result = await pending

    assert time.perf_counter() - started < 20
    assert result.passed is False
    assert workspace.kill_active_process() is False


# ----------------------------------------------------------------------
# API
# ----------------------------------------------------------------------
@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main_module, "settings", make_settings(tmp_path))
    with TestClient(main_module.app) as test_client:
        yield test_client


def test_cancel_endpoint_rejects_unknown_and_finished_runs(client):
    assert client.post("/api/runs/run_missing/cancel").status_code == 404

    finished = client.post(
        "/api/runs?wait=true", json={"goal": "Implement tag normalization", "provider": "demo"}
    ).json()["run"]
    response = client.post(f"/api/runs/{finished['run_id']}/cancel")
    assert response.status_code == 409
    assert "already finished" in response.json()["detail"]


# ----------------------------------------------------------------------
# workspace truncation and the demo fixture
# ----------------------------------------------------------------------
async def test_snapshot_truncation_is_reported(build_run):
    provider = ScriptedProvider(approving_handler)
    big = {f"data/file_{i}.txt": "x" * 400 for i in range(10)} | SEED_OK
    orchestrator, _, record = build_run(provider, files=big, snapshot_char_limit=1000)
    result = await orchestrator.run(record)

    warnings = [e for e in result.events if e.kind == "warning"]
    assert len(warnings) == 1
    assert warnings[0].payload["char_limit"] == 1000
    assert "Workspace snapshot: truncated" in result.record.summary


@pytest.mark.parametrize(
    "target",
    [
        "from collections.abc import Iterable\n",
        "def normalize_tags(tags):\n    raise NotImplementedError\n",
    ],
)
def test_demo_reviewer_blockers_carry_the_required_evidence(target):
    from app.models import ReviewInput, ReviewOutput

    payload = ReviewInput(
        goal="Implement normalize_tags", plan=SAMPLE_PLAN, files={"target.py": target}
    ).model_dump(mode="json")
    review = ReviewOutput.model_validate(DemoProvider._review(payload))
    report = validate_review(
        review,
        acceptance_criteria=[c for s in SAMPLE_PLAN.steps for c in s.acceptance_criteria],
        files={"target.py": target},
    )
    assert review.verdict == "request_changes"
    assert report.unsupported_blockers == ()
