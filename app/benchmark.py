"""Compatibility shim: the harness moved to ``app.benchmarks.legacy``.

Kept so existing imports (``swarmos bench`` until it moves onto the
benchmark runner) keep working unchanged.
"""

from app.benchmarks.legacy import (
    POLICIES,
    BenchmarkPolicy,
    BenchmarkResult,
    BenchmarkTask,
    load_tasks,
    request_for,
    result_from_run,
    summarise,
    write_results,
)

__all__ = [
    "POLICIES",
    "BenchmarkPolicy",
    "BenchmarkResult",
    "BenchmarkTask",
    "load_tasks",
    "request_for",
    "result_from_run",
    "summarise",
    "write_results",
]
