"""Benchmark metrics over real recorded traces (the frontend's fixtures) and real runs."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from app.benchmarks.arms import get_arm
from app.benchmarks.metrics import (
    P95_MIN_SAMPLE,
    TrialMetrics,
    aggregate,
    distribution,
    percentile,
    trial_metrics,
)
from app.benchmarks.suites import catalog_suite
from app.models import RunRecord, TraceEvent
from app.service import RunService
from app.store import RunStore
from tests.conftest import make_settings

FIXTURES = Path(__file__).resolve().parent.parent / "frontend" / "src" / "domain" / "execution" / "fixtures"


def recorded(name: str, **record_fields) -> tuple[RunRecord, list[TraceEvent]]:
    """A recorded trace and a run record for it (counters as given)."""
    data = json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))
    seed = data["run"]
    # The sanitised fixtures leave run_id off each event; it is the run's.
    events = [TraceEvent.model_validate({"run_id": seed["run_id"], **event}) for event in data["events"]]
    calls = sum(1 for event in events if event.kind == "agent_invocation")
    record = RunRecord(
        run_id=seed["run_id"],
        goal=seed.get("goal") or "recorded trace",
        status=seed["status"],
        provider=seed["provider"],
        provider_kind=seed["provider_kind"] if seed["provider_kind"] in {"demo", "local", "remote"} else "unknown",
        model_policy=seed.get("model_policy") or "config",
        models_by_role=seed.get("models_by_role") or {},
        agent_calls=calls,
        duration_ms=4321,
        **record_fields,
    )
    return record, events


def event(run_id: str, seq: int, kind: str, **payload) -> TraceEvent:
    return TraceEvent(run_id=run_id, seq=seq, kind=kind, message="", payload=payload)


def invocation(run_id: str, seq: int, *, usage: bool, tokens=(10, 2), latency=100) -> TraceEvent:
    return event(
        run_id,
        seq,
        "agent_invocation",
        invocation={
            "usage_available": usage,
            "input_tokens": tokens[0],
            "output_tokens": tokens[1],
            "latency_ms": latency,
        },
    )


def synthetic(status: str = "completed", **fields) -> RunRecord:
    base = {"goal": "synthetic run", "provider": "openai-compatible:remote", "provider_kind": "remote"}
    return RunRecord(status=status, **{**base, **fields})


# ----------------------------------------------------------------------
# outcomes: success and verification are separate facts
# ----------------------------------------------------------------------
def test_a_completed_verified_run_is_a_success_with_a_verification_pass():
    record, events = recorded("demo_pipeline_completed")
    metrics = trial_metrics(record, events)
    assert metrics.outcome == "success"
    assert metrics.task_success is True
    assert metrics.verification_passed is True
    assert metrics.verification_runs == 1


def test_a_diagnostic_verification_is_never_a_verification_pass():
    record, events = recorded("review_invalid")
    metrics = trial_metrics(record, events)
    assert metrics.outcome == "failure"
    assert metrics.task_success is False
    assert metrics.verification_passed is False  # no real verification ran...
    assert metrics.verification_runs == 0
    assert metrics.diagnostic_tests_passed is True  # ...the evidence-only run passed


def test_task_success_and_verification_pass_rates_are_not_conflated():
    passed_but_findings = TrialMetrics(
        run_id="a", status="completed_with_findings", outcome="failure", task_success=False,
        verification_passed=True, provider="p", provider_kind="remote", scripted=False, model_policy="config",
    )
    completed = passed_but_findings.model_copy(
        update={"run_id": "b", "status": "completed", "outcome": "success", "task_success": True}
    )
    summary = aggregate("arm", [passed_but_findings, completed])
    assert summary.task_success_rate == 0.5
    assert summary.verification_pass_rate == 1.0


def test_the_last_real_verification_decides_after_a_repair():
    record, events = recorded("verification_repair")
    metrics = trial_metrics(record, events)
    assert metrics.verification_runs == 2
    assert metrics.verification_passed is True
    assert metrics.repair_rounds == 1
    assert metrics.verification_ms == 1456 + 1306


@pytest.mark.parametrize("name", ["timed_out", "call_limit_exhausted"])
def test_limits_reached_are_failures_not_exclusions(name):
    metrics = trial_metrics(*recorded(name))
    assert metrics.outcome == "failure"
    assert metrics.task_success is False


# ----------------------------------------------------------------------
# exclusions and unfinished runs
# ----------------------------------------------------------------------
def test_a_cancelled_run_is_excluded_with_everything_unknown():
    metrics = trial_metrics(*recorded("cancelled_mid_call"))
    assert metrics.outcome == "excluded"
    assert metrics.excluded_reason == "cancelled"
    assert metrics.task_success is None and metrics.verification_passed is None
    assert metrics.latency_ms is None and metrics.agent_calls is None
    assert "excluded" in metrics.null_reasons["*"]


def test_a_run_interrupted_by_a_restart_is_excluded():
    record = synthetic("failed", duration_ms=0)
    finished = event(record.run_id, 1, "run_finished", status="failed", error="interrupted", recovered=True)
    metrics = trial_metrics(record, [finished])
    assert metrics.outcome == "excluded"
    assert "server stopped" in metrics.excluded_reason


@pytest.mark.parametrize("error_class", ["run_crashed", "graph_error"])
def test_an_orchestration_crash_is_excluded(error_class):
    record = synthetic("failed")
    crash = event(record.run_id, 1, "failure", error="boom", error_class=error_class)
    assert trial_metrics(record, [crash]).outcome == "excluded"


def test_a_provider_failure_is_a_task_failure():
    record = synthetic("failed")
    provider = event(record.run_id, 1, "failure", error="503 from endpoint", error_class="server")
    assert trial_metrics(record, [provider]).outcome == "failure"


def test_an_unfinished_run_is_incomplete():
    metrics = trial_metrics(synthetic("running"), [])
    assert metrics.outcome == "incomplete"
    assert metrics.task_success is None


# ----------------------------------------------------------------------
# counts
# ----------------------------------------------------------------------
def test_retries_count_re_dispatched_steps_and_retried_calls():
    record, events = recorded("retry_escalation", escalations=1)
    metrics = trial_metrics(record, events)
    # Three coder attempts: two re-dispatches; no transient call retries.
    assert metrics.step_retries == 2
    assert metrics.call_retries == 0
    assert metrics.retries == 2
    assert metrics.escalations == 1
    assert metrics.output_repairs == 0

    call_retry = event(record.run_id, 99, "retry", scope="call", role="coder", attempt=1)
    repair = event(record.run_id, 100, "repair", role="coder", attempt=1, error="bad json")
    again = trial_metrics(record, [*events, call_retry, repair])
    assert (again.call_retries, again.retries, again.output_repairs) == (1, 3, 1)


def test_revisions_and_calls_come_from_the_record():
    record, events = recorded("review_revision_completed", revisions=1)
    metrics = trial_metrics(record, events)
    assert metrics.revisions == 1
    assert metrics.agent_calls == record.agent_calls


# ----------------------------------------------------------------------
# tokens, cost and model latency: only when established
# ----------------------------------------------------------------------
def test_a_scripted_run_has_no_tokens_cost_or_model_latency():
    metrics = trial_metrics(*recorded("demo_pipeline_completed"))
    assert metrics.scripted is True
    assert (metrics.input_tokens, metrics.output_tokens, metrics.cost_usd) == (None, None, None)
    assert metrics.model_latency_ms is None
    assert metrics.null_reasons["tokens"].startswith("scripted provider")
    assert metrics.null_reasons["model_latency_ms"].startswith("scripted provider")
    assert metrics.latency_ms == 4321  # the run's wall time is still real


def test_a_real_model_run_with_complete_usage_reports_tokens_but_not_unpriced_cost():
    record, events = recorded("legacy_false_blocker")
    calls = [e.payload["invocation"] for e in events if e.kind == "agent_invocation"]
    assert calls and all(call["usage_available"] for call in calls)
    metrics = trial_metrics(record, events)
    assert metrics.scripted is False
    assert metrics.input_tokens == sum(call["input_tokens"] for call in calls)
    assert metrics.output_tokens == sum(call["output_tokens"] for call in calls)
    assert metrics.model_latency_ms == sum(call["latency_ms"] for call in calls)
    assert metrics.cost_usd is None
    assert "pricing is not configured" in metrics.null_reasons["cost_usd"]


def test_partial_usage_leaves_tokens_unknown():
    record = synthetic(monetary_enforced=True, cost_usd=0.5)
    events = [invocation(record.run_id, 1, usage=True), invocation(record.run_id, 2, usage=False)]
    metrics = trial_metrics(record, events)
    assert metrics.input_tokens is None and metrics.cost_usd is None
    assert metrics.null_reasons["tokens"] == "1 of 2 model calls reported no usage"
    assert (metrics.model_calls, metrics.calls_with_usage) == (2, 1)


def test_cost_is_reported_only_with_complete_usage_and_real_pricing():
    record = synthetic(monetary_enforced=True, cost_usd=0.01234)
    events = [invocation(record.run_id, 1, usage=True), invocation(record.run_id, 2, usage=True)]
    metrics = trial_metrics(record, events)
    assert (metrics.input_tokens, metrics.output_tokens, metrics.cost_usd) == (20, 4, 0.01234)
    assert "cost_usd" not in metrics.null_reasons


# ----------------------------------------------------------------------
# aggregates
# ----------------------------------------------------------------------
def test_nearest_rank_percentiles():
    assert percentile([], 95) is None
    assert percentile([7], 95) == 7
    assert percentile([1, 2], 95) == 2
    assert percentile(list(range(1, 21)), 95) == 19
    assert percentile(list(range(1, 101)), 50) == 50
    with pytest.raises(ValueError):
        percentile([1], 0)
    assert distribution([4, 1, 3, 2]).median == 2.5
    assert distribution([]).n == 0 and distribution([]).median is None


def test_excluded_and_unfinished_trials_are_in_no_denominator():
    success = trial_metrics(*recorded("demo_pipeline_completed"))
    failure = trial_metrics(*recorded("timed_out"))
    cancelled = trial_metrics(*recorded("cancelled_mid_call"))
    running = trial_metrics(synthetic("running"), [])
    summary = aggregate("arm", [success, failure, cancelled, running])
    assert (summary.trials, summary.counted, summary.excluded, summary.incomplete) == (4, 2, 1, 1)
    assert summary.excluded_reasons == {"cancelled": 1}
    assert summary.task_success_rate == 0.5
    assert summary.latency_ms.n == 2


def test_an_arm_with_nothing_counted_reports_unknowns_not_zeros():
    summary = aggregate("arm", [trial_metrics(*recorded("cancelled_mid_call"))])
    assert summary.task_success_rate is None
    assert summary.verification_pass_rate is None
    assert summary.mean_agent_calls is None
    assert summary.latency_ms.median is None
    assert summary.total_cost_usd is None


def test_token_and_cost_means_cover_only_runs_that_established_them():
    priced = synthetic(monetary_enforced=True, cost_usd=0.02)
    partial = synthetic()
    full = trial_metrics(priced, [invocation(priced.run_id, 1, usage=True, tokens=(100, 10))])
    missing = trial_metrics(partial, [invocation(partial.run_id, 1, usage=False)])
    summary = aggregate("arm", [full, missing])
    assert (summary.runs_with_usage, summary.mean_input_tokens, summary.mean_output_tokens) == (1, 100, 10)
    assert (summary.runs_with_cost, summary.mean_cost_usd, summary.total_cost_usd) == (1, 0.02, 0.02)
    assert any("1 of 2 runs" in note for note in summary.notes)


def test_small_samples_and_scripted_runs_are_called_out():
    trials = [trial_metrics(*recorded("demo_pipeline_completed")) for _ in range(3)]
    summary = aggregate("arm", trials)
    assert any("Scripted provider" in note for note in summary.notes)
    assert any(f"fewer than {P95_MIN_SAMPLE}" in note for note in summary.notes)
    assert any("Cost is unknown" in note for note in summary.notes)
    assert summary.runs_with_usage == 0 and summary.mean_input_tokens is None


def test_metrics_of_a_real_catalog_run(tmp_path):
    """End to end: a demo-provider catalog run through the real service."""
    settings = make_settings(tmp_path)
    store = RunStore(tmp_path / "metrics.db")
    try:
        task = catalog_suite().task("sample_tag_normalization")
        record = asyncio.run(RunService(settings, store).run_request(get_arm("parallel").request(task)))
        metrics = trial_metrics(record, store.get_events(record.run_id))
    finally:
        store.close()
    assert metrics.outcome == "success"
    assert metrics.verification_passed is True
    assert metrics.scripted is True
    assert metrics.latency_ms is not None and metrics.latency_ms > 0
    assert metrics.verification_ms is not None and metrics.verification_ms > 0
    assert metrics.input_tokens is None and metrics.cost_usd is None
    assert metrics.agent_calls == record.agent_calls
