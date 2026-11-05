"""Live trace streaming over Server-Sent Events.

The store stays the only source of events. A stream never buffers or
forwards events itself: it is woken when a run changes, re-reads the store
after its cursor, and writes what it finds. So a stream can miss a wake-up
(a heartbeat re-reads anyway) but never an event, and a slow client holds
back only its own stream.

Cursor rules for ``GET /api/runs/{run_id}/stream``:

* ``after_seq`` (query) and ``Last-Event-ID`` (header, set by browsers when an
  EventSource reconnects) both mean "I have every event up to this seq".
  The stream starts after the greater of the two; absent means 0.
* Every event is sent with ``id: <seq>``, its own sequence number, and events
  go out in ascending seq. An event is never renumbered, so a client that
  resumes from its last id never receives an earlier event as a new one.

The stream ends with an ``end`` event once the run is terminal and every
event has been sent. The run's status is read *before* each drain of the
trace, and every terminal path writes its last event before (or with) the
terminal status, so a terminal status seen before a drain means the drain
was complete.

``sse_commit_to_yield`` (process histogram, app.timings.process): for an
event committed while a stream is subscribed to its run, the monotonic time
from immediately after the event's commit (``RunStore.add_commit_listener``)
to the moment this generator yields that event's frame to the server. Each
stream keeps the commit stamps of its run's new events until it yields them;
the backlog read on connect was committed before the stream existed and has
none, so it is not measured. At most ``MAX_COMMIT_STAMPS`` stamps are held
across all streams; a stamp that does not fit is dropped and counted
(``sse_commit_to_yield.stamps_dropped``). This is the server side only: it
excludes the socket write, any proxy, the network and the browser, so it is
**not** delivery latency. The polling endpoint is not measured. Only times
are recorded: no run id, seq or event content.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import contextmanager
from dataclasses import dataclass, field

from app.models import TraceEvent
from app.store import RunStore
from app.timings.process import PROCESS

TERMINAL_STATUSES = frozenset(
    {
        "completed",
        "completed_with_findings",
        "review_invalid",
        "failed",
        "cancelled",
        "budget_exceeded",
        "limit_exceeded",
        "timed_out",
    }
)

# Events read from the store per drain; a long trace is sent in batches.
BATCH_SIZE = 200
# How long a client waits before reconnecting after the stream drops.
RECONNECT_MS = 2000
# Commit stamps held at once, across every open stream (see the docstring).
MAX_COMMIT_STAMPS = 4096


class StreamLimitError(RuntimeError):
    """Too many streams are open, in total or for one client."""


@dataclass(eq=False)  # compared by identity: each stream is its own waiter
class _Waiter:
    loop: asyncio.AbstractEventLoop
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    # seq -> perf_counter_ns at its commit, for events committed while this
    # stream was subscribed and not yet yielded by it.
    stamps: dict[int, int] = field(default_factory=dict)


class Subscription:
    """One stream's subscription: its wake flag, and its commit stamps."""

    def __init__(self, broker: RunEventBroker, waiter: _Waiter) -> None:
        self._broker = broker
        self._waiter = waiter
        self.wake = waiter.wake

    def yielding(self, seq: int) -> None:
        """Call immediately before yielding event ``seq``'s frame: observes
        ``sse_commit_to_yield`` if the event was committed while subscribed.
        Never raises."""
        if not PROCESS.enabled:
            return
        try:
            now = time.perf_counter_ns()
            stamp = self._broker._take_stamp(self._waiter, seq)
            if stamp is not None:
                PROCESS.observe("sse_commit_to_yield", now - stamp)
        except Exception:  # noqa: BLE001 - instrumentation never fails a stream
            PROCESS.failed()


class RunEventBroker:
    """Wakes open streams when their run changes; counts open streams.

    Notifications carry no data, so memory is one flag per open stream.
    ``notify`` may be called from any thread (the store calls it on the
    writing thread).
    """

    def __init__(self, max_streams: int = 0, max_per_client: int = 0) -> None:
        self.max_streams = max_streams
        self.max_per_client = max_per_client
        self._lock = threading.Lock()
        self._waiters: dict[str, set[_Waiter]] = {}
        self._clients: dict[str, int] = {}
        self._stamps_held = 0  # across every waiter, at most MAX_COMMIT_STAMPS

    # ------------------------------------------------------------------
    def notify(self, run_id: str) -> None:
        with self._lock:
            waiters = list(self._waiters.get(run_id, ()))
        for waiter in waiters:
            try:
                waiter.loop.call_soon_threadsafe(waiter.wake.set)
            except RuntimeError:
                pass  # that stream's loop has closed; its finally unsubscribes

    def record_commit(self, run_id: str, seq: int, committed_ns: int) -> None:
        """Keep an event's commit stamp for each stream subscribed to its run
        (a ``RunStore`` commit listener; any thread). Never raises."""
        if not PROCESS.enabled:
            return
        try:
            dropped = 0
            with self._lock:
                for waiter in self._waiters.get(run_id, ()):
                    if seq in waiter.stamps:
                        continue
                    if self._stamps_held >= MAX_COMMIT_STAMPS:
                        dropped += 1
                        continue
                    waiter.stamps[seq] = committed_ns
                    self._stamps_held += 1
            for _ in range(dropped):
                PROCESS.increment("sse_commit_to_yield.stamps_dropped")
        except Exception:  # noqa: BLE001 - instrumentation never fails a write
            PROCESS.failed()

    def _take_stamp(self, waiter: _Waiter, seq: int) -> int | None:
        """``seq``'s stamp for this stream, if any. Stamps of earlier seqs
        are dropped too: the cursor only moves forward, so they can never be
        yielded (an event read before its stamp was recorded)."""
        with self._lock:
            stamp = waiter.stamps.pop(seq, None)
            stale = [earlier for earlier in waiter.stamps if earlier < seq]
            for earlier in stale:
                del waiter.stamps[earlier]
            self._stamps_held -= len(stale) + (stamp is not None)
        return stamp

    @contextmanager
    def watch(self, run_id: str):
        """A ``Subscription`` for ``run_id``: its wake flag is set whenever the
        run changes; its commit stamps are released when it ends."""
        waiter = _Waiter(loop=asyncio.get_running_loop())
        with self._lock:
            self._waiters.setdefault(run_id, set()).add(waiter)
        try:
            yield Subscription(self, waiter)
        finally:
            with self._lock:
                waiters = self._waiters.get(run_id)
                if waiters is not None:
                    waiters.discard(waiter)
                    if not waiters:
                        del self._waiters[run_id]
                self._stamps_held -= len(waiter.stamps)
                waiter.stamps.clear()

    @contextmanager
    def subscribe(self, run_id: str):
        """A wake flag for ``run_id``, set whenever the run changes."""
        with self.watch(run_id) as subscription:
            yield subscription.wake

    # ------------------------------------------------------------------
    def open(self, client: str) -> None:
        """Count a new stream for ``client``, or raise StreamLimitError."""
        with self._lock:
            total = sum(self._clients.values())
            if self.max_streams > 0 and total >= self.max_streams:
                raise StreamLimitError(
                    f"{total} live streams are open; the limit is {self.max_streams}"
                )
            mine = self._clients.get(client, 0)
            if self.max_per_client > 0 and mine >= self.max_per_client:
                raise StreamLimitError(
                    f"this client has {mine} live streams open; the limit is {self.max_per_client}"
                )
            self._clients[client] = mine + 1

    def close(self, client: str) -> None:
        with self._lock:
            remaining = self._clients.get(client, 0) - 1
            if remaining > 0:
                self._clients[client] = remaining
            else:
                self._clients.pop(client, None)

    # Introspection for tests and health checks.
    def open_streams(self) -> int:
        with self._lock:
            return sum(self._clients.values())

    def subscribers(self, run_id: str | None = None) -> int:
        with self._lock:
            if run_id is not None:
                return len(self._waiters.get(run_id, ()))
            return sum(len(waiters) for waiters in self._waiters.values())

    def stamps_held(self) -> int:
        with self._lock:
            return self._stamps_held


# ----------------------------------------------------------------------
# SSE framing
# ----------------------------------------------------------------------
def sse_event(event: TraceEvent) -> str:
    data = event.model_dump_json()
    return f"id: {event.seq}\nevent: trace\ndata: {data}\n\n"


def sse_end(run_id: str, status: str | None, last_seq: int) -> str:
    data = json.dumps({"run_id": run_id, "status": status, "last_seq": last_seq})
    return f"event: end\ndata: {data}\n\n"


def sse_retry(milliseconds: int = RECONNECT_MS) -> str:
    return f"retry: {milliseconds}\n\n"


SSE_KEEPALIVE = ": keepalive\n\n"


def parse_last_event_id(value: str | None) -> int | None:
    """The seq in a Last-Event-ID header; None when absent or blank.

    Raises ValueError for anything that is not a non-negative integer.
    """
    if value is None or not value.strip():
        return None
    seq = int(value.strip())
    if seq < 0:
        raise ValueError("Last-Event-ID must be a non-negative integer")
    return seq


def effective_cursor(after_seq: int | None, last_event_id: int | None) -> int:
    """Where a stream starts: after the greater of the two cursors (0 if neither)."""
    return max(after_seq or 0, last_event_id or 0)


async def run_event_stream(
    store: RunStore,
    broker: RunEventBroker,
    run_id: str,
    cursor: int,
    *,
    heartbeat_seconds: float,
    max_seconds: float,
    is_disconnected: Callable[[], Awaitable[bool]] | None = None,
    view: Callable[[TraceEvent], TraceEvent] | None = None,
) -> AsyncIterator[str]:
    """SSE frames for ``run_id``'s trace after ``cursor``, live until the run ends.

    Closes after ``max_seconds`` without an ``end`` event; the client then
    reconnects from its cursor. Cancellation (a client disconnect) exits
    through the subscription's cleanup. ``view``, when given, is applied to
    each event before it is sent (the public demo's redaction); it must keep
    the event's seq, which the cursor follows.
    """
    deadline = time.monotonic() + max_seconds
    yield sse_retry()
    # Subscribe before the first read: a change committed after the read
    # sets the flag, so the wait below returns at once and re-reads.
    with broker.watch(run_id) as subscription:
        wake = subscription.wake
        while True:
            if is_disconnected is not None and await is_disconnected():
                return
            wake.clear()
            record = store.get_run(run_id)
            if record is None:
                return
            # Status first, then the trace (see the module docstring).
            terminal = record.status in TERMINAL_STATUSES
            events = store.get_events(run_id, after_seq=cursor, limit=BATCH_SIZE)
            for event in events:
                frame = sse_event(view(event) if view is not None else event)
                subscription.yielding(event.seq)
                yield frame
                cursor = event.seq
            if len(events) == BATCH_SIZE:
                continue  # more already recorded: keep draining before waiting
            if terminal:
                yield sse_end(run_id, record.status, cursor)
                return
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            try:
                await asyncio.wait_for(wake.wait(), timeout=min(heartbeat_seconds, remaining))
            except TimeoutError:
                yield SSE_KEEPALIVE
