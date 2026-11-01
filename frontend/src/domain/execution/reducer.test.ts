import { describe, expect, it } from "vitest";
import type { TraceEvent } from "@/api/types";
import { allFixtures, fixtures, type TraceFixture } from "./fixtures";
import type { ExecutionState } from "./model";
import { initialState, reduce, settleWithRecord } from "./reducer";

function fold(fixture: TraceFixture, events: TraceEvent[] = fixture.events): ExecutionState {
  return events.reduce(reduce, initialState(fixture.run));
}

/** State just after the first event matching `predicate`. */
function until(fixture: TraceFixture, predicate: (event: TraceEvent) => boolean): ExecutionState {
  const index = fixture.events.findIndex(predicate);
  expect(index, "no matching event").toBeGreaterThanOrEqual(0);
  return fold(fixture, fixture.events.slice(0, index + 1));
}

function invocations(state: ExecutionState) {
  return state.invocationOrder.map((id) => state.invocations[id]);
}

function synthetic(seq: number, kind: string, payload: Record<string, unknown> = {}, message = ""): TraceEvent {
  return { event_id: `evt_${seq}`, run_id: "run_syn", seq, at: `2026-11-01T00:00:${String(seq).padStart(2, "0")}Z`, kind, message, payload } as TraceEvent;
}

// --------------------------------------------------------------------
// 1. empty state
// --------------------------------------------------------------------
describe("initial state", () => {
  it("starts empty, with agents and the runner kept distinct", () => {
    const state = initialState();
    expect(state.phase).toBe("not_started");
    expect(state.status).toBeNull();
    expect(state.plan).toBeNull();
    expect(Object.keys(state.agents)).toEqual(["planner", "coder", "reviewer"]);
    for (const agent of Object.values(state.agents)) {
      expect(agent).toMatchObject({ kind: "agent", status: "idle", invocationIds: [] });
    }
    expect(state.verifier).toEqual({ role: "verifier", kind: "deterministic_runner", status: "idle", runIds: [] });
    expect(state.invocationOrder).toEqual([]);
  });

  it("takes only up-front facts from the run record", () => {
    const state = initialState(fixtures.demoPipelineCompleted.run);
    expect(state.runId).toBe(fixtures.demoPipelineCompleted.run.run_id);
    expect(state.budget.limits).not.toBeNull();
    // The record says "completed", but nothing has happened yet in a replay.
    expect(state.status).toBeNull();
    expect(state.plan).toBeNull();
  });
});

// --------------------------------------------------------------------
// 2–6. planner, coding, parallelism, waves, pairing
// --------------------------------------------------------------------
describe("agents and steps", () => {
  it("shows the planner running only between its start and its result", () => {
    const fixture = fixtures.callLimitExhausted;
    const started = until(fixture, (e) => e.kind === "agent_started");
    expect(started.agents.planner.status).toBe("running");
    expect(started.phase).toBe("planning");
    const [running] = invocations(started);
    expect(running).toMatchObject({ role: "planner", status: "running", startObserved: true, latencyMs: null });

    const done = until(fixture, (e) => e.kind === "agent_invocation");
    const [finished] = invocations(done);
    expect(finished.status).toBe("succeeded");
    expect(finished.latencyMs).not.toBeNull();
    expect(done.agents.planner).toMatchObject({ status: "done", activeInvocationIds: [] });
  });

  it("codes, merges and completes a single step", () => {
    const state = fold(fixtures.reviewRevisionCompleted);
    const step = state.plan?.steps.draft_implementation;
    expect(step).toMatchObject({ status: "merged", attempts: 2, revisionsRequested: 1 });
    expect(step?.invocationIds).toHaveLength(2);
    expect(state.agents.planner.status).toBe("skipped"); // the recipe supplied the plan
    expect(state.outcome).toMatchObject({ status: "completed", source: "trace" });
  });

  it("shows both first-wave coders running when their calls overlap", () => {
    const fixture = fixtures.parallelOverlap;
    let coders = 0;
    const both = until(fixture, (e) => e.kind === "agent_started" && e.payload.role === "coder" && ++coders === 2);
    expect(both.agents.coder.activeInvocationIds).toHaveLength(2);
    expect(both.plan?.steps.alpha.status).toBe("running");
    expect(both.plan?.steps.beta.status).toBe("running");
    expect(both.plan?.steps.gamma.status).toBe("pending");
    expect(both.dispatches[0]).toMatchObject({ parallel: true, steps: ["alpha", "beta"] });
  });

  it("does not claim overlap that the trace does not show", () => {
    // The demo fixture answers instantly: the wave was dispatched in parallel,
    // but each call finished before the next started, and the state says so.
    const fixture = fixtures.demoPipelineCompleted;
    expect(fold(fixture).dispatches[0]).toMatchObject({ parallel: true });
    for (let n = 1; n <= fixture.events.length; n += 1) {
      const state = fold(fixture, fixture.events.slice(0, n));
      expect(state.agents.coder.activeInvocationIds.length, `after #${n}`).toBeLessThanOrEqual(1);
    }
  });

  it("rebuilds dependencies and waves from the backend plan", () => {
    const plan = fold(fixtures.demoPipelineCompleted).plan;
    expect(plan?.source).toBe("recipe");
    expect(plan?.dependenciesKnown).toBe(true);
    expect(plan?.waves).toEqual([["inspect_tests", "draft_implementation"], ["document_change"]]);
    expect(plan?.steps.document_change).toMatchObject({ wave: 1, dependsOn: ["inspect_tests", "draft_implementation"] });
    expect(plan?.steps.inspect_tests).toMatchObject({ wave: 0, dependsOn: [], status: "merged" });
  });

  it("takes an old plan's dependencies from the stored record, not step order", () => {
    const plan = fold(fixtures.legacyFalseBlocker).plan;
    expect(plan?.dependenciesKnown).toBe(true);
    expect(plan?.steps.draft_implementation.dependsOn).toEqual([]);
  });

  it("leaves dependencies unknown when nothing records them", () => {
    const state = [
      synthetic(1, "run_started", { goal: "g" }),
      synthetic(2, "routing_decision", { decision: "plan_accepted", steps: ["a", "b"], waves: [["a"], ["b"]] }),
    ].reduce(reduce, initialState());
    expect(state.plan?.dependenciesKnown).toBe(false);
    expect(state.plan?.steps.b.dependsOn).toBeNull(); // not inferred from wave order
    expect(state.plan?.waves).toEqual([["a"], ["b"]]);
  });

  it("pairs every start with its completion by invocation id", () => {
    for (const fixture of allFixtures.filter((f) => !f.name.startsWith("legacy") && f.name !== "cancelled_mid_call")) {
      const state = fold(fixture);
      const starts = fixture.events.filter((e) => e.kind === "agent_started").length;
      expect(state.invocationOrder, fixture.name).toHaveLength(starts);
      for (const invocation of invocations(state)) {
        expect(invocation.startObserved, fixture.name).toBe(true);
        expect(invocation.finishedSeq! > invocation.startedSeq!, fixture.name).toBe(true);
      }
    }
  });
});

// --------------------------------------------------------------------
// 7–8, 13. attempts, retries, escalation
// --------------------------------------------------------------------
describe("retries and escalation", () => {
  const state = fold(fixtures.retryEscalation);

  it("keeps every attempt of a step, with its tier", () => {
    const coder = invocations(state).filter((i) => i.role === "coder");
    expect(coder.map((i) => [i.attempt, i.tier, i.status])).toEqual([
      [1, "fast", "failed"],
      [2, "fast", "failed"],
      [3, "strong", "succeeded"],
    ]);
    expect(state.plan?.steps.alpha).toMatchObject({ status: "merged", attempts: 3 });
    expect(state.plan?.steps.alpha.invocationIds).toHaveLength(3);
  });

  it("records the bounded retry and the failures behind it", () => {
    expect(state.retries).toEqual([expect.objectContaining({ scope: "steps", steps: ["alpha"] })]);
    expect(state.failures.map((f) => f.errorClass)).toEqual(["invalid_response", "invalid_response"]);
    expect(state.failures.every((f) => f.role === "coder" && f.stepIds[0] === "alpha")).toBe(true);
  });

  it("records the escalation and switches the tier", () => {
    expect(state.escalations).toEqual([expect.objectContaining({ fromTier: "fast", toTier: "strong", available: true, round: 1 })]);
    expect(state.tier).toBe("strong");
    expect(state.dispatches.map((d) => d.tier)).toEqual(["fast", "fast", "strong"]);
  });
});

// --------------------------------------------------------------------
// 9–12. review and verification
// --------------------------------------------------------------------
describe("review and verification", () => {
  it("records a rejection, the revision round and the re-review", () => {
    const state = fold(fixtures.reviewRevisionCompleted);
    expect(state.reviews).toHaveLength(2);
    expect(state.reviews[0]).toMatchObject({ verdict: "request_changes", rejection: 1, invalid: false });
    expect(state.reviews[0].findings[0].severity).toBe("blocker");
    expect(state.reviews[1].verdict).toBe("approve");
    expect(state.dispatches.map((d) => d.mode)).toEqual(["initial", "revision"]);
    expect(state.dispatches[1].revisionRound).toBe(1);
  });

  it("marks an evidence-less rejection invalid, not approved", () => {
    const state = fold(fixtures.reviewInvalid);
    expect(state.reviews).toEqual([expect.objectContaining({ verdict: "request_changes", invalid: true })]);
    expect(state.status).toBe("review_invalid");
    const [run] = state.verificationOrder.map((id) => state.verifications[id]);
    expect(run).toMatchObject({ diagnostic: true, status: "passed", attempt: null, startObserved: true });
  });

  it("pairs verification start and result and never treats the runner as an agent", () => {
    const fixture = fixtures.demoPipelineCompleted;
    const running = until(fixture, (e) => e.kind === "verification_started");
    expect(running.verifier.status).toBe("running");
    expect(running.phase).toBe("verifying");

    const state = fold(fixture);
    const runs = state.verificationOrder.map((id) => state.verifications[id]);
    expect(runs).toEqual([
      expect.objectContaining({ status: "passed", testsPassed: 3, testsFailed: 0, attempt: 1, diagnostic: false, startObserved: true }),
    ]);
    expect(state.verifier.status).toBe("passed");
    expect(Object.keys(state.agents)).not.toContain("verifier");
    expect(invocations(state).some((i) => (i.role as string) === "verifier")).toBe(false);
  });

  it("records a failed verification and the repair that fixed it", () => {
    const state = fold(fixtures.verificationRepair);
    const runs = state.verificationOrder.map((id) => state.verifications[id]);
    expect(runs.map((r) => [r.attempt, r.status])).toEqual([
      [1, "failed"],
      [2, "passed"],
    ]);
    expect(state.failures).toEqual([expect.objectContaining({ errorClass: "verification_failed", role: "verifier", stepIds: [] })]);
    expect(state.dispatches.map((d) => d.mode)).toEqual(["initial", "repair"]);
    expect(state.outcome?.status).toBe("completed");
  });
});

// --------------------------------------------------------------------
// 14, 20–22. limits and endings
// --------------------------------------------------------------------
describe("limits and endings", () => {
  it("shows the call budget refusing the review", () => {
    const state = fold(fixtures.callLimitExhausted);
    expect(state.budget.refusals).toEqual([expect.objectContaining({ role: "reviewer", category: "limit_exceeded" })]);
    expect(state.agents.reviewer.invocationIds).toEqual([]); // the call never happened
    expect(state.budget.ledger?.calls).toBe(4);
    expect(state.outcome?.status).toBe("limit_exceeded");
  });

  it("closes a call cut off by cancellation as interrupted", () => {
    const state = fold(fixtures.cancelledMidCall);
    const [planner] = invocations(state);
    expect(planner).toMatchObject({ role: "planner", status: "interrupted", finishedSeq: null, latencyMs: null });
    expect(state.agents.planner).toMatchObject({ status: "interrupted", activeInvocationIds: [] });
    expect(state.outcome).toMatchObject({ status: "cancelled", error: "cancelled on request" });
  });

  it("records a timed-out run's abandoned call as failed, not interrupted", () => {
    const state = fold(fixtures.timedOut);
    const [planner] = invocations(state);
    expect(planner).toMatchObject({ status: "failed", errorClass: "timeout" });
    expect(state.budget.refusals).toEqual([expect.objectContaining({ category: "timed_out" })]);
    expect(state.outcome?.status).toBe("timed_out");
  });

  it("closes open agents, verification and steps when the run finishes", () => {
    const state = [
      synthetic(1, "run_started", { goal: "g" }),
      synthetic(2, "routing_decision", { decision: "dispatch_coding", steps: ["a", "b"], attempts: { a: 1, b: 1 } }),
      synthetic(3, "agent_started", { invocation_id: "inv_a", role: "coder", step_id: "a", attempt: 1, tier: "fast" }),
      synthetic(4, "verification_started", { verification_id: "ver_1", attempt: 1, diagnostic: false }),
      synthetic(5, "run_finished", { status: "failed", error: "server stopped" }),
    ].reduce(reduce, initialState());

    expect(state.invocations.inv_a.status).toBe("interrupted");
    expect(state.agents.coder.status).toBe("interrupted");
    expect(state.verifications.ver_1.status).toBe("interrupted");
    expect(state.verifier.status).toBe("interrupted");
    expect(state.plan?.steps.a.status).toBe("interrupted");
    expect(state.plan?.steps.b.status).toBe("interrupted"); // dispatched, never started
    expect(Object.values(state.invocations).some((i) => i.status === "succeeded")).toBe(false);
  });

  it("settles a trace that never finished from the stored record only", () => {
    const events = [synthetic(1, "run_started"), synthetic(2, "agent_started", { invocation_id: "inv_p", role: "planner", attempt: 1 })];
    const open = events.reduce(reduce, initialState({ run_id: "run_syn", status: "failed" }));
    expect(open.outcome).toBeNull();
    const settled = settleWithRecord(open);
    expect(settled.outcome).toMatchObject({ status: "failed", source: "record" });
    expect(settled.invocations.inv_p.status).toBe("interrupted");
  });
});

// --------------------------------------------------------------------
// 15–16. failure shapes and old traces
// --------------------------------------------------------------------
describe("old traces and failure shapes", () => {
  it("replays an old trace from completions alone", () => {
    const state = fold(fixtures.legacyPlannerRevision);
    const all = invocations(state);
    expect(all.length).toBe(5);
    expect(all.every((i) => i.idRecorded && !i.startObserved && i.startedSeq === null)).toBe(true);
    // Measured timing and usage from the recorded invocation, nothing invented.
    expect(all.every((i) => i.latencyMs !== null && i.startedAt !== null && i.inputTokens !== null)).toBe(true);
    expect(state.reviews.map((r) => [r.verdict, r.rejection])).toEqual([
      ["request_changes", 1],
      ["request_changes", 2],
    ]);
    expect(state.outcome?.status).toBe("completed_with_findings");
  });

  it("never shows an old trace's agent as running", () => {
    const fixture = fixtures.legacyPlannerRevision;
    for (let n = 1; n <= fixture.events.length; n += 1) {
      const state = fold(fixture, fixture.events.slice(0, n));
      expect(Object.values(state.agents).every((a) => a.status !== "running"), `after #${n}`).toBe(true);
    }
  });

  it("records an old diagnostic verification without inventing its start", () => {
    const state = fold(fixtures.legacyFalseBlocker);
    const [run] = state.verificationOrder.map((id) => state.verifications[id]);
    expect(run).toMatchObject({ idRecorded: false, startObserved: false, diagnostic: true, status: "passed", startedSeq: null });
  });

  it("shows an old review refused by the wall clock", () => {
    const state = fold(fixtures.legacyLimitAtReview);
    expect(state.budget.refusals).toEqual([expect.objectContaining({ role: "reviewer", category: "limit_exceeded" })]);
    expect(state.outcome?.status).toBe("limit_exceeded");
  });

  it("fails every step named by a legacy multi-step conflict", () => {
    const state = [
      synthetic(1, "routing_decision", { decision: "dispatch_coding", steps: ["a", "b"], attempts: { a: 1, b: 1 } }),
      synthetic(2, "failure", { steps: ["a", "b"], files: ["out/x.txt"] }, "Rejected conflicting parallel writes"),
    ].reduce(reduce, initialState());
    expect(state.plan?.steps.a).toMatchObject({ status: "failed", lastError: "Rejected conflicting parallel writes" });
    expect(state.plan?.steps.b.status).toBe("failed");
    expect(state.failures[0]).toMatchObject({ role: null, stepIds: ["a", "b"], details: { files: ["out/x.txt"] } });
  });

  it("reports tokens only where the provider reported usage", () => {
    expect(invocations(fold(fixtures.demoPipelineCompleted)).every((i) => i.inputTokens === null)).toBe(true);
    expect(invocations(fold(fixtures.legacyFalseBlocker)).every((i) => i.inputTokens !== null)).toBe(true);
  });
});

// --------------------------------------------------------------------
// 17–19. unknown, duplicate and out-of-order events
// --------------------------------------------------------------------
describe("robustness", () => {
  const fixture = fixtures.demoPipelineCompleted;
  const reference = fold(fixture);

  it("keeps unknown kinds in the log without changing the execution state", () => {
    const events = [...fixture.events];
    const unknown = synthetic(events.length + 1, "telepathy", { x: 1 });
    const state = [...events, unknown].reduce(reduce, initialState(fixture.run));
    expect(state.integrity.unknownKinds).toEqual(["telepathy"]);
    expect(state.log.at(-1)).toMatchObject({ type: "unknown", rawKind: "telepathy" });
    expect({ ...state, log: [], lastSeq: 0, integrity: null }).toEqual({ ...reference, log: [], lastSeq: 0, integrity: null });
  });

  it("ignores duplicate events and returns the same object", () => {
    const doubled = fixture.events.flatMap((event) => [event, event]);
    expect(fold(fixture, doubled)).toEqual(reference);
    expect(reduce(reference, fixture.events[3])).toBe(reference);
  });

  it("reaches the same state whatever order events arrive in", () => {
    // A fixed permutation: deterministic, not random.
    const shuffled = [...fixture.events].sort((a, b) => ((a.seq * 7) % 11) - ((b.seq * 7) % 11) || a.seq - b.seq);
    expect(shuffled.map((e) => e.seq)).not.toEqual(fixture.events.map((e) => e.seq));
    expect(fold(fixture, shuffled)).toEqual(reference);
  });

  it("reports a gap until the missing event arrives", () => {
    const missing = fixture.events[5];
    const withGap = fold(fixture, fixture.events.filter((e) => e !== missing));
    expect(withGap.integrity.missingSeqs).toEqual([missing.seq]);
    const filled = reduce(withGap, missing);
    expect(filled.integrity.missingSeqs).toEqual([]);
    expect(filled).toEqual(reference);
  });
});
