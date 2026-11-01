"""Write the FastAPI OpenAPI schema to a file, without starting a server.

Used by ``npm run gen:api`` in frontend/ to generate TypeScript types from the
backend contract. Run it with the project's virtualenv Python:

    python scripts/export_openapi.py frontend/openapi.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.main import app  # noqa: E402 - needs the repository root on sys.path


def render() -> str:
    """The schema as stable, diff-friendly JSON."""
    return json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n"


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: export_openapi.py <output.json>", file=sys.stderr)
        return 2
    Path(argv[1]).write_text(render(), encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
