"""The trace event contract the frontend's event reducer relies on (M3.0)."""

from __future__ import annotations

import json

import pytest

from app.demo_tasks import SAMPLE_TASK_ID
from app.models import Limits
from app.providers.base import ProviderAuthError
from tests.conftest import (
    PLAN_THREE_STEPS,
    SEED_OK,
    TARGET_IMPLEMENTATION,
    ScriptedProvider,
    plan_response,
    review_response,
)

ROLES = {"planner", "coder", "reviewer", "verifier"}


def failures(result) -> list:
    return [event for event in result.events if event.kind == "failure"]


def assert_normalised(event) -> None:
    """Every failure carries an error, and only known optional context."""
    payload = event.payload
    assert isinstance(payload["error"], str) and payload["error"]
    assert payload.get("role") in ROLES | {None}
    assert payload.get("step_id") is None or isinstance(payload["step_id"], str)
    assert payload.get("attempt") is None or isinstance(payload["attempt"], int)
    assert payload.get("error_class") is None or isinstance(payload["error_class"], str)
    assert "steps" not in payload  # the old multi-step shape is gone


def coder_writing(changes_for):
    """Approve everything; the coder's answer comes from ``changes_for(step_id)``."""

    def handler(request, index):
        if request.role == "planner":
            return plan_response(PLAN_THREE_STEPS)
        if request.role == "coder":
            step_id = json.loads(request.user)["step"]["id"]
            return json.dumps(
                {
                    "step_id": step_id,
                    "summary": "scripted change",
                    "rationale": "r",
                    "changes": changes_for(step_id),
                }
            )
        return review_response("approve")

    return handler


# ----------------------------------------------------------------------
# plan structure
# ----------------------------------------------------------------------
def plan_event(result):
    (event,) = [
        e for e in result.events
        if e.kind == "routing_decision"
        and e.payload.get("decision") in {"plan_accepted", "plan_seeded"}
    ]
    return event


def assert_waves_respect_dependencies(payload) -> None:
    deps = {step["id"]: step["depends_on"] for step in payload["plan"]["steps"]}
    wave_of = {step: index for index, wave in enumerate(payload["waves"]) for step in wave}
    assert set(wave_of) == set(deps) == set(payload["steps"])
    for step, needs in deps.items():
        assert all(wave_of[dep] < wave_of[step] for dep in needs)


async def test_generated_plan_event_carries_dependencies_and_waves(build_run):
    provider = ScriptedProvider(coder_writing(lambda step: [{"path": f"out/{step}.txt", "content": "x"}]))
    orchestrator, _, record = build_run(provider, files=SEED_OK)
    result = await orchestrator.run(record)

    payload = plan_event(result).payload
    assert payload["decision"] == "plan_accepted"
    deps = {step["id"]: step["depends_on"] for step in payload["plan"]["steps"]}
    assert deps == {"alpha": [], "beta": [], "gamma": ["alpha", "beta"]}
    assert payload["waves"] == [["alpha", "beta"], ["gamma"]]
    assert payload["plan"]["steps"][0]["target_files"] == ["out/alpha.txt"]
    assert_waves_respect_dependencies(payload)

    # The first dispatch really ran the first wave in parallel.
    dispatch = next(
        e for e in result.events
        if e.kind == "routing_decision" and e.payload.get("decision") == "dispatch_coding"
    )
    assert dispatch.payload["steps"] == payload["waves"][0]
    assert dispatch.payload["parallel"] is True


async def test_seeded_plan_event_carries_the_recipe_dependencies(build_run):
    from app.demo_tasks import PIPELINE_TASK_ID
    from app.providers.demo import DemoProvider

    orchestrator, _, record = build_run(DemoProvider(), demo_task=PIPELINE_TASK_ID)
    result = await orchestrator.run(record)

    payload = plan_event(result).payload
    assert payload["decision"] == "plan_seeded"
    document = next(s for s in payload["plan"]["steps"] if s["id"] == "document_change")
    assert document["depends_on"] == ["inspect_tests", "draft_implementation"]
    assert payload["waves"] == [["inspect_tests", "draft_implementation"], ["document_change"]]
    assert_waves_respect_dependencies(payload)


async def test_dependency_chain_yields_one_step_per_wave(build_run):
    chain = {
        "steps": [
            {"id": "first", "title": "First", "detail": "write first", "acceptance_criteria": ["done"],
             "depends_on": [], "target_files": ["out/first.txt"]},
            {"id": "second", "title": "Second", "detail": "write second", "acceptance_criteria": ["done"],
             "depends_on": ["first"], "target_files": ["out/second.txt"]},
            {"id": "third", "title": "Third", "detail": "write third", "acceptance_criteria": ["done"],
             "depends_on": ["second"], "target_files": ["out/third.txt"]},
        ]
    }

    def handler(request, index):
        if request.role == "planner":
            return plan_response(chain)
        if request.role == "coder":
            step_id = json.loads(request.user)["step"]["id"]
            return json.dumps({"step_id": step_id, "summary": "done",
                               "changes": [{"path": f"out/{step_id}.txt", "content": "x"}]})
        return review_response("approve")

    orchestrator, _, record = build_run(ScriptedProvider(handler), files=SEED_OK)
    result = await orchestrator.run(record)

    payload = plan_event(result).payload
    assert payload["waves"] == [["first"], ["second"], ["third"]]
    assert_waves_respect_dependencies(payload)
    dispatches = [
        e.payload for e in result.events
        if e.kind == "routing_decision" and e.payload.get("decision") == "dispatch_coding"
    ]
    assert [d["steps"] for d in dispatches] == [["first"], ["second"], ["third"]]
    assert not any(d["parallel"] for d in dispatches)


# ----------------------------------------------------------------------
# normalised failure events
# ----------------------------------------------------------------------
async def test_disallowed_write_failure_is_normalised(build_run):
    def handler(request, index):
        if request.role == "coder":
            return json.dumps(
                {
                    "step_id": "draft_implementation",
                    "summary": "edits the tests",
                    "changes": [{"path": "tests/test_target.py", "content": "x", "action": "update"}],
                }
            )
        return review_response("approve")

    orchestrator, _, record = build_run(ScriptedProvider(handler), demo_task=SAMPLE_TASK_ID)
    result = await orchestrator.run(record)

    (event,) = failures(result)
    assert_normalised(event)
    assert event.payload["role"] == "coder"
    assert event.payload["step_id"] == "draft_implementation"
    assert event.payload["attempt"] == 1
    assert event.payload["error_class"] == "write_not_allowed"
    assert event.payload["paths"] == ["tests/test_target.py"]


async def test_parallel_conflict_emits_one_failure_per_step(build_run):
    provider = ScriptedProvider(
        coder_writing(lambda step: [{"path": "out/shared.txt", "content": step, "action": "create"}])
    )
    orchestrator, _, record = build_run(
        provider, files=SEED_OK, limits=Limits(max_retries=0, max_escalations=0)
    )
    result = await orchestrator.run(record)

    conflicts = [e for e in failures(result) if e.payload.get("error_class") == "write_conflict"]
    assert sorted(e.payload["step_id"] for e in conflicts) == ["alpha", "beta"]
    for event in conflicts:
        assert_normalised(event)
        assert event.payload["role"] == "coder"
        assert event.payload["paths"] == ["out/shared.txt"]
        partner = {"alpha": "beta", "beta": "alpha"}[event.payload["step_id"]]
        assert event.payload["conflicting_steps"] == [partner]


@pytest.mark.parametrize(
    "answer, error_class",
    [
        (lambda step: {"step_id": "someone_else", "changes": []}, "wrong_step"),
        (
            lambda step: {
                "step_id": step,
                "changes": [
                    {"path": f"out/{step}_{n}.txt", "content": "x", "action": "create"}
                    for n in range(21)
                ],
            },
            "too_many_files",
        ),
        (
            lambda step: {
                "step_id": step,
                "changes": [{"path": "out/big.txt", "content": "x" * 200_001, "action": "create"}],
            },
            "file_too_large",
        ),
    ],
)
async def test_previously_silent_coding_rejections_now_emit_failures(build_run, answer, error_class):
    def handler(request, index):
        if request.role == "planner":
            return plan_response(PLAN_THREE_STEPS)
        if request.role == "coder":
            step_id = json.loads(request.user)["step"]["id"]
            return json.dumps({"summary": "scripted", **answer(step_id)})
        return review_response("approve")

    orchestrator, _, record = build_run(
        ScriptedProvider(handler), files=SEED_OK, limits=Limits(max_retries=0, max_escalations=0)
    )
    result = await orchestrator.run(record)

    matching = [e for e in failures(result) if e.payload.get("error_class") == error_class]
    assert matching, [e.payload for e in failures(result)]
    for event in matching:
        assert_normalised(event)
        assert event.payload["role"] == "coder"
        assert event.payload["step_id"] in {"alpha", "beta"}
        assert event.payload["attempt"] == 1


async def test_verification_failure_is_attributed_to_the_verifier(build_run):
    failing = {"tests/test_fail.py": "def test_fail():\n    assert False\n"}
    provider = ScriptedProvider(coder_writing(lambda step: [{"path": f"out/{step}.txt", "content": "x"}]))
    orchestrator, _, record = build_run(
        provider, files=failing, limits=Limits(max_retries=0, max_escalations=0)
    )
    result = await orchestrator.run(record)

    (event,) = [e for e in failures(result) if e.payload.get("error_class") == "verification_failed"]
    assert_normalised(event)
    assert event.payload["role"] == "verifier"
    assert event.payload["attempt"] == 1
    assert event.payload.get("step_id") is None  # verification covers the whole workspace
    assert event.payload["tests_failed"] == 1


async def test_invalid_review_failure_is_attributed_to_the_reviewer(build_run):
    def handler(request, index):
        if request.role == "coder":
            return json.dumps(
                {
                    "step_id": "draft_implementation",
                    "summary": "implemented",
                    "changes": [{"path": "target.py", "content": TARGET_IMPLEMENTATION}],
                }
            )
        return review_response(
            "request_changes",
            [{"severity": "blocker", "file": "target.py", "message": "Wrong."}],
        )

    orchestrator, _, record = build_run(ScriptedProvider(handler), demo_task=SAMPLE_TASK_ID)
    result = await orchestrator.run(record)

    (event,) = [e for e in failures(result) if e.payload.get("error_class") == "review_invalid"]
    assert_normalised(event)
    assert event.payload["role"] == "reviewer"
    assert event.payload["attempt"] == 1
    assert event.payload.get("step_id") is None
    assert event.payload["error"] == result.record.error


async def test_provider_failure_carries_role_and_category(build_run):
    def handler(request, index):
        return ProviderAuthError("bad key", status_code=401)

    orchestrator, _, record = build_run(ScriptedProvider(handler), files=SEED_OK)
    result = await orchestrator.run(record)

    (event,) = failures(result)
    assert_normalised(event)
    assert event.payload["role"] == "planner"
    assert event.payload["error_class"] == "auth"
    assert event.payload["attempt"] == 1


async def test_unparseable_output_failure_is_normalised(build_run):
    provider = ScriptedProvider(lambda request, index: "not json at all")
    orchestrator, _, record = build_run(provider, files=SEED_OK, limits=Limits(max_retries=0))
    result = await orchestrator.run(record)

    (event,) = failures(result)
    assert_normalised(event)
    assert event.payload["role"] == "planner"
    assert event.payload["error_class"] == "invalid_response"


async def test_orchestration_failure_names_no_agent_or_step(build_run, monkeypatch):
    from app.orchestrator import Orchestrator

    async def broken(self, state):
        raise RuntimeError("scheduler bug")

    # Patched before build_run compiles the graph, which binds self._advance.
    monkeypatch.setattr(Orchestrator, "_advance", broken)
    provider = ScriptedProvider(coder_writing(lambda step: []))
    orchestrator, _, record = build_run(provider, files=SEED_OK)
    result = await orchestrator.run(record)

    (event,) = failures(result)
    assert_normalised(event)
    assert event.payload["error_class"] == "graph_error"
    assert "scheduler bug" in event.payload["error"]
    for key in ("role", "step_id", "attempt"):
        assert event.payload.get(key) is None


# ----------------------------------------------------------------------
# lifecycle events and ordering
# ----------------------------------------------------------------------
def of_kind(result, kind: str) -> list:
    return [event for event in result.events if event.kind == kind]


def approving():
    return coder_writing(lambda step: [{"path": f"out/{step}.txt", "content": "x"}])


def assert_agent_pairs(result) -> None:
    """Every completion has exactly one earlier start with the same identity."""
    starts = {e.payload["invocation_id"]: e for e in of_kind(result, "agent_started")}
    completions = of_kind(result, "agent_invocation")
    assert len(starts) == len(of_kind(result, "agent_started"))  # ids are unique
    assert {e.payload["invocation_id"] for e in completions} == set(starts)
    for done in completions:
        start = starts[done.payload["invocation_id"]]
        assert start.seq < done.seq
        for key in ("role", "step_id", "attempt", "model", "tier"):
            assert start.payload[key] == done.payload[key], key


async def test_every_trace_is_numbered_one_to_n(build_run):
    orchestrator, _, record = build_run(ScriptedProvider(approving(), delay=0.02), files=SEED_OK)
    result = await orchestrator.run(record)
    assert [e.seq for e in result.events] == list(range(1, len(result.events) + 1))


async def test_agent_starts_pair_with_completions(build_run):
    orchestrator, _, record = build_run(ScriptedProvider(approving()), files=SEED_OK)
    result = await orchestrator.run(record)

    assert_agent_pairs(result)
    roles = [e.payload["role"] for e in of_kind(result, "agent_started")]
    assert roles == ["planner", "coder", "coder", "coder", "reviewer"]
    # Control nodes and the deterministic verifier are never reported as agents.
    assert set(roles) <= {"planner", "coder", "reviewer"}
    start = of_kind(result, "agent_started")[0]
    assert start.payload["started_at"]
    assert start.payload["model"] == "demo-fast"


async def test_parallel_agents_start_before_either_finishes(build_run):
    provider = ScriptedProvider(approving(), delay=0.05)
    orchestrator, _, record = build_run(provider, files=SEED_OK)
    result = await orchestrator.run(record)

    events = result.events
    started = {e.payload["step_id"]: e.seq for e in of_kind(result, "agent_started") if e.payload["role"] == "coder"}
    finished = {e.payload["step_id"]: e.seq for e in of_kind(result, "agent_invocation") if e.payload["role"] == "coder"}
    first_wave_done = min(finished["alpha"], finished["beta"])
    assert started["alpha"] < first_wave_done and started["beta"] < first_wave_done
    # The dependent step starts only after the merge of the first wave.
    merge = next(e.seq for e in events if e.payload.get("decision") == "merge_wave")
    assert started["gamma"] > merge


async def test_serial_coding_starts_one_agent_at_a_time(build_run):
    provider = ScriptedProvider(approving(), delay=0.02)
    orchestrator, _, record = build_run(
        provider, files=SEED_OK, limits=Limits(parallel_coding=False)
    )
    result = await orchestrator.run(record)

    coder_events = [
        (e.kind, e.payload["step_id"])
        for e in result.events
        if e.kind in {"agent_started", "agent_invocation"} and e.payload.get("role") == "coder"
    ]
    # start, finish, start, finish ...: dispatched together, executed in turn.
    kinds = [kind for kind, _ in coder_events]
    assert kinds == ["agent_started", "agent_invocation"] * 3
    dispatch = next(e for e in result.events if e.payload.get("decision") == "dispatch_coding")
    assert dispatch.payload["steps"] == ["alpha", "beta"]
    assert dispatch.payload["parallel"] is False


async def test_each_retry_attempt_has_its_own_start(build_run):
    from app.providers.base import ProviderTimeoutError

    def handler(request, index):
        if index == 1:
            return ProviderTimeoutError("slow")
        return approving()(request, index)

    orchestrator, _, record = build_run(ScriptedProvider(handler), files=SEED_OK)
    result = await orchestrator.run(record)

    planner_starts = [e.payload for e in of_kind(result, "agent_started") if e.payload["role"] == "planner"]
    assert [p["attempt"] for p in planner_starts] == [1, 2]
    assert_agent_pairs(result)


async def test_a_refused_call_never_starts(build_run):
    orchestrator, _, record = build_run(
        ScriptedProvider(approving()), files=SEED_OK, limits=Limits(max_agent_calls=1)
    )
    result = await orchestrator.run(record)

    assert result.record.status == "limit_exceeded"
    assert [e.payload["role"] for e in of_kind(result, "agent_started")] == ["planner"]
    assert_agent_pairs(result)


async def test_verification_start_pairs_with_its_result(build_run):
    orchestrator, _, record = build_run(ScriptedProvider(approving()), files=SEED_OK)
    result = await orchestrator.run(record)

    (start,) = of_kind(result, "verification_started")
    (done,) = of_kind(result, "verification")
    assert start.seq < done.seq
    assert start.payload["verification_id"] == done.payload["verification_id"]
    assert start.payload["runner"] == "deterministic_subprocess"
    assert start.payload["role"] == "verifier"
    assert start.payload["diagnostic"] is False and done.payload["diagnostic"] is False
    assert start.payload["attempt"] == done.payload["attempt"] == 1
    assert start.payload["command"] == "python -m pytest -q"
    # Verification started only after the reviewer approved.
    review_done = next(e.seq for e in of_kind(result, "agent_invocation") if e.payload["role"] == "reviewer")
    assert start.seq > review_done


async def test_diagnostic_verification_has_a_paired_start(build_run):
    def handler(request, index):
        if request.role == "coder":
            return json.dumps(
                {"step_id": "draft_implementation", "summary": "implemented",
                 "changes": [{"path": "target.py", "content": TARGET_IMPLEMENTATION}]}
            )
        return review_response("request_changes", [{"severity": "blocker", "message": "Wrong."}])

    orchestrator, _, record = build_run(ScriptedProvider(handler), demo_task=SAMPLE_TASK_ID)
    result = await orchestrator.run(record)

    (start,) = of_kind(result, "verification_started")
    (done,) = of_kind(result, "verification")
    assert start.payload["diagnostic"] is True and done.payload["diagnostic"] is True
    assert start.payload["attempt"] is None
    assert start.payload["verification_id"] == done.payload["verification_id"]


async def test_no_verification_starts_after_the_deadline(build_run):
    orchestrator, runtime, record = build_run(ScriptedProvider(approving()), files=SEED_OK)
    runtime.ledger.started_monotonic -= runtime.limits.max_wall_seconds
    await orchestrator._verify({"verification_attempts": 0})
    assert [e for e in runtime.trace.events if e.kind == "verification_started"] == []
