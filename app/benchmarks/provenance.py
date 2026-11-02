"""What an experiment ran on: per-arm configurations and the environment.

``arm_configuration`` describes what a run of an arm on a task will actually
get (provider, model per role, effective limits, whether escalation is
possible), using the same resolution code as the run itself. Escalation is
judged from the provider that arm uses: the demo fixture offers a single
scripted model whatever endpoint is configured.

The configuration fingerprint covers effective behaviour only, never an
arm's name, so two arms that run identically by construction share it.
``identical_by_design`` finds them and says why, so equal results are not
read as evidence that two policies perform alike.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import sys
from itertools import groupby

from pydantic import BaseModel, Field

from app import __version__
from app.benchmarks.arms import BenchmarkArm
from app.benchmarks.suites import SuiteTask
from app.config import Settings
from app.models import Limits, utc_now
from app.providers import provider_kind, provider_name_for
from app.runtime.runtime import VALID_POLICIES, model_profiles, select_role_profile
from app.service import clamp_limits, demo_limits, effective_provider_choice

VERIFIER = "deterministic-subprocess"
RECIPE_PLANNER = "skipped (demo recipe)"


class ArmConfiguration(BaseModel):
    arm_id: str
    task_id: str
    provider: str
    provider_kind: str
    # The demo fixture: agents follow a script, so results describe the
    # orchestration, not a model.
    scripted: bool
    model_policy: str
    models_by_role: dict[str, str]
    escalation_possible: bool
    # Why escalation cannot happen; empty when it can.
    escalation_unavailable: list[str] = Field(default_factory=list)
    limits: Limits
    # Whether parallel_coding can change scheduling for this task (None: unknown).
    parallel_relevant: bool | None
    fingerprint: str


def resolve_policy(requested: str | None, settings: Settings) -> str:
    """The model policy a run gets (as RunService.resolve_policy)."""
    policy = (requested or settings.model_policy or "config").strip().lower()
    return policy if policy in VALID_POLICIES else "config"


def arm_configuration(
    arm: BenchmarkArm,
    task: SuiteTask,
    settings: Settings,
    provider: str = "auto",
    budget_usd: float | None = None,
) -> ArmConfiguration:
    """What a run of ``arm`` on ``task`` gets. Raises ProviderConfigError
    when the provider cannot be used, as starting the run would."""
    name = provider_name_for(effective_provider_choice(provider, settings), settings)
    kind = provider_kind(name, settings)
    policy = resolve_policy(arm.model_policy, settings)

    requested = arm.requested_limits(task, budget_usd)
    if task.demo_task is not None:
        requested = demo_limits(requested, task.limits)
    limits = clamp_limits(requested, policy, settings)

    profiles = model_profiles(name, settings)
    models = {
        "planner": RECIPE_PLANNER
        if task.demo_task is not None
        else select_role_profile("planner", policy, profiles, settings).model,
        "coder": select_role_profile("coder", policy, profiles, settings).model,
        "reviewer": select_role_profile("reviewer", policy, profiles, settings).model,
        "verifier": VERIFIER,
    }

    unavailable: list[str] = []
    if limits.max_escalations == 0:
        if policy == "fast_only":
            unavailable.append("the fast_only policy pins every role to the fast model")
        elif task.limits.max_escalations == 0:
            unavailable.append(f"the task {task.id!r} allows no escalation")
        else:
            unavailable.append("the server's limits allow no escalation")
    if "strong" not in profiles:
        unavailable.append(
            "the demo fixture has a single scripted model"
            if name == "demo"
            else "no distinct strong model is configured for this endpoint"
        )
    possible = not unavailable

    parallel_relevant = task.parallel_waves
    effective = limits.model_dump(mode="json")
    # What cannot change behaviour is left out, so it cannot tell arms apart.
    if not possible:
        effective["max_escalations"] = 0
    if parallel_relevant is False:
        effective.pop("parallel_coding")
    fingerprint = _digest(
        {
            "task": task.id,
            "provider": name,
            "models_by_role": models,
            "escalation_possible": possible,
            "limits": effective,
        }
    )
    return ArmConfiguration(
        arm_id=arm.id,
        task_id=task.id,
        provider=name,
        provider_kind=kind,
        scripted=kind == "demo",
        model_policy=policy,
        models_by_role=models,
        escalation_possible=possible,
        escalation_unavailable=unavailable,
        limits=limits,
        parallel_relevant=parallel_relevant,
        fingerprint=fingerprint,
    )


def _digest(value: object) -> str:
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()[:16]


class IdenticalArms(BaseModel):
    """Arms that run identically on a task, and why."""

    task_id: str
    arm_ids: list[str]
    fingerprint: str
    reasons: list[str]
    explanation: str


def identical_by_design(
    configurations: list[ArmConfiguration], kinds: dict[str, str]
) -> list[IdenticalArms]:
    """Groups of arms whose effective configuration on a task is the same.

    ``kinds`` maps arm id to arm kind ("execution" / "model_policy").
    """
    groups: list[IdenticalArms] = []
    keyed = sorted(configurations, key=lambda c: (c.task_id, c.fingerprint, c.arm_id))
    for (task_id, fingerprint), members in groupby(keyed, key=lambda c: (c.task_id, c.fingerprint)):
        same = list(members)
        if len(same) < 2:
            continue
        reasons: list[str] = []
        arm_kinds = {kinds.get(c.arm_id) for c in same}
        if "execution" in arm_kinds and same[0].parallel_relevant is False:
            reasons.append(
                "the task has no wave with more than one step, so parallel and "
                "sequential coding schedule it identically"
            )
        if "model_policy" in arm_kinds:
            models = same[0].models_by_role
            reasons.append(
                "every policy selects the same model for each role ("
                + ", ".join(f"{role}: {model}" for role, model in models.items())
                + ")"
            )
            for reason in same[0].escalation_unavailable:
                reasons.append(f"escalation is impossible: {reason}")
        if not reasons:
            reasons.append("their effective configurations are the same")
        groups.append(
            IdenticalArms(
                task_id=task_id,
                arm_ids=[c.arm_id for c in same],
                fingerprint=fingerprint,
                reasons=reasons,
                explanation=(
                    f"On {task_id}, the arms {', '.join(c.arm_id for c in same)} run "
                    "identically by construction. Any agreement in their results "
                    "is not evidence that one configuration performs like the "
                    "other, and any difference is run-to-run variation."
                ),
            )
        )
    return groups


class EnvironmentProvenance(BaseModel):
    """The environment an experiment ran in. No endpoint URL or key."""

    app_version: str
    python_version: str
    platform: str
    mode: str
    provider_choice: str
    provider: str
    provider_kind: str
    scripted: bool
    pricing_known: bool
    monetary_enforced: bool
    execution_enabled: bool
    execution_sandbox: str
    verification_command: str
    # From SWARMOS_BUILD_COMMIT when the deployment sets it.
    build_commit: str | None
    collected_at: str


def collect_provenance(settings: Settings, provider: str = "auto") -> EnvironmentProvenance:
    name = provider_name_for(effective_provider_choice(provider, settings), settings)
    kind = provider_kind(name, settings)
    scripted = kind == "demo"
    return EnvironmentProvenance(
        app_version=__version__,
        python_version=sys.version.split()[0],
        platform=platform.platform(terse=True),
        mode=settings.mode,
        provider_choice=provider,
        provider=name,
        provider_kind=kind,
        scripted=scripted,
        pricing_known=settings.pricing_known and not scripted,
        monetary_enforced=settings.monetary_enforced and not scripted,
        execution_enabled=settings.execution_enabled,
        execution_sandbox=settings.execution_sandbox,
        verification_command=settings.verification_command,
        build_commit=os.environ.get("SWARMOS_BUILD_COMMIT", "").strip() or None,
        collected_at=utc_now(),
    )
