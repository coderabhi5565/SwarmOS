/**
 * The execution reducer: (state, trace event) -> state. Pure and framework
 * free: no React, store, DOM, or clock.
 *
 * - Events are applied in seq order. A seq already applied is a duplicate and
 *   returns the same state object. An event older than the newest applied one
 *   rebuilds the state from the sorted log, so the result depends only on the
 *   set of events received, never on their arrival order.
 * - Nothing is inferred beyond what an event establishes: a dispatched step is
 *   not "running", an old trace without agent_started never shows a call in
 *   progress, and run_finished closes open work as interrupted, never as
 *   succeeded.
 */
import type { RunStatus, TraceEvent } from "@/api/types";
import { normalizeEvent, normalizeSteps, type NormalizedEvent, type NormalizedStep } from "./events";
import type {
  AgentNode,
  AgentRole,
  ExecutionState,
  Invocation,
  Phase,
  PlanState,
  PlanStepNode,
  ReviewRound,
  RunSeed,
  VerificationRun,
} from "./model";

const ROLES: readonly AgentRole[] = ["planner", "coder", "reviewer"];
const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "completed",
  "completed_with_findings",
  "review_invalid",
  "failed",
  "cancelled",
  "budget_exceeded",
  "limit_exceeded",
  "timed_out",
]);

export function isTerminal(status: RunStatus | null | undefined): status is RunStatus {
  return status !== null && status !== undefined && TERMINAL.has(status);
}

function agentNode(role: AgentRole): AgentNode {
  return { role, kind: "agent", status: "idle", activeInvocationIds: [], invocationIds: [] };
}

/**
 * The state before any event. The seed (the stored run record) contributes
 * only what is known up front: identity, goal and limits. Its plan is used to
 * fill in dependencies an old plan event lacks, and its status only when the
 * trace never finishes (see settleWithRecord); otherwise state comes from
 * events alone, so a replay shows each moment as it was.
 */
export function initialState(seed: RunSeed | null = null): ExecutionState {
  return {
    runId: seed?.run_id ?? null,
    goal: seed?.goal ?? null,
    seed,
    status: null,
    phase: "not_started",
    tier: "fast",
    startedAt: null,
    finishedAt: null,
    plan: null,
    agents: { planner: agentNode("planner"), coder: agentNode("coder"), reviewer: agentNode("reviewer") },
    verifier: { role: "verifier", kind: "deterministic_runner", status: "idle", runIds: [] },
    invocations: {},
    invocationOrder: [],
    verifications: {},
    verificationOrder: [],
    reviews: [],
    dispatches: [],
    merges: [],
    escalations: [],
    retries: [],
    repairs: [],
    providerErrors: [],
    failures: [],
    warnings: [],
    budget: { limits: seed?.limits ?? null, ledger: null, refusals: [] },
    outcome: null,
    log: [],
    lastSeq: 0,
    integrity: { missingSeqs: [], unknownKinds: [] },
  };
}

/** Apply one backend trace event. */
export function reduce(state: ExecutionState, event: TraceEvent): ExecutionState {
  return applyEvent(state, normalizeEvent(event));
}

/** Apply one already-normalised event. */
export function applyEvent(state: ExecutionState, event: NormalizedEvent): ExecutionState {
  if (hasSeq(state.log, event.seq)) {
    return state; // duplicate: the first copy of a seq wins
  }
  if (event.seq < state.lastSeq) {
    // A late event: rebuild in seq order rather than apply it out of place.
    const log = [...state.log, event].sort((a, b) => a.seq - b.seq);
    return log.reduce(applyNext, initialState(state.seed));
  }
  return applyNext(state, event);
}

function hasSeq(log: NormalizedEvent[], seq: number): boolean {
  // The log is sorted by seq: binary search.
  let low = 0;
  let high = log.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (log[mid].seq === seq) return true;
    if (log[mid].seq < seq) low = mid + 1;
    else high = mid - 1;
  }
  return false;
}

function applyNext(state: ExecutionState, event: NormalizedEvent): ExecutionState {
  const { log, ...rest } = state;
  const next: ExecutionState = { ...structuredClone(rest), log: [...log, event] };
  next.lastSeq = event.seq;
  apply(next, event);
  next.integrity = integrityOf(next.log);
  return next;
}

/**
 * Close the state using the stored run record when the trace never reached
 * run_finished (for example a run that crashed in the service). Uses only the
 * record's status and plan; never invents events.
 */
export function settleWithRecord(state: ExecutionState): ExecutionState {
  const seed = state.seed;
  if (!seed) return state;
  const next = structuredClone(state);
  if (!next.plan && seed.plan) {
    next.plan = buildPlan("record", normalizeSteps(seed.plan) ?? [], [], [], seed.plan.assumptions ?? [], null);
  }
  if (!next.outcome && isTerminal(seed.status)) {
    next.status = seed.status;
    next.outcome = { status: seed.status, error: null, source: "record", recovered: false, seq: null, at: null };
    next.phase = "finished";
    closeOpenWork(next);
  }
  return next;
}

// ----------------------------------------------------------------------
// event handlers (mutate a fresh copy)
// ----------------------------------------------------------------------
function apply(state: ExecutionState, event: NormalizedEvent): void {
  switch (event.type) {
    case "run_started":
      state.status = "running";
      state.phase = "planning";
      state.startedAt = event.at;
      state.goal = event.goal ?? state.goal;
      state.budget.limits = event.limits ?? state.budget.limits;
      return;

    case "planner_dispatched":
      // Dispatched is not running: only agent_started (or a result) says more.
      setPhase(state, "planning");
      if (event.tier) state.tier = event.tier;
      return;

    case "plan_ready": {
      const steps = event.steps ?? recordSteps(state, event.stepIds);
      state.plan = buildPlan(event.source, steps, event.stepIds, event.waves, event.assumptions, event.recipe);
      if (event.source === "recipe" && state.agents.planner.invocationIds.length === 0) {
        state.agents.planner.status = "skipped";
      }
      setPhase(state, "coding");
      return;
    }

    case "coding_dispatched":
      setPhase(state, "coding");
      if (event.tier) state.tier = event.tier;
      state.dispatches.push({
        seq: event.seq,
        steps: event.steps,
        mode: event.mode,
        parallel: event.parallel,
        tier: event.tier,
        revisionRound: event.revisionRound,
        attempts: event.attempts,
        reason: event.reason,
      });
      for (const id of event.steps) {
        const step = ensureStep(state, id);
        step.status = "dispatched";
        const attempt = event.attempts[id];
        if (attempt !== undefined) step.attempts = Math.max(step.attempts, attempt);
      }
      return;

    case "wave_merged":
      state.merges.push({ seq: event.seq, accepted: event.accepted, rejected: event.rejected, files: event.files });
      for (const id of event.accepted) ensureStep(state, id).status = "merged";
      for (const id of event.rejected) ensureStep(state, id).status = "failed";
      return;

    case "agent_started":
      startInvocation(state, event);
      return;

    case "agent_finished":
      finishInvocation(state, event);
      return;

    case "verification_started": {
      const run: VerificationRun = {
        id: event.verificationId,
        idRecorded: !event.verificationId.startsWith("seq-"),
        attempt: event.attempt,
        diagnostic: event.diagnostic,
        status: "running",
        startObserved: true,
        command: event.command,
        timeoutSeconds: event.timeoutSeconds,
        exitCode: null,
        testsPassed: null,
        testsFailed: null,
        durationMs: null,
        startedSeq: event.seq,
        finishedSeq: null,
      };
      addVerification(state, run);
      state.verifier.status = "running";
      setPhase(state, "verifying");
      return;
    }

    case "verification_finished": {
      const existing = event.verificationId ? state.verifications[event.verificationId] : undefined;
      const run: VerificationRun = existing ?? {
        // An older trace: the result is all that was recorded.
        id: event.verificationId ?? `seq-${event.seq}`,
        idRecorded: event.verificationId !== null,
        attempt: event.attempt,
        diagnostic: event.diagnostic,
        status: "running",
        startObserved: false,
        command: event.command,
        timeoutSeconds: null,
        exitCode: null,
        testsPassed: null,
        testsFailed: null,
        durationMs: null,
        startedSeq: null,
        finishedSeq: null,
      };
      if (!existing) addVerification(state, run);
      run.status = event.passed ? "passed" : "failed";
      run.exitCode = event.exitCode;
      run.testsPassed = event.testsPassed;
      run.testsFailed = event.testsFailed;
      run.durationMs = event.durationMs;
      run.finishedSeq = event.seq;
      run.command = run.command ?? event.command;
      run.attempt = run.attempt ?? event.attempt;
      state.verifier.status = run.status;
      setPhase(state, "verifying");
      return;
    }

    case "review_rejected": {
      const round = openReviewRound(state);
      round.verdict = "request_changes";
      round.findings = event.findings;
      round.withheldBlockers = event.withheldBlockers;
      round.rejection = event.rejection;
      for (const id of event.steps) ensureStep(state, id).revisionsRequested += 1;
      return;
    }

    case "failure": {
      state.failures.push({
        seq: event.seq,
        at: event.at,
        message: event.message,
        error: event.error,
        errorClass: event.errorClass,
        role: event.role,
        stepIds: event.stepIds,
        attempt: event.attempt,
        details: event.details,
      });
      // Step failures come from the coder (or, in legacy traces, unattributed).
      if (event.role === "coder" || event.role === null) {
        for (const id of event.stepIds) {
          const step = ensureStep(state, id);
          step.status = "failed";
          step.lastError = event.error;
        }
      }
      if (event.errorClass === "review_invalid") {
        const round = openReviewRound(state);
        round.verdict = "request_changes";
        round.invalid = true;
      }
      return;
    }

    case "retry":
      state.retries.push({
        seq: event.seq,
        scope: event.scope,
        role: event.role,
        stepId: event.stepId,
        steps: event.steps,
        attempt: event.attempt,
        delaySeconds: event.delaySeconds,
        category: event.category,
      });
      return;

    case "repair":
      state.repairs.push({ seq: event.seq, role: event.role, stepId: event.stepId, attempt: event.attempt, error: event.error });
      return;

    case "escalation":
      state.escalations.push({
        seq: event.seq,
        fromTier: event.fromTier,
        toTier: event.toTier,
        available: event.available,
        round: event.round,
        model: event.model,
        reason: event.reason,
      });
      if (event.available && event.toTier) state.tier = event.toTier;
      return;

    case "budget":
      state.budget.refusals.push({
        seq: event.seq,
        role: event.role,
        stepId: event.stepId,
        reason: event.reason,
        category: event.category,
      });
      if (event.ledger) state.budget.ledger = event.ledger;
      return;

    case "provider_error":
      state.providerErrors.push({
        seq: event.seq,
        role: event.role,
        stepId: event.stepId,
        attempt: event.attempt,
        category: event.category,
        retryable: event.retryable,
        error: event.error,
      });
      return;

    case "warning":
      state.warnings.push({ seq: event.seq, at: event.at, code: event.code, message: event.message, data: event.data });
      return;

    case "run_finished":
      state.status = event.status ?? state.status;
      state.finishedAt = event.at;
      state.phase = "finished";
      if (event.ledger) state.budget.ledger = event.ledger;
      if (event.status) {
        state.outcome = {
          status: event.status,
          error: event.error,
          source: "trace",
          recovered: event.recovered,
          seq: event.seq,
          at: event.at,
        };
      }
      closeOpenWork(state);
      return;

    case "unknown":
      return; // recorded in the log and in integrity.unknownKinds
  }
}

// ----------------------------------------------------------------------
// invocations
// ----------------------------------------------------------------------
type StartEvent = Extract<NormalizedEvent, { type: "agent_started" }>;
type FinishEvent = Extract<NormalizedEvent, { type: "agent_finished" }>;

const PHASE_OF_ROLE: Record<AgentRole, Phase> = { planner: "planning", coder: "coding", reviewer: "reviewing" };

function startInvocation(state: ExecutionState, event: StartEvent): void {
  const existing = state.invocations[event.invocationId];
  const invocation: Invocation = existing ?? {
    id: event.invocationId,
    idRecorded: true,
    role: event.role,
    stepId: event.stepId,
    attempt: event.attempt,
    tier: event.tier,
    model: event.model,
    provider: event.provider,
    status: "running",
    startObserved: true,
    startedSeq: event.seq,
    finishedSeq: null,
    startedAt: event.startedAt ?? event.at,
    finishedAt: null,
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    errorClass: null,
    error: null,
    outputSummary: null,
  };
  if (existing) return; // a repeated start for a known call changes nothing
  addInvocation(state, invocation);

  const agent = state.agents[event.role];
  agent.activeInvocationIds.push(invocation.id);
  agent.status = "running";
  if (event.tier) state.tier = event.tier;
  setPhase(state, PHASE_OF_ROLE[event.role]);

  if (event.role === "coder" && event.stepId) {
    const step = ensureStep(state, event.stepId);
    step.status = "running";
    linkStep(step, invocation);
  }
}

function finishInvocation(state: ExecutionState, event: FinishEvent): void {
  let invocation = state.invocations[event.invocationId];
  if (!invocation) {
    // No agent_started (older traces): the completion is all we know.
    invocation = {
      id: event.invocationId,
      idRecorded: event.idRecorded,
      role: event.role,
      stepId: event.stepId,
      attempt: event.attempt,
      tier: event.tier,
      model: event.model,
      provider: event.provider,
      status: "running",
      startObserved: false,
      startedSeq: null,
      finishedSeq: null,
      startedAt: event.startedAt,
      finishedAt: null,
      latencyMs: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      errorClass: null,
      error: null,
      outputSummary: null,
    };
    addInvocation(state, invocation);
  }
  invocation.status = event.status;
  invocation.finishedSeq = event.seq;
  invocation.finishedAt = event.finishedAt ?? event.at;
  invocation.startedAt = invocation.startedAt ?? event.startedAt;
  invocation.latencyMs = event.latencyMs;
  invocation.inputTokens = event.inputTokens;
  invocation.outputTokens = event.outputTokens;
  invocation.costUsd = event.costUsd;
  invocation.errorClass = event.errorClass;
  invocation.error = event.error;
  invocation.outputSummary = event.outputSummary;
  invocation.stepId = invocation.stepId ?? event.stepId;
  invocation.attempt = invocation.attempt ?? event.attempt;
  invocation.tier = invocation.tier ?? event.tier;
  invocation.model = invocation.model ?? event.model;
  invocation.provider = invocation.provider ?? event.provider;

  const agent = state.agents[event.role];
  agent.activeInvocationIds = agent.activeInvocationIds.filter((id) => id !== invocation.id);
  if (!agent.invocationIds.includes(invocation.id)) agent.invocationIds.push(invocation.id);
  agent.status =
    agent.activeInvocationIds.length > 0
      ? "running"
      : event.status === "succeeded"
        ? "done"
        : event.status === "skipped"
          ? "skipped"
          : "failed";
  setPhase(state, PHASE_OF_ROLE[event.role]);

  if (event.role === "coder" && invocation.stepId) {
    const step = ensureStep(state, invocation.stepId);
    linkStep(step, invocation);
    if (event.status === "succeeded") {
      step.status = "coded";
    } else if (event.status === "failed") {
      step.status = "failed";
      step.lastError = event.error;
    }
  }

  if (event.role === "reviewer" && event.status === "succeeded") {
    const summary = event.outputSummary ?? {};
    const verdict = summary.verdict === "approve" || summary.verdict === "request_changes" ? summary.verdict : null;
    state.reviews.push({
      index: state.reviews.length + 1,
      invocationId: invocation.id,
      verdict,
      findings: [],
      withheldBlockers: [],
      invalid: false,
      rejection: null,
    });
  }
}

function addInvocation(state: ExecutionState, invocation: Invocation): void {
  state.invocations[invocation.id] = invocation;
  state.invocationOrder.push(invocation.id);
}

function linkStep(step: PlanStepNode, invocation: Invocation): void {
  if (!step.invocationIds.includes(invocation.id)) step.invocationIds.push(invocation.id);
  if (invocation.attempt !== null) step.attempts = Math.max(step.attempts, invocation.attempt);
}

function addVerification(state: ExecutionState, run: VerificationRun): void {
  state.verifications[run.id] = run;
  state.verificationOrder.push(run.id);
  state.verifier.runIds.push(run.id);
}

// ----------------------------------------------------------------------
// plan, review, phase
// ----------------------------------------------------------------------
function recordSteps(state: ExecutionState, ids: string[]): NormalizedStep[] {
  // An older plan event names steps and waves only. The stored run record
  // has the same plan with its dependencies: use it, never step order.
  const fromRecord = normalizeSteps(state.seed?.plan) ?? [];
  const byId = new Map(fromRecord.map((step) => [step.id, step]));
  return ids.map(
    (id) => byId.get(id) ?? { id, title: null, dependsOn: null, targetFiles: [], acceptanceCriteria: [] },
  );
}

function buildPlan(
  source: PlanState["source"],
  steps: NormalizedStep[],
  stepIds: string[],
  waves: string[][],
  assumptions: string[],
  recipe: string | null,
): PlanState {
  const order = stepIds.length > 0 ? stepIds : steps.map((step) => step.id);
  const details = new Map(steps.map((step) => [step.id, step]));
  const dependenciesKnown = order.length > 0 && order.every((id) => details.get(id)?.dependsOn != null);
  // Waves come from the backend. Only when absent, and dependencies are
  // known, are they derived from those dependencies.
  const levels = waves.length > 0 ? waves : dependenciesKnown ? deriveWaves(order, details) : [];
  const waveOf = new Map(levels.flatMap((wave, index) => wave.map((id) => [id, index] as const)));

  const nodes: Record<string, PlanStepNode> = {};
  for (const id of order) {
    const step = details.get(id);
    nodes[id] = {
      id,
      title: step?.title ?? null,
      dependsOn: step?.dependsOn ?? null,
      targetFiles: step?.targetFiles ?? [],
      acceptanceCriteria: step?.acceptanceCriteria ?? [],
      wave: waveOf.get(id) ?? null,
      status: "pending",
      attempts: 0,
      invocationIds: [],
      revisionsRequested: 0,
      lastError: null,
    };
  }
  return { source, steps: nodes, order, waves: levels, dependenciesKnown, assumptions, recipe };
}

function deriveWaves(order: string[], details: Map<string, NormalizedStep>): string[][] {
  const remaining = new Set(order);
  const done = new Set<string>();
  const levels: string[][] = [];
  while (remaining.size > 0) {
    const ready = order.filter(
      (id) => remaining.has(id) && (details.get(id)?.dependsOn ?? []).every((dep) => done.has(dep)),
    );
    if (ready.length === 0) break; // a cycle the backend would have rejected
    levels.push(ready);
    for (const id of ready) {
      remaining.delete(id);
      done.add(id);
    }
  }
  return levels;
}

/** A step the trace mentions; created without details if the plan never named it. */
function ensureStep(state: ExecutionState, id: string): PlanStepNode {
  if (!state.plan) {
    state.plan = buildPlan("record", [], [], [], [], null);
  }
  const existing = state.plan.steps[id];
  if (existing) return existing;
  const node: PlanStepNode = {
    id,
    title: null,
    dependsOn: null,
    targetFiles: [],
    acceptanceCriteria: [],
    wave: null,
    status: "pending",
    attempts: 0,
    invocationIds: [],
    revisionsRequested: 0,
    lastError: null,
  };
  state.plan.steps[id] = node;
  state.plan.order.push(id);
  state.plan.dependenciesKnown = false;
  return node;
}

/** The latest review round still awaiting a verdict, or a new one. */
function openReviewRound(state: ExecutionState): ReviewRound {
  const last = state.reviews[state.reviews.length - 1];
  if (last && last.verdict !== "approve" && last.rejection === null && !last.invalid) {
    return last;
  }
  const round: ReviewRound = {
    index: state.reviews.length + 1,
    invocationId: null,
    verdict: null,
    findings: [],
    withheldBlockers: [],
    invalid: false,
    rejection: null,
  };
  state.reviews.push(round);
  return round;
}

function setPhase(state: ExecutionState, phase: Phase): void {
  if (state.phase !== "finished") state.phase = phase;
}

/** Close everything still open when the run ends: interrupted, never succeeded. */
function closeOpenWork(state: ExecutionState): void {
  for (const id of state.invocationOrder) {
    const invocation = state.invocations[id];
    if (invocation.status === "running") invocation.status = "interrupted";
  }
  for (const role of ROLES) {
    const agent = state.agents[role];
    if (agent.activeInvocationIds.length > 0) {
      agent.activeInvocationIds = [];
      agent.status = "interrupted";
    }
  }
  for (const id of state.verificationOrder) {
    const run = state.verifications[id];
    if (run.status === "running") run.status = "interrupted";
  }
  if (state.verifier.status === "running") state.verifier.status = "interrupted";
  if (state.plan) {
    for (const id of state.plan.order) {
      const step = state.plan.steps[id];
      if (step.status === "dispatched" || step.status === "running") step.status = "interrupted";
    }
  }
}

function integrityOf(log: NormalizedEvent[]): ExecutionState["integrity"] {
  const seen = new Set(log.map((event) => event.seq));
  const last = log.length > 0 ? log[log.length - 1].seq : 0;
  const missingSeqs: number[] = [];
  for (let seq = 1; seq < last; seq += 1) {
    if (!seen.has(seq)) missingSeqs.push(seq);
  }
  const unknownKinds = [
    ...new Set(log.flatMap((event) => (event.type === "unknown" ? [event.rawKind] : []))),
  ].sort();
  return { missingSeqs, unknownKinds };
}
