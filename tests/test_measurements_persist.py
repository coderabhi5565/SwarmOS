"""Terminal measurement persistence (M7.2): every terminal path stores the
run's measurements with its terminal row in one transaction; when the
measurements cannot be stored, the terminal row is written alone with a
flush_failed marker, and the run's outcome never changes."""

from __future__ import annotations

import asyncio
import functools
import json
import sqlite3

import pytest

import app.service as service_module
from app.demo_tasks import PIPELINE_TASK_ID, SAMPLE_TASK_ID
from app.models import RunRequest
from app.providers.demo import DemoProvider
from app.service import RunService
from app.store import RunStore
from app.timings.analysis import derive
from app.timings.serialize import measurement_row
from tests.conftest import make_settings


def make_service(tmp_path, **overrides) -> RunService:
    settings = make_settings(tmp_path, **overrides)
    return RunService(settings, RunStore(settings.db_path))


def request(task: str = SAMPLE_TASK_ID) -> RunRequest:
    return RunRequest(goal="run the catalog task", demo_task=task)


def stored(service: RunService, run_id: str) -> dict:
    row = service.store.get_measurement(run_id)
    assert row is not None and row.status == "recorded"
    return json.loads(row.measurements_json)


def lifecycle(measurements: dict) -> dict:
    [span] = [s for s in measurements["spans"] if s["kind"] == "lifecycle"]
    return span


# ----------------------------------------------------------------------
# every terminal path
# ----------------------------------------------------------------------
async def test_a_completed_run_stores_its_measurements_with_its_terminal_row(tmp_path):
    service = make_service(tmp_path)
    record = await service.run_request(request(PIPELINE_TASK_ID))
    assert service.store.get_run(record.run_id).status == "completed"
    measurements = stored(service, record.run_id)
    memory = service.timings_for(record.run_id)
    assert measurements["spans"] == memory["spans"]
    assert measurements["aggregates"] == memory["aggregates"]
    assert measurements["truncated"] is False
    assert lifecycle(measurements)["attrs"]["outcome"] == "completed"
    assert all(span["end_ns"] is not None for span in measurements["spans"])
    # The last event was committed before the terminal row and its measurements.
    assert service.store.get_events(record.run_id)[-1].kind == "run_finished"
    values = derive(measurements).values
    assert values["lifecycle_ms"] is not None and values["coder_critical_path_ms"] is not None
    assert service.measurement_flush_failures == 0


async def test_recording_off_stores_a_disabled_marker(tmp_path):
    service = make_service(tmp_path, timings_enabled=False)
    record = await service.run_request(request())
    row = service.store.get_measurement(record.run_id)
    assert (row.status, row.measurements_json) == ("disabled", None)
    assert service.store.get_run(record.run_id).status == "completed"


async def test_a_run_cancelled_in_flight_stores_its_measurements(tmp_path, monkeypatch):
    original = DemoProvider.complete

    async def slow(self, request_):
        await asyncio.sleep(0.5)
        return await original(self, request_)

    monkeypatch.setattr(DemoProvider, "complete", slow)
    service = make_service(tmp_path)
    record, task = service.start(request())
    loop = asyncio.get_running_loop()
    deadline = loop.time() + 20
    while not any(e.kind == "agent_started" for e in service.store.get_events(record.run_id)):
        assert loop.time() < deadline
        await asyncio.sleep(0.01)
    service.cancel(record.run_id)
    with pytest.raises(asyncio.CancelledError):
        await task
    assert service.store.get_run(record.run_id).status == "cancelled"
    assert lifecycle(stored(service, record.run_id))["attrs"]["outcome"] == "cancelled"


async def test_a_run_cancelled_before_it_started_stores_admission_only(tmp_path):
    service = make_service(tmp_path)
    record, task = service.start(request())
    service.cancel(record.run_id)
    with pytest.raises(asyncio.CancelledError):
        await task
    assert service.store.get_run(record.run_id).status == "cancelled"
    measurements = stored(service, record.run_id)
    assert [span["kind"] for span in measurements["spans"]] == ["lifecycle", "admission"]
    assert derive(measurements).reasons["execution_ms"] == "never started"


async def test_a_crashed_run_stores_its_measurements(tmp_path, monkeypatch):
    async def crash(self, record):
        raise RuntimeError("orchestrator bug")

    monkeypatch.setattr(service_module.Orchestrator, "run", crash)
    service = make_service(tmp_path)
    record = await service.run_request(request())
    assert record.status == "failed"
    assert lifecycle(stored(service, record.run_id))["attrs"]["outcome"] == "failed"


# ----------------------------------------------------------------------
# when the measurements cannot be stored
# ----------------------------------------------------------------------
async def test_a_failing_transaction_keeps_the_terminal_row_and_marks_the_run(tmp_path, monkeypatch):
    service = make_service(tmp_path)

    def broken(record, measurement):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(service.store, "save_terminal", broken)
    record = await service.run_request(request())
    assert record.status == "completed"
    assert service.store.get_run(record.run_id).status == "completed"
    assert service.store.get_measurement(record.run_id).status == "flush_failed"
    assert service.measurement_flush_failures == 1


async def test_a_failing_serialization_keeps_the_terminal_row_and_marks_the_run(tmp_path, monkeypatch):
    def unserializable(run_id, snapshot, **kwargs):
        raise ValueError("cannot serialize")

    monkeypatch.setattr(service_module, "measurement_row", unserializable)
    service = make_service(tmp_path)
    record = await service.run_request(request())
    assert service.store.get_run(record.run_id).status == "completed"
    assert service.store.get_measurement(record.run_id).status == "flush_failed"
    assert service.measurement_flush_failures == 1


async def test_when_even_the_marker_fails_the_run_has_no_row(tmp_path, monkeypatch):
    service = make_service(tmp_path)

    def broken(*args, **kwargs):
        raise sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr(service.store, "save_terminal", broken)
    monkeypatch.setattr(service.store, "add_measurement_marker", broken)
    record = await service.run_request(request())
    assert service.store.get_run(record.run_id).status == "completed"
    assert service.store.get_measurement(record.run_id) is None
    assert service.measurement_flush_failures == 1


async def test_a_failing_terminal_row_is_handled_as_it_was_before(tmp_path, monkeypatch):
    # Before M7.2 the terminal save_run sat in the same try as the run, so a
    # failure there took the crash branch and the run was recorded failed.
    service = make_service(tmp_path)
    original_save = service.store.save_run

    def broken(*args, **kwargs):
        raise sqlite3.OperationalError("disk I/O error")

    def save_run_until_terminal(record):
        if record.status == "completed":
            raise sqlite3.OperationalError("disk I/O error")
        original_save(record)

    monkeypatch.setattr(service.store, "save_terminal", broken)
    monkeypatch.setattr(service.store, "save_run", save_run_until_terminal)
    record = await service.run_request(request())
    assert record.status == "failed" and "disk I/O error" in record.error
    assert service.store.get_run(record.run_id).status == "failed"
    failures = [e for e in service.store.get_events(record.run_id) if e.kind == "failure"]
    assert failures[-1].payload["error_class"] == "run_crashed"
    assert service.store.get_measurement(record.run_id).status == "flush_failed"


async def test_an_oversized_row_is_stored_truncated(tmp_path, monkeypatch):
    monkeypatch.setattr(service_module, "measurement_row", functools.partial(measurement_row, max_bytes=3_000))
    service = make_service(tmp_path)
    record = await service.run_request(request(PIPELINE_TASK_ID))
    measurements = stored(service, record.run_id)
    assert measurements["truncated"] is True
    assert sum(measurements["dropped"].values()) > 0
    assert len(service.store.get_measurement(record.run_id).measurements_json.encode()) <= 3_000
    assert service.store.get_run(record.run_id).status == "completed"
