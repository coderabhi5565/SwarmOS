/**
 * The visualisation model: one renderer-neutral description of a run's
 * execution that both the 2D graph and the 3D scene draw. Built from the
 * normalised ExecutionState (the single source of truth) by a pure function.
 *
 * - Node ids are stable: agent:planner, step:<step id>, agent:reviewer,
 *   runner:verifier. The same entity keeps its id across every update.
 * - Layout is a deterministic grid that depends only on the plan: planner,
 *   one column per wave, reviewer, verifier. New events never move a node.
 * - `active` is true only for work the trace shows running (between a start
 *   event and its result); dispatched or historical work is never active.
 * - Dependency edges come only from recorded dependencies, never step order.
 */
import type { RunStatus } from "@/api/types";
import type {
  AgentStatus,
  ExecutionState,
  Invocation,
  ModelTier,
  PlanStepNode,
  RunnerNode,
  StepStatus,
} from "@/domain/execution";

export type VizRole = "planner" | "coder" | "reviewer" | "verifier";
/** agent: a model agent; step: one coder task; runner: the deterministic verifier. */
export type VizNodeKind = "agent" | "step" | "runner";
export type VizStatus =
  | "idle"
  | "pending"
  | "queued"
  | "running"
  | "awaiting_merge"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "skipped";

export interface VizNode {
  id: string;
  kind: VizNodeKind;
  role: VizRole;
  label: string;
  title: string | null;
  status: VizStatus;
  /** Running now, as established by lifecycle events. */
  active: boolean;
  /** Grid position: column left to right, row centred on 0. */
  column: number;
  row: number;
  wave: number | null;
  /** Steps: coding attempts. Agents: model calls. Runner: verification runs. */
  attempts: number;
  /** A step re-dispatched by a bounded retry. */
  retried: boolean;
  /** Steps: revisions the reviewer requested. */
  revisions: number;
  /** Steps: repair rounds after failed verification. */
  repairs: number;
  /** Some of this node's work ran on the strong (escalated) tier. */
  strongTier: boolean;
  /** Whether this node's work recorded start events (false for old traces). */
  startRecorded: boolean;
  /** Steps: recorded dependencies; null when the trace does not record them. */
  dependsOn: string[] | null;
}

/**
 * flow: the orchestration's fixed pipeline (plan -> first steps, last steps
 * -> review -> verification). dependency: a recorded step dependency.
 * revision / repair: the reviewer or verifier sent a step back.
 */
export type VizEdgeKind = "flow" | "dependency" | "revision" | "repair";

export interface VizEdge {
  id: string;
  kind: VizEdgeKind;
  source: string;
  target: string;
  /** The target is running now because of this relationship. */
  active: boolean;
  /** Revision / repair: how many times it happened. 1 otherwise. */
  count: number;
}

export interface VizWave {
  index: number;
  stepIds: string[];
  parallel: boolean;
}

export interface VizModel {
  /** The run's status as the trace establishes it; null when not yet known. */
  status: RunStatus | null;
  nodes: VizNode[];
  edges: VizEdge[];
  waves: VizWave[];
  /** Number of grid columns (planner, waves, reviewer, verifier). */
  columns: number;
  dependenciesKnown: boolean;
  /** False for traces recorded before lifecycle events. */
  lifecycleRecorded: boolean;
  finished: boolean;
  tier: ModelTier;
  escalations: number;
}

export const PLANNER_ID = "agent:planner";
export const REVIEWER_ID = "agent:reviewer";
export const RUNNER_ID = "runner:verifier";
export const stepNodeId = (stepId: string) => `step:${stepId}`;

const STEP_STATUS: Record<StepStatus, VizStatus> = {
  pending: "pending",
  dispatched: "queued",
  running: "running",
  coded: "awaiting_merge",
  merged: "succeeded",
  failed: "failed",
  interrupted: "interrupted",
};

const AGENT_STATUS: Record<AgentStatus, VizStatus> = {
  idle: "idle",
  running: "running",
  done: "succeeded",
  failed: "failed",
  skipped: "skipped",
  interrupted: "interrupted",
};

const RUNNER_STATUS: Record<RunnerNode["status"], VizStatus> = {
  idle: "idle",
  running: "running",
  passed: "succeeded",
  failed: "failed",
  interrupted: "interrupted",
};

export function buildVizModel(state: ExecutionState): VizModel {
  const plan = state.plan;
  const invocations = state.invocationOrder.map((id) => state.invocations[id]);
  const runs = state.verificationOrder.map((id) => state.verifications[id]);

  // Columns: planner | wave 1..n | (steps placed in no wave) | reviewer | verifier
  const waves: VizWave[] = (plan?.waves ?? []).map((stepIds, index) => ({
    index,
    stepIds: stepIds.filter((id) => plan?.steps[id]),
    parallel: stepIds.length > 1,
  }));
  const placed = new Set(waves.flatMap((wave) => wave.stepIds));
  const unplaced = (plan?.order ?? []).filter((id) => !placed.has(id));
  const stepColumns: string[][] = [...waves.map((wave) => wave.stepIds), ...(unplaced.length > 0 ? [unplaced] : [])];
  const reviewerColumn = 1 + stepColumns.length;
  const runnerColumn = reviewerColumn + 1;

  // Per-step facts derived from dispatches.
  const lastMode = new Map<string, string | null>();
  const retried = new Set<string>();
  const repairs = new Map<string, number>();
  for (const dispatch of state.dispatches) {
    for (const id of dispatch.steps) {
      lastMode.set(id, dispatch.mode);
      if (dispatch.mode === "retry") retried.add(id);
      if (dispatch.mode === "repair") repairs.set(id, (repairs.get(id) ?? 0) + 1);
    }
  }

  const byStep = groupBy(invocations.filter((i) => i.role === "coder" && i.stepId), (i) => i.stepId as string);
  const byRole = groupBy(invocations, (i) => i.role);

  const agentNode = (role: "planner" | "reviewer", column: number): VizNode => {
    const calls = byRole.get(role) ?? [];
    const agent = state.agents[role];
    return {
      id: role === "planner" ? PLANNER_ID : REVIEWER_ID,
      kind: "agent",
      role,
      label: role === "planner" ? "Planner" : "Reviewer",
      // Catalog runs take their plan from the task recipe; the planner never runs.
      title: role === "planner" && plan?.source === "recipe" ? "Plan from the task recipe" : null,
      status: AGENT_STATUS[agent.status],
      active: agent.status === "running",
      column,
      row: 0,
      wave: null,
      attempts: calls.length,
      retried: false,
      revisions: 0,
      repairs: 0,
      strongTier: calls.some((call) => call.tier === "strong"),
      startRecorded: calls.some((call) => call.startObserved),
      dependsOn: null,
    };
  };

  const stepNode = (step: PlanStepNode, column: number, row: number): VizNode => {
    const calls = byStep.get(step.id) ?? [];
    return {
      id: stepNodeId(step.id),
      kind: "step",
      role: "coder",
      label: step.id,
      title: step.title,
      status: STEP_STATUS[step.status],
      active: step.status === "running",
      column,
      row,
      wave: step.wave,
      attempts: step.attempts,
      retried: retried.has(step.id),
      revisions: step.revisionsRequested,
      repairs: repairs.get(step.id) ?? 0,
      strongTier: calls.some((call) => call.tier === "strong"),
      startRecorded: calls.some((call) => call.startObserved),
      dependsOn: step.dependsOn,
    };
  };

  const nodes: VizNode[] = [agentNode("planner", 0)];
  stepColumns.forEach((ids, index) => {
    ids.forEach((id, position) => {
      nodes.push(stepNode(plan!.steps[id], 1 + index, position - (ids.length - 1) / 2));
    });
  });
  nodes.push(agentNode("reviewer", reviewerColumn));
  nodes.push({
    id: RUNNER_ID,
    kind: "runner",
    role: "verifier",
    label: "Verifier",
    title: "Deterministic test runner",
    status: RUNNER_STATUS[state.verifier.status],
    active: state.verifier.status === "running",
    column: runnerColumn,
    row: 0,
    wave: null,
    attempts: runs.length,
    retried: false,
    revisions: 0,
    repairs: 0,
    strongTier: false,
    startRecorded: runs.some((run) => run.startObserved),
    dependsOn: null,
  });

  const active = new Set(nodes.filter((node) => node.active).map((node) => node.id));
  const steps = stepColumns.flat().map((id) => plan!.steps[id]);
  const dependenciesKnown = Boolean(plan?.dependenciesKnown);
  const edges: VizEdge[] = [];
  const edge = (kind: VizEdgeKind, source: string, target: string, count = 1, id = `${kind}:${source}->${target}`) =>
    edges.push({ id, kind, source, target, count, active: false });

  // The pipeline. With recorded dependencies, roots and sinks come from them;
  // otherwise from the recorded waves (first and last).
  const dependents = new Set(steps.flatMap((step) => step.dependsOn ?? []));
  const roots = dependenciesKnown
    ? steps.filter((step) => (step.dependsOn ?? []).length === 0)
    : steps.filter((step) => step.wave === 0 || (step.wave === null && waves.length === 0));
  const sinks = dependenciesKnown
    ? steps.filter((step) => !dependents.has(step.id))
    : steps.filter((step) => step.wave === waves.length - 1 || step.wave === null);
  if (steps.length === 0) {
    edge("flow", PLANNER_ID, REVIEWER_ID);
  } else {
    for (const step of roots) edge("flow", PLANNER_ID, stepNodeId(step.id));
    for (const step of sinks) edge("flow", stepNodeId(step.id), REVIEWER_ID);
  }
  edge("flow", REVIEWER_ID, RUNNER_ID);

  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (plan!.steps[dep]) edge("dependency", stepNodeId(dep), stepNodeId(step.id));
    }
    if (step.revisionsRequested > 0) edge("revision", REVIEWER_ID, stepNodeId(step.id), step.revisionsRequested);
    const repairCount = repairs.get(step.id) ?? 0;
    if (repairCount > 0) edge("repair", RUNNER_ID, stepNodeId(step.id), repairCount);
  }

  for (const item of edges) {
    if (!active.has(item.target)) continue;
    if (item.kind === "flow" || item.kind === "dependency") {
      // Flow and dependency edges light up for first runs and retries alike.
      const mode = item.target.startsWith("step:") ? lastMode.get(item.target.slice(5)) : null;
      item.active = mode !== "revision" && mode !== "repair";
    } else {
      // A revision / repair edge is active only while that round is running.
      item.active = lastMode.get(item.target.slice(5)) === item.kind;
    }
  }

  return {
    status: state.status,
    nodes,
    edges,
    waves,
    columns: runnerColumn + 1,
    dependenciesKnown,
    lifecycleRecorded: invocations.some((i) => i.startObserved) || runs.some((run) => run.startObserved),
    finished: state.outcome !== null,
    tier: state.tier,
    escalations: state.escalations.length,
  };
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

/**
 * Reuse every node and edge object that did not change, so renderers can
 * skip unchanged entities; returns `prev` itself when nothing changed.
 */
export function reconcileVizModel(prev: VizModel | null, next: VizModel): VizModel {
  if (!prev) return next;
  const prevNodes = new Map(prev.nodes.map((node) => [node.id, node]));
  const prevEdges = new Map(prev.edges.map((edge) => [edge.id, edge]));
  const nodes = next.nodes.map((node) => reuse(prevNodes.get(node.id), node));
  const edges = next.edges.map((edge) => reuse(prevEdges.get(edge.id), edge));
  const prevWaves = new Map(prev.waves.map((wave) => [wave.index, wave]));
  const waves = next.waves.map((wave) => reuse(prevWaves.get(wave.index), wave));
  const candidate = {
    ...next,
    nodes: sameItems(prev.nodes, nodes) ? prev.nodes : nodes,
    edges: sameItems(prev.edges, edges) ? prev.edges : edges,
    waves: sameItems(prev.waves, waves) ? prev.waves : waves,
  };
  return shallowEqual(prev, candidate) ? prev : candidate;
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function reuse<T extends object>(prev: T | undefined, next: T): T {
  return prev && shallowEqual(prev, next) ? prev : next;
}

function shallowEqual(a: object, b: object): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => {
    const x = left[key];
    const y = right[key];
    if (Array.isArray(x) && Array.isArray(y)) return sameItems(x, y);
    return Object.is(x, y);
  });
}

/** For the details panel: a node's calls, in trace order. */
export function invocationsForNode(state: ExecutionState, node: VizNode): Invocation[] {
  const all = state.invocationOrder.map((id) => state.invocations[id]);
  if (node.kind === "step") return all.filter((i) => i.role === "coder" && i.stepId === node.label);
  if (node.kind === "agent") return all.filter((i) => i.role === node.role);
  return [];
}
