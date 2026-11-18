/**
 * The hero's self-playing execution cycle, as a pure function of time: which
 * phase is showing, where each packet is on its edge and how lit each node
 * is. The 3D scene only draws this; nothing here touches three.js, so the
 * choreography is tested without WebGL. It illustrates the order of a run,
 * not measured timings.
 */
import { CODER_IDS, PIPELINE_EDGES } from "./pipeline";

export const CYCLE_SECONDS = 9;

export type PhaseId = "plan" | "fan-out" | "evidence-guard" | "verify";

export interface Phase {
  id: PhaseId;
  /** Start of the phase, as a fraction of the cycle. */
  start: number;
  label: string;
  /** What the trace records at this point, in the backend's own terms. */
  detail: string;
}

export const PHASES: Phase[] = [
  { id: "plan", start: 0, label: "Plan", detail: "routing_decision · plan" },
  { id: "fan-out", start: 0.15, label: "Parallel fan-out", detail: "agent_invocation × 3 · merge_wave" },
  { id: "evidence-guard", start: 0.55, label: "Evidence guard", detail: "reviewer · evidence checked" },
  { id: "verify", start: 0.84, label: "Deterministic verify", detail: "verification · tests_passed" },
];

// Sub-steps inside the phases (fractions of the cycle).
const FAN_OUT_END = 0.35; // packets reach the coders
const CODING_END = 0.55; // progress rings complete
const CONVERGE_END = 0.72; // packets reach the reviewer
const GUARD_END = 0.84; // the scan completes and flashes
const BEAM_END = 0.9; // the verification beam reaches the verifier

export interface SimulationState {
  phase: PhaseId;
  /** 0..1 while the planner's pulse radiates, else null. */
  plannerPulse: number | null;
  /** Progress 0..1 of the packet on each edge, or null when none travels. */
  packets: Record<string, number | null>;
  /** Each coder's progress ring, 0..1 (in CODER_IDS order). */
  coderProgress: number[];
  /** 0..1 while the guard's ring sweeps, else null. */
  guardScan: number | null;
  /** 0..1 brightness of the guard's "evidence checked" flash. */
  guardFlash: number;
  /** 0..1 while the verifier's shockwave expands, else null. */
  shockwave: number | null;
  /** 0..1 extra glow per node id. */
  glow: Record<string, number>;
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));
/** Progress of `t` through [from, to], or null outside it. */
const within = (t: number, from: number, to: number) => (t >= from && t < to ? (t - from) / (to - from) : null);
/** Rises to 1 at `peak` and falls back to 0 `width` either side. */
const bump = (t: number, peak: number, width: number) => clamp(1 - Math.abs(t - peak) / width);

export function phaseAt(t: number): Phase {
  let current = PHASES[0];
  for (const phase of PHASES) if (t >= phase.start) current = phase;
  return current;
}

/** The cycle's state at `seconds` (any value: the cycle repeats). */
export function simulationState(seconds: number): SimulationState {
  const t = (((seconds % CYCLE_SECONDS) + CYCLE_SECONDS) % CYCLE_SECONDS) / CYCLE_SECONDS;
  const fanOut = within(t, PHASES[1].start, FAN_OUT_END);
  const converge = within(t, CODING_END, CONVERGE_END);
  const beam = within(t, GUARD_END, BEAM_END);

  const packets: Record<string, number | null> = {};
  for (const edge of PIPELINE_EDGES) {
    if (edge.from === "planner") packets[edge.id] = fanOut; // the three leave together
    else if (edge.to === "reviewer") packets[edge.id] = converge;
    else packets[edge.id] = beam;
  }

  const coding = t < FAN_OUT_END ? 0 : clamp((t - FAN_OUT_END) / (CODING_END - FAN_OUT_END));
  // A ring stays complete until the cycle restarts, then empties.
  const coderProgress = CODER_IDS.map(() => (t < PHASES[1].start ? 0 : coding));
  const coderGlow = t >= FAN_OUT_END && t < CONVERGE_END ? 0.4 + 0.6 * bump(t, CODING_END, CODING_END - FAN_OUT_END) : 0;

  const glow: Record<string, number> = {
    planner: bump(t, 0.07, 0.12),
    reviewer: Math.max(bump(t, CONVERGE_END, 0.06), bump(t, GUARD_END, 0.05)),
    verifier: bump(t, BEAM_END + 0.01, 0.07),
  };
  for (const id of CODER_IDS) glow[id] = coderGlow;

  return {
    phase: phaseAt(t).id,
    plannerPulse: within(t, 0, PHASES[1].start),
    packets,
    coderProgress,
    guardScan: within(t, CONVERGE_END, GUARD_END),
    guardFlash: bump(t, GUARD_END, 0.04),
    shockwave: within(t, BEAM_END, 1),
    glow,
  };
}
