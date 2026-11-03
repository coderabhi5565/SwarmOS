"""The bounded measurement row (app.timings.serialize): compact JSON under the
cap, truncation in a fixed order with every removed span counted, the last
resort, disabled recorders as markers, and failures raised to the caller."""

from __future__ import annotations

import json

import pytest

from app.timings.analysis import derive
from app.timings.recorder import SpanRecorder
from app.timings.serialize import DROP_ORDER, MAX_ROW_BYTES, MeasurementTooLarge, measurement_row

MS = 1_000_000


def sample(http_attempts: int = 0) -> SpanRecorder:
    """A small run: lifecycle and graph, one node with one call and its HTTP attempts."""
    r = SpanRecorder(clock=lambda: 0, zero=0, max_spans=100_000, reserved_structural=0)
    life = r.add("lifecycle", 0, 100 * MS, parent=None, outcome="completed")
    execution = r.add("execution", 0, 90 * MS, parent=life)
    graph = r.add("graph", 1 * MS, 90 * MS, parent=execution)
    node = r.add("node", 2 * MS, 80 * MS, parent=graph, node="review")
    call = r.add("call", 3 * MS, 70 * MS, parent=node, role="reviewer", attempt=1, outcome="ok")
    for i in range(http_attempts):
        r.add("call.http_attempt", 3 * MS + i, 3 * MS + i + 1, parent=call, outcome="ok")
    r.add("call.parse", 70 * MS, 71 * MS, parent=node, role="reviewer", attempt=1)
    r.aggregate("append_event.write", 1000)
    return r


def test_a_small_snapshot_is_stored_whole():
    snapshot = sample().snapshot()
    row = measurement_row("run_a", snapshot)
    assert (row.run_id, row.status, row.measurements_version) == ("run_a", "recorded", 1)
    assert row.collected_at == snapshot["anchor_utc"]
    stored = json.loads(row.measurements_json)
    assert stored["truncated"] is False
    assert stored["spans"] == snapshot["spans"] and stored["aggregates"] == snapshot["aggregates"]
    assert " " not in row.measurements_json.replace("anchor_utc", "")[:50]  # compact separators
    assert len(row.measurements_json.encode()) <= MAX_ROW_BYTES


def test_an_oversized_snapshot_drops_fine_spans_first_and_counts_them():
    snapshot = sample(http_attempts=3000).snapshot()
    full = len(json.dumps(snapshot, separators=(",", ":")).encode())
    limit = full // 4  # far too small for 3000 HTTP attempts, enough without them
    row = measurement_row("run_b", snapshot, max_bytes=limit)
    stored = json.loads(row.measurements_json)
    assert len(row.measurements_json.encode()) <= limit
    assert stored["truncated"] is True
    assert stored["dropped"] == {"call.http_attempt": 3000}
    kinds = {span["kind"] for span in stored["spans"]}
    assert "call.http_attempt" not in kinds
    assert {"lifecycle", "execution", "graph", "node", "call", "call.parse"} <= kinds
    derived = derive(stored)
    assert derived.values["lifecycle_ms"] == 100 and derived.values["graph_ms"] == 89
    assert derived.values["http_attempts"] is None and derived.reasons["http_attempts"] == "spans dropped"


def test_truncation_follows_the_fixed_order():
    assert DROP_ORDER[0] == "call.http_attempt" and DROP_ORDER[-1] == "call"
    assert "node" not in DROP_ORDER and "lifecycle" not in DROP_ORDER  # structural last
    snapshot = sample(http_attempts=10).snapshot()
    small = len(json.dumps({**snapshot, "spans": [], "truncated": True}, separators=(",", ":")).encode()) + 600
    stored = json.loads(measurement_row("run_c", snapshot, max_bytes=small).measurements_json)
    assert stored["dropped"]["call.http_attempt"] == 10
    assert set(stored["dropped"]) <= set(DROP_ORDER) | {"lifecycle", "execution", "graph", "node"}


def test_the_last_resort_keeps_no_spans_but_counts_them_all():
    snapshot = sample(http_attempts=5).snapshot()
    every_kind: dict[str, int] = {}
    for span in snapshot["spans"]:
        every_kind[span["kind"]] = every_kind.get(span["kind"], 0) + 1
    bare = {**snapshot, "spans": [], "dropped": every_kind, "truncated": True}
    limit = len(json.dumps(bare, separators=(",", ":")).encode())  # exactly the span-less row
    stored = json.loads(measurement_row("run_d", snapshot, max_bytes=limit).measurements_json)
    assert stored["spans"] == [] and stored["truncated"] is True
    assert sum(stored["dropped"].values()) == len(snapshot["spans"])
    assert stored["aggregates"] == snapshot["aggregates"]


def test_a_row_that_cannot_fit_at_all_is_refused():
    with pytest.raises(MeasurementTooLarge):
        measurement_row("run_e", sample().snapshot(), max_bytes=50)


def test_an_unserializable_snapshot_is_refused():
    snapshot = sample().snapshot()
    snapshot["self_ns"] = float("nan")
    with pytest.raises(ValueError):
        measurement_row("run_f", snapshot)
    snapshot["self_ns"] = object()
    with pytest.raises(TypeError):
        measurement_row("run_f", snapshot)


def test_a_disabled_recorder_gives_a_disabled_marker():
    row = measurement_row("run_g", SpanRecorder(enabled=False).snapshot())
    assert (row.status, row.measurements_json, row.measurements_version) == ("disabled", None, None)
    assert row.collected_at


def test_the_snapshot_is_not_modified():
    snapshot = sample(http_attempts=200).snapshot()
    before = json.dumps(snapshot, sort_keys=True)
    measurement_row("run_h", snapshot, max_bytes=2_000)
    assert json.dumps(snapshot, sort_keys=True) == before
