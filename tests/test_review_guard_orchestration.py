"""End-to-end behaviour of the reviewer evidence guard inside the graph.

The guard may only do one thing: stop a rejection that rests entirely on
evidence-less blockers from dispatching a revision. It must never approve,
never escalate, never change verification, and never block a genuine,
evidenced rejection.
"""

from __future__ import annotations

import json

from app.demo_tasks import SAMPLE_TASK_ID
from app.models import Limits
from app.store import RunStore
from tests.conftest import TARGET_IMPLEMENTATION, ScriptedProvider

# Stored reviewer message from run_9038fdabb1b9 (review 2), against correct code.
INCIDENT_BLOCKER = (
    "The implementation in `target.py` does not pass the acceptance criteria. The "
    "tests in `tests/test_target.py` expect the `normalize_tags` function to trim "
    "whitespace, lowercase, drop empty entries, deduplicate, and sort ascending. "
    "However, the current implementation does not meet these expectations."
)

UNSORTED_TARGET = (
    "from collections.abc import Iterable\n\n\n"
    "def normalize_tags(tags: Iterable[str]) -> list[str]:\n"
    '    """Deduplicates but does not sort."""\n'
    "    return list({tag.strip().lower() for tag in tags if tag.strip()})\n"
)

EVIDENCED_SORT_BLOCKER = (
    "target.py:6 `return list({...})` returns [\"python\", \"fastapi\"] instead of "
    "[\"fastapi\", \"python\"], violating \"the returned list is sorted ascending, "
    'not merely deduplicated".'
)


def demo_handler(*, coder_files: list[str], reviews: list[dict]):
    """Script the seeded sample demo: one coder answer and one review per round."""
    calls = {"coder": 0, "reviewer": 0}

    def handler(request, index):
        if request.role == "coder":
            content = coder_files[min(calls["coder"], len(coder_files) - 1)]
            calls["coder"] += 1
            return json.dumps(
                {
                    "step_id": "draft_implementation",
                    "summary": "Implemented normalize_tags",
                    "rationale": "r",
                    "changes": [{"path": "target.py", "content": content, "action": "update"}],
                }
            )
        if request.role == "reviewer":
            review = reviews[min(calls["reviewer"], len(reviews) - 1)]
            calls["reviewer"] += 1
            return json.dumps(review)
        raise AssertionError(f"unexpected role {request.role}")

    return handler


def unsupported_rejection(message: str = INCIDENT_BLOCKER) -> dict:
    return {
        "verdict": "request_changes",
        "rationale": "scripted",
        "findings": [
            {
                "severity": "blocker",
                "step_id": "draft_implementation",
                "file": "target.py",
                "message": message,
            }
        ],
    }


def roles(provider, role: str) -> list:
    return [call for call in provider.calls if call.role == role]


def events_of(result, kind: str) -> list:
    return [event for event in result.events if event.kind == kind]


async def test_unsupported_blocker_ends_the_run_as_review_invalid(build_run):
    provider = ScriptedProvider(
        demo_handler(coder_files=[TARGET_IMPLEMENTATION], reviews=[unsupported_rejection()])
    )
    orchestrator, _, record = build_run(provider, demo_task=SAMPLE_TASK_ID)
    result = await orchestrator.run(record)

    assert result.record.status == "review_invalid"
    # Never approval: the verdict stays a rejection and the run is not completed.
    assert result.record.review is not None
    assert result.record.review.verdict == "request_changes"
    assert result.record.error and "not an approval" in result.record.error

    # No revision was dispatched and no extra calls were spent.
    assert len(roles(provider, "coder")) == 1
    assert len(roles(provider, "reviewer")) == 1
    assert result.record.revisions == 0
    assert events_of(result, "revision") == []

    failures = [e for e in events_of(result, "failure") if "substantiated" in e.message]
    assert len(failures) == 1
    (missing,) = failures[0].payload["missing"]
    assert "code reference or line" in missing["missing"]
    assert "named acceptance criterion" in missing["missing"]

    finished = events_of(result, "run_finished")[0]
    assert finished.payload["status"] == "review_invalid"


async def test_review_invalid_keeps_verification_independent(build_run):
    """Correct code, false blocker: tests pass, yet the status is not upgraded."""
    provider = ScriptedProvider(
        demo_handler(coder_files=[TARGET_IMPLEMENTATION], reviews=[unsupported_rejection()])
    )
    orchestrator, _, record = build_run(provider, demo_task=SAMPLE_TASK_ID)
    result = await orchestrator.run(record)

    verification = result.record.verification
    assert verification is not None
    assert verification.diagnostic is True
    assert verification.passed is True
    assert verification.tests_passed == 3
    assert result.record.status == "review_invalid"
    assert "Verification (diagnostic): passed" in result.record.summary
    assert "does not change the review verdict" in result.record.summary


async def test_review_invalid_with_failing_code_does_not_start_repair(build_run):
    provider = ScriptedProvider(
        demo_handler(coder_files=[UNSORTED_TARGET], reviews=[unsupported_rejection()])
    )
    orchestrator, _, record = build_run(provider, demo_task=SAMPLE_TASK_ID)
    result = await orchestrator.run(record)

    assert result.record.status == "review_invalid"
    assert result.record.verification is not None
    assert result.record.verification.passed is False
    assert len(roles(provider, "coder")) == 1
    modes = [e.payload.get("mode") for e in events_of(result, "routing_decision")]
    assert "repair" not in modes
    assert "revision" not in modes


async def test_review_invalid_does_not_escalate_even_when_escalation_is_available(build_run):
    provider = ScriptedProvider(
        demo_handler(coder_files=[TARGET_IMPLEMENTATION], reviews=[unsupported_rejection()])
    )
    orchestrator, runtime, record = build_run(
        provider,
        demo_task=SAMPLE_TASK_ID,
        limits=Limits(max_revisions=1, max_escalations=1),
        base_url="http://127.0.0.1:1/v1",
        fast_model="fast-model",
        strong_model="strong-model",
    )
    assert runtime.escalation_available
    result = await orchestrator.run(record)

    assert result.record.status == "review_invalid"
    assert result.record.escalations == 0
    assert events_of(result, "escalation") == []


async def test_evidenced_blocker_still_drives_a_revision(build_run):
    """A genuine, evidenced defect is not swallowed by the guard."""
    provider = ScriptedProvider(
        demo_handler(
            coder_files=[UNSORTED_TARGET, TARGET_IMPLEMENTATION],
            reviews=[
                unsupported_rejection(EVIDENCED_SORT_BLOCKER),
                {"verdict": "approve", "rationale": "fixed", "findings": []},
            ],
        )
    )
    orchestrator, _, record = build_run(provider, demo_task=SAMPLE_TASK_ID)
    result = await orchestrator.run(record)

    assert result.record.status == "completed"
    assert result.record.revisions == 1
    assert len(roles(provider, "coder")) == 2
    assert len(roles(provider, "reviewer")) == 2
    assert result.record.verification is not None
    assert result.record.verification.passed is True
    assert result.record.verification.diagnostic is False
    # The coder received the finding that justified the revision.
    revision_request = json.loads(roles(provider, "coder")[1].user)
    assert revision_request["review_findings"][0]["message"] == EVIDENCED_SORT_BLOCKER


async def test_review_invalid_run_round_trips_through_the_store(build_run, tmp_path):
    store = RunStore(tmp_path / "guard.db")
    try:
        provider = ScriptedProvider(
            demo_handler(coder_files=[TARGET_IMPLEMENTATION], reviews=[unsupported_rejection()])
        )
        orchestrator, _, record = build_run(provider, demo_task=SAMPLE_TASK_ID, store=store)
        store.save_run(record)
        result = await orchestrator.run(record)
        store.save_run(result.record)

        loaded = store.get_run(record.run_id)
        assert loaded is not None
        assert loaded.status == "review_invalid"
        assert loaded.review is not None and loaded.review.verdict == "request_changes"
        kinds = [event.kind for event in store.get_events(record.run_id)]
        assert kinds[0] == "run_started" and kinds[-1] == "run_finished"
    finally:
        store.close()
