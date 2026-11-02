"""Metrics derived from one run's span snapshot.

Pure and total: any input, including a malformed or incomplete snapshot,
gives a result and never raises. A metric the snapshot does not establish
is None with a reason in ``reasons``. Durations are milliseconds, computed
only from monotonic span offsets.

Time is attributed, never obtained by subtracting independent totals:

* the **self time** of a span is its duration minus the length of the
  union of its direct children's intervals (clipped to the span), so
  overlapping children count once;
* coder time is reported three ways: **busy** (sum of step durations,
  overlaps counted), **wall** (length of the union of step intervals) and
  **critical path** (for each dispatch, from the dispatch instant to the end
  of its last-finishing step, summed over dispatches);
* **critical orchestration** is the self time of the graph, of every node
  that is not a coding step, and of the last-finishing coding step of each
  dispatch; the self time of the other coding steps is **parallel
  orchestration**, reported apart and never added to the path.

Node self time includes the node's event validation and persistence, which
are also reported on their own (``event_persist_*``) from the per-run
aggregates.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from app.timings.recorder import KINDS, STRUCTURAL_KINDS

PHASES = ("lifecycle", "admission", "execution", "setup", "graph", "finalization")
NEVER_STARTED = "never_started"


@dataclass(frozen=True)
class _Span:
    id: int
    kind: str
    parent: int | None
    start: int
    end: int | None
    attrs: Mapping[str, Any]

    @property
    def duration(self) -> int | None:
        return None if self.end is None else self.end - self.start


@dataclass
class Derived:
    values: dict[str, float | int | None] = field(default_factory=dict)
    reasons: dict[str, str] = field(default_factory=dict)
    calls: list[dict[str, Any]] = field(default_factory=list)
    steps: list[dict[str, Any]] = field(default_factory=list)


def ms(ns: int | None) -> float | None:
    return None if ns is None else round(ns / 1_000_000, 3)


def union_ns(intervals: Iterable[tuple[int, int]]) -> int:
    """Total length covered by the intervals, overlaps counted once."""
    total = 0
    current_start = current_end = None
    for start, end in sorted((a, b) for a, b in intervals if b > a):
        if current_end is None or start > current_end:
            if current_end is not None:
                total += current_end - current_start
            current_start, current_end = start, end
        else:
            current_end = max(current_end, end)
    if current_end is not None:
        total += current_end - current_start
    return total


def derive(snapshot: Any) -> Derived:
    try:
        return _derive(snapshot)
    except Exception:  # noqa: BLE001 - derivation never fails its caller
        return Derived(reasons={"*": "the measurements could not be derived"})


# ----------------------------------------------------------------------
def _parse(snapshot: Mapping[str, Any]) -> tuple[list[_Span], int]:
    spans: list[_Span] = []
    seen: set[int] = set()
    malformed = 0
    for item in snapshot.get("spans") or []:
        try:
            span_id, kind = item["id"], item["kind"]
            start, end = item["start_ns"], item["end_ns"]
            parent = item.get("parent")
            attrs = item.get("attrs") or {}
            valid = (
                isinstance(span_id, int)
                and span_id not in seen
                and kind in KINDS
                and isinstance(start, int)
                and (end is None or (isinstance(end, int) and end >= start))
                and (parent is None or isinstance(parent, int))
                and isinstance(attrs, Mapping)
            )
        except (KeyError, TypeError):
            valid = False
        if not valid:
            malformed += 1
            continue
        seen.add(span_id)
        spans.append(_Span(span_id, kind, parent, start, end, dict(attrs)))
    return spans, malformed


def _derive(snapshot: Any) -> Derived:
    result = Derived()
    values, reasons = result.values, result.reasons
    if not isinstance(snapshot, Mapping):
        reasons["*"] = "no measurements"
        return result
    if snapshot.get("enabled") is False:
        reasons["*"] = "recording was disabled"
        return result

    spans, malformed = _parse(snapshot)
    dropped = {k: v for k, v in (snapshot.get("dropped") or {}).items() if isinstance(v, int)}
    dropped_detail = sum(v for k, v in dropped.items() if k not in STRUCTURAL_KINDS)
    dropped_structural = sum(v for k, v in dropped.items() if k in STRUCTURAL_KINDS)
    values["dropped_spans"] = sum(dropped.values())
    values["malformed_spans"] = malformed
    values["instrumentation_errors"] = snapshot.get("instrumentation_errors") if isinstance(snapshot.get("instrumentation_errors"), int) else None
    self_ns = snapshot.get("self_ns")
    values["measurement_self_ms"] = ms(self_ns) if isinstance(self_ns, int) else None

    by_kind: dict[str, list[_Span]] = {}
    children: dict[int, list[_Span]] = {}
    for span in spans:
        by_kind.setdefault(span.kind, []).append(span)
        if span.parent is not None:
            children.setdefault(span.parent, []).append(span)

    def unknown(name: str, reason: str) -> None:
        values[name] = None
        reasons[name] = reason

    detail_reason = "spans dropped" if dropped_detail else ("malformed spans" if malformed else None)
    structural_reason = "spans dropped" if dropped_structural else ("malformed spans" if malformed else None)

    # ---- run phases -------------------------------------------------
    lifecycle = by_kind.get("lifecycle", [])
    never_started = any(span.attrs.get("reason") == NEVER_STARTED for span in lifecycle)
    for name in PHASES:
        matches = by_kind.get(name, [])
        if len(matches) > 1:
            unknown(f"{name}_ms", "several spans of one phase")
        elif not matches:
            if never_started and name in ("execution", "setup", "graph"):
                unknown(f"{name}_ms", "never started")
            else:
                unknown(f"{name}_ms", structural_reason or "not recorded")
        elif matches[0].end is None:
            unknown(f"{name}_ms", "incomplete")
        else:
            values[f"{name}_ms"] = ms(matches[0].duration)

    # ---- nodes ------------------------------------------------------
    nodes = by_kind.get("node", [])

    def node_total(node: str, metric: str, none_reason: str) -> None:
        matches = [span for span in nodes if span.attrs.get("node") == node]
        if not matches:
            unknown(metric, structural_reason or none_reason)
        elif any(span.end is None for span in matches):
            unknown(metric, "incomplete")
        else:
            values[metric] = ms(sum(span.duration for span in matches))

    node_total("planner", "planner_ms", "no planner node ran")
    node_total("review", "reviewer_ms", "no review ran")

    # ---- coding steps -----------------------------------------------
    dispatches = {span.id: span for span in by_kind.get("dispatch", [])}
    steps = [span for span in nodes if span.attrs.get("node") == "code_step"]
    for step in steps:
        kids = children.get(step.id, [])
        result.steps.append(
            {
                "step_id": step.attrs.get("step_id"),
                "dispatch_id": step.attrs.get("dispatch_id"),
                "attempt": step.attrs.get("attempt"),
                "start_ms": ms(step.start),
                "duration_ms": ms(step.duration),
                "schedule_delay_ms": _sum_ms(kids, "step.schedule_delay"),
                "slot_wait_ms": _sum_ms(kids, "call.slot_wait"),
                "checkout_ms": _sum_ms(kids, "step.checkout"),
            }
        )
    if not steps:
        for metric in ("coder_busy_ms", "coder_wall_ms", "coder_critical_path_ms"):
            unknown(metric, structural_reason or "no step ran")
    elif any(step.end is None for step in steps):
        for metric in ("coder_busy_ms", "coder_wall_ms", "coder_critical_path_ms"):
            unknown(metric, "incomplete")
    else:
        values["coder_busy_ms"] = ms(sum(step.duration for step in steps))
        values["coder_wall_ms"] = ms(union_ns((step.start, step.end) for step in steps))
        groups: dict[int, list[_Span]] = {}
        for step in steps:
            dispatch_id = step.attrs.get("dispatch_id")
            if isinstance(dispatch_id, int) and dispatch_id in dispatches:
                groups.setdefault(dispatch_id, []).append(step)
        if sum(len(group) for group in groups.values()) != len(steps):
            unknown("coder_critical_path_ms", "dispatch not recorded")
        else:
            values["coder_critical_path_ms"] = ms(
                sum(max(step.end for step in group) - dispatches[key].start for key, group in groups.items())
            )

    # ---- calls ------------------------------------------------------
    calls = by_kind.get("call", [])
    parses = by_kind.get("call.parse", [])
    for call in calls:
        attempts = [kid for kid in children.get(call.id, []) if kid.kind == "call.http_attempt"]
        key = (call.parent, call.attrs.get("role"), call.attrs.get("step_id"), call.attrs.get("attempt"))
        parsed = [p for p in parses if (p.parent, p.attrs.get("role"), p.attrs.get("step_id"), p.attrs.get("attempt")) == key]
        result.calls.append(
            {
                "role": call.attrs.get("role"),
                "step_id": call.attrs.get("step_id"),
                "attempt": call.attrs.get("attempt"),
                "outcome": call.attrs.get("outcome"),
                "call_ms": ms(call.duration),
                "http_attempts": len(attempts),
                "http_attempt_ms": [ms(a.duration) for a in sorted(attempts, key=lambda a: a.start)],
                "http_outcomes": [a.attrs.get("outcome") for a in sorted(attempts, key=lambda a: a.start)],
                "parse_ms": ms(sum(p.duration for p in parsed if p.end is not None)) if parsed else None,
            }
        )
    detail_metrics = {
        "call_ms": ("call", "no call"),
        "parse_ms": ("call.parse", "no response parsed"),
        "backoff_ms": ("call.backoff", "no backoff"),
        "ledger_wait_ms": ("call.ledger_wait", "no call"),
        "schedule_delay_ms": ("step.schedule_delay", "no dispatch"),
        "verify_thread_wait_ms": ("verify.thread_wait", "no verification ran"),
    }
    for metric, (kind, none_reason) in detail_metrics.items():
        found = by_kind.get(kind, [])
        if detail_reason:
            unknown(metric, detail_reason)
        elif any(span.end is None for span in found):
            unknown(metric, "incomplete")
        elif not found and kind in ("call", "call.parse", "step.schedule_delay", "verify.thread_wait", "call.ledger_wait"):
            unknown(metric, none_reason)
        else:
            values[metric] = ms(sum(span.duration for span in found))
    if detail_reason:
        unknown("http_attempts", detail_reason)
    elif not calls:
        unknown("http_attempts", "no call")
    else:
        values["http_attempts"] = len(by_kind.get("call.http_attempt", []))

    graphs = by_kind.get("graph", [])
    parallel_coding = bool(graphs) and graphs[0].attrs.get("parallel_coding") is True
    if parallel_coding:
        unknown("slot_wait_ms", "parallel coding: no coding slot")
    elif detail_reason:
        unknown("slot_wait_ms", detail_reason)
    elif not steps:
        unknown("slot_wait_ms", "no step ran")
    else:
        waits = by_kind.get("call.slot_wait", [])
        if any(span.end is None for span in waits):
            unknown("slot_wait_ms", "incomplete")
        else:
            values["slot_wait_ms"] = ms(sum(span.duration for span in waits))

    # ---- verification -----------------------------------------------
    for diagnostic, metric in ((False, "verification_ms"), (True, "diagnostic_verification_ms")):
        runs = [span for span in by_kind.get("verify.run", []) if span.attrs.get("diagnostic") is diagnostic]
        processes = [kid for run in runs for kid in children.get(run.id, []) if kid.kind == "verify.process"]
        if detail_reason:
            unknown(metric, detail_reason)
        elif not processes:
            unknown(metric, "no verification ran" if not diagnostic else "no diagnostic verification ran")
        elif any(span.end is None for span in processes):
            unknown(metric, "incomplete")
        else:
            values[metric] = ms(sum(span.duration for span in processes))

    # ---- attributed orchestration time -------------------------------
    def self_ns(span: _Span) -> int | None:
        if span.end is None:
            return None
        clipped = [
            (max(kid.start, span.start), min(kid.end, span.end))
            for kid in children.get(span.id, [])
            if kid.end is not None
        ]
        return span.duration - union_ns(clipped)

    orchestration_reason = structural_reason or detail_reason
    if orchestration_reason:
        for metric in ("graph_gap_ms", "critical_orchestration_ms", "parallel_orchestration_ms"):
            unknown(metric, orchestration_reason)
    elif len(graphs) != 1 or graphs[0].end is None or any(node.end is None for node in nodes):
        for metric in ("graph_gap_ms", "critical_orchestration_ms", "parallel_orchestration_ms"):
            unknown(metric, "incomplete" if graphs else "not recorded")
    else:
        node_self: dict[str, float] = {}
        for node in nodes:
            name = str(node.attrs.get("node", "unknown"))
            node_self[name] = node_self.get(name, 0) + self_ns(node)
        critical_steps: set[int] = set()
        by_dispatch: dict[Any, list[_Span]] = {}
        for step in steps:
            by_dispatch.setdefault(step.attrs.get("dispatch_id"), []).append(step)
        for group in by_dispatch.values():
            critical_steps.add(max(group, key=lambda s: s.end).id)
        graph_gap = self_ns(graphs[0])
        critical = graph_gap + sum(
            self_ns(node) for node in nodes if node.attrs.get("node") != "code_step" or node.id in critical_steps
        )
        parallel = sum(self_ns(node) for node in steps if node.id not in critical_steps)
        values["graph_gap_ms"] = ms(graph_gap)
        values["critical_orchestration_ms"] = ms(critical)
        values["parallel_orchestration_ms"] = ms(parallel)
        for name, total in node_self.items():
            values[f"node_self_ms.{name}"] = ms(int(total))

    # ---- persistence aggregates --------------------------------------
    aggregates = snapshot.get("aggregates") or {}
    for name in ("append_event.lock_wait", "append_event.write", "save_run.lock_wait", "save_run.write"):
        item = aggregates.get(name) if isinstance(aggregates, Mapping) else None
        metric = name.replace("append_event", "event_persist").replace(".", "_") + "_ms"
        if isinstance(item, Mapping) and isinstance(item.get("sum_ns"), int):
            values[metric] = ms(item["sum_ns"])
            values[metric.replace("_ms", "_count")] = item.get("count")
        else:
            unknown(metric, "not recorded")
    return result


def _sum_ms(spans: list[_Span], kind: str) -> float | None:
    found = [span for span in spans if span.kind == kind]
    if not found or any(span.end is None for span in found):
        return None
    return ms(sum(span.duration for span in found))
