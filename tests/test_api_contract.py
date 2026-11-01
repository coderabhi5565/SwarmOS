"""The public API contract the frontend relies on (M3.0)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.models import RunRecord, TraceEvent
from tests.conftest import make_settings

GOAL = "Implement tag normalization so the failing tests pass"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main_module, "settings", make_settings(tmp_path))
    with TestClient(main_module.app) as test_client:
        yield test_client


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
