/**
 * The boundary between backend trace events and the execution model.
 *
 * Every compatibility rule lives here, so the reducer and the UI only see
 * one shape per event. Payload reads are typed against the generated
 * schemas (field names are checked at compile time) but values are read
 * defensively: traces recorded before the M3.0 contract, or by a newer
 * backend, may omit fields or use older names.
 */
import type { components } from "@/api/schema";
import type { RunStatus, TraceEvent } from "@/api/types";
import type { AgentRole, LedgerSnapshot, Limits, ModelTier, ReviewFinding } from "./model";

type Schemas = components["schemas"];
/** A payload as the contract describes it, tolerating absent or legacy fields. */
type Loose<T> = Partial<T> & Record<string, unknown>;

interface Envelope {
  seq: number;
  at: string;
  eventId: string;
  message: string;
}

export interface NormalizedStep {
  id: string;
  title: string | null;
  dependsOn: string[] | null;
  targetFiles: string[];
  acceptanceCriteria: string[];
}

export type NormalizedEvent = Envelope &
  (
    | { type: "run_started"; goal: string | null; provider: string | null; limits: Limits | null }
    | { type: "planner_dispatched"; tier: ModelTier | null }
    | {
        type: "plan_ready";
        source: "planner" | "recipe";
        stepIds: string[];
        waves: string[][];
        /** Full step details when the event carries the plan (M3.0+). */
        steps: NormalizedStep[] | null;
        assumptions: string[];
        recipe: string | null;
      }
    | {
        type: "coding_dispatched";
        steps: string[];
        mode: string | null;
        parallel: boolean;
        tier: ModelTier | null;
        revisionRound: number | null;
        attempts: Record<string, number>;
        reason: string | null;
      }
    | { type: "wave_merged"; accepted: string[]; rejected: string[]; files: string[] }
    | {
        type: "agent_started";
        invocationId: string;
        role: AgentRole;
        stepId: string | null;
        attempt: number | null;
        tier: ModelTier | null;
        model: string | null;
        provider: string | null;
        startedAt: string | null;
      }
    | {
        type: "agent_finished";
        invocationId: string;
        idRecorded: boolean;
        role: AgentRole;
        stepId: string | null;
        attempt: number | null;
        status: "succeeded" | "failed" | "skipped";
        tier: ModelTier | null;
        model: string | null;
        provider: string | null;
        startedAt: string | null;
        finishedAt: string | null;
        latencyMs: number | null;
        inputTokens: number | null;
        outputTokens: number | null;
        costUsd: number | null;
        errorClass: string | null;
        error: string | null;
        outputSummary: Record<string, unknown> | null;
      }
    | {
        type: "verification_started";
        verificationId: string;
        attempt: number | null;
        diagnostic: boolean;
        command: string | null;
        timeoutSeconds: number | null;
      }
    | {
        type: "verification_finished";
        verificationId: string | null;
        attempt: number | null;
        diagnostic: boolean;
        passed: boolean;
        command: string | null;
        exitCode: number | null;
        testsPassed: number | null;
        testsFailed: number | null;
        durationMs: number | null;
      }
    | {
        type: "review_rejected";
        rejection: number | null;
        findings: ReviewFinding[];
        withheldBlockers: { finding: ReviewFinding; missing: string[] }[];
        steps: string[];
      }
    | {
        type: "failure";
        error: string;
        errorClass: string | null;
        role: AgentRole | "verifier" | null;
        stepIds: string[];
        attempt: number | null;
        details: Record<string, unknown>;
      }
    | {
        type: "retry";
        scope: "call" | "steps";
        role: AgentRole | null;
        stepId: string | null;
        steps: string[];
        attempt: number | null;
        delaySeconds: number | null;
        category: string | null;
      }
    | { type: "repair"; role: AgentRole | null; stepId: string | null; attempt: number | null; error: string | null }
    | {
        type: "escalation";
        fromTier: ModelTier | null;
        toTier: ModelTier | null;
        available: boolean;
        round: number | null;
        model: string | null;
        reason: string | null;
      }
    | {
        type: "budget";
        role: AgentRole | null;
        stepId: string | null;
        reason: string | null;
        category: string | null;
        ledger: LedgerSnapshot | null;
      }
    | {
        type: "provider_error";
        role: AgentRole | null;
        stepId: string | null;
        attempt: number | null;
        category: string | null;
        retryable: boolean | null;
        error: string | null;
      }
    | { type: "warning"; code: string | null; data: Record<string, unknown> }
    | {
        type: "run_finished";
        status: RunStatus | null;
        error: string | null;
        ledger: LedgerSnapshot | null;
        recovered: boolean;
      }
    /**
     * Anything this client cannot interpret: a kind or routing decision from a
     * newer backend, or an event missing the fields that identify it. Kept in
     * the log for the timeline; never guessed at.
     */
    | { type: "unknown"; rawKind: string }
  );

// ----------------------------------------------------------------------
// defensive readers
// ----------------------------------------------------------------------
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const AGENT_ROLES: ReadonlySet<string> = new Set(["planner", "coder", "reviewer"]);
const agentRole = (value: unknown): AgentRole | null =>
  typeof value === "string" && AGENT_ROLES.has(value) ? (value as AgentRole) : null;
const tier = (value: unknown): ModelTier | null => (value === "fast" || value === "strong" ? value : null);

function waves(value: unknown): string[][] {
  return Array.isArray(value) ? value.map(strings).filter((wave) => wave.length > 0) : [];
}

function counts(value: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(record(value) ?? {})) {
    const count = num(item);
    if (count !== null) result[key] = count;
  }
  return result;
}

function findings(value: unknown): ReviewFinding[] {
  return Array.isArray(value)
    ? value.filter((item): item is ReviewFinding => record(item) !== null && typeof record(item)?.message === "string")
    : [];
}

function ledger(value: unknown): LedgerSnapshot | null {
  const data = record(value);
  return data && typeof data.calls === "number" ? (data as unknown as LedgerSnapshot) : null;
}

export function normalizeSteps(plan: unknown): NormalizedStep[] | null {
  const steps = record(plan)?.steps;
  if (!Array.isArray(steps)) return null;
  return steps.flatMap((item) => {
    const step = record(item);
    const id = str(step?.id);
    if (!step || !id) return [];
    return [
      {
        id,
        title: str(step.title),
        dependsOn: Array.isArray(step.depends_on) ? strings(step.depends_on) : null,
        targetFiles: strings(step.target_files),
        acceptanceCriteria: strings(step.acceptance_criteria),
      },
    ];
  });
}

// ----------------------------------------------------------------------
// per kind
// ----------------------------------------------------------------------
function routing(env: Envelope, raw: TraceEvent): NormalizedEvent {
  const decision = str(raw.payload.decision);
  if (decision === "plan") {
    const p = raw.payload as Loose<Schemas["PlannerDispatchDecision"]>;
    return { ...env, type: "planner_dispatched", tier: tier(p.tier) };
  }
  if (decision === "plan_accepted" || decision === "plan_seeded") {
    const p = raw.payload as Loose<Schemas["PlanDecision"]>;
    return {
      ...env,
      type: "plan_ready",
      source: decision === "plan_seeded" ? "recipe" : "planner",
      stepIds: strings(p.steps),
      waves: waves(p.waves),
      // M3.0+ events carry the validated plan; older ones only ids and waves.
      steps: normalizeSteps(p.plan),
      assumptions: strings(p.assumptions),
      recipe: str(p.recipe),
    };
  }
  if (decision === "dispatch_coding") {
    const p = raw.payload as Loose<Schemas["DispatchCodingDecision"]>;
    return {
      ...env,
      type: "coding_dispatched",
      steps: strings(p.steps),
      mode: str(p.mode), // absent before the mode field existed
      parallel: bool(p.parallel) ?? strings(p.steps).length > 1,
      tier: tier(p.tier),
      revisionRound: num(p.revision_round),
      attempts: counts(p.attempts),
      reason: str(p.reason),
    };
  }
  if (decision === "merge_wave") {
    const p = raw.payload as Loose<Schemas["MergeWaveDecision"]>;
    return {
      ...env,
      type: "wave_merged",
      accepted: strings(p.accepted_steps),
      rejected: strings(p.rejected_steps),
      files: strings(p.files),
    };
  }
  return { ...env, type: "unknown", rawKind: `routing_decision:${decision ?? "?"}` };
}

function agentFinished(env: Envelope, raw: TraceEvent): NormalizedEvent {
  const p = raw.payload as Loose<Schemas["AgentInvocationPayload"]>;
  // Older traces lack the top-level id but embed the full invocation record.
  const nested = record(p.invocation) ?? {};
  const recordedId = str(p.invocation_id) ?? str(nested.invocation_id);
  const role = agentRole(p.role) ?? agentRole(nested.role);
  if (!role) return { ...env, type: "unknown", rawKind: "agent_invocation:unknown-role" };
  const usage = bool(p.usage_available) ?? bool(nested.usage_available) ?? false;
  const status = str(p.status) ?? str(nested.status);
  if (status !== "succeeded" && status !== "failed" && status !== "skipped") {
    // Never assume an outcome the trace does not state.
    return { ...env, type: "unknown", rawKind: "agent_invocation:unknown-status" };
  }
  return {
    ...env,
    type: "agent_finished",
    invocationId: recordedId ?? `seq-${env.seq}`,
    idRecorded: recordedId !== null,
    role,
    stepId: str(p.step_id) ?? str(nested.step_id),
    attempt: num(p.attempt) ?? num(nested.attempt),
    status,
    tier: tier(p.tier) ?? tier(nested.model_tier),
    model: str(p.model) ?? str(nested.model),
    provider: str(p.provider) ?? str(nested.provider),
    startedAt: str(nested.started_at),
    finishedAt: str(nested.finished_at),
    latencyMs: num(p.latency_ms) ?? num(nested.latency_ms),
    // Zeros without usage metadata mean "not reported", not "free".
    inputTokens: usage ? (num(p.input_tokens) ?? num(nested.input_tokens)) : null,
    outputTokens: usage ? (num(p.output_tokens) ?? num(nested.output_tokens)) : null,
    costUsd: num(p.cost_usd) ?? num(nested.cost_usd),
    errorClass: str(p.error_class) ?? str(nested.error_class),
    error: str(p.error) ?? str(nested.error),
    outputSummary: record(p.output_summary),
  };
}

const FAILURE_CORE = new Set(["error", "error_class", "role", "step_id", "attempt", "steps"]);

function failure(env: Envelope, raw: TraceEvent): NormalizedEvent {
  const p = raw.payload as Loose<Schemas["FailurePayload"]>;
  const role = p.role === "verifier" ? "verifier" : agentRole(p.role);
  const stepId = str(p.step_id);
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw.payload)) {
    if (!FAILURE_CORE.has(key)) details[key] = value;
  }
  return {
    ...env,
    type: "failure",
    // Older failures may carry no error field; the recorded message is the error.
    error: str(p.error) ?? env.message,
    errorClass: str(p.error_class),
    role,
    // Legacy conflict failures named several steps in one event.
    stepIds: stepId ? [stepId] : strings(raw.payload.steps),
    attempt: num(p.attempt),
    details,
  };
}

export function normalizeEvent(raw: TraceEvent): NormalizedEvent {
  const env: Envelope = { seq: raw.seq, at: raw.at, eventId: raw.event_id, message: raw.message };
  const payload = raw.payload;
  // `raw.kind` is typed as the known kinds, but a newer backend may send others.
  const kind: string = raw.kind;

  switch (kind) {
    case "run_started": {
      const p = payload as Loose<Schemas["RunStartedPayload"]>;
      return { ...env, type: "run_started", goal: str(p.goal), provider: str(p.provider), limits: (record(p.limits) as Limits | null) ?? null };
    }
    case "routing_decision":
      return routing(env, raw);
    case "agent_started": {
      const p = payload as Loose<Schemas["AgentStartedPayload"]>;
      const role = agentRole(p.role);
      const invocationId = str(p.invocation_id);
      if (!role || !invocationId) return { ...env, type: "unknown", rawKind: "agent_started:incomplete" };
      return {
        ...env,
        type: "agent_started",
        invocationId,
        role,
        stepId: str(p.step_id),
        attempt: num(p.attempt),
        tier: tier(p.tier),
        model: str(p.model),
        provider: str(p.provider),
        startedAt: str(p.started_at),
      };
    }
    case "agent_invocation":
      return agentFinished(env, raw);
    case "verification_started": {
      const p = payload as Loose<Schemas["VerificationStartedPayload"]>;
      return {
        ...env,
        type: "verification_started",
        verificationId: str(p.verification_id) ?? `seq-${env.seq}`,
        attempt: num(p.attempt),
        diagnostic: bool(p.diagnostic) ?? false,
        command: str(p.command),
        timeoutSeconds: num(p.timeout_seconds),
      };
    }
    case "verification": {
      const p = payload as Loose<Schemas["VerificationPayload"]>;
      return {
        ...env,
        type: "verification_finished",
        verificationId: str(p.verification_id),
        attempt: num(p.attempt),
        diagnostic: bool(p.diagnostic) ?? false,
        passed: bool(p.passed) ?? false,
        command: str(p.command),
        exitCode: num(p.exit_code),
        testsPassed: num(p.tests_passed),
        testsFailed: num(p.tests_failed),
        durationMs: num(p.duration_ms),
      };
    }
    case "revision": {
      const p = payload as Loose<Schemas["RevisionPayload"]>;
      const withheld = Array.isArray(p.withheld_blockers) ? p.withheld_blockers : [];
      return {
        ...env,
        type: "review_rejected",
        // The earliest traces called this counter "round".
        rejection: num(p.review_rejection) ?? num(payload.round),
        findings: findings(p.findings),
        withheldBlockers: withheld.flatMap((item) => {
          const entry = record(item);
          const [finding] = findings([entry?.finding]);
          return finding ? [{ finding, missing: strings(entry?.missing) }] : [];
        }),
        steps: strings(p.steps),
      };
    }
    case "failure":
      return failure(env, raw);
    case "retry": {
      const p = payload as Loose<Schemas["RetryPayload"]>;
      const steps = strings(p.steps);
      // Before `scope` existed, a step retry was the one that listed steps.
      const scope = p.scope === "call" || p.scope === "steps" ? p.scope : steps.length > 0 ? "steps" : "call";
      return {
        ...env,
        type: "retry",
        scope,
        role: agentRole(p.role),
        stepId: str(p.step_id),
        steps,
        attempt: num(p.attempt),
        delaySeconds: num(p.delay_seconds),
        category: str(p.category),
      };
    }
    case "repair": {
      const p = payload as Loose<Schemas["RepairPayload"]>;
      return { ...env, type: "repair", role: agentRole(p.role), stepId: str(p.step_id), attempt: num(p.attempt), error: str(p.error) };
    }
    case "escalation": {
      const p = payload as Loose<Schemas["EscalationPayload"]>;
      return {
        ...env,
        type: "escalation",
        fromTier: tier(p.from_tier),
        toTier: tier(p.to_tier),
        available: bool(p.available) ?? tier(p.to_tier) !== null,
        round: num(p.round),
        model: str(p.model),
        reason: str(p.reason),
      };
    }
    case "budget": {
      const p = payload as Loose<Schemas["BudgetPayload"]>;
      return { ...env, type: "budget", role: agentRole(p.role), stepId: str(p.step_id), reason: str(p.reason), category: str(p.category), ledger: ledger(p.ledger) };
    }
    case "provider": {
      const p = payload as Loose<Schemas["ProviderPayload"]>;
      return {
        ...env,
        type: "provider_error",
        role: agentRole(p.role),
        stepId: str(p.step_id),
        attempt: num(p.attempt),
        category: str(p.category),
        retryable: bool(p.retryable),
        error: str(p.error),
      };
    }
    case "warning": {
      const p = payload as Loose<Schemas["WarningPayload"]>;
      const { code: _code, ...data } = payload;
      return { ...env, type: "warning", code: str(p.code), data };
    }
    case "run_finished": {
      const p = payload as Loose<Schemas["RunFinishedPayload"]>;
      return {
        ...env,
        type: "run_finished",
        status: (str(p.status) as RunStatus | null) ?? null,
        error: str(p.error),
        ledger: ledger(p.ledger),
        recovered: bool(p.recovered) ?? false,
      };
    }
    default:
      return { ...env, type: "unknown", rawKind: kind };
  }
}
