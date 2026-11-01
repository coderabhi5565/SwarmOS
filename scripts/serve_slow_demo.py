"""Serve the real app with a slowed demo provider, for watching live runs.

Development only. Demo runs finish in about two seconds, too fast to see
live streaming, follow-live or active-call indicators. This wraps the
deterministic demo provider so each model call takes ``--delay`` seconds;
everything else (orchestration, events, the stream, verification) is the
production code, unchanged. It refuses to start in public_demo mode.

    python scripts/serve_slow_demo.py --delay 4 --port 8765 --db /tmp/slow.db
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--delay", type=float, default=4.0, help="seconds per model call")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--db", required=True, help="a scratch database path (never swarmos.db)")
    args = parser.parse_args()

    db = Path(args.db).resolve()
    if db == (ROOT / "swarmos.db").resolve():
        parser.error("use a scratch database, not the project's swarmos.db")
    os.environ["SWARMOS_DB_PATH"] = str(db)
    os.environ["SWARMOS_PROVIDER"] = "demo"
    os.environ.setdefault("SWARMOS_MODE", "local")
    if os.environ["SWARMOS_MODE"] != "local":
        parser.error("serve_slow_demo is for local development only")

    import uvicorn

    import app.service as service
    from app.providers.demo import DemoProvider

    class SlowDemoProvider(DemoProvider):
        async def complete(self, request):  # type: ignore[override]
            await asyncio.sleep(args.delay)
            return await super().complete(request)

    original = service.resolve_provider

    def resolve_slow(name, settings):
        provider, provider_name, warning = original(name, settings)
        if isinstance(provider, DemoProvider):
            provider = SlowDemoProvider()
            warning = f"Demo fixture slowed to {args.delay:g} s per call for development."
        return provider, provider_name, warning

    service.resolve_provider = resolve_slow
    uvicorn.run("app.main:app", host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
