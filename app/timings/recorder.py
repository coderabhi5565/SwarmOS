"""Bounded, in-memory span recording on one monotonic clock.

One ``SpanRecorder`` per run. A span is an interval on
``time.perf_counter_ns``, stored as offsets from the recorder's zero; the
only wall-clock value is one UTC anchor. Nothing is persisted here.

Recording never fails the run: every public method catches its own errors,
counts them (``instrumentation_errors``) and drops the operation.

The recorder for the code that is running is found through context
variables, so deep layers (a provider's HTTP loop, the store) record without
new parameters. asyncio tasks and ``asyncio.to_thread`` copy the context, so
each run's tasks, and its verification thread, see only that run's recorder.

Bounds: at most ``max_spans`` spans per run. Once ``max_spans -
reserved_structural`` are recorded, only structural spans (run boundaries,
graph, nodes, dispatches) are kept; every dropped span is counted by kind.
Attributes are typed and validated: booleans, integers, and id-like strings
(``[A-Za-z0-9_.-]{1,64}``) only, under a fixed set of keys. There is no free
text, so no path, command, URL or key can be recorded.
"""

from __future__ import annotations

import asyncio
import contextvars
import re
import threading
import time
from collections import Counter
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

from app.models import utc_now

SNAPSHOT_VERSION = 1
MAX_SPANS = 2048
RESERVED_STRUCTURAL = 256

STRUCTURAL_KINDS = frozenset(
    {"lifecycle", "admission", "execution", "setup", "graph", "finalization", "node", "dispatch"}
)
DETAIL_KINDS = frozenset(
    {
        "step.schedule_delay",
        "step.checkout",
        "call",
        "call.slot_wait",
        "call.ledger_wait",
        "call.http_attempt",
        "call.parse",
        "call.backoff",
        "verify.thread_wait",
        "verify.run",
        "verify.process",
    }
)
KINDS = STRUCTURAL_KINDS | DETAIL_KINDS
ATTRIBUTE_KEYS = frozenset(
    {
        "node",
        "role",
        "step_id",
        "dispatch_id",
        "attempt",
        "tier",
        "mode",
        "diagnostic",
        "parallel_coding",
        "outcome",
        "reason",
    }
)
_ID = re.compile(r"[A-Za-z0-9_.-]{1,64}")
INVALID = "invalid"

# Fixed log-scale buckets for per-run aggregates: 50 µs doubling to ~105 s,
# plus one overflow bucket.
BUCKET_BOUNDS_NS = tuple(50_000 * 2**i for i in range(22))


def _attribute(value: Any) -> bool | int | str:
    if isinstance(value, bool | int):
        return value
    if isinstance(value, str) and _ID.fullmatch(value):
        return value
    return INVALID


@dataclass
class Span:
    id: int
    kind: str
    parent: int | None
    start: int  # raw clock ns
    end: int | None = None
    attrs: dict[str, bool | int | str] = field(default_factory=dict)


@dataclass
class Aggregate:
    """Count, sum, max and a fixed-bucket histogram of durations (ns)."""

    count: int = 0
    sum_ns: int = 0
    max_ns: int = 0
    buckets: list[int] = field(default_factory=lambda: [0] * (len(BUCKET_BOUNDS_NS) + 1))

    def add(self, duration_ns: int) -> None:
        duration_ns = max(0, duration_ns)
        self.count += 1
        self.sum_ns += duration_ns
        self.max_ns = max(self.max_ns, duration_ns)
        for index, bound in enumerate(BUCKET_BOUNDS_NS):
            if duration_ns <= bound:
                self.buckets[index] += 1
                return
        self.buckets[-1] += 1

    def as_dict(self) -> dict[str, Any]:
        return {"count": self.count, "sum_ns": self.sum_ns, "max_ns": self.max_ns, "buckets": list(self.buckets)}


class SpanHandle:
    """A span opened by ``SpanRecorder.span``; set ``outcome`` before it closes."""

    __slots__ = ("id", "outcome")

    def __init__(self, span_id: int | None) -> None:
        self.id = span_id
        self.outcome: str | None = None


class SpanRecorder:
    def __init__(
        self,
        *,
        enabled: bool = True,
        clock: Callable[[], int] = time.perf_counter_ns,
        zero: int | None = None,
        max_spans: int = MAX_SPANS,
        reserved_structural: int = RESERVED_STRUCTURAL,
    ) -> None:
        self.enabled = enabled
        self._clock = clock
        if zero is None:
            try:
                zero = clock()
            except Exception:  # noqa: BLE001 - an unreadable clock disables recording
                zero, self.enabled = 0, False
        self.zero = zero
        self.anchor_utc = utc_now()
        self.max_spans = max_spans
        self.reserved_structural = min(reserved_structural, max_spans)
        self._spans: dict[int, Span] = {}
        self._next_id = 1
        self._dropped: Counter[str] = Counter()
        self._errors = 0
        self._self_ns = 0
        self._aggregates: dict[str, Aggregate] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # recording
    # ------------------------------------------------------------------
    def now(self) -> int | None:
        """The clock's current reading, or None if it cannot be read."""
        try:
            return self._clock()
        except Exception:  # noqa: BLE001 - instrumentation never fails the run
            self._failed()
            return None

    def start(self, kind: str, *, parent: int | None | object = ..., at: int | None = None, **attrs: Any) -> int | None:
        """Open a span; returns its id, or None when disabled or dropped.
        ``parent`` defaults to the current span of this context."""
        if not self.enabled:
            return None
        entered = self.now()
        if entered is None:
            return None
        try:
            return self._add(kind, entered if at is None else at, None, parent, attrs)
        except Exception:  # noqa: BLE001
            self._failed()
            return None
        finally:
            self._account(entered)

    def started_at(self, span_id: int | None) -> int | None:
        """A recorded span's start (raw clock ns), or None. Never raises."""
        if not isinstance(span_id, int):
            return None
        with self._lock:
            span = self._spans.get(span_id)
            return None if span is None else span.start

    def end(self, span_id: int | None, *, at: int | None = None, outcome: str | None = None) -> None:
        if not self.enabled or span_id is None:
            return
        entered = self.now()
        if entered is None:
            return
        try:
            with self._lock:
                span = self._spans.get(span_id)
                if span is None or span.end is not None:
                    return
                span.end = entered if at is None else at
                if outcome is not None:
                    span.attrs["outcome"] = _attribute(outcome)
        except Exception:  # noqa: BLE001
            self._failed()
        finally:
            self._account(entered)

    def add(self, kind: str, start: int | None, end: int | None, *, parent: int | None | object = ..., **attrs: Any) -> int | None:
        """Record a finished interval measured elsewhere on this clock."""
        if not self.enabled:
            return None
        entered = self.now()
        if entered is None:
            return None
        try:
            if not isinstance(start, int) or not isinstance(end, int):
                raise ValueError("an interval needs two clock readings")
            return self._add(kind, start, end, parent, attrs)
        except Exception:  # noqa: BLE001
            self._failed()
            return None
        finally:
            self._account(entered)

    def instant(self, kind: str, *, parent: int | None | object = ..., **attrs: Any) -> int | None:
        """A zero-length span (a dispatch) at the current time."""
        if not self.enabled:
            return None
        entered = self.now()
        if entered is None:
            return None
        try:
            return self._add(kind, entered, entered, parent, attrs)
        except Exception:  # noqa: BLE001
            self._failed()
            return None
        finally:
            self._account(entered)

    @contextmanager
    def span(self, kind: str, *, parent: int | None | object = ..., **attrs: Any) -> Iterator[SpanHandle]:
        """Open a span for the block and make it the current span inside it.
        It closes with ``outcome`` (``ok`` by default; ``cancelled`` or
        ``error`` if the block raises), however the block ends."""
        handle = SpanHandle(self.start(kind, parent=parent, **attrs))
        token = _CURRENT_SPAN.set(handle.id) if handle.id is not None else None
        outcome = "ok"
        try:
            yield handle
        except asyncio.CancelledError:
            outcome = "cancelled"
            raise
        except BaseException:
            outcome = "error"
            raise
        finally:
            if token is not None:
                _CURRENT_SPAN.reset(token)
            self.end(handle.id, outcome=handle.outcome or outcome)

    def aggregate(self, name: str, duration_ns: int) -> None:
        """Add one duration to a per-run aggregate (persistence timings)."""
        if not self.enabled:
            return
        entered = self.now()
        if entered is None:
            return
        try:
            with self._lock:
                self._aggregates.setdefault(name, Aggregate()).add(duration_ns)
        except Exception:  # noqa: BLE001
            self._failed()
        finally:
            self._account(entered)

    def _account(self, entered: int) -> None:
        """Add the time spent in a recording call to ``self_ns``."""
        leaving = self.now()
        if leaving is None:
            return
        with self._lock:
            self._self_ns += leaving - entered

    def _failed(self) -> None:
        with self._lock:
            self._errors += 1

    def _add(self, kind: str, start: int, end: int | None, parent: Any, attrs: dict[str, Any]) -> int | None:
        if kind not in KINDS:
            raise ValueError(f"unknown span kind {kind!r}")
        if parent is ...:
            parent = _CURRENT_SPAN.get()
        clean: dict[str, bool | int | str] = {}
        for key, value in attrs.items():
            if key in ATTRIBUTE_KEYS and value is not None:
                clean[key] = _attribute(value)
        with self._lock:
            limit = self.max_spans if kind in STRUCTURAL_KINDS else self.max_spans - self.reserved_structural
            if len(self._spans) >= limit:
                self._dropped[kind] += 1
                return None
            span_id = self._next_id
            self._next_id += 1
            self._spans[span_id] = Span(span_id, kind, parent if isinstance(parent, int) else None, start, end, clean)
            return span_id

    # ------------------------------------------------------------------
    # reading
    # ------------------------------------------------------------------
    def snapshot(self) -> dict[str, Any]:
        """A detached, JSON-ready copy; open spans have ``end_ns: None``.
        Never raises: on an internal failure it returns an empty snapshot
        that says so."""
        try:
            return self._snapshot()
        except Exception:  # noqa: BLE001
            return {
                "version": SNAPSHOT_VERSION,
                "enabled": self.enabled,
                "clock": "perf_counter_ns",
                "anchor_utc": self.anchor_utc,
                "spans": [],
                "dropped": {},
                "instrumentation_errors": self._errors + 1,
                "self_ns": 0,
                "aggregates": {},
                "snapshot_failed": True,
            }

    def _snapshot(self) -> dict[str, Any]:
        with self._lock:
            spans = [
                {
                    "id": span.id,
                    "kind": span.kind,
                    "parent": span.parent,
                    "start_ns": span.start - self.zero,
                    "end_ns": None if span.end is None else span.end - self.zero,
                    "attrs": dict(span.attrs),
                }
                for span in self._spans.values()
            ]
            return {
                "version": SNAPSHOT_VERSION,
                "enabled": self.enabled,
                "clock": "perf_counter_ns",
                "anchor_utc": self.anchor_utc,
                "spans": spans,
                "dropped": dict(self._dropped),
                "instrumentation_errors": self._errors,
                "self_ns": self._self_ns,
                "aggregates": {name: item.as_dict() for name, item in self._aggregates.items()},
            }


# ----------------------------------------------------------------------
# the recorder of the running code
# ----------------------------------------------------------------------
DISABLED = SpanRecorder(enabled=False)
_RECORDER: contextvars.ContextVar[SpanRecorder] = contextvars.ContextVar("swarmos_timings", default=DISABLED)
_CURRENT_SPAN: contextvars.ContextVar[int | None] = contextvars.ContextVar("swarmos_span", default=None)


def current() -> SpanRecorder:
    """The recorder for this context (a disabled one when none is active)."""
    return _RECORDER.get()


@contextmanager
def activate(recorder: SpanRecorder) -> Iterator[SpanRecorder]:
    """Make ``recorder`` this context's recorder, with no current span."""
    recorder_token = _RECORDER.set(recorder)
    span_token = _CURRENT_SPAN.set(None)
    try:
        yield recorder
    finally:
        _CURRENT_SPAN.reset(span_token)
        _RECORDER.reset(recorder_token)
