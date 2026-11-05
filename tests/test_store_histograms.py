"""RunStore in the process histograms (M7.4): every read and write records
its wait for the store lock and the time it holds it, under fixed names,
from any thread, also when the statement fails, and never at the cost of
the operation."""

from __future__ import annotations

import threading
import time

import pytest
from fastapi.testclient import TestClient

import app.cli as cli
import app.main as main_module
from app.benchmarks.store import BenchmarkStore
from app.models import RunRecord, TraceEvent, utc_now
from app.store import MeasurementRow, RunStore
from app.timings.process import PROCESS, Histogram
from tests.conftest import make_settings

MS = 1_000_000
NAMES = ("db_read.lock_wait", "db_read.execute", "db_write.lock_wait", "db_write.execute")


@pytest.fixture
def histograms(monkeypatch):
    """The process registry, enabled and empty for the test; emptied after."""
    monkeypatch.setattr(PROCESS, "enabled", True)
    PROCESS.reset()
    yield PROCESS
    PROCESS.reset()


@pytest.fixture
def store(tmp_path):
    runs = RunStore(tmp_path / "histograms.db")
    yield runs
    runs.close()


def counts() -> dict[str, int]:
    snapshot = PROCESS.snapshot()["histograms"]
    return {name: snapshot[name]["count"] for name in NAMES}


def delta(operation) -> dict[str, int]:
    before = counts()
    operation()
    after = counts()
    return {name: after[name] - before[name] for name in NAMES}


READ = {"db_read.lock_wait": 1, "db_read.execute": 1, "db_write.lock_wait": 0, "db_write.execute": 0}
WRITE = {"db_read.lock_wait": 0, "db_read.execute": 0, "db_write.lock_wait": 1, "db_write.execute": 1}


# ----------------------------------------------------------------------
# what is recorded
# ----------------------------------------------------------------------
def test_each_store_operation_is_one_read_or_one_write(histograms, store):
    record = RunRecord(goal="histograms", status="running")
    event = TraceEvent(run_id=record.run_id, seq=1, kind="run_finished", message="done", payload={})
    marker_run = RunRecord(goal="marker", status="completed")
    terminal_run = RunRecord(goal="terminal", status="completed")
    store.save_run(marker_run)
    store.save_run(terminal_run)
    measurement = MeasurementRow(run_id=terminal_run.run_id, status="disabled", collected_at=utc_now())

    writes = {
        "save_run": lambda: store.save_run(record),
        "append_event": lambda: store.append_event(event),
        "add_measurement_marker": lambda: store.add_measurement_marker(marker_run.run_id, "disabled"),
        "save_terminal": lambda: store.save_terminal(terminal_run, measurement),
        "recover_interrupted": lambda: store.recover_interrupted("stopped"),
    }
    reads = {
        "get_run": lambda: store.get_run(record.run_id),
        "list_runs_page": lambda: store.list_runs_page(10),
        "get_events": lambda: store.get_events(record.run_id),
        "get_measurement": lambda: store.get_measurement(marker_run.run_id),
        "measurements_installed_at": store.measurements_installed_at,
    }
    for name, operation in writes.items():
        assert delta(operation) == WRITE, name
    for name, operation in reads.items():
        assert delta(operation) == READ, name


def test_benchmark_reads_and_writes_are_labelled_by_their_transaction(histograms, store):
    benchmarks = BenchmarkStore(store)

    def write():
        with store.transaction() as conn:
            conn.execute("SELECT 1")

    def read():
        with store.transaction("read") as conn:
            conn.execute("SELECT 1")

    assert delta(write) == WRITE
    assert delta(read) == READ
    assert delta(lambda: benchmarks.get_trials("bex_missing")) == READ
    assert delta(lambda: benchmarks.get_experiment("bex_missing")) == READ
    assert delta(lambda: benchmarks.active_experiments()) == READ
    assert delta(lambda: benchmarks.list_experiments_page(5)) == READ
    assert delta(lambda: benchmarks.trial_for_run("run_missing")) == READ
    with pytest.raises(ValueError, match="'read' or 'write'"):
        with store.transaction("delete"):
            pass


def test_the_metric_names_carry_no_run_or_user_detail(histograms, store):
    store.save_run(RunRecord(goal="secret goal text", status="running"))
    snapshot = PROCESS.snapshot()
    assert set(snapshot["histograms"]) == set(NAMES) | {"sse_commit_to_yield"}
    assert "secret" not in repr(snapshot) and "run_" not in repr(snapshot)


# ----------------------------------------------------------------------
# lock wait and held time
# ----------------------------------------------------------------------
def test_waiting_for_the_lock_is_lock_wait_not_execute(histograms, store):
    holding, release = threading.Event(), threading.Event()

    def holder():
        with store._lock:  # another thread holds the store, as a long write would
            holding.set()
            release.wait(5)

    thread = threading.Thread(target=holder)
    thread.start()
    holding.wait(5)
    timer = threading.Timer(0.1, release.set)
    timer.start()
    store.get_run("run_missing")  # waits about 100 ms for the lock
    thread.join(5)
    reads = PROCESS.snapshot()["histograms"]
    assert reads["db_read.lock_wait"]["max_ns"] >= 80 * MS
    assert reads["db_read.execute"]["max_ns"] < reads["db_read.lock_wait"]["max_ns"]


def test_execute_is_the_time_the_lock_is_held(histograms, store):
    with store.transaction("read"):
        time.sleep(0.05)
    item = PROCESS.snapshot()["histograms"]["db_read.execute"]
    assert item["count"] == 1 and item["max_ns"] >= 45 * MS


def test_a_failing_block_is_recorded_rolled_back_and_releases_the_lock(histograms, store):
    with pytest.raises(RuntimeError, match="boom"):
        with store.transaction() as conn:
            conn.execute("INSERT INTO measurement_meta (key, value) VALUES ('probe', 'x')")
            raise RuntimeError("boom")
    assert counts()["db_write.execute"] == 1
    assert store._lock.acquire(timeout=1)  # released
    store._lock.release()
    with store.transaction("read") as conn:
        assert conn.execute("SELECT value FROM measurement_meta WHERE key = 'probe'").fetchone() is None


def test_concurrent_reads_and_writes_lose_no_observation(histograms, store):
    threads, each = 8, 40
    records = [RunRecord(goal=f"run {i}", status="running") for i in range(threads)]
    barrier = threading.Barrier(threads)

    def work(record):
        barrier.wait()
        for _ in range(each):
            store.save_run(record)
            store.get_run(record.run_id)

    workers = [threading.Thread(target=work, args=(record,)) for record in records]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()
    assert counts() == dict.fromkeys(NAMES, threads * each)
    assert len(store.list_runs(50)) == threads


# ----------------------------------------------------------------------
# disabled, failures, configuration
# ----------------------------------------------------------------------
def test_disabled_records_nothing_and_the_store_still_works(histograms, store, monkeypatch):
    monkeypatch.setattr(PROCESS, "enabled", False)
    record = RunRecord(goal="disabled", status="running")
    store.save_run(record)
    assert store.get_run(record.run_id) is not None
    assert counts() == dict.fromkeys(NAMES, 0)


def test_a_broken_histogram_never_breaks_a_write(histograms, store, monkeypatch):
    class Broken(Histogram):
        __slots__ = ()

        def observe(self, value_ns):
            raise RuntimeError("histogram broke")

    monkeypatch.setitem(PROCESS._histograms, "db_write.execute", Broken())
    record = RunRecord(goal="still saved", status="running")
    store.save_run(record)
    assert store.get_run(record.run_id).goal == "still saved"
    snapshot = PROCESS.snapshot()
    assert snapshot["errors"] == 1
    assert snapshot["histograms"]["db_write.lock_wait"]["count"] == 1


@pytest.mark.parametrize("enabled", [False, True])
def test_the_api_applies_the_timings_setting(tmp_path, monkeypatch, enabled):
    monkeypatch.setattr(PROCESS, "enabled", not enabled)
    monkeypatch.setattr(main_module, "settings", make_settings(tmp_path, db_path=tmp_path / "api.db", timings_enabled=enabled))
    with TestClient(main_module.app):
        assert PROCESS.enabled is enabled


@pytest.mark.parametrize("enabled", [False, True])
def test_the_cli_applies_the_timings_setting(tmp_path, monkeypatch, enabled):
    monkeypatch.setattr(PROCESS, "enabled", not enabled)
    monkeypatch.setattr(cli, "settings", make_settings(tmp_path, timings_enabled=enabled))
    cli.main(["--db", str(tmp_path / "cli.db"), "trace", "run_missing"])
    assert PROCESS.enabled is enabled
