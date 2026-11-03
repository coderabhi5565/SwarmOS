"""Per-run persistence aggregates: each trace write and run-row write of a
measured run adds its store-lock wait and its execute-and-commit time to
the run's aggregates; writes outside a measured run record nothing."""

from __future__ import annotations

import threading
import time

from app.demo_tasks import PIPELINE_TASK_ID
from app.models import RunRecord, RunRequest, TraceEvent
from app.service import RunService
from app.store import RunStore
from app.timings.analysis import derive
from app.timings.recorder import DISABLED, SpanRecorder, activate
from tests.conftest import make_settings

MS = 1_000_000


async def test_every_write_of_a_run_is_in_its_aggregates(tmp_path):
    settings = make_settings(tmp_path)
    service = RunService(settings, RunStore(settings.db_path))
    saves: list[str] = []
    original = service.store.save_run

    def counting(record):
        saves.append(record.status)
        original(record)

    service.store.save_run = counting  # type: ignore[method-assign]
    record = await service.run_request(RunRequest(goal="run the catalog task", demo_task=PIPELINE_TASK_ID))
    aggregates = service.timings_for(record.run_id)["aggregates"]
    events = service.store.get_events(record.run_id)
    assert aggregates["append_event.write"]["count"] == len(events)
    assert aggregates["append_event.lock_wait"]["count"] == len(events)
    # The queued row is written by prepare, before the lifecycle starts.
    assert saves[0] == "queued"
    assert aggregates["save_run.write"]["count"] == len(saves) - 1
    assert aggregates["save_run.lock_wait"]["count"] == len(saves) - 1
    for item in aggregates.values():
        assert sum(item["buckets"]) == item["count"] and item["sum_ns"] >= item["max_ns"] >= 0
    values = derive(service.timings_for(record.run_id)).values
    assert values["event_persist_write_count"] == len(events)
    assert values["event_persist_write_ms"] is not None and values["save_run_write_ms"] is not None


def test_waiting_for_the_store_lock_is_measured_as_lock_wait(tmp_path):
    store = RunStore(tmp_path / "lock.db")
    record = RunRecord(goal="measure the store lock")
    store.save_run(record)
    recorder = SpanRecorder()
    holding = threading.Event()

    def hold_the_lock() -> None:
        with store._lock:
            holding.set()
            time.sleep(0.15)

    holder = threading.Thread(target=hold_the_lock)
    holder.start()
    holding.wait(5)
    with activate(recorder):
        store.append_event(TraceEvent(run_id=record.run_id, seq=1, kind="warning", message="w", payload={}))
    holder.join()
    aggregates = recorder.snapshot()["aggregates"]
    assert aggregates["append_event.lock_wait"]["max_ns"] >= 100 * MS
    assert aggregates["append_event.write"]["count"] == 1
    store.close()


def test_writes_outside_a_measured_run_record_nothing(tmp_path):
    store = RunStore(tmp_path / "plain.db")
    record = RunRecord(goal="written outside any run")
    store.save_run(record)
    store.append_event(TraceEvent(run_id=record.run_id, seq=1, kind="warning", message="w", payload={}))
    assert DISABLED.snapshot()["aggregates"] == {}
    store.close()


async def test_a_run_with_recording_off_has_no_aggregates(tmp_path):
    settings = make_settings(tmp_path, timings_enabled=False)
    service = RunService(settings, RunStore(settings.db_path))
    record = await service.run_request(RunRequest(goal="run the catalog task", demo_task=PIPELINE_TASK_ID))
    assert record.status == "completed"
    assert service.timings_for(record.run_id)["aggregates"] == {}
