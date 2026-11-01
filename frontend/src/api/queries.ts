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
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  initialState,
  isTerminal,
  reduce,
  settleWithRecord,
  type ExecutionState,
  type RunSeed,
} from "@/domain/execution";
import { api } from "./client";
import { liveConnectionsFor, type ConnectionStatus } from "./liveConnection";
import type { RunDetail, RunRecord, RunRequest, RunStatus } from "./types";

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
  execution: (runId: string) => ["execution", runId] as const,
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

/**
 * Run history, newest first, one page at a time via the keyset cursor.
 * `pollMs` refreshes the loaded pages, e.g. to discover new runs.
 */
export function useRunHistory(limit = 25, { pollMs }: { pollMs?: number } = {}) {
  return useInfiniteQuery({
    queryKey: queryKeys.runs(limit),
    queryFn: ({ pageParam }) => api.listRuns({ limit, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    refetchInterval: pollMs ?? false,
  });
}

/**
 * A run record, polled while it is queued or running, unless `streaming`:
 * then the event stream carries the run and its end refreshes the record.
 */
export function useRun(runId: string | undefined, { streaming = false }: { streaming?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.run(runId ?? ""),
    queryFn: () => api.getRun(runId as string),
    enabled: Boolean(runId),
    refetchInterval: (query) =>
      !streaming && isLiveStatus(query.state.data?.run.status) ? LIVE_RUN_POLL_MS : false,
  });
}

/** Connection states in which the stream, not polling, carries the run. */
const STREAMING: ReadonlySet<ConnectionStatus> = new Set(["connecting", "connected", "reconnecting"]);

/** The live transport's state for a run (see liveConnection.ts). */
export function useConnectionStatus(runId: string | undefined): ConnectionStatus {
  const connections = liveConnectionsFor(useQueryClient());
  const subscribe = useCallback(
    (listener: () => void) => (runId ? connections.subscribe(runId, listener) : () => {}),
    [connections, runId],
  );
  return useSyncExternalStore(subscribe, () => (runId ? connections.status(runId) : "idle"));
}

/** The parts of a run record the execution reducer may use (see RunSeed). */
export function runSeed(run: RunRecord): RunSeed {
  return {
    run_id: run.run_id,
    goal: run.goal,
    status: run.status,
    plan: run.plan,
    limits: run.limits,
    provider: run.provider,
    provider_kind: run.provider_kind,
    model_policy: run.model_policy,
    models_by_role: run.models_by_role,
    created_at: run.created_at,
  };
}

/**
 * When to poll a run's events again: while the record says the run is live,
 * the trace has not reached run_finished, and the event stream is not
 * carrying it (`streaming`). A terminal run is fetched once more when it
 * ends (see useExecution), then never again.
 */
export function executionPollInterval(
  status: RunStatus | undefined,
  state: ExecutionState | undefined,
  streaming = false,
): number | false {
  return isLiveStatus(status) && !state?.outcome && !streaming ? LIVE_EVENTS_POLL_MS : false;
}

/**
 * A run's execution state. The first load fetches the trace; while the run
 * is live, the event stream keeps it current (liveConnection.ts), with
 * cursor polling as the fallback when the stream is unavailable. Both fold
 * events through the execution reducer into this one cache entry, so a
 * repeated or overlapping event changes nothing. Components get normalised
 * state; none of them sees raw events.
 */
export function useExecution(runId: string | undefined) {
  const client = useQueryClient();
  const connection = useConnectionStatus(runId);
  const streaming = STREAMING.has(connection);
  const record = useRun(runId, { streaming });
  const run = record.data?.run;
  const status = run?.status;
  const key = queryKeys.execution(runId ?? "");

  const trace = useQuery<ExecutionState>({
    queryKey: key,
    queryFn: async () => {
      const id = runId as string;
      const cacheKey = queryKeys.execution(id);
      const held = client.getQueryData<ExecutionState>(cacheKey) ?? initialState(run ? runSeed(run) : null);
      const page = await api.runEvents(id, held.lastSeq || undefined);
      // Fold onto the latest state, not `held`: the stream may have applied
      // events while this request was in flight.
      return page.events.reduce(reduce, client.getQueryData<ExecutionState>(cacheKey) ?? held);
    },
    // The record seeds the state (goal, limits, plan for old traces).
    enabled: Boolean(runId) && record.isSuccess,
    staleTime: Infinity,
    refetchInterval: (query) => executionPollInterval(status, query.state.data, streaming),
  });

  // Stream a live run once its trace has loaded; stop when it is no longer
  // live, on unmount, or when the run changes.
  const watch = Boolean(runId) && isLiveStatus(status) && trace.isSuccess;
  useEffect(() => {
    if (!watch || !runId) return;
    return liveConnectionsFor(client).acquire(runId);
  }, [client, runId, watch]);

  // When the run ends between polls, collect its final events once.
  const previous = useRef(status);
  const { refetch } = trace;
  useEffect(() => {
    if (isLiveStatus(previous.current) && isTerminal(status)) void refetch();
    previous.current = status;
  }, [status, refetch]);

  // A terminal run whose trace never reached run_finished (for example one
  // that crashed in the service) is closed from its record, never guessed.
  const execution = useMemo(() => {
    const state = trace.data;
    if (!state || !run || state.outcome || !isTerminal(run.status) || trace.isFetching) return state;
    return settleWithRecord({ ...state, seed: runSeed(run) });
  }, [trace.data, trace.isFetching, run]);

  return { record, trace, execution, live: isLiveStatus(status), connection };
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
