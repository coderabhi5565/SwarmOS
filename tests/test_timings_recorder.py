"""The span recorder (app.timings.recorder): monotonic offsets, nesting,
outcomes, bounds, attribute validation, isolation, and never failing."""

from __future__ import annotations

import asyncio

import pytest

from app.timings import recorder as timings
from app.timings.recorder import BUCKET_BOUNDS_NS, SpanRecorder, activate, current


class FakeClock:
    """A clock the test moves by hand (ns)."""

    def __init__(self, t: int = 1_000) -> None:
        self.t = t

    def __call__(self) -> int:
        return self.t


def make(clock: FakeClock | None = None, **kwargs) -> tuple[SpanRecorder, FakeClock]:
    clock = clock or FakeClock()
    return SpanRecorder(clock=clock, **kwargs), clock


def spans_by_kind(snapshot: dict) -> dict[str, list[dict]]:
    found: dict[str, list[dict]] = {}
    for span in snapshot["spans"]:
        found.setdefault(span["kind"], []).append(span)
    return found


# ----------------------------------------------------------------------
# clock and nesting
# ----------------------------------------------------------------------
def test_spans_are_offsets_from_the_zero_on_one_clock():
    recorder, clock = make(FakeClock(5_000))
    clock.t = 5_200
    with recorder.span("graph"):
        clock.t = 5_900
    span = recorder.snapshot()["spans"][0]
    assert (span["start_ns"], span["end_ns"]) == (200, 900)
    assert recorder.snapshot()["clock"] == "perf_counter_ns"


def test_nested_spans_take_the_current_span_as_parent():
    recorder, clock = make()
    with activate(recorder):
        with recorder.span("graph") as graph:
            with recorder.span("node", node="planner") as node:
                clock.t += 10
                child = recorder.start("call", role="planner")
                clock.t += 5
                recorder.end(child)
            sibling = recorder.instant("dispatch", dispatch_id=1)
    spans = {span["id"]: span for span in recorder.snapshot()["spans"]}
    assert spans[graph.id]["parent"] is None
    assert spans[node.id]["parent"] == graph.id
    assert spans[child]["parent"] == node.id
    assert spans[sibling]["parent"] == graph.id
    assert spans[sibling]["start_ns"] == spans[sibling]["end_ns"]


def test_an_explicit_parent_and_a_retroactive_interval():
    recorder, _ = make()
    root = recorder.start("lifecycle", parent=None, at=1_000)
    added = recorder.add("admission", 1_000, 1_300, parent=root)
    span = {s["id"]: s for s in recorder.snapshot()["spans"]}[added]
    assert (span["parent"], span["start_ns"], span["end_ns"]) == (root, 0, 300)


# ----------------------------------------------------------------------
# outcomes
# ----------------------------------------------------------------------
async def test_a_cancelled_block_closes_its_span_as_cancelled():
    recorder, _ = make()

    async def blocked():
        with recorder.span("call.slot_wait"):
            await asyncio.Event().wait()

    task = asyncio.create_task(blocked())
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    span = recorder.snapshot()["spans"][0]
    assert span["end_ns"] is not None and span["attrs"]["outcome"] == "cancelled"


def test_an_error_closes_the_span_as_error_and_still_raises():
    recorder, _ = make()
    with pytest.raises(RuntimeError):
        with recorder.span("call"):
            raise RuntimeError("provider failed")
    assert recorder.snapshot()["spans"][0]["attrs"]["outcome"] == "error"


def test_a_handle_outcome_overrides_the_default():
    recorder, _ = make()
    with recorder.span("call.http_attempt") as attempt:
        attempt.outcome = "json_mode_rejected"
    assert recorder.snapshot()["spans"][0]["attrs"]["outcome"] == "json_mode_rejected"


def test_an_open_span_has_no_end_and_ending_twice_changes_nothing():
    recorder, clock = make()
    open_id = recorder.start("graph")
    closed = recorder.start("node")
    clock.t += 7
    recorder.end(closed)
    clock.t += 100
    recorder.end(closed)  # ignored
    recorder.end(None)  # ignored (a dropped span)
    recorder.end(999)  # ignored (unknown)
    spans = {s["id"]: s for s in recorder.snapshot()["spans"]}
    assert spans[open_id]["end_ns"] is None
    assert spans[closed]["end_ns"] - spans[closed]["start_ns"] == 7


# ----------------------------------------------------------------------
# bounds and validation
# ----------------------------------------------------------------------
def test_detail_spans_are_dropped_first_and_counted_by_kind():
    recorder, _ = make(max_spans=10, reserved_structural=4)
    detail = [recorder.start("call.parse") for _ in range(8)]
    structural = [recorder.start("node") for _ in range(6)]
    snapshot = recorder.snapshot()
    assert sum(1 for item in detail if item is not None) == 6
    assert sum(1 for item in structural if item is not None) == 4
    assert len(snapshot["spans"]) == 10
    assert snapshot["dropped"] == {"call.parse": 2, "node": 2}


def test_attributes_are_typed_ids_without_free_text():
    recorder, _ = make()
    recorder.start(
        "call",
        role="coder",
        step_id=r"C:\Users\someone\secret",
        attempt=2,
        diagnostic=False,
        reason="the provider said no",
        unknown_key="dropped",
        tier=None,
    )
    attrs = recorder.snapshot()["spans"][0]["attrs"]
    assert attrs == {"role": "coder", "step_id": "invalid", "attempt": 2, "diagnostic": False, "reason": "invalid"}


def test_an_unknown_kind_is_counted_not_raised():
    recorder, _ = make()
    assert recorder.start("not_a_kind") is None
    assert recorder.add("also_not", 1, 2) is None
    snapshot = recorder.snapshot()
    assert snapshot["spans"] == [] and snapshot["instrumentation_errors"] == 2


def test_a_failing_clock_never_fails_the_caller():
    broken = {"now": False}

    def clock() -> int:
        if broken["now"]:
            raise OSError("clock failed")
        return 1

    recorder = SpanRecorder(clock=clock)
    opened = recorder.start("graph")
    broken["now"] = True
    # Every recording call swallows the failure and counts it.
    assert recorder.start("node") is None
    assert recorder.instant("dispatch") is None
    assert recorder.add("call", 1, 2) is None
    recorder.end(opened)
    recorder.aggregate("append_event.write", 10)
    with recorder.span("call") as handle:
        pass
    assert handle.id is None
    assert recorder.now() is None
    snapshot = recorder.snapshot()
    assert snapshot["instrumentation_errors"] >= 6
    assert [span["end_ns"] for span in snapshot["spans"]] == [None]  # the open span stays open


def test_a_clock_that_fails_at_construction_disables_the_recorder():
    def clock() -> int:
        raise OSError("no clock")

    recorder = SpanRecorder(clock=clock)
    assert recorder.enabled is False
    assert recorder.start("graph") is None


def test_a_failing_snapshot_returns_an_empty_snapshot_that_says_so(monkeypatch):
    recorder, _ = make()
    recorder.start("graph")

    def broken():
        raise RuntimeError("corrupt")

    monkeypatch.setattr(recorder, "_snapshot", broken)
    snapshot = recorder.snapshot()
    assert snapshot["snapshot_failed"] is True and snapshot["spans"] == []
    assert snapshot["instrumentation_errors"] == 1


def test_started_at_reads_a_span_start_and_tolerates_anything_else():
    recorder, clock = make(FakeClock(500))
    span = recorder.start("dispatch")
    assert recorder.started_at(span) == 500
    for value in (None, 999, "1", {"id": 1}, [1]):
        assert recorder.started_at(value) is None


def test_an_interval_without_two_readings_is_counted_not_recorded():
    recorder, _ = make()
    assert recorder.add("admission", None, 5) is None
    assert recorder.snapshot()["instrumentation_errors"] == 1


def test_a_disabled_recorder_records_nothing():
    recorder, _ = make(enabled=False)
    with recorder.span("graph") as handle:
        recorder.instant("dispatch")
        recorder.aggregate("append_event.write", 5)
    assert handle.id is None
    snapshot = recorder.snapshot()
    assert snapshot["enabled"] is False and snapshot["spans"] == [] and snapshot["aggregates"] == {}


def test_aggregates_count_sum_max_and_bucket():
    recorder, _ = make()
    for duration in (10_000, 50_000, 60_000, BUCKET_BOUNDS_NS[-1] + 1):
        recorder.aggregate("append_event.write", duration)
    aggregate = recorder.snapshot()["aggregates"]["append_event.write"]
    assert aggregate["count"] == 4
    assert aggregate["sum_ns"] == 10_000 + 50_000 + 60_000 + BUCKET_BOUNDS_NS[-1] + 1
    assert aggregate["max_ns"] == BUCKET_BOUNDS_NS[-1] + 1
    assert aggregate["buckets"][0] == 2  # <= 50 µs
    assert aggregate["buckets"][1] == 1  # <= 100 µs
    assert aggregate["buckets"][-1] == 1  # overflow
    assert sum(aggregate["buckets"]) == 4


def test_self_time_counts_only_time_inside_recording_calls():
    ticks = iter(range(0, 10_000, 10))
    recorder = SpanRecorder(clock=lambda: next(ticks))
    span = recorder.start("graph")  # 2 clock reads: 10 ns of self time
    recorder.end(span)  # 2 more: 10 ns
    assert recorder.snapshot()["self_ns"] == 20


# ----------------------------------------------------------------------
# context: one recorder per run, across tasks and threads
# ----------------------------------------------------------------------
def test_without_an_active_recorder_recording_is_a_no_op():
    assert current() is timings.DISABLED
    assert current().start("graph") is None


async def test_each_task_sees_only_its_own_runs_recorder():
    first, _ = make()
    second, _ = make()

    async def run(recorder: SpanRecorder) -> None:
        with activate(recorder):
            with current().span("graph"):
                await asyncio.sleep(0)
                current().instant("dispatch")

    await asyncio.gather(run(first), run(second))
    assert [s["kind"] for s in first.snapshot()["spans"]] == ["graph", "dispatch"]
    assert [s["kind"] for s in second.snapshot()["spans"]] == ["graph", "dispatch"]
    assert current() is timings.DISABLED


async def test_a_worker_thread_records_into_the_runs_recorder_under_the_current_span():
    recorder, _ = make()

    def in_thread() -> None:
        with current().span("verify.process"):
            pass

    with activate(recorder):
        with current().span("node", node="verify") as node:
            await asyncio.to_thread(in_thread)
    process = spans_by_kind(recorder.snapshot())["verify.process"][0]
    assert process["parent"] == node.id
