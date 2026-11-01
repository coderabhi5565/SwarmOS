"""Response contracts for the HTTP API.

Domain models (``RunRecord``, ``TraceEvent``, ``Limits``, ...) live in
``app.models`` and are reused here. These models only describe API-shaped
responses, so the OpenAPI schema is an accurate contract for clients and every
response field is declared: undeclared keys are dropped by FastAPI's response
validation rather than leaked.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

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


class CancelResponse(_Response):
    run_id: str
    status: Literal["cancelling"] = "cancelling"
