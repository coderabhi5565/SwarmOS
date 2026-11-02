/**
 * Benchmark API payloads for tests, typed as the generated contract: a
 * backend contract change breaks these at compile time.
 */
import type {
  BenchmarkExperimentDetail,
  BenchmarkExperimentList,
  BenchmarkExperimentSummary,
  BenchmarkSuites,
  BenchmarkTrial,
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
