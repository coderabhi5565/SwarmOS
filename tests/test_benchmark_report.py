"""The benchmark report (M7.6): a stored experiment rendered as Markdown,
from the same detail the API serves. Nothing is computed but the arm
position counts; nothing missing reads as zero; throughput is never
derived from sequential latencies."""

from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

import app.cli as cli
import app.main as main_module
from app.benchmarks.metrics import (
    CANCELLED_REASON,
    INTERRUPTED_REASON,
    WARMUP_REASON,
    TrialMetrics,
    TrialTimings,
)
from app.benchmarks.report import TIMING_ROWS, _ms, arm_positions, render_report
from app.benchmarks.runner import ExperimentRunner
from app.benchmarks.store import BenchmarkStore
from app.benchmarks.views import experiment_detail
from app.service import RunService
from app.store import RunStore
from tests.conftest import make_settings
from tests.test_benchmark_store import experiment_with_trials

SAMPLE = "sample_tag_normalization"
PIPELINE = "sample_parallel_pipeline"
PUBLIC = {"mode": "public_demo", "execution_sandbox": "restricted", "code_policy_enabled": True}


@pytest.fixture
def harness(tmp_path):
    made: list[RunStore] = []

    def build(**overrides):
        store = RunStore(tmp_path / "report.db")
        made.append(store)
        settings = make_settings(tmp_path, db_path=tmp_path / "report.db", **overrides)
        return ExperimentRunner(RunService(settings, store), BenchmarkStore(store), slot_poll_seconds=0.05), settings

    yield build
    for store in made:
        store.close()


def detail_of(runner: ExperimentRunner, experiment_id: str, settings):
    experiment = runner.benchmarks.get_experiment(experiment_id)
    return experiment_detail(experiment, runner.benchmarks.get_trials(experiment_id), settings)


def aggregate_for(detail, arm: str, task: str):
    return next(a for a in detail.task_aggregates if a.arm_id == arm and a.task_id == task)


# ----------------------------------------------------------------------
# a real scripted experiment
# ----------------------------------------------------------------------
async def test_a_scripted_experiment_reports_warmups_and_its_actual_measured_n(harness):
    runner, settings = harness()
    experiment = runner.create("catalog", ["parallel", "sequential"], 2, origin="cli", provider="demo", order_seed=7)
    await runner.run(experiment.experiment_id)
    detail = detail_of(runner, experiment.experiment_id, settings)
    text = render_report(detail)

    assert text.startswith("# Benchmark report: Demo catalog\n")
    assert "**Scripted provider:**" in text
    assert "| measured repetitions per arm and task | 2 |" in text
    assert "| warm-up repetitions per arm and task | 1 |" in text
    assert "| trials | 12 done of 12 |" in text  # 2 arms x 2 tasks x (2 + 1)
    for arm in ("parallel", "sequential"):
        for task in (SAMPLE, PIPELINE):
            # One warm-up excluded per pair; the two measured trials counted; nothing rerun.
            assert f"| `{arm}` | `{task}` | 2 | **incomplete** (2 of 20) | 1 | 0 (none) | 0 | 2 |" in text
            assert f"### `{arm}` on `{task}`" in text
    assert "2 of 2 measured trials have recorded run measurements." in text
    assert "| lifecycle (queued to terminal) | elapsed | 2 | 0 |" in text
    assert "| HTTP attempts | count | 2 | 0 | 0 | 0 | 0 | 0 |" in text  # scripted: a measured zero
    assert "P95 over 2 values (fewer than 20) is the largest observed value" in text
    # The same records render to the same bytes.
    assert render_report(detail_of(runner, experiment.experiment_id, settings)) == text


async def test_the_scripted_baseline_is_deterministic_apart_from_its_timings(harness):
    runner, settings = harness()

    async def outcomes():
        experiment = runner.create("catalog", ["parallel", "sequential"], 1, origin="cli", provider="demo", order_seed=42)
        await runner.run(experiment.experiment_id)
        return [
            (
                t.ordinal,
                t.arm_id,
                t.task_id,
                t.repetition,
                t.metrics.outcome,
                t.metrics.excluded_reason,
                t.metrics.task_success,
                t.metrics.verification_passed,
                t.metrics.agent_calls,
                t.metrics.step_retries,
                t.metrics.revisions,
                t.metrics.timings.provider_calls if t.metrics.timings else None,
                t.metrics.timings.http_attempts if t.metrics.timings else None,
            )
            for t in runner.benchmarks.get_trials(experiment.experiment_id)
        ]

    first = await outcomes()
    second = await outcomes()
    assert first == second
    assert all(row[4] == "excluded" and row[5] == WARMUP_REASON for row in first if row[3] == 0)
    assert all(row[4] == "success" for row in first if row[3] >= 1)


# ----------------------------------------------------------------------
# a hand-built sample: exclusions, failures, missing measurements
# ----------------------------------------------------------------------
def counted(lifecycle: float, *, success: bool = True, verified: bool = True, status: str = "recorded") -> TrialMetrics:
    if status == "recorded":
        timings = TrialTimings(
            measurement_status="recorded",
            measurements_version=1,
            lifecycle_ms=lifecycle,
            coder_busy_ms=lifecycle / 2,
            coder_wall_ms=lifecycle / 4,
            null_reasons={"planner_ms": "no planner node ran"},
        )
    else:
        timings = TrialTimings(measurement_status=status, null_reasons={"*": f"no run measurements: {status}"})
    return TrialMetrics(
        metrics_version=2,
        run_id="run_x",
        status="completed" if success else "failed",
        outcome="success" if success else "failure",
        task_success=success,
        verification_passed=verified,
        verification_runs=1,
        provider="demo",
        provider_kind="demo",
        scripted=True,
        model_policy="config",
        agent_calls=2,
        step_retries=0,
        call_retries=0,
        repair_rounds=0,
        revisions=0,
        escalations=0,
        timings=timings,
    )


def excluded(reason: str) -> TrialMetrics:
    return TrialMetrics(
        run_id="run_x",
        status="cancelled" if reason == CANCELLED_REASON else "failed",
        outcome="excluded",
        excluded_reason=reason,
        provider="demo",
        provider_kind="demo",
        scripted=True,
        model_policy="config",
        null_reasons={"*": f"excluded from the comparison: {reason}"},
    )


def hand_built(tmp_path, settings_overrides=None):
    """2 arms x 2 tasks x (1 warm-up + 20 measured). parallel on the sample
    task loses two trials to exclusions, has one task failure with a passed
    verification, one run whose measurements failed to save and one from
    before trial timings. Every other pair is a clean 20."""
    experiment, trials = experiment_with_trials(tmp_path, repetitions=21)
    experiment = experiment.model_copy(update={"repetitions": 20})  # repetition 0 is the warm-up
    special = {1: excluded(CANCELLED_REASON), 2: excluded(INTERRUPTED_REASON), 3: counted(300.0, success=False)}
    finished = []
    for trial in trials:
        if trial.repetition == 0:
            metrics = excluded(WARMUP_REASON)
        elif trial.arm_id == "parallel" and trial.task_id == SAMPLE:
            if trial.repetition in special:
                metrics = special[trial.repetition]
            elif trial.repetition == 4:
                metrics = counted(0, status="measurement_flush_failed")
            elif trial.repetition == 5:
                metrics = counted(0).model_copy(update={"timings": None, "metrics_version": 1})
            else:
                metrics = counted(100.0 * trial.repetition)
        else:
            metrics = counted(1000.0 + trial.repetition)
        finished.append(trial.model_copy(update={"status": "done", "metrics": metrics}))
    return experiment_detail(experiment, finished, make_settings(tmp_path, **(settings_overrides or {})))


def test_exclusions_failures_and_unavailable_measurements_are_reported(tmp_path):
    detail = hand_built(tmp_path)
    text = render_report(detail)
    # 20 scheduled, 2 excluded and not rerun: measured n 18, incomplete.
    assert (
        "| `parallel` | `sample_tag_normalization` | 18 | **incomplete** (18 of 20) | 1 | "
        "2 (cancelled (1); interrupted: the server stopped during the run (1)) | 0 | 20 | "
        "5.0% (1 of 20 non-warm-up trials) | 5.0% (1 of 20 non-warm-up trials) |"
    ) in text
    assert "| `sequential` | `sample_parallel_pipeline` | 20 | complete | 1 | 0 (none) | 0 | 20 | 0.0% (0 of 20 non-warm-up trials) |" in text
    # Over all tasks, parallel is incomplete because one of its tasks is.
    assert "| `parallel` | 38 | **incomplete** (every task needs 20) |" in text
    assert "| `sequential` | 40 | complete |" in text
    # A task failure whose verification passed: two separate facts.
    assert "| `parallel` | `sample_tag_normalization` | 94.4% (17 of 18 measured) | 100.0% (18 of 18 measured) |" in text
    # Counted trials without recorded measurements are counted by status, not dropped.
    assert "16 of 18 measured trials have recorded run measurements; left out of every figure: measurement_flush_failed (1); metrics_v1 (1)." in text


def test_timing_rows_render_the_backend_summaries_and_never_zero_for_missing(tmp_path):
    detail = hand_built(tmp_path)
    text = render_report(detail)
    summary = aggregate_for(detail, "parallel", SAMPLE).timings.metrics
    lifecycle = summary["lifecycle_ms"]
    assert lifecycle.n == 16 and lifecycle.missing == 0
    # Values 300, 600, 700, ..., 2000 ms: the backend's median and nearest-rank P95, as given.
    assert lifecycle.median == 1250.0 and lifecycle.p95 == 2000.0 and lifecycle.min == 300.0 and lifecycle.max == 2000.0
    assert "| lifecycle (queued to terminal) | elapsed | 16 | 0 | 1.25 s | 2.00 s | 300.00 ms | 2.00 s |" in text
    assert "| coder busy | busy | 16 | 0 | 625.00 ms | 1.00 s | 150.00 ms | 1.00 s |" in text
    assert "| coder wall (union) | elapsed | 16 | 0 | 312.50 ms | 500.00 ms | 75.00 ms | 500.00 ms |" in text
    assert "| planner | total | 0 | 16 (no planner node ran (16)) | — | — | — | — |" in text
    for line in text.splitlines():
        if line.startswith("| planner |"):
            assert "0.00" not in line
    # Every timing field has a row in every measured pair.
    assert text.count("| trial slot wait (before the run) |") == 4
    assert len(TIMING_ROWS) == 28


def test_the_method_states_the_conventions_and_makes_no_significance_claim(tmp_path):
    text = render_report(hand_built(tmp_path))
    assert "Trials run one at a time (concurrency 1)" in text
    assert "The first 1 repetition(s) of each arm and task run first and are excluded" in text
    assert "are **not rerun**" in text
    assert "P95 is nearest-rank: the value at 1-based rank ceil(0.95 × n)" in text
    assert "do not establish a statistically significant difference" in text
    assert "no arm is declared best" in text


def test_throughput_is_kept_apart_and_never_derived(tmp_path):
    text = render_report(hand_built(tmp_path))
    section = text.split("## Throughput\n", 1)[1].split("\n## ", 1)[0]
    assert section.strip().startswith("Not measured. This is a sequential latency baseline (concurrency 1)")
    assert "none may be derived from them" in section
    assert not re.search(r"\d\s*(runs?|trials?)\s*(/|per)\s*(s|sec|second|min|minute)\b", text)


# ----------------------------------------------------------------------
# trial order
# ----------------------------------------------------------------------
def test_position_counts_come_from_the_stored_schedule(tmp_path):
    detail = hand_built(tmp_path)
    positions = arm_positions(detail.trials, warmups=1)
    # The helper schedules parallel before sequential in every block: 40 measured blocks.
    assert positions == {"parallel": {1: 40}, "sequential": {2: 40}}
    text = render_report(detail)
    assert "| `parallel` | 40 | 0 |" in text and "| `sequential` | 0 | 40 |" in text
    assert "Positions are **not** balanced across arms." in text


async def test_a_seeded_rotation_reports_balanced_positions(harness):
    runner, settings = harness()
    experiment = runner.create("catalog", ["parallel", "sequential"], 2, origin="cli", provider="demo", order_seed=3)
    detail = detail_of(runner, experiment.experiment_id, settings)  # not run: the schedule is stored at creation
    positions = arm_positions(detail.trials, warmups=1)
    assert sum(positions["parallel"].values()) == sum(positions["sequential"].values()) == 4
    assert positions["parallel"] == positions["sequential"]  # 4 measured blocks, 2 arms: exactly balanced
    assert "Positions are balanced across arms." in render_report(detail)


def test_warmups_are_not_positions(tmp_path):
    detail = hand_built(tmp_path)
    total = sum(sum(counter.values()) for counter in arm_positions(detail.trials, warmups=1).values())
    assert total == 2 * 2 * 20  # measured trials only


# ----------------------------------------------------------------------
# the command, the API and the public demo
# ----------------------------------------------------------------------
def test_the_report_command_writes_the_rendered_report(tmp_path, monkeypatch, capsys):
    db = tmp_path / "cli.db"
    store = RunStore(db)
    experiment, trials = experiment_with_trials(tmp_path, repetitions=2)
    BenchmarkStore(store).create_experiment(experiment, trials, exclusive=True)
    store.close()
    settings = make_settings(tmp_path, db_path=db)
    monkeypatch.setattr(cli, "settings", settings)

    out = tmp_path / "report.md"
    assert cli.main(["--db", str(db), "report", experiment.experiment_id, "--out", str(out)]) == 0
    reopened = RunStore(db)
    try:
        benchmarks = BenchmarkStore(reopened)
        expected = render_report(
            experiment_detail(experiment, benchmarks.get_trials(experiment.experiment_id), settings)
        )
    finally:
        reopened.close()
    assert out.read_text(encoding="utf-8") == expected
    assert str(tmp_path) not in expected  # no host path in the report

    capsys.readouterr()
    assert cli.main(["--db", str(db), "report", experiment.experiment_id]) == 0
    assert capsys.readouterr().out == expected
    assert cli.main(["--db", str(db), "report", "bex_missing"]) == 2
    assert "experiment bex_missing not found" in capsys.readouterr().err


@pytest.mark.parametrize("mode", [{}, PUBLIC])
def test_there_is_no_report_endpoint(tmp_path, monkeypatch, mode):
    monkeypatch.setattr(main_module, "settings", make_settings(tmp_path, db_path=tmp_path / "api.db", **mode))
    with TestClient(main_module.app) as client:
        for path in ("/api/benchmarks/experiments/bex_x/report", "/api/benchmarks/report"):
            assert client.get(path).status_code in {404, 405}
            assert client.post(path).status_code in {404, 405}


def test_a_report_rendered_with_public_settings_withholds_host_details(tmp_path):
    text = render_report(hand_built(tmp_path, PUBLIC))
    assert "| python | — (not disclosed) |" in text
    assert "| platform | — (not disclosed) |" in text


def test_every_line_fits_the_repository_line_limit(tmp_path):
    assert max(len(line) for line in render_report(hand_built(tmp_path)).splitlines()) < 400


@pytest.mark.parametrize(
    ("value", "text"),
    [
        (None, "—"),
        (0, "0 ms"),  # a measured zero (a scripted call makes no HTTP attempt)
        (0.0, "0 ms"),
        (0.004, "0.004 ms"),  # a few microseconds: never rounded to look like zero
        (0.01, "0.01 ms"),
        (12.345, "12.35 ms"),
        (999.99, "999.99 ms"),
        (1000.0, "1.00 s"),
        (2750.0, "2.75 s"),
    ],
)
def test_durations_keep_measured_zeros_apart_from_tiny_values(value, text):
    assert _ms(value) == text
