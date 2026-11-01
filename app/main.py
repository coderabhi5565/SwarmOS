from __future__ import annotations

import hmac
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.api_models import (
    CancelResponse,
    ConfigResponse,
    DemoTaskInfo,
    DemoTasksResponse,
    HealthResponse,
    ProviderModelsResponse,
    RunEventsResponse,
    RunListResponse,
    RunSummary,
)
from app.config import settings
from app.demo_tasks import DemoTaskError, demo_catalog
from app.models import RunDetail, RunRequest
from app.providers import resolve_provider
from app.providers.base import ProbeableProvider, ProviderConfigError, ProviderError
from app.rate_limit import SlidingWindowLimiter
from app.service import CapacityError, PublicDemoError, RunService
from app.store import RunStore


@asynccontextmanager
async def lifespan(app: FastAPI):
    errors = settings.startup_errors()
    if errors:
        raise RuntimeError("refusing to start: " + "; ".join(errors))
    app.state.limiter = SlidingWindowLimiter(settings.runs_per_client_per_hour)
    store = RunStore(settings.db_path)
    store.recover_interrupted("interrupted: the server stopped before this run finished")
    app.state.store = store
    app.state.service = RunService(settings, store)
    try:
        yield
    finally:
        await app.state.service.shutdown()
        store.close()


app = FastAPI(
    title="SwarmOS",
    version=__version__,
    description="Adaptive multi-agent coding orchestration with inspectable traces",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
        *settings.cors_origin_list,
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def require_token(request: Request, call_next):
    """Optional bearer auth for the API.

    Execution endpoints can run code, so when SWARMOS_API_TOKEN is set every
    /api route requires it. /health stays open for liveness checks.
    """
    token = settings.api_token
    if token and request.method != "OPTIONS" and request.url.path.startswith("/api"):
        supplied = request.headers.get("authorization", "")
        expected = f"Bearer {token}"
        if not hmac.compare_digest(supplied, expected):
            return JSONResponse(
                status_code=401,
                content={"detail": "missing or invalid API token"},
                headers={"WWW-Authenticate": "Bearer"},
            )
    return await call_next(request)


def _service() -> RunService:
    return app.state.service


def _store() -> RunStore:
    return app.state.store


def _client_key(request: Request) -> str:
    """The rate-limit bucket for a caller.

    X-Forwarded-For is only honoured behind a trusted proxy; otherwise a
    caller could rotate the header to get a fresh bucket on every request.
    """
    if settings.trust_proxy_headers:
        forwarded = request.headers.get("x-forwarded-for", "")
        first = forwarded.split(",")[0].strip()
        if first:
            return first
    return request.client.host if request.client else "unknown"


def _public_demo_only_allows(feature: str) -> None:
    if settings.is_public_demo:
        raise HTTPException(
            status_code=403, detail=f"{feature} is not available in the public demo"
        )


def _detail(run_id: str) -> RunDetail:
    record = _store().get_run(run_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"run {run_id} not found")
    return RunDetail(run=record, events=_store().get_events(run_id))


@app.get("/health")
async def health() -> HealthResponse:
    return HealthResponse(
        version=__version__,
        mode=settings.mode,
        provider_mode=settings.provider,
        provider_kind=settings.provider_kind,
        openai_configured=settings.openai_configured,
        auth_required=bool(settings.api_token),
    )


@app.get("/api/demo-tasks")
async def demo_tasks() -> DemoTasksResponse:
    """The curated tasks a visitor may run. The only runs the public demo accepts."""
    return DemoTasksResponse(
        mode=settings.mode,
        tasks=[DemoTaskInfo.model_validate(task.describe()) for task in demo_catalog()],
    )


@app.get("/api/config")
async def config() -> ConfigResponse:
    sample_files: list[str] = []
    if settings.sample_project.is_dir():
        sample_files = sorted(
            str(path.relative_to(settings.sample_project)).replace("\\", "/")
            for path in settings.sample_project.rglob("*")
            if path.is_file() and "__pycache__" not in path.parts
        )
    described = settings.describe()
    if settings.is_public_demo:
        # Visitors see what the endpoint is (local or hosted, which models),
        # not where it is.
        described["base_url"] = None
    return ConfigResponse.model_validate({
        **described,
        "public_demo": {
            "enabled": settings.is_public_demo,
            "execution_sandbox": settings.execution_sandbox,
            "code_policy": settings.code_policy_enabled,
            "max_concurrent_runs": settings.max_concurrent_runs,
            "runs_per_client_per_hour": settings.runs_per_client_per_hour,
        },
        "caps": {
            "max_agent_calls": settings.max_agent_calls,
            "max_budget_usd": settings.max_budget_usd,
            "max_wall_seconds": settings.max_wall_seconds,
            "max_retries": settings.max_retries,
            "max_revisions": settings.max_revisions,
            "max_escalations": settings.max_escalations,
        },
        "verification": {
            "command": settings.verification_command,
            "timeout_seconds": settings.verification_timeout_seconds,
            "execution_enabled": settings.execution_enabled,
            "allowed_commands": sorted(settings.allowed_command_set),
            "repo_checkout_allowed": settings.allow_repo_checkout,
        },
        "api": {
            "auth_required": bool(settings.api_token),
            "remote_bind_allowed": settings.allow_remote_bind,
        },
        "sample_files": sample_files,
        "demo_fixture": not settings.openai_configured,
    })


@app.get("/api/provider/models")
async def provider_models() -> ProviderModelsResponse:
    """List models from the configured endpoint. No inference, no cost."""
    # An open probe would let anyone make this server call its model endpoint.
    _public_demo_only_allows("the endpoint probe")
    provider, name, warning = resolve_provider("auto", settings)
    if not isinstance(provider, ProbeableProvider):
        return ProviderModelsResponse(
            provider=name,
            kind="demo",
            ok=True,
            detail="demo fixture; no endpoint to probe",
            warning=warning,
        )
    try:
        result = await provider.health()
    except ProviderError as exc:
        return ProviderModelsResponse(provider=name, ok=False, detail=str(exc))
    return ProviderModelsResponse.model_validate(
        {"provider": name, "kind": settings.provider_kind, **result}
    )


@app.post("/api/runs", status_code=202)
async def create_run(
    request: RunRequest,
    http_request: Request,
    response: Response,
    wait: bool = Query(default=False, description="Execute inline instead of in the background"),
) -> RunDetail:
    service = _service()
    if wait:
        # An inline run holds a connection open for the whole run.
        _public_demo_only_allows("wait=true")
    try:
        service.check_public_demo(request)
        service.check_capacity()
    except PublicDemoError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except CapacityError as exc:
        raise HTTPException(
            status_code=429, detail=str(exc), headers={"Retry-After": "30"}
        ) from exc
    # Only requests that would actually start a run count against the limit.
    retry_after = http_request.app.state.limiter.acquire(_client_key(http_request))
    if retry_after is not None:
        raise HTTPException(
            status_code=429,
            detail=f"run limit reached for this client; retry in {retry_after}s",
            headers={"Retry-After": str(retry_after)},
        )
    try:
        if wait:
            record = await service.run_request(request)
            response.status_code = 200
        else:
            record = service.submit(request)
    except ProviderConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except DemoTaskError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except CapacityError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    return _detail(record.run_id)


@app.get("/api/runs")
async def list_runs(
    limit: int = Query(default=25, ge=1, le=200),
    cursor: str | None = Query(
        default=None,
        description="next_cursor from the previous page, to fetch older runs",
    ),
) -> RunListResponse:
    """Newest-first run history. Lightweight: no plan details, review text,
    verification output, summary, or generated file contents; fetch
    /api/runs/{run_id} for those."""
    try:
        records, next_cursor = _store().list_runs_page(limit, before=cursor)
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=f"unknown cursor: {cursor}") from exc
    return RunListResponse(
        runs=[RunSummary.from_record(record) for record in records],
        next_cursor=next_cursor,
    )


@app.get("/api/runs/{run_id}", response_model=RunDetail)
async def get_run(run_id: str) -> RunDetail:
    return _detail(run_id)


@app.post("/api/runs/{run_id}/cancel", status_code=202)
async def cancel_run(run_id: str) -> CancelResponse:
    # Without accounts, any visitor could cancel any other visitor's run.
    # Demo runs are short and bounded, so cancellation is simply off there.
    _public_demo_only_allows("cancelling runs")
    record = _store().get_run(run_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"run {run_id} not found")
    if _service().cancel(run_id):
        return CancelResponse(run_id=run_id)
    if record.status not in {"queued", "running"}:
        raise HTTPException(
            status_code=409, detail=f"run {run_id} already finished: {record.status}"
        )
    raise HTTPException(
        status_code=409, detail=f"run {run_id} is not active in this server process"
    )


@app.get("/api/runs/{run_id}/events")
async def get_run_events(
    run_id: str,
    after_seq: int | None = Query(
        default=None,
        ge=0,
        description=(
            "Return only events with seq greater than this cursor. Omit for the "
            "full trace. Poll with the previous response's last_seq."
        ),
    ),
) -> RunEventsResponse:
    if _store().get_run(run_id) is None:
        raise HTTPException(status_code=404, detail=f"run {run_id} not found")
    events = _store().get_events(run_id, after_seq=after_seq)
    return RunEventsResponse(
        run_id=run_id,
        events=events,
        # The cursor for the next poll: unchanged when nothing new arrived.
        last_seq=events[-1].seq if events else (after_seq or 0),
    )


# Serve the built React dashboard when it exists, so one process can run the MVP.
_dist = Path(settings.frontend_dist)
if (_dist / "index.html").is_file():
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="ui")
else:

    @app.get("/")
    async def root() -> dict:
        return {
            "service": "swarmos",
            "docs": "/docs",
            "ui": "Run `npm install && npm run dev` in frontend/ for the dashboard.",
        }