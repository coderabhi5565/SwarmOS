import { describe, expect, it } from "vitest";
import type { TraceEvent } from "@/api/types";
import { normalizeEvent, type NormalizedEvent } from "./events";
import { allFixtures, fixtures } from "./fixtures";

function event(kind: string, payload: Record<string, unknown>, seq = 1, message = ""): TraceEvent {
  return { event_id: `evt_${seq}`, run_id: "run_t", seq, at: "2026-11-01T00:00:00Z", kind, message, payload } as TraceEvent;
}

function first<T extends NormalizedEvent["type"]>(events: TraceEvent[], type: T) {
  const found = events.map(normalizeEvent).find((e) => e.type === type);
  expect(found, `no ${type}`).toBeDefined();
  return found as Extract<NormalizedEvent, { type: T }>;
}

describe("normalizeEvent on recorded traces", () => {
  it("understands every event in every recorded trace", () => {
    for (const fixture of allFixtures) {
      for (const raw of fixture.events) {
        const normalized = normalizeEvent(raw);
        expect(normalized.type, `${fixture.name} #${raw.seq} ${raw.kind}`).not.toBe("unknown");
        expect(normalized.seq).toBe(raw.seq);
      }
    }
  });

  it("reads a legacy invocation id and timing from the embedded record", () => {
    const done = first(fixtures.legacyPlannerRevision.events, "agent_finished");
    expect(done.idRecorded).toBe(true);
    expect(done.invocationId).toMatch(/^inv_/);
    expect(done.role).toBe("planner");
    expect(done.startedAt).not.toBeNull();
    expect(done.latencyMs).toBeGreaterThan(0);
    // That local model reported usage, so the counts are real.
    expect(done.inputTokens).toBeGreaterThan(0);
  });

  it("maps the earliest revision counter name and missing dispatch mode", () => {
    const rejected = first(fixtures.legacyPlannerRevision.events, "review_rejected");
    expect(rejected.rejection).toBe(1);
    expect(first(fixtures.legacyPlannerRevision.events, "coding_dispatched").mode).toBeNull();
  });

  it("keeps dependencies unknown when an old plan event omits them", () => {
    const plan = first(fixtures.legacyFalseBlocker.events, "plan_ready");
    expect(plan.source).toBe("recipe");
    expect(plan.steps).toBeNull();
    expect(plan.waves).toEqual([["draft_implementation"]]);
  });

  it("reads dependencies from a current plan event", () => {
    const plan = first(fixtures.demoPipelineCompleted.events, "plan_ready");
    const document = plan.steps?.find((step) => step.id === "document_change");
    expect(document?.dependsOn).toEqual(["inspect_tests", "draft_implementation"]);
  });

  it("reads a legacy verification without an id", () => {
    const done = first(fixtures.legacyFalseBlocker.events, "verification_finished");
    expect(done.verificationId).toBeNull();
    expect(done.diagnostic).toBe(true);
    expect(done.passed).toBe(true);
  });

  it("does not report tokens a provider never reported", () => {
    const done = first(fixtures.demoPipelineCompleted.events, "agent_finished");
    expect(done.inputTokens).toBeNull();
    expect(done.outputTokens).toBeNull();
  });
});

describe("normalizeEvent on shapes no recording contains", () => {
  it("splits a legacy multi-step conflict and falls back to the message", () => {
    const normalized = normalizeEvent(
      event("failure", { steps: ["alpha", "beta"], files: ["out/x.txt"] }, 4, "Rejected conflicting parallel writes"),
    );
    expect(normalized).toMatchObject({
      type: "failure",
      error: "Rejected conflicting parallel writes",
      stepIds: ["alpha", "beta"],
      role: null,
      details: { files: ["out/x.txt"] },
    });
  });

  it("keeps a current failure's context and diagnostics apart", () => {
    const normalized = normalizeEvent(
      event("failure", { error: "boom", error_class: "code_policy", role: "coder", step_id: "alpha", attempt: 2, violations: ["x"] }),
    );
    expect(normalized).toMatchObject({
      type: "failure",
      errorClass: "code_policy",
      role: "coder",
      stepIds: ["alpha"],
      attempt: 2,
      details: { violations: ["x"] },
    });
  });

  it("infers a legacy retry's scope only from the fields it carries", () => {
    expect(normalizeEvent(event("retry", { steps: ["alpha"], attempts: { alpha: 2 } }))).toMatchObject({ scope: "steps" });
    expect(normalizeEvent(event("retry", { role: "planner", category: "timeout" }))).toMatchObject({ scope: "call" });
  });

  it("never assumes an invocation outcome", () => {
    const normalized = normalizeEvent(event("agent_invocation", { role: "coder", invocation_id: "inv_1" }));
    expect(normalized).toMatchObject({ type: "unknown", rawKind: "agent_invocation:unknown-status" });
  });

  it("keeps unknown kinds and routing decisions as unknown", () => {
    expect(normalizeEvent(event("telepathy", { x: 1 }))).toMatchObject({ type: "unknown", rawKind: "telepathy" });
    expect(normalizeEvent(event("routing_decision", { decision: "teleport" }))).toMatchObject({
      type: "unknown",
      rawKind: "routing_decision:teleport",
    });
  });
});
