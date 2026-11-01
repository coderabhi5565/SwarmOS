/**
 * Pure derived facts about an ExecutionState, so views never recompute them
 * from raw events. Like the reducer, these never fill gaps with guesses:
 * a total is null when any contributing value was not reported.
 */
import type { AgentRole, ExecutionState, Invocation, PlanStepNode, VerificationRun } from "./model";

export interface UsageTotals {
  /** Model calls that finished (succeeded or failed). */
  finishedCalls: number;
  failedCalls: number;
  /** Calls still open (running). */
  openCalls: number;
  /** null unless every finished call reported usage. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** True when at least one finished call lacks usage metadata. */
  usagePartial: boolean;
  /** Sum of reported per-call cost estimates; null if none reported one. */
  costUsd: number | null;
}

export function invocationsOf(state: ExecutionState): Invocation[] {
  return state.invocationOrder.map((id) => state.invocations[id]);
}

export function verificationRunsOf(state: ExecutionState): VerificationRun[] {
  return state.verificationOrder.map((id) => state.verifications[id]);
}

export function usageTotals(state: ExecutionState): UsageTotals {
  const all = invocationsOf(state);
  const finished = all.filter((i) => i.status === "succeeded" || i.status === "failed");
  const reported = finished.filter((i) => i.inputTokens !== null && i.outputTokens !== null);
  const complete = finished.length > 0 && reported.length === finished.length;
  const costs = finished.map((i) => i.costUsd).filter((cost): cost is number => cost !== null);
  return {
    finishedCalls: finished.length,
    failedCalls: finished.filter((i) => i.status === "failed").length,
    openCalls: all.filter((i) => i.status === "running").length,
    inputTokens: complete ? reported.reduce((sum, i) => sum + (i.inputTokens ?? 0), 0) : null,
    outputTokens: complete ? reported.reduce((sum, i) => sum + (i.outputTokens ?? 0), 0) : null,
    usagePartial: finished.length > 0 && !complete,
    costUsd: costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) : null,
  };
}

/** Whether the trace recorded call starts (M3.0+) or only completions. */
export function lifecycleRecorded(state: ExecutionState): boolean {
  return (
    invocationsOf(state).some((i) => i.startObserved) ||
    verificationRunsOf(state).some((run) => run.startObserved)
  );
}

/** Calls in flight right now, oldest first. */
export function activeInvocations(state: ExecutionState): Invocation[] {
  return invocationsOf(state).filter((i) => i.status === "running");
}

/** Invocations of one agent, in trace order. */
export function invocationsFor(state: ExecutionState, role: AgentRole): Invocation[] {
  return state.agents[role].invocationIds.map((id) => state.invocations[id]);
}

/** Plan steps grouped by wave; steps the plan did not place go last. */
export function stepsByWave(state: ExecutionState): PlanStepNode[][] {
  const plan = state.plan;
  if (!plan) return [];
  const placed = new Set(plan.waves.flat());
  const waves = plan.waves.map((wave) => wave.map((id) => plan.steps[id]).filter(Boolean));
  const unplaced = plan.order.filter((id) => !placed.has(id)).map((id) => plan.steps[id]);
  return unplaced.length > 0 ? [...waves, unplaced] : waves;
}

/** Wall-clock span of the run when both ends were recorded. */
export function runDurationMs(state: ExecutionState): number | null {
  if (!state.startedAt || !state.finishedAt) return null;
  const span = Date.parse(state.finishedAt) - Date.parse(state.startedAt);
  return Number.isFinite(span) && span >= 0 ? span : null;
}
