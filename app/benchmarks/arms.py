"""Benchmark arms: the fixed configurations an experiment compares.

Callers pick arms by id; there is no free-form configuration. Each arm
varies one dimension and leaves the rest to the task:

* execution arms vary how coding steps are scheduled (``parallel`` /
  ``sequential``), which matters even with the scripted demo provider on a
  task whose plan has a parallel wave;
* model-policy arms vary model selection and escalation (``fixed-fast`` /
  ``adaptive`` / ``multi-agent``), which matters only with a real provider
  that offers a distinct strong model and a task that allows escalation.

Whether an arm can make a difference is decided per experiment from the
provider actually used (see ``provenance.arm_configuration``).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from app.benchmarks.suites import SuiteTask
from app.models import Limits, RunRequest

ArmKind = Literal["execution", "model_policy"]


class ArmError(ValueError):
    """An unknown arm."""


@dataclass(frozen=True)
class BenchmarkArm:
    id: str
    kind: ArmKind
    label: str
    description: str
    # None leaves the server's default policy.
    model_policy: Literal["fast_only", "adaptive", "role_routed"] | None = None
    # None leaves the task's setting.
    parallel_coding: bool | None = None
    # None leaves the task's limit.
    max_escalations: int | None = None

    def requested_limits(self, task: SuiteTask, budget_usd: float | None = None) -> Limits:
        """The limits this arm requests for ``task``, before the server clamps them."""
        update: dict[str, object] = {}
        if self.parallel_coding is not None:
            update["parallel_coding"] = self.parallel_coding
        if self.max_escalations is not None:
            update["max_escalations"] = self.max_escalations
        if budget_usd is not None:
            update["max_budget_usd"] = budget_usd
        return task.limits.model_copy(update=update)

    def request(
        self, task: SuiteTask, provider: str = "auto", budget_usd: float | None = None
    ) -> RunRequest:
        """The run request for one trial of this arm on ``task``."""
        return RunRequest(
            goal=task.goal,
            demo_task=task.demo_task,  # type: ignore[arg-type]
            provider=provider,  # type: ignore[arg-type]
            model_policy=self.model_policy,
            limits=self.requested_limits(task, budget_usd),
        )


ARMS: dict[str, BenchmarkArm] = {
    arm.id: arm
    for arm in (
        BenchmarkArm(
            "parallel",
            "execution",
            "Parallel coding",
            "independent steps in a wave are coded concurrently",
            parallel_coding=True,
        ),
        BenchmarkArm(
            "sequential",
            "execution",
            "Sequential coding",
            "steps are coded one at a time, even within a wave",
            parallel_coding=False,
        ),
        BenchmarkArm(
            "fixed-fast",
            "model_policy",
            "Fixed fast",
            "fast profile for every role; no escalation",
            model_policy="fast_only",
            max_escalations=0,
        ),
        BenchmarkArm(
            "adaptive",
            "model_policy",
            "Adaptive",
            "fast first, one escalation to strong if configured",
            model_policy="adaptive",
            max_escalations=1,
        ),
        BenchmarkArm(
            "multi-agent",
            "model_policy",
            "Role-routed",
            "role-routed profiles with escalation allowed",
            model_policy="role_routed",
            max_escalations=1,
        ),
    )
}


def get_arm(arm_id: str) -> BenchmarkArm:
    try:
        return ARMS[arm_id]
    except KeyError as exc:
        raise ArmError(f"unknown benchmark arm: {arm_id!r}") from exc
