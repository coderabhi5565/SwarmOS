"""Persistence for benchmark experiments and trials.

The tables live in the same SQLite database as runs (see ``app.store``) and
are written through ``RunStore.transaction``, so they share its connection
and lock. Runs and their traces are never written here.
"""

from __future__ import annotations

import json
import sqlite3

from app.benchmarks.metrics import TrialMetrics
from app.benchmarks.models import BenchmarkExperiment, BenchmarkTrial
from app.benchmarks.provenance import ArmConfiguration, EnvironmentProvenance
from app.models import utc_now
from app.store import RunStore

_EXPERIMENT_COLUMNS = (
    "experiment_id",
    "created_at",
    "updated_at",
    "started_at",
    "finished_at",
    "status",
    "origin",
    "suite_id",
    "suite_version",
    "provider",
    "provider_kind",
    "scripted",
    "repetitions",
    "order_seed",
    "arm_ids_json",
    "configurations_json",
    "provenance_json",
    "error",
)
_TRIAL_COLUMNS = (
    "trial_id",
    "experiment_id",
    "ordinal",
    "arm_id",
    "task_id",
    "repetition",
    "fingerprint",
    "status",
    "run_id",
    "started_at",
    "finished_at",
    "metrics_json",
    "metrics_version",
    "error",
)


class BenchmarkStoreError(ValueError):
    """A write that would make the stored benchmark inconsistent."""


def _experiment_row(item: BenchmarkExperiment) -> tuple[object, ...]:
    return (
        item.experiment_id,
        item.created_at,
        item.updated_at,
        item.started_at,
        item.finished_at,
        item.status,
        item.origin,
        item.suite_id,
        item.suite_version,
        item.provider,
        item.provider_kind,
        int(item.scripted),
        item.repetitions,
        item.order_seed,
        json.dumps(item.arm_ids),
        json.dumps([config.model_dump(mode="json") for config in item.configurations]),
        item.provenance.model_dump_json(),
        item.error,
    )


def _trial_row(item: BenchmarkTrial) -> tuple[object, ...]:
    return (
        item.trial_id,
        item.experiment_id,
        item.ordinal,
        item.arm_id,
        item.task_id,
        item.repetition,
        item.fingerprint,
        item.status,
        item.run_id,
        item.started_at,
        item.finished_at,
        item.metrics.model_dump_json() if item.metrics is not None else None,
        item.metrics.metrics_version if item.metrics is not None else None,
        item.error,
    )


def _experiment(row: sqlite3.Row) -> BenchmarkExperiment:
    return BenchmarkExperiment(
        experiment_id=row["experiment_id"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        started_at=row["started_at"],
        finished_at=row["finished_at"],
        status=row["status"],
        origin=row["origin"],
        suite_id=row["suite_id"],
        suite_version=row["suite_version"],
        provider=row["provider"],
        provider_kind=row["provider_kind"],
        scripted=bool(row["scripted"]),
        repetitions=row["repetitions"],
        order_seed=row["order_seed"],
        arm_ids=json.loads(row["arm_ids_json"]),
        configurations=[
            ArmConfiguration.model_validate(item) for item in json.loads(row["configurations_json"])
        ],
        provenance=EnvironmentProvenance.model_validate_json(row["provenance_json"]),
        error=row["error"],
    )


def _trial(row: sqlite3.Row) -> BenchmarkTrial:
    metrics = row["metrics_json"]
    return BenchmarkTrial(
        trial_id=row["trial_id"],
        experiment_id=row["experiment_id"],
        ordinal=row["ordinal"],
        arm_id=row["arm_id"],
        task_id=row["task_id"],
        repetition=row["repetition"],
        fingerprint=row["fingerprint"],
        status=row["status"],
        run_id=row["run_id"],
        started_at=row["started_at"],
        finished_at=row["finished_at"],
        metrics=TrialMetrics.model_validate_json(metrics) if metrics else None,
        error=row["error"],
    )


class BenchmarkStore:
    def __init__(self, store: RunStore) -> None:
        self.store = store

    # ------------------------------------------------------------------
    def create_experiment(
        self, experiment: BenchmarkExperiment, trials: list[BenchmarkTrial]
    ) -> None:
        """Insert an experiment with all its trials, atomically."""
        if not trials:
            raise BenchmarkStoreError("an experiment needs at least one trial")
        foreign = [t.trial_id for t in trials if t.experiment_id != experiment.experiment_id]
        if foreign:
            raise BenchmarkStoreError(f"trials of another experiment: {foreign}")
        unknown = sorted({t.arm_id for t in trials} - set(experiment.arm_ids))
        if unknown:
            raise BenchmarkStoreError(f"trials for arms the experiment does not compare: {unknown}")
        with self.store.transaction() as conn:
            conn.execute(
                f"INSERT INTO benchmark_experiments ({','.join(_EXPERIMENT_COLUMNS)}) "
                f"VALUES ({','.join('?' for _ in _EXPERIMENT_COLUMNS)})",
                _experiment_row(experiment),
            )
            conn.executemany(
                f"INSERT INTO benchmark_trials ({','.join(_TRIAL_COLUMNS)}) "
                f"VALUES ({','.join('?' for _ in _TRIAL_COLUMNS)})",
                [_trial_row(trial) for trial in trials],
            )

    def save_experiment(self, experiment: BenchmarkExperiment) -> BenchmarkExperiment:
        """Update an existing experiment's row; returns it with updated_at set."""
        saved = experiment.model_copy(update={"updated_at": utc_now()})
        updates = ",".join(f"{column}=?" for column in _EXPERIMENT_COLUMNS[1:])
        with self.store.transaction() as conn:
            cursor = conn.execute(
                f"UPDATE benchmark_experiments SET {updates} WHERE experiment_id = ?",
                (*_experiment_row(saved)[1:], saved.experiment_id),
            )
            if cursor.rowcount != 1:
                raise BenchmarkStoreError(f"unknown experiment: {experiment.experiment_id}")
        return saved

    def save_trial(self, trial: BenchmarkTrial) -> None:
        """Update an existing trial's row (status, run link, metrics snapshot)."""
        updates = ",".join(f"{column}=?" for column in _TRIAL_COLUMNS[1:])
        with self.store.transaction() as conn:
            cursor = conn.execute(
                f"UPDATE benchmark_trials SET {updates} WHERE trial_id = ?",
                (*_trial_row(trial)[1:], trial.trial_id),
            )
            if cursor.rowcount != 1:
                raise BenchmarkStoreError(f"unknown trial: {trial.trial_id}")

    # ------------------------------------------------------------------
    def get_experiment(self, experiment_id: str) -> BenchmarkExperiment | None:
        with self.store.transaction() as conn:
            row = conn.execute(
                "SELECT * FROM benchmark_experiments WHERE experiment_id = ?", (experiment_id,)
            ).fetchone()
        return _experiment(row) if row is not None else None

    def get_trials(self, experiment_id: str) -> list[BenchmarkTrial]:
        """An experiment's trials in execution order."""
        with self.store.transaction() as conn:
            rows = conn.execute(
                "SELECT * FROM benchmark_trials WHERE experiment_id = ? ORDER BY ordinal",
                (experiment_id,),
            ).fetchall()
        return [_trial(row) for row in rows]

    def trial_for_run(self, run_id: str) -> BenchmarkTrial | None:
        with self.store.transaction() as conn:
            row = conn.execute(
                "SELECT * FROM benchmark_trials WHERE run_id = ?", (run_id,)
            ).fetchone()
        return _trial(row) if row is not None else None

    def active_experiments(self) -> list[BenchmarkExperiment]:
        """Experiments queued or running, oldest first."""
        with self.store.transaction() as conn:
            rows = conn.execute(
                "SELECT * FROM benchmark_experiments WHERE status IN ('queued', 'running') "
                "ORDER BY created_at, experiment_id"
            ).fetchall()
        return [_experiment(row) for row in rows]

    def list_experiments_page(
        self, limit: int = 25, before: str | None = None
    ) -> tuple[list[BenchmarkExperiment], str | None]:
        """Newest-first page of experiments and the cursor for the next page.

        Keyset pagination on ``(created_at, experiment_id)``, like the run
        history. Raises ``KeyError`` for an unknown cursor.
        """
        limit = max(1, min(limit, 200))
        with self.store.transaction() as conn:
            if before is None:
                rows = conn.execute(
                    "SELECT * FROM benchmark_experiments "
                    "ORDER BY created_at DESC, experiment_id DESC LIMIT ?",
                    (limit + 1,),
                ).fetchall()
            else:
                anchor = conn.execute(
                    "SELECT created_at FROM benchmark_experiments WHERE experiment_id = ?",
                    (before,),
                ).fetchone()
                if anchor is None:
                    raise KeyError(before)
                rows = conn.execute(
                    "SELECT * FROM benchmark_experiments "
                    "WHERE created_at < ? OR (created_at = ? AND experiment_id < ?) "
                    "ORDER BY created_at DESC, experiment_id DESC LIMIT ?",
                    (anchor["created_at"], anchor["created_at"], before, limit + 1),
                ).fetchall()
        page = [_experiment(row) for row in rows[:limit]]
        return page, (page[-1].experiment_id if len(rows) > limit else None)
