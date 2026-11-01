"""A revision must hand the coder every actionable finding, and nothing else."""

from __future__ import annotations

import json

from app.models import Limits
from tests.conftest import (
    PLAN_THREE_STEPS,
    SEED_OK,
    ScriptedProvider,
    coder_response,
    plan_response,
    review_response,
)

EVIDENCED_ALPHA = (
    'out/alpha.txt:1 holds placeholder text, so "out/alpha.txt exists" is not met '
    "with real content."
)


def scripted(first_review: list[dict]):
    """Plan three steps, reject once with ``first_review``, then approve."""
    reviews = {"count": 0}

    def handler(request, index):
        if request.role == "planner":
            return plan_response(PLAN_THREE_STEPS)
        if request.role == "coder":
            return coder_response(json.loads(request.user)["step"]["id"])
        reviews["count"] += 1
        if reviews["count"] == 1:
            return review_response("request_changes", first_review)
        return review_response("approve")

    return handler


def revision_requests(provider) -> dict[str, list[dict]]:
    """step id -> review_findings received in a revision coding call."""
    received: dict[str, list[dict]] = {}
    for call in provider.calls:
        if call.role != "coder":
            continue
        payload = json.loads(call.user)
        if payload["review_findings"]:
            received[payload["step"]["id"]] = payload["review_findings"]
    return received


async def run(build_run, findings: list[dict]):
    provider = ScriptedProvider(scripted(findings))
    orchestrator, _, record = build_run(
        provider, files=SEED_OK, limits=Limits(max_revisions=1, max_escalations=0)
    )
    return provider, await orchestrator.run(record)


async def test_every_finding_for_a_step_reaches_the_coder(build_run):
    findings = [
        {"severity": "major", "step_id": "alpha", "message": "first problem with alpha"},
        {"severity": "minor", "step_id": "alpha", "message": "second problem with alpha"},
    ]
    provider, result = await run(build_run, findings)

    received = revision_requests(provider)
    assert [f["message"] for f in received["alpha"]] == [
        "first problem with alpha",
        "second problem with alpha",
    ]
    assert result.record.status == "completed"


async def test_findings_without_a_step_reach_every_revised_step(build_run):
    findings = [{"severity": "major", "message": "both outputs need a trailing newline"}]
    provider, _ = await run(build_run, findings)

    received = revision_requests(provider)
    # No step was named, so the earliest wave (alpha and beta) is revised.
    assert set(received) == {"alpha", "beta"}
    for step_findings in received.values():
        assert [f["message"] for f in step_findings] == [
            "both outputs need a trailing newline"
        ]


async def test_unsupported_blockers_are_withheld_from_a_mixed_revision(build_run):
    findings = [
        {"severity": "blocker", "step_id": "alpha", "file": "out/alpha.txt", "message": "Wrong."},
        {"severity": "major", "step_id": "alpha", "file": "out/alpha.txt", "message": EVIDENCED_ALPHA},
    ]
    provider, result = await run(build_run, findings)

    received = revision_requests(provider)
    assert [f["message"] for f in received["alpha"]] == [EVIDENCED_ALPHA]

    (revision,) = [e for e in result.events if e.kind == "revision"]
    assert [f["message"] for f in revision.payload["findings"]] == [EVIDENCED_ALPHA]
    (withheld,) = revision.payload["withheld_blockers"]
    assert withheld["finding"]["message"] == "Wrong."
    assert "code reference or line" in withheld["missing"]
