"""The restricted public demo: code policy, sandboxed tests, and API gating."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from typing import get_args

import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.demo_tasks import PIPELINE_TASK_ID, SAMPLE_TASK_ID, demo_catalog
from app.models import FileChange, Limits, RunStatus
from app.providers.demo import DemoProvider
from app.rate_limit import SlidingWindowLimiter
from app.runtime import sandbox_launcher
from app.runtime.code_policy import check_changes, check_file
from app.runtime.workspace import Workspace
from tests.conftest import TARGET_IMPLEMENTATION, ScriptedProvider, make_settings, sign_up

TERMINAL = set(get_args(RunStatus)) - {"queued", "running"}
PUBLIC = {
    "mode": "public_demo",
    "execution_sandbox": "restricted",
    "code_policy_enabled": True,
    "max_concurrent_runs": 2,
    "runs_per_client_per_hour": 2,
}


# ----------------------------------------------------------------------
# static code policy
# ----------------------------------------------------------------------
def test_reference_implementations_pass_the_policy():
    assert check_file("target.py", TARGET_IMPLEMENTATION) == []
    from app.providers.demo import _IMPLEMENTATION

    assert check_file("target.py", _IMPLEMENTATION) == []


@pytest.mark.parametrize(
    "source, reason",
    [
        ("import os\n", "import of 'os'"),
        ("import subprocess\n", "import of 'subprocess'"),
        ("import socket\n", "import of 'socket'"),
        ("import ctypes\n", "import of 'ctypes'"),
        ("from importlib import import_module\n", "import from 'importlib'"),
        ("from . import sibling\n", "relative imports"),
        ("x = __import__('os')\n", "'__import__'"),
        ("eval('1 + 1')\n", "'eval'"),
        ("exec('x = 1')\n", "'exec'"),
        ("data = open('/etc/passwd').read()\n", "'open'"),
        ("f = getattr(object, 'x')\n", "'getattr'"),
        ("x = ().__class__.__bases__[0].__subclasses__()\n", "'__class__'"),
        ("def f():\n    return f.__globals__\n", "'__globals__'"),
        ("def f():\n    global counter\n", "global statements"),
        ("def broken(:\n", "syntax error"),
    ],
)
def test_policy_rejects_unsafe_code(source, reason):
    violations = check_file("target.py", source)
    assert violations, source
    assert any(reason in violation.reason for violation in violations)


def test_policy_allows_ordinary_classes_and_safe_modules():
    source = (
        "from __future__ import annotations\n"
        "import re\nfrom collections import Counter\nfrom dataclasses import dataclass\n\n"
        "class Tags(Counter):\n"
        "    def __init__(self, items):\n"
        "        super().__init__(items)\n\n"
        "def slug(text: str) -> str:\n"
        "    return re.sub(r'\\s+', '-', text.strip().lower())\n"
    )
    assert check_file("target.py", source) == []


def test_policy_file_types_and_size():
    assert check_file("docs/change-notes.md", "import os  # just text") == []
    assert check_file("run.sh", "rm -rf /")[0].reason.startswith("only .py")
    assert "exceeds" in check_file("target.py", "x = 1\n" * 5000)[0].reason


def test_deletions_are_not_code():
    assert check_changes([FileChange(path="target.py", action="delete")]) == []


# ----------------------------------------------------------------------
# restricted sandbox
# ----------------------------------------------------------------------
HOSTILE = '''
import pytest

SECRET = {secret!r}
OUTSIDE = {outside!r}

def test_network_is_refused():
    import socket
    with pytest.raises(PermissionError):
        socket.create_connection(("127.0.0.1", 9), timeout=1)

def test_process_creation_is_refused():
    import subprocess
    with pytest.raises(PermissionError):
        subprocess.run(["python", "-c", "print(1)"])

def test_reading_outside_the_workspace_is_refused():
    with pytest.raises(PermissionError):
        open(SECRET).read()

def test_listing_outside_the_workspace_is_refused():
    import os
    with pytest.raises(PermissionError):
        os.listdir(os.path.dirname(SECRET))

def test_writing_outside_the_workspace_is_refused():
    with pytest.raises(PermissionError):
        open(OUTSIDE, "w").write("pwned")

def test_ctypes_is_refused():
    # Loading a native library is refused. On Windows, ctypes' own import code
    # converts that refusal into AttributeError, so accept either form.
    with pytest.raises((PermissionError, AttributeError, OSError)):
        import ctypes
        ctypes.CDLL(None)

def test_tmp_path_still_works(tmp_path):
    (tmp_path / "ok.txt").write_text("fine")
    assert (tmp_path / "ok.txt").read_text() == "fine"
'''


def restricted_workspace(tmp_path, files: dict[str, str]) -> Workspace:
    workspace = Workspace(tmp_path / "run" / "workspace", sandbox="restricted")
    workspace.seed(files)
    return workspace


def test_restricted_sandbox_refuses_escape_attempts(tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("host secret")
    outside = tmp_path / "pwned.txt"
    workspace = restricted_workspace(
        tmp_path,
        {
            "tests/test_hostile.py": HOSTILE.format(secret=str(secret), outside=str(outside)),
        },
    )
    result = workspace.run_command("python -m pytest -q", 60)

    # Every test asserts its operation was refused, so all of them pass.
    assert result.passed, result.stdout_tail + result.stderr_tail
    assert result.tests_passed == 7
    assert not outside.exists()


def test_restricted_sandbox_runs_the_real_sample_tests(tmp_path):
    from app.config import PROJECT_ROOT

    tests = (PROJECT_ROOT / "samples/sample_project/tests/test_target.py").read_text()
    workspace = restricted_workspace(
        tmp_path, {"target.py": TARGET_IMPLEMENTATION, "tests/test_target.py": tests}
    )
    result = workspace.run_command("python -m pytest -q", 60)

    assert result.passed and result.tests_passed == 3
    # The sandbox scratch directory never leaks into a workspace snapshot.
    assert not any(path.startswith(".swarmos_tmp") for path in workspace.snapshot())


def test_a_test_that_escapes_fails_verification(tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("host secret")
    workspace = restricted_workspace(
        tmp_path,
        {"tests/test_leak.py": f"def test_leak():\n    assert open({str(secret)!r}).read()\n"},
    )
    result = workspace.run_command("python -m pytest -q", 60)

    assert not result.passed
    assert "SwarmOS sandbox" in result.stdout_tail


def test_restricted_sandbox_only_runs_pytest(tmp_path):
    workspace = restricted_workspace(tmp_path, {"main.py": "print('hi')\n"})
    result = workspace.run_command("python main.py", 30)
    assert not result.passed
    assert result.exit_code == 126
    assert "only runs `python -m pytest`" in result.stderr_tail


@pytest.mark.skipif(os.name == "nt", reason="POSIX resource limits")
def test_resource_limits_are_applied_on_posix():
    code = (
        "import resource, sys\n"
        f"sys.path.insert(0, {os.path.dirname(sandbox_launcher.__file__)!r})\n"
        "import sandbox_launcher\n"
        "print(sorted(sandbox_launcher.apply_resource_limits(7)))\n"
        "print(resource.getrlimit(resource.RLIMIT_CPU)[0])\n"
    )
    output = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, check=True
    ).stdout.split("\n")
    assert "RLIMIT_CPU" in output[0] and "RLIMIT_AS" in output[0]
    assert output[1] == "7"


# ----------------------------------------------------------------------
# orchestration under the public profile
# ----------------------------------------------------------------------
async def test_policy_violation_fails_the_step_and_a_clean_retry_succeeds(build_run):
    attempts = {"coder": 0}

    def handler(request, index):
        if request.role == "coder":
            attempts["coder"] += 1
            content = (
                "import os\n\ndef normalize_tags(tags):\n    return os.listdir('/')\n"
                if attempts["coder"] == 1
                else TARGET_IMPLEMENTATION
            )
            return json.dumps(
                {
                    "step_id": "draft_implementation",
                    "summary": "attempt",
                    "rationale": "r",
                    "changes": [{"path": "target.py", "content": content, "action": "update"}],
                }
            )
        return json.dumps({"verdict": "approve", "rationale": "ok", "findings": []})

    orchestrator, _, record = build_run(
        ScriptedProvider(handler),
        demo_task=SAMPLE_TASK_ID,
        limits=Limits(max_agent_calls=6, max_retries=1, max_revisions=0, max_escalations=0),
        code_policy_enabled=True,
        execution_sandbox="restricted",
    )
    result = await orchestrator.run(record)

    rejected = [e for e in result.events if "code policy" in e.message]
    assert len(rejected) == 1
    assert "import of 'os'" in rejected[0].payload["violations"][0]
    assert result.record.status == "completed"
    assert result.record.verification.passed is True


@pytest.mark.parametrize("task_id", [SAMPLE_TASK_ID, PIPELINE_TASK_ID])
async def test_catalog_tasks_complete_under_the_public_profile(build_run, task_id):
    orchestrator, _, record = build_run(
        DemoProvider(),
        demo_task=task_id,
        code_policy_enabled=True,
        execution_sandbox="restricted",
    )
    result = await orchestrator.run(record)

    assert result.record.status == "completed", result.record.summary
    assert result.record.verification.passed is True
    assert result.record.verification.tests_passed == 3
    if task_id == PIPELINE_TASK_ID:
        first = next(
            e for e in result.events
            if e.kind == "routing_decision" and e.payload.get("decision") == "dispatch_coding"
        )
        assert first.payload["steps"] == ["inspect_tests", "draft_implementation"]
        assert first.payload["parallel"] is True
        assert "docs/change-notes.md" in result.record.changed_files


# ----------------------------------------------------------------------
# configuration
# ----------------------------------------------------------------------
def test_public_demo_requires_its_safety_layers(tmp_path):
    assert make_settings(tmp_path, **PUBLIC).startup_errors() == []

    unsandboxed = make_settings(tmp_path, **{**PUBLIC, "execution_sandbox": "none"})
    assert any("restricted" in error for error in unsandboxed.startup_errors())

    no_policy = make_settings(tmp_path, **{**PUBLIC, "code_policy_enabled": False})
    assert any("CODE_POLICY" in error for error in no_policy.startup_errors())

    repo = make_settings(tmp_path, **{**PUBLIC, "allow_repo_checkout": True})
    assert any("REPO_CHECKOUT" in error for error in repo.startup_errors())

    assert make_settings(tmp_path, mode="production").startup_errors()


def test_api_refuses_to_start_with_an_unsafe_public_config(tmp_path, monkeypatch):
    unsafe = make_settings(tmp_path, **{**PUBLIC, "execution_sandbox": "none"})
    monkeypatch.setattr(main_module, "settings", unsafe)
    with pytest.raises(RuntimeError, match="refusing to start"):
        with TestClient(main_module.app):
            pass


# ----------------------------------------------------------------------
# API in public demo mode
# ----------------------------------------------------------------------
@pytest.fixture
def public_client(tmp_path, monkeypatch):
    """A signed-in user of the public demo (visitors are in test_auth.py)."""
    monkeypatch.setattr(main_module, "settings", make_settings(tmp_path, **PUBLIC))
    with TestClient(main_module.app) as client:
        sign_up(client)
        yield client


def wait_for_terminal(client, run_id: str, within: float = 60.0) -> dict:
    deadline = time.time() + within
    while time.time() < deadline:
        run = client.get(f"/api/runs/{run_id}").json()["run"]
        if run["status"] in TERMINAL:
            return run
        time.sleep(0.1)
    raise AssertionError("run did not finish")


def test_public_demo_runs_a_catalog_task_end_to_end(public_client):
    response = public_client.post("/api/runs", json={"goal": "ignored by the recipe", "demo_task": SAMPLE_TASK_ID})
    assert response.status_code == 202
    run = wait_for_terminal(public_client, response.json()["run"]["run_id"])
    assert run["status"] == "completed"
    assert run["verification"]["tests_passed"] == 3


@pytest.mark.parametrize(
    "body, path",
    [
        ({"goal": "write me a port scanner please"}, "/api/runs"),
        ({"goal": "catalog with files", "demo_task": SAMPLE_TASK_ID, "files": {"x.py": "1"}}, "/api/runs"),
        ({"goal": "catalog with provider", "demo_task": SAMPLE_TASK_ID, "provider": "demo"}, "/api/runs"),
        ({"goal": "inline catalog run", "demo_task": SAMPLE_TASK_ID}, "/api/runs?wait=true"),
    ],
)
def test_public_demo_refuses_anything_but_a_catalog_run(public_client, body, path):
    response = public_client.post(path, json=body)
    assert response.status_code == 403


def test_public_demo_rate_limits_per_client(public_client):
    body = {"goal": "catalog run", "demo_task": SAMPLE_TASK_ID}
    first = public_client.post("/api/runs", json=body)
    second = public_client.post("/api/runs", json=body)
    assert first.status_code == second.status_code == 202
    wait_for_terminal(public_client, first.json()["run"]["run_id"])
    wait_for_terminal(public_client, second.json()["run"]["run_id"])

    # X-Forwarded-For is not trusted by default, so rotating it does not help.
    third = public_client.post("/api/runs", json=body, headers={"X-Forwarded-For": "203.0.113.9"})
    assert third.status_code == 429
    assert int(third.headers["Retry-After"]) > 0


def test_public_demo_disables_probe_and_redacts_config(public_client):
    assert public_client.get("/api/provider/models").status_code == 403
    assert public_client.post("/api/runs/run_x/cancel").status_code == 404
    config = public_client.get("/api/config").json()
    assert config["base_url"] is None
    assert config["public_demo"]["enabled"] is True
    assert config["public_demo"]["execution_sandbox"] == "restricted"


def test_catalog_endpoint_lists_tasks_and_waves(public_client):
    body = public_client.get("/api/demo-tasks").json()
    assert body["mode"] == "public_demo"
    tasks = {task["id"]: task for task in body["tasks"]}
    assert set(tasks) == {task.id for task in demo_catalog()}
    assert tasks[PIPELINE_TASK_ID]["waves"] == [
        ["inspect_tests", "draft_implementation"],
        ["document_change"],
    ]


def test_capacity_limit_is_enforced(tmp_path):
    from app.service import CapacityError, RunService, _ActiveRun
    from app.store import RunStore

    store = RunStore(tmp_path / "cap.db")
    try:
        service = RunService(make_settings(tmp_path, max_concurrent_runs=1), store)
        service.check_capacity()
        service._active["run_busy"] = _ActiveRun(task=None)  # type: ignore[arg-type]
        with pytest.raises(CapacityError):
            service.check_capacity()
    finally:
        store.close()


# ----------------------------------------------------------------------
# rate limiter
# ----------------------------------------------------------------------
def test_sliding_window_limiter():
    limiter = SlidingWindowLimiter(limit=2, window_seconds=100)
    assert limiter.acquire("a", now=0) is None
    assert limiter.acquire("a", now=10) is None
    assert limiter.acquire("a", now=20) == 80
    assert limiter.acquire("b", now=20) is None  # buckets are per client
    assert limiter.acquire("a", now=100) is None  # the first hit expired
    assert SlidingWindowLimiter(limit=0).acquire("a") is None  # 0 = unlimited


def test_limiter_memory_is_bounded():
    limiter = SlidingWindowLimiter(limit=1, window_seconds=100, max_keys=3)
    for index in range(10):
        limiter.acquire(f"client-{index}", now=index)
    assert len(limiter._hits) <= 3
