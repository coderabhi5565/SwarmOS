"""FastAPI serving the built dashboard with client-side routing."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.main import mount_frontend, spa_file

INDEX = "<!doctype html><title>SwarmOS</title>"


@pytest.fixture
def dist(tmp_path):
    root = tmp_path / "dist"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text(INDEX, encoding="utf-8")
    (root / "assets" / "index-abc.js").write_text("console.log(1)", encoding="utf-8")
    (root / "favicon.svg").write_text("<svg/>", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("outside dist", encoding="utf-8")
    return root


@pytest.fixture
def client(dist):
    app = FastAPI()

    @app.get("/api/ping")
    async def ping() -> dict:
        return {"ok": True}

    mount_frontend(app, dist)
    return TestClient(app)


@pytest.mark.parametrize("path", ["/", "/console", "/runs/run_abc123", "/runs/run_abc123/trace"])
def test_client_side_routes_get_the_app(client, path):
    response = client.get(path)
    assert response.status_code == 200
    assert response.text == INDEX


def test_built_files_are_served_as_files(client):
    assert client.get("/assets/index-abc.js").text == "console.log(1)"
    assert client.get("/favicon.svg").text == "<svg/>"


def test_api_routes_take_precedence_and_unknown_api_paths_404(client):
    assert client.get("/api/ping").json() == {"ok": True}
    response = client.get("/api/does-not-exist")
    assert response.status_code == 404
    assert response.json() == {"detail": "not found"}


def test_missing_assets_are_404_not_html(client):
    assert client.get("/assets/index-missing.js").status_code == 404
    assert client.get("/robots.txt").status_code == 404


@pytest.mark.parametrize("path", ["../secret.txt", "assets/../../secret.txt", "..\\secret.txt"])
def test_paths_cannot_escape_dist(dist, path):
    assert spa_file(dist, path) in {None, dist.resolve() / "index.html"}
    assert spa_file(dist, path) != dist.parent / "secret.txt"
