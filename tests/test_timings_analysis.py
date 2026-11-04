"""Derived timing metrics (app.timings.analysis): phases, self time over the
union of children, coder busy/wall/critical path, calls and HTTP attempts,
verification, and the null-with-reason rules for incomplete, dropped and
malformed measurements. Times are hand-checkable ns on a zero-based clock."""

from __future__ import annotations

import pytest

from app.timings.analysis import derive, union_ns
from app.timings.recorder import SpanRecorder


def recorder(**kwargs) -> SpanRecorder:
    return SpanRecorder(clock=lambda: 0, zero=0, **kwargs)


MS = 1_000_000  # ns per ms


# ----------------------------------------------------------------------
# union
# ----------------------------------------------------------------------
@pytest.mark.parametrize(
    "intervals, expected",
    [
        ([], 0),
        ([(0, 10)], 10),
        ([(0, 10), (20, 30)], 20),  # disjoint
        ([(0, 10), (5, 15)], 15),  # overlapping
        ([(0, 30), (5, 10), (12, 20)], 30),  # nested
        ([(0, 10), (10, 20)], 20),  # touching
        ([(5, 5), (0, 1)], 1),  # zero-length ignored
    ],
)
def test_union_counts_overlaps_once(intervals, expected):
    assert union_ns(intervals) == expected


# ----------------------------------------------------------------------
# phases
# ----------------------------------------------------------------------
def test_run_phases_are_each_one_interval():
    r = recorder()
    life = r.add("lifecycle", 0, 1000 * MS, parent=None)
    r.add("admission", 0, 100 * MS, parent=life)
    execution = r.add("execution", 100 * MS, 900 * MS, parent=life)
    r.add("setup", 100 * MS, 200 * MS, parent=execution)
    r.add("graph", 200 * MS, 850 * MS, parent=execution)
    r.add("finalization", 900 * MS, 1000 * MS, parent=life)
    values = derive(r.snapshot()).values
    assert values["lifecycle_ms"] == 1000
    assert values["admission_ms"] == 100
    assert values["execution_ms"] == 800
    assert values["setup_ms"] == 100
    assert values["graph_ms"] == 650
    assert values["finalization_ms"] == 100


def test_a_run_cancelled_before_it_started_has_no_execution():
    r = recorder()
    life = r.add("lifecycle", 0, 30 * MS, parent=None, outcome="cancelled", reason="never_started")
    r.add("admission", 0, 30 * MS, parent=life)
    derived = derive(r.snapshot())
    assert derived.values["lifecycle_ms"] == 30 and derived.values["admission_ms"] == 30
    for phase in ("execution_ms", "setup_ms", "graph_ms"):
        assert derived.values[phase] is None
        assert derived.reasons[phase] == "never started"
    assert derived.reasons["finalization_ms"] == "not recorded"


def test_an_open_phase_is_incomplete_not_zero():
    r = recorder()
    r.start("lifecycle", parent=None, at=0)
    derived = derive(r.snapshot())
    assert derived.values["lifecycle_ms"] is None and derived.reasons["lifecycle_ms"] == "incomplete"


# ----------------------------------------------------------------------
# a parallel wave
# ----------------------------------------------------------------------
def parallel_wave() -> SpanRecorder:
    """graph 0-1000; dispatch at 100; steps A 120-520 and B 130-830 (B ends
    last); advance 840-900; review 900-950. A has two overlapping calls."""
    r = recorder()
    graph = r.add("graph", 0, 1000 * MS, parent=None, parallel_coding=True)
    dispatch = r.add("dispatch", 100 * MS, 100 * MS, parent=graph)
    step_a = r.add("node", 120 * MS, 520 * MS, parent=graph, node="code_step", step_id="a", dispatch_id=dispatch)
    step_b = r.add("node", 130 * MS, 830 * MS, parent=graph, node="code_step", step_id="b", dispatch_id=dispatch)
    r.add("step.schedule_delay", 100 * MS, 120 * MS, parent=step_a)
    r.add("step.schedule_delay", 100 * MS, 130 * MS, parent=step_b)
    r.add("call", 150 * MS, 450 * MS, parent=step_a, role="coder", step_id="a", attempt=1)
    r.add("call", 300 * MS, 500 * MS, parent=step_a, role="coder", step_id="a", attempt=2)
    r.add("call", 160 * MS, 800 * MS, parent=step_b, role="coder", step_id="b", attempt=1)
    r.add("node", 840 * MS, 900 * MS, parent=graph, node="advance")
    r.add("node", 900 * MS, 950 * MS, parent=graph, node="review")
    return r


def test_coder_busy_wall_and_critical_path_differ_in_a_parallel_wave():
    values = derive(parallel_wave().snapshot()).values
    assert values["coder_busy_ms"] == 400 + 700  # overlaps counted
    assert values["coder_wall_ms"] == 830 - 120  # union of the two steps
    assert values["coder_critical_path_ms"] == 830 - 100  # dispatch to last step end
    assert values["schedule_delay_ms"] == 20 + 30


def test_self_time_uses_the_union_of_overlapping_children():
    values = derive(parallel_wave().snapshot()).values
    # step A: 400 long, calls cover 150-500 (union 350): self 50
    # step B: 700 long, call covers 640: self 60
    # graph: 1000 minus union of its children (120-830, 840-950 and a
    # zero-length dispatch) = 1000 - 820 = 180
    assert values["graph_gap_ms"] == 180
    assert values["node_self_ms.code_step"] == 50 + 60
    # B ends last, so it is on the critical path; A's self time is parallel.
    assert values["critical_orchestration_ms"] == 180 + 60 + 60 + 50  # gap, advance, review, B
    assert values["parallel_orchestration_ms"] == 50
    assert values["node_self_ms.advance"] == 60 and values["node_self_ms.review"] == 50


def test_slot_wait_is_not_applicable_in_parallel_mode():
    derived = derive(parallel_wave().snapshot())
    assert derived.values["slot_wait_ms"] is None
    assert derived.reasons["slot_wait_ms"] == "parallel coding: no coding slot"


def test_sequential_mode_reports_slot_waits():
    r = recorder()
    graph = r.add("graph", 0, 500 * MS, parent=None, parallel_coding=False)
    dispatch = r.add("dispatch", 10 * MS, 10 * MS, parent=graph)
    first = r.add("node", 20 * MS, 220 * MS, parent=graph, node="code_step", dispatch_id=dispatch)
    second = r.add("node", 20 * MS, 420 * MS, parent=graph, node="code_step", dispatch_id=dispatch)
    r.add("call.slot_wait", 20 * MS, 21 * MS, parent=first)
    r.add("call.slot_wait", 20 * MS, 220 * MS, parent=second)  # waited for the first step
    values = derive(r.snapshot()).values
    assert values["slot_wait_ms"] == 1 + 200
    assert values["coder_busy_ms"] == 200 + 400
    assert values["coder_wall_ms"] == 400
    assert values["coder_critical_path_ms"] == 410


def test_a_step_without_its_dispatch_has_no_critical_path():
    r = recorder()
    graph = r.add("graph", 0, 100 * MS, parent=None)
    r.add("node", 10 * MS, 50 * MS, parent=graph, node="code_step")
    derived = derive(r.snapshot())
    assert derived.values["coder_busy_ms"] == 40
    assert derived.reasons["coder_critical_path_ms"] == "dispatch not recorded"


# ----------------------------------------------------------------------
# calls, HTTP attempts, parsing
# ----------------------------------------------------------------------
def test_http_attempts_parse_and_backoff_are_separate():
    r = recorder()
    node = r.add("node", 0, 1000 * MS, parent=None, node="review")
    r.add("call.ledger_wait", 0, 2 * MS, parent=node, role="reviewer", attempt=1)
    call = r.add("call", 2 * MS, 702 * MS, parent=node, role="reviewer", attempt=1, outcome="ok")
    r.add("call.http_attempt", 3 * MS, 103 * MS, parent=call, outcome="json_mode_rejected")
    r.add("call.http_attempt", 104 * MS, 700 * MS, parent=call, outcome="ok")
    r.add("call.parse", 702 * MS, 705 * MS, parent=node, role="reviewer", attempt=1)
    r.add("call.backoff", 705 * MS, 905 * MS, parent=node, role="reviewer", attempt=1)
    derived = derive(r.snapshot())
    assert derived.values["call_ms"] == 700
    assert derived.values["http_attempts"] == 2
    assert derived.values["parse_ms"] == 3
    assert derived.values["backoff_ms"] == 200
    assert derived.values["ledger_wait_ms"] == 2
    [call_info] = derived.calls
    assert call_info["http_attempts"] == 2
    assert call_info["http_attempt_ms"] == [100, 596]
    assert call_info["http_outcomes"] == ["json_mode_rejected", "ok"]
    assert call_info["parse_ms"] == 3


def test_a_scripted_call_has_zero_http_attempts_not_unknown():
    r = recorder()
    node = r.add("node", 0, 10 * MS, parent=None, node="review")
    r.add("call", 1 * MS, 2 * MS, parent=node, role="reviewer", attempt=1, outcome="ok")
    derived = derive(r.snapshot())
    assert derived.values["http_attempts"] == 0
    assert derived.calls[0]["http_attempts"] == 0
    assert derived.values["backoff_ms"] == 0  # measured: no backoff happened


def test_a_failed_provider_call_keeps_its_duration_and_outcome():
    r = recorder()
    node = r.add("node", 0, 100 * MS, parent=None, node="planner")
    call = r.add("call", 1 * MS, 91 * MS, parent=node, role="planner", attempt=1, outcome="timeout")
    r.add("call.http_attempt", 1 * MS, 91 * MS, parent=call, outcome="timeout")
    derived = derive(r.snapshot())
    assert derived.calls[0]["outcome"] == "timeout" and derived.calls[0]["call_ms"] == 90
    assert derived.values["parse_ms"] is None and derived.reasons["parse_ms"] == "no response parsed"


def test_no_call_means_unknown_call_metrics():
    derived = derive(recorder().snapshot())
    assert derived.reasons["call_ms"] == "no call"
    assert derived.reasons["http_attempts"] == "no call"
    for metric in ("call_wall_ms", "http_attempt_ms", "http_attempt_wall_ms"):
        assert derived.values[metric] is None and derived.reasons[metric] == "no call"
    assert derived.values["provider_calls"] == 0  # counted: no call was made


def test_overlapping_calls_in_a_parallel_wave_count_once_in_wall_time():
    values = derive(parallel_wave().snapshot()).values
    # A1 150-450, A2 300-500, B1 160-800.
    assert values["provider_calls"] == 3
    assert values["call_ms"] == 300 + 200 + 640  # busy: 1140, overlaps counted
    assert values["call_wall_ms"] == 800 - 150  # union: one interval, 650
    # Scripted calls: no HTTP attempt, measured as zero.
    assert values["http_attempt_ms"] == 0 and values["http_attempt_wall_ms"] == 0


def overlapping_attempts() -> SpanRecorder:
    """call X 10-110 (attempts 11-50, 55-110); call Y 60-210 (attempt 70-200)."""
    r = recorder()
    node = r.add("node", 0, 1000 * MS, parent=None, node="code_step")
    x = r.add("call", 10 * MS, 110 * MS, parent=node, role="coder", attempt=1)
    y = r.add("call", 60 * MS, 210 * MS, parent=node, role="coder", attempt=1)
    r.add("call.http_attempt", 11 * MS, 50 * MS, parent=x, outcome="server_error")
    r.add("call.http_attempt", 55 * MS, 110 * MS, parent=x, outcome="ok")
    r.add("call.http_attempt", 70 * MS, 200 * MS, parent=y, outcome="ok")
    return r


def test_http_attempt_busy_and_wall_time_are_hand_checkable():
    values = derive(overlapping_attempts().snapshot()).values
    assert values["provider_calls"] == 2 and values["http_attempts"] == 3
    assert values["call_ms"] == 100 + 150
    assert values["call_wall_ms"] == 210 - 10
    assert values["http_attempt_ms"] == 39 + 55 + 130  # busy: 224
    # union: 11-50 (39), then 55-110 and 70-200 merge into 55-200 (145)
    assert values["http_attempt_wall_ms"] == 39 + 145


def test_an_open_call_or_attempt_makes_wall_and_busy_time_incomplete():
    r = recorder()
    node = r.add("node", 0, 100 * MS, parent=None, node="review")
    call = r.add("call", 1 * MS, 50 * MS, parent=node, role="reviewer", attempt=1)
    r.start("call.http_attempt", parent=call, at=2 * MS)
    r.start("call", parent=node, at=60 * MS, role="reviewer", attempt=2)
    derived = derive(r.snapshot())
    for metric in ("call_wall_ms", "http_attempt_ms", "http_attempt_wall_ms"):
        assert derived.values[metric] is None and derived.reasons[metric] == "incomplete"
    assert derived.values["provider_calls"] == 2


# ----------------------------------------------------------------------
# verification
# ----------------------------------------------------------------------
def test_gating_and_diagnostic_verification_are_kept_apart():
    r = recorder()
    node = r.add("node", 0, 1000 * MS, parent=None, node="verify")
    gating = r.add("verify.run", 10 * MS, 400 * MS, parent=node, diagnostic=False)
    r.add("verify.process", 20 * MS, 390 * MS, parent=gating)
    r.add("verify.thread_wait", 5 * MS, 10 * MS, parent=node)
    diagnostic = r.add("verify.run", 500 * MS, 700 * MS, parent=node, diagnostic=True)
    r.add("verify.process", 510 * MS, 690 * MS, parent=diagnostic)
    values = derive(r.snapshot()).values
    assert values["verification_ms"] == 370
    assert values["diagnostic_verification_ms"] == 180
    assert values["verify_thread_wait_ms"] == 5


# ----------------------------------------------------------------------
# incomplete, dropped, malformed, disabled
# ----------------------------------------------------------------------
def test_a_cancelled_run_with_open_spans_reports_incomplete_not_zero():
    r = recorder()
    graph = r.start("graph", parent=None, at=0)
    r.start("node", parent=graph, at=10 * MS, node="code_step")
    derived = derive(r.snapshot())
    assert derived.values["graph_ms"] is None and derived.reasons["graph_ms"] == "incomplete"
    assert derived.reasons["coder_busy_ms"] == "incomplete"
    assert derived.values["critical_orchestration_ms"] is None


def test_dropped_detail_spans_null_the_detail_metrics_but_not_the_phases():
    r = recorder(max_spans=4, reserved_structural=2)
    graph = r.add("graph", 0, 100 * MS, parent=None)
    for start in range(5):
        r.add("call", start, start + 1, parent=graph, role="coder", attempt=1)
    derived = derive(r.snapshot())
    assert derived.values["dropped_spans"] == 4
    assert derived.values["graph_ms"] == 100
    for metric in (
        "call_ms",
        "http_attempts",
        "provider_calls",
        "call_wall_ms",
        "http_attempt_ms",
        "http_attempt_wall_ms",
        "verification_ms",
        "critical_orchestration_ms",
    ):
        assert derived.values[metric] is None and derived.reasons[metric] == "spans dropped"


def test_malformed_spans_are_skipped_and_counted():
    snapshot = {
        "enabled": True,
        "spans": [
            {"id": 1, "kind": "graph", "parent": None, "start_ns": 0, "end_ns": 10 * MS, "attrs": {}},
            {"id": 1, "kind": "node", "parent": None, "start_ns": 0, "end_ns": 1, "attrs": {}},  # duplicate id
            {"id": 2, "kind": "graph", "parent": None, "start_ns": 5, "end_ns": 1, "attrs": {}},  # ends before start
            {"id": 3, "kind": "nonsense", "parent": None, "start_ns": 0, "end_ns": 1, "attrs": {}},
            {"id": 4, "kind": "node", "start_ns": "0", "end_ns": 1, "attrs": {}},  # wrong type
            {"kind": "node"},  # missing fields
            None,
        ],
        "dropped": {},
        "aggregates": {},
    }
    derived = derive(snapshot)
    assert derived.values["malformed_spans"] == 6
    assert derived.values["graph_ms"] == 10
    assert derived.reasons["critical_orchestration_ms"] == "malformed spans"


@pytest.mark.parametrize(
    "snapshot",
    [None, 42, "spans", [], {"spans": "not a list"}, {"spans": [1, 2]}, {"dropped": "x"}, {"aggregates": 7}],
)
def test_derivation_never_raises(snapshot):
    derived = derive(snapshot)
    assert isinstance(derived.values, dict) and isinstance(derived.reasons, dict)


def test_a_disabled_snapshot_establishes_nothing():
    derived = derive(SpanRecorder(enabled=False).snapshot())
    assert derived.values == {} and derived.reasons == {"*": "recording was disabled"}


def test_persistence_aggregates_become_totals_and_counts():
    r = recorder()
    r.aggregate("append_event.write", 3 * MS)
    r.aggregate("append_event.write", 1 * MS)
    r.aggregate("append_event.lock_wait", 0)
    derived = derive(r.snapshot())
    assert derived.values["event_persist_write_ms"] == 4
    assert derived.values["event_persist_write_count"] == 2
    assert derived.values["event_persist_lock_wait_ms"] == 0
    assert derived.reasons["save_run_write_ms"] == "not recorded"
