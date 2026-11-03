"""Per-operation cost of span recording (the M7.1 overhead benchmark).

``measure()`` times, on this machine and with the real clock, the median
cost over several rounds of: one span (start and end), one span through
the ``span()`` context manager, one aggregate update, and a span on a
disabled recorder. The test bounds are deliberately loose: they catch a
regression by an order of magnitude, they do not make a performance claim.
The whole-run comparison with recording on and off is the M7.2 A/B.
"""

from __future__ import annotations

import statistics
import time

from app.timings.recorder import SpanRecorder


def _per_operation_ns(operation, operations: int) -> float:
    started = time.perf_counter_ns()
    for _ in range(operations):
        operation()
    return (time.perf_counter_ns() - started) / operations


def _round(operations: int) -> dict[str, float]:
    """One round: ns per operation for each measured operation."""
    recorder = SpanRecorder(max_spans=operations + 1, reserved_structural=0)
    context_recorder = SpanRecorder(max_spans=operations + 1, reserved_structural=0)
    disabled = SpanRecorder(enabled=False)

    def span() -> None:
        recorder.end(recorder.start("call"))

    def span_context() -> None:
        with context_recorder.span("call"):
            pass

    def aggregate() -> None:
        recorder.aggregate("append_event.write", 1_000)

    def disabled_span() -> None:
        disabled.end(disabled.start("call"))

    return {
        "span": _per_operation_ns(span, operations),
        "span_context": _per_operation_ns(span_context, operations),
        "aggregate": _per_operation_ns(aggregate, operations),
        "disabled_span": _per_operation_ns(disabled_span, operations),
    }


def measure(operations: int = 20_000, rounds: int = 5) -> dict[str, float]:
    """Median ns per operation over ``rounds`` rounds of ``operations`` each."""
    rounds_measured = [_round(operations) for _ in range(rounds)]
    return {
        name: round(statistics.median(item[name] for item in rounds_measured), 1)
        for name in rounds_measured[0]
    }


def test_recording_costs_microseconds_per_operation_at_most():
    figures = measure(operations=5_000, rounds=3)
    assert figures["span"] < 50_000, figures
    assert figures["span_context"] < 50_000, figures
    assert figures["aggregate"] < 50_000, figures
    assert figures["disabled_span"] < 5_000, figures


def test_the_benchmark_records_what_it_measures():
    recorder = SpanRecorder(max_spans=10, reserved_structural=0)
    recorder.end(recorder.start("call"))
    snapshot = recorder.snapshot()
    assert len(snapshot["spans"]) == 1 and snapshot["spans"][0]["end_ns"] is not None
    assert snapshot["self_ns"] >= 0
