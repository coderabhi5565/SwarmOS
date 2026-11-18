/**
 * The orchestration pipeline the landing hero draws, in 3D and in the 2D
 * fallback: planner, one parallel wave of three coders, the reviewer's
 * evidence guard, then deterministic verification. Plain data: no three.js.
 */
export type PipelineRole = "planner" | "coder" | "reviewer" | "verifier";

export interface PipelineNode {
  id: string;
  role: PipelineRole;
  label: string;
  description: string;
  /**
   * What SwarmOS records for this role: real event kinds, payload fields,
   * span metrics and statuses, by name. No figures: the hero is an
   * illustration, not a measurement.
   */
  telemetry: string[];
  /** sRGB hex accent, for three.js (which does not parse the theme's oklch). */
  color: string;
  /** Scene position (x right, y up, z towards the viewer). */
  position: [number, number, number];
  /** Centre in the 2D diagram's 640 × 260 view box. */
  point: [number, number];
}

const CODER = "One step of a wave, written in its own checkout and merged only after conflict checks.";
const CODER_TELEMETRY = [
  "event: agent_invocation · role coder",
  "span: coder_busy_ms · coder_wall_ms",
  "span: coder_critical_path_ms",
  "merge: routing_decision · merge_wave",
];

export const PIPELINE_NODES: PipelineNode[] = [
  {
    id: "planner",
    role: "planner",
    label: "Planner",
    description: "Turns the goal into a typed plan: steps, dependencies and parallel waves.",
    telemetry: ["event: routing_decision · plan_accepted", "state: typed plan · dependency waves", "span: planner_ms"],
    color: "#a78bfa",
    position: [-4.4, 0, 0],
    point: [70, 130],
  },
  // The wave sits on an arc around the planner, bowed towards the viewer.
  { id: "coder-a", role: "coder", label: "Coder A", description: CODER, telemetry: CODER_TELEMETRY, color: "#38bdf8", position: [-1.5, 1.6, 0.1], point: [250, 50] },
  { id: "coder-b", role: "coder", label: "Coder B", description: CODER, telemetry: CODER_TELEMETRY, color: "#818cf8", position: [-1.0, 0, 0.9], point: [250, 130] },
  { id: "coder-c", role: "coder", label: "Coder C", description: CODER, telemetry: CODER_TELEMETRY, color: "#34d399", position: [-1.5, -1.6, 0.1], point: [250, 210] },
  {
    id: "reviewer",
    role: "reviewer",
    label: "Reviewer evidence guard",
    description: "A blocker must cite a real file, line and test output; otherwise the review is invalid.",
    telemetry: ["guard: review_invalid check", "evidence: file · line · test output", "span: reviewer_ms"],
    color: "#fbbf24",
    position: [1.7, 0, 0],
    point: [420, 130],
  },
  {
    id: "verifier",
    role: "verifier",
    label: "Deterministic verifier",
    description: "Runs the test command in a subprocess. No model decides pass or fail.",
    telemetry: [
      "runner: deterministic_subprocess",
      "sandbox: audit_hook + rlimits",
      "event: verification · tests_passed · exit_code",
      "span: verification_ms",
    ],
    color: "#6ee7b7",
    position: [4.4, 0, 0],
    point: [570, 130],
  },
];

export interface PipelineEdge {
  id: string;
  from: string;
  to: string;
}

export const PIPELINE_EDGES: PipelineEdge[] = [
  { id: "planner>coder-a", from: "planner", to: "coder-a" },
  { id: "planner>coder-b", from: "planner", to: "coder-b" },
  { id: "planner>coder-c", from: "planner", to: "coder-c" },
  { id: "coder-a>reviewer", from: "coder-a", to: "reviewer" },
  { id: "coder-b>reviewer", from: "coder-b", to: "reviewer" },
  { id: "coder-c>reviewer", from: "coder-c", to: "reviewer" },
  { id: "reviewer>verifier", from: "reviewer", to: "verifier" },
];

export const CODER_IDS = ["coder-a", "coder-b", "coder-c"] as const;

export function pipelineNode(id: string): PipelineNode {
  const node = PIPELINE_NODES.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`unknown pipeline node ${id}`);
  return node;
}

/** The edges into and out of a node: the paths a focused node highlights. */
export function connectedEdges(nodeId: string): string[] {
  return PIPELINE_EDGES.filter((edge) => edge.from === nodeId || edge.to === nodeId).map((edge) => edge.id);
}
