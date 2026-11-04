"""Benchmark metrics: what a trial's persisted run establishes, and per-arm aggregates.

Pure functions over a ``RunRecord`` and its trace events. Nothing is
estimated: a value the record and trace do not establish is null, with the
reason in ``null_reasons``. In particular:

* **Task success** (the run finished ``completed``) and **verification
  passed** (the run's last non-diagnostic verification passed) are separate
  facts with separate rates. Diagnostic verifications, which record test
  evidence after a rejected review without approving anything, never count
  as a verification pass; their result is reported on its own.
* **Excluded** trials ended for infrastructure reasons (cancelled, the
  server restarted, the orchestrator crashed). They are counted and listed
  but are in no rate's denominator. Provider errors are task outcomes: a
  run that failed because the model endpoint failed is a failure.
* **Tokens** are reported only when every model call reported usage;
  **cost** only when, in addition, the provider is real and priced.
* **Model-call latency** is null for scripted runs: no model was called.
* **Timings** (metrics v2) come only from the run's persisted span
  measurements (``trial_timings``); a run without usable measurements keeps
  every timing null with its measurement status as the reason.
"""

from __future__ import annotations

import math
import statistics
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.models import RunRecord, TraceEvent
from app.timings.analysis import derive
from app.timings.recorder import SNAPSHOT_VERSION

# 2: trial timings from persisted run measurements (M7.3).
METRICS_VERSION = 2

TERMINAL_STATUSES = frozenset(
    {
        "completed",
        "completed_with_findings",
        "review_invalid",
        "failed",
        "cancelled",
        "budget_exceeded",
        "limit_exceeded",
        "timed_out",
    }
)
# Failure classes that describe the system, not the task.
INFRASTRUCTURE_ERRORS = frozenset({"run_crashed", "graph_error"})

# Below this many runs, a nearest-rank P95 is one of the slowest few runs.
P95_MIN_SAMPLE = 20
# Measured (counted) trials required per arm and task (proposal section 4.4).
MEASURED_SAMPLE = 20

# Exclusion reasons (besides warm-up and orchestration errors).
CANCELLED_REASON = "cancelled"
INTERRUPTED_REASON = "interrupted: the server stopped during the run"

Outcome = Literal["success", "failure", "excluded", "incomplete"]

# Why a trial has, or lacks, run measurements: the run measurements reasons
# (app.timings.view), plus a stored snapshot version this code cannot read.
MeasurementStatus = Literal[
    "recorded",
    "run_in_progress",
    "predates_measurements",
    "process_crash",
    "measurement_flush_failed",
    "instrumentation_disabled",
    "not_recorded",
    "unreadable",
    "unsupported_version",
]
SUPPORTED_MEASUREMENT_VERSIONS = frozenset({SNAPSHOT_VERSION})

# TrialTimings field -> the app.timings.analysis metric it reports.
TIMING_METRICS = {
    "lifecycle_ms": "lifecycle_ms",
    "admission_ms": "admission_ms",
    "execution_ms": "execution_ms",
    "setup_ms": "setup_ms",
    "graph_ms": "graph_ms",
    "finalization_ms": "finalization_ms",
    "planner_ms": "planner_ms",
    "reviewer_ms": "reviewer_ms",
    "coder_busy_ms": "coder_busy_ms",
    "coder_wall_ms": "coder_wall_ms",
    "coder_critical_path_ms": "coder_critical_path_ms",
    "provider_calls": "provider_calls",
    "provider_call_busy_ms": "call_ms",
    "provider_call_wall_ms": "call_wall_ms",
    "http_attempts": "http_attempts",
    "http_attempt_busy_ms": "http_attempt_ms",
    "http_attempt_wall_ms": "http_attempt_wall_ms",
    "parse_total_ms": "parse_ms",
    "backoff_total_ms": "backoff_ms",
    "verification_ms": "verification_ms",
    "diagnostic_verification_ms": "diagnostic_verification_ms",
    "graph_gap_ms": "graph_gap_ms",
    "critical_orchestration_ms": "critical_orchestration_ms",
    "parallel_orchestration_ms": "parallel_orchestration_ms",
    "schedule_delay_total_ms": "schedule_delay_ms",
    "slot_wait_total_ms": "slot_wait_ms",
    "ledger_wait_total_ms": "ledger_wait_ms",
}


class TrialTimings(BaseModel):
    """A counted trial's run timings, from its persisted span measurements
    (never from event timestamps). Null means "not established", with the
    reason in ``null_reasons``; ``*`` covers every field when the run has
    no usable measurements.

    ``*_busy_ms`` and ``*_total_ms`` are sums over possibly overlapping
    intervals (time spent, not time elapsed); ``*_wall_ms`` and the phases
    are elapsed time (the length of a union, or one interval);
    ``coder_critical_path_ms`` runs from each dispatch to its last step's end.
    """

    measurement_status: MeasurementStatus
    measurements_version: int | None = None

    # Run phases (one interval each).
    lifecycle_ms: float | None = None
    admission_ms: float | None = None
    execution_ms: float | None = None
    setup_ms: float | None = None
    graph_ms: float | None = None
    finalization_ms: float | None = None
    planner_ms: float | None = None
    reviewer_ms: float | None = None

    coder_busy_ms: float | None = None
    coder_wall_ms: float | None = None
    coder_critical_path_ms: float | None = None

    provider_calls: int | None = None
    provider_call_busy_ms: float | None = None
    provider_call_wall_ms: float | None = None
    http_attempts: int | None = None
    http_attempt_busy_ms: float | None = None
    http_attempt_wall_ms: float | None = None
    parse_total_ms: float | None = None
    backoff_total_ms: float | None = None

    # Test process time (gating, and diagnostic evidence apart).
    verification_ms: float | None = None
    diagnostic_verification_ms: float | None = None

    graph_gap_ms: float | None = None
    critical_orchestration_ms: float | None = None
    parallel_orchestration_ms: float | None = None

    schedule_delay_total_ms: float | None = None
    slot_wait_total_ms: float | None = None
    ledger_wait_total_ms: float | None = None

    # Benchmark runner, outside the run: from claiming the trial to its run
    # being admitted, including any wait for a free run slot.
    trial_slot_wait_ms: float | None = None

    null_reasons: dict[str, str] = Field(default_factory=dict)


def trial_timings(
    status: str,
    snapshot: Mapping[str, Any] | None,
    version: int | None,
    trial_slot_wait_ms: float | None,
) -> TrialTimings:
    """A trial's timings from its run's loaded measurements (app.timings.view).

    Only a ``recorded`` snapshot of a supported version is derived; any
    other status leaves every run metric null with that status as reason.
    """
    reasons: dict[str, str] = {}
    if trial_slot_wait_ms is None:
        reasons["trial_slot_wait_ms"] = "not measured: the trial was finished by recovery"
    if status == "recorded" and version not in SUPPORTED_MEASUREMENT_VERSIONS:
        status = "unsupported_version"
    if status != "recorded" or snapshot is None:
        reasons["*"] = f"no run measurements: {status}"
        return TrialTimings(
            measurement_status=status,
            measurements_version=version,
            trial_slot_wait_ms=trial_slot_wait_ms,
            null_reasons=reasons,
        )
    derived = derive(snapshot)
    values: dict[str, Any] = {}
    for field_name, metric in TIMING_METRICS.items():
        value = derived.values.get(metric)
        values[field_name] = value
        if value is None:
            reasons[field_name] = derived.reasons.get(metric) or derived.reasons.get("*") or "not established"
    return TrialTimings(
        measurement_status="recorded",
        measurements_version=version,
        trial_slot_wait_ms=trial_slot_wait_ms,
        null_reasons=reasons,
        **values,
    )


class TrialMetrics(BaseModel):
    """What one trial's run establishes. Null means "not established"."""

    metrics_version: int = METRICS_VERSION
    run_id: str
    status: str
    outcome: Outcome
    excluded_reason: str | None = None

    # Execution success: the run finished "completed". Null unless counted.
    task_success: bool | None = None
    # The run's last non-diagnostic verification passed (False when none
    # ran). Null unless counted.
    verification_passed: bool | None = None
    verification_runs: int = 0
    # The latest diagnostic verification (evidence only, never a pass).
    diagnostic_tests_passed: bool | None = None

    provider: str
    provider_kind: str
    scripted: bool
    model_policy: str
    models_by_role: dict[str, str] = Field(default_factory=dict)

    # Wall time of the run (orchestration, model calls and test runs).
    latency_ms: int | None = None
    # Sum of model-call latencies; null for scripted runs.
    model_latency_ms: int | None = None
    # Sum of verification run durations (0 when none ran).
    verification_ms: int | None = None

    agent_calls: int | None = None
    # Coding steps re-dispatched after a failed attempt.
    step_retries: int | None = None
    # Model calls retried after a transient provider error.
    call_retries: int | None = None
    # Unparseable model output retried with a repair note.
    output_repairs: int | None = None
    # Coding rounds dispatched after a failed verification.
    repair_rounds: int | None = None
    revisions: int | None = None
    escalations: int | None = None

    model_calls: int = 0
    calls_with_usage: int = 0
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None

    # Run timings (metrics v2): set for counted trials; null for excluded and
    # incomplete trials and for trials recorded before v2 (metrics_version 1).
    timings: TrialTimings | None = None

    null_reasons: dict[str, str] = Field(default_factory=dict)

    @property
    def counted(self) -> bool:
        return self.outcome in {"success", "failure"}

    @property
    def retries(self) -> int | None:
        if self.step_retries is None or self.call_retries is None:
            return None
        return self.step_retries + self.call_retries


def _payloads(events: Iterable[TraceEvent], kind: str) -> list[dict[str, Any]]:
    return [dict(event.payload or {}) for event in events if event.kind == kind]


def _excluded_reason(record: RunRecord, events: Sequence[TraceEvent]) -> str | None:
    if record.status == "cancelled":
        return CANCELLED_REASON
    for payload in _payloads(events, "run_finished"):
        if payload.get("recovered"):
            return INTERRUPTED_REASON
    for payload in _payloads(events, "failure"):
        if payload.get("error_class") in INFRASTRUCTURE_ERRORS:
            return f"orchestration error ({payload['error_class']})"
    return None


WARMUP_REASON = "warm-up"


def as_warmup(metrics: TrialMetrics) -> TrialMetrics:
    """A warm-up trial's metrics: excluded whatever its outcome.

    Warm-ups absorb first-run costs (imports, caches, connection setup) and
    never count towards a rate, a distribution or the measured sample.
    """
    return TrialMetrics(
        run_id=metrics.run_id,
        status=metrics.status,
        provider=metrics.provider,
        provider_kind=metrics.provider_kind,
        scripted=metrics.scripted,
        model_policy=metrics.model_policy,
        models_by_role=dict(metrics.models_by_role),
        outcome="excluded",
        excluded_reason=WARMUP_REASON,
        null_reasons={"*": _warmup_note(metrics)},
    )


def _warmup_note(metrics: TrialMetrics) -> str:
    note = f"excluded from the comparison: {WARMUP_REASON}"
    if metrics.outcome == "excluded":
        # Kept so a cancelled or interrupted warm-up still says so.
        note += f" (the run itself was excluded: {metrics.excluded_reason})"
    return note


def trial_metrics(record: RunRecord, events: Sequence[TraceEvent]) -> TrialMetrics:
    """The metrics one run establishes, from its record and trace."""
    ordered = sorted(events, key=lambda event: event.seq)
    scripted = record.provider_kind == "demo"
    base = {
        "run_id": record.run_id,
        "status": record.status,
        "provider": record.provider,
        "provider_kind": record.provider_kind,
        "scripted": scripted,
        "model_policy": record.model_policy,
        "models_by_role": dict(record.models_by_role),
    }

    if record.status not in TERMINAL_STATUSES:
        return TrialMetrics(
            **base,
            outcome="incomplete",
            null_reasons={"*": "the run has not finished"},
        )
    excluded = _excluded_reason(record, ordered)
    if excluded is not None:
        return TrialMetrics(
            **base,
            outcome="excluded",
            excluded_reason=excluded,
            null_reasons={"*": f"excluded from the comparison: {excluded}"},
        )

    reasons: dict[str, str] = {}

    verifications = _payloads(ordered, "verification")
    checks = [item for item in verifications if not item.get("diagnostic")]
    diagnostics = [item for item in verifications if item.get("diagnostic")]
    durations = [item.get("duration_ms") for item in verifications]

    invocations = [item.get("invocation") or {} for item in _payloads(ordered, "agent_invocation")]
    with_usage = [item for item in invocations if item.get("usage_available")]
    usage_complete = len(with_usage) == len(invocations)

    if scripted:
        model_latency = None
        reasons["model_latency_ms"] = "scripted provider: no model was called"
    else:
        model_latency = sum(int(item.get("latency_ms") or 0) for item in invocations)

    if usage_complete:
        input_tokens: int | None = sum(int(item.get("input_tokens") or 0) for item in invocations)
        output_tokens: int | None = sum(int(item.get("output_tokens") or 0) for item in invocations)
    else:
        input_tokens = output_tokens = None
        missing = len(invocations) - len(with_usage)
        reasons["tokens"] = (
            "scripted provider: no usage is reported"
            if scripted
            else f"{missing} of {len(invocations)} model calls reported no usage"
        )

    cost: float | None = None
    if scripted:
        reasons["cost_usd"] = "scripted provider: nothing was billed"
    elif not usage_complete:
        reasons["cost_usd"] = "token usage is incomplete"
    elif not record.monetary_enforced:
        reasons["cost_usd"] = "token pricing is not configured, so any cost would be an estimate"
    else:
        cost = round(record.cost_usd, 8)

    dispatch_modes = Counter(
        item.get("mode")
        for item in _payloads(ordered, "routing_decision")
        if item.get("decision") == "dispatch_coding"
    )
    retries = _payloads(ordered, "retry")

    return TrialMetrics(
        **base,
        outcome="success" if record.status == "completed" else "failure",
        task_success=record.status == "completed",
        verification_passed=bool(checks and checks[-1].get("passed")),
        verification_runs=len(checks),
        diagnostic_tests_passed=bool(diagnostics[-1].get("passed")) if diagnostics else None,
        latency_ms=record.duration_ms,
        model_latency_ms=model_latency,
        verification_ms=sum(int(item or 0) for item in durations),
        agent_calls=record.agent_calls,
        step_retries=dispatch_modes.get("retry", 0),
        call_retries=sum(1 for item in retries if item.get("scope") == "call"),
        output_repairs=len(_payloads(ordered, "repair")),
        repair_rounds=dispatch_modes.get("repair", 0),
        revisions=record.revisions,
        escalations=record.escalations,
        model_calls=len(invocations),
        calls_with_usage=len(with_usage),
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=cost,
        null_reasons=reasons,
    )


# ----------------------------------------------------------------------
# aggregates
# ----------------------------------------------------------------------
def percentile(values: Sequence[float], p: float) -> float | None:
    """Nearest-rank percentile (an observed value); None for no values."""
    if not values:
        return None
    if not 0 < p <= 100:
        raise ValueError("p must be in (0, 100]")
    ordered = sorted(values)
    rank = math.ceil(p / 100 * len(ordered))
    return float(ordered[rank - 1])


class Distribution(BaseModel):
    n: int
    median: float | None = None
    p95: float | None = None
    mean: float | None = None
    min: float | None = None
    max: float | None = None


def distribution(values: Sequence[float]) -> Distribution:
    if not values:
        return Distribution(n=0)
    return Distribution(
        n=len(values),
        median=float(statistics.median(values)),
        p95=percentile(values, 95),
        mean=round(statistics.fmean(values), 3),
        min=float(min(values)),
        max=float(max(values)),
    )


class TimingSummary(BaseModel):
    """One timing metric over the measured trials (see TimingAggregate):
    ``n`` trials established it, ``missing`` did not (by reason), and
    ``n + missing`` is always the measured count. Median is
    ``statistics.median`` (the mean of the two middle values for even n);
    P95 is nearest-rank (an observed value)."""

    n: int
    missing: int
    missing_reasons: dict[str, int] = Field(default_factory=dict)
    median: float | None = None
    p95: float | None = None
    min: float | None = None
    max: float | None = None


class TimingAggregate(BaseModel):
    """Run timings over counted trials. Only trials whose run measurements
    were recorded (a supported version) are measured; every other counted
    trial is counted under ``unavailable`` by status and enters no
    distribution, so statuses are never mixed and none is dropped."""

    measured: int
    unavailable: dict[str, int] = Field(default_factory=dict)
    metrics: dict[str, TimingSummary] = Field(default_factory=dict)


TIMING_FIELDS = (*TIMING_METRICS, "trial_slot_wait_ms")
# A counted trial without timings: recorded before metrics v2.
NO_TIMINGS_V1 = "metrics_v1"


def timing_summary(values: Sequence[float | None], reasons: Sequence[str]) -> TimingSummary:
    """``values`` per measured trial (None when missing, with ``reasons``
    holding the reason of each missing value, in order)."""
    known = [value for value in values if value is not None]
    if not known:
        return TimingSummary(n=0, missing=len(values), missing_reasons=dict(Counter(reasons)))
    return TimingSummary(
        n=len(known),
        missing=len(values) - len(known),
        missing_reasons=dict(Counter(reasons)),
        median=float(statistics.median(known)),
        p95=percentile(known, 95),
        min=float(min(known)),
        max=float(max(known)),
    )


def timing_aggregate(counted: Sequence[TrialMetrics]) -> TimingAggregate:
    measured = [t.timings for t in counted if t.timings is not None and t.timings.measurement_status == "recorded"]
    unavailable = Counter(
        (t.timings.measurement_status if t.timings is not None else NO_TIMINGS_V1)
        for t in counted
        if t.timings is None or t.timings.measurement_status != "recorded"
    )
    metrics = {}
    for name in TIMING_FIELDS:
        values = [getattr(timings, name) for timings in measured]
        reasons = [
            timings.null_reasons.get(name) or timings.null_reasons.get("*") or "not established"
            for timings in measured
            if getattr(timings, name) is None
        ]
        metrics[name] = timing_summary(values, reasons)
    return TimingAggregate(measured=len(measured), unavailable=dict(unavailable), metrics=metrics)


class ArmAggregate(BaseModel):
    """One arm's results (over all its tasks, or one task). Rates and means
    are over counted trials only, except the cancellation and interrupted
    rates, which are over every non-warm-up trial with metrics."""

    arm_id: str
    trials: int
    # Measured n: trials that count (success or failure), warm-ups never.
    counted: int
    # Excluded trials other than warm-ups (cancelled, interrupted,
    # orchestration error), by reason in excluded_reasons.
    excluded: int
    incomplete: int
    excluded_reasons: dict[str, int] = Field(default_factory=dict)
    warmups: int = 0

    # Denominator of the two rates below: trials - warmups.
    non_warmup_trials: int = 0
    cancelled: int = 0
    cancellation_rate: float | None = None
    interrupted: int = 0
    interrupted_rate: float | None = None

    # At least this many counted trials per arm and task; never topped up by
    # reruns. For an arm over all tasks, complete only when every task is.
    sample_required: int = MEASURED_SAMPLE
    sample_complete: bool = False

    task_successes: int
    task_success_rate: float | None
    verification_passes: int
    verification_pass_rate: float | None

    latency_ms: Distribution
    model_latency_ms: Distribution
    verification_ms: Distribution

    mean_agent_calls: float | None
    mean_retries: float | None
    mean_step_retries: float | None
    mean_call_retries: float | None
    mean_output_repairs: float | None
    mean_repair_rounds: float | None
    mean_revisions: float | None
    mean_escalations: float | None

    runs_with_usage: int
    mean_input_tokens: float | None
    mean_output_tokens: float | None
    runs_with_cost: int
    mean_cost_usd: float | None
    total_cost_usd: float | None

    timings: TimingAggregate = Field(default_factory=lambda: TimingAggregate(measured=0))

    notes: list[str] = Field(default_factory=list)


def _rate(numerator: int, denominator: int) -> float | None:
    return None if denominator == 0 else round(numerator / denominator, 4)


def _mean(values: Sequence[float | None]) -> float | None:
    known = [value for value in values if value is not None]
    return round(statistics.fmean(known), 4) if known else None


def aggregate(arm_id: str, trials: Sequence[TrialMetrics]) -> ArmAggregate:
    counted = [trial for trial in trials if trial.counted]
    warmups = [trial for trial in trials if trial.excluded_reason == WARMUP_REASON]
    non_warmup = [trial for trial in trials if trial.excluded_reason != WARMUP_REASON]
    excluded = [trial for trial in non_warmup if trial.outcome == "excluded"]
    cancelled = sum(1 for trial in excluded if trial.excluded_reason == CANCELLED_REASON)
    interrupted = sum(1 for trial in excluded if trial.excluded_reason == INTERRUPTED_REASON)
    timings = timing_aggregate(counted)
    latencies = [trial.latency_ms for trial in counted if trial.latency_ms is not None]
    model_latencies = [trial.model_latency_ms for trial in counted if trial.model_latency_ms is not None]
    with_usage = [trial for trial in counted if trial.input_tokens is not None]
    with_cost = [trial for trial in counted if trial.cost_usd is not None]

    notes: list[str] = []
    if counted and all(trial.scripted for trial in counted):
        notes.append(
            "Scripted provider: the agents follow a script, so success, retries and "
            "revisions describe the orchestration, not a model's ability."
        )
    if 0 < len(latencies) < P95_MIN_SAMPLE:
        notes.append(
            f"P95 latency is from {len(latencies)} runs (fewer than {P95_MIN_SAMPLE}); "
            "it is one of the slowest runs observed, not a stable tail estimate."
        )
    if counted and not with_usage:
        notes.append("No counted run reported complete token usage; token figures are unknown.")
    elif with_usage and len(with_usage) < len(counted):
        notes.append(
            f"Token means cover the {len(with_usage)} of {len(counted)} runs that reported "
            "usage for every call."
        )
    if counted and not with_cost:
        notes.append("Cost is unknown: no counted run had complete usage with configured pricing.")
    if 0 < timings.measured < P95_MIN_SAMPLE:
        notes.append(
            f"Timing P95s are from {timings.measured} measured runs (fewer than {P95_MIN_SAMPLE}); "
            "each is one of the slowest runs observed, not a stable tail estimate."
        )
    if timings.unavailable:
        missing = ", ".join(f"{status} {count}" for status, count in sorted(timings.unavailable.items()))
        notes.append(f"Timings are unavailable for some counted runs ({missing}); they are in no timing figure.")
    if len(counted) < MEASURED_SAMPLE:
        notes.append(
            f"Sample incomplete: {len(counted)} measured trials; {MEASURED_SAMPLE} per arm and task "
            "are required. Excluded trials are not rerun."
        )

    return ArmAggregate(
        arm_id=arm_id,
        trials=len(trials),
        counted=len(counted),
        excluded=len(excluded),
        incomplete=sum(1 for trial in trials if trial.outcome == "incomplete"),
        excluded_reasons=dict(Counter(trial.excluded_reason or "unknown" for trial in excluded)),
        warmups=len(warmups),
        non_warmup_trials=len(non_warmup),
        cancelled=cancelled,
        cancellation_rate=_rate(cancelled, len(non_warmup)),
        interrupted=interrupted,
        interrupted_rate=_rate(interrupted, len(non_warmup)),
        sample_required=MEASURED_SAMPLE,
        sample_complete=len(counted) >= MEASURED_SAMPLE,
        timings=timings,
        task_successes=sum(1 for trial in counted if trial.task_success),
        task_success_rate=_rate(sum(1 for trial in counted if trial.task_success), len(counted)),
        verification_passes=sum(1 for trial in counted if trial.verification_passed),
        verification_pass_rate=_rate(
            sum(1 for trial in counted if trial.verification_passed), len(counted)
        ),
        latency_ms=distribution(latencies),
        model_latency_ms=distribution(model_latencies),
        verification_ms=distribution(
            [trial.verification_ms for trial in counted if trial.verification_ms is not None]
        ),
        mean_agent_calls=_mean([trial.agent_calls for trial in counted]),
        mean_retries=_mean([trial.retries for trial in counted]),
        mean_step_retries=_mean([trial.step_retries for trial in counted]),
        mean_call_retries=_mean([trial.call_retries for trial in counted]),
        mean_output_repairs=_mean([trial.output_repairs for trial in counted]),
        mean_repair_rounds=_mean([trial.repair_rounds for trial in counted]),
        mean_revisions=_mean([trial.revisions for trial in counted]),
        mean_escalations=_mean([trial.escalations for trial in counted]),
        runs_with_usage=len(with_usage),
        mean_input_tokens=_mean([trial.input_tokens for trial in with_usage]),
        mean_output_tokens=_mean([trial.output_tokens for trial in with_usage]),
        runs_with_cost=len(with_cost),
        mean_cost_usd=_mean([trial.cost_usd for trial in with_cost]),
        total_cost_usd=round(sum(trial.cost_usd or 0.0 for trial in with_cost), 8)
        if with_cost
        else None,
        notes=notes,
    )
