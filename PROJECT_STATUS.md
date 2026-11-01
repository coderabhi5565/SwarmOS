# SwarmOS project status

Last updated: 2026-11-01

## Current milestone

**M1 — Backend reliability: complete** (branch `m0-stabilize-review-guard`).
Next: **M2 — Production execution infrastructure** (sandboxed verification).

## Validation at the last milestone boundary

| Check | Result |
| --- | --- |
| `python -m pytest` | 248 passed, 1 skipped (symlink test; needs symlink privilege on Windows) |
| `ruff check .` | clean |
| `npx tsc --noEmit` (frontend) | clean |
| `npm run build` (frontend) | builds |
| Live local-model run with the guard | **not yet performed** |

Suite wall time varies a lot on this machine (80 s to 300 s for the same code).
Most of it is real `pytest` subprocesses spawned by verification tests.

## Completed

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

1. **Security (M2):** verification executes model-written code with
   containment only: no sandbox, network, CPU or memory isolation. The API must
   stay on loopback.
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
