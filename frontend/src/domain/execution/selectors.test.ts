import { describe, expect, it } from "vitest";
import { fixtures } from "./fixtures";
import { replay } from "./replay";
import {
  activeInvocations,
  invocationsFor,
  lifecycleRecorded,
  runDurationMs,
  stepsByWave,
  usageTotals,
} from "./selectors";

const final = (name: keyof typeof fixtures) =>
  replay(fixtures[name].events, { seed: fixtures[name].run });

describe("selectors", () => {
  it("withholds token totals when the provider reported no usage", () => {
    const usage = usageTotals(final("demoPipelineCompleted"));
    expect(usage.finishedCalls).toBe(4);
    expect(usage.inputTokens).toBeNull();
    expect(usage.usagePartial).toBe(true);
  });

  it("sums tokens when every call reported usage", () => {
    const usage = usageTotals(final("legacyFalseBlocker"));
    expect(usage.usagePartial).toBe(false);
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);
  });

  it("counts failed calls separately", () => {
    expect(usageTotals(final("retryEscalation"))).toMatchObject({ failedCalls: 2, openCalls: 0 });
  });

  it("tells current traces from ones without lifecycle events", () => {
    expect(lifecycleRecorded(final("demoPipelineCompleted"))).toBe(true);
    expect(lifecycleRecorded(final("legacyPlannerRevision"))).toBe(false);
  });

  it("lists calls in flight, and none once the run is closed", () => {
    const fixture = fixtures.cancelledMidCall;
    const beforeEnd = replay(fixture.events, { seed: fixture.run, untilSeq: fixture.events.length - 1 });
    expect(activeInvocations(beforeEnd).map((i) => i.role)).toEqual(["planner"]);
    expect(activeInvocations(final("cancelledMidCall"))).toEqual([]);
  });

  it("groups steps by wave in plan order", () => {
    expect(stepsByWave(final("demoPipelineCompleted")).map((wave) => wave.map((s) => s.id))).toEqual([
      ["inspect_tests", "draft_implementation"],
      ["document_change"],
    ]);
    expect(invocationsFor(final("reviewRevisionCompleted"), "reviewer")).toHaveLength(2);
  });

  it("reports the run's span only when both ends were recorded", () => {
    expect(runDurationMs(final("demoPipelineCompleted"))).toBeGreaterThanOrEqual(0);
    const open = replay(fixtures.demoPipelineCompleted.events, { untilSeq: 3 });
    expect(runDurationMs(open)).toBeNull();
  });
});
