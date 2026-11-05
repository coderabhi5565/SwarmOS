"""SQLite persistence for runs and their append-only traces."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from app.events import validate_payload
from app.models import (
    Plan,
    ReviewOutput,
    RunRecord,
    TraceEvent,
    VerificationResult,
    utc_now,
)
from app.timings import current as current_timings
from app.timings.process import PROCESS

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    run_id            TEXT PRIMARY KEY,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    goal              TEXT NOT NULL,
    provider          TEXT NOT NULL,
    provider_kind     TEXT NOT NULL DEFAULT 'unknown',
    provider_warning  TEXT,
    status            TEXT NOT NULL,
    limits_json       TEXT NOT NULL,
    model_policy      TEXT NOT NULL DEFAULT 'config',
    models_by_role_json TEXT NOT NULL DEFAULT '{}',
    plan_json         TEXT,
    review_json       TEXT,
    verification_json TEXT,
    summary           TEXT NOT NULL DEFAULT '',
    error             TEXT,
    cost_usd          REAL NOT NULL DEFAULT 0,
    monetary_enforced INTEGER NOT NULL DEFAULT 0,
    usage_available   INTEGER NOT NULL DEFAULT 0,
    agent_calls       INTEGER NOT NULL DEFAULT 0,
    escalations       INTEGER NOT NULL DEFAULT 0,
    revisions         INTEGER NOT NULL DEFAULT 0,
    duration_ms       INTEGER NOT NULL DEFAULT 0,
    changed_files_json TEXT NOT NULL DEFAULT '[]',
    artifacts_json     TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS trace_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id     TEXT NOT NULL UNIQUE,
    run_id       TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL,
    at           TEXT NOT NULL,
    kind         TEXT NOT NULL,
    message      TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_trace_run ON trace_events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);

-- Benchmarks (M6). Additive: runs and trace_events are unchanged, and each
-- trial's run is an ordinary run, linked here rather than in the run record.
CREATE TABLE IF NOT EXISTS benchmark_experiments (
    experiment_id       TEXT PRIMARY KEY,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    started_at          TEXT,
    finished_at         TEXT,
    status              TEXT NOT NULL,
    origin              TEXT NOT NULL,
    suite_id            TEXT NOT NULL,
    suite_version       TEXT NOT NULL,
    provider            TEXT NOT NULL,
    provider_kind       TEXT NOT NULL,
    scripted            INTEGER NOT NULL,
    repetitions         INTEGER NOT NULL,
    order_seed          INTEGER NOT NULL,
    arm_ids_json        TEXT NOT NULL,
    configurations_json TEXT NOT NULL,
    provenance_json     TEXT NOT NULL,
    error               TEXT
);

CREATE TABLE IF NOT EXISTS benchmark_trials (
    trial_id        TEXT PRIMARY KEY,
    experiment_id   TEXT NOT NULL
                    REFERENCES benchmark_experiments(experiment_id) ON DELETE CASCADE,
    ordinal         INTEGER NOT NULL,
    arm_id          TEXT NOT NULL,
    task_id         TEXT NOT NULL,
    repetition      INTEGER NOT NULL,
    fingerprint     TEXT NOT NULL,
    status          TEXT NOT NULL,
    run_id          TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
    started_at      TEXT,
    finished_at     TEXT,
    metrics_json    TEXT,
    metrics_version INTEGER,
    error           TEXT,
    UNIQUE (experiment_id, arm_id, task_id, repetition),
    UNIQUE (experiment_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_bench_experiments_created
    ON benchmark_experiments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bench_trials_run ON benchmark_trials(run_id);

-- Timing measurements (M7.2). Additive: runs and trace_events are unchanged.
-- One row per run, written with its terminal status. ``status`` is
-- ``recorded`` (with measurements_json), or a marker saying why there are
-- none: ``disabled``, ``flush_failed`` or ``process_crash``.
CREATE TABLE IF NOT EXISTS run_measurements (
    run_id               TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
    status               TEXT NOT NULL,
    measurements_version INTEGER,
    collected_at         TEXT NOT NULL,
    measurements_json    TEXT
);
-- When this database first had run_measurements: a run created before it
-- predates measurements.
CREATE TABLE IF NOT EXISTS measurement_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

MEASUREMENT_STATUSES = frozenset({"recorded", "disabled", "flush_failed", "process_crash"})

# Columns added after the first release, with their backfill defaults.
_MIGRATIONS = {
    "provider_kind": "TEXT NOT NULL DEFAULT 'unknown'",
    "model_policy": "TEXT NOT NULL DEFAULT 'config'",
    "models_by_role_json": "TEXT NOT NULL DEFAULT '{}'",
    "monetary_enforced": "INTEGER NOT NULL DEFAULT 0",
    "usage_available": "INTEGER NOT NULL DEFAULT 0",
}

_COLUMNS = [
    "run_id",
    "created_at",
    "updated_at",
    "goal",
    "provider",
    "provider_kind",
    "provider_warning",
    "status",
    "limits_json",
    "model_policy",
    "models_by_role_json",
    "plan_json",
    "review_json",
    "verification_json",
    "summary",
    "error",
    "cost_usd",
    "monetary_enforced",
    "usage_available",
    "agent_calls",
    "escalations",
    "revisions",
    "duration_ms",
    "changed_files_json",
    "artifacts_json",
]


@dataclass(frozen=True)
class MeasurementRow:
    """One run_measurements row. ``measurements_json`` is set only when
    ``status`` is ``recorded``."""

    run_id: str
    status: str
    collected_at: str
    measurements_version: int | None = None
    measurements_json: str | None = None


class _WriteTimer:
    """Times one write for the run being measured in this context, if any:
    the wait for the store lock, then execute and commit, added to the run's
    ``<name>.lock_wait`` and ``<name>.write`` aggregates (app.timings).
    Inside the lock it only reads the clock; recording happens after."""

    __slots__ = ("_name", "_timings", "_start", "_locked")

    def __init__(self, name: str) -> None:
        self._name = name
        self._timings = current_timings()
        self._start = time.perf_counter_ns() if self._timings.enabled else 0
        self._locked = 0

    def locked(self) -> None:
        if self._timings.enabled:
            self._locked = time.perf_counter_ns()

    def written(self) -> None:
        if self._timings.enabled and self._locked:
            written = time.perf_counter_ns()
            self._timings.aggregate(f"{self._name}.lock_wait", self._locked - self._start)
            self._timings.aggregate(f"{self._name}.write", written - self._locked)


def _loads(value: str | None, default: Any = None) -> Any:
    if not value:
        return default
    return json.loads(value)


class RunStore:
    def __init__(self, db_path: str | Path) -> None:
        self.db_path = str(db_path)
        if self.db_path != ":memory:":
            Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        # Called with a run_id after a committed change to that run or its
        # trace (see add_listener). Carries no data: listeners re-read.
        self._listeners: list[Callable[[str], None]] = []
        self._conn = sqlite3.connect(
            self.db_path, check_same_thread=False, timeout=30
        )
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA foreign_keys=ON")
            self._conn.executescript(_SCHEMA)
            self._migrate()
            self._conn.execute(
                "INSERT OR IGNORE INTO measurement_meta (key, value) VALUES ('installed_at', ?)",
                (utc_now(),),
            )
            self._conn.commit()

    def _migrate(self) -> None:
        existing = {
            row["name"] for row in self._conn.execute("PRAGMA table_info(runs)")
        }
        for column, definition in _MIGRATIONS.items():
            if column not in existing:
                self._conn.execute(f"ALTER TABLE runs ADD COLUMN {column} {definition}")

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    @contextmanager
    def _held(self, kind: str) -> Iterator[None]:
        """The store lock, timed for the process histograms (``kind`` is
        ``db_read`` or ``db_write``): the wait for the lock
        (``<kind>.lock_wait``) and the time it is held, executing and, for a
        write, committing (``<kind>.execute``). Recorded after the lock is
        released, also when the block raises; skipped when disabled."""
        if not PROCESS.enabled:
            with self._lock:
                yield
            return
        requested = time.perf_counter_ns()
        acquired = released = 0
        try:
            with self._lock:
                acquired = time.perf_counter_ns()
                try:
                    yield
                finally:
                    released = time.perf_counter_ns()
        finally:
            if acquired and released:
                PROCESS.observe(f"{kind}.lock_wait", acquired - requested)
                PROCESS.observe(f"{kind}.execute", released - acquired)

    @contextmanager
    def transaction(self, kind: Literal["read", "write"] = "write") -> Iterator[sqlite3.Connection]:
        """The connection under the store's lock: committed when the block
        succeeds, rolled back when it raises. For modules that keep their own
        tables in this database (benchmarks). ``kind`` only labels the block
        for the process histograms (``db_read`` or ``db_write``)."""
        if kind not in ("read", "write"):
            raise ValueError(f"transaction kind must be 'read' or 'write', not {kind!r}")
        with self._held(f"db_{kind}"):
            try:
                yield self._conn
            except BaseException:
                self._conn.rollback()
                raise
            self._conn.commit()

    def add_listener(self, listener: Callable[[str], None]) -> None:
        """Call ``listener(run_id)`` after each committed change to a run.

        Listeners run on the writing thread, after the commit and outside the
        store lock, so a reader they wake always sees the change.
        """
        self._listeners.append(listener)

    def _changed(self, run_id: str) -> None:
        for listener in self._listeners:
            listener(run_id)

    # ------------------------------------------------------------------
    def save_run(self, record: RunRecord) -> None:
        timer = _WriteTimer("save_run")
        with self._held("db_write"):
            timer.locked()
            self._upsert_run(record)
            self._conn.commit()
        timer.written()
        self._changed(record.run_id)

    def save_terminal(self, record: RunRecord, measurement: MeasurementRow) -> None:
        """A run's terminal row and its measurement row, in one transaction.

        Both are written or neither is: on any failure the transaction is
        rolled back and the error raised, so the caller can fall back to the
        terminal row alone. The measurement row is built (serialized and
        bounded) before this is called; here only its status is checked, so
        apart from that the database itself is all that can fail.
        """
        with self._held("db_write"):
            try:
                self._upsert_run(record)
                self._insert_measurement(measurement)
                self._conn.commit()
            except BaseException:
                self._conn.rollback()
                raise
        self._changed(record.run_id)

    def add_measurement_marker(self, run_id: str, status: str) -> bool:
        """Record why a run has no measurements, unless it already has a row.
        Returns whether a row was written."""
        if status not in MEASUREMENT_STATUSES or status == "recorded":
            raise ValueError(f"not a measurement marker: {status!r}")
        with self._held("db_write"):
            cursor = self._conn.execute(
                "INSERT OR IGNORE INTO run_measurements (run_id, status, collected_at) "
                "VALUES (?, ?, ?)",
                (run_id, status, utc_now()),
            )
            self._conn.commit()
            return cursor.rowcount == 1

    def get_measurement(self, run_id: str) -> MeasurementRow | None:
        with self._held("db_read"):
            row = self._conn.execute(
                "SELECT * FROM run_measurements WHERE run_id = ?", (run_id,)
            ).fetchone()
        if row is None:
            return None
        return MeasurementRow(
            run_id=row["run_id"],
            status=row["status"],
            measurements_version=row["measurements_version"],
            collected_at=row["collected_at"],
            measurements_json=row["measurements_json"],
        )

    def measurements_installed_at(self) -> str | None:
        """When this database first had run_measurements (UTC ISO)."""
        with self._held("db_read"):
            row = self._conn.execute(
                "SELECT value FROM measurement_meta WHERE key = 'installed_at'"
            ).fetchone()
        return None if row is None else row["value"]

    def _insert_measurement(self, measurement: MeasurementRow) -> None:
        if measurement.status not in MEASUREMENT_STATUSES:
            raise ValueError(f"unknown measurement status: {measurement.status!r}")
        self._conn.execute(
            "INSERT INTO run_measurements "
            "(run_id, status, measurements_version, collected_at, measurements_json) "
            "VALUES (?, ?, ?, ?, ?)",
            (
                measurement.run_id,
                measurement.status,
                measurement.measurements_version,
                measurement.collected_at,
                measurement.measurements_json,
            ),
        )

    def _upsert_run(self, record: RunRecord) -> None:
        """Insert or update the run row; the caller holds the lock and commits."""
        data = record.model_dump(mode="json")
        values = (
            data["run_id"],
            data["created_at"],
            data["updated_at"],
            data["goal"],
            data["provider"],
            data["provider_kind"],
            data["provider_warning"],
            data["status"],
            json.dumps(data["limits"]),
            data["model_policy"],
            json.dumps(data["models_by_role"]),
            json.dumps(data["plan"]) if data["plan"] else None,
            json.dumps(data["review"]) if data["review"] else None,
            json.dumps(data["verification"]) if data["verification"] else None,
            data["summary"],
            data["error"],
            data["cost_usd"],
            int(data["monetary_enforced"]),
            int(data["usage_available"]),
            data["agent_calls"],
            data["escalations"],
            data["revisions"],
            data["duration_ms"],
            json.dumps(data["changed_files"]),
            json.dumps(data["artifacts"]),
        )
        placeholders = ",".join("?" for _ in _COLUMNS)
        updates = ",".join(
            f"{column}=excluded.{column}" for column in _COLUMNS if column != "run_id"
        )
        self._conn.execute(
            f"INSERT INTO runs ({','.join(_COLUMNS)}) VALUES ({placeholders}) "
            f"ON CONFLICT(run_id) DO UPDATE SET {updates}",
            values,
        )

    def append_event(self, event: TraceEvent) -> None:
        data = event.model_dump(mode="json")
        timer = _WriteTimer("append_event")
        with self._held("db_write"):
            timer.locked()
            self._conn.execute(
                """
                INSERT OR IGNORE INTO trace_events
                    (event_id, run_id, seq, at, kind, message, payload_json)
                VALUES (?,?,?,?,?,?,?)
                """,
                (
                    data["event_id"],
                    data["run_id"],
                    data["seq"],
                    data["at"],
                    data["kind"],
                    data["message"],
                    json.dumps(data["payload"]),
                ),
            )
            self._conn.commit()
        timer.written()
        self._changed(event.run_id)

    def recover_interrupted(self, reason: str) -> list[str]:
        """Mark runs left queued or running by a stopped process as failed.

        Runs execute in-process, so at startup nothing can still be running
        them. This assumes a single API process per database; a multi-worker
        deployment needs a durable job queue that owns run state instead.
        Their timing spans died with the process: each gets a
        ``process_crash`` measurement marker.
        """
        now = utc_now()
        with self._held("db_write"):
            rows = self._conn.execute(
                "SELECT run_id FROM runs WHERE status IN ('queued', 'running')"
            ).fetchall()
            run_ids = [row["run_id"] for row in rows]
            for run_id in run_ids:
                self._conn.execute(
                    "UPDATE runs SET status = 'failed', error = ?, updated_at = ? "
                    "WHERE run_id = ?",
                    (reason, now, run_id),
                )
                (last_seq,) = self._conn.execute(
                    "SELECT COALESCE(MAX(seq), 0) FROM trace_events WHERE run_id = ?",
                    (run_id,),
                ).fetchone()
                event = TraceEvent(
                    run_id=run_id,
                    seq=last_seq + 1,
                    kind="run_finished",
                    message="Run finished: failed (interrupted)",
                    payload=validate_payload(
                        "run_finished",
                        {"status": "failed", "error": reason, "recovered": True},
                    ),
                )
                data = event.model_dump(mode="json")
                self._conn.execute(
                    "INSERT OR IGNORE INTO trace_events "
                    "(event_id, run_id, seq, at, kind, message, payload_json) "
                    "VALUES (?,?,?,?,?,?,?)",
                    (
                        data["event_id"],
                        run_id,
                        data["seq"],
                        data["at"],
                        data["kind"],
                        data["message"],
                        json.dumps(data["payload"]),
                    ),
                )
                self._conn.execute(
                    "INSERT OR IGNORE INTO run_measurements (run_id, status, collected_at) "
                    "VALUES (?, 'process_crash', ?)",
                    (run_id, now),
                )
            self._conn.commit()
        for run_id in run_ids:
            self._changed(run_id)
        return run_ids

    # ------------------------------------------------------------------
    def get_run(self, run_id: str) -> RunRecord | None:
        with self._held("db_read"):
            row = self._conn.execute(
                "SELECT * FROM runs WHERE run_id = ?", (run_id,)
            ).fetchone()
        if row is None:
            return None
        return self._row_to_record(row)

    def list_runs(self, limit: int = 25) -> list[RunRecord]:
        return self.list_runs_page(limit)[0]

    def list_runs_page(
        self, limit: int = 25, before: str | None = None
    ) -> tuple[list[RunRecord], str | None]:
        """Newest-first page of runs, plus the cursor for the next page.

        Keyset pagination on ``(created_at, run_id)``: ``before`` is the run_id
        of the last run already seen, so new runs arriving between requests
        never shift or duplicate entries. Raises ``KeyError`` for an unknown
        cursor.
        """
        limit = max(1, min(limit, 200))
        with self._held("db_read"):
            if before is None:
                rows = self._conn.execute(
                    "SELECT * FROM runs ORDER BY created_at DESC, run_id DESC LIMIT ?",
                    (limit + 1,),
                ).fetchall()
            else:
                anchor = self._conn.execute(
                    "SELECT created_at FROM runs WHERE run_id = ?", (before,)
                ).fetchone()
                if anchor is None:
                    raise KeyError(before)
                rows = self._conn.execute(
                    "SELECT * FROM runs "
                    "WHERE created_at < ? OR (created_at = ? AND run_id < ?) "
                    "ORDER BY created_at DESC, run_id DESC LIMIT ?",
                    (anchor["created_at"], anchor["created_at"], before, limit + 1),
                ).fetchall()
        page = [self._row_to_record(row) for row in rows[:limit]]
        next_cursor = page[-1].run_id if len(rows) > limit else None
        return page, next_cursor

    def get_events(
        self, run_id: str, after_seq: int | None = None, limit: int | None = None
    ) -> list[TraceEvent]:
        """A run's events in ascending ``seq``; only those after ``after_seq`` if
        given, and at most ``limit`` of them if given."""
        with self._held("db_read"):
            rows = self._conn.execute(
                "SELECT * FROM trace_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC "
                "LIMIT ?",
                (run_id, -1 if after_seq is None else after_seq, -1 if limit is None else limit),
            ).fetchall()
        return [
            TraceEvent(
                event_id=row["event_id"],
                run_id=row["run_id"],
                seq=row["seq"],
                at=row["at"],
                kind=row["kind"],
                message=row["message"],
                payload=_loads(row["payload_json"], {}),
            )
            for row in rows
        ]

    # ------------------------------------------------------------------
    @staticmethod
    def _row_to_record(row: sqlite3.Row) -> RunRecord:
        plan = _loads(row["plan_json"])
        review = _loads(row["review_json"])
        verification = _loads(row["verification_json"])
        keys = row.keys()
        return RunRecord(
            run_id=row["run_id"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            goal=row["goal"],
            provider=row["provider"],
            provider_kind=row["provider_kind"] if "provider_kind" in keys else "unknown",
            provider_warning=row["provider_warning"],
            status=row["status"],
            limits=_loads(row["limits_json"], {}),
            model_policy=row["model_policy"] if "model_policy" in keys else "config",
            models_by_role=_loads(row["models_by_role_json"], {})
            if "models_by_role_json" in keys
            else {},
            plan=Plan.model_validate(plan) if plan else None,
            review=ReviewOutput.model_validate(review) if review else None,
            verification=VerificationResult.model_validate(verification)
            if verification
            else None,
            summary=row["summary"],
            error=row["error"],
            cost_usd=row["cost_usd"],
            monetary_enforced=bool(row["monetary_enforced"])
            if "monetary_enforced" in keys
            else False,
            usage_available=bool(row["usage_available"])
            if "usage_available" in keys
            else False,
            agent_calls=row["agent_calls"],
            escalations=row["escalations"],
            revisions=row["revisions"],
            duration_ms=row["duration_ms"],
            changed_files=_loads(row["changed_files_json"], []),
            artifacts=_loads(row["artifacts_json"], {}),
        )