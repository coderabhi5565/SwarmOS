"""Agent-call timing: the ledger wait, the provider call on the runner's
clock, each HTTP attempt (count and outcome) inside it, parsing and backoff,
for success, JSON-mode downgrade, server errors with retry, timeouts,
connection errors, unparseable output, deadline abandonment and a refused
call. HTTP is a mock transport; nothing leaves the process."""

from __future__ import annotations

import asyncio
import json
import time

import httpx
import pytest

from app.agents.planner import PlannerAgent
from app.agents.runner import AgentRunner
from app.demo_tasks import SAMPLE_TASK_ID
from app.models import PlannerInput, RunRequest
from app.providers.demo import DemoProvider
from app.runtime.limits import LimitExceeded
from app.service import RunService
from app.store import RunStore
from app.timings.analysis import derive
from app.timings.recorder import SpanRecorder, activate
from tests.conftest import make_settings
from tests.test_provider_adapter import completion, provider_with

GOAL = "Add a function that normalises tags"
PLAN = json.dumps(DemoProvider._plan(GOAL))


def of_kind(snapshot: dict, kind: str) -> list[dict]:
    return [span for span in snapshot["spans"] if span["kind"] == kind]


def children(snapshot: dict, parent: dict, kind: str) -> list[dict]:
    return [span for span in snapshot["spans"] if span["kind"] == kind and span["parent"] == parent["id"]]


async def call_planner(build_run, handler, *, max_attempts: int = 1, before=None):
    """Run one planner call through AgentRunner inside a node span; returns
    (result or exception, snapshot)."""
    _, runtime, _ = build_run(provider_with(handler))
    recorder = SpanRecorder()
    runtime.timings = recorder
    if before is not None:
        before(runtime)
    outcome: object
    try:
        with activate(recorder):
            with recorder.span("node", node="planner"):
                outcome = await AgentRunner(runtime).run(
                    PlannerAgent(), PlannerInput(goal=GOAL), max_attempts=max_attempts
                )
    except LimitExceeded as exc:
        outcome = exc
    finally:
        runtime.cleanup()
    return outcome, recorder.snapshot()


# ----------------------------------------------------------------------
async def test_a_successful_call_has_one_attempt_and_a_parse(build_run):
    result, snapshot = await call_planner(build_run, lambda request: httpx.Response(200, json=completion(PLAN)))
    assert result.output is not None
    [call] = of_kind(snapshot, "call")
    [attempt] = children(snapshot, call, "call.http_attempt")
    [parse] = of_kind(snapshot, "call.parse")
    [ledger] = of_kind(snapshot, "call.ledger_wait")
    assert call["attrs"] == {"role": "planner", "attempt": 1, "tier": "fast", "outcome": "ok"}
    assert attempt["attrs"]["outcome"] == "ok"
    assert call["start_ns"] <= attempt["start_ns"] <= attempt["end_ns"] <= call["end_ns"]
    # Parse and the ledger wait are siblings of the call, linked by labels.
    assert parse["parent"] == call["parent"] == ledger["parent"]
    assert parse["start_ns"] >= call["end_ns"] and ledger["end_ns"] <= call["start_ns"]
    derived = derive(snapshot)
    assert derived.values["http_attempts"] == 1
    assert derived.calls[0]["parse_ms"] is not None


async def test_a_json_mode_downgrade_is_two_attempts_in_one_call(build_run):
    def handler(request: httpx.Request) -> httpx.Response:
        if "response_format" in json.loads(request.content):
            return httpx.Response(400, json={"error": "response_format is not supported by this server"})
        return httpx.Response(200, json=completion(PLAN))

    result, snapshot = await call_planner(build_run, handler)
    assert result.output is not None
    [call] = of_kind(snapshot, "call")
    attempts = children(snapshot, call, "call.http_attempt")
    assert [a["attrs"]["outcome"] for a in sorted(attempts, key=lambda a: a["start_ns"])] == ["json_mode_rejected", "ok"]
    derived = derive(snapshot)
    assert derived.calls[0]["http_attempts"] == 2
    # Sequential attempts inside one call: busy equals wall, and neither exceeds the call.
    busy, wall = derived.values["http_attempt_ms"], derived.values["http_attempt_wall_ms"]
    assert busy == pytest.approx(sum(derived.calls[0]["http_attempt_ms"]), abs=0.002)
    assert wall == pytest.approx(busy, abs=0.002)
    assert wall <= derived.values["call_wall_ms"] == derived.values["call_ms"]
    assert derived.values["provider_calls"] == 1


async def test_a_server_error_is_retried_after_a_timed_backoff(build_run):
    answers = iter([httpx.Response(503, json={"error": "overloaded"}), httpx.Response(200, json=completion(PLAN))])
    result, snapshot = await call_planner(build_run, lambda request: next(answers), max_attempts=2)
    assert result.output is not None
    calls = sorted(of_kind(snapshot, "call"), key=lambda c: c["start_ns"])
    assert [c["attrs"]["outcome"] for c in calls] == ["server", "ok"]
    assert [c["attrs"]["attempt"] for c in calls] == [1, 2]
    assert children(snapshot, calls[0], "call.http_attempt")[0]["attrs"]["outcome"] == "http_5xx"
    [backoff] = of_kind(snapshot, "call.backoff")
    assert calls[0]["end_ns"] <= backoff["start_ns"] <= backoff["end_ns"] <= calls[1]["start_ns"]
    assert len(of_kind(snapshot, "call.parse")) == 1  # only the answer that arrived


@pytest.mark.parametrize(
    "error, call_outcome, attempt_outcome",
    [
        (httpx.ReadTimeout("slow"), "timeout", "timeout"),
        (httpx.ConnectError("refused"), "connection", "connect"),
    ],
)
async def test_a_transport_failure_is_one_failed_call(build_run, error, call_outcome, attempt_outcome):
    def handler(request: httpx.Request) -> httpx.Response:
        raise error

    result, snapshot = await call_planner(build_run, handler)
    assert result.output is None
    [call] = of_kind(snapshot, "call")
    assert call["attrs"]["outcome"] == call_outcome and call["end_ns"] is not None
    assert children(snapshot, call, "call.http_attempt")[0]["attrs"]["outcome"] == attempt_outcome
    assert of_kind(snapshot, "call.parse") == []


async def test_unparseable_output_is_a_failed_parse_then_a_repair(build_run):
    answers = iter([httpx.Response(200, json=completion("not json at all")), httpx.Response(200, json=completion(PLAN))])
    result, snapshot = await call_planner(build_run, lambda request: next(answers), max_attempts=2)
    assert result.output is not None
    parses = sorted(of_kind(snapshot, "call.parse"), key=lambda p: p["start_ns"])
    assert [p["attrs"]["outcome"] for p in parses] == ["invalid_response", "ok"]
    assert len(of_kind(snapshot, "call.backoff")) == 1
    assert [c["attrs"]["outcome"] for c in of_kind(snapshot, "call")] == ["ok", "ok"]


async def test_a_call_abandoned_at_the_deadline(build_run):
    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(5)
        return httpx.Response(200, json=completion(PLAN))

    def nearly_out_of_time(runtime) -> None:
        ledger = runtime.ledger
        ledger.started_monotonic = time.monotonic() - (ledger.max_wall_seconds - 0.3)

    outcome, snapshot = await call_planner(build_run, slow, before=nearly_out_of_time)
    assert isinstance(outcome, LimitExceeded)
    [call] = of_kind(snapshot, "call")
    assert call["attrs"]["outcome"] == "deadline"
    assert children(snapshot, call, "call.http_attempt")[0]["attrs"]["outcome"] == "cancelled"
    assert all(span["end_ns"] is not None for span in snapshot["spans"])


async def test_a_refused_call_has_a_ledger_wait_and_no_call(build_run):
    def exhausted(runtime) -> None:
        runtime.ledger.calls = runtime.ledger.max_calls

    outcome, snapshot = await call_planner(
        build_run, lambda request: httpx.Response(200, json=completion(PLAN)), before=exhausted
    )
    assert isinstance(outcome, LimitExceeded)
    [ledger] = of_kind(snapshot, "call.ledger_wait")
    assert ledger["attrs"]["outcome"] == "error"
    assert of_kind(snapshot, "call") == [] and of_kind(snapshot, "call.http_attempt") == []


async def test_a_scripted_run_has_calls_but_no_http_attempts(tmp_path):
    settings = make_settings(tmp_path)
    service = RunService(settings, RunStore(settings.db_path))
    record = await service.run_request(RunRequest(goal="run the catalog task", demo_task=SAMPLE_TASK_ID))
    snapshot = service.timings_for(record.run_id)
    calls = of_kind(snapshot, "call")
    assert calls and all(call["attrs"]["outcome"] == "ok" for call in calls)
    assert of_kind(snapshot, "call.http_attempt") == []
    assert len(of_kind(snapshot, "call.parse")) == len(calls)
    assert len(of_kind(snapshot, "call.ledger_wait")) == len(calls)
    derived = derive(snapshot)
    assert derived.values["http_attempts"] == 0
    assert derived.values["call_ms"] is not None and derived.values["parse_ms"] is not None
    nodes = {span["id"]: span for span in of_kind(snapshot, "node")}
    assert all(call["parent"] in nodes for call in calls)
