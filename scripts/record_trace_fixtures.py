"""Record real backend traces as fixtures for the frontend event reducer.

Every fixture is produced by the actual orchestrator (graph, ledger, review
guard, verification subprocess, persistence); only the model replies are
scripted, as in the backend test suite. Legacy fixtures are exported,
read-only, from historical runs in the local database when it is present.

    python scripts/record_trace_fixtures.py [fixture_name ...]

With names, only those fixtures are (re)written; the others are left as they are.

Output: frontend/src/domain/execution/fixtures/*.json. Payloads are
sanitised: local paths are replaced, long text is truncated, and generated
file contents are never included.
"""

from __future__ import annotations

import asyncio
import json
import re
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.demo_tasks import PIPELINE_TASK_ID, SAMPLE_TASK_ID, resolve_demo_task  # noqa: E402
from app.models import Limits, RunRecord, RunRequest  # noqa: E402
from app.orchestrator import Orchestrator  # noqa: E402
from app.providers.demo import DemoProvider  # noqa: E402
from app.runtime.runtime import RunRuntime  # noqa: E402
from tests.conftest import (  # noqa: E402
    PLAN_THREE_STEPS,
    SEED_OK,
    TARGET_IMPLEMENTATION,
    ScriptedProvider,
    make_settings,
    plan_response,
    review_response,
)

OUT = ROOT / "frontend" / "src" / "domain" / "execution" / "fixtures"
LEGACY_RUNS = {
    # era 1: revision payload used "round"; dispatch had no mode
    "legacy_planner_revision": "run_37204d26ec8b",
    # era 2: the wall clock refused the reviewer call; no reviewer invocation
    "legacy_limit_at_review": "run_43bb974fc487",
    # era 3: seeded plan without depends_on, diagnostic verification, false blocker
    "legacy_false_blocker": "run_9038fdabb1b9",
}
TEXT_LIMIT = 240
_PATH = re.compile(r"(?:[A-Za-z]:[\\/]|/(?:home|Users|tmp|var|private)/)[^\s'\"]*")


def sanitize(value: Any) -> Any:
    if isinstance(value, str):
        cleaned = _PATH.sub("<path>", value)
        return cleaned if len(cleaned) <= TEXT_LIMIT else cleaned[:TEXT_LIMIT] + "…"
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    if isinstance(value, dict):
        return {key: sanitize(item) for key, item in value.items()}
    return value


def seed_of(record: RunRecord | dict) -> dict:
    data = record.model_dump(mode="json") if isinstance(record, RunRecord) else record
    keep = ("run_id", "created_at", "goal", "status", "provider", "provider_kind",
            "model_policy", "models_by_role", "limits", "plan")
    return sanitize({key: data.get(key) for key in keep})


ONLY: set[str] = set()


def write(name: str, description: str, source: str, run: dict, events: list[dict]) -> None:
    if ONLY and name not in ONLY:
        return
    OUT.mkdir(parents=True, exist_ok=True)
    fixture = {
        "name": name,
        "description": description,
        "source": source,
        "run": run,
        "events": [sanitize(event) for event in events],
    }
    path = OUT / f"{name}.json"
    path.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    print(f"{path.relative_to(ROOT)}: {len(events)} events")


def event_dicts(events) -> list[dict]:
    return [
        {key: value for key, value in event.model_dump(mode="json").items() if key != "run_id"}
        for event in events
    ]


# ----------------------------------------------------------------------
# recorded scenarios (current backend)
# ----------------------------------------------------------------------
async def orchestrate(tmp: Path, provider, *, demo_task=None, limits=None, files=None,
                      before_run=None, **overrides):
    demo = resolve_demo_task(demo_task) if demo_task else None
    settings = make_settings(tmp, **overrides)
    record = RunRecord(
        goal=demo.goal if demo else "Create the three output files",
        limits=limits or (demo.limits if demo else Limits()),
        provider=provider.name,
        provider_kind="demo" if provider.name == "demo" else "local",
    )
    runtime = RunRuntime(
        run_id=record.run_id, settings=settings, limits=record.limits, provider=provider,
        provider_name=provider.name, provider_warning=None,
        demo_task=demo.id if demo else None, seeded_plan=demo.plan if demo else None,
        allowed_files=frozenset(demo.allowed_files) if demo else None,
        read_only_files=frozenset(demo.read_only_files) if demo else frozenset(),
    )
    runtime.seed_workspace({} if demo else (files or SEED_OK), settings.sample_project)
    if before_run:
        before_run(runtime)
    try:
        result = await Orchestrator(runtime).run(record)
    finally:
        runtime.cleanup()
    return result


def coder(step_id: str, path: str, content: str) -> str:
    return json.dumps({"step_id": step_id, "summary": f"wrote {path}", "rationale": "scripted",
                       "changes": [{"path": path, "content": content, "action": "update"}]})


UNSORTED = ("from collections.abc import Iterable\n\n\n"
            "def normalize_tags(tags: Iterable[str]) -> list[str]:\n"
            "    return list({tag.strip().lower() for tag in tags if tag.strip()})\n")
EVIDENCED_BLOCKER = ('target.py:5 `return list({...})` returns ["python", "fastapi"] instead of '
                     '["fastapi", "python"], violating "the returned list is sorted ascending, '
                     'not merely deduplicated".')


async def record_all(tmp: Path) -> None:
    # 1. parallel pipeline: plan_seeded with depends_on, two waves, lifecycle pairs
    result = await orchestrate(tmp / "p", DemoProvider(), demo_task=PIPELINE_TASK_ID)
    write("demo_pipeline_completed", "Catalog pipeline on the demo fixture: a parallel first "
          "wave, a dependent second wave, review approval and passing verification.",
          "recorded: current backend, DemoProvider", seed_of(result.record),
          event_dicts(result.events))

    # 2. reviewer rejects with evidence, coder revises, reviewer approves
    reviews = iter([review_response("request_changes", [{"severity": "blocker", "step_id":
                    "draft_implementation", "file": "target.py", "message": EVIDENCED_BLOCKER}]),
                    review_response("approve")])
    coders = iter([UNSORTED, TARGET_IMPLEMENTATION])
    provider = ScriptedProvider(lambda r, i: coder("draft_implementation", "target.py", next(coders))
                                if r.role == "coder" else next(reviews))
    result = await orchestrate(tmp / "r", provider, demo_task=SAMPLE_TASK_ID)
    write("review_revision_completed", "An evidenced blocker triggers one revision round; the "
          "re-review approves and verification passes.", "recorded: current backend, scripted "
          "model replies", seed_of(result.record), event_dicts(result.events))

    # 3. evidence-less blocker: review_invalid with diagnostic verification
    provider = ScriptedProvider(lambda r, i: coder("draft_implementation", "target.py",
                                TARGET_IMPLEMENTATION) if r.role == "coder" else review_response(
                                "request_changes", [{"severity": "blocker", "file": "target.py",
                                                     "message": "Wrong."}]))
    result = await orchestrate(tmp / "i", provider, demo_task=SAMPLE_TASK_ID)
    write("review_invalid", "A blocker with no evidence ends the run as review_invalid; a "
          "diagnostic verification records that the tests pass.", "recorded: current backend, "
          "scripted model replies", seed_of(result.record), event_dicts(result.events))

    # 4. verification fails, one repair round fixes it
    coders = iter([UNSORTED, TARGET_IMPLEMENTATION])
    provider = ScriptedProvider(lambda r, i: coder("draft_implementation", "target.py", next(coders))
                                if r.role == "coder" else review_response("approve"))
    result = await orchestrate(tmp / "v", provider, demo_task=SAMPLE_TASK_ID,
                               limits=Limits(max_agent_calls=6, max_retries=1, max_revisions=1,
                                             max_escalations=0))
    write("verification_repair", "Approved code fails verification; a repair round fixes it "
          "and verification passes.", "recorded: current backend, scripted model replies",
          seed_of(result.record), event_dicts(result.events))

    # 5. invalid output, bounded retry, escalation to the strong tier
    def flaky(request, index):
        if request.role == "planner":
            return plan_response({**PLAN_THREE_STEPS, "steps": PLAN_THREE_STEPS["steps"][:1]})
        if request.role == "coder":
            return "not json" if request.model == "fast-model" else coder("alpha", "out/alpha.txt", "x")
        return review_response("approve")

    result = await orchestrate(tmp / "e", ScriptedProvider(flaky),
                               limits=Limits(max_retries=1, max_escalations=1),
                               base_url="http://127.0.0.1:1/v1", fast_model="fast-model",
                               strong_model="strong-model")
    write("retry_escalation", "The fast model returns unparseable output twice (attempt and "
          "bounded retry); escalation to the strong tier succeeds.", "recorded: current backend, "
          "scripted model replies", seed_of(result.record), event_dicts(result.events))

    # 6. the call limit refuses the review
    approve_all = lambda r, i: (plan_response(PLAN_THREE_STEPS) if r.role == "planner"  # noqa: E731
                                else coder(json.loads(r.user)["step"]["id"],
                                           f"out/{json.loads(r.user)['step']['id']}.txt", "x")
                                if r.role == "coder" else review_response("approve"))
    result = await orchestrate(tmp / "b", ScriptedProvider(approve_all),
                               limits=Limits(max_agent_calls=4))
    write("call_limit_exhausted", "Planning and three coding calls use the whole call budget; "
          "the reviewer call is refused and the run ends limit_exceeded.", "recorded: current "
          "backend, scripted model replies", seed_of(result.record), event_dicts(result.events))

    # 7. a slow model: both first-wave coder calls are in flight at once
    result = await orchestrate(tmp / "o", ScriptedProvider(approve_all, delay=0.05))
    write("parallel_overlap", "Three planned steps on a slow scripted model: both first-wave "
          "coder calls are in flight at the same time, then the dependent step runs.",
          "recorded: current backend, scripted model replies with a 50 ms delay",
          seed_of(result.record), event_dicts(result.events))

    # 8. the wall clock expires during the planner call
    def short_clock(runtime):
        runtime.ledger.started_monotonic -= runtime.limits.max_wall_seconds - 0.3

    result = await orchestrate(tmp / "t", ScriptedProvider(approve_all, delay=3.0),
                               before_run=short_clock)
    write("timed_out", "The run deadline arrives while the planner call is in flight; the call "
          "is abandoned and the run ends timed_out.", "recorded: current backend, scripted "
          "model replies", seed_of(result.record), event_dicts(result.events))

    # 9. cancelled mid-call: an agent_started without a completion
    await record_cancelled(tmp / "c")


async def record_cancelled(tmp: Path) -> None:
    import app.service as service_module
    from app.service import RunService
    from app.store import RunStore

    provider = ScriptedProvider(lambda r, i: plan_response(PLAN_THREE_STEPS), delay=30.0)
    original = service_module.resolve_provider
    service_module.resolve_provider = lambda name, settings: (provider, "scripted", None)
    store = RunStore(tmp / "cancel.db")
    try:
        service = RunService(make_settings(tmp), store)
        record = service.submit(RunRequest(goal="Create the three output files", files=SEED_OK))
        deadline = asyncio.get_running_loop().time() + 10
        while provider.in_flight == 0:
            if asyncio.get_running_loop().time() > deadline:
                raise RuntimeError("the scripted planner call never started")
            await asyncio.sleep(0.01)
        service.cancel(record.run_id)
        await service.drain()
        events = store.get_events(record.run_id)
        write("cancelled_mid_call", "Cancelled while the planner call is in flight: the "
              "agent_started has no completion, and run_finished closes the run.",
              "recorded: current backend RunService, scripted model replies",
              seed_of(store.get_run(record.run_id)), event_dicts(events))
    finally:
        service_module.resolve_provider = original
        store.close()


# ----------------------------------------------------------------------
# legacy traces (read-only export from the local database)
# ----------------------------------------------------------------------
def export_legacy(db: Path) -> None:
    if not db.is_file():
        print(f"{db} not found: legacy fixtures not exported")
        return
    connection = sqlite3.connect(f"file:{db.resolve().as_posix()}?immutable=1", uri=True)
    connection.row_factory = sqlite3.Row
    for name, run_id in LEGACY_RUNS.items():
        row = connection.execute("SELECT * FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        if row is None:
            print(f"{run_id} not in {db}: {name} not exported")
            continue
        run = {key: row[key] for key in ("run_id", "created_at", "goal", "status", "provider",
                                         "provider_kind", "model_policy")}
        run["models_by_role"] = json.loads(row["models_by_role_json"])
        run["limits"] = json.loads(row["limits_json"])
        run["plan"] = json.loads(row["plan_json"]) if row["plan_json"] else None
        events = [
            {"event_id": e["event_id"], "seq": e["seq"], "at": e["at"], "kind": e["kind"],
             "message": e["message"], "payload": json.loads(e["payload_json"])}
            for e in connection.execute(
                "SELECT * FROM trace_events WHERE run_id = ? ORDER BY seq", (run_id,))
        ]
        write(name, f"Historical local-model run {run_id} (qwen2.5-coder:1.5b), recorded "
              "before the M3.0 event contract.", "historical: local SQLite run history",
              sanitize(run), events)


def main() -> None:
    ONLY.update(sys.argv[1:])
    with tempfile.TemporaryDirectory(prefix="swarmos-fixtures-") as tmp:
        asyncio.run(record_all(Path(tmp)))
    export_legacy(ROOT / "swarmos.db")


if __name__ == "__main__":
    main()
