"""Measurement storage (M7.2): the additive tables, migrating an existing
database without touching its runs, the terminal transaction (both rows or
neither), markers that say why a run has no measurements, and recovery."""

from __future__ import annotations

import sqlite3

import pytest

from app.models import RunRecord, TraceEvent, utc_now
from app.store import MeasurementRow, RunStore


def tables(path) -> set[str]:
    with sqlite3.connect(path) as conn:
        return {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}


def dump(path, table: str) -> list[tuple]:
    with sqlite3.connect(path) as conn:
        return conn.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall()  # noqa: S608 - fixed names


def row(run_id: str, status: str = "recorded") -> MeasurementRow:
    recorded = status == "recorded"
    return MeasurementRow(
        run_id=run_id,
        status=status,
        collected_at=utc_now(),
        measurements_version=1 if recorded else None,
        measurements_json='{"version": 1, "spans": []}' if recorded else None,
    )


# ----------------------------------------------------------------------
# schema and migration
# ----------------------------------------------------------------------
def test_a_new_database_gets_the_tables_and_an_installation_time(tmp_path):
    store = RunStore(tmp_path / "new.db")
    assert {"run_measurements", "measurement_meta"} <= tables(tmp_path / "new.db")
    installed = store.measurements_installed_at()
    store.close()
    reopened = RunStore(tmp_path / "new.db")
    assert reopened.measurements_installed_at() == installed  # set once
    reopened.close()


def test_an_existing_database_is_migrated_without_touching_its_runs(tmp_path):
    path = tmp_path / "old.db"
    store = RunStore(path)
    old = RunRecord(goal="a run from before measurements", status="completed")
    store.save_run(old)
    store.append_event(TraceEvent(run_id=old.run_id, seq=1, kind="run_finished", message="done", payload={}))
    store.close()
    # Make it a pre-M7.2 database: no measurement tables.
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TABLE run_measurements")
        conn.execute("DROP TABLE measurement_meta")
    runs_before, events_before = dump(path, "runs"), dump(path, "trace_events")

    store = RunStore(path)
    assert {"run_measurements", "measurement_meta"} <= tables(path)
    assert dump(path, "runs") == runs_before
    assert dump(path, "trace_events") == events_before
    assert store.get_measurement(old.run_id) is None
    assert store.measurements_installed_at() > old.created_at
    store.close()


# ----------------------------------------------------------------------
# the terminal transaction
# ----------------------------------------------------------------------
def test_the_terminal_row_and_the_measurement_row_are_written_together(tmp_path):
    store = RunStore(tmp_path / "t.db")
    changed: list[str] = []
    store.add_listener(changed.append)
    record = RunRecord(goal="terminal transaction", status="running")
    store.save_run(record)
    finished = record.model_copy(update={"status": "completed"})
    store.save_terminal(finished, row(record.run_id))
    assert store.get_run(record.run_id).status == "completed"
    stored = store.get_measurement(record.run_id)
    assert stored.status == "recorded" and stored.measurements_json == '{"version": 1, "spans": []}'
    assert changed[-1] == record.run_id
    store.close()


def test_a_bad_measurement_rolls_back_the_terminal_row_too(tmp_path):
    store = RunStore(tmp_path / "t.db")
    record = RunRecord(goal="terminal transaction", status="running")
    store.save_run(record)
    with pytest.raises(ValueError):
        store.save_terminal(record.model_copy(update={"status": "completed"}), row(record.run_id, "bogus"))
    assert store.get_run(record.run_id).status == "running"
    assert store.get_measurement(record.run_id) is None
    store.close()


def test_a_database_error_rolls_back_the_terminal_row_too(tmp_path):
    store = RunStore(tmp_path / "t.db")
    record = RunRecord(goal="terminal transaction", status="running")
    store.save_run(record)
    store.add_measurement_marker(record.run_id, "flush_failed")  # an existing row: the insert conflicts
    with pytest.raises(sqlite3.IntegrityError):
        store.save_terminal(record.model_copy(update={"status": "completed"}), row(record.run_id))
    assert store.get_run(record.run_id).status == "running"
    assert store.get_measurement(record.run_id).status == "flush_failed"
    # The store is still usable after the rollback.
    store.save_run(record.model_copy(update={"status": "completed"}))
    assert store.get_run(record.run_id).status == "completed"
    store.close()


def test_a_measurement_needs_its_run(tmp_path):
    store = RunStore(tmp_path / "t.db")
    with pytest.raises(sqlite3.IntegrityError):
        store.save_terminal(RunRecord(goal="never saved", status="completed"), row("run_does_not_exist"))
    store.close()


# ----------------------------------------------------------------------
# markers and recovery
# ----------------------------------------------------------------------
def test_a_marker_is_written_once_and_only_as_a_marker(tmp_path):
    store = RunStore(tmp_path / "m.db")
    record = RunRecord(goal="marker run", status="completed")
    store.save_run(record)
    assert store.add_measurement_marker(record.run_id, "disabled") is True
    assert store.add_measurement_marker(record.run_id, "flush_failed") is False
    stored = store.get_measurement(record.run_id)
    assert (stored.status, stored.measurements_json, stored.measurements_version) == ("disabled", None, None)
    for status in ("recorded", "anything"):
        with pytest.raises(ValueError):
            store.add_measurement_marker(record.run_id, status)
    store.close()


def test_recovery_marks_interrupted_runs_as_process_crash(tmp_path):
    store = RunStore(tmp_path / "r.db")
    running = RunRecord(goal="running when the process died", status="running")
    queued = RunRecord(goal="queued when the process died", status="queued")
    done = RunRecord(goal="finished before", status="completed")
    measured = RunRecord(goal="running, already has a row", status="running")
    for record in (running, queued, done, measured):
        store.save_run(record)
    store.add_measurement_marker(measured.run_id, "disabled")
    recovered = set(store.recover_interrupted("interrupted: the server stopped"))
    assert recovered == {running.run_id, queued.run_id, measured.run_id}
    assert store.get_measurement(running.run_id).status == "process_crash"
    assert store.get_measurement(queued.run_id).status == "process_crash"
    assert store.get_measurement(measured.run_id).status == "disabled"  # kept
    assert store.get_measurement(done.run_id) is None
    store.close()
