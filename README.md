# SwarmOS

**Adaptive multi-agent coding orchestration — explicit state, bounded autonomy, and a trace you can audit.**

SwarmOS turns one coding goal into a plan, fans out independent coding subtasks in parallel, reviews the result, and runs the tests. Every agent invocation, routing decision, verification result, retry, escalation, and failure is recorded in SQLite and rendered in a React trace viewer.

It runs fully offline with a deterministic demo fixture, and against local open-weight models through any OpenAI-compatible endpoint (Ollama, vLLM, llama.cpp server, LM Studio). No paid API is required.

---

## Status, stated plainly

| Area | State |
| --- | --- |
| LangGraph orchestration, conditional routing, parallel dependency waves | Implemented, tested |
| Typed state and typed agent inputs/outputs | Implemented, tested |
| Bounded retries, revisions, escalations | Implemented, tested |
| Call, wall-clock, and conditional USD limits | Implemented, tested |
| SQLite runs and append-only trace | Implemented, tested |
| Real pytest verification in a temp workspace | Implemented, tested |
| Diagnostic verification on rejected runs | Real; recorded without changing the verdict |
| Reviewer evidence guard (`review_invalid`) | Implemented, tested; checks evidence shape only, not truth |
| OpenAI-compatible adapter (local first) | Implemented, mock-tested; used against local Ollama `qwen2.5-coder:1.5b` |
| Role → model-profile routing, honest fallback | Implemented, tested |
| React dashboard with provider/model provenance | Implemented, type-checked, built |
| Benchmark harness (fixed / adaptive / multi-agent) | Implemented, demo-measured |
| Live local-model end-to-end run | Performed with `qwen2.5-coder:1.5b`; **no run has reached `completed` yet** (see PROJECT_STATUS.md) |
| Restricted public demo mode (catalog tasks, code policy, audited test runner, rate limits) | Implemented, tested on Windows; Linux validation pending |
| Kernel sandbox / network isolation | **Not implemented** (not available on the free hosting target; see [safety](docs/safety.md)) |
| Live repository checkout, commit, or push | **Not implemented** |
| Multi-provider orchestration | **Not implemented** (one endpoint per run) |

Mock-HTTP tests prove the adapter's request/response handling. They are not evidence of a real inference call. See [docs/providers.md](docs/providers.md).

## Architecture

```mermaid
flowchart TD
    A[REST request] --> B[Planner]
    B --> C{Plan valid?}
    C -- no --> Z[Finalize: failed]
    C -- yes --> D[Dispatch wave<br/>independent steps only]
    D --> E1[Coder: step A]
    D --> E2[Coder: step B]
    E1 --> F[Advance: merge + conflict check]
    E2 --> F
    F --> G{More work?}
    G -- retry / next wave --> D
    G -- escalated retry --> H[Escalate: strong tier]
    H --> D
    G -- all steps done --> I[Reviewer]
    I --> J{Approved?}
    J -- request changes --> K[Revision round]
    K --> F
    J -- approve --> L[Verifier: real pytest]
    L --> M{Passed?}
    M -- no, repair left --> N[Repair round]
    N --> I
    M -- yes --> Z[Finalize: completed]
    M -- no, exhausted --> Z
```

Four roles:

- **Planner** — emits a `Plan` of steps with dependencies, acceptance criteria, and target files.
- **Coding Agent** — receives one step plus the workspace snapshot, returns complete-file `FileChange`s, and works in an isolated per-step checkout.
- **Review Agent** — inspects the merged workspace against acceptance criteria and returns `approve` or `request_changes` with typed findings.
- **Verification Agent** — no model: runs the configured command, captures exit code and output, and parses pass/fail counts.

Details: [architecture](docs/architecture.md), [providers](docs/providers.md), [safety](docs/safety.md), and the [audit](docs/audit.md) of the original prototype.

## Quickstart (offline demo)

Requires Python 3.11+. The demo needs no model and no credentials.

```bash
python -m venv .venv
# Windows PowerShell
.venv\Scripts\Activate.ps1
# macOS / Linux
# source .venv/bin/activate

pip install -e ".[dev]"
```

```bash
swarmos run "Implement tag normalization so the failing tests pass" --provider demo
swarmos trace <run_id>
```

The demo plans three steps, runs two in parallel, implements `normalize_tags`, writes change notes, reviews, and then really runs `python -m pytest -q` in the temporary workspace. Only the model's reasoning is scripted; verification and the trace are real.

## Local open-weight inference

Install and start a compatible runtime, then point SwarmOS at it. Example with Ollama:

```bash
ollama pull qwen2.5-coder:7b
ollama serve
```

`.env`:

```dotenv
SWARMOS_PROVIDER=openai
OPENAI_COMPAT_BASE_URL=http://127.0.0.1:11434/v1
OPENAI_COMPAT_API_KEY=
OPENAI_COMPAT_MODEL_FAST=qwen2.5-coder:7b
OPENAI_COMPAT_MODEL_STRONG=
```

Check reachability and whether your model id is actually present, without running inference:

```bash
swarmos doctor
```

Then run the constrained demo:

```bash
swarmos demo --provider openai
```

`swarmos demo` uses the canonical `sample_tag_normalization` recipe: one step, `target.py` only, and `tests/test_target.py` is read-only. The plan is supplied by the recipe, so the **planner model is skipped** and the trace says so. The **coder, reviewer, and verifier still run for real**, and verification executes the existing three tests with `python -m pytest -q`. Limits are 6 agent calls, 0 retries, 1 revision, 0 escalations, and the existing 120-second wall clock. Use `--provider demo` for the same recipe with the deterministic fixture.

For an unconstrained task:

```bash
swarmos run "Implement tag normalization so the failing tests pass" --provider openai \
  --policy adaptive --budget 0.50 --max-calls 8 --max-retries 1 --max-escalations 0
```

`--budget 0.50` is a soft USD cap. It only takes effect once you configure
token rates (`FAST_*_USD_PER_MILLION` and friends); with no rates configured the
cap is inactive and the call, time, retry, and revision limits are the real
controls. Do not pass `--budget 0` to mean "unlimited": when rates *are*
configured, a zero cap refuses every call and the run fails immediately with
`budget_exceeded`. Leave the default, or set a real cap.

`OPENAI_COMPAT_MODEL_STRONG` must be a **different** model id to enable escalation. If it is absent or identical, SwarmOS reports escalation as unavailable instead of calling the fast model twice. An API key is optional locally and required for hosted endpoints.

No hosted provider is assumed to be free, and SwarmOS does not assume any chat product exposes its internal models over HTTP.

## Providers and models

| Setting | Purpose |
| --- | --- |
| `SWARMOS_PROVIDER` | `auto` / `demo` / `openai` default |
| `OPENAI_COMPAT_BASE_URL` | endpoint root, including `/v1` if required |
| `OPENAI_COMPAT_API_KEY` | optional bearer token |
| `OPENAI_COMPAT_MODEL_FAST` | required fast profile |
| `OPENAI_COMPAT_MODEL_STRONG` | optional distinct strong profile |
| `SWARMOS_ROLE_MODELS` | e.g. `planner=strong,coder=fast,reviewer=strong` |
| `SWARMOS_MODEL_POLICY` | `config` / `fast_only` / `adaptive` / `role_routed` |
| `SWARMOS_JSON_MODE` | request JSON mode; downgraded once if rejected |

All four roles run the same graph under every policy; policies only change model selection and escalation. Full reference: [.env.example](.env.example) and [docs/providers.md](docs/providers.md).

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness, provider kind, auth status |
| `GET` | `/api/config` | Profiles, routing, caps, safety flags |
| `GET` | `/api/provider/models` | List models from the endpoint (no inference) |
| `POST` | `/api/runs?wait=true` | Create and execute a run inline |
| `POST` | `/api/runs` | Create a run in the background (`202`) |
| `GET` | `/api/runs?limit&cursor` | Run history, newest first: lightweight summaries (no file contents), paged with `next_cursor` |
| `GET` | `/api/runs/{id}` | Run record plus every trace event |
| `GET` | `/api/runs/{id}/events?after_seq` | Trace events in `seq` order; with `after_seq`, only newer ones. Returns `last_seq` for the next poll |
| `GET` | `/api/runs/{id}/stream?after_seq` | The trace as Server-Sent Events, live until the run ends (`id` = `seq`; resumes after the greater of `after_seq` and `Last-Event-ID`; `end` closes it). See [docs/architecture.md](docs/architecture.md#live-streaming) |
| `POST` | `/api/runs/{id}/cancel` | Cancel an in-flight run (`202`; `404` unknown, `409` finished or not active here; `403` in the public demo) |
| `GET` | `/api/demo-tasks` | The curated task catalog (the only runs the public demo accepts) |
| `GET` | `/api/benchmarks/suites` | Benchmark suites, arms and caps (the public demo lists only the catalog suite) |
| `GET` | `/api/benchmarks/experiments?limit&cursor` | Benchmark experiments, newest first, paged with `next_cursor` |
| `GET` | `/api/benchmarks/experiments/{id}` | An experiment: provenance, arm configurations, identical-by-design warnings, aggregates, and every trial with its run and metrics (unknowns null, with reasons) |
| `POST` | `/api/benchmarks/experiments` | Start an experiment on a fixed suite with fixed arms (`202`; `409` while another is active; `403` in the public demo) |
| `POST` | `/api/benchmarks/experiments/{id}/cancel` | Cancel an experiment running in this server (`202`; `409` finished or not running here; `403` in the public demo) |

Set `SWARMOS_API_TOKEN` to require `Authorization: Bearer <token>` on every `/api` route. The CLI refuses a non-loopback bind unless the token is set and `SWARMOS_ALLOW_REMOTE_BIND=1`.

### Dashboard

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173, proxying to the API on :8000
```

For a single process (FastAPI serves the build, including deep links such as `/runs/<id>`):

```bash
cd frontend && npm run build && cd ..
uvicorn app.main:app
# http://localhost:8000
```

The frontend is React 19, Vite 6, TypeScript, Tailwind CSS 4 and shadcn/ui, with
React Router, TanStack Query and Motion. Routes:

| Route | Page |
| --- | --- |
| `/` | Overview from live API data: demo catalog, recent runs, backend mode |
| `/runs/new` | Start a run from the curated task catalog (the only runs the public demo accepts) |
| `/runs/:runId` | One run from its normalised execution state: plan and waves, agents and the verification runner, trace, review, verification, model calls, budget, failures |
| `/console` | Live execution monitor: what is in flight right now, followed trace, counters |
| `/history` | Paginated run history |
| `/legacy` | The original dashboard (free-form goals, policy comparison); local mode only |

Every run view renders the frontend execution model
(`src/domain/execution`): a live run's events arrive over the event stream
(cursor polling takes over when the stream is unavailable) and are folded
through a pure reducer, and anything a trace does not record is shown as
unknown rather than invented. The console and Run Detail say how the run is
being received: streaming, reconnecting, polling fallback, offline, or
finished.

Run Detail can replay a run event by event (play, pause, step, scrub,
speed); the graph, details and every panel show the chosen point, while a
live run keeps updating underneath.

Run Detail and the console draw the execution as a graph
(`src/domain/visualization` builds one model for both views): planner,
coder steps by wave with their recorded dependencies, reviewer, and the
deterministic verification runner, with revisions, repairs, retries and the
escalated tier marked. The 2D graph (React Flow) needs no WebGL. The 3D
scene (React Three Fiber) is downloaded only when chosen and WebGL is
available; otherwise the 2D graph is shown with an explanation. Only work
the trace shows running is animated, and never under reduced motion.

API types are generated from the backend contract. After changing the API, run
`npm run gen:api` in `frontend/` with the virtualenv active and commit
`openapi.json` and `src/api/schema.d.ts`; a backend test fails if they drift.
Set `VITE_API_BASE_URL` (see `frontend/.env.example`) when the API is hosted on
another origin.

The console dashboard shows run status, dependency waves, agent invocations, routing decisions, verification
evidence, errors, resource meters, the actual provider kind, and the model used by each role. Demo runs are
labelled as fixtures. It also provides:

- **Provider status** - configured profiles, role routing, pricing state, and a model-list check
  against the endpoint. The check lists models only; it never runs inference.
- **Compare policies** - runs the same goal under `fast_only`, `adaptive`, and `role_routed`,
  then shows status, verification, calls, retries, escalations, revision rounds, duration,
  tokens and cost side by side. It warns when escalation is inert and never declares a winner.
  This starts three independent runs, so with a priced provider total spend can be up to
  three times a single run.
- **Download trace JSON** - the complete run record and every trace event for offline review.

## How autonomy is bounded

| Control | Behaviour |
| --- | --- |
| `max_agent_calls` | The ledger refuses the next call; the run ends `limit_exceeded` |
| `max_wall_seconds` | No call starts after the deadline; in-flight calls and verification are cut off at it; the run ends `timed_out` |
| `max_retries` | Coding attempts per step, plus repair rounds after failed verification |
| `max_revisions` | Revision rounds dispatched after a review rejection |
| `max_escalations` | Bounded switch to a configured strong profile |
| `max_budget_usd` | A **soft** cap, enforced only when both input and output token rates are configured. Not a hard limit — see below. |

USD honesty: with unknown pricing the run reports **"Monetary budget: NOT enforced"** and relies on call, time, retry, and revision limits. Even when rates are configured, the cap is **not a strict hard limit**: cost is reserved before a call and settled afterwards, so a call already in flight can exceed the cap by its own cost, and several parallel in-flight calls can collectively exceed the configured cap before any of them settles. The cap bounds the spend of calls that have not started yet; it does not bound the total spend of the run. The call count and the wall clock are the limits that are always enforced. Missing usage metadata is recorded as unavailable, never estimated.

## Execution safety

- A binary allowlist (`python`, `pytest`, …) and no shell.
- `SWARMOS_EXECUTION_ENABLED=0` disables execution entirely.
- Timeouts kill the process tree.
- Test subprocesses get a filtered environment without provider keys.
- Path traversal, absolute paths, and symlinks are refused.
- Real repository copying is opt-in and skips `.git`, `.env*`, keys, and databases.

This is containment, not a sandbox: there is no kernel isolation or network block. Do not expose the API publicly without authentication and a container. Full details: [docs/safety.md](docs/safety.md).

## Evaluation

```bash
swarmos bench --provider demo --out benchmarks/results/demo.jsonl
swarmos bench --provider openai --policy fixed-fast adaptive multi-agent --budget 0.50
```

All policies run the same graph and differ only in model selection. The harness records status, verification, calls, retries, escalations, duration, tokens, and cost **only when reported**. It withholds a cost comparison when usage or pricing is missing and never declares a winner.

`--budget` defaults to `0` for `bench`. As with `run`, a zero cap is not
"unlimited": once token rates are configured it refuses every call. Pass a real
cap such as `--budget 0.50`, or omit it when no rates are configured.

The summary warns explicitly when a policy that is supposed to escalate cannot
select a distinct stronger model. In that case the escalating policies produce
the same numbers as the non-escalating one **by construction**, so equal
results are not evidence that the policies are equivalent.

Tasks are in `benchmarks/tasks.jsonl`; results are written to `benchmarks/results/`, which is git-ignored.

Only one benchmark experiment may be active per database. An experiment is
owned by the process running it (an API server or a `bench` command), and
nothing records that ownership across processes. The API server closes
experiments left queued or running by a stopped process when it starts.
`swarmos bench --recover` does the same on demand and is **operator-only**:
run it only when you know no server or other `bench` process is still
running that experiment. If one is, the experiment is marked interrupted
under it: the trial in flight is recorded as an error (its run still
completes and stays linked, without metrics), and the owning process starts
no further trials. There is no API for recovery.

## Tests

```bash
python -m pytest
ruff check .
cd frontend && npm run typecheck && npm test && npm run build
```

The suite covers typed contracts, plan validation, routing, wave independence, parallel execution, conflict rejection, retries and escalation, budget and call limits, review revisions, verification repair, provider error classification, JSON-mode downgrade, workspace safety, persistence and migration, the benchmark harness, and the HTTP API.

## Project layout

```
app/
  orchestrator.py      LangGraph wiring, routing rules, run record assembly
  state.py             Explicit shared state and reducers
  models.py            Typed contracts for every agent boundary
  store.py             SQLite runs + append-only trace events, with migration
  streaming.py         Live trace streams (SSE): change broker, cursor rules
  service.py           Run lifecycle, provider/policy resolution, limit clamping
  main.py              FastAPI surface, optional auth, static dashboard
  benchmark.py         Reproducible policy comparison
  agents/              Planner, coder, reviewer, verifier, call runner
  providers/           Provider protocol, demo fixture, OpenAI-compatible adapter
  runtime/             Budget ledger, isolated workspace, trace recorder
frontend/src/          React app: app/ (shell, router), api/ (generated types, client, queries),
                       domain/, store/, pages/, components/ui (shadcn)
scripts/               export_openapi.py (frontend type generation), record_trace_fixtures.py,
                       serve_slow_demo.py (slowed demo provider for watching live runs; dev only)
samples/sample_project Failing-test fixture used by demo runs
tests/                 Pytest suite
docs/                  Architecture, providers, safety, audit
```

## Limitations

- Live runs so far used only `qwen2.5-coder:1.5b`. Its reviewer produced false
  blockers, which the evidence guard now stops as `review_invalid`; no live run
  has yet completed with an approved review and passing tests.
- One endpoint per run. No cross-provider fallback, so this is not yet multi-provider
  orchestration.
- Verification is contained by path checks, a filtered environment, a binary
  allowlist, and a timeout — not a kernel sandbox. Do not run untrusted code.
- Orchestration is in-process: no worker queue or checkpoint/resume. Runs can be
  cancelled, and runs interrupted by a restart are marked failed at startup,
  but they are not resumed.
- There is no live repository workflow (clone, branch, diff, commit, push).
- The planner is one model call; conflicting parallel writes are rejected rather than
  re-planned.
- The workspace snapshot is capped in characters and silently truncated at the limit;
  there is no token-aware context budgeting.
- The demo provider is scripted for the bundled sample. Use a configured model for
  custom seed files.
- Cost is an estimate from configured token rates, not a provider invoice.
- The API serves the built dashboard only when `frontend/dist` exists.

## Roadmap

1. Validate the adapter against a live local model and record the trace.
2. Durable checkpoint/resume and a worker-backed executor.
3. Container or namespace isolation for verification.
4. Live repository checkout with branch and diff support.
5. Token-aware context budgeting.
6. Comparative benchmark with recorded traces and measured results.

## License

MIT. See [LICENSE](LICENSE).
