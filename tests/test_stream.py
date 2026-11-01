"""Live trace streaming: GET /api/runs/{run_id}/stream (Server-Sent Events).

The tests drive the ASGI app directly in the test's event loop. The
TestClient buffers a whole response, which cannot observe a stream that is
still open, deliver events into it, or disconnect from it part-way.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

import pytest

import app.main as main_module
from app.models import RunRecord, TraceEvent
from app.streaming import RunEventBroker, effective_cursor, parse_last_event_id
from tests.conftest import make_settings

SECRET_KEY = "sk-stream-test-secret-000"
PRIVATE_URL = "http://10.20.30.40:11434/v1"
PUBLIC = {
    "mode": "public_demo",
    "execution_sandbox": "restricted",
    "code_policy_enabled": True,
}


# ----------------------------------------------------------------------
# harness
# ----------------------------------------------------------------------
@asynccontextmanager
async def running_app(tmp_path, monkeypatch, **overrides):
    """The app with its lifespan (store, broker, service) started in this loop."""
    monkeypatch.setattr(main_module, "settings", make_settings(tmp_path, **overrides))
    app = main_module.app
    async with main_module.lifespan(app):
        yield app


@dataclass
class Message:
    event: str
    data: str
    id: str | None


@dataclass
class Stream:
    """One open GET against the app, read as SSE."""

    status: int | None = None
    headers: dict[str, str] = field(default_factory=dict)
    raw: str = ""
    finished: bool = False
    _changed: asyncio.Event = field(default_factory=asyncio.Event)
    _disconnect: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None

    @property
    def messages(self) -> list[Message]:
        found = []
        for block in self.raw.split("\n\n"):
            lines = [line for line in block.split("\n") if line and not line.startswith(":")]
            fields: dict[str, str] = {}
            for line in lines:
                name, _, value = line.partition(": ")
                fields[name] = value
            if "data" in fields:
                found.append(Message(fields.get("event", "message"), fields["data"], fields.get("id")))
        return found

    @property
    def traces(self) -> list[dict]:
        return [json.loads(m.data) for m in self.messages if m.event == "trace"]

    @property
    def seqs(self) -> list[int]:
        return [event["seq"] for event in self.traces]

    @property
    def end(self) -> dict | None:
        ends = [json.loads(m.data) for m in self.messages if m.event == "end"]
        return ends[-1] if ends else None

    async def wait_for(self, predicate, within: float = 5.0) -> None:
        async def poll():
            while not predicate(self):
                self._changed.clear()
                if predicate(self):
                    return
                await self._changed.wait()

        await asyncio.wait_for(poll(), within)

    async def disconnect(self) -> None:
        self._disconnect.set()
        assert self.task is not None
        await asyncio.wait_for(self.task, 5)


def open_stream(app, path: str, query: str = "", headers: dict[str, str] | None = None, client="127.0.0.1") -> Stream:
    stream = Stream()
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": query.encode(),
        "root_path": "",
        "headers": [(b"host", b"testserver")]
        + [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
        "client": (client, 50000),
        "server": ("testserver", 80),
        "state": {},
    }
    sent_request = False

    async def receive():
        nonlocal sent_request
        if not sent_request:
            sent_request = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await stream._disconnect.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == "http.response.start":
            stream.status = message["status"]
            stream.headers = {k.decode(): v.decode() for k, v in message["headers"]}
        elif message["type"] == "http.response.body":
            stream.raw += message.get("body", b"").decode()
            if not message.get("more_body", False):
                stream.finished = True
        stream._changed.set()

    async def run():
        await app(scope, receive, send)
        stream.finished = True
        stream._changed.set()

    stream.task = asyncio.create_task(run())
    return stream


async def read_to_end(app, path: str, **kwargs) -> Stream:
    stream = open_stream(app, path, **kwargs)
    await asyncio.wait_for(stream.task, 10)
    return stream


def emit(store, run_id: str, seq: int, kind: str = "warning", **payload) -> None:
    store.append_event(
        TraceEvent(run_id=run_id, seq=seq, kind=kind, message=f"e{seq}", payload=payload)
    )


def save(store, status: str, run_id: str | None = None) -> RunRecord:
    record = RunRecord(goal="streamed", status=status)
    if run_id is not None:
        record = record.model_copy(update={"run_id": run_id})
    store.save_run(record)
    return record


def finish(store, record: RunRecord, seq: int, status: str = "completed") -> None:
    """The order every terminal path uses: run_finished, then the status."""
    emit(store, record.run_id, seq, "run_finished", status=status)
    store.save_run(record.model_copy(update={"status": status}))


# ----------------------------------------------------------------------
# format, completed runs, unknown runs
# ----------------------------------------------------------------------
async def test_a_completed_run_streams_its_trace_then_ends(tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch) as app:
        store = app.state.store
        record = save(store, "running")
        for seq in (1, 2, 3):
            emit(store, record.run_id, seq)
        finish(store, record, 4)

        stream = await read_to_end(app, f"/api/runs/{record.run_id}/stream")

    assert stream.status == 200
    assert stream.headers["content-type"].startswith("text/event-stream")
    assert stream.headers["cache-control"] == "no-cache"
    assert stream.raw.startswith("retry: ")
    assert stream.seqs == [1, 2, 3, 4]
    # Each trace message's id is the event's own seq.
    assert [m.id for m in stream.messages if m.event == "trace"] == ["1", "2", "3", "4"]
    assert stream.traces[0]["run_id"] == record.run_id
    assert stream.traces[3]["kind"] == "run_finished"
    assert stream.end == {"run_id": record.run_id, "status": "completed", "last_seq": 4}
    assert stream.messages[-1].event == "end"


async def test_the_streamed_events_are_exactly_the_polled_events(tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch) as app:
        store = app.state.store
        record = save(store, "running")
        for seq in range(1, 6):
            emit(store, record.run_id, seq)
        finish(store, record, 6)
        stream = await read_to_end(app, f"/api/runs/{record.run_id}/stream")
        polled = [e.model_dump(mode="json") for e in store.get_events(record.run_id)]
    assert stream.traces == polled


async def test_a_real_catalog_run_streams_to_the_end(tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch) as app:
        record = app.state.service.submit(
            main_module.RunRequest(goal="catalog run", demo_task="sample_tag_normalization")
        )
        stream = await read_to_end(app, f"/api/runs/{record.run_id}/stream")
        final = app.state.store.get_run(record.run_id)
        polled = [e.seq for e in app.state.store.get_events(record.run_id)]

    assert stream.seqs == polled
    assert stream.traces[0]["kind"] == "run_started"
    assert stream.traces[-1]["kind"] == "run_finished"
    assert stream.end == {"run_id": record.run_id, "status": final.status, "last_seq": polled[-1]}


async def test_an_unknown_run_is_a_404_not_a_stream(tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch) as app:
        stream = await read_to_end(app, "/api/runs/run_missing/stream")
        assert app.state.broker.open_streams() == 0
    assert stream.status == 404
    assert json.loads(stream.raw) == {"detail": "run run_missing not found"}


async def test_a_terminal_run_without_events_still_ends(tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch) as app:
        record = save(app.state.store, "failed")
        stream = await read_to_end(app, f"/api/runs/{record.run_id}/stream")
    assert stream.seqs == []
    assert stream.end == {"run_id": record.run_id, "status": "failed", "last_seq": 0}


# ----------------------------------------------------------------------
# live delivery and ordering
# ----------------------------------------------------------------------
async def test_events_of_an_active_run_arrive_as_they_are_recorded(tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch) as app:
        store = app.state.store
        record = save(store, "running")
        emit(store, record.run_id, 1)

        stream = open_stream(app, f"/api/runs/{record.run_id}/stream")
        await stream.wait_for(lambda s: s.seqs == [1])

        emit(store, record.run_id, 2)
        await stream.wait_for(lambda s: s.seqs == [1, 2])
        emit(store, record.run_id, 3)
        emit(store, record.run_id, 4)
        await stream.wait_for(lambda s: s.seqs == [1, 2, 3, 4])
        assert not stream.finished and stream.end is None

        finish(store, record, 5)
        await asyncio.wait_for(stream.task, 5)

    assert stream.seqs == [1, 2, 3, 4, 5]
    assert stream.end["status"] == "completed"


async def test_events_recorded_out_of_order_are_sent_in_seq_order(tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch) as app:
        store = app.state.store
        record = save(store, "running")
        for seq in (3, 1, 2):
            emit(store, record.run_id, seq)
        finish(store, record, 4)
        stream = await read_to_end(app, f"/api/runs/{record.run_id}/stream")
    assert stream.seqs == [1, 2, 3, 4]


async def test_a_long_trace_is_sent_in_batches_without_loss(tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch) as app:
        store = app.state.store
        record = save(store, "running")
        for seq in range(1, 451):
            emit(store, record.run_id, seq)
        finish(store, record, 451)
        stream = await read_to_end(app, f"/api/runs/{record.run_id}/stream")
    assert stream.seqs == list(range(1, 452))


async def test_heartbeats_are_comments_not_events(tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch, stream_heartbeat_seconds=0.05) as app:
        store = app.state.store
        record = save(store, "running")
        stream = open_stream(app, f"/api/runs/{record.run_id}/stream")
        await stream.wait_for(lambda s: s.raw.count(": keepalive") >= 2)
        assert stream.messages == []
        finish(store, record, 1)
        await asyncio.wait_for(stream.task, 5)
    assert stream.seqs == [1]


async def test_a_stream_closes_after_its_maximum_lifetime(tmp_path, monkeypatch):
    async with running_app(
        tmp_path, monkeypatch, stream_heartbeat_seconds=0.05, stream_max_seconds=0.2
    ) as app:
        store = app.state.store
        record = save(store, "running")
        emit(store, record.run_id, 1)
        stream = await read_to_end(app, f"/api/runs/{record.run_id}/stream")
        # Closed without an end message: the client reconnects from seq 1.
        assert stream.seqs == [1] and stream.end is None
        assert app.state.broker.open_streams() == 0


# ----------------------------------------------------------------------
# cursors
# ----------------------------------------------------------------------
async def test_after_seq_resumes_after_the_cursor(tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch) as app:
        store = app.state.store
        record = save(store, "running")
        for seq in range(1, 5):
            emit(store, record.run_id, seq)
        finish(store, record, 5)
        stream = await read_to_end(app, f"/api/runs/{record.run_id}/stream", query="after_seq=3")
        caught_up = await read_to_end(app, f"/api/runs/{record.run_id}/stream", query="after_seq=5")
    assert stream.seqs == [4, 5]
    assert caught_up.seqs == [] and caught_up.end["last_seq"] == 5


async def test_last_event_id_resumes_a_reconnecting_client(tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch) as app:
        store = app.state.store
        record = save(store, "running")
        for seq in range(1, 5):
            emit(store, record.run_id, seq)
        finish(store, record, 5)
        path = f"/api/runs/{record.run_id}/stream"
        resumed = await read_to_end(app, path, headers={"Last-Event-ID": "2"})
        # A browser reconnects with the original URL plus Last-Event-ID: the
        # greater cursor wins, in either direction.
        newer_header = await read_to_end(
            app, path, query="after_seq=1", headers={"Last-Event-ID": "3"}
        )
        newer_query = await read_to_end(
            app, path, query="after_seq=4", headers={"Last-Event-ID": "2"}
        )
        blank = await read_to_end(app, path, headers={"Last-Event-ID": " "})
    assert resumed.seqs == [3, 4, 5]
    assert newer_header.seqs == [4, 5]
    assert newer_query.seqs == [5]
    assert blank.seqs == [1, 2, 3, 4, 5]


@pytest.mark.parametrize("header", ["abc", "-1", "1.5"])
async def test_a_malformed_last_event_id_is_rejected(tmp_path, monkeypatch, header):
    async with running_app(tmp_path, monkeypatch) as app:
        record = save(app.state.store, "completed")
        stream = await read_to_end(
            app, f"/api/runs/{record.run_id}/stream", headers={"Last-Event-ID": header}
        )
        assert app.state.broker.open_streams() == 0
    assert stream.status == 400


@pytest.mark.parametrize("cursor", ["-1", "abc"])
async def test_a_malformed_after_seq_is_rejected(tmp_path, monkeypatch, cursor):
    async with running_app(tmp_path, monkeypatch) as app:
        record = save(app.state.store, "completed")
        stream = await read_to_end(app, f"/api/runs/{record.run_id}/stream", query=f"after_seq={cursor}")
    assert stream.status == 422


def test_cursor_rules():
    assert effective_cursor(None, None) == 0
    assert effective_cursor(4, None) == 4
    assert effective_cursor(None, 7) == 7
    assert effective_cursor(9, 7) == 9
    assert parse_last_event_id(None) is None
    assert parse_last_event_id("  ") is None
    assert parse_last_event_id(" 12 ") == 12
    with pytest.raises(ValueError):
        parse_last_event_id("-3")


async def test_reconnecting_never_repeats_or_skips_an_event(tmp_path, monkeypatch):
    """Drop the stream mid-run, record more, resume from the last id seen."""
    async with running_app(tmp_path, monkeypatch) as app:
        store = app.state.store
        record = save(store, "running")
        path = f"/api/runs/{record.run_id}/stream"
        emit(store, record.run_id, 1)
        emit(store, record.run_id, 2)

        first = open_stream(app, path)
        await first.wait_for(lambda s: s.seqs == [1, 2])
        await first.disconnect()

        emit(store, record.run_id, 3)  # recorded while disconnected
        last_id = [m.id for m in first.messages if m.event == "trace"][-1]
        second = open_stream(app, path, headers={"Last-Event-ID": last_id})
        await second.wait_for(lambda s: s.seqs == [3])
        emit(store, record.run_id, 4)
        finish(store, record, 5)
        await asyncio.wait_for(second.task, 5)

    assert first.seqs + second.seqs == [1, 2, 3, 4, 5]


async def test_no_event_is_lost_between_reading_a_cursor_and_connecting(tmp_path, monkeypatch):
    """The race: the client polls (cursor 2), events land, then it connects."""
    async with running_app(tmp_path, monkeypatch) as app:
        store = app.state.store
        record = save(store, "running")
        emit(store, record.run_id, 1)
        emit(store, record.run_id, 2)
        cursor = store.get_events(record.run_id)[-1].seq

        emit(store, record.run_id, 3)  # between the poll and the connection
        stream = open_stream(app, f"/api/runs/{record.run_id}/stream", query=f"after_seq={cursor}")
        await stream.wait_for(lambda s: s.seqs == [3])
        finish(store, record, 4)
        await asyncio.wait_for(stream.task, 5)
    assert stream.seqs == [3, 4]


async def test_events_recorded_while_the_stream_reads_are_not_lost(tmp_path, monkeypatch):
    """A write that lands after the stream's read, while it is still sending
    what it read, must wake it: the wake flag is cleared before reading."""
    async with running_app(tmp_path, monkeypatch) as app:
        store = app.state.store
        record = save(store, "running")
        emit(store, record.run_id, 1)
        original = store.get_events
        injected = False

        def get_events_then_write(run_id, after_seq=None, limit=None):
            nonlocal injected
            events = original(run_id, after_seq=after_seq, limit=limit)
            if not injected:
                injected = True
                emit(store, record.run_id, 2)  # committed just after the read
            return events

        monkeypatch.setattr(store, "get_events", get_events_then_write)
        stream = open_stream(app, f"/api/runs/{record.run_id}/stream")
        # The heartbeat is 15 s: only the wake-up can deliver this in time.
        await stream.wait_for(lambda s: s.seqs == [1, 2], within=3)
        finish(store, record, 3)
        await asyncio.wait_for(stream.task, 5)
    assert stream.seqs == [1, 2, 3]


async def test_a_duplicate_write_is_never_sent_again(tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch) as app:
        store = app.state.store
        record = save(store, "running")
        event = TraceEvent(run_id=record.run_id, seq=1, kind="warning", message="once")
        store.append_event(event)
        stream = open_stream(app, f"/api/runs/{record.run_id}/stream")
        await stream.wait_for(lambda s: s.seqs == [1])
        store.append_event(event)  # the same event_id again: ignored by the store
        finish(store, record, 2)
        await asyncio.wait_for(stream.task, 5)
    assert stream.seqs == [1, 2]


# ----------------------------------------------------------------------
# clients
# ----------------------------------------------------------------------
async def test_a_disconnect_releases_the_stream(tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch) as app:
        store, broker = app.state.store, app.state.broker
        record = save(store, "running")
        emit(store, record.run_id, 1)
        stream = open_stream(app, f"/api/runs/{record.run_id}/stream")
        await stream.wait_for(lambda s: s.seqs == [1])
        assert broker.open_streams() == 1
        assert broker.subscribers(record.run_id) == 1

        await stream.disconnect()

        assert broker.open_streams() == 0
        assert broker.subscribers() == 0
        emit(store, record.run_id, 2)  # nobody left to wake: no error


async def test_concurrent_clients_each_get_the_whole_trace(tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch) as app:
        store, broker = app.state.store, app.state.broker
        record = save(store, "running")
        emit(store, record.run_id, 1)
        path = f"/api/runs/{record.run_id}/stream"
        early = open_stream(app, path)
        late = open_stream(app, path, query="after_seq=1")
        leaver = open_stream(app, path)
        await early.wait_for(lambda s: s.seqs == [1])
        await leaver.wait_for(lambda s: s.seqs == [1])
        assert broker.subscribers(record.run_id) == 3

        await leaver.disconnect()  # one client leaving affects no other
        emit(store, record.run_id, 2)
        emit(store, record.run_id, 3)
        await late.wait_for(lambda s: s.seqs == [2, 3])
        finish(store, record, 4)
        await asyncio.wait_for(asyncio.gather(early.task, late.task), 5)
        assert broker.open_streams() == 0

    assert early.seqs == [1, 2, 3, 4]
    assert late.seqs == [2, 3, 4]
    assert leaver.seqs == [1]


async def test_streams_of_other_runs_are_not_woken(tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch) as app:
        store, broker = app.state.store, app.state.broker
        watched = save(store, "running")
        other = save(store, "running")
        with broker.subscribe(watched.run_id) as wake:
            emit(store, other.run_id, 1)
            await asyncio.sleep(0.05)
            assert not wake.is_set()
            emit(store, watched.run_id, 1)
            await asyncio.wait_for(wake.wait(), 1)


def test_the_broker_counts_streams_per_client_and_in_total():
    broker = RunEventBroker(max_streams=3, max_per_client=2)
    broker.open("a")
    broker.open("a")
    with pytest.raises(Exception, match="this client has 2"):
        broker.open("a")
    broker.open("b")
    with pytest.raises(Exception, match="3 live streams are open"):
        broker.open("c")
    broker.close("a")
    broker.open("c")
    assert broker.open_streams() == 3


# ----------------------------------------------------------------------
# public demo
# ----------------------------------------------------------------------
async def test_the_public_demo_caps_open_streams_per_client(tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch, **PUBLIC, max_streams_per_client=2) as app:
        store = app.state.store
        record = save(store, "running")
        path = f"/api/runs/{record.run_id}/stream"
        first = open_stream(app, path, client="198.51.100.1")
        second = open_stream(app, path, client="198.51.100.1")
        await first.wait_for(lambda s: s.status == 200)
        await second.wait_for(lambda s: s.status == 200)

        refused = await read_to_end(app, path, client="198.51.100.1")
        assert refused.status == 429
        assert refused.headers["retry-after"] == "15"
        other_client = open_stream(app, path, client="198.51.100.2")
        await other_client.wait_for(lambda s: s.status == 200)

        await first.disconnect()  # a slot frees up when a stream closes
        again = open_stream(app, path, client="198.51.100.1")
        await again.wait_for(lambda s: s.status == 200)
        finish(store, record, 1)
        await asyncio.wait_for(asyncio.gather(second.task, other_client.task, again.task), 5)


async def test_the_api_token_guards_the_stream(tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch, api_token="stream-token") as app:
        record = save(app.state.store, "completed")
        path = f"/api/runs/{record.run_id}/stream"
        denied = await read_to_end(app, path)
        allowed = await read_to_end(app, path, headers={"Authorization": "Bearer stream-token"})
    assert denied.status == 401
    assert allowed.status == 200 and allowed.end["status"] == "completed"


async def test_the_stream_creates_nothing_and_accepts_no_inputs(tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch, **PUBLIC) as app:
        store = app.state.store
        before = len(store.list_runs(200))
        stream = await read_to_end(
            app,
            "/api/runs/run_new/stream",
            query="goal=rm+-rf&provider=openai&demo_task=sample_tag_normalization",
        )
        assert stream.status == 404
        assert len(store.list_runs(200)) == before


async def test_a_public_catalog_stream_leaks_no_endpoint_or_key(tmp_path, monkeypatch):
    overrides = {**PUBLIC, "base_url": PRIVATE_URL, "fast_model": "m", "api_key": SECRET_KEY}
    async with running_app(tmp_path, monkeypatch, **overrides) as app:
        record = app.state.service.submit(
            main_module.RunRequest(goal="catalog run", demo_task="sample_tag_normalization")
        )
        stream = await read_to_end(app, f"/api/runs/{record.run_id}/stream")
    assert stream.end is not None
    assert SECRET_KEY not in stream.raw
    assert PRIVATE_URL not in stream.raw
    assert "10.20.30.40" not in stream.raw
