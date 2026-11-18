from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from app import __version__, auth
from app.api_models import (
    AuthResponse,
    AuthUser,
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
    LoginRequest,
    MeResponse,
    ProviderModelsResponse,
    RegisterRequest,
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
    app.state.login_limiter = SlidingWindowLimiter(
        settings.login_attempts_per_client, window_seconds=15 * 60
    )
    app.state.register_limiter = SlidingWindowLimiter(settings.registrations_per_client_per_hour)
    # Process histograms follow the per-run timings setting (SWARMOS_TIMINGS).
    configure_process_timings(settings.timings_enabled)
    store = RunStore(settings.db_path)
    store.recover_interrupted("interrupted: the server stopped before this run finished")
    broker = RunEventBroker(settings.max_streams, settings.max_streams_per_client)
    store.add_commit_listener(broker.record_commit)
    store.add_listener(broker.notify)
    app.state.store = store
    app.state.auth = auth.AuthStore(store, settings.session_ttl_hours * 3600)
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
    # Sessions are cookies: a configured frontend origin may send them.
    allow_credentials=bool(settings.cors_origin_list),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def require_token(request: Request, call_next):
    """Optional bearer auth for the API (local mode).

    Execution endpoints can run code, so when SWARMOS_API_TOKEN is set every
    /api route requires it, account routes included. /health stays open for
    liveness checks. In the public demo the token is an operator credential
    instead (see _principal).
    """
    token = settings.api_token
    if (
        settings.api_token_gates_api
        and request.method != "OPTIONS"
        and request.url.path.startswith("/api")
    ):
        supplied = request.headers.get("authorization", "")
        expected = f"Bearer {token}"
        if not auth.same_secret(supplied, expected):
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


# ----------------------------------------------------------------------
# accounts and authorization (app.auth)
# ----------------------------------------------------------------------
def _auth() -> auth.AuthStore:
    return app.state.auth


def _bearer(request: Request) -> str | None:
    scheme, _, value = request.headers.get("authorization", "").partition(" ")
    return value.strip() if scheme.lower() == "bearer" and value.strip() else None


def _session_token(request: Request) -> str | None:
    """The session token a request carries: a bearer token, else the cookie."""
    bearer = _bearer(request)
    if bearer is not None:
        return bearer
    return request.cookies.get(auth.SESSION_COOKIE) or None


def _principal(request: Request) -> auth.Principal | None:
    """Who is asking: the operator API token, a signed-in user, or nobody."""
    bearer = _bearer(request)
    if bearer is not None and settings.api_token and auth.same_secret(bearer, settings.api_token):
        return auth.Principal(role="operator")
    token = _session_token(request)
    user = _auth().user_for_token(token) if token else None
    if user is None:
        return None
    return auth.Principal(role=auth.role_for(user.email, settings), user=user)


def _require_account(request: Request, action: str) -> auth.Principal | None:
    """In the public demo, ``action`` needs a signed-in user (401 otherwise).
    Locally nothing is required; the principal is returned if there is one."""
    principal = _principal(request)
    if principal is None and settings.is_public_demo:
        raise HTTPException(status_code=401, detail=f"sign in to {action}")
    return principal


def _require_operator(request: Request, action: str) -> None:
    """In the public demo, ``action`` needs the operator role."""
    principal = _require_account(request, action)
    if settings.is_public_demo and (principal is None or not principal.is_operator):
        raise HTTPException(status_code=403, detail=f"only operators may {action}")


def _auth_user(principal: auth.Principal) -> AuthUser:
    user = principal.user
    if user is None:
        return AuthUser(
            user_id=auth.API_TOKEN_SUBJECT,
            full_name="Operator (API token)",
            email=None,
            phone_masked=None,
            role=principal.role,
        )
    return AuthUser(
        user_id=user.user_id,
        full_name=user.full_name,
        email=user.email,
        phone_masked=auth.mask_phone(user.phone),
        role=principal.role,
    )


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        auth.SESSION_COOKIE,
        token,
        max_age=settings.session_ttl_hours * 3600,
        path="/",
        httponly=True,
        samesite="lax",
        # Behind the deployment's TLS proxy the cookie travels over HTTPS only.
        secure=settings.trust_proxy_headers,
    )


def _clear_session_cookie(response: Response) -> None:
    response.delete_cookie(
        auth.SESSION_COOKIE,
        path="/",
        httponly=True,
        samesite="lax",
        secure=settings.trust_proxy_headers,
    )


def _limit(limiter: SlidingWindowLimiter, request: Request, what: str) -> None:
    retry_after = limiter.acquire(_client_key(request))
    if retry_after is not None:
        raise HTTPException(
            status_code=429,
            detail=f"too many {what} from this client; retry in {retry_after}s",
            headers={"Retry-After": str(retry_after)},
        )


def _checked(check, value: str) -> str:
    try:
        return check(value)
    except auth.AuthInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError) -> Response:
    """FastAPI's 422, except that on account routes the submitted values are
    left out, so a password is never echoed back."""
    if request.url.path.startswith("/api/auth/"):
        errors = [
            {"type": error.get("type"), "loc": list(error.get("loc", ())), "msg": error.get("msg")}
            for error in exc.errors()
        ]
        return JSONResponse(status_code=422, content={"detail": errors})
    return await request_validation_exception_handler(request, exc)


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
        auth_required=settings.api_token_gates_api,
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
            "auth_required": settings.api_token_gates_api,
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


# ----------------------------------------------------------------------
# accounts
# ----------------------------------------------------------------------
@app.post("/api/auth/register", status_code=201)
async def register(body: RegisterRequest, request: Request, response: Response) -> AuthResponse:
    """Create an account and sign in. Email and phone are each unique (409)."""
    _limit(request.app.state.register_limiter, request, "registrations")
    full_name = _checked(auth.check_name, body.full_name)
    email = _checked(auth.normalize_email, body.email)
    phone = _checked(auth.normalize_phone, body.phone)
    password = _checked(auth.check_password, body.password)
    # scrypt takes tens of milliseconds: off the event loop.
    password_hash = await asyncio.to_thread(auth.hash_password, password)
    try:
        user = _auth().create_user(email, phone, full_name, password_hash, auth.role_for(email, settings))
    except auth.DuplicateAccountError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    _set_session_cookie(response, _auth().create_session(user.user_id))
    principal = auth.Principal(role=auth.role_for(user.email, settings), user=user)
    return AuthResponse(authenticated=True, user=_auth_user(principal))


@app.post("/api/auth/login")
async def login(body: LoginRequest, request: Request, response: Response) -> AuthResponse:
    """Sign in with an email or a phone number and the password (401 if wrong)."""
    _limit(request.app.state.login_limiter, request, "sign-in attempts")
    if len(body.password) > auth.MAX_PASSWORD or len(body.identifier) > auth.MAX_EMAIL:
        raise HTTPException(status_code=401, detail="incorrect email, phone or password")
    found = _auth().find_login(body.identifier)
    if found is None:
        await asyncio.to_thread(auth.burn_password_check, body.password)
        raise HTTPException(status_code=401, detail="incorrect email, phone or password")
    user, password_hash = found
    if not await asyncio.to_thread(auth.verify_password, body.password, password_hash):
        raise HTTPException(status_code=401, detail="incorrect email, phone or password")
    previous = request.cookies.get(auth.SESSION_COOKIE)
    if previous:
        _auth().revoke(previous)
    _set_session_cookie(response, _auth().create_session(user.user_id))
    principal = auth.Principal(role=auth.role_for(user.email, settings), user=user)
    return AuthResponse(authenticated=True, user=_auth_user(principal))


@app.post("/api/auth/logout")
async def logout(request: Request, response: Response) -> AuthResponse:
    """End this session (cookie or bearer). The API token cannot be revoked here."""
    token = _session_token(request)
    if token and not (settings.api_token and auth.same_secret(token, settings.api_token)):
        _auth().revoke(token)
    _clear_session_cookie(response)
    return AuthResponse(authenticated=False, user=None)


@app.get("/api/auth/me")
async def me(request: Request) -> MeResponse:
    principal = _principal(request)
    return MeResponse(
        authenticated=principal is not None,
        user=_auth_user(principal) if principal is not None else None,
        mode=settings.mode,
    )


# ----------------------------------------------------------------------
# runs
# ----------------------------------------------------------------------
@app.post("/api/runs", status_code=202)
async def create_run(
    request: RunRequest,
    http_request: Request,
    response: Response,
    wait: bool = Query(default=False, description="Execute inline instead of in the background"),
) -> RunDetail:
    service = _service()
    principal = _require_account(http_request, "start a run")
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
    if principal is not None:
        # Recorded before the run's task first runs, so no cancel can race it.
        _auth().set_run_owner(record.run_id, principal.subject)
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
async def cancel_run(run_id: str, request: Request) -> CancelResponse:
    """Cancel an active run. In the public demo a signed-in user may cancel
    the runs they started; an operator may cancel any run."""
    principal = _require_account(request, "cancel a run")
    record = _store().get_run(run_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"run {run_id} not found")
    if (
        settings.is_public_demo
        and principal is not None
        and not principal.is_operator
        and _auth().run_owner(run_id) != principal.subject
    ):
        raise HTTPException(status_code=403, detail="you can cancel only runs you started")
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
# benchmarks (M6). In the public demo visitors can inspect experiments on
# the public catalog suite; creating and cancelling need the operator role.
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
async def benchmark_suites(request: Request) -> BenchmarkSuitesResponse:
    """The benchmark suites and arms this server offers (the public demo
    shows only public suites, and lets only operators create)."""
    principal = _principal(request)
    return benchmark_views.suites_response(
        settings, operator=principal is not None and principal.is_operator
    )


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
    http_request: Request,
) -> BenchmarkExperimentDetail:
    """Create an experiment and start running it in the background.

    Fixed suites and arms only, by id: no goals, files, models or limits.
    In the public demo: operators only, public suites and the server's
    provider only.
    """
    _require_operator(http_request, "create benchmark experiments")
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
async def cancel_benchmark_experiment(
    experiment_id: str, request: Request
) -> BenchmarkCancelResponse:
    """Cancel an experiment running in this server process: its current run
    is cancelled and its remaining trials never start. In the public demo,
    operators only."""
    _require_operator(request, "cancel benchmark experiments")
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