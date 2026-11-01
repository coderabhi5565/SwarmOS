# SwarmOS project status

Last updated: 2026-11-01

## Scope

Portfolio flagship, not commercial SaaS: a genuinely working orchestrator,
publicly deployed for ₹0/month, with a premium React + Three.js UI driven by
real backend events. No billing, organizations, or heavy infrastructure.

Milestones (revised 2026-11-01):

- M0 stabilize ✅
- M1 orchestration and API reliability ✅
- M2 restricted demo execution ✅ (Linux validation pending, in M7)
- M3.0 backend contract for the frontend ✅
- M3.1 frontend foundation ✅
- M3.2 event reducer and replay engine ✅
- M3.3 execution interface (new run, run detail, live console, history) ✅
- M4 Three.js agent network
- M5 integration
- M6 benchmarks, docs, landing page
- M7 security review, testing, free deployment
- M8 release

## Current milestone

**M3.3 — Execution interface: complete** (on `main`; M3.2 pushed, M3.3 not yet pushed).
Next: **M4 — agent network visualisation**, awaiting approval.

## Validation at the last milestone boundary

| Check | Result |
| --- | --- |
| `python -m pytest` | 351 passed, 2 skipped (symlink test needs privilege on Windows; POSIX rlimit test is Linux-only) |
| frontend `npm run typecheck` / `npm test` / `npm run build` | clean / 122 passed (16 files) / builds |
| `ruff format --check` | not configured; the codebase has never been formatted (56/62 files would change before M3.0) |
| `ruff check .` | clean |
| `npx tsc --noEmit` (frontend) | clean |
| `npm run build` (frontend) | builds |
| Live local-model run with the guard | **not yet performed** |

Suite wall time varies a lot on this machine (80 s to 300 s for the same code).
Most of it is real `pytest` subprocesses spawned by verification tests.

## Completed

### M3.3 — execution interface

- **`useExecution(runId)`** keeps a cached `ExecutionState` current: each
  poll fetches `after_seq` and folds the page through the reducer, so
  duplicates are no-ops. It polls only while the run is live, makes one
  final fetch when the run ends, and closes a trace that never finished
  with `settleWithRecord`.
- **Shared components** (`src/components/execution/`) render normalised
  state only. Unknowns are explicit: "not recorded", "not reported",
  "dependencies not recorded". The verifier is shown as a deterministic
  runner. Only current activity is animated.
- **Pages:**
  - `/runs/new`: catalog only, with actionable 403/422/429 and
    waking-server messages;
  - `/runs/:runId`: the full execution view;
  - `/console`: the live monitor (in-flight calls only, followed trace,
    connection state);
  - `/history`: cursor-paged, no trace fetches;
  - `/legacy`: the old dashboard, local mode only.
- **Visual check:** verified against a real public-demo backend with
  headless screenshots. This found and fixed pulsing badges on past
  timeline events.
- **Process note:** `ac6b9b9` was committed while two page tests were
  failing in the full suite (an ungated `;` before `git commit`); it is
  fixed in `32e77c2` (lazy-route load timing), and later commits are gated
  on the suite passing.

### M3.2 — event reducer and replay engine

- **`frontend/src/domain/execution/`** (framework-free domain layer):
  - `events.ts` (compatibility boundary);
  - `model.ts` (normalised state);
  - `reducer.ts` (pure, seq-ordered, idempotent, rebuilds on late events);
  - `replay.ts` (replay to a seq; memoised, scrubbable frames).
- **Fixtures recorded from the real backend** by
  `scripts/record_trace_fixtures.py`:
  - nine current-contract scenarios: pipeline, parallel overlap, review
    revision, review_invalid, verification repair, retry and escalation,
    call limit, timed out, cancelled mid-call;
  - three historical qwen2.5-coder:1.5b runs exported read-only, spanning
    three pre-M3.0 trace generations.
- **Tests:** 53 domain tests (normalisation, the 22 reducer behaviours,
  replay and determinism).

### M3.1 — frontend foundation

- **Stack:** React 19.3, Vite 6.4, TypeScript 5.9, Tailwind CSS 4.3,
  shadcn/ui (Radix, radix-nova preset), React Router 7.18,
  TanStack Query 5.105, Motion 12.43 (LazyMotion), Zustand 5.0, and
  Vitest 5.0 with Testing Library and jsdom.
- **Contract types:** generated from the backend by `npm run gen:api`
  (`scripts/export_openapi.py` + openapi-typescript). A backend snapshot
  test fails on drift.
- **Query layer:** retries for a sleeping free-tier backend (never 4xx);
  incremental event polling with `after_seq`; a paged history.
- **Shell:** a glass header with a live backend status ("waking" during
  cold starts); `/` overview from real API data; `/console` keeps the
  original dashboard unchanged; `/runs/:runId` deep links; 404 page.
  FastAPI serves client-side routes.
- **Design tokens:** dark navy, electric blue, cyan and violet, plus
  semantic status and agent-role colors; Inter and JetBrains Mono;
  reduced-motion support.
- **Zustand:** view state only (selection scoped to a run, 2D/3D mode,
  follow live).
- **Found and fixed during visual checks:** demo-fixture runs were recorded
  as "local" when an endpoint was configured (backend), and the status
  label (frontend).
- **Bundle:** 101 kB entry (36 kB gzip), plus cached vendor chunks; the
  console and run pages load lazily.

Accepted advisory: openapi-typescript → @redocly/openapi-core →
minimatch 5 (moderate ReDoS, GHSA-g3hv-75wg-m249). It is dev-only, only
parses our own schema, and no patched release exists below minimatch 11.

### M3.0 — backend contract for the frontend

- **Typed responses:** every `/api` route and `/health` has a response model
  (`app/api_models.py`).
- **Run list:** returns lightweight `RunSummary` rows (no file contents),
  paged with a keyset `cursor` / `next_cursor`.
- **Event cursor:** `GET /api/runs/{id}/events?after_seq=` returns only newer
  events, plus `last_seq` for the next poll.
- **Typed payloads:** every event payload is validated on emit by a strict
  per-kind model (`app/events.py`), published in OpenAPI as
  `TraceEventPayloads`.
- **Lifecycle events:**
  - `agent_started` / `agent_invocation` are paired by `invocation_id`;
  - `verification_started` / `verification` are paired by `verification_id`.
- **Plan events** carry the validated plan, so `depends_on` and waves are
  available from the trace alone.
- **Failure events** are normalised: `error` always; `error_class`, `role`,
  `step_id` and `attempt` where they apply. Three coding rejections that were
  previously silent now emit failures.
- **Tests:** `tests/test_api_contract.py` and `tests/test_event_contract.py`.

### M2 — restricted public demo execution

Free hosting (Render free tier) cannot run containers inside the app, so
there is no Docker sandbox. `SWARMOS_MODE=public_demo` layers these
restrictions instead (details in `docs/safety.md`):

- **Curated tasks only.** `GET /api/demo-tasks` lists them:
  `sample_tag_normalization` (1 step) and `sample_parallel_pipeline` (2 waves,
  with parallel steps).
- **Static code policy** for generated code (`app/runtime/code_policy.py`).
- **Restricted pytest launcher** with an audit hook and POSIX rlimits
  (`app/runtime/sandbox_launcher.py`). `Workspace(sandbox="restricted")`
  routes verification through it.
- **Abuse limits:** per-client rate limit (`app/rate_limit.py`) and a cap on
  concurrent runs. The endpoint probe, cancellation, and inline runs are
  disabled, and `base_url` is redacted.
- **Fails closed:** the app refuses to start if a safety layer is off
  (`Settings.startup_errors`).
- Configurable CORS origins for the deployed frontend.
- Tests: `tests/test_public_demo.py` (40 items). Hostile tests prove that
  network, subprocess, reads and listings outside the workspace, writes
  outside it, and `ctypes` are refused. Both catalog tasks complete under the
  public profile, including a real parallel wave.

### M1 — backend reliability

- **Revisions:** every actionable finding for each step reaches the coder.
  Findings without a known step reach every revised step. Unsupported blockers
  are withheld and listed in the `revision` event. (`Orchestrator._findings_by_step`)
- **Wall clock:**
  - provider calls are capped at the remaining time (`AgentRunner._complete_before_deadline`);
  - verification's timeout is capped the same way, and no verification starts
    after the deadline;
  - a deadline now ends the run as `timed_out`, distinct from the call-count
    `limit_exceeded`.
- **Async verification:** runs via `asyncio.to_thread`, so the API stays
  responsive.
- **Cancellation:**
  - `RunService.cancel` and `POST /api/runs/{id}/cancel`, with a new
    `cancelled` status;
  - the verification process tree is killed (`Workspace.kill_active_process`);
  - runs cancelled before they start are handled.
- **Shutdown and recovery:** `RunService.shutdown` gives runs a grace period
  and then cancels them. `RunStore.recover_interrupted` marks orphaned
  `queued`/`running` runs `failed` at startup.
- **Live progress:** the run record is persisted after plan, merge, review, and
  verification.
- **Wired up:** `Limits.parallel_coding` now serialises coding calls when false.
  Snapshot truncation emits a `warning` event and a summary line.
- **Demo provider:** its blockers now carry the evidence the guard requires.
- **Test hygiene:** `make_settings` pins safety, execution, and path settings,
  so a local `.env` cannot leak into tests.
- **Frontend:** `cancelled` and `timed_out` statuses, and a "cancel run"
  action on live runs.
- **Tests:** `tests/test_revision_findings.py` and `tests/test_run_lifecycle.py`.

### M0 — reviewer evidence guard finished

- `app/review_evidence.py`:
  - accepts equivalent expected/actual phrasing ("returns X instead of Y", "should return X but returns Y", "expected X but got Y");
  - normalises `./` and `\` in finding paths;
  - accepts an exact quote of a short criterion;
  - requires quoted excerpts to be phrase-length, so a quoted path or value does not count as citing a criterion;
  - does not treat quoted criterion text as a runtime claim;
  - Ruff UP031 fixed.
- `tests/test_review_evidence.py` (56 items): unit tests for every check, plus regression fixtures built from the stored reviewer messages of `run_32c8ea28b288`, `run_478959ca3d86` and `run_9038fdabb1b9`.
- `tests/test_review_guard_orchestration.py` (6 items): `review_invalid` end to end. Covers: never approval, no revision, no escalation, verification independence, no repair, persistence, and that an evidenced blocker still drives a revision.
- The 11 tests broken by the guard were repaired by giving their scripted blockers real evidence. No assertion was relaxed.
- `tests/test_api.py` derives terminal statuses from `RunStatus`.
- Frontend:
  - `review_invalid` is a terminal status, with its own badge label and color;
  - the terminal map is exhaustive at compile time, so a new status fails `tsc`.
- Docs: `docs/architecture.md` (guard section, routing, failure semantics) and the README status and limitations.

## Decisions in force

- `review_invalid` is terminal for now. It is never an approval.
- Only blocker findings are validated. Major/minor/nit findings and zero-finding rejections follow the normal revision path.
- The guard checks evidence shape, not truth. Verification remains the independent ground truth.

## Known issues (open)

1. **Blocks deployment (M7):** the restricted launcher has only been
   validated on Windows. Run `tests/test_public_demo.py` on Linux in CI before
   deploying; the read allowlist may need Linux system paths.
1a. `local` mode still executes model-written code with containment only.
    Never deploy it publicly.
1b. The current dashboard posts free-form goals, so it gets 403 in
    public_demo. The M3–M5 frontend must use the catalog.
1c. The public demo needs a model. With no API key it uses the deterministic
    fixture, which is clearly labelled. A free hosted OpenAI-compatible key
    (e.g. Groq or OpenRouter free tier) is a credential decision for the user
    at deployment.
2. `RunRequest.metadata` is accepted but not persisted (M3, with benchmark
   endpoints).
3. An escalated revision can exceed `max_revisions` (by design; to be
   documented or bounded).
4. The seeded demo plan contains the literal solution, so demo runs barely
   test the coder (M6/benchmarks).
5. Cancellation and recovery are in-process only. A multi-worker deployment
   needs the durable job queue (M3).
6. A cancelled run's worker thread can outlive the cancel by a moment while the
   killed process exits.
7. There are no "agent started" events yet. In-flight agent state must be
   inferred from dispatch events (M3).

## Blockers needing the user

None for M1–M3 locally. Later milestones need decisions on:

- hosting provider and paid infrastructure;
- an authentication provider;
- a production database;
- error tracking;
- a domain;
- authorization to deploy.

## Deployment checklist (not started)

- [ ] Sandboxed execution worker (M2). Public code execution stays disabled until then.
- [ ] Authentication, ownership checks, quotas, rate limits (M4)
- [ ] Postgres and migrations (M3)
- [ ] Dockerfiles, Compose, CI (M8)
- [ ] Secrets management, CORS for the production origin
- [ ] Logging, metrics, error tracking, backups, rollback procedure
- [ ] Explicit user authorization for external resources and costs
