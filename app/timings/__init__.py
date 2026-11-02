"""Per-run timing measurements (M7.1): bounded spans on a monotonic clock,
kept in memory. See ``docs/m7-observability-proposal.md``."""

from app.timings.recorder import (
    DISABLED,
    KINDS,
    MAX_SPANS,
    SpanRecorder,
    activate,
    current,
)

__all__ = ["DISABLED", "KINDS", "MAX_SPANS", "SpanRecorder", "activate", "current"]
