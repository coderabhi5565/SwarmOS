"""API views of benchmark suites and experiments.

Builds the explicit response models in ``app.api_models`` from the domain
models, deciding what a caller may see:

* the public demo shows only public suites (the catalog) and experiments on
  them; anything else is treated as not found;
* host details (Python version, platform) are left out in the public demo;
* every free-text error is redacted: the configured endpoint URL and key
  never appear, and in the public demo no URL at all.
"""

from __future__ import annotations

from collections import Counter

from app.api_models import (
    BenchmarkAggregate,
    BenchmarkArmConfiguration,
    BenchmarkArmInfo,
    BenchmarkEnvironment,
    BenchmarkExperimentDetail,
    BenchmarkExperimentSummary,
    BenchmarkIdenticalArms,
    BenchmarkSuiteInfo,
    BenchmarkSuitesResponse,
    BenchmarkTaskInfo,
    BenchmarkTrialInfo,
    BenchmarkTrialMetrics,
)
from app.benchmarks.arms import ARMS
from app.benchmarks.metrics import aggregate
from app.benchmarks.models import BenchmarkExperiment, BenchmarkTrial
from app.benchmarks.provenance import identical_by_design
from app.benchmarks.runner import (
    MAX_REPETITIONS,
    MAX_TRIALS,
    WARMUP_REPETITIONS,
    warmup_repetitions,
)
from app.benchmarks.suites import SuiteError, all_suites, get_suite
from app.config import Settings
from app.redaction import REDACTED, PublicRedactor


def redact(text: str | None, settings: Settings) -> str | None:
    """Remove private configuration from free text (errors, reasons); in the
    public demo, also every URL, host path and address (``app.redaction``)."""
    if text is None:
        return None
    for secret in (settings.api_key, settings.base_url):
        if secret:
            text = text.replace(secret, REDACTED)
    if settings.is_public_demo:
        text = PublicRedactor(settings).text(text)
    return text


def visible_suite_ids(settings: Settings) -> set[str]:
    suites = all_suites().values()
    return {s.id for s in suites if s.public or not settings.is_public_demo}


def is_visible(experiment: BenchmarkExperiment, settings: Settings) -> bool:
    return experiment.suite_id in visible_suite_ids(settings)


def suites_response(settings: Settings, operator: bool = False) -> BenchmarkSuitesResponse:
    """``can_create``: always locally; in the public demo, for operators only."""
    visible = visible_suite_ids(settings)
    return BenchmarkSuitesResponse(
        mode=settings.mode,
        can_create=operator or not settings.is_public_demo,
        suites=[
            BenchmarkSuiteInfo(
                id=suite.id,
                title=suite.title,
                description=suite.description,
                version=suite.version,
                public=suite.public,
                requires_real_model=suite.requires_real_model,
                tasks=[
                    BenchmarkTaskInfo(
                        id=task.id,
                        title=task.title,
                        demo_task=task.demo_task,
                        parallel_waves=task.parallel_waves,
                        notes=task.notes,
                    )
                    for task in suite.tasks
                ],
            )
            for suite in all_suites().values()
            if suite.id in visible
        ],
        arms=[
            BenchmarkArmInfo(
                id=arm.id,
                kind=arm.kind,
                label=arm.label,
                description=arm.description,
                model_policy=arm.model_policy,
                parallel_coding=arm.parallel_coding,
                max_escalations=arm.max_escalations,
            )
            for arm in ARMS.values()
        ],
        max_repetitions=MAX_REPETITIONS,
        max_trials=MAX_TRIALS,
        warmup_repetitions=WARMUP_REPETITIONS,
    )


def _suite_title(suite_id: str) -> str:
    try:
        return get_suite(suite_id).title
    except SuiteError:
        return suite_id


def experiment_summary(
    experiment: BenchmarkExperiment, trials: list[BenchmarkTrial], settings: Settings
) -> BenchmarkExperimentSummary:
    return BenchmarkExperimentSummary(
        experiment_id=experiment.experiment_id,
        created_at=experiment.created_at,
        updated_at=experiment.updated_at,
        started_at=experiment.started_at,
        finished_at=experiment.finished_at,
        status=experiment.status,
        origin=experiment.origin,
        suite_id=experiment.suite_id,
        suite_title=_suite_title(experiment.suite_id),
        suite_version=experiment.suite_version,
        provider=experiment.provider,
        provider_kind=experiment.provider_kind,
        scripted=experiment.scripted,
        repetitions=experiment.repetitions,
        warmup_repetitions=warmup_repetitions(experiment, trials),
        arm_ids=list(experiment.arm_ids),
        trials_total=len(trials),
        trials_done=sum(1 for trial in trials if trial.status == "done"),
        error=redact(experiment.error, settings),
    )


def _aggregate(arm_id: str, task_id: str | None, trials: list[BenchmarkTrial]) -> BenchmarkAggregate:
    metrics = [trial.metrics for trial in trials if trial.metrics is not None]
    summary = aggregate(arm_id, metrics)
    return BenchmarkAggregate.model_validate(
        {
            **summary.model_dump(),
            "task_id": task_id,
            "trial_statuses": dict(Counter(trial.status for trial in trials)),
        }
    )


def experiment_detail(
    experiment: BenchmarkExperiment, trials: list[BenchmarkTrial], settings: Settings
) -> BenchmarkExperimentDetail:
    provenance = experiment.provenance
    public = settings.is_public_demo
    environment = BenchmarkEnvironment.model_validate(
        {
            **provenance.model_dump(exclude={"provider_choice"}),
            "verification_command": redact(provenance.verification_command, settings),
            "python_version": None if public else provenance.python_version,
            "platform": None if public else provenance.platform,
        }
    )
    kinds = {arm.id: arm.kind for arm in ARMS.values()}
    identical = identical_by_design(experiment.configurations, kinds)

    task_ids = list(dict.fromkeys(trial.task_id for trial in trials))
    task_aggregates = [
        _aggregate(arm_id, task_id, [t for t in trials if t.arm_id == arm_id and t.task_id == task_id])
        for task_id in task_ids
        for arm_id in experiment.arm_ids
    ]
    aggregates = []
    for arm_id in experiment.arm_ids:
        summary = _aggregate(arm_id, None, [t for t in trials if t.arm_id == arm_id])
        # The sample requirement is per arm and task: an arm is complete when
        # every one of its tasks is.
        per_task = [a for a in task_aggregates if a.arm_id == arm_id]
        complete = bool(per_task) and all(a.sample_complete for a in per_task)
        aggregates.append(summary.model_copy(update={"sample_complete": complete}))

    notes = [
        "All arms run the same orchestration graph; each differs only in its own "
        "configuration. No arm is declared best: compare the numbers with their "
        "sample sizes.",
        "Medians and P95s describe the measured trials only. Twenty trials per arm "
        "and task do not establish a statistically significant difference; none "
        "is claimed.",
    ]
    if experiment.scripted:
        notes.insert(
            0,
            "Scripted provider: the agents follow a script, so these results describe "
            "the orchestration, not a model's ability.",
        )
    if identical:
        notes.append(
            "Some arms run identically by construction on some tasks (see "
            "identical_by_design); their results are not evidence of a difference "
            "or of equivalence."
        )

    return BenchmarkExperimentDetail(
        experiment=experiment_summary(experiment, trials, settings),
        order_seed=experiment.order_seed,
        environment=environment,
        configurations=[
            BenchmarkArmConfiguration.model_validate(config.model_dump())
            for config in experiment.configurations
        ],
        identical_by_design=[
            BenchmarkIdenticalArms.model_validate(group.model_dump()) for group in identical
        ],
        aggregates=aggregates,
        task_aggregates=task_aggregates,
        trials=[
            BenchmarkTrialInfo(
                trial_id=trial.trial_id,
                ordinal=trial.ordinal,
                arm_id=trial.arm_id,
                task_id=trial.task_id,
                repetition=trial.repetition,
                fingerprint=trial.fingerprint,
                status=trial.status,
                run_id=trial.run_id,
                run_path=f"/api/runs/{trial.run_id}" if trial.run_id else None,
                started_at=trial.started_at,
                finished_at=trial.finished_at,
                error=redact(trial.error, settings),
                metrics=BenchmarkTrialMetrics.model_validate(trial.metrics.model_dump())
                if trial.metrics is not None
                else None,
            )
            for trial in trials
        ],
        notes=notes,
    )
