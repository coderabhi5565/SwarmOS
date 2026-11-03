"""The API view of a run's measurements (``GET /api/runs/{id}/measurements``).

A stored row is revalidated on every read, never trusted: spans of unknown
kind or with malformed fields are left out, attributes are checked again
against the recorder's rules (fixed keys; booleans, integers and id-like
strings, anything else ``invalid``), and only known aggregate names are
kept. In the public demo every string is also passed through the public
redactor. Metrics come only from the stored spans (app.timings.analysis):
when a run has no row nothing is derived, in particular nothing from
wall-clock event timestamps.

Why a run has no measurements (``reason``):

* ``run_in_progress``: not finished yet;
* ``predates_measurements``: created before this database had the table;
* ``process_crash``: the process stopped during the run (startup recovery
  wrote the marker);
* ``measurement_flush_failed``: the terminal row was written without them;
* ``instrumentation_disabled``: recording was off for the run;
* ``not_recorded``: none of the above is on record (for example, the
  flush failed and so did writing its marker);
* ``unreadable``: a stored row that cannot be parsed.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import datetime
from typing import Any

from app.api_models import (
    MeasurementAgents,
    MeasurementCall,
    MeasurementCoder,
    MeasurementOrchestration,
    MeasurementPersistence,
    MeasurementPhases,
    MeasurementSpan,
    MeasurementStep,
    MeasurementVerification,
    MeasurementWaits,
    RunMeasurements,
)
from app.models import RunRecord
from app.redaction import PublicRedactor
from app.store import RunStore
from app.timings.analysis import derive
from app.timings.recorder import ATTRIBUTE_KEYS, KINDS, _attribute

ACTIVE_STATUSES = frozenset({"queued", "running"})
MARKER_REASONS = {
    "disabled": "instrumentation_disabled",
    "flush_failed": "measurement_flush_failed",
    "process_crash": "process_crash",
}
AGGREGATE_NAMES = frozenset({"append_event.lock_wait", "append_event.write", "save_run.lock_wait", "save_run.write"})


def _timestamp(value: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        return None


def _int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def sanitize(snapshot: Any) -> dict[str, Any] | None:
    """A stored snapshot reduced to what the recorder could have written."""
    if not isinstance(snapshot, dict):
        return None
    spans = []
    for item in snapshot.get("spans") or []:
        if not isinstance(item, dict) or item.get("kind") not in KINDS:
            continue
        span_id, start, end, parent = (_int(item.get(k)) for k in ("id", "start_ns", "end_ns", "parent"))
        if span_id is None or start is None:
            continue
        if item.get("end_ns") is not None and (end is None or end < start):
            continue
        if item.get("parent") is not None and parent is None:
            continue
        raw = item.get("attrs") if isinstance(item.get("attrs"), dict) else {}
        attrs = {key: _attribute(value) for key, value in raw.items() if key in ATTRIBUTE_KEYS and value is not None}
        spans.append({"id": span_id, "kind": item["kind"], "parent": parent, "start_ns": start, "end_ns": end, "attrs": attrs})
    dropped_raw = snapshot.get("dropped") if isinstance(snapshot.get("dropped"), dict) else {}
    dropped = {kind: count for kind, count in dropped_raw.items() if kind in KINDS and _int(count) is not None and count >= 0}
    aggregates_raw = snapshot.get("aggregates") if isinstance(snapshot.get("aggregates"), dict) else {}
    aggregates = {
        name: {key: _int(item.get(key)) for key in ("count", "sum_ns", "max_ns")}
        for name, item in aggregates_raw.items()
        if name in AGGREGATE_NAMES and isinstance(item, dict)
    }
    return {
        "version": _int(snapshot.get("version")),
        "enabled": True,
        "spans": spans,
        "dropped": dropped,
        "instrumentation_errors": _int(snapshot.get("instrumentation_errors")),
        "self_ns": _int(snapshot.get("self_ns")),
        "aggregates": aggregates,
        "truncated": snapshot.get("truncated") is True,
    }


def _reason_without_row(store: RunStore, record: RunRecord) -> str:
    if record.status in ACTIVE_STATUSES:
        return "run_in_progress"
    installed = _timestamp(store.measurements_installed_at())
    created = _timestamp(record.created_at)
    if installed is not None and created is not None and created < installed:
        return "predates_measurements"
    return "not_recorded"


def measurements_view(store: RunStore, record: RunRecord, *, public: PublicRedactor | None = None) -> RunMeasurements:
    """The response for one run (which the caller has already found)."""
    run_id = record.run_id
    row = store.get_measurement(run_id)
    if row is None:
        return RunMeasurements(run_id=run_id, available=False, reason=_reason_without_row(store, record))
    collected = _timestamp(row.collected_at)
    collected_at = collected.isoformat() if collected is not None else None
    if row.status != "recorded":
        reason = MARKER_REASONS.get(row.status, "not_recorded")
        return RunMeasurements(run_id=run_id, available=False, reason=reason, collected_at=collected_at)
    try:
        snapshot = sanitize(json.loads(row.measurements_json or ""))
    except (ValueError, TypeError, RecursionError):
        snapshot = None
    if snapshot is None:
        return RunMeasurements(run_id=run_id, available=False, reason="unreadable", collected_at=collected_at)
    return _recorded(run_id, snapshot, collected_at, row.measurements_version, public)


def _recorded(
    run_id: str,
    snapshot: dict[str, Any],
    collected_at: str | None,
    version: int | None,
    public: PublicRedactor | None,
) -> RunMeasurements:
    derived = derive(snapshot)
    v = derived.values
    text: Callable[[Any], Any] = (lambda s: public.text(s) if isinstance(s, str) else s) if public else (lambda s: s)

    def ms(ns: int | None) -> float | None:
        return None if ns is None else round(ns / 1_000_000, 3)

    dropped = snapshot["dropped"]
    return RunMeasurements(
        run_id=run_id,
        available=True,
        reason="recorded",
        measurements_version=version,
        collected_at=collected_at,
        truncated=snapshot["truncated"],
        dropped_spans=sum(dropped.values()),
        dropped_by_kind=dropped,
        instrumentation_errors=snapshot["instrumentation_errors"],
        measurement_self_ms=ms(snapshot["self_ns"]),
        phases=MeasurementPhases(
            admission_ms=v.get("admission_ms"),
            setup_ms=v.get("setup_ms"),
            graph_ms=v.get("graph_ms"),
            execution_ms=v.get("execution_ms"),
            finalization_ms=v.get("finalization_ms"),
            lifecycle_ms=v.get("lifecycle_ms"),
        ),
        coder=MeasurementCoder(
            busy_ms=v.get("coder_busy_ms"),
            wall_ms=v.get("coder_wall_ms"),
            critical_path_ms=v.get("coder_critical_path_ms"),
        ),
        orchestration=MeasurementOrchestration(
            graph_gap_ms=v.get("graph_gap_ms"),
            critical_ms=v.get("critical_orchestration_ms"),
            parallel_ms=v.get("parallel_orchestration_ms"),
            node_self_ms={
                text(key.removeprefix("node_self_ms.")): value
                for key, value in v.items()
                if key.startswith("node_self_ms.") and value is not None
            },
        ),
        agents=MeasurementAgents(
            planner_ms=v.get("planner_ms"),
            reviewer_ms=v.get("reviewer_ms"),
            call_ms=v.get("call_ms"),
            parse_ms=v.get("parse_ms"),
            backoff_ms=v.get("backoff_ms"),
            http_attempts=v.get("http_attempts"),
        ),
        waits=MeasurementWaits(
            schedule_delay_ms=v.get("schedule_delay_ms"),
            slot_wait_ms=v.get("slot_wait_ms"),
            ledger_wait_ms=v.get("ledger_wait_ms"),
            verify_thread_wait_ms=v.get("verify_thread_wait_ms"),
        ),
        verification=MeasurementVerification(
            verification_ms=v.get("verification_ms"),
            diagnostic_verification_ms=v.get("diagnostic_verification_ms"),
        ),
        persistence=MeasurementPersistence(
            event_persist_lock_wait_ms=v.get("event_persist_lock_wait_ms"),
            event_persist_write_ms=v.get("event_persist_write_ms"),
            event_persist_writes=v.get("event_persist_write_count"),
            save_run_lock_wait_ms=v.get("save_run_lock_wait_ms"),
            save_run_write_ms=v.get("save_run_write_ms"),
            save_run_writes=v.get("save_run_write_count"),
        ),
        unknown={text(key): reason for key, reason in derived.reasons.items()},
        calls=[
            MeasurementCall(
                role=text(call["role"]),
                step_id=text(call["step_id"]),
                attempt=_int(call["attempt"]),
                outcome=text(call["outcome"]),
                call_ms=call["call_ms"],
                http_attempts=call["http_attempts"],
                http_attempt_ms=call["http_attempt_ms"],
                http_outcomes=[text(item) for item in call["http_outcomes"]],
                parse_ms=call["parse_ms"],
            )
            for call in derived.calls
        ],
        steps=[
            MeasurementStep(
                step_id=text(step["step_id"]),
                dispatch_id=_int(step["dispatch_id"]),
                attempt=_int(step["attempt"]),
                start_ms=step["start_ms"],
                duration_ms=step["duration_ms"],
                schedule_delay_ms=step["schedule_delay_ms"],
                slot_wait_ms=step["slot_wait_ms"],
                checkout_ms=step["checkout_ms"],
            )
            for step in derived.steps
        ],
        spans=[
            MeasurementSpan(
                id=span["id"],
                kind=span["kind"],
                parent=span["parent"],
                start_ms=ms(span["start_ns"]),
                end_ms=ms(span["end_ns"]),
                attrs={key: text(value) for key, value in span["attrs"].items()},
            )
            for span in snapshot["spans"]
        ],
    )
