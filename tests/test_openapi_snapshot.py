"""The frontend's generated API types must match the live backend contract."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _render() -> str:
    spec = importlib.util.spec_from_file_location(
        "export_openapi", ROOT / "scripts" / "export_openapi.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module.render()


def test_frontend_openapi_snapshot_is_current():
    committed = (ROOT / "frontend" / "openapi.json").read_text(encoding="utf-8")
    assert committed == _render(), (
        "The API contract changed but the frontend types were not regenerated. "
        "Run `npm run gen:api` in frontend/ (with the virtualenv active) and "
        "commit openapi.json and src/api/schema.d.ts."
    )
