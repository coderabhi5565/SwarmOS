"""Typed payloads for every trace event kind.

``TraceRecorder.emit`` validates each payload against the model for its kind
before it is stored, so the trace is a dependable contract for clients (the
frontend's event reducer) rather than free-form dictionaries:

* every model forbids undeclared fields, so a new or misspelled key fails
  loudly in tests instead of being silently dropped or drifting;
* optional fields are those that genuinely do not apply to every emission;
* payloads are stored with ``exclude_unset``: exactly the keys the emitter
  supplied, never invented ones.

Events persisted before these models existed are not re-validated on read,
so old traces keep loading.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, RootModel
from pydantic.json_schema import models_json_schema

from app.models import (
    AgentInvocation,
    AgentRole,
    Limits,
    ModelTier,
    Plan,
    ReviewFinding,
    RunStatus,
    TraceKind,
)


class _Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LedgerSnapshot(_Payload):
    max_usd: float
    spent_usd: float
    reserved_usd: float
    remaining_usd: float
    max_calls: int
    calls: int
    denied: int
    monetary_enforced: bool
    elapsed_seconds: float
    remaining_seconds: float


# ----------------------------------------------------------------------
# run boundaries
# ----------------------------------------------------------------------
class RunStartedPayload(_Payload):
    goal: str
    provider: str
    provider_warning: str | None = None
    limits: Limits
    files: list[str]
    snapshot_truncated: bool = False


class VerificationOutcome(_Payload):
    diagnostic: bool
    passed: bool
    exit_code: int
    tests_passed: int
    tests_failed: int


class RunFinishedPayload(_Payload):
    status: RunStatus
    error: str | None = None
    summary: str | None = None
    verification: VerificationOutcome | None = None
    cost_usd: float | None = None
    agent_calls: int | None = None
    ledger: LedgerSnapshot | None = None
    escalated: bool | None = None
    # Set when the run was closed at startup after the server stopped.
    recovered: bool | None = None


# ----------------------------------------------------------------------
# agents
# ----------------------------------------------------------------------
class AgentStartedPayload(_Payload):
    """A model call is about to be sent. Pairs with ``agent_invocation``."""

    invocation_id: str
    role: AgentRole
    step_id: str | None = None
    attempt: int
    provider: str
    model: str
    profile: str
    tier: ModelTier
    started_at: str


class AgentInvocationPayload(_Payload):
    """A model call finished (successfully or not)."""

    invocation: AgentInvocation
    invocation_id: str
    role: AgentRole
    step_id: str | None = None
    status: Literal["succeeded", "failed", "skipped"]
    provider: str
    model: str
    profile: str
    tier: ModelTier
    attempt: int
    latency_ms: int
    input_tokens: int
    output_tokens: int
    usage_available: bool
    structured_mode: str | None = None
    cost_usd: float
    error_class: str | None = None
    error: str | None = None
    # The agent's own conclusions, truncated (see Agent.summarize).
    output_summary: dict[str, Any] = Field(default_factory=dict)


# ----------------------------------------------------------------------
# routing decisions (discriminated by ``decision``)
# ----------------------------------------------------------------------
class PlannerDispatchDecision(_Payload):
    decision: Literal["plan"]
    reason: str
    tier: ModelTier


class PlanDecision(_Payload):
    decision: Literal["plan_accepted", "plan_seeded"]
    steps: list[str]
    waves: list[list[str]]
    assumptions: list[str] = Field(default_factory=list)
    plan: Plan
    planner_skipped: bool | None = None
    recipe: str | None = None


class DispatchCodingDecision(_Payload):
    decision: Literal["dispatch_coding"]
    reason: str
    mode: Literal["initial", "retry", "revision", "repair"]
    revision_round: int
    steps: list[str]
    parallel: bool
    tier: ModelTier
    attempts: dict[str, int]


class MergeWaveDecision(_Payload):
    decision: Literal["merge_wave"]
    applied: int
    conflicts: list[str]
    accepted_steps: list[str]
    rejected_steps: list[str]
    files: list[str]


class RoutingDecisionPayload(
    RootModel[
        Annotated[
            PlannerDispatchDecision | PlanDecision | DispatchCodingDecision | MergeWaveDecision,
            Field(discriminator="decision"),
        ]
    ]
):
    pass


# ----------------------------------------------------------------------
# verification
# ----------------------------------------------------------------------
class VerificationStartedPayload(_Payload):
    """The deterministic test runner is about to start. Not a model call."""

    verification_id: str
    role: Literal["verifier"] = "verifier"
    runner: Literal["deterministic_subprocess"] = "deterministic_subprocess"
    command: str
    timeout_seconds: int
    # None for a diagnostic run, which is not a repair round.
    attempt: int | None = None
    diagnostic: bool


class VerificationPayload(_Payload):
    verification_id: str
    role: Literal["verifier"] = "verifier"
    diagnostic: bool
    passed: bool
    command: str
    exit_code: int
    tests_passed: int
    tests_failed: int
    duration_ms: int
    stdout_tail: str
    stderr_tail: str
    attempt: int | None = None


# ----------------------------------------------------------------------
# review, retries, escalation
# ----------------------------------------------------------------------
class WithheldBlocker(_Payload):
    finding: ReviewFinding
    missing: list[str]


class RevisionPayload(_Payload):
    findings: list[ReviewFinding]
    withheld_blockers: list[WithheldBlocker] = Field(default_factory=list)
    review_rejection: int
    steps: list[str]


class RetryPayload(_Payload):
    """``scope="call"``: one agent call is retried after a transient error.
    ``scope="steps"``: failed plan steps are re-dispatched."""

    scope: Literal["call", "steps"]
    # scope == "call"
    role: AgentRole | None = None
    step_id: str | None = None
    category: str | None = None
    attempt: int | None = None
    delay_seconds: float | None = None
    # scope == "steps"
    steps: list[str] | None = None
    attempts: dict[str, int] | None = None
    max_retries: int | None = None


class RepairPayload(_Payload):
    """Unparseable structured output; the call is retried with a repair note."""

    role: AgentRole
    step_id: str | None = None
    attempt: int
    error: str
    error_class: Literal["invalid_response"] = "invalid_response"


class EscalationPayload(_Payload):
    from_tier: ModelTier
    to_tier: ModelTier | None
    available: bool
    round: int | None = None
    model: str | None = None
    unresolved: list[str] | None = None
    reason: str | None = None


class BudgetPayload(_Payload):
    """A call was refused or abandoned by the ledger."""

    role: AgentRole
    step_id: str | None = None
    reason: str
    category: Literal["budget_exceeded", "limit_exceeded", "timed_out"]
    ledger: LedgerSnapshot


class ProviderPayload(_Payload):
    role: AgentRole
    step_id: str | None = None
    attempt: int
    category: str
    retryable: bool
    error: str


class WarningPayload(_Payload):
    code: Literal["snapshot_truncated"]
    char_limit: int | None = None
    files_included: int | None = None


# ----------------------------------------------------------------------
# failures
# ----------------------------------------------------------------------
class MissingEvidence(_Payload):
    step_id: str | None = None
    file: str | None = None
    missing: list[str]


class FailurePayload(_Payload):
    """Every failure: ``error`` always; agent context only where it applies.

    Orchestration-level failures (graph errors, crashes) carry no role, step,
    or attempt. The remaining fields are diagnostics specific to one cause.
    """

    error: str
    error_class: str | None = None
    role: AgentRole | None = None
    step_id: str | None = None
    attempt: int | None = None
    # rejected writes, conflicts, oversized files
    paths: list[str] | None = None
    allowed: list[str] | None = None
    read_only: list[str] | None = None
    conflicting_steps: list[str] | None = None
    # code policy
    violations: list[str] | None = None
    # invalid review
    findings: list[ReviewFinding] | None = None
    missing: list[MissingEvidence] | None = None
    note: str | None = None
    # failing verification
    exit_code: int | None = None
    tests_failed: int | None = None
    stdout_tail: str | None = None
    stderr_tail: str | None = None


PAYLOAD_MODELS: dict[str, type[BaseModel]] = {
    "run_started": RunStartedPayload,
    "agent_started": AgentStartedPayload,
    "agent_invocation": AgentInvocationPayload,
    "verification_started": VerificationStartedPayload,
    "routing_decision": RoutingDecisionPayload,
    "verification": VerificationPayload,
    "failure": FailurePayload,
    "retry": RetryPayload,
    "escalation": EscalationPayload,
    "revision": RevisionPayload,
    "budget": BudgetPayload,
    "provider": ProviderPayload,
    "repair": RepairPayload,
    "warning": WarningPayload,
    "run_finished": RunFinishedPayload,
}

_missing = set(get_args(TraceKind)) ^ set(PAYLOAD_MODELS)
if _missing:  # pragma: no cover - guards future edits at import time
    raise RuntimeError(f"trace kinds and payload models disagree: {sorted(_missing)}")


def openapi_components(ref_template: str = "#/components/schemas/{model}") -> dict[str, Any]:
    """JSON schemas for every payload model, plus a ``TraceEventPayloads``
    index mapping each trace kind to its payload, for the OpenAPI document."""
    _, schema = models_json_schema(
        [(model, "serialization") for model in PAYLOAD_MODELS.values()],
        ref_template=ref_template,
    )
    components: dict[str, Any] = dict(schema.get("$defs", {}))
    components["TraceEventPayloads"] = {
        "title": "TraceEventPayloads",
        "description": (
            "The payload schema for each TraceEvent.kind. TraceEvent.payload "
            "conforms to the entry for its kind for events recorded by this "
            "version; older stored traces are returned as recorded."
        ),
        "type": "object",
        "properties": {
            kind: {"$ref": ref_template.format(model=model.__name__)}
            for kind, model in PAYLOAD_MODELS.items()
        },
        "required": sorted(PAYLOAD_MODELS),
    }
    return components


def validate_payload(kind: TraceKind, payload: dict[str, Any]) -> dict[str, Any]:
    """Validate a payload for ``kind`` and return its JSON-ready form.

    Raises ``pydantic.ValidationError`` for an undeclared or mistyped field.
    """
    model = PAYLOAD_MODELS[kind].model_validate(payload)
    return model.model_dump(mode="json", exclude_unset=True)
