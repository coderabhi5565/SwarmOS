from __future__ import annotations

import hmac
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.api_models import (
    BenchmarkCancelResponse,
    BenchmarkCreateRequest,
    BenchmarkExperimentDetail,
    BenchmarkExperimentListResponse,
    BenchmarkSuitesResponse,
    CancelResponse,
    ConfigResponse,
    DemoTaskInfo,
    DemoTasksResponse,
    HealthResponse,
    ProviderModelsResponse,
    RunEventsResponse,
    RunListResponse,
    RunMeasurements,
    RunStreamEnd,
    RunSummary,
)
from app.benchmarks import views as benchmark_views
from app.benchmarks.runner import ExperimentError, ExperimentRunner
from app.benchmarks.store import BenchmarkStore, ExperimentBusyError
from app.config import settings
from app.demo_tasks import DemoTaskError, demo_catalog
from app.events import openapi_components
from app.models import RunDetail, RunRequest
from app.providers import resolve_provider
from app.providers.base import ProbeableProvider, ProviderConfigError, ProviderError
from app.rate_limit import SlidingWindowLimiter
from app.redaction import PublicRedactor
from app.service import CapacityError, PublicDemoError, RunService
from app.store import RunStore
from app.streaming import (
    RunEventBroker,
    StreamLimitError,
    effective_cursor,
    parse_last_event_id,
    run_event_stream,
)
from app.timings.process import configure as configure_process_timings
from app.timings.view import measurements_view


@asynccontextmanager
async def lifespan(app: FastAPI):
    errors = settings.startup_errors()
    if errors:
        raise RuntimeError("refusing to start: " + "; ".join(errors))
    app.state.limiter = SlidingWindowLimiter(settings.runs_per_client_per_hour)
    # Process histograms follow the per-run timings setting (SWARMOS_TIMINGS).
    configure_process_timings(settings.timings_enabled)
    store = RunStore(settings.db_path)
    store.recover_interrupted("interrupted: the server stopped before this run finished")
    broker = RunEventBroker(settings.max_streams, settings.max_streams_per_client)
    store.add_commit_listener(broker.record_commit)
    store.add_listener(broker.notify)
    app.state.store = store
    app.state.broker = broker
    app.state.service = RunService(settings, store)
    # Experiments a stopped process left running are closed as interrupted
    # (after run recovery, so their runs are already closed); none resumes.
    app.state.experiments = ExperimentRunner(app.state.service, BenchmarkStore(store))
    app.state.experiments.recover_interrupted()
    try:
        yield
    finally:
        # Experiments first: each ends interrupted with its current run
        # cancelled, rather than starting another run during shutdown.
        await app.state.experiments.shutdown()
        await app.state.service.shutdown()
        store.close()


app = FastAPI(
    title="SwarmOS",
    version=__version__,
    description="Adaptive multi-agent coding orchestration with inspectable traces",
    lifespan=lifespan,
)

def _openapi() -> dict:
    """The generated schema, plus the typed trace payloads.

    Payloads travel inside ``TraceEvent.payload``, which no route names
    directly, so their models are added as components explicitly.
    """
    if app.openapi_schema is None:
        schema = get_openapi(
            title=app.title,
            version=app.version,
            description=app.description,
            routes=app.routes,
        )
        components = schema.setdefault("components", {}).setdefault("schemas", {})
        for name, definition in openapi_components().items():
            components.setdefault(name, definition)
        # The stream's end message is named only inside its event-stream
        # response, so its model is added as a component explicitly.
        components.setdefault(
            "RunStreamEnd",
            RunStreamEnd.model_json_schema(ref_template="#/components/schemas/{model}"),
        )
        # FastAPI types every non-JSON body as a string; the stream's
        # messages are described by the reference alone.
        stream = schema["paths"]["/api/runs/{run_id}/stream"]["get"]["responses"]["200"]
        stream["content"]["text/event-stream"]["schema"] = {
            "$ref": "#/components/schemas/RunStreamEnd"
        }
        app.openapi_schema = schema
    return app.openapi_schema


app.openapi = _openapi  # type: ignore[method-assign]

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


def _public_view() -> PublicRedactor | None:
    """How run data is shown: redacted in the public demo (no host paths,
    executed command lines, endpoint, key or addresses), as stored otherwise."""
    return PublicRedactor(settings) if settings.is_public_demo else None


def _public_text(text: str) -> str:
    view = _public_view()
    return view.text(text) if view is not None else text


def _detail(run_id: str) -> RunDetail:
    record = _store().get_run(run_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"run {run_id} not found")
    detail = RunDetail(run=record, events=_store().get_events(run_id))
    view = _public_view()
    return view.detail(detail) if view is not None else detail


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
            # An operator may configure an absolute interpreter path.
            "command": _public_text(settings.verification_command),
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
        raise HTTPException(status_code=400, detail=_public_text(str(exc))) from exc
    except DemoTaskError as exc:
        raise HTTPException(status_code=400, detail=_public_text(str(exc))) from exc
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
    view = _public_view()
    if view is not None:
        records = [view.run(record) for record in records]
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


@app.get("/api/runs/{run_id}/measurements")
async def get_run_measurements(run_id: str) -> RunMeasurements:
    """The run's stored timing measurements, or why it has none.

    Numbers, enums and validated ids only; the stored row is revalidated on
    read and, in the public demo, redacted like every other run response.
    """
    record = _store().get_run(run_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"run {run_id} not found")
    return measurements_view(_store(), record, public=_public_view())


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
    view = _public_view()
    return RunEventsResponse(
        run_id=run_id,
        events=[view.event(event) for event in events] if view is not None else events,
        # The cursor for the next poll: unchanged when nothing new arrived.
        last_seq=events[-1].seq if events else (after_seq or 0),
    )


class EventSourceResponse(StreamingResponse):
    media_type = "text/event-stream"


@app.get(
    "/api/runs/{run_id}/stream",
    response_class=EventSourceResponse,
    responses={
        200: {
            "description": (
                "Server-Sent Events. `trace` messages carry one TraceEvent (id = seq); "
                "`end` (RunStreamEnd) closes the stream once the run is terminal. "
                "Comment lines are keepalives."
            ),
            "content": {
                "text/event-stream": {"schema": {"$ref": "#/components/schemas/RunStreamEnd"}}
            },
        },
        400: {"description": "Malformed Last-Event-ID"},
        404: {"description": "Unknown run"},
        429: {"description": "Too many open streams"},
    },
)
async def stream_run_events(
    run_id: str,
    request: Request,
    after_seq: int | None = Query(
        default=None,
        ge=0,
        description=(
            "Send only events with seq greater than this cursor. With a "
            "Last-Event-ID header too, the stream starts after the greater of the two."
        ),
    ),
) -> EventSourceResponse:
    """A run's trace as it is recorded, then an ``end`` message.

    Read-only: it streams runs that exist, exactly the events
    ``/api/runs/{run_id}/events`` would return, and nothing else.
    """
    try:
        last_event_id = parse_last_event_id(request.headers.get("last-event-id"))
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail="Last-Event-ID must be a non-negative integer seq"
        ) from exc
    if _store().get_run(run_id) is None:
        raise HTTPException(status_code=404, detail=f"run {run_id} not found")
    broker: RunEventBroker = request.app.state.broker
    client = _client_key(request)
    try:
        broker.open(client)
    except StreamLimitError as exc:
        raise HTTPException(
            status_code=429, detail=str(exc), headers={"Retry-After": "15"}
        ) from exc
    view = _public_view()

    async def frames():
        try:
            async for frame in run_event_stream(
                _store(),
                broker,
                run_id,
                effective_cursor(after_seq, last_event_id),
                heartbeat_seconds=settings.stream_heartbeat_seconds,
                max_seconds=settings.stream_max_seconds,
                is_disconnected=request.is_disconnected,
                view=view.event if view is not None else None,
            ):
                yield frame
        finally:
            broker.close(client)

    return EventSourceResponse(
        frames(),
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ----------------------------------------------------------------------
# benchmarks (M6). Read-only in the public demo: visitors can inspect
# experiments on the public catalog suite; creating and cancelling are local.
# Recovery of experiments a stopped process left running is operator-only
# (startup, or `swarmos bench --recover`); there is no API for it.
# ----------------------------------------------------------------------
def _experiments() -> ExperimentRunner:
    return app.state.experiments


def _visible_experiment(experiment_id: str):
    """The experiment, or a 404: unknown and hidden (non-public in the
    public demo) look the same, so hidden ones are not disclosed."""
    experiment = _experiments().benchmarks.get_experiment(experiment_id)
    if experiment is None or not benchmark_views.is_visible(experiment, settings):
        raise HTTPException(status_code=404, detail=f"experiment {experiment_id} not found")
    return experiment


def _experiment_detail(experiment_id: str) -> BenchmarkExperimentDetail:
    experiment = _visible_experiment(experiment_id)
    trials = _experiments().benchmarks.get_trials(experiment_id)
    return benchmark_views.experiment_detail(experiment, trials, settings)


@app.get("/api/benchmarks/suites")
async def benchmark_suites() -> BenchmarkSuitesResponse:
    """The benchmark suites and arms this server offers (the public demo
    shows only public suites)."""
    return benchmark_views.suites_response(settings)


@app.get("/api/benchmarks/experiments")
async def list_benchmark_experiments(
    limit: int = Query(default=20, ge=1, le=50),
    cursor: str | None = Query(
        default=None,
        max_length=64,
        description="next_cursor from the previous page, to fetch older experiments",
    ),
) -> BenchmarkExperimentListResponse:
    """Newest-first experiments, paged like the run history."""
    benchmarks = _experiments().benchmarks
    try:
        page, next_cursor = benchmarks.list_experiments_page(
            limit, before=cursor, suite_ids=benchmark_views.visible_suite_ids(settings)
        )
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=f"unknown cursor: {cursor}") from exc
    return BenchmarkExperimentListResponse(
        experiments=[
            benchmark_views.experiment_summary(
                experiment, benchmarks.get_trials(experiment.experiment_id), settings
            )
            for experiment in page
        ],
        next_cursor=next_cursor,
    )


@app.get("/api/benchmarks/experiments/{experiment_id}")
async def get_benchmark_experiment(experiment_id: str) -> BenchmarkExperimentDetail:
    """An experiment with its provenance, per-arm aggregates and every trial
    (linked to its run). Unknown metric values are null, with reasons."""
    return _experiment_detail(experiment_id)


@app.post("/api/benchmarks/experiments", status_code=202)
async def create_benchmark_experiment(
    request: BenchmarkCreateRequest,
) -> BenchmarkExperimentDetail:
    """Create an experiment and start running it in the background.

    Fixed suites and arms only, by id: no goals, files, models or limits.
    Not available in the public demo.
    """
    _public_demo_only_allows("creating benchmark experiments")
    runner = _experiments()
    try:
        experiment = runner.create(
            request.suite_id,
            request.arm_ids,
            request.repetitions,
            origin="api",
            provider=request.provider,
            task_ids=request.task_ids,
            order_seed=request.order_seed,
        )
    except ExperimentBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ExperimentError as exc:
        raise HTTPException(
            status_code=400, detail=benchmark_views.redact(str(exc), settings)
        ) from exc
    runner.launch(experiment.experiment_id)
    return _experiment_detail(experiment.experiment_id)


@app.post("/api/benchmarks/experiments/{experiment_id}/cancel", status_code=202)
async def cancel_benchmark_experiment(experiment_id: str) -> BenchmarkCancelResponse:
    """Cancel an experiment running in this server process: its current run
    is cancelled and its remaining trials never start. Not in the public demo."""
    _public_demo_only_allows("cancelling benchmark experiments")
    experiment = _visible_experiment(experiment_id)
    if _experiments().cancel(experiment_id):
        return BenchmarkCancelResponse(experiment_id=experiment_id)
    if experiment.status not in {"queued", "running"}:
        raise HTTPException(
            status_code=409,
            detail=f"experiment {experiment_id} already finished: {experiment.status}",
        )
    raise HTTPException(
        status_code=409,
        detail=f"experiment {experiment_id} is not running in this server process",
    )


def spa_file(dist: Path, path: str) -> Path | None:
    """The file to answer a browser GET for ``path`` with, or None for a 404.

    The dashboard routes on the client (/runs/<id>, /console, ...), so any
    path that is not a built file gets index.html. Unknown API paths and
    missing assets (anything with a file extension) stay 404s, so a missing
    script is never answered with HTML. Paths cannot escape ``dist``.
    """
    if path == "api" or path.startswith("api/"):
        return None
    root = dist.resolve()
    candidate = (root / path).resolve()
    if candidate != root and root not in candidate.parents:
        return None
    if candidate.is_file():
        return candidate
    if "." in path.rsplit("/", 1)[-1]:
        return None
    return root / "index.html"


def mount_frontend(target: FastAPI, dist: Path) -> None:
    """Serve the built dashboard from ``dist`` with client-side routing."""
    target.mount("/assets", StaticFiles(directory=str(dist / "assets")), name="assets")

    @target.get("/{path:path}", include_in_schema=False)
    async def frontend(path: str) -> FileResponse:
        file = spa_file(dist, path)
        if file is None:
            raise HTTPException(status_code=404, detail="not found")
        return FileResponse(file)


# Serve the built React dashboard when it exists, so one process can run the MVP.
# Registered last, so every API route takes precedence over the catch-all.
_dist = Path(settings.frontend_dist)
if (_dist / "index.html").is_file():
    mount_frontend(app, _dist)
else:

    @app.get("/")
    async def root() -> dict:
        return {
            "service": "swarmos",
            "docs": "/docs",
            "ui": "Run `npm install && npm run dev` in frontend/ for the dashboard.",
        }