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
  /** Scene position (x right, y up, z towards the viewer). */
  position: [number, number, number];
  /** Centre in the 2D diagram's 640 × 260 view box. */
  point: [number, number];
}

const CODER = "One step of a wave, written in its own checkout and merged only after conflict checks.";

export const PIPELINE_NODES: PipelineNode[] = [
  {
    id: "planner",
    role: "planner",
    label: "Planner",
    description: "Turns the goal into a typed plan: steps, dependencies and parallel waves.",
    position: [-4.4, 0, 0],
    point: [70, 130],
  },
  { id: "coder-a", role: "coder", label: "Coder A", description: CODER, position: [-1.4, 1.5, 0.5], point: [250, 50] },
  { id: "coder-b", role: "coder", label: "Coder B", description: CODER, position: [-1.4, 0, -0.5], point: [250, 130] },
  { id: "coder-c", role: "coder", label: "Coder C", description: CODER, position: [-1.4, -1.5, 0.5], point: [250, 210] },
  {
    id: "reviewer",
    role: "reviewer",
    label: "Reviewer evidence guard",
    description: "A blocker must cite a real file, line and test output; otherwise the review is invalid.",
    position: [1.6, 0, 0],
    point: [420, 130],
  },
  {
    id: "verifier",
    role: "verifier",
    label: "Deterministic verifier",
    description: "Runs the test command in a subprocess. No model decides pass or fail.",
    position: [4.4, 0, 0],
    point: [570, 130],
  },
];

export const PIPELINE_EDGES: { id: string; from: string; to: string }[] = [
  { id: "planner>coder-a", from: "planner", to: "coder-a" },
  { id: "planner>coder-b", from: "planner", to: "coder-b" },
  { id: "planner>coder-c", from: "planner", to: "coder-c" },
  { id: "coder-a>reviewer", from: "coder-a", to: "reviewer" },
  { id: "coder-b>reviewer", from: "coder-b", to: "reviewer" },
  { id: "coder-c>reviewer", from: "coder-c", to: "reviewer" },
  { id: "reviewer>verifier", from: "reviewer", to: "verifier" },
];

export function pipelineNode(id: string): PipelineNode {
  const node = PIPELINE_NODES.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`unknown pipeline node ${id}`);
  return node;
}

/** sRGB hex per role, for three.js (which does not parse the theme's oklch). */
export const ROLE_HEX: Record<PipelineRole, string> = {
  planner: "#a78bfa",
  coder: "#60a5fa",
  reviewer: "#fbbf24",
  verifier: "#34d399",
};
