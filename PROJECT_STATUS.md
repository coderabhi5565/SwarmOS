# SwarmOS project status

Last updated: 2026-11-05

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
- M4 visual execution engine (2D graph, lazy 3D scene) ✅
- M5 real-time execution (SSE streaming, polling fallback) and playback ✅
- M6 benchmarks, docs, landing page
  - M6.0–M6.2 benchmark backend: suites, arms, metrics, runner, CLI, API ✅
  - M6.3 benchmark pages (list, creation, detail) ✅
  - M6.4 benchmark charts: not started
  - docs and landing page: not started
- M7 measurement, security review, testing, free deployment
  - M7.0 observability architecture proposal ✅ (`docs/m7-observability-proposal.md`)
  - M7.1 in-memory timing spans ✅
  - M7.2 measurement persistence and API ✅
  - M7.3 benchmark metrics v2 ✅
  - M7.4 process histograms and SSE timing ✅
  - M7.5 onward (UI, baseline): not started
- M8 release

## Current milestone

**M7.4 — Process histograms and SSE timing: complete and pushed**
(commits `7afa383`, `79fe9f4`, `1fc2dc9` and this documentation commit).
M7.1 to M7.3 are complete and pushed.
Next: **M7.5 — UI**, awaiting approval (not started). M6.4 (benchmark
charts) also awaits approval.

## Validation at the last milestone boundary

M7.4, 2026-11-05, at `1fc2dc9` (backend only; no frontend file changed
since M7.3):

| Check | Result |
| --- | --- |
| `python -m pytest` (`.env` loading disabled) | 848 passed, 2 skipped (788 at M7.3) |
| frontend `npx tsc --noEmit` / `vitest run` / `npm run build` | not rerun (unchanged); at `005e2b1`: clean / 305 passed (28 files) / builds |
| `ruff check .` | clean |
| `ruff format --check` | not configured; the codebase has never been formatted |
| Browser verification against the real backend | see M6.3 below |
| Live local-model run with the guard | **not yet performed** |

Suite wall time varies a lot on this machine (80 s to 300 s for the same code).
Most of it is real `pytest` subprocesses spawned by verification tests.
During M5 the machine ran near its memory commit limit (other applications):
frontend runs used `vitest run --maxWorkers=2`, and a few `tsc`/build runs
were killed by out-of-memory and passed unchanged on retry.

## Completed

### M7.4 — process histograms and SSE timing

- **Commits:** `7afa383` the histogram registry; `79fe9f4` database
  lock-wait and execute time; `1fc2dc9` `sse_commit_to_yield`.
- **Process histograms** (`app/timings/process.py`): in memory only,
  reset with the process, no endpoint and no UI. Exactly five, with no
  labels: `db_read.lock_wait`, `db_read.execute`, `db_write.lock_wait`,
  `db_write.execute` and `sse_commit_to_yield`, plus one counter,
  `sse_commit_to_yield.stamps_dropped`. An unknown name is counted and
  creates nothing.
- **Buckets:** 48 inclusive upper bounds, log-spaced (ratio about 1.367)
  from 50 µs to 120 s, plus an overflow bucket; an observation goes to the
  first bucket whose bound is not below it. Each histogram also keeps
  count, sum, min and max; a negative or non-integer observation is
  counted as invalid, in no bucket. Memory is constant whatever the number
  of observations.
- **Concurrency and failures:** a lock per histogram (the store records
  from any writing thread, streams from the event loop); recording never
  raises, and a failure is counted (`errors`) and dropped.
- **Database:** every `RunStore` read and write records its wait for the
  store lock and the time it holds it (executing and, for a write,
  committing), also when the statement fails. `transaction()` takes a
  read/write label; the benchmark store's five read methods use `read`.
  Opening and closing the store are not timed.
- **`sse_commit_to_yield`:** for an event committed while a live stream is
  subscribed to its run, from immediately after the commit to the moment
  the stream yields that event's frame. Server side only, so not delivery
  latency; the backlog read on connect and the polling endpoint are not
  measured. Commit stamps are kept per stream, at most 4,096 across all
  streams (drops counted), and released when used, when they can no longer
  be used, or when the stream ends. Only times are recorded: no run id,
  seq or event content. Frames, their order, cursors and reconnects are
  unchanged.
- **On and off:** the API lifespan and the CLI apply `SWARMOS_TIMINGS` to
  the process histograms; disabled, nothing is recorded and the store and
  streams skip their clock reads.
- **Tests:** 60 more test cases (848 at `1fc2dc9`, 788 at M7.3): bucket
  boundaries and overflow, invalid values, concurrent updates, constant
  memory, a restarted process starting empty, disabled and failing
  instrumentation, every store operation's label, lock wait against held
  time, and real streams (backlog, several clients, a writing thread,
  disconnects, polling, the public demo). The existing stream tests pass
  unchanged.
- **Not done in M7.4:** reading or reporting the histograms anywhere but
  in-process (no endpoint, by decision); the UI (M7.5).

### M7.3 — benchmark metrics v2

- **Commits:** `7b73a12` warm-up and caps; `237f37e` a rounding fix in
  the M7.2 harness test (the harness is unchanged); `dbffe85` call and
  HTTP-attempt wall time; `9e75e1d` trial timings; `005e2b1` aggregates.
- **Warm-up:** `repetitions` is the number of **measured** repetitions per
  arm and task (API and `bench --repetitions`; default 1, at most 20).
  Every new experiment schedules one more, repetition 0, as the warm-up of
  each arm and task pair. The schedule is repetition-major, so every
  warm-up runs before any measured trial; the seeded interleaving and the
  configuration fingerprints are unchanged. A warm-up runs in full and is
  excluded whatever its outcome (`excluded_reason` `warm-up`; a cancelled
  or interrupted warm-up says so in its null reason). `bench` lists
  warm-ups as excluded and keeps them out of its table, summary and JSONL.
- **No schema change:** the warm-up count is never stored. It is read
  from the persisted trial schedule (`runner.warmup_repetitions`: the
  scheduled repetitions minus `repetitions`), so experiments created
  before M7.3 report 0 and count every trial; a finished trial keeps the
  outcome snapshotted when it finished. The experiment summary reports it
  as `warmup_repetitions`.
- **Caps (local, operator-created experiments only):** `MAX_REPETITIONS`
  10 → 20 measured repetitions; `MAX_TRIALS` 60 → 315, warm-ups included
  (the largest suite, 3 tasks, with all 5 arms at 20 + 1 repetitions). The
  public demo still refuses creation and cancellation (`403`) and has no
  recovery endpoint; a new test checks that creation is still refused at
  the raised caps, and the existing public tests cover the rest.
- **Trial timings** (`TrialMetrics.timings`, metrics version 2): for a
  counted trial, from its run's persisted span measurements only, through
  the same revalidating loader as `GET /api/runs/{id}/measurements`: run
  phases, planner and reviewer time; coder busy (sum), wall (union) and
  critical path; provider calls and HTTP attempts, each with busy (sum)
  and wall (union) time; parse and backoff totals; gating and diagnostic
  verification; graph gap, critical and parallel orchestration;
  schedule-delay, slot-wait and ledger-wait totals; and
  `trial_slot_wait_ms`, timed by the runner from claiming the trial to its
  run's admission. A run without usable measurements keeps every timing
  null with its `measurement_status` as the reason. Warm-up, excluded,
  incomplete and pre-v2 trials have no timings.
- **Aggregates v2** (per arm, and per arm and task): measured n
  (`counted`), `warmups`, `excluded` and `excluded_reasons` (warm-ups are
  not exclusions), `cancelled`/`cancellation_rate` and
  `interrupted`/`interrupted_rate` over `non_warmup_trials`,
  `sample_required` (20) and `sample_complete`, and `timings`: for every
  timing metric `n`, `missing` (with `missing_reasons`), median,
  nearest-rank P95, min and max over the counted trials whose
  measurements were recorded. `n + missing` always equals
  `timings.measured`; every other counted trial is counted in
  `timings.unavailable` by status and enters no figure. Exact definitions
  and conventions: `docs/m7-observability-proposal.md` §17.
- **No significance claims:** every experiment carries the note that 20
  trials per arm and task do not establish a statistically significant
  difference. Excluded trials are never rerun; a short sample reports its
  actual n and is flagged incomplete.
- **Tests:** 52 more test cases (788 at `005e2b1`, 736 at M7.2),
  including percentile, aggregation, exclusion, denominator and
  missing-value checks against hand-calculated datasets and overlapping
  parallel spans.
- **Not done in M7.3:** the proposal's failure rate by error class (§4.2)
  and the arm-position counts for unbalanced orders (§8); the scripted
  baseline report (acceptance criterion 11); the UI (M7.5, see known
  issues 12 and 13).

### M7.2 — measurement persistence and API

- **Storage** (`app/store.py`, additive): `run_measurements` (one row per
  run: `status`, `measurements_version`, `collected_at`,
  `measurements_json`) and `measurement_meta` (`installed_at`: when this
  database first had the table). Existing tables and rows are untouched;
  an existing database gains the two tables when opened. Checked on a copy
  of a real pre-M7.2 scratch database (73 runs, 945 events, 26
  experiments, 88 trials): every existing table identical before and
  after, all 73 runs reading `predates_measurements`.
- **Terminal transaction** (`RunService._write_terminal`): every terminal
  path closes its spans, serializes and bounds the measurements first
  (`app/timings/serialize.py`: compact JSON, at most 256 KiB; when larger,
  fine-grained spans are removed in a fixed order, counted in `dropped`,
  and the row is marked `truncated`), then writes the terminal row and the
  measurement row in one transaction. The last event still commits first.
  If serializing or the transaction fails, the terminal row is written
  alone and a `flush_failed` marker says why; an in-process counter and
  one log line (the run id only) record it. A failing terminal row takes
  the crash path, as before.
- **Markers:** `disabled` (recording off), `flush_failed`, and
  `process_crash` (written by startup recovery for the runs it closes).
- **API:** `GET /api/runs/{id}/measurements` (`RunMeasurements`): typed
  phases, coder, orchestration, agents, waits, verification, persistence,
  calls, steps and spans, plus the reason for every null metric; or
  `available: false` with `run_in_progress`, `predates_measurements`,
  `process_crash`, `measurement_flush_failed`, `instrumentation_disabled`,
  `not_recorded` or `unreadable`. Nothing is derived from wall-clock event
  timestamps. Stored rows are revalidated on read; in the public demo every
  string also goes through the redactor. API types regenerated (additions
  only).
- **A/B overhead** (`scripts/measure_timings_overhead.py`; 20 measured
  pairs per catalog task after one warm-up pair, interleaved, timed by the
  harness): median paired difference (on minus off) −30.3 ms (−2.2%) and
  −12.2 ms (−0.9%), with paired differences spread from −475 to +166 ms.
  The overhead is not detectable at this noise level (the run's real
  pytest subprocess dominates); both medians are within the proposed
  target, which this method cannot resolve below tens of milliseconds. The
  recorder's own accounted time (0.6–1.2 ms per run, M7.1) remains the
  direct estimate.
- **Tests:** 42 new: storage and migration, serialization and
  truncation, terminal persistence and every fallback, the API with every
  reason, tampered rows and public canaries, and the harness.
- **Deviations from the proposal** are in
  `docs/m7-observability-proposal.md` §16.

### M7.1 — in-memory timing spans

- **Recorder** (`app/timings/recorder.py`): one `SpanRecorder` per run;
  spans are offsets on `time.perf_counter_ns` from a monotonic zero, with
  one UTC anchor. At most 2,048 spans per run, 256 reserved for structural
  spans; dropped spans are counted by kind. Attributes are typed (booleans,
  integers, id-like strings under fixed keys): no free text, so no path,
  command or URL. Recording never raises into a run (failures, including an
  unreadable clock, are counted). Found through context variables, so tasks
  and `asyncio.to_thread` see only their own run's recorder.
- **Spans recorded:** lifecycle (from the `queued` commit to the terminal
  write) split into admission, execution (setup, graph) and finalization; a
  run cancelled before it started records admission only. A node span per
  graph node; a dispatch instant per wave (carried to its steps as
  `dispatch_id`); per step the scheduling delay, checkout and, in sequential
  mode, the coding-slot wait. Per agent-call attempt: ledger wait, the
  provider call (runner clock, outcome), each HTTP attempt inside it
  (outcome, so a JSON-mode downgrade is two attempts), parsing and backoff.
  Verification: thread wait, gating or diagnostic run, process. Per-run
  aggregates of trace and run-row writes (store-lock wait and
  execute-and-commit).
- **Derived metrics** (`app/timings/analysis.py`, pure and total): run
  phases; coder busy, wall and critical-path time; self time over the union
  of children; graph gap; critical and parallel orchestration; calls with
  HTTP attempts; waits; gating and diagnostic verification; persistence
  totals. A value not established is null with a reason (incomplete, never
  started, spans dropped, malformed, not applicable, disabled).
- **Where it lives:** in memory only, the 64 most recent runs in
  `RunService` (`timings_for`). No table, API or UI (M7.2 onward).
  `SWARMOS_TIMINGS=0` turns recording off.
- **Overhead (measured, this machine):** a span costs about 2.3–2.6 µs
  (start and end), 5.3–5.6 µs through the context manager, an aggregate
  update about 1.6 µs, and 0.15 µs when disabled (median of 5 rounds of
  20,000, three runs). A catalog run records 24 spans (one-step task) or 38
  (parallel pipeline), none dropped, with 0.6–1.2 ms of recorder self time
  against a lifecycle of about 1.4 s. The whole-run on/off A/B is M7.2.
- **Unchanged:** the event trace (identical with timings on and off), event
  order and seq, replay, cancellation, the Provider protocol, the public
  redaction boundary.
- **Tests:** 83 new (`tests/test_timings_*.py`): recorder, analysis
  (hand-checkable times), real runs, agent calls with a mock HTTP
  transport, persistence aggregates, overhead.
- **Not in M7.1 (by the proposal's phases):** persistence and the terminal
  transaction (M7.2), the 256 KiB row cap (M7.2), benchmark metrics v2 and
  trial slot wait (M7.3), process histograms and `sse_commit_to_yield_ms`
  (M7.4). Deviations from the proposal's span table are recorded in
  `docs/m7-observability-proposal.md` §15.

### Public trace redaction (found in M6.3 integration)

- **Root cause:** runs are stored as recorded, and the public demo served
  them as stored. `Workspace.run_command` records the command it executed,
  with `python` replaced by `sys.executable`; the restricted runner adds the
  launcher's path, the temporary workspace and `--basetemp`. That command
  (in `run.verification` and the `verification` event), pytest output that
  quotes paths, and free-text errors put absolute server paths, and so the
  account's home directory, into `GET /api/runs/{id}`, `POST /api/runs`,
  `GET /api/runs/{id}/events` and `GET /api/runs/{id}/stream`.
- **Fix:** `app/redaction.py` (`PublicRedactor`), applied in `public_demo`
  mode at the response boundary of every route that returns run data
  (detail, create, events, the stream before framing, the list), the
  configured command in `/api/config`, 400 messages from run creation, and
  the benchmark views' free text. Commands are an allowlist (only the
  configured verification command); truncated output loses its partial
  first line; every other string loses keys, endpoints, credentials, URLs,
  absolute paths (workspace paths become workspace-relative) and IP
  addresses. Stored data is not rewritten; `local` mode is unchanged.
  Details: `docs/safety.md#what-visitors-see-of-a-run`.
- **Tests:** `tests/test_public_redaction.py` (37): events, paging, detail,
  list, the stream of a stored trace and of events recorded while it is
  open, a real public catalog run through the sandbox launcher (no
  interpreter, home, temp or project path anywhere), nested payloads and
  keys, Windows/UNC/POSIX/`~`/repr paths, fake keys, URLs, hosts and
  addresses, unchanged ordinary text, unchanged storage, and local mode.
  With the redaction switched off, the 7 endpoint tests fail.
- **Verified against a real server** (scratch copy of the M6.3 database:
  73 runs recorded before the fix, 71 of them with host paths; public mode
  with a fake endpoint, key and model set): 255 API responses (every run's
  detail, events and stream, the list, config, health and every benchmark
  experiment) contained no host path or canary. A new catalog run was
  streamed live (19 reads over 0.7 s) and checked the same way: stored with
  the launcher and a drive path, served as `[redacted]`, with the
  configured `python -m pytest -q` shown. Stream ids equal event seqs for
  all 74 runs. Run Detail in headless Chrome showed `$ python -m pytest -q`;
  its markup's only path-like matches were static SVG and link URLs. Local
  mode served the full 418-character command unchanged in the events, the
  detail and the stream. (Run twice on fresh copies, with the same results.)

### M6.3 — benchmark pages

- **Routes** (lazy, in the main navigation):
  - `/benchmarks` (`BenchmarksPage`): experiments newest first, cursor
    paging with "Load more", and the creation form where allowed;
  - `/benchmarks/:experimentId` (`BenchmarkExperimentPage`): the experiment
    as the backend reports it.
- **Data layer** (`src/api/benchmarkQueries.ts`, client functions in
  `src/api/client.ts`): suites (stale after 60 s); an infinite experiment
  list refreshed every 2 s while any loaded experiment is queued or
  running; the detail refreshed every 2 s while it is. Polling stops at
  every terminal status. Creation seeds the detail cache and invalidates
  the lists; mutations never retry. Details: `docs/architecture.md#benchmark-pages`.
- **Creation** (`components/benchmarks/CreateExperimentForm.tsx`): mounted
  only when the server's `can_create` is true; only the server's suites,
  tasks, arms and caps; client validation (arms, tasks, repetitions, seed,
  `max_trials`, a real-model suite with the demo provider); one request in
  flight; navigates to the new experiment. The server's 400/403/409/422/
  429/5xx messages are shown as it worded them. No cancel button yet (the
  hook exists).
- **Detail:** header with status, provenance and refresh state; the
  backend's notes; overview; provenance (host details "not disclosed" when
  withheld); arm configurations with escalation reasons; identical-by-design
  groups from the backend only; results by arm and by arm and task; and a
  trial table (status, outcome, task success, verification, latency,
  calls and retries, exclusion reason or error, and a link to the run).
- **Interpretation rules:** unknown is never zero (null values show the
  backend's `null_reasons`); a rate shows its denominator; task success and
  verification are separate; excluded and not-run trials are listed with
  their reasons; scripted results are labelled as describing the
  orchestration, not a model. No metric is computed in the browser except
  an experiment's elapsed time, from its recorded start and finish. No
  charts (M6.4).
- **Tests:** 79 new frontend tests (data layer, list, form, detail).

**Integration and browser verification.** All of this was checked against
the real backend in scratch SQLite databases (the project's `swarmos.db`
was byte-identical before and after), with `.env` loading disabled, the
demo provider, and no endpoint or key. A headless Chrome was driven over
the DevTools protocol with a throwaway profile: real page loads, mouse and
keyboard input, network capture and screenshots. The rendered trial rows,
aggregates and identical-by-design groups of three experiments (completed,
cancelled, interrupted) were compared field by field with the API's JSON:
93, 104 and 95 checks, no mismatch.

| Scenario | Result |
| --- | --- |
| Empty list, form with the server's 2 suites, 5 arms, `max_trials` 60 | passed |
| Client validation (no arm; 70 trials > 60): nothing sent | passed |
| Server refusal (local-fixtures without a real model): one POST, 400 shown, not retried | passed |
| Real double click on Start: exactly one POST (202), navigation to the new experiment | passed |
| Detail while running: GET every ~2.0 s, "refreshing every 2 s", trials done 0 → 6 of 6 | passed |
| Polling stops at the terminal status (no request in the following ~5 min) | passed |
| Trial → run link opens `/runs/:runId` | passed |
| 20 + "Load more": 22 unique experiments, same order as the API, one cursor request | passed |
| List refresh while active refetches both loaded pages, keeps 22 rows, stops when terminal | passed |
| Cancellation (API): in-flight trial excluded ("cancelled"), the rest not run with the reason | passed |
| Backend killed mid-experiment: "Could not refresh" after 16 s with the last data kept; after restart, `interrupted`, in-flight trial excluded, polling stopped | passed |
| List error (request blocked in the browser): alert after 4 retries; "Try again" recovers | passed (failure injected) |
| Unknown experiment and unknown run: real 404 pages | passed |
| Public demo: read-only note, no form, no non-GET request, experiments readable, host details "not disclosed", `/legacy` closed | passed |
| Public demo API: create, cancel, free-form run and inline run all `403`; no run started | passed |
| Public demo with fake endpoint, key and model set: no key, URL or local path in any benchmark, config or health response | passed |
| Public demo run traces: absolute server paths visible | **failed** (pre-existing); fixed since, see "Public trace redaction" |
| Regression: `/`, `/console`, `/history`, `/legacy` (local), `/runs/new`, a live run streamed to completion, replay, the 3D scene, 404 | passed |
| `queued` state seen in a browser | not observed (an experiment starts running at once) |
| Trial `error` state ("the run could not be started") end to end | not tested (no configuration triggers it without code changes) |
| SSE polling fallback in a browser | not tested in M6.3 (covered by M5 tests) |

### M6.0–M6.2 — benchmark backend

- **M6.0** (`app/benchmarks/`): versioned suites (`catalog`, public;
  `local-fixtures`, local and real-model only); fixed arms (execution:
  `parallel`, `sequential`; model policy: `fixed-fast`, `adaptive`,
  `multi-agent`); configuration fingerprints, identical-by-design
  detection and provenance; trial metrics and per-arm aggregates (task
  success separate from verification, exclusions, null with reasons,
  nearest-rank P95); tokens and cost null unless reported.
- **M6.1:** the experiment runner (one active experiment per database, a
  seeded trial order, conditional claims, cancellation, recovery as
  `interrupted` at startup) and `swarmos bench` on it, with an
  operator-only `--recover`. Escalation is judged from the run's own
  provider.
- **M6.2:** `GET /api/benchmarks/suites`, `GET` and `POST
  /api/benchmarks/experiments`, `GET /api/benchmarks/experiments/{id}`,
  `POST …/cancel`. The public demo is read-only (only the catalog suite;
  `403` for writes; host details omitted; errors redacted).

### M5 — real-time execution and playback

- **`GET /api/runs/{id}/stream`** (Server-Sent Events, `app/streaming.py`):
  the persisted trace, live, then `end`. `RunStore` notifies listeners after
  each commit; a broker wakes the streams of that run, which re-read the
  store after their cursor. No second event store and no per-stream
  buffering. Cursor: the greater of `after_seq` and `Last-Event-ID`; `id` =
  `seq`. Correctness argument (connect race, read/wait race, terminal
  ordering) in `docs/architecture.md#live-streaming`.
- **Limits:** keepalive comments, a maximum stream lifetime (clients
  resume), batches of 200, back-pressure. The public demo caps open streams
  at 4 per client and 40 in total; the token check applies; the endpoint
  creates nothing and takes no inputs beyond the cursor.
- **Frontend transport:** one shared connection per run per QueryClient,
  reading the stream with `fetch` and folding events through the reducer
  into the same cache entry as polling. States: connecting, connected,
  reconnecting (1/2/4 s backoff), polling fallback (stream retried every
  30 s), disconnected (offline), completed. No record or event polling
  while streaming; `end` refreshes the record and triggers one final
  fetch. A poll folds onto the latest cached state, never a stale one.
- **Connection badge** on the console and Run Detail: says live only while
  a stream is open; the fallback says the backend answers but the stream
  does not.
- **Playback** on Run Detail (`createStateReplay` over the state's own log):
  play, pause, restart, step, scrub, 0.5×–4×; the position is view state, so
  it survives 2D/3D switches; all progress panels draw the frame; derived
  only, so a live run keeps updating underneath. Elapsed time only from
  recorded timestamps; the cadence is one event per step, stated as such.
- **Visual check with a long run:** `scripts/serve_slow_demo.py` (dev only)
  slows the demo provider to 4 s per call; production timing is unchanged.
  Headless Edge confirmed streaming, nodes updating as events arrive,
  animation only on edges into running work (and none under reduced
  motion), selection surviving live updates and 2D/3D switches, playback in
  both views, and one stream / two record / two events requests for a
  whole live run. It found and fixed two M4 bugs: 2D follow-live never
  moved (React Flow held queued fits because replaced nodes lost their
  measured size), and both views stayed on the last active node after a run
  ended.
- **Not changed:** M2 public-demo restrictions, rate limits, the reducer
  and the visualisation model.

### M4 — visual execution engine

- **Shared model** (`frontend/src/domain/visualization/`, framework-free):
  `buildVizModel(state)` turns the normalised `ExecutionState` into nodes
  and edges that both renderers draw.
  - Stable ids: `agent:planner`, `step:<id>`, `agent:reviewer`,
    `runner:verifier`. The deterministic grid (planner, one column per wave,
    reviewer, verifier) never moves a node once the plan is known.
  - Dependency edges only from recorded dependencies; with none recorded the
    graph says so and draws none. Revision (reviewer → step) and repair
    (verifier → step) edges carry counts; retries and the strong tier are
    node badges.
  - A node is active only between a lifecycle start event and its result,
    so finished runs and pre-M3.0 traces never show activity.
  - `reconcileVizModel` keeps unchanged node and edge objects (and the
    whole model when a poll brings nothing new).
- **2D graph** (React Flow): fixed node sizes and declared handles, so
  layout and edges never depend on measurement; no dragging; pan, zoom and
  fit; edge animation only for running work and never under reduced motion;
  accessible node labels and keyboard selection. Fully usable without WebGL.
- **3D scene** (React Three Fiber, drei): distinct shapes per role, the
  verifier as a machine; status rings; feedback arcs. `frameloop="demand"`
  (continuous frames only while work runs and motion is allowed), orbit
  controls, camera reset, a focusable entity list for keyboard and
  screen-reader users. Labels are DOM projected over the canvas.
- **Lazy 3D:** `three`/R3F live only in the `ExecutionScene3D` chunk
  (971 kB, 262 kB gzip), imported only after choosing 3D with WebGL
  available. Missing WebGL, a failed start or a lost context fall back to
  the 2D graph with an explanation. The entry chunk (120 kB, 41 kB gzip)
  imports only the vendor chunks; React Flow is in the lazy
  `ExecutionView` chunk (228 kB, 74 kB gzip) used by Run Detail and the
  console. Vite warns about the 3D chunk's size; it is opt-in only.
- **Shared view state** (Zustand): selection (now including the runner,
  mapped to node ids), 2D/3D mode and follow-live. The view now starts in
  2D for everyone (previously 3D unless reduced motion was requested).
- **Integration:** Run Detail and the console render `ExecutionView` from
  the execution state they already poll; no new data path. Every existing
  panel stays. The details panel sits beside the graph only when the
  view's container is wide enough.
- **Visual check** (headless Edge, SwiftShader WebGL, scratch database,
  demo provider): found and fixed truncated 2D labels, an empty planner
  label in 3D (drei `Html` under React 19), and an unreadably small graph
  in the console's narrower column. Verified the no-WebGL fallback and
  that the 3D chunk is never requested without WebGL.
- **Test infrastructure:** page tests got a 20 s timeout and preloaded
  lazy pages (`885b2db`); they had timed out under heavy machine load.

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
8. Resolved: public run data exposed absolute server paths. The public
   demo now redacts every response that carries a run
   (`app/redaction.py`; see "Public trace redaction" above). It is
   pattern-based redaction, not an explicit public response schema: beyond
   the command allowlist, a new free-text field with host details in an
   unrecognised form would need a new rule and test.
9. The browser console warns "No `HydrateFallback` element provided" on
   every page load (lazy routes without a hydrate fallback; harmless, since
   nothing is server-rendered), and `THREE.Clock` is deprecated in the 3D
   scene. Both pre-date M6.3.
10. Benchmark pages: no cancel button (the API and the hook exist); the
    `queued` badge and the trial `error` state are covered by component
    tests but were not produced in a browser.
11. `tests/test_openapi_snapshot.py` passes only where `frontend/dist`
    exists: without a built frontend, `app/main.py` registers a documented
    `GET /` fallback that the committed `frontend/openapi.json` lacks. A
    fresh checkout fails it until the frontend is built (or
    `SWARMOS_FRONTEND_DIST` points at a build). Pre-existing; not changed.
12. **M7.5 follow-up:** the create-experiment form computes its trial
    count as arms × tasks × repetitions, without the warm-up repetition
    the server adds per arm and task, so the count it displays and checks
    against `max_trials` is low by arms × tasks. At the current caps the
    server never rejects such a request (the largest choice is exactly
    315 trials); the server's count is authoritative. Not fixed.
13. **M7.5 follow-up:** the aggregate v2 fields (warm-ups, exclusions,
    rates, sample completeness, timing distributions) and trial timings
    are in the API but not yet displayed by any page. Not fixed.

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
