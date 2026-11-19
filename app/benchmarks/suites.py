"""Benchmark suites: fixed, versioned sets of tasks.

Suites are defined here, never submitted by callers. Each has a version
derived from everything that can change its results (the task definitions
and the sample project they run against), so two experiments with the same
suite version ran the same tasks on the same files.

* ``catalog``: the public demo catalog. Public-safe: these are the only runs
  the public demo accepts. With the demo provider its runs are scripted.
* ``local-fixtures``: free-form goals from ``benchmarks/tasks.jsonl``,
  local mode only. The demo fixture only scripts the bundled sample, so
  these tasks are meaningful only with a real model.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

from app.config import PROJECT_ROOT
from app.demo_tasks import demo_catalog
from app.models import Limits

# Next to the package in a checkout or an editable install; see fixture_tasks_path.
FIXTURE_TASKS = PROJECT_ROOT / "benchmarks" / "tasks.jsonl"
SAMPLE_PROJECT = PROJECT_ROOT / "samples" / "sample_project"

# Limits for free-form fixture tasks (the bench command's long-standing values;
# the budget comes from the caller).
FIXTURE_LIMITS = Limits(
    max_agent_calls=12,
    max_budget_usd=0.25,
    max_wall_seconds=120,
    max_retries=2,
    max_revisions=1,
    max_escalations=1,
)

_IGNORED_PARTS = {"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"}


class SuiteError(ValueError):
    """An unknown suite or task."""


@dataclass(frozen=True)
class SuiteTask:
    id: str
    title: str
    goal: str
    # The catalog task id for catalog suites; None for free-form goals.
    demo_task: str | None
    # The recipe ceiling (catalog) or the fixture defaults.
    limits: Limits
    # Some wave has more than one step, so parallel and sequential coding
    # schedule differently. None when the plan is not known in advance.
    parallel_waves: bool | None
    notes: str = ""
    # Everything about the task that can change its result, for the version.
    definition: dict[str, object] = field(default_factory=dict, repr=False)


@dataclass(frozen=True)
class BenchmarkSuite:
    id: str
    title: str
    description: str
    public: bool
    requires_real_model: bool
    tasks: tuple[SuiteTask, ...]
    version: str

    def task(self, task_id: str) -> SuiteTask:
        for task in self.tasks:
            if task.id == task_id:
                return task
        raise SuiteError(f"suite {self.id!r} has no task {task_id!r}")


def directory_digest(root: Path) -> str:
    """A digest of every file under ``root`` (paths and contents), ignoring caches."""
    digest = hashlib.sha256()
    if root.is_dir():
        files = sorted(
            path
            for path in root.rglob("*")
            if path.is_file() and not _IGNORED_PARTS.intersection(path.relative_to(root).parts)
        )
        for path in files:
            digest.update(path.relative_to(root).as_posix().encode())
            digest.update(b"\0")
            digest.update(path.read_bytes().replace(b"\r\n", b"\n"))
            digest.update(b"\0")
    return digest.hexdigest()


def suite_version(definition: dict[str, object]) -> str:
    canonical = json.dumps(definition, sort_keys=True, separators=(",", ":"))
    return "v1-" + hashlib.sha256(canonical.encode()).hexdigest()[:12]


def _versioned(
    suite_id: str,
    title: str,
    description: str,
    *,
    public: bool,
    requires_real_model: bool,
    tasks: list[SuiteTask],
    sample_project: Path,
) -> BenchmarkSuite:
    definition = {
        "suite": suite_id,
        "tasks": [task.definition for task in tasks],
        "sample_project": directory_digest(sample_project),
    }
    return BenchmarkSuite(
        id=suite_id,
        title=title,
        description=description,
        public=public,
        requires_real_model=requires_real_model,
        tasks=tuple(tasks),
        version=suite_version(definition),
    )


def catalog_suite(sample_project: Path = SAMPLE_PROJECT) -> BenchmarkSuite:
    tasks = []
    for demo in demo_catalog():
        waves = demo.plan.waves()
        tasks.append(
            SuiteTask(
                id=demo.id,
                title=demo.title,
                goal=demo.goal,
                demo_task=demo.id,
                limits=demo.limits,
                parallel_waves=any(len(wave) > 1 for wave in waves),
                notes=demo.description,
                definition={
                    "id": demo.id,
                    "goal": demo.goal,
                    "plan": demo.plan.model_dump(mode="json"),
                    "allowed_files": list(demo.allowed_files),
                    "read_only_files": list(demo.read_only_files),
                    "limits": demo.limits.model_dump(mode="json"),
                },
            )
        )
    return _versioned(
        "catalog",
        "Demo catalog",
        "The curated catalog tasks: fixed recipes on the bundled sample project. "
        "With the demo provider the agents are scripted, so results describe the "
        "orchestration, not a model.",
        public=True,
        requires_real_model=False,
        tasks=tasks,
        sample_project=sample_project,
    )


def fixture_tasks_path() -> Path:
    """Where ``benchmarks/tasks.jsonl`` is: beside the package (a checkout or
    an editable install), else under the working directory. A non-editable
    install copies only the package into site-packages, so the file is then
    found in the checkout the server runs from."""
    if FIXTURE_TASKS.exists():
        return FIXTURE_TASKS
    return Path.cwd() / "benchmarks" / "tasks.jsonl"


def local_fixtures_suite(
    path: Path | None = None, sample_project: Path = SAMPLE_PROJECT
) -> BenchmarkSuite:
    # Imported here: the legacy harness owns the task file format.
    from app.benchmarks.legacy import load_tasks

    path = path if path is not None else fixture_tasks_path()

    tasks = [
        SuiteTask(
            id=item.id,
            title=item.id,
            goal=item.goal,
            demo_task=None,
            limits=FIXTURE_LIMITS,
            parallel_waves=None,
            notes=item.notes,
            definition={
                "id": item.id,
                "goal": item.goal,
                "category": item.category,
                "limits": FIXTURE_LIMITS.model_dump(mode="json"),
            },
        )
        for item in load_tasks(path)
    ]
    return _versioned(
        "local-fixtures",
        "Local fixtures",
        "Free-form coding goals against the bundled sample project. Local mode only, "
        "and meaningful only with a real model: the demo fixture scripts only the "
        "catalog recipes.",
        public=False,
        requires_real_model=True,
        tasks=tasks,
        sample_project=sample_project,
    )


def all_suites() -> dict[str, BenchmarkSuite]:
    suites = [catalog_suite(), local_fixtures_suite()]
    return {suite.id: suite for suite in suites}


def get_suite(suite_id: str) -> BenchmarkSuite:
    suites = all_suites()
    if suite_id not in suites:
        raise SuiteError(f"unknown benchmark suite: {suite_id!r}")
    return suites[suite_id]
