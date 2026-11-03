"""A/B overhead of timing recording: the scripted catalog suite with
recording on and off, paired and interleaved, on scratch databases.

Each trial is one catalog run through ``RunService.run_request``, timed by
this harness on a monotonic clock (``time.perf_counter_ns``) the same way
for both arms (with recording off there are no spans to read). Pairs
alternate their order (on then off, then off then on) so drift spreads over
both arms. The first ``--warmup`` pairs per task are excluded. Reported per
arm: n, median and nearest-rank P95; and the median of the paired
differences (on minus off), absolute and relative to the off median. No
significance is claimed.

usage: python scripts/measure_timings_overhead.py [--pairs 20] [--warmup 1] [--json out.json]

Development tool. Reads no .env, calls no model (the demo provider only),
and writes only to a temporary directory.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import statistics
import sys
import tempfile
import time
from dataclasses import replace
from pathlib import Path

# Before anything imports app.config: no .env, no model endpoint.
os.environ["PYTHON_DOTENV_DISABLED"] = "1"
for name in ("OPENAI_COMPAT_BASE_URL", "OPENAI_COMPAT_API_KEY", "OPENAI_COMPAT_MODEL_FAST", "OPENAI_COMPAT_MODEL_STRONG"):
    os.environ[name] = ""

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.config import settings as base_settings  # noqa: E402
from app.demo_tasks import PIPELINE_TASK_ID, SAMPLE_TASK_ID  # noqa: E402
from app.models import RunRequest  # noqa: E402
from app.service import RunService  # noqa: E402
from app.store import RunStore  # noqa: E402

TASKS = (SAMPLE_TASK_ID, PIPELINE_TASK_ID)


def p95(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[math.ceil(0.95 * len(ordered)) - 1]


def summary(values: list[float]) -> dict:
    return {
        "n": len(values),
        "median_ms": round(statistics.median(values), 3) if values else None,
        "p95_ms": round(p95(values), 3) if values else None,
    }


async def measure(pairs: int, warmup: int, tasks: tuple[str, ...]) -> dict:
    root = Path(tempfile.mkdtemp(prefix="swarmos-overhead-"))
    services = {}
    for arm, enabled in (("on", True), ("off", False)):
        settings = replace(
            base_settings,
            db_path=root / f"{arm}.db",
            provider="demo",
            base_url="",
            api_key="",
            fast_model="",
            strong_model="",
            api_token="",
            timings_enabled=enabled,
        )
        services[arm] = RunService(settings, RunStore(settings.db_path))

    async def trial(arm: str, task: str) -> float:
        started = time.perf_counter_ns()
        record = await services[arm].run_request(RunRequest(goal="measure the overhead", demo_task=task))
        elapsed = (time.perf_counter_ns() - started) / 1_000_000
        if record.status != "completed":
            raise RuntimeError(f"{arm} run on {task} ended {record.status}")
        return elapsed

    results: dict = {"pairs": pairs, "warmup": warmup, "tasks": {}}
    for task in tasks:
        on: list[float] = []
        off: list[float] = []
        for index in range(warmup + pairs):
            order = ("on", "off") if index % 2 == 0 else ("off", "on")
            times = {arm: await trial(arm, task) for arm in order}
            if index >= warmup:
                on.append(times["on"])
                off.append(times["off"])
        differences = [a - b for a, b in zip(on, off, strict=True)]
        off_median = statistics.median(off)
        median_difference = statistics.median(differences)
        results["tasks"][task] = {
            "on": summary(on),
            "off": summary(off),
            "paired_difference_median_ms": round(median_difference, 3),
            "paired_difference_median_pct": round(100 * median_difference / off_median, 3),
            "paired_differences_ms": {"min": round(min(differences), 3), "max": round(max(differences), 3)},
            "target_ms": round(max(0.01 * off_median, 2.0), 3),
            "within_target": median_difference <= max(0.01 * off_median, 2.0),
        }
    for service in services.values():
        service.store.close()
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pairs", type=int, default=20, help="measured pairs per task (default 20)")
    parser.add_argument("--warmup", type=int, default=1, help="excluded pairs per task (default 1)")
    parser.add_argument("--json", type=Path, default=None, help="also write the results here")
    args = parser.parse_args(argv)
    if args.pairs < 1 or args.warmup < 0:
        parser.error("--pairs must be at least 1 and --warmup at least 0")
    results = asyncio.run(measure(args.pairs, args.warmup, TASKS))
    text = json.dumps(results, indent=2)
    print(text)
    if args.json is not None:
        args.json.write_text(text + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
