/**
 * Benchmark API payloads for tests, typed as the generated contract: a
 * backend contract change breaks these at compile time.
 */
import type {
  BenchmarkAggregate,
  BenchmarkExperimentDetail,
  BenchmarkExperimentList,
  BenchmarkExperimentSummary,
  BenchmarkSuites,
  BenchmarkTrial,
  BenchmarkTrialMetrics,
} from "@/api/types";
import { DEFAULT_LIMITS } from "./api";

export function benchmarkSuites(overrides: Partial<BenchmarkSuites> = {}): BenchmarkSuites {
  return {
    mode: "local",
    can_create: true,
    suites: [
      {
        id: "catalog",
        title: "Demo catalog",
        description: "The curated catalog tasks.",
        version: "v1-0123456789ab",
        public: true,
        requires_real_model: false,
        tasks: [
          { id: "sample_tag_normalization", title: "Tag normalization", demo_task: "sample_tag_normalization", parallel_waves: false, notes: "" },
          { id: "sample_parallel_pipeline", title: "Parallel pipeline", demo_task: "sample_parallel_pipeline", parallel_waves: true, notes: "" },
        ],
      },
    ],
    arms: [
      { id: "parallel", kind: "execution", label: "Parallel coding", description: "concurrent", model_policy: null, parallel_coding: true, max_escalations: null },
      { id: "sequential", kind: "execution", label: "Sequential coding", description: "one at a time", model_policy: null, parallel_coding: false, max_escalations: null },
    ],
    max_repetitions: 10,
    max_trials: 60,
    ...overrides,
  };
}

export function experimentSummary(overrides: Partial<BenchmarkExperimentSummary> = {}): BenchmarkExperimentSummary {
  return {
    experiment_id: "bex_000000000001",
    created_at: "2026-11-02T10:00:00+00:00",
    updated_at: "2026-11-02T10:00:05+00:00",
    started_at: "2026-11-02T10:00:01+00:00",
    finished_at: null,
    status: "running",
    origin: "api",
    suite_id: "catalog",
    suite_title: "Demo catalog",
    suite_version: "v1-0123456789ab",
    provider: "demo",
    provider_kind: "demo",
    scripted: true,
    repetitions: 1,
    warmup_repetitions: 0,
    arm_ids: ["parallel", "sequential"],
    trials_total: 2,
    trials_done: 0,
    error: null,
    ...overrides,
  };
}

export function trial(overrides: Partial<BenchmarkTrial> = {}): BenchmarkTrial {
  return {
    trial_id: "btr_000000000001",
    ordinal: 0,
    arm_id: "parallel",
    task_id: "sample_tag_normalization",
    repetition: 0,
    fingerprint: "0123456789abcdef",
    status: "pending",
    run_id: null,
    run_path: null,
    started_at: null,
    finished_at: null,
    error: null,
    metrics: null,
    ...overrides,
  };
}

export function trialMetrics(overrides: Partial<BenchmarkTrialMetrics> = {}): BenchmarkTrialMetrics {
  return {
    metrics_version: 1,
    run_id: "run_000000000001",
    status: "completed",
    outcome: "success",
    excluded_reason: null,
    task_success: true,
    verification_passed: true,
    verification_runs: 1,
    diagnostic_tests_passed: null,
    provider: "demo",
    provider_kind: "demo",
    scripted: true,
    model_policy: "config",
    models_by_role: { coder: "demo-fast" },
    latency_ms: 3_400,
    model_latency_ms: null,
    verification_ms: 1_200,
    agent_calls: 2,
    step_retries: 0,
    call_retries: 0,
    output_repairs: 0,
    repair_rounds: 0,
    revisions: 0,
    escalations: 0,
    model_calls: 2,
    calls_with_usage: 0,
    input_tokens: null,
    output_tokens: null,
    cost_usd: null,
    timings: null,
    null_reasons: {
      model_latency_ms: "scripted provider: no model was called",
      tokens: "scripted provider: no usage is reported",
      cost_usd: "scripted provider: nothing was billed",
    },
    ...overrides,
  };
}

const noDistribution = { n: 0, median: null, p95: null, mean: null, min: null, max: null };

export function aggregate(overrides: Partial<BenchmarkAggregate> = {}): BenchmarkAggregate {
  return {
    arm_id: "parallel",
    task_id: null,
    trial_statuses: { done: 2 },
    trials: 2,
    counted: 2,
    excluded: 0,
    incomplete: 0,
    excluded_reasons: {},
    warmups: 0,
    non_warmup_trials: 2,
    cancelled: 0,
    cancellation_rate: 0,
    interrupted: 0,
    interrupted_rate: 0,
    sample_required: 20,
    sample_complete: false,
    task_successes: 2,
    task_success_rate: 1,
    verification_passes: 2,
    verification_pass_rate: 1,
    latency_ms: { n: 2, median: 3_300, p95: 3_400, mean: 3_300, min: 3_200, max: 3_400 },
    model_latency_ms: noDistribution,
    verification_ms: { n: 2, median: 1_200, p95: 1_300, mean: 1_200, min: 1_100, max: 1_300 },
    mean_agent_calls: 2,
    mean_retries: 0,
    mean_step_retries: 0,
    mean_call_retries: 0,
    mean_output_repairs: 0,
    mean_repair_rounds: 0,
    mean_revisions: 0,
    mean_escalations: 0,
    runs_with_usage: 0,
    mean_input_tokens: null,
    mean_output_tokens: null,
    runs_with_cost: 0,
    mean_cost_usd: null,
    total_cost_usd: null,
    timings: { measured: 0, unavailable: {}, metrics: {} },
    notes: [],
    ...overrides,
  };
}

export function experimentDetail(
  experiment: Partial<BenchmarkExperimentSummary> = {},
  overrides: Partial<BenchmarkExperimentDetail> = {},
): BenchmarkExperimentDetail {
  const summary = experimentSummary(experiment);
  return {
    experiment: summary,
    order_seed: 7,
    environment: {
      app_version: "0.3.0",
      mode: "local",
      provider: summary.provider,
      provider_kind: summary.provider_kind,
      scripted: summary.scripted,
      pricing_known: false,
      monetary_enforced: false,
      execution_enabled: true,
      execution_sandbox: "none",
      verification_command: "python -m pytest -q",
      build_commit: null,
      python_version: "3.13.3",
      platform: "Windows-11",
      collected_at: summary.created_at,
    },
    configurations: [
      {
        arm_id: "parallel",
        task_id: "sample_tag_normalization",
        provider: "demo",
        provider_kind: "demo",
        scripted: true,
        model_policy: "config",
        models_by_role: { planner: "skipped (demo recipe)", coder: "demo-fast", reviewer: "demo-fast", verifier: "deterministic-subprocess" },
        escalation_possible: false,
        escalation_unavailable: ["the demo fixture has a single scripted model"],
        limits: DEFAULT_LIMITS,
        parallel_relevant: false,
        fingerprint: "0123456789abcdef",
      },
    ],
    identical_by_design: [],
    aggregates: [],
    task_aggregates: [],
    trials: [trial()],
    notes: [],
    ...overrides,
  };
}

export function experimentPage(
  experiments: BenchmarkExperimentSummary[],
  next_cursor: string | null = null,
): BenchmarkExperimentList {
  return { experiments, next_cursor };
}
