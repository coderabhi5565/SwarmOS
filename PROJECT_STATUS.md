# SwarmOS project status

Last updated: 2026-11-01

## Current milestone

**M0 — Stabilize the existing system: complete** (branch `m0-stabilize-review-guard`).
Next: **M1 — Backend reliability.**

## Validation at the last milestone boundary

| Check | Result |
| --- | --- |
| `python -m pytest` | 229 passed, 1 skipped (symlink test; needs symlink privilege on Windows) |
| `ruff check .` | clean |
| `npx tsc --noEmit` (frontend) | clean |
| `npm run build` (frontend) | builds |
| Live local-model run with the guard | **not yet performed** |

## Completed

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

## Known issues carried into M1 (verified in code)

1. Revision routing keeps only the last finding per step and drops findings without a `step_id` (`Orchestrator._after_review`, `_after_escalate`).
2. In a mixed review, unsupported blockers are still forwarded to the coder.
3. Verification runs a blocking `subprocess.communicate` inside an async node, which freezes the API for the duration.
4. The run record is persisted only at queued, running and the end, so live metrics read zero.
5. Runs orphaned by a restart stay `running` forever. There is no cancellation.
6. The wall-clock limit is checked only before model calls, not during verification.
7. `Limits.parallel_coding` and `RunRequest.metadata` are accepted but unused. `Workspace.last_truncated` is never surfaced.
8. An escalated revision can exceed `max_revisions` (by design, undocumented).
9. The demo provider's own blockers carry no evidence, so the guard would now classify them as invalid.
10. `load_dotenv()` lets a developer `.env` leak into tests. `make_settings` does not override every safety setting.
11. The seeded demo plan contains the literal solution, so demo runs barely test the coder.

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
