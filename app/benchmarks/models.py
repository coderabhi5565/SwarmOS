"""Benchmark experiments and trials, as persisted.

An experiment runs every (arm, task, repetition) combination of a suite as
a trial; each trial's run is an ordinary SwarmOS run, linked by ``run_id``.
An experiment keeps everything needed to reproduce and judge it: the suite
version, the arms, each arm's effective configuration per task (with its
fingerprint), the order seed, and the environment.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.benchmarks.metrics import TrialMetrics
from app.benchmarks.provenance import ArmConfiguration, EnvironmentProvenance
from app.models import new_id, utc_now

ExperimentStatus = Literal[
    "queued",
    "running",
    # Every trial ran.
    "completed",
    # Some trials did not run or could not start.
    "partial",
    "cancelled",
    "failed",
    # The server stopped while the experiment was running.
    "interrupted",
]
TrialStatus = Literal[
    "pending",
    "running",
    # The run finished; its metrics are recorded (the outcome is in them).
    "done",
    # Never started (the experiment stopped first).
    "not_run",
    # The run could not be started.
    "error",
]
ExperimentOrigin = Literal["cli", "api"]


class BenchmarkExperiment(BaseModel):
    experiment_id: str = Field(default_factory=lambda: new_id("bex"))
    created_at: str = Field(default_factory=utc_now)
    updated_at: str = Field(default_factory=utc_now)
    started_at: str | None = None
    finished_at: str | None = None
    status: ExperimentStatus = "queued"
    origin: ExperimentOrigin
    suite_id: str
    suite_version: str
    provider: str
    provider_kind: str
    scripted: bool
    # Measured repetitions per arm and task. Since M7.3 the schedule adds a
    # warm-up repetition (repetition 0) per arm and task on top; see
    # runner.warmup_repetitions.
    repetitions: int = Field(ge=1)
    order_seed: int
    arm_ids: list[str] = Field(min_length=1)
    configurations: list[ArmConfiguration]
    provenance: EnvironmentProvenance
    error: str | None = None


class BenchmarkTrial(BaseModel):
    trial_id: str = Field(default_factory=lambda: new_id("btr"))
    experiment_id: str
    # Execution order within the experiment, from 0.
    ordinal: int = Field(ge=0)
    arm_id: str
    task_id: str
    repetition: int = Field(ge=0)
    # The arm's configuration fingerprint on this task.
    fingerprint: str
    status: TrialStatus = "pending"
    run_id: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    # Snapshot taken when the run finished (runs never change afterwards).
    metrics: TrialMetrics | None = None
    error: str | None = None
