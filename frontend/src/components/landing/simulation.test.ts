import { describe, expect, it } from "vitest";
import { CODER_IDS, PIPELINE_EDGES } from "./pipeline";
import { CYCLE_SECONDS, PHASES, phaseAt, simulationState } from "./simulation";

const at = (fraction: number) => simulationState(fraction * CYCLE_SECONDS);
const FAN_OUT = ["planner>coder-a", "planner>coder-b", "planner>coder-c"];
const CONVERGE = ["coder-a>reviewer", "coder-b>reviewer", "coder-c>reviewer"];

describe("the execution cycle", () => {
  it("plays plan, fan-out, evidence guard and verify, in that order", () => {
    expect(PHASES.map((phase) => phase.id)).toEqual(["plan", "fan-out", "evidence-guard", "verify"]);
    expect([0, 0.1, 0.2, 0.5, 0.6, 0.8, 0.9, 0.99].map((t) => at(t).phase)).toEqual([
      "plan",
      "plan",
      "fan-out",
      "fan-out",
      "evidence-guard",
      "evidence-guard",
      "verify",
      "verify",
    ]);
    expect(phaseAt(0.15).id).toBe("fan-out"); // a boundary belongs to the phase it starts
  });

  it("names each phase in the trace's own terms", () => {
    expect(PHASES.map((phase) => phase.detail)).toEqual([
      "routing_decision · plan",
      "agent_invocation × 3 · merge_wave",
      "reviewer · evidence checked",
      "verification · tests_passed",
    ]);
  });

  it("radiates the planner's pulse only while planning", () => {
    expect(at(0.05).plannerPulse).toBeCloseTo(1 / 3);
    expect(at(0.2).plannerPulse).toBeNull();
    expect(Object.values(at(0.05).packets).every((progress) => progress === null)).toBe(true);
  });

  it("sends the three fan-out packets together, and nothing else meanwhile", () => {
    const state = at(0.25); // half-way through the fan-out
    for (const edge of FAN_OUT) expect(state.packets[edge]).toBeCloseTo(0.5);
    for (const edge of [...CONVERGE, "reviewer>verifier"]) expect(state.packets[edge]).toBeNull();
  });

  it("fills every coder's progress ring after its packet arrives", () => {
    expect(at(0.3).coderProgress).toEqual([0, 0, 0]); // packets still travelling
    const working = at(0.45).coderProgress;
    expect(working).toHaveLength(CODER_IDS.length);
    for (const progress of working) expect(progress).toBeCloseTo(0.5);
    expect(at(0.7).coderProgress).toEqual([1, 1, 1]); // complete until the cycle restarts
    expect(at(0.05).coderProgress).toEqual([0, 0, 0]);
    for (const id of CODER_IDS) expect(at(0.5).glow[id]).toBeGreaterThan(at(0.2).glow[id]);
  });

  it("converges on the reviewer, sweeps the guard, then flashes", () => {
    const converging = at(0.635);
    for (const edge of CONVERGE) expect(converging.packets[edge]).toBeCloseTo(0.5);
    for (const edge of FAN_OUT) expect(converging.packets[edge]).toBeNull();
    expect(converging.guardScan).toBeNull();
    expect(at(0.78).guardScan).toBeCloseTo(0.5);
    expect(at(0.84).guardFlash).toBeCloseTo(1);
    expect(at(0.5).guardFlash).toBe(0);
  });

  it("fires the verification beam, then the verifier's shockwave", () => {
    expect(at(0.87).packets["reviewer>verifier"]).toBeCloseTo(0.5);
    expect(at(0.87).shockwave).toBeNull();
    expect(at(0.95).shockwave).toBeCloseTo(0.5);
    expect(at(0.95).packets["reviewer>verifier"]).toBeNull();
    expect(at(0.91).glow.verifier).toBeGreaterThan(0.9);
    expect(at(0.3).shockwave).toBeNull();
  });

  it("repeats, and stays within bounds at every instant", () => {
    expect(simulationState(CYCLE_SECONDS * 3 + 2)).toEqual(simulationState(2));
    expect(simulationState(-1).phase).toBe(simulationState(CYCLE_SECONDS - 1).phase);
    for (let step = 0; step < 200; step += 1) {
      const state = at(step / 200);
      expect(Object.keys(state.packets)).toEqual(PIPELINE_EDGES.map((edge) => edge.id));
      const values = [
        ...Object.values(state.packets),
        ...state.coderProgress,
        ...Object.values(state.glow),
        state.plannerPulse,
        state.guardScan,
        state.guardFlash,
        state.shockwave,
      ].filter((value): value is number => value !== null);
      for (const value of values) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });
});
