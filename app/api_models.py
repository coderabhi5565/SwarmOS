"""Response contracts for the HTTP API.

Domain models (``RunRecord``, ``TraceEvent``, ``Limits``, ...) live in
``app.models`` and are reused here. These models only describe API-shaped
responses, so the OpenAPI schema is an accurate contract for clients and every
response field is declared: undeclared keys are dropped by FastAPI's response
validation rather than leaked.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.models import (
    RESPONSE_SCHEMA,
    Limits,
    ReviewOutput,
    RunRecord,
    RunStatus,
    TraceEvent,
)


class _Response(BaseModel):
    """Base for response models: defaulted fields are always serialised."""

    model_config = RESPONSE_SCHEMA


class HealthResponse(_Response):
    status: Literal["ok"] = "ok"
    service: str = "swarmos"
    version: str
    mode: str
    provider_mode: str
    provider_kind: str
    openai_configured: bool
    auth_required: bool


# ----------------------------------------------------------------------
# demo catalog
# ----------------------------------------------------------------------
class DemoTaskStep(_Response):
    id: str
    title: str
    depends_on: list[str] = Field(default_factory=list)


class DemoTaskInfo(_Response):
    id: str
    title: str
    description: str
    goal: str
    steps: list[DemoTaskStep]
    waves: list[list[str]]
    allowed_files: list[str]
    read_only_files: list[str]
    limits: Limits


class DemoTasksResponse(_Response):
    mode: str
    tasks: list[DemoTaskInfo]


# ----------------------------------------------------------------------
# configuration
# ----------------------------------------------------------------------
class ModelProfileInfo(_Response):
    name: str
    model: str
    priced: bool
    input_usd_per_million: float
    output_usd_per_million: float


class PublicDemoInfo(_Response):
    enabled: bool
    execution_sandbox: str
    code_policy: bool
    max_concurrent_runs: int
    runs_per_client_per_hour: int


class CapsInfo(_Response):
    max_agent_calls: int
    max_budget_usd: float
    max_wall_seconds: int
    max_retries: int
    max_revisions: int
    max_escalations: int


class VerificationConfigInfo(_Response):
    command: str
    timeout_seconds: int
    execution_enabled: bool
    allowed_commands: list[str]
    repo_checkout_allowed: bool


class ApiInfo(_Response):
    auth_required: bool
    remote_bind_allowed: bool


class ConfigResponse(_Response):
    mode: str
    provider_mode: str
    provider_kind: str
    openai_configured: bool
    # None in the public demo: visitors learn which models run, not where.
    base_url: str | None
    auth_configured: bool
    json_mode: bool
    profiles: dict[str, ModelProfileInfo]
    role_routing: dict[str, str]
    model_policy: str
    escalation_available: bool
    pricing_known: bool
    monetary_enforced: bool
    public_demo: PublicDemoInfo
    caps: CapsInfo
    verification: VerificationConfigInfo
    api: ApiInfo
    sample_files: list[str]
    demo_fixture: bool


class ProviderModelsResponse(_Response):
    provider: str
    kind: str | None = None
    ok: bool
    detail: str
    models: list[str] = Field(default_factory=list)
    warning: str | None = None
    status_code: int | None = None


# ----------------------------------------------------------------------
# runs
# ----------------------------------------------------------------------
class RunSummary(_Response):
    """A run as listed in history: everything except plan details, review
    text, verification output, the summary, and generated file contents."""

    run_id: str
    created_at: str
    updated_at: str
    goal: str
    status: RunStatus
    provider: str
    provider_kind: str
    model_policy: str
    models_by_role: dict[str, str]
    limits: Limits
    error: str | None
    cost_usd: float
    monetary_enforced: bool
    usage_available: bool
    agent_calls: int
    escalations: int
    revisions: int
    duration_ms: int
    changed_files: list[str]
    plan_step_count: int | None = None
    review_verdict: Literal["approve", "request_changes"] | None = None
    verification_passed: bool | None = None
    verification_diagnostic: bool | None = None

    @classmethod
    def from_record(cls, record: RunRecord) -> RunSummary:
        review: ReviewOutput | None = record.review
        verification = record.verification
        return cls(
            **record.model_dump(
                include={
                    "run_id",
                    "created_at",
                    "updated_at",
                    "goal",
                    "status",
                    "provider",
                    "provider_kind",
                    "model_policy",
                    "models_by_role",
                    "limits",
                    "error",
                    "cost_usd",
                    "monetary_enforced",
                    "usage_available",
                    "agent_calls",
                    "escalations",
                    "revisions",
                    "duration_ms",
                    "changed_files",
                }
            ),
            plan_step_count=len(record.plan.steps) if record.plan else None,
            review_verdict=review.verdict if review else None,
            verification_passed=verification.passed if verification else None,
            verification_diagnostic=verification.diagnostic if verification else None,
        )


class RunListResponse(_Response):
    runs: list[RunSummary]
    # Pass as ``cursor`` to fetch the next (older) page; None on the last page.
    next_cursor: str | None = None


class RunEventsResponse(_Response):
    run_id: str
    events: list[TraceEvent]
    # The cursor for the next poll (``after_seq``). Unchanged when no new
    # events arrived; 0 when the run has none yet.
    last_seq: int


class RunStreamEnd(_Response):
    """The data of the ``end`` message that closes a run's event stream.

    The stream (``GET /api/runs/{run_id}/stream``) is Server-Sent Events:
    ``trace`` messages carry one ``TraceEvent`` each with ``id`` set to its
    ``seq``; ``end`` is sent once the run is terminal and every event has
    been delivered. Comment lines are keepalives, not events.
    """

    run_id: str
    status: RunStatus
    # The seq of the last event in the trace (0 when it has none).
    last_seq: int


class CancelResponse(_Response):
    run_id: str
    status: Literal["cancelling"] = "cancelling"


# ----------------------------------------------------------------------
# benchmarks (M6). Explicit API shapes, converted from app.benchmarks; tests
# keep their fields in step with the domain models they mirror.
# ----------------------------------------------------------------------
class BenchmarkTaskInfo(_Response):
    id: str
    title: str
    # The catalog task this runs (null for free-form fixture goals).
    demo_task: str | None
    # Some wave has more than one step (null when the plan is not fixed).
    parallel_waves: bool | None
    notes: str


class BenchmarkSuiteInfo(_Response):
    id: str
    title: str
    description: str
    version: str
    public: bool
    requires_real_model: bool
    tasks: list[BenchmarkTaskInfo]


class BenchmarkArmInfo(_Response):
    id: str
    kind: Literal["execution", "model_policy"]
    label: str
    description: str
    model_policy: str | None
    parallel_coding: bool | None
    max_escalations: int | None


class BenchmarkSuitesResponse(_Response):
    mode: str
    # Whether this server accepts new experiments (never in the public demo).
    can_create: bool
    suites: list[BenchmarkSuiteInfo]
    arms: list[BenchmarkArmInfo]
    max_repetitions: int
    max_trials: int


class BenchmarkCreateRequest(BaseModel):
    """A new experiment: a fixed suite and fixed arms, by id. Nothing else."""

    model_config = ConfigDict(extra="forbid")

    suite_id: str = Field(min_length=1, max_length=64)
    arm_ids: list[str] = Field(min_length=1, max_length=8)
    repetitions: int = Field(
        default=1,
        ge=1,
        le=20,
        description=(
            "Measured repetitions per arm and task. One warm-up repetition per "
            "arm and task is added, run first and excluded from every result."
        ),
    )
    # A subset of the suite's tasks, by id (default: all of them).
    task_ids: list[str] | None = Field(default=None, min_length=1, max_length=20)
    provider: Literal["auto", "demo", "openai"] = "auto"
    order_seed: int | None = Field(default=None, ge=0, le=2**31 - 1)


class BenchmarkEnvironment(_Response):
    app_version: str
    mode: str
    provider: str
    provider_kind: str
    scripted: bool
    pricing_known: bool
    monetary_enforced: bool
    execution_enabled: bool
    execution_sandbox: str
    verification_command: str
    build_commit: str | None
    # Host details: null in the public demo.
    python_version: str | None
    platform: str | None
    collected_at: str


class BenchmarkArmConfiguration(_Response):
    arm_id: str
    task_id: str
    provider: str
    provider_kind: str
    scripted: bool
    model_policy: str
    models_by_role: dict[str, str]
    escalation_possible: bool
    escalation_unavailable: list[str]
    limits: Limits
    parallel_relevant: bool | None
    fingerprint: str


class BenchmarkIdenticalArms(_Response):
    task_id: str
    arm_ids: list[str]
    fingerprint: str
    reasons: list[str]
    explanation: str


class BenchmarkDistribution(_Response):
    n: int
    median: float | None
    p95: float | None
    mean: float | None
    min: float | None
    max: float | None


class BenchmarkTrialMetrics(_Response):
    """What a trial's run established; null means not established (see null_reasons)."""

    metrics_version: int
    run_id: str
    status: str
    outcome: Literal["success", "failure", "excluded", "incomplete"]
    excluded_reason: str | None
    task_success: bool | None
    verification_passed: bool | None
    verification_runs: int
    diagnostic_tests_passed: bool | None
    provider: str
    provider_kind: str
    scripted: bool
    model_policy: str
    models_by_role: dict[str, str]
    latency_ms: int | None
    model_latency_ms: int | None
    verification_ms: int | None
    agent_calls: int | None
    step_retries: int | None
    call_retries: int | None
    output_repairs: int | None
    repair_rounds: int | None
    revisions: int | None
    escalations: int | None
    model_calls: int
    calls_with_usage: int
    input_tokens: int | None
    output_tokens: int | None
    cost_usd: float | None
    null_reasons: dict[str, str]


class BenchmarkAggregate(_Response):
    """An arm's results, over all tasks (task_id null) or one task.
    Rates and means are over counted trials only."""

    arm_id: str
    task_id: str | None
    # Every trial of the arm by status (pending, running, done, ...).
    trial_statuses: dict[str, int]
    trials: int
    counted: int
    excluded: int
    incomplete: int
    excluded_reasons: dict[str, int]
    task_successes: int
    task_success_rate: float | None
    verification_passes: int
    verification_pass_rate: float | None
    latency_ms: BenchmarkDistribution
    model_latency_ms: BenchmarkDistribution
    verification_ms: BenchmarkDistribution
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
    notes: list[str]


class BenchmarkTrialInfo(_Response):
    trial_id: str
    ordinal: int
    arm_id: str
    task_id: str
    repetition: int
    fingerprint: str
    status: Literal["pending", "running", "done", "not_run", "error"]
    run_id: str | None
    # GET path of the trial's run (Run Detail and replay), when it has one.
    run_path: str | None
    started_at: str | None
    finished_at: str | None
    error: str | None
    metrics: BenchmarkTrialMetrics | None


class BenchmarkExperimentSummary(_Response):
    experiment_id: str
    created_at: str
    updated_at: str
    started_at: str | None
    finished_at: str | None
    status: Literal[
        "queued", "running", "completed", "partial", "cancelled", "failed", "interrupted"
    ]
    origin: Literal["cli", "api"]
    suite_id: str
    suite_title: str
    suite_version: str
    provider: str
    provider_kind: str
    scripted: bool
    repetitions: int
    # Warm-up repetitions per arm and task (excluded); 0 before M7.3.
    warmup_repetitions: int
    arm_ids: list[str]
    trials_total: int
    trials_done: int
    error: str | None


class BenchmarkExperimentListResponse(_Response):
    experiments: list[BenchmarkExperimentSummary]
    next_cursor: str | None


class BenchmarkExperimentDetail(_Response):
    experiment: BenchmarkExperimentSummary
    order_seed: int
    environment: BenchmarkEnvironment
    configurations: list[BenchmarkArmConfiguration]
    identical_by_design: list[BenchmarkIdenticalArms]
    # One per arm over every task, then one per arm and task.
    aggregates: list[BenchmarkAggregate]
    task_aggregates: list[BenchmarkAggregate]
    trials: list[BenchmarkTrialInfo]
    notes: list[str]


class BenchmarkCancelResponse(_Response):
    experiment_id: str
    status: Literal["cancelling"] = "cancelling"


# ----------------------------------------------------------------------
# run measurements (M7.2)
# ----------------------------------------------------------------------
MeasurementReason = Literal[
    "recorded",
    "run_in_progress",
    "predates_measurements",
    "process_crash",
    "measurement_flush_failed",
    "instrumentation_disabled",
    "not_recorded",
    "unreadable",
]
SpanKind = Literal[
    "lifecycle",
    "admission",
    "execution",
    "setup",
    "graph",
    "finalization",
    "node",
    "dispatch",
    "step.schedule_delay",
    "step.checkout",
    "call",
    "call.slot_wait",
    "call.ledger_wait",
    "call.http_attempt",
    "call.parse",
    "call.backoff",
    "verify.thread_wait",
    "verify.run",
    "verify.process",
]


class MeasurementSpan(_Response):
    """One span on the run's monotonic clock: ms offsets from the lifecycle
    start; ``end_ms`` null when the span never closed."""

    id: int
    kind: SpanKind
    parent: int | None
    start_ms: float
    end_ms: float | None
    attrs: dict[str, bool | int | str]


class MeasurementPhases(_Response):
    admission_ms: float | None
    setup_ms: float | None
    graph_ms: float | None
    execution_ms: float | None
    finalization_ms: float | None
    lifecycle_ms: float | None


class MeasurementCoder(_Response):
    busy_ms: float | None
    wall_ms: float | None
    critical_path_ms: float | None


class MeasurementOrchestration(_Response):
    graph_gap_ms: float | None
    critical_ms: float | None
    parallel_ms: float | None
    node_self_ms: dict[str, float]


class MeasurementAgents(_Response):
    planner_ms: float | None
    reviewer_ms: float | None
    call_ms: float | None
    parse_ms: float | None
    backoff_ms: float | None
    http_attempts: int | None


class MeasurementWaits(_Response):
    schedule_delay_ms: float | None
    slot_wait_ms: float | None
    ledger_wait_ms: float | None
    verify_thread_wait_ms: float | None


class MeasurementVerification(_Response):
    verification_ms: float | None
    diagnostic_verification_ms: float | None


class MeasurementPersistence(_Response):
    """Trace and run-row writes during the run (the terminal write is not in
    the row: it happens after the measurements are serialized)."""

    event_persist_lock_wait_ms: float | None
    event_persist_write_ms: float | None
    event_persist_writes: int | None
    save_run_lock_wait_ms: float | None
    save_run_write_ms: float | None
    save_run_writes: int | None


class MeasurementCall(_Response):
    role: str | None
    step_id: str | None
    attempt: int | None
    outcome: str | None
    call_ms: float | None
    http_attempts: int
    http_attempt_ms: list[float | None]
    http_outcomes: list[str | None]
    parse_ms: float | None


class MeasurementStep(_Response):
    step_id: str | None
    dispatch_id: int | None
    attempt: int | None
    start_ms: float | None
    duration_ms: float | None
    schedule_delay_ms: float | None
    slot_wait_ms: float | None
    checkout_ms: float | None


class RunMeasurements(_Response):
    """A run's stored timing measurements, or why there are none.

    Only numbers, enums and validated ids: no free text. ``unknown`` names
    each metric that is null and why (incomplete, never started, spans
    dropped, not applicable, ...). Nothing is ever derived from wall-clock
    event timestamps.
    """

    run_id: str
    available: bool
    reason: MeasurementReason
    measurements_version: int | None = None
    collected_at: str | None = None
    truncated: bool = False
    dropped_spans: int = 0
    dropped_by_kind: dict[str, int] = Field(default_factory=dict)
    instrumentation_errors: int | None = None
    measurement_self_ms: float | None = None
    phases: MeasurementPhases | None = None
    coder: MeasurementCoder | None = None
    orchestration: MeasurementOrchestration | None = None
    agents: MeasurementAgents | None = None
    waits: MeasurementWaits | None = None
    verification: MeasurementVerification | None = None
    persistence: MeasurementPersistence | None = None
    unknown: dict[str, str] = Field(default_factory=dict)
    calls: list[MeasurementCall] = Field(default_factory=list)
    steps: list[MeasurementStep] = Field(default_factory=list)
    spans: list[MeasurementSpan] = Field(default_factory=list)
