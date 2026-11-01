"""Canonical demo tasks.

A demo task is a task definition, not a claim of success: it fixes the goal and
the plan so a small local model cannot turn a one-file demo into a multi-step
rewrite. Coding, review, and verification still run for real, and the trace
records that the recipe supplied the plan.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.models import Limits, Plan, PlanStep

SAMPLE_TASK_ID = "sample_tag_normalization"

SAMPLE_GOAL = (
    "Implement normalize_tags in target.py so the three tests in "
    "tests/test_target.py pass."
)

SAMPLE_PLAN = Plan(
    steps=[
        PlanStep(
            id="draft_implementation",
            title="Implement normalize_tags in target.py",
            detail=(
                "Implement normalize_tags in target.py. It must trim whitespace, "
                "lowercase, drop empty entries, deduplicate, and sort ascending. "
                "You MUST return sorted(...): "
                "return sorted({tag.strip().lower() for tag in tags if tag.strip()}). "
                "Do NOT return list(set(...)): set iteration order is not sorted. "
                "Return the complete target.py file. tests/test_target.py is "
                "read-only and must not be modified."
            ),
            acceptance_criteria=[
                "python -m pytest -q reports 3 passed",
                "tests/test_target.py is unchanged",
                "normalize_tags trims, lowercases, drops blanks, deduplicates, and sorts",
                "the returned list is sorted ascending, not merely deduplicated",
            ],
            depends_on=[],
            target_files=["target.py"],
        )
    ],
    assumptions=[
        "The workspace is the bundled sample project.",
        "The three tests in tests/test_target.py are the acceptance criteria.",
    ],
)

SAMPLE_ALLOWED_FILES = ("target.py",)
SAMPLE_READ_ONLY_FILES = ("tests/test_target.py",)
SAMPLE_LIMITS = Limits(
    max_agent_calls=6,
    max_budget_usd=0.25,
    max_wall_seconds=120,
    max_retries=0,
    max_revisions=1,
    max_escalations=0,
)


class DemoTaskError(ValueError):
    """The requested demo task is unknown or misconfigured."""


@dataclass(frozen=True)
class DemoTask:
    id: str
    goal: str
    plan: Plan
    allowed_files: tuple[str, ...]
    read_only_files: tuple[str, ...]
    limits: Limits
    title: str = ""
    description: str = ""

    def describe(self) -> dict[str, object]:
        """The public catalog entry: what a visitor may choose to run."""
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "goal": self.goal,
            "steps": [
                {"id": step.id, "title": step.title, "depends_on": step.depends_on}
                for step in self.plan.steps
            ],
            "waves": [[step.id for step in wave] for wave in self.plan.waves()],
            "allowed_files": list(self.allowed_files),
            "read_only_files": list(self.read_only_files),
            "limits": self.limits.model_dump(),
        }


def _validate(task: DemoTask) -> DemoTask:
    """A recipe may only touch files it allows, and must protect its tests."""
    if not task.allowed_files:
        raise DemoTaskError(f"{task.id} must allow at least one file")
    allowed = set(task.allowed_files)
    for step in task.plan.steps:
        outside = set(step.target_files) - allowed
        if outside:
            raise DemoTaskError(
                f"{task.id}: step {step.id} targets files the recipe does not allow: "
                f"{sorted(outside)}"
            )
    if not any(path.startswith("tests/") for path in task.read_only_files):
        raise DemoTaskError(f"{task.id} must mark the tests as read-only")
    if allowed & set(task.read_only_files):
        raise DemoTaskError(f"{task.id}: a file cannot be both allowed and read-only")
    return task


SAMPLE_TASK = _validate(
    DemoTask(
        id=SAMPLE_TASK_ID,
        goal=SAMPLE_GOAL,
        plan=SAMPLE_PLAN,
        allowed_files=SAMPLE_ALLOWED_FILES,
        read_only_files=SAMPLE_READ_ONLY_FILES,
        limits=SAMPLE_LIMITS,
        title="Fix one function",
        description=(
            "One coding step: implement normalize_tags so three read-only tests "
            "pass. Shows coding, evidence-checked review, and real verification."
        ),
    )
)

PIPELINE_TASK_ID = "sample_parallel_pipeline"
PIPELINE_GOAL = (
    "Implement normalize_tags in target.py so tests/test_target.py passes, and "
    "document the change in docs/change-notes.md."
)
PIPELINE_PLAN = Plan(
    steps=[
        PlanStep(
            id="inspect_tests",
            title="Inspect the failing tests",
            detail=(
                "Read tests/test_target.py and state the behaviour normalize_tags "
                "must have. This step makes no file changes."
            ),
            acceptance_criteria=["the required behaviour is stated in plain language"],
            depends_on=[],
            target_files=[],
        ),
        PlanStep(
            id="draft_implementation",
            title="Implement normalize_tags",
            detail=(
                "Implement normalize_tags in target.py: trim whitespace, lowercase, "
                "drop empty entries, deduplicate, and return the tags sorted "
                "ascending. Return the complete file. tests/test_target.py is "
                "read-only."
            ),
            acceptance_criteria=[
                "python -m pytest -q reports 3 passed",
                "normalize_tags trims, lowercases, drops blanks, deduplicates, and sorts",
            ],
            depends_on=[],
            target_files=["target.py"],
        ),
        PlanStep(
            id="document_change",
            title="Document the change",
            detail=(
                "Write docs/change-notes.md explaining what changed in target.py "
                "and why, based on the tests."
            ),
            acceptance_criteria=["docs/change-notes.md records the change and rationale"],
            depends_on=["inspect_tests", "draft_implementation"],
            target_files=["docs/change-notes.md"],
        ),
    ],
    assumptions=["The workspace is the bundled sample project."],
)

PIPELINE_TASK = _validate(
    DemoTask(
        id=PIPELINE_TASK_ID,
        goal=PIPELINE_GOAL,
        plan=PIPELINE_PLAN,
        allowed_files=("target.py", "docs/change-notes.md"),
        read_only_files=SAMPLE_READ_ONLY_FILES,
        limits=Limits(
            max_agent_calls=10,
            max_budget_usd=0.25,
            max_wall_seconds=180,
            max_retries=1,
            max_revisions=1,
            max_escalations=0,
        ),
        title="Parallel pipeline",
        description=(
            "Three steps in two dependency waves: two independent steps run in "
            "parallel, then a documentation step that depends on both."
        ),
    )
)

_DEMO_TASKS = {task.id: task for task in (SAMPLE_TASK, PIPELINE_TASK)}


def demo_catalog() -> list[DemoTask]:
    return list(_DEMO_TASKS.values())


def resolve_demo_task(task_id: str) -> DemoTask:
    try:
        return _DEMO_TASKS[task_id]
    except KeyError as exc:
        raise DemoTaskError(f"unknown demo task: {task_id!r}") from exc