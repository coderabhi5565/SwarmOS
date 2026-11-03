"""A run's measurements as one bounded database row.

The row is built (serialized and bounded) before the terminal transaction
opens, so nothing about its content can fail that transaction. It is at
most ``MAX_ROW_BYTES`` (256 KiB) of compact JSON. When a snapshot is larger,
fine-grained spans are removed kind by kind in ``DROP_ORDER``, each removed
span is counted in ``dropped`` under its kind, and the row says
``truncated: true``; structural spans go only as a last resort. Derived
metrics that needed a removed span are then null with "spans dropped".

A recorder with recording off gives a ``disabled`` marker row: there are no
measurements, and the row says why.
"""

from __future__ import annotations

import json
from collections import Counter
from typing import Any

from app.models import utc_now
from app.store import MeasurementRow
from app.timings.recorder import SNAPSHOT_VERSION

MAX_ROW_BYTES = 256 * 1024
# Leaves first: a span is removed before the spans it nests under.
DROP_ORDER = (
    "call.http_attempt",
    "call.parse",
    "call.ledger_wait",
    "call.backoff",
    "step.checkout",
    "step.schedule_delay",
    "verify.thread_wait",
    "call.slot_wait",
    "verify.process",
    "verify.run",
    "call",
)


class MeasurementTooLarge(ValueError):
    """Even without any span the row exceeds the cap."""


def _dumps(payload: dict[str, Any]) -> str:
    return json.dumps(payload, separators=(",", ":"), allow_nan=False)


def _fits(text: str, limit: int) -> bool:
    return len(text.encode("utf-8")) <= limit


def measurement_row(run_id: str, snapshot: dict[str, Any], *, max_bytes: int = MAX_ROW_BYTES) -> MeasurementRow:
    """The run_measurements row for a recorder snapshot. Raises on a snapshot
    that cannot be serialized or bounded: the caller then falls back to the
    terminal row alone."""
    collected_at = snapshot.get("anchor_utc") if isinstance(snapshot.get("anchor_utc"), str) else utc_now()
    if not snapshot.get("enabled"):
        return MeasurementRow(run_id=run_id, status="disabled", collected_at=collected_at)

    payload = dict(snapshot)
    payload["truncated"] = False
    text = _dumps(payload)
    if not _fits(text, max_bytes):
        spans = list(payload.get("spans") or [])
        dropped: Counter[str] = Counter(payload.get("dropped") or {})
        payload["truncated"] = True
        for kind in DROP_ORDER:
            removed = sum(1 for span in spans if span.get("kind") == kind)
            if not removed:
                continue
            spans = [span for span in spans if span.get("kind") != kind]
            dropped[kind] += removed
            payload["spans"], payload["dropped"] = spans, dict(dropped)
            text = _dumps(payload)
            if _fits(text, max_bytes):
                break
        else:
            # Last resort: no spans at all, every one counted.
            dropped.update(span.get("kind", "unknown") for span in spans)
            payload["spans"], payload["dropped"] = [], dict(dropped)
            text = _dumps(payload)
        if not _fits(text, max_bytes):
            raise MeasurementTooLarge(f"measurements exceed {max_bytes} bytes without spans")
    return MeasurementRow(
        run_id=run_id,
        status="recorded",
        collected_at=collected_at,
        measurements_version=int(payload.get("version") or SNAPSHOT_VERSION),
        measurements_json=text,
    )
