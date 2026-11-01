/**
 * TanStack Query hooks over the typed client. Server state lives here, not in
 * component state or a global store.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "./client";
import { emptyEventLog, mergeEvents, type EventLog } from "./eventLog";
import type { RunDetail, RunRequest, RunStatus } from "./types";

/** How often a live run is polled. Event polls are cheap (cursor-based). */
export const LIVE_RUN_POLL_MS = 1_500;
export const LIVE_EVENTS_POLL_MS = 1_000;

const LIVE_STATUSES: ReadonlySet<RunStatus> = new Set(["queued", "running"]);

export function isLiveStatus(status: RunStatus | undefined): boolean {
  return status !== undefined && LIVE_STATUSES.has(status);
}

export const queryKeys = {
  health: ["health"] as const,
  config: ["config"] as const,
  demoTasks: ["demo-tasks"] as const,
  runs: (limit: number) => ["runs", { limit }] as const,
  allRuns: ["runs"] as const,
  run: (runId: string) => ["run", runId] as const,
  runEvents: (runId: string) => ["run-events", runId] as const,
};

export function useHealth() {
  return useQuery({ queryKey: queryKeys.health, queryFn: api.health, staleTime: 30_000 });
}

export function useConfig() {
  return useQuery({ queryKey: queryKeys.config, queryFn: api.config, staleTime: 60_000 });
}

export function useDemoTasks() {
  // The catalog only changes with a deploy.
  return useQuery({ queryKey: queryKeys.demoTasks, queryFn: api.demoTasks, staleTime: Infinity });
}

/** Run history, newest first, one page at a time via the keyset cursor. */
export function useRunHistory(limit = 25) {
  return useInfiniteQuery({
    queryKey: queryKeys.runs(limit),
    queryFn: ({ pageParam }) => api.listRuns({ limit, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
}

/** A run record, polled while it is queued or running. */
export function useRun(runId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.run(runId ?? ""),
    queryFn: () => api.getRun(runId as string),
    enabled: Boolean(runId),
    refetchInterval: (query) =>
      isLiveStatus(query.state.data?.run.status) ? LIVE_RUN_POLL_MS : false,
  });
}

/**
 * A run's trace, fetched incrementally: each poll asks only for events after
 * the highest seq already held. Polling stops once run_finished has arrived,
 * or when the caller passes `live: false` (a run that crashed records a
 * failure but no run_finished, so the run's status is the other signal).
 */
export function useRunEvents(runId: string | undefined, { live = true }: { live?: boolean } = {}) {
  const client = useQueryClient();
  return useQuery<EventLog>({
    queryKey: queryKeys.runEvents(runId ?? ""),
    queryFn: async () => {
      const id = runId as string;
      const held = client.getQueryData<EventLog>(queryKeys.runEvents(id)) ?? emptyEventLog(id);
      const page = await api.runEvents(id, held.lastSeq || undefined);
      return mergeEvents(held, page);
    },
    enabled: Boolean(runId),
    // Keep accumulated events while a new page loads; never start over.
    staleTime: Infinity,
    refetchInterval: (query) =>
      live && !query.state.data?.finished ? LIVE_EVENTS_POLL_MS : false,
  });
}

export function useCreateRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: RunRequest) => api.createRun(body),
    onSuccess: (detail: RunDetail) => {
      client.setQueryData(queryKeys.run(detail.run.run_id), detail);
      void client.invalidateQueries({ queryKey: queryKeys.allRuns });
    },
  });
}

export function useCancelRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.cancelRun(runId),
    onSuccess: (_result, runId) => {
      void client.invalidateQueries({ queryKey: queryKeys.run(runId) });
    },
  });
}
