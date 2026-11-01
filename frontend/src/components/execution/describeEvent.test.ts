import { describe, expect, it } from "vitest";
import { normalizeEvent } from "@/domain/execution";
import { allFixtures, fixtures } from "@/domain/execution/fixtures";
import { describeEvent } from "./describeEvent";

const views = (name: keyof typeof fixtures) => fixtures[name].events.map((event) => describeEvent(normalizeEvent(event)));

describe("describeEvent", () => {
  it("describes every recorded event without falling back to 'unrecognised'", () => {
    for (const fixture of allFixtures) {
      for (const event of fixture.events) {
        expect(describeEvent(normalizeEvent(event)).title, `${fixture.name} #${event.seq}`).not.toMatch(/^Unrecognised/);
      }
    }
  });

  it("attributes verification to the runner and orchestration to the orchestrator", () => {
    const all = views("demoPipelineCompleted");
    expect(all.find((v) => v.title === "Verification passed")?.actor).toBe("verifier");
    expect(all.find((v) => v.title.startsWith("Dispatched"))?.actor).toBe("orchestrator");
    expect(all.find((v) => v.title === "Plan supplied by the recipe")?.actor).toBe("orchestrator");
  });

  it("files rejections, failed calls and refusals under problems", () => {
    expect(views("reviewRevisionCompleted").find((v) => v.title === "Review requested changes")?.category).toBe("problems");
    expect(views("retryEscalation").filter((v) => v.title === "Coder failed").every((v) => v.category === "problems")).toBe(true);
    expect(views("callLimitExhausted").find((v) => v.title === "Call refused by the budget")?.actor).toBe("reviewer");
  });

  it("marks an invalid review distinctly from other failures", () => {
    const invalid = views("reviewInvalid").find((v) => v.title === "Review rejected without substantiated evidence");
    expect(invalid?.tone).toBe("invalid");
  });

  it("names unknown kinds instead of hiding them", () => {
    const unknown = normalizeEvent({ event_id: "e", run_id: "r", seq: 1, at: "2026-11-01T00:00:00Z", kind: "telepathy", message: "", payload: {} } as never);
    expect(describeEvent(unknown).title).toBe("Unrecognised event (telepathy)");
  });
});
