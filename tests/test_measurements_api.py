"""GET /api/runs/{id}/measurements (M7.2): the typed view of a run's stored
measurements, every reason a run can have none, nothing derived from
wall-clock event timestamps, stored rows revalidated on read, and the
public demo's redaction (fake canaries only)."""

from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.demo_tasks import PIPELINE_TASK_ID
from app.models import RunRecord, TraceEvent, utc_now
from app.store import MeasurementRow
from tests.conftest import make_settings, sign_up
from tests.test_public_redaction import (
    CANARY_ENDPOINT,
    CANARY_KEY,
    CANARY_URL,
    FORBIDDEN,
    PUBLIC,
    assert_clean,
)

TERMINAL = {"completed", "completed_with_findings", "review_invalid", "failed", "cancelled", "budget_exceeded", "limit_exceeded", "timed_out"}


@pytest.fixture
def local_client(tmp_path, monkeypatch):
    monkeypatch.setattr(main_module, "settings", make_settings(tmp_path))
    with TestClient(main_module.app) as client:
        yield client


@pytest.fixture
def public_client(tmp_path, monkeypatch):
    monkeypatch.setattr(main_module, "settings", make_settings(tmp_path, **PUBLIC, **CANARY_ENDPOINT))
    with TestClient(main_module.app) as client:
        sign_up(client)  # starting a run in the public demo needs an account
        yield client


def finish_a_run(client) -> str:
    response = client.post("/api/runs", json={"goal": "run the catalog task", "demo_task": PIPELINE_TASK_ID})
    assert response.status_code == 202, response.text
    run_id = response.json()["run"]["run_id"]
    store = client.app.state.store
    deadline = time.time() + 60
    while store.get_run(run_id).status not in TERMINAL or store.get_measurement(run_id) is None:
        assert time.time() < deadline
        time.sleep(0.05)
    return run_id


def measurements(client, run_id: str) -> dict:
    response = client.get(f"/api/runs/{run_id}/measurements")
    assert response.status_code == 200
    return response.json()


# ----------------------------------------------------------------------
# a measured run
# ----------------------------------------------------------------------
def test_a_finished_run_has_typed_measurements(local_client):
    run_id = finish_a_run(local_client)
    body = measurements(local_client, run_id)
    assert body["available"] is True and body["reason"] == "recorded"
    assert body["measurements_version"] == 1 and body["truncated"] is False and body["dropped_spans"] == 0
    phases = body["phases"]
    assert phases["lifecycle_ms"] >= phases["execution_ms"] >= phases["graph_ms"] > 0
    assert body["coder"]["busy_ms"] >= body["coder"]["wall_ms"] > 0
    assert body["agents"]["http_attempts"] == 0  # scripted provider
    assert body["verification"]["verification_ms"] > 0
    assert body["persistence"]["event_persist_writes"] == len(local_client.app.state.store.get_events(run_id))
    assert {"lifecycle", "graph", "node", "call", "verify.process"} <= {s["kind"] for s in body["spans"]}
    assert body["calls"] and body["steps"]
    assert body["unknown"]["slot_wait_ms"] == "parallel coding: no coding slot"
    lifecycle = next(s for s in body["spans"] if s["kind"] == "lifecycle")
    assert lifecycle["start_ms"] == 0 and lifecycle["attrs"]["outcome"] == "completed"


def test_an_unknown_run_is_404(local_client):
    assert local_client.get("/api/runs/run_doesnotexist/measurements").status_code == 404


# ----------------------------------------------------------------------
# every reason for no measurements
# ----------------------------------------------------------------------
def save(client, status: str, **fields) -> RunRecord:
    record = RunRecord(goal="a run without measurements", status=status, **fields)
    client.app.state.store.save_run(record)
    return record


def test_a_run_in_progress(local_client):
    record = save(local_client, "running")
    assert measurements(local_client, record.run_id)["reason"] == "run_in_progress"


def test_a_run_from_before_the_table(local_client):
    record = save(local_client, "completed", created_at="2026-01-01T00:00:00+00:00")
    body = measurements(local_client, record.run_id)
    assert (body["available"], body["reason"]) == (False, "predates_measurements")


@pytest.mark.parametrize(
    "marker, reason",
    [
        ("process_crash", "process_crash"),
        ("flush_failed", "measurement_flush_failed"),
        ("disabled", "instrumentation_disabled"),
    ],
)
def test_a_marker_says_why(local_client, marker, reason):
    record = save(local_client, "failed")
    local_client.app.state.store.add_measurement_marker(record.run_id, marker)
    body = measurements(local_client, record.run_id)
    assert (body["available"], body["reason"]) == (False, reason)
    assert body["phases"] is None and body["spans"] == []


def test_a_run_recovered_after_a_crash(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    monkeypatch.setattr(main_module, "settings", settings)
    with TestClient(main_module.app) as client:
        record = save(client, "running")
    with TestClient(main_module.app) as client:  # a restart: startup recovery
        body = measurements(client, record.run_id)
    assert body["reason"] == "process_crash"


def test_a_finished_run_with_nothing_on_record(local_client):
    record = save(local_client, "completed")  # after the table existed, no row
    assert measurements(local_client, record.run_id)["reason"] == "not_recorded"


def test_an_unreadable_row(local_client):
    record = save(local_client, "completed")
    local_client.app.state.store.save_terminal(
        record,
        MeasurementRow(run_id=record.run_id, status="recorded", collected_at=utc_now(), measurements_version=1, measurements_json="{not json"),
    )
    assert measurements(local_client, record.run_id)["reason"] == "unreadable"


def test_nothing_is_derived_from_event_timestamps(local_client):
    record = save(local_client, "completed")
    store = local_client.app.state.store
    for seq, kind in enumerate(("run_started", "agent_started", "agent_invocation", "run_finished"), start=1):
        store.append_event(TraceEvent(run_id=record.run_id, seq=seq, kind=kind, message=kind, payload={}))
    body = measurements(local_client, record.run_id)
    assert body["available"] is False
    for group in ("phases", "coder", "orchestration", "agents", "waits", "verification", "persistence"):
        assert body[group] is None
    assert body["spans"] == [] and body["calls"] == [] and body["steps"] == []


# ----------------------------------------------------------------------
# stored rows are revalidated; the public demo is redacted
# ----------------------------------------------------------------------
HOSTILE = {
    "version": 1,
    "enabled": True,
    "anchor_utc": "2026-11-03T00:00:00+00:00",
    "spans": [
        {"id": 1, "kind": "lifecycle", "parent": None, "start_ns": 0, "end_ns": 10_000_000, "attrs": {"outcome": "completed"}},
        {"id": 2, "kind": "graph", "parent": 1, "start_ns": 1, "end_ns": 9_000_000, "attrs": {"reason": r"C:\Users\canaryuser7f3a\secret"}},
        {"id": 3, "kind": "node", "parent": 2, "start_ns": 2, "end_ns": 8_000_000, "attrs": {"node": "/home/canaryuser7f3a/.ssh", "step_id": "sk-canary-0000000000000000000000"}},
        {"id": 4, "kind": "call", "parent": 3, "start_ns": 3, "end_ns": 7_000_000, "attrs": {"role": CANARY_URL, "outcome": "ok", "command": "python sandbox_launcher.py"}},
        {"id": 5, "kind": "verify.command", "parent": 3, "start_ns": 4, "end_ns": 5, "attrs": {}},
        {"id": "6", "kind": "node", "parent": 2, "start_ns": 0, "end_ns": 1, "attrs": {}},
    ],
    "dropped": {"call": 1, r"C:\Users\canaryuser7f3a": 3},
    "aggregates": {"append_event.write": {"count": 2, "sum_ns": 5, "max_ns": 3}, "10.66.77.88": {"count": 1}},
    "instrumentation_errors": 0,
    "self_ns": 100,
    "truncated": False,
}


@pytest.mark.parametrize(
    "client_fixture, step_id",
    [
        # Local mode returns validated ids as stored (as Run Detail does):
        # an id-shaped token passes, paths, URLs and hosts do not.
        ("local_client", CANARY_KEY),
        ("public_client", "[redacted]"),
    ],
)
def test_a_tampered_row_cannot_leak_through_the_response(request, client_fixture, step_id):
    client = request.getfixturevalue(client_fixture)
    record = save(client, "completed")
    client.app.state.store.save_terminal(
        record,
        MeasurementRow(
            run_id=record.run_id,
            status="recorded",
            collected_at="not a timestamp /home/canaryuser7f3a",
            measurements_version=1,
            measurements_json=json.dumps(HOSTILE),
        ),
    )
    response = client.get(f"/api/runs/{record.run_id}/measurements")
    assert response.status_code == 200
    host_details = [item for item in FORBIDDEN if item != CANARY_KEY]
    leaked = [item for item in host_details if item in response.text]
    assert not leaked, leaked
    if client_fixture == "public_client":
        assert_clean(response.text)
    body = response.json()
    assert body["available"] is True and body["collected_at"] is None
    assert {span["kind"] for span in body["spans"]} == {"lifecycle", "graph", "node", "call"}
    node = next(span for span in body["spans"] if span["kind"] == "node")
    assert node["attrs"] == {"node": "invalid", "step_id": step_id}
    call = next(span for span in body["spans"] if span["kind"] == "call")
    assert call["attrs"] == {"role": "invalid", "outcome": "ok"}  # "command" is not an attribute key
    assert body["dropped_by_kind"] == {"call": 1}
    assert body["persistence"]["event_persist_writes"] == 2


def test_a_real_public_run_shows_no_host_detail_in_its_measurements(public_client):
    run_id = finish_a_run(public_client)
    response = public_client.get(f"/api/runs/{run_id}/measurements")
    assert response.status_code == 200 and response.json()["available"] is True
    assert_clean(response.text)
    for forbidden in FORBIDDEN:
        assert forbidden not in json.dumps(response.json())
