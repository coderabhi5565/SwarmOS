/**
 * TanStack Query hooks for the benchmark API. Server state only: pages render
 * what these return and never call the client themselves.
 *
 * Keys live under ["benchmarks", ...], so one invalidation can reach every
 * benchmark query. Retries follow the app's QueryClient: never a 4xx, and
 * never a mutation.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { api } from "./client";
import type {
  BenchmarkCreateRequest,
  BenchmarkExperimentDetail,
  BenchmarkExperimentList,
  BenchmarkExperimentStatus,
  BenchmarkExperimentSummary,
} from "./types";

/** How often an experiment that is still queued or running is fetched again. */
export const BENCHMARK_POLL_MS = 2_000;

/** The backend's non-terminal experiment statuses (it treats these as active). */
const ACTIVE_STATUSES: ReadonlySet<BenchmarkExperimentStatus> = new Set(["queued", "running"]);

export function isActiveExperiment(status: BenchmarkExperimentStatus | undefined): boolean {
  return status !== undefined && ACTIVE_STATUSES.has(status);
}

/** Poll every 2 s while the experiment is active; never once it is terminal (or unknown). */
export function experimentPollInterval(status: BenchmarkExperimentStatus | undefined): number | false {
  return isActiveExperiment(status) ? BENCHMARK_POLL_MS : false;
}

/**
 * The experiments in loaded list pages, in order, each once. Pages come from
 * a keyset cursor, so a refetch cannot repeat a row across pages; this keeps
 * the first copy anyway, should the list change between two page requests.
 */
export function experimentsFromPages(
  data: InfiniteData<BenchmarkExperimentList> | undefined,
): BenchmarkExperimentSummary[] {
  const seen = new Set<string>();
  return (data?.pages ?? []).flatMap((page) =>
    page.experiments.filter((experiment) => {
      if (seen.has(experiment.experiment_id)) return false;
      seen.add(experiment.experiment_id);
      return true;
    }),
  );
}

/** Refresh the list every 2 s while any loaded experiment is active; otherwise not at all. */
export function experimentListPollInterval(
  data: InfiniteData<BenchmarkExperimentList> | undefined,
): number | false {
  const active = (data?.pages ?? []).some((page) =>
    page.experiments.some((experiment) => isActiveExperiment(experiment.status)),
  );
  return active ? BENCHMARK_POLL_MS : false;
}

export const benchmarkKeys = {
  all: ["benchmarks"] as const,
  suites: ["benchmarks", "suites"] as const,
  /** Prefix of every experiment list (any page size). */
  experimentLists: ["benchmarks", "experiments"] as const,
  experimentList: (limit: number) => ["benchmarks", "experiments", { limit }] as const,
  experiment: (experimentId: string) => ["benchmarks", "experiment", experimentId] as const,
};

/** Suites, arms and caps: the only options experiment creation may offer. */
export function useBenchmarkSuites() {
  return useQuery({
    queryKey: benchmarkKeys.suites,
    queryFn: api.benchmarkSuites,
    // Suites change only with a deploy (their version says so).
    staleTime: 60_000,
  });
}

/**
 * Experiments, newest first, one page at a time via the keyset cursor.
 *
 * While any loaded experiment is queued or running, the loaded pages are
 * refreshed every 2 s. TanStack refetches the same number of pages, the
 * first from the start and each next one from the freshly fetched page's
 * cursor, so "Load more" pages stay loaded and nothing is skipped or
 * repeated when a new experiment arrives at the top.
 */
export function useBenchmarkExperiments(limit = 20) {
  return useInfiniteQuery({
    queryKey: benchmarkKeys.experimentList(limit),
    queryFn: ({ pageParam }) => api.listBenchmarkExperiments({ limit, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    refetchInterval: (query) => experimentListPollInterval(query.state.data),
  });
}

/** One experiment, polled every 2 s while queued or running, and not after. */
export function useBenchmarkExperiment(experimentId: string | undefined) {
  return useQuery({
    queryKey: benchmarkKeys.experiment(experimentId ?? ""),
    queryFn: () => api.getBenchmarkExperiment(experimentId as string),
    enabled: Boolean(experimentId),
    refetchInterval: (query) => experimentPollInterval(query.state.data?.experiment.status),
  });
}

/**
 * Create an experiment (local mode; the public demo answers 403). The
 * response is the new experiment's detail, cached so its page opens at once;
 * every experiment list is refreshed so it appears there.
 */
export function useCreateBenchmarkExperiment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: BenchmarkCreateRequest) => api.createBenchmarkExperiment(body),
    onSuccess: (detail: BenchmarkExperimentDetail) => {
      client.setQueryData(benchmarkKeys.experiment(detail.experiment.experiment_id), detail);
      void client.invalidateQueries({ queryKey: benchmarkKeys.experimentLists });
    },
  });
}

/**
 * Cancel an experiment running in this server (local mode). Whether it
 * succeeds or is refused (409: already finished, or not running here), the
 * experiment and the lists are refreshed: either way the cached status may
 * be out of date.
 */
export function useCancelBenchmarkExperiment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (experimentId: string) => api.cancelBenchmarkExperiment(experimentId),
    onSettled: (_result, _error, experimentId) => {
      void client.invalidateQueries({ queryKey: benchmarkKeys.experiment(experimentId) });
      void client.invalidateQueries({ queryKey: benchmarkKeys.experimentLists });
    },
  });
}
