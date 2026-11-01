"""The public API contract the frontend relies on (M3.0)."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.models import RunRecord, TraceEvent
from tests.conftest import make_settings

GOAL = "Implement tag normalization so the failing tests pass"
SECRET_KEY = "sk-contract-test-secret-000"
PRIVATE_URL = "http://10.20.30.40:11434/v1"
PUBLIC = {
    "mode": "public_demo",
    "execution_sandbox": "restricted",
    "code_policy_enabled": True,
}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main_module, "settings", make_settings(tmp_path))
    with TestClient(main_module.app) as test_client:
        yield test_client


def client_with(tmp_path, monkeypatch, **overrides) -> TestClient:
    monkeypatch.setattr(main_module, "settings", make_settings(tmp_path, **overrides))
    return TestClient(main_module.app)


# ----------------------------------------------------------------------
# typed responses
# ----------------------------------------------------------------------
def test_every_api_response_is_a_named_schema():
    spec = main_module.app.openapi()
    for path, operations in spec["paths"].items():
        if not (path.startswith("/api") or path == "/health"):
            continue
        for method, operation in operations.items():
            success = next(code for code in operation["responses"] if code.startswith("2"))
            content = operation["responses"][success]["content"]
            # JSON everywhere, except the live trace stream (Server-Sent
            # Events), whose messages are named the same way.
            media = "text/event-stream" if path.endswith("/stream") else "application/json"
            assert list(content) == [media], f"{method.upper()} {path} serves {list(content)}"
            schema = content[media]["schema"]
            assert "$ref" in schema, f"{method.upper()} {path} has an untyped response"


def test_health_is_typed(client):
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["mode"] == "local"
    assert set(body) == {
        "status", "service", "version", "mode", "provider_mode",
        "provider_kind", "openai_configured", "auth_required",
    }


def test_demo_tasks_are_typed(client):
    body = client.get("/api/demo-tasks").json()
    pipeline = next(task for task in body["tasks"] if task["id"] == "sample_parallel_pipeline")
    gamma = next(step for step in pipeline["steps"] if step["id"] == "document_change")
    assert gamma["depends_on"] == ["inspect_tests", "draft_implementation"]
    assert pipeline["limits"]["max_agent_calls"] == 10


@pytest.mark.parametrize("public", [False, True])
def test_config_never_exposes_the_api_key(tmp_path, monkeypatch, public):
    overrides = {"base_url": PRIVATE_URL, "fast_model": "m", "api_key": SECRET_KEY}
    if public:
        overrides.update(PUBLIC)
    with client_with(tmp_path, monkeypatch, **overrides) as client:
        body = client.get("/api/config").json()
    assert SECRET_KEY not in json.dumps(body)
    assert body["auth_configured"] is True
    if public:
        assert body["base_url"] is None
        assert PRIVATE_URL not in json.dumps(body)
        assert body["public_demo"]["enabled"] is True
    else:
        assert body["base_url"] == PRIVATE_URL


# ----------------------------------------------------------------------
# run list
# ----------------------------------------------------------------------
def test_run_list_is_lightweight(client):
    run = inline_run(client)["run"]
    assert run["artifacts"]  # the full record does carry file contents

    (listed,) = client.get("/api/runs").json()["runs"]
    for heavy in ("artifacts", "plan", "review", "verification", "summary"):
        assert heavy not in listed
    assert listed["run_id"] == run["run_id"]
    assert listed["changed_files"] == run["changed_files"]
    assert listed["plan_step_count"] == len(run["plan"]["steps"])
    assert listed["review_verdict"] == run["review"]["verdict"]
    assert listed["verification_passed"] is True
    assert listed["verification_diagnostic"] is False


def seed_runs(store, count: int) -> list[str]:
    ids = []
    for index in range(count):
        record = RunRecord(
            run_id=f"run_{index:02d}",
            goal=f"goal number {index}",
            status="completed",
            created_at=f"2026-11-01T10:00:{index:02d}+00:00",
        )
        store.save_run(record)
        ids.append(record.run_id)
    return ids[::-1]  # newest first


def test_run_list_pages_newest_first_without_gaps_or_repeats(client):
    expected = seed_runs(client.app.state.store, 5)

    seen, cursor, pages = [], None, 0
    while True:
        params = {"limit": 2} | ({"cursor": cursor} if cursor else {})
        body = client.get("/api/runs", params=params).json()
        seen += [run["run_id"] for run in body["runs"]]
        pages += 1
        cursor = body["next_cursor"]
        if cursor is None:
            break

    assert seen == expected
    assert pages == 3


def test_new_runs_do_not_shift_later_pages(client):
    store = client.app.state.store
    expected = seed_runs(store, 4)
    first = client.get("/api/runs", params={"limit": 2}).json()

    store.save_run(RunRecord(run_id="run_new", goal="arrived later", created_at="2026-11-01T11:00:00+00:00"))
    second = client.get("/api/runs", params={"limit": 2, "cursor": first["next_cursor"]}).json()

    assert [run["run_id"] for run in second["runs"]] == expected[2:]


def test_ties_on_created_at_are_paged_stably(client):
    store = client.app.state.store
    for suffix in "abcd":
        store.save_run(RunRecord(run_id=f"run_{suffix}", goal="same instant", created_at="2026-11-01T10:00:00+00:00"))
    first = client.get("/api/runs", params={"limit": 2}).json()
    second = client.get("/api/runs", params={"limit": 2, "cursor": first["next_cursor"]}).json()
    ids = [run["run_id"] for run in first["runs"] + second["runs"]]
    assert sorted(ids) == ["run_a", "run_b", "run_c", "run_d"]
    assert len(set(ids)) == 4


def test_run_list_rejects_bad_paging_input(client):
    assert client.get("/api/runs", params={"cursor": "run_missing"}).status_code == 400
    assert client.get("/api/runs", params={"limit": 0}).status_code == 422
    assert client.get("/api/runs", params={"limit": 201}).status_code == 422


def inline_run(client) -> dict:
    response = client.post("/api/runs?wait=true", json={"goal": GOAL, "provider": "demo"})
    assert response.status_code == 200
    return response.json()


# ----------------------------------------------------------------------
# event cursor
# ----------------------------------------------------------------------
def test_events_without_a_cursor_return_the_full_trace(client):
    run = inline_run(client)
    body = client.get(f"/api/runs/{run['run']['run_id']}/events").json()

    seqs = [event["seq"] for event in body["events"]]
    assert seqs == list(range(1, len(seqs) + 1))
    assert body["last_seq"] == seqs[-1]
    assert len(body["events"]) == len(run["events"])


def test_after_seq_returns_only_newer_events_in_order(client):
    run_id = inline_run(client)["run"]["run_id"]
    full = client.get(f"/api/runs/{run_id}/events").json()["events"]

    body = client.get(f"/api/runs/{run_id}/events", params={"after_seq": 3}).json()
    assert [event["seq"] for event in body["events"]] == [e["seq"] for e in full[3:]]
    assert body["last_seq"] == full[-1]["seq"]

    caught_up = client.get(
        f"/api/runs/{run_id}/events", params={"after_seq": full[-1]["seq"]}
    ).json()
    assert caught_up["events"] == []
    assert caught_up["last_seq"] == full[-1]["seq"]


@pytest.mark.parametrize("cursor", ["-1", "abc", "1.5"])
def test_invalid_cursors_are_rejected(client, cursor):
    run_id = inline_run(client)["run"]["run_id"]
    response = client.get(f"/api/runs/{run_id}/events", params={"after_seq": cursor})
    assert response.status_code == 422


def test_cursor_on_unknown_run_is_404(client):
    assert client.get("/api/runs/run_missing/events?after_seq=0").status_code == 404


def test_cursor_follows_an_active_run(client):
    store = client.app.state.store
    record = RunRecord(goal="still running", status="running")
    store.save_run(record)

    def emit(seq: int) -> None:
        store.append_event(TraceEvent(run_id=record.run_id, seq=seq, kind="warning", message=f"e{seq}"))

    emit(1)
    emit(2)
    first = client.get(f"/api/runs/{record.run_id}/events").json()
    assert first["last_seq"] == 2

    emit(3)  # the run keeps going between polls
    second = client.get(
        f"/api/runs/{record.run_id}/events", params={"after_seq": first["last_seq"]}
    ).json()
    assert [event["message"] for event in second["events"]] == ["e3"]
    assert second["last_seq"] == 3


# ----------------------------------------------------------------------
# public demo safety on the new surface
# ----------------------------------------------------------------------
def test_no_public_response_leaks_the_endpoint_or_key(tmp_path, monkeypatch):
    """A full public catalog run: config, history, detail and events stay clean.

    The provider is configured with a private URL and key, but the request
    is served by the demo fixture (provider=auto resolves to the configured
    default, "demo"), so the run completes without any network access.
    """
    import time

    overrides = {**PUBLIC, "base_url": PRIVATE_URL, "fast_model": "m", "api_key": SECRET_KEY}
    with client_with(tmp_path, monkeypatch, **overrides) as client:
        created = client.post(
            "/api/runs", json={"goal": "catalog run", "demo_task": "sample_tag_normalization"}
        )
        assert created.status_code == 202
        run_id = created.json()["run"]["run_id"]
        deadline = time.time() + 60
        while client.get(f"/api/runs/{run_id}").json()["run"]["status"] in {"queued", "running"}:
            assert time.time() < deadline
            time.sleep(0.1)

        bodies = [
            client.get("/api/config").text,
            client.get("/api/runs").text,
            client.get(f"/api/runs/{run_id}").text,
            client.get(f"/api/runs/{run_id}/events").text,
            client.get(f"/api/runs/{run_id}/events", params={"after_seq": 2}).text,
            client.get("/api/demo-tasks").text,
            client.get("/health").text,
        ]
        # The restrictions themselves are unchanged by the new parameters.
        assert client.post("/api/runs", json={"goal": "arbitrary goal text"}).status_code == 403
        assert client.post(f"/api/runs/{run_id}/cancel").status_code == 403
        assert client.get("/api/provider/models").status_code == 403

    for body in bodies:
        assert SECRET_KEY not in body
        assert PRIVATE_URL not in body
        assert "10.20.30.40" not in body


def test_response_schemas_mark_always_present_fields_required():
    """Clients generated from OpenAPI must not see always-present response
    fields as optional, while requests and event payloads keep true optionals."""
    schemas = main_module.app.openapi()["components"]["schemas"]

    def required(name: str) -> set[str]:
        return set(schemas[name].get("required", []))

    assert {"run_id", "created_at", "status", "limits", "artifacts"} <= required("RunRecord")
    assert {"event_id", "seq", "at", "payload"} <= required("TraceEvent")
    assert {"depends_on", "target_files"} <= required("PlanStep")
    assert {"runs", "next_cursor"} <= required("RunListResponse")
    # A request body only requires what the server cannot default.
    assert required("RunRequest") == {"goal"}
    assert required("Limits-Input") == set()
    # Event payload keys that may genuinely be absent stay optional.
    assert "step_id" not in required("AgentStartedPayload")
    assert required("FailurePayload") == {"error"}
