"""sse_commit_to_yield (M7.4): from immediately after an event's commit to
the stream yielding its frame, for events committed while that stream is
subscribed. Server side only; the backlog and the polling endpoint are not
measured; stamps are bounded and released; ordering is unchanged."""

from __future__ import annotations

import asyncio

import pytest

import app.streaming as streaming
from app.models import RunRecord, TraceEvent
from app.store import RunStore
from app.streaming import RunEventBroker
from app.timings.process import BUCKET_BOUNDS_NS, PROCESS, Histogram
from tests.test_stream import emit, finish, open_stream, read_to_end, running_app, save

MS = 1_000_000


@pytest.fixture
def histograms(monkeypatch):
    monkeypatch.setattr(PROCESS, "enabled", True)
    PROCESS.reset()
    yield PROCESS
    PROCESS.reset()


def sse() -> dict:
    return PROCESS.snapshot()["histograms"]["sse_commit_to_yield"]


def dropped() -> int:
    return PROCESS.snapshot()["counters"]["sse_commit_to_yield.stamps_dropped"]


# ----------------------------------------------------------------------
# the broker, by hand
# ----------------------------------------------------------------------
async def test_the_value_is_yield_time_minus_commit_time(histograms, monkeypatch):
    broker = RunEventBroker()
    with broker.watch("run_a") as subscription:
        broker.record_commit("run_a", 1, 1_000)
        assert broker.stamps_held() == 1
        monkeypatch.setattr(streaming.time, "perf_counter_ns", lambda: 6_001_000)
        subscription.yielding(1)
    item = sse()
    assert (item["count"], item["sum_ns"], item["min_ns"], item["max_ns"]) == (1, 6 * MS, 6 * MS, 6 * MS)
    bucket = next(i for i, bound in enumerate(BUCKET_BOUNDS_NS) if bound >= 6 * MS)
    assert item["counts"][bucket] == 1
    assert broker.stamps_held() == 0


async def test_a_run_without_streams_keeps_no_stamp(histograms):
    broker = RunEventBroker()
    with broker.watch("run_watched"):
        broker.record_commit("run_other", 1, 10)
        assert broker.stamps_held() == 0


async def test_each_stream_measures_only_what_was_committed_while_it_was_subscribed(histograms):
    broker = RunEventBroker()
    with broker.watch("run_a") as early:
        broker.record_commit("run_a", 1, 10)
        with broker.watch("run_a") as late:  # subscribed after seq 1 committed
            broker.record_commit("run_a", 2, 20)
            assert broker.stamps_held() == 3  # early: 1 and 2; late: 2
            late.yielding(1)  # backlog for this stream: not measured
            assert sse()["count"] == 0
            late.yielding(2)
            early.yielding(1)
            early.yielding(2)
    assert sse()["count"] == 3
    assert broker.stamps_held() == 0


async def test_a_stamp_is_used_once_and_older_ones_are_released(histograms):
    broker = RunEventBroker()
    with broker.watch("run_a") as subscription:
        for seq in (1, 2, 3):
            broker.record_commit("run_a", seq, seq)
        subscription.yielding(3)  # 1 and 2 were read before their stamps: never yielded again
        assert sse()["count"] == 1 and broker.stamps_held() == 0
        subscription.yielding(3)
        subscription.yielding(2)
    assert sse()["count"] == 1


async def test_the_stamp_map_is_bounded_and_drops_are_counted(histograms, monkeypatch):
    monkeypatch.setattr(streaming, "MAX_COMMIT_STAMPS", 3)
    broker = RunEventBroker()
    with broker.watch("run_a"), broker.watch("run_a"):
        broker.record_commit("run_a", 1, 1)  # one stamp per stream: 2 held
        broker.record_commit("run_a", 2, 2)  # one fits, one is dropped
        broker.record_commit("run_a", 3, 3)  # both dropped
        assert broker.stamps_held() == 3
        assert dropped() == 3
    assert broker.stamps_held() == 0  # released with their streams


async def test_disabled_keeps_and_records_nothing(histograms, monkeypatch):
    monkeypatch.setattr(PROCESS, "enabled", False)
    broker = RunEventBroker()
    with broker.watch("run_a") as subscription:
        broker.record_commit("run_a", 1, 1)
        subscription.yielding(1)
        assert broker.stamps_held() == 0
    assert sse()["count"] == 0


async def test_a_broken_histogram_never_breaks_a_stream(histograms, monkeypatch):
    class Broken(Histogram):
        __slots__ = ()

        def observe(self, value_ns):
            raise RuntimeError("histogram broke")

    monkeypatch.setitem(PROCESS._histograms, "sse_commit_to_yield", Broken())
    broker = RunEventBroker()
    with broker.watch("run_a") as subscription:
        broker.record_commit("run_a", 1, 1)
        subscription.yielding(1)  # does not raise
    assert PROCESS.snapshot()["errors"] == 1


# ----------------------------------------------------------------------
# the store's commit stamp
# ----------------------------------------------------------------------
def test_the_store_stamps_only_newly_inserted_events(histograms, tmp_path):
    store = RunStore(tmp_path / "stamps.db")
    try:
        calls = []
        store.add_commit_listener(lambda run_id, seq, ns: calls.append((run_id, seq, ns)))
        record = RunRecord(goal="stamps", status="running")
        store.save_run(record)
        event = TraceEvent(run_id=record.run_id, seq=1, kind="warning", message="once")
        store.append_event(event)
        store.append_event(event)  # a duplicate: ignored by the store, and not stamped
        assert [(run_id, seq) for run_id, seq, _ in calls] == [(record.run_id, 1)]
        assert isinstance(calls[0][2], int) and calls[0][2] > 0
    finally:
        store.close()


def test_a_failing_commit_listener_never_fails_the_write(histograms, tmp_path):
    store = RunStore(tmp_path / "stamps.db")
    try:
        woken = []

        def broken(run_id, seq, committed_ns):
            raise RuntimeError("listener broke")

        store.add_commit_listener(broken)
        store.add_listener(woken.append)
        record = RunRecord(goal="still written", status="running")
        store.save_run(record)
        woken.clear()
        store.append_event(TraceEvent(run_id=record.run_id, seq=1, kind="warning", message="kept"))
        assert [e.seq for e in store.get_events(record.run_id)] == [1]
        assert woken == [record.run_id]  # streams are still woken
        assert PROCESS.snapshot()["errors"] == 1
    finally:
        store.close()


def test_disabled_the_store_takes_no_stamp(histograms, tmp_path, monkeypatch):
    monkeypatch.setattr(PROCESS, "enabled", False)
    store = RunStore(tmp_path / "stamps.db")
    try:
        calls = []
        store.add_commit_listener(lambda *args: calls.append(args))
        record = RunRecord(goal="disabled", status="running")
        store.save_run(record)
        store.append_event(TraceEvent(run_id=record.run_id, seq=1, kind="warning", message="m"))
        assert calls == []
    finally:
        store.close()


# ----------------------------------------------------------------------
# real streams
# ----------------------------------------------------------------------
async def test_a_live_stream_measures_new_events_and_not_its_backlog(histograms, tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch) as app:
        store, broker = app.state.store, app.state.broker
        record = save(store, "running")
        emit(store, record.run_id, 1)
        emit(store, record.run_id, 2)  # committed before the stream exists
        stream = open_stream(app, f"/api/runs/{record.run_id}/stream")
        await stream.wait_for(lambda s: s.seqs == [1, 2])
        assert sse()["count"] == 0  # the backlog is not measured

        emit(store, record.run_id, 3)
        emit(store, record.run_id, 4)
        await stream.wait_for(lambda s: s.seqs == [1, 2, 3, 4])
        assert sse()["count"] == 2
        finish(store, record, 5)
        await asyncio.wait_for(stream.task, 5)
        assert broker.stamps_held() == 0

    assert stream.seqs == [1, 2, 3, 4, 5]  # order unchanged
    item = sse()
    assert item["count"] == 3 and item["invalid"] == 0
    assert 0 <= item["min_ns"] <= item["max_ns"] < 5_000 * MS
    # Only times are kept: nothing identifies the run.
    assert record.run_id not in repr(PROCESS.snapshot())


async def test_every_subscribed_stream_measures_its_own_yield(histograms, tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch) as app:
        store, broker = app.state.store, app.state.broker
        record = save(store, "running")
        emit(store, record.run_id, 1)
        path = f"/api/runs/{record.run_id}/stream"
        first, second = open_stream(app, path), open_stream(app, path)
        await first.wait_for(lambda s: s.seqs == [1])
        await second.wait_for(lambda s: s.seqs == [1])
        emit(store, record.run_id, 2)
        await first.wait_for(lambda s: s.seqs == [1, 2])
        await second.wait_for(lambda s: s.seqs == [1, 2])
        assert sse()["count"] == 2  # one event, yielded by two streams
        await second.disconnect()
        assert broker.subscribers(record.run_id) == 1
        finish(store, record, 3)
        await asyncio.wait_for(first.task, 5)
        assert broker.stamps_held() == 0
    assert sse()["count"] == 3
    assert first.seqs == [1, 2, 3] and second.seqs == [1, 2]


async def test_events_written_from_another_thread_are_measured_or_released(histograms, tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch) as app:
        store, broker = app.state.store, app.state.broker
        record = save(store, "running")
        stream = open_stream(app, f"/api/runs/{record.run_id}/stream")
        await stream.wait_for(lambda s: s.messages == [] and broker.subscribers(record.run_id) == 1)

        def writer():  # a writing thread can race the stream's read
            for seq in range(1, 51):
                emit(store, record.run_id, seq)

        await asyncio.to_thread(writer)
        await stream.wait_for(lambda s: s.seqs == list(range(1, 51)))
        finish(store, record, 51)
        await asyncio.wait_for(stream.task, 5)
        assert broker.stamps_held() == 0  # every stamp used or released
    assert stream.seqs == list(range(1, 52))
    assert 1 <= sse()["count"] <= 51


async def test_a_disconnect_releases_its_stamps_and_measures_nothing_more(histograms, tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch) as app:
        store, broker = app.state.store, app.state.broker
        record = save(store, "running")
        stream = open_stream(app, f"/api/runs/{record.run_id}/stream")
        await stream.wait_for(lambda s: broker.subscribers(record.run_id) == 1)
        await stream.disconnect()
        emit(store, record.run_id, 1)  # nobody subscribed: no stamp
        assert broker.stamps_held() == 0 and broker.subscribers() == 0
    assert sse()["count"] == 0


async def test_the_polling_endpoint_is_not_measured(histograms, tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch) as app:
        store = app.state.store
        record = save(store, "running")
        emit(store, record.run_id, 1)
        polled = await read_to_end(app, f"/api/runs/{record.run_id}/events")
        assert polled.status == 200 and '"seq":1' in polled.raw.replace(" ", "")
    assert sse()["count"] == 0


async def test_a_public_stream_records_only_times(histograms, tmp_path, monkeypatch):
    public = {"mode": "public_demo", "execution_sandbox": "restricted", "code_policy_enabled": True}
    async with running_app(tmp_path, monkeypatch, **public) as app:
        store = app.state.store
        record = save(store, "running")
        stream = open_stream(app, f"/api/runs/{record.run_id}/stream")
        await stream.wait_for(lambda s: app.state.broker.subscribers(record.run_id) == 1)
        emit(store, record.run_id, 1, detail="C:/Users/someone/secret.txt")
        finish(store, record, 2)
        await asyncio.wait_for(stream.task, 5)
    assert stream.seqs == [1, 2] and sse()["count"] == 2
    recorded = repr(PROCESS.snapshot())
    assert "secret" not in recorded and record.run_id not in recorded
