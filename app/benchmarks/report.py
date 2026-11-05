"""A benchmark experiment as a Markdown report (M7.6).

The report renders what the database already holds, through the same
detail the API serves (``views.experiment_detail``): provenance, the
backend's aggregates and every trial. It computes no statistic. Its only
derivation is the arm-position count of §8 of the M7 proposal, read from
the stored trial schedule.

Rendering is pure: the same records give the same bytes (no clock, no
host facts read at report time). Values are formatted, never filled in:
a missing value is ``—`` with the backend's reason, never zero.

Throughput is not part of this report. Trials run one at a time
(concurrency 1), so the figures are latencies of sequential runs; a
throughput figure needs a separate fixed-concurrency experiment, which
does not exist (proposal §8, gap G10).
"""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Iterable

from app.api_models import (
    BenchmarkAggregate,
    BenchmarkExperimentDetail,
    BenchmarkTimingSummary,
    BenchmarkTrialInfo,
)

REPORT_VERSION = 1

# Trial timing fields in reading order: (field, label, kind). Kinds:
# elapsed (one interval or a union), busy (a sum, overlaps counted),
# total (time spent, not elapsed), count.
TIMING_ROWS: tuple[tuple[str, str, str], ...] = (
    ("lifecycle_ms", "lifecycle (queued to terminal)", "elapsed"),
    ("admission_ms", "admission", "elapsed"),
    ("execution_ms", "execution", "elapsed"),
    ("setup_ms", "setup", "elapsed"),
    ("graph_ms", "graph", "elapsed"),
    ("finalization_ms", "finalization", "elapsed"),
    ("planner_ms", "planner", "total"),
    ("reviewer_ms", "reviewer", "total"),
    ("coder_busy_ms", "coder busy", "busy"),
    ("coder_wall_ms", "coder wall (union)", "elapsed"),
    ("coder_critical_path_ms", "coder critical path", "elapsed"),
    ("provider_calls", "provider calls", "count"),
    ("provider_call_busy_ms", "provider call busy", "busy"),
    ("provider_call_wall_ms", "provider call wall (union)", "elapsed"),
    ("http_attempts", "HTTP attempts", "count"),
    ("http_attempt_busy_ms", "HTTP attempt busy", "busy"),
    ("http_attempt_wall_ms", "HTTP attempt wall (union)", "elapsed"),
    ("parse_total_ms", "response parsing", "total"),
    ("backoff_total_ms", "retry backoff", "total"),
    ("verification_ms", "verification (gating)", "total"),
    ("diagnostic_verification_ms", "diagnostic verification", "total"),
    ("graph_gap_ms", "graph gap", "total"),
    ("critical_orchestration_ms", "critical orchestration", "total"),
    ("parallel_orchestration_ms", "parallel orchestration", "total"),
    ("schedule_delay_total_ms", "step schedule delay", "total"),
    ("slot_wait_total_ms", "coding slot wait", "total"),
    ("ledger_wait_total_ms", "budget ledger wait", "total"),
    ("trial_slot_wait_ms", "trial slot wait (before the run)", "elapsed"),
)

MISSING = "—"


def _ms(value: float | None) -> str:
    if value is None:
        return MISSING
    if value < 1000:
        return f"{value:.2f} ms"
    return f"{value / 1000:.2f} s"


def _value(kind: str, value: float | None) -> str:
    if value is None:
        return MISSING
    return f"{value:g}" if kind == "count" else _ms(value)


def _percent(rate: float | None, count: int, of: int, what: str) -> str:
    if rate is None:
        return f"{MISSING} (no {what})"
    return f"{rate * 100:.1f}% ({count} of {of} {what})"


def _reasons(reasons: dict[str, int]) -> str:
    return "; ".join(f"{reason} ({count})" for reason, count in sorted(reasons.items())) or "none"


def _mean(value: float | None) -> str:
    return MISSING if value is None else f"{value:g}"


def arm_positions(trials: Iterable[BenchmarkTrialInfo], warmups: int) -> dict[str, Counter[int]]:
    """For each arm, how many measured (repetition, task) blocks it ran at
    each position (1 = first), from the stored schedule (proposal §8)."""
    blocks: dict[tuple[int, str], list[BenchmarkTrialInfo]] = defaultdict(list)
    for trial in trials:
        if trial.repetition >= warmups:
            blocks[(trial.repetition, trial.task_id)].append(trial)
    positions: dict[str, Counter[int]] = defaultdict(Counter)
    for block in blocks.values():
        for position, trial in enumerate(sorted(block, key=lambda item: item.ordinal), start=1):
            positions[trial.arm_id][position] += 1
    return dict(positions)


def render_report(detail: BenchmarkExperimentDetail) -> str:
    """The experiment as Markdown; see the module docstring."""
    lines: list[str] = []
    add = lines.append
    experiment = detail.experiment
    environment = detail.environment
    warmups = experiment.warmup_repetitions
    task_ids = list(dict.fromkeys(trial.task_id for trial in detail.trials))

    add(f"# Benchmark report: {experiment.suite_title}")
    add("")
    add(
        f"Experiment `{experiment.experiment_id}`, {experiment.status}. "
        + (
            "**Scripted provider:** these results describe the orchestration, not a model's ability."
            if experiment.scripted
            else "Real model: results depend on the provider as much as on SwarmOS."
        )
    )
    add("")
    add(f"Generated by `swarmos report` (report version {REPORT_VERSION}) from the stored experiment records.")

    add("")
    add("## Experiment")
    add("")
    add("| Field | Value |")
    add("| --- | --- |")
    facts = [
        ("suite", f"`{experiment.suite_id}` `{experiment.suite_version}`"),
        ("provider", f"{environment.provider} ({environment.provider_kind})"),
        ("arms", ", ".join(f"`{arm}`" for arm in experiment.arm_ids)),
        ("tasks", ", ".join(f"`{task}`" for task in task_ids) or MISSING),
        ("measured repetitions per arm and task", str(experiment.repetitions)),
        ("warm-up repetitions per arm and task", str(warmups)),
        ("trials", f"{experiment.trials_done} done of {experiment.trials_total}"),
        ("trial order seed", str(detail.order_seed)),
        ("created", experiment.created_at),
        ("started", experiment.started_at or MISSING),
        ("finished", experiment.finished_at or MISSING),
        ("app version", environment.app_version),
        ("build commit", environment.build_commit or f"{MISSING} (not recorded)"),
        ("python", environment.python_version or f"{MISSING} (not disclosed)"),
        ("platform", environment.platform or f"{MISSING} (not disclosed)"),
        ("verification command", f"`{environment.verification_command}`"),
        ("test execution", f"{'enabled' if environment.execution_enabled else 'disabled'}, {environment.execution_sandbox} sandbox"),
    ]
    for label, value in facts:
        add(f"| {label} | {value} |")
    if experiment.error:
        add("")
        add(f"Experiment error: {experiment.error}")

    add("")
    add("## Method")
    add("")
    add(
        "- **Sequential latency only.** Trials run one at a time (concurrency 1), in the stored seeded order; "
        "every figure below is a latency of a run executed alone."
    )
    add(
        f"- **Warm-up.** The first {warmups} repetition(s) of each arm and task run first and are excluded from "
        "every rate, distribution and timing (reason `warm-up`)."
        if warmups
        else "- **Warm-up.** None: this experiment was scheduled without warm-up repetitions."
    )
    add(
        "- **Measured n** counts trials that finished with a success or a failure. Cancelled, interrupted and "
        "orchestration-error trials are excluded with their reason and are **not rerun**, so a short sample "
        "reports its actual n and is marked incomplete."
    )
    add(
        "- **Timings** come only from each run's persisted span measurements. A trial without recorded "
        "measurements is counted by status and enters no timing figure; a value a run did not establish is "
        f"`{MISSING}` with its reason, never zero."
    )
    add(
        "- **Kinds.** *elapsed* is one interval or the length of a union; *busy* is a sum over possibly "
        "overlapping intervals; *total* is time spent, not elapsed; *count* is a number of events."
    )
    add(
        "- **Statistics.** The median is `statistics.median` (the mean of the two middle values for even n). "
        "P95 is nearest-rank: the value at 1-based rank ceil(0.95 × n) of the sorted values, always an "
        "observed value; for n < 20 it is the maximum."
    )
    add(
        "- **No significance claim.** Twenty measured trials per arm and task do not establish a statistically "
        "significant difference. No confidence interval or test is computed, and no arm is declared best."
    )

    if detail.notes:
        add("")
        add("## Notes from the backend")
        add("")
        for note in detail.notes:
            add(f"- {note}")

    add("")
    add("## Identical by design")
    add("")
    if not detail.identical_by_design:
        add("No arms ran identically by construction on any task.")
    for group in detail.identical_by_design:
        add(f"- On `{group.task_id}`: {', '.join(f'`{arm}`' for arm in group.arm_ids)}. {group.explanation}")
        for reason in group.reasons:
            add(f"  - {reason}")

    add("")
    add("## Trial order")
    add("")
    positions = arm_positions(detail.trials, warmups)
    if not positions:
        add("No measured trial is scheduled.")
    else:
        width = max(max(counter) for counter in positions.values())
        add("Measured (repetition, task) blocks each arm ran at each position (1 = first in its block).")
        add("")
        add("| arm | " + " | ".join(f"position {i}" for i in range(1, width + 1)) + " |")
        add("| --- |" + " --- |" * width)
        for arm in experiment.arm_ids:
            counter = positions.get(arm, Counter())
            add(f"| `{arm}` | " + " | ".join(str(counter.get(i, 0)) for i in range(1, width + 1)) + " |")
        balanced = len({tuple(positions.get(arm, Counter()).get(i, 0) for i in range(1, width + 1)) for arm in experiment.arm_ids}) == 1
        add("")
        add("Positions are balanced across arms." if balanced else "Positions are **not** balanced across arms.")

    add("")
    add("## Samples by arm and task")
    add("")
    add(
        "| arm | task | measured n | sample | warm-ups | excluded (reasons) | incomplete | non-warm-up | cancelled | interrupted |"
    )
    add("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for aggregate in detail.task_aggregates:
        add(_sample_row(aggregate))
    add("")
    add("Over all tasks, per arm (complete only when every task is):")
    add("")
    add("| arm | measured n | sample | warm-ups | excluded (reasons) | non-warm-up | cancelled | interrupted |")
    add("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for aggregate in detail.aggregates:
        add(
            f"| `{aggregate.arm_id}` | {aggregate.counted} | {_sample(aggregate)} | {aggregate.warmups} | "
            f"{aggregate.excluded} ({_reasons(aggregate.excluded_reasons)}) | {aggregate.non_warmup_trials} | "
            f"{_percent(aggregate.cancellation_rate, aggregate.cancelled, aggregate.non_warmup_trials, 'non-warm-up trials')} | "
            f"{_percent(aggregate.interrupted_rate, aggregate.interrupted, aggregate.non_warmup_trials, 'non-warm-up trials')} |"
        )

    add("")
    add("## Outcomes by arm and task")
    add("")
    add("Task success (the run completed) and verification (the gating tests passed) are separate facts.")
    add("")
    add("| arm | task | task success | verification passed | mean agent calls | mean retries (step / call) | mean repair rounds | mean revisions | mean escalations |")
    add("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for aggregate in detail.task_aggregates:
        add(
            f"| `{aggregate.arm_id}` | `{aggregate.task_id}` | "
            f"{_percent(aggregate.task_success_rate, aggregate.task_successes, aggregate.counted, 'measured')} | "
            f"{_percent(aggregate.verification_pass_rate, aggregate.verification_passes, aggregate.counted, 'measured')} | "
            f"{_mean(aggregate.mean_agent_calls)} | {_mean(aggregate.mean_step_retries)} / {_mean(aggregate.mean_call_retries)} | "
            f"{_mean(aggregate.mean_repair_rounds)} | {_mean(aggregate.mean_revisions)} | {_mean(aggregate.mean_escalations)} |"
        )

    add("")
    add("## Run timings by arm and task")
    for aggregate in detail.task_aggregates:
        add("")
        add(f"### `{aggregate.arm_id}` on `{aggregate.task_id}`")
        add("")
        timings = aggregate.timings
        unavailable = sum(timings.unavailable.values())
        add(
            f"{timings.measured} of {aggregate.counted} measured trials have recorded run measurements"
            + (f"; left out of every figure: {_reasons(timings.unavailable)}." if unavailable else ".")
        )
        if timings.measured == 0:
            add("")
            add("No timing figures.")
            continue
        add("")
        add("| metric | kind | n | missing (reasons) | median | p95 | min | max |")
        add("| --- | --- | --- | --- | --- | --- | --- | --- |")
        for field, label, kind in TIMING_ROWS:
            add(_timing_row(label, kind, timings.metrics.get(field)))
        if timings.measured < aggregate.sample_required:
            add("")
            add(
                f"P95 over {timings.measured} values (fewer than {aggregate.sample_required}) is the largest "
                "observed value, not a stable tail estimate."
            )

    add("")
    add("## Throughput")
    add("")
    add(
        "Not measured. This is a sequential latency baseline (concurrency 1); no figure above is a "
        "throughput, and none may be derived from them. Throughput needs a separate experiment at a fixed "
        "concurrency, which SwarmOS does not run yet (M7 proposal §8, gap G10)."
    )

    add("")
    add("## Limitations")
    add("")
    for limitation in (
        "One machine and one process; results describe this environment only.",
        "Host facts beyond the platform string and Python version (CPU count, memory) were not recorded.",
        "Failures are not broken down by error class: the trial metrics do not record it.",
        "The scripted provider answers instantly, so model latency is absent and call times are in-process time.",
    ):
        add(f"- {limitation}")
    return "\n".join(lines) + "\n"


def _sample(aggregate: BenchmarkAggregate) -> str:
    # The requirement is per arm and task; over all tasks, every task must meet it.
    if aggregate.task_id is None:
        need = f"every task needs {aggregate.sample_required}"
        return "complete" if aggregate.sample_complete else f"**incomplete** ({need})"
    if aggregate.sample_complete:
        return "complete"
    return f"**incomplete** ({aggregate.counted} of {aggregate.sample_required})"


def _sample_row(aggregate: BenchmarkAggregate) -> str:
    return (
        f"| `{aggregate.arm_id}` | `{aggregate.task_id}` | {aggregate.counted} | {_sample(aggregate)} | "
        f"{aggregate.warmups} | {aggregate.excluded} ({_reasons(aggregate.excluded_reasons)}) | {aggregate.incomplete} | "
        f"{aggregate.non_warmup_trials} | "
        f"{_percent(aggregate.cancellation_rate, aggregate.cancelled, aggregate.non_warmup_trials, 'non-warm-up trials')} | "
        f"{_percent(aggregate.interrupted_rate, aggregate.interrupted, aggregate.non_warmup_trials, 'non-warm-up trials')} |"
    )


def _timing_row(label: str, kind: str, summary: BenchmarkTimingSummary | None) -> str:
    if summary is None:
        return f"| {label} | {kind} | {MISSING} | not reported | {MISSING} | {MISSING} | {MISSING} | {MISSING} |"
    missing = f"{summary.missing} ({_reasons(summary.missing_reasons)})" if summary.missing else "0"
    cells = (summary.median, summary.p95, summary.min, summary.max)
    return f"| {label} | {kind} | {summary.n} | {missing} | " + " | ".join(_value(kind, value) for value in cells) + " |"
