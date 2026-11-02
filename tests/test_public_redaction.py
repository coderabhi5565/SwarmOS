"""The public demo's view of run data (``app.redaction``).

No host path, executed command line, endpoint, key or address may leave the
server in any response that carries a run: the run detail, the polled
events, the live stream, the run list. Local mode keeps every detail. The
seeded traces are stored exactly as an older server might have recorded
them, so these tests also prove that sanitizing happens at read time.
All values below are fake canaries.
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.benchmarks import views as benchmark_views
from app.models import RunRecord, TraceEvent, VerificationResult
from app.redaction import REDACTED, REDACTED_ADDRESS, REDACTED_PATH, TAIL_LIMIT, PublicRedactor
from tests.conftest import make_settings
from tests.test_stream import open_stream, read_to_end, running_app

PUBLIC = {"mode": "public_demo", "execution_sandbox": "restricted", "code_policy_enabled": True}
CANARY_USER = "canaryuser7f3a"
CANARY_KEY = "sk-canary-0000000000000000000000"
CANARY_HOST = "canary-endpoint.internal"
CANARY_URL = f"http://{CANARY_HOST}:4444/v1"
CANARY_IP = "10.66.77.88"
CANARY_ENDPOINT = {"base_url": CANARY_URL, "api_key": CANARY_KEY, "fast_model": "canary-model"}

WIN_HOME = rf"C:\Users\{CANARY_USER}"
POSIX_HOME = f"/home/{CANARY_USER}"
WIN_WORKSPACE = rf"{WIN_HOME}\AppData\Local\Temp\swarmos-run_canary-ab12\workspace"
EXECUTED = (
    rf"{WIN_HOME}\SwarmOS\.venv\Scripts\python.exe -I {WIN_HOME}\SwarmOS\app\runtime\sandbox_launcher.py "
    rf"{WIN_WORKSPACE} -q -p no:cacheprovider --rootdir {WIN_WORKSPACE} "
    rf"--basetemp {WIN_WORKSPACE}\.swarmos_tmp\pytest"
)
CONFIGURED = "python -m pytest -q"
# Output cut at the recording limit, starting part-way through a path.
TRUNCATED_TAIL = (
    rf"ers\{CANARY_USER}\AppData\Local\Temp\swarmos-run_canary-ab12\workspace\tests\x.py:1: in f" + "\n"
    + "E   assert 1 == 2\n" * 400
)[:TAIL_LIMIT]

FORBIDDEN = [
    CANARY_USER,
    CANARY_KEY,
    CANARY_HOST,
    CANARY_IP,
    "sandbox_launcher",
    "no:cacheprovider",
    "--basetemp",
    "AppData",
    "/home/",
    "/tmp/",
    ".venv",
    "site-packages",
    "swarmos-run_canary",
    "abc123secret",
]


def assert_clean(text: str) -> None:
    leaked = [canary for canary in FORBIDDEN if canary in text]
    assert not leaked, f"leaked to the public: {leaked}"


def seed(store) -> RunRecord:
    """A finished run whose record and trace carry every kind of host detail."""
    record = RunRecord(
        goal=f"fix the parser in {POSIX_HOME}/project",
        status="failed",
        error=rf"could not start verification command: [WinError 2] '{WIN_HOME}\SwarmOS\x.exe'",
        provider_warning=f"endpoint {CANARY_URL} unreachable",
        verification=VerificationResult(
            passed=False,
            command=EXECUTED,
            exit_code=1,
            duration_ms=40,
            tests_passed=2,
            tests_failed=1,
            stdout_tail=TRUNCATED_TAIL,
            stderr_tail="SwarmOS sandbox: read outside the workspace: " + repr(rf"{WIN_HOME}\secret.txt"),
        ),
        changed_files=["target.py"],
    )
    store.save_run(record)
    events = [
        ("verification_started", "Verification started", {"verification_id": "ver_1", "command": CONFIGURED}),
        (
            "verification",
            "Verification failed",
            {
                "verification_id": "ver_1",
                "passed": False,
                "command": EXECUTED,
                "exit_code": 1,
                "tests_passed": 2,
                "tests_failed": 1,
                "stdout_tail": rf"{WIN_WORKSPACE}\tests\test_target.py:12: AssertionError",
                "stderr_tail": "SwarmOS sandbox: write outside the workspace: " + repr(f"{POSIX_HOME}/.ssh/id_rsa"),
            },
        ),
        (
            "failure",
            "Verification reported failing tests",
            {
                "error": f"OSError in {POSIX_HOME}/app/.venv/lib/python3.12/site-packages/_pytest/main.py",
                "error_class": "verification_failed",
                "stdout_tail": TRUNCATED_TAIL,
            },
        ),
        (
            "agent_invocation",
            "Coder call failed",
            {
                "error": f"connection to {CANARY_URL} failed ({CANARY_IP}:11434), key {CANARY_KEY}",
                # An older trace generation with free-form nesting, keys included.
                "output_summary": {
                    "nested": [
                        {
                            "deeper": {
                                f"{POSIX_HOME}/key-file": [rf"{WIN_HOME}\a.txt", "OPENAI_COMPAT_API_KEY=abc123secret"],
                                "host": f"[fd00::{CANARY_IP.split('.')[-1]}]:8080 via {CANARY_IP}",
                            }
                        }
                    ]
                },
            },
        ),
        ("warning", rf"snapshot of {WIN_WORKSPACE}\target.py truncated", {"files": ["target.py"]}),
        ("run_finished", "Run failed", {"status": "failed"}),
    ]
    for seq, (kind, message, payload) in enumerate(events, start=1):
        store.append_event(TraceEvent(run_id=record.run_id, seq=seq, kind=kind, message=message, payload=payload))
    return record


@pytest.fixture
def public_client(tmp_path, monkeypatch):
    monkeypatch.setattr(main_module, "settings", make_settings(tmp_path, **PUBLIC, **CANARY_ENDPOINT))
    with TestClient(main_module.app) as client:
        yield client


@pytest.fixture
def local_client(tmp_path, monkeypatch):
    monkeypatch.setattr(main_module, "settings", make_settings(tmp_path, **CANARY_ENDPOINT))
    with TestClient(main_module.app) as client:
        yield client


# ----------------------------------------------------------------------
# historical reads
# ----------------------------------------------------------------------
def test_public_events_carry_no_host_detail(public_client):
    record = seed(public_client.app.state.store)
    response = public_client.get(f"/api/runs/{record.run_id}/events")
    assert response.status_code == 200
    assert_clean(response.text)
    events = response.json()["events"]
    by_kind = {event["kind"]: event for event in events}
    # The executed command line is withheld; the configured command is shown.
    assert by_kind["verification"]["payload"]["command"] == REDACTED
    assert by_kind["verification_started"]["payload"]["command"] == CONFIGURED
    # Useful, host-free detail survives: workspace-relative paths, outcomes.
    assert by_kind["verification"]["payload"]["stdout_tail"] == "tests/test_target.py:12: AssertionError"
    assert REDACTED_PATH in by_kind["verification"]["payload"]["stderr_tail"]
    assert by_kind["verification"]["payload"]["tests_failed"] == 1
    assert by_kind["warning"]["message"] == "snapshot of target.py truncated"
    assert by_kind["failure"]["payload"]["error_class"] == "verification_failed"
    assert by_kind["failure"]["payload"]["stdout_tail"].startswith("[earlier output omitted]\nE   assert 1 == 2")
    nested = by_kind["agent_invocation"]["payload"]["output_summary"]["nested"][0]["deeper"]
    assert set(nested) == {REDACTED_PATH, "host"}
    assert nested[REDACTED_PATH] == [REDACTED_PATH, f"OPENAI_COMPAT_API_KEY={REDACTED}"]
    assert nested["host"] == f"{REDACTED_ADDRESS} via {REDACTED_ADDRESS}"


def test_public_events_keep_every_event_its_order_and_ids(public_client):
    store = public_client.app.state.store
    record = seed(store)
    stored = store.get_events(record.run_id)
    shown = public_client.get(f"/api/runs/{record.run_id}/events").json()
    assert [e["seq"] for e in shown["events"]] == [e.seq for e in stored] == [1, 2, 3, 4, 5, 6]
    assert [e["event_id"] for e in shown["events"]] == [e.event_id for e in stored]
    assert [e["kind"] for e in shown["events"]] == [e.kind for e in stored]
    assert [e["at"] for e in shown["events"]] == [e.at for e in stored]
    assert shown["last_seq"] == 6
    page = public_client.get(f"/api/runs/{record.run_id}/events", params={"after_seq": 3}).json()
    assert [e["seq"] for e in page["events"]] == [4, 5, 6] and page["last_seq"] == 6
    assert_clean(json.dumps(page))


def test_public_run_detail_and_list_carry_no_host_detail(public_client):
    record = seed(public_client.app.state.store)
    detail = public_client.get(f"/api/runs/{record.run_id}")
    assert detail.status_code == 200
    assert_clean(detail.text)
    run = detail.json()["run"]
    assert run["verification"]["command"] == REDACTED
    assert run["verification"]["exit_code"] == 1 and run["status"] == "failed"
    assert run["verification"]["stdout_tail"].startswith("[earlier output omitted]")
    assert len(detail.json()["events"]) == 6
    listing = public_client.get("/api/runs")
    assert record.run_id in listing.text
    assert_clean(listing.text)


def test_stored_events_are_not_rewritten(public_client):
    store = public_client.app.state.store
    record = seed(store)
    public_client.get(f"/api/runs/{record.run_id}/events")
    public_client.get(f"/api/runs/{record.run_id}")
    stored = store.get_events(record.run_id)
    assert stored[1].payload["command"] == EXECUTED
    assert store.get_run(record.run_id).verification.command == EXECUTED


def test_local_mode_keeps_its_debugging_detail(local_client):
    record = seed(local_client.app.state.store)
    events = local_client.get(f"/api/runs/{record.run_id}/events").json()["events"]
    assert events[1]["payload"]["command"] == EXECUTED
    assert events[2]["payload"]["stdout_tail"] == TRUNCATED_TAIL
    detail = local_client.get(f"/api/runs/{record.run_id}").json()
    assert detail["run"]["verification"]["command"] == EXECUTED
    assert CANARY_USER in json.dumps(detail)


def test_public_config_hides_an_absolute_verification_command(tmp_path, monkeypatch):
    command = rf"{WIN_HOME}\py\python.exe -m pytest -q"
    monkeypatch.setattr(
        main_module, "settings", make_settings(tmp_path, **PUBLIC, verification_command=command)
    )
    with TestClient(main_module.app) as client:
        shown = client.get("/api/config").json()["verification"]["command"]
    assert shown == f"{REDACTED_PATH} -m pytest -q"


def test_benchmark_text_in_the_public_demo_carries_no_host_path(tmp_path):
    public = make_settings(tmp_path, **PUBLIC, **CANARY_ENDPOINT)
    local = make_settings(tmp_path, **CANARY_ENDPOINT)
    text = rf"the run could not be started: {WIN_HOME}\x and {POSIX_HOME}/y via {CANARY_URL}"
    assert_clean(benchmark_views.redact(text, public))
    # Local mode: the endpoint and key are still removed, paths kept.
    assert benchmark_views.redact(text, local) == text.replace(CANARY_URL, REDACTED)


# ----------------------------------------------------------------------
# the live stream
# ----------------------------------------------------------------------
async def test_a_public_stream_of_a_stored_trace_carries_no_host_detail(tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch, **PUBLIC, **CANARY_ENDPOINT) as app:
        record = seed(app.state.store)
        stream = await read_to_end(app, f"/api/runs/{record.run_id}/stream")
    assert stream.status == 200 and stream.end is not None
    assert_clean(stream.raw)
    assert [m.id for m in stream.messages if m.event == "trace"] == ["1", "2", "3", "4", "5", "6"]
    assert stream.seqs == [1, 2, 3, 4, 5, 6]
    assert stream.traces[1]["payload"]["command"] == REDACTED


async def test_events_recorded_during_a_public_stream_arrive_redacted(tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch, **PUBLIC, **CANARY_ENDPOINT) as app:
        store = app.state.store
        record = RunRecord(goal="live", status="running")
        store.save_run(record)
        stream = open_stream(app, f"/api/runs/{record.run_id}/stream")
        await stream.wait_for(lambda s: s.status == 200)
        store.append_event(
            TraceEvent(
                run_id=record.run_id,
                seq=1,
                kind="verification",
                message="Verification failed",
                payload={"command": EXECUTED, "stderr_tail": f"refused {POSIX_HOME}/.ssh/id_rsa"},
            )
        )
        await stream.wait_for(lambda s: len(s.traces) == 1)
        store.append_event(TraceEvent(run_id=record.run_id, seq=2, kind="run_finished", message="done", payload={}))
        store.save_run(record.model_copy(update={"status": "failed"}))
        await stream.wait_for(lambda s: s.end is not None)
        await asyncio.wait_for(stream.task, 5)
    assert_clean(stream.raw)
    assert stream.seqs == [1, 2]
    assert stream.traces[0]["payload"] == {"command": REDACTED, "stderr_tail": f"refused {REDACTED_PATH}"}


# ----------------------------------------------------------------------
# a real public run, through the real sandbox launcher
# ----------------------------------------------------------------------
def _host_details() -> list[str]:
    """This machine's real paths, raw and as JSON escapes them."""
    paths = {
        sys.executable,
        str(Path(sys.executable).parent),
        str(Path.home()),
        tempfile.gettempdir(),
        str(Path(main_module.__file__).resolve().parents[1]),
    }
    return sorted(paths | {json.dumps(path)[1:-1] for path in paths})


async def test_a_real_public_run_shows_no_host_path_anywhere(tmp_path, monkeypatch):
    async with running_app(tmp_path, monkeypatch, **PUBLIC) as app:
        record = app.state.service.submit(
            main_module.RunRequest(goal="catalog run", demo_task="sample_tag_normalization")
        )
        stream = await read_to_end(app, f"/api/runs/{record.run_id}/stream")
        deadline = time.time() + 60
        while app.state.store.get_run(record.run_id).status in {"queued", "running"}:
            assert time.time() < deadline
            await asyncio.sleep(0.1)
        stored = app.state.store.get_events(record.run_id)
        detail = main_module._detail(record.run_id)
    # The trace as stored really does hold the executed command line ...
    executed = next(e.payload["command"] for e in stored if e.kind == "verification")
    assert "sandbox_launcher" in executed and sys.executable in executed
    # ... and neither the stream nor the detail shows any of it.
    for text in (stream.raw, detail.model_dump_json()):
        leaked = [path for path in _host_details() if path in text]
        assert not leaked, f"host paths leaked: {leaked}"
        assert "sandbox_launcher" not in text
    assert detail.run.status == "completed" and detail.run.verification.passed
    assert detail.run.verification.command == REDACTED
    assert [e.seq for e in detail.events] == [e.seq for e in stored]
    assert stream.seqs == [e.seq for e in stored]


# ----------------------------------------------------------------------
# the text rules
# ----------------------------------------------------------------------
@pytest.mark.parametrize(
    "text, expected",
    [
        (rf"{WIN_HOME}\x\python.exe -q", f"{REDACTED_PATH} -q"),
        ("C:/Users/" + CANARY_USER + "/x.py", REDACTED_PATH),
        ("in " + repr(rf"{WIN_HOME}\secret.txt"), f"in '{REDACTED_PATH}'"),
        (rf"C:\Users\John {CANARY_USER}\AppData\x.py -q", f"{REDACTED_PATH} -q"),
        (rf"\\fileserver\share\{CANARY_USER}\x.txt", REDACTED_PATH),
        (f"open {POSIX_HOME}/.config/x.json failed", f"open {REDACTED_PATH} failed"),
        ("~/.ssh/id_rsa", REDACTED_PATH),
        (f'File "{POSIX_HOME}/lib/x.py", line 3', f'File "{REDACTED_PATH}", line 3'),
        ("/tmp/swarmos-run_x-1/workspace/tests/t.py:4: E", "tests/t.py:4: E"),
        (rf"{WIN_WORKSPACE}\docs\a.md", "docs/a.md"),
        (WIN_WORKSPACE, "."),
        (f"see {CANARY_URL}", f"see {REDACTED}"),
        (f"host {CANARY_HOST}:4444", f"host {REDACTED}"),
        (f"at {CANARY_IP}:11434", f"at {REDACTED_ADDRESS}"),
        ("at [fd00::1]:8080", f"at {REDACTED_ADDRESS}"),
        (f"key {CANARY_KEY}", f"key {REDACTED}"),
        ("Authorization: Bearer abcdefghijklmnop", f"Authorization: {REDACTED}"),
        ("GITHUB_TOKEN=ghp_notreal", f"GITHUB_TOKEN={REDACTED}"),
    ],
)
def test_private_details_are_replaced(tmp_path, text, expected):
    redactor = PublicRedactor(make_settings(tmp_path, **PUBLIC, **CANARY_ENDPOINT))
    assert redactor.text(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "3 passed, 1 failed in 0.42s",
        "tests/test_target.py::test_normalize_tags FAILED",
        "docs/change-notes.md and target.py",
        "step 1/2 of wave 2; 50% done; a / b",
        "assert normalize_tags(['A', 'b']) == ['a', 'b']",
        "python -m pytest -q",
        "Dispatched 2 coding steps (inspect_tests, draft_implementation)",
    ],
)
def test_ordinary_trace_text_is_unchanged(tmp_path, text):
    redactor = PublicRedactor(make_settings(tmp_path, **PUBLIC, **CANARY_ENDPOINT))
    assert redactor.text(text) == text


def test_only_the_configured_command_is_shown(tmp_path):
    redactor = PublicRedactor(make_settings(tmp_path, **PUBLIC))
    assert redactor.command(CONFIGURED) == CONFIGURED
    assert redactor.command(EXECUTED) == REDACTED
    assert redactor.command("python -m pytest -q -x") == REDACTED


def test_an_untruncated_tail_keeps_its_first_line(tmp_path):
    redactor = PublicRedactor(make_settings(tmp_path, **PUBLIC))
    tail = "first line\nsecond line"
    assert redactor.value(tail, "stdout_tail") == tail
    assert redactor.value(TRUNCATED_TAIL, "stderr_tail").startswith("[earlier output omitted]\n")
