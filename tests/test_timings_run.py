"""Timing spans recorded by real runs: lifecycle phases, graph nodes, waves,
coding-slot waits, verification, cancellation (in flight and before start),
the on/off setting, and that recording never changes a run or its trace.

Real catalog runs on the demo provider; structure and order are asserted
here, exact durations in tests/test_timings_analysis.py."""

from __future__ import annotations

import asyncio

import pytest

import app.service as service_module
from app.demo_tasks import PIPELINE_TASK_ID, SAMPLE_TASK_ID
from app.models import Limits, RunRequest
from app.providers.demo import DemoProvider
from app.runtime.workspace import Workspace
from app.service import RunService
from app.store import RunStore
from app.timings.analysis import derive
from app.timings.recorder import SpanRecorder, activate
from tests.conftest import make_settings


def make_service(tmp_path, **overrides) -> RunService:
    settings = make_settings(tmp_path, **overrides)
    return RunService(settings, RunStore(settings.db_path))


def request(task: str = SAMPLE_TASK_ID, **limits) -> RunRequest:
    return RunRequest(goal="run the catalog task", demo_task=task, limits=Limits(**limits))


def spans(snapshot: dict) -> dict[int, dict]:
    return {span["id"]: span for span in snapshot["spans"]}


def of_kind(snapshot: dict, kind: str) -> list[dict]:
    return [span for span in snapshot["spans"] if span["kind"] == kind]


def one(snapshot: dict, kind: str) -> dict:
    [span] = of_kind(snapshot, kind)
    return span


async def wait_for_event(store, run_id: str, kind: str, within: float = 20.0) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + within
    while not any(event.kind == kind for event in store.get_events(run_id)):
        assert loop.time() < deadline, f"no {kind} event"
        await asyncio.sleep(0.01)


# ----------------------------------------------------------------------
# lifecycle
# ----------------------------------------------------------------------
async def test_a_run_records_its_lifecycle_phases_in_order(tmp_path):
    service = make_service(tmp_path)
    record = await service.run_request(request())
    snapshot = service.timings_for(record.run_id)
    assert record.status == "completed" and snapshot["enabled"] is True
    lifecycle, admission = one(snapshot, "lifecycle"), one(snapshot, "admission")
    execution, setup = one(snapshot, "execution"), one(snapshot, "setup")
    graph, finalization = one(snapshot, "graph"), one(snapshot, "finalization")
    assert lifecycle["parent"] is None
    assert {admission["parent"], execution["parent"], finalization["parent"]} == {lifecycle["id"]}
    assert setup["parent"] == graph["parent"] == execution["id"]
    # One clock: each phase starts where (or after) the previous one ended.
    assert lifecycle["start_ns"] == admission["start_ns"] == 0
    assert admission["end_ns"] == execution["start_ns"] == setup["start_ns"]
    assert setup["end_ns"] <= graph["start_ns"] <= graph["end_ns"] <= execution["end_ns"]
    assert execution["end_ns"] <= finalization["start_ns"] <= finalization["end_ns"] <= lifecycle["end_ns"]
    assert lifecycle["attrs"]["outcome"] == execution["attrs"]["outcome"] == "completed"
    assert all(span["end_ns"] is not None for span in snapshot["spans"])
    values = derive(snapshot).values
    for phase in ("lifecycle_ms", "admission_ms", "execution_ms", "setup_ms", "graph_ms", "finalization_ms"):
        assert values[phase] is not None and values[phase] >= 0
    assert values["lifecycle_ms"] >= values["execution_ms"] >= values["graph_ms"]


async def test_every_node_runs_in_a_node_span_under_the_graph(tmp_path):
    service = make_service(tmp_path)
    record = await service.run_request(request())
    snapshot = service.timings_for(record.run_id)
    graph = one(snapshot, "graph")
    nodes = of_kind(snapshot, "node")
    assert all(node["parent"] == graph["id"] for node in nodes)
    names = {node["attrs"]["node"] for node in nodes}
    assert {"planner", "code_step", "advance", "review", "verify", "finalize"} <= names
    by_id = spans(snapshot)
    for step in (node for node in nodes if node["attrs"]["node"] == "code_step"):
        dispatch = by_id[step["attrs"]["dispatch_id"]]
        assert dispatch["kind"] == "dispatch" and dispatch["start_ns"] <= step["start_ns"]
        kids = [span for span in snapshot["spans"] if span["parent"] == step["id"]]
        assert {"step.schedule_delay", "step.checkout"} <= {kid["kind"] for kid in kids}
        delay = next(kid for kid in kids if kid["kind"] == "step.schedule_delay")
        assert (delay["start_ns"], delay["end_ns"]) == (dispatch["start_ns"], step["start_ns"])


async def test_verification_is_timed_on_its_thread(tmp_path):
    service = make_service(tmp_path)
    record = await service.run_request(request())
    snapshot = service.timings_for(record.run_id)
    by_id = spans(snapshot)
    [run] = [span for span in of_kind(snapshot, "verify.run") if span["attrs"]["diagnostic"] is False]
    [process] = [span for span in of_kind(snapshot, "verify.process") if span["parent"] == run["id"]]
    assert by_id[run["parent"]]["attrs"]["node"] == "verify"
    assert process["attrs"]["outcome"] == "ok"
    assert run["start_ns"] <= process["start_ns"] <= process["end_ns"] <= run["end_ns"]
    assert of_kind(snapshot, "verify.thread_wait")[0]["parent"] == run["parent"]
    assert derive(snapshot).values["verification_ms"] > 0


# ----------------------------------------------------------------------
# waves
# ----------------------------------------------------------------------
async def test_a_parallel_wave_is_one_dispatch_of_several_steps(tmp_path):
    service = make_service(tmp_path)
    record = await service.run_request(request(PIPELINE_TASK_ID))
    snapshot = service.timings_for(record.run_id)
    waves: dict[int, list[dict]] = {}
    for step in (n for n in of_kind(snapshot, "node") if n["attrs"]["node"] == "code_step"):
        waves.setdefault(step["attrs"]["dispatch_id"], []).append(step)
    assert max(len(steps) for steps in waves.values()) >= 2
    assert one(snapshot, "graph")["attrs"]["parallel_coding"] is True
    derived = derive(snapshot)
    assert derived.values["coder_busy_ms"] >= derived.values["coder_wall_ms"] > 0
    assert derived.values["coder_critical_path_ms"] is not None
    assert derived.reasons["slot_wait_ms"] == "parallel coding: no coding slot"
    assert of_kind(snapshot, "call.slot_wait") == []


async def test_sequential_coding_times_each_steps_wait_for_the_slot(tmp_path):
    service = make_service(tmp_path)
    record = await service.run_request(request(PIPELINE_TASK_ID, parallel_coding=False))
    snapshot = service.timings_for(record.run_id)
    assert record.status == "completed"
    assert one(snapshot, "graph")["attrs"]["parallel_coding"] is False
    steps = [n for n in of_kind(snapshot, "node") if n["attrs"]["node"] == "code_step"]
    waits = of_kind(snapshot, "call.slot_wait")
    assert len(waits) == len(steps)
    assert {wait["parent"] for wait in waits} == {step["id"] for step in steps}
    assert derive(snapshot).values["slot_wait_ms"] is not None


# ----------------------------------------------------------------------
# cancellation
# ----------------------------------------------------------------------
async def test_a_run_cancelled_in_flight_closes_every_span(tmp_path, monkeypatch):
    original = DemoProvider.complete

    async def slow(self, request_):
        await asyncio.sleep(0.5)
        return await original(self, request_)

    monkeypatch.setattr(DemoProvider, "complete", slow)
    service = make_service(tmp_path)
    record, task = service.start(request())
    await wait_for_event(service.store, record.run_id, "agent_started")
    assert service.cancel(record.run_id)
    with pytest.raises(asyncio.CancelledError):
        await task
    snapshot = service.timings_for(record.run_id)
    assert all(span["end_ns"] is not None for span in snapshot["spans"])
    assert one(snapshot, "execution")["attrs"]["outcome"] == "cancelled"
    assert one(snapshot, "lifecycle")["attrs"]["outcome"] == "cancelled"
    assert one(snapshot, "graph")["attrs"]["outcome"] == "cancelled"
    assert one(snapshot, "finalization")["end_ns"] is not None
    assert any(n["attrs"].get("outcome") == "cancelled" for n in of_kind(snapshot, "node"))
    values = derive(snapshot).values
    assert values["execution_ms"] is not None and values["lifecycle_ms"] >= values["execution_ms"]


async def test_a_run_cancelled_before_it_started_is_admission_only(tmp_path):
    service = make_service(tmp_path)
    record, task = service.start(request())
    assert service.cancel(record.run_id)  # before the task ever ran
    with pytest.raises(asyncio.CancelledError):
        await task
    snapshot = service.timings_for(record.run_id)
    assert [span["kind"] for span in snapshot["spans"]] == ["lifecycle", "admission"]
    lifecycle = one(snapshot, "lifecycle")
    assert lifecycle["attrs"] == {"outcome": "cancelled", "reason": "never_started"}
    derived = derive(snapshot)
    assert derived.values["lifecycle_ms"] == derived.values["admission_ms"]
    for phase in ("execution_ms", "setup_ms", "graph_ms"):
        assert derived.reasons[phase] == "never started"


# ----------------------------------------------------------------------
# recording never changes a run
# ----------------------------------------------------------------------
async def test_the_trace_is_the_same_with_and_without_timings(tmp_path):
    traces = []
    for enabled in (True, False):
        service = make_service(tmp_path / str(enabled), timings_enabled=enabled)
        record = await service.run_request(request(PIPELINE_TASK_ID))
        events = service.store.get_events(record.run_id)
        assert [event.seq for event in events] == list(range(1, len(events) + 1))
        traces.append((record.status, [event.kind for event in events]))
        snapshot = service.timings_for(record.run_id)
        assert snapshot["enabled"] is enabled
        assert (snapshot["spans"] == []) is (not enabled)
    assert traces[0] == traces[1]


async def test_a_failing_recorder_never_fails_the_run(tmp_path, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("recorder broke")

    monkeypatch.setattr(SpanRecorder, "_add", broken)
    service = make_service(tmp_path)
    record = await service.run_request(request(PIPELINE_TASK_ID))
    assert record.status == "completed"
    snapshot = service.timings_for(record.run_id)
    assert snapshot["spans"] == [] and snapshot["instrumentation_errors"] > 0


async def test_a_crashed_run_closes_its_phases_as_failed(tmp_path, monkeypatch):
    async def crash(self, record):
        raise RuntimeError("orchestrator bug")

    monkeypatch.setattr(service_module.Orchestrator, "run", crash)
    service = make_service(tmp_path)
    record = await service.run_request(request())
    assert record.status == "failed"
    snapshot = service.timings_for(record.run_id)
    assert all(span["end_ns"] is not None for span in snapshot["spans"])
    assert one(snapshot, "setup")["attrs"]["outcome"] == "error"
    assert one(snapshot, "execution")["attrs"]["outcome"] == "error"
    assert one(snapshot, "lifecycle")["attrs"]["outcome"] == "failed"
    assert one(snapshot, "finalization")["end_ns"] is not None
    assert derive(snapshot).reasons["graph_ms"] == "not recorded"


async def test_diagnostic_verification_is_marked_as_diagnostic(build_run):
    orchestrator, runtime, _ = build_run(DemoProvider(), demo_task=SAMPLE_TASK_ID)
    recorder = SpanRecorder()
    runtime.timings = recorder
    try:
        with activate(recorder):
            with recorder.span("node", node="review"):
                result, _ = await orchestrator._run_verifier(
                    verification_id="ver_diag", attempt=None, diagnostic=True
                )
    finally:
        runtime.cleanup()
    assert result is not None
    snapshot = recorder.snapshot()
    run = one(snapshot, "verify.run")
    assert run["attrs"]["diagnostic"] is True
    assert one(snapshot, "verify.process")["parent"] == run["id"]
    derived = derive(snapshot)
    assert derived.values["diagnostic_verification_ms"] is not None
    assert derived.reasons["verification_ms"] == "no verification ran"


def test_a_verification_timeout_and_a_failed_start_are_recorded(tmp_path):
    workspace = Workspace(tmp_path / "ws", allowed_commands={"python", "missing-binary-xyz"})
    (workspace.root / "sleep.py").write_text("import time\ntime.sleep(10)\n", encoding="utf-8")
    recorder = SpanRecorder()
    with activate(recorder):
        timed_out = workspace.run_command("python sleep.py", timeout_seconds=1)
        not_started = workspace.run_command("missing-binary-xyz --version", timeout_seconds=5)
    assert timed_out.exit_code == 124 and not_started.exit_code == 126
    outcomes = [span["attrs"]["outcome"] for span in of_kind(recorder.snapshot(), "verify.process")]
    assert outcomes == ["timeout", "error"]
    assert all(span["end_ns"] is not None for span in recorder.snapshot()["spans"])


def test_verification_outside_a_measured_run_records_nothing(tmp_path):
    workspace = Workspace(tmp_path / "ws", allowed_commands={"missing-binary-xyz"})
    result = workspace.run_command("missing-binary-xyz", timeout_seconds=5)
    assert result.exit_code == 126  # unchanged behaviour, nowhere to record


def test_only_the_most_recent_snapshots_are_kept(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "RECENT_TIMINGS", 2)
    service = make_service(tmp_path)
    for run_id in ("run_a", "run_b", "run_c"):
        service._keep_timings(run_id, SpanRecorder())
    assert service.timings_for("run_a") is None
    assert service.timings_for("run_b") is not None and service.timings_for("run_c") is not None
