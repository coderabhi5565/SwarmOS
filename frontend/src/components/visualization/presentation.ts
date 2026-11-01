/**
 * How the visualisation model reads on screen, shared by the 2D graph, the 3D
 * scene and the details panel so every view says the same thing.
 */
import type { Tone } from "@/components/execution/primitives";
import type { VizEdge, VizModel, VizNode, VizStatus } from "@/domain/visualization";

const STATUS_TONE: Record<VizStatus, Tone> = {
  idle: "muted",
  pending: "muted",
  queued: "muted",
  running: "live",
  awaiting_merge: "muted",
  succeeded: "completed",
  failed: "failed",
  interrupted: "cancelled",
  skipped: "muted",
};

export function statusTone(node: VizNode): Tone {
  return STATUS_TONE[node.status];
}

/** The status in words. Idle work of a finished run never ran. */
export function statusLabel(node: VizNode, finished: boolean): string {
  switch (node.status) {
    case "idle":
      return finished ? "not reached" : "idle";
    case "queued":
      return "dispatched";
    case "awaiting_merge":
      return "awaiting merge";
    case "skipped":
      return node.title ? "recipe plan" : "skipped";
    default:
      return node.status;
  }
}

export const ROLE_LABEL: Record<VizNode["role"], string> = {
  planner: "Planner agent",
  coder: "Coder step",
  reviewer: "Reviewer agent",
  verifier: "Verification runner (deterministic)",
};

/** Short facts shown as badges on a node: retries, rounds, tier. */
export function nodeBadges(node: VizNode): string[] {
  const badges: string[] = [];
  if (node.kind === "step" && node.attempts > 1) badges.push(`${node.attempts} attempts`);
  if (node.kind !== "step" && node.attempts > 1) badges.push(`${node.attempts} ${node.kind === "runner" ? "runs" : "calls"}`);
  if (node.retried) badges.push("retried");
  if (node.revisions > 0) badges.push(`revised ×${node.revisions}`);
  if (node.repairs > 0) badges.push(`repaired ×${node.repairs}`);
  if (node.strongTier) badges.push("strong tier");
  return badges;
}

/** A node in one sentence, for screen readers and canvas labels. */
export function nodeDescription(node: VizNode, finished: boolean): string {
  const name = node.kind === "step" ? `Coder step ${node.label}` : ROLE_LABEL[node.role];
  const facts = [statusLabel(node, finished), ...nodeBadges(node)];
  if (node.wave !== null) facts.push(`wave ${node.wave + 1}`);
  return `${name}: ${facts.join(", ")}`;
}

export const EDGE_LABEL: Record<VizEdge["kind"], string> = {
  flow: "hands off to",
  dependency: "must finish before",
  revision: "requested a revision of",
  repair: "sent back for repair",
};

export function edgeDescription(edge: VizEdge, model: VizModel): string {
  const name = (id: string) => model.nodes.find((node) => node.id === id)?.label ?? id;
  const count = edge.count > 1 ? ` (${edge.count} times)` : "";
  return `${name(edge.source)} ${EDGE_LABEL[edge.kind]} ${name(edge.target)}${count}`;
}

/**
 * Colours for the 3D scene, which cannot read the CSS oklch tokens. sRGB
 * approximations of the --agent-* and --status-* tokens in globals.css.
 */
export const SCENE_COLORS = {
  planner: "#a77bf3",
  coder: "#5b8def",
  reviewer: "#e8b54d",
  verifier: "#3fcf9a",
  live: "#5b8def",
  completed: "#3fcf9a",
  findings: "#e8b54d",
  invalid: "#a77bf3",
  failed: "#ec5a4f",
  cancelled: "#8a8fa0",
  muted: "#4a5068",
  edge: "#6b7290",
} as const;
