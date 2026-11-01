/**
 * The normalised execution model: what a run's trace establishes, in a form
 * any view (timeline, 2D graph, 3D scene) can render.
 *
 * Three categories are kept distinct:
 * - agents (planner, coder, reviewer) make model calls: `AgentNode`;
 * - the verifier is a deterministic test runner, not a model: `RunnerNode`;
 * - advance / escalate / finalize are orchestrator operations, recorded as
 *   dispatches, merges, retries and escalations, never as agents.
 *
 * `null` always means "the trace does not establish this". It is never a
 * stand-in for zero, empty, or success.
 */
import type { components } from "@/api/schema";
import type { RunStatus } from "@/api/types";
import type { NormalizedEvent } from "./events";

type Schemas = components["schemas"];

export type AgentRole = "planner" | "coder" | "reviewer";
export type ModelTier = "fast" | "strong";
export type ReviewFinding = Schemas["ReviewFinding"];
export type LedgerSnapshot = Schemas["LedgerSnapshot"];
export type Limits = Schemas["Limits"];

/** What the run record contributes before (or instead of) the trace. */
export interface RunSeed {
  run_id: string;
  goal?: string | null;
  status?: RunStatus | null;
  plan?: Schemas["Plan"] | null;
  limits?: Limits | null;
  provider?: string | null;
  provider_kind?: string | null;
  model_policy?: string | null;
  models_by_role?: Record<string, string> | null;
  created_at?: string | null;
}

export type Phase = "not_started" | "planning" | "coding" | "reviewing" | "verifying" | "finished";

// ----------------------------------------------------------------------
// plan
// ----------------------------------------------------------------------
export type StepStatus =
  | "pending" // planned, not yet dispatched
  | "dispatched" // queued by the orchestrator, not observed running
  | "running" // between agent_started and its completion
  | "coded" // the coder answered; not yet merged
  | "merged" // accepted into the workspace: the step is complete
  | "failed"
  | "interrupted"; // the run ended while the step was dispatched or running

export interface PlanStepNode {
  id: string;
  title: string | null;
  /** null when the trace and record do not record dependencies (older traces). */
  dependsOn: string[] | null;
  targetFiles: string[];
  acceptanceCriteria: string[];
  /** Index into PlanState.waves. */
  wave: number | null;
  status: StepStatus;
  /** Highest coding attempt dispatched or observed. */
  attempts: number;
  invocationIds: string[];
  revisionsRequested: number;
  lastError: string | null;
}

export interface PlanState {
  /** Who produced the plan: the planner model, a catalog recipe, or only the stored record. */
  source: "planner" | "recipe" | "record";
  steps: Record<string, PlanStepNode>;
  order: string[];
  waves: string[][];
  dependenciesKnown: boolean;
  assumptions: string[];
  recipe: string | null;
}

// ----------------------------------------------------------------------
// agents and model calls
// ----------------------------------------------------------------------
export type InvocationStatus = "running" | "succeeded" | "failed" | "skipped" | "interrupted";

export interface Invocation {
  id: string;
  /** False when the trace carried no invocation id and one was derived from seq. */
  idRecorded: boolean;
  role: AgentRole;
  stepId: string | null;
  attempt: number | null;
  tier: ModelTier | null;
  model: string | null;
  provider: string | null;
  status: InvocationStatus;
  /** True only when an agent_started event was seen (M3.0+ traces). */
  startObserved: boolean;
  startedSeq: number | null;
  finishedSeq: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  latencyMs: number | null;
  /** Token counts only when the provider reported usage. */
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  errorClass: string | null;
  error: string | null;
  outputSummary: Record<string, unknown> | null;
}

export type AgentStatus = "idle" | "running" | "done" | "failed" | "skipped" | "interrupted";

export interface AgentNode {
  role: AgentRole;
  kind: "agent";
  status: AgentStatus;
  activeInvocationIds: string[];
  invocationIds: string[];
}

// ----------------------------------------------------------------------
// the deterministic verification runner
// ----------------------------------------------------------------------
export type VerificationStatus = "running" | "passed" | "failed" | "interrupted";

export interface VerificationRun {
  id: string;
  idRecorded: boolean;
  /** null for diagnostic runs, which are not repair rounds. */
  attempt: number | null;
  diagnostic: boolean;
  status: VerificationStatus;
  startObserved: boolean;
  command: string | null;
  timeoutSeconds: number | null;
  exitCode: number | null;
  testsPassed: number | null;
  testsFailed: number | null;
  durationMs: number | null;
  startedSeq: number | null;
  finishedSeq: number | null;
}

export interface RunnerNode {
  role: "verifier";
  kind: "deterministic_runner";
  status: "idle" | VerificationStatus;
  runIds: string[];
}

// ----------------------------------------------------------------------
// review, orchestration operations, limits
// ----------------------------------------------------------------------
export interface ReviewRound {
  /** 1-based, in trace order. */
  index: number;
  invocationId: string | null;
  verdict: "approve" | "request_changes" | null;
  findings: ReviewFinding[];
  withheldBlockers: { finding: ReviewFinding; missing: string[] }[];
  /** The review guard found the rejection unsupported (review_invalid). */
  invalid: boolean;
  rejection: number | null;
}

export interface Dispatch {
  seq: number;
  steps: string[];
  mode: string | null;
  parallel: boolean;
  tier: ModelTier | null;
  revisionRound: number | null;
  attempts: Record<string, number>;
  reason: string | null;
}

export interface Merge {
  seq: number;
  accepted: string[];
  rejected: string[];
  files: string[];
}

export interface Escalation {
  seq: number;
  fromTier: ModelTier | null;
  toTier: ModelTier | null;
  available: boolean;
  round: number | null;
  model: string | null;
  reason: string | null;
}

export interface Retry {
  seq: number;
  scope: "call" | "steps";
  role: AgentRole | null;
  stepId: string | null;
  steps: string[];
  attempt: number | null;
  delaySeconds: number | null;
  category: string | null;
}

export interface Repair {
  seq: number;
  role: AgentRole | null;
  stepId: string | null;
  attempt: number | null;
  error: string | null;
}

export interface ProviderError {
  seq: number;
  role: AgentRole | null;
  stepId: string | null;
  attempt: number | null;
  category: string | null;
  retryable: boolean | null;
  error: string | null;
}

export interface Failure {
  seq: number;
  at: string;
  message: string;
  error: string;
  errorClass: string | null;
  role: AgentRole | "verifier" | null;
  /** One step for current traces; several for legacy multi-step conflicts. */
  stepIds: string[];
  attempt: number | null;
  /** Cause-specific diagnostics (paths, violations, findings, test output). */
  details: Record<string, unknown>;
}

export interface Warning {
  seq: number;
  at: string;
  code: string | null;
  message: string;
  data: Record<string, unknown>;
}

export interface BudgetRefusal {
  seq: number;
  role: AgentRole | null;
  stepId: string | null;
  reason: string | null;
  category: string | null;
}

export interface BudgetState {
  limits: Limits | null;
  /** The latest ledger snapshot the trace reported. */
  ledger: LedgerSnapshot | null;
  refusals: BudgetRefusal[];
}

export interface Outcome {
  status: RunStatus;
  error: string | null;
  /** "trace": a run_finished event; "record": only the stored run says so. */
  source: "trace" | "record";
  recovered: boolean;
  seq: number | null;
  at: string | null;
}

export interface Integrity {
  /** Sequence numbers between 1 and lastSeq that have not arrived. */
  missingSeqs: number[];
  /** Event kinds this client does not understand (newer backend). */
  unknownKinds: string[];
}

export interface ExecutionState {
  runId: string | null;
  goal: string | null;
  seed: RunSeed | null;
  status: RunStatus | null;
  phase: Phase;
  tier: ModelTier;
  startedAt: string | null;
  finishedAt: string | null;

  plan: PlanState | null;
  agents: Record<AgentRole, AgentNode>;
  verifier: RunnerNode;

  invocations: Record<string, Invocation>;
  invocationOrder: string[];
  verifications: Record<string, VerificationRun>;
  verificationOrder: string[];
  reviews: ReviewRound[];

  dispatches: Dispatch[];
  merges: Merge[];
  escalations: Escalation[];
  retries: Retry[];
  repairs: Repair[];
  providerErrors: ProviderError[];
  failures: Failure[];
  warnings: Warning[];
  budget: BudgetState;
  outcome: Outcome | null;

  /** Every applied event, normalised, in seq order: the timeline. */
  log: NormalizedEvent[];
  lastSeq: number;
  integrity: Integrity;
}
